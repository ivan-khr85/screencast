// Share modal: open/close and QR code rendering.
(function () {
  'use strict';
  const { els, state } = window.App;

  function renderQR() {
    if (!state.qrVisible || typeof qrcode !== 'function' || !state.lastStatus || !state.lastStatus.url) return;
    const includePwd = els.qrIncludePassword.checked && state.lastStatus.password;
    const content = includePwd ? `${state.lastStatus.url}#${state.lastStatus.password}` : state.lastStatus.url;
    if (content === state.lastQrContent) return;
    state.lastQrContent = content;

    try {
      const qr = qrcode(0, 'M');
      qr.addData(content);
      qr.make();
      const count = qr.getModuleCount();
      const canvas = els.qrCanvas;
      const ctx = canvas.getContext('2d');
      const quiet = 4;
      const cell = Math.floor(canvas.width / (count + quiet * 2));
      const offset = Math.floor((canvas.width - cell * count) / 2);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#000000';
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (qr.isDark(r, c)) {
            ctx.fillRect(offset + c * cell, offset + r * cell, cell, cell);
          }
        }
      }
    } catch (err) {
      console.error('QR render failed:', err);
    }
  }

  function open() {
    els.shareModal.classList.remove('hidden');
    state.qrVisible = true;
    renderQR();
  }

  function close() {
    els.shareModal.classList.add('hidden');
    state.qrVisible = false;
  }

  function isOpen() {
    return !els.shareModal.classList.contains('hidden');
  }

  els.shareOpen.addEventListener('click', open);
  els.shareClose.addEventListener('click', close);
  els.shareModal.addEventListener('click', (e) => {
    if (e.target === els.shareModal) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close();
  });

  els.qrIncludePassword.addEventListener('change', renderQR);

  window.App.share = { open, close, isOpen, renderQR };
})();
