# Lansman Bulgu Listesi

Plan: docs/URUNLESME_TEST_PLANI.md (bölüm 6). Sınıflar: S1 bloker · S2 ana akış · S3 küçük.
Go/No-Go şartı: S1 = 0, S2 = 0, S3 ≤ 5 ve belgelenmiş.

| # | Tarih | Sınıf | Katman | Ekran / rota | Adımlar | Beklenen | Gerçekleşen | Durum | Düzeltme |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-13 | S3 | K2 | Toplu Arama | Sekmeye geç, hemen dosya yükle | Yeni liste ekranda kalır | Gecikmiş "en son kampanya" yanıtı listeyi ezdi | Kapalı | d182372 (odak değiştiyse yanıt atılır) |
| 2 | 2026-11-13 | S3 | K2 | Çıkış | Eski sürümden kalan `propcall.` anahtarıyla çıkış | Tüm veri anahtarları silinir | Listede olmayan anahtar kaldı | Kapalı | d182372 (önek bazlı temizlik) |

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
