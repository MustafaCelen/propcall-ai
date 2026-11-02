// Kampanya "atlanan kişi" kurtarma kuralları — SAF MANTIK testi.
// Ağ/DB/tarayıcı kullanmaz, doğrudan src/campaigns.ts'teki karar fonksiyonlarını
// çağırır. Bu kurallar gerçek bir production sorunundan doğdu: arama limiti
// dolunca kalan binlerce kişi kalıcı olarak kilitleniyor, hiçbir arayüz elemanı
// onları geri getiremiyordu (tek çare listeyi sıfırdan yüklemekti).
//
// KRİTİK DEĞİŞMEZ: ret listesi (DNC) ve tekrar-arama koruması ASLA kurtarılmamalı —
// geri alınsalar aynı kontrole takılıp yeniden elenirlerdi, yani danışmana hiçbir
// şey yapmayan bir buton göstermiş olurduk.

import { test, expect } from '@playwright/test';
import {
  SKIP_KIND_RESUMABLE, isLimitSkip, isSkipResumable, SkipKind,
} from '../../src/campaigns';

test.describe('Atlanan kişi kurtarma kuralları', () => {
  test('kurtarılabilirlik tablosu doğru', () => {
    // Sayısal limitler ve durdurma geri alınabilir — danışman limiti yükseltir
    // ya da kampanyayı sürdürür.
    expect(SKIP_KIND_RESUMABLE['call-limit']).toBe(true);
    expect(SKIP_KIND_RESUMABLE['answered-limit']).toBe(true);
    expect(SKIP_KIND_RESUMABLE.stopped).toBe(true);

    // Bunlar kalıcı — geri alınsalar aynı kontrole takılırlardı.
    expect(SKIP_KIND_RESUMABLE.dnc).toBe(false);
    expect(SKIP_KIND_RESUMABLE.duplicate).toBe(false);
  });

  test('limit yükseltmesi SADECE limit kurbanlarını kapsar', () => {
    expect(isLimitSkip('call-limit')).toBe(true);
    expect(isLimitSkip('answered-limit')).toBe(true);

    // Durdurma ayrı bir aksiyona ait ("Devam Et"), limit yükseltmesiyle gelmez.
    expect(isLimitSkip('stopped')).toBe(false);
    expect(isLimitSkip('dnc')).toBe(false);
    expect(isLimitSkip('duplicate')).toBe(false);
    expect(isLimitSkip(undefined)).toBe(false);

    const kinds: SkipKind[] = ['dnc', 'duplicate', 'call-limit', 'answered-limit', 'stopped'];
    expect(kinds.filter(isLimitSkip).sort()).toEqual(['answered-limit', 'call-limit']);
  });

  test('eski kayıtlar (skipKind yok) skipResumable bayrağına düşer', () => {
    // skipKind alanı sonradan eklendi; geçmiş kampanyalarda yok.
    expect(isSkipResumable({ skipResumable: true })).toBe(true);
    expect(isSkipResumable({ skipResumable: false })).toBe(false);
    expect(isSkipResumable({})).toBe(false);
  });

  test('skipKind varsa skipResumable bayrağını EZER', () => {
    // Bozuk/eski bir bayrak, ret listesindeki birini kurtarılabilir gösteremez.
    expect(isSkipResumable({ skipKind: 'dnc', skipResumable: true })).toBe(false);
    expect(isSkipResumable({ skipKind: 'duplicate', skipResumable: true })).toBe(false);
    expect(isSkipResumable({ skipKind: 'call-limit', skipResumable: false })).toBe(true);
  });
});
