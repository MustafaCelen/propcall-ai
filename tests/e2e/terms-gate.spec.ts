// Kullanım Koşulları gate'i — /api/terms/accept çağrıldıktan sonra kullanıcının
// termsAcceptedVersion'ının güncellendiğini ve ardından korumalı uçların (CRM,
// kampanya vb.) normal çalıştığını doğrular. Guard'ın "kabul edilmeden 403 döner"
// tarafı src/auth.ts requireUserAuth'ta kod incelemesiyle doğrulanmıştır — bunu
// canlı olarak tetiklemek staging DB'sinde kullanıcının terms durumunu elle
// sıfırlamayı gerektirir ki bu test altyapısının kasıtlı olarak sahip olmadığı
// bir DB-erişim katmanı ister (bkz. tests/playwright.config.ts dosya başı notu —
// testler sadece HTTP üzerinden staging'e konuşur).

import { test, expect } from '@playwright/test';

test.describe('Kullanım Koşulları gate', () => {
  test('terms accept çağrısı versiyonu günceller, sonrasında korumalı uçlar çalışır', async ({ request }) => {
    const acceptRes = await request.post('/api/terms/accept');
    expect(acceptRes.ok()).toBeTruthy();
    const accepted = (await acceptRes.json()).data;
    expect(accepted.termsAcceptedVersion).toBeGreaterThanOrEqual(1);

    const leadsRes = await request.get('/api/leads');
    expect(leadsRes.ok()).toBeTruthy();

    const sessionRes = await request.get('/api/auth/session');
    expect(sessionRes.ok()).toBeTruthy();
    const session = (await sessionRes.json()).data;
    expect(session.termsAcceptedVersion).toBe(accepted.termsAcceptedVersion);
  });
});
