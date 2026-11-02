// PropCall AI — Playwright E2E config. Testler DOĞRUDAN staging deploy'una karşı
// çalışır (yerel/dockerized bir sunucu BAŞLATMAZ) — bkz. tests/README.md'deki
// "hangi rotalar kasıtlı olarak test edilmiyor" listesi. Gerçek arama/mesaj asla
// tetiklenmez: /api/call, /api/campaign/start|resume, WhatsApp gönderim/onay
// rotaları hiçbir spec'te çağrılmaz.

import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '.env.test') });

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // aynı staging DB'sini paylaşan testler — veri çakışmasını önlemek için sıralı
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,
  globalSetup: require.resolve('./helpers/globalSetup.ts'),
  use: {
    baseURL: process.env.STAGING_URL,
    storageState: path.join(__dirname, '.auth', 'staging.json'),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
