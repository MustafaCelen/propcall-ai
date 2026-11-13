// Tenant izolasyonu (IDOR) + rol kapıları — admin oturumuyla geçici bir "agent"
// kullanıcı açılır, ayrı bir cookie kavanozuyla (request.newContext) o kullanıcı
// olarak giriş yapılır ve:
//   (a) admin'in adayına agent'ın ID bilerek bile ulaşamadığı (GET/PATCH/DELETE),
//   (b) requireManager / requireAdmin kapılarının agent'ı reddettiği,
//   (c) role 'manager'a yükseltilince ekip görünümünün açıldığı,
//   (d) POST /api/admin/users ile 'admin' rolü verilemediği
// doğrulanır. Gerçek arama/mesaj tetiklenmez. Geçici kullanıcı afterAll'da devre
// dışı bırakılır (DELETE /api/admin/users/:id yok — PATCH isActive:false).

import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { createTestLead, deleteLead } from '../helpers/apiHelpers';

const EMAIL    = `e2e-agent-${Date.now()}@example.com`;
const PASSWORD = 'E2e-Gecici-Sifre-' + Date.now();

test.describe.configure({ mode: 'serial' });

test.describe('Tenant izolasyonu ve rol kapıları', () => {
  let admin: APIRequestContext;   // storageState'li (admin) bağlam
  let agent: APIRequestContext;   // kendi cookie kavanozu — agent oturumu
  let agentUserId: string;
  let adminLeadId: string;

  test.beforeAll(async ({ playwright }) => {
    const baseURL = test.info().project.use.baseURL as string;
    const storageState = test.info().project.use.storageState as string;
    admin = await playwright.request.newContext({ baseURL, storageState });

    // 1) Admin geçici agent kullanıcı açar.
    const createRes = await admin.post('/api/admin/users', {
      data: { email: EMAIL, password: PASSWORD, name: 'E2E Gecici Agent', role: 'agent' },
    });
    expect(createRes.status(), 'geçici agent kullanıcı oluşturulamadı').toBe(201);
    const createdUser = (await createRes.json()).data;
    agentUserId = createdUser.id;
    expect(agentUserId).toBeTruthy();
    expect(createdUser.role).toBe('agent');

    // 2) Agent olarak ayrı bağlamda giriş yap (propcall_sid çerezi bu kavanozda kalır).
    agent = await playwrightRequest.newContext({ baseURL });
    const loginRes = await agent.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
    expect(loginRes.ok(), 'agent giriş yapamadı').toBeTruthy();

    // Kullanım koşulları gate'i (requireUserAuth → terms_not_accepted 403) IDOR
    // kontrollerini anlamsız kılmasın — agent önce koşulları kabul eder, böylece
    // aşağıdaki 404/403'ler gerçekten izolasyondan gelir.
    const termsRes = await agent.post('/api/terms/accept');
    expect(termsRes.ok()).toBeTruthy();

    const session = (await (await agent.get('/api/auth/session')).json()).data;
    expect(session.id).toBe(agentUserId);
    expect(session.role).toBe('agent');

    // 3) Admin kendi tenant'ında bir aday oluşturur.
    adminLeadId = (await createTestLead(admin, { firstName: 'E2E Izolasyon Aday ' + Date.now() })).id;
  });

  test.afterAll(async () => {
    if (admin) {
      if (adminLeadId) await deleteLead(admin, adminLeadId).catch(() => {});
      if (agentUserId) await admin.patch(`/api/admin/users/${agentUserId}`, { data: { isActive: false } }).catch(() => {});
      await admin.dispose();
    }
    if (agent) await agent.dispose();
  });

  test('(a) agent başka tenant\'ın adayını ID ile okuyamaz, değiştiremez, silemez', async () => {
    const getRes = await agent.get(`/api/leads/${adminLeadId}`);
    expect([403, 404], 'agent admin adayını okuyabildi').toContain(getRes.status());

    const patchRes = await agent.patch(`/api/leads/${adminLeadId}`, { data: { firstName: 'IDOR Degistirdi' } });
    expect(patchRes.ok(), 'agent admin adayını değiştirebildi').toBeFalsy();
    expect([403, 404]).toContain(patchRes.status());

    const stageRes = await agent.patch(`/api/leads/${adminLeadId}/stage`, { data: { stage: 'CONTACTED' } });
    expect(stageRes.ok(), 'agent admin adayının aşamasını değiştirebildi').toBeFalsy();

    const delRes = await agent.delete(`/api/leads/${adminLeadId}`);
    expect(delRes.ok(), 'agent admin adayını silebildi').toBeFalsy();
    expect([403, 404]).toContain(delRes.status());

    // Admin tarafında aday hâlâ var ve dokunulmamış.
    const adminGet = await admin.get(`/api/leads/${adminLeadId}`);
    expect(adminGet.ok()).toBeTruthy();
    const lead = (await adminGet.json()).data;
    expect(lead.firstName).not.toBe('IDOR Degistirdi');
    expect(lead.stage).toBe('NEW');

    // Agent'ın kendi listesinde de görünmemeli.
    const agentList = (await (await agent.get('/api/leads')).json()).data as Array<{ id: string }>;
    expect(agentList.some(l => l.id === adminLeadId)).toBeFalsy();
  });

  test('(b) agent yönetici/admin uçlarına giremez', async () => {
    const team = await agent.get('/api/team/overview');
    expect(team.status()).toBe(403);
    expect((await team.json()).error).toBe('manager_only');

    const users = await agent.get('/api/admin/users');
    expect([401, 403]).toContain(users.status());

    const health = await agent.get('/api/admin/health');
    expect([401, 403]).toContain(health.status());

    // Admin uçlarından veri de sızmamalı.
    const createOther = await agent.post('/api/admin/users', {
      data: { email: `e2e-agent-escalation-${Date.now()}@example.com`, password: 'x'.repeat(12), role: 'agent' },
    });
    expect([401, 403]).toContain(createOther.status());
  });

  test('(c) admin agent\'ı manager yapınca ekip görünümü açılır', async () => {
    const promote = await admin.patch(`/api/admin/users/${agentUserId}`, { data: { role: 'manager' } });
    expect(promote.ok()).toBeTruthy();

    const session = (await (await agent.get('/api/auth/session')).json()).data;
    expect(session.role).toBe('manager');

    const team = await agent.get('/api/team/overview');
    expect(team.status()).toBe(200);
    expect(Array.isArray((await team.json()).data)).toBeTruthy();

    // Manager hâlâ admin değil — admin uçları kapalı kalır.
    expect([401, 403]).toContain((await agent.get('/api/admin/users')).status());
  });

  test('(d) POST /api/admin/users ile admin rolü verilemez, PATCH ile de yükseltilemez', async () => {
    const res = await admin.post('/api/admin/users', {
      data: { email: `e2e-agent-admin-${Date.now()}@example.com`, password: PASSWORD, name: 'E2E Admin Denemesi', role: 'admin' },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).success).toBeFalsy();

    const patchRes = await admin.patch(`/api/admin/users/${agentUserId}`, { data: { role: 'admin' } });
    expect(patchRes.status()).toBe(400);
  });
});
