(function() {
  const RECONNECT_DELAYS = [1000, 2000, 4000, 8000];

  const authScreen = document.getElementById('auth-screen');
  const playerScreen = document.getElementById('player-screen');
  const video = document.getElementById('video');
  const statusEl = document.getElementById('status');
  const authForm = document.getElementById('auth-form');
  const passwordInput = document.getElementById('password-input');
  const authError = document.getElementById('auth-error');
  const statsEl = document.getElementById('stream-stats');
  const toastsEl = document.getElementById('error-toasts');

  let ws = null;
  let pc = null;
  let reconnectAttempt = 0;
  let password = '';
  let authenticated = false;
  let streamInfo = { fps: null, bitrate: null, viewers: null };

  let isMuted = true; // Start muted (browser autoplay policy)
  let hasAudio = false;

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

  window.toggleChat = function() {
    chatOpen = !chatOpen;
    chatPanel.classList.toggle('open', chatOpen);
    if (chatOpen) {
      unreadCount = 0;
      chatBadge.style.display = 'none';
      if (myName) chatInput.focus();
      else chatNameInput.focus();
    }
  };

  window.setName = function() {
    const name = chatNameInput.value.trim();
    if (!name || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'set_name', name: name }));
  };

  chatNameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); window.setName(); }
  });

  function handleNameResult(msg) {
    if (msg.success) {
      myName = msg.name;
      chatNameRow.style.display = 'none';
      chatNameError.style.display = 'none';
      chatInputRow.style.display = 'flex';
      chatInput.focus();
    } else {
      chatNameError.textContent = msg.error || 'Name not available';
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

  window.sendChat = function() {
    const text = chatInput.value.trim();
    if (!text || !myName || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'chat', message: text }));
    chatInput.value = '';
    chatInput.focus();
  };

  chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); window.sendChat(); }
  });

  // Drag handle to resize chat panel height/width
  const chatResizeHandle = document.getElementById('chat-resize-handle');
  let resizing = false;
  let resizeStartY = 0;
  let resizeStartX = 0;
  let resizeStartH = 0;
  let resizeStartW = 0;

  chatResizeHandle?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    resizing = true;
    resizeStartY = e.clientY;
    resizeStartX = e.clientX;
    resizeStartH = chatPanel.offsetHeight;
    resizeStartW = chatPanel.offsetWidth;
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const dy = resizeStartY - e.clientY;
    const dx = resizeStartX - e.clientX;
    const newH = Math.max(200, Math.min(window.innerHeight - 80, resizeStartH + dy));
    const newW = Math.max(240, Math.min(window.innerWidth - 30, resizeStartW + dx));
    chatPanel.style.height = newH + 'px';
    chatPanel.style.width = newW + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (resizing) {
      resizing = false;
      document.body.style.userSelect = '';
    }
  });

  function addChatMessage(sender, text) {
    const el = document.createElement('div');
    el.className = 'chat-msg';
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

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls;
    statusEl.style.display = text ? 'block' : 'none';
  }

  function showError(msg, warn) {
    const el = document.createElement('div');
    el.className = 'error-toast' + (warn ? ' warn' : '');
    el.textContent = msg;
    toastsEl.appendChild(el);
    while (toastsEl.children.length > 5) toastsEl.removeChild(toastsEl.firstChild);
    setTimeout(() => { if (el.parentNode) el.remove(); }, 6000);
  }

  function updateStats() {
    if (!authenticated || playerScreen.style.display === 'none') {
      statsEl.style.display = 'none';
      return;
    }

    const parts = [];

    if (video.videoWidth && video.videoHeight) {
      parts.push(`<span>${video.videoWidth}x${video.videoHeight}</span>`);
    }

    if (streamInfo.fps) {
      parts.push(`<span>${streamInfo.fps}</span> fps`);
    }

    if (streamInfo.bitrate) {
      parts.push(`<span>${streamInfo.bitrate}bps</span>`);
    }

    if (streamInfo.viewers != null) {
      parts.push(`<span>${streamInfo.viewers}</span> viewer${streamInfo.viewers !== 1 ? 's' : ''}`);
    }

    if (parts.length > 0) {
      statsEl.innerHTML = parts.join(' &middot; ');
      statsEl.style.display = 'block';
    }
  }

  setInterval(updateStats, 500);

  function getWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  }

  // Mute toggle
  const muteToggle = document.getElementById('mute-toggle');
  const iconMuted = document.getElementById('icon-muted');
  const iconUnmuted = document.getElementById('icon-unmuted');

  // Auto-connect if password is in the URL hash
  const hashPassword = location.hash.slice(1);
  if (hashPassword) {
    password = decodeURIComponent(hashPassword);
    history.replaceState(null, '', location.pathname);
    connect();
  }

  authForm.addEventListener('submit', (e) => {
    e.preventDefault();
    password = passwordInput.value.trim();
    if (!password) return;
    authError.style.display = 'none';
    connect();
  });

  function cleanupPeerConnection() {
    if (pc) {
      pc.close();
      pc = null;
    }
    video.srcObject = null;
  }

  function connect() {
    if (ws) {
      ws.onclose = null;
      ws.close();
    }

    cleanupPeerConnection();
    muteToggle.style.display = 'none';

    setStatus('Connecting...', 'reconnecting');
    ws = new WebSocket(getWsUrl());
    authenticated = false;
    hasAudio = false;
    myName = null;
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
      if (e.code === 4003) {
        showAuthError('Wrong password');
        return;
      }
      if (e.code === 4005) {
        showAuthError('Stream is full');
        return;
      }
      if (e.code === 4010) {
        showError('Stream is restarting...', true);
      } else if (e.code === 4011) {
        showError('WebRTC connection lost');
      } else if (authenticated && e.code !== 1000) {
        showError('Connection lost (code ' + e.code + ')');
      }
      cleanupPeerConnection();
      if (authenticated) {
        setStatus('Reconnecting...', 'reconnecting');
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      if (authenticated) showError('WebSocket error');
    };
  }

  function handleAuthResponse(data) {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'auth' && msg.success) {
        authenticated = true;
        reconnectAttempt = 0;
        authScreen.style.display = 'none';
        playerScreen.style.display = 'block';
        setStatus('Connected', 'connected');
        setTimeout(() => setStatus('', ''), 2000);
        // Tell server we're ready for WebRTC
        ws.send(JSON.stringify({ type: 'webrtc_ready' }));
      } else {
        showAuthError('Wrong password');
      }
    } catch {
      showAuthError('Connection error');
    }
  }

  function showAuthError(msg) {
    authScreen.style.display = 'block';
    playerScreen.style.display = 'none';
    authError.textContent = msg;
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
        streamInfo.fps = msg.fps || null;
        streamInfo.bitrate = msg.bitrate || null;
        if (msg.hasAudio) {
          hasAudio = true;
          muteToggle.style.display = 'flex';
          updateMuteIcon();
        }
      } else if (msg.type === 'viewer_count') {
        streamInfo.viewers = msg.count;
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

    localPc.ontrack = (event) => {
      console.log('[viewer] ontrack:', event.track.kind, 'streams:', event.streams.length);
      if (event.track.kind === 'video') {
        if (!video.srcObject) {
          video.srcObject = event.streams[0] || new MediaStream([event.track]);
          video.muted = isMuted;
          video.play().catch((err) => { if (err.name !== 'AbortError') console.warn('[viewer] video.play() rejected:', err); });
        }
      } else if (event.track.kind === 'audio' && video.srcObject) {
        video.srcObject.addTrack(event.track);
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
        showError('WebRTC connection failed. You may be behind a firewall that blocks UDP.');
        setStatus('Connection failed', 'error');
        scheduleReconnect();
      } else if (state === 'disconnected') {
        setStatus('Reconnecting...', 'reconnecting');
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
          const timeout = setTimeout(() => {
            console.warn('[viewer] ICE gathering timed out after 5s, sending partial answer');
            resolve();
          }, 5000);
          localPc.addEventListener('icegatheringstatechange', function onState() {
            if (localPc.iceGatheringState === 'complete') {
              clearTimeout(timeout);
              localPc.removeEventListener('icegatheringstatechange', onState);
              console.log(`[viewer] ICE gathering complete in ${Date.now() - iceGatherStart}ms`);
              resolve();
            }
          });
        }
      });

      // Bail out if this PC was replaced by a reconnect while we were waiting
      if (pc !== localPc || !localPc.localDescription) return;

      ws.send(JSON.stringify({
        type: 'webrtc_answer',
        sdp: localPc.localDescription.sdp,
      }));
    } catch (err) {
      showError('WebRTC setup failed: ' + err.message);
    }
  }

  function updateMuteIcon() {
    iconMuted.style.display = isMuted ? 'block' : 'none';
    iconUnmuted.style.display = isMuted ? 'none' : 'block';
  }

  window.toggleMute = function() {
    isMuted = !isMuted;
    video.muted = isMuted;
    updateMuteIcon();
  };

  video.addEventListener('click', () => {
    isMuted = !isMuted;
    video.muted = isMuted;
    updateMuteIcon();
  });

  function scheduleReconnect() {
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    reconnectAttempt++;
    setTimeout(() => connect(), delay);
  }
})();
