// Stats module for the browser viewer. Classic script (no modules) — attaches
// to the shared Viewer namespace. Owns the stats overlay: WebRTC getStats()
// polling, measured fps/bitrate/loss/jitter-buffer numbers, rendering (via
// textContent only — server-sent viewer counts must never become markup),
// the toggle button and visibility persistence (through deps.savePrefs).
// The core (js/viewer.js) provides deps at init:
// { t, getPc, isAuthenticated, getStreamInfo, savePrefs, visible }.
(function () {
  window.Viewer = window.Viewer || {};

  const video = document.getElementById('video');
  const playerScreen = document.getElementById('player-screen');
  const statsEl = document.getElementById('stream-stats');
  const statsToggle = document.getElementById('stats-toggle');

  // Filled in by init(); safe defaults so the intervals can't throw early.
  let deps = {
    t: function (key) { return key; },
    getPc: function () { return null; },
    isAuthenticated: function () { return false; },
    getStreamInfo: function () { return { viewers: null, maxViewers: null }; },
    savePrefs: function () {},
  };

  let statsVisible = false;

  // Measured playback stats (real fps/bitrate/loss from WebRTC, not the
  // configured values the server advertises)
  let lastRtp = null;
  let measured = { fps: null, kbps: null, lossPct: null, bufMs: null };

  function resetMeasuredStats() {
    lastRtp = null;
    measured = { fps: null, kbps: null, lossPct: null, bufMs: null };
  }

  setInterval(() => {
    const pc = deps.getPc();
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
      ? (kbps / 1000).toFixed(1) + ' ' + deps.t('viewer.stats.mbps')
      : kbps + ' ' + deps.t('viewer.stats.kbps');
  }

  function updateStats() {
    if (!statsVisible || !deps.isAuthenticated() || playerScreen.style.display === 'none') {
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
      parts.push([String(measured.fps), ' ' + deps.t('viewer.stats.fps')]);
    }

    if (measured.kbps != null) {
      parts.push([formatBitrate(measured.kbps), '']);
    }

    if (measured.lossPct != null && measured.lossPct > 0) {
      parts.push([measured.lossPct + '%', ' ' + deps.t('viewer.stats.loss')]);
    }

    if (measured.bufMs != null) {
      parts.push([measured.bufMs + ' ms', ' ' + deps.t('viewer.stats.buffer')]);
    }

    const streamInfo = deps.getStreamInfo();
    if (streamInfo.viewers != null) {
      const cap = streamInfo.maxViewers != null ? `/${streamInfo.maxViewers}` : '';
      // i18next picks the plural form from count — Ukrainian has four
      parts.push([`${streamInfo.viewers}${cap}`, ' ' + deps.t('viewer.stats.viewersSuffix', { count: streamInfo.viewers })]);
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
    statsToggle.setAttribute('aria-label', deps.t(statsVisible ? 'viewer.stats.hide' : 'viewer.stats.show'));
  }

  function toggleStats() {
    statsVisible = !statsVisible;
    statsToggle.classList.toggle('active', statsVisible);
    syncStatsAria();
    deps.savePrefs();
    updateStats();
  }
  statsToggle.addEventListener('click', toggleStats);

  Viewer.stats = {
    init(d) {
      deps = Object.assign(deps, d);
      if (typeof d.visible === 'boolean') statsVisible = d.visible;
      statsToggle.classList.toggle('active', statsVisible);
    },
    toggle: toggleStats,
    isVisible() { return statsVisible; },
    resetMeasured: resetMeasuredStats,
    // Re-renders language-dependent bits (aria label + overlay text)
    refresh() {
      syncStatsAria();
      updateStats();
    },
  };
})();
