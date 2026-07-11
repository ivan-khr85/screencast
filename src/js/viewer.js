// Core viewer script: auth, WebSocket signaling, RTCPeerConnection,
// reconnect/backoff, video events, player controls (volume/mute/pip/
// fullscreen), overlays, toasts, status pill and i18n bootstrap.
// Chat and stats live in their own modules (js/viewer-chat.js,
// js/viewer-stats.js — loaded before this file); this core wires them up
// via Viewer.chat.init / Viewer.stats.init and routes ws messages to them.
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
  let streamInfo = { viewers: null, maxViewers: null, fps: null, bitrate: null };
  let streamEnded = false;

  // Media transport. 'webrtc' is the low-latency default; 'ws' streams fMP4
  // over the signaling WebSocket (MSE) for networks where the direct UDP
  // path can't be established (strict NAT/firewall behind the tunnel).
  // ?ws=1 forces the fallback from the start (the hash carries the password).
  let transport = 'webrtc';
  let preferFallback = new URLSearchParams(location.search).get('ws') === '1';
  let webrtcFailCycles = 0; // survives reconnects — breaks the retry loop
  let fallbackTimer = null;
  let fallbackPillPending = false; // flash "Compatibility mode" once MSE plays
  let pendingCandidates = []; // server candidates that raced the offer
  let remoteDescSet = false;
  let lastMessageAt = Date.now(); // watchdog: server pings every 25s

  let isMuted = true; // Start muted (browser autoplay policy)
  let hasAudio = false;

  // Persisted viewer preferences (volume + stats overlay visibility).
  // statsVisible is owned by Viewer.stats after init — savePrefs reads it
  // back so the single localStorage key stays byte-identical.
  let volume = 1;
  let initialStatsVisible = false;
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    if (typeof saved.volume === 'number' && saved.volume >= 0 && saved.volume <= 1) volume = saved.volume;
    if (typeof saved.statsVisible === 'boolean') initialStatsVisible = saved.statsVisible;
  } catch {}
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ volume, statsVisible: Viewer.stats.isVisible() })); } catch {}
  }

  // Guarded send used by the chat module (and safe anywhere)
  function sendJson(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // Wire up the split-out modules
  Viewer.chat.init({ send: sendJson, t });
  Viewer.stats.init({
    t,
    getPc: () => pc,
    isAuthenticated: () => authenticated,
    getStreamInfo: () => streamInfo,
    getTransport: () => transport,
    savePrefs,
    visible: initialStatsVisible,
  });
  Viewer.mse.init({
    onFatal: () => {
      // This browser can't play the fallback stream either — nothing left.
      showError('viewer.errors.firewall');
      showOverlay('viewer.overlay.unable', 'viewer.overlay.unableMsg');
    },
  });
  Viewer.debug.init({
    t,
    getState: () => ({
      pc,
      transport,
      authenticated,
      wsReadyState: ws ? ['connecting', 'open', 'closing', 'closed'][ws.readyState] : 'none',
      reconnectAttempt,
      webrtcFailCycles,
      preferFallback,
      lastMessageAgeMs: Date.now() - lastMessageAt,
      streamInfo,
      hasAudio,
    }),
  });

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

  video.addEventListener('playing', () => {
    hideLoading();
    if (transport === 'ws' && fallbackPillPending) {
      // Mirror the WebRTC "Connected" flash; the stats overlay keeps showing
      // the active transport for anyone who wants it.
      fallbackPillPending = false;
      setStatus('viewer.status.fallback', 'connected');
      setTimeout(() => setStatus('', ''), 2000);
    }
  });
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

  function getWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  }

  // Watchdog: the server sends a JSON ping every 25s, so a long silence
  // means the socket is dead even if the TCP stack hasn't noticed (sleep,
  // network switch, tunnel drop). Recycle it through the reconnect path.
  setInterval(() => {
    if (authenticated && ws && ws.readyState === WebSocket.OPEN &&
        Date.now() - lastMessageAt > 60000) {
      console.warn('[viewer] no server messages for 60s — recycling connection');
      ws.close();
    }
  }, 10000);

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
      Viewer.stats.toggle();
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

  function clearFallbackTimer() {
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
  }

  // Viewer loaded the page over LAN/loopback? Then WebRTC host candidates
  // have a real chance and deserve the full connect window.
  function isPrivateHost() {
    const h = location.hostname;
    return (
      h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' ||
      h.endsWith('.local') ||
      /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    );
  }

  function cleanupPeerConnection() {
    clearFallbackTimer();
    pendingCandidates = [];
    remoteDescSet = false;
    if (pc) {
      pc.close();
      pc = null;
    }
    video.srcObject = null;
    if (Viewer.mse) Viewer.mse.reset();
    Viewer.stats.resetMeasured();
  }

  // WebRTC could not connect (ICE failed or timed out) — switch this session
  // to the fMP4-over-WebSocket transport. The signaling socket is still open;
  // sticky via preferFallback so later reconnects skip the doomed retry.
  function switchToFallback() {
    if (transport === 'ws' || streamEnded) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    transport = 'ws';
    preferFallback = true;
    webrtcFailCycles++;
    console.warn('[viewer] WebRTC failed — switching to WebSocket media fallback');
    cleanupPeerConnection();
    setStatus('viewer.status.fallback', 'reconnecting');
    showError('viewer.errors.webrtcFallback', true);
    showLoading('viewer.loading.waiting');
    sendJson({ type: 'transport_fallback' });
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
    ws.binaryType = 'arraybuffer'; // fMP4 fallback segments arrive as binary
    authenticated = false;
    hasAudio = false;
    transport = preferFallback ? 'ws' : 'webrtc';
    streamInfo = { viewers: null, maxViewers: null, fps: null, bitrate: null };
    Viewer.chat.resetForConnect();

    ws.onopen = () => {
      lastMessageAt = Date.now();
      ws.send(JSON.stringify({ type: 'auth', password: password }));
    };

    ws.onmessage = (event) => {
      lastMessageAt = Date.now();
      if (event.data instanceof ArrayBuffer) {
        if (authenticated) handleBinaryFrame(event.data);
        return;
      }
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
        // Repeated WebRTC timeouts (server closes 4011) used to loop forever:
        // reconnect → new offer → 35s timeout → 4011 → … After two cycles,
        // go straight to the WebSocket fallback on the next connect.
        if (transport === 'webrtc') {
          webrtcFailCycles++;
          if (webrtcFailCycles >= 2) preferFallback = true;
        }
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
        if (transport === 'ws') {
          // Fallback transport (forced via ?ws=1 or sticky after WebRTC failures)
          ws.send(JSON.stringify({ type: 'transport_fallback' }));
        } else {
          // Tell server we're ready for WebRTC
          ws.send(JSON.stringify({ type: 'webrtc_ready' }));
        }
        // Restore the chat name after a reconnect so the user
        // doesn't have to re-join mid-session
        Viewer.chat.resendName();
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
      } else if (msg.type === 'ice_candidate') {
        // Trickled server candidate. Queue until setRemoteDescription lands.
        if (!pc || !msg.candidate) return;
        if (!remoteDescSet) {
          pendingCandidates.push(msg.candidate);
        } else {
          pc.addIceCandidate(msg.candidate).catch(() => {});
        }
      } else if (msg.type === 'ice_complete') {
        // Browsers cope fine without an explicit end-of-candidates signal.
      } else if (msg.type === 'ping') {
        // Server heartbeat — receiving it already fed the watchdog.
      } else if (msg.type === 'fallback_start') {
        if (Viewer.mse && typeof msg.mime === 'string') {
          transport = 'ws';
          // Covers forced ?ws=1 and sticky-preferFallback reconnects, which
          // never go through switchToFallback().
          setStatus('viewer.status.fallback', 'reconnecting');
          fallbackPillPending = true;
          Viewer.mse.reset();
          Viewer.mse.start(msg.mime);
        }
      } else if (msg.type === 'fallback_unavailable') {
        showError('viewer.errors.firewall');
        showOverlay('viewer.overlay.unable', 'viewer.overlay.unableMsg');
      } else if (msg.type === 'stream_restarting') {
        // Capture pipeline is restarting in place — keep the socket, expect
        // a fresh offer (webrtc) or a fresh init segment (ws) shortly.
        if (authenticated && !streamEnded) showLoading('viewer.loading.waiting');
      } else if (msg.type === 'stream_info') {
        streamInfo.fps = Number.isFinite(Number(msg.fps)) ? Number(msg.fps) : null;
        streamInfo.bitrate = typeof msg.bitrate === 'string' ? msg.bitrate : null;
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
        Viewer.chat.addMessage(msg.sender, msg.message);
      } else if (msg.type === 'chat_enabled') {
        Viewer.chat.setEnabled(msg.enabled);
      } else if (msg.type === 'debug_enabled') {
        Viewer.debug.setEnabled(msg.enabled);
      } else if (msg.type === 'name_result') {
        Viewer.chat.onNameResult(msg);
      }
    } catch {}
  }

  // Binary WS frames carry the fMP4 fallback stream: 1-byte type prefix
  // (0x01 init segment, 0x02 media segment) + MP4 payload.
  function handleBinaryFrame(data) {
    if (!Viewer.mse || data.byteLength < 2) return;
    const type = new Uint8Array(data, 0, 1)[0];
    const payload = data.slice(1);
    if (type === 0x01) Viewer.mse.appendInit(payload);
    else if (type === 0x02) Viewer.mse.appendSegment(payload);
  }

  async function handleWebRTCOffer(sdp, iceServers) {
    if (transport === 'ws') return; // fallback already active — stale offer
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
      if (localPc.connectionState === 'connected' && pc === localPc) {
        clearFallbackTimer();
      }
    };

    localPc.onicecandidateerror = (e) => {
      console.warn(`[viewer] ICE candidate error: ${e.url} — ${e.errorCode} ${e.errorText}`);
    };

    // Trickle ICE: forward our candidates to the server as they're gathered.
    localPc.onicecandidate = (e) => {
      if (pc !== localPc) return;
      if (e.candidate) sendJson({ type: 'ice_candidate', candidate: e.candidate.toJSON() });
      else sendJson({ type: 'ice_complete' });
    };

    localPc.oniceconnectionstatechange = () => {
      const state = localPc.iceConnectionState;
      console.log('[viewer] iceConnectionState:', state);
      if (state === 'failed') {
        // Direct media path impossible — don't loop reconnects, switch to
        // the WebSocket fallback on the still-open signaling socket.
        switchToFallback();
      } else if (state === 'disconnected') {
        setStatus('viewer.status.reconnecting', 'reconnecting');
      } else if (state === 'connected' || state === 'completed') {
        clearFallbackTimer();
        setStatus('', '');
        // Log inbound RTP stats after a short delay
        setTimeout(() => logTrackStats(), 3000);
      }
    };

    try {
      await localPc.setRemoteDescription({ type: 'offer', sdp: sdp });

      // Bail out if this PC was replaced by a reconnect while we awaited
      if (pc !== localPc) return;
      remoteDescSet = true;
      for (const c of pendingCandidates) localPc.addIceCandidate(c).catch(() => {});
      pendingCandidates = [];

      const answer = await localPc.createAnswer();
      await localPc.setLocalDescription(answer);
      if (pc !== localPc || !localPc.localDescription) return;

      // Send the answer immediately, before ICE gathering finishes: werift
      // latches on a=end-of-candidates in the SDP, so a "complete" answer
      // would make it ignore every candidate we trickle afterwards.
      ws.send(JSON.stringify({
        type: 'webrtc_answer',
        sdp: localPc.localDescription.sdp,
      }));

      // If WebRTC can't get connected quickly it likely never will (ICE can
      // sit in "checking" for ages on hostile NATs) — arm the fallback.
      // A remote viewer with STUN-only servers has no relay to wait for, so
      // don't make them stare at a black screen: cut the window to 4s. With
      // TURN configured (or on LAN) keep 9s — relay allocation is slower.
      const hasTurn = (iceServers || []).some((s) =>
        String(Array.isArray(s.urls) ? s.urls[0] : s.urls).startsWith('turn:'));
      const connectWindowMs = (!isPrivateHost() && !hasTurn) ? 4000 : 9000;
      clearFallbackTimer();
      fallbackTimer = setTimeout(() => {
        if (pc === localPc && localPc.connectionState !== 'connected') {
          console.warn(`[viewer] WebRTC not connected after ${connectWindowMs / 1000}s — falling back`);
          switchToFallback();
        }
      }, connectWindowMs);
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
    Viewer.stats.refresh();
    Viewer.debug.refresh();
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
    Viewer.stats.refresh();
    Viewer.debug.refresh();

    // Auto-connect if password is in the URL hash
    const hashPassword = location.hash.slice(1);
    if (hashPassword) {
      password = decodeURIComponent(hashPassword);
      history.replaceState(null, '', location.pathname);
      connect();
    }
  })();
})();
