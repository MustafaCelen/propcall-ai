// PropCall AI / RLM — Adaylar (Leads) CRUD + Kanban aşama geçişleri + aktivite geçmişi.
// calls.ts/appointments.ts ile aynı desen: sık filtrelenen alanlar gerçek sütun
// (user_id, stage, meta_lead_id), geri kalanı JSONB 'data'.

import pool from './db';
import { Lead, LeadStage, LeadActivity, LeadActivityType, LEAD_STAGES } from './types';

function newLeadId(): string {
  return 'lead_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function newActivityId(): string {
  return 'act_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function rowToLead(row: { id: string; stage: string; data: any; created_at: Date; updated_at: Date }): Lead {
  return {
    ...row.data,
    id: row.id,
    stage: row.stage as LeadStage,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getAllLeads(userId: string): Promise<Lead[]> {
  const { rows } = await pool.query(
    `SELECT id, stage, data, created_at, updated_at FROM leads WHERE user_id = $1 ORDER BY updated_at DESC`,
    [userId],
  );
  return rows.map(rowToLead);
}

export async function getLead(userId: string, id: string): Promise<Lead | null> {
  const { rows } = await pool.query(
    `SELECT id, stage, data, created_at, updated_at FROM leads WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] ? rowToLead(rows[0]) : null;
}

export interface CreateLeadInput {
  firstName: string;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  source?: Lead['source'];
  metaLeadId?: string | null;
  tags?: string[];
  adData?: Lead['adData'];
}

export async function createLead(userId: string, input: CreateLeadInput): Promise<Lead> {
  const id = newLeadId();
  const data = {
    source: input.source ?? 'MANUAL',
    firstName: input.firstName.trim(),
    lastName: input.lastName?.trim() || null,
    email: input.email?.trim() || null,
    phone: input.phone?.trim() || null,
    notes: input.notes?.trim() || null,
    metaLeadId: input.metaLeadId ?? null,
    tags: input.tags ?? [],
    adData: input.adData ?? null,
    linkedCallId: null,
  };
  const { rows } = await pool.query(
    `INSERT INTO leads (id, user_id, stage, meta_lead_id, data) VALUES ($1, $2, 'NEW', $3, $4)
     RETURNING id, stage, data, created_at, updated_at`,
    [id, userId, input.metaLeadId ?? null, JSON.stringify(data)],
  );
  return rowToLead(rows[0]);
}

export interface UpdateLeadInput {
  firstName?: string;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  tags?: string[];
}

export async function updateLead(userId: string, id: string, patch: UpdateLeadInput): Promise<Lead | null> {
  const { rows } = await pool.query(
    `UPDATE leads SET data = data || $3::jsonb, updated_at = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING id, stage, data, created_at, updated_at`,
    [id, userId, JSON.stringify(patch)],
  );
  return rows[0] ? rowToLead(rows[0]) : null;
}

// Kanban sürükle-bırak / aşama değişimi — aynı sorguda hem stage sütununu hem
// data.stage'i günceller ki rowToLead tutarlı kalsın, ayrıca STAGE_CHANGE aktivitesi loglar.
export async function setLeadStage(userId: string, id: string, stage: LeadStage): Promise<Lead | null> {
  if (!LEAD_STAGES.includes(stage)) throw new Error('Geçersiz aşama: ' + stage);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE leads SET stage = $3, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id, stage, data, created_at, updated_at`,
      [id, userId, stage],
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return null; }
    await client.query(
      `INSERT INTO lead_activities (id, lead_id, user_id, type, data) VALUES ($1, $2, $3, 'STAGE_CHANGE', $4)`,
      [newActivityId(), id, userId, JSON.stringify({ to: stage })],
    );
    await client.query('COMMIT');
    return rowToLead(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteLead(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM leads WHERE id = $1 AND user_id = $2`, [id, userId]);
  return (rowCount ?? 0) > 0;
}

export async function getLeadActivities(userId: string, leadId: string): Promise<LeadActivity[]> {
  const { rows } = await pool.query(
    `SELECT a.id, a.lead_id, a.type, a.data, a.created_at
     FROM lead_activities a JOIN leads l ON l.id = a.lead_id
     WHERE a.lead_id = $1 AND l.user_id = $2
     ORDER BY a.created_at DESC`,
    [leadId, userId],
  );
  return rows.map(r => ({
    id: r.id, leadId: r.lead_id, type: r.type as LeadActivityType,
    data: r.data, createdAt: r.created_at.toISOString(),
  }));
}

// ─── Arama sonucu → Aday birleşimi (RLM Faz 5) ──────────────────────────────
// ASİMETRİK RİSK — KASITLI (bkz. ai.ts enforceSummaryConsistency ile aynı prensip):
// bir arama sonucu bir adayın aşamasını SADECE İLERİ taşıyabilir, asla geri almaz
// veya LOST'a çekmez — o karar danışmana ait. "Kişiyle konuşuldu" gerçeği bile en
// kötü ihtimalle CONTACTED'a taşır, hiçbir zaman NEW'in altına düşürmez.
const STAGE_RANK: Record<string, number> = { NEW: 0, CONTACTED: 1, QUALIFIED: 2, VIEWING: 3, OFFER: 4, WON: 5, LOST: -1 };

export async function upsertLeadFromCallOutcome(
  userId: string,
  phone: string,
  customerName: string,
  vapiCallId: string,
  randevuAlindi: boolean,
  ilgiSeviyesi: string,
  ozet: string,
): Promise<void> {
  if (!phone?.trim()) return;
  const candidateStage: LeadStage = randevuAlindi ? 'QUALIFIED' : 'CONTACTED';

  const { rows } = await pool.query(
    `SELECT id, stage FROM leads WHERE user_id = $1 AND data->>'phone' = $2 ORDER BY updated_at DESC LIMIT 1`,
    [userId, phone.trim()],
  );

  let leadId: string;
  if (rows[0]) {
    leadId = rows[0].id;
    const currentRank = STAGE_RANK[rows[0].stage] ?? 0;
    const candidateRank = STAGE_RANK[candidateStage];
    if (candidateRank > currentRank) {
      await pool.query(
        `UPDATE leads SET stage = $3, data = data || jsonb_build_object('linkedCallId', $4::text), updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [leadId, userId, candidateStage, vapiCallId],
      );
    } else {
      await pool.query(
        `UPDATE leads SET data = data || jsonb_build_object('linkedCallId', $3::text), updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [leadId, userId, vapiCallId],
      );
    }
  } else {
    const parts = customerName.trim().split(/\s+/);
    const created = await createLead(userId, {
      firstName: parts[0] || customerName || 'Bilinmiyor',
      lastName: parts.slice(1).join(' ') || null,
      phone: phone.trim(),
      source: 'CALL_CAMPAIGN',
    });
    leadId = created.id;
    await pool.query(`UPDATE leads SET stage = $2 WHERE id = $1`, [leadId, candidateStage]);
    await pool.query(
      `UPDATE leads SET data = data || jsonb_build_object('linkedCallId', $2::text) WHERE id = $1`,
      [leadId, vapiCallId],
    );
  }

  await pool.query(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, data) VALUES ($1, $2, $3, 'CALL_COMPLETED', $4)`,
    [newActivityId(), leadId, userId, JSON.stringify({ vapiCallId, randevuAlindi, ilgiSeviyesi, ozet })],
  );
}

export async function addLeadActivity(
  userId: string, leadId: string, type: LeadActivityType, data: Record<string, unknown>,
): Promise<LeadActivity | null> {
  // Sahiplik kontrolü — leads.user_id eşleşmezse hiçbir şey eklenmez.
  const owned = await pool.query(`SELECT 1 FROM leads WHERE id = $1 AND user_id = $2`, [leadId, userId]);
  if (!owned.rows[0]) return null;
  const id = newActivityId();
  const { rows } = await pool.query(
    `INSERT INTO lead_activities (id, lead_id, user_id, type, data) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, lead_id, type, data, created_at`,
    [id, leadId, userId, type, JSON.stringify(data)],
  );
  return { id: rows[0].id, leadId: rows[0].lead_id, type: rows[0].type, data: rows[0].data, createdAt: rows[0].created_at.toISOString() };
}
