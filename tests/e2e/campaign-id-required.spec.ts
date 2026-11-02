// Kampanyayı DEĞİŞTİREN uçlarda campaignId zorunlu.
//
// Gönderilmezse sunucu "en son güncellenen kampanya"ya düşüyordu (resolveEntry
// fallback'i) — yani eski bir sekme ya da hatalı bir istek YANLIŞ kampanyayı
// durdurabilirdi. campaignStop bekleyen HERKESİ 'başarısız' işaretlediği için
// bunun bedeli binlerce kişinin kilitlenmesi olurdu.
//
// Gerçek arama tetiklenmez: sadece ID'siz istekler gönderilir, hepsi 400 dönmeli.

import { test, expect } from '@playwright/test';

test.describe('Kampanya uçlarında kimlik zorunluluğu', () => {
  const yikiciUclar = [
    '/api/campaign/stop',
    '/api/campaign/pause',
    '/api/campaign/retry-failed',
  ];

  for (const uc of yikiciUclar) {
    test(`${uc} campaignId olmadan reddedilir`, async ({ request }) => {
      // Boş gövde — campaignId hiç yok
      const bos = await request.post(uc, { data: {} });
      expect(bos.status(), `${uc} ID'siz isteği kabul etti`).toBe(400);

      // Açıkça null/boş string gönderilse de reddedilmeli
      const bosString = await request.post(uc, { data: { campaignId: '' } });
      expect(bosString.status(), `${uc} boş ID'yi kabul etti`).toBe(400);

      // Hata mesajı kullanıcıya ne yapacağını söylemeli
      const json = await bos.json();
      expect(json.success).toBeFalsy();
      expect(String(json.error)).toMatch(/kampanya|yenile/i);
    });
  }

  test('DELETE /api/campaign campaignId olmadan reddedilir', async ({ request }) => {
    // Bu uc campaignClear cagiriyor; o da calisan kampanyayi DURDURUR.
    // Query string ile gelir (govde degil) — koruma ikisini de kapsamali.
    const bos = await request.delete('/api/campaign');
    expect(bos.status(), "ID'siz silme isteği kabul edildi").toBe(400);

    const bosString = await request.delete('/api/campaign?campaignId=');
    expect(bosString.status(), 'boş ID kabul edildi').toBe(400);
  });
});
