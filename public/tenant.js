// Tenant dashboard: link with a house code, see my tenancy, legal checklist.
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
  var currentTenancyId = null;

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

  async function loadMe() {
    var r = await api('GET', '/api/auth/me');
    if (r.status !== 200) { window.location.href = '/login'; return null; }
    if (r.data.user.role !== 'tenant') { window.location.href = '/owner'; return null; }
    el('who').textContent = 'Logged in as ' + r.data.user.display_name + ' (Rent Taker)';
    return r.data.user;
  }

  async function loadTenancy() {
    var r = await api('GET', '/api/tenant/tenancy');
    if (r.status !== 200) { el('tenancy').textContent = 'Could not load your tenancy.'; return; }
    var t = r.data.tenancy;
    if (!t) {
      el('tenancy').innerHTML = '<p class="muted">No tenancy yet — enter your house code above to link with your owner.</p>';
      el('checklist-status').textContent = '';
      return;
    }
    currentTenancyId = t.id;
    el('tenancy').innerHTML = '<div class="sum-row"><span class="nm"><strong>' + esc(t.house.title || '') + '</strong>'
      + '<span class="sub">' + esc(t.house.kind || '') + ' · ' + esc(t.house.address || '') + (t.house.city ? ', ' + esc(t.house.city) : '') + '</span>'
      + '<span class="sub">Owner: ' + esc(t.owner.display_name) + ' · ' + esc(t.owner.phone) + '</span>'
      + '<span class="sub">Rent ' + rs(t.rent_pkr) + '/month · due day ' + Number(t.due_day) + ' · Status: ' + esc(t.status) + '</span>'
      + '<span class="sub">' + (t.start_date ? 'From ' + esc(t.start_date) : 'Start date not set yet') + (t.end_date ? ' to ' + esc(t.end_date) : '') + '</span></span>'
      + '<span class="sum-actions"><a class="pill" href="/tenancy?id=' + t.id + '">Open</a></span></div>'
      + (t.status === 'requested'
        ? '<p class="muted">Request sent — waiting for your owner to approve it. Nothing else exists yet: no schedule, no bill, no chat.</p>'
        : '')
      + (t.status === 'active'
        ? '<div class="row"><label style="flex:1">Ask the owner to end this tenancy — reason '
          + '<input type="text" id="end-reason" maxlength="500" placeholder="Why should it end?"></label></div>'
          + '<p><button class="small danger" id="request-end">Ask to end tenancy</button> <span class="tag" id="end-msg" role="status"></span></p>'
        : '');
    var endBtn = el('request-end');
    if (endBtn) {
      endBtn.addEventListener('click', async function () {
        var reason = el('end-reason').value.trim();
        var x = await api('POST', '/api/tenant/tenancies/' + t.id + '/request-end', { reason: reason });
        el('end-msg').textContent = x.status === 200 ? 'Your owner has been asked to end the tenancy.' : (x.data.error || 'Could not send the request.');
      });
    }
    el('checklist-status').innerHTML = '<p>Written agreement: <strong>' + (t.agreement_note ? esc(t.agreement_note) : 'not recorded yet') + '</strong><br>'
      + 'Registered with Rent Registrar: <strong>' + (t.agreement_registered ? 'Yes ✓' : 'Not yet') + '</strong><br>'
      + 'Registered with police: <strong>' + (t.police_registered ? 'Yes ✓' : 'Not yet') + '</strong></p>';
  }

  function paymentBlock(b) {
    var cp = b.current_payment;
    if (!cp) return '';
    var html = '<span class="sub">Payment: ' + rs(cp.amount_pkr) + ' · ' + esc(cp.method)
      + (cp.txn_ref ? ' · ref ' + esc(cp.txn_ref) : '') + ' · ' + esc(cp.status) + '</span>';
    if (cp.proof_file_url) {
      html += '<span class="sub"><a class="pill" href="' + esc(cp.proof_file_url) + '" target="_blank" rel="noopener">View proof photo</a></span>';
    }
    if (cp.status === 'pending') {
      html += '<span class="sub">Proof uploaded — waiting for your owner to approve it.</span>';
    }
    if (cp.status === 'rejected') {
      html += '<span class="sub"><strong>Rejected by your owner:</strong> ' + esc(cp.decide_reason || 'no reason given') + ' — you can upload a corrected proof below.</span>';
    }
    if (cp.status === 'approved' && b.receipt) {
      html += '<span class="sub"><strong>Receipt ' + esc(b.receipt.receipt_number) + '</strong> · ' + esc(b.receipt.date) + ' · ' + rs(b.receipt.amount_pkr) + ' · ' + esc(b.receipt.method) + '</span>';
    }
    return html;
  }

  function payForm(b) {
    // Shown only when the bill can take a payment: amount entered, not
    // paid, and no proof currently waiting for approval.
    if (b.amount_pkr == null) return '<p class="muted">Amount not entered yet — your owner enters the real bill amount first.</p>';
    if (b.status === 'paid') return '';
    var cp = b.current_payment;
    if (cp && cp.status === 'pending') return '';
    var isCorrection = cp && cp.status === 'rejected';
    return '<form class="pay-form" data-bill="' + b.id + '">'
      + '<div class="row"><div><label>Amount paid (Rs)</label>'
      + '<input type="number" name="amount_pkr" min="1" max="100000000" step="1" required value="' + Number(b.amount_pkr) + '"></div>'
      + '<div><label>How you paid</label><select name="method">'
      + '<option value="cash">Cash</option><option value="jazzcash">JazzCash</option>'
      + '<option value="easypaisa">Easypaisa</option><option value="bank">Bank transfer</option>'
      + '<option value="other">Other</option></select></div></div>'
      + '<div class="row"><div><label>Transaction ref (optional)</label>'
      + '<input type="text" name="txn_ref" maxlength="100" placeholder="e.g. JazzCash TID"></div>'
      + '<div><label>Proof photo (JPG/PNG/WebP, max 5 MB)</label>'
      + '<input type="file" name="photo" accept=".jpg,.jpeg,.png,.webp" required></div></div>'
      + '<p><button class="small" type="submit">' + (isCorrection ? 'Upload corrected proof' : 'Upload proof of payment') + '</button> '
      + '<span class="tag" role="status"></span></p></form>';
  }

  async function loadBills() {
    var box = el('bills');
    if (!box) return;
    var r = await api('GET', '/api/tenant/bills');
    if (r.status !== 200) { box.textContent = 'Could not load your bills.'; return; }
    var list = r.data.bills || [];
    if (!list.length) {
      box.innerHTML = '<p class="muted">No bills yet — your owner keeps the schedules, and bills for the current month appear here.</p>';
      return;
    }
    box.innerHTML = list.map(function (b) {
      var amt = b.amount_pkr == null ? 'Amount not entered yet' : rs(b.amount_pkr);
      var text = 'My ' + (b.schedule_kind || 'bill') + ' bill for ' + (b.month || '') + ' is due on ' + (b.due_date || '')
        + ' — ' + (b.amount_pkr == null ? 'amount not entered yet' : 'Rs ' + b.amount_pkr);
      var shareUrl = b.whatsapp_share_url || waShare(r.data.owner && r.data.owner.phone, text);
      var share = shareUrl
        ? ' <a class="pill" href="' + esc(shareUrl) + '" target="_blank" rel="noopener">Share on WhatsApp</a>' : '';
      return '<div class="sum-row"><span class="nm"><strong>' + esc(b.schedule_label || b.schedule_kind || 'Bill') + '</strong>'
        + '<span class="sub">' + esc(b.month || '') + ' · due ' + esc(b.due_date || '') + ' · ' + esc(b.status || '') + '</span>'
        + paymentBlock(b) + '</span>'
        + '<span class="amt">' + esc(amt) + '</span>'
        + '<span class="sum-actions">' + share + '</span></div>'
        + payForm(b);
    }).join('');
    box.querySelectorAll('.pay-form').forEach(function (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var msg = form.querySelector('[role="status"]');
        var fd = new FormData(form);
        fd.append('bill_id', form.getAttribute('data-bill'));
        var res;
        try {
          res = await fetch('/api/tenant/payments', { method: 'POST', body: fd });
        } catch (e) {
          msg.textContent = 'Could not reach the server. Please try again.';
          return;
        }
        var data = await res.json().catch(function () { return {}; });
        if (res.status === 201) {
          msg.textContent = 'Proof uploaded — waiting for your owner to approve it.';
          loadBills();
          loadReceipts();
        } else {
          msg.textContent = data.error || ('Could not upload the proof (' + res.status + ').');
        }
      });
    });
  }

  function receiptRow(rc) {
    return '<div class="sum-row"><span class="nm"><strong>Receipt ' + esc(rc.receipt_number) + '</strong>'
      + '<span class="sub">' + esc(rc.house_title) + ' · ' + esc(rc.schedule_label || rc.schedule_kind) + ' · ' + esc(rc.month) + '</span>'
      + '<span class="sub">' + esc(rc.date) + ' · ' + esc(rc.method) + (rc.txn_ref ? ' · ref ' + esc(rc.txn_ref) : '') + '</span></span>'
      + '<span class="amt">' + rs(rc.amount_pkr) + '</span></div>';
  }

  async function loadReceipts() {
    var box = el('receipts');
    if (!box) return;
    var r = await api('GET', '/api/tenant/receipts');
    if (r.status !== 200) { box.textContent = 'Could not load your receipts.'; return; }
    var list = r.data.receipts || [];
    box.innerHTML = list.length
      ? list.map(receiptRow).join('')
      : '<p class="muted">No receipts yet — a receipt appears here once your owner approves a payment.</p>';
  }

  el('link-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    el('link-msg').textContent = '';
    var code = el('link-code').value.trim();
    var r = await api('POST', '/api/tenant/link', { code: code });
    if (r.status === 201) {
      el('link-msg').textContent = 'Request sent — your owner will approve it.';
      el('link-code').value = '';
      loadTenancy();
    } else {
      el('link-msg').textContent = r.data.error || ('Could not send the request (' + r.status + ').');
    }
  });

  (async function init() {
    var me = await loadMe();
    if (!me) return;
    loadTenancy();
    loadBills();
    loadReceipts();
  })();
})();
