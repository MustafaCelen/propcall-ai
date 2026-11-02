// PropCall AI — Kampanya kalıcı depolama + kampanya-bazlı analiz.
//
// campaign.ts (tekil) canlı arama motorudur (kuyruk, tick, webhook kancaları).
// Bu dosya (campaigns.ts, çoğul) o motorun üzerinde çalıştığı KALICI kaydı yönetir:
// bir kampanya oluşturulduğunda burada bir satır açılır, motor onu günceller,
// bittiğinde de silinmez — geçmişte kalır, karşılaştırılabilir.

import pool from './db';
import { CallSummary } from './types';

// Bir kişinin neden HİÇ ARANMADIĞININ yapısal sebebi (bkz. CampaignContact.skipKind).
// 'dnc'            — global ret listesinde ("bir daha aramayın" demiş)
// 'duplicate'      — tekrar arama koruması: aynı numara yakın zamanda arandı
// 'call-limit'     — kampanyanın "toplam kaç arama" limiti doldu
// 'answered-limit' — kampanyanın "kaç görüşme" hedefi doldu
// 'stopped'        — danışman kampanyayı durdurdu, sıra bu kişiye gelmedi
export type SkipKind = 'dnc' | 'duplicate' | 'call-limit' | 'answered-limit' | 'stopped' | 'invalid-phone';

// Hangi atlama türü kuyruğa geri alınabilir? Sayısal limitler ve durdurma geri
// alınabilir (danışman limiti yükseltir ya da kampanyayı sürdürür); ret listesi ve
// tekrar-arama koruması alınamaz — geri alınsalar aynı kontrole takılıp yeniden
// atlanırlardı, danışmana hiçbir şey yapmayan bir buton göstermiş olurduk.
export const SKIP_KIND_RESUMABLE: Record<SkipKind, boolean> = {
  dnc: false,
  duplicate: false,
  'call-limit': true,
  'answered-limit': true,
  stopped: true,
  // Numara gercekten bozuksa (CSV'den eksik/fazla haneli gelmis) 'Tekrar Dene'
  // ayni 400 hatasini tekrar tekrar alirdi -- kurtarilamaz.
  'invalid-phone': false,
};

// Sayısal limit kaynaklı atlamalar — limit yükseltilince kurtarılacak olanlar.
export function isLimitSkip(kind?: SkipKind): boolean {
  return kind === 'call-limit' || kind === 'answered-limit';
}

// Eski kayıtlarda skipKind yok (bu alan sonradan eklendi). O kayıtlarda tek
// bilgimiz skipResumable boolean'ı — yeni alan yoksa ona düşeriz, böylece
// geçmiş kampanyalar da doğru davranmaya devam eder.
export function isSkipResumable(c: Pick<CampaignContact, 'skipKind' | 'skipResumable'>): boolean {
  if (c.skipKind) return SKIP_KIND_RESUMABLE[c.skipKind];
  return c.skipResumable === true;
}

export interface CampaignContact {
  name: string;
  phone: string;
  region: string;
  notes: string;
  reference: string;
  leadSource?: string; // hangi ilan/reklam/liste — raporlamada kaynak bazlı dönüşüm için
  // Müşteri veritabanından (leads) seçilerek kampanyaya eklendiyse orijinal lead'in
  // ID'si — arama sonucu geldiğinde telefon-eşleştirmesi yerine doğrudan bu ID ile
  // AYNI lead'e yazılabilsin diye (bkz. campaign.ts onCampaignCallEnded). CSV'den
  // gelen (henüz veritabanına kaydedilmemiş) kişilerde null/undefined kalır.
  leadId?: string | null;
  // 'tekrar-planlandı': cevapsız/meşgul sonrası otomatik yeniden arama bekliyor —
  // nextRetryAt geçince fillQueue() bunu 'bekliyor' gibi tekrar arar (bkz. campaign.ts).
  status: 'bekliyor' | 'arıyor' | 'tamamlandı' | 'cevapsız' | 'meşgul' | 'başarısız' | 'tekrar-planlandı';
  vapiCallId: string | null;
  result: CallSummary | null;
  duration?: number;
  callStartTs?: number;
  attemptCount?: number;      // bu kişi kaç kez arandı (fresh + retry toplamı)
  nextRetryAt?: string | null; // ISO — 'tekrar-planlandı' durumundayken bu zamandan sonra tekrar aranabilir
  // 'tekrar-planlandı' durumu asıl sonucu (cevapsız mı, meşgul mü) ezer; danışmana
  // "Cevapsız — 14:30'da tekrar aranacak" diyebilmek için son sonuç burada saklanır.
  lastOutcome?: 'cevapsız' | 'meşgul' | 'başarısız';
  // İnsan-okur Türkçe hata sebebi — status 'başarısız' veya 'tekrar-planlandı' olduğunda
  // dolu olur. Ham Vapi/SIP hata koduna DEĞİL, translateEndedReason() çıktısına karşılık
  // gelir (bkz. campaignErrors.ts) — danışmanın "⚠️ Hata" etiketinin üzerine gelince
  // gördüğü tooltip metni budur.
  failureReason?: string;
  // Bu kişi hiç aranmadı ama arama da denenmedi — örn. tekrar arama koruması nedeniyle
  // bilerek atlandı. failureReason'dan farklı: bu bir HATA değil, kasıtlı bir atlama.
  skipReason?: string;
  // Atlama geri alınabilir mi? Durdurma ve sayısal limitler yüzünden atlananlar
  // kuyruğa geri alınabilir (true); ret listesi (DNC) ve tekrar-arama koruması
  // yüzünden atlananlar alınamaz (false/undefined) — onları geri almak aynı
  // kontrole takılırdı. skipKind'dan türetilir, bkz. SKIP_KIND_RESUMABLE.
  skipResumable?: boolean;
  // Atlamanın YAPISAL sebebi. skipReason insan-okur metindir, bu ise mantık içindir:
  // hangi kurtarma aksiyonunun geçerli olduğunu ve panelde hangi kovaya sayılacağını
  // belirler. Önceden bu bilgi yalnızca skipReason metninde vardı; ona göre karar
  // vermek (skipReason.includes('limit')) metin değişince sessizce bozulurdu.
  // Eski kayıtlarda undefined olabilir — okurken skipResumable'a düşülür.
  skipKind?: SkipKind;
}

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed' | 'stopped';

export interface CampaignRecord {
  id: string;
  userId: string;
  name: string;
  scenarioId?: string;
  scenarioName?: string;
  status: CampaignStatus;
  maxConcurrent: number;
  startFromIndex: number;
  callLimit: number;
  answeredLimit: number;
  retryMaxAttempts: number;
  retryDelayMinutes: number;
  smartPlanId?: string;
  contacts: CampaignContact[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface CampaignListRow {
  id: string;
  name: string;
  scenarioName: string | null;
  status: CampaignStatus;
  totalContacts: number;
  callsMade: number;
  completed: number;
  randevu: number;
  randevuRate: number;
  totalCost: number;
  avgDuration: number;
  smartPlanId: string | null;
  smartPlanName: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

function newCampaignId(): string {
  return 'camp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function rowToRecord(r: any): CampaignRecord {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    scenarioId: r.scenario_id || undefined,
    scenarioName: r.scenario_name || undefined,
    status: r.status,
    maxConcurrent: r.max_concurrent,
    startFromIndex: r.start_from_index,
    callLimit: r.call_limit,
    answeredLimit: r.answered_limit,
    retryMaxAttempts: r.retry_max_attempts ?? 2,
    retryDelayMinutes: r.retry_delay_minutes ?? 120,
    smartPlanId: r.smart_plan_id || undefined,
    contacts: r.contacts || [],
    createdAt: r.created_at?.toISOString?.() ?? r.created_at,
    startedAt: r.started_at?.toISOString?.() ?? r.started_at ?? undefined,
    completedAt: r.completed_at?.toISOString?.() ?? r.completed_at ?? undefined,
    updatedAt: r.updated_at?.toISOString?.() ?? r.updated_at,
  };
}

export async function createCampaign(userId: string, params: {
  name: string;
  scenarioId?: string;
  scenarioName?: string;
  maxConcurrent: number;
  startFromIndex: number;
  callLimit: number;
  answeredLimit: number;
  retryMaxAttempts?: number;
  retryDelayMinutes?: number;
  smartPlanId?: string;
  contacts: Array<Omit<CampaignContact, 'status' | 'vapiCallId' | 'result'>>;
}): Promise<CampaignRecord> {
  const id = newCampaignId();
  const contacts: CampaignContact[] = params.contacts.map(c => ({
    ...c, status: 'bekliyor', vapiCallId: null, result: null,
  }));

  const { rows } = await pool.query(
    `INSERT INTO campaigns
       (id, name, scenario_id, scenario_name, status, max_concurrent,
        start_from_index, call_limit, answered_limit, retry_max_attempts, retry_delay_minutes, smart_plan_id, contacts, user_id)
     VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      id, params.name.trim() || 'İsimsiz Kampanya', params.scenarioId || null, params.scenarioName || null,
      params.maxConcurrent, params.startFromIndex, params.callLimit, params.answeredLimit,
      Math.max(1, params.retryMaxAttempts || 2), Math.max(1, params.retryDelayMinutes || 120),
      params.smartPlanId || null, JSON.stringify(contacts), userId,
    ],
  );
  return rowToRecord(rows[0]);
}

export async function getCampaign(userId: string, id: string): Promise<CampaignRecord | null> {
  const { rows } = await pool.query('SELECT * FROM campaigns WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows[0] ? rowToRecord(rows[0]) : null;
}

// Motor yeniden başladığında hafızaya alınacak kampanyalar: running/paused (devam
// edecekler) ve draft (yüklenmiş ama henüz başlatılmamış listeler). Draft'lar
// eskiden yüklenmiyordu — danışman Excel yükleyip "Başlat"a basmadan bir deploy
// olursa liste sunucudan da kayboluyordu.
const ENGINE_STATUSES = `('draft','running','paused')`;

export async function getActiveCampaigns(userId: string): Promise<CampaignRecord[]> {
  const { rows } = await pool.query(
    `SELECT * FROM campaigns WHERE user_id = $1 AND status IN ${ENGINE_STATUSES} ORDER BY updated_at DESC`,
    [userId],
  );
  return rows.map(rowToRecord);
}

// Sunucu açılışında TÜM kullanıcıların motor kampanyalarını tek seferde yüklemek için —
// motor (campaign.ts) her satırı kendi user_id'siyle hafızaya alır. Rota katmanından çağrılmaz.
export async function getAllActiveCampaigns(): Promise<CampaignRecord[]> {
  const { rows } = await pool.query(
    `SELECT * FROM campaigns WHERE status IN ${ENGINE_STATUSES} ORDER BY updated_at DESC`,
  );
  return rows.map(rowToRecord);
}

export async function saveCampaignContacts(userId: string, id: string, contacts: CampaignContact[]): Promise<void> {
  await pool.query(
    `UPDATE campaigns SET contacts = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
    [id, userId, JSON.stringify(contacts)],
  );
}

export async function setCampaignStatus(
  userId: string,
  id: string,
  status: CampaignStatus,
  opts?: { markStarted?: boolean; markCompleted?: boolean },
): Promise<void> {
  const sets: string[] = ['status = $3', 'updated_at = NOW()'];
  if (opts?.markStarted)   sets.push('started_at = COALESCE(started_at, NOW())');
  if (opts?.markCompleted) sets.push('completed_at = NOW()');
  await pool.query(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2`, [id, userId, status]);
}

// Var olan bir kampanyayı "belirli bir satırdan devam et" gibi ayarlarla güncellemek
// için — contacts'a (ve dolayısıyla birikmiş arama sonuçlarına) DOKUNMAZ, sadece
// kuyruk davranışını belirleyen alanları değiştirir. "Başlat"a tekrar basınca listeyi
// sıfırdan yükleyip tüm ilerlemenin kaybolmasının önüne geçmek için eklendi.
export async function updateCampaignSettings(
  userId: string,
  id: string,
  patch: {
    startFromIndex?: number; maxConcurrent?: number; callLimit?: number; answeredLimit?: number;
    retryMaxAttempts?: number; retryDelayMinutes?: number;
    // Ad ve senaryo yükleme anında henüz bilinmez (danışman önce Excel'i atar, sonra
    // formu doldurur) — "Başlat"ta draft'ın üstüne yazılır.
    name?: string; scenarioId?: string | null; scenarioName?: string | null;
  },
): Promise<void> {
  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [id, userId];
  const add = (col: string, v: number | string | null | undefined) => {
    if (v === undefined) return;
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  add('name', patch.name);
  add('scenario_id', patch.scenarioId);
  add('scenario_name', patch.scenarioName);
  add('start_from_index', patch.startFromIndex);
  add('max_concurrent', patch.maxConcurrent);
  add('call_limit', patch.callLimit);
  add('answered_limit', patch.answeredLimit);
  add('retry_max_attempts', patch.retryMaxAttempts);
  add('retry_delay_minutes', patch.retryDelayMinutes);
  if (sets.length === 1) return; // hiçbir alan verilmemiş
  await pool.query(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2`, vals);
}

// Geçmiş kampanya listesi — her satır için calls tablosundan gerçek maliyet/süre/randevu
// bilgisini tek sorguda hesaplar (contacts JSONB'de maliyet tutulmuyor, kaynak calls tablosu).
export async function listCampaigns(userId: string): Promise<CampaignListRow[]> {
  const { rows } = await pool.query(`
    SELECT
      camp.id, camp.name, camp.scenario_name, camp.status,
      camp.created_at, camp.started_at, camp.completed_at,
      camp.smart_plan_id, sp.name AS smart_plan_name,
      jsonb_array_length(camp.contacts)::int AS total_contacts,
      COUNT(c.vapi_call_id)::int AS calls_made,
      COUNT(*) FILTER (WHERE c.status = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE (c.data->'summary'->>'randevu_alindi')::boolean = true)::int AS randevu,
      COUNT(*) FILTER (WHERE c.data->'summary' IS NOT NULL)::int AS with_summary,
      COALESCE(SUM((c.data->'costs'->>'total')::float), 0) AS total_cost,
      COALESCE(AVG((c.data->>'duration')::float) FILTER (WHERE c.status != 'in-progress'), 0) AS avg_duration
    FROM campaigns camp
    LEFT JOIN calls c ON c.data->>'campaignId' = camp.id AND c.user_id = camp.user_id
    LEFT JOIN smart_plans sp ON sp.id = camp.smart_plan_id
    WHERE camp.user_id = $1
    GROUP BY camp.id, sp.name
    ORDER BY camp.created_at DESC
  `, [userId]);
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    scenarioName: r.scenario_name,
    status: r.status,
    totalContacts: r.total_contacts,
    callsMade: r.calls_made,
    completed: r.completed,
    randevu: r.randevu,
    // Payda GERÇEKTEN GÖRÜŞÜLEN aramalar (özeti olanlar) — İstatistikler sayfasıyla
    // AYNI tanım (bkz. calls.ts getStats: randevuCount / withSummary). Önceden
    // calls_made'e (cevapsızlar dahil TÜM denemeler) bölünüyordu; aynı kampanya iki
    // ekranda farklı dönüşüm oranı gösterip hangisinin doğru olduğunu belirsizleştiriyordu.
    randevuRate: r.with_summary ? Math.round(r.randevu / r.with_summary * 100) : 0,
    totalCost: Math.round(Number(r.total_cost) * 10000) / 10000,
    avgDuration: Math.round(Number(r.avg_duration)),
    smartPlanId: r.smart_plan_id || null,
    smartPlanName: r.smart_plan_name || null,
    createdAt: r.created_at?.toISOString?.() ?? r.created_at,
    startedAt: r.started_at?.toISOString?.() ?? r.started_at ?? null,
    completedAt: r.completed_at?.toISOString?.() ?? r.completed_at ?? null,
  }));
}

// Kampanyayı kalıcı olarak siler. ÇALIŞAN/DURAKLATILMIŞ bir kampanya silinemez —
// motor onu hafızada tutmaya devam eder ve satır kaybolunca persistContacts her
// tick'te sessizce 0 satır günceller (kampanya "hayalet" olarak arama yapmayı
// sürdürür). Çağıran önce durdurmalı.
// Aramalar (calls) SİLİNMEZ: maliyet/istatistik geçmişi korunur, sadece kampanya
// kaydı kalkar — aramalar campaignId ile bağlıydı, artık sahipsiz kalır ama
// İstatistikler ve Geçmiş Aramalar'da görünmeye devam eder.
export async function deleteCampaignRecord(userId: string, id: string): Promise<
  { deleted: boolean; reason?: 'not-found' | 'active' }
> {
  const { rows } = await pool.query(
    'SELECT status FROM campaigns WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  if (!rows[0]) return { deleted: false, reason: 'not-found' };
  if (rows[0].status === 'running' || rows[0].status === 'paused') {
    return { deleted: false, reason: 'active' };
  }
  await pool.query('DELETE FROM campaigns WHERE id = $1 AND user_id = $2', [id, userId]);
  return { deleted: true };
}
