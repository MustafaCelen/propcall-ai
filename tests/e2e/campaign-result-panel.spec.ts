// Sonuç paneli — randevu alınanların hızlı görünümü (ad · telefon · özet · Ara / WhatsApp).
// Gerçek arama yapılmadan: sayfadaki `campaign` durumuna tarayıcı içinden sahte bir
// randevulu kişi enjekte edilip panelin ve aksiyonların doğru çalıştığı doğrulanır.

import { test, expect } from '@playwright/test';
import { deleteCampaign, cleanupE2EDrafts, CLEAR_FOCUS_INIT } from '../helpers/apiHelpers';

test('randevu paneli: boşken gizli, randevu gelince satır + Ara/WhatsApp', async ({ page, request }) => {
  await cleanupE2EDrafts(request);
  await page.addInitScript(CLEAR_FOCUS_INIT);
  const draft = (await (await request.post('/api/campaign/load', {
    data: { contacts: [{ name: 'E2E Panel Kişi', phone: '+905551234801', region: '', notes: '', reference: '' }], maxConcurrent: 1, name: 'E2E Panel ' + Date.now() },
  })).json()).data;

  await page.goto('/');
  const tablo = page.locator('#campaignTableBody');
  await expect(tablo).toContainText('E2E Panel Kişi');
  await page.locator('.tab-btn[data-tab="campaign"]').click();

  // Taslakta randevu yok → panel gizli.
  await expect(page.locator('#campaignResultPanel')).toBeHidden();

  // Sahte sonuç: sunucunun kampanya durumu ucunu "tamamlandı + randevu" snapshot'ıyla
  // yanıtlat ve sayfayı yenile. Sayfa içi durum enjekte etmek yetmiyordu — SSE
  // bağlantısı kurulunca loadCampaignState gerçek (taslak) durumu geri yazıyordu.
  const sahteSnapshot = {
    success: true,
    data: {
      id: draft.campaignId, status: 'completed', name: 'E2E Panel', running: false, paused: false, maxConcurrent: 1,
      contacts: [{
        name: 'E2E Panel Kişi', phone: '+905551234801', region: '', notes: '', reference: '',
        status: 'tamamlandı', vapiCallId: 'call_e2e',
        result: { randevu_alindi: true, ilgi_seviyesi: 'yüksek', geri_donus_notu: 'Perşembe 14:00 ofiste' },
      }],
    },
  };
  await page.route(/\/api\/campaign(\?.*)?$/, route =>
    route.request().method() === 'GET' ? route.fulfill({ json: sahteSnapshot }) : route.continue());
  await page.reload();
  await expect(tablo).toContainText('E2E Panel Kişi');
  await page.locator('.tab-btn[data-tab="campaign"]').click();

  const panel = page.locator('#campaignResultPanel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Randevu Alınanlar (1)');
  await expect(panel).toContainText('E2E Panel Kişi');
  await expect(panel).toContainText('Perşembe 14:00 ofiste');
  await expect(panel.locator('a.crp-wa')).toHaveAttribute('href', 'https://wa.me/905551234801');

  // "📞 Ara" canlı arama formunu doldurup sekmeye geçer — arama BAŞLATMAZ.
  await panel.locator('button.crp-call').click();
  await expect(page.locator('#customerPhone')).toHaveValue('+905551234801');
  await expect(page.locator('#customerName')).toHaveValue('E2E Panel Kişi');
  await expect(page.locator('.tab-btn[data-tab="live"]')).toHaveClass(/active/);

  await deleteCampaign(request, draft.campaignId);
});
