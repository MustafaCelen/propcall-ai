# PropCall AI — Ürünleşme Hazırlık ve Test Planı

Tarih: 2026-11-13 · Sahip: Mustafa Celen · Prod sürümü: 0eeca7b (deploy 2ab20f91)
Durum: **Onaylandı (Mustafa, 2026-11-13), uygulanıyor.** Bu belge "kullanıcıya açmadan önce nelerden emin olmalıyız"
sorusunun cevabıdır. Her katmanın geçme kriteri ve sorumlusu yazılıdır; Go/No-Go kararı
bölüm 6'daki kriterlere göre verilir.

---

## 1. "Hazır" ne demek — Go/No-Go kriterleri

Lansman (ilk gerçek danışmanlara açılış) için **hepsi** sağlanmalı:

| # | Kriter | Nasıl kanıtlanır |
|---|---|---|
| G1 | Otomatik test takımı (API + arayüz) staging'de %100 yeşil, iki ardışık koşuda | `npm run test` çıktısı |
| G2 | Gerçek arama kabul testi (K3) 12 senaryonun 12'si geçti | Ek A tablosu doldurulmuş |
| G3 | Faturalama uçtan uca doğru: gerçek Fonzip ödemesi + gerçek arama ücreti + bakiye bitince durma | K4 kayıtları |
| G4 | Çalışan kampanya deploy/restart'ta kaybolmuyor, takılı arama kalmıyor | K5 kayıtları |
| G5 | 5.000 satırlık liste ve 10 eşzamanlı hat ile sistem ayakta | K6 ölçümleri |
| G6 | S1 (bloker) açık hata = 0, S2 = 0, S3 ≤ 5 ve belgelenmiş | Hata listesi (bölüm 6) |
| G7 | Pilot: 2 danışman × 5 iş günü, "tek başına kullanabiliyorum" onayı | Pilot raporu |
| G8 | Prod operasyon listesi (bölüm 7) tamamen işaretli | Kontrol listesi |

---

## 2. Bugünkü durum (envanter)

**Hazır olanlar**
- 67 maddelik güvenlik/doğruluk denetimi uygulandı ve prod'da (docs/DENETIM_2026-11-12.md).
- Kiracı izolasyonu tam incelendi; sızıntı yok, geçmişteki "Excel başkasında göründü" olayı kapatıldı.
- CRM yeniden yapımı 4 faz + "Berrak" arayüz canlı.
- Otomatik test takımı: 74 API düzeyinde E2E + **19 yeni tarayıcı (arayüz) testi** (bu planla eklendi) = 93 test, hepsi staging'e karşı koşuyor.

**Bilinçli olarak dışarıda bırakılanlar**
- Meta lead entegrasyonu: kullanılmayacak, test kapsamı dışı (`META_APP_SECRET` boş kalabilir).
- Postgres RLS: yapısal öneri, lansman şartı değil.
- Ertelenen teknik borç: campaign_contacts tablosu, billing_jobs kuyruğu, node-pg-migrate, pino/Sentry.

**İş kararları**
- Dakika ücreti: **10 TL/dk** (karar 2026-11-13). Kod varsayılanı 10 (`CALL_MINUTE_RATE_TRY`, src/users.ts),
  prod ortamında üzerine yazan değişken yok, Kullanım Koşulları metninde tutar geçmiyor → çelişki yok.

---

## 3. Test katmanları

| Katman | Ne test eder | Kim / nerede | Ne zaman | Geçme kriteri |
|---|---|---|---|---|
| K1 Otomatik API | Rotalar, izolasyon, faturalama mantığı, kampanya kuralları | Claude, staging | Her deploy öncesi | 74/74 |
| K2 Otomatik arayüz | Danışmanın gördüğü ekranlar: gezinme, dosya yükleme, formlar, mobil, giriş/çıkış | Claude, staging | Her deploy öncesi | 19/19, konsol hatası 0 |
| K3 Gerçek arama UAT | Vapi ile gerçek arama → transcript, AI özeti, faturalama, CRM otomasyonu | **Mustafa + 2 kişi**, staging gerçek anahtarlarla | G3–G4 | Ek A 12/12 |
| K4 Ödeme ve faturalama | Fonzip gerçek ödeme, webhook, bakiye, mükerrer koruma | Mustafa, **prod** (küçük tutar) | G5 | Bölüm 3.4 listesi |
| K5 Dayanıklılık | Deploy/restart sırasında kampanya, yedek/geri yükleme, geri alma | Claude + Mustafa, staging | G5 | Bölüm 3.5 listesi |
| K6 Performans | Büyük liste, eşzamanlı hat, çok sekme | Claude, staging | G6 | Bölüm 3.6 eşikleri |
| K7 Pilot | Gerçek danışman, gerçek liste, 1 hafta | 2 danışman, prod | G9–G15 | Bölüm 3.7 |

### 3.1 K1 — Otomatik API testleri (mevcut)
Kapsam: auth, terms gate, leads CRUD/import/deal, tasks, scenarios, smart plans, campaign (load/rerun/reattempt/result panel/delete), billing, DNC, webhook imzası, izolasyon, health, raporlar.
Kasıtlı olarak çağrılmayanlar (gerçek para/insan): `/api/call`, `/api/campaign/start|resume`, WhatsApp gönderimleri. Bunlar K3'te **elle** yapılır.

### 3.2 K2 — Otomatik arayüz testleri (bu planla eklendi)
Dosyalar: `tests/e2e/ui-*.spec.ts`, yardımcılar `tests/helpers/ui.ts`.

| Dosya | Ne doğrular |
|---|---|
| ui-smoke | 11 sekmenin tamamı açılır, kök elemanları görünür, JS/konsol hatası yok; üst çubuk; Raporlar grafikleri; Kampanya Geçmişi; Ayarlar 4 sekme; Yönetim sayfası |
| ui-auth | Oturumsuz → /login; yanlış şifre mesajı; boş form; giriş → çıkış: localStorage temiz, oturum 401, geri dönülemez |
| ui-campaign-upload | Gerçek CSV seçimi → tablo, numara normalizasyonu (0532/532-/+90), bozuk satır atlanır, sunucuda taslak, F5 sonrası aynı liste; "Telefon" başlığı yoksa uyarı; geçersiz dosyada taslak oluşmaz |
| ui-leads-import | Kişi içe aktarma: çakışma önizlemesi, onay, mevcut kayıt korunur, Kanban'da görünür |
| ui-lead-drawer | Kişi kartı: hızlı Görev oluşturma; LOST'a geçişte neden zorunlu |
| ui-scenarios | Senaryo ekle (boş prompt reddi) → seçim listesine düşer → sil |
| ui-mobile | 390px: menü çekmecesi, sekme geçişi, yatay taşma yok; giriş sayfası mobil |

**Otomasyonun bilerek kapsamadığı arayüz alanları → bölüm 4'teki manuel listeyle kapatılır:**
WhatsApp şablon/gönderim, Akıllı Plan formu, Rol Yapma, Ayarlar'da kaydetme (gerçek Vapi/ElevenLabs anahtarı değiştirir), ses önizleme, Kanban sürükle-bırak, tur (onboarding).

### 3.3 K3 — Gerçek arama kabul testi (UAT)
Ortam: **staging**, gerçek Vapi/ElevenLabs/Anthropic anahtarları, test kullanıcısına 300 TL jeton.
Aranacak numaralar: yalnızca Mustafa ve gönüllü 2 kişinin kendi telefonları (gerçek müşteri yok).
Yöntem: Her senaryo için 1 kampanya (1–3 kişi), senaryo script'i Ek A'da. Her aramadan sonra 6 kontrol:

1. **Arama Geçmişi** satırı: durum, süre, maliyet doğru.
2. **Transcript** tam ve Türkçe karakterler doğru.
3. **AI özeti**: randevu_alindi / ilgi_seviyesi / ret_nedeni / aksiyon alanları mantıklı.
4. **Faturalama**: `startedAt`'ten yukarı yuvarlanmış dakika × tarife; çalma süresi faturalanmamış; bakiye düştü; aynı arama iki kez ücretlenmemiş.
5. **CRM otomasyonu**: kişi aşaması, otomatik görev/randevu, Bugün ekranı, Takip listesi.
6. **Raporlar**: sayılar ve huni bir sonraki yenilemede tutarlı.

### 3.4 K4 — Ödeme ve faturalama (prod, küçük tutar)
- [ ] Fonzip ile 10 TL gerçek yükleme → webhook → bakiye +10 (tek işlem, mükerrer yok).
- [ ] Ödeme sayfasını kapatıp 1 saat bekle → bekleyen kayıt iptal notuyla kapanır, bakiye değişmez.
- [ ] Aynı webhook'u iki kez gönder (Fonzip "yeniden gönder") → tek kredi.
- [ ] Bakiye 1 dakikalık ücretin altındayken arama → reddedilir, kampanya `pause_reason=credit` ile durur, bakiye yüklenince devam eder.
- [x] Dakika ücreti kararı: 10 TL, kodla aynı (2026-11-13).

### 3.5 K5 — Dayanıklılık ve operasyon (staging)
- [ ] 3 kişilik kampanya çalışırken `railway up` → yeni sürüm açılınca kampanya DB'den geri yüklenir, kalan kişiler aranır, aranmış kişi tekrar aranmaz.
- [ ] Servis restart → aktif aramalar `reconcile` ile kapanır, takılı "arıyor" kalmaz (10 dk sonra kontrol).
- [ ] Vapi webhook'u 2 dk geciktirildiğinde (ngrok kapat/aç) arama kaydı yine tamamlanır.
- [ ] Railway Postgres yedeğinden **geri yükleme provası** (staging'de): yedek al → tablo sil → geri yükle → uygulama açılır.
- [ ] Geri alma provası: önceki deployment'a `redeploy` → /health 200, veriler yerinde. Süre ölçülür (hedef < 5 dk).
- [ ] `/health` alarmı: Railway'de healthcheck başarısızlığında bildirim (e-posta) geliyor mu.

### 3.6 K6 — Performans (staging)
| Ölçüm | Eşik |
|---|---|
| 5.000 satırlık Excel yükleme (tarayıcı + sunucu) | < 15 sn, hata yok, sayım doğru |
| 10 eşzamanlı hat ile kampanya (Vapi sınırı) | hepsi başlar, adil paylaşım, 429 yok |
| 5 açık sekme + SSE | sunucu RAM < 400 MB, olaylar her sekmeye düşer |
| Raporlar: 10.000 arama kaydıyla | her rapor < 2 sn |
| /api/calls listesi | < 1 sn (LIMIT 500) |

### 3.7 K7 — Pilot
- 2 danışman (biri teknikle arası iyi olmayan), kendi gerçek listeleri, **prod**, 5 iş günü.
- Her gün 15 dk görüşme: "Nerede takıldın? Ne beklemiştin?" — kayıt tutulur.
- Ölçülenler: başlangıçtan ilk kampanyaya süre (hedef < 20 dk, destek almadan), günlük arama sayısı, cevaplama oranı, randevu sayısı, hata/şikayet sayısı, jeton tüketimi vs beklenen.
- Çıkış: her iki danışman da "yarın tek başıma kullanırım" diyor; S1/S2 bulgu yok.

---

## 4. Manuel arayüz kontrol listesi (senaryo tabanlı)

Üç tarayıcı/cihaz: Chrome masaüstü (1440), Safari iPhone (390), Android Chrome (412).
Her senaryo "✓ / ✗ + not" ile işaretlenir.

**S1 — Yeni danışmanın ilk günü**
- [ ] Admin yeni kullanıcı açar → danışman giriş yapar → Kullanım Koşulları gelir → onaylamadan hiçbir ekran kullanılamaz → onaylar.
- [ ] Tanışma turu açılır, atlanabilir, bir daha gelmez.
- [ ] Ayarlar > Hesap Bağlantıları: varsayılan asistan/numara dolu; ses önizleme çalışır; arama saatleri kaydedilir ve F5 sonrası durur.
- [ ] Şifre değiştirir → diğer cihazdaki oturum düşer.

**S2 — Günlük kampanya**
- [ ] Gerçek bir Excel (.xlsx, Türkçe başlıklar, boşluklu numaralar) yükler → sayım ve atlanan listesi doğru.
- [ ] Senaryo seçer, "Bu Ayarlarla Devam Et" → Başlat (K3 içinde) → canlı ilerleme çubuğu, SSE ile satırlar güncellenir.
- [ ] Duraklat / Devam / Durdur; sayfa yenileyince durum aynı.
- [ ] Bitince sonuç paneli; "Yeniden çalıştır" sadece seçilen kapsamı arar.

**S3 — CRM günü**
- [ ] Bugün ekranı: gecikmiş/bugün/yaklaşan görevler doğru gruplanır; görevi tamamla/ertele.
- [ ] Kanban sürükle-bırak: NEW→CONTACTED; LOST'a bırakınca neden sorulur; vazgeçince kart geri gelir.
- [ ] Kişi kartı: Ara (gerçek arama, K3), WhatsApp (wa.me doğru numara), Randevu → takvimde görünür.
- [ ] Pano (huni) sayıları Kişiler sayfasıyla tutarlı.

**S4 — WhatsApp**
- [ ] Şablon oluştur → önizleme sayımı → (gönderim K3'te, 1 kişiye kendi numarasına).
- [ ] Gelen kutusu: yanıt düşer, Bugün ekranında "yanıt bekleyen" sayısı artar.

**S5 — Yönetici**
- [ ] Yönetim: kullanıcı aç/pasifleştir, DNC ekle (o numara kampanyada atlanır), Vapi hesap kapasitesi görünür.
- [ ] Ekip görünümü (manager rolü): sadece kendi ekibinin verisi.

**S6 — Kötü günler**
- [ ] İnternet kopar → SSE yeniden bağlanır, tablo güncel kalır; toast'lar anlaşılır.
- [ ] Bakiye biter → kampanya durur, mesaj net, yükleme düğmesi görünür.
- [ ] Arama saatleri dışında Başlat → "otomatik bekletildi" bildirimi, saat gelince başlar.

---

## 5. Takvim (10 iş günü + pilot)

| Gün | İş | Çıktı |
|---|---|---|
| G1 (13 Kasım) ✓ | K2 arayüz testleri yazıldı, 95/95 yeşil; plan onaylandı; ücret 10 TL kesinleşti | Bu belge, 19 test |
| G2 | Bölüm 4 manuel liste, 3 cihaz; bulgular S1–S3 sınıflandırılır | Bulgu listesi |
| G3–G4 | K3 gerçek arama UAT (Ek A, 12 senaryo) | Ek A doldurulmuş |
| G5 | K4 ödeme (prod, 10 TL) + K5 dayanıklılık provaları | Kontrol listeleri |
| G6 | K6 performans ölçümleri | Ölçüm tablosu |
| G7–G8 | Bulgu düzeltme, regresyon (K1+K2 yeşil), prod deploy | Temiz liste |
| G9–G15 | K7 pilot (2 danışman) | Pilot raporu |
| G16 | Go/No-Go toplantısı (bölüm 1) | Karar |

---

## 6. Hata sınıflandırma ve kayıt

| Sınıf | Tanım | Lansman etkisi |
|---|---|---|
| S1 | Veri kaybı/karışması, yanlış ücretlendirme, gerçek müşteri yanlış aranıyor, kampanya kontrolsüz | Bloker, 0 olmalı |
| S2 | Ana akış çalışmıyor (yükleme, başlatma, rapor), geçici çözümü yok | 0 olmalı |
| S3 | Rahatsız edici ama geçici çözümü var (görsel, metin, küçük mantık) | ≤ 5, belgelenmiş |

Kayıt: `docs/BULGULAR_LANSMAN.md` (tarih, sınıf, ekran, adımlar, beklenen/gerçekleşen, durum).

---

## 7. Lansman öncesi prod operasyon listesi

- [x] `CALL_MINUTE_RATE_TRY` iş kararıyla aynı (10 TL, doğrulandı 2026-11-13); Kullanım Koşulları tutar içermiyor, çelişki yok.
- [ ] Test hesapları ve "E2E" artıkları prod'da yok (2026-11-12 temizliği doğrulanır).
- [ ] Railway: prod Postgres otomatik yedek açık, son yedek tarihi görülür; healthcheck + ON_FAILURE restart aktif.
- [ ] Özel alan adı + SSL (şu an railway.app alt alanı; danışmanlara verilecek adres netleşsin).
- [ ] Vapi: hesap başına 10 hat sınırı biliniyor; cüzdan bakiyesi alarmı (Vapi tarafında) açık; şirket hesabına geçiş planı (bireysel anahtarlı eski kullanıcılar).
- [ ] ElevenLabs karakter kotası ve Anthropic limitleri lansman hacmine yetiyor.
- [ ] Destek kanalı: danışmanların yazacağı WhatsApp/e-posta ve "ilk 2 hafta aynı gün dönüş" sözü.
- [ ] Yönetici hesabı şifresi yenilendi, 2 kişi biliyor.
- [ ] Geri alma komutu ve son bilinen iyi deployment ID'si yazılı (`railway redeploy`).
- [ ] Günlük log kontrol rutini: `railway logs` ile `error`/`unhandled` taraması (ilk 2 hafta her sabah).

---

## 8. Lansman sonrası ilk 2 hafta

- Her sabah: /health, takılı arama (reconcile), bakiye şikayeti, hata logları.
- Haftalık: arama/cevap/randevu oranları danışman bazında; jeton tüketimi vs tahmin.
- Yeni özellik yok; yalnızca S1–S3 düzeltmeleri. Her düzeltme K1+K2 yeşil olmadan prod'a gitmez.

---

## Ek A — K3 gerçek arama senaryoları

| # | Senaryo | Aranan kişi ne yapar | Beklenen sistem davranışı |
|---|---|---|---|
| 1 | Cevapsız | Açmaz | status unanswered, ücret 0, retry kuralına göre yeniden planlanır |
| 2 | Meşgul | Reddeder | busy, ücret 0, retry |
| 3 | Açıp kapatır (3 sn) | "Alo" der kapatır | 1 dk ücret, transcript kısa, ilgi düşük |
| 4 | Net ret | "İlgilenmiyorum" | ret_nedeni dolu, aşama LOST değil (sadece AI önerisi), görev yok |
| 5 | Randevu | Gün/saat verir | randevu_alindi=true, otomatik Randevu görevi, Bugün'de görünür, aşama MEETING |
| 6 | "Beni bir daha aramayın" | Açıkça söyler | DNC listesine düşer, sonraki kampanyada atlanır |
| 7 | Yanlış kişi | "Yanlış numara" | aksiyon = yanlış_kişi, kişi notu güncellenir |
| 8 | Uzun konuşma | 4+ dk konuşur | maxDuration bakiyeye göre kırpılır, ücret dakikaya yuvarlanır |
| 9 | Bakiye bitişi | Bakiye 1 dk'ya düşürülmüş | kampanya credit nedeniyle durur, net mesaj, yükleyince devam |
| 10 | Saat dışı | 21:00'de Başlat | otomatik bekletme, sabah kendiliğinden başlar |
| 11 | 3 eşzamanlı | 3 telefon aynı anda | 3 hat aynı anda çalar, tablo canlı güncellenir |
| 12 | Deploy ortası | Kampanya sürerken deploy | kalanlar aranır, mükerrer arama yok (K5 ile ortak) |

Her satır için: tarih, arayan hesap, call id, ücret (TL), 6 kontrol sonucu.

## Ek B — Komutlar

```bash
# Tüm takım (API + arayüz), staging
npm run test

# Yalnızca arayüz
npx playwright test -c tests/playwright.config.ts tests/e2e/ui-*.spec.ts

# Başarısız testin izini aç
npx playwright show-trace test-results/<klasör>/trace.zip
```
