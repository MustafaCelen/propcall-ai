// PropCall AI — Global "Beni bir daha aramayın" ret listesi. İYS ret-listesi
// mantığıyla aynı ilke: bir numara bir danışmana bunu söylediğinde ŞİRKET ÇAPINDA
// hiçbir danışman o numarayı bir daha arayamaz — kullanıcı bazlı değil, numara bazlı
// tek bir global liste (bkz. src/db.ts do_not_call_list tablosu).
//
// AI ile otomatik tespit (generateCallSummary'nin ürettiği beni_aramayin_talebi alanı,
// bkz. src/ai.ts) burada eklenir; ileride danışmanın manuel işaretlemesi de aynı
// tabloya 'manual' source'uyla yazılabilir.

import pool from './db';

// Client-side cleanPhone (public/app.js) ile aynı Türkiye-öncelikli normalizasyon —
// ret listesindeki ve gelen aramadaki numaranın AYNI formatta karşılaştırılması için.
// Normalize etmezsek "+905551234567" ile "05551234567" farklı satır sayılıp kontrol
// sessizce delinebilir.
export function normalizePhone(raw: string): string {
  let p = String(raw ?? '').trim().replace(/[\s\-().]/g, '');
  if (!p) return '';
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (p.startsWith('+')) return p;

  const digits = p.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('90') && digits.length === 12) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 11) return '+90' + digits.slice(1);
  if (digits.length === 10) return '+90' + digits;
  return '+' + digits;
}

// Bir numaranın DB'de karşılaşılabilecek tüm yazım biçimleri. Telefon alanları
// tarihsel olarak iki formatta yazıldı: normalizasyon eklenmeden önce ham kullanıcı
// girdisi ("0555…"), sonrasında E.164 ("+90555…"). Numara-bazlı HER eşleştirme
// (arama geçmişi, tekrar arama koruması, aday/CRM eşleşmesi) iki biçimi de
// kapsamalı; tek formatla sorgulamak eski kayıtları görünmez yapar.
export function phoneVariants(phone: string): string[] {
  const raw = String(phone ?? '').trim();
  const normalized = normalizePhone(raw);
  const variants = new Set<string>();
  if (raw) variants.add(raw);
  if (normalized) {
    variants.add(normalized);
    if (normalized.startsWith('+90') && normalized.length === 13) {
      variants.add('0' + normalized.slice(3));
    }
  }
  return [...variants];
}

// ─── Deterministik tespit (çift tetiğin ikinci kolu) ─────────────────────────
// AI özeti (beni_aramayin_talebi) tek tetikken iki sorun vardı: özet üretilemeyen
// aramalarda (Anthropic kredisi bitmiş, bozuk JSON) talep tamamen kaçıyordu ve model
// ara sıra "şu an ilgilenmiyor"u da talep sayıyordu. Burası özetten BAĞIMSIZ çalışır:
// yalnızca MÜŞTERİNİN söylediklerine bakar ve ancak açık bir "bir daha aramayın"
// kalıbı geçiyorsa tetiklenir. Kalıplar bilinçli olarak dar — yanlış pozitif kalıcı
// engel demek. "ilgilenmiyorum / müsait değilim" gibi normal retler eşleşmez.
// "ara-" fiilinin yalnızca OLUMSUZ EMİR/İSTEK çekimleri: aramayın, arama, aramayınız,
// aramazsanız (sevinirim), aramasın. "aramaların", "aramalar" gibi isim halleri ve
// "arayın" (olumlu) eşleşmez — canlı transkriptlerde bunlar yanlış tetik üretmişti.
const NEG_CALL = 'ara(ma|may[ıi]n|may[ıi]n[ıi]z|mazsan[ıi]z|mas[ıi]n)\\b';
const DNC_REQUEST_PATTERNS: RegExp[] = [
  new RegExp(`\\b(bir daha|tekrar|artık)\\s+(beni |bizi )?${NEG_CALL}`),          // bir daha aramayın / tekrar arama
  new RegExp(`\\b(beni|bizi)\\s+(bir daha |tekrar |artık |lütfen )?${NEG_CALL}`),  // beni aramayın / beni aramazsanız
  new RegExp(`\\b${NEG_CALL}\\s+(bir daha|artık|lütfen|beni|bizi)\\b`),            // aramayın lütfen / aramayın beni
  /\bnumaram[ıi]\s+(sil|çıkar|kaldır)/,                                            // numaramı silin
  /\blisten?(iz)?den\s+(beni |numaramı )?(çıkar|sil|kaldır)/,                      // listenizden çıkarın
  /\brahatsız\s+etmey(in|iniz)\b|\brahatsız\s+etme\b/,                             // rahatsız etmeyin (emir)
  /\b(ararsan[ıi]z|ararsan)\s+şikayet/,                                            // tekrar ararsanız şikayet ederim
];

// Müşteri turlarını tarar; eşleşen ilk cümleyi (gerekçe olarak kaydetmek için) döner.
export function detectDncRequest(transcript: Array<{ role: string; text: string }>): string | null {
  for (const t of transcript) {
    if (t.role !== 'user' || !t.text) continue;
    const norm = t.text.toLocaleLowerCase('tr').replace(/[^a-zçğıöşü0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (DNC_REQUEST_PATTERNS.some(re => re.test(norm))) return t.text.trim().slice(0, 200);
  }
  return null;
}

export async function isPhoneBlocked(phone: string): Promise<boolean> {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  const { rowCount } = await pool.query(
    `SELECT 1 FROM do_not_call_list WHERE phone = $1`,
    [normalized],
  );
  return (rowCount ?? 0) > 0;
}

export async function addToDoNotCallList(
  phone: string, reason: string | null, source: 'ai_detected' | 'keyword_detected' | 'manual',
  addedByUserId: string | null, vapiCallId: string | null,
): Promise<void> {
  const normalized = normalizePhone(phone);
  if (!normalized) return;
  await pool.query(
    `INSERT INTO do_not_call_list (phone, reason, source, added_by_user_id, vapi_call_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (phone) DO NOTHING`,
    [normalized, reason, source, addedByUserId, vapiCallId],
  );
}

export interface DoNotCallEntry {
  phone: string;
  reason: string | null;
  source: string;
  createdAt: string;
}

export async function listDoNotCallEntries(): Promise<DoNotCallEntry[]> {
  const { rows } = await pool.query(
    `SELECT phone, reason, source, created_at FROM do_not_call_list ORDER BY created_at DESC`,
  );
  return rows.map(r => ({ phone: r.phone, reason: r.reason, source: r.source, createdAt: r.created_at }));
}

export async function removeFromDoNotCallList(phone: string): Promise<boolean> {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  const { rowCount } = await pool.query(`DELETE FROM do_not_call_list WHERE phone = $1`, [normalized]);
  return (rowCount ?? 0) > 0;
}
