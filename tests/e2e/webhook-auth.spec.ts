// Webhook doğrulama — Vapi/Twilio'dan geliyormuş gibi görünen sahte isteklerin
// reddedildiğini doğrular. Hiçbir gövde gerçek bir aramaya/mesaja karşılık gelmez
// (uydurma call id / MessageSid), hiçbir dış API çağrılmaz.
//
//   (a) POST /webhook           — doğrulamasız eski rota kaldırıldı → 404
//   (b) POST /webhook/:userId   — X-Vapi-Secret yoksa → 401/403 (sessiz 200 değil)
//   (c) POST /webhook/whatsapp/:userId — X-Twilio-Signature yoksa → 403

import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';

const sahteEndOfCallReport = (assistantId = 'asst_e2e_sahte') => ({
  message: {
    type: 'end-of-call-report',
    endedReason: 'customer-ended-call',
    call: { id: 'call_e2e_sahte_' + Date.now(), assistantId, customer: { number: '+905550000000' } },
    transcript: 'E2E sahte transkript',
    summary: 'E2E sahte özet',
  },
});

test.describe('Webhook doğrulama', () => {
  let anon: APIRequestContext;   // oturumsuz — webhook'lar gerçek hayatta çerezsiz gelir
  let adminUserId: string;

  test.beforeAll(async ({ playwright }) => {
    const baseURL = test.info().project.use.baseURL as string;
    const storageState = test.info().project.use.storageState as string;
    const admin = await playwright.request.newContext({ baseURL, storageState });
    const sessionRes = await admin.get('/api/auth/session');
    expect(sessionRes.ok()).toBeTruthy();
    adminUserId = (await sessionRes.json()).data.id;
    expect(adminUserId).toBeTruthy();
    await admin.dispose();

    anon = await playwrightRequest.newContext({ baseURL });
  });

  test.afterAll(async () => { if (anon) await anon.dispose(); });

  test('(a) eski doğrulamasız POST /webhook rotası artık yok (404)', async () => {
    const res = await anon.post('/webhook', { data: sahteEndOfCallReport() });
    expect(res.status()).toBe(404);
  });

  test('(b) POST /webhook/:userId X-Vapi-Secret olmadan reddedilir', async () => {
    const res = await anon.post(`/webhook/${adminUserId}`, { data: sahteEndOfCallReport() });
    expect([401, 403], 'gizli anahtarsız webhook kabul edildi').toContain(res.status());
  });

  test('(b2) POST /webhook/:userId yanlış X-Vapi-Secret ile reddedilir', async () => {
    const res = await anon.post(`/webhook/${adminUserId}`, {
      data: sahteEndOfCallReport(),
      headers: { 'X-Vapi-Secret': 'e2e-yanlis-secret-' + Date.now() },
    });
    expect([401, 403], 'yanlış gizli anahtarla webhook kabul edildi').toContain(res.status());
  });

  test('(c) POST /webhook/whatsapp/:userId X-Twilio-Signature olmadan reddedilir', async () => {
    const res = await anon.post(`/webhook/whatsapp/${adminUserId}`, {
      form: {
        From: 'whatsapp:+905550000000',
        To: 'whatsapp:+905550000001',
        Body: 'E2E sahte gelen mesaj',
        MessageSid: 'SM_e2e_sahte_' + Date.now(),
        AccountSid: 'AC_e2e_sahte',
      },
    });
    expect(res.status()).toBe(403);
  });

  test('(c2) POST /webhook/whatsapp/status/:userId X-Twilio-Signature olmadan reddedilir', async () => {
    const res = await anon.post(`/webhook/whatsapp/status/${adminUserId}`, {
      form: { MessageSid: 'SM_e2e_sahte_' + Date.now(), MessageStatus: 'delivered' },
    });
    expect(res.status()).toBe(403);
  });
});
