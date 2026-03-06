(function() {
  let BUFFER_EVICTION_SEC = 5;
  let LIVE_EDGE_THRESHOLD = 1;
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
  let mediaSource = null;
  let sourceBuffer = null;
  let queue = [];
  let reconnectAttempt = 0;
  let password = '';
  let initSegment = null;
  let authenticated = false;
  let serverMime = null;
  let streamInfo = { fps: null, bitrate: null, viewers: null };

  // --- Audio via Web Audio API ---
  let audioCtx = null;
  let audioWorkletReady = false;
  let audioWorkletNode = null;
  let audioGain = null;
  let audioSampleRate = 48000;
  let audioChannels = 2;
  let hasAudio = false;
  let isMuted = true; // Start muted (browser autoplay policy)

  const WORKLET_CODE = `
class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Ring buffer: ~1 second at given sample rate * channels
    this.ring = new Float32Array(48000 * 2);
    this.writePos = 0;
    this.readPos = 0;
    this.buffered = 0;
    this.channels = 2;

    this.port.onmessage = (e) => {
      if (e.data.type === 'config') {
        this.channels = e.data.channels;
        this.ring = new Float32Array(e.data.sampleRate * this.channels);
        this.writePos = 0;
        this.readPos = 0;
        this.buffered = 0;
        return;
      }
      const data = e.data;
      const len = data.length;
      const ringLen = this.ring.length;

      // If buffer would overflow, drop old data
      if (this.buffered + len > ringLen) {
        const excess = (this.buffered + len) - ringLen;
        this.readPos = (this.readPos + excess) % ringLen;
        this.buffered -= excess;
      }

      // Write to ring buffer
      for (let i = 0; i < len; i++) {
        this.ring[this.writePos] = data[i];
        this.writePos = (this.writePos + 1) % ringLen;
      }
      this.buffered += len;
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const outChannels = output.length;
    const frameSize = output[0].length; // 128 samples per quantum
    const srcChannels = this.channels;
    const samplesNeeded = frameSize * srcChannels;
    const ringLen = this.ring.length;

    if (this.buffered >= samplesNeeded) {
      for (let i = 0; i < frameSize; i++) {
        for (let ch = 0; ch < outChannels; ch++) {
          if (ch < srcChannels) {
            output[ch][i] = this.ring[this.readPos + ch];
          }
        }
        this.readPos = (this.readPos + srcChannels) % ringLen;
      }
      this.buffered -= samplesNeeded;
    }
    // If not enough data, outputs stay silent (pre-filled with 0)
    return true;
  }
}
registerProcessor('pcm-player', PCMPlayerProcessor);
`;

  async function initAudio() {
    if (audioCtx) return;
    try {
      audioCtx = new AudioContext({ sampleRate: audioSampleRate });
      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      audioWorkletNode = new AudioWorkletNode(audioCtx, 'pcm-player', {
        outputChannelCount: [audioChannels],
      });
      audioWorkletNode.port.postMessage({
        type: 'config',
        sampleRate: audioSampleRate,
        channels: audioChannels,
      });

      audioGain = audioCtx.createGain();
      audioGain.gain.value = isMuted ? 0 : 1;
      audioWorkletNode.connect(audioGain);
      audioGain.connect(audioCtx.destination);

      audioWorkletReady = true;
    } catch (err) {
      console.warn('AudioWorklet init failed:', err);
    }
  }

  function feedAudio(pcmData) {
    if (!audioWorkletReady || !audioWorkletNode) return;
    // Resume AudioContext if suspended (autoplay policy)
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    audioWorkletNode.port.postMessage(pcmData, [pcmData.buffer]);
  }

  function destroyAudio() {
    if (audioWorkletNode) {
      audioWorkletNode.disconnect();
      audioWorkletNode = null;
    }
    if (audioGain) {
      audioGain.disconnect();
      audioGain = null;
    }
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }
    audioWorkletReady = false;
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
    // Keep max 100 messages
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
    // Keep max 5 toasts
    while (toastsEl.children.length > 5) toastsEl.removeChild(toastsEl.firstChild);
    setTimeout(() => { if (el.parentNode) el.remove(); }, 6000);
  }

  function updateStats() {
    if (!authenticated || playerScreen.style.display === 'none') {
      statsEl.style.display = 'none';
      return;
    }

    const parts = [];

    // Resolution
    if (video.videoWidth && video.videoHeight) {
      parts.push(`<span>${video.videoWidth}x${video.videoHeight}</span>`);
    }

    // FPS
    if (streamInfo.fps) {
      parts.push(`<span>${streamInfo.fps}</span> fps`);
    }

    // Bitrate
    if (streamInfo.bitrate) {
      parts.push(`<span>${streamInfo.bitrate}bps</span>`);
    }

    // Viewers
    if (streamInfo.viewers != null) {
      parts.push(`<span>${streamInfo.viewers}</span> viewer${streamInfo.viewers !== 1 ? 's' : ''}`);
    }

    // Delay
    if (sourceBuffer) {
      try {
        const buffered = sourceBuffer.buffered;
        if (buffered.length > 0) {
          const delay = buffered.end(buffered.length - 1) - video.currentTime;
          parts.push(`delay <span>${delay.toFixed(1)}s</span>`);
        }
      } catch {}
    }

    // Queue
    if (queue.length > 0) {
      parts.push(`queue <span>${queue.length}</span>`);
    }

    if (parts.length > 0) {
      statsEl.innerHTML = parts.join(' &middot; ');
      statsEl.style.display = 'block';
    }
  }

  setInterval(updateStats, 500);

  function dbg() {}

  function getWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  }

  // Auto-connect if password is in the URL hash (#password).
  // Hash fragments are never sent to the server or proxy (Cloudflare),
  // so they survive tunneling and aren't logged.
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

  function connect() {
    if (ws) {
      ws.onclose = null;
      ws.close();
    }

    destroyAudio();

    setStatus('Connecting...', 'reconnecting');
    ws = new WebSocket(getWsUrl());
    ws.binaryType = 'arraybuffer';
    authenticated = false;
    myName = null;
    chatNameRow.style.display = 'flex';
    chatInputRow.style.display = 'none';
    chatNameError.style.display = 'none';

    ws.onopen = () => {
      dbg('WebSocket connected, sending auth');
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
      dbg('WebSocket closed, code=' + e.code, 'reason=' + e.reason);
      if (e.code === 4003) {
        showAuthError('Wrong password');
        return;
      }
      if (e.code === 4005) {
        showAuthError('Stream is full');
        return;
      }
      if (e.code === 4006) {
        showError('Disconnected: client too slow (backpressure)');
      } else if (e.code === 4010) {
        showError('Stream is restarting...', true);
      } else if (authenticated && e.code !== 1000) {
        showError('Connection lost (code ' + e.code + ')');
      }
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
        muteToggle.style.display = 'flex';
        setStatus('Connected', 'connected');
        setTimeout(() => setStatus('', ''), 2000);
        initMediaSource();
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

  function initMediaSource() {
    if (mediaSource) {
      try { video.src = ''; } catch {}
    }

    mediaSource = new MediaSource();
    sourceBuffer = null;
    queue = [];
    initSegment = null;

    // Video element is always muted — audio comes from Web Audio API
    video.muted = true;

    dbg('MediaSource created, readyState=' + mediaSource.readyState);
    video.src = URL.createObjectURL(mediaSource);

    mediaSource.addEventListener('sourceopen', () => {
      dbg('MediaSource sourceopen fired');
      if (initSegment && !sourceBuffer) {
        dbg('init segment was queued, creating SourceBuffer now');
        createSourceBuffer(initSegment);
      }
    }, { once: true });

  }

  function handleMessage(data) {
    // JSON text messages
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'mime') {
          serverMime = msg.mime;
          dbg('received mime:', msg.mime);
        } else if (msg.type === 'stream_info') {
          streamInfo.fps = msg.fps || null;
          streamInfo.bitrate = msg.bitrate || null;
          if (msg.liveEdgeThreshold) LIVE_EDGE_THRESHOLD = msg.liveEdgeThreshold;
          if (msg.bufferEvictionSeconds) BUFFER_EVICTION_SEC = msg.bufferEvictionSeconds;
          if (msg.hasAudio) {
            hasAudio = true;
            audioSampleRate = msg.audioSampleRate || 48000;
            audioChannels = msg.audioChannels || 2;
            initAudio();
          }
          dbg('received stream_info:', JSON.stringify(msg));
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
      return;
    }

    if (!(data instanceof ArrayBuffer) || data.byteLength < 1) return;

    // First byte is the channel tag: 0x00 = video, 0x01 = audio
    const tag = new Uint8Array(data, 0, 1)[0];
    const payload = data.slice(1);

    if (tag === 0x01) {
      // Audio: raw f32le PCM — feed to AudioWorklet
      const pcm = new Float32Array(payload);
      feedAudio(pcm);
      return;
    }

    // tag === 0x00: video segment
    const buf = new Uint8Array(payload);

    // First binary video message is the init segment (ftyp + moov)
    if (!initSegment) {
      initSegment = buf;
      dbg('received init segment:', buf.length, 'bytes, MediaSource.readyState=' + mediaSource.readyState);
      createSourceBuffer(buf);
      return;
    }

    appendBuffer(buf);
  }

  function createSourceBuffer(init) {
    if (mediaSource.readyState !== 'open') {
      dbg('createSourceBuffer: MediaSource not open yet (readyState=' + mediaSource.readyState + '), deferring');
      return;
    }

    // Use server-provided mime if available, otherwise try common codecs
    let mime = serverMime;
    dbg('createSourceBuffer: serverMime=' + serverMime, 'isSupported=' + (mime ? MediaSource.isTypeSupported(mime) : 'N/A'));
    if (!mime || !MediaSource.isTypeSupported(mime)) {
      const fallbacks = [
        'video/mp4; codecs="avc1.640028,mp4a.40.2"',
        'video/mp4; codecs="avc1.640028"',
        'video/mp4',
      ];
      mime = fallbacks.find(m => MediaSource.isTypeSupported(m)) || 'video/mp4';
      dbg('createSourceBuffer: using fallback mime=' + mime);
    }

    try {
      sourceBuffer = mediaSource.addSourceBuffer(mime);
      sourceBuffer.mode = 'sequence';
      dbg('SourceBuffer created, mode=sequence, mime=' + mime);

      sourceBuffer.addEventListener('updateend', () => {
        if (video.paused) {
          video.play().then(() => {
            dbg('video.play() succeeded');
          }).catch((err) => {
            dbg('video.play() failed:', err.message);
          });
        }
        processQueue();
      });
      sourceBuffer.addEventListener('error', (e) => {
        dbg('SourceBuffer error event', e);
        showError('SourceBuffer error — stream may be corrupted');
      });

      appendBuffer(init);
    } catch (err) {
      dbg('createSourceBuffer failed:', err.message);
      showError('Failed to create SourceBuffer: ' + err.message);
    }
  }

  function appendBuffer(data) {
    if (!sourceBuffer) return;

    queue.push(data);

    // Drop frames if queue is too long (> 10 chunks)
    if (queue.length > 10) {
      const dropped = queue.length - 3;
      queue = queue.slice(-3);
      showError('Dropped ' + dropped + ' frames (queue overflow)', true);
    }

    processQueue();
  }

  function processQueue() {
    if (!sourceBuffer || sourceBuffer.updating || queue.length === 0) return;

    const chunk = queue.shift();
    try {
      sourceBuffer.appendBuffer(chunk);
    } catch (err) {
      if (err.name === 'QuotaExceededError') {
        evictBuffer();
        queue.unshift(chunk);
      } else {
        showError('Buffer append error: ' + err.message);
      }
    }
  }

  function evictBuffer() {
    if (!sourceBuffer || sourceBuffer.updating) return;
    try {
      const buffered = sourceBuffer.buffered;
      if (buffered.length > 0) {
        const removeEnd = buffered.end(buffered.length - 1) - BUFFER_EVICTION_SEC;
        if (removeEnd > buffered.start(0)) {
          sourceBuffer.remove(buffered.start(0), removeEnd);
        }
      }
    } catch {}
  }

  // Live edge seeking — keep video at the live edge
  setInterval(() => {
    if (!video || video.paused || !sourceBuffer) return;

    try {
      const buffered = sourceBuffer.buffered;
      if (buffered.length === 0) return;

      const liveEdge = buffered.end(buffered.length - 1);
      const behind = liveEdge - video.currentTime;

      if (behind > LIVE_EDGE_THRESHOLD) {
        video.currentTime = liveEdge - 0.05;
      }

      // Evict old buffer
      if (liveEdge - buffered.start(0) > BUFFER_EVICTION_SEC) {
        if (!sourceBuffer.updating) {
          sourceBuffer.remove(buffered.start(0), liveEdge - BUFFER_EVICTION_SEC);
        }
      }
    } catch {}
  }, 200);

  // Mute toggle — controls Web Audio API gain
  const muteToggle = document.getElementById('mute-toggle');
  const iconMuted = document.getElementById('icon-muted');
  const iconUnmuted = document.getElementById('icon-unmuted');

  function updateMuteIcon() {
    iconMuted.style.display = isMuted ? 'block' : 'none';
    iconUnmuted.style.display = isMuted ? 'none' : 'block';
  }

  window.toggleMute = function() {
    isMuted = !isMuted;
    if (audioGain) {
      audioGain.gain.value = isMuted ? 0 : 1;
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    updateMuteIcon();
  };

  video.addEventListener('click', () => {
    isMuted = !isMuted;
    if (audioGain) {
      audioGain.gain.value = isMuted ? 0 : 1;
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    updateMuteIcon();
  });

  function scheduleReconnect() {
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    reconnectAttempt++;
    setTimeout(() => connect(), delay);
  }
})();
