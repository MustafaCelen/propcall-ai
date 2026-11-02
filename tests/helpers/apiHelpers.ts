// Ortak API yardımcıları — spec'ler kendi oluşturduğu test verisini (lead, kampanya,
// akıllı plan) bu fonksiyonlarla açıp temizler. Playwright'ın APIRequestContext'i
// storageState'i (login cookie'sini) otomatik taşır, ayrıca login yapmaya gerek yok.

import type { APIRequestContext } from '@playwright/test';

export async function createTestLead(
  request: APIRequestContext, overrides: Partial<{ firstName: string; phone: string; notes: string }> = {},
): Promise<{ id: string }> {
  const res = await request.post('/api/leads', {
    data: {
      firstName: overrides.firstName ?? 'E2E Test Lead',
      phone: overrides.phone ?? `+90555${Math.floor(1000000 + Math.random() * 8999999)}`,
      notes: overrides.notes,
    },
  });
  const json = await res.json();
  if (!json.success) throw new Error('createTestLead başarısız: ' + json.error);
  return json.data;
}

export async function deleteLead(request: APIRequestContext, id: string): Promise<void> {
  await request.delete(`/api/leads/${id}`);
}

export async function deleteSmartPlan(request: APIRequestContext, id: string): Promise<void> {
  await request.delete(`/api/smart-plans/${id}`);
}

// Önceki koşularda yarıda düşen testlerin bıraktığı "E2E …" taslaklarını temizler.
// Gerekçe: storageState localStorage'ı da taşır; globalSetup sırasında yetim bir
// taslak odaklanırsa (propcall.focusedCampaignId.v1) her test o kampanyayla açılır ve
// "en son yüklenen" yerine onu görür. UI spec'leri başlarken bunu çağırır.
export async function cleanupE2EDrafts(request: APIRequestContext): Promise<number> {
  const res = await request.get('/api/campaigns').catch(() => null);
  if (!res || !res.ok()) return 0;
  const list = ((await res.json()).data || []) as Array<{ id: string; name: string; status: string }>;
  const orphans = list.filter(c => c.status === 'draft' && /^E2E /.test(c.name));
  for (const c of orphans) await request.delete(`/api/campaigns/${c.id}`).catch(() => {});
  return orphans.length;
}

// Taslak odağını sıfırlar — sayfa "danışmanın en son yüklediği" kampanyayla açılsın.
export const CLEAR_FOCUS_INIT = () => { try { localStorage.removeItem('propcall.focusedCampaignId.v1'); } catch (_) {} };

export async function deleteCampaign(request: APIRequestContext, id: string): Promise<void> {
  // Draft/tamamlanmış test kampanyaları gerçekten silinir — staging geçmişinde
  // "E2E ..." taslak çöpü birikmesin (bkz. DELETE /api/campaigns/:id, server.ts).
  await request.delete(`/api/campaigns/${id}`).catch(() => {});
}

export async function createTestScenario(
  request: APIRequestContext, name: string, systemPrompt: string,
): Promise<{ id: string }> {
  const res = await request.post('/api/scenarios', { data: { name, systemPrompt } });
  const json = await res.json();
  if (!json.success) throw new Error('createTestScenario başarısız: ' + json.error);
  return json.data;
}

export async function deleteScenario(request: APIRequestContext, id: string): Promise<void> {
  await request.delete(`/api/scenarios/${id}`);
}
