// Tekrar arama (reattempt) kuralı — tek kural, sektör standardı varsayılanı:
// "cevapsız/meşgul → 2 saat sonra 1 kez daha" (retryMaxAttempts=2 toplam deneme,
// retryDelayMinutes=120). Bu spec varsayılanın, açık seçimin ve sınırların sunucuda
// korunduğunu doğrular. Gerçek arama BAŞLATILMAZ — yalnızca /api/campaign/load (draft).

import { test, expect } from '@playwright/test';
import { deleteCampaign } from '../helpers/apiHelpers';

const kisi = { name: 'E2E Reattempt', phone: '+905551234601', region: '', notes: '', reference: '' };

test.describe('Tekrar arama kuralı', () => {
  test('hiç ayar verilmezse varsayılan: 2 saat sonra 1 kez daha', async ({ request }) => {
    const d = (await (await request.post('/api/campaign/load', {
      data: { contacts: [kisi], maxConcurrent: 1, name: 'E2E Reattempt Varsayılan ' + Date.now() },
    })).json()).data;
    expect(d.retryMaxAttempts, 'toplam deneme (1 ilk + 1 tekrar)').toBe(2);
    expect(d.retryDelayMinutes, 'bekleme dakikası').toBe(120);
    await deleteCampaign(request, d.campaignId);
  });

  test('"tekrar arama yok" seçimi (1) korunur, varsayılana ezilmez', async ({ request }) => {
    const d = (await (await request.post('/api/campaign/load', {
      data: { contacts: [kisi], maxConcurrent: 1, name: 'E2E Reattempt Yok ' + Date.now(), retryMaxAttempts: 1, retryDelayMinutes: 30 },
    })).json()).data;
    expect(d.retryMaxAttempts).toBe(1);
    expect(d.retryDelayMinutes).toBe(30);
    await deleteCampaign(request, d.campaignId);
  });

  test('sınır dışı değerler güvenli aralığa sıkıştırılır', async ({ request }) => {
    const d = (await (await request.post('/api/campaign/load', {
      data: { contacts: [kisi], maxConcurrent: 1, name: 'E2E Reattempt Clamp ' + Date.now(), retryMaxAttempts: 99, retryDelayMinutes: 999999 },
    })).json()).data;
    expect(d.retryMaxAttempts).toBe(5);
    expect(d.retryDelayMinutes).toBe(1440);
    await deleteCampaign(request, d.campaignId);
  });
});
