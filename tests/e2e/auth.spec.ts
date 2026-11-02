// Smoke testi — global-setup'ın kaydettiği storageState gerçekten oturum açık bir
// sayfa mı yüklüyor, yoksa login'e mi geri atıyor? Bu, geri kalan tüm E2E specler'in
// üzerine oturduğu temel varsayım.

import { test, expect } from '@playwright/test';

test('oturum açık kullanıcı ana sayfayı görür, login\'e atılmaz', async ({ page }) => {
  await page.goto('/');
  await expect(page).not.toHaveURL(/login\.html/);
  await expect(page.locator('.tab-btn[data-tab="live"]')).toBeVisible();
});

test('API session kontrolü giriş yapmış kullanıcıyı döner', async ({ request }) => {
  const res = await request.get('/api/auth/session');
  expect(res.ok()).toBeTruthy();
  const json = await res.json();
  expect(json.success).toBe(true);
  expect(json.data?.email).toBe(process.env.STAGING_TEST_EMAIL);
});
