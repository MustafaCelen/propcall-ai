// PropCall AI / RLM — Adaylar (Leads) Kanban panosu. Faz 1: manuel CRUD + sürükle-bırak
// aşama değişimi + aktivite geçmişi. app.js'in $/$$ helper'larını ve ui-kit.js'in
// toast/uiConfirm'ünü kullanır — bu dosya app.js'ten SONRA yüklenmelidir.

const LEAD_STAGES = ['NEW', 'CONTACTED', 'QUALIFIED', 'VIEWING', 'OFFER', 'WON', 'LOST'];
const LEAD_STAGE_LABELS = {
  NEW: 'Yeni', CONTACTED: 'İletişime Geçildi', QUALIFIED: 'Nitelikli',
  VIEWING: 'Gezme', OFFER: 'Teklif', WON: 'Kazanıldı', LOST: 'Kaybedildi',
};
const LEAD_SOURCE_LABELS = {
  MANUAL: 'Manuel', META_LEAD_AD: 'Meta Lead Ad', CSV_IMPORT: 'CSV',
  CALL_CAMPAIGN: 'Arama Sonucu', REFERRAL: 'Referans', OTHER: 'Diğer',
};
const LEAD_ACTIVITY_LABELS = {
  STAGE_CHANGE: 'Aşama değişti', NOTE: 'Not eklendi', CALL_COMPLETED: 'Arama tamamlandı',
  ASSIGNED: 'Atandı', MESSAGE_SENT: 'Mesaj gönderildi', MESSAGE_RECEIVED: 'Mesaj alındı',
};

const leadsState = { leads: [], openId: null, draggedId: null };

function leadFullName(lead) {
  return [lead.firstName, lead.lastName].filter(Boolean).join(' ') || '(isimsiz)';
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
    renderLeadsBoard();
  } catch (err) {
    board.innerHTML = `<div class="drawer-error">✗ ${err.message}</div>`;
  }
}

function renderLeadsBoard() {
  const board = $('leadsBoard');
  board.innerHTML = LEAD_STAGES.map(stage => {
    const items = leadsState.leads.filter(l => l.stage === stage);
    return `
      <div class="lead-column" data-stage="${stage}">
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
  return `
    <div class="lead-card" draggable="true" data-lead-id="${lead.id}">
      <div class="lead-card-name">${esc(leadFullName(lead))}</div>
      ${lead.phone ? `<div class="lead-card-phone">${esc(lead.phone)}</div>` : ''}
      <div class="lead-card-meta">
        <span class="lead-card-source">${LEAD_SOURCE_LABELS[lead.source] || lead.source}</span>
        <span class="lead-card-time">${leadRelativeTime(lead.updatedAt)}</span>
      </div>
    </div>
  `;
}

async function moveLeadStage(id, stage) {
  try {
    const r = await fetch(`/api/leads/${id}/stage`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Aşama güncellenemedi');
    const idx = leadsState.leads.findIndex(l => l.id === id);
    if (idx !== -1) leadsState.leads[idx] = j.data;
    renderLeadsBoard();
    if (leadsState.openId === id) openLeadDrawer(id);
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  }
}

// ─── ADAY DETAY DRAWER ──────────────────────────────────────────────────────

async function openLeadDrawer(id) {
  const lead = leadsState.leads.find(l => l.id === id);
  if (!lead) return;
  leadsState.openId = id;

  $('leadDrawerTitle').textContent = leadFullName(lead);
  $('leadDrawerSub').textContent = [lead.phone, lead.email].filter(Boolean).join(' · ') || LEAD_SOURCE_LABELS[lead.source];
  $('leadDrawerBody').innerHTML = `
    <div class="drawer-section">
      <div class="drawer-section-title">Aşama</div>
      <div class="lead-drawer-actions" id="leadStageButtons">
        ${LEAD_STAGES.map(s => `<button class="lead-drawer-stage-btn${s === lead.stage ? ' active' : ''}" data-stage="${s}">${LEAD_STAGE_LABELS[s]}</button>`).join('')}
      </div>
    </div>
    <div class="drawer-section">
      <div class="drawer-section-title">Not Ekle</div>
      <textarea class="drawer-notes" id="leadNoteInput" rows="3" placeholder="Görüşme notu, hatırlatma..."></textarea>
      <div class="drawer-actions">
        <button class="btn-save-notes" id="leadNoteSave">Notu Kaydet</button>
      </div>
    </div>
    <div class="drawer-section">
      <div class="drawer-section-title">Aktivite Geçmişi</div>
      <div id="leadActivityList"><div class="drawer-loading">⏳ Yükleniyor...</div></div>
    </div>
  `;

  $('leadStageButtons').querySelectorAll('.lead-drawer-stage-btn').forEach(btn => {
    btn.addEventListener('click', () => moveLeadStage(id, btn.dataset.stage));
  });
  $('leadNoteSave').addEventListener('click', () => saveLeadNote(id));

  $('leadDrawer').classList.add('open');
  $('leadDrawerOverlay').classList.add('visible');

  loadLeadActivities(id);
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
  if (a.type === 'STAGE_CHANGE') return `Aşama → <b>${LEAD_STAGE_LABELS[a.data.to] || a.data.to}</b>`;
  if (a.type === 'NOTE') return esc(a.data.note || '');
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

function openLeadFormModal() {
  ['leadFormFirstName', 'leadFormLastName', 'leadFormPhone', 'leadFormEmail', 'leadFormNotes'].forEach(id => { $(id).value = ''; });
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
  };
  try {
    const r = await fetch('/api/leads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Aday eklenemedi');
    leadsState.leads.unshift(j.data);
    renderLeadsBoard();
    closeLeadFormModal();
    toast('✓ Aday eklendi', 'success');
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

  $('leadDrawerClose').addEventListener('click', closeLeadDrawer);
  $('leadDrawerOverlay').addEventListener('click', closeLeadDrawer);
});
