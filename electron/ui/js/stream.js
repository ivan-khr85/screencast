// Stream lifecycle: start/stop, status-driven UI state, live stats
// (timer, health, viewers), share fields and copy actions.
(function () {
  'use strict';
  const { els, t, state, showToast } = window.App;

  // Text is resolved through i18next at render time — a static map would
  // freeze the badge in whatever language was active at boot.
  const TUNNEL_BADGE_CLS = {
    up: 'up',
    off: 'lan',
    starting: 'lan',
    failed: 'warn',
    down: 'warn',
  };

  // --- Idle hero pill (readiness-driven) ---

  function renderReadyPill(ok) {
    els.readyPill.classList.toggle('pill-warn', !ok);
    els.readyPillText.textContent = t(ok ? 'ui.hero.ready' : 'ui.hero.actionNeeded');
  }

  // --- Live timer ---

  let timerInterval = null;

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function renderTimer() {
    const s = state.lastStatus;
    if (!s || !s.running || !s.startedAt) {
      els.streamTimer.textContent = '00:00:00';
      return;
    }
    const total = Math.max(0, Math.floor((Date.now() - s.startedAt) / 1000));
    const hh = Math.floor(total / 3600);
    const mm = Math.floor(total / 60) % 60;
    const ss = total % 60;
    els.streamTimer.textContent = `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  }

  function startTimer() {
    renderTimer();
    if (timerInterval == null) {
      timerInterval = setInterval(renderTimer, 1000);
    }
  }

  function stopTimer() {
    if (timerInterval != null) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  // --- Live health ---

  function renderHealth(health) {
    const h = health === 'recovering' || health === 'degraded' ? health : 'good';
    els.streamHealth.className = 'stat-value health-' + h;
    els.streamHealth.textContent = t('ui.health.' + h);
  }

  // --- Status-driven UI ---

  function updateUI(status) {
    state.streaming = status.running;
    state.lastStatus = status;
    document.body.classList.toggle('streaming', !!status.running);

    if (status.running) {
      els.startBtn.textContent = t('ui.start.stop');
      els.startBtn.className = 'btn btn-stop';
      els.startBtn.disabled = false;
      els.startHint.classList.add('hidden');
      els.setup.classList.add('hidden');
      els.streamInfo.classList.remove('hidden');
      els.error.classList.add('hidden');

      if (!state.prevRunning) {
        // New stream session — reset per-stream chat + QR state, and open
        // the chat panel (after #stream-info is visible so focus() lands)
        window.App.chat.resetSession();
        state.lastQrContent = null;
        window.App.chat.setExpanded(true);
      }

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
      els.debugMenu.checked = status.debugEnabled !== false;

      startTimer();
      renderHealth(status.health);

      const badgeKey = TUNNEL_BADGE_CLS[status.tunnelStatus] ? status.tunnelStatus : 'off';
      els.tunnelBadge.className = `tunnel-badge ${TUNNEL_BADGE_CLS[badgeKey]}`;
      els.tunnelBadge.textContent = t('ui.tunnelBadge.' + badgeKey);
      els.tunnelBadge.classList.remove('hidden');
      if (state.prevTunnelStatus === 'up' && status.tunnelStatus === 'down') {
        showToast(t('ui.toast.tunnelDown'));
      }
      state.prevTunnelStatus = status.tunnelStatus;

      window.App.share.renderQR();

      els.audioNote.classList.toggle('hidden', !!status.hasAudio);
    } else {
      state.prevTunnelStatus = null;
      stopTimer();
      els.streamInfo.classList.add('hidden');
      if (window.App.share.isOpen()) window.App.share.close();

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
        window.App.setup.updateStartButton();
      }

      if (status.error) {
        els.error.textContent = status.error;
        els.error.classList.remove('hidden');
      } else {
        els.error.classList.add('hidden');
      }
    }

    state.prevRunning = state.streaming;
    window.App.settings.syncPreview();
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

    if (state.streaming) {
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
      window.App.settings.save();

      const audioMode = els.audioMode.value;
      const config = {
        port: intOr(els.port.value, 8080),
        fps: els.fps.value === 'original' ? 'original' : intOr(els.fps.value, 30),
        bitrate: bitrate,
        password: els.password.value,
        maxViewers: intOr(els.maxViewers.value, 5),
        audioMode: audioMode,
        audioAppBundleId: audioMode === 'app' ? els.audioApp.value : undefined,
        tunnel: els.tunnel.checked,
        chat: els.chat.checked,
        debug: els.debugMenu.checked,
        screenIndex: els.screenSelect.value,
      };

      const result = await window.api.startStream(config);

      if (!result.success) {
        els.error.textContent = result.error;
        els.error.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = t('ui.start.start');
        window.App.setup.updateStartButton();
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
  for (const btn of document.querySelectorAll('.btn-copy[data-copy]')) {
    btn.addEventListener('click', () => copyField(btn.dataset.copy, btn));
  }

  window.App.stream = {
    updateUI,
    renderReadyPill,
    renderTimer,
    renderHealth,
  };
})();
