# Lansman Bulgu Listesi

Plan: docs/URUNLESME_TEST_PLANI.md (bölüm 6). Sınıflar: S1 bloker · S2 ana akış · S3 küçük.
Go/No-Go şartı: S1 = 0, S2 = 0, S3 ≤ 5 ve belgelenmiş.

| # | Tarih | Sınıf | Katman | Ekran / rota | Adımlar | Beklenen | Gerçekleşen | Durum | Düzeltme |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-13 | S3 | K2 | Toplu Arama | Sekmeye geç, hemen dosya yükle | Yeni liste ekranda kalır | Gecikmiş "en son kampanya" yanıtı listeyi ezdi | Kapalı | d182372 (odak değiştiyse yanıt atılır) |
| 2 | 2026-11-13 | S3 | K2 | Çıkış | Eski sürümden kalan `propcall.` anahtarıyla çıkış | Tüm veri anahtarları silinir | Listede olmayan anahtar kaldı | Kapalı | d182372 (önek bazlı temizlik) |
| 3 | 2026-11-16 | S3 | K1 | Test altyapısı | izolasyon testi her koşuda geçici kullanıcı açar | Test artığı kalmaz | Her koşu şirket Vapi hesabında gerçek bir "E2E Gecici Agent Asistanı" bırakıyor (6 tane birikmişti, elle silindi) | Açık | Öneri: test sonunda kullanıcı pasifleştirilirken asistan da Vapi'den silinsin ya da test ortamında provisioning atlansın |
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
| 1 Cevapsız | | | | | | | | | | | | |
| 2 Meşgul | | | | | | | | | | | | |
| 3 Açıp kapatır | | | | | | | | | | | | |
| 4 Net ret | | | | | | | | | | | | |
| 5 Randevu | | | | | | | | | | | | |
| 6 Beni aramayın | | | | | | | | | | | | |
| 7 Yanlış kişi | | | | | | | | | | | | |
| 8 Uzun konuşma | | | | | | | | | | | | |
| 9 Bakiye bitişi | | | | | | | | | | | | |
| 10 Saat dışı | | | | | | | | | | | | |
| 11 3 eşzamanlı | | | | | | | | | | | | |
| 12 Deploy ortası | | | | | | | | | | | | |
