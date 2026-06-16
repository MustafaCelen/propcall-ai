// PropCall AI — Sunucu tarafı kampanya yöneticisi
// Tarayıcı kapansa bile çalışmaya devam eder.

import { createVapiCall } from './vapi';
import { readCall } from './calls';
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
}

type BroadcastFn = (event: string, data: unknown) => void;

// ─── Sabitler ─────────────────────────────────────────────────────────────────

const CALL_TIMEOUT_MS  = 5 * 60 * 1000; // 5 dakika
const TICK_INTERVAL_MS = 10 * 1000;      // 10 saniye

// ─── Durum ───────────────────────────────────────────────────────────────────

let broadcastFn: BroadcastFn = () => {};

const state: CampaignSnapshot = {
  contacts:       [],
  running:        false,
  paused:         false,
  maxConcurrent:  1,
};

// ─── Başlatıcı ────────────────────────────────────────────────────────────────

export function initCampaignRunner(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
  setInterval(tick, TICK_INTERVAL_MS);
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
): Promise<void> {
  state.running       = false;
  state.paused        = false;
  state.maxConcurrent = maxConcurrent;
  state.scenarioId    = scenarioId;
  state.contacts      = contacts.map(c => ({
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

export async function onCampaignCallEnded(
  vapiCallId: string, status: string, duration?: number,
): Promise<void> {
  const idx = state.contacts.findIndex(c => c.vapiCallId === vapiCallId);
  if (idx < 0) return;

  const mapped = mapStatus(status);
  const c      = state.contacts[idx];
  if (c.status === 'tamamlandı' && mapped === 'başarısız') return;

  c.status = mapped;
  if (duration) c.duration = duration;

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

function mapStatus(status: string): CampaignContact['status'] {
  if (status === 'completed') return 'tamamlandı';
  if (status === 'no-answer') return 'cevapsız';
  if (status === 'busy')      return 'meşgul';
  return 'başarısız';
}

function isDone(): boolean {
  return state.contacts.length > 0 &&
    state.contacts.every(c => c.status !== 'bekliyor' && c.status !== 'arıyor');
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
  const active = state.contacts.filter(c => c.status === 'arıyor').length;
  const slots  = state.maxConcurrent - active;
  if (slots <= 0) return;

  let started = 0;
  for (let i = 0; i < state.contacts.length && started < slots; i++) {
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
    let systemPrompt: string | undefined;
    if (state.scenarioId) {
      const scenario = await getScenario(state.scenarioId);
      systemPrompt   = scenario?.systemPrompt;
    }
    const customer: CustomerInfo = {
      name: c.name, phone: c.phone,
      region: c.region || '', notes: c.notes || '',
    };
    const vapiCall = await createVapiCall(customer, systemPrompt);
    c.vapiCallId   = vapiCall.id;
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
        c.status = mapStatus(record.status);
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
