// Shared DOM references, cross-module state and tiny helpers.
// Loaded first; every other module reads window.App.
(function () {
  'use strict';

  const els = {
    // header / language
    langSelect: document.getElementById('langSelect'),
    settingsGear: document.getElementById('settings-gear'),

    // first-run setup
    setup: document.getElementById('setup'),
    setupChecklist: document.getElementById('setup-checklist'),
    setupInstall: document.getElementById('setup-install'),
    setupRecheck: document.getElementById('setup-recheck'),
    setupLog: document.getElementById('setup-log'),

    // idle hero
    readyPill: document.getElementById('ready-pill'),
    readyPillText: document.getElementById('ready-pill-text'),

    // settings
    settings: document.getElementById('settings'),
    advancedToggle: document.getElementById('advanced-toggle'),
    screenSelect: document.getElementById('screenSelect'),
    displayThumb: document.getElementById('displayThumb'),
    displayPreview: document.getElementById('displayPreview'),
    port: document.getElementById('port'),
    fps: document.getElementById('fps'),
    quality: document.getElementById('quality'),
    bitrateField: document.getElementById('bitrateField'),
    bitrate: document.getElementById('bitrate'),
    password: document.getElementById('password'),
    genPassword: document.getElementById('genPassword'),
    maxViewers: document.getElementById('maxViewers'),
    audioMode: document.getElementById('audioMode'),
    audioAppField: document.getElementById('audioAppField'),
    audioApp: document.getElementById('audioApp'),
    tunnel: document.getElementById('tunnel'),
    tunnelNote: document.getElementById('tunnel-note'),
    chat: document.getElementById('chat'),

    // stream controls / status
    startBtn: document.getElementById('startBtn'),
    startHint: document.getElementById('start-hint'),
    error: document.getElementById('error'),
    streamInfo: document.getElementById('stream-info'),
    streamWarning: document.getElementById('stream-warning'),
    streamWarningText: document.getElementById('stream-warning-text'),
    streamWarningDismiss: document.getElementById('stream-warning-dismiss'),
    streamTimer: document.getElementById('stream-timer'),
    streamHealth: document.getElementById('stream-health'),
    viewerCount: document.getElementById('viewer-count'),
    audioNote: document.getElementById('audio-note'),

    // share modal
    shareOpen: document.getElementById('share-open'),
    shareModal: document.getElementById('share-modal'),
    shareClose: document.getElementById('share-close'),
    qrCanvas: document.getElementById('qr-canvas'),
    qrIncludePassword: document.getElementById('qr-include-password'),
    streamUrl: document.getElementById('stream-url'),
    streamPassword: document.getElementById('stream-password'),
    tunnelBadge: document.getElementById('tunnel-badge'),

    // host chat
    chatLiveToggle: document.getElementById('chat-live-toggle'),
    chatHeader: document.getElementById('chat-header'),
    chatBody: document.getElementById('chat-body'),
    chatMessages: document.getElementById('chat-messages'),
    chatInput: document.getElementById('chat-input'),
    chatSend: document.getElementById('chat-send'),
    chatUnread: document.getElementById('chat-unread'),

    toast: document.getElementById('toast'),
  };

  const state = {
    streaming: false,
    lastStatus: null,
    prevRunning: false,
    prevTunnelStatus: null,
    qrVisible: false,
    lastQrContent: null,
  };

  let toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1800);
  }

  window.App = {
    els,
    state,
    showToast,
    show: (el) => el.classList.remove('hidden'),
    hide: (el) => el.classList.add('hidden'),
    // resolved through i18next at call time so language switches take effect
    t: (key, opts) => i18next.t(key, opts),
  };
})();
