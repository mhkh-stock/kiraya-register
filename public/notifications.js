// Notifications list: newest first, mark-one-read, mark-all-read.
// Every user string is rendered with esc() — never raw HTML.
(function () {
  'use strict';
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(id) { return document.getElementById(id); }

  async function api(method, path, body) {
    var res;
    try {
      res = await fetch(path, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      return { status: 0, data: { error: 'Could not reach the server. Please try again.' } };
    }
    var data = await res.json().catch(function () { return {}; });
    return { status: res.status, data: data };
  }

  async function load() {
    var me = await api('GET', '/api/auth/me');
    if (me.status !== 200) { window.location.href = '/login'; return; }
    var r = await api('GET', '/api/notifications');
    if (r.status !== 200) { el('list').textContent = 'Could not load notifications.'; return; }
    var list = r.data.notifications || [];
    el('notif-msg').textContent = (r.data.unread_count || 0) + ' unread';
    if (!list.length) {
      el('list').innerHTML = '<p class="muted">No notifications yet.</p>';
      return;
    }
    el('list').innerHTML = list.map(function (n) {
      var inner = '<strong>' + esc(n.title) + '</strong>'
        + (n.body ? '<span class="sub">' + esc(n.body) + '</span>' : '')
        + '<span class="sub">' + esc(n.created_at || '') + (n.link ? ' · <a href="' + esc(n.link) + '">Open in the app</a>' : '') + '</span>';
      if (!n.is_read) {
        inner += ' <button class="small" data-read="' + n.id + '">Mark read</button>';
      }
      return '<div class="notif-row' + (n.is_read ? '' : ' unread') + '">' + inner + '</div>';
    }).join('');
    el('list').querySelectorAll('[data-read]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var x = await api('POST', '/api/notifications/' + b.getAttribute('data-read') + '/read', {});
        if (x.status === 200) { load(); } else { alert(x.data.error || 'Could not mark it read.'); }
      });
    });
  }

  el('read-all').addEventListener('click', async function () {
    var x = await api('POST', '/api/notifications/read-all', {});
    if (x.status === 200) { load(); } else { el('notif-msg').textContent = x.data.error || 'Could not mark all read.'; }
  });

  load();
})();
