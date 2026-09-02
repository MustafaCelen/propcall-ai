// PropCall AI - Vapi API entegrasyonu — her danışman kendi Vapi hesabıyla çalışır,
// bu yüzden her fonksiyon kimlik bilgilerini (apiKey/assistantId) açıkça parametre alır.

import { CustomerInfo } from './types';
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

function invalidateAssistantCaches(assistantId: string): void {
  modelConfigCache.delete(assistantId);
  systemPromptCache.delete(assistantId);
}

// Vapi üzerinden outbound arama başlat
export async function createVapiCall(
  creds: ResolvedVapiCredentials,
  customer: CustomerInfo,
  systemPrompt?: string,
  personalization?: { agentName?: string; consultantName?: string; companyName?: string },
): Promise<VapiCallResponse> {
  const { apiKey, phoneNumberId, assistantId } = creds;

  const assistantOverrides: Record<string, unknown> = {
    variableValues: {
      customerName: customer.name,
      customerRegion: customer.region || 'belirtilmemiş',
      customerNotes: customer.notes || 'yok',
      customerReference: customer.reference || 'yok',
      // Senaryo metinlerinde {{agentName}}/{{consultantName}}/{{companyName}} olarak
      // kullanılır — script'i elle düzenlemeye gerek kalmadan kişiselleştirilmiş bir
      // arama deneyimi sağlar. agentName = asistanın kendi kimliği (örn. "Deniz"),
      // consultantName = danışmanın GERÇEK adı (örn. "İbrahim Erokyar") — ikisi kasıtlı
      // olarak ayrı (bkz. users.assistant_name vs users.name).
      agentName: personalization?.agentName?.trim() || 'Asistan',
      consultantName: personalization?.consultantName?.trim() || '',
      companyName: personalization?.companyName?.trim() || 'Şirketimiz',
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

  const body = {
    phoneNumberId,
    assistantId,
    customer: {
      number: customer.phone,
      name: customer.name,
    },
    assistantOverrides,
  };

  const response = await fetch(`${VAPI_BASE_URL}/call`, {
    method: 'POST',
    headers: getHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Vapi API hatası: ${response.status} - ${errText}`);
  }

  return response.json() as Promise<VapiCallResponse>;
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
    const errText = await response.text();
    throw new Error(`Vapi arama sonlandırma hatası: ${response.status} - ${errText}`);
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
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
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
// (scenarios.ts, {{agentName}}/{{companyName}} değişkenli) — böylece senaryo seçilmeden
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
