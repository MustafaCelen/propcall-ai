// "Yeniden çalıştır" — biten/durdurulan kampanyada seçilen kesimi AYNI kampanyada
// tekrar arar (JustCall "Re-run this campaign" deseni). Bu spec yalnızca sözleşmeyi
// doğrular: kapsam doğrulaması, kimlik zorunluluğu ve "alınacak kimse yoksa hiçbir
// şey başlamaz" kuralı. Bir draft'ta herkes 'bekliyor' olduğu için rerun 0 kişi
// alır ve campaignResume'a HİÇ ulaşmaz — gerçek arama tetiklenmez.
//
// Eşleme kuralının kendisi (rerunMatches) saf fonksiyon olarak ayrıca test edilir.

import { test, expect } from '@playwright/test';
import { deleteCampaign } from '../helpers/apiHelpers';
import { rerunMatches } from '../../src/campaign';
import type { CampaignContact } from '../../src/campaigns';

const kisi = { name: 'E2E Rerun', phone: '+905551234701', region: '', notes: '', reference: '' };

test.describe('Kampanya yeniden çalıştırma — API sözleşmesi', () => {
  test('campaignId ve geçerli kapsam zorunlu', async ({ request }) => {
    const idsiz = await request.post('/api/campaign/rerun', { data: { scope: 'unreachable' } });
    expect(idsiz.status()).toBe(400);

    const d = (await (await request.post('/api/campaign/load', {
      data: { contacts: [kisi], maxConcurrent: 1, name: 'E2E Rerun Kapsam ' + Date.now() },
    })).json()).data;
    const kapsamsiz = await request.post('/api/campaign/rerun', { data: { campaignId: d.campaignId, scope: 'herkes' } });
    expect(kapsamsiz.status(), 'geçersiz kapsam kabul edildi').toBe(400);
    await deleteCampaign(request, d.campaignId);
  });

  test('alınacak kimse yoksa hiçbir şey başlamaz (draft → requeued 0, hâlâ draft)', async ({ request }) => {
    const d = (await (await request.post('/api/campaign/load', {
      data: { contacts: [kisi], maxConcurrent: 1, name: 'E2E Rerun Boş ' + Date.now() },
    })).json()).data;
    const res = await request.post('/api/campaign/rerun', { data: { campaignId: d.campaignId, scope: 'all' } });
    expect(res.ok()).toBeTruthy();
    const json = await res.json();
    expect(json.requeued).toBe(0);
    expect(json.data.status, 'rerun 0 kişiyle kampanyayı başlatmamalı').toBe('draft');
    expect(json.data.running).toBe(false);
    await deleteCampaign(request, d.campaignId);
  });
});

test.describe('Yeniden çalıştırma eşleme kuralı (saf mantık)', () => {
  const c = (over: Partial<CampaignContact>): CampaignContact => ({
    name: 'x', phone: '+905551234702', region: '', notes: '', reference: '',
    status: 'cevapsız', vapiCallId: 'call_1', result: null, ...over,
  });

  test('ulaşılamayanlar: cevapsız, meşgul ve tekrar-planlandı', () => {
    expect(rerunMatches(c({ status: 'cevapsız' }), 'unreachable')).toBe(true);
    expect(rerunMatches(c({ status: 'meşgul' }), 'unreachable')).toBe(true);
    expect(rerunMatches(c({ status: 'tekrar-planlandı', lastOutcome: 'meşgul' }), 'unreachable')).toBe(true);
    expect(rerunMatches(c({ status: 'tamamlandı' }), 'unreachable')).toBe(false);
  });

  test('sadece cevapsız / sadece meşgul, planlanmış olanın asıl sonucuna bakar', () => {
    expect(rerunMatches(c({ status: 'tekrar-planlandı', lastOutcome: 'cevapsız' }), 'unanswered')).toBe(true);
    expect(rerunMatches(c({ status: 'tekrar-planlandı', lastOutcome: 'cevapsız' }), 'busy')).toBe(false);
    expect(rerunMatches(c({ status: 'meşgul' }), 'busy')).toBe(true);
  });

  test('kurtarılamaz atlamalar (ret listesi, tekrar-arama koruması) hiçbir kapsamda alınmaz', () => {
    for (const scope of ['unreachable', 'failed', 'all'] as const) {
      expect(rerunMatches(c({ status: 'başarısız', skipKind: 'dnc' }), scope)).toBe(false);
      expect(rerunMatches(c({ status: 'başarısız', skipKind: 'duplicate' }), scope)).toBe(false);
    }
    expect(rerunMatches(c({ status: 'başarısız', skipKind: 'stopped' }), 'failed')).toBe(true);
    expect(rerunMatches(c({ status: 'başarısız' }), 'failed')).toBe(true);
  });

  test('"herkes" randevu alınanı ve şu an aranan/bekleyeni dışarıda bırakır', () => {
    const randevu = { randevu_alindi: true } as unknown as CampaignContact['result'];
    expect(rerunMatches(c({ status: 'tamamlandı', result: randevu }), 'all')).toBe(false);
    expect(rerunMatches(c({ status: 'tamamlandı' }), 'all')).toBe(true);
    expect(rerunMatches(c({ status: 'arıyor' }), 'all')).toBe(false);
    expect(rerunMatches(c({ status: 'bekliyor' }), 'all')).toBe(false);
  });
});
