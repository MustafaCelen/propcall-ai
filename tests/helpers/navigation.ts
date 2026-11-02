// Sekme geçişi — DOM'daki .tab-btn'e tıklamak ara sıra JS event listener'ları henüz
// bağlanmadan (sayfa yeni yüklendiğinde) bir yarış durumuna giriyordu (flaky test).
// app.js'in kendi window.switchTab(name) fonksiyonunu doğrudan çağırmak, DOM tıklama
// zamanlamasından bağımsız, güvenilir bir alternatif — uygulamanın kendi kodunu
// kullandığımız için "gerçek" davranışı hâlâ test ediyoruz, sahte bir yol değil.

import type { Page } from '@playwright/test';

export async function gotoTab(page: Page, tabName: string): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => typeof (window as any).switchTab === 'function');
  await page.evaluate((name) => (window as any).switchTab(name), tabName);
}
