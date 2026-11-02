// Kampanya oluşturma sırasında Türkiye telefon numarası doğrulaması.
//
// GERÇEK PROD HATASI: eski kontrol +90 ile başlayan numaralarda genel bir
// 10-15 hane aralığı kabul ediyordu. 11 haneli (bir eksik) numaralar "geçerli"
// sayılıp kampanyaya giriyor, Vapi'ye gönderilince "400 - E.164 format" hatasıyla
// ARANAMADAN başarısız oluyordu. Prod'da 82 kişi böyle kilitlenmişti — hiçbiri
// "Tekrar Dene" ile kurtarılamıyordu çünkü hata her seferinde aynen tekrarlanıyordu.
//
// Bu spec /api/campaign/load kullanır (draft oluşturur, gerçek arama BAŞLATMAZ).

import { test, expect } from '@playwright/test';
import { deleteCampaign } from '../helpers/apiHelpers';

test.describe('Kampanya oluşturma — telefon doğrulaması', () => {
  test('eksik/fazla haneli Türkiye numaraları listeye alınmaz', async ({ request }) => {
    const contacts = [
      // Gerçek prod örneği: 11 hane (bir eksik) — bug'lı.
      { name: 'Eksik Haneli', phone: '+90532237016', region: '', notes: '', reference: '' },
      // Gerçek prod örneği: 13 hane (bir fazla) — bug'lı.
      { name: 'Fazla Haneli', phone: '+9053224117174', region: '', notes: '', reference: '' },
      // Doğru: tam 12 hane.
      { name: 'Dogru Numara', phone: '+905322370016', region: '', notes: '', reference: '' },
      // Yerel format, normalize edilince 12 haneye çıkmalı — geçerli.
      { name: 'Yerel Format', phone: '05321234567', region: '', notes: '', reference: '' },
    ];

    const res = await request.post('/api/campaign/load', {
      data: { name: 'E2E Telefon Doğrulama ' + Date.now(), contacts, maxConcurrent: 1 },
    });
    expect(res.ok()).toBeTruthy();
    const json = await res.json();
    expect(json.success).toBeTruthy();

    // İki bozuk numara "geçersiz" listesine düşmeli, ismiyle raporlanmalı —
    // danışman kaç kişinin ve kimin listeye alınmadığını görmeli.
    expect(json.data.skippedInvalid).toContain('Eksik Haneli');
    expect(json.data.skippedInvalid).toContain('Fazla Haneli');
    expect(json.data.skippedInvalid.length).toBe(2);

    try {
      // Kampanyada sadece 2 geçerli kişi kalmalı.
      const detail = await (await request.get(
        '/api/campaigns/' + json.data.campaignId)).json();
      expect(detail.data.campaign.contacts.length).toBe(2);
      const names = detail.data.campaign.contacts.map((c: any) => c.name);
      expect(names).toContain('Dogru Numara');
      expect(names).toContain('Yerel Format');
    } finally {
      await deleteCampaign(request, json.data.campaignId);
    }
  });

  test('tümü geçersizse kampanya hiç oluşturulmaz', async ({ request }) => {
    const res = await request.post('/api/campaign/load', {
      data: {
        name: 'E2E Tumu Gecersiz ' + Date.now(),
        contacts: [{ name: 'Bozuk', phone: '+90532237016', region: '', notes: '', reference: '' }],
        maxConcurrent: 1,
      },
    });
    expect(res.status()).toBe(400);
    const json = await res.json();
    expect(json.success).toBeFalsy();
    expect(String(json.error)).toMatch(/geçerli.*telefon|telefon.*geçerli/i);
  });
});
