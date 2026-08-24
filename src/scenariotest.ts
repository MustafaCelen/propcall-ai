// Senaryo test önizlemesi — gerçek Vapi araması yapmadan (para harcamadan), bir
// sistem promptunun pratikte nasıl bir konuşmaya yol açacağını görmek için.
// Claude hem asistanı hem olası müşteri tepkilerini simüle eder.

import Anthropic from '@anthropic-ai/sdk';

export interface SimulatedTurn {
  role: 'assistant' | 'user';
  text: string;
}

export interface SimulatedScenario {
  label: string;
  transcript: SimulatedTurn[];
}

export async function simulateScenario(
  apiKey: string,
  systemPrompt: string,
  customerName?: string,
): Promise<SimulatedScenario[]> {
  if (!apiKey) throw new Error('Anthropic API key tanımlanmamış (Ayarlarım sayfasından ekleyin)');
  const client = new Anthropic({ apiKey });
  const name = customerName?.trim() || 'Ayşe Yılmaz';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2200,
    system: `Sen bir telefon görüşmesi simülatörüsün. Sana bir Vapi sesli asistan sistem promptu verilecek.
Bu promptun talimatlarına göre asistanın GERÇEKTE nasıl konuşacağını simüle edeceksin — üç farklı
müşteri tepkisi için ayrı ayrı örnek diyalog üreteceksin: "Olumlu" (müşteri teklifi kabul eder),
"Olumsuz" (müşteri kibarca reddeder), "Kararsız" (müşteri bilgi ister veya net bir yanıt vermez).

KURALLAR:
- Asistan repliklerini TAM OLARAK promptun talimat ettiği ton, uzunluk ve akışla yaz
  (açılış cümlesi promptta varsa birebir kullan, kısa cümle kuralına uy)
- {{customerName}} gibi değişken varsa verilen müşteri adıyla değiştir
- Müşteri repliklerini gerçekçi, doğal Türkçe günlük konuşma diliyle yaz — kısa, samimi
- Her diyalog 4-8 replik (2 dakikalık gerçek bir aramayı temsil etsin)
- Promptta kapanış kuralı varsa (örn. "kapanış cümlesinden sonra konuşma bitsin") ona uy
- SADECE şu JSON formatında döndür, başka HİÇBİR ŞEY yazma, markdown code fence kullanma:
{"scenarios":[
  {"label":"Olumlu","transcript":[{"role":"assistant","text":"..."},{"role":"user","text":"..."}]},
  {"label":"Olumsuz","transcript":[...]},
  {"label":"Kararsız","transcript":[...]}
]}`,
    messages: [{
      role: 'user',
      content: `Müşteri adı: ${name}\n\nAsistan sistem promptu:\n${systemPrompt}`,
    }],
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Beklenmeyen yanıt tipi');

  const jsonText = content.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const parsed = JSON.parse(jsonText) as { scenarios: SimulatedScenario[] };
  if (!Array.isArray(parsed.scenarios) || !parsed.scenarios.length) {
    throw new Error('Simülasyon boş döndü');
  }
  return parsed.scenarios;
}
