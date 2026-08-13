// PropCall AI — Kampanya kalıcı depolama + kampanya-bazlı analiz.
//
// campaign.ts (tekil) canlı arama motorudur (kuyruk, tick, webhook kancaları).
// Bu dosya (campaigns.ts, çoğul) o motorun üzerinde çalıştığı KALICI kaydı yönetir:
// bir kampanya oluşturulduğunda burada bir satır açılır, motor onu günceller,
// bittiğinde de silinmez — geçmişte kalır, karşılaştırılabilir.

import pool from './db';
import { CallSummary } from './types';

export interface CampaignContact {
  name: string;
  phone: string;
  region: string;
  notes: string;
  status: 'bekliyor' | 'arıyor' | 'tamamlandı' | 'cevapsız' | 'meşgul' | 'başarısız';
  vapiCallId: string | null;
  result: CallSummary | null;
  duration?: number;
  callStartTs?: number;
}

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed' | 'stopped';

export interface CampaignRecord {
  id: string;
  name: string;
  scenarioId?: string;
  scenarioName?: string;
  status: CampaignStatus;
  maxConcurrent: number;
  startFromIndex: number;
  callLimit: number;
  answeredLimit: number;
  contacts: CampaignContact[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface CampaignListRow {
  id: string;
  name: string;
  scenarioName: string | null;
  status: CampaignStatus;
  totalContacts: number;
  callsMade: number;
  completed: number;
  randevu: number;
  randevuRate: number;
  totalCost: number;
  avgDuration: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

function newCampaignId(): string {
  return 'camp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function rowToRecord(r: any): CampaignRecord {
  return {
    id: r.id,
    name: r.name,
    scenarioId: r.scenario_id || undefined,
    scenarioName: r.scenario_name || undefined,
    status: r.status,
    maxConcurrent: r.max_concurrent,
    startFromIndex: r.start_from_index,
    callLimit: r.call_limit,
    answeredLimit: r.answered_limit,
    contacts: r.contacts || [],
    createdAt: r.created_at?.toISOString?.() ?? r.created_at,
    startedAt: r.started_at?.toISOString?.() ?? r.started_at ?? undefined,
    completedAt: r.completed_at?.toISOString?.() ?? r.completed_at ?? undefined,
    updatedAt: r.updated_at?.toISOString?.() ?? r.updated_at,
  };
}

export async function createCampaign(params: {
  name: string;
  scenarioId?: string;
  scenarioName?: string;
  maxConcurrent: number;
  startFromIndex: number;
  callLimit: number;
  answeredLimit: number;
  contacts: Array<Omit<CampaignContact, 'status' | 'vapiCallId' | 'result'>>;
}): Promise<CampaignRecord> {
  const id = newCampaignId();
  const contacts: CampaignContact[] = params.contacts.map(c => ({
    ...c, status: 'bekliyor', vapiCallId: null, result: null,
  }));

  const { rows } = await pool.query(
    `INSERT INTO campaigns
       (id, name, scenario_id, scenario_name, status, max_concurrent,
        start_from_index, call_limit, answered_limit, contacts)
     VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      id, params.name.trim() || 'İsimsiz Kampanya', params.scenarioId || null, params.scenarioName || null,
      params.maxConcurrent, params.startFromIndex, params.callLimit, params.answeredLimit,
      JSON.stringify(contacts),
    ],
  );
  return rowToRecord(rows[0]);
}

export async function getCampaign(id: string): Promise<CampaignRecord | null> {
  const { rows } = await pool.query('SELECT * FROM campaigns WHERE id = $1', [id]);
  return rows[0] ? rowToRecord(rows[0]) : null;
}

// Motor yeniden başladığında devam edecek aktif kampanya (running veya paused)
export async function getActiveCampaign(): Promise<CampaignRecord | null> {
  const { rows } = await pool.query(
    `SELECT * FROM campaigns WHERE status IN ('running','paused') ORDER BY updated_at DESC LIMIT 1`,
  );
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export async function saveCampaignContacts(id: string, contacts: CampaignContact[]): Promise<void> {
  await pool.query(
    `UPDATE campaigns SET contacts = $2, updated_at = NOW() WHERE id = $1`,
    [id, JSON.stringify(contacts)],
  );
}

export async function setCampaignStatus(
  id: string,
  status: CampaignStatus,
  opts?: { markStarted?: boolean; markCompleted?: boolean },
): Promise<void> {
  const sets: string[] = ['status = $2', 'updated_at = NOW()'];
  if (opts?.markStarted)   sets.push('started_at = COALESCE(started_at, NOW())');
  if (opts?.markCompleted) sets.push('completed_at = NOW()');
  await pool.query(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = $1`, [id, status]);
}

// Geçmiş kampanya listesi — her satır için calls tablosundan gerçek maliyet/süre/randevu
// bilgisini tek sorguda hesaplar (contacts JSONB'de maliyet tutulmuyor, kaynak calls tablosu).
export async function listCampaigns(): Promise<CampaignListRow[]> {
  const { rows } = await pool.query(`
    SELECT
      camp.id, camp.name, camp.scenario_name, camp.status,
      camp.created_at, camp.started_at, camp.completed_at,
      jsonb_array_length(camp.contacts)::int AS total_contacts,
      COUNT(c.vapi_call_id)::int AS calls_made,
      COUNT(*) FILTER (WHERE c.status = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE (c.data->'summary'->>'randevu_alindi')::boolean = true)::int AS randevu,
      COALESCE(SUM((c.data->'costs'->>'total')::float), 0) AS total_cost,
      COALESCE(AVG((c.data->>'duration')::float) FILTER (WHERE c.status != 'in-progress'), 0) AS avg_duration
    FROM campaigns camp
    LEFT JOIN calls c ON c.data->>'campaignId' = camp.id
    GROUP BY camp.id
    ORDER BY camp.created_at DESC
  `);
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    scenarioName: r.scenario_name,
    status: r.status,
    totalContacts: r.total_contacts,
    callsMade: r.calls_made,
    completed: r.completed,
    randevu: r.randevu,
    randevuRate: r.calls_made ? Math.round(r.randevu / r.calls_made * 100) : 0,
    totalCost: Math.round(Number(r.total_cost) * 10000) / 10000,
    avgDuration: Math.round(Number(r.avg_duration)),
    createdAt: r.created_at?.toISOString?.() ?? r.created_at,
    startedAt: r.started_at?.toISOString?.() ?? r.started_at ?? null,
    completedAt: r.completed_at?.toISOString?.() ?? r.completed_at ?? null,
  }));
}
