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
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Vapi API hatası: ${response.status} - ${errText}`);
  }

  return response.json() as Promise<VapiCallResponse>;
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

// Vapi hesap kredisi / abonelik bilgisi
export interface VapiCreditInfo {
  ok: boolean;
  balance?: number;         // USD kredi (varsa)
  monthlyCharge?: number;   // Aylık ücret
  plan?: string;            // Plan adı
  error?: string;
}

export async function getVapiCredit(): Promise<VapiCreditInfo> {
  try {
    if (!process.env.VAPI_API_KEY) return { ok: false, error: 'VAPI_API_KEY yok' };
    const resp = await fetch(`${VAPI_BASE_URL}/subscription`, { headers: getHeaders() });
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
