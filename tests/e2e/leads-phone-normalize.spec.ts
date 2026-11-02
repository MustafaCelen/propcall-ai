// Aday telefon normalizasyonu — aynı kişinin FARKLI yazım biçimiyle ikinci kez
// CRM'e girmesini önleyen mantık. Gerçek bug'dı: CSV'den "0555..." gelen satır,
// DB'de "+90555..." olarak duran adayla eşleşmiyor, aynı kişi için ikinci bir
// aday açılıyordu (danışman aynı ismi iki kez görüyordu).
// Gerçek arama/mesaj tetiklenmez.

import { test, expect } from '@playwright/test';
import { deleteLead } from '../helpers/apiHelpers';

test.describe('Aday telefon normalizasyonu', () => {
  test('elle eklenen aday E.164 biçiminde saklanır', async ({ request }) => {
    const son7 = String(Math.floor(1000000 + Math.random() * 8999999));
    const hamFormat = '0555' + son7;          // danışmanın yazdığı biçim
    const beklenen  = '+90555' + son7;        // saklanması gereken biçim

    const res = await request.post('/api/leads', {
      data: { firstName: 'E2E Normalize ' + son7, phone: hamFormat },
    });
    expect(res.ok()).toBeTruthy();
    const lead = (await res.json()).data;

    try {
      // Aramalar E.164 kaydediliyor; aday da aynı biçimde olmalı ki arama sonucu
      // varyant aramasına muhtaç kalmadan doğru adaya eşleşsin.
      expect(lead.phone).toBe(beklenen);
    } finally {
      await deleteLead(request, lead.id);
    }
  });

  test('farklı yazım biçimi çakışma olarak tespit edilir, ikinci aday açılmaz', async ({ request }) => {
    const son7 = String(Math.floor(1000000 + Math.random() * 8999999));
    const e164 = '+90555' + son7;
    const yerel = '0555' + son7;   // AYNI numara, farklı yazım

    const createRes = await request.post('/api/leads', {
      data: { firstName: 'E2E Cakisma Orijinal ' + son7, phone: e164 },
    });
    expect(createRes.ok()).toBeTruthy();
    const original = (await createRes.json()).data;

    try {
      // İçe aktarma önizlemesi: yerel biçimli satır, mevcut adayla ÇAKIŞMALI.
      const previewRes = await request.post('/api/leads/import/preview', {
        data: { rows: [{ name: 'E2E Cakisma Yeni', phone: yerel }] },
      });
      expect(previewRes.ok()).toBeTruthy();
      const preview = (await previewRes.json()).data;

      expect(preview.conflicts.length,
        'yerel biçimli numara mevcut E.164 adayla çakışmalıydı').toBe(1);
      expect(preview.newRows.length,
        'çakışan satır "yeni aday" sayılmamalıydı').toBe(0);
      expect(preview.conflicts[0].existingLead.id).toBe(original.id);
    } finally {
      await deleteLead(request, original.id);
    }
  });
});
