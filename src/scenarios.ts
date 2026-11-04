import pool from './db';
import { Scenario, ScenarioVoiceModel, OpeningVariant } from './types';

// Her yeni danışman hesabında otomatik oluşturulan varsayılan senaryo. İsimsiz yazılır:
// müşteri ve asistan adı yalnızca senaryoda "Müşteri adını söyle / Asistan adını söyle"
// açıksa kullanılır (bkz. src/opening.ts applyNameRules) — o durumda {{customerName}}
// / {{agentName}} değişkenleri Vapi variableValues ile arama anında doldurulur.
// Şirket adı ("Keller Williams Platin Karma") kasıtlı olarak SABİT metin — bir
// değişken değil, çünkü bu varsayılan senaryo doğrudan bu şirketin danışmanları için.
// NOT: "&" işareti YAZILMAZ — ElevenLabs (özellikle v4) bunu "and" diye okuyor
// ("Platinand Carma"); konuşma metninde "Platin Karma" kullanılır.
// --- eski açıklama: bir
// değişken değil, çünkü bu varsayılan senaryo doğrudan bu şirketin danışmanları için.
export const DEFAULT_SCENARIO_NAME = 'Standart Satılık Kiralık Var mı Sorgusu';
export const DEFAULT_SCENARIO_TEMPLATE = `[Identity]
Keller Williams Platin Karma emlak ofisinin yapay zeka asistanısın —
güven veren, sakin, açık ve bilgi odaklı bir asistansın.
Satış ya da baskı amacı taşımazsın. Yapay zeka olduğunu sorulursa açıkça söylersin.

[Style]
- Yalnızca Türkçe konuş
- Doğal, sakin, akıcı ve samimi konuş
- Kısa, sade ve net cümleler (en fazla 10–12 kelime)
- Resmi ama sıcak bir ton
- Dolgu kelimeler, gereksiz tekrar ve açıklamalardan kaçın

[Response Guidelines]
- Sorulanı kısa ve net yanıtla
- Sayıları kelimeyle söyle
- Toplam görüşme iki dakikayı geçmesin
- Beş saniye sessizlikte kapat

[Adım Sırası — KRİTİK, ATLAMA YASAK]
- [Task & Goals] altındaki adımları SIRAYLA izle. Müşterinin ilk tepkisi kısa, belirsiz
  veya sessiz olsa bile bunu "reddetti" sayıp DOĞRUDAN kapanışa ATLAMA —
  adım 2 ve 4'teki ilgili dalı izle.
- Kapanış (adım 6, 7, 8 veya 9) SADECE o adımda açıkça tarif edilen durum gerçekleştiğinde
  ve orada verilen TAM cümleyle yapılır. Rastgele bir anda kendi kararınla erken kapanış
  üretme — bu YASAK.
- Kapanış cümlesi söylendikten SONRA (asla öncesinde değil) DERHAL aramayı bitir; karşı
  taraf ne derse desin tekrar kapanış cümlesi KURMA, döngüye girme.

[Task & Goals]

1. AÇILIŞ (müşteri "Alo", "Efendim", "Buyrun" dedikten SONRA):
"Merhaba, Keller Williams Platin Karma emlak ofisinden arıyorum. Müsait misiniz?"
<Yanıtı bekle>

2. MÜSAİTLİK:
- Evet / Olur / Buyrun / Dinliyorum → adım 3'e geç
- Hayır / Meşgulüm / Toplantıdayım / Sonra arayın → adım 7'ye geç
- "Kimsiniz?", "Ne için aradınız?" → "Platin Karma'nın yapay zeka asistanıyım, kısa bir sorum olacak. Müsait misiniz?" de, yanıtı bekle, bu adımı tekrar uygula
- Belirsiz / kısa / sessiz → "Kısa bir sorum olacak, bir dakikanızı alabilir miyim?" de, yanıtı bekle
- Telefonu kapatırsa → aramayı bitir, hiçbir şey söyleme

3. ANA SORU:
"Teşekkürler. Şu sıralar satmayı veya kiralamayı düşündüğünüz bir mülkünüz var mı?"
<Yanıtı bekle>

4. YANITA GÖRE:
- Evet / Belirsiz / Düşünüyorum → adım 5'e geç
- Hayır → adım 6'ya geç
- Telefonu kapatırsa → aramayı bitir, hiçbir şey söyleme

5. RANDEVUYA YÖNLENDİR:
"Uzman danışmanlarımız sizi arayıp detaylı bilgi verebilir. Uygun olur mu?"
<Yanıtı bekle>
- Evet derlerse → adım 8'e geç
- Hayır derlerse → adım 6'ya geç

6. PLANI YOK / REDDEDER:
"Anlıyorum, iyi günler."
<DERHAL kes, başka hiçbir şey söyleme>

7. MÜSAİT DEĞİL:
"Anlıyorum, sizi daha uygun bir zamanda arayalım. İyi günler."
<DERHAL kes, başka hiçbir şey söyleme>

8. RANDEVU ONAYLANIRSA:
"Teşekkürler, danışmanlarımız en kısa sürede sizi arayacak. İyi günler."
<DERHAL kes, başka hiçbir şey söyleme>

9. İKİ DAKİKA / SESSİZLİK:
"Teşekkürler, iyi günler."
<DERHAL kes>

[Error Handling]
- Anlaşılmayan yanıtta kısa tekrar sor, ADIM ATLAMA
- Konu dışına çıkarsa "Bilgim dahilinde değil" de ve kaldığın adıma geri dön
- Kapanış cümlesiz aramayı asla bitirme
- Emin olmadığın her durumda erken kapanış yerine o adımın "Belirsiz" dalını izle

[Son Hatırlatma — ATLAMA YASAK]
Kapanışa (adım 6/7/8/9) geçmeden önce adım 1'in açılışını ve müsaitse adım 3'ün
sorusunu MUTLAKA sormuş olmalısın. Kısa/belirsiz bir ilk yanıt erken kapanış
için gerekçe DEĞİLDİR.`;

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

export async function createScenario(
  userId: string, name: string, systemPrompt: string, voiceModel?: ScenarioVoiceModel,
  openingVariants?: OpeningVariant[],
  nameFlags?: { useCustomerName: boolean; useAgentName: boolean },
): Promise<Scenario> {
  const scenario: Scenario = {
    id:           `sc_${Date.now()}`,
    name:         name.trim(),
    systemPrompt,
    ...(voiceModel ? { voiceModel } : {}),
    ...(openingVariants?.length ? { openingVariants } : {}),
    ...(nameFlags?.useCustomerName ? { useCustomerName: true } : {}),
    ...(nameFlags?.useAgentName ? { useAgentName: true } : {}),
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
  voiceModel?: ScenarioVoiceModel | null,
  openingVariants?: OpeningVariant[],
  nameFlags?: { useCustomerName: boolean; useAgentName: boolean },
  waitForGreeting?: boolean,
): Promise<Scenario | null> {
  const { rows } = await pool.query('SELECT data FROM scenarios WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!rows[0]) return null;
  const updated: Scenario = {
    ...rows[0].data,
    name: name.trim(),
    systemPrompt,
    updatedAt: new Date().toISOString(),
  };
  // undefined = alana dokunma (eski istemciler); null = asistan varsayılanına dön.
  if (voiceModel !== undefined) {
    if (voiceModel) updated.voiceModel = voiceModel; else delete updated.voiceModel;
  }
  // undefined = dokunma; boş liste = varyantları kaldır.
  if (openingVariants !== undefined) {
    if (openingVariants.length) updated.openingVariants = openingVariants; else delete updated.openingVariants;
  }
  // Kapalı bayrak kayıtta tutulmaz (undefined = kapalı) — JSON sade kalsın.
  if (nameFlags !== undefined) {
    if (nameFlags.useCustomerName) updated.useCustomerName = true; else delete updated.useCustomerName;
    if (nameFlags.useAgentName) updated.useAgentName = true; else delete updated.useAgentName;
  }
  if (waitForGreeting !== undefined) {
    if (waitForGreeting) updated.waitForGreeting = true; else delete updated.waitForGreeting;
  }
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
  // Varsayılan şablonun açılışı "müşteri Alo dedikten SONRA" kurgulu — Vapi tarafında
  // da önce müşteriyi bekle (bkz. opening.ts resolveWaitForGreeting).
  const s = await createScenario(userId, DEFAULT_SCENARIO_NAME, DEFAULT_SCENARIO_TEMPLATE);
  return (await updateScenario(userId, s.id, s.name, s.systemPrompt, undefined, undefined, undefined, true)) || s;
}
