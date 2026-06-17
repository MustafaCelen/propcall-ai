// PropCall AI - Anthropic Claude ile görüşme özeti üretimi

import Anthropic from '@anthropic-ai/sdk';
import { CustomerInfo, CallSummary } from './types';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function generateCallSummary(
  customer: CustomerInfo,
  history: Array<{ role: 'assistant' | 'user'; content: string }>
): Promise<CallSummary> {
  const conversationText = history
    .map((m) => `${m.role === 'assistant' ? 'Asistan' : 'Müşteri'}: ${m.content}`)
    .join('\n\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    system: `Sen bir gayrimenkul CRM sistemi için görüşme analisti asistanısın.
Sana verilen telefon görüşmesi transcript'ini analiz edecek ve SADECE geçerli JSON döndüreceksin, başka hiçbir şey yazmayacaksın.`,
    messages: [
      {
        role: 'user',
        content: `Aşağıdaki telefon görüşmesini analiz et.

BAĞLAM: Keller Williams Quantum Team adına yapay zeka asistan soğuk arama yaptı.
Amacı: Mülk sahibine ücretsiz "Gayrimenkul Röntgeni" (değerleme) randevusu teklif etmek.
Asistan; niyet, bölge, bütçe veya zaman dilimi SORMADI — sadece randevu teklif etti.
Bu nedenle yalnızca görüşmeden gerçekten çıkarılabilen bilgileri yaz.

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
- true: Müşteri randevuyu açıkça kabul etti ("tamam", "evet", "olur", "ayarlayın" vb.)
- false: Reddetti, yanıt vermedi veya belirsiz kaldı

ilgi_seviyesi:
- "yüksek": Randevu aldı VEYA aktif soru sordu, detay istedi
- "orta": İlgiliydi ama şu an müsait değil / daha sonra diyebilir
- "düşük": Kibarca reddetti, yoğun/ilgisiz ama baskı yapmadı
- "yok": Hiç yanıt vermedi, hemen kapattı, agresif reddetti

ret_nedeni:
- Reddetmediyse null
- Reddetmişse kısa ve somut: "meşgul şu an", "satmıyorum zaten", "başka ajansla çalışıyorum",
  "ilgilenmiyorum", "zamanım yok", "aradığım için rahatsız oldu" vb.

mulk_tipi:
- Müşteri yalnızca kendisi bahsetmişse yaz (konut, daire, villa, arsa, dükkan vb.)
- Bahsetmediyse null — UYDURMA

ozet:
- Görüşmenin sonucunu 1-2 cümleyle özetle; ne oldu, ne söylendi

tavsiye_edilen_aksiyon:
- "Ara": İlgi vardı ama randevu alınamadı; tekrar aranmalı
- "Bekleme listesine al": Şu an değil ama ileride potansiyel var
- "Uğraşma": Hiç ilgi yok, bağlantı kurulamadı veya agresif reddetti

geri_donus_notu:
- Ara veya Bekleme için ZORUNLU: 1 cümle, somut ve kişiye özel.
  "Toplantıdaydı, akşam saatini tercih ediyor — yarın 18:00 sonrası dene"
  "Kiracıya bağlı, 6 ay içinde satışı düşünüyor — Mayıs'ta tekrar ara"
- Uğraşma veya randevu alındıysa null`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Beklenmeyen yanıt tipi');

  const jsonText = content.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(jsonText) as CallSummary;
}
