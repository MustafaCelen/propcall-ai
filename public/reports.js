// PropCall AI — CRM Faz 4: Huni raporu + Ekip görünümü ("Berrak" dili, today.js ile aynı .td-* sınıfları).
// app.js'in $/esc/toast/switchTab'ını kullanır; today.js'ten sonra yüklenir.
(function () {
  const STAGES = ['NEW', 'CONTACTED', 'MEETING', 'AGREEMENT', 'WON', 'LOST'];
  const STAGE_COLOR = { NEW: 'var(--blue)', CONTACTED: 'var(--orange)', MEETING: '#7c5cbf', AGREEMENT: 'var(--primary)', WON: 'var(--primary)', LOST: 'var(--red)' };
  const funnelState = { days: 30, userId: null, userName: null };

  async function api(url) {
    const r = await fetch(url);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(j.error || ('HTTP ' + r.status));
    return j.data;
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

  // ── Huni ──
  window.loadFunnel = async function loadFunnel() {
    const root = $('funnelRoot');
    if (!root) return;
    try {
      const url = funnelState.userId ? `/api/team/funnel/${funnelState.userId}?days=${funnelState.days}` : `/api/reports/funnel?days=${funnelState.days}`;
      const d = await api(url);
      root.innerHTML = renderFunnel(d);
      root.querySelectorAll('[data-days]').forEach(b => b.addEventListener('click', () => { funnelState.days = Number(b.dataset.days); loadFunnel(); }));
      const back = root.querySelector('[data-back-team]');
      if (back) back.addEventListener('click', () => { funnelState.userId = null; funnelState.userName = null; switchTab('team'); });
    } catch (err) {
      root.innerHTML = '<div class="td-empty">✗ ' + esc(err.message) + '</div>';
    }
  };

  function renderFunnel(d) {
    const labels = d.stageLabels || {};
    const open = STAGES.filter(s => s !== 'WON' && s !== 'LOST').reduce((n, s) => n + (d.now[s] || 0), 0);
    // Dönemde ulaşılan: huni sırası — Yeni = dönemde oluşturulan
    const reached = { NEW: d.created, CONTACTED: d.reached.CONTACTED, MEETING: d.reached.MEETING, AGREEMENT: d.reached.AGREEMENT, WON: d.reached.WON, LOST: d.reached.LOST };
    const max = Math.max(1, ...STAGES.filter(s => s !== 'LOST').map(s => reached[s] || 0));
    const steps = ['NEW', 'CONTACTED', 'MEETING', 'AGREEMENT', 'WON'];
    const chips = [7, 30, 90, 365].map(n => `<button class="${n === d.days ? 'active' : ''}" data-days="${n}">${n === 365 ? '1 yıl' : 'Son ' + n + ' gün'}</button>`).join('');
    const who = funnelState.userName ? `<div class="td-sub">${esc(funnelState.userName)} · <a href="#" data-back-team>← Ekibe dön</a></div>` : '<div class="td-sub">Kişilerin huniden nasıl aktığı, nerede kaybedildiği.</div>';

    const bars = steps.map((s, i) => {
      const n = reached[s] || 0;
      const prev = i ? (reached[steps[i - 1]] || 0) : null;
      const w = Math.max(6, Math.round((n / max) * 100));
      return `<div class="fn-row">
        <div class="fn-lbl"><span class="fn-dot" style="background:${STAGE_COLOR[s]}"></span>${esc(labels[s] || s)}</div>
        <div class="fn-bar"><div class="fn-fill" style="width:${w}%;background:${STAGE_COLOR[s]}"></div><b>${n}</b></div>
        <div class="fn-conv">${prev != null ? (prev ? pct(n, prev) + '%' : '—') : ''}</div>
      </div>`;
    }).join('');

    const lostTotal = d.lostReasons.reduce((n, r) => n + r.count, 0);
    const lost = d.lostReasons.length
      ? d.lostReasons.map(r => `<div class="td-field"><span>${esc(r.label)}</span><b>${r.count} <small class="tl-meta">(${pct(r.count, lostTotal)}%)</small></b></div>`).join('')
      : '<div class="td-empty">Bu dönemde kayıp yok</div>';
    const deals = d.byDealType.length
      ? d.byDealType.map(r => `<div class="td-field"><span>${esc(r.label)}</span><b>${r.open} açık · ${r.won} kapandı · ${r.lost} kayıp</b></div>`).join('')
      : '<div class="td-empty">Henüz kişi yok</div>';
    const SRC = { MANUAL: 'Elle', META_LEAD_AD: 'Meta reklam', CSV_IMPORT: 'Excel/CSV', CALL_CAMPAIGN: 'Arama sonucu', REFERRAL: 'Referans', OTHER: 'Diğer' };
    const src = d.bySource.length
      ? d.bySource.map(r => `<div class="td-field"><span>${esc(SRC[r.code] || r.code)}</span><b>${r.count}</b></div>`).join('')
      : '<div class="td-empty">Bu dönemde yeni kişi yok</div>';

    return `
      <div class="td-top"><div><h2>Huni</h2>${who}</div><div class="pano-seg">${chips}</div></div>
      <div class="td-kpis">
        <div class="td-kpi"><b>${open}</b><span>Açık fırsat (şu an)</span></div>
        <div class="td-kpi"><b>${d.created}</b><span>Yeni kişi (dönem)</span></div>
        <div class="td-kpi"><b>${d.reached.MEETING || 0}</b><span>Randevuya ulaşan</span></div>
        <div class="td-kpi"><b>${d.reached.WON || 0}</b><span>Kapanan <small class="tl-meta">${d.created ? '· %' + pct(d.reached.WON || 0, d.created) : ''}</small></span></div>
      </div>
      <div class="td-cols">
        <div>
          <div class="td-card"><h3>Dönemde aşamaya ulaşan kişi <span>adım dönüşümü</span></h3><div class="fn-wrap">${bars}</div></div>
          <div class="td-card"><h3>Şu an aşamalarda</h3>${STAGES.map(s => `<div class="td-field"><span><span class="fn-dot" style="background:${STAGE_COLOR[s]}"></span> ${esc(labels[s] || s)}</span><b>${d.now[s] || 0}</b></div>`).join('')}</div>
        </div>
        <div>
          <div class="td-card"><h3>Kayıp nedenleri <span>${lostTotal} kişi</span></h3>${lost}</div>
          <div class="td-card"><h3>Fırsat tipine göre</h3>${deals}</div>
          <div class="td-card"><h3>Yeni kişiler nereden geldi</h3>${src}</div>
        </div>
      </div>`;
  }

  // ── Ekip ──
  window.loadTeam = async function loadTeam() {
    const root = $('teamRoot');
    if (!root) return;
    try {
      const rows = await api('/api/team/overview');
      root.innerHTML = renderTeam(rows);
      root.querySelectorAll('[data-user-funnel]').forEach(b => b.addEventListener('click', () => {
        funnelState.userId = b.dataset.userFunnel; funnelState.userName = b.dataset.userName; switchTab('funnel');
      }));
    } catch (err) {
      root.innerHTML = '<div class="td-empty">✗ ' + esc(err.message) + '</div>';
    }
  };

  function relAgo(iso) {
    if (!iso) return 'hiç';
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 60) return m + ' dk önce';
    if (m < 1440) return Math.round(m / 60) + ' sa önce';
    return Math.round(m / 1440) + ' gün önce';
  }

  function renderTeam(rows) {
    const tot = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
    const list = rows.length ? rows.map(r => {
      const stale = r.lastActivityAt && (Date.now() - new Date(r.lastActivityAt).getTime()) > 3 * 86400000;
      return `<div class="tm-row">
        <div class="tm-who"><b>${esc(r.name)}</b><small>${r.role === 'manager' ? 'Yönetici · ' : ''}son hareket <span class="${stale ? 'late' : ''}">${relAgo(r.lastActivityAt)}</span></small></div>
        <div class="tm-stages">${['NEW', 'CONTACTED', 'MEETING', 'AGREEMENT'].map(s => `<span title="${s}" style="border-color:${STAGE_COLOR[s]}">${r.stages[s] || 0}</span>`).join('')}</div>
        <div class="tm-num${r.overdueTasks ? ' warn' : ''}"><b>${r.overdueTasks}</b><small>gecikmiş</small></div>
        <div class="tm-num"><b>${r.meetingsWeek}</b><small>randevu/hafta</small></div>
        <div class="tm-num"><b>${r.calls7d}</b><small>arama/7g</small></div>
        <div class="tm-num"><b>${r.appointments7d}</b><small>randevu alındı/7g</small></div>
        <div class="td-act"><button class="td-ic p" title="Huniyi gör" data-user-funnel="${esc(r.userId)}" data-user-name="${esc(r.name)}">🔻</button></div>
      </div>`;
    }).join('') : '<div class="td-empty">Aktif danışman yok</div>';
    return `
      <div class="td-top"><div><h2>Ekip</h2><div class="td-sub">Ofisteki danışmanların panosu, görevleri ve son 7 gün aktivitesi.</div></div></div>
      <div class="td-kpis">
        <div class="td-kpi"><b>${rows.length}</b><span>Danışman</span></div>
        <div class="td-kpi"><b>${tot('open')}</b><span>Açık fırsat</span></div>
        <div class="td-kpi"><b class="${tot('overdueTasks') ? 'warn' : ''}">${tot('overdueTasks')}</b><span>Gecikmiş görev</span></div>
        <div class="td-kpi"><b>${tot('appointments7d')}</b><span>Randevu alındı (7 gün)</span></div>
      </div>
      <div class="td-card">
        <h3>Danışmanlar <span>Yeni · Temas · Randevu · Yetki</span></h3>
        ${list}
      </div>`;
  }
})();
