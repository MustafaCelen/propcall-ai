// PropCall AI — Frontend

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
  statsPeriod:  30,        // gün
};
const FILTER_STORAGE_KEY = 'propcall.historyFilters.v1';
const FOLLOWUP_STORAGE_KEY = 'propcall.followupSearch.v1';

const campaign = {
  contacts: [],        // { name, phone, region, notes, status, vapiCallId, result }
  maxConcurrent: 1,
  running: false,
  paused: false,
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

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initCallButtons();
  initFilterBar();
  initStatsChips();
  initFollowupToolbar();
  initDrawer();
  initAppointments();
  initCampaign();
  initScenarios();
  connectSSE();
  loadHistory();
  loadFollowupBadge();
});

// ─── TABS ─────────────────────────────────────────────────────────────────────

function initTabs() {
  DOM.tabBtns.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(name) {
  DOM.tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  DOM.tabContents.forEach(c => {
    const match = (name === 'live'     && c.id === 'tabLive')     ||
                  (name === 'history'  && c.id === 'tabHistory')  ||
                  (name === 'stats'    && c.id === 'tabStats')    ||
                  (name === 'campaign' && c.id === 'tabCampaign') ||
                  (name === 'followup' && c.id === 'tabFollowup');
    c.classList.toggle('active', match);
  });
  if (name === 'history') loadHistory();
  if (name === 'stats')   loadStats();
  if (name === 'followup') loadFollowup();
}

// ─── SSE ─────────────────────────────────────────────────────────────────────

function connectSSE() {
  if (state.sseSource) state.sseSource.close();
  const src = new EventSource('/api/events');
  state.sseSource = src;

  src.addEventListener('connected', () => {
    console.log('[SSE] Bağlandı');
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
    campaign.contacts     = data.contacts || [];
    campaign.running      = data.running;
    campaign.paused       = data.paused;
    campaign.maxConcurrent = data.maxConcurrent;
    syncCampaignButtons();
    renderCampaignTable();
    updateCampaignProgress();
  });

  src.addEventListener('campaign-contact-update', e => {
    const { index, contact, summary: sum } = JSON.parse(e.data);
    if (index >= 0 && index < campaign.contacts.length) {
      campaign.contacts[index] = contact;
      renderCampaignRow(index);
    }
    if (sum) updateCampaignProgressFromSummary(sum);
  });

  src.addEventListener('campaign-complete', e => {
    const { randevu, total } = JSON.parse(e.data);
    campaign.running = false;
    syncCampaignButtons();
    updateCampaignProgress();
    // Tamamlanma banner'ı
    const bar = $('campaignProgressBar');
    if (bar) {
      const old = bar.querySelector('.campaign-complete-banner');
      if (old) old.remove();
      const banner = document.createElement('div');
      banner.className = 'campaign-complete-banner';
      const pct = total ? Math.round(randevu / total * 100) : 0;
      banner.innerHTML =
        '🏁 <strong>Kampanya Tamamlandı!</strong> ' +
        '<span class="ccb-stat">📅 ' + randevu + ' randevu</span> · ' +
        '<span class="ccb-stat">📞 ' + total + ' kişi</span> · ' +
        '<span class="ccb-stat ccb-rate">%' + pct + ' dönüşüm</span>';
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
  const phone = rawPhone && !rawPhone.startsWith('+') ? '+' + rawPhone : rawPhone;
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
    await fetch('/api/call/' + state.activeCallId, { method: 'DELETE' });
    toast('Arama sonlandırıldı', 'info');
  } catch (err) {
    toast('Sonlandırma hatası: ' + err.message, 'error');
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
    DOM.callsTableBody.innerHTML = '<tr><td colspan="10" class="table-empty">Kayıt bulunamadı</td></tr>';
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
      ? '<span class="tbl-cost">$' + c.costs.total.toFixed(4) + '</span>'
      : '';
    return '<tr class="call-row" data-id="' + c.vapiCallId + '">' +
      '<td>' + fmtDateTime(c.startTime) + '</td>' +
      '<td><div class="tbl-name">' + esc(c.customerName) + '</div><div class="tbl-phone">' + esc(c.customerPhone) + '</div></td>' +
      '<td>' + statusBadge(c.status) + '</td>' +
      '<td class="dur-cell">' + dur + '</td>' +
      '<td class="tc-cell">' + trIcon + '</td>' +
      '<td>' + randevuBadge(s) + '</td>' +
      '<td>' + ilgiBadge(s && s.ilgi_seviyesi) + '</td>' +
      '<td class="ozet-cell">' + retStr + '</td>' +
      '<td class="ozet-cell note-cell">' + noteStr + '</td>' +
      '<td class="action-cell">' + costStr + '<button class="btn-detail" data-id="' + c.vapiCallId + '">›</button></td>' +
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
  const map = {
    'completed':   { cls: 's-completed',   label: 'Tamamlandı' },
    'no-answer':   { cls: 's-no-answer',   label: 'Cevapsız' },
    'busy':        { cls: 's-busy',        label: 'Meşgul' },
    'failed':      { cls: 's-failed',      label: 'Başarısız' },
    'in-progress': { cls: 's-in-progress', label: 'Devam Ediyor' },
  };
  const m = map[status] || { cls: '', label: status || '—' };
  return '<span class="status-tag ' + m.cls + '">' + m.label + '</span>';
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

  const recLink = call.recordingUrl
    ? ' <a class="recording-link" href="' + call.recordingUrl + '" target="_blank">🎧 Dinle</a>'
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
          recLink +
          '<button class="btn-copy-tr" data-text="' + encodeURIComponent(plainText) + '">📋 Kopyala</button>' +
        '</div>' +
        '<div class="drawer-transcript-full">' +
          call.transcript.map(t => {
            const isAgent = t.role === 'assistant';
            return '<div class="dtf-row ' + (isAgent ? 'agent' : 'user') + '">' +
              '<div class="dtf-who">' + (isAgent ? '🤖 Asistan' : '👤 Müşteri') + '</div>' +
              '<div class="dtf-bubble">' + esc(t.text) + '</div>' +
              '<div class="dtf-time">' + fmtTime(t.timestamp) + '</div>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>';
  } else {
    transcriptHtml =
      '<div class="drawer-section">' +
        '<div class="drawer-section-title">💬 Transkript' + recLink + '</div>' +
        '<div class="tr-empty">Transkript bulunamadı — webhook olayları alınamadı veya arama çok kısa sürdü.</div>' +
      '</div>';
  }

  DOM.drawerBody.innerHTML =
    summaryHtml +
    '<div class="drawer-section">' +
      '<div class="drawer-section-title">💰 Maliyet</div>' +
      '<div class="cost-breakdown">' +
        '<div class="cb-row"><span>Vapi</span><span>$' + (cost.vapi||0).toFixed(4) + '</span></div>' +
        '<div class="cb-row"><span>Twilio</span><span>$' + (cost.twilio||0).toFixed(4) + '</span></div>' +
        '<div class="cb-row"><span>LLM</span><span>$' + (cost.llm||0).toFixed(4) + '</span></div>' +
        '<div class="cb-row"><span>TTS</span><span>$' + (cost.tts||0).toFixed(4) + '</span></div>' +
        '<div class="cb-row"><span>STT</span><span>$' + (cost.stt||0).toFixed(4) + '</span></div>' +
        '<div class="cb-row total"><span>Toplam</span><span>$' + (cost.total||0).toFixed(4) + '</span></div>' +
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

function initStatsChips() {
  const bar = $('statsChips');
  if (!bar) return;
  bar.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => {
      bar.querySelectorAll('.chip').forEach(b => b.classList.toggle('active', b === btn));
      state.statsPeriod = parseInt(btn.dataset.period, 10);
      loadStats();
    });
  });
  const refresh = $('statsRefresh');
  if (refresh) refresh.addEventListener('click', loadStats);
}

async function loadStats() {
  try {
    const qs = state.statsPeriod > 0 ? '?period=' + state.statsPeriod : '';
    const resp = await fetch('/api/stats' + qs);
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

  const avgEl = $('statAvgDuration');
  if (avgEl) avgEl.textContent = d.avgDuration ? fmtDuration(d.avgDuration) : '—';
  const costEl = $('statTotalCost');
  if (costEl) costEl.textContent = '$' + (d.totalCost || 0).toFixed(2);
  const cprEl = $('statCostPerRandevu');
  if (cprEl) cprEl.textContent = d.randevuCount
    ? '$' + (d.totalCost / d.randevuCount).toFixed(2) + ' / randevu'
    : 'henüz randevu yok';

  // Günlük chart başlığı dönem'e göre
  const dailyTitle = $('chartDailyTitle');
  if (dailyTitle) {
    const labelMap = { 1: 'Bugün', 7: 'Son 7 Gün', 30: 'Son 30 Gün' };
    dailyTitle.textContent = 'Günlük Arama Sayısı — ' + (labelMap[state.statsPeriod] || 'Tümü');
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

  // Senaryo performans tablosu
  renderScenarioPerf(d.scenarioPerformance || []);
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

function renderAppointments(apts) {
  if (!apts.length) {
    DOM.aptList.innerHTML = '<div class="apt-empty">Henüz randevu yok</div>';
    return;
  }
  DOM.aptList.innerHTML = apts.map(a =>
    '<div class="apt-item">' +
      '<div class="apt-info">' +
        '<div class="apt-name">' + esc(a.customerName) + '</div>' +
        '<div class="apt-meta">' + esc(a.date) + ' ' + esc(a.time) +
          (a.address ? ' · ' + esc(a.address) : '') + '</div>' +
        (a.notes ? '<div class="apt-notes">' + esc(a.notes) + '</div>' : '') +
      '</div>' +
      '<button class="btn-del-apt" data-id="' + a.id + '">✕</button>' +
    '</div>'
  ).join('');

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
    const total = (d.geriAranacaklar || []).length
                + (d.beklemeListesi || []).length
                + (d.cevapsizilar || []).length
                + (d.manuelTakip || []).length;
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
}

function followupMatchesSearch(c, q) {
  if (!q) return true;
  return (c.customerName  || '').toLowerCase().includes(q) ||
         (c.customerPhone || '').toLowerCase().includes(q);
}

function renderFollowup(d) {
  renderFollowup._lastData = d;
  const layout = $('followupLayout');
  const searchInput = $('followupSearch');
  const q = searchInput ? searchInput.value.trim().toLowerCase() : '';

  const sections = [
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

  // Toplam sayaç
  const sumEl = $('followupSummary');
  if (sumEl) {
    const total = sections.reduce((s, sec) => s + sec.items.length, 0);
    sumEl.textContent = total + ' kişi · ' + sections.map(s => s.title.split('—')[0].trim() + ': ' + s.items.length).join(' · ');
  }

  layout.innerHTML = sections.map(sec => {
    const cardFn = sec.customCard || ((c) => followupCard(c, sec.color));
    const filtered = sec.items.filter(c => followupMatchesSearch(c, q));
    const cards = filtered.length
      ? filtered.map(c => cardFn(c)).join('')
      : '<div class="fu-empty">' + (q ? 'Aramaya uyan kayıt yok' : sec.emptyMsg) + '</div>';

    const bulkBtn = sec.bulk && filtered.length
      ? '<button class="fu-bulk-btn" data-bulk-key="' + sec.key + '">📞 Hepsini Kampanyaya At (' + filtered.length + ')</button>'
      : '';

    const filterBadge = (q && filtered.length !== sec.items.length)
      ? '<span class="fu-filter-badge">' + filtered.length + '/' + sec.items.length + '</span>'
      : '<span class="fu-count">' + sec.items.length + '</span>';

    return '<div class="fu-section fu-' + sec.color + '">' +
      '<div class="fu-section-header">' +
        '<span class="fu-icon">' + sec.icon + '</span>' +
        '<span class="fu-title">' + sec.title + '</span>' +
        filterBadge +
        bulkBtn +
      '</div>' +
      '<div class="fu-cards">' + cards + '</div>' +
    '</div>';
  }).join('');

  layout.querySelectorAll('.fu-detail-btn').forEach(btn => {
    btn.addEventListener('click', () => openDrawer(btn.dataset.id));
  });
  layout.querySelectorAll('.fu-call-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name   = btn.dataset.name;
      const phone  = btn.dataset.phone;
      const region = btn.dataset.region || '';
      if ($('customerName'))   $('customerName').value   = name;
      if ($('customerPhone'))  $('customerPhone').value  = phone;
      if ($('customerRegion')) $('customerRegion').value = region;
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

function bulkLoadToCampaign(items) {
  campaign.contacts = items.map(c => ({
    name:       c.customerName,
    phone:      c.customerPhone,
    region:     c.customerInfo?.region || '',
    notes:      c.customerInfo?.notes  || '',
    status:     'bekliyor',
    vapiCallId: null,
    result:     null,
  }));
  campaign.running  = false;
  campaign.paused   = false;
  switchTab('campaign');
  renderCampaignTable();
  updateCampaignProgress();
  $('btnCampaignStart').disabled = false;
  $('campaignProgressBar').style.display = 'none';
  toast(items.length + ' kişi kampanyaya yüklendi', 'success');
}

// Son veriyi sakla — bulk btn erişimi için
renderFollowup._lastData = null;

function followupCard(c, colorClass, opts) {
  opts = opts || {};
  const s    = c.summary;
  const ilgi = s ? s.ilgi_seviyesi : null;
  const ilgiCls = ilgi === 'yüksek' ? 'heat-hot' : ilgi === 'orta' ? 'heat-warm' : ilgi === 'düşük' ? 'heat-mid' : 'heat-cold';
  const ilgiStr = ilgi || '—';
  const note = s ? s.geri_donus_notu : null;
  const mulk = s ? s.mulk_tipi : null;
  const ago  = timeSince(c.startTime);

  const unfollowBtn = opts.canUnfollow
    ? '<button class="fu-unfollow-btn" data-id="' + c.vapiCallId + '" title="Takipten çıkart">✓</button>'
    : '';

  return '<div class="fu-card fu-' + colorClass + '">' +
    '<div class="fu-card-top">' +
      '<div class="fu-person">' +
        '<div class="fu-name">' + esc(c.customerName) + '</div>' +
        '<div class="fu-phone">' + esc(c.customerPhone) + '</div>' +
      '</div>' +
      '<div class="fu-heat ' + ilgiCls + '" title="İlgi: ' + ilgiStr + '">' + ilgiStr.slice(0,3) + '</div>' +
    '</div>' +
    (note
      ? '<div class="fu-note">💡 ' + esc(note) + '</div>'
      : '') +
    '<div class="fu-meta">' +
      (mulk ? '<span class="fu-tag">' + esc(mulk) + '</span>' : '') +
      '<span class="fu-ago">' + ago + '</span>' +
    '</div>' +
    '<div class="fu-actions">' +
      '<button class="fu-call-btn" data-id="' + c.vapiCallId + '" ' +
        'data-name="' + esc(c.customerName) + '" ' +
        'data-phone="' + esc(c.customerPhone) + '" ' +
        'data-region="' + esc((c.customerInfo && c.customerInfo.region) || '') + '">📞 Ara</button>' +
      '<button class="fu-detail-btn" data-id="' + c.vapiCallId + '">Detay ›</button>' +
      unfollowBtn +
    '</div>' +
  '</div>';
}

function cevapsizCard(c) {
  const ago     = timeSince(c.startTime);
  const count   = c.retryCount || 1;
  const statusLabel = c.status === 'busy' ? 'Meşgul' : 'Cevapsız';
  const statusCls   = c.status === 'busy' ? 'ct-busy' : 'ct-miss';
  return '<div class="fu-card fu-cevapsiz">' +
    '<div class="fu-card-top">' +
      '<div class="fu-person">' +
        '<div class="fu-name">' + esc(c.customerName) + '</div>' +
        '<div class="fu-phone">' + esc(c.customerPhone) + '</div>' +
      '</div>' +
      '<div class="fu-retry-badge" title="Deneme sayısı">' + count + 'x</div>' +
    '</div>' +
    '<div class="fu-retry-meta">' +
      '<span class="ctag ' + statusCls + '">' + statusLabel + '</span>' +
      '<span class="fu-ago">' + ago + '</span>' +
    '</div>' +
    '<div class="fu-actions">' +
      '<button class="fu-call-btn" data-id="' + c.vapiCallId + '" ' +
        'data-name="' + esc(c.customerName) + '" ' +
        'data-phone="' + esc(c.customerPhone) + '" ' +
        'data-region="' + esc((c.customerInfo && c.customerInfo.region) || '') + '">📞 Tekrar Ara</button>' +
      '<button class="fu-detail-btn" data-id="' + c.vapiCallId + '">Detay ›</button>' +
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
  $('campaignConcurrency').addEventListener('change', function() {
    campaign.maxConcurrent = parseInt(this.value, 10);
  });
  loadCampaignState();
}

function onFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    try {
      const wb   = XLSX.read(ev.target.result, { type: 'array', codepage: 65001 });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      parseContacts(rows);
    } catch(err) {
      toast('Dosya okunamadı: ' + err.message, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
  e.target.value = '';
}

function parseContacts(rows) {
  if (!rows.length) { toast('Dosya boş', 'error'); return; }

  // Detect header row — look for phone-like column
  let dataStart = 0;
  let colName = 0, colPhone = 1, colRegion = 2, colNotes = 3;

  const first = rows[0].map(c => String(c).toLowerCase().trim());
  const phoneIdx = first.findIndex(h => h.includes('telefon') || h.includes('phone') || h.includes('tel'));
  if (phoneIdx >= 0) {
    dataStart = 1;
    colPhone  = phoneIdx;
    colName   = first.findIndex(h => h.includes('ad') || h.includes('isim') || h.includes('name'));
    if (colName < 0) colName = phoneIdx === 0 ? 1 : 0;
    colRegion = first.findIndex(h => h.includes('bölge') || h.includes('bolge') || h.includes('region'));
    if (colRegion < 0) colRegion = -1;
    colNotes  = first.findIndex(h => h.includes('not') || h.includes('note'));
    if (colNotes < 0) colNotes = -1;
  }

  campaign.contacts = [];
  campaign.running  = false;
  campaign.paused   = false;

  for (let i = dataStart; i < rows.length; i++) {
    const row   = rows[i];
    const rawPhone = String(row[colPhone] || '').trim();
    const phone    = rawPhone && !rawPhone.startsWith('+') ? '+' + rawPhone : rawPhone;
    const name     = String(row[colName]  || '').trim() || ('Kişi ' + (i - dataStart + 1));
    if (!phone) continue;
    campaign.contacts.push({
      name,
      phone,
      region: colRegion >= 0 ? String(row[colRegion] || '').trim() : '',
      notes:  colNotes  >= 0 ? String(row[colNotes]  || '').trim() : '',
      status: 'bekliyor',
      vapiCallId: null,
      result: null,
    });
  }

  if (!campaign.contacts.length) { toast('Geçerli telefon bulunamadı', 'error'); return; }

  toast(campaign.contacts.length + ' kişi yüklendi', 'success');
  $('btnCampaignStart').disabled = false;
  $('campaignProgressBar').style.display = 'none';
  renderCampaignTable();
}

async function loadCampaignState() {
  try {
    const resp = await fetch('/api/campaign');
    const json = await resp.json();
    if (!json.success || !json.data || !json.data.contacts || !json.data.contacts.length) return;

    campaign.contacts      = json.data.contacts;
    campaign.running       = json.data.running;
    campaign.paused        = json.data.paused;
    campaign.maxConcurrent = json.data.maxConcurrent || 1;

    const sel = $('campaignConcurrency');
    if (sel) sel.value = String(campaign.maxConcurrent);

    renderCampaignTable();
    updateCampaignProgress();
    syncCampaignButtons();
    $('campaignProgressBar').style.display = 'block';
    toast('Önceki kampanya yüklendi (' + campaign.contacts.length + ' kişi)', 'info');
  } catch(_) {}
}

function syncCampaignButtons() {
  const running = campaign.running;
  const paused  = campaign.paused;
  $('btnCampaignStart').disabled = running && !paused;
  $('btnCampaignPause').disabled = !running;
  $('btnCampaignStop').disabled  = !running;
  $('btnCampaignPause').textContent = paused ? '▶ Devam Et' : '⏸ Duraklat';
}

function renderCampaignTable() {
  const tbody = $('campaignTableBody');
  if (!campaign.contacts.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Excel veya CSV dosyası yükleyin</td></tr>';
    return;
  }
  tbody.innerHTML = campaign.contacts.map((c, i) => campaignRowHtml(c, i)).join('');
  attachCampaignRowClicks(tbody);
}

function attachCampaignRowClicks(tbody) {
  tbody.querySelectorAll('.cp-row-click').forEach(row => {
    row.addEventListener('click', () => openDrawer(row.dataset.callid));
  });
}

function campaignRowHtml(c, i) {
  const statusTag = {
    bekliyor:    '<span class="ctag ct-wait">Bekliyor</span>',
    arıyor:      '<span class="ctag ct-calling">📞 Arıyor</span>',
    tamamlandı:  '<span class="ctag ct-done">✅ Tamamlandı</span>',
    cevapsız:    '<span class="ctag ct-miss">📵 Cevapsız</span>',
    meşgul:      '<span class="ctag ct-busy">🔴 Meşgul</span>',
    başarısız:   '<span class="ctag ct-fail">❌ Başarısız</span>',
  }[c.status] || '<span class="ctag ct-wait">' + esc(c.status) + '</span>';

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
    '<td class="dur-cell">' + esc(c.phone) + '</td>' +
    '<td>' + esc(c.region || '—') + '</td>' +
    '<td>' + statusTag + '</td>' +
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

function updateCampaignProgress() {
  const total    = campaign.contacts.length;
  const done     = campaign.contacts.filter(c => c.status !== 'bekliyor' && c.status !== 'arıyor').length;
  const randevu  = campaign.contacts.filter(c => c.result && c.result.randevu_alindi).length;
  const fail     = campaign.contacts.filter(c => ['cevapsız','meşgul','başarısız'].includes(c.status)).length;
  const active   = campaign.contacts.filter(c => c.status === 'arıyor').length;
  const pct      = total ? Math.round(done / total * 100) : 0;

  $('progressText').textContent = done + ' / ' + total;
  $('progressPct').textContent  = pct + '%';
  $('progressFill').style.width = pct + '%';
  $('psDone').textContent    = '✅ ' + (done - fail) + ' Tamamlandı';
  $('psRandevu').textContent = '📅 ' + randevu + ' Randevu';
  $('psFail').textContent    = '❌ ' + fail + ' Başarısız';
  $('psActive').textContent  = '📞 ' + active + ' Aktif';

  if (done === total && total > 0) {
    syncCampaignButtons();
  }
}

function updateCampaignProgressFromSummary(sum) {
  const total  = sum.total  || campaign.contacts.length;
  const done   = sum.done   ?? campaign.contacts.filter(c => c.status !== 'bekliyor' && c.status !== 'arıyor').length;
  const randevu = sum.randevu ?? campaign.contacts.filter(c => c.result && c.result.randevu_alindi).length;
  const fail   = sum.fail   ?? campaign.contacts.filter(c => ['cevapsız','meşgul','başarısız'].includes(c.status)).length;
  const active = sum.active  ?? campaign.contacts.filter(c => c.status === 'arıyor').length;
  const pct    = total ? Math.round(done / total * 100) : 0;
  $('progressText').textContent = done + ' / ' + total;
  $('progressPct').textContent  = pct + '%';
  $('progressFill').style.width = pct + '%';
  $('psDone').textContent    = '✅ ' + (done - fail) + ' Tamamlandı';
  $('psRandevu').textContent = '📅 ' + randevu + ' Randevu';
  $('psFail').textContent    = '❌ ' + fail + ' Başarısız';
  $('psActive').textContent  = '📞 ' + active + ' Aktif';
}

async function campaignStart() {
  if (!campaign.contacts.length) return;
  campaign.maxConcurrent = parseInt($('campaignConcurrency').value, 10) || 1;
  const scenarioId = $('scenarioSelect') ? ($('scenarioSelect').value || undefined) : undefined;
  try {
    const resp = await fetch('/api/campaign/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contacts:      campaign.contacts,
        maxConcurrent: campaign.maxConcurrent,
        scenarioId,
      }),
    });
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    $('campaignProgressBar').style.display = 'block';
    syncCampaignButtons();
    toast('Kampanya sunucuda başlatıldı — tarayıcıyı kapatabilirsiniz', 'success');
  } catch(err) {
    toast('Kampanya başlatılamadı: ' + err.message, 'error');
  }
}

async function campaignPause() {
  try {
    const resp = await fetch('/api/campaign/pause', { method: 'POST' });
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
  try {
    const resp = await fetch('/api/campaign/stop', { method: 'POST' });
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    campaign.running = false;
    campaign.paused  = false;
    syncCampaignButtons();
    toast('Kampanya durduruldu', 'info');
  } catch(err) {
    toast('Hata: ' + err.message, 'error');
  }
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
  loadScenarios();
}

async function loadScenarios() {
  try {
    const resp = await fetch('/api/scenarios');
    const json = await resp.json();
    if (!json.success) return;
    scenariosCache = json.data;
    refreshScenarioSelects();
  } catch(e) {}
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
    fsel.innerHTML = '<option value="">Tümü</option>';
    scenariosCache.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      if (s.id === fcur) opt.selected = true;
      fsel.appendChild(opt);
    });
  }
}

function openScenarioModal() {
  $('scenarioModal').classList.add('open');
  $('scenarioModalOverlay').classList.add('visible');
  $('scenarioForm').style.display = 'none';
  renderScenarioList();
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
        '<div class="sc-item-name">' + esc(s.name) + '</div>' +
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
  $('scenarioForm').style.display = 'block';
  $('scenarioName').focus();
}

function showEditScenarioForm(id) {
  const s = scenariosCache.find(x => x.id === id);
  if (!s) return;
  $('scenarioEditId').value = s.id;
  $('scenarioName').value   = s.name;
  $('scenarioPrompt').value = s.systemPrompt;
  $('scenarioForm').style.display = 'block';
  $('scenarioName').focus();
}

async function saveScenario() {
  const id     = $('scenarioEditId').value;
  const name   = $('scenarioName').value.trim();
  const prompt = $('scenarioPrompt').value.trim();
  if (!name || !prompt) { toast('Ad ve prompt zorunlu', 'error'); return; }

  try {
    const method = id ? 'PUT' : 'POST';
    const url    = id ? '/api/scenarios/' + id : '/api/scenarios';
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, systemPrompt: prompt }),
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
  if (!confirm('"' + s.name + '" silinsin mi?')) return;
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

