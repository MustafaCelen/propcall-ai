// Giriş/çıkış arayüz akışı. Ortak storageState'i BOZMAMAK için (çıkış sunucudaki
// oturumu siler, diğer testler aynı çerezi kullanır) bu dosya kendi tarayıcı
// bağlamında ayrıca giriş yapar.

import { test, expect } from '@playwright/test';
import { trackPageErrors, waitAppReady } from '../helpers/ui';

test.describe('Giriş / çıkış arayüzü', () => {
  // Oturumsuz bağlam
  test.use({ storageState: { cookies: [], origins: [] } });

  test('oturumsuz kullanıcı ana sayfadan giriş ekranına yönlendirilir', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('#btnLogin')).toBeVisible();
  });

  test('yanlış şifre: hata mesajı gösterilir, sayfada kalınır', async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto('/login.html');
    await page.fill('#emailInput', process.env.STAGING_TEST_EMAIL!);
    await page.fill('#pwInput', 'kesinlikle-yanlis-sifre-' + Date.now());
    await page.click('#btnLogin');
    await expect(page.locator('#loginErr')).toHaveClass(/show/);
    await expect(page.locator('#loginErr')).not.toHaveText('');
    await expect(page).toHaveURL(/login/);
    expect(errors).toEqual([]);
  });

  test('boş form: istemci tarafı doğrulama mesajı', async ({ page }) => {
    await page.goto('/login.html');
    await page.click('#btnLogin');
    await expect(page.locator('#loginErr')).toContainText('zorunlu');
  });

  test('giriş → uygulama → çıkış: tarayıcı deposu temizlenir, oturum kapanır', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('propcall_tour_app_v1', '1');
      localStorage.setItem('propcall_tour_settings_v1', '1');
    });
    await page.goto('/login.html');
    await page.fill('#emailInput', process.env.STAGING_TEST_EMAIL!);
    await page.fill('#pwInput', process.env.STAGING_TEST_PASSWORD!);
    await page.click('#btnLogin');
    await page.waitForURL(/\/$/, { timeout: 10_000 });
    await waitAppReady(page); // çıkış düğmesinin dinleyicisi session yanıtından sonra bağlanır

    // Geçmişteki "Excel başkasında göründü" olayının kökü localStorage'dı —
    // çıkışta uygulamaya ait her anahtar silinmeli.
    await page.evaluate(() => {
      localStorage.setItem('propcall.focusedCampaignId.v1', 'test-deger');
      localStorage.setItem('propcall.pendingCampaignDraft.v1', '{"x":1}');
    });
    await page.click('#btnLogout');
    await expect(page).toHaveURL(/\/login/);

    // "propcall." önekli anahtarlar veri taşır (kampanya odağı, filtreler, eski taslak);
    // "propcall_tour_*" yalnızca "turu gördü" işaretidir, kalması normaldir.
    const kalan = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('propcall.')));
    expect(kalan, 'çıkışta temizlenmemiş uygulama anahtarları').toEqual([]);

    const session = await page.request.get('/api/auth/session');
    expect(session.status()).toBe(401);

    // Geri tuşu / adres çubuğu ile korunan sayfaya dönülemez.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });
});
