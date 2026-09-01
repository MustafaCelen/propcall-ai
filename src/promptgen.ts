// Vapi assistant sistem promptu üretimi — Anthropic Claude ile.
// Vapi'nin kendi "Generate with AI" özelliği public API'de yok (doğrulandı,
// OpenAPI spec'te böyle bir endpoint mevcut değil), bu yüzden aynı işlevi
// kendi Anthropic entegrasyonumuzla, üretimde kanıtlanmış prompt yapısına
// (Identity/Style/Response Guidelines/Task & Goals/Error Handling) uyarak sağlıyoruz.

import Anthropic from '@anthropic-ai/sdk';

export interface PromptGenInput {
  companyName?: string;         // örn. "Keller Williams Gayrimenkul" — rawText modunda zorunlu değil
  callGoal?: string;            // örn. "Geçmişte ilgi göstermiş kişileri işe alım görüşmesine davet etmek"
  offerDetails?: string;        // örn. "Ücretsiz gayrimenkul değerleme" / "Kariyer fırsatı"
  tone?: string;                // örn. "Sıcak ama profesyonel, baskıcı değil"
  contactPersonName?: string;   // detaylar için yönlendirilecek kişi, varsa
  maxDurationSeconds?: number;  // örn. 120
  additionalNotes?: string;     // serbest metin, ekstra kurallar
  // Doldurulursa, alan-alan girdiler yerine kullanıcının kendi taslağı/örnek
  // scripti/konuşma akışı kaynak alınır — yapıya (bkz. sistem promptu) oturtulur,
  // içerik/ton/açılış cümlesi olabildiğince korunur.
  rawText?: string;
}

export async function generateVapiPrompt(apiKey: string, input: PromptGenInput): Promise<string> {
  if (!apiKey) throw new Error('Anthropic API key tanımlanmamış (Ayarlarım sayfasından ekleyin)');
  const client = new Anthropic({ apiKey });
  const maxDuration = input.maxDurationSeconds || 120;

  const userMessage = input.rawText?.trim()
    ? `Kullanıcının elinde hazır bir taslak/script/örnek konuşma akışı var — aşağıda. Bunu KAYNAK
alarak, yukarıdaki YAPIYA (Identity/Style/Response Guidelines/Task & Goals/Error Handling,
dallanma, "Sonuç:" etiketleri) uygun, düzenli bir Vapi sistem promptu oluştur.

Kullanıcının verdiği açılış cümlesini, tonu, akış mantığını ve somut detayları OLABİLDİĞİNCE
KORU — sadece eksik kısımları (dallanma senaryoları, hata yönetimi, kapanış kuralları vb.)
tamamla ve doğru yapıya oturt. Kullanıcının yazmadığı bir şeyi UYDURMA; eksikse makul bir
varsayılan ekle ama taslağın özünü değiştirme.
${input.additionalNotes ? `\nEk notlar/kurallar: ${input.additionalNotes}` : ''}

Kullanıcının taslağı / scripti:
"""
${input.rawText.trim()}
"""`
    : `Aşağıdaki bilgilere göre bir Vapi sistem promptu oluştur:

Şirket/Marka: ${input.companyName}
Aramanın amacı: ${input.callGoal}
${input.offerDetails ? `Teklif edilen şey: ${input.offerDetails}` : ''}
${input.tone ? `Konuşma tonu: ${input.tone}` : 'Konuşma tonu: Sıcak, güven verici, baskıcı olmayan'}
${input.contactPersonName ? `Detaylar için yönlendirilecek kişi: ${input.contactPersonName}` : ''}
Maksimum görüşme süresi: ${maxDuration} saniye
${input.additionalNotes ? `Ek notlar/kurallar: ${input.additionalNotes}` : ''}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1500,
    system: `Sen Vapi (sesli yapay zeka asistan platformu) için Türkçe soğuk arama sistem promptu yazan bir uzmansın.

Ürettiğin prompt SADECE şu bölümleri, bu sırayla içerir — başka bölüm ekleme:

[Identity]
[Style]
[Response Guidelines]
[Task & Goals]
[Error Handling / Fallback]

KURALLAR:
- Sadece Türkçe konuşma talimatı ver
- [Style] bölümünde: cümlelerin kısa olmasını iste (on-on iki kelimeyi geçmesin), doğal/akıcı/samimi ama
  resmi ol, dolgu kelime ve gereksiz tekrardan kaçınmayı belirt
- [Response Guidelines] bölümünde: sayıları kelimeyle ifade etmeyi, taahhüt/fiyat/komisyon gibi
  konularda söz vermemeyi (varsa yönlendirilecek kişiye yönlendirmeyi), kapanış cümlesinden sonra
  DERHAL konuşmayı bitirmeyi ve ikinci bir kapanış cümlesi asla üretmemeyi, toplam görüşme süresi ve
  sessizlik zaman aşımı kurallarını yaz
- [Identity] bölümünde asistanın kendi adını sabit yazma — "Adın {{agentName}}." şeklinde değişken kullan;
  şirket/marka adı geçen her yerde de literal isim yerine {{companyName}} değişkenini kullan (bu ikisi
  arama anında o danışmanın kendi adı/şirket-takım adıyla otomatik doldurulur)
- [Task & Goals] bölümünde NUMARALI adımlar yaz:
  1) Açılış mesajı (tam metin, {{customerName}}, {{agentName}}, {{companyName}} değişkenlerini kullan) + "< Kullanıcı yanıtını bekle >"
  2) Kullanıcı yanıtına göre EN AZ 3 dallanan akış: olumlu / olumsuz / kararsız-bilgi isteyen
     Her dal: söylenecek tam cümle + "< Anında konuşmayı sonlandır >" veya "< Yanıtı bekle >" gibi
     yönerge + "Sonuç: \\"kısa durum kodu\\"" (örn. "İlgileniyor", "Şu anda ilgilenmiyor")
  3) Süre/sessizlik aşımı durumunda söylenecek kapanış cümlesi
- [Error Handling / Fallback] bölümünde şu durumları ele al: yanıt anlaşılmadı, yanlış kişi,
  aranmak istemiyor, konu dışına çıktı — her biri için kısa cevap + "Sonuç:" etiketi
- Maksimum görüşme süresi olarak verilen saniyeyi kullan, sessizlik zaman aşımını 5 saniye olarak belirt
- SADECE prompt metnini döndür — açıklama, giriş cümlesi, markdown code fence (\`\`\`) EKLEME`,
    messages: [{ role: 'user', content: userMessage }],
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Beklenmeyen yanıt tipi');
  return content.text.trim();
}
