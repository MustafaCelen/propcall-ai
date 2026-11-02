// PropCall AI / RLM — Akıllı Plan: belirli gün/saat penceresinde otomatik kampanya
// açıp kapatan zamanlayıcının arayüzü. app.js'in $/scenariosCache'ini, leads.js'in
// leadsState.selectedIds'ini kullanır — bu dosya HER İKİSİNDEN SONRA yüklenmelidir.
// Faz 4: hedef kitle sabit bir seçim (STATIC_LIST) VEYA dinamik bir kural
// (NEVER_CONTACTED, STAGE_STALE, STAGE_EQUALS, SOURCE_EQUALS, TAG_INCLUDES)
// olabilir — dinamik kurallar her plan tetiklendiğinde backend'de taze sorgulanır,
// burada sadece plan oluştururken bir "önizleme" sayısı gösterilir.

const smartPlansState = { plans: [], pendingLeadIds: [] };

async function loadSmartPlans() {
  const list = $('smartPlansList');
  try {
    const r = await fetch('/api/smart-plans');
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Planlar yüklenemedi');
    smartPlansState.plans = j.data;
    renderSmartPlansList();
  } catch (err) {
    list.innerHTML = `<div class="drawer-error">✗ ${err.message}</div>`;
  }
}

const SP_DAY_LABELS = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
const SP_RULE_LABELS = {
  STATIC_LIST: r => `👥 Sabit liste (${r.leadIds.length} kişi)`,
  NEVER_CONTACTED: () => '🆕 Hiç aranmamış kişiler',
  STAGE_STALE: r => `⏳ "${r.stage}" aşamasında ${r.staleDays}+ gündür hareketsiz`,
  STAGE_EQUALS: r => `🏷️ "${r.stage}" aşamasındaki herkes`,
  SOURCE_EQUALS: r => `📥 Kaynak: ${r.source}`,
  TAG_INCLUDES: r => `🏷️ Etiket: ${r.tag}`,
};

function smartPlanRuleLabel(rule) {
  if (!rule || !rule.type) return '—';
  const fn = SP_RULE_LABELS[rule.type];
  return fn ? fn(rule) : rule.type;
}

function renderSmartPlansList() {
  const list = $('smartPlansList');
  if (!smartPlansState.plans.length) {
    list.innerHTML = '<div class="lead-column-empty" style="padding:24px">Henüz akıllı plan yok — "Yeni Plan" ile başlayın.</div>';
    return;
  }
  list.innerHTML = smartPlansState.plans.map(p => {
    const days = [...p.daysOfWeek].sort().map(d => SP_DAY_LABELS[d]).join(', ');
    return `
      <div class="sp-plan-card" data-plan-id="${p.id}">
        <div class="sp-plan-header">
          <span class="sp-plan-name">${esc(p.name)}</span>
          <span class="sp-plan-status${p.status === 'active' ? ' active' : ''}">${p.status === 'active' ? '▶ Aktif' : p.status === 'paused' ? '⏸ Duraklatıldı' : '🗄 Arşivlendi'}</span>
        </div>
        <div class="sp-plan-meta">
          <span>📅 ${days}</span>
          <span>🕐 ${String(p.windowStartHour).padStart(2, '0')}:00–${String(p.windowEndHour).padStart(2, '0')}:00</span>
          <span>${esc(smartPlanRuleLabel(p.segmentRule))}</span>
          <span>📞 ${p.dailyCallCap || 'sınırsız'} arama/gün</span>
          ${p.lastRunDate ? `<span>Son çalışma: ${p.lastRunDate}</span>` : '<span>Henüz çalışmadı</span>'}
        </div>
        <div class="sp-plan-actions">
          <button class="btn-secondary" data-toggle="${p.id}">${p.status === 'active' ? '⏸ Duraklat' : '▶ Aktifleştir'}</button>
          <button class="btn-secondary" data-delete="${p.id}">Sil</button>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', () => toggleSmartPlanStatus(btn.dataset.toggle));
  });
  list.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteSmartPlanConfirm(btn.dataset.delete));
  });
}

async function toggleSmartPlanStatus(id) {
  const plan = smartPlansState.plans.find(p => p.id === id);
  if (!plan) return;
  const newStatus = plan.status === 'active' ? 'paused' : 'active';
  try {
    const r = await fetch(`/api/smart-plans/${id}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Durum güncellenemedi');
    const idx = smartPlansState.plans.findIndex(p => p.id === id);
    smartPlansState.plans[idx] = j.data;
    renderSmartPlansList();
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  }
}

async function deleteSmartPlanConfirm(id) {
  if (!await uiConfirm('Bu akıllı planı silmek istediğinize emin misiniz? Şu an çalışıyorsa mevcut kampanya devam eder, sadece gelecekteki otomatik çalışmalar durur.')) return;
  try {
    const r = await fetch(`/api/smart-plans/${id}`, { method: 'DELETE' });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Silinemedi');
    smartPlansState.plans = smartPlansState.plans.filter(p => p.id !== id);
    renderSmartPlansList();
    toast('✓ Plan silindi', 'success');
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  }
}

// ─── YENİ PLAN MODAL ────────────────────────────────────────────────────────

function openSmartPlanFormModal() {
  // leads.js'in çoklu seçim state'inden — plan formu açılırken en son orada
  // seçilmiş adayları "hedef kitle" olarak alır (Faz 3: sabit liste).
  smartPlansState.pendingLeadIds = (typeof leadsState !== 'undefined') ? [...leadsState.selectedIds] : [];

  $('spFormName').value = '';
  $('spFormDailyCap').value = '';
  $('spFormMaxConcurrent').value = '1';
  $('spFormStartHour').value = '9';
  $('spFormEndHour').value = '18';
  $('spFormDays').querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = ['1', '2', '3', '4', '5'].includes(cb.value);
  });

  const summary = $('spFormSelectionSummary');
  summary.innerHTML = smartPlansState.pendingLeadIds.length
    ? `<span class="is-ok">✓ ${smartPlansState.pendingLeadIds.length} aday seçildi</span>`
    : '<span class="is-warn-static">Henüz seçim yok — Adaylar sekmesine gidip Liste görünümünden aday seçin</span>';

  const scenarioSel = $('spFormScenario');
  scenarioSel.innerHTML = '<option value="">— Varsayılan prompt —</option>';
  (typeof scenariosCache !== 'undefined' ? scenariosCache : []).forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    scenarioSel.appendChild(opt);
  });

  $('spFormRuleType').value = 'STATIC_LIST';
  updateSmartPlanRuleSubfields();
  populateSmartPlanTagOptions();
  $('spSegmentPreviewResult').textContent = '';

  $('spFormModal').classList.add('open');
  $('spFormOverlay').classList.add('visible');
}

// CRM'deki adaylara eklenmiş etiketlerin gerçek listesini gösterir — danışman
// TAG_INCLUDES kuralı için hangi etiketlerin gerçekten var olduğunu görmeden serbest
// metin yazınca, hiçbir adayla eşleşmeyen "hayalet" bir kural oluşturması kolaydı.
async function populateSmartPlanTagOptions() {
  const list = $('spRuleTagOptions');
  list.innerHTML = '';
  try {
    const r = await fetch('/api/leads');
    const j = await r.json();
    if (!j.success) return;
    const tags = [...new Set(j.data.flatMap(l => l.tags || []))].sort();
    list.innerHTML = tags.map(t => `<option value="${esc(t)}"></option>`).join('');
  } catch (_) { /* önizleme özelliği, sessizce atla */ }
}

function closeSmartPlanFormModal() {
  $('spFormModal').classList.remove('open');
  $('spFormOverlay').classList.remove('visible');
}

const SP_RULE_SUBFIELD_IDS = {
  STATIC_LIST: 'spRuleStaticList', NEVER_CONTACTED: null, STAGE_STALE: 'spRuleStageStale',
  STAGE_EQUALS: 'spRuleStageEquals', SOURCE_EQUALS: 'spRuleSourceEquals', TAG_INCLUDES: 'spRuleTagIncludes',
};

function updateSmartPlanRuleSubfields() {
  const selected = $('spFormRuleType').value;
  Object.values(SP_RULE_SUBFIELD_IDS).forEach(id => {
    if (id) $(id).style.display = id === SP_RULE_SUBFIELD_IDS[selected] ? 'block' : 'none';
  });
  $('spSegmentPreviewResult').textContent = '';
}

// Formdaki seçili kural tipine göre backend'in beklediği SegmentRule şeklini üretir.
// STATIC_LIST dışındakiler leads.ts querySegment()'in 5 sabit tipiyle birebir eşleşir.
function buildSegmentRuleFromForm() {
  const type = $('spFormRuleType').value;
  if (type === 'STATIC_LIST') return { type, leadIds: smartPlansState.pendingLeadIds };
  if (type === 'NEVER_CONTACTED') return { type };
  if (type === 'STAGE_STALE') return { type, stage: $('spRuleStaleStage').value, staleDays: Number($('spRuleStaleDays').value) || 30 };
  if (type === 'STAGE_EQUALS') return { type, stage: $('spRuleStage').value };
  if (type === 'SOURCE_EQUALS') return { type, source: $('spRuleSource').value };
  if (type === 'TAG_INCLUDES') return { type, tag: $('spRuleTag').value.trim() };
  return { type: 'STATIC_LIST', leadIds: [] };
}

async function previewSmartPlanSegment() {
  const segmentRule = buildSegmentRuleFromForm();
  if (segmentRule.type === 'TAG_INCLUDES' && !segmentRule.tag) {
    toast('✗ Etiket adı girin', 'error'); return;
  }
  const resultEl = $('spSegmentPreviewResult');
  resultEl.textContent = '⏳ Hesaplanıyor...';
  try {
    const r = await fetch('/api/smart-plans/preview-segment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segmentRule }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Önizleme başarısız');
    resultEl.textContent = `→ ${j.data.count} kişi eşleşiyor`;
  } catch (err) {
    resultEl.textContent = '✗ ' + err.message;
  }
}

async function saveSmartPlan() {
  const name = $('spFormName').value.trim();
  if (!name) { toast('✗ Plan adı zorunlu', 'error'); return; }

  const segmentRule = buildSegmentRuleFromForm();
  if (segmentRule.type === 'STATIC_LIST' && !segmentRule.leadIds.length) {
    toast('✗ Hedef kitle boş — önce Adaylar → Liste görünümünden aday seçin', 'error');
    return;
  }
  if (segmentRule.type === 'TAG_INCLUDES' && !segmentRule.tag) {
    toast('✗ Etiket adı girin', 'error'); return;
  }

  const daysOfWeek = [...$('spFormDays').querySelectorAll('input[type="checkbox"]:checked')].map(cb => Number(cb.value));
  if (!daysOfWeek.length) { toast('✗ En az bir gün seçilmeli', 'error'); return; }

  const startHour = Number($('spFormStartHour').value);
  const endHour = Number($('spFormEndHour').value);
  const scenarioSel = $('spFormScenario');
  const scenarioId = scenarioSel.value || null;
  const scenarioName = scenarioId ? scenarioSel.options[scenarioSel.selectedIndex].textContent : null;

  const body = {
    name,
    scenarioId, scenarioName,
    maxConcurrent: Number($('spFormMaxConcurrent').value) || 1,
    dailyCallCap: Number($('spFormDailyCap').value) || 0,
    daysOfWeek, windowStartHour: startHour, windowEndHour: endHour,
    segmentRule,
  };

  try {
    const r = await fetch('/api/smart-plans', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Plan oluşturulamadı');
    smartPlansState.plans.unshift(j.data);
    renderSmartPlansList();
    closeSmartPlanFormModal();
    toast('✓ Akıllı plan oluşturuldu', 'success');
  } catch (err) {
    toast('✗ ' + err.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('btnAddSmartPlan').addEventListener('click', openSmartPlanFormModal);
  $('spFormCancel').addEventListener('click', closeSmartPlanFormModal);
  $('spFormOverlay').addEventListener('click', closeSmartPlanFormModal);
  $('spFormClose').addEventListener('click', closeSmartPlanFormModal);
  $('spFormSave').addEventListener('click', saveSmartPlan);
  $('spFormRuleType').addEventListener('change', updateSmartPlanRuleSubfields);
  $('btnSpPreviewSegment').addEventListener('click', previewSmartPlanSegment);
});
