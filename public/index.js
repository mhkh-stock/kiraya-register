// Home: due/overdue items for the logged-in user (their own tenancy only).
// Every user string is rendered with esc() — never raw HTML.
(function () {
  'use strict';
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function rs(n) { return 'Rs ' + Number(n || 0).toLocaleString('en-PK'); }
  function el(id) { return document.getElementById(id); }

  function billRow(b, tenancyId) {
    var amt = b.amount_pkr == null ? 'Amount not entered yet' : rs(b.amount_pkr);
    return '<div class="sum-row"><span class="nm"><strong>' + esc(b.schedule_label || b.schedule_kind || 'Bill') + '</strong>'
      + '<span class="sub">' + esc(b.month || '') + ' · due ' + esc(b.due_date || '') + ' · ' + esc(b.status || '') + '</span></span>'
      + '<span class="amt">' + esc(amt) + '</span>'
      + '<span class="sum-actions"><a class="pill" href="/tenancy?id=' + Number(tenancyId) + '">Open</a></span></div>';
  }

  (async function init() {
    var card = el('due-card');
    if (!card) return;
    var me;
    try {
      var res = await fetch('/api/auth/me');
      if (res.status !== 200) return; // logged out: no due list
      me = await res.json();
    } catch (e) { return; }
    var items = [];
    try {
      if (me.user.role === 'tenant') {
        var r = await fetch('/api/tenant/bills');
        if (r.status !== 200) return;
        var data = await r.json();
        items = (data.bills || [])
          .filter(function (b) { return b.status === 'overdue' || b.status === 'due'; })
          .map(function (b) { return billRow(b, data.tenancy_id); });
      } else if (me.user.role === 'owner') {
        var r2 = await fetch('/api/owner/tenancies');
        if (r2.status !== 200) return;
        var data2 = await r2.json();
        (data2.tenancies || []).forEach(function (t) {
          (t.bills || []).forEach(function (b) {
            if (b.status === 'overdue' || b.status === 'due') items.push(billRow(b, t.id));
          });
        });
      }
    } catch (e) { return; }
    card.hidden = false;
    el('due-list').innerHTML = items.length
      ? items.join('')
      : '<p class="muted">Nothing due right now.</p>';
  })();
})();
