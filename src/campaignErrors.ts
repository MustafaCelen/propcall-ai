// PropCall AI — Toplu Arama hata/durum mesajlarını danışmanın anlayacağı, insan-okur
// Türkçe cümlelere çeviren tek yer. İki farklı girdi kaynağı var:
//   1. endedReason: Vapi'nin webhook'ta gönderdiği ham SIP/pipeline hata kodu
//      (örn. "sip-487-request-terminated", "pipeline-error-openai-llm-failed").
//   2. dial-time hata metni: createVapiCall() içindeki fetch başarısız olduğunda
//      throw edilen "Vapi API hatası: <status> - <mesaj>" formatındaki metin.
// Bilinen kalıplara TAM kapsayıcı bir liste hedeflenmiyor — en sık görülen birkaç
// kalıp çevrilir, geri kalanı için ham mesaj (kısaltılmış) fallback olarak gösterilir;
// bu, hiçbir şey göstermemekten iyidir.

const KNOWN_PATTERNS: Array<{ test: RegExp; message: string }> = [
  { test: /sip-4\d\d|sip-5\d\d|call-rejected|rejected/i,
    message: 'Operatör aramayı reddetti (numara meşgul, kapalı veya arama engelli olabilir)' },
  { test: /pipeline-error/i,
    message: 'Sistemsel bir hata oluştu (ses/model altyapısı) — bu kişi otomatik tekrar denenecek' },
  // DIKKAT: sadece '400' arayan eski desen, customer.name uzunluk hatasi gibi
  // TELEFONLA ILGISIZ 400'leri de "telefon formati reddedildi" diye gosteriyordu
  // (prod'da 93/107 hata bu sekilde yanlis etiketlenmisti). Artik yalnizca
  // gercekten telefon/numara/E.164 kelimesi gecen 400 hatalari bu mesaja girer.
  { test: /invalid.*phone|phone.*invalid|E\.?164|phone.*number.*invalid|400.*phone|phone.*400/i,
    message: 'Telefon numarası formatı Vapi tarafından reddedildi' },
  { test: /customer\.name|name must be shorter/i,
    message: 'İsim alanı çok uzun (40 karakter sınırı) — otomatik kısaltılarak tekrar denenecek' },
  { test: /429|rate.?limit/i,
    message: 'Çok fazla eşzamanlı arama isteği — kısa süre sonra otomatik devam edecek' },
  { test: /assistant.*not.*found|phone.*number.*not.*found|invalid.*assistant/i,
    message: 'Vapi asistanı veya telefon numarası hesap ayarlarında bulunamadı — Ayarlarım sayfasını kontrol edin' },
];

function shorten(raw: string, max = 160): string {
  const trimmed = raw.trim();
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed;
}

// endedReason (webhook'tan gelen ham kod) → Türkçe sebep.
export function translateEndedReason(reason?: string | null): string {
  if (!reason) return 'Bilinmeyen bir hata oluştu';
  for (const { test, message } of KNOWN_PATTERNS) {
    if (test.test(reason)) return message;
  }
  return 'Teknik hata: ' + shorten(reason);
}

// Herhangi bir sunucu hatasını istemciye göstermeye UYGUN bir mesaja indirger.
// Gerekçe: rotalar uzun süre `String(err)` döndürüyordu — bu, Postgres hata
// metinlerini (tablo/kolon adları, kısıt isimleri), dosya yollarını ve üçüncü
// parti API'lerin ham İngilizce yanıtlarını doğrudan danışmanın ekranına taşıyor;
// hem anlaşılmaz hem de altyapı detayı sızdırıyor. Zaten Türkçe yazılmış, bilinçli
// olarak fırlatılmış "kullanıcıya söylenecek" mesajlar olduğu gibi geçer; geri
// kalan her şey tek bir genel cümleye indirgenir (ayrıntı sunucu loglarında kalır).
// Altyapı/DB/ağ kaynaklı, danışmana gösterilmemesi gereken sinyaller. Bunlardan
// biri geçerse mesaj tamamen gizlenir. Aksi halde mesaj bizim kendi kodumuzun
// bilinçli fırlattığı kullanıcı metnidir ("Kampanya bulunamadı", "Ses seçilmedi"
// gibi Türkçe karakter içermeyenler dahil) ve olduğu gibi gösterilir.
const INTERNAL_ERROR_PATTERN = /(\brelation\b|\bcolumn\b|\bconstraint\b|syntax error|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EAI_AGAIN|self.signed|certificate|password authentication|duplicate key|null value in|violates|\bpg_|postgres|node_modules|\bat \w+ \(|\.ts:\d+|\.js:\d+)/i;

export function toClientError(err: unknown, fallback = 'İşlem tamamlanamadı — lütfen tekrar deneyin.'): string {
  const raw = String((err as Error)?.message ?? err ?? '').trim();
  if (!raw) return fallback;
  if (INTERNAL_ERROR_PATTERN.test(raw)) return fallback;
  return shorten(raw, 200);
}

// createVapiCall() içinde throw edilen hata metni (Error.message) → Türkçe sebep.
// "Vapi hesap bilgileriniz tanımlı değil..." gibi zaten Türkçe/anlaşılır olan
// mesajları OLDUĞU GİBİ geçirir — sadece ham İngilizce/kod-benzeri metinleri çevirir.
export function translateDialError(err: unknown): string {
  const raw = String((err as Error)?.message ?? err ?? '');
  if (!raw) return 'Bilinmeyen bir hata oluştu';

  // "Vapi hesap bilgileriniz tanımlı değil — ..." zaten danışman-dostu, olduğu gibi geç.
  if (!/^Vapi API hatası/i.test(raw)) return shorten(raw, 200);

  for (const { test, message } of KNOWN_PATTERNS) {
    if (test.test(raw)) return message;
  }
  return 'Arama başlatılamadı: ' + shorten(raw.replace(/^Vapi API hatası:\s*/i, ''));
}
