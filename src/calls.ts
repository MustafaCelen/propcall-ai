import pool from './db';
import {
  CallRecord, CustomerInfo, CallSummary, CallCosts,
  VapiTranscriptEntry, CallFilters, StatsData,
} from './types';

async function writeCall(record: CallRecord): Promise<void> {
  await pool.query(
    `INSERT INTO calls (vapi_call_id, data, start_time, status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (vapi_call_id) DO UPDATE
       SET data = EXCLUDED.data, status = EXCLUDED.status`,
    [record.vapiCallId, JSON.stringify(record), record.startTime || null, record.status],
  );
}

export async function readCall(vapiCallId: string): Promise<CallRecord | null> {
  const { rows } = await pool.query(
    'SELECT data FROM calls WHERE vapi_call_id = $1',
    [vapiCallId],
  );
  return rows[0]?.data ?? null;
}

export async function getAllCalls(filters?: CallFilters): Promise<CallRecord[]> {
  const { rows } = await pool.query(
    'SELECT data FROM calls ORDER BY start_time DESC NULLS LAST',
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
  await writeCall(record);
  return record;
}

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

export function endedReasonToStatus(r?: string): CallRecord['status'] {
  if (!r) return 'failed';
  const lower = r.toLowerCase();
  if (['customer-ended-call','assistant-ended-call','assistant-forwarded-call',
       'exceeded-max-duration','manual','silence-timed-out'].includes(lower)) return 'completed';
  if (lower.includes('no-answer') || lower === 'voicemail') return 'no-answer';
  if (lower.includes('busy') || lower === 'call-rejected') return 'busy';
  return 'failed';
}

export async function getStats(): Promise<StatsData> {
  const calls    = await getAllCalls();
  const finished = calls.filter(c => c.status !== 'in-progress');
  const withSum  = finished.filter(c => c.summary !== undefined);

  const totalCalls     = calls.length;
  const completedCalls = calls.filter(c => c.status === 'completed').length;
  const answerRate     = totalCalls ? Math.round(completedCalls / totalCalls * 100) : 0;
  const avgDuration    = finished.length
    ? Math.round(finished.reduce((s, c) => s + (c.duration || 0), 0) / finished.length) : 0;
  const totalCost      = Math.round(calls.reduce((s, c) => s + (c.costs?.total || 0), 0) * 10000) / 10000;
  const randevuCount   = withSum.filter(c => c.summary!.randevu_alindi === true).length;
  const randevuRate    = withSum.length ? Math.round(randevuCount / withSum.length * 100) : 0;

  const dailyCalls: Record<string, number> = {};
  const dailyCost:  Record<string, number> = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = d.toISOString().slice(0, 10);
    dailyCalls[k] = 0; dailyCost[k] = 0;
  }
  calls.forEach(c => {
    const k = c.startTime.slice(0, 10);
    if (k in dailyCalls) {
      dailyCalls[k]++;
      dailyCost[k] = Math.round((dailyCost[k] + (c.costs?.total || 0)) * 10000) / 10000;
    }
  });

  const ilgiOrder = ['yüksek', 'orta', 'düşük', 'yok'];
  const ilgiMap: Record<string, number> = { yüksek: 0, orta: 0, düşük: 0, yok: 0 };
  withSum.forEach(c => { const s = c.summary!.ilgi_seviyesi || 'yok'; ilgiMap[s] = (ilgiMap[s] || 0) + 1; });

  const retMap: Record<string, number> = {};
  withSum.filter(c => c.summary!.ret_nedeni).forEach(c => {
    const r = c.summary!.ret_nedeni!;
    retMap[r] = (retMap[r] || 0) + 1;
  });
  const retNedeniDistribution = Object.entries(retMap)
    .sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([neden, count]) => ({ neden, count }));

  const actionMap: Record<string, number> = {};
  withSum.forEach(c => {
    const a = c.summary!.tavsiye_edilen_aksiyon || 'Belirsiz';
    actionMap[a] = (actionMap[a] || 0) + 1;
  });

  const hourMap: Record<number, number> = {};
  for (let h = 0; h < 24; h++) hourMap[h] = 0;
  calls.forEach(c => { hourMap[new Date(c.startTime).getHours()]++; });

  const statusMap: Record<string, number> = {};
  calls.forEach(c => { statusMap[c.status] = (statusMap[c.status] || 0) + 1; });

  return {
    totalCalls, completedCalls, answerRate, avgDuration, totalCost,
    randevuCount, randevuRate,
    ilgiDistribution:    ilgiOrder.map(s => ({ seviye: s, count: ilgiMap[s] || 0 })),
    retNedeniDistribution,
    actionDistribution:  Object.entries(actionMap).map(([action, count]) => ({ action, count })),
    dailyCalls:          Object.entries(dailyCalls).map(([date, count]) => ({ date, count })),
    costTrend:           Object.entries(dailyCost).map(([date, cost]) => ({ date, cost })),
    hourlyDistribution:  Object.entries(hourMap).map(([hour, count]) => ({ hour: Number(hour), count })).sort((a, b) => a.hour - b.hour),
    statusBreakdown:     Object.entries(statusMap).map(([status, count]) => ({ status, count })),
  };
}

export async function exportCSV(filters?: CallFilters): Promise<string> {
  const calls = await getAllCalls(filters);
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
