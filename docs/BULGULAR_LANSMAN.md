# Lansman Bulgu Listesi

Plan: docs/URUNLESME_TEST_PLANI.md (bölüm 6). Sınıflar: S1 bloker · S2 ana akış · S3 küçük.
Go/No-Go şartı: S1 = 0, S2 = 0, S3 ≤ 5 ve belgelenmiş.

| # | Tarih | Sınıf | Katman | Ekran / rota | Adımlar | Beklenen | Gerçekleşen | Durum | Düzeltme |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-13 | S3 | K2 | Toplu Arama | Sekmeye geç, hemen dosya yükle | Yeni liste ekranda kalır | Gecikmiş "en son kampanya" yanıtı listeyi ezdi | Kapalı | d182372 (odak değiştiyse yanıt atılır) |
| 2 | 2026-11-13 | S3 | K2 | Çıkış | Eski sürümden kalan `propcall.` anahtarıyla çıkış | Tüm veri anahtarları silinir | Listede olmayan anahtar kaldı | Kapalı | d182372 (önek bazlı temizlik) |
| 3 | 2026-11-16 | S3 | K1 | Test altyapısı | izolasyon testi her koşuda geçici kullanıcı açar | Test artığı kalmaz | Her koşu şirket Vapi hesabında gerçek bir "E2E Gecici Agent Asistanı" bırakıyor (6 tane birikmişti, elle silindi) | Açık | Öneri: test sonunda kullanıcı pasifleştirilirken asistan da Vapi'den silinsin ya da test ortamında provisioning atlansın |
| 5 | 2026-11-16 | S3 | K5 | Staging logları | Staging'e `/webhook/fonzip` istekleri geliyor | Staging Fonzip'ten bildirim almamalı | Fonzip hesabında staging URL'sine kayıtlı eski bir webhook var gibi; her olayda "FONZIP_CLIENT_ID tanımlı değil" hatası loga düşüyor (zararsız, gürültü) | Açık | Fonzip panelinden staging webhook'unu sil; prod etkilenmez |
| 6 | 2026-11-16 | S2 | K3 | Toplu Arama | Tek kişilik kampanya; kişi meşgul çıkıp 2 saat sonraya planlanınca | Panel "tekrar aranacak" der, bekler | Sarı "Hat kapasitesi dolu" uyarısı çıktı (başka hat kullanan yokken). Neden: aranacak kimse kalmayınca hat paylaşımı talep 0 → pay 0 veriyor, bu "kapasite dolu" sanılıyordu. Çağrı akışı etkilenmiyor, yalnızca yanıltıcı uyarı | Düzeltildi | src/campaign.ts fillQueue: slot sayısı şu an aranabilir kişiyle sınırlandı, talep yoksa kapasite kontrolüne girilmiyor |
| 7 | 2026-11-16 | S2 | K3 | Faturalama | Senaryo 3: 7,6 sn konuşma, ~7 sn çalma | Süre = bağlantı anından (Vapi startedAt), çalma faturalanmaz | Kayıt 19 sn (istek anından); webhook'taki `call.startedAt` boş geliyor, kod bizim startTime'a düşüyordu. Bu aramada 1 dk zaten; ama 55 sn konuşma + 8 sn çalma 2 dk ücretlenirdi | Düzeltildi | end-of-call-report'un üst alanları (`startedAt`/`endedAt`/`durationSeconds`) önce kullanılıyor; fallback'te uyarı logu |
| 4 | 2026-11-16 | S3 | K3 | Staging ortamı | Ayarlar > ses önizleme | Çalışır | Staging'de DEFAULT_ELEVENLABS_API_KEY yok; aramalar Vapi'nin kendi ElevenLabs entegrasyonuyla çalışır, yalnızca önizleme/maliyet gösterimi staging'de boş | Bilgi | Prod'da anahtar var, lansmanı etkilemez |

## UAT ortamı (K3) — 2026-11-16

- Hesap: staging `uat@propcall.local` (rol agent), "UAT Danışman", otomatik açılış akışıyla kuruldu:
  Vapi anahtarı + asistan `17cfdb24…` (webhook staging'e bağlı, ses 11labs eleven_v3, model gpt-5.6-luna, Deepgram nova-3),
  Anthropic anahtarı, varsayılan senaryo "Standart Satılık Kiralık Var mı Sorgusu", bakiye 300 TL, ücret 10 TL/dk.
- Kullanım Koşulları API ile onaylandı (gate'in kendisi otomatik testte zaten kapsanıyor: terms-gate.spec).
- Seçilmeyi bekleyen tek şey: telefon numarası (ZAB +90 212 909 4276 ya da EminTel +90 212 909 4947 — şirket Vapi hesabındaki iki hat; ikisi de prod'da gerçek danışmanlara bağlı, staging'den arama o numarayı arayan kimliği olarak gösterir).

## K3 gerçek arama kayıtları (Ek A)

| Senaryo | Tarih | Hesap | Call ID | Süre | Ücret (TL) | 1 Geçmiş | 2 Transcript | 3 AI özeti | 4 Faturalama | 5 CRM | 6 Rapor | Not |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 Cevapsız | 2026-11-16 07:58Z | uat | 01a1e35d | 41 sn çalma | 0 | ✓ (Vapi "customer-busy" döndü → sistemde "meşgul"; operatör cevapsızı meşgul olarak bildiriyor) | ✓ boş | – | ✓ ücret 0, bakiye 300 | ✓ kampanya: "120 dk sonra tekrar denenecek (1/2)", kişi "tekrar-planlandı" | bekliyor | Kampanya "Kampanya 16.11.2026"; tekrar arama varsayılan 2 deneme/120 dk ile başlatılmış |
| 2 Meşgul | 2026-11-16 07:53Z | uat | 01a1e359 | 16 sn (çalma) | 0 | ✓ busy / customer-busy | ✓ boş (konuşma yok) | – (konuşma yok) | ✓ ücret 0, bakiye 300 | – Canlı Görüşme'den tekil arama, kampanya değil → retry kuralı bu turda test edilmedi | ✓ | Müşteri adı "Test's opportunity" olarak girilmiş; Vapi cost 0 ile tutarlı |
| 3 Açıp kapatır | 2026-11-16 08:14Z | uat | 01a1e36b | 7,6 sn konuşma (kayıt 19 sn → bulgu 7) | 10 | ✓ completed / customer-ended-call | ✓ "User: Alo. / AI: Merhaba, gelir benim" | ✓ ilgi yok, randevu yok, aksiyon "Ara"; özet asistanın kesildiğini doğru anlatıyor | ✓ 1 dk × 10 TL, bakiye 290; Vapi maliyeti $0.0084 kaydedildi | ✓ tasarım gereği ilgi "yok" ise CRM'e kişi açılmaz; kampanya "tamamlandı 0/1 randevu" | ✓ | Asistan açılış cümlesini bitiremeden kapatıldı (senaryo gereği) |
| 4 Net ret | | | | | | | | | | | | |
| 5 Randevu | | | | | | | | | | | | |
| 6 Beni aramayın | | | | | | | | | | | | |
| 7 Yanlış kişi | | | | | | | | | | | | |
| 8 Uzun konuşma | | | | | | | | | | | | |
| 9 Bakiye bitişi | | | | | | | | | | | | |
| 10 Saat dışı | | | | | | | | | | | | |
| 11 3 eşzamanlı | | | | | | | | | | | | |
| 12 Deploy ortası | 2026-11-16 09:1xZ (kısmi) | uat | – | – | – | – | – | – | – | ✓ staging deploy'u sırasında "Kampanya 16.11.2026" running + tekrar planı (09:59Z) kaybolmadan geri yüklendi, "4/4 aktif kampanya yüklendi" | – | Aktif arama sırasında deploy henüz denenmedi (K5 ile tamamlanacak) |
