// Kişi kartı (çekmece) arayüzü: hızlı görev ekleme ve aşama değişimi.
// LOST'a geçişte kayıp nedeni ZORUNLU — modal nedensiz onaya izin vermemeli.

import { test, expect } from '@playwright/test';
import { createTestLead, deleteLead } from '../helpers/apiHelpers';
import { openApp, switchTab, trackPageErrors } from '../helpers/ui';

test.describe('Kişi kartı çekmecesi', () => {
  test('hızlı "Görev" aksiyonu görev oluşturur', async ({ page, request }) => {
    const name = 'E2E Drawer Gorev ' + Date.now();
    const lead = await createTestLead(request, { firstName: name });
    const errors = trackPageErrors(page);
    try {
      await openApp(page);
      await switchTab(page, 'leads');
      await page.click('#btnLeadsViewList');
      await page.locator('.leads-list-row', { hasText: name }).locator('.leads-list-name').click();
      await expect(page.locator('#leadDrawer')).toHaveClass(/open/);

      await page.locator('#leadDrawerBody [data-q="task"]').click();
      await expect(page.locator('#ldMini')).toBeVisible();
      await page.fill('#ldMiniTitle', 'E2E UI görevi');
      await page.click('#ldMiniSave');

      await expect.poll(async () => {
        const list = (await (await request.get('/api/tasks?scope=upcoming')).json()).data as any[];
        const all = list.concat((await (await request.get('/api/tasks?scope=today')).json()).data || []);
        return all.some(t => t.leadId === lead.id && t.title === 'E2E UI görevi');
      }, { message: 'görev sunucuda oluşmadı', timeout: 10_000 }).toBe(true);
      expect(errors, errors.join('\n')).toEqual([]);
    } finally {
      await deleteLead(request, lead.id); // görevler lead ile birlikte silinir
    }
  });

  test('LOST aşaması: neden seçilmeden onaylanamaz, seçilince kaydedilir', async ({ page, request }) => {
    const name = 'E2E Drawer Lost ' + Date.now();
    const lead = await createTestLead(request, { firstName: name });
    try {
      await openApp(page);
      await switchTab(page, 'leads');
      await page.click('#btnLeadsViewList');
      await page.locator('.leads-list-row', { hasText: name }).locator('.leads-list-name').click();
      await expect(page.locator('#leadDrawer')).toHaveClass(/open/);

      await page.locator('#leadStageButtons .lead-drawer-stage-btn[data-stage="LOST"]').click();
      await expect(page.locator('#leadLostModal')).toHaveClass(/open/);
      await expect(page.locator('#leadLostConfirm')).toBeDisabled();

      const neden = page.locator('#leadLostReasons .lost-reason').first();
      const nedenKodu = await neden.getAttribute('data-reason');
      await neden.click();
      await expect(page.locator('#leadLostConfirm')).toBeEnabled();
      await page.fill('#leadLostNote', 'E2E ui notu');
      await page.click('#leadLostConfirm');
      await expect(page.locator('#leadLostModal')).not.toHaveClass(/open/);

      await expect.poll(async () => {
        const l = (await (await request.get(`/api/leads/${lead.id}`)).json()).data;
        return l && l.stage === 'LOST' && l.lostReason === nedenKodu;
      }, { timeout: 10_000 }).toBe(true);
    } finally {
      await deleteLead(request, lead.id);
    }
  });
});
