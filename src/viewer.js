(function() {
  const RECONNECT_DELAYS = [1000, 2000, 4000, 8000];
  const MAX_RECONNECT_ATTEMPTS = 10;
  const PREFS_KEY = 'icast:viewer';
  const LANG_KEY = 'icast:lang';
  const t = (key, opts) => i18next.t(key, opts);

  const authScreen = document.getElementById('auth-screen');
  const playerScreen = document.getElementById('player-screen');
  const video = document.getElementById('video');
  const statusEl = document.getElementById('status');
  const authForm = document.getElementById('auth-form');
  const authSubmit = document.getElementById('auth-submit');
  const passwordInput = document.getElementById('password-input');
  const authError = document.getElementById('auth-error');
  const statsEl = document.getElementById('stream-stats');
  const toastsEl = document.getElementById('error-toasts');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingText = document.getElementById('loading-text');
  const streamOverlay = document.getElementById('stream-overlay');
  const overlayTitle = document.getElementById('overlay-title');
  const overlayMessage = document.getElementById('overlay-message');
  const overlayRetry = document.getElementById('overlay-retry');
  const controls = document.getElementById('controls');
  const audioControls = document.getElementById('audio-controls');
  const volumeSlider = document.getElementById('volume-slider');
  const statsToggle = document.getElementById('stats-toggle');
  const pipToggle = document.getElementById('pip-toggle');
  const fullscreenToggle = document.getElementById('fullscreen-toggle');
  const iconFsEnter = document.getElementById('icon-fs-enter');
  const iconFsExit = document.getElementById('icon-fs-exit');

  let ws = null;
  let pc = null;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let password = '';
  let authenticated = false;
  let streamInfo = { viewers: null, maxViewers: null };
  let streamEnded = false;

  let isMuted = true; // Start muted (browser autoplay policy)
  let hasAudio = false;

  // Persisted viewer preferences (volume + stats overlay visibility)
  let volume = 1;
  let statsVisible = false;
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    if (typeof saved.volume === 'number' && saved.volume >= 0 && saved.volume <= 1) volume = saved.volume;
    if (typeof saved.statsVisible === 'boolean') statsVisible = saved.statsVisible;
  } catch {}
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ volume, statsVisible })); } catch {}
  }

  function logTrackStats() {
    if (!pc) return;
    pc.getStats().then((stats) => {
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          console.log('[viewer] video inbound-rtp:', {
            bytesReceived: report.bytesReceived,
            packetsReceived: report.packetsReceived,
            packetsLost: report.packetsLost,
            framesDecoded: report.framesDecoded,
            framesDropped: report.framesDropped,
          });
        }
      });
    }).catch(() => {});
  }

  // Chat
  const chatToggle = document.getElementById('chat-toggle');
  const chatPanel = document.getElementById('chat-panel');
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const chatInputRow = document.getElementById('chat-input-row');
  const chatBadge = document.getElementById('chat-badge');
  const chatNameRow = document.getElementById('chat-name-row');
  const chatNameInput = document.getElementById('chat-name-input');
  const chatNameError = document.getElementById('chat-name-error');
  let chatOpen = false;
  let unreadCount = 0;
  let chatEnabled = false;
  let myName = null;
  let savedName = null; // survives reconnects — re-sent after re-auth

  function toggleChat() {
    chatOpen = !chatOpen;
    chatPanel.classList.toggle('open', chatOpen);
    if (chatOpen) {
      unreadCount = 0;
      chatBadge.style.display = 'none';
      if (myName) chatInput.focus();
      else chatNameInput.focus();
    }
  }
  chatToggle?.addEventListener('click', toggleChat);

  function setName() {
    const name = chatNameInput.value.trim();
    if (!name || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'set_name', name: name }));
  }
  document.getElementById('chat-name-btn')?.addEventListener('click', setName);

  chatNameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); setName(); }
  });

  function handleNameResult(msg) {
    if (msg.success) {
      myName = msg.name;
      savedName = msg.name;
      chatNameRow.style.display = 'none';
      chatNameError.style.display = 'none';
      chatInputRow.style.display = 'flex';
      chatInput.focus();
    } else {
      // The server sends an error code; the key-array fallback covers old
      // servers (or unknown codes) via the generic message
      chatNameError.textContent = t(['viewer.chat.nameError.' + (msg.code || 'generic'), 'viewer.chat.nameError.generic']);
      chatNameError.style.display = 'block';
      chatNameInput.focus();
      chatNameInput.select();
    }
  }

  function handleChatEnabled(enabled) {
    chatEnabled = enabled;
    if (enabled) {
      chatToggle.style.display = 'flex';
    } else {
      chatToggle.style.display = 'none';
      chatPanel.classList.remove('open');
      chatOpen = false;
    }
  }

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text || !myName || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'chat', message: text }));
    chatInput.value = '';
    chatInput.focus();
  }
  document.getElementById('chat-send')?.addEventListener('click', sendChat);

  chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
  });

  // Drag handle to resize the chat panel. Pointer events cover mouse and
  // touch in one code path; capture keeps move/up on the handle itself.
  const chatResizeHandle = document.getElementById('chat-resize-handle');
  let resizing = false;
  let resizeStartY = 0;
  let resizeStartX = 0;
  let resizeStartH = 0;
  let resizeStartW = 0;

  chatResizeHandle?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resizing = true;
    chatResizeHandle.setPointerCapture(e.pointerId);
    resizeStartY = e.clientY;
    resizeStartX = e.clientX;
    resizeStartH = chatPanel.offsetHeight;
    resizeStartW = chatPanel.offsetWidth;
    document.body.style.userSelect = 'none';
  });

  chatResizeHandle?.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const dy = e.clientY - resizeStartY;
    const newH = Math.max(200, Math.min(window.innerHeight - 80, resizeStartH + dy));
    chatPanel.style.height = newH + 'px';
    // On phone-sized screens the panel is a full-width bottom sheet — height only
    if (window.innerWidth > 600) {
      const dx = e.clientX - resizeStartX;
      const newW = Math.max(240, Math.min(window.innerWidth - 30, resizeStartW + dx));
      chatPanel.style.width = newW + 'px';
    }
  });

  const endResize = () => {
    if (resizing) {
      resizing = false;
      document.body.style.userSelect = '';
    }
  };
  chatResizeHandle?.addEventListener('pointerup', endResize);
  chatResizeHandle?.addEventListener('pointercancel', endResize);

  function addChatMessage(sender, text) {
    const el = document.createElement('div');
    el.className = 'chat-msg';
    if (sender === 'Host') el.classList.add('chat-host');
    const s = document.createElement('span');
    s.className = 'chat-sender';
    s.textContent = sender;
    const t = document.createElement('span');
    t.className = 'chat-text';
    t.textContent = text;
    el.appendChild(s);
    el.appendChild(t);
    chatMessages.appendChild(el);
    while (chatMessages.children.length > 100) chatMessages.removeChild(chatMessages.firstChild);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    if (!chatOpen) {
      unreadCount++;
      chatBadge.textContent = unreadCount > 9 ? '9+' : unreadCount;
      chatBadge.style.display = 'flex';
    }
  }

  // Transient text setters take i18n keys and remember their last arguments
  // so a language switch can re-render whatever is currently on screen.
  let lastStatusArgs = null;
  function setStatus(key, cls, opts) {
    lastStatusArgs = { key, cls, opts };
    statusEl.textContent = key ? t(key, opts) : '';
    statusEl.className = cls;
    statusEl.style.display = key ? 'block' : 'none';
  }

  function showError(key, warn) {
    const el = document.createElement('div');
    el.className = 'error-toast' + (warn ? ' warn' : '');
    el.textContent = t(key);
    toastsEl.appendChild(el);
    while (toastsEl.children.length > 5) toastsEl.removeChild(toastsEl.firstChild);
    setTimeout(() => { if (el.parentNode) el.remove(); }, 6000);
  }

  // Loading / buffering overlay
  let lastLoadingKey = null;
  function showLoading(key) {
    lastLoadingKey = key;
    loadingText.textContent = t(key);
    loadingOverlay.classList.add('visible');
  }
  function hideLoading() {
    loadingOverlay.classList.remove('visible');
  }

  video.addEventListener('playing', hideLoading);
  video.addEventListener('loadeddata', hideLoading);
  video.addEventListener('waiting', () => {
    if (authenticated && !streamEnded) showLoading('viewer.loading.buffering');
  });
  video.addEventListener('stalled', () => {
    if (authenticated && !streamEnded) showLoading('viewer.loading.buffering');
  });

  // Terminal overlay (stream ended / gave up reconnecting)
  let lastOverlayArgs = null;
  function showOverlay(titleKey, messageKey) {
    lastOverlayArgs = { titleKey, messageKey };
    overlayTitle.textContent = t(titleKey);
    overlayMessage.textContent = t(messageKey);
    streamOverlay.classList.add('visible');
    hideLoading();
    setStatus('', '');
  }
  function hideOverlay() {
    streamOverlay.classList.remove('visible');
  }
  overlayRetry.addEventListener('click', () => {
    hideOverlay();
    streamEnded = false;
    reconnectAttempt = 0;
    showLoading('viewer.loading.connecting');
    connect();
  });

  // Measured playback stats (real fps/bitrate/loss from WebRTC, not the
  // configured values the server advertises)
  let lastRtp = null;
  let measured = { fps: null, kbps: null, lossPct: null, bufMs: null };

  function resetMeasuredStats() {
    lastRtp = null;
    measured = { fps: null, kbps: null, lossPct: null, bufMs: null };
  }

  setInterval(() => {
    if (!pc || !statsVisible) return;
    pc.getStats().then((stats) => {
      let bytes = 0;
      let frames = null;
      let lost = 0;
      let received = 0;
      let jbDelay = null;
      let jbEmitted = null;
      let found = false;
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp') {
          found = true;
          bytes += report.bytesReceived || 0;
          lost += report.packetsLost || 0;
          received += report.packetsReceived || 0;
          if (report.kind === 'video' && typeof report.framesDecoded === 'number') {
            frames = report.framesDecoded;
          }
          if (report.kind === 'video'
              && typeof report.jitterBufferDelay === 'number'
              && typeof report.jitterBufferEmittedCount === 'number') {
            jbDelay = report.jitterBufferDelay;
            jbEmitted = report.jitterBufferEmittedCount;
          }
        }
      });
      if (!found) return;
      const now = performance.now();
      if (lastRtp) {
        const dt = (now - lastRtp.ts) / 1000;
        if (dt > 0) {
          measured.kbps = Math.max(0, Math.round(((bytes - lastRtp.bytes) * 8) / dt / 1000));
          if (frames != null && lastRtp.frames != null) {
            measured.fps = Math.max(0, Math.round((frames - lastRtp.frames) / dt));
          }
          const dLost = lost - lastRtp.lost;
          const dRecv = received - lastRtp.received;
          measured.lossPct = dLost > 0 && dLost + dRecv > 0
            ? Math.round((dLost / (dLost + dRecv)) * 1000) / 10
            : 0;
          // Average time each video frame sat in the receive jitter buffer
          // over this interval — the browser-added latency component.
          if (jbDelay != null && lastRtp.jbDelay != null) {
            const dEmitted = (jbEmitted || 0) - (lastRtp.jbEmitted || 0);
            if (dEmitted > 0) {
              measured.bufMs = Math.round(((jbDelay - lastRtp.jbDelay) / dEmitted) * 1000);
            }
          }
        }
      }
      lastRtp = { ts: now, bytes, frames, lost, received, jbDelay, jbEmitted };
    }).catch(() => {});
  }, 1000);

  function formatBitrate(kbps) {
    return kbps >= 1000
      ? (kbps / 1000).toFixed(1) + ' ' + t('viewer.stats.mbps')
      : kbps + ' ' + t('viewer.stats.kbps');
  }

  function updateStats() {
    if (!statsVisible || !authenticated || playerScreen.style.display === 'none') {
      statsEl.style.display = 'none';
      return;
    }

    // [value, suffix] pairs — rendered via textContent, never innerHTML;
    // viewer counts come from the server and must not become markup.
    const parts = [];

    if (video.videoWidth && video.videoHeight) {
      parts.push([`${video.videoWidth}x${video.videoHeight}`, '']);
    }

    if (measured.fps != null) {
      parts.push([String(measured.fps), ' ' + t('viewer.stats.fps')]);
    }

    if (measured.kbps != null) {
      parts.push([formatBitrate(measured.kbps), '']);
    }

    if (measured.lossPct != null && measured.lossPct > 0) {
      parts.push([measured.lossPct + '%', ' ' + t('viewer.stats.loss')]);
    }

    if (measured.bufMs != null) {
      parts.push([measured.bufMs + ' ms', ' ' + t('viewer.stats.buffer')]);
    }

    if (streamInfo.viewers != null) {
      const cap = streamInfo.maxViewers != null ? `/${streamInfo.maxViewers}` : '';
      // i18next picks the plural form from count — Ukrainian has four
      parts.push([`${streamInfo.viewers}${cap}`, ' ' + t('viewer.stats.viewersSuffix', { count: streamInfo.viewers })]);
    }

    if (parts.length > 0) {
      statsEl.textContent = '';
      parts.forEach(([value, suffix], i) => {
        if (i > 0) statsEl.appendChild(document.createTextNode(' · '));
        const span = document.createElement('span');
        span.textContent = value;
        statsEl.appendChild(span);
        if (suffix) statsEl.appendChild(document.createTextNode(suffix));
      });
      statsEl.style.display = 'block';
    } else {
      statsEl.style.display = 'none';
    }
  }

  setInterval(updateStats, 500);

  function syncStatsAria() {
    statsToggle.setAttribute('aria-label', t(statsVisible ? 'viewer.stats.hide' : 'viewer.stats.show'));
  }

  function toggleStats() {
    statsVisible = !statsVisible;
    statsToggle.classList.toggle('active', statsVisible);
    syncStatsAria();
    savePrefs();
    updateStats();
  }
  statsToggle.addEventListener('click', toggleStats);
  statsToggle.classList.toggle('active', statsVisible);

  function getWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  }

  // Mute / volume
  const muteToggle = document.getElementById('mute-toggle');
  const iconMuted = document.getElementById('icon-muted');
  const iconUnmuted = document.getElementById('icon-unmuted');

  function updateMuteIcon() {
    iconMuted.style.display = isMuted ? 'block' : 'none';
    iconUnmuted.style.display = isMuted ? 'none' : 'block';
    muteToggle.setAttribute('aria-label', t(isMuted ? 'viewer.controls.unmute' : 'viewer.controls.mute'));
  }

  function applyAudio() {
    video.muted = isMuted;
    video.volume = volume;
    volumeSlider.value = String(isMuted ? 0 : volume);
    updateMuteIcon();
  }

  function toggleMute() {
    if (!hasAudio) return;
    isMuted = !isMuted;
    if (!isMuted && volume === 0) volume = 0.5;
    applyAudio();
    savePrefs();
  }
  muteToggle.addEventListener('click', toggleMute);

  volumeSlider.addEventListener('input', () => {
    const v = parseFloat(volumeSlider.value);
    if (Number.isNaN(v)) return;
    if (v === 0) {
      isMuted = true;
    } else {
      isMuted = false;
      volume = v;
    }
    applyAudio();
    savePrefs();
  });

  function adjustVolume(delta) {
    if (!hasAudio) return;
    volume = Math.max(0, Math.min(1, (isMuted ? 0 : volume) + delta));
    isMuted = volume === 0;
    applyAudio();
    savePrefs();
  }

  // Fullscreen — on the player container so controls/chat stay visible.
  // iPhone Safari has no element fullscreen; fall back to the native
  // video fullscreen there (overlays won't show — platform limitation).
  function toggleFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      return;
    }
    if (playerScreen.requestFullscreen) {
      playerScreen.requestFullscreen().catch(() => {});
    } else if (playerScreen.webkitRequestFullscreen) {
      playerScreen.webkitRequestFullscreen();
    } else if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
    }
  }
  fullscreenToggle.addEventListener('click', toggleFullscreen);

  function syncFullscreenIcon() {
    const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    iconFsEnter.style.display = fs ? 'none' : 'block';
    iconFsExit.style.display = fs ? 'block' : 'none';
    fullscreenToggle.setAttribute('aria-label', t(fs ? 'viewer.controls.exitFullscreen' : 'viewer.controls.fullscreen'));
  }
  document.addEventListener('fullscreenchange', syncFullscreenIcon);
  document.addEventListener('webkitfullscreenchange', syncFullscreenIcon);

  // Picture-in-picture (hidden where unsupported — Firefox has its own UI)
  if (!document.pictureInPictureEnabled) {
    pipToggle.style.display = 'none';
  } else {
    pipToggle.addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await video.requestPictureInPicture();
      } catch {}
    });
    video.addEventListener('enterpictureinpicture', () => pipToggle.classList.add('active'));
    video.addEventListener('leavepictureinpicture', () => pipToggle.classList.remove('active'));
  }

  // Control bar auto-hide
  let controlsTimer = null;
  function showControls() {
    controls.classList.add('visible');
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => controls.classList.remove('visible'), 3000);
  }
  function hideControls() {
    clearTimeout(controlsTimer);
    controlsTimer = null;
    controls.classList.remove('visible');
  }
  playerScreen.addEventListener('mousemove', showControls);
  playerScreen.addEventListener('touchstart', showControls, { passive: true });
  controls.addEventListener('mouseenter', () => clearTimeout(controlsTimer));
  controls.addEventListener('mouseleave', showControls);

  // Tap video: toggle the control bar. Double-tap/click: fullscreen.
  video.addEventListener('click', () => {
    if (controls.classList.contains('visible')) hideControls();
    else showControls();
  });
  video.addEventListener('dblclick', toggleFullscreen);

  // Keyboard shortcuts (skipped while typing in an input)
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (!authenticated) return;
    if (e.key === 'm' || e.key === 'M') {
      toggleMute();
    } else if (e.key === 'f' || e.key === 'F') {
      toggleFullscreen();
    } else if (e.key === 's' || e.key === 'S') {
      toggleStats();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      adjustVolume(0.05);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      adjustVolume(-0.05);
    } else {
      return;
    }
    showControls();
  });

  let lastAuthBusy = false;
  function setAuthBusy(busy) {
    lastAuthBusy = busy;
    authSubmit.disabled = busy;
    authSubmit.textContent = t(busy ? 'viewer.auth.connecting' : 'viewer.auth.connect');
  }

  authForm.addEventListener('submit', (e) => {
    e.preventDefault();
    password = passwordInput.value.trim();
    if (!password) return;
    authError.style.display = 'none';
    setAuthBusy(true);
    connect();
  });

  function cleanupPeerConnection() {
    if (pc) {
      pc.close();
      pc = null;
    }
    video.srcObject = null;
    resetMeasuredStats();
  }

  function connect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.onclose = null;
      ws.close();
    }

    cleanupPeerConnection();
    audioControls.classList.remove('available');

    setStatus('viewer.status.connecting', 'reconnecting');
    ws = new WebSocket(getWsUrl());
    authenticated = false;
    hasAudio = false;
    myName = null;
    streamInfo = { viewers: null, maxViewers: null };
    chatNameRow.style.display = 'flex';
    chatInputRow.style.display = 'none';
    chatNameError.style.display = 'none';

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', password: password }));
    };

    ws.onmessage = (event) => {
      if (!authenticated) {
        handleAuthResponse(event.data);
        return;
      }
      handleMessage(event.data);
    };

    ws.onclose = (e) => {
      console.log('[viewer] ws closed, code:', e.code, e.reason);
      if (streamEnded) {
        cleanupPeerConnection();
        return;
      }
      if (e.code === 4003) {
        showAuthError('viewer.authError.wrongPassword');
        return;
      }
      if (e.code === 4005) {
        showAuthError('viewer.authError.full');
        return;
      }
      if (e.code === 4008) {
        // Reconnecting would keep tripping the throttle — stop here.
        showAuthError('viewer.authError.throttled');
        return;
      }
      if (e.code === 4001 || e.code === 4002) {
        showAuthError('viewer.authError.connection');
        return;
      }
      if (e.code === 4010) {
        showError('viewer.errors.restarting', true);
      } else if (e.code === 4011) {
        showError('viewer.errors.videoInterrupted');
      } else if (authenticated && e.code !== 1000) {
        showError('viewer.errors.lost');
      }
      cleanupPeerConnection();
      if (authenticated) {
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      if (authenticated) showError('viewer.errors.problem');
    };
  }

  function handleAuthResponse(data) {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'auth' && msg.success) {
        authenticated = true;
        reconnectAttempt = 0;
        setAuthBusy(false);
        authScreen.style.display = 'none';
        playerScreen.style.display = 'block';
        setStatus('viewer.status.connected', 'connected');
        setTimeout(() => setStatus('', ''), 2000);
        showLoading('viewer.loading.waiting');
        showControls();
        // Tell server we're ready for WebRTC
        ws.send(JSON.stringify({ type: 'webrtc_ready' }));
        // Restore the chat name after a reconnect so the user
        // doesn't have to re-join mid-session
        if (savedName) ws.send(JSON.stringify({ type: 'set_name', name: savedName }));
      } else {
        showAuthError('viewer.authError.wrongPassword');
      }
    } catch {
      showAuthError('viewer.authError.generic');
    }
  }

  let lastAuthErrorKey = null;
  function showAuthError(key) {
    lastAuthErrorKey = key;
    setAuthBusy(false);
    hideLoading();
    authScreen.style.display = 'block';
    playerScreen.style.display = 'none';
    authError.textContent = t(key);
    authError.style.display = 'block';
    passwordInput.focus();
    passwordInput.select();
  }

  function handleMessage(data) {
    if (typeof data !== 'string') return;
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'webrtc_offer') {
        handleWebRTCOffer(msg.sdp, msg.iceServers);
      } else if (msg.type === 'stream_info') {
        if (msg.hasAudio) {
          hasAudio = true;
          audioControls.classList.add('available');
          applyAudio();
        }
      } else if (msg.type === 'viewer_count') {
        streamInfo.viewers = Number.isFinite(Number(msg.count)) ? Number(msg.count) : null;
        streamInfo.maxViewers = Number.isFinite(Number(msg.maxViewers)) ? Number(msg.maxViewers) : null;
      } else if (msg.type === 'stream_ended') {
        streamEnded = true;
        cleanupPeerConnection();
        showOverlay('viewer.overlay.ended', 'viewer.overlay.endedMsg');
      } else if (msg.type === 'chat' && msg.sender && msg.message) {
        addChatMessage(msg.sender, msg.message);
      } else if (msg.type === 'chat_enabled') {
        handleChatEnabled(msg.enabled);
      } else if (msg.type === 'name_result') {
        handleNameResult(msg);
      }
    } catch {}
  }

  async function handleWebRTCOffer(sdp, iceServers) {
    cleanupPeerConnection();

    const localPc = new RTCPeerConnection({
      iceServers: iceServers || [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    pc = localPc;

    // One stream we own — tracks attach in whatever order they arrive, so
    // audio isn't dropped when its ontrack fires before the video track's.
    const remoteStream = new MediaStream();

    localPc.ontrack = (event) => {
      console.log('[viewer] ontrack:', event.track.kind, 'streams:', event.streams.length);
      if (event.receiver) {
        // Minimize the receive jitter buffer on BOTH tracks: the browser slaves
        // video playout to the audio buffer for lip sync, so an unhinted audio
        // track would drag video back up to NetEQ's default delay anyway.
        // jitterBufferTarget is the standard knob (Chrome 110+, Safari 17.4+,
        // Firefox); playoutDelayHint covers older Chromium. Both are targets —
        // the browser still grows the buffer under real network jitter.
        const receiver = event.receiver;
        try {
          if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
        } catch { /* out-of-range or read-only on some engines */ }
        try {
          if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0;
        } catch { /* ignore */ }
      }
      remoteStream.addTrack(event.track);
      if (video.srcObject !== remoteStream) {
        video.srcObject = remoteStream;
        video.muted = isMuted;
        video.volume = volume;
        video.play().catch((err) => { if (err.name !== 'AbortError') console.warn('[viewer] video.play() rejected:', err); });
      }
    };

    localPc.onconnectionstatechange = () => {
      console.log('[viewer] connectionState:', localPc.connectionState);
    };

    localPc.onicecandidateerror = (e) => {
      console.warn(`[viewer] ICE candidate error: ${e.url} — ${e.errorCode} ${e.errorText}`);
    };

    localPc.oniceconnectionstatechange = () => {
      const state = localPc.iceConnectionState;
      console.log('[viewer] iceConnectionState:', state);
      if (state === 'failed') {
        showError('viewer.errors.firewall');
        setStatus('viewer.status.failed', 'error');
        scheduleReconnect();
      } else if (state === 'disconnected') {
        setStatus('viewer.status.reconnecting', 'reconnecting');
      } else if (state === 'connected' || state === 'completed') {
        setStatus('', '');
        // Log inbound RTP stats after a short delay
        setTimeout(() => logTrackStats(), 3000);
      }
    };

    try {
      await localPc.setRemoteDescription({ type: 'offer', sdp: sdp });
      const answer = await localPc.createAnswer();
      await localPc.setLocalDescription(answer);

      // Wait for ICE gathering to complete (with timeout) so all candidates
      // are in the SDP. werift requires candidates in the answer SDP.
      const iceGatherStart = Date.now();
      await new Promise((resolve) => {
        if (localPc.iceGatheringState === 'complete') {
          resolve();
        } else {
          const onState = () => {
            if (localPc.iceGatheringState === 'complete') {
              clearTimeout(timeout);
              localPc.removeEventListener('icegatheringstatechange', onState);
              console.log(`[viewer] ICE gathering complete in ${Date.now() - iceGatherStart}ms`);
              resolve();
            }
          };
          const timeout = setTimeout(() => {
            localPc.removeEventListener('icegatheringstatechange', onState);
            console.warn('[viewer] ICE gathering timed out after 5s, sending partial answer');
            resolve();
          }, 5000);
          localPc.addEventListener('icegatheringstatechange', onState);
        }
      });

      // Bail out if this PC was replaced by a reconnect while we were waiting
      if (pc !== localPc || !localPc.localDescription) return;

      ws.send(JSON.stringify({
        type: 'webrtc_answer',
        sdp: localPc.localDescription.sdp,
      }));
    } catch (err) {
      console.error('[viewer] WebRTC setup failed:', err);
      showError('viewer.errors.playback');
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    // Both ws.onclose and ICE-failure call this — one pending timer only,
    // or reconnects double up and the backoff index drifts.
    if (reconnectTimer || streamEnded) return;
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      showOverlay('viewer.overlay.unable', 'viewer.overlay.unableMsg');
      return;
    }
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    reconnectAttempt++;
    setStatus('viewer.status.reconnectingN', 'reconnecting', { count: reconnectAttempt });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  // --- Language ---

  const langSelects = Array.from(document.querySelectorAll('.lang-select'));

  async function setLanguage(lng) {
    lng = lng === 'uk' ? 'uk' : 'en';
    try { localStorage.setItem(LANG_KEY, lng); } catch {}
    await i18next.changeLanguage(lng);
    applyI18n();
    document.title = t('viewer.title');
    langSelects.forEach((s) => { s.value = lng; });

    // Re-render whatever dynamic text is currently visible. No WebSocket or
    // PeerConnection state is touched — switching mid-stream is safe.
    if (lastStatusArgs && lastStatusArgs.key) setStatus(lastStatusArgs.key, lastStatusArgs.cls, lastStatusArgs.opts);
    if (loadingOverlay.classList.contains('visible') && lastLoadingKey) showLoading(lastLoadingKey);
    if (streamOverlay.classList.contains('visible') && lastOverlayArgs) showOverlay(lastOverlayArgs.titleKey, lastOverlayArgs.messageKey);
    if (authError.style.display === 'block' && lastAuthErrorKey) authError.textContent = t(lastAuthErrorKey);
    setAuthBusy(lastAuthBusy);
    updateMuteIcon();
    syncFullscreenIcon();
    syncStatsAria();
    updateStats();
  }

  langSelects.forEach((s) => s.addEventListener('change', () => setLanguage(s.value)));

  // --- Boot ---

  // i18next must be initialized before anything renders text — including the
  // hash auto-connect below, which fires setStatus/showLoading immediately.
  (async () => {
    let resources = {};
    try {
      const [en, uk] = await Promise.all([
        fetch('/locales/en.json').then((r) => r.json()),
        fetch('/locales/uk.json').then((r) => r.json()),
      ]);
      resources = { en: { translation: en }, uk: { translation: uk } };
    } catch (err) {
      console.error('[viewer] locale load failed:', err);
    }
    await i18next.init({ lng: pickLanguage(navigator.language), fallbackLng: 'en', resources });
    applyI18n();
    document.title = t('viewer.title');
    langSelects.forEach((s) => { s.value = i18next.language; });
    setAuthBusy(false);
    updateMuteIcon();
    syncFullscreenIcon();
    syncStatsAria();

    // Auto-connect if password is in the URL hash
    const hashPassword = location.hash.slice(1);
    if (hashPassword) {
      password = decodeURIComponent(hashPassword);
      history.replaceState(null, '', location.pathname);
      connect();
    }
  })();
})();
