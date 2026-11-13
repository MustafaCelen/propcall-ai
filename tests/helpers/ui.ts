// Arayüz (tarayıcı) testleri için ortak yardımcılar.
//
// - trackPageErrors: sayfadaki yakalanmamış JS hatalarını (pageerror) ve console.error
//   çağrılarını toplar. Arayüz smoke testleri "ekran açıldı ama konsol hata dolu"
//   durumunu yakalasın diye her ekran geçişinden sonra boş olduğu doğrulanır.
//   Ağ kaynaklı "Failed to load resource" satırları (ör. kasıtlı 404) sayılmaz —
//   onlar API testlerinin konusu.
// - writeTempCsv: Excel/CSV yükleme akışları için geçici dosya üretir (işletim
//   sisteminin temp klasöründe; repoya girmez).

import type { Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const IGNORED = [
  /Failed to load resource/i,
  /net::ERR_/i,
  /favicon/i,
];

export function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push('pageerror: ' + err.message));
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED.some(re => re.test(text))) return;
    errors.push('console.error: ' + text);
  });
  return errors;
}

export function writeTempCsv(prefix: string, rows: string[][]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'propcall-e2e-'));
  const file = path.join(dir, prefix + '.csv');
  // UTF-8 BOM: Türkçe karakterler SheetJS'te doğru okunsun (uygulama codepage 65001 kullanır).
  const body = '﻿' + rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

// Uygulama düğme/sekme dinleyicilerini /api/auth/session yanıtından SONRA bağlar
// (switchTab fonksiyonu ise dosya yüklenir yüklenmez vardır — onu beklemek yetmez).
// Session yanıtını ve ilk ekranın (Bugün) dolmasını bekleyince kurulum bitmiştir.
export async function openApp(page: Page): Promise<void> {
  const session = page.waitForResponse(r => r.url().includes('/api/auth/session'));
  await page.goto('/');
  await session;
  await waitAppReady(page);
}

// Bugün ekranı statik "Yükleniyor…" ile gelir; o yer tutucu gidince init bitmiş,
// tüm düğme dinleyicileri (çıkış dahil) bağlanmıştır.
export async function waitAppReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById('todayRoot');
    return !!root && root.children.length > 0 && !root.querySelector('.today-loading');
  }, null, { timeout: 15_000 });
}

// Toplu Arama sekmesi açılınca uygulama "en son kampanya"yı sunucudan çeker ve form
// alanlarını (ad dahil) onunla doldurur. Bu yükleme bitmeden yazılan ad ezilir —
// danışman böyle bir hızda davranmaz, test ise davranır; o yüzden bekleriz.
export async function waitCampaignLoaded(page: Page): Promise<void> {
  await page.waitForResponse(
    r => /\/api\/campaign(\?|$)/.test(r.url()) && r.request().method() === 'GET',
    { timeout: 4_000 },
  ).catch(() => {});
  await page.waitForTimeout(300);
}

export async function switchTab(page: Page, tab: string): Promise<void> {
  await page.evaluate((name) => (window as any).switchTab(name), tab);
}
