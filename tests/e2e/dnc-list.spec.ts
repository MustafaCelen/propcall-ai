// Global "Beni bir daha aramayın" ret listesi (bkz. src/dncList.ts) — admin API'leri
// üzerinden ekleme/listeleme/kaldırma akışını ve arama başlatmanın (/api/call) engellendiğini
// doğrular. AI otomatik tespit tarafı (generateCallSummary → beni_aramayin_talebi) gerçek
// bir Vapi görüşmesi gerektirdiği için burada test edilmiyor — bu test sadece guard'ın
// (isPhoneBlocked → 403) ve admin CRUD'unun doğru çalıştığını doğrular.
//
// KRİTİK SIRA: numara ÖNCE ret listesine eklenir, /api/call ANCAK ondan sonra
// çağrılır. Böylece guard Vapi'ye hiç ulaşmadan 403 döner — engellenmemiş bir
// numaraya asla /api/call atılmaz (gerçek bir telefon aramasına dönüşebilirdi).

import { test, expect } from '@playwright/test';

test.describe('Global ret listesi (DNC)', () => {
  test('admin numara ekleyip listeleyip kaldırabilir, engelliyken /api/call 403 döner', async ({ request }) => {
    const phone = `+90555${Math.floor(1000000 + Math.random() * 8999999)}`;

    const addRes = await request.post('/api/admin/dnc-list', {
      data: { phone, reason: 'e2e test — manuel ekleme' },
    });
    expect(addRes.ok()).toBeTruthy();
    const afterAdd = (await addRes.json()).data;
    expect(afterAdd.some((r: any) => r.phone === phone)).toBeTruthy();

    // Şimdi engelli — /api/call'un KENDİSİ 403 dönmeli (Vapi'ye hiç gitmeden).
    const blockedRes = await request.post('/api/call', { data: { customer: { name: 'DNC Test', phone } } });
    expect(blockedRes.status()).toBe(403);
    const blockedJson = await blockedRes.json();
    expect(blockedJson.error).toContain('ret listesinde');

    const listRes = await request.get('/api/admin/dnc-list');
    const list = (await listRes.json()).data;
    const entry = list.find((r: any) => r.phone === phone);
    expect(entry).toBeTruthy();
    expect(entry.source).toBe('manual');

    // Temizlik — kaldırınca tekrar aranabilir hale gelmeli.
    const delRes = await request.delete(`/api/admin/dnc-list/${encodeURIComponent(phone)}`);
    expect(delRes.ok()).toBeTruthy();

    const afterDelRes = await request.get('/api/admin/dnc-list');
    const afterDelList = (await afterDelRes.json()).data;
    expect(afterDelList.some((r: any) => r.phone === phone)).toBeFalsy();
  });

  test('farklı formattaki aynı numara normalize edilip aynı satır sayılır', async ({ request }) => {
    const digits = `555${Math.floor(1000000 + Math.random() * 8999999)}`;
    const normalized = `+90${digits}`;
    const alternateFormat = `0${digits}`; // aynı numara, farklı yazım

    await request.post('/api/admin/dnc-list', { data: { phone: normalized } });

    const blockedRes = await request.post('/api/call', {
      data: { customer: { name: 'Normalize Test', phone: alternateFormat } },
    });
    expect(blockedRes.status()).toBe(403);

    await request.delete(`/api/admin/dnc-list/${encodeURIComponent(normalized)}`);
  });
});
