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
  reference: string;
  leadSource?: string; // hangi ilan/reklam/liste — raporlamada kaynak bazlı dönüşüm için
  // 'tekrar-planlandı': cevapsız/meşgul sonrası otomatik yeniden arama bekliyor —
  // nextRetryAt geçince fillQueue() bunu 'bekliyor' gibi tekrar arar (bkz. campaign.ts).
  status: 'bekliyor' | 'arıyor' | 'tamamlandı' | 'cevapsız' | 'meşgul' | 'başarısız' | 'tekrar-planlandı';
  vapiCallId: string | null;
  result: CallSummary | null;
  duration?: number;
  callStartTs?: number;
  attemptCount?: number;      // bu kişi kaç kez arandı (fresh + retry toplamı)
  nextRetryAt?: string | null; // ISO — 'tekrar-planlandı' durumundayken bu zamandan sonra tekrar aranabilir
}

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed' | 'stopped';

export interface CampaignRecord {
  id: string;
  userId: string;
  name: string;
  scenarioId?: string;
  scenarioName?: string;
  status: CampaignStatus;
  maxConcurrent: number;
  startFromIndex: number;
  callLimit: number;
  answeredLimit: number;
  retryMaxAttempts: number;
  retryDelayMinutes: number;
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
    userId: r.user_id,
    name: r.name,
    scenarioId: r.scenario_id || undefined,
    scenarioName: r.scenario_name || undefined,
    status: r.status,
    maxConcurrent: r.max_concurrent,
    startFromIndex: r.start_from_index,
    callLimit: r.call_limit,
    answeredLimit: r.answered_limit,
    retryMaxAttempts: r.retry_max_attempts ?? 1,
    retryDelayMinutes: r.retry_delay_minutes ?? 30,
    contacts: r.contacts || [],
    createdAt: r.created_at?.toISOString?.() ?? r.created_at,
    startedAt: r.started_at?.toISOString?.() ?? r.started_at ?? undefined,
    completedAt: r.completed_at?.toISOString?.() ?? r.completed_at ?? undefined,
    updatedAt: r.updated_at?.toISOString?.() ?? r.updated_at,
  };
}

export async function createCampaign(userId: string, params: {
  name: string;
  scenarioId?: string;
  scenarioName?: string;
  maxConcurrent: number;
  startFromIndex: number;
  callLimit: number;
  answeredLimit: number;
  retryMaxAttempts?: number;
  retryDelayMinutes?: number;
  contacts: Array<Omit<CampaignContact, 'status' | 'vapiCallId' | 'result'>>;
}): Promise<CampaignRecord> {
  const id = newCampaignId();
  const contacts: CampaignContact[] = params.contacts.map(c => ({
    ...c, status: 'bekliyor', vapiCallId: null, result: null,
  }));

  const { rows } = await pool.query(
    `INSERT INTO campaigns
       (id, name, scenario_id, scenario_name, status, max_concurrent,
        start_from_index, call_limit, answered_limit, retry_max_attempts, retry_delay_minutes, contacts, user_id)
     VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      id, params.name.trim() || 'İsimsiz Kampanya', params.scenarioId || null, params.scenarioName || null,
      params.maxConcurrent, params.startFromIndex, params.callLimit, params.answeredLimit,
      Math.max(1, params.retryMaxAttempts || 1), Math.max(1, params.retryDelayMinutes || 30),
      JSON.stringify(contacts), userId,
    ],
  );
  return rowToRecord(rows[0]);
}

export async function getCampaign(userId: string, id: string): Promise<CampaignRecord | null> {
  const { rows } = await pool.query('SELECT * FROM campaigns WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows[0] ? rowToRecord(rows[0]) : null;
}

// Motor yeniden başladığında devam edecek aktif kampanyalar (running veya paused) — bir
// kullanıcının birden fazla eşzamanlı kampanyası olabilir, bu yüzden dizi döner.
export async function getActiveCampaigns(userId: string): Promise<CampaignRecord[]> {
  const { rows } = await pool.query(
    `SELECT * FROM campaigns WHERE user_id = $1 AND status IN ('running','paused') ORDER BY updated_at DESC`,
    [userId],
  );
  return rows.map(rowToRecord);
}

// Sunucu açılışında TÜM kullanıcıların aktif kampanyalarını tek seferde yüklemek için —
// motor (campaign.ts) her satırı kendi user_id'siyle hafızaya alır. Rota katmanından çağrılmaz.
export async function getAllActiveCampaigns(): Promise<CampaignRecord[]> {
  const { rows } = await pool.query(
    `SELECT * FROM campaigns WHERE status IN ('running','paused') ORDER BY updated_at DESC`,
  );
  return rows.map(rowToRecord);
}

export async function saveCampaignContacts(userId: string, id: string, contacts: CampaignContact[]): Promise<void> {
  await pool.query(
    `UPDATE campaigns SET contacts = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
    [id, userId, JSON.stringify(contacts)],
  );
}

export async function setCampaignStatus(
  userId: string,
  id: string,
  status: CampaignStatus,
  opts?: { markStarted?: boolean; markCompleted?: boolean },
): Promise<void> {
  const sets: string[] = ['status = $3', 'updated_at = NOW()'];
  if (opts?.markStarted)   sets.push('started_at = COALESCE(started_at, NOW())');
  if (opts?.markCompleted) sets.push('completed_at = NOW()');
  await pool.query(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2`, [id, userId, status]);
}

// Var olan bir kampanyayı "belirli bir satırdan devam et" gibi ayarlarla güncellemek
// için — contacts'a (ve dolayısıyla birikmiş arama sonuçlarına) DOKUNMAZ, sadece
// kuyruk davranışını belirleyen alanları değiştirir. "Başlat"a tekrar basınca listeyi
// sıfırdan yükleyip tüm ilerlemenin kaybolmasının önüne geçmek için eklendi.
export async function updateCampaignSettings(
  userId: string,
  id: string,
  patch: {
    startFromIndex?: number; maxConcurrent?: number; callLimit?: number; answeredLimit?: number;
    retryMaxAttempts?: number; retryDelayMinutes?: number;
  },
): Promise<void> {
  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [id, userId];
  const add = (col: string, v: number | undefined) => {
    if (v === undefined) return;
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  add('start_from_index', patch.startFromIndex);
  add('max_concurrent', patch.maxConcurrent);
  add('call_limit', patch.callLimit);
  add('answered_limit', patch.answeredLimit);
  add('retry_max_attempts', patch.retryMaxAttempts);
  add('retry_delay_minutes', patch.retryDelayMinutes);
  if (sets.length === 1) return; // hiçbir alan verilmemiş
  await pool.query(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2`, vals);
}

// Geçmiş kampanya listesi — her satır için calls tablosundan gerçek maliyet/süre/randevu
// bilgisini tek sorguda hesaplar (contacts JSONB'de maliyet tutulmuyor, kaynak calls tablosu).
export async function listCampaigns(userId: string): Promise<CampaignListRow[]> {
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
    LEFT JOIN calls c ON c.data->>'campaignId' = camp.id AND c.user_id = camp.user_id
    WHERE camp.user_id = $1
    GROUP BY camp.id
    ORDER BY camp.created_at DESC
  `, [userId]);
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
