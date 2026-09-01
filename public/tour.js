// PropCall AI — Spotlight onboarding tour. Dependency-free, reusable across pages.
// Usage: startTour([{ target: '#id', title, body, placement, onBefore }], { storageKey })
// - target: CSS selector to spotlight (omit for a centered welcome/closing step)
// - onBefore: optional function to run before this step renders (e.g. switch tabs
//   so the target becomes visible) — tour.js itself knows nothing about app navigation
// - storageKey: localStorage key — if already set, startTour() no-ops (won't re-show
//   automatically); pass { force: true } to always show regardless (manual "?" button)
(function () {
  let state = null;

  function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'tour-overlay';
    document.body.appendChild(overlay);
    return overlay;
  }
  function buildPopup() {
    const popup = document.createElement('div');
    popup.className = 'tour-popup';
    document.body.appendChild(popup);
    return popup;
  }

  function positionSpotlight(overlay, targetEl) {
    if (!targetEl) { overlay.classList.add('tour-no-target'); return; }
    overlay.classList.remove('tour-no-target');
    const r = targetEl.getBoundingClientRect();
    const pad = 8;
    overlay.style.setProperty('--tour-x', Math.max(0, r.left - pad) + 'px');
    overlay.style.setProperty('--tour-y', Math.max(0, r.top - pad) + 'px');
    overlay.style.setProperty('--tour-w', (r.width + pad * 2) + 'px');
    overlay.style.setProperty('--tour-h', (r.height + pad * 2) + 'px');
  }

  function positionPopup(popup, targetEl, placement) {
    if (!targetEl) {
      popup.classList.add('tour-popup-center');
      popup.style.top = ''; popup.style.left = '';
      return;
    }
    popup.classList.remove('tour-popup-center');
    const r = targetEl.getBoundingClientRect();
    const pw = popup.offsetWidth, ph = popup.offsetHeight;
    const gap = 16;
    let top, left;
    switch (placement) {
      case 'right': top = r.top + r.height / 2 - ph / 2; left = r.right + gap; break;
      case 'left':  top = r.top + r.height / 2 - ph / 2; left = r.left - pw - gap; break;
      case 'top':   top = r.top - ph - gap; left = r.left + r.width / 2 - pw / 2; break;
      default:      top = r.bottom + gap; left = r.left + r.width / 2 - pw / 2; break; // bottom
    }
    top = Math.max(12, Math.min(top, window.innerHeight - ph - 12));
    left = Math.max(12, Math.min(left, window.innerWidth - pw - 12));
    popup.style.top = top + 'px';
    popup.style.left = left + 'px';
  }

  function render() {
    if (!state) return;
    const { steps, idx, overlay, popup } = state;
    const step = steps[idx];
    if (typeof step.onBefore === 'function') { try { step.onBefore(); } catch (e) {} }

    // İki rAF: onBefore bir tab değiştirdiyse tarayıcının layout'u güncellemesine izin ver.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!state) return;
      const targetEl = step.target ? document.querySelector(step.target) : null;
      positionSpotlight(overlay, targetEl);

      popup.innerHTML =
        '<div class="tour-popup-step">' + (idx + 1) + ' / ' + steps.length + '</div>' +
        '<div class="tour-popup-title">' + step.title + '</div>' +
        '<div class="tour-popup-body">' + step.body + '</div>' +
        '<div class="tour-popup-actions">' +
          '<button class="tour-btn-skip" type="button">Turu Atla</button>' +
          '<div class="tour-popup-nav">' +
            (idx > 0 ? '<button class="tour-btn-prev" type="button">← Geri</button>' : '') +
            '<button class="tour-btn-next" type="button">' + (idx === steps.length - 1 ? 'Bitir ✓' : 'İleri →') + '</button>' +
          '</div>' +
        '</div>';
      popup.querySelector('.tour-btn-skip').addEventListener('click', end);
      popup.querySelector('.tour-btn-next').addEventListener('click', next);
      const prevBtn = popup.querySelector('.tour-btn-prev');
      if (prevBtn) prevBtn.addEventListener('click', prev);

      positionPopup(popup, targetEl, step.placement);
      if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }));
  }

  function next() {
    if (!state) return;
    if (state.idx >= state.steps.length - 1) { end(); return; }
    state.idx++;
    render();
  }
  function prev() {
    if (!state || state.idx <= 0) return;
    state.idx--;
    render();
  }
  function end() {
    if (!state) return;
    if (state.storageKey) localStorage.setItem(state.storageKey, '1');
    state.overlay.remove();
    state.popup.remove();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    state = null;
  }
  function onKey(e) {
    if (!state) return;
    if (e.key === 'Escape') end();
    else if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') prev();
  }
  function onResize() { if (state) render(); }

  window.startTour = function (steps, opts) {
    opts = opts || {};
    if (!steps || !steps.length) return;
    if (opts.storageKey && !opts.force && localStorage.getItem(opts.storageKey)) return;
    if (state) end();
    const overlay = buildOverlay();
    const popup = buildPopup();
    state = { steps: steps, idx: 0, overlay: overlay, popup: popup, storageKey: opts.storageKey };
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    render();
  };

  // "?" yardım butonu her zaman force:true ile çağırır — daha önce görülmüş olsa bile tekrar açar.
  window.resetTour = function (storageKey) {
    if (storageKey) localStorage.removeItem(storageKey);
  };
})();
