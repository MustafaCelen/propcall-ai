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
export async function createVapiCall(customer: CustomerInfo): Promise<VapiCallResponse> {
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const assistantId = process.env.VAPI_ASSISTANT_ID;

  if (!phoneNumberId) throw new Error('VAPI_PHONE_NUMBER_ID tanımlanmamış');
  if (!assistantId) throw new Error('VAPI_ASSISTANT_ID tanımlanmamış');

  const body = {
    phoneNumberId,
    assistantId,
    customer: {
      number: customer.phone,
      name: customer.name,
    },
    // Müşteri bilgilerini asistan değişkenlerine geç
    assistantOverrides: {
      variableValues: {
        customerName: customer.name,
        customerRegion: customer.region || 'belirtilmemiş',
        customerNotes: customer.notes || 'yok',
      },
    },
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
