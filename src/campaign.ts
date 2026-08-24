// PropCall AI — Sunucu tarafı kampanya çalıştırma motoru.
// Tarayıcı kapansa bile çalışmaya devam eder.
//
// Kalıcı kayıt (isim, geçmiş, analiz) campaigns.ts'te tutulur — bu dosya sadece
// AKTİF kampanyaların canlı kuyruk/dialer mantığını yönetir ve o kayıtları günceller.
//
// Faz 4: motor artık kampanya-başına eşzamanlı (Map<campaignId, entry>) — bir
// danışman birden fazla kampanyayı aynı anda çalıştırabilir, farklı danışmanlar
// da birbirini etkilemeden aynı anda arama yapabilir. Tek paylaşılan tick döngüsü
// tüm aktif kampanyaları Promise.allSettled ile PARALEL işler — sıralı bir döngü
// bir danışmanın yavaş bir Vapi çağrısının başka birinin kuyruğunu geciktirmesine
// (kiracılar arası sızıntıya) yol açardı.

import { createVapiCall } from './vapi';
import { getElevenLabsCredit } from './elevenlabs';
import {
  readCall, createCall, callStatusToTurkish,
  getBestCallsByPhoneForCampaign, findTodaysCallForPhone, BestCallInfo,
} from './calls';
import { getScenario } from './scenarios';
import { resolveVapiCreds, getUserById, getUserElevenLabsKey } from './users';
import { CustomerInfo, CallSummary } from './types';
import {
  CampaignContact, CampaignRecord,
  createCampaign, getAllActiveCampaigns,
  saveCampaignContacts, setCampaignStatus, updateCampaignSettings,
} from './campaigns';

export type { CampaignContact } from './campaigns';

// ─── Tipler ──────────────────────────────────────────────────────────────────

interface CampaignEngineEntry {
  id: string;
  userId: string;
  name: string;
  contacts: CampaignContact[];
  running: boolean;
  paused: boolean;
  maxConcurrent: number;
  scenarioId?: string;
  startFromIndex: number;
  callLimit: number;
  answeredLimit: number;
  updatedAt: number; // "kullanıcının şu an baktığı kampanya" fallback seçimi için
  // Arama saatleri dışındayken motorun kendisinin YENİ arama başlatmayı geçici
  // olarak ertelemesi — entry.paused'tan FARKLI: kullanıcı hiçbir şey yapmadan,
  // saat penceresi tekrar açılınca bir sonraki tick'te otomatik kalkar. Devam
  // eden aramalar kesilmez, sadece kuyruk doldurma bekletilir.
  autoHeld?: 'calling-hours';
}

// Dışa açık görünüm — bugünkü frontend'in beklediği şekle birebir uyar.
export interface CampaignSnapshot {
  id: string | null;
  userId: string | null;
  name: string;
  contacts: CampaignContact[];
  running: boolean;
  paused: boolean;
  maxConcurrent: number;
  scenarioId?: string;
  startFromIndex?: number;
  callLimit?: number;
  answeredLimit?: number;
  autoHeld?: 'calling-hours';
}

type BroadcastFn = (userId: string, event: string, data: unknown) => void;

// ─── Sabitler ─────────────────────────────────────────────────────────────────

const CALL_TIMEOUT_MS      = 5 * 60 * 1000; // 5 dakika
const TICK_ACTIVE_MS       = 5  * 1000;
const TICK_RUNNING_MS      = 15 * 1000;
const TICK_IDLE_MS         = 30 * 1000;

// Kişi durumları arasındaki "üstünlük" sırası — hem webhook'tan gelen güncellemelerin
// bir kişiyi yanlışlıkla geriye düşürmesini önlemek (onCampaignCallEnded), hem de DB
// senkronizasyonunda (recordToEntry, güvenlik ağı) gerçek durumun JSONB'dekinden daha
// "ileri" olup olmadığını karşılaştırmak için kullanılıyor.
const STATUS_PRIORITY: Record<string, number> = {
  'tamamlandı': 4, 'cevapsız': 3, 'meşgul': 2, 'başarısız': 1, 'arıyor': 0, 'bekliyor': -1,
};

// ─── Durum ───────────────────────────────────────────────────────────────────

let broadcastFn: BroadcastFn = () => {};
const engines = new Map<string, CampaignEngineEntry>();

// ─── Başlatıcı ────────────────────────────────────────────────────────────────

function scheduleNextTick(): void {
  const all        = [...engines.values()];
  const anyActive  = all.some(e => e.contacts.some(c => c.status === 'arıyor'));
  const anyRunning = all.some(e => e.running && !e.paused);
  const delay = anyActive ? TICK_ACTIVE_MS : anyRunning ? TICK_RUNNING_MS : TICK_IDLE_MS;
  setTimeout(async () => {
    await tickAll();
    scheduleNextTick();
  }, delay).unref();
}

export function initCampaignRunner(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
  scheduleNextTick();
}

// ─── DB ───────────────────────────────────────────────────────────────────────

// Sunucu açılışında sadece JSONB'deki kaydı güvenmek yerine, her kişiyi "calls"
// tablosundaki GERÇEK arama geçmişiyle karşılaştırıp senkronize eder. Gerekçe: bir
// webhook yazımı tam bir deploy/restart anında kaybolursa (örn. arıyor'da takılı
// kalmış ama aslında tamamlanmış bir kişi, ya da özeti hiç JSONB'ye yazılamamış bir
// randevu), JSONB'ye körü körüne güvenmek o hatayı kalıcı hale getirir ve motor o
// kişiyi TEKRAR arayabilir. calls tablosu buradaki tek gerçek kaynak (source of truth).
async function recordToEntry(rec: CampaignRecord): Promise<CampaignEngineEntry> {
  const bestCalls = await getBestCallsByPhoneForCampaign(rec.userId, rec.id);
  let changed = false;

  const contacts = rec.contacts.map(c => {
    const next: CampaignContact = {
      ...c,
      // Sunucu yeniden başladıysa "arıyor" durumundakileri varsayılan olarak sıraya
      // geri al — altta, bu numara için gerçekten tamamlanmış bir arama bulunursa bu
      // varsayım geçersiz kılınıp gerçek sonuç uygulanır.
      status:      (c.status === 'arıyor' ? 'bekliyor' : c.status) as CampaignContact['status'],
      vapiCallId:  c.status === 'arıyor' ? null : c.vapiCallId,
      callStartTs: undefined,
    };
    if (next.status !== c.status) changed = true;

    const best = bestCalls.get(c.phone);
    if (!best) return next;

    const mappedStatus  = callStatusToTurkish(best.status) as CampaignContact['status'];
    const currentPriority = STATUS_PRIORITY[next.status]    ?? -1;
    const realPriority    = STATUS_PRIORITY[mappedStatus]   ?? -1;
    if (realPriority > currentPriority) {
      next.status     = mappedStatus;
      next.vapiCallId = best.vapiCallId;
      changed = true;
    }
    if (best.summary && !next.result) { next.result = best.summary; changed = true; }
    return next;
  });

  // Uzlaştırma canlı motora bir şey değiştirdiyse, DB'deki JSONB kopyasını da HEMEN
  // güncelle — kampanya o an duraklatılmış/durmuşsa (fillQueue hiç çalışmayacaksa)
  // bu düzeltme aksi halde bir sonraki gerçek arama olayına kadar DB'ye hiç yazılmazdı.
  if (changed) {
    try {
      await saveCampaignContacts(rec.userId, rec.id, contacts);
      console.log(`[Campaign] "${rec.name}" — açılışta ${contacts.length} kişi calls tablosuyla senkronize edildi (düzeltme uygulandı).`);
    } catch (err) {
      console.error('[Campaign] Açılış senkronizasyonu DB yazım hatası:', err);
    }
  }

  return {
    id: rec.id,
    userId: rec.userId,
    name: rec.name,
    contacts,
    running: false, // Kullanıcı "Başlat"a tekrar basana kadar bekle
    paused: rec.status === 'paused',
    maxConcurrent: rec.maxConcurrent || 1,
    scenarioId: rec.scenarioId,
    startFromIndex: rec.startFromIndex || 0,
    callLimit: rec.callLimit || 0,
    answeredLimit: rec.answeredLimit || 0,
    updatedAt: Date.now(),
  };
}

function toSnapshot(e: CampaignEngineEntry | null): CampaignSnapshot {
  if (!e) {
    return {
      id: null, userId: null, name: '', contacts: [],
      running: false, paused: false, maxConcurrent: 1,
    };
  }
  return {
    id: e.id, userId: e.userId, name: e.name,
    contacts: e.contacts.map(c => ({ ...c })),
    running: e.running, paused: e.paused, maxConcurrent: e.maxConcurrent,
    scenarioId: e.scenarioId, startFromIndex: e.startFromIndex,
    callLimit: e.callLimit, answeredLimit: e.answeredLimit,
    autoHeld: e.autoHeld,
  };
}

// Sunucu açılışında TÜM kullanıcıların running/paused kampanyalarını yükler —
// tek en-son-güncellenen kaydı değil, hepsini (Faz 4 öncesi burada tek kayıt yüklenirdi).
export async function loadAllActiveCampaigns(): Promise<void> {
  try {
    const records = await getAllActiveCampaigns();
    const entries = await Promise.all(records.map(rec => recordToEntry(rec)));
    records.forEach((rec, i) => engines.set(rec.id, entries[i]));
    if (records.length) {
      console.log(`[Campaign] ${records.length} aktif kampanya yüklendi: ${records.map(r => `"${r.name}"`).join(', ')}`);
    }
  } catch (err) {
    console.error('[Campaign] DB yükleme hatası:', err);
  }
}

async function persistContacts(entry: CampaignEngineEntry): Promise<void> {
  try {
    await saveCampaignContacts(entry.userId, entry.id, entry.contacts);
  } catch (err) {
    console.error('[Campaign] DB kaydetme hatası:', err);
  }
}

// ─── İç yardımcılar: kampanya çözümleme ────────────────────────────────────────

// Frontend henüz kampanya seçici arayüzüne sahip değil — bu yüzden campaignId
// verilmediğinde "kullanıcının en son etkileşimde bulunduğu kampanya" varsayılır.
// Kullanıcı birden fazla kampanyayı aynı anda çalıştırıyorsa (motor bunu destekler),
// duraklat/durdur gibi tekil-kampanya işlemleri bu varsayılanı hedefler.
function resolveEntry(userId: string, campaignId?: string): CampaignEngineEntry | null {
  if (campaignId) {
    const e = engines.get(campaignId);
    return e && e.userId === userId ? e : null;
  }
  let best: CampaignEngineEntry | null = null;
  for (const e of engines.values()) {
    if (e.userId !== userId) continue;
    if (!best || e.updatedAt > best.updatedAt) best = e;
  }
  return best;
}

function findEntryByVapiCallId(vapiCallId: string): { entry: CampaignEngineEntry; idx: number } | null {
  for (const entry of engines.values()) {
    const idx = entry.contacts.findIndex(c => c.vapiCallId === vapiCallId);
    if (idx >= 0) return { entry, idx };
  }
  return null;
}

// ─── API Komutları ────────────────────────────────────────────────────────────

export function getCampaignState(userId: string, campaignId?: string): CampaignSnapshot {
  return toSnapshot(resolveEntry(userId, campaignId));
}

// Yeni bir kampanya kaydı açar (durum: draft) ve motora ekler — mevcut çalışan
// kampanyaları ETKİLEMEZ, aynı kullanıcı birden fazla kampanyayı eşzamanlı sürdürebilir.
export async function campaignLoad(
  userId: string,
  contacts: Array<Omit<CampaignContact, 'status' | 'vapiCallId' | 'result'>>,
  maxConcurrent: number,
  scenarioId?: string,
  startFromIndex?: number,
  callLimit?: number,
  answeredLimit?: number,
  name?: string,
): Promise<string> {
  const scenario = scenarioId ? await getScenario(userId, scenarioId) : null;
  const record = await createCampaign(userId, {
    name: name?.trim() || `Kampanya ${new Date().toLocaleDateString('tr-TR')}`,
    scenarioId,
    scenarioName: scenario?.name,
    maxConcurrent,
    startFromIndex: startFromIndex || 0,
    callLimit: callLimit || 0,
    answeredLimit: answeredLimit || 0,
    contacts,
  });
  // Yeni oluşan kampanyanın henüz "calls" tablosunda hiç kaydı yok — recordToEntry'nin
  // DB senkronizasyonu burada no-op olur, sadece contacts'ı doğrudan atıyoruz.
  const entry = await recordToEntry(record);
  entry.contacts = record.contacts;
  engines.set(record.id, entry);
  broadcastFn(userId, 'campaign-update', toSnapshot(entry));
  return record.id;
}

export async function campaignStart(userId: string, campaignId: string): Promise<void> {
  const entry = resolveEntry(userId, campaignId);
  if (!entry || !entry.contacts.length) return;
  entry.running   = true;
  entry.paused    = false;
  entry.updatedAt = Date.now();
  await setCampaignStatus(userId, entry.id, 'running', { markStarted: true });
  broadcastFn(userId, 'campaign-update', toSnapshot(entry));
  fillQueue(entry);
}

export interface CampaignResumeOverrides {
  startFromIndex?: number;
  maxConcurrent?: number;
  callLimit?: number;
  answeredLimit?: number;
}

// overrides verilirse (örn. "Başlangıç Satırı" değiştirilip devam edilmek istendiğinde)
// contacts'a ve birikmiş sonuçlara DOKUNMADAN sadece kuyruk ayarlarını günceller.
export async function campaignResume(
  userId: string, campaignId?: string, overrides?: CampaignResumeOverrides,
): Promise<void> {
  const entry = resolveEntry(userId, campaignId);
  if (!entry || !entry.contacts.length) return;

  if (overrides) {
    if (overrides.startFromIndex !== undefined) entry.startFromIndex = overrides.startFromIndex;
    if (overrides.maxConcurrent  !== undefined) entry.maxConcurrent  = overrides.maxConcurrent;
    if (overrides.callLimit      !== undefined) entry.callLimit      = overrides.callLimit;
    if (overrides.answeredLimit  !== undefined) entry.answeredLimit  = overrides.answeredLimit;
    await updateCampaignSettings(userId, entry.id, overrides);
  }

  entry.running   = true;
  entry.paused    = false;
  entry.updatedAt = Date.now();
  await setCampaignStatus(userId, entry.id, 'running');
  broadcastFn(userId, 'campaign-update', toSnapshot(entry));
  fillQueue(entry);
}

export async function campaignPause(userId: string, campaignId?: string): Promise<{ paused: boolean }> {
  const entry = resolveEntry(userId, campaignId);
  if (!entry) return { paused: false };
  entry.paused    = !entry.paused;
  entry.updatedAt = Date.now();
  await setCampaignStatus(userId, entry.id, entry.paused ? 'paused' : 'running');
  broadcastFn(userId, 'campaign-update', toSnapshot(entry));
  if (!entry.paused) fillQueue(entry);
  return { paused: entry.paused };
}

export async function campaignStop(userId: string, campaignId?: string): Promise<void> {
  const entry = resolveEntry(userId, campaignId);
  if (!entry) return;
  entry.running   = false;
  entry.paused    = false;
  entry.updatedAt = Date.now();
  entry.contacts.forEach(c => {
    if (c.status === 'bekliyor') c.status = 'başarısız';
  });
  await persistContacts(entry);
  await setCampaignStatus(userId, entry.id, 'stopped');
  broadcastFn(userId, 'campaign-update', toSnapshot(entry));
}

// "Temizle" artık kampanyayı SİLMEZ — geçmişte durur, sadece motordan (canlı takipten) çıkarır.
export async function campaignClear(userId: string, campaignId?: string): Promise<void> {
  const entry = resolveEntry(userId, campaignId);
  if (!entry) return;
  engines.delete(entry.id);
  broadcastFn(userId, 'campaign-update', toSnapshot(null));
}

// ─── Webhook kancaları ────────────────────────────────────────────────────────

export async function onCampaignCallEnded(
  vapiCallId: string, status: string, duration?: number,
): Promise<void> {
  const found = findEntryByVapiCallId(vapiCallId);
  if (!found) return;
  const { entry, idx } = found;
  const c      = entry.contacts[idx];
  const mapped = callStatusToTurkish(status) as CampaignContact['status'];

  const currentPriority = STATUS_PRIORITY[c.status] ?? 0;
  const newPriority     = STATUS_PRIORITY[mapped]   ?? 0;

  if (newPriority > currentPriority || c.status === 'arıyor') {
    c.status = mapped;
  } else {
    console.log(`[Campaign] onCampaignCallEnded: "${c.name}" ${c.status}→${mapped} düşürme önlendi`);
  }

  if (duration && (!c.duration || duration > c.duration)) c.duration = duration;

  await persistContacts(entry);
  broadcastFn(entry.userId, 'campaign-contact-update', {
    campaignId: entry.id, index: idx, contact: { ...c }, summary: getCampaignSummary(entry),
  });

  if (isDone(entry)) { await onCampaignComplete(entry); return; }
  if (entry.running && !entry.paused) fillQueue(entry);
}

export async function onCampaignSummaryReady(
  vapiCallId: string, summary: CallSummary,
): Promise<void> {
  const found = findEntryByVapiCallId(vapiCallId);
  if (!found) return;
  const { entry, idx } = found;
  entry.contacts[idx].result = summary;
  await persistContacts(entry);
  broadcastFn(entry.userId, 'campaign-contact-update', {
    campaignId: entry.id, index: idx, contact: { ...entry.contacts[idx] }, summary: getCampaignSummary(entry),
  });
}

// ─── İç yardımcılar ───────────────────────────────────────────────────────────

function isDone(entry: CampaignEngineEntry): boolean {
  const startIdx = entry.startFromIndex ?? 0;
  const scope    = entry.contacts.slice(startIdx);
  if (scope.length === 0) return false;

  const active = scope.filter(c => c.status === 'arıyor').length;
  if (active > 0) return false;

  const allDone = scope.every(c => c.status !== 'bekliyor' && c.status !== 'arıyor');
  if (allDone) return true;

  if (entry.callLimit && entry.callLimit > 0) {
    const dialed = scope.filter(c => c.status !== 'bekliyor').length;
    if (dialed >= entry.callLimit) return true;
  }

  if (entry.answeredLimit && entry.answeredLimit > 0) {
    const answered = entry.contacts.filter(c => c.status === 'tamamlandı').length;
    if (answered >= entry.answeredLimit) return true;
  }

  return false;
}

function getCampaignSummary(entry: CampaignEngineEntry) {
  const total       = entry.contacts.length;
  const active      = entry.contacts.filter(c => c.status === 'arıyor').length;
  const waiting     = entry.contacts.filter(c => c.status === 'bekliyor').length;
  const appointment = entry.contacts.filter(c => c.status === 'tamamlandı' && c.result?.randevu_alindi === true).length;
  const talked      = entry.contacts.filter(c => c.status === 'tamamlandı' && !c.result?.randevu_alindi).length;
  const unreachable = entry.contacts.filter(c => c.status === 'cevapsız' || c.status === 'meşgul').length;
  const error       = entry.contacts.filter(c => c.status === 'başarısız').length;
  const done        = appointment + talked + unreachable + error;
  return { total, done, active, waiting, appointment, talked, unreachable, error, randevu: appointment, fail: unreachable + error };
}

async function onCampaignComplete(entry: CampaignEngineEntry): Promise<void> {
  entry.running = false;
  const randevu = entry.contacts.filter(c => c.result?.randevu_alindi).length;
  await persistContacts(entry);
  await setCampaignStatus(entry.userId, entry.id, 'completed', { markCompleted: true });
  broadcastFn(entry.userId, 'campaign-complete', { campaignId: entry.id, randevu, total: entry.contacts.length });
  console.log(`[Campaign] "${entry.name}" tamamlandı — ${randevu}/${entry.contacts.length} randevu`);
}

// Bir kullanıcının TÜM eşzamanlı kampanyalarındaki toplam aktif ('arıyor') arama sayısı —
// tek bir kampanyanın maxConcurrent'ı yeterli değil; aynı danışmanın 2 kampanyası birlikte
// gerçek Vapi/telefon hattı kapasitesini aşabilir (bkz. bu oturumdaki SIP kanal kapasitesi sorunu).
function countUserActiveCalls(userId: string): number {
  let total = 0;
  for (const e of engines.values()) {
    if (e.userId === userId) total += e.contacts.filter(c => c.status === 'arıyor').length;
  }
  return total;
}

// Türkiye tek dilim (Europe/Istanbul, DST yok 2016'dan beri) — danışman bazlı
// ayrı zaman dilimi desteğine şimdilik gerek yok.
function currentIstanbulHour(): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Istanbul', hour: 'numeric', hour12: false }).format(new Date()));
}

// Bugünün İstanbul saatiyle 00:00'ı, UTC ISO string olarak — "aynı kişiyi aynı gün
// tekrar arama" güvenlik kontrolünde start_time karşılaştırması için kullanılıyor.
function istanbulTodayStartIso(): string {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return new Date(`${ymd}T00:00:00+03:00`).toISOString();
}

function isWithinCallingHours(start: number | null, end: number | null): boolean {
  if (start == null || end == null) return true; // sınır tanımlanmamış
  const hour = currentIstanbulHour();
  if (start === end) return true; // 0 genişlikli aralık = sınır yok say
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end; // gece yarısını aşan aralık (örn. 22-06)
}

// ElevenLabs kredisi sık sık sorgulanmasın diye kısa TTL'li cache — her fillQueue
// tetiklendiğinde (5-30sn'de bir) API'yi bombalamamak için.
const elevenLabsCreditCache = new Map<string, { remaining: number | undefined; ok: boolean; cachedAt: number }>();
const CREDIT_CHECK_TTL_MS = 3 * 60 * 1000;

async function hasElevenLabsCreditLeft(userId: string): Promise<boolean> {
  const cached = elevenLabsCreditCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < CREDIT_CHECK_TTL_MS) {
    return !cached.ok || cached.remaining === undefined || cached.remaining > 0;
  }
  const key = await getUserElevenLabsKey(userId);
  if (!key) return true; // ElevenLabs bağlı değil — bu kontrolün konusu değil
  const credit = await getElevenLabsCredit(key);
  elevenLabsCreditCache.set(userId, { remaining: credit.remaining, ok: credit.ok, cachedAt: Date.now() });
  if (!credit.ok) return true; // sorgu başarısız oldu — emin olamadığımız için engellemeyelim
  return credit.remaining === undefined || credit.remaining > 0;
}

// Kredi tükenmesi (Vapi hata mesajından veya ElevenLabs kotasından anlaşılan) GERÇEK
// bir duraklatma — kullanıcı fark etmeden "Devam Et"e basana kadar kampanya durur.
// Arama saatleri dışı kalmasından (autoHeld) BİLEREK farklı: o otomatik açılır, bu açılmaz.
async function pauseForCreditExhaustion(entry: CampaignEngineEntry, reason: string): Promise<void> {
  if (entry.paused) return; // zaten duraklatılmış, tekrar tetikleme
  entry.paused    = true; // running kasıtlı olarak dokunulmuyor — "Devam Et" tekrar fillQueue'yu denesin
  entry.autoHeld  = undefined;
  entry.updatedAt = Date.now();
  await setCampaignStatus(entry.userId, entry.id, 'paused');
  broadcastFn(entry.userId, 'campaign-update', toSnapshot(entry));
  broadcastFn(entry.userId, 'campaign-credit-paused', { campaignId: entry.id, name: entry.name, reason });
  console.warn(`[Campaign] "${entry.name}" kredi tükenmesi nedeniyle duraklatıldı: ${reason}`);
}

const CREDIT_ERROR_PATTERN = /credit|balance|insufficient|payment required|billing|out of funds/i;

async function fillQueue(entry: CampaignEngineEntry): Promise<void> {
  if (!entry.running || entry.paused) return;

  const user = await getUserById(entry.userId);

  if (!isWithinCallingHours(user?.callingHoursStart ?? null, user?.callingHoursEnd ?? null)) {
    if (entry.autoHeld !== 'calling-hours') {
      entry.autoHeld = 'calling-hours';
      broadcastFn(entry.userId, 'campaign-update', toSnapshot(entry));
    }
    return; // devam eden aramalar kesilmez, sadece yeni arama başlatılmaz
  }
  if (entry.autoHeld === 'calling-hours') {
    entry.autoHeld = undefined;
    broadcastFn(entry.userId, 'campaign-update', toSnapshot(entry));
  }

  if (!(await hasElevenLabsCreditLeft(entry.userId))) {
    await pauseForCreditExhaustion(entry, 'ElevenLabs karakter kotası tükendi');
    return;
  }

  const startIdx = entry.startFromIndex ?? 0;
  const answered = entry.contacts.filter(c => c.status === 'tamamlandı').length;
  const active   = entry.contacts.filter(c => c.status === 'arıyor').length;

  if (entry.answeredLimit && entry.answeredLimit > 0 && answered >= entry.answeredLimit) {
    let changed = false;
    entry.contacts.forEach(c => { if (c.status === 'bekliyor') { c.status = 'başarısız'; changed = true; } });
    // Sıraya alma/tamamlama yazımı önceden "fire-and-forget" idi (void ile) — sunucu
    // tam bu anda yeniden başlarsa (örn. dev respawn) yazım tamamlanmadan kaybolabiliyordu,
    // DB'de bir adım geride kalmış görünüp "sayı azaldı" hissi yaratıyordu. Artık await'li.
    if (active === 0) { if (changed) await persistContacts(entry); await onCampaignComplete(entry); }
    return;
  }

  if (entry.callLimit && entry.callLimit > 0) {
    const dialed = entry.contacts.slice(startIdx).filter(c => c.status !== 'bekliyor').length;
    if (dialed >= entry.callLimit) {
      let changed = false;
      entry.contacts.forEach(c => { if (c.status === 'bekliyor') { c.status = 'başarısız'; changed = true; } });
      if (active === 0) { if (changed) await persistContacts(entry); await onCampaignComplete(entry); }
      return;
    }
  }

  let slots = entry.maxConcurrent - active;

  if (entry.answeredLimit && entry.answeredLimit > 0) {
    const remaining = entry.answeredLimit - answered - active;
    slots = Math.min(slots, remaining);
  }

  // Kullanıcının tüm kampanyaları genelinde toplam telefon hattı kapasitesi
  if (slots > 0) {
    const user = await getUserById(entry.userId);
    const ceiling = user?.maxConcurrentCalls ?? 3;
    const userActive = countUserActiveCalls(entry.userId);
    slots = Math.min(slots, Math.max(0, ceiling - userActive));
  }

  if (slots <= 0) return;

  let started = 0;
  let reconciledAny = false;
  const todayStart = istanbulTodayStartIso();
  for (let i = startIdx; i < entry.contacts.length && started < slots; i++) {
    const c = entry.contacts[i];
    if (c.status !== 'bekliyor') continue;

    // Güvenlik ağı: contact.status yanlış/eski kalmış olsa bile (örn. bir deploy
    // sırasında kaybolan webhook yazımı), bu kişiyi bugün GERÇEKTEN aramadığımızı
    // arama başlatmadan hemen önce, DIŞARIDAN (calls tablosundan) bağımsızca
    // doğrula. Aksi halde aynı kişi ikinci kez, gereksiz maliyetle aranabilir.
    const already: BestCallInfo | null = await findTodaysCallForPhone(entry.userId, c.phone, todayStart);
    if (already) {
      const mappedStatus = callStatusToTurkish(already.status) as CampaignContact['status'];
      if (already.summary) c.result = already.summary;
      if ((STATUS_PRIORITY[mappedStatus] ?? -1) > (STATUS_PRIORITY[c.status] ?? -1)) c.status = mappedStatus;
      reconciledAny = true;
      console.warn(`[Campaign] "${c.name}" (${c.phone}) bugün zaten arandı (${already.vapiCallId}) — tekrar aranmadı, durum senkronize edildi.`);
      continue;
    }

    callContact(entry, i);
    started++;
  }
  if (reconciledAny) {
    await persistContacts(entry);
    broadcastFn(entry.userId, 'campaign-update', toSnapshot(entry));
  }
}

async function callContact(entry: CampaignEngineEntry, idx: number): Promise<void> {
  const c      = entry.contacts[idx];
  c.status     = 'arıyor';
  c.callStartTs = Date.now();

  broadcastFn(entry.userId, 'campaign-contact-update', {
    campaignId: entry.id, index: idx, contact: { ...c }, summary: getCampaignSummary(entry),
  });

  try {
    const creds    = await resolveVapiCreds(entry.userId);
    const scenario = entry.scenarioId ? await getScenario(entry.userId, entry.scenarioId) : null;
    const customer: CustomerInfo = {
      name: c.name, phone: c.phone,
      region: c.region || '', notes: c.notes || '', reference: c.reference || '',
    };
    const vapiCall = await createVapiCall(creds, customer, scenario?.systemPrompt);
    c.vapiCallId   = vapiCall.id;

    // Aramayı DB'ye kaydet — Geçmiş Aramalar'da VE kampanya analizinde görünmesi için
    await createCall(entry.userId, vapiCall.id, customer, scenario?.id, scenario?.name, entry.id);

    await persistContacts(entry);
    broadcastFn(entry.userId, 'campaign-contact-update', {
      index: idx, contact: { ...c }, summary: getCampaignSummary(entry),
    });
    console.log(`[Campaign] Arama başlatıldı: ${c.name} → ${vapiCall.id} (kampanya: ${entry.name})`);
  } catch (err) {
    console.error(`[Campaign] Arama hatası (${c.name}, kampanya: ${entry.name}):`, err);

    // Vapi'nin kredi/bakiye hatası döndürdüğünü sezersek bu kişiyi "başarısız"
    // yakıp devam etmek yerine kampanyayı duraklat — aksi halde listedeki herkes
    // aynı sebeple art arda başarısız yakılır, kimse fark etmeden kredi bitmiş olur.
    if (CREDIT_ERROR_PATTERN.test(String(err))) {
      c.status = 'bekliyor'; // gerçekten denenmedi, kredi yüklenince tekrar denensin
      c.callStartTs = undefined;
      await persistContacts(entry);
      broadcastFn(entry.userId, 'campaign-contact-update', {
        index: idx, contact: { ...c }, summary: getCampaignSummary(entry),
      });
      await pauseForCreditExhaustion(entry, `Vapi kredisi/bakiyesi tükenmiş olabilir: ${String(err).slice(0, 200)}`);
      return;
    }

    c.status = 'başarısız';
    await persistContacts(entry);
    broadcastFn(entry.userId, 'campaign-contact-update', {
      index: idx, contact: { ...c }, summary: getCampaignSummary(entry),
    });
    if (entry.running && !entry.paused) fillQueue(entry);
  }
}

// Tüm aktif kampanyaları PARALEL işler — bkz. dosya başındaki not.
async function tickAll(): Promise<void> {
  const entries = [...engines.values()].filter(e => e.running && !e.paused);
  await Promise.allSettled(entries.map(tickOne));
}

// Periyodik kontrol: takılı kalan aramaları temizle, boş slotları doldur
async function tickOne(entry: CampaignEngineEntry): Promise<void> {
  const now     = Date.now();
  let   changed = false;

  for (const c of entry.contacts) {
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
    await persistContacts(entry);
    broadcastFn(entry.userId, 'campaign-update', toSnapshot(entry));
    if (isDone(entry)) { await onCampaignComplete(entry); return; }
  }

  await fillQueue(entry);
}
