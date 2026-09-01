import pool from './db';
import { Scenario } from './types';

// Her yeni danışman hesabında otomatik oluşturulan varsayılan senaryo — {{agentName}}
// ve {{companyName}} Vapi'nin variableValues mekanizmasıyla ({{customerName}} ile
// aynı yöntem, bkz. vapi.ts createVapiCall) her arama anında o danışmanın kendi
// adı/şirket-takım adıyla doldurulur, script metnini elle düzenlemeye gerek kalmaz.
export const DEFAULT_SCENARIO_NAME = 'Genel Tanıtım (Varsayılan)';
export const DEFAULT_SCENARIO_TEMPLATE = `[Identity]
Adın {{agentName}}. {{companyName}} adına arayan,
güven veren, sakin, açık ve bilgi odaklı bir asistansın.
Satış ya da baskı amacı taşımazsın.

[Style]
- Yalnızca Türkçe konuş
- Doğal, sakin, akıcı ve samimi konuş
- Kısa, sade ve net cümleler (en fazla 10–12 kelime)
- Resmi ama sıcak bir ton
- Dolgu kelimeler, gereksiz tekrar ve açıklamalardan kaçın

[Response Guidelines]
- Sorulanı kısa ve net yanıtla
- Sayıları kelimeyle söyle
- Kapanış cümlesi söylendikten sonra DERHAL aramayı bitir
- Karşı taraf kapanış söylese bile tekrar kapanış cümlesi KURMA
- Kapanış döngüsüne girme, bir kez söyle ve kes
- Toplam görüşme iki dakikayı geçmesin
- Beş saniye sessizlikte kapat

[Task & Goals]

1. AÇILIŞ:
"Merhaba {{customerName}}, {{companyName}} Yapay Zeka Asistanı {{agentName}}.
Sizi gayrimenkul ile ilgili ihtiyaçlarınız için aradık. Şu sıralar satmayı veya kiralamayı planladığınız mülkünüz bulunmakta mıdır?"
<Yanıtı bekle>

2. YANITA GÖRE:
- Evet / Belirsiz → adım 3'e geç
- Hayır → adım 4'e geç
- Telefonu kapatırsa → aramayı bitir, hiçbir şey söyleme

3. RANDEVUYA YÖNLENDİR:
"Uzman danışmanlarımız sizi arayıp
detaylı bilgi verebilir.
Uygun olur mu?"
<Yanıtı bekle>

- Evet derlerse → adım 5'e geç
- Hayır derlerse → adım 4'e geç

4. PLANI YOK / REDDEDER:
"Anlıyorum, iyi günler."
<DERHAL kes, başka hiçbir şey söyleme>

5. RANDEVU ONAYLANIRSA:
"Teşekkürler, danışmanlarımız
en kısa sürede sizi arayacak.
İyi günler."
<DERHAL kes, başka hiçbir şey söyleme>

6. İKİ DAKİKA / SESSİZLİK:
"Teşekkürler, iyi günler."
<DERHAL kes>

[Kapanış Kuralı — KRİTİK]
- Teşekkürler, iyi günler dedikten sonra kesinlikle konuşmayı bitir.
- Kapanış cümlesi bittikten sonra karşı taraf
  ne derse desin CEVAP VERME
- "İyi günler", "görüşürüz", "tamam" gibi
  kapanış sinyallerine karşılık VERME
- Bir kez kapanış söyle, kes, bitir
- Döngüye girme

[Error Handling]
- Anlaşılmayan yanıtta kısa tekrar sor
- Konu dışına çıkarsa "Bilgim dahilinde değil" de ve kapat
- Kapanış cümlesiz aramayı asla bitirme`;

export async function getAllScenarios(userId: string): Promise<Scenario[]> {
  const { rows } = await pool.query(
    `SELECT data FROM scenarios WHERE user_id = $1 ORDER BY data->>'createdAt' ASC`,
    [userId],
  );
  return rows.map(r => r.data as Scenario);
}

export async function getScenario(userId: string, id: string): Promise<Scenario | null> {
  const { rows } = await pool.query(
    'SELECT data FROM scenarios WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return rows[0]?.data ?? null;
}

export async function createScenario(userId: string, name: string, systemPrompt: string): Promise<Scenario> {
  const scenario: Scenario = {
    id:           `sc_${Date.now()}`,
    name:         name.trim(),
    systemPrompt,
    createdAt:    new Date().toISOString(),
  };
  await pool.query(
    'INSERT INTO scenarios (id, data, user_id) VALUES ($1, $2, $3)',
    [scenario.id, JSON.stringify(scenario), userId],
  );
  return scenario;
}

export async function updateScenario(
  userId: string,
  id: string,
  name: string,
  systemPrompt: string,
): Promise<Scenario | null> {
  const { rows } = await pool.query('SELECT data FROM scenarios WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!rows[0]) return null;
  const updated: Scenario = {
    ...rows[0].data,
    name: name.trim(),
    systemPrompt,
    updatedAt: new Date().toISOString(),
  };
  await pool.query(
    'UPDATE scenarios SET data = $1 WHERE id = $2 AND user_id = $3',
    [JSON.stringify(updated), id, userId],
  );
  return updated;
}

export async function deleteScenario(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM scenarios WHERE id = $1 AND user_id = $2', [id, userId]);
  return (rowCount ?? 0) > 0;
}

// Yeni danışman hesabı oluşturulduğunda çağrılır — boş bir "Senaryolar" ekranıyla
// başlamak yerine hemen kullanılabilir bir varsayılan script sağlar.
export async function seedDefaultScenario(userId: string): Promise<Scenario> {
  return createScenario(userId, DEFAULT_SCENARIO_NAME, DEFAULT_SCENARIO_TEMPLATE);
}
