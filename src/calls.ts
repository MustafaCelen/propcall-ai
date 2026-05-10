// PropCall AI - Arama kayıtları (data/calls/ klasörüne bireysel JSON)

import fs from 'fs';
import path from 'path';
import {
  CallRecord, CustomerInfo, CallSummary, CallCosts,
  VapiTranscriptEntry, CallFilters, StatsData
} from './types';

const CALLS_DIR = path.join(__dirname, '..', 'data', 'calls');
const OLD_FILE  = path.join(__dirname, '..', 'data', 'calls.json');

function ensureDir(): void {
  if (!fs.existsSync(CALLS_DIR)) fs.mkdirSync(CALLS_DIR, { recursive: true });
}

function callPath(vapiCallId: string): string {
  return path.join(CALLS_DIR, `${vapiCallId}.json`);
}

export function readCall(vapiCallId: string): CallRecord | null {
  const p = callPath(vapiCallId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as CallRecord; }
  catch { return null; }
}

function writeCall(record: CallRecord): void {
  ensureDir();
  fs.writeFileSync(callPath(record.vapiCallId), JSON.stringify(record, null, 2), 'utf-8');
}

// Eski calls.json'u bireysel dosyalara taşı
function migrateOldCalls(): void {
  if (!fs.existsSync(OLD_FILE)) return;
  try {
    const old = JSON.parse(fs.readFileSync(OLD_FILE, 'utf-8')) as Record<string, unknown>[];
    old.forEach((c: any) => {
      if (!c.vapiCallId) return;
      const p = callPath(c.vapiCallId);
      if (fs.existsSync(p)) return;
      const record: CallRecord = {
        callId:       c.id || c.callId || `call_${Date.now()}`,
        vapiCallId:   c.vapiCallId,
        customerName: c.customerName || '',
        customerPhone: c.customerPhone || '',
        customerInfo: c.customerInfo || { name: c.customerName, phone: c.customerPhone, region: '', notes: '' },
        startTime:    c.startedAt || c.startTime || c.createdAt,
        endTime:      c.endedAt || c.endTime,
        duration:     c.durationSeconds || c.duration,
        transcript:   c.transcript || [],
        costs:        c.costs || { vapi: 0, twilio: 0, llm: 0, tts: 0, stt: 0, total: 0 },
        summary:      c.summary,
        recordingUrl: c.recordingUrl,
        status:       mapStatus(c.endedReason, c.status),
        notes:        c.notes || '',
        followUp:     c.followUp || false,
        createdAt:    c.createdAt || c.startTime || new Date().toISOString(),
      };
      writeCall(record);
    });
    fs.renameSync(OLD_FILE, OLD_FILE.replace('.json', '.backup.json'));
  } catch (e) {
    console.error('[Migration] Eski calls.json taşınamadı:', e);
  }
}

function mapStatus(endedReason?: string, oldStatus?: string): CallRecord['status'] {
  if (!endedReason) {
    if (oldStatus === 'ended' || oldStatus === 'completed') return 'completed';
    if (oldStatus === 'in-progress' || oldStatus === 'initiated') return 'in-progress';
    return 'failed';
  }
  const r = endedReason.toLowerCase();
  if (['customer-ended-call','assistant-ended-call','assistant-forwarded-call',
       'exceeded-max-duration','manual','silence-timed-out'].includes(r)) return 'completed';
  if (r.includes('no-answer') || r === 'voicemail') return 'no-answer';
  if (r === 'busy') return 'busy';
  return 'failed';
}

export function endedReasonToStatus(r?: string): CallRecord['status'] {
  return mapStatus(r);
}

export function getAllCalls(filters?: CallFilters): CallRecord[] {
  ensureDir();
  migrateOldCalls();

  const files = fs.readdirSync(CALLS_DIR).filter(f => f.endsWith('.json'));
  let calls = files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(CALLS_DIR, f), 'utf-8')) as CallRecord; }
    catch { return null; }
  }).filter(Boolean) as CallRecord[];

  if (filters) {
    if (filters.dateFrom)    calls = calls.filter(c => c.startTime >= filters.dateFrom!);
    if (filters.dateTo)      calls = calls.filter(c => c.startTime <= filters.dateTo! + 'T23:59:59');
    if (filters.minScore !== undefined)
      calls = calls.filter(c => (c.summary?.sicaklik_skoru ?? 0) >= filters.minScore!);
    if (filters.maxScore !== undefined)
      calls = calls.filter(c => (c.summary?.sicaklik_skoru ?? 100) <= filters.maxScore!);
    if (filters.niyet)   calls = calls.filter(c => c.summary?.niyet === filters.niyet);
    if (filters.aksiyon) calls = calls.filter(c => c.summary?.tavsiye_edilen_aksiyon === filters.aksiyon);
    if (filters.status)  calls = calls.filter(c => c.status === filters.status);
    if (filters.randevu === 'evet') calls = calls.filter(c => c.summary?.randevu_alindi === true);
    if (filters.randevu === 'hayir') calls = calls.filter(c => c.summary?.randevu_alindi === false);
    if (filters.scenarioId) calls = calls.filter(c => c.scenarioId === filters.scenarioId);
  }

  return calls.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
}

export function createCall(vapiCallId: string, customer: CustomerInfo, scenarioId?: string, scenarioName?: string): CallRecord {
  ensureDir();
  const record: CallRecord = {
    callId:       `call_${Date.now()}`,
    vapiCallId,
    customerName: customer.name,
    customerPhone: customer.phone,
    customerInfo: customer,
    startTime:    new Date().toISOString(),
    transcript:   [],
    costs:        { vapi: 0, twilio: 0, llm: 0, tts: 0, stt: 0, total: 0 },
    status:       'in-progress',
    followUp:     false,
    createdAt:    new Date().toISOString(),
    scenarioId,
    scenarioName,
  };
  writeCall(record);
  return record;
}

export function updateCall(vapiCallId: string, updates: Partial<CallRecord>): CallRecord | null {
  const record = readCall(vapiCallId);
  if (!record) return null;
  const updated = { ...record, ...updates };
  writeCall(updated);
  return updated;
}

export function appendTranscript(vapiCallId: string, entry: VapiTranscriptEntry): void {
  const record = readCall(vapiCallId);
  if (!record) return;
  record.transcript.push(entry);
  writeCall(record);
}

export function updateCosts(vapiCallId: string, costs: Partial<CallCosts>): void {
  const record = readCall(vapiCallId);
  if (!record) return;
  record.costs = { ...record.costs, ...costs };
  writeCall(record);
}

export function saveCallSummary(vapiCallId: string, summary: CallSummary): void {
  updateCall(vapiCallId, { summary });
}

export function getStats(): StatsData {
  const calls     = getAllCalls();
  const finished  = calls.filter(c => c.status !== 'in-progress');
  const withScore = finished.filter(c => c.summary?.sicaklik_skoru !== undefined);

  const totalCalls   = calls.length;
  const avgDuration  = finished.length
    ? Math.round(finished.reduce((s, c) => s + (c.duration || 0), 0) / finished.length) : 0;
  const avgHeatScore = withScore.length
    ? Math.round(withScore.reduce((s, c) => s + c.summary!.sicaklik_skoru, 0) / withScore.length) : 0;
  const totalCost    = Math.round(calls.reduce((s, c) => s + (c.costs?.total || 0), 0) * 10000) / 10000;
  const conversionRate = withScore.length
    ? Math.round(withScore.filter(c => c.summary!.sicaklik_skoru >= 60).length / withScore.length * 100) : 0;
  const randevuCount = finished.filter(c => c.summary?.randevu_alindi === true).length;

  // Günlük veriler — son 30 gün
  const dailyCalls: Record<string, number> = {};
  const dailyCost:  Record<string, number> = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = d.toISOString().slice(0, 10);
    dailyCalls[k] = 0;
    dailyCost[k]  = 0;
  }
  calls.forEach(c => {
    const k = c.startTime.slice(0, 10);
    if (k in dailyCalls) {
      dailyCalls[k]++;
      dailyCost[k] = Math.round((dailyCost[k] + (c.costs?.total || 0)) * 10000) / 10000;
    }
  });

  // Sıcaklık dağılımı
  const heatBuckets = ['0-20', '20-40', '40-60', '60-80', '80-100'];
  const heatDistribution = heatBuckets.map(range => {
    const [min, max] = range.split('-').map(Number);
    return { range, count: withScore.filter(c => c.summary!.sicaklik_skoru >= min && c.summary!.sicaklik_skoru <= max).length };
  });

  // Niyet dağılımı
  const niyetMap: Record<string, number> = {};
  finished.forEach(c => {
    const n = c.summary?.niyet || 'belirsiz';
    niyetMap[n] = (niyetMap[n] || 0) + 1;
  });

  return {
    totalCalls, avgDuration, avgHeatScore, totalCost, conversionRate, randevuCount,
    dailyCalls:       Object.entries(dailyCalls).map(([date, count]) => ({ date, count })),
    heatDistribution,
    intentDistribution: Object.entries(niyetMap).map(([niyet, count]) => ({ niyet, count })),
    costTrend:        Object.entries(dailyCost).map(([date, cost]) => ({ date, cost })),
  };
}

export function exportCSV(filters?: CallFilters): string {
  const calls = getAllCalls(filters);
  const headers = ['Tarih','Ad','Telefon','Süre','Sıcaklık','Niyet','Bölge','Bütçe','Zaman','Randevu','Aksiyon','Maliyet','Durum','Notlar'];
  const rows = calls.map(c => [
    new Date(c.startTime).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }),
    c.customerName, c.customerPhone,
    c.duration ? `${Math.floor(c.duration/60)}:${String(c.duration%60).padStart(2,'0')}` : '',
    c.summary?.sicaklik_skoru ?? '',
    c.summary?.niyet ?? '',
    c.summary?.bolge ?? '',
    c.summary?.butce ?? '',
    c.summary?.zaman_cercevesi ?? '',
    c.summary?.randevu_alindi != null ? (c.summary.randevu_alindi ? 'Evet' : 'Hayır') : '',
    c.summary?.tavsiye_edilen_aksiyon ?? '',
    c.costs?.total ?? 0,
    c.status,
    (c.notes || '').replace(/\n/g, ' '),
  ]);
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [headers.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
}
