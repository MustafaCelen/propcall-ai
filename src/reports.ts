// PropCall AI — CRM Faz 4: huni raporu, ekip görünümü, sabah özeti.
//
// Huni raporu STAGE_CHANGE aktivitelerine dayanır (bir kişi dönemde o aşamaya en az
// bir kez ulaştı mı?) — "şu an hangi aşamada" sayımı ayrı verilir. Kayıp nedenleri
// LOST aktivitesindeki lostReason'dan okunur (Faz 2'den beri zorunlu).

import pool from './db';
import { LEAD_STAGES, LEAD_STAGE_LABELS, LOST_REASON_LABELS, DEAL_TYPE_LABELS, LeadStage } from './types';
import { getTodayDigest, istanbulAt } from './tasks';

export interface FunnelReport {
  days: number;
  now: Record<LeadStage, number>;                       // şu an aşamalardaki kişi sayısı
  created: number;                                      // dönemde oluşturulan kişi
  reached: Record<LeadStage, number>;                   // dönemde aşamaya ulaşan (tekil kişi)
  lostReasons: Array<{ code: string; label: string; count: number }>;
  byDealType: Array<{ code: string; label: string; open: number; won: number; lost: number }>;
  bySource: Array<{ code: string; count: number }>;
  stageLabels: Record<string, string>;
}

export async function getFunnelReport(userId: string, days = 30): Promise<FunnelReport> {
  const d = Math.min(365, Math.max(1, Math.round(days)));
  const [now, created, reached, lost, deal, src] = await Promise.all([
    pool.query(`SELECT stage, COUNT(*)::int AS n FROM leads WHERE user_id = $1 GROUP BY stage`, [userId]),
    pool.query(`SELECT COUNT(*)::int AS n FROM leads WHERE user_id = $1 AND created_at > NOW() - ($2 || ' days')::interval`, [userId, d]),
    pool.query(
      `SELECT a.data->>'to' AS stage, COUNT(DISTINCT a.lead_id)::int AS n
       FROM lead_activities a JOIN leads l ON l.id = a.lead_id
       WHERE l.user_id = $1 AND a.type = 'STAGE_CHANGE' AND a.created_at > NOW() - ($2 || ' days')::interval
       GROUP BY a.data->>'to'`, [userId, d]),
    pool.query(
      `SELECT COALESCE(a.data->>'lostReason', 'OTHER') AS code, COUNT(DISTINCT a.lead_id)::int AS n
       FROM lead_activities a JOIN leads l ON l.id = a.lead_id
       WHERE l.user_id = $1 AND a.type = 'STAGE_CHANGE' AND a.data->>'to' = 'LOST'
         AND a.created_at > NOW() - ($2 || ' days')::interval
       GROUP BY 1 ORDER BY n DESC`, [userId, d]),
    pool.query(
      `SELECT COALESCE(data->>'dealType', '') AS code,
              COUNT(*) FILTER (WHERE stage NOT IN ('WON','LOST'))::int AS open,
              COUNT(*) FILTER (WHERE stage = 'WON')::int AS won,
              COUNT(*) FILTER (WHERE stage = 'LOST')::int AS lost
       FROM leads WHERE user_id = $1 GROUP BY 1 ORDER BY open DESC`, [userId]),
    pool.query(
      `SELECT COALESCE(data->>'source', 'OTHER') AS code, COUNT(*)::int AS n
       FROM leads WHERE user_id = $1 AND created_at > NOW() - ($2 || ' days')::interval GROUP BY 1 ORDER BY n DESC`, [userId, d]),
  ]);
  const zero = () => Object.fromEntries(LEAD_STAGES.map(s => [s, 0])) as Record<LeadStage, number>;
  const nowMap = zero(); for (const r of now.rows) if (r.stage in nowMap) nowMap[r.stage as LeadStage] = r.n;
  const reachedMap = zero(); for (const r of reached.rows) if (r.stage in reachedMap) reachedMap[r.stage as LeadStage] = r.n;
  return {
    days: d,
    now: nowMap,
    created: created.rows[0]?.n ?? 0,
    reached: reachedMap,
    lostReasons: lost.rows.map(r => ({ code: r.code, label: (LOST_REASON_LABELS as any)[r.code] || r.code, count: r.n })),
    byDealType: deal.rows.map(r => ({ code: r.code, label: r.code ? (DEAL_TYPE_LABELS as any)[r.code] || r.code : 'Tipi yok', open: r.open, won: r.won, lost: r.lost })),
    bySource: src.rows.map(r => ({ code: r.code, count: r.n })),
    stageLabels: LEAD_STAGE_LABELS,
  };
}

// ─── Ekip görünümü (manager/admin) ─────────────────────────────────────────
export interface TeamMemberOverview {
  userId: string;
  name: string;
  email: string;
  role: string;
  open: number;
  stages: Record<LeadStage, number>;
  overdueTasks: number;
  todayTasks: number;
  meetingsWeek: number;
  calls7d: number;
  appointments7d: number;
  lastActivityAt: string | null;
}

export async function getTeamOverview(): Promise<TeamMemberOverview[]> {
  const startOfToday = istanbulAt(0, 0), endOfToday = istanbulAt(1, 0), weekAhead = istanbulAt(7, 0);
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.role,
       (SELECT COUNT(*)::int FROM leads l WHERE l.user_id = u.id AND l.stage NOT IN ('WON','LOST')) AS open,
       (SELECT json_object_agg(s.stage, s.n) FROM (SELECT stage, COUNT(*)::int AS n FROM leads WHERE user_id = u.id GROUP BY stage) s) AS stages,
       (SELECT COUNT(*)::int FROM tasks t WHERE t.user_id = u.id AND t.status = 'open' AND t.due_at < $1) AS overdue,
       (SELECT COUNT(*)::int FROM tasks t WHERE t.user_id = u.id AND t.status = 'open' AND t.due_at >= $1 AND t.due_at < $2) AS today,
       (SELECT COUNT(*)::int FROM tasks t WHERE t.user_id = u.id AND t.status = 'open' AND t.kind = 'meeting' AND t.due_at >= $1 AND t.due_at < $3) AS meetings,
       (SELECT COUNT(*)::int FROM calls c WHERE c.user_id = u.id AND c.status = 'completed' AND COALESCE(c.is_practice,false) = false AND c.start_time > NOW() - INTERVAL '7 days') AS calls7d,
       (SELECT COUNT(*)::int FROM calls c WHERE c.user_id = u.id AND COALESCE(c.is_practice,false) = false AND c.start_time > NOW() - INTERVAL '7 days' AND (c.data->'summary'->>'randevu_alindi')::boolean = true) AS appts7d,
       (SELECT MAX(l.updated_at) FROM leads l WHERE l.user_id = u.id) AS last_activity
     FROM users u WHERE u.is_active = true AND u.role IN ('agent','manager')
     ORDER BY u.name NULLS LAST, u.email`,
    [startOfToday, endOfToday, weekAhead],
  );
  return rows.map(r => {
    const stages = Object.fromEntries(LEAD_STAGES.map(s => [s, 0])) as Record<LeadStage, number>;
    for (const [k, v] of Object.entries(r.stages || {})) if (k in stages) stages[k as LeadStage] = Number(v);
    return {
      userId: r.id, name: r.name || r.email, email: r.email, role: r.role,
      open: r.open, stages, overdueTasks: r.overdue, todayTasks: r.today, meetingsWeek: r.meetings,
      calls7d: r.calls7d, appointments7d: r.appts7d,
      lastActivityAt: r.last_activity ? new Date(r.last_activity).toISOString() : null,
    };
  });
}

// ─── Sabah özeti (WhatsApp) ─────────────────────────────────────────────────
// Her sabah 08:30 İstanbul'da, numarasını kaydetmiş danışmanlara o günün Bugün
// özetini kendi Twilio WhatsApp hattından gönderir. Not: Twilio/WhatsApp 24 saatlik
// pencere dışında serbest metin teslim etmeyebilir — gönderim başarısızsa sessizce
// loglanır, ertesi gün tekrar denenir.
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' });

export async function buildMorningSummaryText(userId: string, name: string | null): Promise<string> {
  const d = await getTodayDigest(userId);
  const lines: string[] = [];
  lines.push(`Günaydın${name ? ' ' + name.split(' ')[0] : ''} 👋 — ${d.dateLabel}`);
  const overdue = d.tasks.filter(t => new Date(t.dueAt) < istanbulAt(0, 0));
  if (overdue.length) lines.push(`⚠️ ${overdue.length} gecikmiş görev`);
  const todays = d.tasks.filter(t => new Date(t.dueAt) >= istanbulAt(0, 0));
  lines.push(`☑ Bugün ${todays.length} görev`);
  for (const t of todays.slice(0, 6)) lines.push(`  • ${fmtTime(t.dueAt)} ${t.title}${t.leadName ? ' — ' + t.leadName : ''}`);
  if (todays.length > 6) lines.push(`  … +${todays.length - 6}`);
  if (d.meetings.length) {
    lines.push(`📅 Bu hafta ${d.meetings.length} randevu`);
    for (const m of d.meetings.slice(0, 4)) {
      const day = new Date(m.dueAt).toLocaleDateString('tr-TR', { weekday: 'short', timeZone: 'Europe/Istanbul' });
      lines.push(`  • ${day} ${fmtTime(m.dueAt)} ${m.leadName || m.title}`);
    }
  }
  if (d.counts.awaitingWhatsapp) lines.push(`💬 ${d.counts.awaitingWhatsapp} WhatsApp yanıt bekliyor`);
  if (d.counts.untouchedHot) lines.push(`🔥 ${d.counts.untouchedHot} sıcak fırsata 2 gündür dokunulmadı`);
  if (d.lastCampaign) lines.push(`📞 Son kampanya "${d.lastCampaign.name}": ${d.lastCampaign.reached}/${d.lastCampaign.total} ulaşıldı, ${d.lastCampaign.appointments} randevu`);
  lines.push('— PropCall');
  return lines.join('\n');
}

export async function runMorningSummaries(opts: { force?: boolean } = {}): Promise<number> {
  const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }));
  const hhmm = istNow.getHours() * 60 + istNow.getMinutes();
  // 08:30–08:59 penceresi; aynı gün ikinci kez gönderilmez (morning_summary_sent_on).
  if (!opts.force && (hhmm < 8 * 60 + 30 || hhmm >= 9 * 60)) return 0;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
  const { rows } = await pool.query(
    `SELECT id, name, morning_summary_phone FROM users
     WHERE is_active = true AND morning_summary_phone IS NOT NULL AND morning_summary_phone <> ''
       AND (morning_summary_sent_on IS NULL OR morning_summary_sent_on < $1::date)`, [today]);
  let sent = 0;
  const { getUserWhatsappConfig } = await import('./users');
  const { sendWhatsAppMessage } = await import('./whatsapp');
  for (const u of rows) {
    try {
      const cfg = await getUserWhatsappConfig(u.id);
      if (!cfg) { console.warn(`[Sabah] ${u.id}: WhatsApp hattı tanımlı değil, özet atlandı`); continue; }
      const text = await buildMorningSummaryText(u.id, u.name);
      await sendWhatsAppMessage(cfg, u.morning_summary_phone, text);
      await pool.query(`UPDATE users SET morning_summary_sent_on = $2::date WHERE id = $1`, [u.id, today]);
      sent++;
    } catch (err) {
      console.error(`[Sabah] ${u.id} özet gönderilemedi:`, err instanceof Error ? err.message : err);
    }
  }
  if (sent) console.log(`[Sabah] ${sent} danışmana sabah özeti gönderildi`);
  return sent;
}
