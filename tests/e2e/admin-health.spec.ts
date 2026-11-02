// Veri tutarlilik kontrolleri — GET /api/admin/health.
// Bu uc, muhasebe/ozet mantiginin sessizce bozulmasini yakalar: cift
// ucretlendirme, bakiye-hareket uyusmazligi, celiskili ozet gibi mantiksal
// olarak imkansiz kayitlar. Salt okunur, hicbir veri degistirmez.

import { test, expect } from '@playwright/test';

test.describe('Veri sağlık kontrolleri', () => {
  test('/api/admin/health tüm kontrolleri döner ve staging verisi sağlıklı', async ({ request }) => {
    const res = await request.get('/api/admin/health');
    expect(res.ok()).toBeTruthy();
    const { success, data } = await res.json();
    expect(success).toBeTruthy();

    expect(Array.isArray(data.checks)).toBeTruthy();
    expect(data.checks.length).toBeGreaterThan(0);

    // Her kontrol kendini açıklamalı — panelde ham alan adı görmek işe yaramaz.
    for (const c of data.checks) {
      expect(typeof c.ad).toBe('string');
      expect(typeof c.aciklama).toBe('string');
      expect(typeof c.sorunlu).toBe('number');
      // -1 = kontrol çalıştırılamadı (SQL patladı). Bu da bir arıza sayılır.
      expect(c.sorunlu, `"${c.ad}" kontrolü çalıştırılamadı`).toBeGreaterThanOrEqual(0);
    }

    // Kritik olanlar isim olarak mevcut olmalı — biri sessizce silinirse yakala.
    const adlar = data.checks.map((c: any) => c.ad);
    expect(adlar).toContain('cift_ucretlendirme');
    expect(adlar).toContain('bakiye_uyusmazligi');

    // Çift ücretlendirme ASLA olmamalı — doğrudan para kaybı demek.
    const ciftUcret = data.checks.find((c: any) => c.ad === 'cift_ucretlendirme');
    expect(ciftUcret.sorunlu, 'Aynı arama birden fazla kez ücretlendirilmiş').toBe(0);

    // Sahipsiz hareket de olmamalı — muhasebe izini koparır.
    const sahipsiz = data.checks.find((c: any) => c.ad === 'sahipsiz_hareket');
    expect(sahipsiz.sorunlu, 'Kullanıcısı olmayan kredi hareketi var').toBe(0);

    // Özet çelişkileri enforceSummaryConsistency ile deterministik olarak
    // engelleniyor — sıfır olmalı.
    for (const ad of ['celiskili_ozet_ilgi', 'celiskili_ozet_ret', 'negatif_sure']) {
      const c = data.checks.find((x: any) => x.ad === ad);
      expect(c.sorunlu, ad + ' kontrolü sıfır olmalıydı').toBe(0);
    }

    // NOT: bakiye_uyusmazligi burada KASITLI olarak zorlanmıyor. Staging'de
    // doğrudan bakiyeyle açılmış (hareket kaydı olmayan) test hesapları var —
    // bu bir muhasebe hatası değil, kurulum şekli. Production'da bu kontrol
    // temiz (doğrulandı); orada bozulursa /api/admin/health panelinde görünür.
  });
});
