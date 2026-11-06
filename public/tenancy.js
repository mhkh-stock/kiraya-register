// Tenancy detail — one page, both roles. Each side sees only its own actions.
// Every user string is rendered with textContent or esc() — never raw HTML.
(function () {
  'use strict';
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function rs(n) { return 'Rs ' + Number(n || 0).toLocaleString('en-PK'); }
  function el(id) { return document.getElementById(id); }
  // "Share on WhatsApp" deep link (wa.me) — fallback when the server did
  // not attach one. The app sends nothing itself; the link only opens the
  // user's own WhatsApp with the message ready to send.
  function waShare(phone, text) {
    var digits = String(phone || '').replace(/[^0-9]/g, '');
    var intl = digits.indexOf('92') === 0 ? digits : (digits.charAt(0) === '0' ? '92' + digits.slice(1) : digits);
    return 'https://wa.me/' + intl + '?text=' + encodeURIComponent(text);
  }

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

  (async function init() {
    var params = new URLSearchParams(window.location.search);
    var id = Number(params.get('id'));
    if (!id) { el('detail').textContent = 'No tenancy selected.'; return; }
    var me = await api('GET', '/api/auth/me');
    if (me.status !== 200) { window.location.href = '/login'; return; }
    var role = me.data.user.role;
    var t = null;
    if (role === 'owner') {
      var r = await api('GET', '/api/owner/tenancies/' + id);
      if (r.status === 200) t = r.data.tenancy;
      else { el('detail').textContent = r.data.error || 'Tenancy not found.'; return; }
    } else {
      var r2 = await api('GET', '/api/tenant/tenancy');
      if (r2.status === 200 && r2.data.tenancy && r2.data.tenancy.id === id) t = r2.data.tenancy;
      else { el('detail').textContent = 'This is not your tenancy.'; return; }
    }
    var other = role === 'owner'
      ? 'Tenant: ' + esc(t.tenant.display_name) + ' · ' + esc(t.tenant.phone) + ' · CNIC …' + esc(t.tenant.cnic_last4 || '') + (t.tenant.cnic ? ' (full CNIC on file)' : '')
      : 'Owner: ' + esc(t.owner.display_name) + ' · ' + esc(t.owner.phone);
    var house = t.house || {};
    var schedulesHtml = '<h3>Schedules</h3>' + (((t.schedules || []).length)
      ? (t.schedules || []).map(function (s) {
          var amt = s.amount_pkr == null ? 'Variable — amount when the bill comes' : rs(s.amount_pkr);
          return '<div class="sum-row"><span class="nm"><strong>' + esc(s.label || s.kind) + '</strong>'
            + '<span class="sub">' + esc(s.kind) + ' · ' + esc(amt) + ' · due day ' + Number(s.due_day) + ' · ' + (s.active ? 'active' : 'deactivated') + '</span>'
            + (s.note ? '<span class="sub">' + esc(s.note) + '</span>' : '') + '</span></div>';
        }).join('')
      : '<p class="muted">No schedules yet.</p>');
    var billsHtml = '<h3>Bills</h3>' + (((t.bills || []).length)
      ? (t.bills || []).map(function (b) {
          var amt = b.amount_pkr == null ? 'Amount not entered yet' : rs(b.amount_pkr);
          var otherPhone = role === 'owner' ? (t.tenant && t.tenant.phone) : (t.owner && t.owner.phone);
          var text = (role === 'owner' ? 'Your ' : 'My ') + (b.schedule_kind || 'bill') + ' bill for ' + (b.month || '')
            + ' is due on ' + (b.due_date || '') + ' — ' + (b.amount_pkr == null ? 'amount not entered yet' : 'Rs ' + b.amount_pkr);
          var shareUrl = b.whatsapp_share_url || waShare(otherPhone, text);
          var share = shareUrl
            ? ' <a class="pill" href="' + esc(shareUrl) + '" target="_blank" rel="noopener">Share on WhatsApp</a>' : '';
          return '<div class="sum-row"><span class="nm"><strong>' + esc(b.schedule_label || b.schedule_kind || 'Bill') + '</strong>'
            + '<span class="sub">' + esc(b.month || '') + ' · due ' + esc(b.due_date || '') + ' · ' + esc(b.status || '') + '</span></span>'
            + '<span class="amt">' + esc(amt) + '</span>'
            + '<span class="sum-actions">' + share + '</span></div>'
            + (b.amount_pkr == null && role === 'owner' && t.status === 'active'
              ? '<div class="row"><label style="flex:1">Enter the real bill amount (Rs) '
                + '<input type="number" id="bill-amt-' + b.id + '" min="1" max="100000000" step="1"></label>'
                + '<p><button class="small" data-bill-amount="' + b.id + '">Save amount</button></p></div>'
              : '');
        }).join('')
      : '<p class="muted">No bills yet — bills for the current month appear when this tenancy is opened.</p>');
    var paymentsHtml = '<h3>Payment history</h3>'
      + '<p class="muted">A screenshot proves the tenant showed a payment — only the owner, checking his own account, knows the money arrived.</p>'
      + (((t.payments || []).length)
        ? (t.payments || []).map(function (p) {
            var proof = p.proof_file_url
              ? ' <a class="pill" href="' + esc(p.proof_file_url) + '" target="_blank" rel="noopener">View proof</a>' : '';
            return '<div class="sum-row"><span class="nm"><strong>' + rs(p.amount_pkr) + ' · ' + esc(p.method) + '</strong>'
              + '<span class="sub">' + esc(p.schedule_label || p.schedule_kind) + ' · ' + esc(p.bill_month || '') + ' · ' + esc(p.status) + '</span>'
              + (p.txn_ref ? '<span class="sub">Ref: ' + esc(p.txn_ref) + '</span>' : '')
              + (p.note ? '<span class="sub">' + esc(p.note) + '</span>' : '')
              + (p.status === 'rejected' ? '<span class="sub">Rejected: ' + esc(p.decide_reason || '') + '</span>' : '')
              + (p.status === 'approved' && p.receipt ? '<span class="sub"><strong>Receipt ' + esc(p.receipt.receipt_number) + '</strong> · ' + esc(p.receipt.date) + '</span>' : '')
              + '</span><span class="sum-actions">' + proof + '</span></div>';
          }).join('')
        : '<p class="muted">No payments yet.</p>');
    var receiptsHtml = '<h3>Receipts</h3>' + (((t.receipts || []).length)
      ? (t.receipts || []).map(function (rc) {
          return '<div class="sum-row"><span class="nm"><strong>Receipt ' + esc(rc.receipt_number) + '</strong>'
            + '<span class="sub">' + esc(rc.house_title) + ' · ' + esc(rc.schedule_label || rc.schedule_kind) + ' · ' + esc(rc.month) + ' · ' + esc(rc.date)
            + ' · ' + esc(rc.method) + (rc.txn_ref ? ' · ref ' + esc(rc.txn_ref) : '') + ' · ' + esc(rc.tenant_name) + '</span></span>'
            + '<span class="amt">' + rs(rc.amount_pkr) + '</span></div>';
        }).join('')
      : '<p class="muted">No receipts yet — a receipt is created when the owner approves a payment.</p>');
    el('detail').innerHTML = '<p><strong>' + esc(house.title || '') + '</strong><br>'
      + esc(house.kind || '') + ' · ' + esc(house.address || '') + (house.city ? ', ' + esc(house.city) : '') + '</p>'
      + '<p>' + other + '</p>'
      + '<p>Status: <strong>' + esc(t.status) + '</strong> · Rent ' + rs(t.rent_pkr) + '/month · due day ' + Number(t.due_day) + '<br>'
      + (t.start_date ? 'From ' + esc(t.start_date) : 'Start date not set yet') + (t.end_date ? ' to ' + esc(t.end_date) : '') + '<br>'
      + 'Agreement registered: ' + (t.agreement_registered ? 'Yes ✓' : 'Not yet') + ' · Police registered: ' + (t.police_registered ? 'Yes ✓' : 'Not yet')
      + (t.agreement_note ? '<br>Agreement: ' + esc(t.agreement_note) : '') + '</p>'
      + schedulesHtml + billsHtml + paymentsHtml + receiptsHtml
      + (t.decide_reason ? '<p class="muted">Last decision note: ' + esc(t.decide_reason) + '</p>' : '');
    el('detail').querySelectorAll('[data-bill-amount]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = Number(b.getAttribute('data-bill-amount'));
        var x = await api('POST', '/api/owner/bills/' + id + '/amount', { amount_pkr: Number(el('bill-amt-' + id).value) });
        if (x.status === 200) { window.location.reload(); }
        else { alert(x.data.error || ('Could not save the amount (' + x.status + ').')); }
      });
    });
    var actions = el('actions');
    var card = el('actions-card');
    if (t.status === 'active' && role === 'owner') {
      card.hidden = false;
      actions.innerHTML = '<label>Reason for ending <input type="text" id="end-reason" maxlength="500"></label>'
        + '<p><button class="danger" id="end-btn">End tenancy</button> <span class="tag" id="end-msg" role="status"></span></p>';
      el('end-btn').addEventListener('click', async function () {
        var x = await api('POST', '/api/owner/tenancies/' + t.id + '/end', { reason: el('end-reason').value.trim() });
        if (x.status === 200) { window.location.reload(); }
        else { el('end-msg').textContent = x.data.error || 'Could not end the tenancy.'; }
      });
    } else if (t.status === 'active' && role === 'tenant') {
      card.hidden = false;
      actions.innerHTML = '<label>Reason for asking to end <input type="text" id="end-reason" maxlength="500"></label>'
        + '<p><button class="danger" id="end-btn">Ask owner to end tenancy</button> <span class="tag" id="end-msg" role="status"></span></p>';
      el('end-btn').addEventListener('click', async function () {
        var x = await api('POST', '/api/tenant/tenancies/' + t.id + '/request-end', { reason: el('end-reason').value.trim() });
        el('end-msg').textContent = x.status === 200 ? 'Your owner has been asked to end the tenancy.' : (x.data.error || 'Could not send the request.');
      });
    } else if (t.status === 'ended') {
      card.hidden = false;
      actions.innerHTML = '<p class="muted">This tenancy has ended. It stays read-only — the history is the proof.</p>';
    }
  })();
})();
