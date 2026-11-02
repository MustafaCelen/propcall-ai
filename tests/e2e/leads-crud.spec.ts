// Adaylar (leads) CRUD akışı — UI üzerinden yeni aday oluşturma, Kanban'da görünme,
// aşama değiştirme. Sadece pure DB/UI işlemleri — hiçbir dış API'ye (Vapi/Twilio)
// dokunmaz.

import { test, expect } from '@playwright/test';
import { deleteLead } from '../helpers/apiHelpers';
import { gotoTab } from '../helpers/navigation';

test.describe('Adaylar CRUD', () => {
  test('yeni aday oluşturulup Kanban panosunda görünür', async ({ page, request }) => {
    const uniqueName = 'E2E Test ' + Date.now();

    await gotoTab(page, 'leads');
    await expect(page.locator('#tabLeads')).toHaveClass(/active/);
    await expect(page.locator('#leadsBoard')).toBeVisible();

    await page.click('#btnAddLead');
    await expect(page.locator('#leadFormModal')).toHaveClass(/open/);
    await page.fill('#leadFormFirstName', uniqueName);
    await page.fill('#leadFormPhone', '+905551234567');
    await page.click('#leadFormSave');

    await expect(page.locator('#leadFormModal')).not.toHaveClass(/open/);
    await expect(page.locator('.lead-card', { hasText: uniqueName })).toBeVisible();

    // Temizlik: UI'da oluşturulan lead'i API üzerinden bul ve sil.
    const res = await request.get('/api/leads');
    const json = await res.json();
    const created = json.data.find((l: any) => l.firstName === uniqueName);
    expect(created).toBeTruthy();
    await deleteLead(request, created.id);
  });

  test('aday aşaması Kanban sürükle-bırak yerine API ile değiştirilip UI\'da yansır', async ({ page, request }) => {
    // Sürükle-bırağı Playwright'ta güvenilir simüle etmek yerine, stage-değişiminin
    // backend'de doğru çalıştığını ve sayfa yeniden yüklenince UI'a doğru yansıdığını
    // doğruluyoruz — asıl drag-drop mekaniği değil, veri akışı test ediliyor.
    const uniqueName = 'Stage Test ' + Date.now();
    const createRes = await request.post('/api/leads', {
      data: { firstName: uniqueName, phone: '+905559876543' },
    });
    const created = (await createRes.json()).data;

    const stageRes = await request.patch(`/api/leads/${created.id}/stage`, {
      data: { stage: 'CONTACTED' },
    });
    expect(stageRes.ok()).toBeTruthy();

    await gotoTab(page, 'leads');
    await expect(page.locator('#tabLeads')).toHaveClass(/active/);
    const contactedColumn = page.locator('.lead-column[data-stage="CONTACTED"]');
    await expect(contactedColumn.locator('.lead-card', { hasText: uniqueName })).toBeVisible();

    await deleteLead(request, created.id);
  });

  test('aday etiketleri form üzerinden oluşturulup listede/drawer\'da görünür ve kaldırılabilir', async ({ page, request }) => {
    const uniqueName = 'Tag Test ' + Date.now();

    await gotoTab(page, 'leads');
    await page.click('#btnAddLead');
    await page.fill('#leadFormFirstName', uniqueName);
    await page.fill('#leadFormTags', 'sicak, yatirimci, sicak');
    await page.click('#leadFormSave');
    await expect(page.locator('#leadFormModal')).not.toHaveClass(/open/);

    const res = await request.get('/api/leads');
    const json = await res.json();
    const created = json.data.find((l: any) => l.firstName === uniqueName);
    expect(created).toBeTruthy();
    expect(created.tags.sort()).toEqual(['sicak', 'yatirimci']);

    await page.click('#btnLeadsViewList');
    await expect(page.locator('.leads-list-row', { hasText: uniqueName }).locator('.lead-tag-chip').first()).toBeVisible();

    await page.locator('.leads-list-row', { hasText: uniqueName }).locator('.leads-list-name').click();
    await expect(page.locator('#leadDrawer')).toHaveClass(/open/);
    const removeBtn = page.locator('#leadDrawerTags .lead-tag-remove[data-tag="sicak"]');
    await expect(removeBtn).toBeVisible();
    await removeBtn.click();

    await page.waitForTimeout(500);
    const afterRes = await request.get(`/api/leads`);
    const afterJson = await afterRes.json();
    const afterLead = afterJson.data.find((l: any) => l.id === created.id);
    expect(afterLead.tags).toEqual(['yatirimci']);

    await deleteLead(request, created.id);
  });
});
