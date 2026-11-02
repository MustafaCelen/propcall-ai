// Playwright global-setup — login formunu bir kez doldurup propcall_sid cookie'sini
// tests/.auth/staging.json'a kaydeder. Her spec dosyası bu storageState'i yeniden
// kullanır (playwright.config.ts'teki use.storageState) — her testte tekrar login
// yapmaz, hızlı ve staging'in login rate limiter'ını (loginLimiter, src/server.ts)
// gereksiz yormaz.

import { chromium, FullConfig } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env.test') });

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = process.env.STAGING_URL;
  const email = process.env.STAGING_TEST_EMAIL;
  const password = process.env.STAGING_TEST_PASSWORD;
  if (!baseURL || !email || !password) {
    throw new Error('tests/.env.test eksik — STAGING_URL/STAGING_TEST_EMAIL/STAGING_TEST_PASSWORD gerekli');
  }

  const authDir = path.join(__dirname, '..', '.auth');
  fs.mkdirSync(authDir, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL });
  // Onboarding tur overlay'i (index.html/settings.html) sayfa açılır açılmaz
  // "tanışma turu"nu başlatıp #leadsBoard gibi elemanları görsel olarak kaplıyor —
  // localStorage'a "zaten görüldü" işareti koyup bunu daha ilk navigasyondan
  // önce engelliyoruz, storageState'e de bu haliyle kaydediliyor.
  await page.addInitScript(() => {
    localStorage.setItem('propcall_tour_app_v1', '1');
    localStorage.setItem('propcall_tour_settings_v1', '1');
  });
  await page.goto('/login.html');
  await page.fill('#emailInput', email);
  await page.fill('#pwInput', password);
  await page.click('#btnLogin');
  // Giriş başarılıysa login.html kendi JS'iyle '/' adresine yönlendirir
  // (public/login.html:64) — session cookie'sinin set edildiğinden emin olmak
  // için bu yönlendirmeyi bekle.
  await page.waitForURL(baseURL + '/', { timeout: 10_000 });

  // Kullanım Koşulları gate'i (bkz. src/auth.ts requireUserAuth, public/terms.js) —
  // gerçek danışman akışıyla aynı: onaylamadan diğer TÜM /api/* uçları 403 döner.
  // Testler bu onayı zaten verilmiş varsayıp asıl özellik akışlarına odaklanır —
  // gate'in kendisi ayrı, özel bir testte (terms.spec.ts) doğrulanır.
  await page.request.post('/api/terms/accept');

  await page.context().storageState({ path: path.join(authDir, 'staging.json') });
  await browser.close();
}
