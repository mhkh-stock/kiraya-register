// Notification bell: fetches the unread count and shows the badge.
// Hidden when logged out or when there are zero unread notifications.
(function () {
  'use strict';
  async function updateBell() {
    var bell = document.getElementById('bell');
    if (!bell) return;
    var badge = document.getElementById('bell-badge');
    try {
      var res = await fetch('/api/notifications');
      if (res.status !== 200) { bell.hidden = true; return; }
      var data = await res.json();
      bell.hidden = false;
      var n = data.unread_count || 0;
      if (badge) {
        badge.hidden = n === 0;
        badge.textContent = n > 99 ? '99+' : String(n);
      }
    } catch (e) { bell.hidden = true; }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateBell);
  } else { updateBell(); }
})();
