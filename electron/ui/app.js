(function() {
  let streaming = false;

  const els = {
    settings: document.getElementById('settings'),
    startBtn: document.getElementById('startBtn'),
    error: document.getElementById('error'),
    streamInfo: document.getElementById('stream-info'),
    streamUrl: document.getElementById('stream-url'),
    streamPassword: document.getElementById('stream-password'),
    viewerCount: document.getElementById('viewer-count'),
    audioNote: document.getElementById('audio-note'),
  };

  const LATENCY_BITRATES = { 'ultra-low': '15000k', 'medium': '10000k', 'slow': '5000k' };
  document.getElementById('latency').addEventListener('change', function() {
    document.getElementById('bitrate').value = LATENCY_BITRATES[this.value] || '10000k';
  });

  // Load initial status
  window.api.getStatus().then(updateUI);

  // Listen for live updates
  window.api.onStatusUpdate(updateUI);

  function updateUI(status) {
    streaming = status.running;

    if (streaming) {
      els.startBtn.textContent = 'Stop Stream';
      els.startBtn.className = 'btn btn-stop';
      els.startBtn.disabled = false;
      els.settings.classList.add('hidden');
      els.streamInfo.classList.remove('hidden');
      els.error.classList.add('hidden');

      els.streamUrl.textContent = status.url || '';
      els.streamPassword.textContent = status.password || '';
      els.viewerCount.textContent = `${status.viewers} / ${status.maxViewers}`;
      const liveToggle = document.getElementById('chat-live-toggle');
      if (liveToggle && !liveToggle._initialized) {
        liveToggle.checked = document.getElementById('chat').checked;
        liveToggle._initialized = true;
      }

      if (!status.hasAudio) {
        els.audioNote.classList.remove('hidden');
      } else {
        els.audioNote.classList.add('hidden');
      }
    } else {
      els.startBtn.textContent = 'Start Stream';
      els.startBtn.className = 'btn btn-start';
      els.startBtn.disabled = false;
      els.settings.classList.remove('hidden');
      els.streamInfo.classList.add('hidden');

      if (status.error) {
        els.error.textContent = status.error;
        els.error.classList.remove('hidden');
      } else {
        els.error.classList.add('hidden');
      }
    }
  }

  // Expose toggleStream globally for onclick
  window.toggleStream = async function() {
    const btn = els.startBtn;

    if (streaming) {
      btn.disabled = true;
      btn.textContent = 'Stopping...';
      await window.api.stopStream();
    } else {
      btn.disabled = true;
      btn.textContent = 'Starting...';

      const config = {
        port: parseInt(document.getElementById('port').value, 10),
        fps: parseInt(document.getElementById('fps').value, 10),
        bitrate: document.getElementById('bitrate').value,
        quality: document.getElementById('quality').value,
        latency: document.getElementById('latency').value,
        password: document.getElementById('password').value,
        maxViewers: parseInt(document.getElementById('maxViewers').value, 10),
        audio: document.getElementById('audio').checked,
        tunnel: document.getElementById('tunnel').checked,
        chat: document.getElementById('chat').checked,
      };

      const result = await window.api.startStream(config);

      if (!result.success) {
        els.error.textContent = result.error;
        els.error.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'Start Stream';
      }
    }
  };

  window.toggleLiveChat = function(enabled) {
    window.api.setChat(enabled);
  };

  window.copyField = function(field, btnEl) {
    let text;
    if (field === 'url') {
      text = els.streamUrl.textContent;
    } else if (field === 'link') {
      const url = els.streamUrl.textContent;
      const pwd = els.streamPassword.textContent;
      text = url + '#' + pwd;
    } else {
      text = els.streamPassword.textContent;
    }
    window.api.copyToClipboard(text);
    const original = btnEl.textContent;
    btnEl.textContent = 'Copied!';
    setTimeout(() => { btnEl.textContent = original; }, 1200);
  };
})();
