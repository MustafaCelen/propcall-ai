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
  "ozet": "2-3 cümle emlakçı için özet",
  "tavsiye_edilen_aksiyon": "Ara|Bekleme listesine al|Çevre takibi|Uğraşma"
}

Sıcaklık skoru kriterleri:
- 80-100: Aktif arıyor, bütçesi ve bölgesi net
- 60-79: İlgili ama henüz karar vermemiş
- 40-59: Belirsiz niyet, takip değer
- 20-39: Şu an değil ama gelecekte olabilir
- 0-19: İlgisiz veya transcript yok`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Beklenmeyen yanıt tipi');

  const jsonText = content.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(jsonText) as CallSummary;
}
