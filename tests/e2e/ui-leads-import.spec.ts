// Kişiler — dosyadan içe aktarma arayüzü: dosya seç → çakışma önizlemesi → onayla.
// Var olan bir kişiyle aynı numara "çakışma" olarak gösterilmeli ve varsayılan
// davranış (atla) mevcut kaydı bozmamalı.

import { test, expect } from '@playwright/test';
import { createTestLead, deleteLead } from '../helpers/apiHelpers';
import { openApp, switchTab, trackPageErrors, writeTempCsv } from '../helpers/ui';

test('kişi listesi dosyadan içe aktarılır, çakışma gösterilir, yeni kayıtlar eklenir', async ({ page, request }) => {
  const stamp = Date.now();
  const mevcutTel = '+90555' + String(stamp).slice(-7);
  const mevcut = await createTestLead(request, { firstName: 'E2E Import Mevcut ' + stamp, phone: mevcutTel });
  const errors = trackPageErrors(page);
  const file = writeTempCsv('kisiler', [
    ['Ad', 'Telefon', 'Not'],
    ['E2E Import Yeni A ' + stamp, '0544' + String(stamp).slice(-7), 'a'],
    ['E2E Import Yeni B ' + stamp, '0545' + String(stamp).slice(-7), 'b'],
    ['E2E Import Cakisan ' + stamp, mevcutTel, 'çakışma'],
  ]);
  const olusanIdler: string[] = [mevcut.id];

  try {
    await openApp(page);
    await switchTab(page, 'leads');
    await page.setInputFiles('#leadImportFile', file);

    const modal = page.locator('#leadImportModal');
    await expect(modal).toHaveClass(/open/);
    await expect(page.locator('#leadImportSummary')).toContainText('2 yeni aday eklenecek', { timeout: 15_000 });
    await expect(page.locator('#leadImportSummary')).toContainText('1 çakışma');
    await expect(page.locator('#leadImportConfirm')).toBeVisible();

    await page.click('#leadImportConfirm');
    await expect(modal).not.toHaveClass(/open/);

    // "Ad" sütunu ad/soyad olarak bölünür — eşleşmeyi normalize edilmiş telefonla yap.
    const leads = (await (await request.get('/api/leads')).json()).data as any[];
    const a = leads.find(l => l.phone === '+90544' + String(stamp).slice(-7));
    const b = leads.find(l => l.phone === '+90545' + String(stamp).slice(-7));
    expect(a, 'A eklenmedi').toBeTruthy();
    expect(b, 'B eklenmedi').toBeTruthy();
    olusanIdler.push(a.id, b.id);
    expect((a.firstName + ' ' + (a.lastName || '')).trim()).toBe('E2E Import Yeni A ' + stamp);

    // Çakışan satır varsayılanla atlandı: mevcut kayıt olduğu gibi, kopya yok.
    const ayniTel = leads.filter(l => l.phone === mevcutTel);
    expect(ayniTel).toHaveLength(1);
    expect(ayniTel[0].firstName).toBe('E2E Import Mevcut ' + stamp);

    // Kanban'da yeni kişi görünür.
    await expect(page.locator('.lead-card', { hasText: String(stamp) }).first()).toBeVisible();
    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    for (const id of olusanIdler) await deleteLead(request, id);
  }
});
