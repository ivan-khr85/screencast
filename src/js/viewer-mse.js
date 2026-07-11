// MSE playback module for the WebSocket media fallback. Classic script (no
// modules) — attaches to the shared Viewer namespace like viewer-chat.js /
// viewer-stats.js. When WebRTC can't connect, the server streams fragmented
// MP4 over the signaling WebSocket (binary frames routed here by js/viewer.js)
// and this module feeds it into the <video> through a MediaSource: one muxed
// SourceBuffer, live-edge chasing, buffer eviction and an append queue.
// The core provides deps at init: { onFatal(reason) }.
(function () {
  window.Viewer = window.Viewer || {};

  const video = document.getElementById('video');

  // Safari on iOS (17.1+) only exposes ManagedMediaSource.
  const MSImpl = window.MediaSource || window.ManagedMediaSource || null;

  let deps = {
    onFatal: function () {},
  };

  let ms = null;
  let sb = null;
  let objectUrl = null;
  let queue = [];
  let active = false;
  let bytesReceived = 0;
  let currentMime = null;
  let lastSample = null; // { ts, bytes, frames } for getStats() deltas

  function start(mime) {
    reset();
    currentMime = mime;
    if (!MSImpl || !MSImpl.isTypeSupported(mime)) {
      console.error('[mse] unsupported mime:', mime);
      deps.onFatal('unsupported');
      return;
    }
    active = true;
    ms = new MSImpl();
    ms.addEventListener('sourceopen', function onOpen() {
      ms.removeEventListener('sourceopen', onOpen);
      if (!active || sb) return;
      try {
        sb = ms.addSourceBuffer(mime);
      } catch (err) {
        console.error('[mse] addSourceBuffer failed:', err);
        deps.onFatal('unsupported');
        return;
      }
      sb.mode = 'segments';
      sb.addEventListener('updateend', onUpdateEnd);
      sb.addEventListener('error', () => console.warn('[mse] sourcebuffer error'));
      pump();
    });
    if (!window.MediaSource && window.ManagedMediaSource) {
      // ManagedMediaSource refuses to open without this.
      video.disableRemotePlayback = true;
    }
    objectUrl = URL.createObjectURL(ms);
    video.srcObject = null;
    video.src = objectUrl;
    video.play().catch((err) => { if (err.name !== 'AbortError') console.warn('[mse] video.play() rejected:', err); });
  }

  function appendInit(buf) {
    if (!active) return;
    queue.push(buf);
    pump();
  }

  function appendSegment(buf) {
    if (!active) return;
    bytesReceived += buf.byteLength;
    queue.push(buf);
    // A stalled tab must not accumulate unbounded media. Segments are
    // IDR-aligned, so dropping old ones only skips content.
    while (queue.length > 30) queue.shift();
    pump();
  }

  function pump() {
    if (!active || !sb || sb.updating || queue.length === 0) return;
    if (!ms || ms.readyState !== 'open') return;
    const buf = queue.shift();
    try {
      sb.appendBuffer(buf);
    } catch (err) {
      if (err.name === 'QuotaExceededError') {
        queue.unshift(buf);
        evict(true);
      } else {
        console.warn('[mse] appendBuffer failed:', err);
      }
    }
  }

  function onUpdateEnd() {
    chaseLiveEdge();
    evict(false);
    pump();
  }

  // Live stream: if playback lags the freshest data by more than 3s (tab was
  // hidden, decoder hiccup, skipped segments), jump close to the live edge.
  function chaseLiveEdge() {
    try {
      if (video.buffered.length > 0) {
        const end = video.buffered.end(video.buffered.length - 1);
        if (end - video.currentTime > 3) video.currentTime = end - 0.5;
      }
    } catch {}
  }

  function evict(force) {
    if (!sb || sb.updating) return;
    try {
      if (video.buffered.length === 0) return;
      const start = video.buffered.start(0);
      const span = video.buffered.end(video.buffered.length - 1) - start;
      if (force || span > 30) {
        const removeEnd = Math.max(start, video.currentTime - 10);
        if (removeEnd > start) sb.remove(start, removeEnd);
      }
    } catch {}
  }

  function reset() {
    active = false;
    queue = [];
    bytesReceived = 0;
    currentMime = null;
    lastSample = null;
    if (sb) {
      try { sb.removeEventListener('updateend', onUpdateEnd); } catch {}
      sb = null;
    }
    if (ms) {
      try { if (ms.readyState === 'open') ms.endOfStream(); } catch {}
      ms = null;
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    if (video.getAttribute('src')) {
      video.removeAttribute('src');
      video.load();
    }
  }

  // Measured playback stats (consumed by viewer-stats.js while on the ws
  // transport). Deltas are computed between calls.
  function getStats() {
    const out = { fps: null, kbps: null, bufMs: null };
    try {
      if (video.buffered.length > 0) {
        const end = video.buffered.end(video.buffered.length - 1);
        out.bufMs = Math.max(0, Math.round((end - video.currentTime) * 1000));
      }
      const frames = typeof video.getVideoPlaybackQuality === 'function'
        ? video.getVideoPlaybackQuality().totalVideoFrames
        : null;
      const now = performance.now();
      if (lastSample) {
        const dt = (now - lastSample.ts) / 1000;
        if (dt > 0) {
          out.kbps = Math.max(0, Math.round(((bytesReceived - lastSample.bytes) * 8) / dt / 1000));
          if (frames != null && lastSample.frames != null) {
            out.fps = Math.max(0, Math.round((frames - lastSample.frames) / dt));
          }
        }
      }
      lastSample = { ts: now, bytes: bytesReceived, frames };
    } catch {}
    return out;
  }

  // Raw internals for the debug panel.
  function getDebug() {
    const out = {
      active,
      mime: currentMime,
      queue: queue.length,
      bytes: bytesReceived,
      buffered: null,
      lagMs: null,
    };
    try {
      if (video.buffered.length > 0) {
        const parts = [];
        for (let i = 0; i < video.buffered.length; i++) {
          parts.push(video.buffered.start(i).toFixed(1) + '–' + video.buffered.end(i).toFixed(1));
        }
        out.buffered = parts.join(', ') + ' s';
        out.lagMs = Math.max(0, (video.buffered.end(video.buffered.length - 1) - video.currentTime) * 1000);
      }
    } catch {}
    return out;
  }

  Viewer.mse = {
    init(d) {
      deps = Object.assign(deps, d);
    },
    start,
    appendInit,
    appendSegment,
    reset,
    getStats,
    getDebug,
    isActive() { return active; },
  };
})();
