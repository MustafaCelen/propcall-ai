// "YÜKLE = KAYDET" akışı. Excel yüklenir yüklenmez liste sunucuda 'draft' olur ve
// ekran HER ZAMAN danışmanın en son yüklediği kampanyayı gösterir — tarayıcıda
// kaydedilmemiş liste diye bir şey artık yok. Bu spec, aylarca süren "liste
// yükledim, F5 bastım, eski kampanya geldi" hatasının bir daha dönmemesini korur.
//
// KRİTİK: /api/campaign/start burada yalnızca REDDEDİLMESİ gereken (400) girdilerle
// çağrılır — campaignId'siz ve adsız. Geçerli bir başlatma asla yapılmaz, gerçek
// arama tetiklenmez.

import { test, expect } from '@playwright/test';
import { deleteCampaign, cleanupE2EDrafts, CLEAR_FOCUS_INIT } from '../helpers/apiHelpers';

const kisi = (name: string, phone: string) => ({ name, phone, region: '', notes: '', reference: '' });

test.describe('Toplu Arama — yükle = kaydet', () => {
  test('yüklenen liste sunucuda draft olur ve ekranın varsayılan kampanyası odur', async ({ request }) => {
    const name = 'E2E Yükle Kaydet ' + Date.now();
    const loadRes = await request.post('/api/campaign/load', {
      data: { contacts: [kisi('E2E Kaydet Kişi', '+905551234501')], maxConcurrent: 1, name },
    });
    expect(loadRes.ok()).toBeTruthy();
    const loaded = (await loadRes.json()).data;
    expect(loaded.campaignId).toBeTruthy();
    // Yanıt doğrudan snapshot taşır: istemci kendi kopyasını "gerçek" sanmaz.
    expect(loaded.status).toBe('draft');
    expect(loaded.contacts).toHaveLength(1);
    expect(loaded.contacts[0].phone).toBe('+905551234501');

    // campaignId VERMEDEN sorulunca sunucu "en son yüklenen"i döner — createdAt'e
    // göre. Eskiden updatedAt'e bakıyordu ve arka plandaki eski bir kampanya öne
    // geçebiliyordu; bu satır o hatanın geri dönmesini yakalar.
    const stateRes = await request.get('/api/campaign');
    const state = (await stateRes.json()).data;
    expect(state.id, 'ID\'siz /api/campaign en son yüklenen draft\'ı döndürmeli').toBe(loaded.campaignId);
    expect(state.status).toBe('draft');

    await deleteCampaign(request, loaded.campaignId);
  });

  test('yeni dosya yüklenince önceki başlatılmamış taslak çöpe gider', async ({ request }) => {
    const first = (await (await request.post('/api/campaign/load', {
      data: { contacts: [kisi('E2E Eski Taslak', '+905551234502')], maxConcurrent: 1, name: 'E2E Eski ' + Date.now() },
    })).json()).data;
    const second = (await (await request.post('/api/campaign/load', {
      data: {
        contacts: [kisi('E2E Yeni Taslak', '+905551234503')], maxConcurrent: 1,
        name: 'E2E Yeni ' + Date.now(), replaceDraftId: first.campaignId,
      },
    })).json()).data;
    expect(second.campaignId).not.toBe(first.campaignId);

    const list = (await (await request.get('/api/campaigns')).json()).data;
    expect(list.some((c: any) => c.id === first.campaignId), 'eski taslak silinmeliydi').toBeFalsy();
    expect(list.some((c: any) => c.id === second.campaignId)).toBeTruthy();

    const state = (await (await request.get('/api/campaign')).json()).data;
    expect(state.id).toBe(second.campaignId);

    await deleteCampaign(request, second.campaignId);
  });

  test('başlatma artık liste taşımaz: campaignId ve ad zorunlu', async ({ request }) => {
    const draft = (await (await request.post('/api/campaign/load', {
      data: { contacts: [kisi('E2E Başlat Kuralı', '+905551234504')], maxConcurrent: 1, name: 'E2E Kural ' + Date.now() },
    })).json()).data;

    const idsiz = await request.post('/api/campaign/start', { data: { name: 'x', contacts: [kisi('a', '+905551234505')] } });
    expect(idsiz.status(), 'campaignId olmadan başlatma kabul edildi').toBe(400);

    const adsiz = await request.post('/api/campaign/start', { data: { campaignId: draft.campaignId, name: '   ' } });
    expect(adsiz.status(), 'adsız başlatma kabul edildi').toBe(400);

    // Reddedilen çağrılar taslağa dokunmamış olmalı.
    const state = (await (await request.get('/api/campaign?campaignId=' + draft.campaignId)).json()).data;
    expect(state.status).toBe('draft');

    await deleteCampaign(request, draft.campaignId);
  });

  test('sayfa yenilenince yüklenen liste ekranda durur (tarayıcı taslağı olmadan)', async ({ page, request }) => {
    await cleanupE2EDrafts(request);
    await page.addInitScript(CLEAR_FOCUS_INIT);
    const draft = (await (await request.post('/api/campaign/load', {
      data: { contacts: [kisi('E2E Ekranda Kalan Kişi', '+905551234506')], maxConcurrent: 1, name: 'E2E Ekran ' + Date.now() },
    })).json()).data;

    // Uygulama sekme dinleyicilerini /api/auth/session yanıtından SONRA bağlıyor;
    // erken tıklama yutulur. Tablo dolana kadar beklemek, kurulumun bittiğini garantiler
    // (toContainText gizli panelde de çalışır).
    const tablo = page.locator('#campaignTableBody');
    const sekmeyeGec = async () => {
      await expect(tablo).toContainText('E2E Ekranda Kalan Kişi');
      await page.locator('.tab-btn[data-tab="campaign"]').click();
      await expect(page.getByText('E2E Ekranda Kalan Kişi')).toBeVisible();
    };

    await page.goto('/');
    // Eski tarayıcı taslağı artık yok — localStorage'da hiçbir liste tutulmamalı.
    const draftKey = await page.evaluate(() => localStorage.getItem('propcall.pendingCampaignDraft.v1'));
    expect(draftKey).toBeNull();

    await sekmeyeGec();
    await expect(page.locator('#campaignFocusNote')).toContainText('henüz başlatılmadı');
    await expect(page.locator('#btnCampaignStart')).toBeEnabled();
    await expect(page.locator('#btnCampaignStart')).toHaveText('▶ Başlat');

    // F5 — liste sunucudan geri gelir, eski kampanya değil.
    await page.reload();
    await sekmeyeGec();

    await deleteCampaign(request, draft.campaignId);
  });
});
