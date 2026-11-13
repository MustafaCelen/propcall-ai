// CRM Faz 4 — huni raporu, ekip görünümü (rol kapısı), sabah özeti metni, ayar alanı.
import { test, expect } from '@playwright/test';
import { deleteLead } from '../helpers/apiHelpers';

test.describe('Huni raporu ve ekip', () => {
  test('huni raporu: oluşturulan + aşamaya ulaşan + kayıp nedeni sayılır', async ({ request }) => {
    const lead = (await (await request.post('/api/leads', { data: { firstName: 'Huni', lastName: 'Testi', dealType: 'SELLER' } })).json()).data;
    try {
      await request.patch(`/api/leads/${lead.id}/stage`, { data: { stage: 'MEETING' } });
      await request.patch(`/api/leads/${lead.id}/stage`, { data: { stage: 'LOST', lostReason: 'OTHER_AGENT' } });

      const r = await request.get('/api/reports/funnel?days=7');
      expect(r.ok()).toBeTruthy();
      const d = (await r.json()).data;
      expect(d.days).toBe(7);
      expect(d.created).toBeGreaterThanOrEqual(1);
      expect(d.reached.MEETING).toBeGreaterThanOrEqual(1);
      expect(d.reached.LOST).toBeGreaterThanOrEqual(1);
      expect(d.lostReasons.find((x: any) => x.code === 'OTHER_AGENT')?.count).toBeGreaterThanOrEqual(1);
      expect(d.byDealType.find((x: any) => x.code === 'SELLER')?.lost).toBeGreaterThanOrEqual(1);
      expect(d.stageLabels.MEETING).toBe('Randevu');
    } finally {
      await deleteLead(request, lead.id);
    }
  });

  test('ekip görünümü rol kapısına göre döner', async ({ request }) => {
    const session = (await (await request.get('/api/auth/session')).json()).data;
    const r = await request.get('/api/team/overview');
    if (session.role === 'admin' || session.role === 'manager') {
      expect(r.ok()).toBeTruthy();
      const rows = (await r.json()).data;
      expect(Array.isArray(rows)).toBeTruthy();
      for (const row of rows) {
        expect(typeof row.open).toBe('number');
        expect(typeof row.stages.NEW).toBe('number');
      }
    } else {
      expect(r.status()).toBe(403);
    }
  });

  test('sabah özeti önizlemesi metin döner; numara ayarı boş kaydedilebilir', async ({ request }) => {
    const p = await request.get('/api/reports/morning-preview');
    expect(p.ok()).toBeTruthy();
    const text = (await p.json()).data.text as string;
    expect(text).toContain('Günaydın');
    expect(text).toContain('PropCall');

    expect((await request.put('/api/settings', { data: { key: 'morningSummaryPhone', value: 'abc' } })).status()).toBe(500);
    expect((await request.put('/api/settings', { data: { key: 'morningSummaryPhone', value: '' } })).ok()).toBeTruthy();
    const s = (await (await request.get('/api/settings')).json()).data;
    expect(s.morningSummaryPhone.hasValue).toBe(false);
  });
});
