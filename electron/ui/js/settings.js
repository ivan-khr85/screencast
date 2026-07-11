// Settings persistence, device/app lists, quality presets, password gen.
(function () {
  'use strict';
  const { els, t, state } = window.App;

  const SETTINGS_KEY = 'icast:settings';

  // --- Persistence ---

  function saveSettings() {
    const data = {
      port: els.port.value,
      fps: els.fps.value,
      quality: els.quality.value,
      customBitrate: els.bitrate.value,
      maxViewers: els.maxViewers.value,
      audioMode: els.audioMode.value,
      tunnel: els.tunnel.checked,
      turnUrl: els.turnUrl.value,
      turnUser: els.turnUser.value,
      turnPass: els.turnPass.value,
      chat: els.chat.checked,
      debugMenu: els.debugMenu.checked,
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
    if (data.fps && [...els.fps.options].some((o) => o.value === String(data.fps))) {
      els.fps.value = data.fps;
    }
    if (data.maxViewers) els.maxViewers.value = data.maxViewers;
    if (typeof data.tunnel === 'boolean') els.tunnel.checked = data.tunnel;
    if (typeof data.turnUrl === 'string') els.turnUrl.value = data.turnUrl;
    if (typeof data.turnUser === 'string') els.turnUser.value = data.turnUser;
    if (typeof data.turnPass === 'string') els.turnPass.value = data.turnPass;
    if (typeof data.chat === 'boolean') els.chat.checked = data.chat;
    if (typeof data.debugMenu === 'boolean') els.debugMenu.checked = data.debugMenu;
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

  // Viewer debug panel: applies live while streaming (mirrors the chat toggle).
  els.debugMenu.addEventListener('change', () => {
    if (state.streaming) window.api.setDebug(els.debugMenu.checked);
  });

  // --- Quality presets ---

  function updateQualityVisibility() {
    els.bitrateField.classList.toggle('hidden', els.quality.value !== 'custom');
  }
  els.quality.addEventListener('change', updateQualityVisibility);

  // Tunnel means remote viewers: the LAN-max preset floods a typical uplink
  // and inflates viewer latency by seconds. Nudge to the remote preset when
  // the user turns the tunnel on and hasn't picked a quality themselves.
  // The toggle lives outside the #settings form now, so it must persist
  // itself explicitly.
  els.tunnel.addEventListener('change', () => {
    if (els.tunnel.checked && els.quality.value === '100750k') {
      els.quality.value = '12000k';
      updateQualityVisibility();
    }
    saveSettings();
  });

  // --- Password generation (matches the 12-hex-char server format) ---

  els.genPassword.addEventListener('click', () => {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    els.password.value = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    saveSettings();
  });

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

    syncPreview();
  }

  function showThumbFallback() {
    const idx = parseInt(els.screenSelect.value, 10);
    const src = screenSources[idx];
    if (src && src.thumbnail) {
      els.displayThumb.src = src.thumbnail;
      els.displayThumb.classList.remove('hidden');
    } else {
      els.displayThumb.classList.add('hidden');
    }
  }

  // --- Live preview of the selected display ---
  // Capture runs only while it can actually be seen (panel open, window
  // visible, not streaming) so it never competes with FFmpeg for the screen.

  let previewStream = null;
  let previewToken = 0;

  function stopPreview() {
    previewToken++;
    if (previewStream) {
      for (const track of previewStream.getTracks()) track.stop();
      previewStream = null;
    }
    els.displayPreview.srcObject = null;
    els.displayPreview.classList.add('hidden');
  }

  async function startPreview(src) {
    stopPreview();
    const token = previewToken;
    showThumbFallback(); // instant placeholder while the stream warms up
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: src.id,
            maxWidth: 640,
            maxHeight: 400,
            maxFrameRate: 10,
          },
        },
      });
    } catch {
      return; // thumbnail fallback already showing
    }
    if (token !== previewToken) {
      // Display switched / panel closed while getUserMedia was pending.
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    previewStream = stream;
    els.displayPreview.srcObject = stream;
    els.displayPreview.addEventListener('loadedmetadata', function onMeta() {
      els.displayPreview.removeEventListener('loadedmetadata', onMeta);
      if (token !== previewToken) return;
      if (els.displayPreview.videoWidth) {
        els.displayPreview.style.aspectRatio =
          `${els.displayPreview.videoWidth} / ${els.displayPreview.videoHeight}`;
      }
      els.displayPreview.classList.remove('hidden');
      els.displayThumb.classList.add('hidden');
    });
  }

  function syncPreview() {
    const src = screenSources[parseInt(els.screenSelect.value, 10)];
    const wanted =
      !!(src && src.id) &&
      !state.streaming &&
      !els.settings.classList.contains('hidden') &&
      !document.hidden;
    if (!wanted) {
      stopPreview();
      showThumbFallback();
      return;
    }
    startPreview(src);
  }

  els.screenSelect.addEventListener('change', syncPreview);
  document.addEventListener('visibilitychange', syncPreview);

  // --- Audio mode ---

  els.audioMode.addEventListener('change', function () {
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

  window.App.settings = {
    save: saveSettings,
    restore: restoreSettings,
    loadScreenSources,
    loadAudioApps,
    updateQualityVisibility,
    syncPreview,
  };
})();
