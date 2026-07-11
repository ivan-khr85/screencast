// Host chat panel: expand/collapse, unread badge, message rendering, send.
(function () {
  'use strict';
  const { els, state } = window.App;

  let chatUnreadCount = 0;
  let chatExpanded = false;

  function setChatExpanded(expanded) {
    chatExpanded = expanded;
    els.chatHeader.setAttribute('aria-expanded', String(expanded));
    els.chatBody.classList.toggle('hidden', !expanded);
    if (expanded) {
      chatUnreadCount = 0;
      els.chatUnread.classList.add('hidden');
      els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
      els.chatInput.focus();
    }
  }

  els.chatHeader.addEventListener('click', () => setChatExpanded(!chatExpanded));

  // Deterministic hue bucket so a sender keeps the same avatar color for
  // the whole session (and across sessions).
  function senderHue(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) {
      h = (h * 31 + name.charCodeAt(i)) >>> 0;
    }
    return h % 6;
  }

  function senderInitials(name) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    const initials = parts.slice(0, 2).map((w) => w[0]).join('');
    return (initials || '?').toUpperCase();
  }

  function addChatMessage(sender, message) {
    const el = document.createElement('div');
    el.className = 'chat-msg';
    if (sender === 'Host') el.classList.add('chat-host');
    const avatar = document.createElement('span');
    avatar.className = 'chat-avatar ' + (sender === 'Host' ? 'hue-host' : 'hue-' + senderHue(sender));
    avatar.textContent = senderInitials(sender);
    const s = document.createElement('span');
    s.className = 'chat-sender';
    s.textContent = sender;
    const txt = document.createElement('span');
    txt.className = 'chat-text';
    txt.textContent = message;
    el.appendChild(avatar);
    el.appendChild(s);
    el.appendChild(txt);
    els.chatMessages.appendChild(el);
    while (els.chatMessages.children.length > 100) {
      els.chatMessages.removeChild(els.chatMessages.firstChild);
    }
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;

    if (!chatExpanded && sender !== 'Host') {
      chatUnreadCount++;
      els.chatUnread.textContent = chatUnreadCount > 9 ? '9+' : String(chatUnreadCount);
      els.chatUnread.classList.remove('hidden');
    }
  }

  window.api.onChatMessage?.((msg) => {
    if (msg && msg.sender && msg.message) addChatMessage(msg.sender, msg.message);
  });

  async function sendChat() {
    const text = els.chatInput.value.trim();
    if (!text || !state.streaming) return;
    const result = await window.api.sendChatMessage(text);
    if (result && result.success) {
      // #broadcastChat only reaches viewers — echo our own message locally
      addChatMessage('Host', text);
      els.chatInput.value = '';
    }
    els.chatInput.focus();
  }

  els.chatSend.addEventListener('click', sendChat);
  els.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
  });

  els.chatLiveToggle.addEventListener('change', function () {
    window.api.setChat(this.checked);
  });

  // Clears per-stream chat state when a new session starts.
  function resetSession() {
    els.chatMessages.textContent = '';
    chatUnreadCount = 0;
    els.chatUnread.classList.add('hidden');
  }

  window.App.chat = {
    addChatMessage,
    setExpanded: setChatExpanded,
    resetSession,
  };
})();
