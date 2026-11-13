// Mobil görünüm (390px, iPhone boyu). Danışmanlar sahada telefondan bakar:
// menü çekmecesi açılmalı, sekme geçişi çalışmalı, sayfa yatay taşmamalı.

import { test, expect } from '@playwright/test';
import { openApp, trackPageErrors } from '../helpers/ui';

test.describe('Mobil görünüm', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('menü çekmecesi açılır, sekme değişir, yatay taşma yoktur', async ({ page }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    const toggle = page.locator('#btnLeftToggle');
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.locator('#rail')).toHaveClass(/open/);
    await page.locator('#rail .tab-btn[data-tab="leads"]').click();
    await expect(page.locator('#tabLeads')).toHaveClass(/active/);
    await expect(page.locator('#rail')).not.toHaveClass(/open/);

    for (const tab of ['today', 'campaign', 'stats']) {
      await toggle.click();
      await page.locator(`#rail .tab-btn[data-tab="${tab}"]`).click();
      const tasma = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(tasma, tab + ' sekmesinde yatay taşma').toBeLessThanOrEqual(1);
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('giriş sayfası mobilde kullanılabilir', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    await page.goto('/login.html');
    await expect(page.locator('#emailInput')).toBeVisible();
    await expect(page.locator('#btnLogin')).toBeVisible();
    const tasma = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(tasma).toBeLessThanOrEqual(1);
    await ctx.close();
  });
});
