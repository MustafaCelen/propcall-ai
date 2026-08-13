// PropCall AI — Sunucu tarafı kampanya çalıştırma motoru.
// Tarayıcı kapansa bile çalışmaya devam eder.
//
// Kalıcı kayıt (isim, geçmiş, analiz) campaigns.ts'te tutulur — bu dosya sadece
// AKTİF kampanyanın canlı kuyruk/dialer mantığını yönetir ve o kaydı günceller.

import { createVapiCall } from './vapi';
import { readCall, createCall, callStatusToTurkish } from './calls';
import { getScenario } from './scenarios';
import { CustomerInfo, CallSummary } from './types';
import {
  CampaignContact, CampaignRecord,
  createCampaign, getActiveCampaign,
  saveCampaignContacts, setCampaignStatus,
} from './campaigns';

export type { CampaignContact } from './campaigns';

// ─── Tipler ──────────────────────────────────────────────────────────────────

export interface CampaignSnapshot {
  id: string | null;         // campaigns tablosundaki kalıcı kayıt id'si
  name: string;
  contacts: CampaignContact[];
  running: boolean;
  paused: boolean;
  maxConcurrent: number;
  scenarioId?: string;
  startFromIndex?: number;
  callLimit?: number;
  answeredLimit?: number;
}

type BroadcastFn = (event: string, data: unknown) => void;

// ─── Sabitler ─────────────────────────────────────────────────────────────────

const CALL_TIMEOUT_MS      = 5 * 60 * 1000; // 5 dakika
const TICK_ACTIVE_MS       = 5  * 1000;
const TICK_RUNNING_MS      = 15 * 1000;
const TICK_IDLE_MS         = 30 * 1000;

// ─── Durum ───────────────────────────────────────────────────────────────────

let broadcastFn: BroadcastFn = () => {};

const state: CampaignSnapshot = {
  id: null,
  name: '',
  contacts: [],
  running: false,
  paused: false,
  maxConcurrent: 1,
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

function applyRecordToState(rec: CampaignRecord): void {
  state.id             = rec.id;
  state.name           = rec.name;
  state.contacts       = rec.contacts.map(c => ({
    ...c,
    // Sunucu yeniden başladıysa "arıyor" durumundakileri sıraya geri al
    status:      (c.status === 'arıyor' ? 'bekliyor' : c.status) as CampaignContact['status'],
    vapiCallId:  c.status === 'arıyor' ? null : c.vapiCallId,
    callStartTs: undefined,
  }));
  state.maxConcurrent   = rec.maxConcurrent || 1;
  state.scenarioId      = rec.scenarioId;
  state.startFromIndex  = rec.startFromIndex || 0;
  state.callLimit       = rec.callLimit || 0;
  state.answeredLimit   = rec.answeredLimit || 0;
  state.paused          = rec.status === 'paused';
  state.running         = false; // Kullanıcı "Başlat"a tekrar basana kadar bekle
}

export async function loadCampaignFromDb(): Promise<void> {
  try {
    const active = await getActiveCampaign();
    if (!active) return;
    applyRecordToState(active);
    console.log(`[Campaign] "${state.name}" yüklendi (${state.contacts.length} kişi, id=${state.id})`);
  } catch (err) {
    console.error('[Campaign] DB yükleme hatası:', err);
  }
}

async function persistContacts(): Promise<void> {
  if (!state.id) return;
  try {
    await saveCampaignContacts(state.id, state.contacts);
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

// Yeni bir kampanya kaydı açar (durum: draft) ve motoru ona bağlar.
export async function campaignLoad(
  contacts: Array<Omit<CampaignContact, 'status' | 'vapiCallId' | 'result'>>,
  maxConcurrent: number,
  scenarioId?: string,
  startFromIndex?: number,
  callLimit?: number,
  answeredLimit?: number,
  name?: string,
): Promise<void> {
  const scenario = scenarioId ? await getScenario(scenarioId) : null;
  const record = await createCampaign({
    name: name?.trim() || `Kampanya ${new Date().toLocaleDateString('tr-TR')}`,
    scenarioId,
    scenarioName: scenario?.name,
    maxConcurrent,
    startFromIndex: startFromIndex || 0,
    callLimit: callLimit || 0,
    answeredLimit: answeredLimit || 0,
    contacts,
  });
  applyRecordToState(record);
  broadcastFn('campaign-update', getCampaignState());
}

export async function campaignStart(): Promise<void> {
  if (!state.contacts.length || !state.id) return;
  state.running = true;
  state.paused  = false;
  await setCampaignStatus(state.id, 'running', { markStarted: true });
  broadcastFn('campaign-update', getCampaignState());
  fillQueue();
}

export async function campaignResume(): Promise<void> {
  if (!state.contacts.length || !state.id) return;
  state.running = true;
  state.paused  = false;
  await setCampaignStatus(state.id, 'running');
  broadcastFn('campaign-update', getCampaignState());
  fillQueue();
}

export async function campaignPause(): Promise<{ paused: boolean }> {
  state.paused = !state.paused;
  if (state.id) await setCampaignStatus(state.id, state.paused ? 'paused' : 'running');
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
  if (state.id) {
    await persistContacts();
    await setCampaignStatus(state.id, 'stopped');
  }
  broadcastFn('campaign-update', getCampaignState());
}

// "Temizle" artık kampanyayı SİLMEZ — geçmişte durur, sadece canlı dialer'ı boşaltır.
export async function campaignClear(): Promise<void> {
  state.id             = null;
  state.name           = '';
  state.running        = false;
  state.paused         = false;
  state.contacts       = [];
  state.scenarioId     = undefined;
  state.startFromIndex = 0;
  state.callLimit      = 0;
  state.answeredLimit  = 0;
  broadcastFn('campaign-update', getCampaignState());
}

// ─── Webhook kancaları ────────────────────────────────────────────────────────

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

  if (newPriority > currentPriority || c.status === 'arıyor') {
    c.status = mapped;
  } else {
    console.log(`[Campaign] onCampaignCallEnded: "${c.name}" ${c.status}→${mapped} düşürme önlendi`);
  }

  if (duration && (!c.duration || duration > c.duration)) c.duration = duration;

  await persistContacts();
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
  await persistContacts();
  broadcastFn('campaign-contact-update', {
    index: idx, contact: { ...state.contacts[idx] }, summary: getCampaignSummary(),
  });
}

// ─── İç yardımcılar ───────────────────────────────────────────────────────────

function isDone(): boolean {
  const startIdx = state.startFromIndex ?? 0;
  const scope    = state.contacts.slice(startIdx);
  if (scope.length === 0) return false;

  const active = scope.filter(c => c.status === 'arıyor').length;
  if (active > 0) return false;

  const allDone = scope.every(c => c.status !== 'bekliyor' && c.status !== 'arıyor');
  if (allDone) return true;

  if (state.callLimit && state.callLimit > 0) {
    const dialed = scope.filter(c => c.status !== 'bekliyor').length;
    if (dialed >= state.callLimit) return true;
  }

  if (state.answeredLimit && state.answeredLimit > 0) {
    const answered = state.contacts.filter(c => c.status === 'tamamlandı').length;
    if (answered >= state.answeredLimit) return true;
  }

  return false;
}

function getCampaignSummary() {
  const total       = state.contacts.length;
  const active      = state.contacts.filter(c => c.status === 'arıyor').length;
  const waiting     = state.contacts.filter(c => c.status === 'bekliyor').length;
  const appointment = state.contacts.filter(c => c.status === 'tamamlandı' && c.result?.randevu_alindi === true).length;
  const talked      = state.contacts.filter(c => c.status === 'tamamlandı' && !c.result?.randevu_alindi).length;
  const unreachable = state.contacts.filter(c => c.status === 'cevapsız' || c.status === 'meşgul').length;
  const error       = state.contacts.filter(c => c.status === 'başarısız').length;
  const done        = appointment + talked + unreachable + error;
  return { total, done, active, waiting, appointment, talked, unreachable, error, randevu: appointment, fail: unreachable + error };
}

async function onCampaignComplete(): Promise<void> {
  state.running = false;
  const randevu = state.contacts.filter(c => c.result?.randevu_alindi).length;
  if (state.id) {
    await persistContacts();
    await setCampaignStatus(state.id, 'completed', { markCompleted: true });
  }
  broadcastFn('campaign-complete', { randevu, total: state.contacts.length });
  console.log(`[Campaign] "${state.name}" tamamlandı — ${randevu}/${state.contacts.length} randevu`);
}

function fillQueue(): void {
  if (!state.running || state.paused) return;

  const startIdx = state.startFromIndex ?? 0;
  const answered = state.contacts.filter(c => c.status === 'tamamlandı').length;
  const active   = state.contacts.filter(c => c.status === 'arıyor').length;

  if (state.answeredLimit && state.answeredLimit > 0 && answered >= state.answeredLimit) {
    let changed = false;
    state.contacts.forEach(c => { if (c.status === 'bekliyor') { c.status = 'başarısız'; changed = true; } });
    if (active === 0) { if (changed) void persistContacts(); void onCampaignComplete(); }
    return;
  }

  if (state.callLimit && state.callLimit > 0) {
    const dialed = state.contacts.slice(startIdx).filter(c => c.status !== 'bekliyor').length;
    if (dialed >= state.callLimit) {
      let changed = false;
      state.contacts.forEach(c => { if (c.status === 'bekliyor') { c.status = 'başarısız'; changed = true; } });
      if (active === 0) { if (changed) void persistContacts(); void onCampaignComplete(); }
      return;
    }
  }

  let slots = state.maxConcurrent - active;

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

    // Aramayı DB'ye kaydet — Geçmiş Aramalar'da VE kampanya analizinde görünmesi için
    await createCall(vapiCall.id, customer, scenario?.id, scenario?.name, state.id || undefined);

    await persistContacts();
    broadcastFn('campaign-contact-update', {
      index: idx, contact: { ...c }, summary: getCampaignSummary(),
    });
    console.log(`[Campaign] Arama başlatıldı: ${c.name} → ${vapiCall.id}`);
  } catch (err) {
    console.error(`[Campaign] Arama hatası (${c.name}):`, err);
    c.status = 'başarısız';
    await persistContacts();
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

    if (c.callStartTs && (now - c.callStartTs) > CALL_TIMEOUT_MS) {
      console.warn(`[Campaign] Zaman aşımı: ${c.vapiCallId}`);
      c.status = 'başarısız';
      changed  = true;
      continue;
    }

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
    await persistContacts();
    broadcastFn('campaign-update', getCampaignState());
    if (isDone()) { await onCampaignComplete(); return; }
  }

  fillQueue();
}
