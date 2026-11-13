// CRM Faz 3 — kişi kartı zaman çizelgesi: not, aşama, görev ve oluşturma tek akışta, yeniden eskiye.
import { test, expect } from '@playwright/test';
import { deleteLead } from '../helpers/apiHelpers';

test.describe('Kişi zaman çizelgesi', () => {
  test('not + aşama + görev olayları kronolojik döner', async ({ request }) => {
    const lead = (await (await request.post('/api/leads', { data: { firstName: 'Zaman', lastName: 'Çizelgesi' } })).json()).data;
    let taskId: string | undefined;
    try {
      await request.post(`/api/leads/${lead.id}/notes`, { data: { note: 'İlk not' } });
      await request.patch(`/api/leads/${lead.id}/stage`, { data: { stage: 'CONTACTED' } });
      const task = (await (await request.post('/api/tasks', { data: { leadId: lead.id, title: 'Geri ara', kind: 'call', dueAt: new Date().toISOString() } })).json()).data;
      taskId = task.id;
      await request.patch(`/api/tasks/${task.id}`, { data: { done: true } });

      const r = await request.get(`/api/leads/${lead.id}/timeline`);
      expect(r.ok()).toBeTruthy();
      const events = (await r.json()).data as any[];
      const types = events.map(e => e.type);
      expect(types).toContain('created');
      expect(types).toContain('note');
      expect(types).toContain('stage');
      expect(types.filter(t => t === 'task').length).toBe(1); // tamamlanan görev tek olay (done_at ile)
      expect(events.find(e => e.type === 'task').title).toBe('Görev tamamlandı');
      expect(events.find(e => e.type === 'stage').meta.to).toBe('CONTACTED');
      for (let i = 1; i < events.length; i++) expect(events[i - 1].at >= events[i].at).toBeTruthy();
      expect(events[events.length - 1].type).toBe('created');

      expect((await request.get('/api/leads/lead_yok/timeline')).status()).toBe(404);
    } finally {
      if (taskId) await request.delete(`/api/tasks/${taskId}`).catch(() => {});
      await deleteLead(request, lead.id);
    }
  });
});
