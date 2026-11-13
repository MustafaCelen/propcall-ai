// Canlılık ucu — GET /health. Railway healthcheck/uptime izleyicisi için oturumsuz,
// salt okunur; veri değiştirmez.

import { test, expect, request as playwrightRequest } from '@playwright/test';

test.describe('Sağlık ucu', () => {
  test('GET /health oturumsuz 200 ve {ok:true} döner', async () => {
    const baseURL = test.info().project.use.baseURL as string;
    const anon = await playwrightRequest.newContext({ baseURL });
    try {
      const res = await anon.get('/health');
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      await anon.dispose();
    }
  });
});
