// PropCall AI — "Bugün" ekranı (CRM Faz 1). Sunucudaki /api/today özetini çizer:
// vadesi gelen görevler, randevular, yanıt bekleyen WhatsApp, dokunulmayan sıcak
// fırsatlar, son kampanyanın sonucu. Görev tamamla/ertele/sil buradan yapılır.
// app.js'in $/esc/toast/switchTab yardımcılarını kullanır (önce yüklenir).

(function () {
  let digest = null;

  function fmtTime(iso) {
    const d = new Date(iso);
    return new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' }).format(d);
  }
  function fmtDay(iso) {
    const d = new Date(iso);
    return new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  }
  function isSameIstanbulDay(iso, offsetDays) {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' });
    const ref = new Date(); ref.setUTCDate(ref.getUTCDate() + (offsetDays || 0));
    return f.format(new Date(iso)) === f.format(ref);
  }
  function relAgo(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    const h = Math.round(ms / 36e5);
    if (h < 1) return 'az önce';
    if (h < 24) return h + ' sa önce';
    return Math.round(h / 24) + ' gün önce';
  }
  function waLink(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits ? 'https://wa.me/' + digits : null;
  }
  function kindIcon(kind) {
    return kind === 'meeting' ? '📍' : kind === 'whatsapp' ? '💬' : kind === 'other' ? '✅' : '📞';
  }
  function sourceLabel(s) {
    return { ai_call: 'AI aramasından', meta: 'Meta lead', whatsapp: 'WhatsApp', manual: 'Elle', system: 'Sistem' }[s] || s;
  }
  function stageLabel(s) {
    return (window.LEAD_STAGE_LABELS_TR && window.LEAD_STAGE_LABELS_TR[s]) ||
      ({ NEW: 'Yeni', CONTACTED: 'Temas kuruldu', MEETING: 'Randevu', AGREEMENT: 'Yetki / Anlaşma', WON: 'Kapandı', LOST: 'Kayıp',
         QUALIFIED: 'Randevu', VIEWING: 'Randevu', OFFER: 'Yetki / Anlaşma' })[s] || s;
  }

  function greeting() {
    const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Istanbul', hour: 'numeric', hour12: false }).format(new Date()));
    const name = String(window.CURRENT_USER_NAME || '').trim().split(' ')[0] || '';
    const g = h < 12 ? 'Günaydın' : h < 18 ? 'İyi günler' : 'İyi akşamlar';
    return name ? g + ' ' + name : g;
  }

  function taskRow(t) {
    const late = t.status === 'open' && new Date(t.dueAt) < new Date() && !isSameIstanbulDay(t.dueAt, 0) ? true
               : t.status === 'open' && new Date(t.dueAt) < new Date();
    const when = isSameIstanbulDay(t.dueAt, 0) ? fmtTime(t.dueAt) : fmtDay(t.dueAt);
    const pill = t.kind === 'meeting' ? '<span class="td-pill ok">randevu</span>'
               : late ? '<span class="td-pill late">gecikti</span>'
               : t.source === 'meta' ? '<span class="td-pill i">yeni</span>'
               : t.source === 'ai_call' ? '<span class="td-pill hot">sıcak</span>' : '';
    const wa = waLink(t.leadPhone);
    return '<div class="td-row' + (t.status === 'done' ? ' done' : '') + '" data-id="' + esc(t.id) + '">' +
      '<span class="td-t' + (late ? ' late' : '') + '">' + esc(when) + '</span>' +
      '<div class="td-nm">' + kindIcon(t.kind) + ' ' + esc(t.leadName || t.title) +
        '<small>' + [t.leadName ? t.title : '', t.leadStage ? stageLabel(t.leadStage) : '', t.note || '', sourceLabel(t.source)]
          .filter(Boolean).map(esc).join(' · ') + '</small></div>' +
      '<div class="td-act">' + pill +
        (t.leadPhone ? '<button class="td-ic p" data-act="call" title="Ara">📞</button>' : '') +
        (wa ? '<a class="td-ic" href="' + wa + '" target="_blank" rel="noopener" title="WhatsApp">💬</a>' : '') +
        (t.status === 'open' ? '<button class="td-ic" data-act="done" title="Tamamlandı">✓</button>' : '') +
        '<div class="td-menu"><button class="td-ic" data-act="menu" title="Diğer">⋯</button>' +
          '<div class="td-menu-pop">' +
            '<button data-act="snooze" data-days="0">Bu akşama ertele</button>' +
            '<button data-act="snooze" data-days="1">Yarına ertele</button>' +
            '<button data-act="snooze" data-days="2">2 gün sonraya</button>' +
            '<button data-act="snooze" data-days="7">Haftaya</button>' +
            (t.leadId ? '<button data-act="open-lead">Kişi kartını aç</button>' : '') +
            '<button data-act="delete" class="danger">Görevi sil</button>' +
          '</div></div>' +
      '</div></div>';
  }

  function render() {
    const root = $('todayRoot');
    if (!root) return;
    const d = digest;
    const c = d.counts;
    const dueTasks = d.tasks;
    const lc = d.lastCampaign;

    root.innerHTML =
      '<div class="td-top"><div><h2>' + esc(greeting()) + '</h2><div class="td-sub">' + esc(d.dateLabel) + ' · ' +
        (dueTasks.length ? dueTasks.length + ' görev' : 'görev yok') + ', ' + c.meetings + ' randevu, ' + c.awaitingWhatsapp + ' cevapsız mesaj</div></div>' +
        '<div class="td-actions"><button class="td-btn ghost" data-go="campaign">Liste yükle</button><button class="td-btn" data-go="campaign">Kampanya başlat</button></div></div>' +
      '<div class="td-kpis">' +
        '<button class="td-kpi" data-go="#tasks"><b' + (c.overdue ? ' class="warn"' : '') + '>' + dueTasks.length + '</b><span>Bugün aranacak' + (c.overdue ? ' · ' + c.overdue + ' gecikmiş' : '') + '</span></button>' +
        '<button class="td-kpi" data-go="#meetings"><b>' + c.meetings + '</b><span>Randevu (7 gün)</span></button>' +
        '<button class="td-kpi" data-go="whatsapp"><b>' + c.awaitingWhatsapp + '</b><span>Yanıt bekleyen WhatsApp</span></button>' +
        '<button class="td-kpi" data-go="#hot"><b>' + c.untouchedHot + '</b><span>48 saattir dokunulmayan sıcak fırsat</span></button>' +
      '</div>' +
      '<div class="td-cols"><div>' +
        '<div class="td-card" id="tasks"><h3>Sıradaki görevler <span>vadesi gelenler önce</span></h3>' +
          (dueTasks.length ? dueTasks.map(taskRow).join('') : '<div class="td-empty">Bugün için görev yok. AI aramaları ve Meta lead\'ler buraya otomatik düşer.</div>') +
          '<form class="td-add" id="todayAddForm"><input type="text" id="todayAddTitle" placeholder="Yeni görev… (örn. Selim Bey\'i ara)" required />' +
          '<input type="datetime-local" id="todayAddDue" /><button type="submit" class="td-btn">Ekle</button></form>' +
        '</div>' +
        '<div class="td-card" id="meetings"><h3>Randevular <span>önümüzdeki 7 gün</span></h3>' +
          (d.meetings.length ? d.meetings.map(taskRow).join('') : '<div class="td-empty">Randevu yok.</div>') +
        '</div>' +
      '</div><div>' +
        (lc ? '<div class="td-card"><h3>Son kampanya <span>' + esc(lc.name) + '</span></h3>' +
          '<div class="td-field"><span>Arandı</span><b>' + lc.total + '</b></div>' +
          '<div class="td-field"><span>Ulaşıldı</span><b>' + lc.reached + '</b></div>' +
          '<div class="td-field"><span>İlgi orta/yüksek</span><b>' + lc.hot + '</b></div>' +
          '<div class="td-field"><span>Randevu</span><b>' + lc.appointments + '</b></div>' +
          '<div class="td-field"><span>Aranmak istemiyor</span><b>' + lc.dnc + '</b></div>' +
          '<div style="padding:10px 16px"><button class="td-btn ghost" data-go="campaignHistory">Kampanya detayı</button></div>' +
        '</div>' : '') +
        '<div class="td-card"><h3>Yanıt bekleyen WhatsApp</h3>' +
          (d.awaitingWhatsapp.length ? d.awaitingWhatsapp.map(w =>
            '<div class="td-row" style="grid-template-columns:minmax(0,1fr) auto"><div class="td-nm">' + esc(w.name) + '<small>"' + esc(w.body) + '" · ' + esc(relAgo(w.at)) + '</small></div>' +
            '<div class="td-act"><button class="td-ic" data-go="whatsapp" title="Yanıtla">💬</button></div></div>').join('')
          : '<div class="td-empty">Bekleyen mesaj yok.</div>') +
        '</div>' +
        '<div class="td-card" id="hot"><h3>Dokunulmayan sıcak fırsatlar <span>48 saat+</span></h3>' +
          (d.untouchedHot.length ? d.untouchedHot.map(h =>
            '<div class="td-row" style="grid-template-columns:minmax(0,1fr) auto" data-lead="' + esc(h.leadId) + '"><div class="td-nm">' + esc(h.name) + '<small>' + esc(stageLabel(h.stage)) + ' · son hareket ' + esc(relAgo(h.updatedAt)) + '</small></div>' +
            '<div class="td-act">' + (h.phone ? '<button class="td-ic p" data-act="call-lead" data-phone="' + esc(h.phone) + '" data-name="' + esc(h.name) + '" title="Ara">📞</button>' : '') +
            '<button class="td-ic" data-act="task-lead" data-lead="' + esc(h.leadId) + '" data-name="' + esc(h.name) + '" title="Görev ekle">＋</button></div></div>').join('')
          : '<div class="td-empty">Her sıcak fırsatın bir sonraki adımı var. 👍</div>') +
        '</div>' +
      '</div></div>';

    const badge = $('todayBadge');
    if (badge) { badge.textContent = String(dueTasks.length); badge.style.display = dueTasks.length ? '' : 'none'; }
  }

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(j.error || ('HTTP ' + r.status));
    return j.data;
  }

  function istanbulLocalAt(daysAhead, hour) {
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const d = new Date(ymd + 'T00:00:00+03:00');
    d.setUTCDate(d.getUTCDate() + daysAhead);
    d.setUTCHours(d.getUTCHours() + hour);
    return d;
  }

  function prefillCall(name, phone) {
    if ($('customerName')) $('customerName').value = name || '';
    if ($('customerPhone')) $('customerPhone').value = phone || '';
    switchTab('live');
  }

  async function onClick(e) {
    const go = e.target.closest('[data-go]');
    if (go) {
      const t = go.dataset.go;
      if (t.startsWith('#')) { const el = document.querySelector(t); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      else switchTab(t);
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) { document.querySelectorAll('.td-menu.open').forEach(m => m.classList.remove('open')); return; }
    const act = btn.dataset.act;
    const row = btn.closest('.td-row');
    const id = row && row.dataset.id;
    const task = id && [...digest.tasks, ...digest.meetings].find(t => t.id === id);

    if (act === 'menu') {
      const m = btn.closest('.td-menu');
      document.querySelectorAll('.td-menu.open').forEach(x => { if (x !== m) x.classList.remove('open'); });
      m.classList.toggle('open');
      return;
    }
    document.querySelectorAll('.td-menu.open').forEach(m => m.classList.remove('open'));

    try {
      if (act === 'call' && task) { prefillCall(task.leadName, task.leadPhone); return; }
      if (act === 'call-lead') { prefillCall(btn.dataset.name, btn.dataset.phone); return; }
      if (act === 'open-lead' && task && task.leadId && typeof openLeadDrawer === 'function') { switchTab('leads'); openLeadDrawer(task.leadId); return; }
      if (act === 'done' && id) { await api('PATCH', '/api/tasks/' + id, { done: true }); toast('✓ Görev tamamlandı', 'success'); }
      if (act === 'snooze' && id) {
        const days = Number(btn.dataset.days);
        const until = days === 0 ? istanbulLocalAt(0, 18) : istanbulLocalAt(days, 10);
        await api('PATCH', '/api/tasks/' + id, { snoozeUntil: until.toISOString() });
        toast('Ertelendi', 'info');
      }
      if (act === 'delete' && id) { await api('DELETE', '/api/tasks/' + id); toast('Görev silindi', 'info'); }
      if (act === 'task-lead') {
        await api('POST', '/api/tasks', { leadId: btn.dataset.lead, title: 'Geri ara', kind: 'call', dueAt: istanbulLocalAt(0, 18).toISOString() });
        toast('Görev eklendi: bugün 18:00', 'success');
      }
      await loadToday();
    } catch (err) { toast('✗ ' + err.message, 'error'); }
  }

  async function onSubmit(e) {
    if (e.target.id !== 'todayAddForm') return;
    e.preventDefault();
    const title = $('todayAddTitle').value.trim();
    const dueRaw = $('todayAddDue').value;
    if (!title) return;
    try {
      await api('POST', '/api/tasks', { title, kind: 'other', dueAt: dueRaw ? new Date(dueRaw).toISOString() : istanbulLocalAt(0, 18).toISOString() });
      toast('Görev eklendi', 'success');
      await loadToday();
    } catch (err) { toast('✗ ' + err.message, 'error'); }
  }

  window.loadToday = async function loadToday() {
    const root = $('todayRoot');
    if (!root) return;
    try {
      digest = await api('GET', '/api/today');
      render();
    } catch (err) {
      root.innerHTML = '<div class="today-loading">Bugün yüklenemedi: ' + esc(err.message) + '</div>';
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    const root = $('todayRoot');
    if (!root) return;
    root.addEventListener('click', onClick);
    root.addEventListener('submit', onSubmit);
  });
})();
