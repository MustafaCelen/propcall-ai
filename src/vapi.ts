// PropCall AI - Vapi API entegrasyonu

import { CustomerInfo } from './types';

const VAPI_BASE_URL = 'https://api.vapi.ai';

// Legacy — sadece global getVapiCredit için, deprecate edilecek
function getGlobalHeaders(): Record<string, string> {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) throw new Error('VAPI_API_KEY tanımlanmamış');
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

export interface VapiCallResponse {
  id: string;
  status: string;
  phoneNumberId: string;
  assistantId: string;
  customer: { number: string; name?: string };
  createdAt: string;
}

// Vapi üzerinden outbound arama başlat — user-scoped
export interface VapiCallCredentials {
  apiKey: string;
  phoneNumberId: string;
  assistantId: string;
}

export async function createVapiCall(
  creds: VapiCallCredentials,
  customer: CustomerInfo,
  systemPrompt?: string,
): Promise<VapiCallResponse> {
  const { apiKey, phoneNumberId, assistantId } = creds;
  if (!apiKey)         throw new Error('Vapi API key eksik — Ayarlar\'dan girin');
  if (!phoneNumberId)  throw new Error('Vapi telefon numarası seçilmemiş');
  if (!assistantId)    throw new Error('Vapi assistant seçilmemiş');

  const assistantOverrides: Record<string, unknown> = {
    variableValues: {
      customerName: customer.name,
      customerRegion: customer.region || 'belirtilmemiş',
      customerNotes: customer.notes || 'yok',
    },
  };

  if (systemPrompt) {
    assistantOverrides.model = {
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
    headers: keyHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Vapi API hatası: ${response.status} - ${errText}`);
  }

  return response.json() as Promise<VapiCallResponse>;
}

// Aktif aramayı sonlandır — user'ın key'iyle
export async function endVapiCall(apiKey: string, vapiCallId: string): Promise<void> {
  const response = await fetch(`${VAPI_BASE_URL}/call/${vapiCallId}`, {
    method: 'DELETE',
    headers: keyHeaders(apiKey),
  });

  if (!response.ok && response.status !== 404) {
    const errText = await response.text();
    throw new Error(`Vapi arama sonlandırma hatası: ${response.status} - ${errText}`);
  }
}

// Vapi hesap kredisi / abonelik bilgisi
export interface VapiCreditInfo {
  ok: boolean;
  balance?: number;         // USD kredi (varsa)
  monthlyCharge?: number;   // Aylık ücret
  plan?: string;            // Plan adı
  error?: string;
}

// Verilen API key ile Vapi çağrısı (user-scoped)
function keyHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

// Kullanıcının verdiği key'i doğrula + subscription bilgisi al
export async function verifyVapiKey(apiKey: string): Promise<VapiCreditInfo> {
  try {
    if (!apiKey) return { ok: false, error: 'API key boş' };
    const resp = await fetch(`${VAPI_BASE_URL}/subscription`, { headers: keyHeaders(apiKey) });
    if (!resp.ok) return { ok: false, error: `Geçersiz key (HTTP ${resp.status})` };
    const data = await resp.json() as any;
    const rawCredit = data.credits;
    const balance = typeof rawCredit === 'string' ? parseFloat(rawCredit) : (rawCredit ?? 0);
    return {
      ok: true,
      balance: Number.isFinite(balance) ? balance : 0,
      monthlyCharge: data.monthlyChargeSchedule?.cost,
      plan: data.type || data.status,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Kullanıcının Vapi telefon numaralarını listele
export async function listVapiPhoneNumbers(apiKey: string): Promise<Array<{ id: string; number: string; name?: string }>> {
  const resp = await fetch(`${VAPI_BASE_URL}/phone-number`, { headers: keyHeaders(apiKey) });
  if (!resp.ok) throw new Error(`Vapi phone-number listesi alınamadı: ${resp.status}`);
  const data = await resp.json() as any[];
  return data.map(p => ({ id: p.id, number: p.number || p.twilioPhoneNumber || '', name: p.name }));
}

// Kullanıcının Vapi asistanlarını listele
export async function listVapiAssistants(apiKey: string): Promise<Array<{ id: string; name: string }>> {
  const resp = await fetch(`${VAPI_BASE_URL}/assistant`, { headers: keyHeaders(apiKey) });
  if (!resp.ok) throw new Error(`Vapi assistant listesi alınamadı: ${resp.status}`);
  const data = await resp.json() as any[];
  return data.map(a => ({ id: a.id, name: a.name || '(isimsiz)' }));
}

// Yeni asistan yarat (hazır Türk emlakçı template'inden)
export async function createVapiAssistantFromTemplate(apiKey: string, params: {
  name: string;
  serverUrl: string;
  serverSecret?: string;
  systemPrompt?: string;
}): Promise<{ id: string; name: string }> {
  const systemPrompt = params.systemPrompt || defaultRealtorPrompt();
  const body = {
    name: params.name,
    firstMessage: 'Merhaba, ben Keller Williams gayrimenkul asistanı. Uygun bir zamanda mısınız?',
    model: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }],
    },
    voice: {
      provider: '11labs',
      voiceId: 'sarah', // varsayılan, kullanıcı sonra değiştirebilir
    },
    transcriber: {
      provider: 'deepgram',
      language: 'tr',
      model: 'nova-2',
    },
    server: {
      url: params.serverUrl,
      ...(params.serverSecret ? { secret: params.serverSecret } : {}),
    },
    maxDurationSeconds: 180,
    silenceTimeoutSeconds: 15,
  };
  const resp = await fetch(`${VAPI_BASE_URL}/assistant`, {
    method: 'POST', headers: keyHeaders(apiKey), body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Vapi assistant oluşturulamadı: ${resp.status} — ${t}`);
  }
  const data = await resp.json() as any;
  return { id: data.id, name: data.name };
}

// Mevcut asistanın serverUrl'ini update et (kullanıcı kendi asistanını bağladığında)
export async function updateVapiAssistantServer(apiKey: string, assistantId: string, params: {
  serverUrl: string;
  serverSecret?: string;
}): Promise<void> {
  const body = {
    server: {
      url: params.serverUrl,
      ...(params.serverSecret ? { secret: params.serverSecret } : {}),
    },
  };
  const resp = await fetch(`${VAPI_BASE_URL}/assistant/${assistantId}`, {
    method: 'PATCH', headers: keyHeaders(apiKey), body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Vapi assistant güncellenemedi: ${resp.status} — ${t}`);
  }
}

function defaultRealtorPrompt(): string {
  return `[Kimlik]
Sen Keller Williams gayrimenkul ekibi adına arama yapan yapay zeka asistanısın.

[Amaç]
Mülk sahibine ücretsiz "Gayrimenkul Röntgeni" (değerleme) randevusu teklif etmek.

[Kurallar]
- Kendini kısaca tanıt, vakit uygun mu diye sor
- Ücretsiz değerleme teklif et
- Randevu almaya odaklan (belirli gün/saat önerme, müşteri söylesin)
- Maks 2 dakika konuş
- Kibar, samimi Türkçe
- Reddederse ısrar etme, teşekkür et`;
}

export async function getVapiCredit(apiKey?: string): Promise<VapiCreditInfo> {
  try {
    const key = apiKey || process.env.VAPI_API_KEY;
    if (!key) return { ok: false, error: 'API key yok' };
    const resp = await fetch(`${VAPI_BASE_URL}/subscription`, { headers: keyHeaders(key) });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const data = await resp.json() as {
      credits?: string | number;
      status?: string;
      type?: string;
      monthlyChargeSchedule?: { cost?: number };
    };
    const rawCredit = data.credits;
    const balance = typeof rawCredit === 'string' ? parseFloat(rawCredit) : (rawCredit ?? 0);
    return {
      ok: true,
      balance: Number.isFinite(balance) ? balance : 0,
      monthlyCharge: data.monthlyChargeSchedule?.cost,
      plan: data.type || data.status,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
