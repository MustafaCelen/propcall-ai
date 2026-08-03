import pool from './db';
import {
  CallRecord, CustomerInfo, CallSummary, CallCosts,
  VapiTranscriptEntry, CallFilters, StatsData,
} from './types';

// TÜM PUBLIC FONKSİYONLAR user_id ZORUNLU — çapraz erişim yok.
// Webhook (internal) fonksiyonları vapiCallId ile başlar, user_id row'dan okunur.

// Internal — user_id parametreli INSERT/UPDATE
async function writeCall(record: CallRecord, userId?: string): Promise<void> {
  if (userId) {
    await pool.query(
      `INSERT INTO calls (vapi_call_id, user_id, data, start_time, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (vapi_call_id) DO UPDATE
         SET data = EXCLUDED.data, status = EXCLUDED.status`,
      [record.vapiCallId, userId, JSON.stringify(record), record.startTime || null, record.status],
    );
  } else {
    // Update path — user_id set edilmişse dokunma
    await pool.query(
      `UPDATE calls SET data = $2, status = $3 WHERE vapi_call_id = $1`,
      [record.vapiCallId, JSON.stringify(record), record.status],
    );
  }
}

// Webhook-safe read — user_id kontrolü yok, yönlendirmeyi çağıran yapar
export async function readCall(vapiCallId: string): Promise<CallRecord | null> {
  const { rows } = await pool.query(
    'SELECT data FROM calls WHERE vapi_call_id = $1',
    [vapiCallId],
  );
  return rows[0]?.data ?? null;
}

// Bir aramanın sahibi kim (webhook doğrulama için)
export async function getCallOwnerUserId(vapiCallId: string): Promise<string | null> {
  const { rows } = await pool.query(
    'SELECT user_id FROM calls WHERE vapi_call_id = $1',
    [vapiCallId],
  );
  return rows[0]?.user_id ?? null;
}

// User-scoped read — başkasının aramasına erişemez
export async function readCallForUser(userId: string, vapiCallId: string): Promise<CallRecord | null> {
  const { rows } = await pool.query(
    'SELECT data FROM calls WHERE vapi_call_id = $1 AND user_id = $2',
    [vapiCallId, userId],
  );
  return rows[0]?.data ?? null;
}

export async function getAllCalls(userId: string, filters?: CallFilters): Promise<CallRecord[]> {
  const { rows } = await pool.query(
    'SELECT data FROM calls WHERE user_id = $1 ORDER BY start_time DESC NULLS LAST',
    [userId],
  );
  let calls: CallRecord[] = rows.map(r => r.data as CallRecord);

  if (filters) {
    if (filters.dateFrom)            calls = calls.filter(c => c.startTime >= filters.dateFrom!);
    if (filters.dateTo)              calls = calls.filter(c => c.startTime <= filters.dateTo! + 'T23:59:59');
    if (filters.randevu === 'evet')  calls = calls.filter(c => c.summary?.randevu_alindi === true);
    if (filters.randevu === 'hayir') calls = calls.filter(c => c.summary?.randevu_alindi === false);
    if (filters.ilgi)                calls = calls.filter(c => c.summary?.ilgi_seviyesi === filters.ilgi);
    if (filters.aksiyon)             calls = calls.filter(c => c.summary?.tavsiye_edilen_aksiyon === filters.aksiyon);
    if (filters.status)              calls = calls.filter(c => c.status === filters.status);
    if (filters.scenarioId)          calls = calls.filter(c => c.scenarioId === filters.scenarioId);
  }

  return calls;
}

export async function createCall(
  userId: string,
  vapiCallId: string,
  customer: CustomerInfo,
  scenarioId?: string,
  scenarioName?: string,
): Promise<CallRecord> {
  const record: CallRecord = {
    callId:        `call_${Date.now()}`,
    vapiCallId,
    customerName:  customer.name,
    customerPhone: customer.phone,
    customerInfo:  customer,
    startTime:     new Date().toISOString(),
    transcript:    [],
    costs:         { vapi: 0, twilio: 0, llm: 0, tts: 0, stt: 0, total: 0 },
    status:        'in-progress',
    followUp:      false,
    createdAt:     new Date().toISOString(),
    scenarioId,
    scenarioName,
  };
  await writeCall(record, userId);
  return record;
}

// Webhook-called — vapiCallId ile update (user_id zaten row'da)
export async function updateCall(
  vapiCallId: string,
  updates: Partial<CallRecord>,
): Promise<CallRecord | null> {
  const record = await readCall(vapiCallId);
  if (!record) return null;
  const updated = { ...record, ...updates };
  await writeCall(updated);
  return updated;
}

// User-scoped update — başkasınınkine yazamaz
export async function updateCallForUser(
  userId: string,
  vapiCallId: string,
  updates: Partial<CallRecord>,
): Promise<CallRecord | null> {
  const record = await readCallForUser(userId, vapiCallId);
  if (!record) return null;
  const updated = { ...record, ...updates };
  await writeCall(updated);
  return updated;
}

export async function appendTranscript(
  vapiCallId: string,
  entry: VapiTranscriptEntry,
): Promise<void> {
  const record = await readCall(vapiCallId);
  if (!record) return;
  record.transcript.push(entry);
  await writeCall(record);
}

export async function updateCosts(
  vapiCallId: string,
  costs: Partial<CallCosts>,
): Promise<void> {
  const record = await readCall(vapiCallId);
  if (!record) return;
  record.costs = { ...record.costs, ...costs };
  await writeCall(record);
}

export async function saveCallSummary(
  vapiCallId: string,
  summary: CallSummary,
): Promise<void> {
  await updateCall(vapiCallId, { summary });
}

// Kampanya ve tek arama arasında paylaşılan: İngilizce status → Türkçe UI etiketi
export function callStatusToTurkish(status: string): string {
  switch (status) {
    case 'completed':   return 'tamamlandı';
    case 'no-answer':   return 'cevapsız';
    case 'busy':        return 'meşgul';
    case 'in-progress': return 'arıyor';
    case 'failed':      return 'başarısız';
    default:            return 'başarısız';
  }
}

export function endedReasonToStatus(r?: string): CallRecord['status'] {
  if (!r) return 'failed';
  const lower = r.toLowerCase();
  if ([
    'customer-ended-call',
    'assistant-ended-call',
    'assistant-forwarded-call',
    'exceeded-max-duration',
    'max-duration-exceeded',
    'manual',
  ].includes(lower)) return 'completed';
  if ([
    'no-answer',
    'voicemail',
    'silence-timed-out',
    'customer-did-not-answer',
  ].some(k => lower.includes(k))) return 'no-answer';
  if ([
    'busy',
    'call-rejected',
    'rejected',
  ].some(k => lower.includes(k))) return 'busy';
  return 'failed';
}

// User-scoped stats — SQL'de user_id filter
export async function getStats(userId: string, periodDays?: number): Promise<StatsData> {
  const days   = periodDays && periodDays > 0 ? Math.min(periodDays, 90) : 30;
  const cutoff = periodDays && periodDays > 0
    ? new Date(Date.now() - periodDays * 86400000).toISOString()
    : null;

  const [
    mainRow, dailyRows, randevuTrendRows, ilgiRows, retRows,
    actionRows, hourRows, statusRows, scenarioRows,
  ] = await Promise.all([
    pool.query<{
      total_calls: string; completed_calls: string; avg_duration: string;
      total_cost: string; randevu_count: string; with_summary: string;
    }>(
      `SELECT
         COUNT(*)::int                                                       AS total_calls,
         COUNT(*) FILTER (WHERE status = 'completed')::int                  AS completed_calls,
         COALESCE(ROUND(AVG((data->>'duration')::float)
           FILTER (WHERE status != 'in-progress'))::int, 0)                 AS avg_duration,
         COALESCE(SUM((data->'costs'->>'total')::float), 0)                AS total_cost,
         COUNT(*) FILTER (WHERE (data->'summary'->>'randevu_alindi')::boolean
           = true)::int                                                      AS randevu_count,
         COUNT(*) FILTER (WHERE data->'summary' IS NOT NULL
           AND status != 'in-progress')::int                                AS with_summary
       FROM calls
       WHERE user_id = $3
         AND ($1::timestamptz IS NULL OR start_time >= $1::timestamptz)`,
      [cutoff, days, userId],
    ),

    pool.query<{ date: string; count: string; cost: string }>(
      `WITH ds AS (
         SELECT generate_series(
           CURRENT_DATE - ($2::int - 1) * INTERVAL '1 day',
           CURRENT_DATE, '1 day'
         )::date AS d
       )
       SELECT ds.d::text AS date,
              COALESCE(COUNT(c.vapi_call_id), 0)::int              AS count,
              COALESCE(SUM((c.data->'costs'->>'total')::float), 0) AS cost
       FROM ds
       LEFT JOIN calls c ON c.start_time::date = ds.d AND c.user_id = $3
         AND ($1::timestamptz IS NULL OR c.start_time >= $1::timestamptz)
       GROUP BY ds.d ORDER BY ds.d`,
      [cutoff, days, userId],
    ),

    pool.query<{ date: string; total: string; alindi: string }>(
      `WITH ds AS (
         SELECT generate_series(
           CURRENT_DATE - ($2::int - 1) * INTERVAL '1 day',
           CURRENT_DATE, '1 day'
         )::date AS d
       )
       SELECT ds.d::text AS date,
              COUNT(c.vapi_call_id) FILTER (WHERE c.data->'summary' IS NOT NULL)::int AS total,
              COUNT(c.vapi_call_id) FILTER (
                WHERE (c.data->'summary'->>'randevu_alindi')::boolean = true
              )::int AS alindi
       FROM ds
       LEFT JOIN calls c ON c.start_time::date = ds.d AND c.user_id = $3
         AND ($1::timestamptz IS NULL OR c.start_time >= $1::timestamptz)
       GROUP BY ds.d ORDER BY ds.d`,
      [cutoff, days, userId],
    ),

    pool.query<{ seviye: string; count: string }>(
      `SELECT COALESCE(data->'summary'->>'ilgi_seviyesi','yok') AS seviye,
              COUNT(*)::int AS count
       FROM calls
       WHERE user_id = $2 AND data->'summary' IS NOT NULL AND status != 'in-progress'
         AND ($1::timestamptz IS NULL OR start_time >= $1::timestamptz)
       GROUP BY seviye`,
      [cutoff, userId],
    ),

    pool.query<{ neden: string; count: string }>(
      `SELECT data->'summary'->>'ret_nedeni' AS neden, COUNT(*)::int AS count
       FROM calls
       WHERE user_id = $2 AND data->'summary'->>'ret_nedeni' IS NOT NULL
         AND ($1::timestamptz IS NULL OR start_time >= $1::timestamptz)
       GROUP BY neden ORDER BY count DESC LIMIT 8`,
      [cutoff, userId],
    ),

    pool.query<{ action: string; count: string }>(
      `SELECT COALESCE(data->'summary'->>'tavsiye_edilen_aksiyon','Belirsiz') AS action,
              COUNT(*)::int AS count
       FROM calls
       WHERE user_id = $2 AND data->'summary' IS NOT NULL AND status != 'in-progress'
         AND ($1::timestamptz IS NULL OR start_time >= $1::timestamptz)
       GROUP BY action`,
      [cutoff, userId],
    ),

    pool.query<{ hour: string; count: string }>(
      `SELECT EXTRACT(HOUR FROM start_time)::int AS hour, COUNT(*)::int AS count
       FROM calls
       WHERE user_id = $2 AND start_time IS NOT NULL
         AND ($1::timestamptz IS NULL OR start_time >= $1::timestamptz)
       GROUP BY hour ORDER BY hour`,
      [cutoff, userId],
    ),

    pool.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::int AS count FROM calls
       WHERE user_id = $2 AND ($1::timestamptz IS NULL OR start_time >= $1::timestamptz)
       GROUP BY status`,
      [cutoff, userId],
    ),

    pool.query<{ name: string; calls: string; randevu: string; cost: string }>(
      `SELECT COALESCE(data->>'scenarioName','Varsayılan') AS name,
              COUNT(*)::int AS calls,
              COUNT(*) FILTER (
                WHERE (data->'summary'->>'randevu_alindi')::boolean = true
              )::int AS randevu,
              COALESCE(SUM((data->'costs'->>'total')::float), 0) AS cost
       FROM calls
       WHERE user_id = $2 AND ($1::timestamptz IS NULL OR start_time >= $1::timestamptz)
       GROUP BY name ORDER BY calls DESC`,
      [cutoff, userId],
    ),
  ]);

  const m            = mainRow.rows[0];
  const totalCalls   = Number(m.total_calls);
  const completedCalls = Number(m.completed_calls);
  const withSummary  = Number(m.with_summary);
  const randevuCount = Number(m.randevu_count);
  const totalCost    = Math.round(Number(m.total_cost) * 10000) / 10000;
  const answerRate   = totalCalls ? Math.round(completedCalls / totalCalls * 100) : 0;
  const randevuRate  = withSummary ? Math.round(randevuCount / withSummary * 100) : 0;
  const avgDuration  = Number(m.avg_duration);

  const ilgiOrder = ['yüksek', 'orta', 'düşük', 'yok'];
  const ilgiMap   = Object.fromEntries(ilgiRows.rows.map(r => [r.seviye, Number(r.count)]));

  const hourFull: { hour: number; count: number }[] = [];
  const hourMap = Object.fromEntries(hourRows.rows.map(r => [Number(r.hour), Number(r.count)]));
  for (let h = 0; h < 24; h++) hourFull.push({ hour: h, count: hourMap[h] || 0 });

  return {
    totalCalls, completedCalls, answerRate, avgDuration, totalCost,
    randevuCount, randevuRate,
    ilgiDistribution:   ilgiOrder.map(s => ({ seviye: s, count: ilgiMap[s] || 0 })),
    retNedeniDistribution: retRows.rows.map(r => ({ neden: r.neden, count: Number(r.count) })),
    actionDistribution: actionRows.rows.map(r => ({ action: r.action, count: Number(r.count) })),
    dailyCalls:         dailyRows.rows.map(r => ({ date: r.date, count: Number(r.count) })),
    costTrend:          dailyRows.rows.map(r => ({ date: r.date, cost: Math.round(Number(r.cost) * 10000) / 10000 })),
    hourlyDistribution: hourFull,
    statusBreakdown:    statusRows.rows.map(r => ({ status: r.status, count: Number(r.count) })),
    scenarioPerformance: scenarioRows.rows.map(r => {
      const calls = Number(r.calls);
      const randevu = Number(r.randevu);
      return {
        name: r.name, calls, randevu,
        randevuRate: calls ? Math.round(randevu / calls * 100) : 0,
        cost: Math.round(Number(r.cost) * 10000) / 10000,
      };
    }),
    randevuTrend: randevuTrendRows.rows.map(r => {
      const total  = Number(r.total);
      const alindi = Number(r.alindi);
      return { date: r.date, rate: total ? Math.round(alindi / total * 100) : 0, count: alindi };
    }),
  };
}

export async function exportCSV(userId: string, filters?: CallFilters): Promise<string> {
  const calls = await getAllCalls(userId, filters);
  const headers = ['Tarih','Ad','Telefon','Süre','Randevu','İlgi','Ret Nedeni','Mülk Tipi','Aksiyon','Geri Dönüş Notu','Özet','Maliyet','Durum','Notlar'];
  const rows = calls.map(c => [
    new Date(c.startTime).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }),
    c.customerName, c.customerPhone,
    c.duration ? `${Math.floor(c.duration/60)}:${String(c.duration%60).padStart(2,'0')}` : '',
    c.summary?.randevu_alindi != null ? (c.summary.randevu_alindi ? 'Evet' : 'Hayır') : '',
    c.summary?.ilgi_seviyesi ?? '',
    c.summary?.ret_nedeni ?? '',
    c.summary?.mulk_tipi ?? '',
    c.summary?.tavsiye_edilen_aksiyon ?? '',
    c.summary?.geri_donus_notu ?? '',
    c.summary?.ozet ?? '',
    c.costs?.total ?? 0,
    c.status,
    (c.notes || '').replace(/\n/g, ' '),
  ]);
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [headers.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
}
