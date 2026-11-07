// Change password, shared by the owner and tenant dashboards.
// Posts to /api/auth/change-password. The server ends every other
// session and returns a fresh cookie for this browser, so this
// browser stays logged in and other devices are logged out.
(function () {
  'use strict';
  var form = document.getElementById('cp-form');
  if (!form) return;
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var msg = document.getElementById('cp-msg');
    var cur = document.getElementById('cp-current').value;
    var next = document.getElementById('cp-next').value;
    msg.textContent = '';
    if (next.length < 8) { msg.textContent = 'New password must be at least 8 characters.'; return; }
    if (next === cur) { msg.textContent = 'New password must be different from the current one.'; return; }
    var res;
    try {
      res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current: cur, next: next }),
      });
    } catch (err) {
      msg.textContent = 'Could not reach the server. Please try again.';
      return;
    }
    var data = await res.json().catch(function () { return {}; });
    if (res.ok) {
      msg.textContent = 'Password changed. Your other devices were logged out.';
      form.reset();
    } else {
      msg.textContent = data.error || ('Could not change the password (' + res.status + ').');
    }
  });
})();
