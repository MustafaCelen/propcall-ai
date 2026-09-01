// Shared UI primitives used across all pages: toast notifications, confirm/prompt
// dialogs (replace native alert/confirm/prompt with themed modals), and a binder
// for slider fields. Include before any page-specific script.
(function () {
  function ensureToastContainer() {
    let c = document.getElementById('toastContainer');
    if (!c) {
      c = document.createElement('div');
      c.className = 'toast-container';
      c.id = 'toastContainer';
      document.body.appendChild(c);
    }
    return c;
  }

  window.toast = window.toast || function (msg, type) {
    const c = ensureToastContainer();
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = msg;
    c.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 3200);
  };

  function openMiniModal({ title, message, body, confirmLabel, cancelLabel, danger }) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay visible';
      const modal = document.createElement('div');
      modal.className = 'modal modal-sm open';
      modal.innerHTML = `
        <div class="modal-header">
          <div class="modal-title">${title}</div>
          <button class="modal-close" data-mm-close type="button">✕</button>
        </div>
        <div class="modal-body">
          ${message ? `<div class="modal-message">${message}</div>` : ''}
          ${body || ''}
          <div class="modal-actions">
            <button class="btn-modal-cancel" data-mm-cancel type="button">${cancelLabel || 'Vazgeç'}</button>
            <button class="btn-modal-confirm${danger ? ' danger' : ''}" data-mm-confirm type="button">${confirmLabel || 'Tamam'}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      document.body.appendChild(modal);

      function cleanup(result) {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        modal.remove();
        resolve(result);
      }
      function onKey(e) { if (e.key === 'Escape') cleanup(null); }

      modal.querySelector('[data-mm-close]').addEventListener('click', () => cleanup(null));
      modal.querySelector('[data-mm-cancel]').addEventListener('click', () => cleanup(null));
      overlay.addEventListener('click', () => cleanup(null));
      document.addEventListener('keydown', onKey);

      modal.querySelector('[data-mm-confirm]').addEventListener('click', () => {
        const input = modal.querySelector('[data-mm-input]');
        cleanup(input ? input.value : true);
      });
      const firstInput = modal.querySelector('[data-mm-input]');
      if (firstInput) {
        firstInput.focus();
        firstInput.addEventListener('keydown', e => {
          if (e.key === 'Enter') modal.querySelector('[data-mm-confirm]').click();
        });
      }
    });
  }

  // Themed replacement for window.confirm() — resolves true/false.
  window.uiConfirm = function (message, opts) {
    opts = opts || {};
    return openMiniModal({
      title: opts.title || 'Onay',
      message,
      confirmLabel: opts.confirmLabel || 'Evet, devam et',
      cancelLabel: opts.cancelLabel || 'Vazgeç',
      danger: opts.danger,
    }).then(r => r === true);
  };

  // Themed replacement for window.prompt() — resolves the entered string, or null on cancel.
  window.uiPrompt = function (message, opts) {
    opts = opts || {};
    const type = opts.type || 'text';
    const body = `<div class="mini-form-group"><input type="${type}" data-mm-input value="${opts.value != null ? opts.value : ''}" placeholder="${opts.placeholder || ''}"${opts.step ? ` step="${opts.step}"` : ''} /></div>`;
    return openMiniModal({
      title: opts.title || 'Değer Girin',
      message,
      body,
      confirmLabel: opts.confirmLabel || 'Kaydet',
      cancelLabel: opts.cancelLabel || 'Vazgeç',
    });
  };

  // Binds <input type="range" data-slider> to a sibling .field-slider-value label.
  // Call again after programmatically setting .value (e.g. once data loads) to refresh the label.
  window.initSliders = function (root) {
    (root || document).querySelectorAll('input[type="range"][data-slider]').forEach(input => {
      const valueEl = input.parentElement.querySelector('.field-slider-value');
      const suffix = input.dataset.suffix || '';
      const update = () => { if (valueEl) valueEl.textContent = input.value + suffix; };
      if (!input.dataset.sliderBound) {
        input.addEventListener('input', update);
        input.dataset.sliderBound = '1';
      }
      update();
    });
  };
})();
