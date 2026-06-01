// PropCall AI - Anthropic Claude ile görüşme özeti üretimi

import Anthropic from '@anthropic-ai/sdk';
import { CustomerInfo, CallSummary } from './types';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Görüşme transcript'inden araştırma odaklı özet üret
export async function generateCallSummary(
  customer: CustomerInfo,
  history: Array<{ role: 'assistant' | 'user'; content: string }>
): Promise<CallSummary> {
  const conversationText = history
    .map((m) => `${m.role === 'assistant' ? 'Asistan' : 'Müşteri'}: ${m.content}`)
    .join('\n\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    system: `Sen bir gayrimenkul CRM sistemi için görüşme analisti asistanısın.
Sana verilen telefon görüşmesi transcript'ini analiz edecek ve SADECE geçerli JSON döndüreceksin, başka hiçbir şey yazmayacaksın.`,
    messages: [
      {
        role: 'user',
        content: `Aşağıdaki soğuk arama görüşmesini analiz et.
Asistan, müşterinin gayrimenkul niyetini keşfetmeye çalışmıştır (satış yapmamış, bilgi toplamıştır).

Müşteri: ${customer.name} | Tel: ${customer.phone}${customer.region ? ` | Bölge: ${customer.region}` : ''}

Görüşme:
${conversationText || '(Transcript mevcut değil)'}

SADECE bu JSON formatında döndür:
{
  "sicaklik_skoru": 0-100,
  "niyet": "alım|satım|kiralama|yatırım|yok|belirsiz",
  "mulk_tipi": "konut|arsa|işyeri|belirsiz",
  "bolge": "string veya null",
  "butce": "string veya null",
  "zaman_cercevesi": "acil|3ay|6ay|belirsiz|yok",
  "cevredeki_potansiyel": true|false,
  "randevu_alindi": true|false,
  "ozet": "2-3 cümle emlakçı için özet",
  "tavsiye_edilen_aksiyon": "Ara|Bekleme listesine al|Çevre takibi|Uğraşma",
  "geri_donus_notu": "string veya null"
}

randevu_alindi kriterleri:
- true: Müşteri randevu/görüşme teklifini açıkça kabul etti (ör. "tamam", "evet", "olur", "ayarlayın" veya benzer onay ifadeleri)
- false: Müşteri reddetti, telefonu kapattı, cevap vermedi veya belirsiz kaldı

Sıcaklık skoru kriterleri:
- 80-100: Aktif arıyor, bütçesi ve bölgesi net
- 60-79: İlgili ama henüz karar vermemiş
- 40-59: Belirsiz niyet, takip değer
- 20-39: Şu an değil ama gelecekte olabilir
- 0-19: İlgisiz veya transcript yok

tavsiye_edilen_aksiyon kriterleri:
- "Ara": İlgi var ama randevu alınamadı; tekrar aranmalı
- "Bekleme listesine al": Şu an değil ama gelecekte potansiyel var
- "Çevre takibi": Komşu/yakın muhitte satış potansiyeli olduğunu belirtti
- "Uğraşma": Hiç ilgi yok, devam etmeye değmez

geri_donus_notu kriterleri:
- Ara/Bekleme/Çevre için ZORUNLU: 1 cümle, somut ve kişiye özel not.
  Örnekler: "3 ay içinde daire satmayı planlıyor, Ocak'ta tekrar ara"
            "Meşguldü, akşam saatlerini tercih ediyor — yarın 18:00 sonrası dene"
            "Komşusu da satmak istiyor, komşunun numarasını istedi"
- Uğraşma veya randevu alındı için null döndür`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Beklenmeyen yanıt tipi');

  const jsonText = content.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(jsonText) as CallSummary;
}
