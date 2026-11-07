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

// Log out: the link is a real logout (POST /api/auth/logout), not a
// plain jump to /login — otherwise the session would stay alive and
// the next person on this browser would land straight in the account.
(function () {
  'use strict';
  function wireLogout() {
    var link = document.getElementById('logout-link');
    if (!link) return;
    link.addEventListener('click', async function (e) {
      e.preventDefault();
      try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (err) { /* still leave */ }
      window.location.href = '/login';
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireLogout);
  } else { wireLogout(); }
})();
