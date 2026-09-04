// PropCall AI / RLM — WhatsApp (Twilio) gönderim + şablon onay akışı.
// rlm2/server/twilio-client.ts + twilio-content.ts'in doğrudan portu — aynı fetch()
// tabanlı Twilio REST çağrıları, decrypt() yerine propcall'ın decryptSecret()'i.

import { WhatsappConfig } from './users';
import { WhatsappTemplate } from './types';

function basicAuth(accountSid: string, authToken: string): string {
  return Buffer.from(`${accountSid}:${authToken}`).toString('base64');
}

export async function sendWhatsAppMessage(
  config: WhatsappConfig, to: string, body: string,
): Promise<{ sid: string }> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
  const from = config.whatsappNumber.startsWith('whatsapp:') ? config.whatsappNumber : `whatsapp:${config.whatsappNumber}`;
  const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

  const params = new URLSearchParams();
  params.append('From', from);
  params.append('To', toFormatted);
  params.append('Body', body);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(config.accountSid, config.authToken)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(err.message || `Twilio gönderim hatası: ${res.status}`);
  }
  const data: any = await res.json();
  return { sid: data.sid as string };
}

function toTwilioBody(body: string, variables: string[]): { body: string; defaults: Record<string, string> } {
  let converted = body;
  const defaults: Record<string, string> = {};
  variables.forEach((v, i) => {
    const num = String(i + 1);
    defaults[num] = v;
    converted = converted.replace(new RegExp(`\\{\\{${v}\\}\\}`, 'g'), `{{${num}}}`);
  });
  return { body: converted, defaults };
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 512);
}

export async function submitTemplateForApproval(
  config: WhatsappConfig, template: WhatsappTemplate,
): Promise<string> {
  const auth = basicAuth(config.accountSid, config.authToken);
  const { body: convertedBody, defaults } = toTwilioBody(template.body, template.variables);

  const createResp = await fetch('https://content.twilio.com/v1/Content', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      friendly_name: normalizeName(template.name),
      language: 'tr',
      variables: defaults,
      types: { 'twilio/text': { body: convertedBody } },
      approval_requests: { name: normalizeName(template.name), category: template.category.toLowerCase() },
    }),
  });

  if (!createResp.ok) {
    const err: any = await createResp.json().catch(() => ({}));
    throw new Error(err.message || `Twilio Content API hatası: ${createResp.status}`);
  }

  const created: any = await createResp.json();
  return created.sid as string;
}

export async function getApprovalStatus(
  config: WhatsappConfig, contentSid: string,
): Promise<{ status: string; rejectionReason: string | null } | null> {
  const auth = basicAuth(config.accountSid, config.authToken);
  const resp = await fetch(`https://content.twilio.com/v1/Content/${contentSid}/ApprovalRequests`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!resp.ok) return null;

  const data: any = await resp.json();
  const wa = data.whatsapp;
  if (!wa) return null;

  const raw: string = wa.status ?? 'pending';
  const status = raw === 'approved' ? 'APPROVED' : raw === 'rejected' ? 'REJECTED' : 'PENDING_APPROVAL';
  return { status, rejectionReason: wa.rejection_reason || null };
}
