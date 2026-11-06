// Chat badge: sums the unread counts from /api/chat/threads and shows
// them on the Chat link in the top bar. Hidden when logged out.
(function () {
  'use strict';
  async function updateChatBadge() {
    var link = document.getElementById('chat-link');
    if (!link) return;
    var badge = document.getElementById('chat-badge');
    try {
      var res = await fetch('/api/chat/threads');
      if (res.status !== 200) { link.hidden = true; return; }
      var data = await res.json();
      link.hidden = false;
      var n = (data.threads || []).reduce(function (a, t) { return a + (t.unread_count || 0); }, 0);
      if (badge) {
        badge.hidden = n === 0;
        badge.textContent = n > 99 ? '99+' : String(n);
      }
    } catch (e) { link.hidden = true; }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateChatBadge);
  } else { updateChatBadge(); }
  window.updateChatBadge = updateChatBadge;
})();
