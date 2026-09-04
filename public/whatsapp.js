// PropCall AI / RLM — WhatsApp şablon yöneticisi + toplu kampanya paneli.
// leads.js gibi app.js'in $/$$ ve ui-kit.js'in toast/uiConfirm'ünü kullanır.

const WA_STAGES = ['NEW', 'CONTACTED', 'QUALIFIED', 'VIEWING', 'OFFER', 'WON', 'LOST'];
const WA_STAGE_LABELS = {
  NEW: 'Yeni', CONTACTED: 'İletişime Geçildi', QUALIFIED: 'Nitelikli',
  VIEWING: 'Gezme', OFFER: 'Teklif', WON: 'Kazanıldı', LOST: 'Kaybedildi',
};

const waState = { templates: [], selectedStages: new Set(), previewedCount: null };

async function loadWhatsappTab() {
  await Promise.all([loadTemplates(), loadCampaignHistoryWa()]);
  renderStageChecks();
}

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
