// Senaryo yönetimi arayüzü: modal → yeni senaryo → kaydet → kampanya seçim
// listesinde görünsün → sil. (Prompt üretici / ses önizleme çağrılmaz.)

import { test, expect } from '@playwright/test';
import { openApp, switchTab, trackPageErrors } from '../helpers/ui';

test('senaryo arayüzden eklenir, seçim listesine düşer ve silinir', async ({ page, request }) => {
  const name = 'E2E UI Senaryo ' + Date.now();
  const errors = trackPageErrors(page);
  let id: string | undefined;
  try {
    await openApp(page);
    await switchTab(page, 'live'); // senaryo yönetimi düğmesi Canlı Görüşme ekranında
    await page.click('#btnManageScenarios');
    await expect(page.locator('#scenarioModal')).toHaveClass(/open/);
    await page.locator('#scenarioList .btn-sc-new').click();
    await expect(page.locator('#scenarioForm')).toBeVisible();

    // Ad/prompt boşken kaydetme reddedilmeli.
    await page.fill('#scenarioName', name);
    await page.fill('#scenarioPrompt', '');
    await page.click('#btnScenarioSave');
    await expect(page.locator('#toastContainer')).toContainText('zorunlu');

    await page.fill('#scenarioPrompt', 'Sen bir emlak danışmanısın. E2E test promptu.');
    await page.click('#btnScenarioSave');
    await expect(page.locator('#toastContainer')).toContainText('Senaryo eklendi');
    await expect(page.locator('#scenarioList .sc-item', { hasText: name })).toBeVisible();

    const list = (await (await request.get('/api/scenarios')).json()).data as any[];
    const created = list.find(s => s.name === name);
    expect(created).toBeTruthy();
    id = created.id;

    // Kampanya ekranındaki senaryo seçim listesi de güncellenmiş olmalı.
    await expect(page.locator('#campaignScenario option', { hasText: name })).toHaveCount(1);

    // Arayüzden sil (uiConfirm → onay düğmesi).
    await page.locator(`#scenarioList .btn-sc-del[data-id="${id}"]`).click();
    await page.getByRole('button', { name: /Evet, sil/ }).click();
    await expect(page.locator('#scenarioList .sc-item', { hasText: name })).toHaveCount(0);
    const after = (await (await request.get('/api/scenarios')).json()).data as any[];
    expect(after.some(s => s.id === id)).toBe(false);
    id = undefined;
    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    if (id) await request.delete('/api/scenarios/' + id);
  }
});
