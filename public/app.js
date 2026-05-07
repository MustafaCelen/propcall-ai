// PropCall AI — Frontend

// ─── STATE ───────────────────────────────────────────────────────────────────

const state = {
  activeCallId: null,
  callStartTs:  null,
  timerInterval: null,
  charts: {},
  currentFilters: {},
  sseSource: null,
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
  filterRandevu:    $('filterRandevu'),
  filterIlgi:       $('filterIlgi'),
  filterStatus:     $('filterStatus'),
  btnApplyFilter:   $('btnApplyFilter'),
  btnClearFilter:   $('btnClearFilter'),
  btnExport:        $('btnExport'),
  callsTableBody:   $('callsTableBody'),
  statTotal:        $('statTotal'),
  statAvgDur:       $('statAvgDur'),
  statAppCount:     $('statAppCount'),
  statCost:         $('statCost'),
  statAppRate:      $('statAppRate'),
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
  connectSSE();
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
    const match = (name === 'live' && c.id === 'tabLive') ||
                  (name === 'history' && c.id === 'tabHistory') ||
                  (name === 'stats' && c.id === 'tabStats');
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
    const { vapiCallId, status, endedReason } = JSON.parse(e.data);
    if (vapiCallId !== state.activeCallId) return;
    stopTimer();
    const label = statusLabel(status);
    updateStatus(label, status);
    setBadge(label);
    DOM.callPulse.classList.remove('active');
    DOM.liveDotBtn.classList.remove('active');
    DOM.btnStartCall.disabled = false;
    DOM.btnEndCall.disabled   = true;
    toast('Arama sona erdi: ' + (endedReason || status), 'info');
  });

  src.addEventListener('summary-ready', e => {
    const { vapiCallId, summary } = JSON.parse(e.data);
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
  const phone = DOM.customerPhone.value.trim();
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
      }),
    });
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    state.activeCallId = json.data.callId;
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
  try {
    await fetch('/api/call/' + state.activeCallId, { method: 'DELETE' });
    toast('Arama sonlandırıldı', 'info');
  } catch (err) {
    toast('Sonlandırma hatası: ' + err.message, 'error');
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
      (s.randevu_alindi
        ? '<span class="pill randevu-evet">✓ Randevu Alındı</span>'
        : '<span class="pill randevu-hayir">✗ Reddetti</span>') +
      (s.ilgi_seviyesi ? '<span class="pill">' + esc(s.ilgi_seviyesi) + '</span>' : '') +
      (s.mulk_tipi ? '<span class="pill">🏠 ' + esc(s.mulk_tipi) + '</span>' : '') +
      (s.ret_nedeni ? '<span class="pill">💬 ' + esc(s.ret_nedeni) + '</span>' : '') +
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
    if (DOM.filterRandevu) DOM.filterRandevu.value = '';
    if (DOM.filterIlgi)    DOM.filterIlgi.value    = '';
    DOM.filterStatus.value    = '';
    state.currentFilters = {};
    loadHistory();
  });
  DOM.btnExport.addEventListener('click', exportCSV);
}

let _historyAbort = null;

async function loadHistory() {
  if (_historyAbort) _historyAbort.abort();
  _historyAbort = new AbortController();
  const signal = _historyAbort.signal;

  const params = buildFilterParams();
  state.currentFilters = params;
  DOM.callsTableBody.innerHTML = '<tr><td colspan="9" class="table-empty">Yükleniyor...</td></tr>';
  DOM.btnApplyFilter.disabled = true;
  try {
    const qs   = new URLSearchParams(params).toString();
    const resp = await fetch('/api/calls' + (qs ? '?' + qs : ''), { signal });
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);
    renderTable(json.data);
  } catch (err) {
    if (err.name === 'AbortError') return;
    DOM.callsTableBody.innerHTML = '<tr><td colspan="9" class="table-empty">Hata: ' + err.message + '</td></tr>';
  } finally {
    DOM.btnApplyFilter.disabled = false;
  }
}

function buildFilterParams() {
  const p = {};
  if (DOM.filterDateFrom.value)             p.dateFrom = DOM.filterDateFrom.value;
  if (DOM.filterDateTo.value)               p.dateTo   = DOM.filterDateTo.value;
  if (DOM.filterRandevu && DOM.filterRandevu.value) p.randevu = DOM.filterRandevu.value;
  if (DOM.filterIlgi    && DOM.filterIlgi.value)    p.ilgi    = DOM.filterIlgi.value;
  if (DOM.filterStatus.value)               p.status   = DOM.filterStatus.value;
  return p;
}

function renderTable(calls) {
  if (!calls.length) {
    DOM.callsTableBody.innerHTML = '<tr><td colspan="9" class="table-empty">Kayıt bulunamadı</td></tr>';
    return;
  }
  DOM.callsTableBody.innerHTML = calls.map(c => {
    const s = c.summary;
    const randevuBadge = s == null
      ? '—'
      : s.randevu_alindi
        ? '<span class="tag randevu-evet">✓ Randevu</span>'
        : '<span class="tag randevu-hayir">✗ Reddetti</span>';
    const ilgiBadge = s && s.ilgi_seviyesi
      ? '<span class="tag ilgi-' + s.ilgi_seviyesi.replace('ü','u').replace('ş','s') + '">' + esc(s.ilgi_seviyesi) + '</span>'
      : '—';
    return '<tr class="call-row" data-id="' + c.vapiCallId + '">' +
      '<td>' + fmtDateTime(c.startTime) + '</td>' +
      '<td>' + esc(c.customerName) + '</td>' +
      '<td>' + esc(c.customerPhone) + '</td>' +
      '<td>' + (c.duration ? fmtDuration(c.duration) : '—') + '</td>' +
      '<td>' + randevuBadge + '</td>' +
      '<td>' + ilgiBadge + '</td>' +
      '<td class="ozet-cell">' + esc((s && s.ozet) ? s.ozet.substring(0, 60) + (s.ozet.length > 60 ? '…' : '') : '—') + '</td>' +
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
  DOM.drawerSub.textContent   = call.customerPhone + ' · ' + fmtDateTime(call.startTime);

  const s    = call.summary;
  const cost = call.costs || {};

  let summaryHtml;
  if (s) {
    summaryHtml =
      '<div class="drawer-section">' +
        '<div class="drawer-section-title">📊 Özet</div>' +
        '<div class="summary-grid">' +
          '<div class="sg-item"><span class="sg-label">Randevu</span>' +
            '<span class="sg-val">' +
              (s.randevu_alindi
                ? '<span class="tag randevu-evet">✓ Alındı</span>'
                : '<span class="tag randevu-hayir">✗ Reddetti</span>') +
            '</span></div>' +
          '<div class="sg-item"><span class="sg-label">İlgi Seviyesi</span>' +
            '<span class="sg-val">' + esc(s.ilgi_seviyesi || '—') + '</span></div>' +
          '<div class="sg-item"><span class="sg-label">Mülk Tipi</span>' +
            '<span class="sg-val">' + esc(s.mulk_tipi || '—') + '</span></div>' +
          (s.ret_nedeni
            ? '<div class="sg-item"><span class="sg-label">Ret Nedeni</span>' +
              '<span class="sg-val">' + esc(s.ret_nedeni) + '</span></div>'
            : '') +
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

  let transcriptHtml = '';
  if (call.transcript && call.transcript.length) {
    const recLink = call.recordingUrl
      ? ' <a class="recording-link" href="' + call.recordingUrl + '" target="_blank">🎧 Dinle</a>'
      : '';
    transcriptHtml =
      '<div class="drawer-section">' +
        '<div class="drawer-section-title">💬 Transkript' + recLink + '</div>' +
        '<div class="drawer-transcript">' +
          call.transcript.map(t =>
            '<div class="dt-msg ' + t.role + '">' +
              '<span class="dt-label">' + (t.role === 'assistant' ? '🤖' : '👤') + '</span>' +
              '<div><div class="dt-text">' + esc(t.text) + '</div>' +
              '<div class="dt-time">' + fmtTime(t.timestamp) + '</div></div>' +
            '</div>'
          ).join('') +
        '</div>' +
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
  DOM.statTotal.textContent    = d.totalCalls;
  DOM.statAvgDur.textContent   = d.avgDuration ? fmtDuration(d.avgDuration) : '—';
  DOM.statAppCount.textContent = d.appointmentCount;
  DOM.statCost.textContent     = '$' + d.totalCost.toFixed(4);
  DOM.statAppRate.textContent  = d.appointmentRate + '%';

  const labels30    = d.dailyCalls.map(x => x.date.slice(5));
  const tickColor   = '#64748b';
  const gridColor   = '#1e293b';
  const legendColor = '#94a3b8';
  const baseScales  = {
    x: { ticks: { color: tickColor, maxTicksLimit: 10 }, grid: { color: gridColor } },
    y: { ticks: { color: tickColor }, grid: { color: gridColor } },
  };
  const baseLegendLabels = { color: legendColor, font: { size: 11 } };

  buildOrUpdateChart('chartDailyCalls', 'bar', {
    labels: labels30,
    datasets: [
      {
        label: 'Arama',
        data: d.dailyCalls.map(x => x.count),
        backgroundColor: 'rgba(99,102,241,0.7)',
        borderColor: '#6366f1',
        borderWidth: 1,
        borderRadius: 4,
      },
      {
        label: 'Randevu',
        data: d.dailyAppointments.map(x => x.count),
        backgroundColor: 'rgba(16,185,129,0.8)',
        borderColor: '#10b981',
        borderWidth: 1,
        borderRadius: 4,
      },
    ],
  }, {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: baseLegendLabels } },
    scales: baseScales,
  });

  buildOrUpdateChart('chartCostTrend', 'line', {
    labels: labels30,
    datasets: [{
      label: 'Maliyet ($)',
      data: d.costTrend.map(x => x.cost),
      borderColor: '#10b981',
      backgroundColor: 'rgba(16,185,129,0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: 2,
    }],
  }, {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: baseLegendLabels } },
    scales: baseScales,
  });

  buildOrUpdateChart('chartAppointmentRate', 'doughnut', {
    labels: ['Randevu Alındı', 'Alınamadı'],
    datasets: [{
      data: [d.appointmentCount, Math.max(0, d.totalCalls - d.appointmentCount)],
      backgroundColor: ['#10b981', '#334155'],
      borderWidth: 2,
      borderColor: '#0f172a',
    }],
  }, {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: baseLegendLabels },
      tooltip: {
        callbacks: {
          label: ctx => ctx.label + ': ' + ctx.raw + ' (' + d.appointmentRate + '%)',
        },
      },
    },
  });
}

function buildOrUpdateChart(id, type, data, options) {
  const canvas = $(id);
  if (!canvas) return;
  if (state.charts[id]) {
    state.charts[id].data.labels = data.labels;
    state.charts[id].data.datasets = data.datasets;
    state.charts[id].update();
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

