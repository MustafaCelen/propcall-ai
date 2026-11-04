// PropCall AI — Frontend

// ─── AUTH GUARD ───────────────────────────────────────────────────────────────
// Oturum ortasında süresi dolarsa/devre dışı bırakılırsa (admin tarafından) her
// API çağrısı 401 döner — tek tek ~25 fetch() çağrısını sarmalamak yerine native
// fetch'i burada bir kez sarmalayıp otomatik login'e yönlendiriyoruz.
(function installAuthGuard() {
  const nativeFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await nativeFetch(...args);
    if (resp.status === 401 && !String(args[0]).includes('/api/auth/')) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname);
    }
    return resp;
  };
})();

// ─── STATE ───────────────────────────────────────────────────────────────────

const state = {
  activeCallId: null,
  callStartTs:  null,
  timerInterval: null,
  pollInterval:  null,
  charts: {},
  currentFilters: {},
  sseSource: null,
  historyData: [],        // Geçmiş aramalar son fetched datası (search için)
  historySearch: '',
};
const FILTER_STORAGE_KEY = 'propcall.historyFilters.v1';
const FOLLOWUP_STORAGE_KEY = 'propcall.followupSearch.v1';
const FOCUSED_CAMPAIGN_KEY = 'propcall.focusedCampaignId.v1';
const FOLLOWUP_TAB_STORAGE_KEY = 'propcall.followupActiveTab.v1';
// Aynı tarayıcıda A çıkış yapıp B girdiğinde localStorage TEMİZLENMEDEN kalırsa
// B, A'nın kaydettiği (örn. henüz "Başlat"a basılmamış toplu arama listesi —
// isim/telefon içerir) verisini görebiliyordu — gerçek bir çapraz-hesap veri
// sızıntısıydı. Çıkışta hepsi temizlenir (bkz. btnLogout); bu liste, gelecekte
// yeni bir localStorage key eklenirse unutulmaması için TEK yerden yönetiliyor.
const ALL_APP_STORAGE_KEYS = [
  FILTER_STORAGE_KEY, FOLLOWUP_STORAGE_KEY, FOCUSED_CAMPAIGN_KEY,
  FOLLOWUP_TAB_STORAGE_KEY,
];
function clearAllAppStorage() {
  try { ALL_APP_STORAGE_KEYS.forEach(k => localStorage.removeItem(k)); } catch (_) {}
}

// Çıkışın "temiz" olmadığı durumlara (tarayıcı çökmesi, oturumun elle silinmesi,
// başka bir sekmede farklı hesapla giriş vb.) karşı ikinci bir savunma hattı:
// bekleyen kampanya taslağı KİM tarafından kaydedildiyse onunla etiketlenir,
// geri yüklenirken şu anki oturumun kullanıcı ID'siyle eşleşmiyorsa atılır.
let CURRENT_USER_ID = null;

// localStorage'dan SENKRON okunuyor — sayfa yüklenir yüklenmez, herhangi bir SSE
// olayı veya loadCampaignState() fetch'i tamamlanmadan ÖNCE campaign.id doludur.
// Bu olmadan, kullanıcı birden fazla kampanyayı eşzamanlı çalıştırırken sayfa
// yenilendiğinde ilk gelen SSE campaign-update olayı (hangi kampanyadan gelirse)
// "odak" olarak benimseniyor, bu da rastgele "kendiliğinden eski kampanyaya döndü"
// hissi veriyordu — artık odak her zaman kullanıcının GERÇEKTEN seçtiği kampanyada kalıyor.
function readFocusedCampaignId() {
  try { return localStorage.getItem(FOCUSED_CAMPAIGN_KEY); } catch(_) { return null; }
}
function setFocusedCampaign(id) {
  // BAŞKA bir kampanyaya geçiliyorsa görünüm durumunu sıfırla — tablo filtresi
  // ve limit uyarısı önceki kampanyaya aitti, yenisinde yanlış bilgi gösterirdi.
  if (campaign.id !== (id || null)) {
    campaign.filter = null;
    campaign.limitReached = null;
  }
  campaign.id = id || null;
  try {
    if (id) localStorage.setItem(FOCUSED_CAMPAIGN_KEY, id);
    else localStorage.removeItem(FOCUSED_CAMPAIGN_KEY);
  } catch(_) {}
}

// TEK GERÇEK SUNUCUDUR. Excel yüklenir yüklenmez liste /api/campaign/load ile
// sunucuda 'draft' olur; tarayıcı hiçbir zaman "kaydedilmemiş liste" tutmaz.
// Bu yüzden eskiden burada duran hasUnsavedCampaignList() ve localStorage
// taslağı (savePendingCampaignDraft vb.) tamamen kaldırıldı — koruyacak bir şey
// kalmadı. Aylarca süren "liste gitti / eski kampanya geldi" hatalarının kökü, iki
// ayrı "gerçek" (tarayıcı + sunucu) tutmaktı.
const campaign = {
  id: readFocusedCampaignId(),  // var olan (kaydedilmiş) bir kampanya yüklüyse doldurulur — "Başlat"ın
                                 // bunu sıfırdan yeniden oluşturup ilerlemeyi silmesini önlemek için
  status: null,        // sunucudaki durum: 'draft' | 'running' | 'paused' | 'stopped' | 'completed'
  contacts: [],        // { name, phone, region, notes, status, vapiCallId, result }
  maxConcurrent: 1,
  running: false,
  paused: false,
  filter: null,        // aktif kova filtresi (bkz. setCampaignFilter) — null = tümü
};

// ─── DOM REFS ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

const DOM = {
  callTimer:        $('callTimer'),
  statusDot:        $('statusDot'),
  statusText:       $('statusText'),
  customerName:     $('customerName'),
  customerPhone:    $('customerPhone'),
  customerRegion:   $('customerRegion'),
  customerNotes:    $('customerNotes'),
  customerReference:$('customerReference'),
  btnStartCall:     $('btnStartCall'),
  btnEndCall:       $('btnEndCall'),
  tabBtns:          $$('.tab-btn'),
  tabContents:      $$('.tab-content'),
  liveCallBar:      $('liveCallBar'),
  liveName:         $('liveName'),
  livePhone:        $('livePhone'),
  callStatusBadge:  $('callStatusBadge'),
  callPulse:        $('callPulse'),
  liveDotBtn:       $('liveDotBtn'),
  costVapi:         $('costVapi'),
  costLLM:          $('costLLM'),
  costTTS:          $('costTTS'),
  costSTT:          $('costSTT'),
  costTotal:        $('costTotal'),
  transcriptArea:   $('transcriptArea'),
  welcomeScreen:    $('welcomeScreen'),
  filterDateFrom:   $('filterDateFrom'),
  filterDateTo:     $('filterDateTo'),
  filterIlgi:       $('filterIlgi'),
  filterAksiyon:    $('filterAksiyon'),
  filterStatus:     $('filterStatus'),
  filterRandevu:    $('filterRandevu'),
  filterScenario:   $('filterScenario'),
  btnClearFilter:   $('btnClearFilter'),
  btnExport:        $('btnExport'),
  callsTableBody:   $('callsTableBody'),
  statTotal:        $('statTotal'),
  statCompleted:    $('statCompleted'),
  statAnswerRate:   $('statAnswerRate'),
  statRandevu:      $('statRandevu'),
  statRandevuRate:  $('statRandevuRate'),
  drawerOverlay:    $('drawerOverlay'),
  callDrawer:       $('callDrawer'),
  drawerTitle:      $('drawerTitle'),
  drawerSub:        $('drawerSub'),
  drawerBody:       $('drawerBody'),
  drawerClose:      $('drawerClose'),
  btnToggleApts:    $('btnToggleApts'),
  appointmentsPanel:$('appointmentsPanel'),
  btnCloseApts:     $('btnCloseApts'),
  aptList:          $('aptList'),
  toastContainer:   $('toastContainer'),
};

// ─── INIT ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Oturum kontrolü — girişli değilse uygulamayı hiç kurmadan login'e yönlendir.
  try {
    const r = await fetch('/api/auth/session');
    if (!r.ok) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return; }
    const session = await r.json();
    CURRENT_USER_ID = session.data?.id || null;
    if (session.data?.role === 'admin' && $('linkUsers')) $('linkUsers').style.display = '';
    if (session.data && session.data.termsAcceptedVersion !== CURRENT_TERMS_VERSION) {
      showTermsGate();
      return; // Onaylanana kadar uygulamanın geri kalanı kurulmaz — kısmi/tutarsız
              // bir ekranla baş başa kalmak yerine tek bir net blokaj ekranı gösterilir.
    }
  } catch (_) {
    location.href = '/login';
    return;
  }

  if ($('btnLogout')) {
    $('btnLogout').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      clearAllAppStorage();
      location.href = '/login';
    });
  }

  initTabs();
  // Dar ekranda sol panel (müşteri formu) çekmece: başlıktaki ☰ ile açılır,
  // arka plana dokununca kapanır. Masaüstünde CSS bu kontrolleri gizler.
  const leftPanel = document.querySelector('.left-panel');
  const leftBackdrop = $('leftPanelBackdrop');
  window.setLeftPanel = open => {
    if (leftPanel) leftPanel.classList.toggle('open', !!open);
    if (leftBackdrop) leftBackdrop.classList.toggle('open', !!open);
  };
  if ($('btnLeftToggle')) $('btnLeftToggle').addEventListener('click', () => setLeftPanel(!leftPanel.classList.contains('open')));
  if (leftBackdrop) leftBackdrop.addEventListener('click', () => setLeftPanel(false));
  initCallButtons();
  initFilterBar();
  initStatsChips();
  initFollowupToolbar();
  initDrawer();
  initAppointments();
  initCampaign();
  initCampaignHistory();
  initScenarios();
  initCredits();
  connectSSE();
  loadHistory();
  loadFollowupBadge();
});

// ─── KREDİLER (Vapi + ElevenLabs) ─────────────────────────────────────────────

function initCredits() {
  const btn = $('btnCreditRefresh');
  if (btn) btn.addEventListener('click', () => { loadCredits(); loadBalance(); });
  const topupBtn = $('btnTopupBalance');
  if (topupBtn) topupBtn.addEventListener('click', startTopup);
  loadCredits();
  loadBalance();
  // 5 dakikada bir tazele
  setInterval(() => { loadCredits(); loadBalance(); }, 5 * 60 * 1000);
}

// ─── JETON (TL bakiyesi) ────────────────────────────────────────────────────
async function loadBalance() {
  try {
    const r = await fetch('/api/billing');
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    renderBalance(j.data.balanceTry);
    const topupBtn = $('btnTopupBalance');
    if (topupBtn) topupBtn.style.display = j.data.fonzipEnabled ? 'inline-block' : 'none';
  } catch (err) {
    const bEl = $('creditBalance');
    if (bEl) bEl.textContent = '—';
  }
}

// Kredi kartıyla kendi kendine jeton yükleme — tutarı sorup Fonzip'in kendi
// (hosted) ödeme sayfasını yeni sekmede açar. Kart bilgisi hiç bize uğramaz;
// ödeme tamamlanınca bakiye webhook üzerinden otomatik güncellenir (bkz.
// balance-update SSE olayı).
async function startTopup() {
  const raw = await uiPrompt('Kredi kartıyla yüklenecek tutar (TL, en az 50):', {
    title: 'Jeton Yükle', placeholder: 'örn. 100', value: '100',
  });
  if (!raw) return;
  const amount = parseFloat(String(raw).replace(',', '.'));
  if (!amount || !Number.isFinite(amount) || amount < 50) {
    toast('Geçerli bir tutar girin (en az 50 TL)', 'error');
    return;
  }

  const btn = $('btnTopupBalance');
  if (btn) { btn.disabled = true; btn.textContent = 'Hazırlanıyor...'; }
  // Sekmeyi ÖNCE, hâlâ kullanıcı tıklamasının senkron akışındayken boş olarak aç —
  // tarayıcılar (özellikle Chrome/Safari) fetch sonrası (asenkron) window.open()
  // çağrısını "kullanıcı eylemi değil" sayıp pop-up engelleyiciyle sessizce
  // bloklayabiliyor, kod hiç hata vermediği için "ekran hiç açılmadı" gibi görünüyordu.
  const payWindow = window.open('', '_blank');
  try {
    const r = await fetch('/api/billing/topup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Yükleme başlatılamadı');
    if (payWindow) {
      payWindow.location.href = j.data.link;
    } else {
      // Pop-up engellendiyse (boş sekme bile açılamadıysa) en azından linki elle
      // tıklanabilir bir toast/uyarı olarak göster, sessizce kaybolmasın.
      toast('Tarayıcı açılır pencereyi engelledi — ödeme linki: ' + j.data.link, 'error');
      return;
    }
    toast('Ödeme sayfası yeni sekmede açıldı — ödeme tamamlanınca bakiyeniz otomatik güncellenir', 'info');
  } catch (err) {
    if (payWindow) payWindow.close();
    toast('Hata: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '+ Yükle'; }
  }
}

function renderBalance(balanceTry) {
  const bEl = $('creditBalance');
  if (!bEl) return;
  bEl.textContent = Number(balanceTry).toFixed(0) + ' TL';
  // Eşikler: bir dakikalık ücretin (10 TL) katları — 1 dakikanın altı kritik,
  // 5 dakikanın altı uyarı.
  bEl.className = 'credit-val ' + creditLevelCls(balanceTry, [10, 50]);
}

async function loadCredits() {
  const vEl = $('creditVapi');
  const eEl = $('creditEl');
  const wrap = $('creditsWidget');
  try {
    const r = await fetch('/api/credits');
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Kredi alınamadı');
    const { vapi, elevenlabs } = j.data;
    const tips = [];

    if (vEl) {
      if (vapi.ok && typeof vapi.balance === 'number') {
        vEl.textContent = '$' + vapi.balance.toFixed(2);
        vEl.className = 'credit-val ' + creditLevelCls(vapi.balance, [1, 5]);
        tips.push('Vapi: $' + vapi.balance.toFixed(2) + (vapi.plan ? ' (' + vapi.plan + ')' : ''));
      } else if (vapi.link) {
        vEl.innerHTML = '<a href="' + vapi.link + '" target="_blank" class="credit-dashboard-link" title="Vapi Dashboard\'da görüntüle">Dashboard ↗</a>';
        vEl.className = 'credit-val credit-unknown';
      } else {
        vEl.textContent = '—';
        vEl.className = 'credit-val credit-unknown';
        tips.push('Vapi: ' + (vapi.error || 'bilinmiyor'));
      }
    }

    if (eEl) {
      if (elevenlabs.ok && typeof elevenlabs.remaining === 'number') {
        eEl.textContent = fmtChar(elevenlabs.remaining);
        const pct = elevenlabs.limit ? (elevenlabs.remaining / elevenlabs.limit) * 100 : 100;
        eEl.className = 'credit-val ' + (pct < 5 ? 'credit-low' : pct < 20 ? 'credit-warn' : 'credit-ok');
        tips.push('ElevenLabs: ' + fmtChar(elevenlabs.remaining) + ' / ' + fmtChar(elevenlabs.limit) + ' karakter' +
                  (elevenlabs.tier ? ' (' + elevenlabs.tier + ')' : ''));
      } else {
        eEl.textContent = '—';
        eEl.className = 'credit-val credit-unknown';
        tips.push('ElevenLabs: ' + (elevenlabs.error || 'bilinmiyor'));
      }
    }
    if (wrap) wrap.title = tips.join(' · ');
  } catch (err) {
    if (vEl) vEl.textContent = '—';
    if (eEl) eEl.textContent = '—';
    if (wrap) wrap.title = 'Kredi bilgisi alınamadı: ' + err.message;
  }
}

function creditLevelCls(v, thresholds) {
  if (v < thresholds[0]) return 'credit-low';
  if (v < thresholds[1]) return 'credit-warn';
  return 'credit-ok';
}

function fmtChar(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return Math.round(n / 1_000) + 'K';
  return String(n);
}

// ─── TABS ─────────────────────────────────────────────────────────────────────

function initTabs() {
  DOM.tabBtns.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(name) {
  DOM.tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  DOM.tabContents.forEach(c => {
    const match = (name === 'live'            && c.id === 'tabLive')            ||
                  (name === 'history'         && c.id === 'tabHistory')         ||
                  (name === 'stats'           && c.id === 'tabStats')           ||
                  (name === 'campaign'        && c.id === 'tabCampaign')        ||
                  (name === 'campaignHistory' && c.id === 'tabCampaignHistory') ||
                  (name === 'followup'        && c.id === 'tabFollowup')        ||
                  (name === 'leads'           && c.id === 'tabLeads')           ||
                  (name === 'whatsapp'        && c.id === 'tabWhatsapp')        ||
                  (name === 'smartPlans'      && c.id === 'tabSmartPlans')      ||
                  (name === 'roleplay'        && c.id === 'tabRoleplay');
    c.classList.toggle('active', match);
  });
  if (name === 'campaignHistory') loadCampaignHistory();
  if (name === 'history') loadHistory();
  if (name === 'stats')   loadStats();
  if (name === 'followup') loadFollowup();
  if (name === 'leads')   loadLeads();
  if (name === 'whatsapp') loadWhatsappTab();
  if (name === 'smartPlans') loadSmartPlans();
  if (name === 'roleplay') loadRoleplayTab();
}

// ─── SSE ─────────────────────────────────────────────────────────────────────

function connectSSE() {
  if (state.sseSource) state.sseSource.close();
  const src = new EventSource('/api/events');
  state.sseSource = src;

  src.addEventListener('connected', () => {
    console.log('[SSE] Bağlandı');
    // Bağlantı yeni kurulduysa (ilk yükleme) ya da yeniden kurulduysa (örn. sunucu
    // deploy/restart) — kopukluk sırasında kaçırılmış olabilecek campaign-contact-update
    // olaylarını telafi etmek için güncel kampanya durumunu doğrudan sunucudan tazele.
    // Aksi halde tablo, kaçırılan geçişler için (örn. "bekliyor" → "arıyor") eski kalır.
    loadCampaignState();
  });

  src.addEventListener('call-started', e => {
    const { vapiCallId } = JSON.parse(e.data);
    state.activeCallId = vapiCallId;
    DOM.callPulse.classList.remove('ringing');
    updateStatus('Devam Ediyor', 'in-progress');
    setBadge('🟢 Bağlandı');
    switchTab('live');
  });

  src.addEventListener('transcript', e => {
    const d = JSON.parse(e.data);
    if (d.vapiCallId !== state.activeCallId) return;
    appendTranscriptBubble(d.role, d.text, d.timestamp);
    if (d.role === 'user') setBadge('Konuşuyor');
  });

  src.addEventListener('cost-update', e => {
    const { vapiCallId, costs } = JSON.parse(e.data);
    if (vapiCallId !== state.activeCallId) return;
    renderCosts(costs);
  });

  src.addEventListener('call-ended', e => {
    const { vapiCallId, status, endedReason, duration } = JSON.parse(e.data);

    // Takip tabı açıksa yenile (cevapsız listesi güncellensin)
    if (document.querySelector('#tabFollowup.active')) loadFollowup();
    else loadFollowupBadge();

    if (vapiCallId !== state.activeCallId) return;
    stopPollFallback();
    stopTimer();
    const label = statusLabel(status);
    updateStatus(label, status);
    setBadge(label);
    DOM.callPulse.classList.remove('active');
    DOM.liveDotBtn.classList.remove('active');
    DOM.btnStartCall.disabled = false;
    DOM.btnEndCall.disabled   = true;
    state.activeCallId = null;
    toast('Arama sona erdi: ' + (endedReason || status), 'info');
  });

  src.addEventListener('summary-ready', e => {
    const { vapiCallId, summary } = JSON.parse(e.data);

    // Takip tabı açıksa yenile
    if (document.querySelector('#tabFollowup.active')) loadFollowup();

    if (vapiCallId !== state.activeCallId) return;
    renderInlineSummary(summary);
    toast('Özet hazırlandı', 'success');
  });

  src.addEventListener('summary-error', e => {
    const { error } = JSON.parse(e.data);
    toast('Özet hatası: ' + error, 'error');
  });

  // ─── Kampanya SSE (sunucu taraflı) ─────────────────────────────────────────

  src.addEventListener('campaign-update', e => {
    const data = JSON.parse(e.data);
    // Kullanıcı birden fazla kampanyayı eşzamanlı çalıştırabiliyor — canlı sekme
    // sadece o an odaklanılan (campaign.id) kampanyayı göstermeli, arka plandaki
    // diğer kampanyaların güncellemeleri görünümü ezmemeli.
    if (campaign.id && data.id !== campaign.id) return;

    if (data.id) setFocusedCampaign(data.id);
    campaign.status       = data.status || null;
    campaign.contacts     = data.contacts || [];
    campaign.running      = data.running;
    campaign.paused       = data.paused;
    campaign.maxConcurrent = data.maxConcurrent;
    // Limit banner'ı canlı çıksın — bunlar taşınmazsa danışman limite takıldığını
    // ancak sayfayı yenileyince görürdü.
    campaign.limitReached  = data.limitReached || null;
    campaign.callLimit     = data.callLimit || 0;
    campaign.answeredLimit = data.answeredLimit || 0;
    syncCampaignButtons();
    renderCampaignTable();
    updateCampaignProgress();
    renderCallingHoursNotice(data.autoHeld);
  });

  // Kredi (Vapi/ElevenLabs) tükendiği için otomatik duraklatıldığında — bu, kullanıcının
  // fark etmeden sessizce kampanyanın durmuş kalmasını önlemek için net bir uyarı.
  src.addEventListener('campaign-credit-paused', e => {
    const { name, reason } = JSON.parse(e.data);
    toast('⚠️ "' + name + '" duraklatıldı: ' + reason, 'error');
  });

  // Akıllı Plan arka planda otomatik bir kampanya başlattığında/hiç hedef bulamadığında/
  // hata aldığında — odaklanılan kampanyadan bağımsız, ekrana bakılmasa bile görünsün.
  // Daha önce bu üç durumun HİÇBİRİ bildirilmiyordu, danışman ancak Akıllı Plan
  // sekmesine kendisi gidip bakarsa fark ediyordu.
  src.addEventListener('smart-plan-fired', e => {
    const { planName, contactCount } = JSON.parse(e.data);
    toast('🧠 "' + planName + '" otomatik başladı — ' + contactCount + ' kişi aranacak', 'info');
  });
  src.addEventListener('smart-plan-empty', e => {
    const { planName } = JSON.parse(e.data);
    toast('🧠 "' + planName + '" bugün için hedef bulamadı — kampanya açılmadı', 'info');
  });
  src.addEventListener('smart-plan-error', e => {
    const { planName, error } = JSON.parse(e.data);
    toast('⚠️ "' + planName + '" başlatılamadı: ' + error, 'error');
  });

  // Her arama sonrası jeton bakiyesi düşünce header'daki rakamı anında güncelle.
  src.addEventListener('balance-update', e => {
    const { balanceTry } = JSON.parse(e.data);
    renderBalance(balanceTry);
  });

  src.addEventListener('campaign-contact-update', e => {
    const { campaignId, index, contact, summary: sum } = JSON.parse(e.data);
    // Kampanya kimliği belirtilmişse ve ekrandakinden farklıysa yoksay. Sunucu artık
    // bu olayı HER ZAMAN campaignId ile gönderiyor; eski (kimliksiz) bir olay gelirse
    // ekrandaki kampanyaya uygulamak YANLIŞ satırı güncelleyebileceği için ona da
    // dokunmuyoruz — kaçırılan güncelleme zaten 'campaign-update'/loadCampaignState
    // ile telafi ediliyor.
    if (campaign.id && campaignId !== campaign.id) return;
    if (index >= 0 && index < campaign.contacts.length) {
      campaign.contacts[index] = contact;
      renderCampaignRow(index);
    }
    if (sum) updateCampaignProgressFromSummary(sum);
  });

  src.addEventListener('campaign-complete', e => {
    const data = JSON.parse(e.data);
    const { campaignId, randevu, total } = data;
    if (campaignId && campaign.id && campaignId !== campaign.id) {
      toast('Bir kampanya tamamlandı: ' + randevu + '/' + total + ' randevu alındı.', 'success');
      if (document.querySelector('#tabCampaignHistory.active')) loadCampaignHistory();
      return;
    }
    campaign.running = false;
    campaign.status  = 'completed';
    // Limite takılarak bittiyse panel bunu anında bilsin — banner canlı açılır.
    if (data.contacts) campaign.contacts = data.contacts;
    campaign.limitReached  = data.limitReached || null;
    if (data.callLimit     !== undefined) campaign.callLimit     = data.callLimit || 0;
    if (data.answeredLimit !== undefined) campaign.answeredLimit = data.answeredLimit || 0;
    if (data.contacts) renderCampaignTable();
    syncCampaignButtons();
    updateCampaignProgress();

    // Kampanya bir LİMİTE takılarak durduysa "🏁 Tamamlandı" demek yanıltıcı olur:
    // liste bitmedi, sadece limit doldu. Limit banner'ı (syncCampaignButtons içinde
    // çizilir) zaten ne olduğunu ve nasıl devam edileceğini anlatıyor.
    if (campaign.limitReached) {
      if (document.querySelector('#tabCampaignHistory.active')) loadCampaignHistory();
      toast('Kampanya limite ulaştı — kalan kişiler bekliyor.', 'info');
      return;
    }
    if (document.querySelector('#tabCampaignHistory.active')) loadCampaignHistory();
    // Tamamlanma banner'ı
    const bar = $('campaignProgressBar');
    if (bar) {
      const old = bar.querySelector('.campaign-complete-banner');
      if (old) old.remove();
      const banner = document.createElement('div');
      banner.className = 'campaign-complete-banner';
      const pct = total ? Math.round(randevu / total * 100) : 0;
      const unreachableCount = campaign.contacts.filter(c => c.status === 'cevapsız' || c.status === 'meşgul').length;
      banner.innerHTML =
        '🏁 <strong>Kampanya Tamamlandı!</strong> ' +
        '<span class="ccb-stat">📅 ' + randevu + ' randevu</span> · ' +
        '<span class="ccb-stat">📞 ' + total + ' kişi</span> · ' +
        '<span class="ccb-stat ccb-rate">%' + pct + ' dönüşüm</span>' +
        (unreachableCount
          ? ' <span class="ccb-hint">📵 ' + unreachableCount + ' kişiye ulaşılamadı — yukarıdaki "🔁 Yeniden çalıştır" ile aynı kampanyada tekrar arayabilirsiniz.</span>'
          : '');
      bar.appendChild(banner);
    }
    toast('Kampanya tamamlandı! ' + randevu + '/' + total + ' randevu alındı.', 'success');
  });

  src.onerror = () => {
    console.warn('[SSE] Bağlantı koptu, 3s sonra yeniden deneniyor...');
    setTimeout(connectSSE, 3000);
  };
}

// ─── CALL BUTTONS ─────────────────────────────────────────────────────────────

function initCallButtons() {
  DOM.btnStartCall.addEventListener('click', startCall);
  DOM.btnEndCall.addEventListener('click', endCall);
  DOM.btnEndCall.disabled = true;
}

async function startCall() {
  const name  = DOM.customerName.value.trim();
  const rawPhone = DOM.customerPhone.value.trim();
  const phone = cleanPhone(rawPhone);
  if (!name || !phone) {
    toast('Ad ve telefon zorunlu', 'error');
    return;
  }

  DOM.btnStartCall.disabled = true;
  DOM.btnEndCall.disabled   = false;

  DOM.liveCallBar.style.display = 'flex';
  DOM.liveName.textContent  = name;
  DOM.livePhone.textContent = phone;
  if (DOM.welcomeScreen) DOM.welcomeScreen.style.display = 'none';
  DOM.callPulse.classList.add('active', 'ringing');
  DOM.liveDotBtn.classList.add('active');

  resetCosts();
  clearTranscript();
  updateStatus('Arıyor...', 'calling');
  setBadge('Arıyor');
  startTimer();

  try {
    const scenarioId = $('scenarioSelect') ? $('scenarioSelect').value || undefined : undefined;
    const resp = await fetch('/api/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: {
          name,
          phone,
          region: DOM.customerRegion.value.trim(),
          notes:  DOM.customerNotes.value.trim(),
          reference: DOM.customerReference ? DOM.customerReference.value.trim() : '',
        },
        scenarioId,
      }),
    });
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    state.activeCallId = json.data.callId;
    startPollFallback(json.data.callId);
    toast('Arama başlatıldı', 'success');
  } catch (err) {
    toast('Arama başlatılamadı: ' + err.message, 'error');
    DOM.btnStartCall.disabled = false;
    DOM.btnEndCall.disabled   = true;
    stopTimer();
    updateStatus('Hazır', '');
  }
}

async function endCall() {
  if (!state.activeCallId) return;
  DOM.btnEndCall.disabled = true;
  stopPollFallback();
  try {
    // fetch HTTP 4xx/5xx'te throw ETMEZ — yanıtı açıkça kontrol etmezsek sunucu
    // "arama bulunamadı" dese bile kullanıcıya "sonlandırıldı" denir ve "Bitir"
    // butonu kilitli kalır (arama ekranda sonsuza kadar açık görünür).
    const r = await fetch('/api/call/' + state.activeCallId, { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(j.error || 'Arama sonlandırılamadı');
    toast('Arama sonlandırıldı', 'info');
  } catch (err) {
    toast('Sonlandırma hatası: ' + err.message, 'error');
    DOM.btnEndCall.disabled = false; // tekrar denenebilsin
  }
}

function startPollFallback(vapiCallId) {
  stopPollFallback();
  state.pollInterval = setInterval(async () => {
    if (!state.activeCallId) { stopPollFallback(); return; }
    try {
      const r = await fetch('/api/calls/' + vapiCallId);
      const j = await r.json();
      if (!j.success) return;
      const call = j.data;
      if (call.status !== 'in-progress') {
        stopPollFallback();
        // Webhook missed — recover UI
        stopTimer();
        const label = statusLabel(call.status);
        updateStatus(label, call.status);
        setBadge(label);
        DOM.callPulse.classList.remove('active');
        DOM.liveDotBtn.classList.remove('active');
        DOM.btnStartCall.disabled = false;
        DOM.btnEndCall.disabled   = true;
        state.activeCallId = null;
        if (call.summary) renderInlineSummary(call.summary);
        toast('Arama tamamlandı (webhook yok — polling ile tespit edildi)', 'info');
      }
    } catch(e) {}
  }, 10000);
}

function stopPollFallback() {
  if (state.pollInterval) {
    clearInterval(state.pollInterval);
    state.pollInterval = null;
  }
}

// ─── TIMER ───────────────────────────────────────────────────────────────────

function startTimer() {
  state.callStartTs = Date.now();
  state.timerInterval = setInterval(() => {
    const sec = Math.floor((Date.now() - state.callStartTs) / 1000);
    DOM.callTimer.textContent = fmtDuration(sec);
  }, 1000);
}

function stopTimer() {
  clearInterval(state.timerInterval);
  state.timerInterval = null;
}

function fmtDuration(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return m + ':' + s;
}

// ─── STATUS / BADGE ──────────────────────────────────────────────────────────

function updateStatus(text, cls) {
  DOM.statusText.textContent = text;
  DOM.statusDot.className = 'status-dot' + (cls ? ' dot-' + cls : '');
}

function setBadge(text) {
  DOM.callStatusBadge.textContent = text;
}

function statusLabel(status) {
  const map = {
    completed:     'Tamamlandı',
    'no-answer':   'Cevapsız',
    busy:          'Meşgul',
    failed:        'Başarısız',
    'in-progress': 'Devam Ediyor',
  };
  return map[status] || status;
}

function statusColor(status) {
  const map = {
    completed:     'var(--primary)',
    'no-answer':   'var(--orange)',
    busy:          'var(--yellow)',
    failed:        'var(--red)',
    'in-progress': 'var(--blue)',
  };
  return map[status] || 'var(--txm)';
}

function statusIcon(status) {
  const map = {
    completed:     '✅',
    'no-answer':   '📵',
    busy:          '🔴',
    failed:        '❌',
    'in-progress': '📞',
  };
  return map[status] || '—';
}

// ─── COSTS ───────────────────────────────────────────────────────────────────

function renderCosts(c) {
  const fmt = v => '$' + (v || 0).toFixed(4);
  DOM.costVapi.querySelector('b').textContent  = fmt(c.vapi);
  DOM.costLLM.querySelector('b').textContent   = fmt(c.llm);
  DOM.costTTS.querySelector('b').textContent   = fmt(c.tts);
  DOM.costSTT.querySelector('b').textContent   = fmt(c.stt);
  DOM.costTotal.querySelector('b').textContent = fmt(c.total);
}

function resetCosts() {
  [DOM.costVapi, DOM.costLLM, DOM.costTTS, DOM.costSTT, DOM.costTotal]
    .forEach(el => el.querySelector('b').textContent = '$0.0000');
}

// ─── TRANSCRIPT ───────────────────────────────────────────────────────────────

function clearTranscript() {
  Array.from(DOM.transcriptArea.childNodes).forEach(n => {
    if (n.id !== 'welcomeScreen') DOM.transcriptArea.removeChild(n);
  });
}

function appendTranscriptBubble(role, text, timestamp) {
  const wrap = document.createElement('div');
  wrap.className = 'transcript-msg ' + role;

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = role === 'assistant' ? '🤖 Asistan' : '👤 Müşteri';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = fmtTime(timestamp);

  wrap.appendChild(label);
  wrap.appendChild(bubble);
  wrap.appendChild(time);
  DOM.transcriptArea.appendChild(wrap);
  DOM.transcriptArea.scrollTop = DOM.transcriptArea.scrollHeight;
}

function renderInlineSummary(s) {
  const div = document.createElement('div');
  div.className = 'inline-summary';
  div.innerHTML =
    '<div class="inline-summary-title">📊 Özet</div>' +
    '<div class="summary-pills">' +
      randevuBadge(s) +
      ilgiBadge(s.ilgi_seviyesi) +
      (s.mulk_tipi ? '<span class="pill">🏠 ' + esc(s.mulk_tipi) + '</span>' : '') +
      '<span class="pill a-' + actionClass(s.tavsiye_edilen_aksiyon) + '">' + esc(s.tavsiye_edilen_aksiyon) + '</span>' +
    '</div>' +
    (s.ret_nedeni ? '<div class="summary-ret">❌ ' + esc(s.ret_nedeni) + '</div>' : '') +
    (s.geri_donus_notu ? '<div class="summary-note">💡 ' + esc(s.geri_donus_notu) + '</div>' : '') +
    '<div class="summary-text">' + esc(s.ozet) + '</div>';
  DOM.transcriptArea.appendChild(div);
  DOM.transcriptArea.scrollTop = DOM.transcriptArea.scrollHeight;
}

// ─── HISTORY TABLE ───────────────────────────────────────────────────────────

function initFilterBar() {
  // Filtreleri localStorage'dan geri yükle
  restoreHistoryFilters();

  // Select değiştiğinde otomatik uygula
  const autoApply = [DOM.filterDateFrom, DOM.filterDateTo, DOM.filterRandevu,
                     DOM.filterIlgi, DOM.filterAksiyon, DOM.filterStatus, DOM.filterScenario];
  autoApply.forEach(el => {
    if (el) el.addEventListener('change', () => { saveHistoryFilters(); loadHistory(); });
  });

  DOM.btnClearFilter.addEventListener('click', () => {
    DOM.filterDateFrom.value  = '';
    DOM.filterDateTo.value    = '';
    if (DOM.filterRandevu) DOM.filterRandevu.value = '';
    if (DOM.filterIlgi)    DOM.filterIlgi.value    = '';
    if (DOM.filterAksiyon) DOM.filterAksiyon.value = '';
    DOM.filterStatus.value = '';
    DOM.filterScenario.value = '';
    state.currentFilters = {};
    state.historySearch = '';
    const search = $('historySearch');
    if (search) search.value = '';
    saveHistoryFilters();
    setHistoryChip('all');
    loadHistory();
  });
  DOM.btnExport.addEventListener('click', exportCSV);

  // Hızlı dönem chip'leri
  const chipBar = $('historyChips');
  if (chipBar) {
    chipBar.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => applyHistoryChip(btn.dataset.period));
    });
  }

  // Arama kutusu — client-side filter
  const search = $('historySearch');
  if (search) {
    search.addEventListener('input', () => {
      state.historySearch = search.value.trim().toLowerCase();
      renderTable(filterHistoryData(state.historyData));
    });
  }
}

function applyHistoryChip(period) {
  setHistoryChip(period);
  const today = new Date();
  const fmt = d => d.toISOString().slice(0, 10);
  if (period === 'today') {
    DOM.filterDateFrom.value = fmt(today);
    DOM.filterDateTo.value   = fmt(today);
  } else if (period === 'yesterday') {
    const y = new Date(today); y.setDate(y.getDate() - 1);
    DOM.filterDateFrom.value = fmt(y);
    DOM.filterDateTo.value   = fmt(y);
  } else if (period === 'all') {
    DOM.filterDateFrom.value = '';
    DOM.filterDateTo.value   = '';
  } else {
    const days = parseInt(period, 10);
    const from = new Date(today); from.setDate(from.getDate() - days + 1);
    DOM.filterDateFrom.value = fmt(from);
    DOM.filterDateTo.value   = fmt(today);
  }
  saveHistoryFilters();
  loadHistory();
}

function setHistoryChip(period) {
  const bar = $('historyChips');
  if (!bar) return;
  bar.querySelectorAll('.chip').forEach(b => b.classList.toggle('active', b.dataset.period === period));
}

function saveHistoryFilters() {
  try {
    const data = {
      dateFrom:   DOM.filterDateFrom.value,
      dateTo:     DOM.filterDateTo.value,
      randevu:    DOM.filterRandevu ? DOM.filterRandevu.value : '',
      ilgi:       DOM.filterIlgi    ? DOM.filterIlgi.value    : '',
      aksiyon:    DOM.filterAksiyon ? DOM.filterAksiyon.value : '',
      status:     DOM.filterStatus.value,
      scenarioId: DOM.filterScenario ? DOM.filterScenario.value : '',
    };
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(data));
  } catch(_) {}
}

function restoreHistoryFilters() {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return;
    const f = JSON.parse(raw);
    DOM.filterDateFrom.value = f.dateFrom || '';
    DOM.filterDateTo.value   = f.dateTo   || '';
    if (DOM.filterRandevu && f.randevu)    DOM.filterRandevu.value = f.randevu;
    if (DOM.filterIlgi    && f.ilgi)       DOM.filterIlgi.value    = f.ilgi;
    if (DOM.filterAksiyon && f.aksiyon)    DOM.filterAksiyon.value = f.aksiyon;
    if (f.status)    DOM.filterStatus.value   = f.status;
    if (DOM.filterScenario && f.scenarioId) DOM.filterScenario.value = f.scenarioId;
  } catch(_) {}
}

function filterHistoryData(arr) {
  const q = state.historySearch;
  if (!q) return arr;
  return arr.filter(c =>
    (c.customerName  || '').toLowerCase().includes(q) ||
    (c.customerPhone || '').toLowerCase().includes(q)
  );
}

async function loadHistory() {
  const params = buildFilterParams();
  state.currentFilters = params;
  DOM.callsTableBody.innerHTML = '<tr><td colspan="9" class="table-empty">Yükleniyor...</td></tr>';
  try {
    const qs   = new URLSearchParams(params).toString();
    const resp = await fetch('/api/calls' + (qs ? '?' + qs : ''));
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    state.historyData = json.data;
    renderTable(filterHistoryData(json.data));
  } catch (err) {
    DOM.callsTableBody.innerHTML = '<tr><td colspan="9" class="table-empty">Hata: ' + err.message + '</td></tr>';
  }
}

function buildFilterParams() {
  const p = {};
  if (DOM.filterDateFrom.value)               p.dateFrom   = DOM.filterDateFrom.value;
  if (DOM.filterDateTo.value)                 p.dateTo     = DOM.filterDateTo.value;
  if (DOM.filterRandevu && DOM.filterRandevu.value) p.randevu = DOM.filterRandevu.value;
  if (DOM.filterIlgi    && DOM.filterIlgi.value)    p.ilgi    = DOM.filterIlgi.value;
  if (DOM.filterAksiyon && DOM.filterAksiyon.value) p.aksiyon = DOM.filterAksiyon.value;
  if (DOM.filterStatus.value)                 p.status     = DOM.filterStatus.value;
  if (DOM.filterScenario && DOM.filterScenario.value) p.scenarioId = DOM.filterScenario.value;
  return p;
}

function ilgiBadge(seviye) {
  if (!seviye) return '—';
  const cls = { yüksek: 'ilgi-yuksek', orta: 'ilgi-orta', düşük: 'ilgi-dusuk', yok: 'ilgi-yok' };
  return '<span class="tag ' + (cls[seviye] || '') + '">' + esc(seviye) + '</span>';
}

function renderTable(calls) {
  const counter = $('historyCounter');
  if (counter) counter.textContent = calls.length + ' kayıt';
  if (!calls.length) {
    DOM.callsTableBody.innerHTML = '<tr><td colspan="9" class="table-empty">Kayıt bulunamadı</td></tr>';
    return;
  }
  DOM.callsTableBody.innerHTML = calls.map(c => {
    const s = c.summary;
    const retStr  = s && s.ret_nedeni    ? esc(s.ret_nedeni)    : '—';
    const noteStr = s && s.geri_donus_notu ? esc(s.geri_donus_notu) : '—';
    const dur     = c.duration ? fmtDuration(c.duration) : '—';
    const trCount = c.transcript && c.transcript.length;
    const trIcon  = trCount
      ? '<span class="tc-indicator" title="' + trCount + ' mesaj">💬 ' + trCount + '</span>'
      : '<span class="tc-none" title="Transkript yok">—</span>';
    const costStr = c.costs && c.costs.total
      ? '$' + c.costs.total.toFixed(4)
      : '—';
    return '<tr class="call-row" data-id="' + c.vapiCallId + '">' +
      '<td class="dt-cell">' + fmtDateTime(c.startTime) + '</td>' +
      '<td><div class="tbl-name">' + esc(c.customerName) + '</div><div class="tbl-phone">' + esc(c.customerPhone) + '</div></td>' +
      '<td>' + statusBadge(c.status) + '</td>' +
      '<td class="dur-cell">' + dur + '</td>' +
      '<td class="tc-cell">' + trIcon + '</td>' +
      '<td>' + randevuBadge(s) + '</td>' +
      '<td>' + ilgiBadge(s && s.ilgi_seviyesi) + '</td>' +
      '<td class="tbl-cost">' + costStr + '</td>' +
      '<td class="action-cell"><button class="btn-detail" data-id="' + c.vapiCallId + '">›</button></td>' +
      '</tr>';
  }).join('');

  DOM.callsTableBody.querySelectorAll('.btn-detail').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openDrawer(btn.dataset.id); });
  });
  DOM.callsTableBody.querySelectorAll('.call-row').forEach(row => {
    row.addEventListener('click', () => openDrawer(row.dataset.id));
  });
}

function statusBadge(status) {
  const clsMap = {
    completed:     's-completed',
    'no-answer':   's-no-answer',
    busy:          's-busy',
    failed:        's-failed',
    'in-progress': 's-in-progress',
  };
  const cls = clsMap[status] || '';
  return '<span class="status-tag ' + cls + '">' +
    statusIcon(status) + ' ' + statusLabel(status) +
    '</span>';
}

function exportCSV() {
  const qs = new URLSearchParams(state.currentFilters).toString();
  const a  = document.createElement('a');
  a.href   = '/api/export' + (qs ? '?' + qs : '');
  a.download = 'propcall-export.csv';
  a.click();
}

// ─── DRAWER ──────────────────────────────────────────────────────────────────

function initDrawer() {
  DOM.drawerClose.addEventListener('click', closeDrawer);
  DOM.drawerOverlay.addEventListener('click', closeDrawer);
}

function openDrawer(vapiCallId) {
  DOM.callDrawer.classList.add('open');
  DOM.drawerOverlay.classList.add('visible');
  DOM.drawerTitle.textContent = 'Yükleniyor...';
  DOM.drawerSub.textContent   = '';
  DOM.drawerBody.innerHTML    = '<div class="drawer-loading">⏳ Yükleniyor...</div>';

  fetch('/api/calls/' + vapiCallId)
    .then(r => r.json())
    .then(json => {
      if (!json.success) throw new Error(json.error);
      renderDrawer(json.data);
    })
    .catch(err => {
      DOM.drawerBody.innerHTML = '<div class="drawer-error">Hata: ' + err.message + '</div>';
    });
}

function closeDrawer() {
  DOM.callDrawer.classList.remove('open');
  DOM.drawerOverlay.classList.remove('visible');
}

function renderDrawer(call) {
  DOM.drawerTitle.textContent = call.customerName;
  const scLabel = call.scenarioName ? ' · 🎭 ' + call.scenarioName : '';
  DOM.drawerSub.textContent   = call.customerPhone + ' · ' + fmtDateTime(call.startTime) + scLabel;

  const s    = call.summary;
  const cost = call.costs || {};

  let summaryHtml;
  if (s) {
    summaryHtml =
      '<div class="drawer-section">' +
        '<div class="drawer-section-title">📊 Özet</div>' +
        '<div class="summary-grid">' +
          '<div class="sg-item"><span class="sg-label">Randevu</span>' +
            '<span class="sg-val">' + (s.randevu_alindi ? '✅ Alındı' : '❌ Alınmadı') + '</span></div>' +
          '<div class="sg-item"><span class="sg-label">İlgi</span>' +
            '<span class="sg-val">' + ilgiBadge(s.ilgi_seviyesi) + '</span></div>' +
          '<div class="sg-item"><span class="sg-label">Aksiyon</span>' +
            '<span class="sg-val"><span class="tag a-' + actionClass(s.tavsiye_edilen_aksiyon) + '">' +
            esc(s.tavsiye_edilen_aksiyon) + '</span></span></div>' +
          (s.mulk_tipi ? '<div class="sg-item"><span class="sg-label">Mülk Tipi</span>' +
            '<span class="sg-val">' + esc(s.mulk_tipi) + '</span></div>' : '') +
          (s.ret_nedeni ? '<div class="sg-item sg-full"><span class="sg-label">Ret Nedeni</span>' +
            '<span class="sg-val">' + esc(s.ret_nedeni) + '</span></div>' : '') +
          (s.geri_donus_notu ? '<div class="sg-item sg-full sg-note"><span class="sg-label">💡 Geri Dönüş Notu</span>' +
            '<span class="sg-val">' + esc(s.geri_donus_notu) + '</span></div>' : '') +
        '</div>' +
        '<div class="summary-ozet">' + esc(s.ozet) + '</div>' +
      '</div>';
  } else {
    summaryHtml =
      '<div class="drawer-section">' +
        '<div class="drawer-section-title">📊 Özet</div>' +
        '<p class="no-summary">Henüz özet yok. ' +
          '<button class="btn-gen-summary" data-id="' + call.vapiCallId + '">Oluştur</button>' +
        '</p>' +
      '</div>';
  }

  const recProxyUrl = '/api/calls/' + encodeURIComponent(call.vapiCallId) + '/recording';
  const recPlayerHtml = call.recordingUrl
    ? '<div class="recording-player">' +
        '<div class="rp-label">🎧 Ses Kaydı</div>' +
        '<audio controls preload="none" class="rp-audio" src="' + recProxyUrl + '">' +
          '<source src="' + recProxyUrl + '">' +
          '<a href="' + recProxyUrl + '" target="_blank" class="recording-link">Tarayıcıda Aç</a>' +
        '</audio>' +
        '<a class="rp-ext-link" href="' + recProxyUrl + '" target="_blank" title="Yeni sekmede aç">↗</a>' +
      '</div>'
    : '';

  let transcriptHtml;
  if (call.transcript && call.transcript.length) {
    const plainText = call.transcript
      .map(t => (t.role === 'assistant' ? 'Asistan' : 'Müşteri') + ': ' + t.text)
      .join('\n');
    transcriptHtml =
      '<div class="drawer-section">' +
        '<div class="drawer-section-title">' +
          '💬 Transkript <span class="tr-count">(' + call.transcript.length + ' mesaj)</span>' +
          '<button class="btn-copy-tr" data-text="' + encodeURIComponent(plainText) + '">📋 Kopyala</button>' +
        '</div>' +
        '<div class="tr-search-wrap">' +
          '<input class="tr-search-input" placeholder="🔍 Transkriptte ara..." autocomplete="off"/>' +
          '<span class="tr-search-count"></span>' +
        '</div>' +
        '<div class="drawer-transcript-full" id="drawerTranscriptFull">' +
          call.transcript.map(t => {
            const isAgent = t.role === 'assistant';
            return '<div class="dtf-row ' + (isAgent ? 'agent' : 'user') + '">' +
              '<div class="dtf-who">' + (isAgent ? '🤖 Asistan' : '👤 Müşteri') + '</div>' +
              '<div class="dtf-bubble" data-text="' + encodeURIComponent(t.text) + '">' + esc(t.text) + '</div>' +
              '<div class="dtf-time">' + fmtTime(t.timestamp) + '</div>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>';
  } else {
    transcriptHtml =
      '<div class="drawer-section">' +
        '<div class="drawer-section-title">💬 Transkript</div>' +
        '<div class="tr-empty">Transkript bulunamadı — webhook olayları alınamadı veya arama çok kısa sürdü.</div>' +
      '</div>';
  }

  DOM.drawerBody.innerHTML =
    summaryHtml +
    (recPlayerHtml ? '<div class="drawer-section">' + recPlayerHtml + '</div>' : '') +
    '<div class="drawer-section">' +
      '<div class="drawer-section-title">💰 Maliyet</div>' +
      '<div class="cost-breakdown">' +
        '<div class="cb-row"><span>Vapi (platform)</span><span>$' + (cost.vapi||0).toFixed(4) + '</span></div>' +
        '<div class="cb-row"><span>Telefon Hattı</span><span>$' + (cost.twilio||0).toFixed(4) + '</span></div>' +
        '<div class="cb-row"><span>LLM (konuşma)</span><span>$' + (cost.llm||0).toFixed(4) + '</span></div>' +
        '<div class="cb-row"><span>STT (Deepgram)</span><span>$' + (cost.stt||0).toFixed(4) + '</span></div>' +
        '<div class="cb-row"><span>ElevenLabs' + (cost.tts ? ' (tahmini)' : '') + '</span><span>$' + (cost.tts||0).toFixed(4) + '</span></div>' +
        '<div class="cb-row"><span>Anthropic (özet)</span><span>$' + (cost.anthropic||0).toFixed(4) + '</span></div>' +
        '<div class="cb-row total"><span>Toplam</span><span>$' + (cost.total||0).toFixed(4) + '</span></div>' +
        (!cost.tts ? '<div class="cb-hint">ElevenLabs maliyeti Vapi tarafından raporlanmıyor — Ayarlarım\'da karakter başı ücreti girerseniz burada tahmini olarak görünür.</div>' : '') +
      '</div>' +
    '</div>' +
    transcriptHtml +
    '<div class="drawer-section">' +
      '<div class="drawer-section-title">📝 Notlar</div>' +
      '<textarea class="drawer-notes" id="drawerNotes" placeholder="Not ekle...">' + esc(call.notes || '') + '</textarea>' +
      '<div class="drawer-actions">' +
        '<label class="follow-up-label">' +
          '<input type="checkbox" id="drawerFollowUp"' + (call.followUp ? ' checked' : '') + '/> Takip gerekli' +
        '</label>' +
        '<button class="btn-save-notes" data-id="' + call.vapiCallId + '">Kaydet</button>' +
      '</div>' +
    '</div>';

  DOM.drawerBody.querySelector('.btn-save-notes').addEventListener('click', async function() {
    const id       = this.dataset.id;
    const notes    = ($('drawerNotes') || {}).value || '';
    const followUp = ($('drawerFollowUp') || {}).checked || false;
    try {
      const r = await fetch('/api/calls/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes, followUp }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error);
      toast('Kaydedildi', 'success');
    } catch (err) {
      toast('Kayıt hatası: ' + err.message, 'error');
    }
  });

  const copyBtn = DOM.drawerBody.querySelector('.btn-copy-tr');
  if (copyBtn) {
    copyBtn.addEventListener('click', function() {
      navigator.clipboard.writeText(decodeURIComponent(this.dataset.text))
        .then(() => toast('Transkript kopyalandı', 'success'))
        .catch(() => toast('Kopyalama başarısız', 'error'));
    });
  }

  // ── Transkript arama / vurgulama ──────────────────────────────────────────
  const trSearchInput = DOM.drawerBody.querySelector('.tr-search-input');
  const trSearchCount = DOM.drawerBody.querySelector('.tr-search-count');
  const trFull        = DOM.drawerBody.querySelector('#drawerTranscriptFull');
  if (trSearchInput && trFull) {
    trSearchInput.addEventListener('input', function() {
      const q = this.value.trim().toLowerCase();
      const bubbles = trFull.querySelectorAll('.dtf-bubble');
      let matchTotal = 0;
      bubbles.forEach(b => {
        const raw = decodeURIComponent(b.dataset.text || '');
        if (!q) {
          b.innerHTML = esc(raw);
          b.classList.remove('tr-bubble-match');
          return;
        }
        const lower = raw.toLowerCase();
        if (lower.includes(q)) {
          matchTotal++;
          b.classList.add('tr-bubble-match');
          // Highlight matches
          const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
          b.innerHTML = esc(raw).replace(
            new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
            m => '<mark class="tr-highlight">' + esc(m) + '</mark>'
          );
          b.scrollIntoView({ block: 'nearest' });
        } else {
          b.classList.remove('tr-bubble-match');
          b.innerHTML = esc(raw);
        }
      });
      if (trSearchCount) {
        trSearchCount.textContent = q
          ? (matchTotal > 0 ? matchTotal + ' mesajda bulundu' : 'bulunamadı')
          : '';
      }
    });
  }

  const genBtn = DOM.drawerBody.querySelector('.btn-gen-summary');
  if (genBtn) {
    genBtn.addEventListener('click', async function() {
      this.disabled = true;
      this.textContent = 'Oluşturuluyor...';
      const id = this.dataset.id;
      try {
        const r = await fetch('/api/generate-summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vapiCallId: id }),
        });
        const j = await r.json();
        if (!j.success) throw new Error(j.error);
        toast('Özet hazırlandı', 'success');
        openDrawer(id);
      } catch (err) {
        toast('Özet hatası: ' + err.message, 'error');
        this.disabled = false;
        this.textContent = 'Yeniden Dene';
      }
    });
  }
}

// ─── STATS ───────────────────────────────────────────────────────────────────

// Hazır seçim çipleri artık sadece tarih inputlarını dolduruyor — gerçek filtreleme
// state.statsPeriod gibi ayrı bir sayaç yerine doğrudan tarih/senaryo inputlarından
// okunuyor, böylece hazır seçim ile özel aralık aynı mekanizmayı paylaşıyor.
function applyStatsPeriodChip(period) {
  const dateFrom = $('statsDateFrom');
  const dateTo   = $('statsDateTo');
  if (!dateFrom || !dateTo) return;
  if (!period || period <= 0) { // Hepsi
    dateFrom.value = '';
    dateTo.value   = '';
    return;
  }
  const today = new Date();
  const from  = new Date(today);
  from.setDate(from.getDate() - (period - 1));
  dateTo.value   = today.toISOString().slice(0, 10);
  dateFrom.value = from.toISOString().slice(0, 10);
}

function initStatsChips() {
  const bar = $('statsChips');
  if (!bar) return;
  applyStatsPeriodChip(30); // varsayılan: "Son 30 gün" çipiyle eşleşen tarih aralığı

  bar.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => {
      bar.querySelectorAll('.chip').forEach(b => b.classList.toggle('active', b === btn));
      applyStatsPeriodChip(parseInt(btn.dataset.period, 10));
      loadStats();
    });
  });
  const refresh = $('statsRefresh');
  if (refresh) refresh.addEventListener('click', loadStats);

  const deactivateChips = () => bar.querySelectorAll('.chip').forEach(b => b.classList.remove('active'));
  const dateFrom = $('statsDateFrom');
  const dateTo   = $('statsDateTo');
  const scenarioSel = $('statsScenarioFilter');
  [dateFrom, dateTo, scenarioSel].forEach(el => {
    if (!el) return;
    el.addEventListener('change', () => {
      if (el !== scenarioSel) deactivateChips(); // özel tarih girilince hazır seçim aktifliği kalkar
      loadStats();
    });
  });

  const clearBtn = $('btnStatsClearFilter');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (dateFrom) dateFrom.value = '';
      if (dateTo)   dateTo.value   = '';
      if (scenarioSel) scenarioSel.value = '';
      bar.querySelectorAll('.chip').forEach(b => b.classList.toggle('active', b.dataset.period === '0'));
      loadStats();
    });
  }
}

async function loadStats() {
  try {
    const params = new URLSearchParams();
    const dateFrom   = $('statsDateFrom')?.value;
    const dateTo     = $('statsDateTo')?.value;
    const scenarioId = $('statsScenarioFilter')?.value;
    if (dateFrom)   params.set('dateFrom', dateFrom);
    if (dateTo)     params.set('dateTo', dateTo);
    if (scenarioId) params.set('scenarioId', scenarioId);
    const qs = params.toString();
    const resp = await fetch('/api/stats' + (qs ? '?' + qs : ''));
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    renderStats(json.data);
  } catch (err) {
    toast('İstatistik hatası: ' + err.message, 'error');
  }
}

function renderStats(d) {
  DOM.statTotal.textContent       = d.totalCalls;
  DOM.statCompleted.textContent   = d.completedCalls;
  DOM.statAnswerRate.textContent  = d.answerRate + '% cevap oranı';
  DOM.statRandevu.textContent     = d.randevuCount;
  DOM.statRandevuRate.textContent = d.randevuRate + '% dönüşüm oranı';

  // Cevaplanmayan (no-answer + busy + failed)
  const sbMap = {};
  (d.statusBreakdown || []).forEach(x => { sbMap[x.status] = x.count; });
  const noAns   = sbMap['no-answer'] || 0;
  const busy    = sbMap['busy']      || 0;
  const failed  = sbMap['failed']    || 0;
  const unansEl = $('statUnanswered');
  const unansBk = $('statUnansweredBreak');
  if (unansEl) unansEl.textContent = noAns + busy + failed;
  if (unansBk) unansBk.textContent = noAns + ' cevapsız · ' + busy + ' meşgul' + (failed ? ' · ' + failed + ' hata' : '');

  const avgEl = $('statAvgDuration');
  if (avgEl) avgEl.textContent = d.avgDuration ? fmtDuration(d.avgDuration) : '—';
  const costEl = $('statTotalCost');
  if (costEl) costEl.textContent = '$' + (d.totalCost || 0).toFixed(2);
  const cprEl = $('statCostPerRandevu');
  if (cprEl) cprEl.textContent = d.randevuCount
    ? '$' + (d.totalCost / d.randevuCount).toFixed(2) + ' / randevu'
    : 'henüz randevu yok';

  // Günlük chart başlığı seçili tarih aralığına göre
  const dailyTitle = $('chartDailyTitle');
  if (dailyTitle) {
    const df = $('statsDateFrom')?.value;
    const dt = $('statsDateTo')?.value;
    const labelMap = { 1: 'Bugün', 7: 'Son 7 Gün', 30: 'Son 30 Gün' };
    const short = iso => iso.slice(8, 10) + '.' + iso.slice(5, 7);
    let label = 'Tüm Zamanlar';
    if (df && dt) {
      const days = Math.round((new Date(dt) - new Date(df)) / 86400000) + 1;
      label = labelMap[days] || (short(df) + ' – ' + short(dt));
    } else if (df || dt) {
      label = (df ? short(df) + ' sonrası' : short(dt) + ' öncesi');
    }
    dailyTitle.textContent = 'Günlük Arama Sayısı — ' + label;
  }

  const labels30      = d.dailyCalls.map(x => x.date.slice(5));
  const tickColor     = '#4A5068';
  const gridColor     = 'rgba(255,255,255,0.04)';
  const legendColor   = '#8B92A9';
  const baseScales    = {
    x: { ticks: { color: tickColor, maxTicksLimit: 10, font: { size: 11 } }, grid: { color: gridColor } },
    y: { ticks: { color: tickColor, font: { size: 11 } }, grid: { color: gridColor }, beginAtZero: true },
  };
  const baseLegend    = { color: legendColor, font: { size: 11 } };
  const baseOpts      = { responsive: true, maintainAspectRatio: false, animation: { duration: 400 } };

  buildOrUpdateChart('chartDailyCalls', 'bar', {
    labels: labels30,
    datasets: [{
      label: 'Arama',
      data: d.dailyCalls.map(x => x.count),
      backgroundColor: 'rgba(0,200,150,0.25)',
      borderColor: '#00C896',
      borderWidth: 1,
      borderRadius: 3,
    }],
  }, { ...baseOpts, plugins: { legend: { labels: baseLegend } }, scales: baseScales });

  // Randevu dönüşüm trendi
  if (d.randevuTrend && d.randevuTrend.length) {
    buildOrUpdateChart('chartRandevuTrend', 'line', {
      labels: d.randevuTrend.map(x => x.date.slice(5)),
      datasets: [{
        label: 'Dönüşüm %',
        data: d.randevuTrend.map(x => x.rate),
        borderColor: '#FF9F40',
        backgroundColor: 'rgba(255,159,64,0.12)',
        borderWidth: 2,
        tension: 0.3,
        fill: true,
        pointRadius: 2,
        pointBackgroundColor: '#FF9F40',
      }],
    }, {
      ...baseOpts,
      plugins: { legend: { display: false } },
      scales: {
        ...baseScales,
        y: { ...baseScales.y, max: 100, ticks: { ...baseScales.y.ticks, callback: v => v + '%' } },
      },
    });
  }

  // Maliyet trendi
  if (d.costTrend && d.costTrend.length) {
    buildOrUpdateChart('chartCostTrend', 'line', {
      labels: d.costTrend.map(x => x.date.slice(5)),
      datasets: [{
        label: 'Maliyet ($)',
        data: d.costTrend.map(x => x.cost),
        borderColor: '#b464ff',
        backgroundColor: 'rgba(180,100,255,0.10)',
        borderWidth: 2,
        tension: 0.3,
        fill: true,
        pointRadius: 2,
        pointBackgroundColor: '#b464ff',
      }],
    }, {
      ...baseOpts,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => '$' + (ctx.parsed.y || 0).toFixed(4),
          },
        },
      },
      scales: {
        ...baseScales,
        y: { ...baseScales.y, ticks: { ...baseScales.y.ticks, callback: v => '$' + v.toFixed(3) } },
      },
    });
  }

  buildOrUpdateChart('chartIlgiDist', 'bar', {
    labels: (d.ilgiDistribution || []).map(x => x.seviye),
    datasets: [{
      label: 'Müşteri',
      data: (d.ilgiDistribution || []).map(x => x.count),
      backgroundColor: ['rgba(0,200,150,0.8)','rgba(74,158,255,0.7)','rgba(255,208,96,0.65)','rgba(74,80,104,0.6)'],
      borderColor:     ['#00C896','#4A9EFF','#FFD060','#4A5068'],
      borderWidth: 1,
      borderRadius: 4,
    }],
  }, { ...baseOpts, plugins: { legend: { display: false } }, scales: baseScales });

  buildOrUpdateChart('chartRetDist', 'bar', {
    labels: (d.retNedeniDistribution || []).map(x => x.neden),
    datasets: [{
      label: 'Ret',
      data: (d.retNedeniDistribution || []).map(x => x.count),
      backgroundColor: 'rgba(255,83,112,0.55)',
      borderColor: '#FF5370',
      borderWidth: 1,
      borderRadius: 4,
      borderSkipped: false,
    }],
  }, {
    ...baseOpts,
    indexAxis: 'y',
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: tickColor, font: { size: 11 } }, grid: { color: gridColor }, beginAtZero: true },
      y: { ticks: { color: legendColor, font: { size: 11 } }, grid: { color: gridColor } },
    },
  });

  // Saatlik dağılım
  const hours = d.hourlyDistribution || [];
  buildOrUpdateChart('chartHourly', 'bar', {
    labels: hours.map(x => String(x.hour).padStart(2, '0') + ':00'),
    datasets: [{
      label: 'Arama',
      data: hours.map(x => x.count),
      backgroundColor: 'rgba(74,158,255,0.4)',
      borderColor: '#4A9EFF',
      borderWidth: 1,
      borderRadius: 3,
    }],
  }, {
    ...baseOpts,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: tickColor, maxTicksLimit: 12, font: { size: 10 } }, grid: { color: gridColor } },
      y: { ticks: { color: tickColor, font: { size: 11 } }, grid: { color: gridColor }, beginAtZero: true },
    },
  });

  // Arama durumu dağılımı
  const statusColors = {
    'completed': '#00C896', 'no-answer': '#FF9F40', 'busy': '#FFD060',
    'failed': '#FF5370', 'in-progress': '#4A9EFF',
  };
  const statusLabels = {
    'completed': 'Tamamlandı', 'no-answer': 'Cevapsız', 'busy': 'Meşgul',
    'failed': 'Başarısız', 'in-progress': 'Devam',
  };
  const sb = d.statusBreakdown || [];
  buildOrUpdateChart('chartStatus', 'doughnut', {
    labels: sb.map(x => statusLabels[x.status] || x.status),
    datasets: [{
      data: sb.map(x => x.count),
      backgroundColor: sb.map(x => statusColors[x.status] || '#4A5068'),
      borderColor: '#12151C',
      borderWidth: 2,
    }],
  }, {
    ...baseOpts,
    cutout: '60%',
    plugins: { legend: { position: 'right', labels: { ...baseLegend, boxWidth: 10, padding: 8 } } },
  });

  // Senaryo + kaynak performans tabloları
  renderScenarioPerf(d.scenarioPerformance || []);
  renderSourcePerf(d.sourcePerformance || []);
}

function renderScenarioPerf(scenarios) {
  const tbl = $('scenarioPerfTable');
  if (!tbl) return;
  if (!scenarios.length) {
    tbl.innerHTML = '<div class="sp-empty">Henüz arama verisi yok</div>';
    return;
  }
  tbl.innerHTML =
    '<table class="sp-table">' +
      '<thead><tr><th>Senaryo</th><th>Arama</th><th>Randevu</th><th>Dönüşüm</th><th>Maliyet</th></tr></thead>' +
      '<tbody>' +
      scenarios.map(s => {
        const rateCls = s.randevuRate >= 30 ? 'sp-good' : s.randevuRate >= 15 ? 'sp-mid' : 'sp-low';
        return '<tr>' +
          '<td class="sp-name">' + esc(s.name) + '</td>' +
          '<td>' + s.calls + '</td>' +
          '<td>' + s.randevu + '</td>' +
          '<td><span class="sp-rate ' + rateCls + '">' + s.randevuRate + '%</span></td>' +
          '<td class="sp-cost">$' + (s.cost || 0).toFixed(2) + '</td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>';
}

// Hangi ilan/reklam/liste (leadSource) daha çok randevuya çeviriyor — kampanya
// yüklerken "Kaynak" sütunu girilirse dolar, yoksa kampanya adına düşer.
function renderSourcePerf(sources) {
  const tbl = $('sourcePerfTable');
  if (!tbl) return;
  if (!sources.length) {
    tbl.innerHTML = '<div class="sp-empty">Henüz arama verisi yok</div>';
    return;
  }
  tbl.innerHTML =
    '<table class="sp-table">' +
      '<thead><tr><th>Kaynak</th><th>Arama</th><th>Randevu</th><th>Dönüşüm</th><th>Maliyet</th></tr></thead>' +
      '<tbody>' +
      sources.map(s => {
        const rateCls = s.randevuRate >= 30 ? 'sp-good' : s.randevuRate >= 15 ? 'sp-mid' : 'sp-low';
        return '<tr>' +
          '<td class="sp-name">' + esc(s.source) + '</td>' +
          '<td>' + s.calls + '</td>' +
          '<td>' + s.randevu + '</td>' +
          '<td><span class="sp-rate ' + rateCls + '">' + s.randevuRate + '%</span></td>' +
          '<td class="sp-cost">$' + (s.cost || 0).toFixed(2) + '</td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>';
}

function buildOrUpdateChart(id, type, data, options) {
  const canvas = $(id);
  if (!canvas) return;
  if (state.charts[id]) {
    state.charts[id].data    = data;
    state.charts[id].options = options;
    state.charts[id].update('none');
    return;
  }
  state.charts[id] = new Chart(canvas.getContext('2d'), { type, data, options });
}

// ─── APPOINTMENTS ─────────────────────────────────────────────────────────────

function initAppointments() {
  DOM.btnToggleApts.addEventListener('click', () => {
    DOM.appointmentsPanel.classList.toggle('open');
    if (DOM.appointmentsPanel.classList.contains('open')) loadAppointments();
  });
  DOM.btnCloseApts.addEventListener('click', () => {
    DOM.appointmentsPanel.classList.remove('open');
  });
}

async function loadAppointments() {
  DOM.aptList.innerHTML = '<div class="apt-empty">Yükleniyor...</div>';
  try {
    const resp = await fetch('/api/appointments');
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    renderAppointments(json.data);
  } catch (err) {
    DOM.aptList.innerHTML = '<div class="apt-empty">Hata: ' + err.message + '</div>';
  }
}

const APT_OUTCOME_META = {
  pending: { label: '⏳ Beklemede', cls: 'apt-outcome-pending' },
  won:     { label: '✅ Satıldı',   cls: 'apt-outcome-won' },
  lost:    { label: '❌ Kaybedildi', cls: 'apt-outcome-lost' },
};

// Randevu tarih/saatini Date'e çevirir — a.date "YYYY-MM-DD", a.time "HH:MM"
function appointmentToDate(a) {
  const [y, m, d] = (a.date || '').split('-').map(Number);
  const [hh, mm]  = (a.time || '00:00').split(':').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, hh || 0, mm || 0);
}

function icsTimestamp(date) {
  const p = n => String(n).padStart(2, '0');
  return date.getUTCFullYear() + p(date.getUTCMonth() + 1) + p(date.getUTCDate()) + 'T' +
         p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + 'Z';
}

function icsEscape(s) {
  return String(s || '').replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n');
}

// Backend/OAuth gerektirmeyen v1 takvim entegrasyonu: .ics indirme + Google Calendar linki.
function downloadAppointmentIcs(a) {
  const start = appointmentToDate(a);
  if (!start) { toast('Geçersiz tarih/saat', 'error'); return; }
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PropCall AI//TR', 'BEGIN:VEVENT',
    'UID:' + a.id + '@propcall.ai',
    'DTSTAMP:' + icsTimestamp(new Date()),
    'DTSTART:' + icsTimestamp(start),
    'DTEND:' + icsTimestamp(end),
    'SUMMARY:' + icsEscape(a.customerName + ' — Randevu'),
    a.address ? 'LOCATION:' + icsEscape(a.address) : '',
    'DESCRIPTION:' + icsEscape((a.notes || '') + (a.customerPhone ? '\nTel: ' + a.customerPhone : '')),
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');

  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'randevu-' + (a.customerName || 'musteri').replace(/\s+/g, '-') + '.ics';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function googleCalendarLink(a) {
  const start = appointmentToDate(a);
  if (!start) return '#';
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: a.customerName + ' — Randevu',
    dates: icsTimestamp(start) + '/' + icsTimestamp(end),
    details: (a.notes || '') + (a.customerPhone ? '\nTel: ' + a.customerPhone : ''),
    location: a.address || '',
  });
  return 'https://calendar.google.com/calendar/render?' + params.toString();
}

function renderAppointments(apts) {
  if (!apts.length) {
    DOM.aptList.innerHTML = '<div class="apt-empty">Henüz randevu yok</div>';
    return;
  }
  DOM.aptList.innerHTML = apts.map(a => {
    const outcome = APT_OUTCOME_META[a.outcome] ? a.outcome : 'pending';
    return (
    '<div class="apt-item">' +
      '<div class="apt-info">' +
        '<div class="apt-name">' + esc(a.customerName) + '</div>' +
        '<div class="apt-meta">' + esc(a.date) + ' ' + esc(a.time) +
          (a.address ? ' · ' + esc(a.address) : '') + '</div>' +
        (a.notes ? '<div class="apt-notes">' + esc(a.notes) + '</div>' : '') +
        '<div class="apt-cal-links">' +
          '<button class="apt-cal-btn" data-ics="' + a.id + '" type="button">📥 .ics indir</button>' +
          '<a class="apt-cal-btn" href="' + googleCalendarLink(a) + '" target="_blank" rel="noopener">📅 Google Calendar</a>' +
        '</div>' +
        '<select class="apt-outcome-select ' + APT_OUTCOME_META[outcome].cls + '" data-outcome-id="' + a.id + '">' +
          Object.keys(APT_OUTCOME_META).map(k =>
            '<option value="' + k + '"' + (k === outcome ? ' selected' : '') + '>' + APT_OUTCOME_META[k].label + '</option>'
          ).join('') +
        '</select>' +
      '</div>' +
      '<button class="btn-del-apt" data-id="' + a.id + '">✕</button>' +
    '</div>'
    );
  }).join('');

  DOM.aptList.querySelectorAll('.btn-del-apt').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const r = await fetch('/api/appointments/' + btn.dataset.id, { method: 'DELETE' });
        const j = await r.json();
        if (!j.success) throw new Error(j.error);
        loadAppointments();
        toast('Randevu silindi', 'info');
      } catch (err) {
        toast('Silme hatası: ' + err.message, 'error');
      }
    });
  });

  DOM.aptList.querySelectorAll('[data-ics]').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = apts.find(x => x.id === btn.dataset.ics);
      if (a) downloadAppointmentIcs(a);
    });
  });

  DOM.aptList.querySelectorAll('.apt-outcome-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      const id = sel.dataset.outcomeId;
      const outcome = sel.value;
      sel.className = 'apt-outcome-select ' + APT_OUTCOME_META[outcome].cls;
      try {
        const r = await fetch('/api/appointments/' + id + '/outcome', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outcome }),
        });
        const j = await r.json();
        if (!j.success) throw new Error(j.error);
        toast('Randevu durumu güncellendi', 'success');
      } catch (err) {
        toast('Güncellenemedi: ' + err.message, 'error');
      }
    });
  });
}

// ─── TOAST ───────────────────────────────────────────────────────────────────

function toast(msg, type) {
  type = type || 'info';
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  DOM.toastContainer.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ─── UTILS ───────────────────────────────────────────────────────────────────

function fmtTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('tr-TR', {
      timeZone: 'Europe/Istanbul',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch(e) { return iso; }
}

function fmtDateTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('tr-TR', {
      timeZone: 'Europe/Istanbul',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch(e) { return iso; }
}

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function actionClass(action) {
  if (!action) return '';
  if (action === 'Ara')                  return 'ara';
  if (action === 'Bekleme listesine al') return 'bekle';
  if (action === 'Çevre takibi')         return 'cevre';
  if (action === 'Uğraşma')             return 'ugrasma';
  return '';
}

function randevuBadge(summary) {
  if (!summary || summary.randevu_alindi == null) return '—';
  return summary.randevu_alindi ? '<span class="randevu-yes">✅</span>' : '<span class="randevu-no">❌</span>';
}

// ─── TAKİP ───────────────────────────────────────────────────────────────────

async function loadFollowupBadge() {
  try {
    const resp = await fetch('/api/followup');
    const json = await resp.json();
    if (!json.success) return;
    const d = json.data;
    // oncelikliListe zaten manuel+ara+cevapsız'ı kişi bazında tekilleştirilmiş halde
    // içeriyor; beklemeListesi ayrı bir kategori (henüz aranmayacaklar) olduğu için ekleniyor.
    const total = (d.oncelikliListe || []).length + (d.beklemeListesi || []).length;
    const badge = $('followupBadge');
    if (badge) {
      badge.textContent = total;
      badge.style.display = total > 0 ? 'inline-block' : 'none';
    }
  } catch (_) {}
}

async function loadFollowup() {
  const layout = $('followupLayout');
  layout.innerHTML = '<div class="followup-loading">Yükleniyor...</div>';
  try {
    const resp = await fetch('/api/followup');
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    renderFollowup(json.data);
  } catch (err) {
    layout.innerHTML = '<div class="followup-loading">Hata: ' + err.message + '</div>';
  }
}

function initFollowupToolbar() {
  const search = $('followupSearch');
  if (!search) return;
  try { search.value = localStorage.getItem(FOLLOWUP_STORAGE_KEY) || ''; } catch(_) {}
  search.addEventListener('input', () => {
    try { localStorage.setItem(FOLLOWUP_STORAGE_KEY, search.value); } catch(_) {}
    if (renderFollowup._lastData) renderFollowup(renderFollowup._lastData);
  });

  const scenarioFilter = $('followupScenarioFilter');
  if (scenarioFilter) {
    scenarioFilter.addEventListener('change', () => {
      if (renderFollowup._lastData) renderFollowup(renderFollowup._lastData);
    });
  }

  const deleteBtn = $('btnDeleteOldCalls');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      const sureDelete = await uiConfirm('Bugün öncesi tüm arama kayıtları silinecek. Bu işlem geri alınamaz.', { title: 'Eski Kayıtları Sil', confirmLabel: 'Evet, sil', danger: true });
      if (!sureDelete) return;
      deleteBtn.disabled = true;
      deleteBtn.textContent = '⏳ Siliniyor...';
      try {
        const r = await fetch('/api/calls/before-today', { method: 'DELETE' });
        const j = await r.json();
        if (!j.success) throw new Error(j.error);
        toast(j.deleted + ' kayıt silindi', 'success');
        loadFollowup();
        loadFollowupBadge();
        loadHistory();
      } catch (err) {
        toast('Silme hatası: ' + err.message, 'error');
      } finally {
        deleteBtn.disabled = false;
        deleteBtn.textContent = '🗑 Bugün hariç sil';
      }
    });
  }
}

function followupMatchesSearch(c, q) {
  if (!q) return true;
  return (c.customerName  || '').toLowerCase().includes(q) ||
         (c.customerPhone || '').toLowerCase().includes(q);
}

function readFollowupActiveTab() {
  try { return localStorage.getItem(FOLLOWUP_TAB_STORAGE_KEY) || 'oncelikliListe'; } catch(_) { return 'oncelikliListe'; }
}

function renderFollowup(d) {
  renderFollowup._lastData = d;
  const layout = $('followupLayout');
  const subtabsEl = $('followupSubtabs');
  const searchInput = $('followupSearch');
  const q = searchInput ? searchInput.value.trim().toLowerCase() : '';

  // Senaryo filtresi
  const scenarioSel  = $('followupScenarioFilter');
  const scenarioFilter = scenarioSel ? scenarioSel.value : '';

  // Tüm itemleri toplayıp unique scenario isimlerini bul — select'i güncelle
  if (scenarioSel) {
    const allItems = [
      ...(d.randevuAlanlar  || []),
      ...(d.geriAranacaklar || []),
      ...(d.beklemeListesi  || []),
      ...(d.cevapsizilar    || []),
      ...(d.manuelTakip     || []),
    ];
    const names = [...new Set(allItems.map(c => c.scenarioName).filter(Boolean))].sort();
    const current = scenarioSel.value;
    scenarioSel.innerHTML = '<option value="">📋 Tüm Kampanyalar</option>' +
      names.map(n => '<option value="' + esc(n) + '"' + (current === n ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
  }

  const matchesScenario = (c) => !scenarioFilter || c.scenarioName === scenarioFilter;

  const sections = [
    {
      key: 'oncelikliListe',
      icon: '🎯',
      title: 'Bugünün Önceliği — Kimi Aramalıyım',
      color: 'oncelik',
      emptyMsg: 'Öncelikli kimse yok — harika!',
      items: d.oncelikliListe || [],
      customCard: priorityCard,
      bulk: true,
    },
    {
      key: 'cevapsizilar',
      icon: '📵',
      title: 'Cevapsız — Tekrar Ara',
      color: 'cevapsiz',
      emptyMsg: 'Tekrar aranacak kimse yok',
      items: d.cevapsizilar || [],
      customCard: cevapsizCard,
      bulk: true,
    },
    {
      key: 'randevuAlanlar',
      icon: '📅',
      title: 'Randevu Alınanlar',
      color: 'randevu',
      emptyMsg: 'Henüz randevu alınmadı',
      items: d.randevuAlanlar || [],
    },
    {
      key: 'geriAranacaklar',
      icon: '🔥',
      title: 'Geri Aranacaklar',
      color: 'ara',
      emptyMsg: 'Geri aranacak kimse yok',
      items: d.geriAranacaklar || [],
      bulk: true,
    },
    {
      key: 'beklemeListesi',
      icon: '⏳',
      title: 'İleride Ara',
      color: 'bekle',
      emptyMsg: 'Bekleme listesi boş',
      items: d.beklemeListesi || [],
      bulk: true,
    },
    {
      key: 'manuelTakip',
      icon: '🔖',
      title: 'Manuel Takip',
      color: 'manuel',
      emptyMsg: 'Manuel takip listesi boş',
      items: d.manuelTakip || [],
      customCard: (c) => followupCard(c, 'manuel', { canUnfollow: true }),
    },
  ];

  // Toplam sayaç — oncelikliListe diğer kategorilerle örtüştüğü (aynı kişi birden
  // fazla listede olabilir) için toplama dahil edilmez, sadece kendi rozetinde görünür.
  const sumEl = $('followupSummary');
  if (sumEl) {
    const countable = sections.filter(s => s.key !== 'oncelikliListe');
    const oncelikSec = sections.find(s => s.key === 'oncelikliListe');
    const total = countable.reduce((s, sec) => s + sec.items.length, 0);
    const chips = [
      '<span class="fu-sum-chip fu-sum-total">' + total + ' kişi</span>',
      ...countable.map(sec =>
        '<span class="fu-sum-chip">' + esc(sec.title.split('—')[0].trim()) + ': <b>' + sec.items.length + '</b></span>'),
    ];
    if (oncelikSec) {
      chips.push(
        '<span class="fu-sum-chip fu-sum-oncelik" title="Diğer listelerle örtüşebilir — aynı kişi birden fazla listede görünebilir, toplama dahil değil">' +
        '🎯 Öncelikli: <b>' + oncelikSec.items.length + '</b></span>',
      );
    }
    sumEl.innerHTML = chips.join('');
  }

  // Aktif alt-sekme — daha önce seçilmiş bir sekme varsa (bu render döngüsünde veya
  // localStorage'dan) onu koru; artık mevcut olmayan bir key'e denk gelirse ilkine düş.
  let activeKey = renderFollowup._activeTab || readFollowupActiveTab();
  if (!sections.some(s => s.key === activeKey)) activeKey = sections[0].key;
  renderFollowup._activeTab = activeKey;

  if (subtabsEl) {
    subtabsEl.innerHTML = sections.map(sec => {
      const filtered = sec.items.filter(c => followupMatchesSearch(c, q) && matchesScenario(c));
      const isFiltered = (q || scenarioFilter) && filtered.length !== sec.items.length;
      const countLabel = isFiltered ? (filtered.length + '/' + sec.items.length) : String(sec.items.length);
      const shortTitle = sec.title.split('—')[0].trim();
      return '<button class="fu-subtab fu-subtab-' + sec.color + (sec.key === activeKey ? ' active' : '') + '" data-key="' + sec.key + '">' +
        '<span class="fu-subtab-icon">' + sec.icon + '</span>' +
        '<span class="fu-subtab-label">' + esc(shortTitle) + '</span>' +
        '<span class="fu-subtab-count">' + countLabel + '</span>' +
      '</button>';
    }).join('');

    subtabsEl.querySelectorAll('.fu-subtab').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.key === renderFollowup._activeTab) return;
        renderFollowup._activeTab = btn.dataset.key;
        try { localStorage.setItem(FOLLOWUP_TAB_STORAGE_KEY, btn.dataset.key); } catch(_) {}
        renderFollowup(renderFollowup._lastData);
      });
    });
  }

  // Sadece aktif sekmenin listesi gösteriliyor — diğerleri karışıklık yaratmasın diye
  // gizli, sayıları yine de üstteki alt-sekme rozetlerinde görünüyor.
  const activeSec = sections.find(s => s.key === activeKey);
  const cardFn = activeSec.customCard || ((c) => followupCard(c, activeSec.color));
  const filtered = activeSec.items.filter(c => followupMatchesSearch(c, q) && matchesScenario(c));
  const cards = filtered.length
    ? filtered.map(c => cardFn(c)).join('')
    : '<div class="fu-empty">' + (q || scenarioFilter ? 'Filtreye uyan kayıt yok' : activeSec.emptyMsg) + '</div>';
  const bulkBtn = activeSec.bulk && filtered.length
    ? '<button class="fu-bulk-btn" data-bulk-key="' + activeSec.key + '">📞 Hepsini Kampanyaya At (' + filtered.length + ')</button>'
    : '';

  layout.innerHTML =
    '<div class="fu-section fu-section-solo fu-' + activeSec.color + '">' +
      (bulkBtn ? '<div class="fu-section-toolbar">' + bulkBtn + '</div>' : '') +
      '<div class="fu-list fu-list-full">' + cards + '</div>' +
    '</div>';

  layout.querySelectorAll('.fu-detail-btn').forEach(btn => {
    btn.addEventListener('click', () => openDrawer(btn.dataset.id));
  });
  layout.querySelectorAll('.fu-call-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name      = btn.dataset.name;
      const phone     = btn.dataset.phone;
      const region    = btn.dataset.region    || '';
      const reference = btn.dataset.reference || '';
      if ($('customerName'))      $('customerName').value      = name;
      if ($('customerPhone'))     $('customerPhone').value     = phone;
      if ($('customerRegion'))    $('customerRegion').value    = region;
      if ($('customerReference')) $('customerReference').value = reference;
      switchTab('live');
    });
  });

  // Manuel takipten çıkart butonu
  layout.querySelectorAll('.fu-unfollow-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      btn.disabled = true;
      try {
        const r = await fetch('/api/calls/' + id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ followUp: false }),
        });
        const j = await r.json();
        if (!j.success) throw new Error(j.error);
        toast('Takipten çıkartıldı', 'success');
        loadFollowup();
        loadFollowupBadge();
      } catch (err) {
        toast('Hata: ' + err.message, 'error');
        btn.disabled = false;
      }
    });
  });

  // Toplu kampanyaya at — her section için
  layout.querySelectorAll('.fu-bulk-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.bulkKey;
      const data = renderFollowup._lastData || {};
      const all = data[key] || [];
      const items = all.filter(c => followupMatchesSearch(c, q));
      if (!items.length) return;
      bulkLoadToCampaign(items);
    });
  });
}

// Hem çağrı kaydı (customerName/customerPhone) hem düz CampaignContact şeklini
// kabul eder; listeyi YENİ bir draft olarak sunucuya kaydeder.
async function bulkLoadToCampaign(items, name) {
  const contacts = items.map(c => ({
    name:       c.customerName ?? c.name,
    phone:      c.customerPhone ?? c.phone,
    region:     c.customerInfo?.region    ?? c.region    ?? '',
    notes:      c.customerInfo?.notes     ?? c.notes     ?? '',
    reference:  c.customerInfo?.reference ?? c.reference ?? '',
  }));
  const saved = await saveListAsDraft(contacts, name);
  if (!saved) return;
  switchTab('campaign');
  loadCampaignCallCounts();
  toast(campaign.contacts.length + ' kişi kampanyaya yüklendi ve kaydedildi — Başlat\'a basınca aramalar başlar', 'success');
}

// Son veriyi sakla — bulk btn erişimi için
renderFollowup._lastData = null;

function followupCard(c, colorClass, opts) {
  opts = opts || {};
  const s    = c.summary;
  const ilgi = s ? s.ilgi_seviyesi : null;
  const ilgiCls = ilgi === 'yüksek' ? 'heat-hot' : ilgi === 'orta' ? 'heat-warm' : ilgi === 'düşük' ? 'heat-mid' : 'heat-cold';
  const ilgiEmoji = ilgi === 'yüksek' ? '🔥' : ilgi === 'orta' ? '⚡' : ilgi === 'düşük' ? '❄️' : '—';
  const ilgiLabel = ilgi || 'belirsiz';
  const note    = s ? s.geri_donus_notu : null;
  const aksiyon = s ? s.tavsiye_edilen_aksiyon : null;
  const mulk    = s ? s.mulk_tipi : null;
  const scenario = c.scenarioName || null;
  const ago     = timeSince(c.startTime);

  const unfollowBtn = opts.canUnfollow
    ? '<button class="fu-unfollow-btn" data-id="' + c.vapiCallId + '" title="Takipten çıkart">✓</button>'
    : '';

  return '<div class="fu-row fu-' + colorClass + '">' +
    '<div class="fu-row-heat ' + ilgiCls + '" title="İlgi seviyesi: ' + ilgiLabel + '">' +
      '<span class="fu-heat-emoji">' + ilgiEmoji + '</span>' +
      '<span class="fu-heat-label">' + ilgiLabel.slice(0,3) + '</span>' +
    '</div>' +
    '<div class="fu-row-main">' +
      '<div class="fu-row-line1">' +
        '<span class="fu-name">' + esc(c.customerName) + '</span>' +
        '<span class="fu-phone">' + esc(c.customerPhone) + '</span>' +
        (mulk ? '<span class="fu-tag">' + esc(mulk) + '</span>' : '') +
        (scenario ? '<span class="fu-tag fu-tag-scenario">' + esc(scenario) + '</span>' : '') +
        '<span class="fu-ago">' + ago + '</span>' +
      '</div>' +
      (aksiyon ? '<div class="fu-row-action-hint">→ ' + esc(aksiyon) + '</div>' : '') +
      (note ? '<div class="fu-row-note">💡 ' + esc(note) + '</div>' : '') +
    '</div>' +
    '<div class="fu-row-actions">' +
      '<button class="fu-call-btn" data-id="' + c.vapiCallId + '" ' +
        'data-name="' + esc(c.customerName) + '" ' +
        'data-phone="' + esc(c.customerPhone) + '" ' +
        'data-region="' + esc((c.customerInfo && c.customerInfo.region) || '') + '" ' +
        'data-reference="' + esc((c.customerInfo && c.customerInfo.reference) || '') + '">📞 Ara</button>' +
      '<button class="fu-detail-btn" data-id="' + c.vapiCallId + '">Detay</button>' +
      unfollowBtn +
    '</div>' +
  '</div>';
}

const PRIORITY_SOURCE_CLS = { manuel: 'pr-manuel', ara: 'pr-ara', cevapsiz: 'pr-cevapsiz' };

// Birleşik öncelik listesi kartı — kaynak (manuel/sıcak lead/cevapsız) + ilgi +
// deneme sayısı gibi skor bileşenlerini şeffaf rozetler olarak gösterir,
// kullanıcı "neden bu sırada" sorusuna kartın üzerinden cevap bulabilsin.
function priorityCard(c) {
  const ago  = timeSince(c.startTime);
  const ilgi = c.summary ? c.summary.ilgi_seviyesi : null;
  const ilgiCls = ilgi === 'yüksek' ? 'heat-hot' : ilgi === 'orta' ? 'heat-warm' : ilgi === 'düşük' ? 'heat-mid' : 'heat-cold';
  const note = c.summary ? c.summary.geri_donus_notu : null;
  const srcCls = PRIORITY_SOURCE_CLS[c._prioritySource] || 'pr-cevapsiz';
  const retryBadge = c._prioritySource === 'cevapsiz' && c.retryCount
    ? '<span class="ctag ct-miss" title="Deneme sayısı">' + c.retryCount + 'x</span>' : '';

  return '<div class="fu-row fu-oncelik">' +
    '<div class="fu-row-heat ' + ilgiCls + '" title="İlgi: ' + (ilgi || '—') + '">' + (ilgi ? ilgi.slice(0,3) : '—') + '</div>' +
    '<div class="fu-row-main">' +
      '<div class="fu-row-line1">' +
        '<span class="pr-src-badge ' + srcCls + '">' + esc(c._priorityLabel || '') + '</span>' +
        '<span class="fu-name">' + esc(c.customerName) + '</span>' +
        '<span class="fu-phone">' + esc(c.customerPhone) + '</span>' +
        retryBadge +
        '<span class="fu-ago">' + ago + '</span>' +
      '</div>' +
      (note ? '<div class="fu-row-note">💡 ' + esc(note) + '</div>' : '') +
    '</div>' +
    '<div class="fu-row-actions">' +
      '<button class="fu-call-btn" data-id="' + c.vapiCallId + '" ' +
        'data-name="' + esc(c.customerName) + '" ' +
        'data-phone="' + esc(c.customerPhone) + '" ' +
        'data-region="' + esc((c.customerInfo && c.customerInfo.region) || '') + '" ' +
        'data-reference="' + esc((c.customerInfo && c.customerInfo.reference) || '') + '">📞 Ara</button>' +
      '<button class="fu-detail-btn" data-id="' + c.vapiCallId + '">Detay</button>' +
    '</div>' +
  '</div>';
}

function cevapsizCard(c) {
  const ago     = timeSince(c.startTime);
  const count   = c.retryCount || 1;
  const statusLabel = c.status === 'busy' ? 'Meşgul' : 'Cevapsız';
  const statusCls   = c.status === 'busy' ? 'ct-busy' : 'ct-miss';
  return '<div class="fu-row fu-cevapsiz">' +
    '<div class="fu-row-retry" title="Deneme sayısı">' + count + 'x</div>' +
    '<div class="fu-row-main">' +
      '<div class="fu-row-line1">' +
        '<span class="fu-name">' + esc(c.customerName) + '</span>' +
        '<span class="fu-phone">' + esc(c.customerPhone) + '</span>' +
        '<span class="ctag ' + statusCls + '">' + statusLabel + '</span>' +
        '<span class="fu-ago">' + ago + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="fu-row-actions">' +
      '<button class="fu-call-btn" data-id="' + c.vapiCallId + '" ' +
        'data-name="' + esc(c.customerName) + '" ' +
        'data-phone="' + esc(c.customerPhone) + '" ' +
        'data-region="' + esc((c.customerInfo && c.customerInfo.region) || '') + '" ' +
        'data-reference="' + esc((c.customerInfo && c.customerInfo.reference) || '') + '">📞 Tekrar</button>' +
      '<button class="fu-detail-btn" data-id="' + c.vapiCallId + '">Detay</button>' +
    '</div>' +
  '</div>';
}

function timeSince(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (days  > 0) return days  + ' gün önce';
  if (hours > 0) return hours + ' saat önce';
  if (mins  > 0) return mins  + ' dk önce';
  return 'Az önce';
}

// ─── CAMPAIGN ────────────────────────────────────────────────────────────────

function initCampaign() {
  $('btnUpload').addEventListener('click', () => $('campaignFile').click());
  $('campaignFile').addEventListener('change', onFileSelected);
  $('btnCampaignStart').addEventListener('click', campaignStart);
  $('btnCampaignPause').addEventListener('click', campaignPause);
  $('btnCampaignStop').addEventListener('click', campaignStop);
  $('btnRetryFailed').addEventListener('click', retryFailedContacts);
  $('btnCampaignRerun').addEventListener('click', rerunCampaign);
  $('campaignRerunScope').addEventListener('change', syncCampaignButtons);
  // Bırakma alanı: tablo kabına sürüklenen dosya, gizli file input ile aynı yoldan işlenir.
  const tableWrap = document.querySelector('.campaign-table-wrap');
  if (tableWrap) {
    tableWrap.addEventListener('click', e => {
      if (e.target.closest('#btnDropzonePick')) $('campaignFile').click();
    });
    ['dragenter', 'dragover'].forEach(ev => tableWrap.addEventListener(ev, e => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault(); tableWrap.classList.add('drag-over');
    }));
    ['dragleave', 'drop'].forEach(ev => tableWrap.addEventListener(ev, () => tableWrap.classList.remove('drag-over')));
    tableWrap.addEventListener('drop', e => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      e.preventDefault();
      onFileSelected({ target: { files: [file], value: '' } });
    });
  }
  // Randevu satırlarındaki Ara / WhatsApp — hem canlı panelde hem geçmiş detay
  // modalında aynı sınıflar kullanılır, tek delegasyon yeter.
  [$('campaignResultPanel'), $('cdBody')].forEach(root => {
    if (root) root.addEventListener('click', onAppointmentRowAction);
  });
  $('btnRaiseLimit').addEventListener('click', raiseCampaignLimit);
  $('btnFinishCampaign').addEventListener('click', dismissCampaignLimitBanner);
  // Durum çipleri tabloyu o kovaya filtreler — 4000 satırda "hangi 23 kişi hata
  // aldı" sorusunu tek tıkla cevaplar.
  document.querySelectorAll('.cp-stat[data-bucket]').forEach(el => {
    el.addEventListener('click', () => setCampaignFilter(el.dataset.bucket));
  });
  $('campaignConcurrency').addEventListener('change', function() {
    campaign.maxConcurrent = parseInt(this.value, 10);
  });
  // "Hayır" seçiliyse bekleme süresinin anlamı yok — pasifleştir.
  const syncRetryDelay = () => { $('campaignRetryDelay').disabled = $('campaignRetryAttempts').value === '1'; };
  $('campaignRetryAttempts').addEventListener('change', syncRetryDelay);
  syncRetryDelay();
  loadCampaignState();
}

function onFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;

  // Cok buyuk dosya tarayiciyi dondurur; kullaniciya sebebini soyle.
  const MAX_MB = 25;
  if (file.size > MAX_MB * 1024 * 1024) {
    toast('Dosya cok buyuk (' + (file.size / 1024 / 1024).toFixed(1) + ' MB). ' +
      'En fazla ' + MAX_MB + ' MB yukleyebilirsiniz — listeyi bolerek deneyin.', 'error');
    e.target.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = function(ev) {
    try {
      const wb = XLSX.read(ev.target.result, { type: 'array', codepage: 65001 });
      // Bos/bozuk dosyada SheetNames bos gelir; ws undefined olur ve
      // sheet_to_json anlamsiz bir hata firlatirdi.
      if (!wb.SheetNames || !wb.SheetNames.length) {
        toast('Dosyada okunabilir bir sayfa yok — Excel/CSV dosyasi bos olabilir.', 'error');
        return;
      }
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) {
        toast('Dosyanin ilk sayfasi okunamadi — baska bir dosya deneyin.', 'error');
        return;
      }
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      parseContacts(rows);
    } catch(err) {
      console.error('[Campaign] Dosya okuma hatasi:', err);
      toast('Dosya okunamadi: ' + (err && err.message ? err.message : 'bilinmeyen bicim') +
        '. Dosyanin .xlsx/.xls/.csv oldugundan ve bozuk olmadigindan emin olun.', 'error');
    }
  };
  // Onceden YOKTU: disk/izin hatasinda hicbir sey olmuyor, kullanici
  // "tikladim ama bir sey olmadi" diyordu.
  reader.onerror = function() {
    console.error('[Campaign] FileReader hatasi:', reader.error);
    toast('Dosya okunamadi — dosya baska bir programda acik olabilir ya da erisim izni yok.', 'error');
  };
  reader.readAsArrayBuffer(file);
  e.target.value = '';
}

// Türkiye numaralarını hangi formatta girilirse girilsin (0532..., 532...,
// 90532..., +90532... — boşluklu/tireli fark etmez) doğru +90XXXXXXXXXX
// formatına çevirir. Tanınmayan (yabancı/eksik haneli) girişlerde elimizdeki
// en iyi tahminle + ekleyip bırakır — isValidPhone sonrasında geçersizse eler.
function cleanPhone(raw) {
  let p = String(raw == null ? '' : raw).trim();
  p = p.replace(/[\s\-().]/g, '');
  if (!p) return '';

  // "00" uluslararası çevir öneki → +
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (p.startsWith('+')) return p; // zaten uluslararası formatta, dokunma

  const digits = p.replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('90') && digits.length === 12) return '+' + digits;       // 90532...
  if (digits.startsWith('0')  && digits.length === 11) return '+90' + digits.slice(1); // 0532...
  if (digits.length === 10) return '+90' + digits;                                 // 532...

  // Türkiye kalıplarından hiçbirine uymadı — yabancı numara olabilir, olduğu gibi + ekle
  return '+' + digits;
}
function isValidPhone(p) {
  return /^\+\d{10,15}$/.test(p);
}

// Ortak sütun-tespiti + satır ayrıştırma — hem Toplu Arama'nın CSV yüklemesi
// (parseContacts, aşağıda) hem Adaylar'ın müşteri veritabanı içe aktarımı
// (leads.js) tarafından kullanılır. Sonuç şekli: { rows: [{name,phone,region,
// notes,reference,leadSource}], skipped: [{row,name,reason}], phoneColumnFound }.
function parseSpreadsheetRows(rawRows) {
  if (!rawRows.length) return { rows: [], skipped: [], phoneColumnFound: true };

  let dataStart = 0;
  let colName = 0, colPhone = 1, colRegion = 2, colNotes = 3, colReference = -1, colLeadSource = -1;

  const first = rawRows[0].map(c => String(c).toLowerCase().trim());
  const phoneIdx = first.findIndex(h => h.includes('telefon') || h.includes('phone') || h.includes('tel'));
  const phoneColumnFound = phoneIdx >= 0;
  if (phoneIdx >= 0) {
    dataStart = 1;
    colPhone  = phoneIdx;
    colName   = first.findIndex(h => h.includes('ad') || h.includes('isim') || h.includes('name'));
    if (colName < 0) colName = phoneIdx === 0 ? 1 : 0;
    colRegion = first.findIndex(h => h.includes('bölge') || h.includes('bolge') || h.includes('region'));
    if (colRegion < 0) colRegion = -1;
    colNotes  = first.findIndex(h => h.includes('not') || h.includes('note'));
    if (colNotes < 0) colNotes = -1;
    colReference = first.findIndex(h => h.includes('referans') || h.includes('reference') || h.includes('ref'));
    if (colReference < 0) colReference = -1;
    colLeadSource = first.findIndex(h => h.includes('kaynak') || h.includes('source') || h.includes('ilan'));
    if (colLeadSource < 0) colLeadSource = -1;
  }

  const seenPhones = new Set();
  const skipped = [];
  const rows = [];

  for (let i = dataStart; i < rawRows.length; i++) {
    const row      = rawRows[i];
    const rawPhone = row[colPhone];
    const phone    = cleanPhone(rawPhone);
    const name     = String(row[colName] || '').trim() || ('Kişi ' + (i - dataStart + 1));
    const rowNum   = i + 1;

    if (!phone) {
      skipped.push({ row: rowNum, name, reason: 'Telefon boş' });
      continue;
    }
    if (!isValidPhone(phone)) {
      skipped.push({ row: rowNum, name, reason: 'Geçersiz numara formatı (' + esc(String(rawPhone || '')) + ')' });
      continue;
    }
    if (seenPhones.has(phone)) {
      skipped.push({ row: rowNum, name, reason: 'Mükerrer — bu numara listede zaten var' });
      continue;
    }
    seenPhones.add(phone);

    rows.push({
      name, phone,
      region:    colRegion    >= 0 ? String(row[colRegion]    || '').trim() : '',
      notes:     colNotes     >= 0 ? String(row[colNotes]     || '').trim() : '',
      reference: colReference >= 0 ? String(row[colReference] || '').trim() : '',
      leadSource: colLeadSource >= 0 ? String(row[colLeadSource] || '').trim() : '',
    });
  }

  return { rows, skipped, phoneColumnFound };
}

// YÜKLE = KAYDET. Dosya okunur okunmaz liste sunucuya gider ve 'draft' kampanya
// olur; ekran sunucudan dönen (numaraları normalize edilmiş) listeyi gösterir.
// Tarayıcı artık kendi başına liste tutmaz — F5/deploy/sekme hiçbirinde kaybolmaz.
async function parseContacts(rows) {
  if (!rows.length) { toast('Dosya boş', 'error'); return; }

  const parsed = parseSpreadsheetRows(rows);
  if (!parsed.phoneColumnFound) {
    toast('⚠️ \'Telefon\' sütunu bulunamadı — 2. sütun telefon numarası olarak varsayıldı. ' +
      'Yanlışsa dosyanızda \'Telefon\' başlıklı bir sütun olduğundan emin olun.', 'error');
  }
  if (!parsed.rows.length) {
    renderImportSummary(0, parsed.skipped);
    toast('Geçerli telefon bulunamadı', 'error');
    return;
  }

  const btnUpload = $('btnUpload');
  btnUpload.disabled = true;
  btnUpload.textContent = '⏳ Kaydediliyor…';
  try {
    const saved = await saveListAsDraft(parsed.rows);
    if (!saved) return;
    // Sunucunun elediği numaralar (örn. 11 haneli Türkiye numarası) tarayıcı
    // ön-kontrolünden geçmiş olabilir — onlar da aynı listede görünsün.
    const serverSkipped = (saved.skippedInvalid || []).map(name =>
      ({ row: '—', name, reason: 'Geçersiz numara (sunucu doğrulaması)' }));
    const skipped = parsed.skipped.concat(serverSkipped);
    renderImportSummary(campaign.contacts.length, skipped);
    toast(campaign.contacts.length + ' kişi yüklendi ve kaydedildi' +
      (skipped.length ? ' (' + skipped.length + ' atlandı)' : '') +
      ' — adı ve senaryoyu seçip Başlat\'a basın', skipped.length ? 'info' : 'success');
  } finally {
    btnUpload.disabled = false;
    btnUpload.textContent = '📂 Excel / CSV Yükle';
  }
}

// Bir kişi listesini sunucuda 'draft' kampanya olarak kaydedip ekrana uygular.
// Excel yükleme, Takip listesinden "toplu kampanyaya at" ve Kampanya Geçmişi'nden
// "yeni kampanyaya aktar" HEPSİ buradan geçer — listeyi yalnızca tarayıcıya koyan
// hiçbir yol kalmadı (kalsaydı "Başlat" o listeyi göremezdi).
async function saveListAsDraft(contacts, name) {
  try {
    const typed = $('campaignName') ? $('campaignName').value.trim() : '';
    const resp = await fetch('/api/campaign/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contacts,
        name: name || typed || undefined,
        maxConcurrent: parseInt($('campaignConcurrency').value, 10) || 1,
        // Ekranda henüz başlatılmamış bir taslak varsa yeni liste onun yerine geçer.
        replaceDraftId: (campaign.status === 'draft' && campaign.id) ? campaign.id : undefined,
      }),
    });
    const json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Liste kaydedilemedi');
    applyCampaignSnapshot(json.data);
    const eskiBanner = document.querySelector('.campaign-complete-banner');
    if (eskiBanner) eskiBanner.remove();
    return json.data;
  } catch (err) {
    toast('Liste kaydedilemedi: ' + err.message, 'error');
    return null;
  }
}

// Sunucudan gelen kampanya görünümünü ekrana uygular — loadCampaignState,
// loadSpecificCampaign ve parseContacts aynı yolu kullanır; üçü ayrı ayrı alan
// kopyalayınca biri hep bir alanı unutuyordu (örn. status, limitler).
function applyCampaignSnapshot(data) {
  setFocusedCampaign(data.id || null);
  campaign.status        = data.status || null;
  campaign.contacts      = data.contacts || [];
  campaign.running       = !!data.running;
  campaign.paused        = !!data.paused;
  campaign.maxConcurrent = data.maxConcurrent || 1;
  campaign.limitReached  = data.limitReached || null;
  campaign.callLimit     = data.callLimit || 0;
  campaign.answeredLimit = data.answeredLimit || 0;

  const sel = $('campaignConcurrency');
  if (sel) sel.value = String(campaign.maxConcurrent);
  const nameInput = $('campaignName');
  if (nameInput) nameInput.value = data.name || '';
  const scenarioSel = $('campaignScenario');
  if (scenarioSel && data.scenarioId !== undefined) scenarioSel.value = data.scenarioId || '';
  // Limitler ve tekrar arama kuralı da sunucudan gelir — F5 sonrası danışmanın
  // seçtiği değerler aynen geri gelsin, varsayılana düşmesin.
  const setVal = (id, v) => { const el = $(id); if (el) el.value = v; };
  setVal('campaignStartFrom',     data.startFromIndex ? String(data.startFromIndex + 1) : '');
  setVal('campaignCallLimit',     data.callLimit     ? String(data.callLimit)     : '');
  setVal('campaignAnsweredLimit', data.answeredLimit ? String(data.answeredLimit) : '');
  // Kampanya yoksa (boş liste) önceki taslağın değerleri kalmasın — varsayılana dön.
  setVal('campaignRetryAttempts', String(data.retryMaxAttempts  || 2));
  setVal('campaignRetryDelay',    String(data.retryDelayMinutes || 120));
  if ($('campaignRetryAttempts')) $('campaignRetryAttempts').dispatchEvent(new Event('change')); // "Hayır" ise süre pasif

  // İlerleme çubuğu (ve içindeki çipler/sonuç paneli) taslakta anlamsız — henüz hiç
  // arama yok. Görünürlük TEK yerden: çağıranlar ayrı ayrı yönetince biri hep unutuyordu.
  $('campaignProgressBar').style.display = (campaign.status && campaign.status !== 'draft') ? 'block' : 'none';

  renderCampaignTable();
  updateCampaignProgress();
  syncCampaignButtons();
  renderCallingHoursNotice(data.autoHeld);
}

function renderImportSummary(loadedCount, skipped) {
  const el = $('campaignImportSummary');
  if (!el) return;

  if (loadedCount === 0 && skipped.length === 0) {
    el.style.display = 'none';
    return;
  }

  el.style.display = 'block';
  el.classList.toggle('has-issues', skipped.length > 0);

  const warnHtml = skipped.length
    ? '<span class="is-warn" id="isToggleDetails">⚠️ ' + skipped.length + ' kayıt atlandı — detayı gizle/göster</span>'
    : '';

  el.innerHTML =
    '<div class="is-headline">' +
      '<span class="is-ok">✓ ' + loadedCount + ' kişi yüklendi</span>' +
      warnHtml +
      '<button class="is-dismiss" id="isDismiss" title="Kapat">✕</button>' +
    '</div>' +
    (skipped.length
      ? '<div class="is-details open" id="isDetails">' +
          skipped.map(s =>
            '<div class="is-row">' +
              '<span class="is-row-num">#' + s.row + '</span>' +
              '<span class="is-row-name">' + esc(s.name) + '</span>' +
              '<span class="is-row-reason">' + s.reason + '</span>' +
            '</div>'
          ).join('') +
        '</div>'
      : '');

  const toggle = $('isToggleDetails');
  if (toggle) toggle.addEventListener('click', () => $('isDetails').classList.toggle('open'));
  const dismiss = $('isDismiss');
  if (dismiss) dismiss.addEventListener('click', () => { el.style.display = 'none'; });
}

// Büyük kampanyalarda (binlerce kişi) JSON yanıtı ağır olabiliyor — yavaş/kararsız bir
// ağda (örn. başka bir PC/bağlantı) istek zaman aşımına uğrayabilir veya kesilebilirdi.
// Önceden burası sessizce yutuluyordu (catch(_) {}) — kullanıcı hiçbir hata görmeden
// kampanya verisi boş/eksik kalıyordu ("başka PC'den açınca bilgiler tam gelmiyor"
// şikayetinin kaynağı). Artık birkaç kez otomatik tekrar dener, hepsi başarısız olursa
// kullanıcıyı açıkça bilgilendirir.
async function loadCampaignState(attempt = 1) {
  const MAX_ATTEMPTS = 3;
  try {
    // Daha önce odaklanılmış belirli bir kampanya varsa (localStorage'dan, sayfa
    // yüklenirken senkron okundu) ONU iste — id vermezsek backend "en son güncellenen"e
    // düşer, bu da başka bir kampanyada arka planda aktivite varsa yanlış olanı getirir.
    const focusedId = campaign.id;

    // Odak yoksa sunucu "danışmanın en son yüklediği" kampanyayı döner
    // (createdAt'e göre — bkz. resolveEntry, campaign.ts). Tek gerçek sunucu
    // olduğu için ekranı korumaya gerek yok: ne gelirse o gösterilir.
    const qs   = focusedId ? ('?campaignId=' + encodeURIComponent(focusedId)) : '';
    let resp = await fetch('/api/campaign' + qs);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    let json = await resp.json();

    // Kayıtlı kampanya artık yok/temizlenmiş — genel "en son"a düş.
    if (focusedId && (!json.success || !json.data || !json.data.id)) {
      resp = await fetch('/api/campaign');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      json = await resp.json();
    }

    if (!json.success || !json.data || !json.data.id) {
      setFocusedCampaign(null);
      campaign.status = null;
      campaign.contacts = [];
      renderCampaignTable();
      syncCampaignButtons();
      return;
    }

    applyCampaignSnapshot(json.data);
    loadCampaignCallCounts();
    // loadCampaignState hem açılışta hem SSE bağlanınca çalışır — aynı kampanya için
    // bildirimi bir kez göster, yoksa ekranda iki özdeş toast üst üste biniyordu.
    if (loadCampaignState._toastedFor !== campaign.id) {
      loadCampaignState._toastedFor = campaign.id;
      toast(
        campaign.status === 'draft'
          ? 'Yüklediğiniz liste hazır (' + campaign.contacts.length + ' kişi) — Başlat\'a basınca aramalar başlar'
          : 'Önceki kampanya yüklendi (' + campaign.contacts.length + ' kişi)',
        'info',
      );
    }
  } catch (err) {
    if (attempt < MAX_ATTEMPTS) {
      setTimeout(() => loadCampaignState(attempt + 1), attempt * 1500);
    } else {
      console.error('[Campaign] Kampanya durumu yüklenemedi:', err);
      toast('Kampanya bilgileri yüklenemedi — bağlantınızı kontrol edip sayfayı yenileyin', 'error');
    }
  }
}

// Kampanya Geçmişi'nden yarıda kalmış (bekliyor kişisi olan) belirli bir kampanyayı
// canlı sekmeye getirir — halihazırda odaklanılan kampanyayı DEĞİŞTİRİR, arka planda
// çalışan başka bir kampanya varsa o kendi motorunda dialing'e devam eder, sadece
// görünüm değişir.
async function loadSpecificCampaign(id) {
  try {
    const resp = await fetch('/api/campaign?campaignId=' + encodeURIComponent(id));
    const json = await resp.json();
    if (!json.success || !json.data || !json.data.id) {
      toast('Kampanya yüklenemedi', 'error');
      return;
    }
    applyCampaignSnapshot(json.data);
    loadCampaignCallCounts();
    switchTab('campaign');
    closeCampaignDetail();
    toast('"' + json.data.name + '" kampanyasına geçildi (' + campaign.contacts.length + ' kişi)', 'success');
  } catch (_) {
    toast('Kampanya yüklenemedi', 'error');
  }
}

function renderCallingHoursNotice(autoHeld) {
  const el = $('callingHoursNotice');
  if (el) el.style.display = (autoHeld === 'calling-hours') ? 'block' : 'none';
  const concEl = $('concurrencyLimitNotice');
  if (concEl) concEl.style.display = (autoHeld === 'concurrency-limit') ? 'block' : 'none';
}

function syncCampaignButtons() {
  const running = campaign.running;
  const paused  = campaign.paused;
  const isDraft = campaign.status === 'draft';
  $('btnCampaignStart').disabled = (running && !paused) || !campaign.contacts.length;
  $('btnCampaignPause').disabled = !running;
  $('btnCampaignStop').disabled  = !running;
  $('btnCampaignPause').textContent = paused ? '▶ Devam Et' : '⏸ Duraklat';
  // Taslakta "Başlat" gerçekten başlatır; başlamış bir kampanyada ise ayarları
  // güncelleyip devam ettirir (sonuçları silmez) — etiket bunu açıkça söyler.
  $('btnCampaignStart').textContent = (campaign.id && !isDraft) ? '🔄 Bu Ayarlarla Devam Et' : '▶ Başlat';

  // "Devam Et"e basınca kampanya sessizce ilerlemiyormuş gibi görünmesin diye —
  // listede "başarısız" kişi varsa bunu tekrar deneme listesine almanın yolunu
  // her zaman göster (bkz. campaignResume'daki "hasDialable" kontrolü, campaign.ts).
  // Sadece GERÇEK hataları say — skipReason'lı kişiler (ret listesi / kampanya
  // limiti) sunucudaki campaignRetryFailed tarafından kasıtlı olarak atlanıyor.
  // Onları da sayarsak buton "(12)" der ama 3 kişi alır; sayı yalan söyler.
  const failedBtn = $('btnRetryFailed');
  const failedCount = campaign.contacts.filter(c =>
    c.status === 'başarısız' && (!isCampaignSkip(c) || isSkipRecoverable(c))).length;
  // Kampanya sunucuda KAYITLI degilse (campaign.id yok) bu islem yapilamaz:
  // sunucu artik campaignId zorunlu tutuyor (bkz. requireCampaignId, server.ts).
  // Pratikte kaydedilmemis listede herkes 'bekliyor' oldugu icin failedCount
  // zaten 0'dir — bu kosul niyeti acik yazar, butonun 400 almasini engeller.
  failedBtn.style.display = (failedCount && campaign.id) ? 'inline-block' : 'none';
  failedBtn.textContent = '♻️ Başarısızları Tekrar Dene (' + failedCount + ')';

  paintCampaignLimitBanner();
  paintCampaignRerunBox();
  paintCampaignResultPanel();

  // Hangi kampanyaya odaklanıldığını AÇIKÇA göster — "yanlış/eski kampanya
  // yüklendi" şikayetlerinin gerçek nedeni genelde bu: Kampanya Geçmişi'nden
  // eski bir kampanyaya "geç"ilmiş ve bu odak localStorage'da kalıcı kalmış oluyor.
  const focusNote = $('campaignFocusNote');
  if (campaign.id) {
    focusNote.style.display = 'block';
    focusNote.innerHTML = (isDraft
      ? '📌 Liste sunucuya kaydedildi, henüz başlatılmadı — '
      : '📌 Şu an düzenlediğiniz: kayıtlı bir kampanya — ') +
      '<a href="#" id="campaignFocusClear">' + (isDraft ? 'bu listeyi sil' : 'yeni boş liste başlat') + '</a>';
    const clearLink = $('campaignFocusClear');
    if (clearLink) clearLink.addEventListener('click', async e => {
      e.preventDefault();
      if (isDraft) {
        // Başlatılmamış taslak çöpe gider — geçmişte "taslak" artığı kalmasın.
        if (!confirm('Yüklenen liste silinsin mi? (Henüz hiç arama yapılmadı.)')) return;
        try {
          const r = await fetch('/api/campaigns/' + encodeURIComponent(campaign.id), { method: 'DELETE' });
          const j = await r.json();
          if (!j.success) throw new Error(j.error || 'Silinemedi');
        } catch (err) { toast('Liste silinemedi: ' + err.message, 'error'); return; }
      } else if (!confirm('Odağı temizleyip yeni boş bir liste başlatmak istediğinize emin misiniz? Mevcut liste kaydedilmiş halde Kampanya Geçmişi\'nde kalır.')) {
        return;
      }
      setFocusedCampaign(null);
      campaign.status = null;
      campaign.contacts = [];
      campaign.running = false;
      campaign.paused = false;
      // Eski kampanyadan kalan görünüm durumu yeni listeye taşınmasın — aksi halde
      // boş listede hâlâ "filtre: Hata" ya da limit banner'ı görünürdü.
      campaign.filter = null;
      campaign.limitReached = null;
      $('campaignName').value = '';
      renderCampaignTable();
      updateCampaignProgress();
      syncCampaignButtons();
      $('campaignProgressBar').style.display = 'none';
      toast('Yeni boş liste başlatıldı', 'info');
    });
  } else {
    focusNote.style.display = 'none';
  }
}

// Kampanya sayısal bir limite takıldığında ne olduğunu ve tek tıkla nasıl devam
// edileceğini gösterir. Önceden limit dolduğunda hiçbir bildirim yoktu: danışman
// sadece satırlarda kilit ikonu görüyor, kalan binlerce kişiyi kurtaramıyordu.
function paintCampaignLimitBanner() {
  const banner = $('campaignLimitBanner');
  if (!banner) return;
  const stuck = campaign.contacts.filter(c =>
    c.status === 'başarısız' && (c.skipKind === 'call-limit' || c.skipKind === 'answered-limit')).length;
  if (!campaign.limitReached || !stuck) { banner.style.display = 'none'; return; }

  const isCall = campaign.limitReached === 'call';
  const limitValue = isCall ? campaign.callLimit : campaign.answeredLimit;
  banner.style.display = 'block';
  $('campaignLimitText').innerHTML =
    '⚠️ ' + (isCall ? 'Arama limitiniz' : 'Görüşme hedefiniz') +
    ' (<strong>' + (limitValue || '—') + '</strong>) doldu — ' +
    '<strong>' + stuck + ' kişi</strong> sırada bekliyor.';
}

async function raiseCampaignLimit() {
  const isCall = campaign.limitReached === 'call';
  const label  = isCall ? 'Yeni arama limiti' : 'Yeni görüşme hedefi';
  const current = (isCall ? campaign.callLimit : campaign.answeredLimit) || 0;
  const answer = prompt(label + ' (boş bırakırsanız sınırsız olur):', String(current * 2 || ''));
  if (answer === null) return; // vazgeçildi

  const trimmed = answer.trim();
  const newLimit = trimmed === '' ? 0 : parseInt(trimmed, 10);
  if (trimmed !== '' && (!Number.isFinite(newLimit) || newLimit < 0)) {
    toast('Geçerli bir sayı girin (boş = sınırsız)', 'error');
    return;
  }
  if (newLimit !== 0 && newLimit <= current) {
    toast('Yeni limit mevcut limitten (' + current + ') büyük olmalı — ya da boş bırakıp sınırsız yapın.', 'error');
    return;
  }

  const btn = $('btnRaiseLimit');
  btn.disabled = true;
  try {
    // Mevcut /api/campaign/resume ucu zaten limit override'ını kabul ediyor ve
    // sunucu tarafında o limite takılmış kişileri kuyruğa geri alıyor
    // (bkz. campaignResume → requeueSkipped, src/campaign.ts).
    const body = { campaignId: campaign.id || undefined };
    if (isCall) body.callLimit = newLimit; else body.answeredLimit = newLimit;
    const r = await fetch('/api/campaign/resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'İşlem başarısız');
    // Sunucu kurtarma sırasında ONLARCA/BİNLERCE kişinin durumunu birden
    // değiştirdi — tek tek SSE olayı beklemek yerine listeyi tazeden çek.
    const snap = j.data || {};
    if (snap.contacts) campaign.contacts = snap.contacts;
    campaign.running       = snap.running !== undefined ? snap.running : true;
    campaign.paused        = snap.paused  !== undefined ? snap.paused  : false;
    campaign.limitReached  = snap.limitReached || null;
    campaign.callLimit     = snap.callLimit     || 0;
    campaign.answeredLimit = snap.answeredLimit || 0;
    // Formdaki limit kutusunu da güncelle, yoksa sonraki "Devam Et" eski değeri
    // geri gönderip limiti sessizce düşürürdü.
    const limitInput = $(isCall ? 'campaignCallLimit' : 'campaignAnsweredLimit');
    if (limitInput) limitInput.value = newLimit === 0 ? '' : String(newLimit);
    renderCampaignTable();
    updateCampaignProgress();
    syncCampaignButtons();
    toast(newLimit === 0
      ? 'Limit kaldırıldı — kampanya kalan kişilerle devam ediyor.'
      : 'Limit ' + newLimit + ' olarak güncellendi — kampanya devam ediyor.', 'success');
  } catch (err) {
    toast('Hata: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// "Kampanyayı bitir" — limit uyarısını kapatır, kalan kişiler atlanmış kalır.
// Kampanya zaten durmuş durumda; bayrağı SUNUCUDA da temizliyoruz, yoksa sayfa
// yenilenince banner geri gelir ve "bitir dedim ama uyarı gitmiyor" olur.
async function dismissCampaignLimitBanner() {
  campaign.limitReached = null;
  paintCampaignLimitBanner();
  try {
    await fetch('/api/campaign/dismiss-limit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId: campaign.id || undefined }),
    });
  } catch (err) {
    console.warn('[Campaign] Limit uyarısı sunucuda kapatılamadı:', err);
  }
  toast('Kampanya bitmiş sayıldı — kalan kişiler "atlandı" olarak kalır.', 'info');
}

// ─── Sonuç paneli: randevu alınanların hızlı görünümü ──────────────────────
function appointmentContacts(contacts) {
  return (contacts || []).filter(c => c.result && c.result.randevu_alindi === true);
}

function appointmentRowsHtml(list) {
  return list.map(c => {
    const r = c.result || {};
    const not = r.geri_donus_notu || r.ozet || '';
    const waDigits = String(c.phone || '').replace(/\D/g, '');
    return '<div class="crp-row">' +
      '<span class="crp-name" title="' + esc(c.name || '') + '">' + esc(c.name || '(isimsiz)') + '</span>' +
      '<span class="crp-phone">' + esc(c.phone || '') + '</span>' +
      '<span class="crp-note" title="' + esc(not) + '">' + esc(not || '—') + '</span>' +
      '<span class="crp-actions">' +
        '<button type="button" class="crp-call" data-name="' + esc(c.name || '') + '" data-phone="' + esc(c.phone || '') +
          '" data-region="' + esc(c.region || '') + '" data-reference="' + esc(c.reference || '') + '">📞 Ara</button>' +
        (waDigits ? '<a class="crp-wa" href="https://wa.me/' + waDigits + '" target="_blank" rel="noopener">💬 WhatsApp</a>' : '') +
      '</span>' +
    '</div>';
  }).join('');
}

// Hem canlı Toplu Arama panelinde hem geçmiş detay modalında aynı bölüm.
function appointmentSectionHtml(contacts, opts) {
  const list = appointmentContacts(contacts);
  const bitti = opts && opts.finished;
  if (!list.length) {
    if (!bitti) return '';
    const talked = (contacts || []).filter(c => c.status === 'tamamlandı').length;
    const unreachable = (contacts || []).filter(c => c.status === 'cevapsız' || c.status === 'meşgul').length;
    return '<div class="crp-title">📅 Randevu alınmadı ' +
      '<span class="crp-sub">' + talked + ' kişiyle görüşüldü · ' + unreachable + ' kişiye ulaşılamadı</span></div>';
  }
  return '<div class="crp-title">📅 Randevu Alınanlar (' + list.length + ')' +
      '<span class="crp-sub">tek tıkla ara ya da WhatsApp\'tan yaz</span></div>' +
    '<div class="crp-list">' + appointmentRowsHtml(list) + '</div>';
}

function paintCampaignResultPanel() {
  const el = $('campaignResultPanel');
  if (!el) return;
  const finished = campaign.status === 'completed' || campaign.status === 'stopped';
  const html = campaign.id ? appointmentSectionHtml(campaign.contacts, { finished }) : '';
  el.innerHTML = html;
  el.style.display = html ? 'block' : 'none';
}

function onAppointmentRowAction(e) {
  const btn = e.target.closest('.crp-call');
  if (!btn) return; // WhatsApp bir <a>, tarayıcı kendisi açar
  if ($('customerName'))      $('customerName').value      = btn.dataset.name || '';
  if ($('customerPhone'))     $('customerPhone').value     = btn.dataset.phone || '';
  if ($('customerRegion'))    $('customerRegion').value    = btn.dataset.region || '';
  if ($('customerReference')) $('customerReference').value = btn.dataset.reference || '';
  closeCampaignDetail();
  switchTab('live');
  if (window.innerWidth <= 900 && window.setLeftPanel) setLeftPanel(true); // form çekmecede — göster
  toast('Bilgiler canlı arama formuna aktarıldı — "Aramayı Başlat"a basın', 'info');
}

// Sunucudaki rerunMatches (campaign.ts) ile AYNI kural — sayılar butonda doğru
// görünsün, "12 kişi" deyip 3 kişi almasın.
function rerunMatchesLocal(c, scope) {
  if (c.status === 'arıyor' || c.status === 'bekliyor') return false;
  if (c.skipKind === 'dnc' || c.skipKind === 'duplicate') return false;
  const planlanan = c.status === 'tekrar-planlandı' ? c.lastOutcome : undefined;
  switch (scope) {
    case 'unanswered':  return c.status === 'cevapsız' || planlanan === 'cevapsız';
    case 'busy':        return c.status === 'meşgul'   || planlanan === 'meşgul';
    case 'unreachable': return c.status === 'cevapsız' || c.status === 'meşgul' || c.status === 'tekrar-planlandı';
    case 'failed':      return c.status === 'başarısız';
    case 'all':         return !(c.result && c.result.randevu_alindi === true);
  }
  return false;
}

// "🔁 Yeniden çalıştır" kutusu yalnızca biten/durdurulan kampanyada görünür;
// seçenekler o anki sayılarla etiketlenir, sıfır olanlar seçilemez.
function paintCampaignRerunBox() {
  const box = $('campaignRerunBox');
  if (!box) return;
  const uygun = campaign.id && !campaign.running &&
    (campaign.status === 'completed' || campaign.status === 'stopped');
  box.style.display = uygun ? 'flex' : 'none';
  if (!uygun) return;

  const sel = $('campaignRerunScope');
  const secili = sel.value || 'unreachable';
  const kapsamlar = [
    ['unreachable', 'Ulaşılamayanlar (cevapsız + meşgul)'],
    ['unanswered',  'Sadece cevapsızlar'],
    ['busy',        'Sadece meşguller'],
    ['failed',      'Hata alanlar'],
    ['all',         'Herkes (randevu alınanlar hariç)'],
  ];
  sel.innerHTML = kapsamlar.map(([k, ad]) => {
    const n = campaign.contacts.filter(c => rerunMatchesLocal(c, k)).length;
    return '<option value="' + k + '"' + (n ? '' : ' disabled') + '>' + ad + ' — ' + n + '</option>';
  }).join('');
  const seciliSayi = campaign.contacts.filter(c => rerunMatchesLocal(c, secili)).length;
  sel.value = seciliSayi ? secili : (kapsamlar.find(([k]) => campaign.contacts.some(c => rerunMatchesLocal(c, k))) || ['unreachable'])[0];
  $('btnCampaignRerun').disabled = !campaign.contacts.some(c => rerunMatchesLocal(c, sel.value));
}

async function rerunCampaign() {
  const scope = $('campaignRerunScope').value;
  const n = campaign.contacts.filter(c => rerunMatchesLocal(c, scope)).length;
  if (!n) return;
  if (!confirm(n + ' kişi aynı kampanyada tekrar aranacak; önceki sonuçlar korunur. Devam edilsin mi?')) return;
  const btn = $('btnCampaignRerun');
  btn.disabled = true;
  try {
    const r = await fetch('/api/campaign/rerun', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId: campaign.id, scope }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Yeniden çalıştırılamadı');
    if (j.data) applyCampaignSnapshot(j.data);
    $('campaignProgressBar').style.display = 'block';
    const eskiBanner = document.querySelector('.campaign-complete-banner');
    if (eskiBanner) eskiBanner.remove();
    toast(j.requeued + ' kişi kuyruğa alındı — kampanya devam ediyor', 'success');
  } catch (err) {
    toast('✗ ' + err.message, 'error');
    btn.disabled = false;
  }
}

async function retryFailedContacts() {
  const btn = $('btnRetryFailed');
  btn.disabled = true;
  try {
    const r = await fetch('/api/campaign/retry-failed', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId: campaign.id || undefined }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'İşlem başarısız');
    if (!j.retried) {
      // Kalanların NEDEN kurtarılamadığını söyle — "hiçbir şey olmadı" hissi bırakma.
      const dnc = campaign.contacts.filter(c => c.status === 'başarısız' && c.skipKind === 'dnc').length;
      const dup = campaign.contacts.filter(c => c.status === 'başarısız' && c.skipKind === 'duplicate').length;
      const parts = [];
      if (dnc) parts.push(dnc + ' kişi ret listesinde');
      if (dup) parts.push(dup + ' kişi yakın zamanda zaten arandı');
      toast(
        parts.length
          ? 'Tekrar denenecek kişi yok — ' + parts.join(', ') + '. Bunlar tekrar aranamaz.'
          : 'Tekrar denenecek başarısız kişi yok',
        'info',
      );
      return;
    }
    // Sunucu (campaignRetryFailed) kurtarılamaz atlamaları KASITLI olarak hariç
    // tutuyor — buradaki yerel güncelleme de aynı kuralı uygulamazsa ekran
    // sunucudan farklı bir durum gösterir.
    campaign.contacts.forEach(c => {
      if (c.status === 'başarısız' && (!isCampaignSkip(c) || isSkipRecoverable(c))) {
        c.status = 'bekliyor';
        c.failureReason = undefined;
        c.skipReason    = undefined;
        c.skipKind      = undefined;
        c.skipResumable = undefined;
      }
    });
    renderCampaignTable();
    updateCampaignProgress();
    syncCampaignButtons();
    toast(j.retried + ' kişi tekrar deneme listesine alındı — "Devam Et" ile aramaya devam edebilirsiniz', 'success');
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

let campaignCallCounts = {};

// Tabloda gösterilen numaralar için toplam-arama sayaçlarını çeker — tek seferde
// toplu (N+1 sorgu değil), sessizce başarısız olursa rozetler sadece görünmez
// kalır (kritik olmayan bir gösterge, tabloyu bloklamaz).
async function loadCampaignCallCounts() {
  const phones = [...new Set(campaign.contacts.map(c => c.phone).filter(Boolean))];
  if (!phones.length) return;
  try {
    const r = await fetch('/api/calls/counts-by-phone', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phones }),
    });
    const j = await r.json();
    if (j.success) { campaignCallCounts = j.data; renderCampaignTable(); }
  } catch (_) { /* rozet olmadan devam — kritik değil */ }
}

// Aktif kova filtresi (null = tümü). Çiplere tıklanınca set edilir, böylece
// danışman "23 hata" görüp tek tıkla SADECE o 23 kişiyi inceleyebilir — 4000
// satırlık bir listede tek tek aramak yerine.
const CAMPAIGN_FILTER_LABELS = {
  appointment: 'Randevu', talked: 'Görüşüldü', unreachable: 'Ulaşılamadı',
  error: 'Hata', retrying: 'Tekrar Aranacak', skipped: 'Atlandı',
  active: 'Aktif', waiting: 'Bekliyor',
};

function setCampaignFilter(bucket) {
  // Aynı çipe tekrar tıklamak filtreyi kaldırır — ayrı bir "temizle" aramaya gerek yok.
  campaign.filter = (campaign.filter === bucket) ? null : bucket;
  renderCampaignTable();
  paintCampaignFilterState();
}

function paintCampaignFilterState() {
  document.querySelectorAll('.cp-stat[data-bucket]').forEach(el => {
    el.classList.toggle('cp-stat-active', el.dataset.bucket === campaign.filter);
  });
  const note = $('campaignFilterNote');
  if (!note) return;
  if (!campaign.filter) { note.style.display = 'none'; return; }
  const shown = campaign.contacts.filter(c => categorizeCampaignContact(c) === campaign.filter).length;
  note.style.display = 'block';
  note.innerHTML = '🔍 <strong>' + shown + '</strong> kişi gösteriliyor (filtre: ' +
    esc(CAMPAIGN_FILTER_LABELS[campaign.filter] || campaign.filter) + ') — ' +
    '<a href="#" id="campaignFilterClear">tümünü göster</a>';
  const clear = $('campaignFilterClear');
  if (clear) clear.addEventListener('click', e => { e.preventDefault(); setCampaignFilter(null); });
}

function renderCampaignTable() {
  const tbody = $('campaignTableBody');
  if (!campaign.contacts.length) {
    // Boş durumda sönük bir satır yerine ilk adımı gösteren bırakma alanı.
    tbody.innerHTML = '<tr><td colspan="9" class="table-empty table-empty-drop">' +
      '<div class="camp-dropzone">' +
        '<div class="camp-dropzone-icon">📂</div>' +
        '<div class="camp-dropzone-title">Excel / CSV dosyasını buraya sürükleyin</div>' +
        '<div class="camp-dropzone-or">ya da</div>' +
        '<button type="button" class="btn-secondary" id="btnDropzonePick">Dosya Seç</button>' +
        '<div class="camp-dropzone-hint">Sütunlar: <b>Ad Soyad</b>, <b>Telefon</b> (zorunlu) · Bölge, Referans, Not (isteğe bağlı)</div>' +
      '</div></td></tr>';
    return;
  }
  // Filtrelerken ORİJİNAL indeks korunur — satır id'si (crow-N) ve renderCampaignRow
  // buna bağlı; yeniden numaralandırırsak canlı güncellemeler yanlış satıra yazar.
  const rows = campaign.contacts
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !campaign.filter || categorizeCampaignContact(c) === campaign.filter);
  tbody.innerHTML = rows.length
    ? rows.map(({ c, i }) => campaignRowHtml(c, i)).join('')
    : '<tr><td colspan="9" class="table-empty">Bu filtreye uyan kişi yok</td></tr>';
  attachCampaignRowClicks(tbody);
}

function attachCampaignRowClicks(tbody) {
  tbody.querySelectorAll('.cp-row-click').forEach(row => {
    row.addEventListener('click', () => openDrawer(row.dataset.callid));
  });
}

// Kişinin özet + status kombinasyonuna göre iş odaklı etiket üretir.
// Örn: status=tamamlandı + randevu_alindi=true → "Randevu Alındı"
//      status=tamamlandı + randevu_alindi=false → "Görüşüldü (Ret)"
//      status=cevapsız → "Cevapsız" (yeniden aranabilir, hata değil)
function resolveCampaignStatusTag(c) {
  if (c.status === 'bekliyor')   return '<span class="ctag ct-wait">Bekliyor</span>';
  if (c.status === 'arıyor')     return '<span class="ctag ct-calling">📞 Arıyor</span>';
  if (c.status === 'cevapsız')   return '<span class="ctag ct-miss">📵 Cevapsız</span>';
  if (c.status === 'meşgul')     return '<span class="ctag ct-busy">⏰ Meşgul</span>';
  // Atlanmış 'başarısız' = hiç aranmadı. Gerçek arama hatasından ayrı etiketlenir
  // (bkz. categorizeCampaignContact) ve rozet atlamanın TÜRÜNÜ söyler — danışman
  // "neden aranmadı" sorusunun cevabını tooltip açmadan görsün.
  if (c.status === 'başarısız' && isCampaignSkip(c)) {
    var skipLabel = {
      'dnc':            '🚫 Ret Listesi',
      'duplicate':      '🔁 Zaten Arandı',
      'call-limit':     '🔒 Limit Doldu',
      'answered-limit': '🔒 Hedef Doldu',
      'stopped':        '⏹ Durduruldu',
    }[c.skipKind] || '🔒 Atlandı';
    return '<span class="ctag ct-skip" title="' + esc(c.skipReason || '') + '">' + skipLabel + '</span>';
  }
  if (c.status === 'başarısız')  return '<span class="ctag ct-error" title="' + esc(c.failureReason || 'Bilinmeyen hata') + '">⚠️ Hata</span>';
  if (c.status === 'tekrar-planlandı') {
    // Teknik durum adı yerine danışmanın anlayacağı cümle: ne oldu + ne zaman tekrar aranacak.
    const neOldu = c.lastOutcome === 'meşgul' ? '⏰ Meşgul'
                 : c.lastOutcome === 'başarısız' ? '⚠️ Geçici hata'
                 : '📵 Cevapsız';
    let neZaman = '';
    if (c.nextRetryAt) {
      const t = new Date(c.nextRetryAt);
      const bugun = t.toDateString() === new Date().toDateString();
      neZaman = ' — ' + (bugun ? '' : t.toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit' }) + ' ') +
        t.toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' }) + '\'de tekrar aranacak';
    }
    return '<span class="ctag ct-retry" title="' + esc(c.failureReason || 'Otomatik tekrar aranacak') + '">' + neOldu + neZaman + '</span>';
  }
  if (c.status === 'tamamlandı') {
    if (c.result && c.result.randevu_alindi === true)  return '<span class="ctag ct-appt">✅ Randevu</span>';
    if (c.result && c.result.randevu_alindi === false) return '<span class="ctag ct-talked">💬 Görüşüldü (Ret)</span>';
    return '<span class="ctag ct-done">✅ Görüşüldü</span>';
  }
  return '<span class="ctag ct-wait">' + esc(c.status) + '</span>';
}

// Atlanan kişiyi kurtarma açısından sınıflandırır — backend'deki SKIP_KIND_RESUMABLE
// ile AYNI kural (bkz. src/campaigns.ts). Eski kayıtlarda skipKind yok, o zaman
// skipResumable boolean'ına düşülür.
function isSkipRecoverable(c) {
  if (c.skipKind) return c.skipKind === 'call-limit' || c.skipKind === 'answered-limit' || c.skipKind === 'stopped';
  return c.skipResumable === true;
}
function isCampaignSkip(c) {
  return !!c.skipReason || !!c.skipKind;
}

// Kişiyi hangi kovaya sayacağımızı belirler
function categorizeCampaignContact(c) {
  if (c.status === 'arıyor')    return 'active';
  if (c.status === 'bekliyor')  return 'waiting';
  if (c.status === 'cevapsız' || c.status === 'meşgul') return 'unreachable';
  // Atlanmış bir 'başarısız' aslında HATA DEĞİL: kişi hiç aranmadı (ret listesi,
  // tekrar arama koruması, kampanya limiti ya da durdurma). Hata kovasına sayılırsa
  // danışman panelde olmayan onlarca arıza görür — "atlandı" olarak ayrı sayılmalı.
  if (c.status === 'başarısız') return isCampaignSkip(c) ? 'skipped' : 'error';
  if (c.status === 'tekrar-planlandı') return 'retrying';
  if (c.status === 'tamamlandı') {
    if (c.result && c.result.randevu_alindi === true) return 'appointment';
    return 'talked'; // Randevu yok veya özet gelmedi ama görüşme oldu
  }
  return 'waiting';
}

function campaignRowHtml(c, i) {
  const statusTag = resolveCampaignStatusTag(c);
  // Sebep artık SATIRDA görünür — önceden yalnızca title= tooltip'indeydi, yani
  // dokunmatik cihazda hiç okunamıyordu ve danışman "neden aranmadı"yı göremiyordu.
  // Rozet zaten türü söylüyor, bu satır ayrıntıyı verir.
  const reasonText = c.skipReason || c.failureReason || '';
  const reasonLine = reasonText
    ? '<div class="cp-reason">' + esc(reasonText) + '</div>'
    : '';
  // Kampanya-bağımsız, tüm zamanlar toplam arama sayısı — aynı numara farklı
  // kampanyalarda tekrar tekrar aranmış olabilir, danışman tek bakışta görsün.
  const totalCalls = campaignCallCounts[c.phone] || 0;
  const callCountBadge = totalCalls > 1
    ? ' <span class="cp-call-count" title="Bu numara toplamda ' + totalCalls + ' kez arandı (tüm kampanyalar)">×' + totalCalls + '</span>'
    : '';

  const heat = c.result ? ilgiBadge(c.result.ilgi_seviyesi) : '<span class="tbl-dash">—</span>';
  const rdv  = c.result
    ? (c.result.randevu_alindi ? '<span class="randevu-yes">✅</span>' : '<span class="randevu-no">❌</span>')
    : '<span class="tbl-dash">—</span>';
  const ozetIcon = c.result
    ? '<span class="cp-ozet-icon" title="' + esc(c.result.ozet || 'Özet var') + '">📊</span>'
    : '';
  const clickAttr = c.vapiCallId
    ? ' class="cp-row cp-row-click" data-callid="' + c.vapiCallId + '" title="Detay için tıkla"'
    : ' class="cp-row"';

  return '<tr id="crow-' + i + '"' + clickAttr + '>' +
    '<td>' + (i + 1) + '</td>' +
    '<td>' + esc(c.name) + '</td>' +
    '<td class="dur-cell">' + esc(c.phone) + callCountBadge + '</td>' +
    '<td>' + esc(c.region || '—') + '</td>' +
    '<td>' + esc(c.reference || '—') + '</td>' +
    '<td>' + statusTag + reasonLine + '</td>' +
    '<td>' + heat + '</td>' +
    '<td>' + rdv + ' ' + ozetIcon + '</td>' +
    '<td class="dur-cell">' + (c.duration ? fmtDuration(c.duration) : '—') + '</td>' +
    '</tr>';
}

function renderCampaignRow(idx) {
  const row = $('crow-' + idx);
  if (!row) return;
  const c = campaign.contacts[idx];
  row.outerHTML = campaignRowHtml(c, idx);
  const newRow = $('crow-' + idx);
  if (newRow && newRow.classList.contains('cp-row-click')) {
    newRow.addEventListener('click', () => openDrawer(newRow.dataset.callid));
  }
}

function computeCampaignBuckets() {
  const buckets = {
    appointment:0, talked:0, unreachable:0, error:0, active:0, waiting:0, retrying:0, skipped:0,
    skippedByLimit:0, skippedByStop:0, skippedByDnc:0, skippedDuplicate:0,
  };
  campaign.contacts.forEach(c => {
    const k = categorizeCampaignContact(c);
    buckets[k] = (buckets[k] || 0) + 1;
    if (k !== 'skipped') return;
    // Atlama kırılımı — hangisinin kurtarılabilir olduğunu çipte göstermek için
    // (backend getCampaignSummary ile aynı kovalar).
    if (c.skipKind === 'call-limit' || c.skipKind === 'answered-limit') buckets.skippedByLimit++;
    else if (c.skipKind === 'stopped')   buckets.skippedByStop++;
    else if (c.skipKind === 'dnc')       buckets.skippedByDnc++;
    else if (c.skipKind === 'duplicate') buckets.skippedDuplicate++;
  });
  return buckets;
}

function paintCampaignProgress(total, done, b) {
  const pct = total ? Math.round(done / total * 100) : 0;
  $('progressText').textContent = done + ' / ' + total;
  $('progressPct').textContent  = pct + '%';
  // Segmentli çubuk — her kova toplam içindeki payı kadar yer kaplar.
  const seg = (n) => (total ? (n / total * 100) : 0) + '%';
  const setSeg = (id, n) => { const el = $(id); if (el) el.style.width = seg(n || 0); };
  setSeg('psegAppointment', b.appointment);
  setSeg('psegTalked',      b.talked);
  setSeg('psegUnreachable', b.unreachable);
  setSeg('psegError',       b.error);
  setSeg('psegSkipped',     b.skipped);

  $('psRandevu').textContent     = '✅ ' + b.appointment + ' Randevu';
  $('psTalked').textContent      = '💬 ' + b.talked      + ' Görüşüldü';
  $('psUnreachable').textContent = '📵 ' + b.unreachable + ' Ulaşılamadı';
  $('psError').textContent       = '⚠️ ' + b.error       + ' Hata';
  $('psActive').textContent      = '📞 ' + b.active      + ' Aktif';
  const retryEl = $('psRetrying');
  if (retryEl) {
    const retrying = b.retrying || 0;
    retryEl.style.display = retrying > 0 ? '' : 'none';
    retryEl.textContent = '♻️ ' + retrying + ' Tekrar Aranacak';
  }
  const skipEl = $('psSkipped');
  if (skipEl) {
    const skipped = b.skipped || 0;
    skipEl.style.display = skipped > 0 ? '' : 'none';
    // Kırılımı çipte göster: danışman "1243 atlandı" görüp ne yapacağını
    // bilemiyordu — hangisinin limit (kurtarılabilir), hangisinin ret listesi
    // (kalıcı) olduğu tek bakışta okunmalı.
    const parts = [];
    if (b.skippedByLimit)     parts.push(b.skippedByLimit + ' limit');
    if (b.skippedByStop)      parts.push(b.skippedByStop + ' durduruldu');
    if (b.skippedByDnc)       parts.push(b.skippedByDnc + ' ret listesi');
    if (b.skippedDuplicate)   parts.push(b.skippedDuplicate + ' zaten arandı');
    skipEl.textContent = '🔒 ' + skipped + ' Atlandı' + (parts.length ? ' (' + parts.join(' · ') + ')' : '');
  }
  paintCampaignFilterState();
}

function updateCampaignProgress() {
  const total = campaign.contacts.length;
  const b     = computeCampaignBuckets();
  // skipped de "işi bitmiş" bir kişidir (hiç aranmayacak) — done'a dahil edilmezse
  // ilerleme çubuğu %100'e hiç ulaşmaz ve kampanya bitti sayılmaz.
  const done  = b.appointment + b.talked + b.unreachable + b.error + b.skipped;
  paintCampaignProgress(total, done, b);

  if (done === total && total > 0) {
    syncCampaignButtons();
  }
}

function updateCampaignProgressFromSummary(sum) {
  const total = sum.total || campaign.contacts.length;
  // Backend zaten kovaları verdiyse onu kullan; yoksa local hesapla
  const b = (sum.appointment != null)
    ? {
        appointment: sum.appointment,
        talked:      sum.talked      ?? 0,
        unreachable: sum.unreachable ?? sum.fail ?? 0,
        error:       sum.error       ?? 0,
        active:      sum.active      ?? 0,
        waiting:     sum.waiting     ?? 0,
        retrying:    sum.retrying    ?? 0,
        // skipped ve kırılımı önceden BURADA AKTARILMIYORDU: canlı (SSE) güncellemede
        // atlananlar ilerlemeye hiç sayılmıyor, sayfa yenilenince sayılıyordu — aynı
        // ekran iki farklı yüzde gösteriyordu.
        skipped:          sum.skipped          ?? 0,
        skippedByLimit:   sum.skippedByLimit   ?? 0,
        skippedByStop:    sum.skippedByStop    ?? 0,
        skippedByDnc:     sum.skippedByDnc     ?? 0,
        skippedDuplicate: sum.skippedDuplicate ?? 0,
      }
    : computeCampaignBuckets();
  const done = sum.done ?? (b.appointment + b.talked + b.unreachable + b.error + b.skipped);
  paintCampaignProgress(total, done, b);
}

async function campaignStart() {
  if (!campaign.contacts.length) return;

  campaign.maxConcurrent = parseInt($('campaignConcurrency').value, 10) || 1;
  const startFromRaw    = parseInt(($('campaignStartFrom')?.value    || ''), 10);
  const callLimitRaw    = parseInt(($('campaignCallLimit')?.value     || ''), 10);
  const answeredLimitRaw = parseInt(($('campaignAnsweredLimit')?.value || ''), 10);
  const startFromIndex  = (startFromRaw  > 1  ? startFromRaw - 1 : 0); // UI 1-tabanlı → 0-tabanlı
  const callLimit       = (callLimitRaw  > 0  ? callLimitRaw   : 0);
  const answeredLimit   = (answeredLimitRaw > 0 ? answeredLimitRaw : 0);
  const retryMaxAttempts = parseInt(($('campaignRetryAttempts')?.value || '2'), 10) || 2;
  const retryDelayRaw    = parseInt(($('campaignRetryDelay')?.value    || ''), 10);
  const retryDelayMinutes = (retryDelayRaw > 0 ? retryDelayRaw : 120);

  if (!campaign.id) {
    toast('Önce bir liste yükleyin', 'error');
    return;
  }

  // Zaten başlamış (running/paused/stopped/completed) bir kampanya — listeyi sıfırdan
  // yeniden OLUŞTURMAK yerine (bu, tüm birikmiş sonuçları sıfırlardı) SADECE
  // ayarları güncelleyip devam ettir.
  if (campaign.status !== 'draft') {
    try {
      const resp = await fetch('/api/campaign/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaignId: campaign.id, maxConcurrent: campaign.maxConcurrent,
          startFromIndex, callLimit, answeredLimit, retryMaxAttempts, retryDelayMinutes,
        }),
      });
      const json = await resp.json();
      if (!json.success) throw new Error(json.error);
      $('campaignProgressBar').style.display = 'block';
      campaign.running = true;
      campaign.paused  = false;
      campaign.status  = 'running';
      syncCampaignButtons();
      toast('Kampanya bu ayarlarla devam ediyor — mevcut sonuçlar korundu', 'success');
    } catch (err) {
      toast('Kampanya devam ettirilemedi: ' + err.message, 'error');
    }
    return;
  }

  // Taslak: liste sunucuda zaten var, burada sadece ad/senaryo/ayarlarla başlatılır.
  const nameInput = $('campaignName');
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) {
    if (nameInput) { nameInput.classList.add('invalid'); nameInput.focus(); }
    toast('Kampanya adı zorunlu — geçmişte tanımak için gerekli', 'error');
    return;
  }
  if (nameInput) nameInput.classList.remove('invalid');

  const scenarioId = $('campaignScenario') ? ($('campaignScenario').value || '') : '';
  if (!scenarioId) {
    toast('ℹ️ Senaryo seçilmedi — Vapi asistanının varsayılan script\'i kullanılacak', 'info');
  }
  try {
    const resp = await fetch('/api/campaign/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaignId: campaign.id,
        name,
        scenarioId,
        maxConcurrent: campaign.maxConcurrent,
        startFromIndex,
        callLimit,
        answeredLimit,
        retryMaxAttempts,
        retryDelayMinutes,
      }),
    });
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    applyCampaignSnapshot(json.data);
    $('campaignProgressBar').style.display = 'block';
    toast('Kampanya sunucuda başlatıldı — tarayıcıyı kapatabilirsiniz', 'success');
  } catch(err) {
    toast('Kampanya başlatılamadı: ' + err.message, 'error');
  }
}

async function campaignPause() {
  try {
    // campaignId'yi mutlaka gönder — göndermezsek backend "en son güncellenen
    // kampanya"ya düşer, bu da kullanıcı birden fazla kampanyayı eşzamanlı
    // çalıştırıyorsa o an EKRANDA GÖRÜNENDEN FARKLI bir kampanyayı duraklatabilir.
    const resp = await fetch('/api/campaign/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId: campaign.id }),
    });
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    campaign.paused = json.paused;
    syncCampaignButtons();
    toast(json.paused ? 'Kampanya duraklatıldı' : 'Kampanya devam ediyor', 'info');
  } catch(err) {
    toast('Hata: ' + err.message, 'error');
  }
}

async function campaignStop() {
  // Durdurmak GERİ ALINABİLİR ama sonucu büyük: bekleyen herkes "durduruldu" olarak
  // işaretlenir ve tablo bir anda kilit ikonlarıyla dolar. Önceden hiç onay yoktu ve
  // sonuç mesajı sadece "Kampanya durduruldu" diyordu — danışman 4000 kişilik
  // listesini kaybettiğini sanıyordu. Ne olacağını ve geri dönüşü açıkça söyle.
  const pending = campaign.contacts.filter(c =>
    c.status === 'bekliyor' || c.status === 'tekrar-planlandı').length;
  if (pending && !confirm(
    pending + ' kişi henüz aranmadı.\n\n' +
    'Durdurursanız bu kişiler "durduruldu" olarak işaretlenecek. ' +
    'Daha sonra "Bu Ayarlarla Devam Et" ile kaldığınız yerden sürdürebilirsiniz — kimse listeden silinmez.\n\n' +
    'Kampanya durdurulsun mu?')) return;
  try {
    // Aynı sebeple campaignId zorunlu — bkz. campaignPause() notu. Bu olmadan
    // "Durdur" ekranda görünenden BAŞKA bir kampanyayı hedefleyip onun bekleyen
    // kişilerini sessizce "başarısız" işaretleyebilir.
    const resp = await fetch('/api/campaign/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId: campaign.id }),
    });
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    campaign.running = false;
    campaign.paused  = false;
    syncCampaignButtons();
    toast(pending
      ? 'Kampanya durduruldu — ' + pending + ' kişi aranmadan kaldı. "Bu Ayarlarla Devam Et" ile sürdürebilirsiniz.'
      : 'Kampanya durduruldu', 'info');
  } catch(err) {
    toast('Hata: ' + err.message, 'error');
  }
}

// ─── KAMPANYA GEÇMİŞİ ──────────────────────────────────────────────────────

// Sunucudan gelen HAM kampanya listesi — filtre/sıralama her zaman bunun
// üzerinden türetilir, böylece filtre değiştirmek yeni bir istek gerektirmez.
let campaignHistoryRows = [];

function initCampaignHistory() {
  const refreshBtn = $('btnChRefresh');
  if (refreshBtn) refreshBtn.addEventListener('click', loadCampaignHistory);
  const closeBtn = $('campaignDetailClose');
  if (closeBtn) closeBtn.addEventListener('click', closeCampaignDetail);
  const overlay = $('campaignDetailOverlay');
  if (overlay) overlay.addEventListener('click', closeCampaignDetail);

  // Filtre/arama/sıralama — hepsi yerel, tek veri çekiminden türetilir.
  const search = $('chSearch');
  if (search) search.addEventListener('input', applyCampaignHistoryView);
  const statusSel = $('chStatusFilter');
  if (statusSel) statusSel.addEventListener('change', applyCampaignHistoryView);
  const sortSel = $('chSort');
  if (sortSel) sortSel.addEventListener('change', applyCampaignHistoryView);
  const exportBtn = $('btnChExport');
  if (exportBtn) exportBtn.addEventListener('click', exportCampaignHistoryCsv);
}

// Ham listeyi arama/filtre/sıralamadan geçirip tabloyu yeniden çizer.
function applyCampaignHistoryView() {
  const q      = ($('chSearch')?.value || '').trim().toLocaleLowerCase('tr');
  const status = $('chStatusFilter')?.value || '';
  const sort   = $('chSort')?.value || 'date-desc';

  let rows = campaignHistoryRows.slice();
  if (q) rows = rows.filter(r =>
    (r.name || '').toLocaleLowerCase('tr').includes(q) ||
    (r.scenarioName || '').toLocaleLowerCase('tr').includes(q));
  if (status) rows = rows.filter(r => r.status === status);

  const cmp = {
    'date-desc':    (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    'date-asc':     (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
    'randevu-desc': (a, b) => (b.randevu || 0) - (a.randevu || 0),
    'rate-desc':    (a, b) => (b.randevuRate || 0) - (a.randevuRate || 0),
    'calls-desc':   (a, b) => (b.callsMade || 0) - (a.callsMade || 0),
    'cost-desc':    (a, b) => (b.totalCost || 0) - (a.totalCost || 0),
  }[sort];
  if (cmp) rows.sort(cmp);

  renderCampaignHistoryTable(rows);

  // Filtre aktifken kaç kaydın gizlendiğini açıkça söyle — "kampanyam kayboldu"
  // paniğini önler.
  const note = $('chFilterNote');
  if (note) {
    const hidden = campaignHistoryRows.length - rows.length;
    if (hidden > 0) {
      note.style.display = 'block';
      note.innerHTML = '🔍 ' + rows.length + ' kampanya gösteriliyor, ' + hidden +
        ' tanesi filtre dışında — <a href="#" id="chFilterClear">filtreyi temizle</a>';
      const clear = $('chFilterClear');
      if (clear) clear.addEventListener('click', e => {
        e.preventDefault();
        if ($('chSearch')) $('chSearch').value = '';
        if ($('chStatusFilter')) $('chStatusFilter').value = '';
        applyCampaignHistoryView();
      });
    } else {
      note.style.display = 'none';
    }
  }
}

// Görünen (filtrelenmiş) kampanyaları CSV olarak indirir — danışmanın yöneticiye
// rapor vermesi için. Excel'in Türkçe karakterleri doğru okuması için BOM eklenir.
function exportCampaignHistoryCsv() {
  const rows = getVisibleCampaignHistoryRows();
  if (!rows.length) { toast('Dışa aktarılacak kampanya yok', 'info'); return; }

  const header = ['Kampanya', 'Senaryo', 'Durum', 'Kişi', 'Arandı', 'Randevu', 'Dönüşüm %', 'Ort. Süre (sn)', 'Maliyet ($)', 'Oluşturulma'];
  const csvRows = rows.map(r => [
    r.name || '', r.scenarioName || 'Varsayılan', CH_STATUS_LABEL[r.status] || r.status,
    r.totalContacts || 0, r.callsMade || 0, r.randevu || 0, r.randevuRate || 0,
    Math.round(r.avgDuration || 0), (r.totalCost || 0).toFixed(4),
    r.createdAt ? new Date(r.createdAt).toLocaleString('tr-TR') : '',
  ]);

  const esc = v => {
    const str = String(v ?? '');
    return /[",;\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  };
  // Ayraç olarak noktalı virgül: Türkçe Excel'de virgül ondalık ayracı olduğu için
  // virgülle ayrılmış dosya tek sütuna yapışık açılır.
  const csv = '﻿' + [header, ...csvRows].map(r => r.map(esc).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'kampanyalar-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast(rows.length + ' kampanya CSV olarak indirildi', 'success');
}

// applyCampaignHistoryView ile AYNI filtreleri uygular — CSV, ekranda görüleni
// vermeli; iki yerde ayrı filtre mantığı tutmak ikisinin sessizce ayrışmasına yol açardı.
function getVisibleCampaignHistoryRows() {
  const q      = ($('chSearch')?.value || '').trim().toLocaleLowerCase('tr');
  const status = $('chStatusFilter')?.value || '';
  let rows = campaignHistoryRows.slice();
  if (q) rows = rows.filter(r =>
    (r.name || '').toLocaleLowerCase('tr').includes(q) ||
    (r.scenarioName || '').toLocaleLowerCase('tr').includes(q));
  if (status) rows = rows.filter(r => r.status === status);
  return rows;
}

// Kampanyayı kalıcı olarak siler. Aramalar (Geçmiş Aramalar, İstatistikler) SİLİNMEZ —
// sadece kampanya kaydı kalkar, maliyet/performans geçmişi korunur.
async function deleteCampaignFromHistory(id, name) {
  if (!confirm('"' + (name || 'Bu kampanya') + '" kalıcı olarak silinecek.\n\n' +
    'Yapılan aramalar ve istatistikler SİLİNMEZ — sadece kampanya kaydı kalkar.\n\n' +
    'Devam edilsin mi?')) return;
  try {
    const r = await fetch('/api/campaigns/' + encodeURIComponent(id), { method: 'DELETE' });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Silinemedi');
    // Yerel listeden de çıkar — sunucuya yeniden gitmeden tabloyu tazele.
    campaignHistoryRows = campaignHistoryRows.filter(x => x.id !== id);
    applyCampaignHistoryView();
    // Silinen kampanya o an Toplu Arama ekranında açıksa odayı bırak, yoksa ekran
    // artık var olmayan bir kampanyayı göstermeye devam ederdi.
    if (campaign.id === id) {
      setFocusedCampaign(null);
      campaign.status = null;
      campaign.contacts = [];
      campaign.running = false;
      campaign.paused = false;
      renderCampaignTable();
      updateCampaignProgress();
      syncCampaignButtons();
    }
    toast('Kampanya silindi', 'success');
  } catch (err) {
    toast('Silinemedi: ' + err.message, 'error');
  }
}

async function loadCampaignHistory() {
  const body = $('campaignHistoryBody');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="10" class="table-empty">Yükleniyor...</td></tr>';
  try {
    const resp = await fetch('/api/campaigns');
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    // Ham listeyi sakla — filtre/sıralama bundan türetilir, her değişiklikte
    // sunucuya yeniden gitmeye gerek kalmaz.
    campaignHistoryRows = json.data || [];
    applyCampaignHistoryView();
  } catch (err) {
    body.innerHTML = '<tr><td colspan="10" class="table-empty">Hata: ' + err.message + '</td></tr>';
  }
}

const CH_STATUS_LABEL = {
  draft: 'Taslak', running: 'Çalışıyor', paused: 'Duraklatıldı',
  completed: 'Tamamlandı', stopped: 'Durduruldu',
};

function renderCampaignHistoryTable(rows) {
  const body = $('campaignHistoryBody');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="10" class="table-empty">Henüz kampanya yok — Toplu Arama sekmesinden başlatın</td></tr>';
    return;
  }
  body.innerHTML = rows.map(r => {
    // Hiç randevu yoksa kırmızı alarm değil nötr gri — her taslak/durdurulmuş satırda
    // kırmızı "0 (%0)" rozeti sayfayı hata doluymuş gibi gösteriyordu.
    const rdvCls = r.randevuRate >= 15 ? 'sp-good' : r.randevuRate >= 5 ? 'sp-mid' : r.randevuRate > 0 ? 'sp-low' : 'sp-none';
    const spBadge = r.smartPlanId
      ? ' <span class="ch-smartplan-badge" title="Akıllı Plan tarafından otomatik açıldı: ' + esc(r.smartPlanName || '') + '">🧠 Akıllı Plan</span>'
      : '';
    return '<tr class="call-row" data-id="' + r.id + '">' +
      '<td><div class="tbl-name">' + esc(r.name) + spBadge + '</div></td>' +
      '<td class="ozet-cell">' + esc(r.scenarioName || 'Varsayılan') + '</td>' +
      '<td><span class="ch-status-tag ch-status-' + r.status + '">' + (CH_STATUS_LABEL[r.status] || r.status) + '</span></td>' +
      '<td>' + r.totalContacts + '</td>' +
      '<td>' + r.callsMade + '</td>' +
      '<td><span class="sp-rate ' + rdvCls + '">' + r.randevu + ' (%' + r.randevuRate + ')</span></td>' +
      '<td class="dur-cell">' + (r.avgDuration ? fmtDuration(r.avgDuration) : '—') + '</td>' +
      '<td class="dur-cell">$' + (r.totalCost || 0).toFixed(2) + '</td>' +
      '<td>' + fmtDateTime(r.createdAt) + '</td>' +
      '<td class="ch-actions">' +
        '<button class="btn-ch-detail" data-id="' + r.id + '">Detay ›</button>' +
        // Çalışan/duraklatılmış kampanya silinemez (sunucu da reddeder) — butonu hiç
        // göstermemek, tıklayıp hata almaktan daha anlaşılır.
        (r.status === 'running' || r.status === 'paused'
          ? ''
          : '<button class="btn-ch-delete" data-id="' + r.id + '" data-name="' + esc(r.name) + '" title="Kampanyayı sil">✕</button>') +
      '</td>' +
      '</tr>';
  }).join('');

  body.querySelectorAll('.btn-ch-detail').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openCampaignDetail(btn.dataset.id); });
  });
  body.querySelectorAll('.btn-ch-delete').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); deleteCampaignFromHistory(btn.dataset.id, btn.dataset.name); });
  });
  body.querySelectorAll('.call-row').forEach(row => {
    row.addEventListener('click', () => openCampaignDetail(row.dataset.id));
  });
}

async function openCampaignDetail(id) {
  $('campaignDetailModal').classList.add('open');
  $('campaignDetailOverlay').classList.add('visible');
  $('cdTitle').textContent = 'Yükleniyor...';
  $('cdSub').textContent = '';
  $('cdBody').innerHTML = '<div class="drawer-loading">⏳ Yükleniyor...</div>';

  try {
    const resp = await fetch('/api/campaigns/' + id);
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    renderCampaignDetail(json.data);
    // Randevular en üstte — bir kampanyanın çıktısı bu listedir.
    const c = json.data.campaign;
    const sec = appointmentSectionHtml(c.contacts, { finished: c.status === 'completed' || c.status === 'stopped' });
    if (sec) $('cdBody').insertAdjacentHTML('afterbegin', '<div class="drawer-section cp-result-panel">' + sec + '</div>');
  } catch (err) {
    $('cdBody').innerHTML = '<div class="drawer-error">Hata: ' + err.message + '</div>';
  }
}

function closeCampaignDetail() {
  $('campaignDetailModal').classList.remove('open');
  $('campaignDetailOverlay').classList.remove('visible');
}

function renderCampaignDetail(data) {
  const { campaign: c, stats: s } = data;
  $('cdTitle').textContent = c.name;
  $('cdSub').textContent = (c.scenarioName || 'Varsayılan prompt') + ' · ' + fmtDateTime(c.createdAt) +
    ' · ' + (CH_STATUS_LABEL[c.status] || c.status);

  // "Devam edilebilir" = henüz aranmamış (bekliyor) VEYA kurtarılabilir bir sebeple
  // atlanmış (limit doldu / kampanya durduruldu) kişiler. Sadece 'bekliyor'a bakmak
  // KÖR NOKTAYDI: limite takılmış bir kampanyada 'bekliyor' kişi KALMAZ — hepsi
  // 'başarısız' + skipKind='call-limit' olur — ve danışman bu ekranda hiçbir devam
  // etme yolu göremezdi (bin kişi kurtarılmayı beklerken buton hiç çıkmazdı).
  const pending     = (c.contacts || []).filter(x => x.status === 'bekliyor');
  const recoverable = (c.contacts || []).filter(x =>
    x.status === 'başarısız' && isCampaignSkip(x) && isSkipRecoverable(x));
  const resumable   = pending.length + recoverable.length;

  const existingResumeBtn = $('cdResumeBtn');
  if (existingResumeBtn) existingResumeBtn.remove();
  if (resumable) {
    const rbtn = document.createElement('button');
    rbtn.id = 'cdResumeBtn';
    rbtn.className = 'btn-campaign-start';
    rbtn.style.marginTop = '10px';
    rbtn.style.marginRight = '8px';
    // Neden beklediğini açıkça yaz — "3 bekliyor" ile "1200 limite takıldı" çok farklı
    // iki durum ve danışmanın atması gereken adım da farklı (ikincisinde limiti açmalı).
    const parts = [];
    if (pending.length)     parts.push(pending.length + ' bekliyor');
    if (recoverable.length) parts.push(recoverable.length + ' kurtarılabilir');
    rbtn.textContent = '▶ Bu Kampanyaya Geç ve Devam Et (' + parts.join(' · ') + ')';
    rbtn.addEventListener('click', () => loadSpecificCampaign(c.id));
    $('cdSub').insertAdjacentElement('afterend', rbtn);
  }

  // Kampanyayı sıfırdan, hiç aranmamış gibi tekrar Toplu Arama'ya yüklemek için —
  // bulkLoadToCampaign zaten TÜM kişilerin durumunu 'bekliyor'a sıfırlıyor ve yeni/
  // bağımsız bir listeye ayırıyor, burada sadece TÜM kişi listesini (statüsten
  // bağımsız) ona geçiyoruz (mevcut "Ulaşılamayanları Aktar" sadece cevapsız/meşgulü
  // alıyordu — bu buton TAMAMINI alır).
  const existingResetBtn = $('cdResetAllBtn');
  if (existingResetBtn) existingResetBtn.remove();
  if ((c.contacts || []).length) {
    const resetBtn = document.createElement('button');
    resetBtn.id = 'cdResetAllBtn';
    resetBtn.className = 'btn-secondary';
    resetBtn.style.marginTop = '10px';
    resetBtn.style.marginRight = '8px';
    resetBtn.textContent = '🔄 Tümünü Sıfırlayıp Yeni Kampanyaya Aktar (' + c.contacts.length + ')';
    resetBtn.addEventListener('click', async () => {
      closeCampaignDetail();
      await bulkLoadToCampaign(c.contacts, c.name.replace(/\s*\(tekrar\)$/, '') + ' (tekrar)');
    });
    $('cdSub').insertAdjacentElement('afterend', resetBtn);
  }

  // Ulaşılamayanlar artık yeni listeye kopyalanmaz — AYNI kampanyada tekrar aranır
  // (sonuçlar/geçmiş korunur, bkz. campaignRerun). Sadece biten/durdurulan
  // kampanyada anlamlı; çalışan kampanyada sunucu zaten reddeder.
  const unreachable = (c.contacts || []).filter(x => x.status === 'cevapsız' || x.status === 'meşgul' || x.status === 'tekrar-planlandı');
  const existingBtn = $('cdRequeueBtn');
  if (existingBtn) existingBtn.remove();
  if (unreachable.length && (c.status === 'completed' || c.status === 'stopped')) {
    const btn = document.createElement('button');
    btn.id = 'cdRequeueBtn';
    btn.className = 'btn-secondary';
    btn.style.marginTop = '10px';
    btn.textContent = '🔁 Ulaşılamayanları (' + unreachable.length + ') Aynı Kampanyada Tekrar Ara';
    btn.addEventListener('click', async () => {
      if (!confirm(unreachable.length + ' kişi "' + c.name + '" kampanyasında tekrar aranacak; önceki sonuçlar korunur. Devam edilsin mi?')) return;
      btn.disabled = true;
      try {
        const r = await fetch('/api/campaign/rerun', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ campaignId: c.id, scope: 'unreachable' }),
        });
        const j = await r.json();
        if (!j.success) throw new Error(j.error || 'Yeniden çalıştırılamadı');
        closeCampaignDetail();
        await loadSpecificCampaign(c.id);
        toast(j.requeued + ' kişi kuyruğa alındı — kampanya devam ediyor', 'success');
      } catch (err) {
        toast('✗ ' + err.message, 'error');
        btn.disabled = false;
      }
    });
    $('cdSub').insertAdjacentElement('afterend', btn);
  }

  // Atlanan kişilerin sebep kırılımı — "neden bu kişiler aranmadı" sorusunun
  // cevabı. Kurtarılabilir olanları (limit/durdurma) kalıcı olanlardan (ret listesi,
  // tekrar-arama koruması) ayırır ki danışman hangi adımı atacağını bilsin.
  const skipCounts = { 'call-limit':0, 'answered-limit':0, stopped:0, dnc:0, duplicate:0 };
  (c.contacts || []).forEach(x => {
    if (x.status === 'başarısız' && x.skipKind && skipCounts[x.skipKind] !== undefined) skipCounts[x.skipKind]++;
  });
  const SKIP_INFO = {
    'call-limit':     { label: 'Arama limiti doldu',        hint: 'Limiti açıp devam edebilirsiniz' },
    'answered-limit': { label: 'Görüşme hedefi doldu',      hint: 'Hedefi yükseltip devam edebilirsiniz' },
    stopped:          { label: 'Kampanya durduruldu',       hint: 'Devam Et ile kaldığınız yerden sürdürün' },
    dnc:              { label: 'Ret listesinde',            hint: 'Bu kişiler tekrar aranamaz' },
    duplicate:        { label: 'Yakın zamanda zaten arandı', hint: 'Tekrar arama koruması' },
  };
  const skipRows = Object.keys(skipCounts).filter(k => skipCounts[k] > 0).map(k =>
    '<div class="cd-skip-row">' +
      '<span class="cd-skip-count">' + skipCounts[k] + '</span>' +
      '<span class="cd-skip-label">' + SKIP_INFO[k].label + '</span>' +
      '<span class="cd-skip-hint">' + SKIP_INFO[k].hint + '</span>' +
    '</div>').join('');
  const skipHtml = skipRows
    ? '<div class="drawer-section"><div class="cd-section-title">🔒 Aranmayan Kişiler</div>' + skipRows + '</div>'
    : '';

  const kpis = [
    { label: 'Toplam Arama', value: s.totalCalls, hl: false },
    { label: 'Cevaplanan',   value: s.completedCalls + ' (%' + s.answerRate + ')', hl: false },
    { label: 'Randevu',      value: s.randevuCount + ' (%' + s.randevuRate + ')', hl: true },
    { label: 'Ort. Süre',    value: s.avgDuration ? fmtDuration(s.avgDuration) : '—', hl: false },
    { label: 'Maliyet',      value: '$' + (s.totalCost || 0).toFixed(2), hl: false },
  ];
  const kpiHtml = '<div class="cd-kpis">' + kpis.map(k =>
    '<div class="cd-kpi' + (k.hl ? ' hl' : '') + '">' +
      '<div class="cd-kpi-label">' + k.label + '</div>' +
      '<div class="cd-kpi-value">' + k.value + '</div>' +
    '</div>'
  ).join('') + '</div>';

  const ilgiColors = { yüksek: '#00C896', orta: '#4A9EFF', düşük: '#FFD060', yok: '#4A5068' };
  const ilgiMax = Math.max(1, ...(s.ilgiDistribution || []).map(x => x.count));
  const ilgiHtml = (s.ilgiDistribution || []).map(x =>
    '<div class="cd-bar-row">' +
      '<span class="cd-bar-label">' + esc(x.seviye) + '</span>' +
      '<div class="cd-bar-track"><div class="cd-bar-fill" style="width:' + (x.count / ilgiMax * 100) +
        '%;background:' + (ilgiColors[x.seviye] || '#4A5068') + '"></div></div>' +
      '<span class="cd-bar-count">' + x.count + '</span>' +
    '</div>'
  ).join('');

  // Ret nedenleri tam cümle olabiliyor — 80px'lik yan etikete sığdırıp kesmek yerine
  // (eskiden 14 karaktere kesiliyordu, sadece hover'da tam görünüyordu) metni barın
  // ÜSTÜNE koyup satır kaydırmasına izin veriyoruz, tam metin her zaman görünür.
  const retMax = Math.max(1, ...(s.retNedeniDistribution || []).map(x => x.count));
  const retHtml = (s.retNedeniDistribution || []).length
    ? s.retNedeniDistribution.map(x =>
        '<div class="cd-bar-row-stacked">' +
          '<div class="cd-bar-label-full">' + esc(x.neden) + '</div>' +
          '<div class="cd-bar-row">' +
            '<div class="cd-bar-track"><div class="cd-bar-fill" style="width:' + (x.count / retMax * 100) + '%;background:#FF5370"></div></div>' +
            '<span class="cd-bar-count">' + x.count + '</span>' +
          '</div>' +
        '</div>'
      ).join('')
    : '<div class="fu-empty">Ret nedeni kaydı yok</div>';

  const statusLabels = { completed: 'Tamamlandı', 'no-answer': 'Cevapsız', busy: 'Meşgul', failed: 'Hata', 'in-progress': 'Devam Ediyor' };
  const statusHtml = (s.statusBreakdown || []).map(x =>
    '<span class="status-tag s-' + x.status + '" style="margin-right:6px;margin-bottom:6px;display:inline-block">' +
      (statusLabels[x.status] || x.status) + ': ' + x.count +
    '</span>'
  ).join('') || '<div class="fu-empty">Kayıt yok</div>';

  // "Hata: N" sayısının ardındaki gerçek sebep dağılımı — kredi/bakiye hataları
  // ayrı bir mekanizmayla (toast + duraklatma) ele alındığı için burada sadece
  // teknik dial/bağlantı hataları görünür.
  const failureReasonHtml = (s.failureReasonBreakdown || []).length
    ? '<div class="adm-field-hint" style="margin-top:6px;margin-bottom:2px">Hata sebepleri:</div>' +
      s.failureReasonBreakdown.map(x =>
        '<span class="status-tag s-failed" style="margin-right:6px;margin-bottom:6px;display:inline-block">' +
          esc(x.reason) + ': ' + x.count +
        '</span>'
      ).join('')
    : '';

  // Saatlik performans — sadece o kampanyada gerçekten arama yapılmış saatler
  // gösteriliyor (24 satırlık boş bir liste yerine), kronolojik sırada.
  const hourlyData = (s.hourlyPerformance || []).filter(h => h.calls > 0);
  const hourlyMax  = Math.max(1, ...hourlyData.map(h => h.calls));
  const hourlyHtml = hourlyData.length
    ? hourlyData.map(h =>
        '<div class="cd-bar-row">' +
          '<span class="cd-bar-label">' + String(h.hour).padStart(2, '0') + ':00</span>' +
          '<div class="cd-bar-track"><div class="cd-bar-fill" style="width:' + (h.calls / hourlyMax * 100) + '%;background:#4A9EFF"></div></div>' +
          '<span class="cd-bar-count">' + h.calls + (h.randevu ? ' · ' + h.randevu + '📅' : '') + '</span>' +
        '</div>'
      ).join('')
    : '<div class="fu-empty">Saat verisi yok</div>';

  const regionHtml = (s.regionPerformance || []).length
    ? s.regionPerformance.map(r =>
        '<div class="cd-bar-row-stacked">' +
          '<div class="cd-bar-label-full">' + esc(r.region) + '</div>' +
          '<div class="cd-bar-row">' +
            '<div class="cd-bar-track"><div class="cd-bar-fill" style="width:' + (r.calls / Math.max(1, ...s.regionPerformance.map(x => x.calls)) * 100) + '%;background:#00C896"></div></div>' +
            '<span class="cd-bar-count">' + r.calls + (r.randevu ? ' (%' + r.randevuRate + ')' : '') + '</span>' +
          '</div>' +
        '</div>'
      ).join('')
    : '<div class="fu-empty">Bölge bilgisi girilmemiş</div>';

  const mulkHtml = (s.mulkTipiDistribution || []).length
    ? s.mulkTipiDistribution.map(x =>
        '<div class="cd-bar-row-stacked">' +
          '<div class="cd-bar-label-full">' + esc(x.tip) + '</div>' +
          '<div class="cd-bar-row">' +
            '<div class="cd-bar-track"><div class="cd-bar-fill" style="width:' + (x.count / Math.max(1, ...s.mulkTipiDistribution.map(y => y.count)) * 100) + '%;background:#B464FF"></div></div>' +
            '<span class="cd-bar-count">' + x.count + '</span>' +
          '</div>' +
        '</div>'
      ).join('')
    : '<div class="fu-empty">Mülk tipi bilgisi yok</div>';

  const retryHtml = s.retryEffect
    ? '<div class="cd-kpis" style="grid-template-columns:repeat(2,1fr)">' +
        '<div class="cd-kpi hl">' +
          '<div class="cd-kpi-label">Birden Fazla Arandı (' + s.retryEffect.multiAttemptContacts + ' kişi)</div>' +
          '<div class="cd-kpi-value">%' + s.retryEffect.multiAttemptSuccessRate + '</div>' +
        '</div>' +
        '<div class="cd-kpi">' +
          '<div class="cd-kpi-label">Tek Seferde Arandı</div>' +
          '<div class="cd-kpi-value">%' + s.retryEffect.singleAttemptSuccessRate + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="adm-field-hint" style="margin-top:8px">Yüzdeler "tamamlandı" durumuna ulaşma oranı — tekrar aramanın gerçekten işe yarayıp yaramadığını gösterir.</div>'
    : '';

  $('cdBody').innerHTML =
    kpiHtml +
    skipHtml +
    '<div class="drawer-section">' +
      '<div class="cd-section-title">İlgi Seviyesi Dağılımı</div>' +
      (ilgiHtml || '<div class="fu-empty">Henüz özet yok</div>') +
    '</div>' +
    '<div class="drawer-section">' +
      '<div class="cd-section-title">En Sık Ret Nedenleri</div>' +
      retHtml +
    '</div>' +
    '<div class="drawer-section">' +
      '<div class="cd-section-title">Saatlik Performans</div>' +
      hourlyHtml +
    '</div>' +
    '<div class="drawer-section">' +
      '<div class="cd-section-title">Bölge Bazlı Performans</div>' +
      regionHtml +
    '</div>' +
    '<div class="drawer-section">' +
      '<div class="cd-section-title">Mülk Tipi Dağılımı</div>' +
      mulkHtml +
    '</div>' +
    (retryHtml ? '<div class="drawer-section"><div class="cd-section-title">Tekrar Arama Etkisi</div>' + retryHtml + '</div>' : '') +
    '<div class="drawer-section">' +
      '<div class="cd-section-title">Durum Dağılımı</div>' +
      '<div>' + statusHtml + '</div>' +
      failureReasonHtml +
    '</div>';
}

// ─── SCENARIOS ───────────────────────────────────────────────────────────────

let scenariosCache = [];

function initScenarios() {
  $('btnManageScenarios').addEventListener('click', openScenarioModal);
  $('scenarioModalClose').addEventListener('click', closeScenarioModal);
  $('scenarioModalOverlay').addEventListener('click', closeScenarioModal);
  $('btnScenarioSave').addEventListener('click', saveScenario);
  $('btnScenarioCancel').addEventListener('click', () => {
    $('scenarioForm').style.display = 'none';
    $('scenarioEditId').value = '';
  });
  $('btnVlpReload').addEventListener('click', loadVapiLivePrompt);
  $('btnVlpSave').addEventListener('click', saveVapiLivePrompt);
  $('btnOvAdd').addEventListener('click', () => { ovDraft.push(ovNew('')); renderOpeningVariants(); });
  $('btnOvAddGolden').addEventListener('click', () => { ovDraft.push(ovNew(OV_GOLDEN_TEXT)); renderOpeningVariants(); });
  initPromptGenerator();
  initScenarioTest();
  loadScenarios();
}

// ─── AI PROMPT GENERATOR ───────────────────────────────────────────────────

let promptGenTargetId = null;
let promptGenMode = 'structured'; // 'structured' | 'raw'

function initPromptGenerator() {
  document.querySelectorAll('[data-promptgen-target]').forEach(btn => {
    btn.addEventListener('click', () => openPromptGenModal(btn.dataset.promptgenTarget));
  });
  $('promptGenClose').addEventListener('click', closePromptGenModal);
  $('promptGenOverlay').addEventListener('click', closePromptGenModal);
  $('btnPgCancel').addEventListener('click', closePromptGenModal);
  $('btnPgGenerate').addEventListener('click', runPromptGenerate);

  $('pgModeStructured').addEventListener('click', () => setPromptGenMode('structured'));
  $('pgModeRaw').addEventListener('click', () => setPromptGenMode('raw'));
}

function setPromptGenMode(mode) {
  promptGenMode = mode;
  $('pgModeStructured').classList.toggle('active', mode === 'structured');
  $('pgModeRaw').classList.toggle('active', mode === 'raw');
  $('pgStructuredFields').style.display = mode === 'structured' ? 'block' : 'none';
  $('pgRawFields').style.display = mode === 'raw' ? 'block' : 'none';
}

function openPromptGenModal(targetTextareaId) {
  promptGenTargetId = targetTextareaId;
  ['pgCallGoal','pgOfferDetails','pgTone','pgMaxDuration','pgNotes','pgRawText']
    .forEach(id => { $(id).value = ''; });
  setPromptGenMode('structured');
  $('promptGenModal').classList.add('open');
  $('promptGenOverlay').classList.add('visible');
  $('pgCallGoal').focus();
}

function closePromptGenModal() {
  $('promptGenModal').classList.remove('open');
  $('promptGenOverlay').classList.remove('visible');
  promptGenTargetId = null;
}

// ─── SENARYO TEST ÖNİZLEME — para harcamadan örnek diyalog ─────────────────

function initScenarioTest() {
  document.querySelectorAll('[data-scenariotest-target]').forEach(btn => {
    btn.addEventListener('click', () => runScenarioTest(btn.dataset.scenariotestTarget));
  });
  $('scenarioTestClose').addEventListener('click', closeScenarioTestModal);
  $('scenarioTestOverlay').addEventListener('click', closeScenarioTestModal);
}

function closeScenarioTestModal() {
  $('scenarioTestModal').classList.remove('open');
  $('scenarioTestOverlay').classList.remove('visible');
}

async function runScenarioTest(targetTextareaId) {
  const ta = $(targetTextareaId);
  const systemPrompt = ta ? ta.value.trim() : '';
  if (!systemPrompt) {
    toast('Önce bir prompt yazın veya oluşturun', 'error');
    return;
  }

  $('scenarioTestModal').classList.add('open');
  $('scenarioTestOverlay').classList.add('visible');
  $('scenarioTestBody').innerHTML = '<div class="drawer-loading">⏳ 3 örnek diyalog oluşturuluyor (biraz sürebilir)...</div>';

  try {
    const r = await fetch('/api/prompt/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    renderScenarioTestResult(j.data.scenarios);
  } catch (err) {
    $('scenarioTestBody').innerHTML = '<div class="drawer-error">Hata: ' + err.message + '</div>';
  }
}

const ST_TAG_CLASS = { 'Olumlu': 'st-olumlu', 'Olumsuz': 'st-olumsuz', 'Kararsız': 'st-kararsiz' };

function renderScenarioTestResult(scenarios) {
  $('scenarioTestBody').innerHTML = scenarios.map(sc => {
    const tagCls = ST_TAG_CLASS[sc.label] || 'st-kararsiz';
    const bubbles = (sc.transcript || []).map(t => {
      const isAgent = t.role === 'assistant';
      return '<div class="dtf-row ' + (isAgent ? 'agent' : 'user') + '">' +
        '<div class="dtf-who">' + (isAgent ? '🤖 Asistan' : '👤 Müşteri') + '</div>' +
        '<div class="dtf-bubble">' + esc(t.text) + '</div>' +
      '</div>';
    }).join('');
    return '<div class="st-scenario-group">' +
      '<div class="st-scenario-title">' +
        '<span class="st-tag ' + tagCls + '">' + esc(sc.label) + '</span>' +
        '<span>Müşteri Tepkisi</span>' +
      '</div>' +
      '<div class="st-transcript">' + bubbles + '</div>' +
    '</div>';
  }).join('');
}

async function runPromptGenerate() {
  let body;

  if (promptGenMode === 'raw') {
    const rawText = $('pgRawText').value.trim();
    if (!rawText) {
      toast('Taslak/script metni boş olamaz', 'error');
      return;
    }
    body = {
      rawText,
      additionalNotes: $('pgNotes').value.trim() || undefined,
    };
  } else {
    const callGoal = $('pgCallGoal').value.trim();
    if (!callGoal) {
      toast('Aramanın amacı zorunlu', 'error');
      return;
    }
    body = {
      callGoal,
      offerDetails: $('pgOfferDetails').value.trim() || undefined,
      tone: $('pgTone').value.trim() || undefined,
      maxDurationSeconds: parseInt($('pgMaxDuration').value, 10) || undefined,
      additionalNotes: $('pgNotes').value.trim() || undefined,
    };
  }

  const btn = $('btnPgGenerate');
  btn.disabled = true;
  btn.textContent = 'Oluşturuluyor...';
  $('pgLoadingOverlay').style.display = 'flex';

  try {
    const r = await fetch('/api/prompt/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error);

    if (promptGenTargetId) $(promptGenTargetId).value = j.data.systemPrompt;
    if (j.data.unsupportedVariables && j.data.unsupportedVariables.length) {
      toast('⚠️ Tanınmayan değişken(ler) tespit edildi: ' + j.data.unsupportedVariables.map(v => '{{' + v + '}}').join(', ') + ' — Vapi bunları olduğu gibi okur, doldurmaz. Kaydetmeden önce düzeltin', 'error');
    } else if (j.data.scriptWarnings && j.data.scriptWarnings.length) {
      toast('⚠️ Şirket kurallarına aykırı olabilecek ifade tespit edildi: ' + j.data.scriptWarnings.join(', ') + ' — kaydetmeden önce inceleyin', 'error');
    } else if (j.data.disclosureAdded) {
      toast('Prompt oluşturuldu — zorunlu açıklama otomatik eklendi, inceleyip kaydedin', 'success');
    } else {
      toast('Prompt oluşturuldu — inceleyip kaydedin', 'success');
    }
    closePromptGenModal();
  } catch (err) {
    toast('Prompt oluşturulamadı: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Oluştur';
    $('pgLoadingOverlay').style.display = 'none';
  }
}

async function loadVapiLivePrompt() {
  const ta = $('vlpPrompt');
  const nameEl = $('vlpAssistantName');
  ta.value = '';
  ta.placeholder = 'Yükleniyor...';
  ta.disabled = true;
  try {
    const r = await fetch('/api/vapi/assistant-prompt');
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    ta.value = j.data.systemPrompt;
    nameEl.textContent = j.data.name ? '(' + j.data.name + ')' : '';
  } catch (err) {
    ta.placeholder = 'Yüklenemedi: ' + err.message;
    toast('Vapi prompt alınamadı: ' + err.message, 'error');
  } finally {
    ta.disabled = false;
  }
}

async function saveVapiLivePrompt() {
  const prompt = $('vlpPrompt').value.trim();
  if (!prompt) { toast('Prompt boş olamaz', 'error'); return; }
  const sure = await uiConfirm(
    'Bu, Vapi\'deki PAYLAŞILAN varsayılan promptu kalıcı olarak DEĞİŞTİRECEK.\n\n' +
    'Senaryo seçilmeden yapılan TÜM aramalar bundan sonra bu yeni promptu kullanacak — ' +
    'mevcut/eski prompt geri getirilemez şekilde kaybolacak.\n\n' +
    'Sadece yeni bir senaryo denemek istiyorsanız bunun yerine "Yerel Senaryolar" bölümünü kullanın.',
    { title: 'Vapi Paylaşılan Promptunu Değiştir', confirmLabel: 'Evet, kalıcı olarak değiştir', danger: true },
  );
  if (!sure) return;
  const btn = $('btnVlpSave');
  btn.disabled = true;
  btn.textContent = 'Kaydediliyor...';
  try {
    const r = await fetch('/api/vapi/assistant-prompt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: prompt }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    toast('Vapi asistan promptu güncellendi', 'success');
  } catch (err) {
    toast('Hata: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = "Vapi'ye Kaydet";
  }
}

// Önceden hata sessizce yutuluyordu — ağ hatası/geçici sunucu kesintisinde senaryo
// dropdown'u boş kalır, danışman neden kendi senaryosunu göremediğini anlamazdı.
// Artık birkaç kez tekrar dener, hepsi başarısız olursa açıkça uyarır.
async function loadScenarios(attempt = 1) {
  const MAX_ATTEMPTS = 3;
  try {
    const resp = await fetch('/api/scenarios');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Senaryolar yüklenemedi');
    scenariosCache = json.data;
    refreshScenarioSelects();
  } catch (err) {
    if (attempt < MAX_ATTEMPTS) {
      setTimeout(() => loadScenarios(attempt + 1), attempt * 1500);
    } else {
      console.error('[Scenarios] Yüklenemedi:', err);
      toast('Senaryolar yüklenemedi — sayfayı yenileyin', 'error');
    }
  }
}

function refreshScenarioSelects() {
  // Left panel selector
  const sel = $('scenarioSelect');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Varsayılan prompt —</option>';
  scenariosCache.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    if (s.id === cur) opt.selected = true;
    sel.appendChild(opt);
  });

  // History filter selector
  const fsel = DOM.filterScenario;
  if (fsel) {
    const fcur = fsel.value;
    fsel.innerHTML = '<option value="">Tümü</option><option value="__none__">— Varsayılan (Senaryosuz) —</option>';
    scenariosCache.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      if (s.id === fcur) opt.selected = true;
      fsel.appendChild(opt);
    });
    fsel.value = fcur;
  }

  // İstatistikler filter selector
  const ssel = $('statsScenarioFilter');
  if (ssel) {
    const scur = ssel.value;
    ssel.innerHTML = '<option value="">Tümü</option><option value="__none__">— Varsayılan (Senaryosuz) —</option>';
    scenariosCache.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      if (s.id === scur) opt.selected = true;
      ssel.appendChild(opt);
    });
    ssel.value = scur;
  }

  // Campaign (toplu arama) selector
  const csel = $('campaignScenario');
  if (csel) {
    const ccur = csel.value;
    csel.innerHTML = '<option value="">— Varsayılan prompt —</option>';
    scenariosCache.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      if (s.id === ccur) opt.selected = true;
      csel.appendChild(opt);
    });
  }
}

function openScenarioModal() {
  $('scenarioModal').classList.add('open');
  $('scenarioModalOverlay').classList.add('visible');
  $('scenarioForm').style.display = 'none';
  renderScenarioList();
  loadVapiLivePrompt();
}

function closeScenarioModal() {
  $('scenarioModal').classList.remove('open');
  $('scenarioModalOverlay').classList.remove('visible');
}

function renderScenarioList() {
  const list = $('scenarioList');
  if (!scenariosCache.length) {
    list.innerHTML = '<div class="sc-empty">Henüz senaryo yok. Yeni ekleyin.</div>' +
      '<button class="btn-sc-new">+ Yeni Senaryo</button>';
    list.querySelector('.btn-sc-new').addEventListener('click', showNewScenarioForm);
    return;
  }
  list.innerHTML =
    '<button class="btn-sc-new">+ Yeni Senaryo</button>' +
    scenariosCache.map(s =>
      '<div class="sc-item" data-id="' + s.id + '">' +
        '<div class="sc-item-name">' + esc(s.name) +
          (s.voiceModel === 'eleven_v4_turbo' ? ' <span class="sc-voice-badge" title="Bu senaryo ElevenLabs v4 Turbo ile seslendirilir">🔊 v4 Turbo</span>' : '') +
          ((s.openingVariants || []).some(v => v.enabled) ? ' <span class="sc-ab-badge" title="Açılış A/B testi aktif">A/B ' + (s.openingVariants || []).filter(v => v.enabled).length + '</span>' : '') +
        '</div>' +
        '<div class="sc-item-actions">' +
          '<button class="btn-sc-edit" data-id="' + s.id + '">Düzenle</button>' +
          '<button class="btn-sc-del"  data-id="' + s.id + '">Sil</button>' +
        '</div>' +
      '</div>'
    ).join('');

  list.querySelector('.btn-sc-new').addEventListener('click', showNewScenarioForm);
  list.querySelectorAll('.btn-sc-edit').forEach(btn => {
    btn.addEventListener('click', () => showEditScenarioForm(btn.dataset.id));
  });
  list.querySelectorAll('.btn-sc-del').forEach(btn => {
    btn.addEventListener('click', () => deleteScenarioUI(btn.dataset.id));
  });
}

function showNewScenarioForm() {
  $('scenarioEditId').value = '';
  $('scenarioName').value   = '';
  $('scenarioPrompt').value = '';
  $('scenarioVoiceModel').value = '';
  $('scenarioUseCustomerName').checked = false;
  $('scenarioUseAgentName').checked = false;
  $('scenarioWaitForGreeting').checked = false;
  ovDraft = [];
  renderOpeningVariants();
  $('ovStats').innerHTML = '';
  $('scenarioForm').style.display = 'block';
  $('scenarioName').focus();
}

function showEditScenarioForm(id) {
  const s = scenariosCache.find(x => x.id === id);
  if (!s) return;
  $('scenarioEditId').value = s.id;
  $('scenarioName').value   = s.name;
  $('scenarioPrompt').value = s.systemPrompt;
  $('scenarioVoiceModel').value = s.voiceModel || '';
  $('scenarioUseCustomerName').checked = s.useCustomerName === true;
  $('scenarioUseAgentName').checked = s.useAgentName === true;
  $('scenarioWaitForGreeting').checked = s.waitForGreeting === true;
  ovDraft = (s.openingVariants || []).map(v => ({ ...v }));
  renderOpeningVariants();
  loadOpeningStats(s.id);
  $('scenarioForm').style.display = 'block';
  $('scenarioName').focus();
}

// ─── Açılış varyantları (A/B) — form içi taslak ───────────────────────────
// Sunucudaki karşılığı src/opening.ts. Taslak formda tutulur, Kaydet ile senaryoyla
// birlikte gider; id'ler korunur (eski aramaların istatistiği id'ye bağlı).
const OV_GOLDEN_TEXT = 'Merhaba, Platin Karma\'dan arıyorum. Kısa bir sorum var, satmayı düşündüğünüz bir mülkünüz var mı?';
const OV_MAX = 4;
let ovDraft = [];

function ovNew(text) {
  return { id: 'ov_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6), label: '', text, waitForGreeting: false, enabled: true };
}

function ovWordCount(t) { return (t || '').trim().split(/\s+/).filter(Boolean).length; }

function renderOpeningVariants() {
  const list = $('ovList');
  $('btnOvAdd').disabled = ovDraft.length >= OV_MAX;
  $('btnOvAddGolden').disabled = ovDraft.length >= OV_MAX;
  if (!ovDraft.length) {
    list.innerHTML = '<div class="ov-empty">Varyant yok — senaryo kendi açılışıyla çalışıyor. "Altın açılışı ekle" ile başlayın, ikinci bir varyant ekleyip yarıştırın.</div>';
    return;
  }
  list.innerHTML = ovDraft.map((v, i) => {
    const words = ovWordCount(v.text);
    return '<div class="ov-item' + (v.enabled ? '' : ' ov-off') + '" data-i="' + i + '">' +
      '<input class="ov-label" maxlength="30" placeholder="' + String.fromCharCode(65 + i) + '" value="' + esc(v.label || '') + '" title="Kısa ad"/>' +
      '<div>' +
        '<textarea class="ov-text" maxlength="300" placeholder="Merhaba {{customerName}}, …">' + esc(v.text || '') + '</textarea>' +
        '<div class="ov-meta">' +
          '<span class="ov-words' + (words > 16 ? ' warn' : '') + '">' + words + ' kelime' + (words > 16 ? ' — uzun, kısaltın' : '') + '</span>' +
          '<label><input type="checkbox" class="ov-wait"' + (v.waitForGreeting ? ' checked' : '') + '/> Müşteri "Alo" deyince konuş</label>' +
          '<label><input type="checkbox" class="ov-on"' + (v.enabled ? ' checked' : '') + '/> Aktif</label>' +
        '</div>' +
      '</div>' +
      '<div class="ov-side"><button type="button" class="btn-sc-del ov-del">Sil</button></div>' +
    '</div>';
  }).join('');

  list.querySelectorAll('.ov-item').forEach(el => {
    const i = Number(el.dataset.i);
    el.querySelector('.ov-label').addEventListener('input', e => { ovDraft[i].label = e.target.value; });
    el.querySelector('.ov-text').addEventListener('input', e => {
      ovDraft[i].text = e.target.value;
      const w = ovWordCount(e.target.value); const span = el.querySelector('.ov-words');
      span.textContent = w + ' kelime' + (w > 16 ? ' — uzun, kısaltın' : '');
      span.classList.toggle('warn', w > 16);
    });
    el.querySelector('.ov-wait').addEventListener('change', e => { ovDraft[i].waitForGreeting = e.target.checked; });
    el.querySelector('.ov-on').addEventListener('change', e => { ovDraft[i].enabled = e.target.checked; el.classList.toggle('ov-off', !e.target.checked); });
    el.querySelector('.ov-del').addEventListener('click', () => { ovDraft.splice(i, 1); renderOpeningVariants(); });
  });
}

async function loadOpeningStats(scenarioId) {
  const box = $('ovStats');
  box.innerHTML = '';
  try {
    const r = await fetch('/api/scenarios/' + scenarioId + '/opening-stats');
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    const rows = j.data.stats || [];
    if (!rows.length) { box.innerHTML = '<div class="ov-stats-note">Bu senaryoyla henüz konuşma gerçekleşen arama yok.</div>'; return; }
    const nameOf = id => {
      if (!id) return 'Senaryonun kendi açılışı';
      const v = ovDraft.find(x => x.id === id); return v ? (v.label || ('Varyant ' + (ovDraft.indexOf(v) + 1))) : 'Silinmiş varyant';
    };
    const fmt = p => p === null || p === undefined ? '–' : p + '%';
    // "en iyi" vurgusu: en düşük erken kapanma, en yüksek soruya ulaşma/randevu (≥20 aramada)
    const eligible = rows.filter(r => r.calls >= 20);
    const minEarly = Math.min(...eligible.map(r => r.earlyHangupPct ?? 999));
    const maxReach = Math.max(...eligible.map(r => r.reachedQuestionPct ?? -1));
    const maxAppt  = Math.max(...eligible.map(r => r.appointmentPct ?? -1));
    box.innerHTML =
      '<table><thead><tr><th>Açılış</th><th>Arama</th><th>İlk cümlede kapattı</th><th>Soruya ulaştı</th><th>İlgi orta/yüksek</th><th>Randevu</th><th>Medyan süre</th></tr></thead><tbody>' +
      rows.map(r =>
        '<tr><td>' + esc(nameOf(r.variantId)) + '</td><td>' + r.calls + '</td>' +
        '<td' + (eligible.length > 1 && r.calls >= 20 && r.earlyHangupPct === minEarly ? ' class="best"' : '') + '>' + fmt(r.earlyHangupPct) + '</td>' +
        '<td' + (eligible.length > 1 && r.calls >= 20 && r.reachedQuestionPct === maxReach ? ' class="best"' : '') + '>' + fmt(r.reachedQuestionPct) + '</td>' +
        '<td>' + fmt(r.interestPct) + '</td>' +
        '<td' + (eligible.length > 1 && r.calls >= 20 && r.appointmentPct === maxAppt ? ' class="best"' : '') + '>' + fmt(r.appointmentPct) + '</td>' +
        '<td>' + (r.medianDurationSec == null ? '–' : r.medianDurationSec + ' sn') + '</td></tr>'
      ).join('') +
      '</tbody></table>' +
      '<div class="ov-stats-note">Yalnızca konuşma gerçekleşen aramalar sayılır. Karar için varyant başına en az 50-100 arama bekleyin; 20 aramanın altındaki satırlar vurgulanmaz.</div>';
  } catch (err) {
    box.innerHTML = '<div class="ov-stats-note">Sonuçlar yüklenemedi: ' + esc(err.message) + '</div>';
  }
}

async function saveScenario() {
  const id     = $('scenarioEditId').value;
  const name   = $('scenarioName').value.trim();
  const prompt = $('scenarioPrompt').value.trim();
  const voiceModel = $('scenarioVoiceModel').value || null;
  if (!name || !prompt) { toast('Ad ve prompt zorunlu', 'error'); return; }
  const openingVariants = ovDraft.map(v => ({ ...v, label: (v.label || '').trim(), text: (v.text || '').trim() }));
  if (openingVariants.some(v => !v.text)) { toast('Boş açılış varyantı var — metni girin veya silin', 'error'); return; }

  try {
    const method = id ? 'PUT' : 'POST';
    const url    = id ? '/api/scenarios/' + id : '/api/scenarios';
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, systemPrompt: prompt, voiceModel, openingVariants,
        useCustomerName: $('scenarioUseCustomerName').checked,
        useAgentName: $('scenarioUseAgentName').checked,
        waitForGreeting: $('scenarioWaitForGreeting').checked,
      }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    toast(id ? 'Senaryo güncellendi' : 'Senaryo eklendi', 'success');
    $('scenarioForm').style.display = 'none';
    await loadScenarios();
    renderScenarioList();
  } catch(err) {
    toast('Hata: ' + err.message, 'error');
  }
}

async function deleteScenarioUI(id) {
  const s = scenariosCache.find(x => x.id === id);
  if (!s) return;
  const sureDeleteScenario = await uiConfirm('"' + s.name + '" senaryosu silinsin mi?', { title: 'Senaryoyu Sil', confirmLabel: 'Evet, sil', danger: true });
  if (!sureDeleteScenario) return;
  try {
    const r = await fetch('/api/scenarios/' + id, { method: 'DELETE' });
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    toast('Senaryo silindi', 'info');
    await loadScenarios();
    renderScenarioList();
  } catch(err) {
    toast('Hata: ' + err.message, 'error');
  }
}

