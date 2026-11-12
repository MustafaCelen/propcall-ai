// PropCall AI — Görevler ("sonraki adım") ve "Bugün" özeti. CRM Faz 1.
//
// Emlak CRM'inin kalbi: her sıcak kişi için "sonraki adım + tarih". Görevlerin büyük
// kısmı danışman tarafından değil sistem tarafından açılır (arama özeti, Meta lead,
// WhatsApp); danışman sadece tamamlar ya da erteler. Randevu da ayrı bir modül değil,
// kind='meeting' bir görevdir.

import pool from './db';

export type TaskKind = 'call' | 'whatsapp' | 'meeting' | 'other';
export type TaskSource = 'manual' | 'ai_call' | 'whatsapp' | 'meta' | 'system';

export interface TaskRow {
  id: string;
  leadId: string | null;
  leadName: string | null;
  leadPhone: string | null;
  leadStage: string | null;
  title: string;
  kind: TaskKind;
  dueAt: string;
  status: 'open' | 'done';
  source: TaskSource;
  vapiCallId: string | null;
  note: string | null;
  snoozeCount: number;
  createdAt: string;
  doneAt: string | null;
}

function newTaskId(): string {
  return 'tsk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

const TASK_SELECT = `
  SELECT t.id, t.lead_id, t.title, t.kind, t.due_at, t.status, t.source, t.vapi_call_id, t.note,
         t.snooze_count, t.created_at, t.done_at,
         l.stage AS lead_stage,
         NULLIF(TRIM(CONCAT(l.data->>'firstName', ' ', COALESCE(l.data->>'lastName',''))), '') AS lead_name,
         l.data->>'phone' AS lead_phone
  FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id`;

function rowToTask(r: any): TaskRow {
  return {
    id: r.id, leadId: r.lead_id, leadName: r.lead_name, leadPhone: r.lead_phone, leadStage: r.lead_stage,
    title: r.title, kind: r.kind, dueAt: new Date(r.due_at).toISOString(), status: r.status, source: r.source,
    vapiCallId: r.vapi_call_id, note: r.note, snoozeCount: r.snooze_count,
    createdAt: new Date(r.created_at).toISOString(), doneAt: r.done_at ? new Date(r.done_at).toISOString() : null,
  };
}

// İstanbul takvim gününe göre "yarın 10:00" gibi vadeler — sunucu UTC'de çalışır,
// danışman İstanbul'da yaşar; Date.now()+24h kullanmak gece yarısı etrafında yanlış
// güne düşer.
export function istanbulAt(daysAhead: number, hour: number, minute = 0): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const d = new Date(`${ymd}T00:00:00+03:00`);
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(d.getUTCHours() + hour, minute, 0, 0);
  return d;
}

export async function createTask(userId: string, input: {
  leadId?: string | null; title: string; kind?: TaskKind; dueAt: Date | string; source?: TaskSource;
  vapiCallId?: string | null; note?: string | null;
}): Promise<TaskRow> {
  const id = newTaskId();
  await pool.query(
    `INSERT INTO tasks (id, user_id, lead_id, title, kind, due_at, source, vapi_call_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, userId, input.leadId ?? null, input.title.trim(), input.kind ?? 'call', new Date(input.dueAt),
     input.source ?? 'manual', input.vapiCallId ?? null, input.note ?? null],
  );
  const { rows } = await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [id]);
  return rowToTask(rows[0]);
}

// Otomasyon için: aynı kişiye zaten açık bir görev varsa ikinciyi açma — kampanya
// aynı kişiyi tekrar aradığında (retry) ya da WhatsApp üst üste geldiğinde danışmanın
// Bugün listesi aynı isimle dolmasın. Açık görev varsa onu döner (dokunmaz).
export async function ensureOpenTaskForLead(userId: string, leadId: string, input: {
  title: string; kind?: TaskKind; dueAt: Date; source: TaskSource; vapiCallId?: string | null; note?: string | null;
}): Promise<{ task: TaskRow; created: boolean }> {
  const { rows } = await pool.query(
    `${TASK_SELECT} WHERE t.user_id = $1 AND t.lead_id = $2 AND t.status = 'open' ORDER BY t.due_at ASC LIMIT 1`,
    [userId, leadId],
  );
  if (rows[0]) {
    const existing = rowToTask(rows[0]);
    // Randevu, sıradan "ara" görevinden daha güçlü bir sinyal: mevcut açık görev
    // bir arama göreviyse ve yeni gelen randevuysa görevi randevuya yükselt.
    if (input.kind === 'meeting' && existing.kind !== 'meeting') {
      await pool.query(
        `UPDATE tasks SET kind = 'meeting', title = $2, due_at = $3, note = COALESCE($4, note), vapi_call_id = COALESCE($5, vapi_call_id) WHERE id = $1`,
        [existing.id, input.title, input.dueAt, input.note ?? null, input.vapiCallId ?? null],
      );
      const again = await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [existing.id]);
      return { task: rowToTask(again.rows[0]), created: false };
    }
    return { task: existing, created: false };
  }
  const task = await createTask(userId, { ...input, leadId });
  return { task, created: true };
}

export type TaskScope = 'today' | 'overdue' | 'upcoming' | 'open' | 'done';

export async function listTasks(userId: string, scope: TaskScope = 'open', limit = 200): Promise<TaskRow[]> {
  const endOfToday = istanbulAt(1, 0);
  const startOfToday = istanbulAt(0, 0);
  let where = `t.user_id = $1`;
  const vals: unknown[] = [userId];
  if (scope === 'today')    { where += ` AND t.status = 'open' AND t.due_at < $2`; vals.push(endOfToday); }
  if (scope === 'overdue')  { where += ` AND t.status = 'open' AND t.due_at < $2`; vals.push(startOfToday); }
  if (scope === 'upcoming') { where += ` AND t.status = 'open' AND t.due_at >= $2`; vals.push(endOfToday); }
  if (scope === 'open')     { where += ` AND t.status = 'open'`; }
  if (scope === 'done')     { where += ` AND t.status = 'done'`; }
  const order = scope === 'done' ? 't.done_at DESC' : 't.due_at ASC';
  const { rows } = await pool.query(`${TASK_SELECT} WHERE ${where} ORDER BY ${order} LIMIT ${limit}`, vals);
  return rows.map(rowToTask);
}

export async function completeTask(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE tasks SET status = 'done', done_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'open'`, [id, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function snoozeTask(userId: string, id: string, until: Date): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE tasks SET due_at = $3, snooze_count = snooze_count + 1 WHERE id = $1 AND user_id = $2 AND status = 'open'`,
    [id, userId, until],
  );
  return (rowCount ?? 0) > 0;
}

export async function updateTask(userId: string, id: string, patch: { title?: string; dueAt?: Date; note?: string | null; kind?: TaskKind }): Promise<boolean> {
  const sets: string[] = []; const vals: unknown[] = [id, userId];
  if (patch.title !== undefined) { vals.push(patch.title.trim()); sets.push(`title = $${vals.length}`); }
  if (patch.dueAt !== undefined) { vals.push(patch.dueAt); sets.push(`due_at = $${vals.length}`); }
  if (patch.note !== undefined)  { vals.push(patch.note); sets.push(`note = $${vals.length}`); }
  if (patch.kind !== undefined)  { vals.push(patch.kind); sets.push(`kind = $${vals.length}`); }
  if (!sets.length) return true;
  const { rowCount } = await pool.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2`, vals);
  return (rowCount ?? 0) > 0;
}

export async function deleteTask(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM tasks WHERE id = $1 AND user_id = $2`, [id, userId]);
  return (rowCount ?? 0) > 0;
}

// ─── "Bugün" özeti ────────────────────────────────────────────────────────────
export interface TodayDigest {
  dateLabel: string;
  tasks: TaskRow[];            // gecikmiş + bugün (vade sırasıyla)
  meetings: TaskRow[];         // önümüzdeki 7 gün randevular
  awaitingWhatsapp: Array<{ leadId: string; name: string; phone: string | null; body: string; at: string }>;
  untouchedHot: Array<{ leadId: string; name: string; phone: string | null; stage: string; updatedAt: string }>;
  lastCampaign: null | { id: string; name: string; status: string; startedAt: string | null; total: number; reached: number; hot: number; appointments: number; dnc: number };
  counts: { overdue: number; today: number; meetings: number; awaitingWhatsapp: number; untouchedHot: number };
}

export async function getTodayDigest(userId: string): Promise<TodayDigest> {
  const startOfToday = istanbulAt(0, 0);
  const endOfToday = istanbulAt(1, 0);
  const weekAhead = istanbulAt(7, 0);

  const [tasks, meetings, wa, hot, camp] = await Promise.all([
    pool.query(`${TASK_SELECT} WHERE t.user_id = $1 AND t.status = 'open' AND t.due_at < $2 ORDER BY t.due_at ASC LIMIT 100`, [userId, endOfToday]),
    pool.query(`${TASK_SELECT} WHERE t.user_id = $1 AND t.status = 'open' AND t.kind = 'meeting' AND t.due_at >= $2 AND t.due_at < $3 ORDER BY t.due_at ASC LIMIT 50`, [userId, startOfToday, weekAhead]),
    // Son 7 günde gelen ve ardından bizden hiç giden mesaj olmayan yazışmalar.
    pool.query(
      `WITH last_msg AS (
         SELECT DISTINCT ON (lead_id) lead_id, direction, body, created_at
         FROM whatsapp_messages WHERE user_id = $1 AND created_at > NOW() - INTERVAL '7 days'
         ORDER BY lead_id, created_at DESC)
       SELECT m.lead_id, m.body, m.created_at,
              NULLIF(TRIM(CONCAT(l.data->>'firstName',' ',COALESCE(l.data->>'lastName',''))),'') AS name, l.data->>'phone' AS phone
       FROM last_msg m JOIN leads l ON l.id = m.lead_id
       WHERE m.direction = 'IN' AND COALESCE((l.data->>'whatsappIgnored')::boolean, false) = false
       ORDER BY m.created_at DESC LIMIT 20`, [userId]),
    // 48 saattir dokunulmamış sıcak fırsatlar: aşaması ilerlemiş ama açık görevi yok.
    pool.query(
      `SELECT l.id, l.stage, l.updated_at,
              NULLIF(TRIM(CONCAT(l.data->>'firstName',' ',COALESCE(l.data->>'lastName',''))),'') AS name, l.data->>'phone' AS phone
       FROM leads l
       WHERE l.user_id = $1 AND l.stage IN ('CONTACTED','MEETING','AGREEMENT')
         AND l.updated_at < NOW() - INTERVAL '48 hours'
         AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = l.id AND t.status = 'open')
       ORDER BY l.updated_at ASC LIMIT 20`, [userId]),
    pool.query(
      `SELECT id, name, status, started_at, contacts FROM campaigns
       WHERE user_id = $1 AND status IN ('running','paused','completed','stopped') AND started_at IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`, [userId]),
  ]);

  let lastCampaign: TodayDigest['lastCampaign'] = null;
  if (camp.rows[0]) {
    const c = camp.rows[0];
    const contacts: any[] = Array.isArray(c.contacts) ? c.contacts : [];
    const reached = contacts.filter(x => x.status === 'tamamlandı').length;
    const hot = contacts.filter(x => x.result && (x.result.ilgi_seviyesi === 'yüksek' || x.result.ilgi_seviyesi === 'orta')).length;
    const appointments = contacts.filter(x => x.result && x.result.randevu_alindi === true).length;
    const dnc = contacts.filter(x => (x.result && x.result.beni_aramayin_talebi === true) || x.skipKind === 'dnc').length;
    lastCampaign = { id: c.id, name: c.name, status: c.status, startedAt: c.started_at ? new Date(c.started_at).toISOString() : null,
      total: contacts.length, reached, hot, appointments, dnc };
  }

  const taskRows = tasks.rows.map(rowToTask);
  const overdue = taskRows.filter(t => new Date(t.dueAt) < startOfToday).length;
  const dateLabel = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  return {
    dateLabel,
    tasks: taskRows,
    meetings: meetings.rows.map(rowToTask),
    awaitingWhatsapp: wa.rows.map(r => ({ leadId: r.lead_id, name: r.name || r.phone || 'Bilinmiyor', phone: r.phone, body: String(r.body).slice(0, 120), at: new Date(r.created_at).toISOString() })),
    untouchedHot: hot.rows.map(r => ({ leadId: r.id, name: r.name || r.phone || 'Bilinmiyor', phone: r.phone, stage: r.stage, updatedAt: new Date(r.updated_at).toISOString() })),
    lastCampaign,
    counts: { overdue, today: taskRows.length - overdue, meetings: meetings.rows.length, awaitingWhatsapp: wa.rows.length, untouchedHot: hot.rows.length },
  };
}
