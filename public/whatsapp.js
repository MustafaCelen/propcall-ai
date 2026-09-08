// PropCall AI / RLM — WhatsApp şablon yöneticisi + toplu kampanya paneli.
// leads.js gibi app.js'in $/$$ ve ui-kit.js'in toast/uiConfirm'ünü kullanır.

const WA_STAGES = ['NEW', 'CONTACTED', 'QUALIFIED', 'VIEWING', 'OFFER', 'WON', 'LOST'];
const WA_STAGE_LABELS = {
  NEW: 'Yeni', CONTACTED: 'İletişime Geçildi', QUALIFIED: 'Nitelikli',
  VIEWING: 'Gezme', OFFER: 'Teklif', WON: 'Kazanıldı', LOST: 'Kaybedildi',
};

const waState = { templates: [], selectedStages: new Set(), previewedCount: null, inbox: [], openLeadId: null, personalConnected: false, replyChannel: 'TWILIO' };

async function loadWhatsappTab() {
  await Promise.all([loadTemplates(), loadCampaignHistoryWa(), loadInbox(), checkPersonalWaAvailable()]);
  renderStageChecks();
}

async function checkPersonalWaAvailable() {
  try {
    const r = await fetch('/api/whatsapp/personal/status');
    const j = await r.json();
    waState.personalConnected = j.success && j.data.status === 'connected';
  } catch (_) { waState.personalConnected = false; }
}

// ─── GELEN KUTUSU (WhatsApp Web tarzı, Twilio + şahsi hep aynı listede) ─────

async function loadInbox() {
  const list = $('waInboxList');
  try {
    const r = await fetch('/api/whatsapp/inbox');
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Gelen kutusu yüklenemedi');
    waState.inbox = j.data;
    renderInboxList();
  } catch (err) {
    list.innerHTML = `<div class="drawer-error">✗ ${err.message}</div>`;
  }
}

function renderInboxList() {
  const list = $('waInboxList');
  if (!waState.inbox.length) { list.innerHTML = '<div class="lead-column-empty" style="padding:20px">Henüz mesaj yok</div>'; return; }
  list.innerHTML = waState.inbox.map(c => `
    <div class="wa-inbox-item${c.leadId === waState.openLeadId ? ' active' : ''}" data-lead-id="${c.leadId}">
      <div class="wa-inbox-item-name">
        <span>${esc([c.firstName, c.lastName].filter(Boolean).join(' ') || c.phone || '(isimsiz)')}</span>
        <span class="wa-inbox-item-channel">${c.lastChannel}</span>
      </div>
      <div class="wa-inbox-item-preview">${c.lastDirection === 'OUT' ? 'Siz: ' : ''}${esc(c.lastMessage)}</div>
    </div>
  `).join('');
  list.querySelectorAll('.wa-inbox-item').forEach(el => {
    el.addEventListener('click', () => openInboxThread(el.dataset.leadId));
  });
}

async function openInboxThread(leadId) {
  waState.openLeadId = leadId;
  renderInboxList();
  const entry = waState.inbox.find(c => c.leadId === leadId);
  const thread = $('waInboxThread');
  thread.innerHTML = `
    <div class="wa-inbox-thread-header">
      <span>${esc([entry?.firstName, entry?.lastName].filter(Boolean).join(' ') || entry?.phone || '')}</span>
      <button class="wa-ignore-toggle${entry?.whatsappIgnored ? ' active' : ''}" id="waIgnoreToggle"
        title="İşaretlenirse bu kişiden gelen mesajlar CRM için hiç analiz edilmez (şahsi/müşteri değil)">
        ${entry?.whatsappIgnored ? '🔕 Şahsi (analiz kapalı)' : '🔕 Şahsi olarak işaretle'}
      </button>
    </div>
    <div class="wa-inbox-thread-body" id="waInboxThreadBody"><div class="drawer-loading">⏳ Yükleniyor...</div></div>
    <div class="wa-inbox-thread-footer">
      ${waState.personalConnected ? `
      <div class="wa-channel-toggle">
        <button class="wa-channel-btn${waState.replyChannel === 'TWILIO' ? ' active' : ''}" data-channel="TWILIO">Twilio</button>
        <button class="wa-channel-btn${waState.replyChannel === 'PERSONAL' ? ' active' : ''}" data-channel="PERSONAL">Şahsi</button>
      </div>` : ''}
      <input type="text" id="waInboxReplyInput" placeholder="Mesaj yazın..." />
      <button class="btn-save-notes" id="waInboxReplySend">Gönder</button>
    </div>
  `;
  thread.querySelectorAll('[data-channel]').forEach(btn => {
    btn.addEventListener('click', () => { waState.replyChannel = btn.dataset.channel; openInboxThread(leadId); });
  });
  $('waInboxReplySend').addEventListener('click', () => sendInboxReply(leadId));
  $('waIgnoreToggle').addEventListener('click', () => toggleWhatsappIgnore(leadId, !entry?.whatsappIgnored));
  await loadInboxThreadMessages(leadId);
}

async function toggleWhatsappIgnore(leadId, whatsappIgnored) {
  try {
    const r = await fetch(`/api/leads/${leadId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ whatsappIgnored }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Güncellenemedi');
    toast(whatsappIgnored ? '🔕 Şahsi olarak işaretlendi — artık CRM analizi çalışmayacak' : '✓ İşaret kaldırıldı', 'success');
    const entry = waState.inbox.find(c => c.leadId === leadId);
    if (entry) entry.whatsappIgnored = whatsappIgnored;
    openInboxThread(leadId);
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  }
}

async function loadInboxThreadMessages(leadId) {
  const body = $('waInboxThreadBody');
  try {
    const r = await fetch(`/api/leads/${leadId}/messages`);
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    body.innerHTML = j.data.length ? j.data.map(m => `
      <div class="lead-msg ${m.direction}">
        <div>${esc(m.body)}</div>
        <div class="lead-msg-time">${leadRelativeTime(m.createdAt)} · ${m.channel}${m.status === 'FAILED' ? ' · ✗' : ''}</div>
      </div>
    `).join('') : '<div class="lead-column-empty">Henüz mesaj yok</div>';
    body.scrollTop = body.scrollHeight;
  } catch (err) {
    body.innerHTML = `<div class="drawer-error">✗ ${err.message}</div>`;
  }
}

async function sendInboxReply(leadId) {
  const input = $('waInboxReplyInput');
  const body = input.value.trim();
  if (!body) return;
  try {
    const r = await fetch(`/api/leads/${leadId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, channel: waState.replyChannel }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Gönderilemedi');
    input.value = '';
    loadInboxThreadMessages(leadId);
    loadInbox();
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('waSubtabs').querySelectorAll('.fu-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      $('waSubtabs').querySelectorAll('.fu-subtab').forEach(b => b.classList.toggle('active', b === btn));
      $('waSubInbox').classList.toggle('active', btn.dataset.wasub === 'inbox');
      $('waSubTemplates').classList.toggle('active', btn.dataset.wasub === 'templates');
    });
  });
});

async function loadTemplates() {
  const box = $('waTemplates');
  try {
    const r = await fetch('/api/whatsapp/templates');
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Şablonlar yüklenemedi');
    waState.templates = j.data;
    renderTemplates();
    renderTemplateSelect();
  } catch (err) {
    box.innerHTML = `<div class="drawer-error">✗ ${err.message}</div>`;
  }
}

function renderTemplates() {
  const box = $('waTemplates');
  if (!waState.templates.length) { box.innerHTML = '<div class="lead-column-empty">Henüz şablon yok</div>'; return; }
  box.innerHTML = waState.templates.map(t => `
    <div class="wa-tpl-card" data-tpl-id="${t.id}">
      <div class="wa-tpl-header">
        <span class="wa-tpl-name">${esc(t.name)}</span>
        <span class="wa-tpl-status ${t.status}">${t.status}</span>
      </div>
      <div class="wa-tpl-body">${esc(t.body)}</div>
      ${t.rejectionReason ? `<div class="drawer-error" style="padding:6px 0">Red sebebi: ${esc(t.rejectionReason)}</div>` : ''}
      <div class="wa-tpl-actions">
        ${t.status === 'DRAFT' ? `<button class="btn-secondary" data-submit="${t.id}">Onaya Gönder</button>` : ''}
        <button class="btn-secondary" data-delete-tpl="${t.id}">Sil</button>
      </div>
    </div>
  `).join('');

  box.querySelectorAll('[data-submit]').forEach(btn => {
    btn.addEventListener('click', () => submitTemplateForApproval(btn.dataset.submit));
  });
  box.querySelectorAll('[data-delete-tpl]').forEach(btn => {
    btn.addEventListener('click', () => deleteTemplateConfirm(btn.dataset.deleteTpl));
  });
}

function renderTemplateSelect() {
  const sel = $('waCampTemplate');
  const approved = waState.templates.filter(t => t.status === 'APPROVED');
  sel.innerHTML = '<option value="">— Onaylanmış şablon seçin —</option>' +
    approved.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
}

async function submitTemplateForApproval(id) {
  try {
    const r = await fetch(`/api/whatsapp/templates/${id}/submit`, { method: 'POST' });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Onaya gönderilemedi');
    toast('✓ Onaya gönderildi', 'success');
    loadTemplates();
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  }
}

async function deleteTemplateConfirm(id) {
  if (!await uiConfirm('Bu şablonu silmek istediğinize emin misiniz?')) return;
  try {
    const r = await fetch(`/api/whatsapp/templates/${id}`, { method: 'DELETE' });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Silinemedi');
    loadTemplates();
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  }
}

function renderStageChecks() {
  const box = $('waStageChecks');
  box.innerHTML = WA_STAGES.map(s => `
    <label class="wa-stage-check"><input type="checkbox" data-stage-check="${s}" /> ${WA_STAGE_LABELS[s]}</label>
  `).join('');
  box.querySelectorAll('[data-stage-check]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) waState.selectedStages.add(cb.dataset.stageCheck);
      else waState.selectedStages.delete(cb.dataset.stageCheck);
    });
  });
}

$('btnWaPreview').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/whatsapp/campaigns/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { stages: [...waState.selectedStages] } }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Önizleme başarısız');
    waState.previewedCount = j.data.count;
    $('waPreviewCount').textContent = `${j.data.count} adaya gönderilecek`;
    $('btnWaSend').disabled = j.data.count === 0;
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  }
});

$('btnWaSend').addEventListener('click', async () => {
  const name = $('waCampName').value.trim();
  const templateId = $('waCampTemplate').value;
  const status = $('waCampStatus');
  if (!name || !templateId) { toast('✗ Kampanya adı ve şablon zorunlu', 'error'); return; }
  if (!await uiConfirm(`${waState.previewedCount ?? '?'} adaya WhatsApp mesajı gönderilecek. Emin misiniz?`, { confirmLabel: 'Evet, gönder' })) return;

  status.textContent = 'Gönderiliyor...'; status.className = 'adm-field-status';
  try {
    const createResp = await fetch('/api/whatsapp/campaigns', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, templateId, filter: { stages: [...waState.selectedStages] }, variableMap: { firstName: 'firstName' } }),
    });
    const created = await createResp.json();
    if (!created.success) throw new Error(created.error);

    const sendResp = await fetch(`/api/whatsapp/campaigns/${created.data.id}/send`, { method: 'POST' });
    const sent = await sendResp.json();
    if (!sent.success) throw new Error(sent.error);

    status.textContent = `✓ ${sent.data.sent} gönderildi, ${sent.data.failed} başarısız`;
    status.className = 'adm-field-status ok';
    $('waCampName').value = '';
    $('btnWaSend').disabled = true;
    $('waPreviewCount').textContent = '';
    loadCampaignHistoryWa();
  } catch (err) {
    status.textContent = '✗ ' + err.message;
    status.className = 'adm-field-status err';
  }
});

async function loadCampaignHistoryWa() {
  const box = $('waCampaignHistory');
  try {
    const r = await fetch('/api/whatsapp/campaigns');
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    if (!j.data.length) { box.innerHTML = '<div class="lead-column-empty">Henüz kampanya yok</div>'; return; }
    box.innerHTML = j.data.map(c => `
      <div class="wa-camp-history-item">
        <b>${esc(c.name)}</b> — ${c.status}${c.completedAt ? ' — ' + new Date(c.completedAt).toLocaleString('tr-TR') : ''}
      </div>
    `).join('');
  } catch (err) {
    box.innerHTML = `<div class="drawer-error">✗ ${err.message}</div>`;
  }
}

// ─── YENİ ŞABLON MODAL ──────────────────────────────────────────────────────

function openTemplateFormModal() {
  $('tplFormName').value = '';
  $('tplFormBody').value = '';
  $('tplFormCategory').value = 'MARKETING';
  $('tplFormModal').classList.add('open');
  $('tplFormOverlay').classList.add('visible');
  $('tplFormName').focus();
}

function closeTemplateFormModal() {
  $('tplFormModal').classList.remove('open');
  $('tplFormOverlay').classList.remove('visible');
}

async function saveNewTemplate() {
  const name = $('tplFormName').value.trim();
  const body = $('tplFormBody').value.trim();
  if (!name || !body) { toast('✗ Ad ve metin zorunlu', 'error'); return; }
  const variables = [...body.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
  try {
    const r = await fetch('/api/whatsapp/templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, category: $('tplFormCategory').value, body, variables }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Şablon eklenemedi');
    closeTemplateFormModal();
    toast('✓ Şablon eklendi', 'success');
    loadTemplates();
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('btnAddTemplate').addEventListener('click', openTemplateFormModal);
  $('tplFormCancel').addEventListener('click', closeTemplateFormModal);
  $('tplFormOverlay').addEventListener('click', closeTemplateFormModal);
  $('tplFormClose').addEventListener('click', closeTemplateFormModal);
  $('tplFormSave').addEventListener('click', saveNewTemplate);
});
