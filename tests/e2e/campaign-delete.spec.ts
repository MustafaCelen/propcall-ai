// Kampanya silme — DELETE /api/campaigns/:id.
// KRİTİK: bu spec gerçek arama BAŞLATMAZ (campaign/start|resume çağrılmaz), sadece
// draft kampanya açıp siler. Çalışan kampanyanın silinemediği de doğrulanır.

import { test, expect } from '@playwright/test';

test.describe('Kampanya silme', () => {
  test('draft kampanya silinir ve listeden kalkar', async ({ request }) => {
    const name = 'E2E Silme Testi ' + Date.now();
    const loadRes = await request.post('/api/campaign/load', {
      data: {
        contacts: [{ name: 'Silme Test', phone: '+905559998877', region: '', notes: '', reference: '' }],
        maxConcurrent: 1,
        name,
      },
    });
    expect(loadRes.ok()).toBeTruthy();
    const campaignId = (await loadRes.json()).data.campaignId;
    expect(campaignId).toBeTruthy();

    // Listede görünüyor
    const before = (await (await request.get('/api/campaigns')).json()).data;
    expect(before.some((c: any) => c.id === campaignId)).toBeTruthy();

    // Sil
    const delRes = await request.delete('/api/campaigns/' + campaignId);
    expect(delRes.ok()).toBeTruthy();
    expect((await delRes.json()).success).toBeTruthy();

    // Artık listede yok
    const after = (await (await request.get('/api/campaigns')).json()).data;
    expect(after.some((c: any) => c.id === campaignId)).toBeFalsy();
  });

  test('var olmayan kampanya silinmeye çalışılırsa 404 döner', async ({ request }) => {
    const res = await request.delete('/api/campaigns/camp_yok_boyle_bir_kayit');
    expect(res.status()).toBe(404);
    expect((await res.json()).success).toBeFalsy();
  });
});
