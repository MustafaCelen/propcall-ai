// PropCall AI - Vapi API entegrasyonu

import { CustomerInfo } from './types';

const VAPI_BASE_URL = 'https://api.vapi.ai';

function getHeaders(): Record<string, string> {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) throw new Error('VAPI_API_KEY tanımlanmamış');
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
let modelConfigCache: { provider: string; model: string } | null = null;
let modelConfigCachedAt = 0;
const MODEL_CONFIG_TTL_MS = 5 * 60 * 1000;

async function getAssistantModelConfig(assistantId: string): Promise<{ provider: string; model: string }> {
  if (modelConfigCache && Date.now() - modelConfigCachedAt < MODEL_CONFIG_TTL_MS) {
    return modelConfigCache;
  }
  const resp = await fetch(`${VAPI_BASE_URL}/assistant/${assistantId}`, { headers: getHeaders() });
  if (!resp.ok) throw new Error(`Vapi assistant bilgisi alınamadı: ${resp.status}`);
  const data = await resp.json() as { model?: { provider?: string; model?: string } };
  if (!data.model?.provider || !data.model?.model) {
    throw new Error('Vapi assistant model config eksik (provider/model)');
  }
  modelConfigCache = { provider: data.model.provider, model: data.model.model };
  modelConfigCachedAt = Date.now();
  return modelConfigCache;
}

// Vapi üzerinden outbound arama başlat
export async function createVapiCall(customer: CustomerInfo, systemPrompt?: string): Promise<VapiCallResponse> {
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const assistantId = process.env.VAPI_ASSISTANT_ID;

  if (!phoneNumberId) throw new Error('VAPI_PHONE_NUMBER_ID tanımlanmamış');
  if (!assistantId) throw new Error('VAPI_ASSISTANT_ID tanımlanmamış');

  const assistantOverrides: Record<string, unknown> = {
    variableValues: {
      customerName: customer.name,
      customerRegion: customer.region || 'belirtilmemiş',
      customerNotes: customer.notes || 'yok',
    },
  };

  if (systemPrompt) {
    // Vapi, model override'ında provider/model alanlarını zorunlu tutuyor —
    // sadece messages göndermek "assistantOverrides.model.provider must be one of..." hatası verir.
    const { provider, model } = await getAssistantModelConfig(assistantId);
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
    headers: getHeaders(),
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
export async function getSignedRecordingUrl(vapiCallId: string): Promise<string | null> {
  const resp = await fetch(`${VAPI_BASE_URL}/call/${vapiCallId}/mono-recording`, {
    headers: getHeaders(),
    redirect: 'manual',
  });
  const location = resp.headers.get('location');
  return location;
}

// Aktif aramayı sonlandır
export async function endVapiCall(vapiCallId: string): Promise<void> {
  const response = await fetch(`${VAPI_BASE_URL}/call/${vapiCallId}`, {
    method: 'DELETE',
    headers: getHeaders(),
  });

  if (!response.ok && response.status !== 404) {
    const errText = await response.text();
    throw new Error(`Vapi arama sonlandırma hatası: ${response.status} - ${errText}`);
  }
}

// Vapi assistant'ın canlı (base) sistem promptunu getir — özet üretiminde de
// kullanıldığı için kısa TTL cache: her arama sonunda Vapi'yi bombalamayalım.
let systemPromptCache: { name: string; systemPrompt: string } | null = null;
let systemPromptCachedAt = 0;
const SYSTEM_PROMPT_TTL_MS = 5 * 60 * 1000;

export async function getAssistantSystemPrompt(forceRefresh = false): Promise<{ name: string; systemPrompt: string }> {
  if (!forceRefresh && systemPromptCache && Date.now() - systemPromptCachedAt < SYSTEM_PROMPT_TTL_MS) {
    return systemPromptCache;
  }
  const assistantId = process.env.VAPI_ASSISTANT_ID;
  if (!assistantId) throw new Error('VAPI_ASSISTANT_ID tanımlanmamış');

  const resp = await fetch(`${VAPI_BASE_URL}/assistant/${assistantId}`, { headers: getHeaders() });
  if (!resp.ok) throw new Error(`Vapi assistant bilgisi alınamadı: ${resp.status}`);
  const data = await resp.json() as {
    name?: string;
    model?: { messages?: Array<{ role: string; content: string }> };
  };
  const systemMsg = data.model?.messages?.find(m => m.role === 'system');
  const result = { name: data.name || 'Vapi Asistanı', systemPrompt: systemMsg?.content || '' };
  systemPromptCache = result;
  systemPromptCachedAt = Date.now();
  return result;
}

// Vapi assistant'ın canlı (base) sistem promptunu güncelle — tüm aramaları etkiler
export async function updateAssistantSystemPrompt(systemPrompt: string): Promise<void> {
  const assistantId = process.env.VAPI_ASSISTANT_ID;
  if (!assistantId) throw new Error('VAPI_ASSISTANT_ID tanımlanmamış');

  const { provider, model } = await getAssistantModelConfig(assistantId);
  const resp = await fetch(`${VAPI_BASE_URL}/assistant/${assistantId}`, {
    method: 'PATCH',
    headers: getHeaders(),
    body: JSON.stringify({
      model: { provider, model, messages: [{ role: 'system', content: systemPrompt }] },
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Vapi assistant güncelleme hatası: ${resp.status} - ${errText}`);
  }
  modelConfigCache  = null; // provider/model değişmiş olabilir varsayımıyla cache'i temizle
  systemPromptCache = null; // prompt değişti — bir sonraki özette taze çekilsin
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
