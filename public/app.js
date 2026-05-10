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
};

const campaign = {
  contacts: [],        // { name, phone, region, notes, status, vapiCallId, result }
  callMap: new Map(),  // vapiCallId → contactIndex
  pollMap: new Map(),  // vapiCallId → intervalId
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
  filterMinScore:   $('filterMinScore'),
  filterMaxScore:   $('filterMaxScore'),
  filterNiyet:      $('filterNiyet'),
  filterAksiyon:    $('filterAksiyon'),
  filterStatus:     $('filterStatus'),
  filterRandevu:    $('filterRandevu'),
  filterScenario:   $('filterScenario'),
  btnApplyFilter:   $('btnApplyFilter'),
  btnClearFilter:   $('btnClearFilter'),
  btnExport:        $('btnExport'),
  callsTableBody:   $('callsTableBody'),
  statTotal:        $('statTotal'),
  statCompleted:    $('statCompleted'),
  statAnswerRate:   $('statAnswerRate'),
  statAvgDur:       $('statAvgDur'),
  statAvgHeat:      $('statAvgHeat'),
  statConvSub:      $('statConvSub'),
  statCost:         $('statCost'),
  statCostPer:      $('statCostPer'),
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
  initDrawer();
  initAppointments();
  initCampaign();
  initScenarios();
  connectSSE();
  loadHistory();
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
                  (name === 'campaign' && c.id === 'tabCampaign');
    c.classList.toggle('active', match);
  });
  if (name === 'history') loadHistory();
  if (name === 'stats')   loadStats();
}

// ─── SSE ─────────────────────────────────────────────────────────────────────

function connectSSE() {
  if (state.sseSource) state.sseSource.close();
  const src = new EventSource('/api/events');
  state.sseSource = src;

  src.addEventListener('connected', () => console.log('[SSE] Bağlandı'));

  src.addEventListener('call-started', e => {
    const { vapiCallId } = JSON.parse(e.data);
    state.activeCallId = vapiCallId;
    updateStatus('Bağlanıyor...', 'calling');
    setBadge('Çalıyor');
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

    // Campaign call ended
    if (campaign.callMap.has(vapiCallId)) {
      campaignStopPoll(vapiCallId);
      resolveCampaignCall(vapiCallId, status, duration);
    }

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

    // Campaign: update contact result
    if (campaign.callMap.has(vapiCallId)) {
      const idx = campaign.callMap.get(vapiCallId);
      campaign.contacts[idx].result = summary;
      renderCampaignRow(idx);
      updateCampaignProgress();
    }

    if (vapiCallId !== state.activeCallId) return;
    renderInlineSummary(summary);
    toast('Özet hazırlandı', 'success');
  });

  src.addEventListener('summary-error', e => {
    const { error } = JSON.parse(e.data);
    toast('Özet hatası: ' + error, 'error');
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
  DOM.callPulse.classList.add('active');
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
      '<span class="pill heat-pill">' + s.sicaklik_skoru + '/100</span>' +
      '<span class="pill n-' + s.niyet + '">' + esc(s.niyet) + '</span>' +
      '<span class="pill">' + esc(s.mulk_tipi) + '</span>' +
      (s.bolge ? '<span class="pill">📍 ' + esc(s.bolge) + '</span>' : '') +
      (s.butce ? '<span class="pill">💰 ' + esc(s.butce) + '</span>' : '') +
      '<span class="pill a-' + actionClass(s.tavsiye_edilen_aksiyon) + '">' + esc(s.tavsiye_edilen_aksiyon) + '</span>' +
    '</div>' +
    '<div class="summary-text">' + esc(s.ozet) + '</div>';
  DOM.transcriptArea.appendChild(div);
  DOM.transcriptArea.scrollTop = DOM.transcriptArea.scrollHeight;
}

// ─── HISTORY TABLE ───────────────────────────────────────────────────────────

function initFilterBar() {
  DOM.btnApplyFilter.addEventListener('click', loadHistory);
  DOM.btnClearFilter.addEventListener('click', () => {
    DOM.filterDateFrom.value  = '';
    DOM.filterDateTo.value    = '';
    DOM.filterMinScore.value  = '';
    DOM.filterMaxScore.value  = '';
    DOM.filterNiyet.value     = '';
    DOM.filterAksiyon.value   = '';
    DOM.filterStatus.value    = '';
    DOM.filterRandevu.value   = '';
    DOM.filterScenario.value  = '';
    state.currentFilters = {};
    loadHistory();
  });
  DOM.btnExport.addEventListener('click', exportCSV);
}

async function loadHistory() {
  const params = buildFilterParams();
  state.currentFilters = params;
  DOM.callsTableBody.innerHTML = '<tr><td colspan="14" class="table-empty">Yükleniyor...</td></tr>';
  try {
    const qs   = new URLSearchParams(params).toString();
    const resp = await fetch('/api/calls' + (qs ? '?' + qs : ''));
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    renderTable(json.data);
  } catch (err) {
    DOM.callsTableBody.innerHTML = '<tr><td colspan="14" class="table-empty">Hata: ' + err.message + '</td></tr>';
  }
}

function buildFilterParams() {
  const p = {};
  if (DOM.filterDateFrom.value)  p.dateFrom  = DOM.filterDateFrom.value;
  if (DOM.filterDateTo.value)    p.dateTo    = DOM.filterDateTo.value;
  if (DOM.filterMinScore.value)  p.minScore  = DOM.filterMinScore.value;
  if (DOM.filterMaxScore.value)  p.maxScore  = DOM.filterMaxScore.value;
  if (DOM.filterNiyet.value)     p.niyet     = DOM.filterNiyet.value;
  if (DOM.filterAksiyon.value)   p.aksiyon   = DOM.filterAksiyon.value;
  if (DOM.filterStatus.value)    p.status    = DOM.filterStatus.value;
  if (DOM.filterRandevu.value)   p.randevu    = DOM.filterRandevu.value;
  if (DOM.filterScenario.value)  p.scenarioId = DOM.filterScenario.value;
  return p;
}

function renderTable(calls) {
  if (!calls.length) {
    DOM.callsTableBody.innerHTML = '<tr><td colspan="14" class="table-empty">Kayıt bulunamadı</td></tr>';
    return;
  }
  DOM.callsTableBody.innerHTML = calls.map(c => {
    const s    = c.summary;
    const heat = s != null && s.sicaklik_skoru != null ? s.sicaklik_skoru : null;
    const heatBar = heat !== null
      ? '<div class="heat-cell"><div class="heat-bar" style="width:' + heat + '%"></div><span>' + heat + '</span></div>'
      : '—';
    return '<tr class="call-row" data-id="' + c.vapiCallId + '">' +
      '<td>' + fmtDateTime(c.startTime) + '</td>' +
      '<td>' + esc(c.customerName) + '</td>' +
      '<td>' + esc(c.customerPhone) + '</td>' +
      '<td>' + (c.duration ? fmtDuration(c.duration) : '—') + '</td>' +
      '<td>' + heatBar + '</td>' +
      '<td>' + (s && s.niyet ? '<span class="tag n-' + s.niyet + '">' + esc(s.niyet) + '</span>' : '—') + '</td>' +
      '<td>' + esc((s && s.bolge) || '—') + '</td>' +
      '<td>' + esc((s && s.butce) || '—') + '</td>' +
      '<td>' + (c.scenarioName ? '<span class="tag sc-tag">' + esc(c.scenarioName) + '</span>' : '<span class="tag sc-default">Varsayılan</span>') + '</td>' +
      '<td>' + randevuBadge(s) + '</td>' +
      '<td>' + (s && s.tavsiye_edilen_aksiyon
        ? '<span class="tag a-' + actionClass(s.tavsiye_edilen_aksiyon) + '">' + esc(s.tavsiye_edilen_aksiyon) + '</span>'
        : '—') + '</td>' +
      '<td>$' + ((c.costs && c.costs.total) || 0).toFixed(4) + '</td>' +
      '<td><span class="tag s-' + c.status + '">' + statusLabel(c.status) + '</span></td>' +
      '<td><button class="btn-detail" data-id="' + c.vapiCallId + '">›</button></td>' +
      '</tr>';
  }).join('');

  DOM.callsTableBody.querySelectorAll('.btn-detail').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openDrawer(btn.dataset.id); });
  });
  DOM.callsTableBody.querySelectorAll('.call-row').forEach(row => {
    row.addEventListener('click', () => openDrawer(row.dataset.id));
  });
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
          '<div class="sg-item"><span class="sg-label">Sıcaklık</span>' +
            '<span class="sg-val heat-val">' + s.sicaklik_skoru + '/100</span></div>' +
          '<div class="sg-item"><span class="sg-label">Niyet</span>' +
            '<span class="sg-val"><span class="tag n-' + s.niyet + '">' + esc(s.niyet) + '</span></span></div>' +
          '<div class="sg-item"><span class="sg-label">Mülk Tipi</span>' +
            '<span class="sg-val">' + esc(s.mulk_tipi) + '</span></div>' +
          '<div class="sg-item"><span class="sg-label">Bölge</span>' +
            '<span class="sg-val">' + esc(s.bolge || '—') + '</span></div>' +
          '<div class="sg-item"><span class="sg-label">Bütçe</span>' +
            '<span class="sg-val">' + esc(s.butce || '—') + '</span></div>' +
          '<div class="sg-item"><span class="sg-label">Zaman</span>' +
            '<span class="sg-val">' + esc(s.zaman_cercevesi) + '</span></div>' +
          '<div class="sg-item"><span class="sg-label">Çevre Potansiyeli</span>' +
            '<span class="sg-val">' + (s.cevredeki_potansiyel ? '✅ Evet' : '❌ Hayır') + '</span></div>' +
          '<div class="sg-item"><span class="sg-label">Randevu</span>' +
            '<span class="sg-val">' + (s.randevu_alindi ? '✅ Alındı' : '❌ Alınmadı') + '</span></div>' +
          '<div class="sg-item"><span class="sg-label">Aksiyon</span>' +
            '<span class="sg-val"><span class="tag a-' + actionClass(s.tavsiye_edilen_aksiyon) + '">' +
            esc(s.tavsiye_edilen_aksiyon) + '</span></span></div>' +
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

async function loadStats() {
  try {
    const resp = await fetch('/api/stats');
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    renderStats(json.data);
  } catch (err) {
    toast('İstatistik hatası: ' + err.message, 'error');
  }
}

function renderStats(d) {
  // Stat cards
  DOM.statTotal.textContent      = d.totalCalls;
  DOM.statCompleted.textContent  = d.completedCalls;
  DOM.statAnswerRate.textContent = d.answerRate + '% cevap oranı';
  DOM.statAvgDur.textContent     = d.avgDuration ? fmtDuration(d.avgDuration) : '—';
  DOM.statAvgHeat.textContent    = d.avgHeatScore || '—';
  DOM.statConvSub.textContent    = d.conversionRate + '% dönüşüm (≥60)';
  DOM.statCost.textContent       = '$' + d.totalCost.toFixed(4);
  DOM.statCostPer.textContent    = d.totalCalls
    ? '$' + (d.totalCost / d.totalCalls).toFixed(4) + ' / arama' : '— / arama';
  DOM.statRandevu.textContent    = d.randevuCount;
  DOM.statRandevuRate.textContent = d.randevuRate + '% randevu oranı';

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

  buildOrUpdateChart('chartCostTrend', 'line', {
    labels: labels30,
    datasets: [{
      label: 'Maliyet ($)',
      data: d.costTrend.map(x => x.cost),
      borderColor: '#4A9EFF',
      backgroundColor: 'rgba(74,158,255,0.08)',
      fill: true,
      tension: 0.35,
      pointRadius: 2,
      pointBackgroundColor: '#4A9EFF',
    }],
  }, { ...baseOpts, plugins: { legend: { labels: baseLegend } }, scales: baseScales });

  buildOrUpdateChart('chartHeatDist', 'bar', {
    labels: d.heatDistribution.map(x => x.range),
    datasets: [{
      label: 'Müşteri',
      data: d.heatDistribution.map(x => x.count),
      backgroundColor: ['rgba(255,83,112,0.7)','rgba(255,159,64,0.7)','rgba(255,208,96,0.7)','rgba(0,200,150,0.5)','rgba(0,200,150,0.85)'],
      borderColor:     ['#FF5370','#FF9F40','#FFD060','#00C896','#00C896'],
      borderWidth: 1,
      borderRadius: 4,
    }],
  }, { ...baseOpts, plugins: { legend: { display: false } }, scales: baseScales });

  buildOrUpdateChart('chartIntentDist', 'doughnut', {
    labels: d.intentDistribution.map(x => x.niyet),
    datasets: [{
      data: d.intentDistribution.map(x => x.count),
      backgroundColor: ['rgba(0,200,150,0.75)','rgba(74,158,255,0.75)','rgba(255,159,64,0.75)','rgba(180,100,255,0.75)','rgba(255,208,96,0.75)','rgba(74,80,104,0.75)'],
      borderColor: '#12151C',
      borderWidth: 2,
      hoverOffset: 6,
    }],
  }, { ...baseOpts, plugins: { legend: { position: 'bottom', labels: { ...baseLegend, padding: 12, boxWidth: 12 } } } });

  const actionColors = ['rgba(0,200,150,0.75)','rgba(74,158,255,0.75)','rgba(255,208,96,0.75)','rgba(255,83,112,0.75)'];
  buildOrUpdateChart('chartActionDist', 'bar', {
    labels: d.actionDistribution.map(x => x.action),
    datasets: [{
      label: 'Aksiyon',
      data: d.actionDistribution.map(x => x.count),
      backgroundColor: d.actionDistribution.map((_, i) => actionColors[i % actionColors.length]),
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

  buildOrUpdateChart('chartHourly', 'bar', {
    labels: d.hourlyDistribution.map(x => x.hour + ':00'),
    datasets: [{
      label: 'Arama',
      data: d.hourlyDistribution.map(x => x.count),
      backgroundColor: 'rgba(180,100,255,0.35)',
      borderColor: '#b464ff',
      borderWidth: 1,
      borderRadius: 3,
    }],
  }, { ...baseOpts, plugins: { legend: { display: false } }, scales: { ...baseScales, x: { ...baseScales.x, maxTicksLimit: 12 } } });
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
}

function onFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    try {
      const wb   = XLSX.read(ev.target.result, { type: 'binary' });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      parseContacts(rows);
    } catch(err) {
      toast('Dosya okunamadı: ' + err.message, 'error');
    }
  };
  reader.readAsBinaryString(file);
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

  campaign.pollMap.forEach((id) => clearInterval(id));
  campaign.contacts = [];
  campaign.callMap  = new Map();
  campaign.pollMap  = new Map();
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

function renderCampaignTable() {
  const tbody = $('campaignTableBody');
  if (!campaign.contacts.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Excel veya CSV dosyası yükleyin</td></tr>';
    return;
  }
  tbody.innerHTML = campaign.contacts.map((c, i) => campaignRowHtml(c, i)).join('');
}

function campaignRowHtml(c, i) {
  const statusTag = {
    bekliyor:    '<span class="ctag ct-wait">Bekliyor</span>',
    arıyor:      '<span class="ctag ct-calling">📞 Arıyor</span>',
    tamamlandı:  '<span class="ctag ct-done">Tamamlandı</span>',
    cevapsız:    '<span class="ctag ct-miss">Cevapsız</span>',
    meşgul:      '<span class="ctag ct-busy">Meşgul</span>',
    başarısız:   '<span class="ctag ct-fail">Başarısız</span>',
  }[c.status] || '<span class="ctag ct-wait">' + esc(c.status) + '</span>';

  const heat = c.result ? c.result.sicaklik_skoru : '—';
  const rdv  = c.result ? (c.result.randevu_alindi ? '✅' : '❌') : '—';

  return '<tr id="crow-' + i + '">' +
    '<td>' + (i + 1) + '</td>' +
    '<td>' + esc(c.name) + '</td>' +
    '<td>' + esc(c.phone) + '</td>' +
    '<td>' + esc(c.region || '—') + '</td>' +
    '<td>' + statusTag + '</td>' +
    '<td>' + heat + '</td>' +
    '<td>' + rdv + '</td>' +
    '<td>' + (c.duration ? fmtDuration(c.duration) : '—') + '</td>' +
    '</tr>';
}

function renderCampaignRow(idx) {
  const row = $('crow-' + idx);
  if (!row) return;
  const c = campaign.contacts[idx];
  row.outerHTML = campaignRowHtml(c, idx);
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

  if (done === total && total > 0 && campaign.running) {
    campaign.running = false;
    $('btnCampaignStart').disabled = true;
    $('btnCampaignPause').disabled = true;
    $('btnCampaignStop').disabled  = true;
    toast('Kampanya tamamlandı! ' + randevu + ' randevu alındı.', 'success');
  }
}

function campaignStart() {
  if (!campaign.contacts.length) return;
  campaign.running  = true;
  campaign.paused   = false;
  campaign.maxConcurrent = parseInt($('campaignConcurrency').value, 10) || 1;
  $('btnCampaignStart').disabled = true;
  $('btnCampaignPause').disabled = false;
  $('btnCampaignStop').disabled  = false;
  $('campaignProgressBar').style.display = 'block';
  updateCampaignProgress();
  campaignFillQueue();
}

function campaignPause() {
  campaign.paused = !campaign.paused;
  $('btnCampaignPause').textContent = campaign.paused ? '▶ Devam Et' : '⏸ Duraklat';
  toast(campaign.paused ? 'Kampanya duraklatıldı' : 'Kampanya devam ediyor', 'info');
  if (!campaign.paused) campaignFillQueue();
}

function campaignStop() {
  campaign.running = false;
  campaign.paused  = false;
  // Clear all active polls
  campaign.pollMap.forEach((id) => clearInterval(id));
  campaign.pollMap.clear();
  campaign.callMap.clear();
  // Mark remaining pending as stopped
  campaign.contacts.forEach(c => { if (c.status === 'bekliyor') c.status = 'başarısız'; });
  renderCampaignTable();
  updateCampaignProgress();
  $('btnCampaignStart').disabled = false;
  $('btnCampaignPause').disabled = true;
  $('btnCampaignStop').disabled  = true;
  $('btnCampaignPause').textContent = '⏸ Duraklat';
  toast('Kampanya durduruldu', 'info');
}

function campaignFillQueue() {
  if (!campaign.running || campaign.paused) return;
  const activeCount = campaign.contacts.filter(c => c.status === 'arıyor').length;
  const slots = campaign.maxConcurrent - activeCount;
  if (slots <= 0) return;

  let started = 0;
  for (let i = 0; i < campaign.contacts.length && started < slots; i++) {
    if (campaign.contacts[i].status === 'bekliyor') {
      campaignCallContact(i);
      started++;
    }
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

async function campaignCallContact(idx) {
  const c = campaign.contacts[idx];
  c.status = 'arıyor';
  c.callStartTs = Date.now();
  renderCampaignRow(idx);

  try {
    const campaignScenarioId = $('scenarioSelect') ? ($('scenarioSelect').value || undefined) : undefined;
    const resp = await fetch('/api/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: { name: c.name, phone: c.phone, region: c.region, notes: c.notes }, scenarioId: campaignScenarioId }),
    });
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    c.vapiCallId = json.data.callId;
    campaign.callMap.set(c.vapiCallId, idx);
    campaignStartPoll(c.vapiCallId, idx);
  } catch(err) {
    c.status = 'başarısız';
    renderCampaignRow(idx);
    updateCampaignProgress();
    if (campaign.running && !campaign.paused) campaignFillQueue();
    toast(c.name + ': Arama başlatılamadı', 'error');
  }
}

function campaignStartPoll(vapiCallId, idx) {
  const intervalId = setInterval(async () => {
    try {
      const r = await fetch('/api/calls/' + vapiCallId);
      const j = await r.json();
      if (!j.success) return;
      const call = j.data;
      if (call.status !== 'in-progress') {
        campaignStopPoll(vapiCallId);
        resolveCampaignCall(vapiCallId, call.status, call.duration);
      }
    } catch(e) {}
  }, 10000);
  campaign.pollMap.set(vapiCallId, intervalId);
}

function campaignStopPoll(vapiCallId) {
  if (campaign.pollMap.has(vapiCallId)) {
    clearInterval(campaign.pollMap.get(vapiCallId));
    campaign.pollMap.delete(vapiCallId);
  }
}

function resolveCampaignCall(vapiCallId, status, duration) {
  if (!campaign.callMap.has(vapiCallId)) return;
  const idx = campaign.callMap.get(vapiCallId);
  // Do NOT delete from callMap — summary-ready event needs it later
  const cStatus = (status === 'completed') ? 'tamamlandı' :
                  (status === 'no-answer') ? 'cevapsız'   :
                  (status === 'busy')      ? 'meşgul'     : 'başarısız';
  campaign.contacts[idx].status   = cStatus;
  if (duration) campaign.contacts[idx].duration = duration;
  renderCampaignRow(idx);
  updateCampaignProgress();
  if (campaign.running && !campaign.paused) campaignFillQueue();
}
