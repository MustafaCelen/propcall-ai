// PropCall AI — Sunucu tarafı kampanya yöneticisi
// Tarayıcı kapansa bile çalışmaya devam eder.

import { createVapiCall } from './vapi';
import { readCall, createCall, callStatusToTurkish } from './calls';
import { getScenario } from './scenarios';
import { CustomerInfo, CallSummary } from './types';
import pool from './db';

// ─── Tipler ──────────────────────────────────────────────────────────────────

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

export interface CampaignSnapshot {
  contacts: CampaignContact[];
  running: boolean;
  paused: boolean;
  maxConcurrent: number;
  scenarioId?: string;
  startFromIndex?: number;  // 0-tabanlı; bu satırdan öncekileri atla
  callLimit?: number;       // toplam arama limiti (0 = sınırsız)
  answeredLimit?: number;   // konuşulan (tamamlandı) arama limiti (0 = sınırsız)
}

type BroadcastFn = (event: string, data: unknown) => void;

// ─── Sabitler ─────────────────────────────────────────────────────────────────

const CALL_TIMEOUT_MS      = 5 * 60 * 1000; // 5 dakika
const TICK_ACTIVE_MS       = 5  * 1000;     // Aktif arama varsa: 5 sn
const TICK_RUNNING_MS      = 15 * 1000;     // Çalışıyor ama bekliyor: 15 sn
const TICK_IDLE_MS         = 30 * 1000;     // Durmuş/duraklatılmış: 30 sn

// ─── Durum ───────────────────────────────────────────────────────────────────

let broadcastFn: BroadcastFn = () => {};

const state: CampaignSnapshot = {
  contacts:       [],
  running:        false,
  paused:         false,
  maxConcurrent:  1,
};

// ─── Başlatıcı ────────────────────────────────────────────────────────────────

function scheduleNextTick(): void {
  const hasActive = state.contacts.some(c => c.status === 'arıyor');
  const delay = hasActive
    ? TICK_ACTIVE_MS
    : (state.running && !state.paused ? TICK_RUNNING_MS : TICK_IDLE_MS);
  setTimeout(async () => {
    await tick();
    scheduleNextTick();
  }, delay).unref();
}

export function initCampaignRunner(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
  scheduleNextTick();
}

// ─── DB ───────────────────────────────────────────────────────────────────────

export async function loadCampaignFromDb(): Promise<void> {
  try {
    const { rows } = await pool.query(`SELECT data FROM campaign_state WHERE id = 'current'`);
    if (!rows[0]?.data) return;
    const saved = rows[0].data as CampaignSnapshot;

    state.contacts = (saved.contacts || []).map(c => ({
      ...c,
      // Sunucu yeniden başladıysa "arıyor" durumundakileri sıraya geri al
      status:      (c.status === 'arıyor' ? 'bekliyor' : c.status) as CampaignContact['status'],
      vapiCallId:  c.status === 'arıyor' ? null : c.vapiCallId,
      callStartTs: undefined,
    }));
    state.maxConcurrent = saved.maxConcurrent || 1;
    state.scenarioId    = saved.scenarioId;
    state.paused        = saved.paused || false;
    state.running       = false; // Kullanıcı "Başlat"a tekrar basana kadar bekle

    console.log(`[Campaign] ${state.contacts.length} kişilik kampanya yüklendi`);
  } catch (err) {
    console.error('[Campaign] DB yükleme hatası:', err);
  }
}

async function saveCampaignToDb(): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO campaign_state (id, data, updated_at) VALUES ('current', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
      [JSON.stringify(state)],
    );
  } catch (err) {
    console.error('[Campaign] DB kaydetme hatası:', err);
  }
}

// ─── API Komutları ────────────────────────────────────────────────────────────

export function getCampaignState(): CampaignSnapshot {
  return {
    ...state,
    contacts: state.contacts.map(c => ({ ...c })),
  };
}

export async function campaignLoad(
  contacts: Omit<CampaignContact, 'status' | 'vapiCallId' | 'result'>[],
  maxConcurrent: number,
  scenarioId?: string,
  startFromIndex?: number,
  callLimit?: number,
  answeredLimit?: number,
): Promise<void> {
  state.running        = false;
  state.paused         = false;
  state.maxConcurrent  = maxConcurrent;
  state.scenarioId     = scenarioId;
  state.startFromIndex = startFromIndex || 0;
  state.callLimit      = callLimit      || 0;
  state.answeredLimit  = answeredLimit  || 0;
  state.contacts       = contacts.map(c => ({
    ...c, status: 'bekliyor', vapiCallId: null, result: null,
  }));
  await saveCampaignToDb();
  broadcastFn('campaign-update', getCampaignState());
}

export async function campaignStart(): Promise<void> {
  if (!state.contacts.length) return;
  state.running = true;
  state.paused  = false;
  await saveCampaignToDb();
  broadcastFn('campaign-update', getCampaignState());
  fillQueue();
}

export async function campaignResume(): Promise<void> {
  if (!state.contacts.length) return;
  state.running = true;
  state.paused  = false;
  await saveCampaignToDb();
  broadcastFn('campaign-update', getCampaignState());
  fillQueue();
}

export async function campaignPause(): Promise<{ paused: boolean }> {
  state.paused = !state.paused;
  await saveCampaignToDb();
  broadcastFn('campaign-update', getCampaignState());
  if (!state.paused) fillQueue();
  return { paused: state.paused };
}

export async function campaignStop(): Promise<void> {
  state.running = false;
  state.paused  = false;
  state.contacts.forEach(c => {
    if (c.status === 'bekliyor') c.status = 'başarısız';
  });
  await saveCampaignToDb();
  broadcastFn('campaign-update', getCampaignState());
}

export async function campaignClear(): Promise<void> {
  state.running  = false;
  state.paused   = false;
  state.contacts = [];
  await pool.query(`DELETE FROM campaign_state WHERE id = 'current'`);
  broadcastFn('campaign-update', getCampaignState());
}

// ─── Webhook kancaları ────────────────────────────────────────────────────────

// Kampanya durum önceliği: yüksek sayı = daha kesin sonuç
const STATUS_PRIORITY: Record<string, number> = {
  'tamamlandı': 4, 'cevapsız': 3, 'meşgul': 2, 'başarısız': 1, 'arıyor': 0, 'bekliyor': -1,
};

export async function onCampaignCallEnded(
  vapiCallId: string, status: string, duration?: number,
): Promise<void> {
  const idx = state.contacts.findIndex(c => c.vapiCallId === vapiCallId);
  if (idx < 0) return;

  const c      = state.contacts[idx];
  const mapped = callStatusToTurkish(status) as CampaignContact['status'];

  const currentPriority = STATUS_PRIORITY[c.status] ?? 0;
  const newPriority     = STATUS_PRIORITY[mapped]   ?? 0;

  // Statü güncelle: ya hâlâ arıyor durumdaysa YA DA gelen durum daha kesin/yüksek öncelikli ise.
  // Bu sayede call-ended (fallback) + end-of-call-report (yetkili) çifti doğru çalışır:
  // call-ended geçici olarak başarısız set edebilir, end-of-call-report doğruysa tamamlandı'ya yükseltir.
  if (newPriority > currentPriority || c.status === 'arıyor') {
    c.status = mapped;
  } else {
    console.log(`[Campaign] onCampaignCallEnded: "${c.name}" ${c.status}→${mapped} düşürme önlendi`);
  }

  // Süreyi her zaman güncelle (en iyi değer end-of-call-report'tan gelir)
  if (duration && (!c.duration || duration > c.duration)) c.duration = duration;

  await saveCampaignToDb();
  broadcastFn('campaign-contact-update', {
    index: idx, contact: { ...c }, summary: getCampaignSummary(),
  });

  if (isDone()) { await onCampaignComplete(); return; }
  if (state.running && !state.paused) fillQueue();
}

export async function onCampaignSummaryReady(
  vapiCallId: string, summary: CallSummary,
): Promise<void> {
  const idx = state.contacts.findIndex(c => c.vapiCallId === vapiCallId);
  if (idx < 0) return;
  state.contacts[idx].result = summary;
  await saveCampaignToDb();
  broadcastFn('campaign-contact-update', {
    index: idx, contact: { ...state.contacts[idx] }, summary: getCampaignSummary(),
  });
}

// ─── İç yardımcılar ───────────────────────────────────────────────────────────

// mapStatus kaldırıldı — yerine callStatusToTurkish (calls.ts) kullanılıyor

function isDone(): boolean {
  const startIdx = state.startFromIndex ?? 0;
  const scope    = state.contacts.slice(startIdx);
  if (scope.length === 0) return false;

  const active = scope.filter(c => c.status === 'arıyor').length;
  if (active > 0) return false; // hâlâ aktif arama var

  const allDone = scope.every(c => c.status !== 'bekliyor' && c.status !== 'arıyor');
  if (allDone) return true;

  // Toplam arama limiti aşıldıysa bitti say
  if (state.callLimit && state.callLimit > 0) {
    const dialed = scope.filter(c => c.status !== 'bekliyor').length;
    if (dialed >= state.callLimit) return true;
  }

  // Cevaplayan limiti aşıldıysa bitti say
  if (state.answeredLimit && state.answeredLimit > 0) {
    const answered = state.contacts.filter(c => c.status === 'tamamlandı').length;
    if (answered >= state.answeredLimit) return true;
  }

  return false;
}

function getCampaignSummary() {
  const total   = state.contacts.length;
  const done    = state.contacts.filter(c => c.status !== 'bekliyor' && c.status !== 'arıyor').length;
  const randevu = state.contacts.filter(c => c.result?.randevu_alindi).length;
  const fail    = state.contacts.filter(c =>
    ['cevapsız','meşgul','başarısız'].includes(c.status)).length;
  const active  = state.contacts.filter(c => c.status === 'arıyor').length;
  return { total, done, randevu, fail, active };
}

async function onCampaignComplete(): Promise<void> {
  state.running = false;
  const randevu = state.contacts.filter(c => c.result?.randevu_alindi).length;
  await saveCampaignToDb();
  broadcastFn('campaign-complete', { randevu, total: state.contacts.length });
  console.log(`[Campaign] Tamamlandı — ${randevu}/${state.contacts.length} randevu`);
}

function fillQueue(): void {
  if (!state.running || state.paused) return;

  const startIdx = state.startFromIndex ?? 0;
  const answered = state.contacts.filter(c => c.status === 'tamamlandı').length;
  const active   = state.contacts.filter(c => c.status === 'arıyor').length;

  // Cevaplayan limiti dolmuşsa bekleyenleri iptal et ve bitir
  if (state.answeredLimit && state.answeredLimit > 0 && answered >= state.answeredLimit) {
    let changed = false;
    state.contacts.forEach(c => { if (c.status === 'bekliyor') { c.status = 'başarısız'; changed = true; } });
    if (active === 0) { if (changed) void saveCampaignToDb(); void onCampaignComplete(); }
    return;
  }

  // Toplam arama limiti dolmuşsa bekleyenleri iptal et ve bitir
  if (state.callLimit && state.callLimit > 0) {
    const dialed = state.contacts.slice(startIdx).filter(c => c.status !== 'bekliyor').length;
    if (dialed >= state.callLimit) {
      let changed = false;
      state.contacts.forEach(c => { if (c.status === 'bekliyor') { c.status = 'başarısız'; changed = true; } });
      if (active === 0) { if (changed) void saveCampaignToDb(); void onCampaignComplete(); }
      return;
    }
  }

  let slots = state.maxConcurrent - active;

  // Cevaplayan limitine kalan boşluğu geç — fazla arama başlatma
  if (state.answeredLimit && state.answeredLimit > 0) {
    const remaining = state.answeredLimit - answered - active;
    slots = Math.min(slots, remaining);
  }

  if (slots <= 0) return;

  let started = 0;
  for (let i = startIdx; i < state.contacts.length && started < slots; i++) {
    if (state.contacts[i].status === 'bekliyor') {
      callContact(i);
      started++;
    }
  }
}

async function callContact(idx: number): Promise<void> {
  const c      = state.contacts[idx];
  c.status     = 'arıyor';
  c.callStartTs = Date.now();

  broadcastFn('campaign-contact-update', {
    index: idx, contact: { ...c }, summary: getCampaignSummary(),
  });

  try {
    const scenario = state.scenarioId ? await getScenario(state.scenarioId) : null;
    const customer: CustomerInfo = {
      name: c.name, phone: c.phone,
      region: c.region || '', notes: c.notes || '',
    };
    const vapiCall = await createVapiCall(customer, scenario?.systemPrompt);
    c.vapiCallId   = vapiCall.id;

    // Aramayı DB'ye kaydet — Geçmiş Aramalar'da görünmesi için
    await createCall(vapiCall.id, customer, scenario?.id, scenario?.name);

    await saveCampaignToDb();
    broadcastFn('campaign-contact-update', {
      index: idx, contact: { ...c }, summary: getCampaignSummary(),
    });
    console.log(`[Campaign] Arama başlatıldı: ${c.name} → ${vapiCall.id}`);
  } catch (err) {
    console.error(`[Campaign] Arama hatası (${c.name}):`, err);
    c.status = 'başarısız';
    await saveCampaignToDb();
    broadcastFn('campaign-contact-update', {
      index: idx, contact: { ...c }, summary: getCampaignSummary(),
    });
    if (state.running && !state.paused) fillQueue();
  }
}

// Periyodik kontrol: takılı kalan aramaları temizle, boş slotları doldur
async function tick(): Promise<void> {
  if (!state.running || state.paused) return;

  const now     = Date.now();
  let   changed = false;

  for (const c of state.contacts) {
    if (c.status !== 'arıyor' || !c.vapiCallId) continue;

    // Zaman aşımı
    if (c.callStartTs && (now - c.callStartTs) > CALL_TIMEOUT_MS) {
      console.warn(`[Campaign] Zaman aşımı: ${c.vapiCallId}`);
      c.status = 'başarısız';
      changed  = true;
      continue;
    }

    // DB'den gerçek durumu kontrol et
    try {
      const record = await readCall(c.vapiCallId);
      if (record && record.status !== 'in-progress') {
        c.status = callStatusToTurkish(record.status) as CampaignContact['status'];
        if (record.duration) c.duration = record.duration;
        changed = true;
      }
    } catch (_) {}
  }

  if (changed) {
    await saveCampaignToDb();
    broadcastFn('campaign-update', getCampaignState());
    if (isDone()) { await onCampaignComplete(); return; }
  }

  fillQueue();
}
