// Toplu Arama — kampanya OLUŞTURMA (draft). KRİTİK: bu spec /api/campaign/start
// veya /resume'u ASLA çağırmaz — sadece campaignLoad() ile bir draft satırı
// oluşturur (bkz. src/server.ts:1900-1911, campaignLoad gerçek dialing başlatmaz,
// sadece campaigns tablosuna 'draft' statüsünde bir satır yazar). Gerçek bir Vapi
// araması bu dosyadaki hiçbir testte asla tetiklenmez.

import { test, expect } from '@playwright/test';
import { deleteCampaign } from '../helpers/apiHelpers';

test.describe('Toplu Arama — kampanya oluşturma (draft, başlatmadan)', () => {
  test('/api/campaign/load ile draft kampanya oluşur, listede görünür', async ({ request }) => {
    const name = 'E2E Draft Campaign ' + Date.now();
    const loadRes = await request.post('/api/campaign/load', {
      data: {
        contacts: [{ name: 'Test Contact', phone: '+905551112233', region: '', notes: '', reference: '' }],
        maxConcurrent: 1,
        name,
      },
    });
    expect(loadRes.ok()).toBeTruthy();
    const { campaignId } = (await loadRes.json()).data;
    expect(campaignId).toBeTruthy();

    const listRes = await request.get('/api/campaigns');
    const list = (await listRes.json()).data;
    const found = list.find((c: any) => c.id === campaignId);
    expect(found).toBeTruthy();
    expect(found.status).toBe('draft');
    expect(found.name).toBe(name);

    await deleteCampaign(request, campaignId);
  });

  test('boş kişi listesiyle load reddedilir', async ({ request }) => {
    const res = await request.post('/api/campaign/load', {
      data: { contacts: [], maxConcurrent: 1, name: 'Empty Test' },
    });
    expect(res.status()).toBe(400);
  });
});
