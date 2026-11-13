// Görevler + "Bugün" özeti (CRM Faz 1, bkz. src/tasks.ts) — API sözleşmesi.
import { test, expect } from '@playwright/test';

test.describe('Görevler ve Bugün özeti', () => {
  test('görev oluştur → bugün listesinde görünür → ertele → tamamla', async ({ request }) => {
    const title = `E2E görev ${Date.now()}`;
    const created = await request.post('/api/tasks', { data: { title, kind: 'other', dueAt: new Date().toISOString() } });
    expect(created.status()).toBe(201);
    const task = (await created.json()).data;
    try {
      expect(task.status).toBe('open');

      const today = await request.get('/api/today');
      expect(today.ok()).toBeTruthy();
      const digest = (await today.json()).data;
      expect(digest.tasks.some((t: any) => t.id === task.id)).toBeTruthy();
      expect(typeof digest.counts.today).toBe('number');

      // Haftaya ertele → bugün listesinden çıkar, upcoming'e düşer
      const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString();
      const snoozed = await request.patch(`/api/tasks/${task.id}`, { data: { snoozeUntil: nextWeek } });
      expect(snoozed.ok()).toBeTruthy();
      const upcoming = (await (await request.get('/api/tasks?scope=upcoming')).json()).data;
      expect(upcoming.some((t: any) => t.id === task.id && t.snoozeCount === 1)).toBeTruthy();

      const done = await request.patch(`/api/tasks/${task.id}`, { data: { done: true } });
      expect(done.ok()).toBeTruthy();
      const doneList = (await (await request.get('/api/tasks?scope=done')).json()).data;
      expect(doneList.some((t: any) => t.id === task.id)).toBeTruthy();

      // İkinci tamamlama 404 (zaten kapalı), silme temizler
      expect((await request.patch(`/api/tasks/${task.id}`, { data: { done: true } })).status()).toBe(404);
      expect((await request.delete(`/api/tasks/${task.id}`)).ok()).toBeTruthy();
    } finally {
      // Yukarıdaki silme assertion'a ulaşılamadıysa görev kalmasın (zaten silindiyse no-op).
      await request.delete(`/api/tasks/${task.id}`).catch(() => {});
    }
  });

  test('doğrulama: başlıksız / geçersiz tür / geçersiz tarih reddedilir', async ({ request }) => {
    expect((await request.post('/api/tasks', { data: { title: '  ' } })).status()).toBe(400);
    expect((await request.post('/api/tasks', { data: { title: 'x', kind: 'bogus' } })).status()).toBe(400);
    expect((await request.post('/api/tasks', { data: { title: 'x', dueAt: 'not-a-date' } })).status()).toBe(400);
    expect((await request.get('/api/tasks?scope=nope')).status()).toBe(400);
  });

  test('adaya bağlı görev: aday adı/telefonu görevle birlikte döner', async ({ request }) => {
    const phone = `+90555${Math.floor(1000000 + Math.random() * 8999999)}`;
    const lead = (await (await request.post('/api/leads', { data: { firstName: 'Görev', lastName: 'Testi', phone } })).json()).data;
    let taskId: string | undefined;
    try {
      const task = (await (await request.post('/api/tasks', { data: { leadId: lead.id, title: 'Geri ara', kind: 'call', dueAt: new Date().toISOString() } })).json()).data;
      taskId = task.id;
      expect(task.leadName).toBe('Görev Testi');
      expect(task.leadPhone).toBe(phone);
    } finally {
      if (taskId) await request.delete(`/api/tasks/${taskId}`).catch(() => {});
      await request.delete(`/api/leads/${lead.id}`);
    }
  });
});
