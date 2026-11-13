// Toplu Arama — gerçek dosya yükleme arayüz akışı. Danışmanın yaptığı şeyin aynısı:
// dosya seç → tablo dolsun → sunucuda taslak oluşsun → özet/uyarılar görünsün.
// Başlat'a ASLA basılmaz; yalnızca etkin olduğu doğrulanır.

import { test, expect } from '@playwright/test';
import { cleanupE2EDrafts, CLEAR_FOCUS_INIT, deleteCampaign } from '../helpers/apiHelpers';
import { openApp, switchTab, trackPageErrors, waitAppReady, waitCampaignLoaded, writeTempCsv } from '../helpers/ui';

test.describe('Toplu Arama — dosya yükleme arayüzü', () => {
  test('CSV yüklenir: tablo dolar, numaralar normalize edilir, bozuk satır atlanır, sunucuda taslak oluşur', async ({ page, request }) => {
    await cleanupE2EDrafts(request);
    await page.addInitScript(CLEAR_FOCUS_INIT);
    const errors = trackPageErrors(page);
    const name = 'E2E UI Yükleme ' + Date.now();
    const file = writeTempCsv('liste', [
      ['Ad Soyad', 'Telefon', 'Bölge', 'Not'],
      ['E2E Ui Bir',  '0532 111 22 33', 'Kadıköy', 'ilk'],
      ['E2E Ui İki',  '532-444-55-66',  'Beşiktaş', ''],
      ['E2E Ui Üç',   '+90 533 777 88 99', '', ''],
      ['Bozuk Satır', '123', '', ''],
    ]);

    await openApp(page);
    await switchTab(page, 'campaign');
    await waitCampaignLoaded(page);
    await page.fill('#campaignName', name);
    await page.setInputFiles('#campaignFile', file);
    // Yükleme = kaydet: sunucuya POST /api/campaign/load gider.
    await page.waitForResponse(r => r.url().includes('/api/campaign/load') && r.request().method() === 'POST');

    const ozet = page.locator('#campaignImportSummary');
    await expect(ozet).toBeVisible({ timeout: 15_000 });
    await expect(ozet).toContainText('3 kişi yüklendi');
    await expect(ozet).toContainText('1 kayıt atlandı');

    const tablo = page.locator('#campaignTableBody');
    await expect(tablo).toContainText('E2E Ui Bir');
    await expect(tablo).toContainText('+905321112233');
    await expect(tablo).toContainText('+905324445566');
    await expect(tablo).toContainText('+905337778899');
    await expect(tablo).not.toContainText('Bozuk Satır');

    await expect(page.locator('#campaignFocusNote')).toContainText('henüz başlatılmadı');
    await expect(page.locator('#btnCampaignStart')).toBeEnabled();

    // Sunucu tarafı: taslak gerçekten kaydedildi ve adı tarayıcıdaki ile aynı.
    const list = (await (await request.get('/api/campaigns')).json()).data as any[];
    const draft = list.find(c => c.name === name);
    expect(draft, 'yüklenen liste sunucuda taslak olarak bulunamadı').toBeTruthy();
    expect(draft.status).toBe('draft');
    const state = (await (await request.get('/api/campaign?campaignId=' + draft.id)).json()).data;
    expect(state.contacts).toHaveLength(3);

    // F5 sonrası aynı liste ekranda (tarayıcı deposu olmadan).
    await page.reload();
    await waitAppReady(page);
    await switchTab(page, 'campaign');
    await expect(page.locator('#campaignTableBody')).toContainText('E2E Ui Bir', { timeout: 15_000 });

    expect(errors, errors.join('\n')).toEqual([]);
    await deleteCampaign(request, draft.id);
  });

  test('"Telefon" sütunu olmayan dosya: kullanıcı uyarılır ama akış kırılmaz', async ({ page, request }) => {
    await cleanupE2EDrafts(request);
    await page.addInitScript(CLEAR_FOCUS_INIT);
    const name = 'E2E UI Basliksiz ' + Date.now();
    const file = writeTempCsv('basliksiz', [
      ['E2E Ui Basliksiz Kisi', '05421234567'],
    ]);
    await openApp(page);
    await switchTab(page, 'campaign');
    await waitCampaignLoaded(page);
    await page.fill('#campaignName', name);
    await page.setInputFiles('#campaignFile', file);

    await expect(page.locator('#toastContainer')).toContainText('sütunu bulunamadı');
    await expect(page.locator('#campaignTableBody')).toContainText('E2E Ui Basliksiz Kisi');

    const list = (await (await request.get('/api/campaigns')).json()).data as any[];
    const draft = list.find(c => c.name === name);
    expect(draft).toBeTruthy();
    await deleteCampaign(request, draft.id);
  });

  test('hiç geçerli numara yoksa taslak oluşmaz, hata gösterilir', async ({ page, request }) => {
    await cleanupE2EDrafts(request);
    await page.addInitScript(CLEAR_FOCUS_INIT);
    const before = ((await (await request.get('/api/campaigns')).json()).data as any[]).length;
    const file = writeTempCsv('bos', [
      ['Ad', 'Telefon'],
      ['Kimse', 'abc'],
      ['Kimse 2', ''],
    ]);
    await openApp(page);
    await switchTab(page, 'campaign');
    await page.setInputFiles('#campaignFile', file);
    await expect(page.locator('#toastContainer')).toContainText('Geçerli telefon bulunamadı');
    const after = ((await (await request.get('/api/campaigns')).json()).data as any[]).length;
    expect(after).toBe(before);
  });
});
