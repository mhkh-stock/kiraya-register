// Owner dashboard: houses, link codes, link requests, tenancies.
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
  function billShareText(b, prefix) {
    var amt = b.amount_pkr == null ? 'amount not entered yet' : 'Rs ' + b.amount_pkr;
    return prefix + ' ' + (b.schedule_kind || 'bill') + ' bill for ' + (b.month || '') + ' is due on ' + (b.due_date || '') + ' — ' + amt;
  }
  var editingId = null;

  async function api(method, path, body) {
    var res = await fetch(path, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    var data = await res.json().catch(function () { return {}; });
    return { status: res.status, data: data };
  }
  async function apiForm(path, formData) {
    var res = await fetch(path, { method: 'POST', body: formData });
    var data = await res.json().catch(function () { return {}; });
    return { status: res.status, data: data };
  }

  async function loadMe() {
    var r = await api('GET', '/api/auth/me');
    if (r.status !== 200) { window.location.href = '/login'; return null; }
    if (r.data.user.role !== 'owner') { window.location.href = '/tenant'; return null; }
    el('who').textContent = 'Logged in as ' + r.data.user.display_name + ' (House Owner)';
    return r.data.user;
  }

  function houseCard(h) {
    var tenant = h.tenant ? esc(h.tenant.display_name) + ' (' + esc(h.tenant.status) + ')' : 'No tenant yet';
    var photos = (h.photos || []).map(function (ph) {
      return '<img src="' + esc(ph.file_url) + '" alt="House photo" style="width:96px;height:96px;object-fit:cover;border-radius:12px;margin:4px 4px 0 0">';
    }).join('');
    return '<div class="sum-row"><span class="nm"><strong>' + esc(h.title) + '</strong>'
      + '<span class="sub">' + esc(h.kind) + ' · ' + esc(h.address) + (h.city ? ', ' + esc(h.city) : '') + '</span>'
      + '<span class="sub">Rent ' + rs(h.rent_pkr) + ' · Advance ' + rs(h.advance_pkr) + ' · ' + esc(h.status) + ' · Tenant: ' + tenant + '</span></span>'
      + '<span class="sum-actions">'
      + '<button class="small" data-code="' + h.id + '">Link code</button>'
      + '<button class="small secondary" data-edit="' + h.id + '">Edit</button>'
      + (h.status !== 'hidden' ? '<button class="small secondary" data-hide="' + h.id + '">Hide</button>' : '')
      + '</span></div>'
      + '<div class="code-box" id="code-' + h.id + '" hidden></div>'
      + '<div>' + photos + '</div>'
      + '<div class="row"><label style="flex:1">Add a photo (JPG/PNG/WebP, max 5 MB, 8 per house) '
      + '<input type="file" data-photo="' + h.id + '" accept=".jpg,.jpeg,.png,.webp" style="margin-top:6px"></label></div>';
  }

  async function loadHouses() {
    var r = await api('GET', '/api/owner/houses');
    if (r.status !== 200) { el('houses').textContent = 'Could not load houses.'; return; }
    var list = r.data.houses || [];
    el('houses').innerHTML = list.length
      ? list.map(houseCard).join('')
      : '<p class="muted">No houses yet — add your first house below.</p>';
    el('houses').querySelectorAll('[data-code]').forEach(function (b) {
      b.addEventListener('click', function () { showCode(Number(b.getAttribute('data-code'))); });
    });
    el('houses').querySelectorAll('[data-edit]').forEach(function (b) {
      b.addEventListener('click', function () { startEdit(Number(b.getAttribute('data-edit'))); });
    });
    el('houses').querySelectorAll('[data-hide]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = Number(b.getAttribute('data-hide'));
        var x = await api('POST', '/api/owner/houses/' + id + '/hide', {});
        if (x.status === 200) { loadHouses(); } else { alert(x.data.error || 'Could not hide the house.'); }
      });
    });
    el('houses').querySelectorAll('[data-photo]').forEach(function (inp) {
      inp.addEventListener('change', async function () {
        if (!inp.files || !inp.files[0]) return;
        var fd = new FormData();
        fd.append('photo', inp.files[0]);
        var x = await apiForm('/api/owner/houses/' + inp.getAttribute('data-photo') + '/photos', fd);
        if (x.status === 201) { loadHouses(); } else { alert(x.data.error || ('Photo upload failed (' + x.status + ').')); }
        inp.value = '';
      });
    });
  }

  async function showCode(houseId) {
    var box = el('code-' + houseId);
    var r = await api('GET', '/api/owner/houses/' + houseId + '/code');
    if (r.status !== 200) { box.hidden = false; box.textContent = 'Could not load the code.'; return; }
    box.hidden = false;
    box.innerHTML = '<p><strong>House code: ' + esc(r.data.code) + '</strong>'
      + (r.data.active ? '' : ' (not active — regenerate to link a new tenant)')
      + '<br><span class="muted">' + esc(r.data.share_text) + '</span></p>'
      + '<p><button class="small" id="copy-' + houseId + '">Copy share text</button> '
      + '<button class="small secondary" id="regen-' + houseId + '">Regenerate code</button></p>';
    el('copy-' + houseId).addEventListener('click', function () {
      if (navigator.clipboard) navigator.clipboard.writeText(r.data.share_text);
    });
    el('regen-' + houseId).addEventListener('click', async function () {
      var x = await api('POST', '/api/owner/houses/' + houseId + '/code/regenerate', {});
      if (x.status === 200) { showCode(houseId); } else { alert(x.data.error || 'Could not regenerate the code.'); }
    });
  }

  function fillForm(h) {
    el('f-title').value = h.title || '';
    el('f-kind').value = h.kind || 'house';
    el('f-rent').value = h.rent_pkr == null ? '' : h.rent_pkr;
    el('f-address').value = h.address || '';
    el('f-city').value = h.city || '';
    el('f-area').value = h.area || '';
    el('f-bedrooms').value = h.bedrooms == null ? '' : h.bedrooms;
    el('f-bathrooms').value = h.bathrooms == null ? '' : h.bathrooms;
    el('f-advance').value = h.advance_pkr == null ? '' : h.advance_pkr;
    el('f-deposit').value = h.security_deposit_pkr == null ? '' : h.security_deposit_pkr;
    document.querySelectorAll('#bills-included input').forEach(function (c) {
      c.checked = (h.bills_included || []).indexOf(c.value) !== -1;
    });
    el('f-maps').value = h.maps_url || '';
    el('f-plus').value = h.plus_code || '';
    el('f-available').value = h.available_from || '';
  }

  async function startEdit(houseId) {
    var r = await api('GET', '/api/owner/houses');
    var h = (r.data.houses || []).find(function (x) { return x.id === houseId; });
    if (!h) return;
    editingId = houseId;
    fillForm(h);
    el('form-title').textContent = 'Edit house — ' + h.title;
    el('save-btn').textContent = 'Save changes';
    el('cancel-edit').hidden = false;
    window.scrollTo({ top: el('form-title').offsetTop - 90, behavior: 'smooth' });
  }

  el('cancel-edit').addEventListener('click', function () {
    editingId = null;
    el('house-form').reset();
    el('form-title').textContent = 'Add a house';
    el('save-btn').textContent = 'Add house';
    el('cancel-edit').hidden = true;
    el('form-msg').textContent = '';
  });

  el('house-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    el('form-msg').textContent = '';
    var bills = [];
    document.querySelectorAll('#bills-included input:checked').forEach(function (c) { bills.push(c.value); });
    function num(id) {
      var v = el(id).value.trim();
      return v === '' ? null : Number(v);
    }
    var body = {
      title: el('f-title').value.trim(),
      kind: el('f-kind').value,
      address: el('f-address').value.trim(),
      city: el('f-city').value.trim(),
      area: el('f-area').value.trim(),
      bedrooms: num('f-bedrooms'),
      bathrooms: num('f-bathrooms'),
      rent_pkr: Number(el('f-rent').value),
      advance_pkr: num('f-advance') == null ? 0 : num('f-advance'),
      security_deposit_pkr: num('f-deposit') == null ? 0 : num('f-deposit'),
      bills_included: bills,
      maps_url: el('f-maps').value.trim(),
      plus_code: el('f-plus').value.trim(),
      available_from: el('f-available').value,
    };
    var r;
    if (editingId) {
      r = await api('PUT', '/api/owner/houses/' + editingId, body);
    } else {
      r = await api('POST', '/api/owner/houses', body);
    }
    if (r.status === 201 || r.status === 200) {
      el('form-msg').textContent = editingId ? 'House updated.' : 'House added — its link code is ' + (r.data.code || '') + '.';
      editingId = null;
      el('house-form').reset();
      el('form-title').textContent = 'Add a house';
      el('save-btn').textContent = 'Add house';
      el('cancel-edit').hidden = true;
      loadHouses();
      loadRequests();
      loadTenancies();
    } else {
      el('form-msg').textContent = r.data.error || ('Could not save the house (' + r.status + ').');
    }
  });

  function requestCard(q) {
    return '<div class="sum-row"><span class="nm"><strong>' + esc(q.tenant.display_name) + '</strong>'
      + '<span class="sub">' + esc(q.house_title) + ' · ' + esc(q.tenant.phone) + ' · CNIC …' + esc(q.tenant.cnic_last4) + '</span></span></div>'
      + '<div class="row">'
      + '<div><label>Rent (Rs)</label><input type="number" id="rent-' + q.tenancy_id + '" value="' + Number(q.house_rent_pkr || 0) + '" min="1"></div>'
      + '<div><label>Due day (1–28)</label><input type="number" id="due-' + q.tenancy_id + '" value="1" min="1" max="28"></div>'
      + '<div><label>Start date</label><input type="date" id="start-' + q.tenancy_id + '"></div>'
      + '<div><label>End date</label><input type="date" id="end-' + q.tenancy_id + '"></div>'
      + '</div>'
      + '<div class="row"><label><input type="checkbox" id="agree-' + q.tenancy_id + '"> Agreement registered with Rent Registrar</label>'
      + '<label><input type="checkbox" id="police-' + q.tenancy_id + '"> Tenant registered with police</label></div>'
      + '<p><button class="small" data-approve="' + q.tenancy_id + '">Approve</button> '
      + '<input type="text" id="rej-' + q.tenancy_id + '" placeholder="Reason (required to reject)" style="max-width:280px"> '
      + '<button class="small danger" data-reject="' + q.tenancy_id + '">Reject</button></p>';
  }

  async function loadRequests() {
    var r = await api('GET', '/api/owner/link-requests');
    if (r.status !== 200) { el('requests').textContent = 'Could not load requests.'; return; }
    var list = r.data.requests || [];
    el('requests').innerHTML = list.length
      ? list.map(requestCard).join('')
      : '<p class="muted">No pending link requests.</p>';
    el('requests').querySelectorAll('[data-approve]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = Number(b.getAttribute('data-approve'));
        var x = await api('POST', '/api/owner/link-requests/decide', {
          tenancy_id: id, decision: 'approve',
          rent_pkr: Number(el('rent-' + id).value),
          due_day: Number(el('due-' + id).value),
          start_date: el('start-' + id).value,
          end_date: el('end-' + id).value || '',
          agreement_registered: el('agree-' + id).checked,
          police_registered: el('police-' + id).checked,
        });
        if (x.status === 200) { loadRequests(); loadTenancies(); loadHouses(); }
        else { alert(x.data.error || ('Could not approve (' + x.status + ').')); }
      });
    });
    el('requests').querySelectorAll('[data-reject]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = Number(b.getAttribute('data-reject'));
        var reason = el('rej-' + id).value.trim();
        var x = await api('POST', '/api/owner/link-requests/decide', { tenancy_id: id, decision: 'reject', reason: reason });
        if (x.status === 200) { loadRequests(); loadTenancies(); }
        else { alert(x.data.error || ('Could not reject (' + x.status + ').')); }
      });
    });
  }

  function scheduleRow(t, s) {
    var amt = s.amount_pkr == null ? 'Variable — amount when the bill comes' : rs(s.amount_pkr);
    return '<div class="sum-row"><span class="nm"><strong>' + esc(s.label || s.kind) + '</strong>'
      + '<span class="sub">' + esc(s.kind) + ' · ' + esc(amt) + ' · due day ' + Number(s.due_day) + ' · ' + (s.active ? 'active' : 'deactivated') + '</span>'
      + (s.note ? '<span class="sub">' + esc(s.note) + '</span>' : '') + '</span>'
      + '<span class="sum-actions">'
      + '<button class="small secondary" data-sched-edit="' + s.id + '">Edit</button>'
      + (s.active ? '<button class="small secondary" data-sched-off="' + s.id + '">Deactivate</button>' : '')
      + '</span></div>'
      + '<div class="row" id="sched-edit-' + s.id + '" hidden>'
      + '<div><label>Label</label><input type="text" id="se-label-' + s.id + '" maxlength="100" value="' + esc(s.label || '') + '"></div>'
      + '<div><label>Amount (Rs, blank = variable)</label><input type="number" id="se-amount-' + s.id + '" min="1" max="100000000" step="1" value="' + (s.amount_pkr == null ? '' : Number(s.amount_pkr)) + '"></div>'
      + '<div><label>Due day (1–28)</label><input type="number" id="se-due-' + s.id + '" min="1" max="28" step="1" value="' + Number(s.due_day) + '"></div>'
      + '<div><label>Note</label><input type="text" id="se-note-' + s.id + '" maxlength="500" value="' + esc(s.note || '') + '"></div>'
      + '<p><button class="small" data-sched-save="' + s.id + '">Save schedule</button></p></div>';
  }

  function billRow(t, b) {
    var amt = b.amount_pkr == null ? 'Amount not entered yet' : rs(b.amount_pkr);
    var shareUrl = b.whatsapp_share_url || waShare(t.tenant.phone, billShareText(b, 'Your'));
    var share = shareUrl
      ? ' <a class="pill" href="' + esc(shareUrl) + '" target="_blank" rel="noopener">Share on WhatsApp</a>' : '';
    return '<div class="sum-row"><span class="nm"><strong>' + esc(b.schedule_label || b.schedule_kind || 'Bill') + '</strong>'
      + '<span class="sub">' + esc(b.month || '') + ' · due ' + esc(b.due_date || '') + ' · ' + esc(b.status || '') + '</span></span>'
      + '<span class="amt">' + esc(amt) + '</span>'
      + '<span class="sum-actions">' + share + '</span></div>'
      + (b.amount_pkr == null && t.status === 'active'
        ? '<div class="row"><label style="flex:1">Enter the real bill amount (Rs) '
          + '<input type="number" id="bill-amt-' + b.id + '" min="1" max="100000000" step="1"></label>'
          + '<p><button class="small" data-bill-amount="' + b.id + '">Save amount</button></p></div>'
        : '');
  }

  function paymentRow(p) {
    var proof = p.proof_file_url
      ? ' <a class="pill" href="' + esc(p.proof_file_url) + '" target="_blank" rel="noopener">View proof</a>' : '';
    return '<div class="sum-row"><span class="nm"><strong>' + rs(p.amount_pkr) + ' · ' + esc(p.method) + '</strong>'
      + '<span class="sub">' + esc(p.schedule_label || p.schedule_kind) + ' · ' + esc(p.bill_month || '') + ' · ' + esc(p.status) + '</span>'
      + (p.txn_ref ? '<span class="sub">Ref: ' + esc(p.txn_ref) + '</span>' : '')
      + (p.status === 'rejected' ? '<span class="sub">Rejected: ' + esc(p.decide_reason || '') + '</span>' : '')
      + (p.status === 'approved' && p.receipt ? '<span class="sub"><strong>Receipt ' + esc(p.receipt.receipt_number) + '</strong> · ' + esc(p.receipt.date) + '</span>' : '')
      + '</span><span class="sum-actions">' + proof + '</span></div>';
  }

  function tenancyCard(t) {
    var schedules = (t.schedules || []).map(function (s) { return scheduleRow(t, s); }).join('')
      || '<p class="muted">No schedules yet.</p>';
    var bills = (t.bills || []).map(function (b) { return billRow(t, b); }).join('')
      || '<p class="muted">No bills yet — bills for the current month appear when this tenancy is opened.</p>';
    var payments = (t.payments || []).length
      ? (t.payments || []).map(paymentRow).join('')
      : '<p class="muted">No payments yet.</p>';
    var receipts = (t.receipts || []).length
      ? (t.receipts || []).map(function (rc) {
          return '<div class="sum-row"><span class="nm"><strong>Receipt ' + esc(rc.receipt_number) + '</strong>'
            + '<span class="sub">' + esc(rc.schedule_label || rc.schedule_kind) + ' · ' + esc(rc.month) + ' · ' + esc(rc.date)
            + ' · ' + esc(rc.method) + (rc.txn_ref ? ' · ref ' + esc(rc.txn_ref) : '') + ' · ' + esc(rc.tenant_name) + '</span></span>'
            + '<span class="amt">' + rs(rc.amount_pkr) + '</span></div>';
        }).join('')
      : '<p class="muted">No receipts yet — a receipt is created when you approve a payment.</p>';
    return '<div class="sum-row"><span class="nm"><strong>' + esc(t.house.title || '') + '</strong>'
      + '<span class="sub">' + esc(t.tenant.display_name) + ' · ' + esc(t.tenant.phone) + ' · CNIC …' + esc(t.tenant.cnic_last4) + '</span>'
      + '<span class="sub">' + rs(t.rent_pkr) + '/month · due day ' + Number(t.due_day) + ' · ' + esc(t.status) + '</span></span>'
      + '<span class="sum-actions"><a class="pill" href="/tenancy?id=' + t.id + '">Open</a></span></div>'
      + '<h3>Schedules — kept by you</h3>' + schedules
      + '<div class="row"><div><label>Kind</label><select id="ns-kind-' + t.id + '">'
      + '<option value="gas">Gas</option><option value="electricity">Electricity</option>'
      + '<option value="water">Water</option><option value="internet">Internet</option>'
      + '<option value="maintenance">Maintenance</option><option value="rent">Rent</option>'
      + '<option value="other">Other</option></select></div>'
      + '<div><label>Label</label><input type="text" id="ns-label-' + t.id + '" maxlength="100" placeholder="SNGPL gas"></div>'
      + '<div><label>Amount (Rs, blank = variable)</label><input type="number" id="ns-amount-' + t.id + '" min="1" max="100000000" step="1"></div>'
      + '<div><label>Due day (1–28)</label><input type="number" id="ns-due-' + t.id + '" min="1" max="28" step="1" value="10"></div></div>'
      + '<div class="row"><label style="flex:1">Note <input type="text" id="ns-note-' + t.id + '" maxlength="500"></label></div>'
      + '<p><button class="small" data-sched-add="' + t.id + '">Add schedule</button> <span class="tag" id="ns-msg-' + t.id + '" role="status"></span></p>'
      + '<h3>Bills — ' + esc(t.house.title || '') + '</h3>' + bills
      + '<h3>Payments</h3>' + payments
      + '<h3>Receipts</h3>' + receipts;
  }

  async function loadPendingPayments() {
    var box = el('pending-payments');
    if (!box) return;
    var r = await api('GET', '/api/owner/payments/pending');
    if (r.status !== 200) { box.textContent = 'Could not load pending payments.'; return; }
    var list = r.data.payments || [];
    if (!list.length) {
      box.innerHTML = '<p class="muted">No payment proofs waiting for approval.</p>';
      return;
    }
    box.innerHTML = list.map(function (p) {
      var proof = p.proof_file_url
        ? '<a class="pill" href="' + esc(p.proof_file_url) + '" target="_blank" rel="noopener">View proof photo</a>' : '';
      return '<div class="sum-row"><span class="nm"><strong>' + esc(p.tenant_name || '') + ' — ' + esc(p.house_title || '') + '</strong>'
        + '<span class="sub">' + esc(p.schedule_label || p.schedule_kind) + ' · ' + esc(p.bill_month || '') + ' · ' + esc(p.method)
        + (p.txn_ref ? ' · ref ' + esc(p.txn_ref) : '') + (p.note ? ' · ' + esc(p.note) : '') + '</span></span>'
        + '<span class="amt">' + rs(p.amount_pkr) + '</span>'
        + '<span class="sum-actions">' + proof + '</span></div>'
        + '<div class="row"><label style="flex:1">Reason (required to reject) '
        + '<input type="text" id="pay-rej-' + p.id + '" maxlength="500" placeholder="Why is this proof not accepted?"></label></div>'
        + '<p><button class="small" data-pay-approve="' + p.id + '">Approve — bill paid</button> '
        + '<button class="small danger" data-pay-reject="' + p.id + '">Reject</button> '
        + '<span class="tag" id="pay-msg-' + p.id + '" role="status"></span></p>';
    }).join('');
    box.querySelectorAll('[data-pay-approve]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = Number(b.getAttribute('data-pay-approve'));
        var x = await api('POST', '/api/owner/payments/decide', { payment_id: id, decision: 'approve' });
        if (x.status === 200) { loadPendingPayments(); loadTenancies(); }
        else { el('pay-msg-' + id).textContent = x.data.error || ('Could not approve (' + x.status + ').'); }
      });
    });
    box.querySelectorAll('[data-pay-reject]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = Number(b.getAttribute('data-pay-reject'));
        var reason = el('pay-rej-' + id).value.trim();
        var x = await api('POST', '/api/owner/payments/decide', { payment_id: id, decision: 'reject', reason: reason });
        if (x.status === 200) { loadPendingPayments(); loadTenancies(); }
        else { el('pay-msg-' + id).textContent = x.data.error || ('Could not reject (' + x.status + ').'); }
      });
    });
  }

  async function loadTenancies() {
    var r = await api('GET', '/api/owner/tenancies');
    if (r.status !== 200) { el('tenancies').textContent = 'Could not load tenancies.'; return; }
    var list = r.data.tenancies || [];
    el('tenancies').innerHTML = list.length
      ? list.map(tenancyCard).join('')
      : '<p class="muted">No tenancies yet — approve a link request to start one.</p>';
    el('tenancies').querySelectorAll('[data-sched-add]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = Number(b.getAttribute('data-sched-add'));
        var amtVal = el('ns-amount-' + id).value.trim();
        var x = await api('POST', '/api/owner/schedules', {
          tenancy_id: id,
          kind: el('ns-kind-' + id).value,
          label: el('ns-label-' + id).value.trim(),
          amount_pkr: amtVal === '' ? null : Number(amtVal),
          due_day: Number(el('ns-due-' + id).value),
          note: el('ns-note-' + id).value.trim(),
        });
        if (x.status === 201) { loadTenancies(); }
        else { el('ns-msg-' + id).textContent = x.data.error || ('Could not add the schedule (' + x.status + ').'); }
      });
    });
    el('tenancies').querySelectorAll('[data-sched-edit]').forEach(function (b) {
      b.addEventListener('click', function () {
        var box = el('sched-edit-' + b.getAttribute('data-sched-edit'));
        if (box) box.hidden = !box.hidden;
      });
    });
    el('tenancies').querySelectorAll('[data-sched-save]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = Number(b.getAttribute('data-sched-save'));
        var amtVal = el('se-amount-' + id).value.trim();
        var x = await api('PUT', '/api/owner/schedules/' + id, {
          label: el('se-label-' + id).value.trim(),
          amount_pkr: amtVal === '' ? null : Number(amtVal),
          due_day: Number(el('se-due-' + id).value),
          note: el('se-note-' + id).value.trim(),
        });
        if (x.status === 200) { loadTenancies(); } else { alert(x.data.error || ('Could not save the schedule (' + x.status + ').')); }
      });
    });
    el('tenancies').querySelectorAll('[data-sched-off]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = Number(b.getAttribute('data-sched-off'));
        var x = await api('POST', '/api/owner/schedules/' + id + '/deactivate', {});
        if (x.status === 200) { loadTenancies(); } else { alert(x.data.error || ('Could not deactivate the schedule (' + x.status + ').')); }
      });
    });
    el('tenancies').querySelectorAll('[data-bill-amount]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = Number(b.getAttribute('data-bill-amount'));
        var x = await api('POST', '/api/owner/bills/' + id + '/amount', { amount_pkr: Number(el('bill-amt-' + id).value) });
        if (x.status === 200) { loadTenancies(); } else { alert(x.data.error || ('Could not save the amount (' + x.status + ').')); }
      });
    });
  }

  (async function init() {
    var me = await loadMe();
    if (!me) return;
    loadHouses();
    loadRequests();
    loadTenancies();
    loadPendingPayments();
  })();
})();
