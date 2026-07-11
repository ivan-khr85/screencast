// Chat module for the browser viewer. Classic script (no modules) — attaches
// to the shared Viewer namespace. Owns all chat UI: panel open/close, drag
// resize (right dock on desktop, bottom sheet on mobile), the name join flow,
// message rendering (avatars + sender + text, textContent only), unread
// badge and sending. The core (js/viewer.js) routes WebSocket messages here
// and provides deps at init: { send(obj), t(key, opts) }.
(function () {
  window.Viewer = window.Viewer || {};

  const chatToggle = document.getElementById('chat-toggle');
  const chatPanel = document.getElementById('chat-panel');
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const chatInputRow = document.getElementById('chat-input-row');
  const chatBadge = document.getElementById('chat-badge');
  const chatNameRow = document.getElementById('chat-name-row');
  const chatNameInput = document.getElementById('chat-name-input');
  const chatNameError = document.getElementById('chat-name-error');
  const chatResizeHandle = document.getElementById('chat-resize-handle');

  // Filled in by init(); safe no-op defaults so early events can't throw.
  let deps = {
    send: function () {},
    t: function (key) { return key; },
  };

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
    if (!name) return;
    deps.send({ type: 'set_name', name: name });
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
      chatNameError.textContent = deps.t(['viewer.chat.nameError.' + (msg.code || 'generic'), 'viewer.chat.nameError.generic']);
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
    if (!text || !myName) return;
    deps.send({ type: 'chat', message: text });
    chatInput.value = '';
    chatInput.focus();
  }
  document.getElementById('chat-send')?.addEventListener('click', sendChat);

  chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
  });

  // Drag handle to resize the chat panel. Pointer events cover mouse and
  // touch in one code path; capture keeps move/up on the handle itself.
  // Desktop: the panel is a right dock (anchored right, full height) — the
  // left-edge handle drags width. Mobile: the panel is a bottom sheet — the
  // top handle drags height.
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
    if (window.innerWidth > 600) {
      // Right-anchored dock: dragging left (negative dx) widens the panel
      const dx = e.clientX - resizeStartX;
      const newW = Math.max(240, Math.min(window.innerWidth - 30, resizeStartW - dx));
      chatPanel.style.width = newW + 'px';
    } else {
      // Bottom sheet: dragging up (negative dy) makes it taller
      const dy = e.clientY - resizeStartY;
      const newH = Math.max(200, Math.min(window.innerHeight - 80, resizeStartH - dy));
      chatPanel.style.height = newH + 'px';
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

  // Deterministic avatar hue from the sender name (stable across renders)
  const HUE_COUNT = 6;
  function hueIndex(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return h % HUE_COUNT;
  }

  function initialsFor(name) {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    if (words.length === 1) return words[0].charAt(0).toUpperCase();
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  }

  function addChatMessage(sender, text) {
    const el = document.createElement('div');
    el.className = 'chat-msg';
    if (sender === 'Host') el.classList.add('chat-host');
    const av = document.createElement('span');
    av.className = 'chat-avatar ' + (sender === 'Host' ? 'chat-avatar-host' : 'hue-' + hueIndex(sender));
    av.setAttribute('aria-hidden', 'true');
    av.textContent = initialsFor(sender);
    const s = document.createElement('span');
    s.className = 'chat-sender';
    s.textContent = sender;
    const t = document.createElement('span');
    t.className = 'chat-text';
    t.textContent = text;
    el.appendChild(av);
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

  Viewer.chat = {
    init(d) {
      deps = Object.assign(deps, d);
    },
    // ws message entry points (called by the core)
    addMessage: addChatMessage,
    onNameResult: handleNameResult,
    setEnabled: handleChatEnabled,
    // Called by the core at the start of every (re)connect — resets the
    // per-connection name state exactly like the old inline code did.
    resetForConnect() {
      myName = null;
      chatNameRow.style.display = 'flex';
      chatInputRow.style.display = 'none';
      chatNameError.style.display = 'none';
    },
    // Called after a successful re-auth so the user keeps their chat name.
    resendName() {
      if (savedName) deps.send({ type: 'set_name', name: savedName });
    },
  };
})();
