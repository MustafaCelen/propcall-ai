// PropCall AI - Anthropic Claude ile görüşme özeti üretimi

import Anthropic from '@anthropic-ai/sdk';
import { CustomerInfo, CallSummary } from './types';
import { getSetting } from './settings';

// Client her çağrıda taze key ile yaratılır — admin panelden key değişse bile
// restart gerekmeden bir sonraki özet yeni key'i kullanır.
async function getClient(): Promise<Anthropic> {
  const apiKey = await getSetting('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY tanımlanmamış (Admin panelden veya .env ile ekleyin)');
  return new Anthropic({ apiKey });
}

export async function generateCallSummary(
  customer: CustomerInfo,
  history: Array<{ role: 'assistant' | 'user'; content: string }>,
  scenarioPrompt?: string | null,
): Promise<CallSummary> {
  const client = await getClient();
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
    model: 'claude-sonnet-4-5',
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

Müşteri: ${customer.name} | Tel: ${customer.phone}${customer.region ? ` | Bölge: ${customer.region}` : ''}

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
- "yüksek": Teklifi kabul etti VEYA aktif soru sordu, detay istedi
- "orta": İlgiliydi ama şu an müsait değil / daha sonra diyebilir
- "düşük": Kibarca reddetti, yoğun/ilgisiz ama baskı yapmadı
- "yok": Hiç yanıt vermedi, hemen kapattı, agresif reddetti

ret_nedeni:
- Reddetmediyse null
- Reddetmişse, MÜŞTERİNİN GERÇEKTEN SÖYLEDİĞİ nedeni kısa ve somut yaz. Sabit bir kategori
  listesine bağlı kalma — transkriptten ve BAĞLAM'daki arama amacından çıkar
  (örn. "şu an meşgul", "ilgilenmiyor", "başkasıyla çalışıyor", "zamanı yok",
  "rahatsız oldu", "uygun pozisyon değil" vb. — konuya göre değişir)

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
  return JSON.parse(jsonText) as CallSummary;
}
