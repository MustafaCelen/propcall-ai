// PropCall AI - Anthropic Claude ile görüşme özeti üretimi

import Anthropic from '@anthropic-ai/sdk';
import { CustomerInfo, CallSummary } from './types';

// claude-haiku-4-5 fiyatlandırması ($/milyon token) — model değişirse burada güncelle.
// Sonnet 4.5'e göre ~%67 daha ucuz ($3/$15 → $1/$5) — görev (transkriptten yapılandırılmış
// JSON çıkarımı: randevu/ilgi/ret nedeni) Haiku için uygun karmaşıklıkta.
const ANTHROPIC_INPUT_PER_MTOK  = 1;
const ANTHROPIC_OUTPUT_PER_MTOK = 5;

export interface CallSummaryResult {
  summary: CallSummary;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

// Claude, prompttaki TUTARLILIK KURALLARI'nı gözden kaçırıp mantıksal olarak imkânsız bir
// kombinasyon üretebilir (örn. randevu_alindi=true AMA ilgi_seviyesi='yok') — bu, danışmanların
// raporlarda gördüğü "randevu yok ama ilgi yüksek" tarzı çelişkilerin kaynağı. LLM'e güvenmek
// yerine burada deterministik olarak düzeltiyoruz (bkz. src/scriptRules.ts lintGeneratedPrompt
// ile aynı desen — üretim + deterministik son kontrol).
//
// ASİMETRİK RİSK — KASITLI: düzeltmeler SADECE "lehe" yönde olur (bir lead'i daha takip
// edilebilir/iyi göstermek), ASLA "aleyhe" yönde (bir lead'i "Uğraşma"ya düşürmek/yaz-bozmak)
// bir düzeltme yapılmaz. Yanlış yönde düzeltmemenin bedeli en fazla boşa bir tekrar arama —
// yanlış yönde düzeltmenin bedeli gerçek bir lead'in kaybı. Bu yüzden örn. ilgi_seviyesi='yok'
// olduğunda tavsiye_edilen_aksiyon'u zorla 'Uğraşma'ya ÇEKMİYORUZ — Claude'un kendi ayrıca
// verdiği tavsiye (varsa) daha fazla bilgi taşıyabilir, onu ezmek riskli.
function enforceSummaryConsistency(summary: CallSummary): CallSummary {
  const fixed = { ...summary };
  if (fixed.randevu_alindi) {
    fixed.ilgi_seviyesi = 'yüksek';
    fixed.ret_nedeni = null;
    if (fixed.tavsiye_edilen_aksiyon === 'Uğraşma') fixed.tavsiye_edilen_aksiyon = 'Ara';
  }
  if (fixed.ret_nedeni) {
    fixed.randevu_alindi = false;
    if (fixed.ilgi_seviyesi === 'yüksek') fixed.ilgi_seviyesi = 'orta';
  }
  return fixed;
}

export async function generateCallSummary(
  apiKey: string,
  customer: CustomerInfo,
  history: Array<{ role: 'assistant' | 'user'; content: string }>,
  scenarioPrompt?: string | null,
): Promise<CallSummaryResult> {
  if (!apiKey) throw new Error('Anthropic API key tanımlanmamış (Ayarlarım sayfasından ekleyin)');
  const client = new Anthropic({ apiKey });
  const conversationText = history
    .map((m) => `${m.role === 'assistant' ? 'Asistan' : 'Müşteri'}: ${m.content}`)
    .join('\n\n');

  // BAĞLAM artık sabit değil — aramada gerçekten kullanılan Vapi asistan sistem
  // promptundan (senaryodan) dinamik olarak çekilir. Böylece analiz kriterleri
  // her zaman gerçek arama amacına göre uyum sağlar (gayrimenkul, işe alım, vb.).
  const contextBlock = scenarioPrompt?.trim()
    ? `BAĞLAM: Bu arama, aşağıdaki asistan sistem promptuna göre yapıldı. Aramanın gerçek amacını,
neyin teklif edildiğini ve beklenen sonucu BU PROMPTTAN çıkar. Aşağıdaki alan kriterlerini
bu bağlama göre yorumla — arama gayrimenkul satışı, işe alım, randevu teklifi, ürün tanıtımı
veya başka bir amaç olabilir; varsayım yapmadan promptu esas al.

--- ASİSTANIN SİSTEM PROMPTU (gerçek script) ---
${scenarioPrompt.trim()}
--- PROMPT SONU ---`
    : `BAĞLAM: Asistanın sistem promptu bulunamadı. Sadece görüşme transkriptinden çıkarım yap,
aramanın amacını transkriptin kendisinden anla, varsayım yapma.`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system: `Sen bir soğuk arama CRM sistemi için görüşme analisti asistanısın.
Sana verilen telefon görüşmesi transkriptini, aramanın amacını tanımlayan asistan sistem
promptunu bağlam olarak kullanarak analiz edeceksin ve SADECE geçerli JSON döndüreceksin,
başka hiçbir şey yazmayacaksın.`,
    messages: [
      {
        role: 'user',
        content: `Aşağıdaki telefon görüşmesini analiz et.

${contextBlock}

Müşteri: ${customer.name} | Tel: ${customer.phone}${customer.region ? ` | Bölge: ${customer.region}` : ''}${customer.reference ? ` | Referans: ${customer.reference}` : ''}

Görüşme:
${conversationText || '(Transcript mevcut değil — arama yanıtsız veya çok kısa kaldı)'}

SADECE bu JSON formatında döndür:
{
  "randevu_alindi": true|false,
  "ilgi_seviyesi": "yüksek|orta|düşük|yok",
  "ret_nedeni": "string veya null",
  "mulk_tipi": "string veya null",
  "ozet": "1-2 cümle",
  "tavsiye_edilen_aksiyon": "Ara|Bekleme listesine al|Uğraşma",
  "geri_donus_notu": "string veya null"
}

ALAN KRİTERLERİ:

randevu_alindi:
- true: Müşteri asistanın teklif ettiği sonraki adımı (randevu, tanışma görüşmesi, toplantı vb.)
  açıkça kabul etti ("tamam", "evet", "olur", "ayarlayın", "olabilir" vb.)
- false: Reddetti, yanıt vermedi veya belirsiz kaldı

ilgi_seviyesi:
- "yüksek": randevu_alindi=true İSE HER ZAMAN "yüksek" — YA DA müşteri aktif soru sordu/detay
  istedi VE görüşme olumsuz bir "hayır, ilgilenmiyorum" ile bitmedi (sadece zaman/uygunluk
  nedeniyle erteledi)
- "orta": İlgiliydi, soru sordu ama sonunda "düşüneyim" dedi veya şu an müsait değil dedi —
  net bir hayır değil ama net bir evet de değil
- "düşük": Kibarca reddetti, yoğun/ilgisiz ama baskı yapmadı
- "yok": Hiç yanıt vermedi, hemen kapattı, agresif reddetti

ret_nedeni:
- randevu_alindi=true İSE HER ZAMAN null (kabul eden birinin "ret nedeni" olamaz)
- Reddetmediyse null
- Reddetmişse, MÜŞTERİNİN GERÇEKTEN SÖYLEDİĞİ nedeni kısa ve somut yaz. Sabit bir kategori
  listesine bağlı kalma — transkriptten ve BAĞLAM'daki arama amacından çıkar
  (örn. "şu an meşgul", "ilgilenmiyor", "başkasıyla çalışıyor", "zamanı yok",
  "rahatsız oldu", "uygun pozisyon değil" vb. — konuya göre değişir)

TUTARLILIK KURALLARI (ihlal etme, alanlar birbiriyle çelişemez):
- randevu_alindi=true ⇒ ilgi_seviyesi="yüksek" VE ret_nedeni=null VE tavsiye_edilen_aksiyon≠"Uğraşma"
- ilgi_seviyesi="yok" ⇒ randevu_alindi=false
- ret_nedeni dolu (null değil) ⇒ randevu_alindi=false
- ŞÜPHEDE KALDIĞINDA tavsiye_edilen_aksiyon'u "Uğraşma" seçme — "Uğraşma" bir lead'i tamamen
  kapatır, geri dönüşü olmaz. Emin değilsen "Bekleme listesine al" seç; en kötü ihtimalle boşa
  bir arama denemesi olur, ama gerçek bir potansiyel kaybedilmez.

mulk_tipi:
- Görüşmede yan bilgi olarak somut bir detay geçtiyse yaz (BAĞLAM'a göre: mülk tipi,
  pozisyon/rol, ürün, bölge vb. olabilir)
- Geçmediyse null — UYDURMA

ozet:
- Görüşmenin sonucunu 1-2 cümleyle özetle; ne oldu, ne söylendi

tavsiye_edilen_aksiyon:
- "Ara": İlgi vardı ama sonuç alınamadı; tekrar aranmalı
- "Bekleme listesine al": Şu an değil ama ileride potansiyel var
- "Uğraşma": Hiç ilgi yok, bağlantı kurulamadı veya agresif reddetti

geri_donus_notu:
- Ara veya Bekleme için ZORUNLU: 1 cümle, somut ve kişiye özel.
  "Toplantıdaydı, akşam saatini tercih ediyor — yarın 18:00 sonrası dene"
  "Şu an başka bir yerde çalışıyor, 3 ay sonra tekrar değerlendirebilir"
- Uğraşma veya olumlu sonuçlandıysa null`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Beklenmeyen yanıt tipi');

  const jsonText = content.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const summary = enforceSummaryConsistency(JSON.parse(jsonText) as CallSummary);

  const inputTokens  = response.usage?.input_tokens  ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const costUsd = Math.round(
    ((inputTokens / 1e6) * ANTHROPIC_INPUT_PER_MTOK + (outputTokens / 1e6) * ANTHROPIC_OUTPUT_PER_MTOK) * 1e6,
  ) / 1e6;

  return { summary, usage: { inputTokens, outputTokens, costUsd } };
}

export interface WhatsappThreadAnalysis {
  is_business_related: boolean;
  randevu_alindi: boolean;
  ilgi_seviyesi: 'yüksek' | 'orta' | 'düşük' | 'yok';
  ozet: string;
}

// Arama özetiyle aynı ilke: bir WhatsApp yazışmasının CRM'e "gerçek fırsat" olarak
// yansıması için danışmanın kendisi değil, bu analiz karar verir (bkz. leads.ts
// upsertLeadFromCallOutcome'daki asimetrik-risk yorumu — burada da SADECE ileri taşır).
export async function analyzeWhatsappThread(
  apiKey: string,
  customerName: string,
  messages: Array<{ direction: 'IN' | 'OUT'; body: string }>,
): Promise<{ analysis: WhatsappThreadAnalysis; usage: { inputTokens: number; outputTokens: number; costUsd: number } }> {
  if (!apiKey) throw new Error('Anthropic API key tanımlanmamış (Ayarlarım sayfasından ekleyin)');
  const client = new Anthropic({ apiKey });
  const threadText = messages
    .map(m => `${m.direction === 'IN' ? 'Müşteri' : 'Danışman'}: ${m.body}`)
    .join('\n');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: `Sen bir emlak danışmanının WhatsApp yazışmalarını analiz eden bir CRM asistanısın.
Sana verilen yazışmayı analiz edeceksin ve SADECE geçerli JSON döndüreceksin, başka hiçbir şey yazmayacaksın.`,
    messages: [
      {
        role: 'user',
        content: `Aşağıdaki WhatsApp yazışmasını analiz et. Müşteri: ${customerName}

Yazışma:
${threadText}

SADECE bu JSON formatında döndür:
{
  "is_business_related": true|false,
  "randevu_alindi": true|false,
  "ilgi_seviyesi": "yüksek|orta|düşük|yok",
  "ozet": "1 cümle"
}

ALAN KRİTERLERİ:

is_business_related — HER ŞEYDEN ÖNCE bunu belirle, diğer alanlar buna bağlı:
- true: Yazışma emlak/mülk/randevu ile ilgili GERÇEK bir müşteri iletişimi — soru, fiyat,
  konum, gezme talebi, ilan hakkında herhangi bir şey
- false: Danışmanın KİŞİSEL hayatına ait bir yazışma — arkadaş/aile/tanıdık sohbeti, iş
  dışı teşekkür/rica/sohbet, eşya/randevu gibi konular emlakla İLGİSİZSE (örn. "minik
  adaptörü sende unuttum", "bugünkü destek için teşekkürler" gibi mesajlar — bunlar
  emlak müşterisi DEĞİL, danışmanın tanıdığı biri). ŞÜPHEDE KALDIĞINDA (konu net değilse
  ama en ufak bir emlak/mülk/randevu ipucu varsa) true seç — burada asimetri TERSİNE
  döner: false'u yanlış seçmenin bedeli gerçek bir müşterinin CRM'e hiç girmemesi, true'yu
  yanlış seçmenin bedeli sadece boşa bir "orta/yüksek ilgi" etiketi.
- is_business_related=false İSE randevu_alindi HER ZAMAN false, ilgi_seviyesi HER ZAMAN
  "yok" olmalı — konu ne kadar sıcak/samimi olursa olsun, iş dışıysa CRM'e yansımamalı.

randevu_alindi:
- true: Müşteri bir görüşme/randevu/mülk gezme teklifini AÇIKÇA kabul etti
- false: Henüz kabul yok, sadece soru soruyor, ya da hiç yanıt yok

ilgi_seviyesi:
- "yüksek": randevu_alindi=true İSE HER ZAMAN "yüksek" — YA DA müşteri aktif soru soruyor,
  detay istiyor, fiyat/konum/randevu ile ilgileniyor
- "orta": Kısa/nötr yanıtlar veriyor ama konuşmayı tamamen kapatmadı, "düşüneyim" gibi
- "düşük": Kısa, ilgisiz görünen tek kelimelik yanıtlar ("ok", "tamam") — net red değil
- "yok": Hiç yanıt yok (sadece danışmandan giden mesaj var), net bir "ilgilenmiyorum"/"yanlış
  numara" cevabı, yazışma çok kısa/anlamsız (tek bir "Merhaba" gibi) ve karar verecek içerik
  yok, YA DA is_business_related=false

ozet: Yazışmanın şu anki durumunu 1 cümleyle özetle.`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Beklenmeyen yanıt tipi');

  const jsonText = content.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const analysis = JSON.parse(jsonText) as WhatsappThreadAnalysis;
  // Modele güvenmek yerine deterministik olarak zorla (enforceSummaryConsistency ile aynı
  // ilke) — is_business_related=false ise ne kadar "sıcak" bir yazışma olursa olsun CRM'e
  // asla yansımamalı, model bunu unutup ilgi_seviyesi'ni yanlış doldursa bile.
  if (!analysis.is_business_related) {
    analysis.randevu_alindi = false;
    analysis.ilgi_seviyesi = 'yok';
  } else if (analysis.randevu_alindi) {
    analysis.ilgi_seviyesi = 'yüksek';
  }

  const inputTokens  = response.usage?.input_tokens  ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const costUsd = Math.round(
    ((inputTokens / 1e6) * ANTHROPIC_INPUT_PER_MTOK + (outputTokens / 1e6) * ANTHROPIC_OUTPUT_PER_MTOK) * 1e6,
  ) / 1e6;

  return { analysis, usage: { inputTokens, outputTokens, costUsd } };
}
