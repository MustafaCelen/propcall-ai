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

import { createVapiCall, endVapiCall } from './vapi';
import { isPhoneBlocked, normalizePhone } from './dncList';
import { getElevenLabsCredit } from './elevenlabs';
import { translateDialError, translateEndedReason } from './campaignErrors';
import {
  readCall, createCall, callStatusToTurkish,
  getBestCallsByPhoneForCampaign, findRecentCallForPhone, BestCallInfo,
} from './calls';
import { getScenario } from './scenarios';
import { pickOpeningVariant, buildCallPrompt, nameVariableValues, resolveWaitForGreeting } from './opening';
import { resolveVapiCreds, getUserById, getUserElevenLabsKey, CALL_MINUTE_RATE_TRY } from './users';
import { CustomerInfo, CallSummary } from './types';
import {
  CampaignContact, CampaignRecord, CampaignStatus, SkipKind,
  createCampaign, getAllActiveCampaigns, isSkipResumable, isLimitSkip,
  saveCampaignContacts, setCampaignStatus, updateCampaignSettings, deleteCampaignRecord,
} from './campaigns';

export type { CampaignContact } from './campaigns';

// ─── Tipler ──────────────────────────────────────────────────────────────────

interface CampaignEngineEntry {
  id: string;
  userId: string;
  name: string;
  contacts: CampaignContact[];
  // DB'deki status ile birebir — draft (yüklendi, başlatılmadı) / running / paused /
  // stopped / completed. Frontend "Başlat" mı "Devam Et" mi göstereceğine buna bakar.
  status: CampaignStatus;
  running: boolean;
  paused: boolean;
  maxConcurrent: number;
  scenarioId?: string;
  startFromIndex: number;
  callLimit: number;
  answeredLimit: number;
  retryMaxAttempts: number;
  retryDelayMinutes: number;
  updatedAt: number; // motor aktivitesinin son zamanı (bilgi amaçlı; odak seçiminde KULLANILMAZ)
  // "Danışmanın baktığı kampanya" fallback'i BUNA dayanır: kampanyanın DB'deki
  // oluşturulma zamanı — asla değişmez.
  //
  // GERÇEK HATA: bu seçim eskiden updatedAt'e dayanıyordu ve updatedAt'i motorun
  // KENDI arka plan olayları da güncelliyordu (duraklatma, kredi tükenmesi, her
  // arama tick'i). Danışman yeni liste yükleyip çalıştırırken, haftalar önceki
  // duraklatılmış bir kampanyada kredi hatası tetiklenince o kampanya "en son
  // güncellenen" olup ekranı ele geçiriyordu — "son yüklediğim kampanya gitti,
  // eskisi geldi" şikayetinin kaynağı buydu. Üstüne, recordToEntry her restart'ta
  // updatedAt'i Date.now() yazıyordu: deploy sonrası tüm kampanyalar aynı damgayı
  // alıp sıralama tamamen rastgeleleşiyordu.
  createdAt: number;
  // Arama saatleri dışındayken motorun kendisinin YENİ arama başlatmayı geçici
  // olarak ertelemesi — entry.paused'tan FARKLI: kullanıcı hiçbir şey yapmadan,
  // saat penceresi tekrar açılınca bir sonraki tick'te otomatik kalkar. Devam
  // eden aramalar kesilmez, sadece kuyruk doldurma bekletilir.
  autoHeld?: 'calling-hours' | 'concurrency-limit';
  // Sayısal limite takılıp durduysa hangisine (bkz. CampaignSnapshot.limitReached).
  // autoHeld'den FARKLI: o kendiliğinden kalkar, bu kalkmaz — danışmanın limiti
  // yükseltmesi ya da kampanyayı bitirmesi gerekir.
  limitReached?: 'call' | 'answered';
}

// Dışa açık görünüm — bugünkü frontend'in beklediği şekle birebir uyar.
export interface CampaignSnapshot {
  id: string | null;
  userId: string | null;
  name: string;
  status: CampaignStatus | null;
  contacts: CampaignContact[];
  running: boolean;
  paused: boolean;
  maxConcurrent: number;
  scenarioId?: string;
  startFromIndex?: number;
  callLimit?: number;
  answeredLimit?: number;
  retryMaxAttempts?: number;
  retryDelayMinutes?: number;
  autoHeld?: 'calling-hours' | 'concurrency-limit';
  // Kampanya sayısal bir limite takılıp durduysa hangisine — frontend bunu görünce
  // "limitiniz doldu, N kişi bekliyor, limiti artırıp devam edin" banner'ını açar.
  // Önceden bu durum hiçbir yerde bildirilmiyordu: danışman sadece satırlarda 🔒
  // ikonu görüyor, ne olduğunu ve ne yapacağını anlamıyordu.
  limitReached?: 'call' | 'answered';
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
  'tamamlandı': 4, 'cevapsız': 3, 'meşgul': 2, 'başarısız': 1, 'tekrar-planlandı': 1, 'arıyor': 0, 'bekliyor': -1,
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

// smartPlans.ts gibi bu motorun DIŞINDAKİ modüllerin kendi SSE olaylarını (örn.
// "smart-plan-fired") aynı broadcast kanalından yayınlayabilmesi için — broadcastFn'i
// doğrudan dışa açmak yerine (o zaten modül-içi state), tek amaçlı bir erişim noktası.
export function broadcastToUser(userId: string, event: string, data: unknown): void {
  broadcastFn(userId, event, data);
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

    // 'tekrar-planlandı' henüz hiç dial edilmemiş bir bekleme durumu — bestCalls'ta
    // bulunan kayıt, bu retry'ı TETİKLEYEN eski (zaten cevapsız/meşgul sonuçlanmış)
    // aramanın ta kendisi. O bilgiyle uzlaştırma yaparsak her restart'ta retry
    // planı iptal edilip durum geriye ('cevapsız'/'meşgul') düşürülür — atla.
    // Aynı koruma 'bekliyor' için de geçerli: "Yeniden çalıştır" / "Tekrar Dene" ile
    // kuyruğa geri alınan kişinin vapiCallId'si bilerek korunur — bestCalls'taki kayıt
    // o eski aramadır; uzlaştırma onu görüp kişiyi eski sonuca geri çevirmemeli.
    if ((next.status === 'tekrar-planlandı' || next.status === 'bekliyor') && best.vapiCallId === next.vapiCallId) return next;

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
    status: rec.status,
    contacts,
    // DB'deki son bilinen niyeti yansıt — bir deploy/restart, danışmanın aktif bir
    // kampanyasını sessizce duraklatmamalı. "arıyor" durumundaki kişiler yukarıda zaten
    // calls tablosuyla (gerçek kaynak) uzlaştırıldı, bu yüzden kaldığı yerden güvenle
    // devam edilebilir — kullanıcının tekrar "Başlat"a basmasını beklemeye gerek yok.
    running: rec.status === 'running',
    paused: rec.status === 'paused',
    maxConcurrent: rec.maxConcurrent || 1,
    scenarioId: rec.scenarioId,
    startFromIndex: rec.startFromIndex || 0,
    callLimit: rec.callLimit || 0,
    answeredLimit: rec.answeredLimit || 0,
    retryMaxAttempts: rec.retryMaxAttempts || 2,
    retryDelayMinutes: rec.retryDelayMinutes || 120,
    updatedAt: Date.now(),
    // DB'deki gerçek oluşturulma zamanı — restart'ta Date.now() yazmak tüm
    // kampanyalara aynı damgayı verip odak sıralamasını rastgeleleştiriyordu.
    createdAt: new Date(rec.createdAt).getTime(),
    // limitReached hafızada tutulur, DB'de yok — bir deploy/restart sonrası
    // kişilerin skipKind'ından TÜRETİLİR, aksi halde "limitiniz doldu" banner'ı
    // restart'la birlikte sessizce kaybolur ve danışman kalan kişileri kurtarma
    // yolunu bir daha göremezdi.
    limitReached: contacts.some(c => c.skipKind === 'call-limit') ? 'call'
      : contacts.some(c => c.skipKind === 'answered-limit') ? 'answered'
      : undefined,
  };
}

function toSnapshot(e: CampaignEngineEntry | null): CampaignSnapshot {
  if (!e) {
    return {
      id: null, userId: null, name: '', status: null, contacts: [],
      running: false, paused: false, maxConcurrent: 1,
    };
  }
  return {
    id: e.id, userId: e.userId, name: e.name, status: e.status,
    contacts: e.contacts.map(c => ({ ...c })),
    running: e.running, paused: e.paused, maxConcurrent: e.maxConcurrent,
    scenarioId: e.scenarioId, startFromIndex: e.startFromIndex,
    callLimit: e.callLimit, answeredLimit: e.answeredLimit,
    retryMaxAttempts: e.retryMaxAttempts, retryDelayMinutes: e.retryDelayMinutes,
    autoHeld: e.autoHeld,
    limitReached: e.limitReached,
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
  // Yazım hatası BİLEREK yutulur: bu fonksiyon arama akışının ortasında çağrılıyor,
  // throw etmek devam eden bir kampanyayı yarıda keserdi. Ama tek denemede pes etmek
  // de doğru değil — anlık bir bağlantı hıçkırığında kişinin durumu (örn. "tamamlandı")
  // DB'ye hiç yazılmaz ve sunucu restart'ında o kişi TEKRAR aranır. Bir kez daha dene.
  try {
    await saveCampaignContacts(entry.userId, entry.id, entry.contacts);
  } catch (err) {
    console.error('[Campaign] DB kaydetme hatası (1. deneme):', err);
    try {
      await new Promise(r => setTimeout(r, 1000));
      await saveCampaignContacts(entry.userId, entry.id, entry.contacts);
      console.log(`[Campaign] "${entry.name}" durum yazımı ikinci denemede başarılı.`);
    } catch (retryErr) {
      console.error('[Campaign] DB kaydetme hatası (2. deneme, vazgeçildi):', retryErr);
    }
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
  // En son OLUŞTURULAN kampanya = danışmanın en son yüklediği liste. createdAt
  // hiç değişmediği için arka plan olayları bu seçimi artık bozamaz.
  let best: CampaignEngineEntry | null = null;
  for (const e of engines.values()) {
    if (e.userId !== userId) continue;
    if (!best || e.createdAt > best.createdAt) best = e;
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
  retryMaxAttempts?: number,
  retryDelayMinutes?: number,
  smartPlanId?: string,
): Promise<string> {
  // Numaraları burada normalize et ve çevrilemeyecek olanları ele. Rota katmanı
  // (server.ts) bunu zaten yapıyor ama Akıllı Plan (smartPlans.ts) campaignLoad'ı
  // DOĞRUDAN çağırıyor — doğrulama sadece rotada kalırsa segmentten gelen bozuk
  // numaralar kampanyaya girer ve her biri ayrı bir dial hatasıyla "⚠️ Hata" yanar.
  const normalizedContacts = contacts
    .map(c => ({ ...c, phone: normalizePhone(c.phone) || c.phone }))
    .filter(c => {
      const digits = String(c.phone).replace(/\D/g, '');
      return String(c.phone).startsWith('+') && digits.length >= 10 && digits.length <= 15;
    });
  if (!normalizedContacts.length) {
    throw new Error('Listedeki hiçbir kişide çevrilebilir bir telefon numarası yok — numaraları kontrol edin.');
  }

  const scenario = scenarioId ? await getScenario(userId, scenarioId) : null;
  const record = await createCampaign(userId, {
    name: name?.trim() || `Kampanya ${new Date().toLocaleDateString('tr-TR')}`,
    scenarioId,
    scenarioName: scenario?.name,
    maxConcurrent,
    startFromIndex: startFromIndex || 0,
    callLimit: callLimit || 0,
    answeredLimit: answeredLimit || 0,
    retryMaxAttempts,
    retryDelayMinutes,
    smartPlanId,
    contacts: normalizedContacts,
  });
  // Yeni oluşan kampanyanın henüz "calls" tablosunda hiç kaydı yok — recordToEntry'nin
  // DB senkronizasyonu burada no-op olur, sadece contacts'ı doğrudan atıyoruz.
  const entry = await recordToEntry(record);
  entry.contacts = record.contacts;
  engines.set(record.id, entry);
  broadcastFn(userId, 'campaign-update', toSnapshot(entry));
  return record.id;
}

// Anthropic kredisi tukendigi gibi bir donemde ozetsiz kalan aramalar icin, ozetler
// backfill script'iyle DOGRUDAN DB'ye yazildiginda bu canli motordaki (bellek)
// entry.contacts ONU GORMEZ -- recordToEntry sadece sunucu ACILISINDA calisir. Bu
// fonksiyon aynı uzlastirma mantigini (bkz. recordToEntry) TALEP UZERINE, sunucuyu
// yeniden baslatmadan, tek bir kampanya icin tetikler.
export async function resyncCampaignSummaries(userId: string, campaignId?: string): Promise<number> {
  const entry = resolveEntry(userId, campaignId);
  if (!entry) return 0;
  const bestCalls = await getBestCallsByPhoneForCampaign(userId, entry.id);
  let updated = 0;
  for (const c of entry.contacts) {
    const best = bestCalls.get(c.phone);
    if (best?.summary && !c.result) { c.result = best.summary; updated++; }
  }
  if (updated) {
    await persistContacts(entry);
    broadcastFn(userId, 'campaign-update', toSnapshot(entry));
  }
  return updated;
}

// "Başlat"ta draft'a verilen son ayarlar. Liste yükleme anında ad/senaryo/limitler
// henüz girilmemiş olur (akış: önce Excel, sonra form, sonra Başlat) — bu yüzden
// hepsi burada, başlatma anında uygulanır.
export interface CampaignStartSettings extends CampaignResumeOverrides {
  name?: string;
  scenarioId?: string;
}

export async function campaignStart(
  userId: string, campaignId: string, settings?: CampaignStartSettings,
): Promise<void> {
  const entry = resolveEntry(userId, campaignId);
  if (!entry || !entry.contacts.length)
    throw new Error('Aranacak kimse yok — tüm kişiler ya tamamlandı ya da listede kimse kalmadı.');

  // Ön-kontrol: Vapi kimlik bilgileri eksikse kampanya hiç başlamasın — aksi halde
  // listedeki HERKES tek tek "⚠️ Hata" ile başarısız olurdu, hiç açıklama olmadan
  // (bkz. resolveVapiCreds'in fırlattığı mesaj, users.ts — o zaten danışman-dostu,
  // olduğu gibi yukarı fırlatılır).
  await resolveVapiCreds(userId);

  if (settings) {
    const scenario = settings.scenarioId ? await getScenario(userId, settings.scenarioId) : null;
    if (settings.name)                        entry.name          = settings.name;
    if (settings.scenarioId !== undefined)    entry.scenarioId    = settings.scenarioId || undefined;
    if (settings.startFromIndex !== undefined) entry.startFromIndex = settings.startFromIndex;
    if (settings.maxConcurrent  !== undefined) entry.maxConcurrent  = settings.maxConcurrent;
    if (settings.callLimit      !== undefined) entry.callLimit      = settings.callLimit;
    if (settings.answeredLimit  !== undefined) entry.answeredLimit  = settings.answeredLimit;
    if (settings.retryMaxAttempts  !== undefined) entry.retryMaxAttempts  = settings.retryMaxAttempts;
    if (settings.retryDelayMinutes !== undefined) entry.retryDelayMinutes = settings.retryDelayMinutes;
    await updateCampaignSettings(userId, entry.id, {
      ...settings,
      scenarioId:   settings.scenarioId === undefined ? undefined : (settings.scenarioId || null),
      scenarioName: settings.scenarioId === undefined ? undefined : (scenario?.name ?? null),
    });
  }

  entry.running   = true;
  entry.paused    = false;
  entry.status    = 'running';
  entry.limitReached = undefined; // taze başlangıç — eski limit uyarısı taşınmasın
  entry.updatedAt = Date.now();
  await setCampaignStatus(userId, entry.id, 'running', { markStarted: true });
  broadcastFn(userId, 'campaign-update', toSnapshot(entry));
  fillQueue(entry);
}

// Yeni bir Excel yüklenirken ekranda zaten bir draft varsa onu çöpe at — aksi
// halde her yükleme Kampanya Geçmişi'nde bir "taslak" çöpü bırakırdı. Sadece
// draft silinir; başlamış bir kampanya için bu bir no-op (sessizce korunur).
export async function campaignDiscardDraft(userId: string, campaignId: string): Promise<boolean> {
  const entry = engines.get(campaignId);
  if (!entry || entry.userId !== userId || entry.status !== 'draft') return false;
  engines.delete(campaignId);
  const { deleted } = await deleteCampaignRecord(userId, campaignId);
  return deleted;
}

export interface CampaignResumeOverrides {
  startFromIndex?: number;
  maxConcurrent?: number;
  callLimit?: number;
  answeredLimit?: number;
  retryMaxAttempts?: number;
  retryDelayMinutes?: number;
}

// "Atlandı" işaretli kişileri kuyruğa geri alır — hangi atlama türünün geri
// alınacağına çağıran karar verir (match). Gerçek arama hatalarına (skipKind yok)
// ASLA dokunmaz: onların kurtarılması danışmanın ayrı ve bilinçli kararıdır
// (campaignRetryFailed). Geri alınan kişi sayısını döner.
function requeueSkipped(entry: CampaignEngineEntry, match: (kind: SkipKind) => boolean): number {
  let count = 0;
  entry.contacts.forEach(c => {
    if (c.status !== 'başarısız' || !c.skipKind) return;
    if (!match(c.skipKind)) return;
    c.status        = 'bekliyor';
    c.failureReason = undefined;
    c.skipReason    = undefined;
    c.skipKind      = undefined;
    c.skipResumable = undefined;
    count++;
  });
  return count;
}

// overrides verilirse (örn. "Başlangıç Satırı" değiştirilip devam edilmek istendiğinde)
// contacts'a ve birikmiş sonuçlara DOKUNMADAN sadece kuyruk ayarlarını günceller.
export async function campaignResume(
  userId: string, campaignId?: string, overrides?: CampaignResumeOverrides,
): Promise<void> {
  const entry = resolveEntry(userId, campaignId);
  if (!entry || !entry.contacts.length)
    throw new Error('Aranacak kimse yok — tüm kişiler ya tamamlandı ya da listede kimse kalmadı.');

  await resolveVapiCreds(userId);

  // Bu çağrıda kuyruğa geri alınan toplam kişi — sonunda DB'ye yazılıp yazılmayacağına
  // karar vermek için (bkz. aşağıdaki persistContacts).
  let recoveredTotal = 0;

  if (overrides) {
    const oldCallLimit     = entry.callLimit;
    const oldAnsweredLimit = entry.answeredLimit;
    if (overrides.startFromIndex !== undefined) entry.startFromIndex = overrides.startFromIndex;
    if (overrides.maxConcurrent  !== undefined) entry.maxConcurrent  = overrides.maxConcurrent;
    if (overrides.callLimit      !== undefined) entry.callLimit      = overrides.callLimit;
    if (overrides.answeredLimit  !== undefined) entry.answeredLimit  = overrides.answeredLimit;
    if (overrides.retryMaxAttempts  !== undefined) entry.retryMaxAttempts  = overrides.retryMaxAttempts;
    if (overrides.retryDelayMinutes !== undefined) entry.retryDelayMinutes = overrides.retryDelayMinutes;
    await updateCampaignSettings(userId, entry.id, overrides);

    // Limit YÜKSELTİLDİYSE (veya kaldırıldıysa, 0=sınırsız) daha önce TAM O LİMİTE
    // takılıp "başarısız" yakılmış kişileri otomatik kuyruğa geri al. Aksi halde
    // danışman limiti 4000'den 8000'e çıkarıp "Devam Et"e bassa bile önceki 4000
    // kişi hâlâ 'başarısız' kalır — fillQueue onları görmez ve ayrıca "Tekrar
    // Dene"ye basılması gerekirdi (gerçek production şikayeti buydu).
    // Gerçek arama hatalarına (skipKind yok) DOKUNULMAZ — onlar campaignRetryFailed
    // ile ayrı ve bilinçli olarak kurtarılır.
    const callLimitRaised     = overrides.callLimit     !== undefined && (overrides.callLimit === 0 || overrides.callLimit > oldCallLimit);
    const answeredLimitRaised = overrides.answeredLimit !== undefined && (overrides.answeredLimit === 0 || overrides.answeredLimit > oldAnsweredLimit);
    if (callLimitRaised || answeredLimitRaised) {
      // Sadece YÜKSELTİLEN limitin kurbanlarını geri al: arama limiti artırıldıysa
      // görüşme hedefine takılanlar hâlâ geçerli şekilde beklemeli (ve tersi).
      const recovered = requeueSkipped(entry, k =>
        (k === 'call-limit'     && callLimitRaised) ||
        (k === 'answered-limit' && answeredLimitRaised));
      recoveredTotal += recovered;
      if (recovered) console.log(`[Campaign] "${entry.name}" limit artırıldı — ${recovered} kişi kuyruğa geri alındı.`);
      // Banner'ı kapat — limit artık dolu değil. Kalırsa danışman limiti
      // yükselttiği halde "limitiniz doldu" uyarısını görmeye devam ederdi.
      if ((callLimitRaised && entry.limitReached === 'call') ||
          (answeredLimitRaised && entry.limitReached === 'answered')) {
        entry.limitReached = undefined;
      }
    }
  }

  // Kampanya DURDURULDUĞU için atlananlar, "Devam Et" denildiği anda geri gelir —
  // danışmanın ayrıca "Tekrar Dene"ye basmasını beklemek anlamsız: devam etmek
  // istediğini zaten bu butona basarak söyledi. overrides bloğunun DIŞINDA:
  // hiçbir ayar değiştirmeden sadece "Devam Et" denildiğinde de çalışmalı.
  const resumedAfterStop = requeueSkipped(entry, k => k === 'stopped');
  recoveredTotal += resumedAfterStop;
  if (resumedAfterStop) console.log(`[Campaign] "${entry.name}" devam ettirildi — durdurma sırasında atlanan ${resumedAfterStop} kişi kuyruğa geri alındı.`);

  // Kurtarmalardan SONRA kontrol et: liste dolu ama içindeki HERKES zaten
  // "başarısız"/"tamamlandı"/"arıyor" olabilir — bu durumda fillQueue sessizce 0 kişi
  // çevirip hiçbir şey olmuyormuş gibi görünürdü ("Devam Et'e bastım ama kampanya
  // ilerlemiyor" şikayetinin kaynağı). Sıra önemli: yukarıdaki kurtarmalar
  // çalışmadan kontrol edilirse, durdurulmuş bir kampanya kendi kurtarma koduna
  // hiç ulaşamadan "aranacak kimse yok" hatası verirdi.
  const hasDialable = entry.contacts.some(c =>
    c.status === 'bekliyor' ||
    (c.status === 'tekrar-planlandı' && !!c.nextRetryAt && new Date(c.nextRetryAt) <= new Date()));
  if (!hasDialable) {
    // Mesaj, kalan kişilerin NEDEN aranamadığına göre net bir aksiyon önerir.
    // Kurtarılamaz olanlar (ret listesi, tekrar-arama koruması) için aksiyon
    // önerilmez — danışmanı hiçbir şey yapmayan bir butona yönlendirmemek için.
    const failedCount   = entry.contacts.filter(c => c.status === 'başarısız' && !c.skipReason && !c.skipKind).length;
    const limitCount    = entry.contacts.filter(c => c.status === 'başarısız' && isLimitSkip(c.skipKind)).length;
    const dncCount      = entry.contacts.filter(c => c.status === 'başarısız' && c.skipKind === 'dnc').length;
    const dupCount      = entry.contacts.filter(c => c.status === 'başarısız' && c.skipKind === 'duplicate').length;
    if (limitCount) {
      throw new Error(`Aranacak kimse yok — ${limitCount} kişi kampanya limitine takıldı. Limiti artırıp devam edebilirsiniz.`);
    }
    if (failedCount) {
      throw new Error(`Aranacak kimse yok — listedeki ${failedCount} kişi "başarısız" durumunda. Devam etmek için önce onları tekrar deneme listesine alın.`);
    }
    if (dncCount || dupCount) {
      const parts = [
        dncCount ? `${dncCount} kişi ret listesinde` : '',
        dupCount ? `${dupCount} kişi tekrar arama koruması nedeniyle atlandı` : '',
      ].filter(Boolean).join(', ');
      throw new Error(`Aranacak kimse yok — ${parts}. Bu kişiler tekrar aranamaz.`);
    }
    throw new Error('Aranacak kimse yok — tüm kişiler ya tamamlandı ya da şu an aranıyor.');
  }

  entry.running   = true;
  entry.paused    = false;
  entry.updatedAt = Date.now();
  // Kurtarılan kişileri DB'ye yaz — yoksa yalnızca hafızada 'bekliyor' olurlar ve
  // bir deploy/restart hepsini tekrar 'başarısız' olarak geri yüklerdi.
  if (recoveredTotal) await persistContacts(entry);
  entry.status = 'running';
  await setCampaignStatus(userId, entry.id, 'running');
  broadcastFn(userId, 'campaign-update', toSnapshot(entry));
  fillQueue(entry);
}

// "başarısız" durumundaki kişileri "bekliyor"a geri alır — campaignResume'un
// "hasDialable" kontrolü tüm liste başarısızsa devam etmeyi reddediyor (bkz. yukarı),
// danışmana bu durumu kendi kontrolünde düzeltme yolu sunar. Devam eden/tamamlanmış
// kişilere DOKUNMAZ, sadece 'başarısız' işaretlileri etkiler.
// "Yeniden çalıştır" — biten/durdurulan kampanyada seçilen kesimi AYNI kampanya
// içinde kuyruğa geri alır ve kampanyayı sürdürür (sektör standardı: JustCall
// "Re-run this campaign"). Önceki sonuçlar (result, attemptCount, duration,
// vapiCallId) korunur; danışman eskiden bunun için listeyi yeni bir kampanyaya
// kopyalıyor, geçmiş kopuyordu.
export type RerunScope = 'unreachable' | 'unanswered' | 'busy' | 'failed' | 'all';
export const RERUN_SCOPES: RerunScope[] = ['unreachable', 'unanswered', 'busy', 'failed', 'all'];

export function rerunMatches(c: CampaignContact, scope: RerunScope): boolean {
  if (c.status === 'arıyor' || c.status === 'bekliyor') return false;
  // Kurtarılamaz atlamalar: geri alınsalar aynı kontrole takılırlar.
  if (c.skipKind === 'dnc' || c.skipKind === 'duplicate') return false;
  const planlananSonuc = c.status === 'tekrar-planlandı' ? c.lastOutcome : undefined;
  switch (scope) {
    case 'unanswered':  return c.status === 'cevapsız' || planlananSonuc === 'cevapsız';
    case 'busy':        return c.status === 'meşgul'   || planlananSonuc === 'meşgul';
    case 'unreachable': return c.status === 'cevapsız' || c.status === 'meşgul' || c.status === 'tekrar-planlandı';
    case 'failed':      return c.status === 'başarısız';
    // Randevu alınmış kişi "hepsi" ile bile tekrar aranmaz — kazanılmış bir lead'i
    // rahatsız etmenin bedeli, boşa bir aramadan çok daha yüksek.
    case 'all':         return c.result?.randevu_alindi !== true;
  }
}

export async function campaignRerun(
  userId: string, campaignId: string, scope: RerunScope,
): Promise<{ requeued: number }> {
  const entry = resolveEntry(userId, campaignId);
  if (!entry) throw new Error('Kampanya bulunamadı');
  if (entry.running && !entry.paused) {
    throw new Error('Kampanya şu an çalışıyor — yeniden çalıştırmak için önce bitmesini bekleyin ya da duraklatın.');
  }
  let requeued = 0;
  for (const c of entry.contacts) {
    if (!rerunMatches(c, scope)) continue;
    c.status        = 'bekliyor';
    c.failureReason = undefined;
    c.skipReason    = undefined;
    c.skipKind      = undefined;
    c.skipResumable = undefined;
    c.nextRetryAt   = null;
    c.lastOutcome   = undefined;
    requeued++;
  }
  if (!requeued) return { requeued: 0 };
  entry.limitReached = undefined;
  await persistContacts(entry);
  console.log(`[Campaign] "${entry.name}" yeniden çalıştırıldı (${scope}) — ${requeued} kişi kuyruğa alındı.`);
  await campaignResume(userId, entry.id);
  return { requeued };
}

export async function campaignRetryFailed(userId: string, campaignId?: string): Promise<{ retried: number }> {
  const entry = resolveEntry(userId, campaignId);
  if (!entry) return { retried: 0 };
  let retried = 0;
  entry.contacts.forEach(c => {
    // Kuyruğa geri alınabilecekler: gerçek arama hataları (atlama değil) ve geri
    // alınabilir atlamalar — durdurma, sayısal limitler. Ret listesi (DNC) ve
    // tekrar-arama koruması HARİÇ: geri alınsalar aynı kontrole takılıp yeniden
    // elenirlerdi, danışmana hiçbir şey yapmayan bir buton göstermiş olurduk.
    const isRealFailure   = !c.skipReason && !c.skipKind;
    const isResumableSkip = (!!c.skipReason || !!c.skipKind) && isSkipResumable(c);
    if (c.status === 'başarısız' && (isRealFailure || isResumableSkip)) {
      c.status = 'bekliyor';
      c.failureReason = undefined;
      c.skipReason    = undefined;
      c.skipKind      = undefined;
      c.skipResumable = undefined;
      retried++;
    }
  });
  if (retried) {
    await persistContacts(entry);
    broadcastFn(userId, 'campaign-update', toSnapshot(entry));
  }
  return { retried };
}

// Danışman limit banner'ındaki "Kampanyayı bitir"e bastığında — kampanya zaten
// durmuş durumda, sadece uyarıyı kapatıyoruz. Bayrak SUNUCUDA temizlenmezse
// sayfa yenilenince (ya da bir SSE olayı gelince) banner geri gelir ve danışman
// "bitir dedim ama uyarı gitmiyor" der.
export function campaignDismissLimitNotice(userId: string, campaignId?: string): void {
  const entry = resolveEntry(userId, campaignId);
  if (!entry) return;
  entry.limitReached = undefined;
  broadcastFn(userId, 'campaign-update', toSnapshot(entry));
}

export async function campaignPause(userId: string, campaignId?: string): Promise<{ paused: boolean }> {
  const entry = resolveEntry(userId, campaignId);
  if (!entry) return { paused: false };
  entry.paused    = !entry.paused;
  entry.updatedAt = Date.now();
  entry.status = entry.paused ? 'paused' : 'running';
  await setCampaignStatus(userId, entry.id, entry.status);
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
    if (c.status === 'bekliyor' || c.status === 'tekrar-planlandı') {
      c.status = 'başarısız';
      // Bu bir arama arızası DEĞİL — danışman kampanyayı kendi kararıyla durdurdu.
      // failureReason'a yazılırsa panel "⚠️ Hata" sayacını bu kişilerle şişirir ve
      // gerçek teknik hatalar aralarında kaybolur (bkz. getCampaignSummary).
      c.skipReason = 'Kampanya durdurulduğu için bu kişi aranmadı.';
      c.skipKind = 'stopped';
      c.skipResumable = true; // danışman tekrar başlatmak isterse geri alınabilir
    }
  });
  await persistContacts(entry);
  entry.status = 'stopped';
  await setCampaignStatus(userId, entry.id, 'stopped');
  broadcastFn(userId, 'campaign-update', toSnapshot(entry));
}

// "Temizle" artık kampanyayı SİLMEZ — geçmişte durur, sadece motordan (canlı takipten) çıkarır.
export async function campaignClear(userId: string, campaignId?: string): Promise<void> {
  const entry = resolveEntry(userId, campaignId);
  if (!entry) return;
  // Motordan çıkarmadan ÖNCE düzgünce durdur. Aksi halde: (1) devam eden aramaların
  // webhook'ları geldiğinde findEntryByVapiCallId kaydı bulamaz, sonuç hiçbir yere
  // yazılmaz; (2) kampanya DB'de 'running' kalır ve sunucu yeniden başladığında
  // loadAllActiveCampaigns onu geri yükleyip ARAMAYA DEVAM EDER — kullanıcı
  // "temizledim" sanırken kampanya arkada çalışmaya devam eder.
  if (entry.running || entry.paused) {
    await campaignStop(userId, entry.id);
  }
  engines.delete(entry.id);
  broadcastFn(userId, 'campaign-update', toSnapshot(null));
}

// ─── Webhook kancaları ────────────────────────────────────────────────────────

// "Hata" (başarısız) durumunun ALTINDA yatan gerçek sebep bazen geçici (telefon hattı/
// operatör/Vapi altyapı katmanında bir bağlantı sorunu) bazen kalıcıdır (örn. ElevenLabs
// ses üretimi çöktü — muhtemelen aynı sebeple tekrar çöker). Sadece geçici olduğu bilinen
// SIP bağlantı/timeout hatalarını retry'a dahil ediyoruz — körlemesine HER "başarısız"ı
// tekrar denemek, kalıcı olarak bozuk numaraları sonsuza dek yeniden arayıp durur.
const TRANSIENT_FAILURE_PATTERN = /sip.*(failed-to-connect|timeout)|providerfault|outbound-sip-\d{3}/i;

export async function onCampaignCallEnded(
  vapiCallId: string, status: string, duration?: number, endedReason?: string,
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

  // ElevenLabs ses üretimi görüşmenin ORTASINDA çöktüyse: hat bağlandı, ücret işledi,
  // ama danışman hiçbir şey konuşamadı. Tek seferlik bir arıza olabilir — ama kota
  // bittiyse ARDI ARDINA tekrarlar (gerçek olay: tek günde 295 arama böyle yandı).
  // Krediyi hemen yeniden sorgulat: kota gerçekten bittiyse bir sonraki fillQueue
  // kampanyayı duraklatır, geçici bir arızaysa hiçbir şey değişmez.
  if (endedReason && /eleven-?labs/i.test(endedReason) && /fail/i.test(endedReason)) {
    invalidateElevenLabsCredit(entry.userId);
    console.warn(`[Campaign] "${c.name}" ElevenLabs ses hatası (${endedReason}) — kredi yeniden sorgulanacak.`);
  }

  // Bu kişi gerçekten arandı ve sonuçlandı — daha önce "atlandı" işaretlenmiş olsa
  // bile (örn. tekrar arama koruması sonradan kalktı, kullanıcı elle tekrar denedi)
  // o not artık geçersiz. Temizlenmezse UI "🔒 Atlandı" etiketini gerçek sonucun
  // üstüne yapıştırır ve kişi hata/atlandı sayaçlarında birden fazla yerde görünür.
  c.skipReason    = undefined;
  c.skipResumable = undefined;

  // Terminal "başarısız" durumu — danışmanın "⚠️ Hata" etiketinin üzerine gelince
  // göreceği gerçek sebep. endedReason'ın ham koda değil, çevrilmiş Türkçe metne.
  if (c.status === 'başarısız') c.failureReason = translateEndedReason(endedReason);

  // Otomatik yeniden arama: cevapsız/meşgul (her zaman) VEYA "başarısız" ama sebebi
  // geçici bir SIP/altyapı hatasıysa (yukarı bkz.) VE hâlâ deneme hakkı varsa, terminal
  // durumda bırakmak yerine bir süre sonra tekrar aranmak üzere kuyruğa geri koy.
  const isTransientFailure = c.status === 'başarısız' && !!endedReason && TRANSIENT_FAILURE_PATTERN.test(endedReason);
  if (
    (c.status === 'cevapsız' || c.status === 'meşgul' || isTransientFailure) &&
    entry.retryMaxAttempts > 1 &&
    (c.attemptCount ?? 1) < entry.retryMaxAttempts
  ) {
    const retryAt = new Date(Date.now() + entry.retryDelayMinutes * 60_000).toISOString();
    console.log(`[Campaign] "${c.name}" ${c.status}${isTransientFailure ? ' (geçici hata: ' + endedReason + ')' : ''} — ${entry.retryDelayMinutes} dk sonra tekrar denenecek (deneme ${c.attemptCount ?? 1}/${entry.retryMaxAttempts})`);
    c.lastOutcome = c.status as 'cevapsız' | 'meşgul' | 'başarısız';
    c.status = 'tekrar-planlandı';
    c.failureReason = isTransientFailure
      ? translateEndedReason(endedReason) + ' — otomatik tekrar denenecek'
      : undefined;
    c.nextRetryAt = retryAt;
  }

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
  const c = entry.contacts[idx];
  c.result = summary;
  await persistContacts(entry);
  broadcastFn(entry.userId, 'campaign-contact-update', {
    campaignId: entry.id, index: idx, contact: { ...c }, summary: getCampaignSummary(entry),
  });

  // Müşteri veritabanından seçilerek kampanyaya eklenmiş bir kişiyse (bkz.
  // leadsToCampaignContacts, CampaignContact.leadId), sonuç telefon-eşleştirmesi
  // yerine doğrudan AYNI lead'e yazılsın — yeni, bağlantısız bir lead oluşmasın.
  if (c.leadId) {
    const { applyCallOutcomeToLeadById } = await import('./leads');
    applyCallOutcomeToLeadById(
      entry.userId, c.leadId, vapiCallId, summary.randevu_alindi, summary.ilgi_seviyesi, summary.ozet,
    ).catch(err => console.error('[Campaign] applyCallOutcomeToLeadById hatası:', err));
  }
}

// ─── İç yardımcılar ───────────────────────────────────────────────────────────

function isDone(entry: CampaignEngineEntry): boolean {
  const startIdx = entry.startFromIndex ?? 0;
  const scope    = entry.contacts.slice(startIdx);
  if (scope.length === 0) return false;

  const active = scope.filter(c => c.status === 'arıyor').length;
  if (active > 0) return false;

  // 'tekrar-planlandı' henüz bitmiş sayılmaz — nextRetryAt geçince fillQueue tekrar arayacak.
  const allDone = scope.every(c => c.status !== 'bekliyor' && c.status !== 'arıyor' && c.status !== 'tekrar-planlandı');
  if (allDone) return true;

  if (entry.callLimit && entry.callLimit > 0) {
    const dialed = scope.filter(c => c.status !== 'bekliyor').length;
    if (dialed >= entry.callLimit) return true;
  }

  if (entry.answeredLimit && entry.answeredLimit > 0) {
    // scope (startFromIndex sonrası) üzerinden say — fillQueue ile aynı kapsam,
    // aksi halde ikisi farklı karar verip kampanya "bitti" görünürken kuyruk
    // doldurmaya devam ederdi.
    const answered = scope.filter(c => c.status === 'tamamlandı').length;
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
  // skipReason dolu 'başarısız' bir arama HATASI değil — kişi hiç aranmadı (tekrar
  // arama koruması ya da kampanya limiti). Frontend'deki categorizeCampaignContact
  // ile aynı ayrım; ikisi farklı sayarsa panel ile SSE özeti çelişir.
  const error       = entry.contacts.filter(c => c.status === 'başarısız' && !c.skipReason && !c.skipKind).length;
  const skippedList = entry.contacts.filter(c => c.status === 'başarısız' && (!!c.skipReason || !!c.skipKind));
  const skipped     = skippedList.length;
  // Atlama KIRILIMI — danışman "1243 atlandı" görüp ne yapacağını bilemiyordu.
  // Hangisinin kurtarılabilir (limit/durdurma) hangisinin kalıcı (ret listesi,
  // tekrar-arama koruması) olduğunu panelde ayrı ayrı göstermek için.
  const skippedByLimit     = skippedList.filter(c => isLimitSkip(c.skipKind)).length;
  const skippedByStop      = skippedList.filter(c => c.skipKind === 'stopped').length;
  const skippedByDnc       = skippedList.filter(c => c.skipKind === 'dnc').length;
  const skippedDuplicate   = skippedList.filter(c => c.skipKind === 'duplicate').length;
  // skipKind'ı olmayan ESKİ kayıtlar (alan sonradan eklendi) — hiçbir kırılıma
  // girmezler, toplamın tutması için ayrı sayılırlar.
  const skippedOther       = skipped - skippedByLimit - skippedByStop - skippedByDnc - skippedDuplicate;
  const retrying     = entry.contacts.filter(c => c.status === 'tekrar-planlandı').length;
  const done        = appointment + talked + unreachable + error + skipped;
  return {
    total, done, active, waiting, appointment, talked, unreachable, error, skipped, retrying,
    skippedByLimit, skippedByStop, skippedByDnc, skippedDuplicate, skippedOther,
    randevu: appointment, fail: unreachable + error,
  };
}

async function onCampaignComplete(entry: CampaignEngineEntry): Promise<void> {
  entry.running = false;
  const randevu = entry.contacts.filter(c => c.result?.randevu_alindi).length;
  await persistContacts(entry);
  entry.status = 'completed';
  await setCampaignStatus(entry.userId, entry.id, 'completed', { markCompleted: true });
  // limitReached'i de taşı: kampanya bir LİMİTE takılarak bittiyse panel bunu
  // anında bilmeli ki "limitiniz doldu, N kişi bekliyor" banner'ını açabilsin.
  // Taşınmazsa danışman ancak sayfayı yenileyince fark ederdi.
  broadcastFn(entry.userId, 'campaign-complete', {
    campaignId: entry.id, randevu, total: entry.contacts.length,
    limitReached: entry.limitReached,
    callLimit: entry.callLimit, answeredLimit: entry.answeredLimit,
    contacts: entry.contacts,
  });
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

// Vapi hesabındaki TÜM danışmanlar arası PAYLAŞILAN eşzamanlı-arama tavanı (Vapi
// plan/telefon numarası limiti — hesap başına, kullanıcı başına değil). Kullanıcı
// bazlı maxConcurrentCalls bunun farkında değil: 3 danışman kendi tavanına kadar
// (örn. 5+5+5) aramaya çalışırsa toplam bu hesap limitini kolayca aşabilir. Vapi
// aşımı 429/"concurrent" hatasıyla reddeder ve o kişi hiç denenmeden "başarısız"
// yakılırdı — burada tüm kullanıcılar genelinde toplam aktif aramayı sayıp fillQueue
// içinde ek bir tavan olarak uygulayarak, reddedilecek istekleri hiç göndermeyip
// slotu doğal olarak diğer danışmana bırakıyoruz (kuyruk/load-balance, retry değil).
const VAPI_ACCOUNT_MAX_CONCURRENT = 10;

function countAccountActiveCalls(): number {
  let total = 0;
  for (const e of engines.values()) total += e.contacts.filter(c => c.status === 'arıyor').length;
  return total;
}

// Türkiye tek dilim (Europe/Istanbul, DST yok 2016'dan beri) — danışman bazlı
// ayrı zaman dilimi desteğine şimdilik gerek yok.
export function currentIstanbulHour(): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Istanbul', hour: 'numeric', hour12: false }).format(new Date()));
}

// 0=Pazar..6=Cumartesi (cron/JS Date.getDay() konvansiyonu) — smartPlans.ts'in
// days_of_week eşleşmesinde kullanılır. Ayrıca 'YYYY-MM-DD' (İstanbul takvim günü)
// döner — bir planın "bugün için zaten çalıştı mı" (last_run_date) kontrolü için.
export function currentIstanbulDateParts(): { dayOfWeek: number; ymd: string } {
  const now = new Date();
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Istanbul', weekday: 'short' }).format(now);
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dayOfWeek: dayMap[weekday] ?? 0, ymd };
}

// "Aynı numarayı tekrar arama koruması" penceresinin başlangıcı, UTC ISO string —
// danışmanın duplicateCallProtectionDays ayarına göre (1-90 gün, varsayılan 1 = sadece
// bugün). days=1 için İstanbul bugün 00:00 ile TAM aynı sonucu verir (geriye dönük
// uyumlu); days>1 için o kadar gün geriye giden İstanbul takvim-günü başlangıcı.
function protectionWindowStartIso(days: number): string {
  const clamped = Math.max(1, Math.min(90, Math.round(days || 1)));
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const todayStart = new Date(`${ymd}T00:00:00+03:00`);
  todayStart.setUTCDate(todayStart.getUTCDate() - (clamped - 1));
  return todayStart.toISOString();
}

export function isWithinCallingHours(start: number | null, end: number | null): boolean {
  if (start == null || end == null) return true; // sınır tanımlanmamış
  const hour = currentIstanbulHour();
  if (start === end) return true; // 0 genişlikli aralık = sınır yok say
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end; // gece yarısını aşan aralık (örn. 22-06)
}

// ElevenLabs kredisi sık sık sorgulanmasın diye kısa TTL'li cache — her fillQueue
// tetiklendiğinde (5-30sn'de bir) API'yi bombalamamak için.
const elevenLabsCreditCache = new Map<string, { remaining: number | undefined; ok: boolean; cachedAt: number }>();
// 3 dk fazla uzundu: kota bittikten sonra bu süre boyunca eski "yeterli" cevabı
// kullanılıyor ve eşzamanlı aramalarla onlarca çağrı bu pencerede başlıyordu.
const CREDIT_CHECK_TTL_MS = 45 * 1000;

// Bir aramanın yaklaşık karakter maliyeti kadar güvenlik payı. "remaining > 0"
// yetmiyor: 50 karakter kalmışken arama başlatılıyor, ses görüşmenin ORTASINDA
// kesiliyor ve Vapi 'pipeline-error-eleven-labs-voice-failed' döndürüyor — hat
// bağlandığı için arama ÜCRETLİ oluyor ama danışman hiçbir şey konuşamıyor.
// Gerçek olay: 23.09.2026'da tek bir hesapta 295 arama böyle yandı.
const ELEVENLABS_MIN_CHARS = 1500;

// Vapi çalışma anında ses hatası bildirdiğinde (pipeline-error-eleven-labs-voice-failed)
// cache'i geçersiz kılar — aksi halde motor TTL dolana kadar "kredi var" sanıp
// aynı hatayla arama başlatmaya devam eder.
export function invalidateElevenLabsCredit(userId: string): void {
  elevenLabsCreditCache.delete(userId);
}

async function hasElevenLabsCreditLeft(userId: string): Promise<boolean> {
  const enough = (remaining: number | undefined) =>
    remaining === undefined || remaining > ELEVENLABS_MIN_CHARS;
  const cached = elevenLabsCreditCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < CREDIT_CHECK_TTL_MS) {
    return !cached.ok || enough(cached.remaining);
  }
  const key = await getUserElevenLabsKey(userId);
  if (!key) return true; // ElevenLabs bağlı değil — bu kontrolün konusu değil
  const credit = await getElevenLabsCredit(key);
  elevenLabsCreditCache.set(userId, { remaining: credit.remaining, ok: credit.ok, cachedAt: Date.now() });
  if (!credit.ok) return true; // sorgu başarısız oldu — emin olamadığımız için engellemeyelim
  return enough(credit.remaining);
}

// Kredi tükenmesi (Vapi hata mesajından veya ElevenLabs kotasından anlaşılan) GERÇEK
// bir duraklatma — kullanıcı fark etmeden "Devam Et"e basana kadar kampanya durur.
// Arama saatleri dışı kalmasından (autoHeld) BİLEREK farklı: o otomatik açılır, bu açılmaz.
async function pauseForCreditExhaustion(entry: CampaignEngineEntry, reason: string): Promise<void> {
  if (entry.paused) return; // zaten duraklatılmış, tekrar tetikleme
  entry.paused    = true; // running kasıtlı olarak dokunulmuyor — "Devam Et" tekrar fillQueue'yu denesin
  entry.autoHeld  = undefined;
  entry.updatedAt = Date.now();
  entry.status = 'paused';
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

  // Jeton bakiyesi en az 1 dakikalık ücreti karşılamıyorsa yeni arama başlatma —
  // devam eden görüşme kesilmez, sadece kuyruk doldurma bekletilir (aynı ElevenLabs
  // kredi tükenmesi mantığı, bkz. pauseForCreditExhaustion).
  if ((user?.balanceTry ?? 0) < CALL_MINUTE_RATE_TRY) {
    await pauseForCreditExhaustion(entry, `Jeton bakiyesi yetersiz (kalan: ${(user?.balanceTry ?? 0).toFixed(2)} TL)`);
    return;
  }

  const startIdx = entry.startFromIndex ?? 0;
  // answeredLimit de callLimit gibi SADECE startFromIndex'ten sonrasını kapsar.
  // Tüm liste sayılırsa, "51. kişiden devam et + 20 görüşme hedefle" diyen bir
  // danışmanda önceki 50 kişinin tamamlanmış aramaları da hedefe sayılır, limit
  // anında dolar ve kampanya tek arama yapmadan "tamamlandı" olur.
  const answered = entry.contacts.slice(startIdx).filter(c => c.status === 'tamamlandı').length;
  const active   = entry.contacts.filter(c => c.status === 'arıyor').length;

  if (entry.answeredLimit && entry.answeredLimit > 0 && answered >= entry.answeredLimit) {
    let changed = false;
    // Bu kişiler HİÇ aranmadı — arama başarısız olmadı, kampanya hedefine ulaştığı
    // için sıra onlara gelmedi. failureReason ("⚠️ Hata" tooltip'i) yerine skipReason
    // (🔒 atlandı ikonu) kullanılır, aksi halde danışman panelde onlarca sahte hata görür.
    entry.contacts.forEach(c => {
      if (c.status === 'bekliyor' || c.status === 'tekrar-planlandı') {
        c.status = 'başarısız';
        c.skipReason = `Kampanya "${entry.answeredLimit} görüşme" hedefine ulaştığı için bu kişi aranmadı.`;
        // Ret listesi/DNC'den FARKLI olarak bu kişi sadece SAYISAL bir hedefe
        // takıldı — danışman hedefi yükseltip devam ederse tekrar aranabilir olmalı.
        // Önceden bu bayrak yoktu; limite takılan yüzlerce/binlerce kişi kalıcı
        // kilitleniyordu — tek "kurtarma" yolu listeyi SIFIRDAN yeniden yüklemekti.
        c.skipKind = 'answered-limit';
        c.skipResumable = true;
        changed = true;
      }
    });
    // Panelde "görüşme hedefiniz doldu, N kişi bekliyor" banner'ını açar.
    entry.limitReached = 'answered';
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
      entry.contacts.forEach(c => {
        if (c.status === 'bekliyor' || c.status === 'tekrar-planlandı') {
          c.status = 'başarısız';
          c.skipReason = `Kampanya "${entry.callLimit} arama" limitine ulaştığı için bu kişi aranmadı.`;
          // bkz. answeredLimit dalındaki aynı not — sayısal limite takılan kişiler
          // limit yükseltilip devam edilirse tekrar aranabilir olmalı.
          c.skipKind = 'call-limit';
          c.skipResumable = true;
          changed = true;
        }
      });
      // Panelde "arama limitiniz doldu, N kişi bekliyor" banner'ını açar.
      entry.limitReached = 'call';
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
  let concurrencyLimited = false;
  if (slots > 0) {
    const ceiling = user?.maxConcurrentCalls ?? 3;
    const userActive = countUserActiveCalls(entry.userId);
    const capped = Math.max(0, ceiling - userActive);
    if (capped < slots) concurrencyLimited = true;
    slots = Math.min(slots, capped);
  }

  // Hesap-genelinde (TÜM danışmanlar) paylaşılan Vapi tavanı — kullanıcı tavanının
  // içinde kalsa bile başka danışmanların aktif aramaları toplamı hesap limitine
  // çarpabilir. Burada slotu daraltıyoruz, kimseyi reddetmiyoruz: kalan kişi
  // 'bekliyor'da kalır, bir sonraki tick'te (5-15sn) hat boşalınca otomatik denenir.
  if (slots > 0) {
    const accountActive = countAccountActiveCalls();
    const accountCapped = Math.max(0, VAPI_ACCOUNT_MAX_CONCURRENT - accountActive);
    if (accountCapped < slots) concurrencyLimited = true;
    slots = Math.min(slots, accountCapped);
  }

  // Bilgilendirme amaçlı — hata değil, sadece "neden şu an daha fazla arama
  // başlamıyor" sorusuna kampanya panelinde tek bir not olarak cevap verir.
  if (concurrencyLimited && slots === 0) {
    if (entry.autoHeld !== 'concurrency-limit') {
      entry.autoHeld = 'concurrency-limit';
      broadcastFn(entry.userId, 'campaign-update', toSnapshot(entry));
    }
  } else if (entry.autoHeld === 'concurrency-limit') {
    entry.autoHeld = undefined;
    broadcastFn(entry.userId, 'campaign-update', toSnapshot(entry));
  }

  if (slots <= 0) return;

  let started = 0;
  let reconciledAny = false;
  const protectionWindowStart = protectionWindowStartIso(user?.duplicateCallProtectionDays ?? 1);
  for (let i = startIdx; i < entry.contacts.length && started < slots; i++) {
    const c = entry.contacts[i];
    const retryDue = c.status === 'tekrar-planlandı' && !!c.nextRetryAt && new Date(c.nextRetryAt) <= new Date();
    if (c.status !== 'bekliyor' && !retryDue) continue;

    // Global ret listesi (bkz. src/dncList.ts) — bu numara HERHANGİ bir danışmana
    // "bir daha aramayın" dediyse, kampanya bunu sessizce atlamak yerine "başarısız"
    // yakıp NEDENİNİ göstermeli — aksi halde danışman "neden bu kişi hiç aranmadı"
    // diye sorar.
    if (await isPhoneBlocked(c.phone)) {
      c.status = 'başarısız';
      // failureReason DEĞİL skipReason: bu bir arama arızası değil, bilinçli atlama.
      // failureReason'a yazılırsa "⚠️ Hata" sayacını şişirip gerçek teknik hataları gizler.
      c.skipReason = 'Bu numara ret listesinde — daha önce "bir daha aramayın" talebinde bulunmuş.';
      // Kurtarılamaz: geri alınsa aynı kontrole takılıp yeniden atlanırdı.
      c.skipKind = 'dnc';
      reconciledAny = true;
      continue;
    }

    // Güvenlik ağı: contact.status yanlış/eski kalmış olsa bile (örn. bir deploy
    // sırasında kaybolan webhook yazımı), bu kişiyi koruma penceresi içinde GERÇEKTEN
    // aramadığımızı arama başlatmadan hemen önce, DIŞARIDAN (calls tablosundan)
    // bağımsızca doğrula. Aksi halde aynı kişi ikinci kez, gereksiz maliyetle aranabilir.
    const already: BestCallInfo | null = await findRecentCallForPhone(entry.userId, c.phone, protectionWindowStart);
    if (already) {
      const mappedStatus = callStatusToTurkish(already.status) as CampaignContact['status'];
      if (already.summary) c.result = already.summary;
      if ((STATUS_PRIORITY[mappedStatus] ?? -1) > (STATUS_PRIORITY[c.status] ?? -1)) c.status = mappedStatus;
      c.skipReason = `Son ${user?.duplicateCallProtectionDays ?? 1} gün içinde zaten arandı — tekrar arama koruması nedeniyle bugün tekrar aranmadı, önceki sonuç gösteriliyor.`;
      // Kurtarılamaz: geri alınsa aynı koruma penceresine takılıp yeniden atlanırdı.
      c.skipKind = 'duplicate';
      reconciledAny = true;
      // KASITLI console.log (console.warn DEĞİL) — bu bir hata değil, tekrar arama
      // kontrolünün (duplicate-call protection) doğru çalıştığının kaydı. console.warn
      // stderr'e yazılır ve Railway bunu kırmızı "error" seviyesinde gösterir, bu da
      // danışmana kampanyada gerçek bir hata varmış gibi yanlış izlenim veriyordu.
      console.log(`[Campaign] Tekrar arama kontrolü: "${c.name}" (${c.phone}) zaten arandı (${already.vapiCallId}) — tekrar aranmadı, durum senkronize edildi.`);
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
  c.attemptCount = (c.attemptCount ?? 0) + 1;
  c.nextRetryAt  = null;
  // Önceki denemeden kalan hata/atlama notları bu yeni denemeye ait değil —
  // temizlenmezse danışman devam eden bir aramanın üzerinde eski hatayı görür.
  c.failureReason = undefined;
  c.skipReason    = undefined;
  c.skipResumable = undefined;
  c.lastOutcome   = undefined;

  broadcastFn(entry.userId, 'campaign-contact-update', {
    campaignId: entry.id, index: idx, contact: { ...c }, summary: getCampaignSummary(entry),
  });

  try {
    const creds    = await resolveVapiCreds(entry.userId);
    const scenario = entry.scenarioId ? await getScenario(entry.userId, entry.scenarioId) : null;
    const user     = await getUserById(entry.userId);
    // Numarayı burada da normalize et: yeni kampanyalar rota katmanında (server.ts
    // splitValidContacts) zaten E.164'e çevriliyor, ama o doğrulama eklenmeden ÖNCE
    // kaydedilmiş kampanyalar DB'de ham ("0555…") numarayla duruyor ve doğrudan
    // Vapi'ye gönderilirse anlamsız bir 400 ile başarısız olur.
    // Vapi customer.name alanini 40 karakterle sinirliyor. Birlesik/esli kayitlarda
    // ("AHMET X - DERYA Y - DENIZ Z" gibi) isim bunu kolayca asiyor; asilirsa Vapi
    // 400 dondurur ve bu HATA YANLISLIKLA 'telefon numarasi formati reddedildi'
    // diye goruniyordu (bkz. campaignErrors.ts) -- oysa numara tamamen gecerliydi.
    // Kisaltarak aramanin hic basarisiz olmamasini sagliyoruz.
    const customer: CustomerInfo = {
      name: (c.name || '').slice(0, 40), phone: normalizePhone(c.phone) || c.phone,
      region: c.region || '', notes: c.notes || '', reference: c.reference || '',
    };
    // Açılış A/B: senaryoda aktif varyant varsa biri seçilir ve prompt'un başına
    // eklenir; hangi varyantın kullanıldığı arama kaydına yazılır (bkz. src/opening.ts).
    const opening = pickOpeningVariant(scenario);
    const agentName = user?.assistantName || 'Asistan';
    const vapiCall = await createVapiCall(creds, customer, buildCallPrompt(scenario, opening), {
      agentName,
      voiceModel: scenario?.voiceModel,
      waitForGreeting: resolveWaitForGreeting(scenario, opening),
      variableOverrides: nameVariableValues(scenario, customer.name, agentName),
    });
    c.vapiCallId   = vapiCall.id;

    // Aramayı DB'ye kaydet — Geçmiş Aramalar'da VE kampanya analizinde görünmesi için.
    // leadSource boşsa kampanya adı fallback olur — raporlamada hiçbir arama kaynaksız kalmaz.
    await createCall(entry.userId, vapiCall.id, customer, scenario?.id, scenario?.name, entry.id, c.leadSource || entry.name,
      undefined, undefined, { openingVariantId: opening?.id });

    await persistContacts(entry);
    // campaignId ZORUNLU: istemcideki filtre (app.js campaign-contact-update) onu
    // göndermeyen olayları "bu ekrandaki kampanya" varsayıp uyguluyor — danışman
    // aynı anda iki kampanya çalıştırıyorsa bu satır YANLIŞ kampanyanın tablosuna
    // yazılırdı.
    broadcastFn(entry.userId, 'campaign-contact-update', {
      campaignId: entry.id, index: idx, contact: { ...c }, summary: getCampaignSummary(entry),
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
        campaignId: entry.id, index: idx, contact: { ...c }, summary: getCampaignSummary(entry),
      });
      await pauseForCreditExhaustion(entry, `Vapi kredisi/bakiyesi tükenmiş olabilir: ${String(err).slice(0, 200)}`);
      return;
    }

    c.status = 'başarısız';
    c.failureReason = translateDialError(err);
    await persistContacts(entry);
    broadcastFn(entry.userId, 'campaign-contact-update', {
      campaignId: entry.id, index: idx, contact: { ...c }, summary: getCampaignSummary(entry),
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
      // Kişiyi "başarısız" yakmak yerel durumu düzeltir ama Vapi'deki GERÇEK arama
      // sürüyor olabilir — o zaman hem dakika ücreti işlemeye devam eder hem de
      // eşzamanlılık sayaçları (countUserActiveCalls) gerçeği yansıtmaz. Bu yüzden
      // hattı Vapi tarafında da fiilen kapat. Hata yutulur: çağrı zaten bitmişse
      // (404) ya da kimlik bilgileri okunamazsa yerel temizlik yine de yapılmalı.
      const callIdToEnd = c.vapiCallId;
      resolveVapiCreds(entry.userId)
        .then(creds => endVapiCall(creds.apiKey, callIdToEnd))
        .catch(err => console.warn(`[Campaign] Zaman aşımına uğrayan arama Vapi'de kapatılamadı (${callIdToEnd}):`, err));
      c.status = 'başarısız';
      c.failureReason = 'Arama 5 dakikayı aştı ve zaman aşımına uğradı.';
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
    } catch (err) {
      // Tek bir kisinin okunamamasi digerlerinin uzlastirmasini durdurmamali —
      // ama tamamen sessiz kalmak da DB sorununu gorunmez kilardi.
      console.warn(`[Campaign] "${c.name}" durum uzlastirmasi okunamadi (${c.vapiCallId}):`, err);
    }
  }

  if (changed) {
    await persistContacts(entry);
    broadcastFn(entry.userId, 'campaign-update', toSnapshot(entry));
    if (isDone(entry)) { await onCampaignComplete(entry); return; }
  }

  await fillQueue(entry);
}
