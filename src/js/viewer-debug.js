// Debug panel for the browser viewer. Classic script (no modules) — attaches
// to the shared Viewer namespace. Renders a host-gated panel with the full
// connection/playback internals: transport, WebRTC states + selected ICE
// pair, inbound RTP counters, MSE buffer state, player state, environment.
// Everything is rendered via textContent (convention: no innerHTML). The
// host toggles availability at runtime (`debug_enabled` WS message routed
// here by js/viewer.js). Field names stay in English on purpose — they are
// technical identifiers; only the chrome (title/buttons) is localized.
// The core provides deps at init: { t, getState() }.
(function () {
  window.Viewer = window.Viewer || {};

  const toggle = document.getElementById('debug-toggle');
  const panel = document.getElementById('debug-panel');
  const body = document.getElementById('debug-body');
  const closeBtn = document.getElementById('debug-close');
  const copyBtn = document.getElementById('debug-copy');
  const video = document.getElementById('video');

  let deps = {
    t: function (key) { return key; },
    getState: function () { return {}; },
  };

  let enabled = false;
  let open = false;
  let rows = []; // last rendered [label, value] pairs for the copy button
  let webrtcStats = null; // async getStats() snapshot, refreshed each tick

  function setEnabled(on) {
    enabled = !!on;
    toggle.style.display = enabled ? '' : 'none';
    if (!enabled) setOpen(false);
  }

  function setOpen(on) {
    open = !!on;
    panel.classList.toggle('visible', open);
    toggle.classList.toggle('active', open);
    if (open) render();
  }

  toggle.addEventListener('click', () => setOpen(!open));
  closeBtn.addEventListener('click', () => setOpen(false));
  copyBtn.addEventListener('click', () => {
    const text = rows.map(([k, v]) => (k === '' ? '' : k === null ? `== ${v} ==` : `${k}: ${v}`)).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = deps.t('common.copied');
      setTimeout(() => { copyBtn.textContent = deps.t('common.copy'); }, 1500);
    }).catch(() => {});
  });

  function fmtBytes(n) {
    if (n == null) return '—';
    if (n > 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    if (n > 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  function fmtMs(n) {
    return n == null ? '—' : Math.round(n) + ' ms';
  }

  // Async WebRTC stats snapshot: selected pair, per-kind inbound RTP, codecs.
  function sampleWebRTCStats(pc) {
    pc.getStats().then((stats) => {
      const snap = { pair: null, video: null, audio: null, codecs: {} };
      let selectedPairId = null;
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) selectedPairId = r.selectedCandidatePairId;
        if (r.type === 'codec') snap.codecs[r.id] = r.mimeType + (r.sdpFmtpLine ? ` (${r.sdpFmtpLine})` : '');
      });
      let pairReport = null;
      stats.forEach((r) => {
        if (r.type !== 'candidate-pair') return;
        if (r.id === selectedPairId) pairReport = r;
        else if (!selectedPairId && !pairReport && (r.selected === true || (r.nominated && r.state === 'succeeded'))) pairReport = r;
      });
      if (pairReport) {
        const pair = {
          rttMs: pairReport.currentRoundTripTime != null ? pairReport.currentRoundTripTime * 1000 : null,
          bytesReceived: pairReport.bytesReceived,
          local: null,
          remote: null,
        };
        stats.forEach((r) => {
          if (r.id === pairReport.localCandidateId) pair.local = `${r.candidateType} ${r.protocol || ''} ${r.address || r.ip || '?'}:${r.port || '?'}`;
          if (r.id === pairReport.remoteCandidateId) pair.remote = `${r.candidateType} ${r.protocol || ''} ${r.address || r.ip || '?'}:${r.port || '?'}`;
        });
        snap.pair = pair;
      }
      stats.forEach((r) => {
        if (r.type !== 'inbound-rtp') return;
        const entry = {
          codec: snap.codecs[r.codecId] || null,
          packetsReceived: r.packetsReceived,
          packetsLost: r.packetsLost,
          bytesReceived: r.bytesReceived,
          jitterMs: r.jitter != null ? r.jitter * 1000 : null,
          framesDecoded: r.framesDecoded,
          framesDropped: r.framesDropped,
          keyFramesDecoded: r.keyFramesDecoded,
          framesPerSecond: r.framesPerSecond,
          frameSize: r.frameWidth ? `${r.frameWidth}x${r.frameHeight}` : null,
          nackCount: r.nackCount,
          pliCount: r.pliCount,
          jitterBufferMs: (r.jitterBufferDelay != null && r.jitterBufferEmittedCount > 0)
            ? (r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000 : null,
        };
        if (r.kind === 'video') snap.video = entry;
        else if (r.kind === 'audio') snap.audio = entry;
      });
      webrtcStats = snap;
    }).catch(() => {});
  }

  // Build [label, value] rows. label === null → section heading row.
  function collectRows() {
    const s = deps.getState();
    const out = [];

    out.push([null, 'Connection']);
    out.push(['transport', s.transport || '—']);
    out.push(['websocket', s.wsReadyState || '—']);
    out.push(['authenticated', String(!!s.authenticated)]);
    out.push(['reconnect attempt', String(s.reconnectAttempt ?? 0)]);
    out.push(['webrtc fail cycles', String(s.webrtcFailCycles ?? 0)]);
    out.push(['prefer fallback', String(!!s.preferFallback)]);
    out.push(['last server msg', fmtMs(s.lastMessageAgeMs)]);
    out.push(['page', location.protocol + '//' + location.host]);

    if (s.streamInfo) {
      out.push([null, 'Stream (advertised)']);
      out.push(['fps', s.streamInfo.fps != null ? String(s.streamInfo.fps) : '—']);
      out.push(['bitrate', s.streamInfo.bitrate || '—']);
      out.push(['audio', String(!!s.hasAudio)]);
      out.push(['viewers', s.streamInfo.viewers != null ? `${s.streamInfo.viewers}${s.streamInfo.maxViewers != null ? '/' + s.streamInfo.maxViewers : ''}` : '—']);
    }

    const pc = s.pc;
    if (pc) {
      out.push([null, 'WebRTC']);
      out.push(['connection', pc.connectionState]);
      out.push(['ice', pc.iceConnectionState]);
      out.push(['ice gathering', pc.iceGatheringState]);
      out.push(['signaling', pc.signalingState]);
      const w = webrtcStats;
      if (w && w.pair) {
        out.push(['pair local', w.pair.local || '—']);
        out.push(['pair remote', w.pair.remote || '—']);
        out.push(['rtt', fmtMs(w.pair.rttMs)]);
      }
      const dumpRtp = (label, r) => {
        if (!r) return;
        out.push([null, label]);
        if (r.codec) out.push(['codec', r.codec]);
        if (r.frameSize) out.push(['frame size', r.frameSize]);
        if (r.framesPerSecond != null) out.push(['fps', String(r.framesPerSecond)]);
        out.push(['packets', `${r.packetsReceived ?? '—'} recv / ${r.packetsLost ?? 0} lost`]);
        out.push(['bytes', fmtBytes(r.bytesReceived)]);
        out.push(['jitter', fmtMs(r.jitterMs)]);
        if (r.jitterBufferMs != null) out.push(['jitter buffer', fmtMs(r.jitterBufferMs)]);
        if (r.framesDecoded != null) out.push(['frames', `${r.framesDecoded} dec / ${r.framesDropped ?? 0} drop / ${r.keyFramesDecoded ?? '—'} key`]);
        if (r.nackCount != null) out.push(['nack / pli', `${r.nackCount} / ${r.pliCount ?? 0}`]);
      };
      if (w) {
        dumpRtp('Video RTP', w.video);
        dumpRtp('Audio RTP', w.audio);
      }
    }

    if (s.transport === 'ws' && window.Viewer && Viewer.mse) {
      const m = Viewer.mse.getDebug();
      out.push([null, 'MSE (WS fallback)']);
      out.push(['active', String(m.active)]);
      out.push(['mime', m.mime || '—']);
      out.push(['buffered', m.buffered || '—']);
      out.push(['live lag', fmtMs(m.lagMs)]);
      out.push(['append queue', String(m.queue)]);
      out.push(['received', fmtBytes(m.bytes)]);
    }

    out.push([null, 'Player']);
    out.push(['ready state', String(video.readyState)]);
    out.push(['resolution', video.videoWidth ? `${video.videoWidth}x${video.videoHeight}` : '—']);
    out.push(['current time', video.currentTime.toFixed(1) + ' s']);
    out.push(['paused / muted', `${video.paused} / ${video.muted}`]);
    if (typeof video.getVideoPlaybackQuality === 'function') {
      const q = video.getVideoPlaybackQuality();
      out.push(['playback frames', `${q.totalVideoFrames} total / ${q.droppedVideoFrames} dropped`]);
    }

    out.push([null, 'Environment']);
    out.push(['media source', window.MediaSource ? 'MediaSource' : window.ManagedMediaSource ? 'ManagedMediaSource' : 'none']);
    out.push(['user agent', navigator.userAgent]);

    return out;
  }

  function render() {
    if (!open || !enabled) return;
    const s = deps.getState();
    if (s.pc) sampleWebRTCStats(s.pc); // async — lands next tick
    rows = collectRows();
    body.textContent = '';
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      if (label === null) {
        row.className = 'debug-section';
        row.textContent = value;
      } else {
        row.className = 'debug-row';
        const k = document.createElement('span');
        k.className = 'debug-key';
        k.textContent = label;
        const v = document.createElement('span');
        v.className = 'debug-value';
        v.textContent = value;
        row.appendChild(k);
        row.appendChild(v);
      }
      body.appendChild(row);
    }
  }

  setInterval(() => { if (open && enabled) render(); }, 1000);

  function syncI18n() {
    toggle.setAttribute('aria-label', deps.t('viewer.debug.open'));
    copyBtn.textContent = deps.t('common.copy');
  }

  Viewer.debug = {
    init(d) {
      deps = Object.assign(deps, d);
      syncI18n();
    },
    setEnabled,
    refresh: syncI18n,
  };
})();
