// Kiraya Register chat — WhatsApp-like thread per tenancy.
// Polling only: the open chat fetches ?since=<last-ms> every 5 seconds,
// the thread list every 15 seconds. No websockets, no typing indicator,
// no online / last seen, no message delete (the record is the proof).
// Every user string is escaped with escHtml before it touches innerHTML;
// links in messages render as plain text, never clickable HTML.
(function () {
  'use strict';
  var me = null;
  var tenancyId = null;
  var lastMs = 0;
  var pollTimer = null;
  var listTimer = null;

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtTime(ms) {
    var d = new Date(ms);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function tickHtml(m) {
    // Only the sender sees ticks, on their own messages.
    if (m.sender_id !== (me && me.id)) return '';
    if (m.ticks === 'read') return ' <span class="ticks read" title="They opened this chat">✓✓</span>';
    if (m.ticks === 'delivered') return ' <span class="ticks" title="Their app fetched the message">✓✓</span>';
    return ' <span class="ticks" title="Stored on the server">✓</span>';
  }
  function bubbleHtml(m) {
    var own = m.sender_id === (me && me.id);
    var inner = '';
    if (m.photo_url) {
      inner += '<img src="' + escHtml(m.photo_url) + '" alt="Photo message" loading="lazy">';
    }
    if (m.body) inner += '<div class="bubble-text">' + escHtml(m.body) + '</div>';
    inner += '<div class="bubble-meta"><span class="time">' + escHtml(fmtTime(m.created_at)) + '</span>' + tickHtml(m) + '</div>';
    return '<div class="bubble ' + (own ? 'own' : 'theirs') + '">' + inner + '</div>';
  }
  function renderMessages(list, append) {
    var box = document.getElementById('messages');
    if (!append) box.innerHTML = '';
    for (var i = 0; i < list.length; i++) {
      box.insertAdjacentHTML('beforeend', bubbleHtml(list[i]));
      if (list[i].created_at > lastMs) lastMs = list[i].created_at;
    }
    box.scrollTop = box.scrollHeight;
  }
  async function fetchMessages(since) {
    var url = '/api/chat/' + tenancyId + '/messages' + (since ? '?since=' + since : '');
    var res = await fetch(url);
    if (res.status === 401) { window.location.href = '/login'; return []; }
    if (!res.ok) return [];
    var data = await res.json();
    return data.messages || [];
  }
  async function loadThread() {
    lastMs = 0;
    var list = await fetchMessages(0);
    renderMessages(list, false);
  }
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async function () {
      var list = await fetchMessages(lastMs);
      if (list.length) renderMessages(list, true);
      if (window.updateChatBadge) window.updateChatBadge();
    }, 5000);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function loadThreads() {
    var box = document.getElementById('threads');
    var res = await fetch('/api/chat/threads');
    if (res.status === 401) { window.location.href = '/login'; return; }
    if (!res.ok) { box.innerHTML = '<p class="error">Could not load chats.</p>'; return; }
    var data = await res.json();
    var threads = data.threads || [];
    if (!threads.length) {
      box.innerHTML = '<p class="muted">No active chats yet. Chat starts after your owner approves the link — a requested tenancy has no chat.</p>';
      return;
    }
    var html = '';
    for (var i = 0; i < threads.length; i++) {
      var t = threads[i];
      var preview = t.last_message
        ? (t.last_message.photo_url ? '📷 Photo' : t.last_message.body)
        : 'No messages yet';
      var badge = t.unread_count
        ? ' <span class="badge">' + escHtml(String(t.unread_count)) + '</span>' : '';
      html += '<a class="chat-thread" href="/chat?id=' + t.tenancy_id + '">'
        + '<span class="chat-thread-name">' + escHtml(t.other_name) + badge + '</span>'
        + '<span class="chat-thread-sub">' + escHtml(t.house_title) + '</span>'
        + '<span class="chat-thread-preview">' + escHtml(preview) + '</span>'
        + '</a>';
    }
    box.innerHTML = html;
  }
  function startListPolling() {
    if (listTimer) return;
    listTimer = setInterval(function () { if (!tenancyId) loadThreads(); }, 15000);
  }

  async function openThread(id) {
    tenancyId = id;
    document.getElementById('thread-view').hidden = false;
    var res = await fetch('/api/chat/threads');
    var data = await res.json();
    var t = (data.threads || []).find(function (x) { return x.tenancy_id === id; });
    if (t) {
      document.getElementById('thread-title').textContent = t.house_title + ' — ' + t.other_name;
      document.getElementById('thread-sub').textContent = 'Tenancy active since ' + t.tenancy_active_since;
    } else {
      document.getElementById('thread-title').textContent = 'Chat';
      document.getElementById('thread-sub').textContent = '';
    }
    await loadThread();
    startPolling();
  }

  async function sendText(ev) {
    ev.preventDefault();
    var input = document.getElementById('chat-input');
    var msg = document.getElementById('chat-msg');
    var body = input.value;
    if (!body.trim()) { msg.textContent = 'Type a message first.'; return; }
    if (body.length > 2000) { msg.textContent = 'Message is too long (max 2000 characters).'; return; }
    var res;
    try {
      res = await fetch('/api/chat/' + tenancyId + '/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: body }),
      });
    } catch (e) {
      msg.textContent = 'Could not reach the server. Please try again.';
      return;
    }
    if (res.status === 401) { window.location.href = '/login'; return; }
    if (!res.ok) {
      var err = {};
      try { err = await res.json(); } catch (e) { /* ignore */ }
      msg.textContent = err.error || 'Could not send the message.';
      return;
    }
    input.value = '';
    msg.textContent = '';
    var list = await fetchMessages(lastMs);
    if (list.length) renderMessages(list, true);
  }

  async function sendPhoto(file) {
    var msg = document.getElementById('chat-msg');
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { msg.textContent = 'Photo is too large — max 5MB.'; return; }
    var fd = new FormData();
    fd.append('photo', file);
    var res;
    try {
      res = await fetch('/api/chat/' + tenancyId + '/messages/photo', { method: 'POST', body: fd });
    } catch (e) {
      msg.textContent = 'Could not reach the server. Please try again.';
      return;
    }
    if (res.status === 401) { window.location.href = '/login'; return; }
    if (!res.ok) {
      var err = {};
      try { err = await res.json(); } catch (e) { /* ignore */ }
      msg.textContent = err.error || 'Could not send the photo.';
      return;
    }
    msg.textContent = '';
    var list = await fetchMessages(lastMs);
    if (list.length) renderMessages(list, true);
  }

  async function init() {
    var meRes = await fetch('/api/auth/me');
    if (meRes.status !== 200) { window.location.href = '/login'; return; }
    var meData = await meRes.json();
    me = meData.user;
    await loadThreads();
    startListPolling();
    var params = new URLSearchParams(window.location.search);
    var id = Number(params.get('id'));
    if (id) await openThread(id);
    document.getElementById('composer').addEventListener('submit', sendText);
    document.getElementById('photo-input').addEventListener('change', function (ev) {
      var file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      sendPhoto(file);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
