// Senaryo (Vapi sistem promptu) CRUD — pure DB, dış API'ye dokunmaz.

import { test, expect } from '@playwright/test';
import { createTestScenario, deleteScenario } from '../helpers/apiHelpers';

test.describe('Senaryolar — CRUD', () => {
  test('senaryo oluşturulup listede görünür, silinebilir', async ({ request }) => {
    const name = 'E2E Scenario ' + Date.now();
    const created = await createTestScenario(
      request, name,
      '[Identity]\nAdın {{agentName}}, kısa ve net konuş.\n\n[Task & Goals]\n1. "Merhaba {{customerName}}" de.',
    );
    expect(created.id).toBeTruthy();

    const listRes = await request.get('/api/scenarios');
    const list = (await listRes.json()).data;
    expect(list.find((s: any) => s.id === created.id)?.name).toBe(name);

    await deleteScenario(request, created.id);
    const afterRes = await request.get('/api/scenarios');
    const after = (await afterRes.json()).data;
    expect(after.find((s: any) => s.id === created.id)).toBeFalsy();
  });

  test('tanınmayan {{değişken}} kullanan senaryo reddedilir', async ({ request }) => {
    const res = await request.post('/api/scenarios', {
      data: { name: 'Bad Scenario', systemPrompt: 'Merhaba {{nonExistentVariable}}' },
    });
    expect(res.status()).toBe(400);
  });
});
