// Akıllı Plan — oluşturma/listeleme/silme. KRİTİK: her test, oluşturduğu planı HEMEN
// 'paused' durumuna çeker (scheduler sadece status='active' planları tetikler, bkz.
// src/smartPlans.ts tickSmartPlans — `WHERE status = 'active'`) — bu, scheduler'ın
// 60sn'lik tick'i test sırasında araya girip gerçek bir kampanya/arama başlatma
// riskini SIFIRLAR, pencere/gün ayarından bağımsız olarak.

import { test, expect } from '@playwright/test';
import { createTestLead, deleteLead, deleteSmartPlan } from '../helpers/apiHelpers';

async function pausePlan(request: any, id: string) {
  await request.patch(`/api/smart-plans/${id}/status`, { data: { status: 'paused' } });
}

test.describe('Akıllı Plan — oluşturma (asla otomatik tetiklenmeden)', () => {
  test('STATIC_LIST kuralıyla plan oluşur, hemen duraklatılır, listede görünür', async ({ request }) => {
    const lead = await createTestLead(request, { firstName: 'Smart Plan Target ' + Date.now() });
    let planId: string | undefined;

    // Bir assertion patlasa bile plan (aktif kalırsa scheduler tetikleyebilir!) ve
    // aday staging'de kalmasın.
    try {
      const createRes = await request.post('/api/smart-plans', {
        data: {
          name: 'E2E Smart Plan ' + Date.now(),
          daysOfWeek: [1, 2, 3, 4, 5],
          windowStartHour: 9,
          windowEndHour: 18,
          maxConcurrent: 1,
          dailyCallCap: 0,
          segmentRule: { type: 'STATIC_LIST', leadIds: [lead.id] },
        },
      });
      expect(createRes.ok()).toBeTruthy();
      const plan = (await createRes.json()).data;
      planId = plan.id;

      // Otomatik tetiklenme riskini sıfırla — scheduler artık bu planı görmez.
      await pausePlan(request, plan.id);
      expect(plan.status).toBe('active');

      const listRes = await request.get('/api/smart-plans');
      const list = (await listRes.json()).data;
      const found = list.find((p: any) => p.id === plan.id);
      expect(found).toBeTruthy();
      expect(found.status).toBe('paused');
    } finally {
      if (planId) await deleteSmartPlan(request, planId);
      await deleteLead(request, lead.id);
    }
  });

  test('segment önizleme (preview-segment) gerçek sayı döner', async ({ request }) => {
    const res = await request.post('/api/smart-plans/preview-segment', {
      data: { segmentRule: { type: 'NEVER_CONTACTED' } },
    });
    expect(res.ok()).toBeTruthy();
    const { count } = (await res.json()).data;
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('gün/saat eksikse plan oluşturma reddedilir', async ({ request }) => {
    const res = await request.post('/api/smart-plans', {
      data: { name: 'Invalid Plan', daysOfWeek: [1], segmentRule: { type: 'NEVER_CONTACTED' } },
    });
    expect(res.status()).toBe(400);
  });
});
