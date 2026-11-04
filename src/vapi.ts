// PropCall AI - Vapi API entegrasyonu — her danışman kendi Vapi hesabıyla çalışır,
// bu yüzden her fonksiyon kimlik bilgilerini (apiKey/assistantId) açıkça parametre alır.

import { CustomerInfo, ScenarioVoiceModel } from './types';
import { ResolvedVapiCredentials } from './users';
import { DEFAULT_SCENARIO_TEMPLATE } from './scenarios';

const VAPI_BASE_URL = 'https://api.vapi.ai';

function getHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

export interface VapiCallResponse {
  id: string;
  status: string;
  phoneNumberId: string;
  assistantId: string;
  customer: { number: string; name?: string };
  createdAt: string;
}

// Assistant'ın model config'i (provider + model adı) kısa süreliğine önbelleğe alınır —
// Vapi, assistantOverrides.model'de messages göndermek için provider/model alanlarının da
// dolu olmasını zorunlu tutuyor; bunları her aramada asistandan taze çekmek yerine cache'liyoruz.
// assistantId ile keylenir — farklı danışmanların farklı asistanları birbirine karışmaz.
const modelConfigCache = new Map<string, { provider: string; model: string; cachedAt: number }>();
const MODEL_CONFIG_TTL_MS = 5 * 60 * 1000;

async function getAssistantModelConfig(apiKey: string, assistantId: string): Promise<{ provider: string; model: string }> {
  const cached = modelConfigCache.get(assistantId);
  if (cached && Date.now() - cached.cachedAt < MODEL_CONFIG_TTL_MS) return cached;

  const resp = await fetch(`${VAPI_BASE_URL}/assistant/${assistantId}`, { headers: getHeaders(apiKey) });
  if (!resp.ok) throw new Error(`Vapi assistant bilgisi alınamadı: ${resp.status}`);
  const data = await resp.json() as { model?: { provider?: string; model?: string } };
  if (!data.model?.provider || !data.model?.model) {
    throw new Error('Vapi assistant model config eksik (provider/model)');
  }
  const result = { provider: data.model.provider, model: data.model.model, cachedAt: Date.now() };
  modelConfigCache.set(assistantId, result);
  return result;
}

// Asistanın ses (TTS) ayarından SADECE voiceId + provider'ı okur — roleplay
// override'ında danışmanın seçtiği sesi korumak, ama vurgu/hız parametrelerini
// kendimiz belirlemek için (bkz. buildRoleplayAssistantOverrides).
interface AssistantVoice { voiceId: string; stability?: number; similarityBoost?: number }

// Asistanın 11labs ses ayarını (voiceId + stability/similarity) okur; kısa süreli
// cache — kampanyada her arama için Vapi'ye ek bir GET atmamak için.
const voiceCache = new Map<string, { voice: AssistantVoice | null; cachedAt: number }>();
async function getAssistantVoice(apiKey: string, assistantId: string): Promise<AssistantVoice | null> {
  const cached = voiceCache.get(assistantId);
  if (cached && Date.now() - cached.cachedAt < MODEL_CONFIG_TTL_MS) return cached.voice;
  let voice: AssistantVoice | null = null;
  try {
    const resp = await fetch(`${VAPI_BASE_URL}/assistant/${assistantId}`, { headers: getHeaders(apiKey) });
    if (resp.ok) {
      const data = await resp.json() as { voice?: { provider?: string; voiceId?: string; stability?: number; similarityBoost?: number } };
      if (data.voice?.provider === '11labs' && data.voice.voiceId) {
        voice = { voiceId: data.voice.voiceId, stability: data.voice.stability, similarityBoost: data.voice.similarityBoost };
      }
    }
  } catch { /* aşağıda null */ }
  voiceCache.set(assistantId, { voice, cachedAt: Date.now() });
  return voice;
}

async function getAssistantVoiceId(apiKey: string, assistantId: string): Promise<string | null> {
  return (await getAssistantVoice(apiKey, assistantId))?.voiceId ?? null;
}

// Senaryo bazlı TTS modeli override'ı (bkz. types.ts ScenarioVoiceModel). Asistanın
// kendi sesini (voiceId) korur, sadece modeli değiştirir. eleven_v4_turbo'da
// style/speed/SSML YOK — ifade yalnızca stability ve metin içi ses etiketleriyle
// ([warm], [calm] …) yönetilir; bu yüzden o alanlar bilinçli olarak gönderilmiyor.
// Asistan 11labs değilse (veya okunamazsa) override uygulanmaz, arama normal gider.
async function buildScenarioVoiceOverride(
  apiKey: string, assistantId: string, model: ScenarioVoiceModel,
): Promise<Record<string, unknown> | null> {
  const voice = await getAssistantVoice(apiKey, assistantId);
  if (!voice) return null;
  const isV4 = model === 'eleven_v4_turbo';
  return {
    provider: '11labs',
    voiceId: voice.voiceId,
    model,
    language: 'tr',
    // v4: düşük stability = daha canlı tonlama; asistan ayarı varsa ona saygı duy.
    stability: voice.stability ?? (isV4 ? 0.4 : 0.6),
    similarityBoost: voice.similarityBoost ?? 0.75,
    useSpeakerBoost: true,
    ...(isV4 ? {} : { optimizeStreamingLatency: 4 }),
  };
}

function invalidateAssistantCaches(assistantId: string): void {
  modelConfigCache.delete(assistantId);
  voiceCache.delete(assistantId);
  systemPromptCache.delete(assistantId);
}

// Vapi üzerinden outbound arama başlat
export async function createVapiCall(
  creds: ResolvedVapiCredentials,
  customer: CustomerInfo,
  systemPrompt?: string,
  personalization?: {
    agentName?: string;
    voiceModel?: ScenarioVoiceModel;
    // Açılış varyantı "Alo'yu bekle" istiyorsa (bkz. src/opening.ts) asistanın
    // varsayılan "önce asistan konuşur" modu bu arama için geçersiz kılınır.
    waitForGreeting?: boolean;
    // İsim bayrakları kapalı senaryolarda boş gönderilir (bkz. src/opening.ts
    // nameVariableValues) — undefined ise eski davranış (gerçek değerler).
    variableOverrides?: { customerName?: string; agentName?: string };
  },
): Promise<VapiCallResponse> {
  const { apiKey, phoneNumberId, assistantId } = creds;

  const assistantOverrides: Record<string, unknown> = {
    variableValues: {
      customerName: customer.name,
      customerRegion: customer.region || 'belirtilmemiş',
      customerNotes: customer.notes || 'yok',
      customerReference: customer.reference || 'yok',
      // Senaryo metinlerinde {{agentName}} olarak kullanılır — asistanın kendi
      // konuşma kimliği (örn. "Deniz"), script'i elle düzenlemeye gerek kalmadan
      // kişiselleştirilmiş bir arama deneyimi sağlar.
      agentName: personalization?.agentName?.trim() || 'Asistan',
      ...(personalization?.variableOverrides || {}),
    },
  };

  if (systemPrompt) {
    // Vapi, model override'ında provider/model alanlarını zorunlu tutuyor —
    // sadece messages göndermek "assistantOverrides.model.provider must be one of..." hatası verir.
    const { provider, model } = await getAssistantModelConfig(apiKey, assistantId);
    assistantOverrides.model = {
      provider,
      model,
      messages: [{ role: 'system', content: systemPrompt }],
    };
  }

  if (personalization?.voiceModel) {
    const voice = await buildScenarioVoiceOverride(apiKey, assistantId, personalization.voiceModel);
    if (voice) assistantOverrides.voice = voice;
  }

  if (personalization?.waitForGreeting) {
    assistantOverrides.firstMessageMode = 'assistant-waits-for-user';
  }

  const body = {
    phoneNumberId,
    assistantId,
    customer: {
      number: customer.phone,
      // Vapi customer.name'i 40 karakterle sınırlıyor. CRM'deki tüzel kişi/kurum
      // adları ("DEVA DANIŞMANLIK VE ULUSLARARASI TİC.LTD.ŞTİ." gibi) bunu rahatça
      // aşıyor — kırpılmadan gönderilince Vapi isteğin TAMAMINI 400 ile reddediyordu,
      // kişi hiç aranmadan "başarısız" yakılıyordu (production'da düzinelerce kayıt
      // bu yüzden atlanmıştı). {{customerName}} değişkeni (assistantOverrides,
      // yukarıda) zaten TAM adı taşıyor — asistanın konuşmada kullandığı isim budur,
      // burası sadece Vapi'nin dashboard/log görünümü için.
      name: customer.name?.trim().slice(0, 40) || undefined,
    },
    assistantOverrides,
  };

  const response = await fetch(`${VAPI_BASE_URL}/call`, {
    method: 'POST',
    headers: getHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Vapi API hatası: ${response.status} - ${await extractVapiErrorMessage(response)}`);
  }

  return response.json() as Promise<VapiCallResponse>;
}

// Roleplay Pratik (bkz. src/personas.ts) — createVapiCall'daki assistantOverrides
// hesaplama mantığının (model.messages ile geçici sistem promptu enjeksiyonu),
// REST /call'a hiç POST atmadan sadece override OBJESİNİ üreten hali. Tarayıcıdaki
// Vapi Web SDK (vapiSDK.run) bu objeyi assistantOverrides olarak alıp danışmanın
// kalıcı asistanını DEĞİŞTİRMEDEN geçici bir persona promptuyla çalıştırır.
// Roleplay için sabit ElevenLabs ses ID'leri, cinsiyete göre. Danışmanın kendi
// asistan sesi (varsayılan olarak kadın, örn. FDs1ZX5J4e4f2c2erxtW) sadece kadın
// personalarda kullanılır — erkek karakterler (Mehmet, Burak, Cem, Kemal, vb.)
// danışmanın kadın sesiyle konuşuyordu, bu ciddi bir gerçekçilik sorunuydu.
// 'erkek' ID'si Mustafa'nın ElevenLabs'e eklediği sese sabitlenmiş
// (bkz. https://elevenlabs.io/voices/7VqWGAWwo2HMrylfKrcm).
const ROLEPLAY_VOICE_ID_BY_GENDER: Record<'kadin' | 'erkek', string> = {
  kadin: 'FDs1ZX5J4e4f2c2erxtW',
  erkek: '7VqWGAWwo2HMrylfKrcm',
};

export async function buildRoleplayAssistantOverrides(
  creds: { apiKey: string; assistantId: string },
  systemPrompt: string,
  agentName?: string,
  gender: 'kadin' | 'erkek' = 'kadin',
): Promise<Record<string, unknown>> {
  // Sadece provider'ı asistandan okuyoruz — model'i roleplay için AŞAĞIDA sabit
  // bir değere (ROLEPLAY_MODEL) override ediyoruz, asistanın kendi modelini
  // (luna) kullanmıyoruz.
  const { provider } = await getAssistantModelConfig(creds.apiKey, creds.assistantId);
  // 'kadin' personalarda danışmanın kendi seçtiği sesi kullanmaya devam ediyoruz
  // (o zaten büyük çoğunlukla kadın), 'erkek' personalarda SABİT erkek sese
  // geçiyoruz — danışmanın kendi ses tercihinden bağımsız, çünkü karakterin
  // cinsiyeti prompt'ta net ve ses bununla çelişirse tuhaf kaçar.
  const voiceId = gender === 'erkek'
    ? ROLEPLAY_VOICE_ID_BY_GENDER.erkek
    : (await getAssistantVoiceId(creds.apiKey, creds.assistantId)) || ROLEPLAY_VOICE_ID_BY_GENDER.kadin;

  // ElevenLabs ses parametreleri — vurgu/doğallık parametrelerini roleplay için
  // ayrı ayarlıyoruz. Varsayılan asistan (createDefaultAssistant) soğuk arama
  // için ayarlı: style hiç verilmemiş (yani 0 = düz, vurgusuz okuma), speed 1.15
  // (aceleci), stability 0.6 (monoton tarafa yakın). Pratikte karşımızdaki
  // "gerçek bir insan" gibi duyulmalı.
  const voiceOverride = voiceId ? {
    voice: {
      provider: '11labs',
      voiceId,
      model: 'eleven_v3',
      language: 'tr',        // Dili açıkça bildir — model tahmin etmesin, Türkçe telaffuz tutarlı olsun
      stability: 0.35,       // DÜŞÜK = daha fazla tonlama/duygu değişimi (0.6 monoton okutuyordu)
      similarityBoost: 0.75, // Sesin kendi karakterini koru
      style: 0.45,           // ASIL VURGU AYARI — 0 (varsayılan) düz okuma demekti
      useSpeakerBoost: true, // Ses netliği/karakter tutarlılığı
      speed: 1.0,            // 1.15 aceleci duyuluyordu — normal tempo daha doğal
      // eleven_v3 en yüksek ifade gücünü veriyor ama en yavaş model — vurgu
      // önceliğimiz olduğu için modeli değiştirmiyoruz, sadece ElevenLabs'ın
      // kendi streaming gecikmesini maksimuma çekip telafi ediyoruz (0-4, varsayılan
      // 3). minCharacters/chunkPlan'a DOKUNMUYORUZ — düşük tutmak kısa parçalar
      // halinde TTS'e gönderim yapar, bu da "kekeleme" hissi yaratıp tam
      // istemediğimiz sonucu doğurabilir.
      optimizeStreamingLatency: 4,
    },
  } : {};

  // Roleplay'de LLM'i danışmanın kalıcı asistanından (gpt-5.6-luna) DEĞİL, sabit
  // gpt-5.6-sol'a override ediyoruz — deneme amaçlı, akıcılık/gerçekçilik
  // karşılaştırması için. `model` değişkenini (asistandan okunan luna) kasıtlı
  // olarak KULLANMIYORUZ, sadece `provider`'ı koruyoruz.
  const ROLEPLAY_MODEL = 'gpt-5.6-sol';

  return {
    variableValues: { agentName: agentName?.trim() || 'Asistan' },
    model: { provider, model: ROLEPLAY_MODEL, messages: [{ role: 'system', content: systemPrompt }] },
    ...voiceOverride,

    // GERİ ALINDI: Soniox stt-rt-v5 denendi ama gerçek bir web call'da Daily.co
    // "Meeting ended due to ejection" hatasıyla görüşmeyi saniyeler içinde
    // kapatıyordu (REST /call/web isteği 201 dönüyordu ama runtime'da bağlantı
    // kuruluyor-kuruluyor sonra atılıyordu — muhtemelen bu Vapi hesabında Soniox
    // provider'ı etkin değil, ya da negatif endpointSensitivity kombinasyonu bu
    // hesap/plan için desteklenmiyor). Deepgram nova-3'e dönüldü — bu, danışmanın
    // ana asistanında zaten kanıtlanmış şekilde çalışıyor.
    transcriber: {
      provider: 'deepgram',
      model: 'nova-3',
      language: 'tr',
      endpointing: 400, // varsayılan 150'den daha sabırlı — Türkçenin devrik/ekli
                        // cümle yapısında erken kesmeyi azaltmak için
    },

    // FSBO personaları müşteri rolünde — konuşmayı danışman başlatmalı, AI değil
    // (bkz. persona promptlarındaki "danışman kendini tanıtana kadar konuşma"
    // kuralı). Vapi'nin "asistan ilk konuşmayı yapmaz, kullanıcıyı bekler" modu.
    firstMessageMode: 'assistant-waits-for-user',

    // ─── Roleplay'e ÖZEL konuşma ayarları ───────────────────────────────────
    // Danışmanın kendi asistanı GİDEN SOĞUK ARAMA için ayarlı (bkz.
    // createDefaultAssistant): telefon hattında, tek kişiyle, 2 dakikalık aramalar
    // için agresif kesme/erken cevap değerleri kullanıyor. Tarayıcıdan yapılan
    // pratikte bu ayarlar ters tepiyor — ofis gürültüsü/hoparlör sesi AI'ı sürekli
    // kesiyor, Türkçenin devrik/ekli cümle yapısında AI danışman cümlesini
    // bitirmeden cevaba başlayıp kendini düzeltiyor ("başa sarma" hissi).
    // Bu yüzden roleplay için AYRI, daha sabırlı değerler override ediliyor.

    // Gürültü engelleme AÇIK (Krisp) — tarayıcı/laptop mikrofonu telefon hattından
    // çok daha fazla ortam sesi topluyor. NOT: assistantOverrides'ta alan adı
    // "backgroundDenoisingEnabled" DEĞİL (o sadece asistan tanımında geçerli),
    // burada backgroundSpeechDenoisingPlan kullanılmalı — yanlış alan göndermek
    // Vapi'nin tüm isteği reddetmesine yol açar.
    backgroundSpeechDenoisingPlan: { smartDenoisingPlan: { enabled: true } },

    // AI'ın susması için gereken eşiği YÜKSELT: varsayılan 4 kelime yerine 10 kelime
    // (şema üst sınırı). Kısa bir öksürük, arka plandaki konuşma ya da "hı-hı" gibi
    // onay sesleri artık AI'ı kesmiyor — kesmesi için karşı tarafın gerçekten
    // konuşmaya başlaması gerekiyor.
    // DİKKAT: voiceSeconds'ın Vapi şemasındaki ÜST SINIRI 0.5 — daha büyük bir değer
    // göndermek TÜM isteği 400 ile reddettirir (call hiç oluşmaz). Bu yüzden gürültü
    // toleransı voiceSeconds'tan değil, numWords + backoffSeconds'tan sağlanıyor.
    stopSpeakingPlan: { numWords: 10, voiceSeconds: 0.5, backoffSeconds: 2 },

    // Danışman konuşmayı BİTİRENE kadar bekle: Türkçede cümle sonu tespiti zor
    // (noktalama olmadan, ek yığınlarıyla biten cümleler). waitSeconds 0.2 → 0.8,
    // noktalama yoksa 1 → 2sn bekleme. AI artık yarıda atlamıyor.
    startSpeakingPlan: {
      waitSeconds: 0.8,
      smartEndpointingEnabled: 'livekit',
      transcriptionEndpointingPlan: { onPunctuationSeconds: 0.3, onNoPunctuationSeconds: 2, onNumberSeconds: 0.5 },
    },

    // Pratik görüşmesi 2 dakikayla sınırlı kalmasın — 10 dakika.
    maxDurationSeconds: 600,

    // Otomatik kapanma ifadeleri temizleniyor — gerçek aramada "iyi günler" demek
    // görüşmeyi bitirir, ama pratikte danışman bunu senaryo gereği doğal olarak
    // söyleyebilir ve görüşme ortasında beklenmedik şekilde kapanır. Pratiği
    // bitirmenin tek yolu "Görüşmeyi Bitir" butonu olmalı.
    // NOT: silenceTimeoutSeconds ve endCallFunctionEnabled assistantOverrides
    // şemasında YOK (sadece asistan tanımında var) — göndermiyoruz.
    endCallPhrases: [],
  };
}

// Vapi hata gövdesi genelde {"message": "..." | ["...", ...], "error": "...", "statusCode": ...}
// şeklinde JSON döner — önceden bu ham JSON metni doğrudan danışmana toast olarak
// gösteriliyordu (örn. arama başlatılamadığında). Mümkünse okunabilir mesajı çıkar,
// parse edilemezse (JSON değilse) ham metne düş.
async function extractVapiErrorMessage(response: Response): Promise<string> {
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw) as { message?: string | string[] };
    if (Array.isArray(parsed.message)) return parsed.message.join(', ');
    if (typeof parsed.message === 'string') return parsed.message;
  } catch (_) { /* JSON değil, ham metne düş */ }
  return raw;
}

// Ses kaydı için kısa ömürlü imzalı URL al (raw recordingUrl'ler HIPAA bucket'ında
// yetkilendirme gerektirdiğinden doğrudan tarayıcıdan çalınamaz — Vapi'nin
// /call/:id/mono-recording endpoint'i 302 ile imzalı URL'ye yönlendirir).
export async function getSignedRecordingUrl(apiKey: string, vapiCallId: string): Promise<string | null> {
  const resp = await fetch(`${VAPI_BASE_URL}/call/${vapiCallId}/mono-recording`, {
    headers: getHeaders(apiKey),
    redirect: 'manual',
  });
  const location = resp.headers.get('location');
  return location;
}

// Aktif aramayı sonlandır
export async function endVapiCall(apiKey: string, vapiCallId: string): Promise<void> {
  const response = await fetch(`${VAPI_BASE_URL}/call/${vapiCallId}`, {
    method: 'DELETE',
    headers: getHeaders(apiKey),
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Vapi arama sonlandırma hatası: ${response.status} - ${await extractVapiErrorMessage(response)}`);
  }
}

// Vapi assistant'ın canlı (base) sistem promptunu getir — özet üretiminde de
// kullanıldığı için kısa TTL cache: her arama sonunda Vapi'yi bombalamayalım.
// assistantId ile keylenir (bkz. modelConfigCache açıklaması).
const systemPromptCache = new Map<string, { name: string; systemPrompt: string; cachedAt: number }>();
const SYSTEM_PROMPT_TTL_MS = 5 * 60 * 1000;

export async function getAssistantSystemPrompt(
  apiKey: string, assistantId: string, forceRefresh = false,
): Promise<{ name: string; systemPrompt: string }> {
  const cached = systemPromptCache.get(assistantId);
  if (!forceRefresh && cached && Date.now() - cached.cachedAt < SYSTEM_PROMPT_TTL_MS) return cached;

  const resp = await fetch(`${VAPI_BASE_URL}/assistant/${assistantId}`, { headers: getHeaders(apiKey) });
  if (!resp.ok) throw new Error(`Vapi assistant bilgisi alınamadı: ${resp.status}`);
  const data = await resp.json() as {
    name?: string;
    model?: { messages?: Array<{ role: string; content: string }> };
  };
  const systemMsg = data.model?.messages?.find(m => m.role === 'system');
  const result = { name: data.name || 'Vapi Asistanı', systemPrompt: systemMsg?.content || '', cachedAt: Date.now() };
  systemPromptCache.set(assistantId, result);
  return result;
}

// Vapi assistant'ın canlı (base) sistem promptunu güncelle — tüm aramaları etkiler
export async function updateAssistantSystemPrompt(apiKey: string, assistantId: string, systemPrompt: string): Promise<void> {
  const { provider, model } = await getAssistantModelConfig(apiKey, assistantId);
  const resp = await fetch(`${VAPI_BASE_URL}/assistant/${assistantId}`, {
    method: 'PATCH',
    headers: getHeaders(apiKey),
    body: JSON.stringify({
      model: { provider, model, messages: [{ role: 'system', content: systemPrompt }] },
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Vapi assistant güncelleme hatası: ${resp.status} - ${errText}`);
  }
  invalidateAssistantCaches(assistantId);
}

// Vapi hesap kredisi / abonelik bilgisi
export interface VapiCreditInfo {
  ok: boolean;
  balance?: number;
  monthlyCharge?: number;
  plan?: string;
  error?: string;
  link?: string;
}

export async function getVapiCredit(): Promise<VapiCreditInfo> {
  // Vapi REST API'si kredi/abonelik sorgusunu desteklemiyor; dashboard linki döndür.
  return { ok: false, error: 'dashboard', link: 'https://dashboard.vapi.ai' };
}

// Admin panelden girilen VAPI_API_KEY'i hemen doğrula — kaydetmeden önce test amaçlı
export async function verifyVapiApiKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch(`${VAPI_BASE_URL}/assistant`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) {
      return {
        ok: false,
        error: resp.status === 401 || resp.status === 403
          ? 'API Key geçersiz — Vapi hesabınızdan doğru anahtarı kopyaladığınızdan emin olun.'
          : `Vapi doğrulaması başarısız (HTTP ${resp.status})`,
      };
    }
    return { ok: true };
  } catch {
    // fetch'in kendisi patladı (ağ/DNS/TLS) — ham "TypeError: fetch failed" metni
    // kullanıcıya hiçbir şey anlatmaz.
    return { ok: false, error: 'Vapi sunucusuna ulaşılamadı — internet bağlantınızı kontrol edip tekrar deneyin.' };
  }
}

// Ayarlarım'da Assistant ID / Phone Number ID'yi elle yapıştırmak yerine dropdown'dan
// seçtirebilmek için — kullanıcı sadece Vapi API Key'ini girince hesabındaki asistan/numara
// listesi çekilir.
export async function listAssistants(apiKey: string): Promise<Array<{ id: string; name: string }>> {
  const resp = await fetch(`${VAPI_BASE_URL}/assistant`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!resp.ok) throw new Error(`Vapi asistan listesi alınamadı: ${resp.status}`);
  const data = await resp.json() as Array<{ id: string; name?: string }>;
  return data.map(a => ({ id: a.id, name: a.name || '(isimsiz)' }));
}

export async function listPhoneNumbers(apiKey: string): Promise<Array<{ id: string; number: string; name?: string }>> {
  const resp = await fetch(`${VAPI_BASE_URL}/phone-number`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!resp.ok) throw new Error(`Vapi telefon numarası listesi alınamadı: ${resp.status}`);
  const data = await resp.json() as Array<{ id: string; number?: string; name?: string }>;
  return data.map(p => ({ id: p.id, number: p.number || '(numara yok)', name: p.name }));
}

// Bu alanlar hesaba/kayda özeldir — bir asistanı başka bir hesaba kopyalarken
// taşınmamalı. En önemlisi "server": kaynağın webhook adresi/secret'ı hedefe
// kopyalanırsa hedef hesabın aramaları yanlışlıkla kaynağa gider. Hedefin kendi
// webhook'u, assistantId kaydedildiğinde provisionWebhookIfReady ile ayrıca kurulur.
const NON_COPYABLE_ASSISTANT_FIELDS = ['id', 'orgId', 'createdAt', 'updatedAt', 'server', 'latestVersion', 'isServerUrlSecretSet'];

// Bir asistanın TÜM konfigürasyonunu (model/ses/transkripsiyon/prompt/davranış — Ayarlarım'daki
// dar AssistantConfigView'dan çok daha kapsamlı) bir hesaptan okuyup başka bir hesapta
// yepyeni bir asistan olarak oluşturur. Danışman onboarding'inde "admin'in ayarladığı
// script/ses/model bende de aynen olsun" senaryosu için.
export async function importAssistant(
  sourceApiKey: string, sourceAssistantId: string, targetApiKey: string, newName?: string,
): Promise<{ id: string; name: string }> {
  const sourceResp = await fetch(`${VAPI_BASE_URL}/assistant/${sourceAssistantId}`, { headers: getHeaders(sourceApiKey) });
  if (!sourceResp.ok) throw new Error(`Kaynak asistan okunamadı: ${sourceResp.status}`);
  const source = await sourceResp.json() as Record<string, unknown>;

  const body: Record<string, unknown> = { ...source };
  for (const field of NON_COPYABLE_ASSISTANT_FIELDS) delete body[field];
  if (newName?.trim()) body.name = newName.trim();

  const createResp = await fetch(`${VAPI_BASE_URL}/assistant`, {
    method: 'POST',
    headers: getHeaders(targetApiKey),
    body: JSON.stringify(body),
  });
  if (!createResp.ok) {
    const errText = await createResp.text();
    throw new Error(`Yeni asistan oluşturulamadı: ${createResp.status} - ${errText}`);
  }
  const created = await createResp.json() as { id: string; name: string };
  return { id: created.id, name: created.name };
}

// Yeni danışman onboarding'i için — var olan bir template asistanı klonlamak yerine,
// ses/model/transkripsiyon config'i burada SABİT tanımlanıp sıfırdan yeni bir Vapi
// assistant oluşturulur (merkezi hesap üzerinde). Sistem promptu DEFAULT_SCENARIO_TEMPLATE
// (scenarios.ts, {{agentName}} değişkenli) — böylece senaryo seçilmeden
// yapılan aramalarda da (Vapi'nin kendi baz promptu) tutarlı bir kimlik/davranış olur.
export async function createDefaultAssistant(apiKey: string, name: string): Promise<{ id: string; name: string }> {
  const body = {
    name,
    voice: {
      provider: '11labs',
      voiceId: 'FDs1ZX5J4e4f2c2erxtW',
      model: 'eleven_v3',
      speed: 1.15,
      stability: 0.6,
    },
    model: {
      provider: 'openai',
      model: 'gpt-5.6-luna',
      messages: [{ role: 'system', content: DEFAULT_SCENARIO_TEMPLATE }],
    },
    transcriber: {
      provider: 'deepgram',
      model: 'nova-3',
      language: 'tr',
      endpointing: 150,
    },
    firstMessageMode: 'assistant-speaks-first-with-model-generated-message',
    firstMessage: '',
    silenceTimeoutSeconds: 10,
    maxDurationSeconds: 119,
    backgroundSound: 'off',
    backgroundDenoisingEnabled: false,
    endCallFunctionEnabled: true,
    endCallPhrases: [
      'güle güle', 'hoşça kal', 'hoşça kalın', 'hoşçakal', 'iyi günler', 'iyi akşamlar',
      'iyi çalışmalar', 'kapatıyorum', 'görüşmek üzere', 'teşekkürler iyi günler',
      'iyi geceler', 'bay bay', 'kapatın lütfen', 'tamam kapatalım', 'tamam görüşürüz',
    ],
    stopSpeakingPlan: { numWords: 4, voiceSeconds: 0.5 },
    startSpeakingPlan: {
      waitSeconds: 0.2,
      smartEndpointingEnabled: 'livekit',
      transcriptionEndpointingPlan: { onNoPunctuationSeconds: 1, onNumberSeconds: 0.3 },
    },
    artifactPlan: { recordingEnabled: true },
    voicemailDetection: {
      provider: 'vapi',
      backoffPlan: { maxRetries: 6, startAtSeconds: 5, frequencySeconds: 5 },
      beepMaxAwaitSeconds: 0,
    },
  };

  const resp = await fetch(`${VAPI_BASE_URL}/assistant`, {
    method: 'POST',
    headers: getHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Varsayılan asistan oluşturulamadı: ${resp.status} - ${errText}`);
  }
  const created = await resp.json() as { id: string; name: string };
  return { id: created.id, name: created.name };
}

// ─── Asistan Ayarları (kullanıcının kendi "Ayarlarım" sayfası) ─────────────
// Model/ses/transkripsiyon/konuşma davranışı — prompt dışındaki teknik ayarlar.

export interface AssistantConfigView {
  name: string;
  modelProvider: string;
  modelName: string;
  voiceProvider: string;
  voiceId: string;
  voiceModel: string;
  voiceSpeed: number;
  transcriberProvider: string;
  transcriberModel: string;
  transcriberLanguage: string;
  confidenceThreshold: number;
  backgroundDenoisingEnabled: boolean;
  endCallPhrases: string[];
  endCallMessage: string;
  maxDurationSeconds: number;
  silenceTimeoutSeconds: number;
  stopSpeakingNumWords: number;
}

export async function getAssistantConfig(apiKey: string, assistantId: string): Promise<AssistantConfigView> {
  const resp = await fetch(`${VAPI_BASE_URL}/assistant/${assistantId}`, { headers: getHeaders(apiKey) });
  if (!resp.ok) throw new Error(`Vapi assistant bilgisi alınamadı: ${resp.status}`);
  const d = await resp.json() as any;

  return {
    name: d.name || '',
    modelProvider: d.model?.provider || '',
    modelName: d.model?.model || '',
    voiceProvider: d.voice?.provider || '',
    voiceId: d.voice?.voiceId || '',
    voiceModel: d.voice?.model || '',
    voiceSpeed: d.voice?.speed ?? 1,
    transcriberProvider: d.transcriber?.provider || '',
    transcriberModel: d.transcriber?.model || '',
    transcriberLanguage: d.transcriber?.language || '',
    confidenceThreshold: d.transcriber?.confidenceThreshold ?? 0.4,
    backgroundDenoisingEnabled: !!d.backgroundDenoisingEnabled,
    endCallPhrases: d.endCallPhrases || [],
    endCallMessage: d.endCallMessage || '',
    maxDurationSeconds: d.maxDurationSeconds ?? 120,
    silenceTimeoutSeconds: d.silenceTimeoutSeconds ?? 10,
    stopSpeakingNumWords: d.stopSpeakingPlan?.numWords ?? 3,
  };
}

export interface AssistantConfigPatch {
  modelProvider?: string;
  modelName?: string;
  voiceProvider?: string;
  voiceId?: string;
  voiceModel?: string;
  voiceSpeed?: number;
  transcriberProvider?: string;
  transcriberModel?: string;
  confidenceThreshold?: number;
  backgroundDenoisingEnabled?: boolean;
  endCallPhrases?: string[];
  endCallMessage?: string;
  maxDurationSeconds?: number;
  silenceTimeoutSeconds?: number;
  stopSpeakingNumWords?: number;
}

// Vapi PATCH'i iç içe objelerde (model/voice/transcriber/stopSpeakingPlan) kısmi
// alanı değil TÜM objeyi bekliyor — bu yüzden önce mevcut config'i çekip
// sadece değişen alanları üstüne yazıp tam objeyi geri gönderiyoruz. Aksi halde
// örn. sadece confidenceThreshold güncellenirken transcriber.language sıfırlanabilir.
export async function updateAssistantConfig(apiKey: string, assistantId: string, patch: AssistantConfigPatch): Promise<void> {
  const current = await fetch(`${VAPI_BASE_URL}/assistant/${assistantId}`, { headers: getHeaders(apiKey) })
    .then(r => r.json()) as any;

  const body: Record<string, unknown> = {};

  if (patch.modelProvider !== undefined || patch.modelName !== undefined) {
    body.model = {
      ...current.model,
      provider: patch.modelProvider ?? current.model?.provider,
      model:    patch.modelName    ?? current.model?.model,
    };
  }

  if (patch.voiceProvider !== undefined || patch.voiceId !== undefined
      || patch.voiceModel !== undefined || patch.voiceSpeed !== undefined) {
    body.voice = {
      ...current.voice,
      provider: patch.voiceProvider ?? current.voice?.provider,
      voiceId:  patch.voiceId       ?? current.voice?.voiceId,
      model:    patch.voiceModel    ?? current.voice?.model,
      speed:    patch.voiceSpeed    ?? current.voice?.speed,
    };
  }

  if (patch.transcriberProvider !== undefined || patch.transcriberModel !== undefined
      || patch.confidenceThreshold !== undefined) {
    body.transcriber = {
      ...current.transcriber,
      provider:            patch.transcriberProvider  ?? current.transcriber?.provider,
      model:               patch.transcriberModel      ?? current.transcriber?.model,
      confidenceThreshold: patch.confidenceThreshold   ?? current.transcriber?.confidenceThreshold,
    };
  }

  if (patch.backgroundDenoisingEnabled !== undefined) {
    body.backgroundDenoisingEnabled = patch.backgroundDenoisingEnabled;
  }
  if (patch.endCallPhrases !== undefined) body.endCallPhrases = patch.endCallPhrases;
  if (patch.endCallMessage !== undefined) body.endCallMessage = patch.endCallMessage;
  if (patch.maxDurationSeconds !== undefined) body.maxDurationSeconds = patch.maxDurationSeconds;
  if (patch.silenceTimeoutSeconds !== undefined) body.silenceTimeoutSeconds = patch.silenceTimeoutSeconds;
  if (patch.stopSpeakingNumWords !== undefined) {
    body.stopSpeakingPlan = { ...current.stopSpeakingPlan, numWords: patch.stopSpeakingNumWords };
  }

  const resp = await fetch(`${VAPI_BASE_URL}/assistant/${assistantId}`, {
    method: 'PATCH',
    headers: getHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Vapi assistant güncelleme hatası: ${resp.status} - ${errText}`);
  }
  invalidateAssistantCaches(assistantId);
}

// server.secret + server.url tanımla — webhook geldiğinde bu danışmana ait olduğunu
// doğrulamak için kullanılır (bkz. src/auth.ts webhook spoof kontrolü, Faz 5).
export async function updateAssistantServer(
  apiKey: string, assistantId: string, params: { url: string; secret: string },
): Promise<void> {
  const resp = await fetch(`${VAPI_BASE_URL}/assistant/${assistantId}`, {
    method: 'PATCH',
    headers: getHeaders(apiKey),
    body: JSON.stringify({ server: { url: params.url, secret: params.secret } }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Vapi assistant server ayarı güncellenemedi: ${resp.status} - ${errText}`);
  }
}
