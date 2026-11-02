# PropCall AI — E2E Testleri (Playwright)

Testler **doğrudan staging deploy'una karşı** çalışır (yerel/dockerized bir sunucu
başlatmaz). Bu yüzden gerçek ağ/deploy davranışını test eder, ama bazı rotalar
**kasıtlı olarak hiçbir spec'te çağrılmaz** — aşağıya bakın.

## Çalıştırma

```bash
npm run test
```

İlk kullanımdan önce bir kere:
```bash
npx playwright install chromium
```

`tests/.env.test` dosyasında `STAGING_URL`, `STAGING_TEST_EMAIL`,
`STAGING_TEST_PASSWORD` tanımlı olmalı (gitignore'da, repoya girmez).

## Nasıl çalışır

- `globalSetup.ts` bir kez login olup session cookie'sini
  `tests/.auth/staging.json`'a kaydeder — her spec bunu yeniden kullanır, her testte
  tekrar login yapılmaz.
- Testler sıralı çalışır (`workers: 1`) — aynı staging DB'sini paylaştıkları için
  paralel çalıştırmak veri çakışmasına yol açar.
- Her spec kendi oluşturduğu test verisini (`E2E Test ...`, `Stage Test ...` gibi
  benzersiz isimlerle) test sonunda API üzerinden siler.

## ⚠️ Kasıtlı olarak test EDİLMEYEN rotalar

Staging'de gerçek Vapi/Twilio anahtarları yapılandırılmışsa aşağıdaki rotalar
**gerçek para harcayan/gerçek insanlara ulaşan** aksiyonlar tetikler. Hiçbir test
dosyası bunları çağırmaz:

| Rota | Neden tehlikeli |
|---|---|
| `POST /api/call` | Gerçek bir Vapi telefon araması başlatır |
| `POST /api/campaign/start`, `/resume` | Kampanyadaki herkesi gerçekten aramaya başlar |
| `POST /api/leads/:id/messages` (channel: TWILIO) | Gerçek WhatsApp mesajı gönderir |
| `POST /api/whatsapp/campaigns/:id/send` | Toplu gerçek WhatsApp mesajı gönderir |
| `POST /api/whatsapp/templates/:id/submit` | Gerçek, geri alınamaz bir Meta/Twilio onay başvurusu |
| `POST /api/whatsapp/personal/connect` | Gerçek bir kişisel WhatsApp hesabına QR-eşleştirme başlatır |

Kampanya testleri sadece `POST /api/campaign/load` (draft oluşturma) seviyesinde
durur. Akıllı Plan testleri, oluşturduğu planı **hemen `paused` durumuna çeker**
(scheduler sadece `status='active'` planları tetikler) — bu, planın gün/saat
ayarından bağımsız olarak otomatik tetiklenme riskini sıfırlar.

## Yeni bir özellik test etmek istediğinizde

1. `tests/e2e/` altına yeni bir `*.spec.ts` dosyası ekleyin (ya da mevcut bir
   dosyaya test ekleyin).
2. Yukarıdaki tabloda olmayan, "pure DB/UI" rotaları kullanın.
3. `tests/helpers/apiHelpers.ts`'teki yardımcıları kullanın/genişletin — her test
   kendi verisini temizlemeli.
4. `npm run test` ile çalıştırıp yeşil olduğunu doğrulayın.
