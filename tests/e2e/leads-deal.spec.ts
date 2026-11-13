// CRM Faz 2 — fırsat alanları, 6 aşamalı huni, kayıp nedeni, eski aşama kodu uyumu.
// Sadece API sözleşmesi (UI ayrıca leads-crud.spec.ts'te).
import { test, expect } from '@playwright/test';
import { deleteLead } from '../helpers/apiHelpers';

test.describe('Fırsat alanları ve huni (CRM Faz 2)', () => {
  test('fırsat alanlarıyla oluştur → güncelle → sayı alanları temizlenir', async ({ request }) => {
    const phone = `+90555${Math.floor(1000000 + Math.random() * 8999999)}`;
    const created = await request.post('/api/leads', {
      data: {
        firstName: 'Fırsat', lastName: 'Testi', phone,
        dealType: 'SELLER', propertyType: '3+1 daire', propertyLocation: 'Bahçelievler',
        propertyM2: '120', priceExpectation: '5.250.000', authority: 'EXCLUSIVE',
      },
    });
    expect(created.status()).toBe(201);
    const lead = (await created.json()).data;
    try {
      expect(lead.stage).toBe('NEW');
      expect(lead.dealType).toBe('SELLER');
      expect(lead.propertyM2).toBe(120);
      expect(lead.priceExpectation).toBe(5250000);
      expect(lead.authority).toBe('EXCLUSIVE');

      const patched = await request.patch(`/api/leads/${lead.id}`, { data: { dealType: 'BUYER', priceExpectation: null } });
      expect(patched.ok()).toBeTruthy();
      const after = (await patched.json()).data;
      expect(after.dealType).toBe('BUYER');
      expect(after.priceExpectation).toBeNull();
      expect(after.propertyType).toBe('3+1 daire'); // dokunulmayan alan korunur

      expect((await request.patch(`/api/leads/${lead.id}`, { data: { dealType: 'BOGUS' } })).status()).toBe(400);
      expect((await request.patch(`/api/leads/${lead.id}`, { data: { propertyM2: 'abc' } })).status()).toBe(400);
    } finally {
      await deleteLead(request, lead.id);
    }
  });

  test('LOST kayıp nedeni ister; neden aktiviteye yazılır; geri alınca temizlenir', async ({ request }) => {
    const lead = (await (await request.post('/api/leads', { data: { firstName: 'Kayıp', lastName: 'Testi' } })).json()).data;
    try {
      const noReason = await request.patch(`/api/leads/${lead.id}/stage`, { data: { stage: 'LOST' } });
      expect(noReason.status()).toBe(400);
      expect((await noReason.json()).code).toBe('LOST_REASON_REQUIRED');

      const lost = await request.patch(`/api/leads/${lead.id}/stage`, { data: { stage: 'LOST', lostReason: 'PRICE', lostNote: 'çok yüksek' } });
      expect(lost.ok()).toBeTruthy();
      const lostLead = (await lost.json()).data;
      expect(lostLead.stage).toBe('LOST');
      expect(lostLead.lostReason).toBe('PRICE');

      const acts = (await (await request.get(`/api/leads/${lead.id}/activities`)).json()).data;
      const change = acts.find((a: any) => a.type === 'STAGE_CHANGE' && a.data.to === 'LOST');
      expect(change?.data.lostReason).toBe('PRICE');
      expect(change?.data.from).toBe('NEW');

      const back = (await (await request.patch(`/api/leads/${lead.id}/stage`, { data: { stage: 'CONTACTED' } })).json()).data;
      expect(back.stage).toBe('CONTACTED');
      expect(back.lostReason).toBeNull();
    } finally {
      await deleteLead(request, lead.id);
    }
  });

  test('eski aşama kodları yeni huniye çevrilir (QUALIFIED→MEETING, OFFER→AGREEMENT)', async ({ request }) => {
    const lead = (await (await request.post('/api/leads', { data: { firstName: 'Göç', lastName: 'Testi' } })).json()).data;
    try {
      const a = (await (await request.patch(`/api/leads/${lead.id}/stage`, { data: { stage: 'QUALIFIED' } })).json()).data;
      expect(a.stage).toBe('MEETING');
      const b = (await (await request.patch(`/api/leads/${lead.id}/stage`, { data: { stage: 'OFFER' } })).json()).data;
      expect(b.stage).toBe('AGREEMENT');
      expect((await request.patch(`/api/leads/${lead.id}/stage`, { data: { stage: 'NOPE' } })).status()).toBe(400);
    } finally {
      await deleteLead(request, lead.id);
    }
  });
});
