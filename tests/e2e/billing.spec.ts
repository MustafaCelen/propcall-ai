// Jeton (TL bakiyesi) — para işlemi olduğu için regresyon en pahalıya patlayan alan.
// Testler bakiyeyi DEĞİŞTİRİR ama her zaman geri alır (ekle → doğrula → geri al),
// böylece staging bakiyesi test sonunda başladığı yere döner.
// Gerçek arama/ödeme tetiklenmez: /api/call ve Fonzip uçları hiç çağrılmaz.

import { test, expect } from '@playwright/test';

async function getBalance(request: any): Promise<number> {
  const res = await request.get('/api/billing');
  expect(res.ok()).toBeTruthy();
  const json = await res.json();
  expect(json.success).toBeTruthy();
  return json.data.balanceTry;
}

async function getOwnUserId(request: any): Promise<string> {
  const res = await request.get('/api/auth/session');
  expect(res.ok()).toBeTruthy();
  return (await res.json()).data.id;
}

test.describe('Jeton / bakiye', () => {
  test('/api/billing bakiye, dakika ücreti ve hareketleri döner', async ({ request }) => {
    const res = await request.get('/api/billing');
    expect(res.ok()).toBeTruthy();
    const { data } = await res.json();

    expect(typeof data.balanceTry).toBe('number');
    expect(Number.isFinite(data.balanceTry)).toBeTruthy();
    // Dakika ücreti ücretlendirmenin temeli — sıfır/negatif olursa arama bedava olurdu.
    expect(data.ratePerMinute).toBeGreaterThan(0);
    expect(Array.isArray(data.transactions)).toBeTruthy();
  });

  test('bakiye ekleme hareketi yazar ve geri alınabilir', async ({ request }) => {
    const userId = await getOwnUserId(request);
    const before = await getBalance(request);
    const note = 'E2E bakiye testi ' + Date.now();

    const addRes = await request.post(`/api/admin/users/${userId}/balance`, {
      data: { amount: 7, note },
    });
    expect(addRes.ok()).toBeTruthy();
    expect((await addRes.json()).success).toBeTruthy();

    const afterAdd = await getBalance(request);
    expect(afterAdd).toBeCloseTo(before + 7, 2);

    // Hareket kaydı listede görünmeli — bakiye değişti ama iz bırakmadıysa
    // muhasebe tutmaz.
    const billing = await (await request.get('/api/billing')).json();
    expect(billing.data.transactions.some((t: any) => t.note === note)).toBeTruthy();

    // Geri al — staging bakiyesini başladığı yere döndür.
    const undoRes = await request.post(`/api/admin/users/${userId}/balance`, {
      data: { amount: -7, note: note + ' (geri alma)' },
    });
    expect(undoRes.ok()).toBeTruthy();
    expect(await getBalance(request)).toBeCloseTo(before, 2);
  });

  test('geçersiz tutarlar reddedilir (0, sayı olmayan, üst sınır aşımı)', async ({ request }) => {
    const userId = await getOwnUserId(request);
    const before = await getBalance(request);

    for (const amount of [0, 'abc', 1_000_001, -1_000_001]) {
      const res = await request.post(`/api/admin/users/${userId}/balance`, {
        data: { amount, note: 'E2E gecersiz tutar' },
      });
      expect(res.status(), `tutar=${amount} reddedilmeliydi`).toBe(400);
    }

    // Hiçbiri bakiyeye dokunmamış olmalı.
    expect(await getBalance(request)).toBeCloseTo(before, 2);
  });

  test('var olmayan kullanıcıya bakiye yüklenemez', async ({ request }) => {
    const res = await request.post('/api/admin/users/usr_boyle_bir_kullanici_yok/balance', {
      data: { amount: 5, note: 'E2E olmayan kullanici' },
    });
    expect(res.ok()).toBeFalsy();
  });
});
