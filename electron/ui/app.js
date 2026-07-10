(function() {
  let streaming = false;
  const SETTINGS_KEY = 'screencast:settings';
  const LANG_KEY = 'screencast:lang';
  const t = (key, opts) => i18next.t(key, opts);

  const els = {
    langSelect: document.getElementById('langSelect'),
    setup: document.getElementById('setup'),
    setupChecklist: document.getElementById('setup-checklist'),
    setupInstall: document.getElementById('setup-install'),
    setupRecheck: document.getElementById('setup-recheck'),
    setupLog: document.getElementById('setup-log'),
    settings: document.getElementById('settings'),
    startBtn: document.getElementById('startBtn'),
    startHint: document.getElementById('start-hint'),
    error: document.getElementById('error'),
    streamInfo: document.getElementById('stream-info'),
    streamWarning: document.getElementById('stream-warning'),
    streamWarningText: document.getElementById('stream-warning-text'),
    streamWarningDismiss: document.getElementById('stream-warning-dismiss'),
    streamUrl: document.getElementById('stream-url'),
    streamPassword: document.getElementById('stream-password'),
    tunnelBadge: document.getElementById('tunnel-badge'),
    viewerCount: document.getElementById('viewer-count'),
    audioNote: document.getElementById('audio-note'),
    audioMode: document.getElementById('audioMode'),
    audioAppField: document.getElementById('audioAppField'),
    audioApp: document.getElementById('audioApp'),
    screenSelect: document.getElementById('screenSelect'),
    displayThumb: document.getElementById('displayThumb'),
    quality: document.getElementById('quality'),
    bitrateField: document.getElementById('bitrateField'),
    bitrate: document.getElementById('bitrate'),
    password: document.getElementById('password'),
    genPassword: document.getElementById('genPassword'),
    port: document.getElementById('port'),
    fps: document.getElementById('fps'),
    maxViewers: document.getElementById('maxViewers'),
    tunnel: document.getElementById('tunnel'),
    tunnelNote: document.getElementById('tunnel-note'),
    chat: document.getElementById('chat'),
    chatLiveToggle: document.getElementById('chat-live-toggle'),
    qrToggle: document.getElementById('qr-toggle'),
    qrBlock: document.getElementById('qr-block'),
    qrCanvas: document.getElementById('qr-canvas'),
    qrIncludePassword: document.getElementById('qr-include-password'),
    chatHeader: document.getElementById('chat-header'),
    chatBody: document.getElementById('chat-body'),
    chatMessages: document.getElementById('chat-messages'),
    chatInput: document.getElementById('chat-input'),
    chatSend: document.getElementById('chat-send'),
    chatUnread: document.getElementById('chat-unread'),
    toast: document.getElementById('toast'),
  };

  // --- Toast ---

  let toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1800);
  }

  // --- Settings persistence ---

  function saveSettings() {
    const data = {
      port: els.port.value,
      fps: els.fps.value,
      quality: els.quality.value,
      customBitrate: els.bitrate.value,
      maxViewers: els.maxViewers.value,
      audioMode: els.audioMode.value,
      tunnel: els.tunnel.checked,
      chat: els.chat.checked,
      screenIndex: els.screenSelect.value,
    };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(data)); } catch {}
  }

  let savedScreenIndex = null;
  function restoreSettings() {
    let data;
    try { data = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch { return; }
    if (!data || typeof data !== 'object') return;
    if (data.port) els.port.value = data.port;
    if (data.fps) els.fps.value = data.fps;
    if (data.maxViewers) els.maxViewers.value = data.maxViewers;
    if (typeof data.tunnel === 'boolean') els.tunnel.checked = data.tunnel;
    if (typeof data.chat === 'boolean') els.chat.checked = data.chat;
    if (data.audioMode && ['system', 'app', 'none'].includes(data.audioMode)) {
      els.audioMode.value = data.audioMode;
    }
    if (data.quality && [...els.quality.options].some((o) => o.value === data.quality)) {
      els.quality.value = data.quality;
    }
    if (data.customBitrate) els.bitrate.value = data.customBitrate;
    if (data.screenIndex != null) savedScreenIndex = String(data.screenIndex);
    updateQualityVisibility();
  }

  els.settings.addEventListener('change', saveSettings);

  // --- Quality presets ---

  function updateQualityVisibility() {
    els.bitrateField.classList.toggle('hidden', els.quality.value !== 'custom');
  }
  els.quality.addEventListener('change', updateQualityVisibility);

  // --- Password generation (matches the 12-hex-char server format) ---

  els.genPassword.addEventListener('click', () => {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    els.password.value = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    saveSettings();
  });

  // --- Readiness / first-run setup ---

  let canStart = true;
  let startBlockReasonKey = '';
  let lastReadiness = null;

  function renderReadiness(r) {
    if (!r) return;
    lastReadiness = r;
    const screenKnown = r.screenRecording !== 'unknown';
    const screenOk = !screenKnown || (r.screenRecording !== 'denied' && r.screenRecording !== 'restricted');

    canStart = r.hasFFmpeg && screenOk;
    startBlockReasonKey = !r.hasFFmpeg
      ? 'ui.start.blockedFfmpeg'
      : !screenOk
        ? 'ui.start.blockedScreen'
        : '';

    // cloudflared is only needed for the public tunnel — never blocks Start
    if (!r.hasCloudflared) {
      els.tunnel.checked = false;
      els.tunnel.disabled = true;
      els.tunnelNote.classList.remove('hidden');
    } else {
      els.tunnel.disabled = false;
      els.tunnelNote.classList.add('hidden');
    }

    const rows = [
      { label: t('ui.setup.ffmpeg'), ok: r.hasFFmpeg, state: t(r.hasFFmpeg ? 'ui.setup.installed' : 'ui.setup.missing') },
    ];
    if (screenKnown) {
      rows.push({
        label: t('ui.setup.screenRecording'),
        ok: screenOk,
        state: t(r.screenRecording === 'granted' ? 'ui.setup.granted'
          : screenOk ? 'ui.setup.willPrompt' : 'ui.setup.denied'),
      });
    }
    rows.push({
      label: t('ui.setup.cloudflared'),
      ok: r.hasCloudflared,
      optional: true,
      state: t(r.hasCloudflared ? 'ui.setup.installed' : 'ui.setup.missingOptional'),
    });

    els.setupChecklist.textContent = '';
    let anyProblem = false;
    for (const row of rows) {
      if (!row.ok) anyProblem = true;
      const li = document.createElement('li');
      li.className = row.ok ? 'ok' : (row.optional ? 'optional-missing' : 'missing');
      const icon = document.createElement('span');
      icon.className = 'check-icon';
      icon.textContent = row.ok ? '✓' : '✗';
      const label = document.createElement('span');
      label.textContent = row.label;
      const state = document.createElement('span');
      state.className = 'check-state';
      state.textContent = row.state;
      li.appendChild(icon);
      li.appendChild(label);
      li.appendChild(state);
      els.setupChecklist.appendChild(li);
    }

    els.setup.classList.toggle('hidden', !anyProblem);
    updateStartButton();
  }

  function updateStartButton() {
    if (streaming) return;
    els.startBtn.disabled = !canStart;
    if (!canStart && startBlockReasonKey) {
      els.startHint.textContent = t(startBlockReasonKey);
      els.startHint.classList.remove('hidden');
    } else {
      els.startHint.classList.add('hidden');
    }
  }

  async function checkReadiness() {
    if (!window.api.checkReadiness) return;
    try {
      renderReadiness(await window.api.checkReadiness());
    } catch {}
  }

  const setupLogLines = [];
  function appendSetupLog(msg) {
    setupLogLines.push(msg);
    while (setupLogLines.length > 50) setupLogLines.shift();
    els.setupLog.textContent = setupLogLines.join('\n');
    els.setupLog.classList.remove('hidden');
    els.setupLog.scrollTop = els.setupLog.scrollHeight;
  }

  window.api.onSetupProgress?.(appendSetupLog);

  els.setupInstall.addEventListener('click', async () => {
    els.setupInstall.disabled = true;
    els.setupInstall.textContent = t('ui.setup.installing');
    try {
      renderReadiness(await window.api.autoSetup());
    } catch (err) {
      appendSetupLog(t('ui.setup.setupFailed', { message: err && err.message ? err.message : err }));
    } finally {
      els.setupInstall.disabled = false;
      els.setupInstall.textContent = t('ui.setup.install');
    }
  });

  els.setupRecheck.addEventListener('click', checkReadiness);

  // --- Displays ---

  let screenSources = [];
  async function loadScreenSources() {
    try {
      screenSources = await window.api.getScreenSources();
    } catch {
      return;
    }
    if (!screenSources.length) return;

    els.screenSelect.textContent = '';
    for (const src of screenSources) {
      const opt = document.createElement('option');
      opt.value = src.index;
      opt.textContent = src.name;
      els.screenSelect.appendChild(opt);
    }
    if (savedScreenIndex != null && screenSources.some((s) => String(s.index) === savedScreenIndex)) {
      els.screenSelect.value = savedScreenIndex;
    }

    updateDisplayThumb();
  }

  function updateDisplayThumb() {
    const idx = parseInt(els.screenSelect.value, 10);
    const src = screenSources[idx];
    if (src && src.thumbnail) {
      els.displayThumb.src = src.thumbnail;
      els.displayThumb.classList.remove('hidden');
    } else {
      els.displayThumb.classList.add('hidden');
    }
  }

  els.screenSelect.addEventListener('change', updateDisplayThumb);

  // --- Audio mode ---

  els.audioMode.addEventListener('change', function() {
    if (this.value === 'app') {
      els.audioAppField.classList.remove('hidden');
      loadAudioApps();
    } else {
      els.audioAppField.classList.add('hidden');
    }
  });

  async function loadAudioApps() {
    els.audioApp.textContent = '';
    const loading = document.createElement('option');
    loading.value = '';
    loading.textContent = t('ui.settings.loading');
    els.audioApp.appendChild(loading);
    const apps = await window.api.listAudioApps();
    els.audioApp.textContent = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = t('ui.settings.selectApp');
    els.audioApp.appendChild(placeholder);
    for (const app of apps) {
      const opt = document.createElement('option');
      opt.value = app.bundleID;
      opt.textContent = app.name;
      els.audioApp.appendChild(opt);
    }
  }

  // --- QR code ---

  let qrVisible = false;
  let lastQrContent = null;
  let lastStatus = null;

  function renderQR() {
    if (!qrVisible || typeof qrcode !== 'function' || !lastStatus || !lastStatus.url) return;
    const includePwd = els.qrIncludePassword.checked && lastStatus.password;
    const content = includePwd ? `${lastStatus.url}#${lastStatus.password}` : lastStatus.url;
    if (content === lastQrContent) return;
    lastQrContent = content;

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

  els.qrToggle.addEventListener('click', () => {
    qrVisible = !qrVisible;
    els.qrBlock.classList.toggle('hidden', !qrVisible);
    els.qrToggle.textContent = t(qrVisible ? 'ui.info.hideQr' : 'ui.info.showQr');
    renderQR();
  });

  els.qrIncludePassword.addEventListener('change', renderQR);

  // --- Host chat ---

  let chatUnreadCount = 0;
  let chatExpanded = false;

  function setChatExpanded(expanded) {
    chatExpanded = expanded;
    els.chatHeader.setAttribute('aria-expanded', String(expanded));
    els.chatBody.classList.toggle('hidden', !expanded);
    if (expanded) {
      chatUnreadCount = 0;
      els.chatUnread.classList.add('hidden');
      els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
      els.chatInput.focus();
    }
  }

  els.chatHeader.addEventListener('click', () => setChatExpanded(!chatExpanded));

  function addChatMessage(sender, message) {
    const el = document.createElement('div');
    el.className = 'chat-msg';
    if (sender === 'Host') el.classList.add('chat-host');
    const s = document.createElement('span');
    s.className = 'chat-sender';
    s.textContent = sender;
    const t = document.createElement('span');
    t.className = 'chat-text';
    t.textContent = message;
    el.appendChild(s);
    el.appendChild(t);
    els.chatMessages.appendChild(el);
    while (els.chatMessages.children.length > 100) {
      els.chatMessages.removeChild(els.chatMessages.firstChild);
    }
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;

    if (!chatExpanded && sender !== 'Host') {
      chatUnreadCount++;
      els.chatUnread.textContent = chatUnreadCount > 9 ? '9+' : String(chatUnreadCount);
      els.chatUnread.classList.remove('hidden');
    }
  }

  window.api.onChatMessage?.((msg) => {
    if (msg && msg.sender && msg.message) addChatMessage(msg.sender, msg.message);
  });

  async function sendChat() {
    const text = els.chatInput.value.trim();
    if (!text || !streaming) return;
    const result = await window.api.sendChatMessage(text);
    if (result && result.success) {
      // #broadcastChat only reaches viewers — echo our own message locally
      addChatMessage('Host', text);
      els.chatInput.value = '';
    }
    els.chatInput.focus();
  }

  els.chatSend.addEventListener('click', sendChat);
  els.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
  });

  // --- Status / UI state ---

  // Text is resolved through i18next at render time — a static map would
  // freeze the badge in whatever language was active at boot.
  const TUNNEL_BADGE_CLS = {
    up: 'up',
    off: 'lan',
    starting: 'lan',
    failed: 'warn',
    down: 'warn',
  };

  let prevRunning = false;
  let prevTunnelStatus = null;

  function updateUI(status) {
    streaming = status.running;
    lastStatus = status;

    if (streaming) {
      if (!prevRunning) {
        // New stream session — reset per-stream chat state
        els.chatMessages.textContent = '';
        chatUnreadCount = 0;
        els.chatUnread.classList.add('hidden');
        lastQrContent = null;
      }

      els.startBtn.textContent = t('ui.start.stop');
      els.startBtn.className = 'btn btn-stop';
      els.startBtn.disabled = false;
      els.startHint.classList.add('hidden');
      els.settings.classList.add('hidden');
      els.setup.classList.add('hidden');
      els.streamInfo.classList.remove('hidden');
      els.error.classList.add('hidden');

      // Non-fatal errors during the stream show as a dismissible warning
      if (status.error) {
        els.streamWarningText.textContent = status.error;
        els.streamWarning.classList.remove('hidden');
      } else {
        els.streamWarning.classList.add('hidden');
      }

      els.streamUrl.textContent = status.url || '';
      els.streamPassword.textContent = status.password || '';
      els.viewerCount.textContent = `${status.viewers} / ${status.maxViewers}`;
      els.chatLiveToggle.checked = status.chatEnabled !== false;

      const badgeKey = TUNNEL_BADGE_CLS[status.tunnelStatus] ? status.tunnelStatus : 'off';
      els.tunnelBadge.className = `tunnel-badge ${TUNNEL_BADGE_CLS[badgeKey]}`;
      els.tunnelBadge.textContent = t('ui.tunnelBadge.' + badgeKey);
      els.tunnelBadge.classList.remove('hidden');
      if (prevTunnelStatus === 'up' && status.tunnelStatus === 'down') {
        showToast(t('ui.toast.tunnelDown'));
      }
      prevTunnelStatus = status.tunnelStatus;

      renderQR();

      els.audioNote.classList.toggle('hidden', !!status.hasAudio);
    } else {
      prevTunnelStatus = null;
      els.settings.classList.remove('hidden');
      els.streamInfo.classList.add('hidden');

      if (status.phase) {
        // Mid-startup — the main process sends a phase code; the key-array
        // fallback covers codes this UI doesn't know about
        els.startBtn.textContent = t(['ui.phase.' + status.phase, 'ui.start.starting']);
        els.startBtn.className = 'btn btn-start';
        els.startBtn.disabled = true;
      } else {
        els.startBtn.textContent = t('ui.start.start');
        els.startBtn.className = 'btn btn-start';
        els.startBtn.disabled = false;
        updateStartButton();
      }

      if (status.error) {
        els.error.textContent = status.error;
        els.error.classList.remove('hidden');
      } else {
        els.error.classList.add('hidden');
      }
    }

    prevRunning = streaming;
  }

  els.streamWarningDismiss.addEventListener('click', () => {
    els.streamWarning.classList.add('hidden');
    window.api.clearError?.();
  });

  // Empty/garbage fields parse to NaN — fall back to defaults.
  // The main process clamps again; this just keeps the UI honest.
  function intOr(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isInteger(n) ? n : fallback;
  }

  async function toggleStream() {
    const btn = els.startBtn;

    if (streaming) {
      btn.disabled = true;
      btn.textContent = t('ui.start.stopping');
      await window.api.stopStream();
    } else {
      const bitrate = els.quality.value === 'custom' ? els.bitrate.value.trim() : els.quality.value;
      if (!/^\d+[kKmM]?$/.test(bitrate)) {
        els.error.textContent = t('ui.start.bitrateInvalid');
        els.error.classList.remove('hidden');
        return;
      }
      els.error.classList.add('hidden');

      btn.disabled = true;
      btn.textContent = t('ui.start.starting');
      saveSettings();

      const audioMode = els.audioMode.value;
      const config = {
        port: intOr(els.port.value, 8080),
        fps: intOr(els.fps.value, 30),
        bitrate: bitrate,
        password: els.password.value,
        maxViewers: intOr(els.maxViewers.value, 5),
        audioMode: audioMode,
        audioAppBundleId: audioMode === 'app' ? els.audioApp.value : undefined,
        tunnel: els.tunnel.checked,
        chat: els.chat.checked,
        screenIndex: els.screenSelect.value,
      };

      const result = await window.api.startStream(config);

      if (!result.success) {
        els.error.textContent = result.error;
        els.error.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = t('ui.start.start');
        updateStartButton();
      }
    }
  }

  function copyField(field, btnEl) {
    let text;
    let label;
    if (field === 'url') {
      text = els.streamUrl.textContent;
      label = t('ui.toast.urlCopied');
    } else if (field === 'link') {
      const url = els.streamUrl.textContent;
      const pwd = els.streamPassword.textContent;
      text = url + '#' + pwd;
      label = t('ui.toast.linkCopied');
    } else {
      text = els.streamPassword.textContent;
      label = t('ui.toast.passwordCopied');
    }
    window.api.copyToClipboard(text);
    showToast(label);
    btnEl.textContent = t('common.copied');
    // Restore from the button's i18n key — a captured string would resurrect
    // stale text if the language changed during the timeout window
    setTimeout(() => { btnEl.textContent = t(btnEl.getAttribute('data-i18n')); }, 1200);
  }

  // CSP blocks inline handlers — bind everything here instead.
  els.startBtn.addEventListener('click', toggleStream);
  els.chatLiveToggle.addEventListener('change', function() {
    window.api.setChat(this.checked);
  });
  for (const btn of document.querySelectorAll('.btn-copy[data-copy]')) {
    btn.addEventListener('click', () => copyField(btn.dataset.copy, btn));
  }

  // --- Language ---

  // Re-render every JS-driven string in the current language; static
  // markup is covered by applyI18n().
  function refreshDynamicText() {
    if (!els.setupInstall.disabled) els.setupInstall.textContent = t('ui.setup.install');
    els.qrToggle.textContent = t(qrVisible ? 'ui.info.hideQr' : 'ui.info.showQr');
    const placeholderOpt = els.audioApp.options[0];
    if (placeholderOpt && placeholderOpt.value === '') {
      placeholderOpt.textContent = t('ui.settings.selectApp');
    }
    if (lastReadiness) renderReadiness(lastReadiness);
    if (lastStatus) updateUI(lastStatus);
    else els.startBtn.textContent = t('ui.start.start');
  }

  els.langSelect.addEventListener('change', async () => {
    const lng = els.langSelect.value === 'uk' ? 'uk' : 'en';
    try { localStorage.setItem(LANG_KEY, lng); } catch {}
    await i18next.changeLanguage(lng);
    applyI18n();
    refreshDynamicText();
  });

  // --- Init ---

  (async () => {
    try {
      const { locale, resources } = await window.api.getI18n();
      await i18next.init({ lng: pickLanguage(locale), fallbackLng: 'en', resources });
      applyI18n();
      els.langSelect.value = i18next.language;
      els.startBtn.textContent = t('ui.start.start');
      els.setupInstall.textContent = t('ui.setup.install');
      els.qrToggle.textContent = t('ui.info.showQr');
    } catch (err) {
      // IPC failure — keep the English markup as-is; t() falls back to keys
      console.error('i18n init failed:', err);
      await i18next.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: {} } } });
    }

    restoreSettings();
    if (els.audioMode.value === 'app') {
      els.audioAppField.classList.remove('hidden');
      loadAudioApps();
    }
    loadScreenSources();
    checkReadiness();
    window.api.getStatus().then(updateUI);
    window.api.onStatusUpdate(updateUI);
  })();
})();
