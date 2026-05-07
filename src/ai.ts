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
        content: `Aşağıdaki telefon görüşmesini analiz et.
Asistan, Keller Williams Quantum Team adına ücretsiz gayrimenkul değerleme (Gayrimenkul Röntgeni) randevusu almaya çalışmıştır.

Müşteri: ${customer.name} | Tel: ${customer.phone}${customer.region ? ` | Bölge: ${customer.region}` : ''}

Görüşme:
${conversationText || '(Transcript mevcut değil)'}

SADECE bu JSON formatında döndür:
{
  "randevu_alindi": true|false,
  "ret_nedeni": "string veya null (reddettiyse kısa sebep)",
  "ilgi_seviyesi": "yüksek|orta|düşük|yok",
  "mulk_tipi": "string veya null (konut/arsa/daire vb. bahsettiyse)",
  "ozet": "1-2 cümle özet"
}

randevu_alindi: Müşteri randevuyu kabul ettiyse true, reddettiyse veya ulaşılamadıysa false.
ilgi_seviyesi: Genel olarak hizmete ilgi gösterdi mi?`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Beklenmeyen yanıt tipi');

  const jsonText = content.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(jsonText) as CallSummary;
}
