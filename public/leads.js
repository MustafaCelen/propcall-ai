// PropCall AI / RLM — Adaylar (Leads) Kanban panosu. Faz 1: manuel CRUD + sürükle-bırak
// aşama değişimi + aktivite geçmişi. app.js'in $/$$ helper'larını ve ui-kit.js'in
// toast/uiConfirm'ünü kullanır — bu dosya app.js'ten SONRA yüklenmelidir.

// CRM Faz 2: 6 aşamalı emlak hunisi (bkz. src/types.ts LEAD_STAGES). Eski kodlar
// (QUALIFIED/VIEWING/OFFER) sunucuda yeni koda çevrilir; burada sadece etiket için tutulur.
const LEAD_STAGES = ['NEW', 'CONTACTED', 'MEETING', 'AGREEMENT', 'WON', 'LOST'];
const LEAD_STAGE_LABELS = {
  NEW: 'Yeni', CONTACTED: 'Temas kuruldu', MEETING: 'Randevu', AGREEMENT: 'Yetki / Anlaşma',
  WON: 'Kapandı', LOST: 'Kayıp',
  QUALIFIED: 'Randevu', VIEWING: 'Randevu', OFFER: 'Yetki / Anlaşma',
};
const DEAL_TYPE_LABELS = { SELLER: 'Satıcı', BUYER: 'Alıcı', RENTAL: 'Kiralama' };
const AUTHORITY_LABELS = { EXCLUSIVE: 'Tek yetki', OPEN: 'Açık yetki', NONE: 'Yetki yok' };
const LOST_REASON_LABELS = {
  PRICE: 'Fiyat uyuşmadı', OTHER_AGENT: 'Başka danışmanla çalıştı', GAVE_UP: 'Satış / alımdan vazgeçti',
  UNREACHABLE: 'Ulaşılamadı', NOT_INTERESTED: 'İlgilenmiyor', OTHER: 'Diğer',
};
window.LEAD_STAGE_LABELS = LEAD_STAGE_LABELS;
const LEAD_SOURCE_LABELS = {
  MANUAL: 'Manuel', META_LEAD_AD: 'Meta Lead Ad', CSV_IMPORT: 'CSV',
  CALL_CAMPAIGN: 'Arama Sonucu', REFERRAL: 'Referans', OTHER: 'Diğer',
};
const LEAD_ACTIVITY_LABELS = {
  STAGE_CHANGE: 'Aşama değişti', NOTE: 'Not eklendi', CALL_COMPLETED: 'Arama tamamlandı',
  ASSIGNED: 'Atandı', MESSAGE_SENT: 'Mesaj gönderildi', MESSAGE_RECEIVED: 'Mesaj alındı',
  WHATSAPP_ANALYZED: 'Yazışma analiz edildi',
};

const leadsState = {
  leads: [], openId: null, draggedId: null,
  view: 'kanban', // 'kanban' | 'list'
  selectedIds: new Set(),
  filters: { stage: '', source: '', region: '', tag: '', neverContacted: false, dealType: '', q: '' },
};

function parseTagsInput(raw) {
  return [...new Set((raw || '').split(',').map(t => t.trim()).filter(Boolean))];
}

function leadFullName(lead) {
  return [lead.firstName, lead.lastName].filter(Boolean).join(' ') || '(isimsiz)';
}

// "3+1 daire · Bahçelievler · 120 m² · 5,2 mn" — dolu olan alanlar, kısa.
function fmtPrice(n) {
  if (n == null || n === '') return '';
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  if (v >= 1e6) return (v / 1e6).toLocaleString('tr-TR', { maximumFractionDigits: 1 }) + ' mn';
  if (v >= 1e3) return Math.round(v / 1e3).toLocaleString('tr-TR') + ' bin';
  return v.toLocaleString('tr-TR');
}
function leadPropertyLine(lead) {
  return [
    lead.propertyType, lead.propertyLocation,
    lead.propertyM2 ? lead.propertyM2 + ' m²' : '',
    fmtPrice(lead.priceExpectation),
  ].filter(Boolean).join(' · ');
}
function dealChip(lead) {
  if (!lead.dealType) return '';
  return `<span class="deal-chip ${lead.dealType.toLowerCase()}">${DEAL_TYPE_LABELS[lead.dealType] || lead.dealType}</span>`;
}

// Genel (herhangi bir metin) + fırsat tipi filtresi — hem pano hem liste bunu kullanır.
function baseFilteredLeads() {
  const f = leadsState.filters;
  const q = (f.q || '').trim().toLowerCase();
  return leadsState.leads.filter(l => {
    if (f.dealType && l.dealType !== f.dealType) return false;
    if (q) {
      const hay = [leadFullName(l), l.phone, l.propertyLocation, l.propertyType, l.region, (l.tags || []).join(' ')]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function leadRelativeTime(iso) {
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return 'az önce';
  if (diffMin < 60) return diffMin + ' dk önce';
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return diffH + ' sa önce';
  return Math.round(diffH / 24) + ' gün önce';
}

async function loadLeads() {
  const board = $('leadsBoard');
  try {
    const r = await fetch('/api/leads');
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Adaylar yüklenemedi');
    leadsState.leads = j.data;
    renderLeadsView();
  } catch (err) {
    board.innerHTML = `<div class="drawer-error">✗ ${err.message}</div>`;
  }
}

function renderLeadsView() {
  if (leadsState.view === 'list') renderLeadsList();
  else renderLeadsBoard();
}

function setLeadsView(view) {
  leadsState.view = view;
  $('leadsBoard').style.display = view === 'kanban' ? 'grid' : 'none';
  $('leadsListWrap').style.display = view === 'list' ? 'block' : 'none';
  $('btnLeadsViewKanban').classList.toggle('active', view === 'kanban');
  $('btnLeadsViewList').classList.toggle('active', view === 'list');
  renderLeadsView();
}

// Not: "Hiç aranmamış" burada sadece bir İSTEMCİ TARAFI ön-izleme sezgisi —
// gerçek CALL_COMPLETED aktivite kaydına bakmıyor (o veri bu listede yok),
// sadece source'un arama kaynaklı olmadığını ve hiç linkedCallId'si olmadığını
// kontrol ediyor. Kesin/doğru kural Faz 4'te backend'de (querySegment,
// lead_activities'e karşı SQL) uygulanacak — bu sadece hızlı bir filtre.
function leadLooksNeverContacted(lead) {
  return lead.source !== 'CALL_CAMPAIGN' && !lead.linkedCallId;
}

function filteredLeads() {
  const f = leadsState.filters;
  return baseFilteredLeads().filter(l => {
    if (f.stage && l.stage !== f.stage) return false;
    if (f.source && l.source !== f.source) return false;
    if (f.region && !(l.region || '').toLowerCase().includes(f.region.toLowerCase())) return false;
    if (f.tag && !(l.tags || []).some(t => t.toLowerCase().includes(f.tag.toLowerCase()))) return false;
    if (f.neverContacted && !leadLooksNeverContacted(l)) return false;
    return true;
  });
}

function renderLeadsList() {
  const wrap = $('leadsListWrap');
  const leads = filteredLeads();

  wrap.querySelector('#leadsListBody').innerHTML = leads.length
    ? leads.map(l => `
      <tr class="leads-list-row${leadsState.selectedIds.has(l.id) ? ' selected' : ''}" data-lead-id="${l.id}">
        <td><input type="checkbox" class="lead-select-checkbox" data-lead-id="${l.id}" ${leadsState.selectedIds.has(l.id) ? 'checked' : ''} /></td>
        <td class="leads-list-name">${esc(leadFullName(l))}</td>
        <td>${esc(l.phone || '—')}</td>
        <td>${dealChip(l) || '—'}</td>
        <td><span class="lead-stage-tag s-${l.stage}">${LEAD_STAGE_LABELS[l.stage] || l.stage}</span></td>
        <td class="leads-list-prop">${esc(leadPropertyLine(l) || l.region || '—')}</td>
        <td>${LEAD_SOURCE_LABELS[l.source] || l.source}</td>
        <td>${(l.tags || []).length ? l.tags.map(t => `<span class="lead-tag-chip">${esc(t)}</span>`).join(' ') : '—'}</td>
        <td>${leadRelativeTime(l.updatedAt)}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="9" class="lead-column-empty">Filtreye uyan kişi yok</td></tr>';

  wrap.querySelectorAll('.lead-select-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) leadsState.selectedIds.add(cb.dataset.leadId);
      else leadsState.selectedIds.delete(cb.dataset.leadId);
      cb.closest('tr').classList.toggle('selected', cb.checked);
      renderLeadsSelectionBar();
    });
  });
  wrap.querySelectorAll('.leads-list-row .leads-list-name').forEach(td => {
    td.addEventListener('click', () => openLeadDrawer(td.closest('tr').dataset.leadId));
  });

  const selectAllCb = $('leadsSelectAll');
  if (selectAllCb) {
    selectAllCb.checked = leads.length > 0 && leads.every(l => leadsState.selectedIds.has(l.id));
  }

  renderLeadsSelectionBar();
}

function renderLeadsSelectionBar() {
  const bar = $('leadsSelectionBar');
  const n = leadsState.selectedIds.size;
  if (n === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  $('leadsSelectionCount').textContent = `${n} aday seçildi`;
}

function toggleSelectAllLeads(checked) {
  const leads = filteredLeads();
  if (checked) leads.forEach(l => leadsState.selectedIds.add(l.id));
  else leads.forEach(l => leadsState.selectedIds.delete(l.id));
  renderLeadsList();
}

async function createCampaignFromSelection() {
  const leadIds = [...leadsState.selectedIds];
  if (!leadIds.length) return;
  try {
    const r = await fetch('/api/leads/to-campaign-contacts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadIds }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Kampanya kişileri hazırlanamadı');
    if (!j.data.length) { toast('Seçilen adayların hiçbirinde telefon numarası yok', 'error'); return; }

    setFocusedCampaign(null);
    campaign.contacts = j.data.map(c => ({ ...c, status: 'bekliyor', vapiCallId: null, result: null }));
    campaign.running = false;
    campaign.paused = false;
    renderImportSummary(campaign.contacts.length, []);
    renderCampaignTable();
    $('btnCampaignStart').disabled = false;
    savePendingCampaignDraft();

    leadsState.selectedIds.clear();
    renderLeadsSelectionBar();

    switchTab('campaign');
    toast(`✓ ${campaign.contacts.length} aday Toplu Arama'ya aktarıldı — kampanyayı buradan yapılandırıp başlatın`, 'success');
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  }
}

function renderLeadsBoard() {
  const board = $('leadsBoard');
  const visible = baseFilteredLeads();
  const summary = $('panoSummary');
  if (summary) {
    const open = visible.filter(l => l.stage !== 'WON' && l.stage !== 'LOST').length;
    summary.textContent = `${visible.length} kişi · ${open} açık fırsat — kartı sürükleyin ya da tıklayıp detaydan ilerletin.`;
  }
  board.innerHTML = LEAD_STAGES.map(stage => {
    const items = visible.filter(l => l.stage === stage);
    return `
      <div class="lead-column s-${stage}" data-stage="${stage}">
        <div class="lead-column-header">
          <span class="lead-column-title">${LEAD_STAGE_LABELS[stage]}</span>
          <span class="lead-column-count">${items.length}</span>
        </div>
        <div class="lead-column-body" data-stage-body="${stage}">
          ${items.length ? items.map(leadCardHtml).join('') : '<div class="lead-column-empty">Boş</div>'}
        </div>
      </div>
    `;
  }).join('');

  board.querySelectorAll('.lead-card').forEach(card => {
    card.addEventListener('dragstart', () => {
      leadsState.draggedId = card.dataset.leadId;
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('click', () => openLeadDrawer(card.dataset.leadId));
  });

  board.querySelectorAll('.lead-column').forEach(col => {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const stage = col.dataset.stage;
      const id = leadsState.draggedId;
      if (!id) return;
      await moveLeadStage(id, stage);
    });
  });
}

function leadCardHtml(lead) {
  const prop = leadPropertyLine(lead);
  const stale = lead.stage !== 'WON' && lead.stage !== 'LOST' && (Date.now() - new Date(lead.updatedAt).getTime()) > 7 * 86400000;
  return `
    <div class="lead-card" draggable="true" data-lead-id="${lead.id}">
      <div class="lead-card-top">
        <div class="lead-card-name">${esc(leadFullName(lead))}</div>
        ${dealChip(lead)}
      </div>
      ${prop ? `<div class="lead-card-prop">${esc(prop)}</div>` : (lead.phone ? `<div class="lead-card-phone">${esc(lead.phone)}</div>` : '')}
      ${lead.stage === 'LOST' && lead.lostReason ? `<div class="lead-card-lost">${esc(LOST_REASON_LABELS[lead.lostReason] || lead.lostReason)}</div>` : ''}
      <div class="lead-card-meta">
        <span class="lead-card-source">${LEAD_SOURCE_LABELS[lead.source] || lead.source}</span>
        <span class="lead-card-time${stale ? ' stale' : ''}" title="${stale ? '7 günden uzun süredir hareket yok' : ''}">${leadRelativeTime(lead.updatedAt)}</span>
      </div>
    </div>
  `;
}

// Aşama değişimi. LOST: neden sorulmadan sunucuya gidilmez (sunucu da 400 döner).
async function moveLeadStage(id, stage, extra) {
  if (stage === 'LOST' && !(extra && extra.lostReason)) { openLostModal(id); return; }
  try {
    const r = await fetch(`/api/leads/${id}/stage`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage, ...(extra || {}) }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Aşama güncellenemedi');
    const idx = leadsState.leads.findIndex(l => l.id === id);
    if (idx !== -1) leadsState.leads[idx] = j.data;
    renderLeadsView();
    if (leadsState.openId === id) openLeadDrawer(id);
    if (typeof loadToday === 'function') loadToday();
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  }
}

// ─── KAYIP NEDENİ MODALI ────────────────────────────────────────────────────
const lostState = { leadId: null, reason: null };

function openLostModal(id) {
  const lead = leadsState.leads.find(l => l.id === id);
  if (!lead) return;
  lostState.leadId = id; lostState.reason = null;
  $('leadLostWho').textContent = leadFullName(lead) + (leadPropertyLine(lead) ? ' · ' + leadPropertyLine(lead) : '');
  $('leadLostReasons').innerHTML = Object.entries(LOST_REASON_LABELS)
    .map(([k, v]) => `<button type="button" class="lost-reason" data-reason="${k}">${v}</button>`).join('');
  $('leadLostReasons').querySelectorAll('.lost-reason').forEach(btn => {
    btn.addEventListener('click', () => {
      lostState.reason = btn.dataset.reason;
      $('leadLostReasons').querySelectorAll('.lost-reason').forEach(b => b.classList.toggle('active', b === btn));
      $('leadLostConfirm').disabled = false;
    });
  });
  $('leadLostNote').value = '';
  $('leadLostConfirm').disabled = true;
  $('leadLostModal').classList.add('open');
  $('leadLostOverlay').classList.add('visible');
}

function closeLostModal() {
  $('leadLostModal').classList.remove('open');
  $('leadLostOverlay').classList.remove('visible');
  lostState.leadId = null; lostState.reason = null;
  // Sürükleyerek LOST'a bırakılıp vazgeçildiyse kart eski sütununa dönsün.
  renderLeadsView();
}

async function confirmLost() {
  if (!lostState.leadId || !lostState.reason) return;
  const id = lostState.leadId;
  const extra = { lostReason: lostState.reason, lostNote: $('leadLostNote').value.trim() || null };
  $('leadLostModal').classList.remove('open');
  $('leadLostOverlay').classList.remove('visible');
  lostState.leadId = null; lostState.reason = null;
  await moveLeadStage(id, 'LOST', extra);
}

// ─── FIRSAT ALANLARI (çekmece) ──────────────────────────────────────────────
async function saveLeadDeal(id) {
  const body = {
    dealType: $('ldDealType').value || null,
    propertyType: $('ldPropType').value.trim() || null,
    propertyLocation: $('ldPropLoc').value.trim() || null,
    propertyM2: $('ldPropM2').value.trim() || null,
    priceExpectation: $('ldPrice').value.trim() || null,
    authority: $('ldAuthority').value || null,
  };
  try {
    const r = await fetch(`/api/leads/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Fırsat kaydedilemedi');
    const idx = leadsState.leads.findIndex(l => l.id === id);
    if (idx !== -1) leadsState.leads[idx] = j.data;
    renderLeadsView();
    toast('✓ Fırsat bilgileri kaydedildi', 'success');
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  }
}

async function saveLeadTags(id, tags) {
  try {
    const r = await fetch(`/api/leads/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Etiket güncellenemedi');
    const idx = leadsState.leads.findIndex(l => l.id === id);
    if (idx !== -1) leadsState.leads[idx] = j.data;
    renderLeadsView();
    if (leadsState.openId === id) openLeadDrawer(id);
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  }
}

function addLeadTag(id) {
  const input = $('leadTagInput');
  const tag = input.value.trim();
  if (!tag) return;
  const lead = leadsState.leads.find(l => l.id === id);
  const tags = [...new Set([...(lead?.tags || []), tag])];
  saveLeadTags(id, tags);
}

function removeLeadTag(id, tag) {
  const lead = leadsState.leads.find(l => l.id === id);
  const tags = (lead?.tags || []).filter(t => t !== tag);
  saveLeadTags(id, tags);
}

// ─── ADAY DETAY DRAWER ──────────────────────────────────────────────────────

async function openLeadDrawer(id) {
  const lead = leadsState.leads.find(l => l.id === id);
  if (!lead) return;
  leadsState.openId = id;

  $('leadDrawerTitle').textContent = leadFullName(lead);
  $('leadDrawerSub').textContent = [lead.phone, lead.email].filter(Boolean).join(' · ') || LEAD_SOURCE_LABELS[lead.source];
  const sel = (v, cur) => v === (cur || '') ? ' selected' : '';
  $('leadDrawerBody').innerHTML = `
    <div class="drawer-section">
      <div class="drawer-section-title">Aşama</div>
      <div class="lead-drawer-actions" id="leadStageButtons">
        ${LEAD_STAGES.map(s => `<button class="lead-drawer-stage-btn${s === lead.stage ? ' active' : ''}" data-stage="${s}">${LEAD_STAGE_LABELS[s]}</button>`).join('')}
      </div>
      ${lead.stage === 'LOST' && lead.lostReason ? `<div class="lead-lost-info">Kayıp nedeni: <b>${esc(LOST_REASON_LABELS[lead.lostReason] || lead.lostReason)}</b>${lead.lostNote ? ' — ' + esc(lead.lostNote) : ''}</div>` : ''}
    </div>
    <div class="drawer-section">
      <div class="drawer-section-title">Fırsat</div>
      <div class="ld-grid">
        <label>Tip
          <select id="ldDealType">
            <option value=""${sel('', lead.dealType)}>—</option>
            ${Object.entries(DEAL_TYPE_LABELS).map(([k, v]) => `<option value="${k}"${sel(k, lead.dealType)}>${v}</option>`).join('')}
          </select>
        </label>
        <label>Yetki
          <select id="ldAuthority">
            <option value=""${sel('', lead.authority)}>—</option>
            ${Object.entries(AUTHORITY_LABELS).map(([k, v]) => `<option value="${k}"${sel(k, lead.authority)}>${v}</option>`).join('')}
          </select>
        </label>
        <label>Mülk tipi<input type="text" id="ldPropType" value="${esc(lead.propertyType || '')}" placeholder="3+1 daire, arsa…" /></label>
        <label>Konum<input type="text" id="ldPropLoc" value="${esc(lead.propertyLocation || '')}" placeholder="Mahalle / site" /></label>
        <label>m²<input type="number" id="ldPropM2" min="0" value="${lead.propertyM2 ?? ''}" /></label>
        <label>Fiyat beklentisi (TL)<input type="number" id="ldPrice" min="0" step="1000" value="${lead.priceExpectation ?? ''}" /></label>
      </div>
      <div class="drawer-actions">
        <button class="btn-save-notes" id="ldDealSave">Fırsatı kaydet</button>
      </div>
    </div>
    <div class="drawer-section">
      <div class="drawer-section-title">Etiketler</div>
      <div class="lead-tag-list" id="leadDrawerTags">
        ${(lead.tags || []).length
          ? lead.tags.map(t => `<span class="lead-tag-chip removable" data-tag="${esc(t)}">${esc(t)} <button class="lead-tag-remove" data-tag="${esc(t)}" title="Kaldır">✕</button></span>`).join('')
          : '<span class="lead-column-empty" style="padding:0">Etiket yok</span>'}
      </div>
      <div class="drawer-actions" style="margin-top:8px">
        <input type="text" id="leadTagInput" placeholder="Yeni etiket..." style="flex:1" />
        <button class="btn-save-notes" id="leadTagAdd">Ekle</button>
      </div>
    </div>
    <div class="drawer-section">
      <div class="drawer-section-title">Not Ekle</div>
      <textarea class="drawer-notes" id="leadNoteInput" rows="3" placeholder="Görüşme notu, hatırlatma..."></textarea>
      <div class="drawer-actions">
        <button class="btn-save-notes" id="leadNoteSave">Notu Kaydet</button>
      </div>
    </div>
    ${lead.phone ? `
    <div class="drawer-section">
      <div class="drawer-section-title">WhatsApp</div>
      <div class="lead-msg-thread" id="leadMsgThread"><div class="drawer-loading">⏳ Yükleniyor...</div></div>
      <div class="drawer-actions" style="margin-top:8px">
        <input type="text" id="leadMsgInput" placeholder="Mesaj yazın..." style="flex:1" />
        <button class="btn-save-notes" id="leadMsgSend">Gönder</button>
      </div>
    </div>` : ''}
    <div class="drawer-section">
      <div class="drawer-section-title">Aktivite Geçmişi</div>
      <div id="leadActivityList"><div class="drawer-loading">⏳ Yükleniyor...</div></div>
    </div>
  `;

  $('leadStageButtons').querySelectorAll('.lead-drawer-stage-btn').forEach(btn => {
    btn.addEventListener('click', () => moveLeadStage(id, btn.dataset.stage));
  });
  $('ldDealSave').addEventListener('click', () => saveLeadDeal(id));
  $('leadTagAdd').addEventListener('click', () => addLeadTag(id));
  $('leadTagInput').addEventListener('keydown', e => { if (e.key === 'Enter') addLeadTag(id); });
  $('leadDrawerTags').querySelectorAll('.lead-tag-remove').forEach(btn => {
    btn.addEventListener('click', () => removeLeadTag(id, btn.dataset.tag));
  });
  $('leadNoteSave').addEventListener('click', () => saveLeadNote(id));
  if (lead.phone) {
    $('leadMsgSend').addEventListener('click', () => sendLeadMessage(id));
    loadLeadMessages(id);
  }

  $('leadDrawer').classList.add('open');
  $('leadDrawerOverlay').classList.add('visible');

  loadLeadActivities(id);
}

async function loadLeadMessages(id) {
  const thread = $('leadMsgThread');
  try {
    const r = await fetch(`/api/leads/${id}/messages`);
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Mesajlar yüklenemedi');
    if (!j.data.length) { thread.innerHTML = '<div class="lead-column-empty">Henüz mesaj yok</div>'; return; }
    thread.innerHTML = j.data.map(m => `
      <div class="lead-msg ${m.direction}">
        <div>${esc(m.body)}</div>
        <div class="lead-msg-time">${leadRelativeTime(m.createdAt)}${m.status === 'FAILED' ? ' · ✗ gönderilemedi' : ''}</div>
      </div>
    `).join('');
    thread.scrollTop = thread.scrollHeight;
  } catch (err) {
    thread.innerHTML = `<div class="drawer-error">✗ ${err.message}</div>`;
  }
}

async function sendLeadMessage(id) {
  const input = $('leadMsgInput');
  const body = input.value.trim();
  if (!body) return;
  try {
    const r = await fetch(`/api/leads/${id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Mesaj gönderilemedi');
    input.value = '';
    loadLeadMessages(id);
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  }
}

async function loadLeadActivities(id) {
  const list = $('leadActivityList');
  try {
    const r = await fetch(`/api/leads/${id}/activities`);
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Aktiviteler yüklenemedi');
    if (!j.data.length) { list.innerHTML = '<div class="lead-column-empty">Henüz aktivite yok</div>'; return; }
    list.innerHTML = j.data.map(a => `
      <div class="lead-activity-item">
        <div>${leadActivitySummary(a)}</div>
        <div class="lead-activity-time">${leadRelativeTime(a.createdAt)}</div>
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<div class="drawer-error">✗ ${err.message}</div>`;
  }
}

function leadActivitySummary(a) {
  if (a.type === 'STAGE_CHANGE') {
    const reason = a.data.lostReason ? ` (${esc(LOST_REASON_LABELS[a.data.lostReason] || a.data.lostReason)}${a.data.lostNote ? ': ' + esc(a.data.lostNote) : ''})` : '';
    return `Aşama → <b>${LEAD_STAGE_LABELS[a.data.to] || a.data.to}</b>${reason}`;
  }
  if (a.type === 'NOTE') return esc(a.data.note || '');
  if (a.type === 'WHATSAPP_ANALYZED') {
    const tag = a.data.qualifies ? '✅ Fırsat' : '— Yeterli ilgi yok';
    return `Yazışma analiz edildi (${esc(a.data.ilgiSeviyesi || '')}, ${tag})${a.data.ozet ? ' — ' + esc(a.data.ozet) : ''}`;
  }
  return LEAD_ACTIVITY_LABELS[a.type] || a.type;
}

async function saveLeadNote(id) {
  const input = $('leadNoteInput');
  const note = input.value.trim();
  if (!note) return;
  try {
    const r = await fetch(`/api/leads/${id}/notes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Not kaydedilemedi');
    input.value = '';
    toast('✓ Not eklendi', 'success');
    loadLeadActivities(id);
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  }
}

function closeLeadDrawer() {
  $('leadDrawer').classList.remove('open');
  $('leadDrawerOverlay').classList.remove('visible');
  leadsState.openId = null;
}

// ─── YENİ ADAY MODAL ────────────────────────────────────────────────────────

const leadFormState = { dealType: null };

function setLeadFormDealType(type) {
  leadFormState.dealType = leadFormState.dealType === type ? null : type;
  $('leadFormDealType').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.deal === leadFormState.dealType));
}

function openLeadFormModal() {
  ['leadFormFirstName', 'leadFormLastName', 'leadFormPhone', 'leadFormEmail', 'leadFormNotes', 'leadFormTags',
   'leadFormPropertyType', 'leadFormPropertyLocation', 'leadFormPropertyM2', 'leadFormPrice'].forEach(id => { $(id).value = ''; });
  leadFormState.dealType = null;
  $('leadFormDealType').querySelectorAll('button').forEach(b => b.classList.remove('active'));
  $('leadFormModal').classList.add('open');
  $('leadFormOverlay').classList.add('visible');
  $('leadFormFirstName').focus();
}

function closeLeadFormModal() {
  $('leadFormModal').classList.remove('open');
  $('leadFormOverlay').classList.remove('visible');
}

async function saveNewLead() {
  const firstName = $('leadFormFirstName').value.trim();
  if (!firstName) { toast('✗ Ad zorunlu', 'error'); return; }
  const body = {
    firstName,
    lastName: $('leadFormLastName').value.trim() || null,
    phone: $('leadFormPhone').value.trim() || null,
    email: $('leadFormEmail').value.trim() || null,
    notes: $('leadFormNotes').value.trim() || null,
    tags: parseTagsInput($('leadFormTags').value),
    dealType: leadFormState.dealType,
    propertyType: $('leadFormPropertyType').value.trim() || null,
    propertyLocation: $('leadFormPropertyLocation').value.trim() || null,
    propertyM2: $('leadFormPropertyM2').value.trim() || null,
    priceExpectation: $('leadFormPrice').value.trim() || null,
  };
  try {
    const r = await fetch('/api/leads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Kişi eklenemedi');
    leadsState.leads.unshift(j.data);
    renderLeadsView();
    closeLeadFormModal();
    toast('✓ Kişi eklendi', 'success');
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('btnAddLead').addEventListener('click', openLeadFormModal);
  $('leadFormCancel').addEventListener('click', closeLeadFormModal);
  $('leadFormOverlay').addEventListener('click', closeLeadFormModal);
  $('leadFormClose').addEventListener('click', closeLeadFormModal);
  $('leadFormSave').addEventListener('click', saveNewLead);
  $('leadFormDealType').querySelectorAll('button').forEach(b => b.addEventListener('click', () => setLeadFormDealType(b.dataset.deal)));

  $('leadLostCancel').addEventListener('click', closeLostModal);
  $('leadLostClose').addEventListener('click', closeLostModal);
  $('leadLostOverlay').addEventListener('click', closeLostModal);
  $('leadLostConfirm').addEventListener('click', confirmLost);

  $('panoDealFilter').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    leadsState.filters.dealType = b.dataset.deal;
    $('panoDealFilter').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    renderLeadsView();
  }));
  $('panoSearch').addEventListener('input', () => { leadsState.filters.q = $('panoSearch').value; renderLeadsView(); });

  $('leadDrawerClose').addEventListener('click', closeLeadDrawer);
  $('leadDrawerOverlay').addEventListener('click', closeLeadDrawer);

  $('btnImportLeads').addEventListener('click', () => $('leadImportFile').click());
  $('leadImportFile').addEventListener('change', onLeadImportFileSelected);
  $('leadImportCancel').addEventListener('click', closeLeadImportModal);
  $('leadImportOverlay').addEventListener('click', closeLeadImportModal);
  $('leadImportClose').addEventListener('click', closeLeadImportModal);

  $('btnLeadsViewKanban').addEventListener('click', () => setLeadsView('kanban'));
  $('btnLeadsViewList').addEventListener('click', () => setLeadsView('list'));
  $('leadsSelectAll').addEventListener('change', e => toggleSelectAllLeads(e.target.checked));
  $('btnCreateCampaignFromSelection').addEventListener('click', createCampaignFromSelection);

  ['leadsFilterStage', 'leadsFilterSource', 'leadsFilterRegion', 'leadsFilterTag'].forEach(id => {
    $(id).addEventListener('input', () => {
      leadsState.filters.stage = $('leadsFilterStage').value;
      leadsState.filters.source = $('leadsFilterSource').value;
      leadsState.filters.region = $('leadsFilterRegion').value;
      leadsState.filters.tag = $('leadsFilterTag').value;
      renderLeadsList();
    });
  });
  $('leadsFilterNeverContacted').addEventListener('change', e => {
    leadsState.filters.neverContacted = e.target.checked;
    renderLeadsList();
  });
});

// ─── ADAY İÇE AKTARMA (CSV/EXCEL) + ÇAKIŞMA ÇÖZÜMÜ ─────────────────────────
// parseSpreadsheetRows (app.js) ile aynı sütun-tespiti/telefon-temizleme mantığını
// kullanır — Toplu Arama'nın CSV yüklemesiyle birebir aynı dosya biçimini kabul eder,
// ama sonuçlar geçici bir kampanya listesine değil KALICI müşteri veritabanına yazılır.
const leadImportState = { newRows: [], conflicts: [], resolutions: [] };

function onLeadImportFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (ev) {
    try {
      const wb   = XLSX.read(ev.target.result, { type: 'array', codepage: 65001 });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (!rows.length) { toast('Dosya boş', 'error'); return; }
      const parsed = parseSpreadsheetRows(rows);
      if (!parsed.phoneColumnFound) {
        toast('⚠️ \'Telefon\' sütunu bulunamadı — 2. sütun telefon numarası olarak varsayıldı.', 'error');
      }
      if (!parsed.rows.length) { toast('Geçerli telefon bulunamadı', 'error'); return; }
      previewLeadImport(parsed.rows, parsed.skipped);
    } catch (err) {
      toast('Dosya okunamadı: ' + err.message, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
  e.target.value = '';
}

async function previewLeadImport(rows, skipped) {
  openLeadImportModal();
  $('leadImportSummary').innerHTML = '<div class="drawer-loading">⏳ Çakışmalar kontrol ediliyor...</div>';
  $('leadImportConflicts').innerHTML = '';
  $('leadImportConfirm').style.display = 'none';
  try {
    const r = await fetch('/api/leads/import/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Önizleme başarısız');

    leadImportState.newRows = j.data.newRows;
    leadImportState.conflicts = j.data.conflicts;
    leadImportState.resolutions = j.data.conflicts.map(c => ({ row: c.row, existingLeadId: c.existingLead.id, action: 'skip' }));

    renderLeadImportSummary(skipped);
  } catch (err) {
    $('leadImportSummary').innerHTML = `<div class="drawer-error">✗ ${err.message}</div>`;
  }
}

function renderLeadImportSummary(skipped) {
  const { newRows, conflicts } = leadImportState;
  const skippedHtml = (skipped && skipped.length)
    ? `<div class="adm-field-hint">${skipped.length} satır dosyadan atlandı (geçersiz/boş/mükerrer telefon)</div>`
    : '';

  $('leadImportSummary').innerHTML = `
    <div class="is-headline">
      <span class="is-ok">✓ ${newRows.length} yeni aday eklenecek</span>
      ${conflicts.length ? `<span class="is-warn-static">⚠️ ${conflicts.length} çakışma bulundu — zaten veritabanınızda var</span>` : ''}
    </div>
    ${skippedHtml}
  `;

  $('leadImportTagsGroup').style.display = (newRows.length || conflicts.length) ? 'block' : 'none';

  if (!conflicts.length) {
    $('leadImportConflicts').innerHTML = '';
    $('leadImportConfirm').style.display = 'inline-block';
    return;
  }

  $('leadImportConflicts').innerHTML = `
    <div class="drawer-section">
      <div class="drawer-section-title">Çakışmalar — her biri için işlem seçin</div>
      <div class="lead-import-bulk-row">
        <span>Tümü:</span>
        <button class="btn-secondary" data-bulk="skip">Atla</button>
        <button class="btn-secondary" data-bulk="update">Güncelle</button>
        <button class="btn-secondary" data-bulk="create-new">Yeni Oluştur</button>
      </div>
      <div class="lead-import-conflict-list" id="leadImportConflictList">
        ${conflicts.map((c, i) => `
          <div class="lead-import-conflict-row" data-idx="${i}">
            <div class="lead-import-conflict-info">
              <b>${esc(c.row.name)}</b> (${esc(c.row.phone)}) — mevcut aday: <b>${esc(leadFullName(c.existingLead))}</b>
            </div>
            <select class="lead-import-action-select" data-idx="${i}">
              <option value="skip" selected>Atla (mevcut aday değişmez)</option>
              <option value="update">Güncelle (yeni bilgilerle üzerine yaz)</option>
              <option value="create-new">Yeni Oluştur (ayrı bir aday olarak ekle)</option>
            </select>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  $('leadImportConflicts').querySelectorAll('[data-bulk]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.bulk;
      leadImportState.resolutions.forEach(res => { res.action = action; });
      $('leadImportConflicts').querySelectorAll('.lead-import-action-select').forEach(sel => { sel.value = action; });
    });
  });
  $('leadImportConflicts').querySelectorAll('.lead-import-action-select').forEach(sel => {
    sel.addEventListener('change', () => {
      leadImportState.resolutions[Number(sel.dataset.idx)].action = sel.value;
    });
  });

  $('leadImportConfirm').style.display = 'inline-block';
}

async function commitLeadImport() {
  const btn = $('leadImportConfirm');
  btn.disabled = true;
  try {
    const r = await fetch('/api/leads/import/commit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        newRows: leadImportState.newRows,
        resolutions: leadImportState.resolutions,
        tags: parseTagsInput($('leadImportTags').value),
      }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'İçe aktarma başarısız');
    toast(`✓ ${j.data.created} yeni, ${j.data.updated} güncellendi, ${j.data.skipped} atlandı`, 'success');
    closeLeadImportModal();
    loadLeads();
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function openLeadImportModal() {
  $('leadImportModal').classList.add('open');
  $('leadImportOverlay').classList.add('visible');
}

function closeLeadImportModal() {
  $('leadImportModal').classList.remove('open');
  $('leadImportOverlay').classList.remove('visible');
  leadImportState.newRows = [];
  leadImportState.conflicts = [];
  leadImportState.resolutions = [];
  $('leadImportTags').value = '';
  $('leadImportTagsGroup').style.display = 'none';
}

document.addEventListener('DOMContentLoaded', () => {
  $('leadImportConfirm').addEventListener('click', commitLeadImport);
});
