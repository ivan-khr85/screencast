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

  let isMuted = true; // Start muted (browser autoplay policy)

  // --- Audio state (Web Audio API / AudioWorklet) ---
  let audioCtx = null;
  let audioWorkletNode = null;
  let audioGain = null;
  let hasAudio = false;
  let audioSampleRate = 48000;
  let audioChannels = 2;

  // AudioWorklet processor code — runs in a separate thread
  const WORKLET_CODE = `
class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sr = options.processorOptions?.sampleRate || 48000;
    const ch = options.processorOptions?.channels || 2;

    // 1 second ring buffer (room for network jitter)
    this._bufSize = sr * ch * 1;
    this._buf = new Float32Array(this._bufSize);
    this._writePos = 0;
    this._readPos = 0;
    this._channels = ch;

    // Max buffer before skip: 300ms
    this._maxSamples = sr * ch * 0.3;
    // Keep after skip: 100ms
    this._keepSamples = ch * Math.ceil(sr * 0.1);
    // Initial buffering: wait for 80ms before starting
    this._initialThreshold = sr * ch * 0.08;
    this._started = false;

    this.port.onmessage = (e) => {
      if (e.data instanceof Float32Array) {
        this._write(e.data);
      }
    };
  }

  _write(data) {
    for (let i = 0; i < data.length; i++) {
      this._buf[this._writePos] = data[i];
      this._writePos = (this._writePos + 1) % this._bufSize;
      // If write catches up to read, advance read (drop oldest)
      if (this._writePos === this._readPos) {
        this._readPos = (this._readPos + 1) % this._bufSize;
      }
    }
  }

  _available() {
    let avail = this._writePos - this._readPos;
    if (avail < 0) avail += this._bufSize;
    return avail;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frameCount = output[0].length;
    const ch = output.length;
    const avail = this._available();

    // Initial buffering — wait until we have enough data
    if (!this._started) {
      if (avail < this._initialThreshold) {
        // Output silence
        for (let c = 0; c < ch; c++) output[c].fill(0);
        return true;
      }
      this._started = true;
    }

    // Skip ahead if too far behind (> 300ms buffered)
    if (avail > this._maxSamples) {
      const skip = avail - this._keepSamples;
      this._readPos = (this._readPos + skip) % this._bufSize;
    }

    const currentAvail = this._available();
    const samplesToRead = Math.min(frameCount * this._channels, currentAvail);
    const framesToFill = Math.floor(samplesToRead / this._channels);

    for (let i = 0; i < framesToFill; i++) {
      for (let c = 0; c < ch; c++) {
        const idx = c < this._channels ? c : 0;
        const readIdx = (this._readPos + i * this._channels + idx) % this._bufSize;
        output[c][i] = this._buf[readIdx];
      }
    }
    this._readPos = (this._readPos + framesToFill * this._channels) % this._bufSize;

    // Fill remaining with silence if underrun
    for (let i = framesToFill; i < frameCount; i++) {
      for (let c = 0; c < ch; c++) output[c][i] = 0;
    }

    return true;
  }
}
registerProcessor('pcm-player-processor', PCMPlayerProcessor);
`;

  async function initAudio() {
    if (audioCtx) return;
    try {
      audioCtx = new AudioContext({ sampleRate: audioSampleRate });
      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      audioWorkletNode = new AudioWorkletNode(audioCtx, 'pcm-player-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [audioChannels],
        processorOptions: { sampleRate: audioSampleRate, channels: audioChannels },
      });

      audioGain = audioCtx.createGain();
      audioGain.gain.value = isMuted ? 0 : 1;
      audioWorkletNode.connect(audioGain);
      audioGain.connect(audioCtx.destination);
    } catch (err) {
      console.error('Failed to init AudioWorklet:', err);
    }
  }

  function feedAudio(pcmData) {
    if (!audioWorkletNode) return;
    // pcmData is a Uint8Array of raw f32le PCM
    const f32 = new Float32Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 4);
    audioWorkletNode.port.postMessage(f32, [f32.buffer]);
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
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
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

  // Mute toggle — controls audioGain (Web Audio API) when audio is available,
  // falls back to video.muted otherwise
  const muteToggle = document.getElementById('mute-toggle');
  const iconMuted = document.getElementById('icon-muted');
  const iconUnmuted = document.getElementById('icon-unmuted');

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
    muteToggle.style.display = 'none';

    setStatus('Connecting...', 'reconnecting');
    ws = new WebSocket(getWsUrl());
    ws.binaryType = 'arraybuffer';
    authenticated = false;
    hasAudio = false;
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

    // Always mute the video element — audio is handled by Web Audio API
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
            muteToggle.style.display = 'flex';
            updateMuteIcon();
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

    if (!(data instanceof ArrayBuffer) || data.byteLength < 2) return;

    const view = new Uint8Array(data);
    const tag = view[0];
    const payload = view.subarray(1);

    if (tag === 0x01) {
      // Audio PCM data
      feedAudio(payload);
      return;
    }

    // tag === 0x00: Video data
    // First binary video message is the init segment (ftyp + moov)
    if (!initSegment) {
      initSegment = payload;
      dbg('received init segment:', payload.length, 'bytes, MediaSource.readyState=' + mediaSource.readyState);
      createSourceBuffer(payload);
      return;
    }

    appendBuffer(payload);
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

  function updateMuteIcon() {
    iconMuted.style.display = isMuted ? 'block' : 'none';
    iconUnmuted.style.display = isMuted ? 'none' : 'block';
  }

  window.toggleMute = function() {
    isMuted = !isMuted;
    if (audioGain) {
      audioGain.gain.value = isMuted ? 0 : 1;
    }
    // Resume AudioContext if suspended (browser autoplay policy)
    if (!isMuted && audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    updateMuteIcon();
  };

  video.addEventListener('click', () => {
    isMuted = !isMuted;
    if (audioGain) {
      audioGain.gain.value = isMuted ? 0 : 1;
    }
    if (!isMuted && audioCtx && audioCtx.state === 'suspended') {
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
