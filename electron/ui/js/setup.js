// First-run readiness checks and the guided auto-setup flow.
(function () {
  'use strict';
  const { els, t, state } = window.App;

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
      { label: t('ui.setup.ffmpeg'), ok: r.hasFFmpeg, state: t(r.hasFFmpeg ? 'ui.setup.installed' : r.ffmpegBroken ? 'ui.setup.broken' : 'ui.setup.missing') },
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
      const stateEl = document.createElement('span');
      stateEl.className = 'check-state';
      stateEl.textContent = row.state;
      li.appendChild(icon);
      li.appendChild(label);
      li.appendChild(stateEl);
      els.setupChecklist.appendChild(li);
    }

    els.setup.classList.toggle('hidden', !anyProblem);
    updateStartButton();
    if (window.App.stream) window.App.stream.renderReadyPill(canStart);
  }

  function updateStartButton() {
    if (state.streaming) return;
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

  window.App.setup = {
    renderReadiness,
    checkReadiness,
    updateStartButton,
    getLastReadiness: () => lastReadiness,
    getCanStart: () => canStart,
  };
})();
