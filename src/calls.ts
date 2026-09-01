import pool from './db';
import {
  CallRecord, CustomerInfo, CallSummary, CallCosts,
  VapiTranscriptEntry, CallFilters, StatsData,
} from './types';

// Webhook yolunda kullanılır — kayıt zaten var olduğu için düz UPDATE yeterli
// (createCall'daki ilk INSERT dışında hiçbir çağıran yeni satır oluşturmaz).
async function writeCall(record: CallRecord): Promise<void> {
  await pool.query(
    `UPDATE calls SET data = $2, status = $3 WHERE vapi_call_id = $1`,
    [record.vapiCallId, JSON.stringify(record), record.status],
  );
}

// Webhook-internal: sahiplik kontrolü yapmaz — çağıran (server.ts /webhook)
// userId'yi ayrıca (assistantId eşleşmesiyle) doğrulamış olmalı.
export async function readCall(vapiCallId: string): Promise<CallRecord | null> {
  const { rows } = await pool.query(
    'SELECT data FROM calls WHERE vapi_call_id = $1',
    [vapiCallId],
  );
  return rows[0]?.data ?? null;
}

// Uygulama rotaları için sahiplik-kontrollü okuma.
export async function readCallForUser(userId: string, vapiCallId: string): Promise<CallRecord | null> {
  const { rows } = await pool.query(
    'SELECT data FROM calls WHERE vapi_call_id = $1 AND user_id = $2',
    [vapiCallId, userId],
  );
  return rows[0]?.data ?? null;
}

// Webhook spoof-kontrolü / sahiplik doğrulaması için.
export async function getCallOwnerUserId(vapiCallId: string): Promise<string | null> {
  const { rows } = await pool.query('SELECT user_id FROM calls WHERE vapi_call_id = $1', [vapiCallId]);
  return rows[0]?.user_id ?? null;
}

// Sunucu her başladığında çağrılır: bir çökme/restart/tünel kopması yüzünden
// end-of-call-report webhook'u hiç gelmemiş, sonsuza kadar "in-progress"
// görünen eski aramaları 'failed' olarak kapatır. Bunlar İstatistikler'de
// totalCalls'ı şişirip answerRate'i hayalet kayıtlarla düşürüyordu.
// Kasıtlı olarak TÜM kiracılar genelinde çalışır — açılışta bir kerelik sweep.
export async function reconcileStaleCalls(olderThanMinutes = 30): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE calls
     SET status = 'failed',
         data = jsonb_set(jsonb_set(data, '{status}', '"failed"'), '{endedReason}', '"stale-no-webhook-received"')
     WHERE status = 'in-progress'
       AND start_time < NOW() - ($1 || ' minutes')::interval`,
    [olderThanMinutes],
  );
  return rowCount ?? 0;
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
    if (filters.scenarioId === '__none__') calls = calls.filter(c => !c.scenarioId);
    else if (filters.scenarioId)     calls = calls.filter(c => c.scenarioId === filters.scenarioId);
  }

  return calls;
}

export async function createCall(
  userId: string,
  vapiCallId: string,
  customer: CustomerInfo,
  scenarioId?: string,
  scenarioName?: string,
  campaignId?: string,
  leadSource?: string,
): Promise<CallRecord> {
  const record: CallRecord = {
    callId:        `call_${Date.now()}`,
    vapiCallId,
    customerName:  customer.name,
    customerPhone: customer.phone,
    customerInfo:  customer,
    startTime:     new Date().toISOString(),
    transcript:    [],
    costs:         { vapi: 0, twilio: 0, llm: 0, tts: 0, stt: 0, anthropic: 0, total: 0 },
    status:        'in-progress',
    followUp:      false,
    createdAt:     new Date().toISOString(),
    scenarioId,
    scenarioName,
    campaignId,
    leadSource: leadSource || undefined,
  };
  await pool.query(
    `INSERT INTO calls (vapi_call_id, data, start_time, status, user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [record.vapiCallId, JSON.stringify(record), record.startTime, record.status, userId],
  );
  return record;
}

// Webhook-internal — sahiplik zaten rota katmanında doğrulanmış varsayılır.
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

// Uygulama rotaları için sahiplik-kontrollü güncelleme (örn. PATCH /api/calls/:id).
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
  const merged = { ...record.costs, ...costs } as CallCosts;
  // total'ü her zaman parçalardan yeniden hesapla — çağıran taraf hangi alt kalemi
  // güncellerse güncellesin (Vapi'nin cost-update'i, ya da bizim Anthropic/ElevenLabs
  // tahminimiz) toplam asla eksik/yanlış kalmasın.
  merged.total = Math.round(
    ((merged.vapi || 0) + (merged.twilio || 0) + (merged.llm || 0) +
     (merged.tts || 0) + (merged.stt || 0) + (merged.anthropic || 0)) * 1e6,
  ) / 1e6;
  record.costs = merged;
  await writeCall(record);
}

export async function saveCallSummary(
  vapiCallId: string,
  summary: CallSummary,
): Promise<void> {
  await updateCall(vapiCallId, { summary });
}

export interface BestCallInfo {
  vapiCallId: string;
  status: string;
  summary: CallSummary | null;
}

// Bir kampanyadaki her telefon numarası için "calls" tablosundaki EN İYİ (randevu
// varsa öncelikli, sonra özeti olanı, sonra en sonuncusu) aramayı TEK sorguda döner.
// Kampanya motoru sunucu açılışında kendi contacts JSONB kopyasını bu gerçek veriyle
// karşılaştırıp senkronize etmek için kullanır — bir webhook yazımı bir deploy
// sırasında kaybolmuşsa (örn. arıyor'da takılı kalmış veya özeti eksik kalmış bir
// kişi), her kişi için ayrı sorgu atmadan, tek seferde gerçeği geri kazanır.
export async function getBestCallsByPhoneForCampaign(
  userId: string, campaignId: string,
): Promise<Map<string, BestCallInfo>> {
  const { rows } = await pool.query<{ phone: string; vapi_call_id: string; status: string; summary: CallSummary | null }>(
    `SELECT DISTINCT ON (data->>'customerPhone')
       data->>'customerPhone' AS phone, vapi_call_id, status, data->'summary' AS summary
     FROM calls
     WHERE user_id = $1 AND data->>'campaignId' = $2
     ORDER BY data->>'customerPhone',
       (data->'summary'->>'randevu_alindi')::boolean DESC NULLS LAST,
       (data->'summary' IS NOT NULL) DESC,
       start_time DESC`,
    [userId, campaignId],
  );
  const map = new Map<string, BestCallInfo>();
  for (const r of rows) map.set(r.phone, { vapiCallId: r.vapi_call_id, status: r.status, summary: r.summary });
  return map;
}

// Aynı kişiyi aynı gün ikinci kez aramayı önleyen güvenlik ağı — kampanya motorunun
// KENDİ durum takibi (contact.status) bir nedenle yanlış/eski kalmış olsa bile
// (örn. bir deploy sırasında kaybolan webhook yazımı), gerçek arama geçmişine bakan
// bu DIŞARIDAN doğrulama ikinci bir güvence katmanı sağlar.
export async function findTodaysCallForPhone(
  userId: string, phone: string, sinceIso: string,
): Promise<BestCallInfo | null> {
  const { rows } = await pool.query<{ vapi_call_id: string; status: string; summary: CallSummary | null }>(
    `SELECT vapi_call_id, status, data->'summary' AS summary
     FROM calls
     WHERE user_id = $1 AND data->>'customerPhone' = $2 AND start_time >= $3
     ORDER BY
       (data->'summary'->>'randevu_alindi')::boolean DESC NULLS LAST,
       (data->'summary' IS NOT NULL) DESC,
       start_time DESC
     LIMIT 1`,
    [userId, phone, sinceIso],
  );
  const r = rows[0];
  return r ? { vapiCallId: r.vapi_call_id, status: r.status, summary: r.summary } : null;
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

// hasUserSpeech: transcript'te müşteri gerçekten konuştu mu? — silence-timed-out
// veya ambiguous durumlarda kesinleştirmek için kullanılır.
export function endedReasonToStatus(
  r?: string,
  opts?: { hasUserSpeech?: boolean },
): CallRecord['status'] {
  if (!r) return 'failed';
  const lower = r.toLowerCase();

  // Gerçek konuşma yapılmış aramalar
  if ([
    'customer-ended-call',
    'assistant-ended-call',
    'assistant-said-end-call-phrase',   // endCallPhrases eşleşti — asistan kapanışı düzgün yaptı
    'assistant-forwarded-call',
    'exceeded-max-duration',
    'max-duration-exceeded',
    'manual',
  ].includes(lower)) return 'completed';

  // silence-timed-out: kişi telefonu açtı ama bir noktada sessiz kaldı.
  // Eğer transcript'te user mesajı varsa → konuşma oldu, 'completed' say.
  // Yoksa (hiç konuşulmadıysa) 'no-answer' say.
  if (lower.includes('silence-timed-out')) {
    return opts?.hasUserSpeech ? 'completed' : 'no-answer';
  }

  // Cevapsız / ulaşılamadı
  if ([
    'no-answer',
    'voicemail',
    'customer-did-not-answer',
  ].some(k => lower.includes(k))) return 'no-answer';

  // Meşgul / reddedildi
  if ([
    'busy',
    'call-rejected',
    'rejected',
  ].some(k => lower.includes(k))) return 'busy';

  // Gerçek hata durumları
  return 'failed';
}

export interface CampaignStatsData {
  totalCalls: number;
  completedCalls: number;
  answerRate: number;
  avgDuration: number;
  totalCost: number;
  randevuCount: number;
  randevuRate: number;
  ilgiDistribution: Array<{ seviye: string; count: number }>;
  retNedeniDistribution: Array<{ neden: string; count: number }>;
  statusBreakdown: Array<{ status: string; count: number }>;
  hourlyPerformance: Array<{ hour: number; calls: number; randevu: number }>;
  regionPerformance: Array<{ region: string; calls: number; randevu: number; randevuRate: number }>;
  mulkTipiDistribution: Array<{ tip: string; count: number }>;
  retryEffect: {
    multiAttemptContacts: number;
    multiAttemptSuccessRate: number;
    singleAttemptSuccessRate: number;
  } | null;
}

// Tek bir kampanyaya ait aramaların analizi — getStats ile aynı SQL desenini
// kullanır ama tarih aralığı yerine campaignId ile filtreler.
export async function getCampaignStats(userId: string, campaignId: string): Promise<CampaignStatsData> {
  const [
    mainRow, ilgiRows, retRows, statusRows,
    hourRows, regionRows, mulkRows, retryRow,
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
       FROM calls WHERE data->>'campaignId' = $1 AND user_id = $2`,
      [campaignId, userId],
    ),
    pool.query<{ seviye: string; count: string }>(
      `SELECT COALESCE(data->'summary'->>'ilgi_seviyesi','yok') AS seviye, COUNT(*)::int AS count
       FROM calls WHERE data->>'campaignId' = $1 AND user_id = $2
         AND data->'summary' IS NOT NULL AND status != 'in-progress'
       GROUP BY seviye`,
      [campaignId, userId],
    ),
    pool.query<{ neden: string; count: string }>(
      `SELECT data->'summary'->>'ret_nedeni' AS neden, COUNT(*)::int AS count
       FROM calls WHERE data->>'campaignId' = $1 AND user_id = $2 AND data->'summary'->>'ret_nedeni' IS NOT NULL
       GROUP BY neden ORDER BY count DESC LIMIT 8`,
      [campaignId, userId],
    ),
    pool.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::int AS count FROM calls WHERE data->>'campaignId' = $1 AND user_id = $2 GROUP BY status`,
      [campaignId, userId],
    ),
    // Saatlik performans — bu kampanyada hangi saatte arayınca daha çok randevu alınıyor
    pool.query<{ hour: string; calls: string; randevu: string }>(
      `SELECT EXTRACT(HOUR FROM start_time)::int AS hour,
              COUNT(*)::int AS calls,
              COUNT(*) FILTER (WHERE (data->'summary'->>'randevu_alindi')::boolean = true)::int AS randevu
       FROM calls WHERE data->>'campaignId' = $1 AND user_id = $2 AND start_time IS NOT NULL
       GROUP BY hour ORDER BY hour`,
      [campaignId, userId],
    ),
    // Bölge bazlı performans
    pool.query<{ region: string; calls: string; randevu: string }>(
      `SELECT COALESCE(NULLIF(data->'customerInfo'->>'region', ''), 'Belirtilmemiş') AS region,
              COUNT(*)::int AS calls,
              COUNT(*) FILTER (WHERE (data->'summary'->>'randevu_alindi')::boolean = true)::int AS randevu
       FROM calls WHERE data->>'campaignId' = $1 AND user_id = $2
       GROUP BY region ORDER BY calls DESC LIMIT 10`,
      [campaignId, userId],
    ),
    // Mülk tipi dağılımı
    pool.query<{ tip: string; count: string }>(
      `SELECT data->'summary'->>'mulk_tipi' AS tip, COUNT(*)::int AS count
       FROM calls WHERE data->>'campaignId' = $1 AND user_id = $2 AND data->'summary'->>'mulk_tipi' IS NOT NULL
       GROUP BY tip ORDER BY count DESC LIMIT 8`,
      [campaignId, userId],
    ),
    // Tekrar arama etkisi — aynı numara birden fazla kez arandıysa, tek seferde
    // arananlara kıyasla sonuca ulaşma oranı ne kadar değişiyor
    pool.query<{ multi_count: string; multi_success: string; single_count: string; single_success: string }>(
      `WITH phone_counts AS (
         SELECT data->>'customerPhone' AS phone, COUNT(*)::int AS attempts,
                BOOL_OR(status = 'completed') AS ever_completed
         FROM calls WHERE data->>'campaignId' = $1 AND user_id = $2
         GROUP BY phone
       )
       SELECT
         COUNT(*) FILTER (WHERE attempts > 1)::int AS multi_count,
         COUNT(*) FILTER (WHERE attempts > 1 AND ever_completed)::int AS multi_success,
         COUNT(*) FILTER (WHERE attempts = 1)::int AS single_count,
         COUNT(*) FILTER (WHERE attempts = 1 AND ever_completed)::int AS single_success
       FROM phone_counts`,
      [campaignId, userId],
    ),
  ]);

  const m = mainRow.rows[0];
  const totalCalls     = Number(m?.total_calls ?? 0);
  const completedCalls = Number(m?.completed_calls ?? 0);
  const withSummary    = Number(m?.with_summary ?? 0);
  const randevuCount   = Number(m?.randevu_count ?? 0);

  const ilgiOrder = ['yüksek', 'orta', 'düşük', 'yok'];
  const ilgiMap   = Object.fromEntries(ilgiRows.rows.map(r => [r.seviye, Number(r.count)]));

  const hourMap = Object.fromEntries(hourRows.rows.map(r => [Number(r.hour), r]));
  const hourlyPerformance = Array.from({ length: 24 }, (_, hour) => {
    const r = hourMap[hour];
    return { hour, calls: r ? Number(r.calls) : 0, randevu: r ? Number(r.randevu) : 0 };
  });

  const regionPerformance = regionRows.rows.map(r => {
    const calls = Number(r.calls);
    const randevu = Number(r.randevu);
    return { region: r.region, calls, randevu, randevuRate: calls ? Math.round(randevu / calls * 100) : 0 };
  });

  const rr = retryRow.rows[0];
  const multiCount   = Number(rr?.multi_count ?? 0);
  const multiSuccess = Number(rr?.multi_success ?? 0);
  const singleCount  = Number(rr?.single_count ?? 0);
  const singleSuccess = Number(rr?.single_success ?? 0);
  const retryEffect = multiCount > 0 ? {
    multiAttemptContacts: multiCount,
    multiAttemptSuccessRate: Math.round(multiSuccess / multiCount * 100),
    singleAttemptSuccessRate: singleCount ? Math.round(singleSuccess / singleCount * 100) : 0,
  } : null;

  return {
    totalCalls, completedCalls,
    answerRate:  totalCalls ? Math.round(completedCalls / totalCalls * 100) : 0,
    avgDuration: Number(m?.avg_duration ?? 0),
    totalCost:   Math.round(Number(m?.total_cost ?? 0) * 10000) / 10000,
    randevuCount,
    randevuRate: withSummary ? Math.round(randevuCount / withSummary * 100) : 0,
    ilgiDistribution: ilgiOrder.map(s => ({ seviye: s, count: ilgiMap[s] || 0 })),
    retNedeniDistribution: retRows.rows.map(r => ({ neden: r.neden, count: Number(r.count) })),
    statusBreakdown: statusRows.rows.map(r => ({ status: r.status, count: Number(r.count) })),
    hourlyPerformance,
    regionPerformance,
    mulkTipiDistribution: mulkRows.rows.map(r => ({ tip: r.tip, count: Number(r.count) })),
    retryEffect,
  };
}

export interface StatsFilters {
  dateFrom?: string;   // 'YYYY-MM-DD', dahil
  dateTo?: string;     // 'YYYY-MM-DD', dahil
  scenarioId?: string; // '__none__' = senaryosuz (varsayılan prompt) aramalar
}

export async function getStats(userId: string, filters?: StatsFilters): Promise<StatsData> {
  const fromTs      = filters?.dateFrom ? `${filters.dateFrom}T00:00:00.000Z` : null;
  const toTs        = filters?.dateTo   ? `${filters.dateTo}T23:59:59.999Z`   : null;
  const scenarioId  = filters?.scenarioId || null;

  // Günlük grafik penceresi: özel aralık verildiyse aynen o kullanılır (KPI'lar zaten
  // fromTs/toTs ile tam o aralığı yansıtıyor); verilmediyse (Hepsi/varsayılan) grafik
  // son 30 günü gösterir — aksi halde aylar süren tek bir çizgi grafik anlamsızlaşır.
  // Çok uzun bir özel aralık verilirse (>90 gün) grafik yine de sondan 90 güne kırpılır.
  const todayStr = new Date().toISOString().slice(0, 10);
  const seriesEndDate = filters?.dateTo || todayStr;
  const addDays = (dateStr: string, delta: number) => {
    const d = new Date(dateStr + 'T00:00:00.000Z');
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  };
  let seriesStartDate = filters?.dateFrom || addDays(seriesEndDate, -29);
  const spanDays = Math.round((new Date(seriesEndDate).getTime() - new Date(seriesStartDate).getTime()) / 86400000);
  if (spanDays > 90) seriesStartDate = addDays(seriesEndDate, -90);

  // Tüm sorgularda paylaşılan filtre: tarih aralığı ($1/$3) + senaryo ($4, '__none__'
  // senaryosuz aramalar demek). Tüm ağır hesaplamalar PostgreSQL'de paralel çalışır.
  const RANGE = `
    AND ($1::timestamptz IS NULL OR start_time >= $1::timestamptz)
    AND ($3::timestamptz IS NULL OR start_time <= $3::timestamptz)
    AND ($4::text IS NULL OR ($4 = '__none__' AND data->>'scenarioId' IS NULL) OR data->>'scenarioId' = $4)`;
  const baseParams = [fromTs, userId, toTs, scenarioId];

  const [
    mainRow,
    dailyRows,
    randevuTrendRows,
    ilgiRows,
    retRows,
    actionRows,
    hourRows,
    statusRows,
    scenarioRows,
    sourceRows,
  ] = await Promise.all([
    // 1 — Temel sayılar
    pool.query<{
      total_calls: string; completed_calls: string; avg_duration: string;
      total_cost: string; randevu_count: string; with_summary: string;
    }>(
      `SELECT
         COUNT(*)::int                                                         AS total_calls,
         COUNT(*) FILTER (WHERE status = 'completed')::int                    AS completed_calls,
         COALESCE(ROUND(AVG((data->>'duration')::float)
           FILTER (WHERE status != 'in-progress'))::int, 0)                   AS avg_duration,
         COALESCE(SUM((data->'costs'->>'total')::float), 0)                  AS total_cost,
         COUNT(*) FILTER (WHERE (data->'summary'->>'randevu_alindi')::boolean
           = true)::int                                                        AS randevu_count,
         COUNT(*) FILTER (WHERE data->'summary' IS NOT NULL
           AND status != 'in-progress')::int                                  AS with_summary
       FROM calls
       WHERE user_id = $2 ${RANGE}`,
      baseParams,
    ),

    // 2 — Günlük arama + maliyet (generate_series → sıfırlı günler dahil)
    // NOT: fromTs/toTs burada kasıtlı olarak YOK — pencere zaten seriesStartDate/
    // seriesEndDate ile tam olarak sınırlanıyor. baseParams'ı olduğu gibi ekleyip
    // $1/$3'ü sorgu metninde hiç kullanmamak "could not determine data type of
    // parameter $1" hatasına yol açıyordu (Postgres, bağlanan her parametrenin
    // metinde en az bir yerde geçmesini ve tipinin çıkarılabilir olmasını ister).
    pool.query<{ date: string; count: string; cost: string }>(
      `WITH ds AS (
         SELECT generate_series($3::date, $4::date, '1 day')::date AS d
       )
       SELECT ds.d::text AS date,
              COALESCE(COUNT(c.vapi_call_id), 0)::int                AS count,
              COALESCE(SUM((c.data->'costs'->>'total')::float), 0)   AS cost
       FROM ds
       LEFT JOIN calls c ON c.start_time::date = ds.d
         AND c.user_id = $1
         AND ($2::text IS NULL OR ($2 = '__none__' AND c.data->>'scenarioId' IS NULL) OR c.data->>'scenarioId' = $2)
       GROUP BY ds.d ORDER BY ds.d`,
      [userId, scenarioId, seriesStartDate, seriesEndDate],
    ),

    // 3 — Randevu dönüşüm trendi (aynı sebeple kendi minimal parametre listesi)
    pool.query<{ date: string; total: string; alindi: string }>(
      `WITH ds AS (
         SELECT generate_series($3::date, $4::date, '1 day')::date AS d
       )
       SELECT ds.d::text AS date,
              COUNT(c.vapi_call_id) FILTER (WHERE c.data->'summary' IS NOT NULL)::int AS total,
              COUNT(c.vapi_call_id) FILTER (
                WHERE (c.data->'summary'->>'randevu_alindi')::boolean = true
              )::int AS alindi
       FROM ds
       LEFT JOIN calls c ON c.start_time::date = ds.d
         AND c.user_id = $1
         AND ($2::text IS NULL OR ($2 = '__none__' AND c.data->>'scenarioId' IS NULL) OR c.data->>'scenarioId' = $2)
       GROUP BY ds.d ORDER BY ds.d`,
      [userId, scenarioId, seriesStartDate, seriesEndDate],
    ),

    // 4 — İlgi seviyesi dağılımı
    pool.query<{ seviye: string; count: string }>(
      `SELECT COALESCE(data->'summary'->>'ilgi_seviyesi','yok') AS seviye,
              COUNT(*)::int AS count
       FROM calls
       WHERE user_id = $2 AND data->'summary' IS NOT NULL AND status != 'in-progress' ${RANGE}
       GROUP BY seviye`,
      baseParams,
    ),

    // 5 — Ret nedeni dağılımı
    pool.query<{ neden: string; count: string }>(
      `SELECT data->'summary'->>'ret_nedeni' AS neden, COUNT(*)::int AS count
       FROM calls
       WHERE user_id = $2 AND data->'summary'->>'ret_nedeni' IS NOT NULL ${RANGE}
       GROUP BY neden ORDER BY count DESC LIMIT 8`,
      baseParams,
    ),

    // 6 — Aksiyon dağılımı
    pool.query<{ action: string; count: string }>(
      `SELECT COALESCE(data->'summary'->>'tavsiye_edilen_aksiyon','Belirsiz') AS action,
              COUNT(*)::int AS count
       FROM calls
       WHERE user_id = $2 AND data->'summary' IS NOT NULL AND status != 'in-progress' ${RANGE}
       GROUP BY action`,
      baseParams,
    ),

    // 7 — Saatlik dağılım
    pool.query<{ hour: string; count: string }>(
      `SELECT EXTRACT(HOUR FROM start_time)::int AS hour, COUNT(*)::int AS count
       FROM calls
       WHERE user_id = $2 AND start_time IS NOT NULL ${RANGE}
       GROUP BY hour ORDER BY hour`,
      baseParams,
    ),

    // 8 — Durum dağılımı
    pool.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::int AS count FROM calls
       WHERE user_id = $2 ${RANGE}
       GROUP BY status`,
      baseParams,
    ),

    // 9 — Senaryo performansı
    pool.query<{ name: string; calls: string; randevu: string; cost: string }>(
      `SELECT COALESCE(data->>'scenarioName','Varsayılan') AS name,
              COUNT(*)::int AS calls,
              COUNT(*) FILTER (
                WHERE (data->'summary'->>'randevu_alindi')::boolean = true
              )::int AS randevu,
              COALESCE(SUM((data->'costs'->>'total')::float), 0) AS cost
       FROM calls
       WHERE user_id = $2 ${RANGE}
       GROUP BY name ORDER BY calls DESC`,
      baseParams,
    ),

    // 10 — Kaynak (lead source) performansı — hangi ilan/reklam/liste daha çok randevuya çeviriyor
    pool.query<{ source: string; calls: string; randevu: string; cost: string }>(
      `SELECT COALESCE(NULLIF(data->>'leadSource',''),'Belirtilmemiş') AS source,
              COUNT(*)::int AS calls,
              COUNT(*) FILTER (
                WHERE (data->'summary'->>'randevu_alindi')::boolean = true
              )::int AS randevu,
              COALESCE(SUM((data->'costs'->>'total')::float), 0) AS cost
       FROM calls
       WHERE user_id = $2 ${RANGE}
       GROUP BY source ORDER BY calls DESC`,
      baseParams,
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

  // Saatlik dağılım: 0-23 tam seri
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
    sourcePerformance: sourceRows.rows.map(r => {
      const calls = Number(r.calls);
      const randevu = Number(r.randevu);
      return {
        source: r.source, calls, randevu,
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

export interface AdminUserComparisonRow {
  userId: string;
  totalCalls: number;
  completedCalls: number;
  answerRate: number;
  randevuCount: number;
  randevuRate: number;
  totalCost: number;
  avgDuration: number;
}

// Admin-only, tüm danışmanlar genelinde (cross-tenant) karşılaştırma — hangi danışman
// daha çok arama yapıyor, daha yüksek dönüşüm/daha düşük maliyet elde ediyor.
// getStats ile aynı sorgu deseni, tek fark: user_id'ye göre GROUP BY.
export async function getAdminUserComparison(dateFrom?: string, dateTo?: string): Promise<AdminUserComparisonRow[]> {
  const fromTs = dateFrom ? `${dateFrom}T00:00:00.000Z` : null;
  const toTs   = dateTo   ? `${dateTo}T23:59:59.999Z`   : null;
  const { rows } = await pool.query<{
    user_id: string; total_calls: string; completed_calls: string;
    randevu_count: string; with_summary: string; total_cost: string; avg_duration: string;
  }>(
    `SELECT
       user_id,
       COUNT(*)::int AS total_calls,
       COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_calls,
       COUNT(*) FILTER (WHERE (data->'summary'->>'randevu_alindi')::boolean = true)::int AS randevu_count,
       COUNT(*) FILTER (WHERE data->'summary' IS NOT NULL AND status != 'in-progress')::int AS with_summary,
       COALESCE(SUM((data->'costs'->>'total')::float), 0) AS total_cost,
       COALESCE(ROUND(AVG((data->>'duration')::float) FILTER (WHERE status != 'in-progress'))::int, 0) AS avg_duration
     FROM calls
     WHERE user_id IS NOT NULL
       AND ($1::timestamptz IS NULL OR start_time >= $1::timestamptz)
       AND ($2::timestamptz IS NULL OR start_time <= $2::timestamptz)
     GROUP BY user_id
     ORDER BY total_calls DESC`,
    [fromTs, toTs],
  );
  return rows.map(r => {
    const totalCalls = Number(r.total_calls);
    const withSummary = Number(r.with_summary);
    const randevuCount = Number(r.randevu_count);
    return {
      userId: r.user_id,
      totalCalls,
      completedCalls: Number(r.completed_calls),
      answerRate: totalCalls ? Math.round(Number(r.completed_calls) / totalCalls * 100) : 0,
      randevuCount,
      randevuRate: withSummary ? Math.round(randevuCount / withSummary * 100) : 0,
      totalCost: Math.round(Number(r.total_cost) * 10000) / 10000,
      avgDuration: Number(r.avg_duration),
    };
  });
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
