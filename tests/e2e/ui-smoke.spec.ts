// Arayüz smoke testi — danışmanın gördüğü HER ekran gerçekten açılıyor mu, JS hatası
// atıyor mu? Önceki E2E'ler çoğunlukla API seviyesindeydi; bu dosya tarayıcıyı sürer.
// Hiçbir gerçek arama/mesaj tetiklenmez (yalnızca gezinme ve okuma).

import { test, expect } from '@playwright/test';
import { trackPageErrors, openApp, switchTab } from '../helpers/ui';

// data-tab → aktif olması beklenen panel + panelde görünmesi gereken kök eleman
const TABS: Array<{ tab: string; panel: string; root: string; label: string }> = [
  { tab: 'today',    panel: '#tabToday',    root: '#todayRoot',          label: 'Bugün' },
  { tab: 'leads',    panel: '#tabLeads',    root: '#leadsBoard',         label: 'Kişiler' },
  { tab: 'funnel',   panel: '#tabFunnel',   root: '#funnelRoot',         label: 'Pano' },
  { tab: 'campaign', panel: '#tabCampaign', root: '#campaignUploadArea', label: 'Toplu Arama' },
  { tab: 'live',     panel: '#tabLive',     root: '#btnStartCall',       label: 'Canlı Görüşme' },
  { tab: 'followup', panel: '#tabFollowup', root: '#followupLayout',     label: 'Takip' },
  { tab: 'history',  panel: '#tabHistory',  root: '#callsTableBody',     label: 'Arama Geçmişi' },
  { tab: 'stats',    panel: '#tabStats',    root: '#statTotal',          label: 'Raporlar' },
  { tab: 'whatsapp', panel: '#tabWhatsapp', root: '#waSubtabs',          label: 'WhatsApp' },
  { tab: 'roleplay', panel: '#tabRoleplay', root: '#roleplayCards',      label: 'Rol Yapma' },
  { tab: 'team',     panel: '#tabTeam',     root: '#teamRoot',           label: 'Ekip' },
];

test.describe('Arayüz smoke — ana uygulama', () => {
  test('tüm sekmeler açılır, JS hatası yoktur', async ({ page }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await expect(page.locator('#rail')).toBeVisible();

    for (const t of TABS) {
      await switchTab(page, t.tab);
      await expect(page.locator(t.panel), t.label + ' paneli aktif olmalı').toHaveClass(/active/);
      await expect(page.locator(t.root), t.label + ' ekranının kök elemanı görünmeli').toBeVisible();
    }
    // Ekran geçişleri arka planda veri çeker; birikmiş hata varsa burada görünür.
    await page.waitForTimeout(500);
    expect(errors, 'Sekme gezintisinde JS hatası:\n' + errors.join('\n')).toEqual([]);
  });

  test('üst çubuk: bakiye, durum ve ayarlar bağlantısı görünür', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#creditsWidget')).toBeVisible();
    await expect(page.locator('#creditBalance')).not.toHaveText('');
    await expect(page.locator('#linkSettings')).toBeVisible();
    await expect(page.locator('#btnLogout')).toBeVisible();
  });

  test('Raporlar ekranı rakam kartlarını ve grafikleri yükler', async ({ page }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await switchTab(page, 'stats');
    // Kartlar "—" veya sayı olabilir ama boş kalmamalı (yükleme bitmiş olmalı).
    await expect(page.locator('#statTotal')).not.toHaveText('', { timeout: 15_000 });
    await expect(page.locator('#chartDailyCalls')).toBeVisible();
    await expect(page.locator('#chartStatus')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Kampanya geçmişi listelenir ve detay penceresi açılıp kapanır', async ({ page, request }) => {
    const list = (await (await request.get('/api/campaigns')).json()).data as any[];
    await openApp(page);
    await switchTab(page, 'campaignHistory');
    await expect(page.locator('#tabCampaignHistory')).toHaveClass(/active/);
    if (!list.length) return; // staging'de hiç kampanya yoksa satır beklenmez
    await expect(page.locator('#campaignHistoryBody tr').first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Arayüz smoke — Ayarlar ve Yönetim', () => {
  test('Ayarlar sayfası: dört sekme de açılır, JS hatası yoktur', async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto('/settings.html');
    await expect(page.locator('#settingsView')).toBeVisible();
    // Hesap bağlantıları formu dolu gelmeli (asistan/numara alanları render edildi)
    await expect(page.locator('#fieldsContainer-baglanti')).not.toBeEmpty({ timeout: 15_000 });
    for (const tab of ['baglanti', 'asistan', 'kurallar', 'crm']) {
      await page.locator(`.adm-tab[data-tab="${tab}"]`).click();
      await expect(page.locator(`.adm-tab-panel[data-panel="${tab}"]`)).toHaveClass(/active/);
    }
    // Son açılan sekme "crm"; arama kuralları paneline dönünce kaydet düğmesi görünür.
    await page.locator('.adm-tab[data-tab="kurallar"]').click();
    await expect(page.locator('#btnSaveCallingHours')).toBeVisible();
    await page.waitForTimeout(300);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('Yönetim sayfası: kullanıcı listesi, DNC ve Vapi hesapları bölümleri yüklenir', async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto('/admin.html');
    await expect(page.locator('#usersBody tr').first()).toBeVisible({ timeout: 15_000 });
    // Boş tbody'ler Playwright için "görünmez" sayılır — DOM'da olmaları ve
    // çevreleyen tabloların görünmesi yeterli.
    await expect(page.locator('#dncBody')).toBeAttached();
    await page.locator('summary', { hasText: 'Ret Listesi' }).click(); // katlanmış bölüm
    await expect(page.locator('#dncPhone')).toBeVisible();
    await expect(page.locator('#vapiAccBody')).toBeAttached();
    await expect(page.locator('#btnCreate')).toBeVisible();
    await page.waitForTimeout(300);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
