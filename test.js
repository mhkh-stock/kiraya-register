// Kiraya Register final tests (Phases 1–6).
// Spawns server.js on a throwaway DB + uploads dir (port 3098), runs
// assertions, kills the server. Run: node test.js
// Env used: ADMIN_CODE=test-admin-code, LOGIN_LOCK_SECONDS=2.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { DatabaseSync } = require('node:sqlite');
const PORT = 3098;
const BASE = 'http://127.0.0.1:' + PORT;
const MASTER = 'test-admin-code';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiraya-test-'));
const DB_FILE = path.join(tmp, 'test.sqlite');
const UPLOADS_DIR = path.join(tmp, 'uploads');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok - ' + name); }
  else { failed++; failures.push(name); console.log('  FAIL - ' + name + (extra ? ' :: ' + extra : '')); }
}

async function req(method, p, opts) {
  const o = opts || {};
  const headers = { 'Content-Type': 'application/json', ...(o.headers || {}) };
  if (o.ip) headers['X-Forwarded-For'] = o.ip;
  if (o.cookie) headers.Cookie = o.cookie;
  if (o.master) headers['X-Master-Code'] = o.master;
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  const setCookie = res.headers.get('set-cookie') || '';
  return { status: res.status, headers: res.headers, text, json, setCookie };
}
function cookieOf(r) {
  const m = r.setCookie.match(/kiraya_session=[^;]+/);
  return m ? m[0] : '';
}
let ipCounter = 10;
function nextIp() { return '10.1.0.' + (ipCounter++); }

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.status === 200) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_FILE, UPLOADS_DIR, ADMIN_CODE: MASTER, LOGIN_LOCK_SECONDS: '2' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });
  try {
    check('server starts and answers /health', await waitHealth());

    // --- /health ---
    let r = await req('GET', '/health');
    check('/health returns {"ok":true}', r.status === 200 && r.json && r.json.ok === true, r.text);
    check('security headers present on /health',
      r.headers.get('x-content-type-options') === 'nosniff'
      && r.headers.get('referrer-policy') === 'no-referrer-when-downgrade'
      && r.headers.get('x-frame-options') === 'SAMEORIGIN',
      JSON.stringify([...r.headers.entries()]));

    // --- register: owner 201 ---
    const ownerIp = nextIp();
    r = await req('POST', '/api/auth/register', { ip: ownerIp, body: {
      gmail: 'owner1@gmail.com', password: 'ownerpass1', display_name: 'Malik Sahib',
      phone: '0300-1234567', role: 'owner',
    } });
    check('register owner 201', r.status === 201 && r.json && r.json.user && r.json.user.role === 'owner', r.status + ' ' + r.text);
    const ownerId = r.json && r.json.user ? r.json.user.id : null;

    // --- register: tenant 201 ---
    r = await req('POST', '/api/auth/register', { ip: nextIp(), body: {
      gmail: 'tenant1@gmail.com', password: 'tenantpass1', display_name: 'Ahmed Raza',
      phone: '0312-7654321', cnic: '3520212345671', role: 'tenant',
    } });
    check('register tenant 201', r.status === 201 && r.json && r.json.user && r.json.user.role === 'tenant', r.status + ' ' + r.text);
    const tenantId = r.json && r.json.user ? r.json.user.id : null;

    // --- validation failures (fresh IP each, so the register limit cannot interfere) ---
    r = await req('POST', '/api/auth/register', { ip: nextIp(), body: {
      gmail: 'owner1@gmail.com', password: 'otherpass1', display_name: 'Dup',
      phone: '0300-1234567', role: 'owner',
    } });
    check('duplicate Gmail 409', r.status === 409, r.status + ' ' + r.text);

    r = await req('POST', '/api/auth/register', { ip: nextIp(), body: {
      gmail: 'not-an-email', password: 'validpass1', display_name: 'Bad',
      phone: '0300-1234567', role: 'owner',
    } });
    check('invalid Gmail 400', r.status === 400, r.status + ' ' + r.text);

    r = await req('POST', '/api/auth/register', { ip: nextIp(), body: {
      gmail: 'badphone@gmail.com', password: 'validpass1', display_name: 'Bad',
      phone: '12345', role: 'owner',
    } });
    check('invalid phone 400', r.status === 400, r.status + ' ' + r.text);

    r = await req('POST', '/api/auth/register', { ip: nextIp(), body: {
      gmail: 'nocnic@gmail.com', password: 'validpass1', display_name: 'No Cnic',
      phone: '0300-1234567', role: 'tenant',
    } });
    check('tenant without CNIC 400', r.status === 400, r.status + ' ' + r.text);

    r = await req('POST', '/api/auth/register', { ip: nextIp(), body: {
      gmail: 'badcnic@gmail.com', password: 'validpass1', display_name: 'Bad Cnic',
      phone: '0300-1234567', cnic: '12345', role: 'tenant',
    } });
    check('tenant with bad CNIC 400', r.status === 400, r.status + ' ' + r.text);

    r = await req('POST', '/api/auth/register', { ip: nextIp(), body: {
      gmail: 'shortpw@gmail.com', password: 'short', display_name: 'Short',
      phone: '0300-1234567', role: 'owner',
    } });
    check('short password 400', r.status === 400, r.status + ' ' + r.text);

    r = await req('POST', '/api/auth/register', { ip: nextIp(), body: {
      gmail: 'unknownfield@gmail.com', password: 'validpass1', display_name: 'X',
      phone: '0300-1234567', role: 'owner', admin: true,
    } });
    check('unknown field 400', r.status === 400, r.status + ' ' + r.text);

    // --- register rate limit: 3/hour per IP, 4th is 429 ---
    const rlIp = nextIp();
    for (let i = 1; i <= 3; i++) {
      r = await req('POST', '/api/auth/register', { ip: rlIp, body: {
        gmail: 'rl' + i + '@gmail.com', password: 'validpass1', display_name: 'RL ' + i,
        phone: '0300-1234567', role: 'owner',
      } });
      check('register rate limit attempt ' + i + ' allowed (201)', r.status === 201, r.status + ' ' + r.text);
    }
    r = await req('POST', '/api/auth/register', { ip: rlIp, body: {
      gmail: 'rl4@gmail.com', password: 'validpass1', display_name: 'RL 4',
      phone: '0300-1234567', role: 'owner',
    } });
    check('register rate limit 429 on 4th', r.status === 429, r.status + ' ' + r.text);

    // --- login: wrong password 401 generic ---
    const loginIp = nextIp();
    r = await req('POST', '/api/auth/login', { ip: loginIp, body: { gmail: 'owner1@gmail.com', password: 'wrongpass' } });
    check('login wrong password 401', r.status === 401, r.status + ' ' + r.text);
    check('login error is generic (no hint which field)', r.json && r.json.error === 'invalid Gmail or password', r.text);

    // --- login lockout: 5 fails then 429 ---
    const lockIp = nextIp();
    for (let i = 1; i <= 4; i++) {
      r = await req('POST', '/api/auth/login', { ip: lockIp, body: { gmail: 'tenant1@gmail.com', password: 'wrongpass' } });
      check('lockout fail ' + i + ' is 401', r.status === 401, r.status + ' ' + r.text);
    }
    r = await req('POST', '/api/auth/login', { ip: lockIp, body: { gmail: 'tenant1@gmail.com', password: 'wrongpass' } });
    check('lockout 5th fail is 401 (lock armed)', r.status === 401, r.status + ' ' + r.text);
    r = await req('POST', '/api/auth/login', { ip: lockIp, body: { gmail: 'tenant1@gmail.com', password: 'tenantpass1' } });
    check('login lockout 429 after 5 fails', r.status === 429, r.status + ' ' + r.text);
    await new Promise((res2) => setTimeout(res2, 2500)); // LOGIN_LOCK_SECONDS=2
    r = await req('POST', '/api/auth/login', { ip: nextIp(), body: { gmail: 'tenant1@gmail.com', password: 'tenantpass1' } });
    check('login works again after lock expires', r.status === 200, r.status + ' ' + r.text);

    // --- login success sets HttpOnly SameSite=Lax cookie ---
    r = await req('POST', '/api/auth/login', { ip: nextIp(), body: { gmail: 'owner1@gmail.com', password: 'ownerpass1' } });
    check('login success 200', r.status === 200 && r.json && r.json.user && r.json.user.display_name === 'Malik Sahib', r.status + ' ' + r.text);
    check('login sets HttpOnly SameSite=Lax cookie',
      /HttpOnly/.test(r.setCookie) && /SameSite=Lax/.test(r.setCookie) && r.setCookie.startsWith('kiraya_session='),
      r.setCookie);
    const ownerCookie = cookieOf(r);

    // --- /me ---
    r = await req('GET', '/api/auth/me', { cookie: ownerCookie });
    check('/me 200 with cookie', r.status === 200 && r.json && r.json.user && r.json.user.role === 'owner', r.status + ' ' + r.text);
    r = await req('GET', '/api/auth/me');
    check('/me 401 without cookie', r.status === 401, r.status + ' ' + r.text);

    // --- logout kills session ---
    r = await req('POST', '/api/auth/logout', { cookie: ownerCookie });
    check('logout 200', r.status === 200, r.status + ' ' + r.text);
    r = await req('GET', '/api/auth/me', { cookie: ownerCookie });
    check('/me 401 after logout', r.status === 401, r.status + ' ' + r.text);

    // --- change-password works + old password fails after ---
    r = await req('POST', '/api/auth/login', { ip: nextIp(), body: { gmail: 'owner1@gmail.com', password: 'ownerpass1' } });
    const cpCookie = cookieOf(r);
    // A second session for the same account, open before the change.
    r = await req('POST', '/api/auth/login', { ip: nextIp(), body: { gmail: 'owner1@gmail.com', password: 'ownerpass1' } });
    const cpCookie2 = cookieOf(r);
    check('second login before change-password 200', r.status === 200 && !!cpCookie2, r.status + ' ' + r.text);
    r = await req('POST', '/api/auth/change-password', { cookie: cpCookie, body: { current: 'ownerpass1', next: 'ownerpass2' } });
    check('change-password 200', r.status === 200, r.status + ' ' + r.text);
    check('change-password returns a fresh session cookie for this browser',
      !!cookieOf(r), 'no Set-Cookie on the change-password response');
    r = await req('GET', '/api/auth/me', { cookie: cookieOf(r) || cpCookie });
    check('changing browser stays logged in on the fresh cookie', r.status === 200, r.status + ' ' + r.text);
    r = await req('GET', '/api/auth/me', { cookie: cpCookie2 });
    check('change-password kills other sessions (/me 401)', r.status === 401, r.status + ' ' + r.text);
    r = await req('GET', '/api/auth/me', { cookie: cpCookie });
    check('change-password kills the old cookie of this browser too (/me 401)', r.status === 401, r.status + ' ' + r.text);
    r = await req('POST', '/api/auth/login', { ip: nextIp(), body: { gmail: 'owner1@gmail.com', password: 'ownerpass1' } });
    check('old password fails after change-password', r.status === 401, r.status + ' ' + r.text);
    r = await req('POST', '/api/auth/login', { ip: nextIp(), body: { gmail: 'owner1@gmail.com', password: 'ownerpass2' } });
    check('new password works after change-password', r.status === 200, r.status + ' ' + r.text);
    const ownerCookie2 = cookieOf(r);

    // --- master: 403 without code and with wrong code ---
    r = await req('GET', '/api/master/users');
    check('master users 403 without code', r.status === 403, r.status + ' ' + r.text);
    r = await req('GET', '/api/master/users', { master: 'wrong-code' });
    check('master users 403 with wrong code', r.status === 403, r.status + ' ' + r.text);
    r = await req('GET', '/api/master/stats');
    check('master stats 403 without code', r.status === 403, r.status + ' ' + r.text);
    r = await req('GET', '/api/master/audit');
    check('master audit 403 without code', r.status === 403, r.status + ' ' + r.text);

    // --- master users list: never contains a full CNIC ---
    r = await req('GET', '/api/master/users', { master: MASTER });
    check('master users 200 with code', r.status === 200 && Array.isArray(r.json.users), r.status + ' ' + r.text);
    check('master users list never contains a full CNIC value',
      !r.text.includes('3520212345671') && !r.text.includes('35202-1234567-1'),
      'full CNIC leaked in master list');
    const tenantRow = (r.json.users || []).find((u) => u.id === tenantId);
    check('master users list shows CNIC last-4 only (5671)',
      !!tenantRow && tenantRow.cnic_last4 === '5671' && !('cnic' in tenantRow),
      JSON.stringify(tenantRow));
    r = await req('GET', '/api/master/users?role=tenant', { master: MASTER });
    check('master users ?role=tenant filters', r.status === 200 && r.json.users.every((u) => u.role === 'tenant'), r.status + ' ' + r.text);
    r = await req('GET', '/api/master/stats', { master: MASTER });
    check('master stats counts only', r.status === 200 && r.json.users >= 2 && r.json.houses === 0 && r.json.messages === 0, r.status + ' ' + r.text);

    // --- suspend kills sessions + login blocked while suspended ---
    r = await req('POST', '/api/auth/login', { ip: nextIp(), body: { gmail: 'tenant1@gmail.com', password: 'tenantpass1' } });
    const tenantCookie = cookieOf(r);
    check('tenant login 200 before suspend', r.status === 200, r.status + ' ' + r.text);
    r = await req('POST', '/api/master/users/suspend', { master: MASTER, body: { user_id: tenantId } });
    check('master suspend 200', r.status === 200 && r.json.user.status === 'suspended', r.status + ' ' + r.text);
    r = await req('GET', '/api/auth/me', { cookie: tenantCookie });
    check('suspend kills sessions (/me 401)', r.status === 401, r.status + ' ' + r.text);
    r = await req('POST', '/api/auth/login', { ip: nextIp(), body: { gmail: 'tenant1@gmail.com', password: 'tenantpass1' } });
    check('login blocked while suspended (403)', r.status === 403, r.status + ' ' + r.text);

    // --- reinstate restores login ---
    r = await req('POST', '/api/master/users/reinstate', { master: MASTER, body: { user_id: tenantId } });
    check('master reinstate 200', r.status === 200 && r.json.user.status === 'active', r.status + ' ' + r.text);
    r = await req('POST', '/api/auth/login', { ip: nextIp(), body: { gmail: 'tenant1@gmail.com', password: 'tenantpass1' } });
    check('reinstate restores login', r.status === 200, r.status + ' ' + r.text);
    const tenantCookie2 = cookieOf(r);

    // --- password-reset kills sessions + new password works ---
    r = await req('POST', '/api/master/password-reset', { master: MASTER, body: { user_id: tenantId, new_password: 'tenantpass9' } });
    check('master password-reset 200', r.status === 200, r.status + ' ' + r.text);
    r = await req('GET', '/api/auth/me', { cookie: tenantCookie2 });
    check('password-reset kills sessions (/me 401)', r.status === 401, r.status + ' ' + r.text);
    r = await req('POST', '/api/auth/login', { ip: nextIp(), body: { gmail: 'tenant1@gmail.com', password: 'tenantpass1' } });
    check('old password fails after password-reset', r.status === 401, r.status + ' ' + r.text);
    r = await req('POST', '/api/auth/login', { ip: nextIp(), body: { gmail: 'tenant1@gmail.com', password: 'tenantpass9' } });
    check('new password works after password-reset', r.status === 200, r.status + ' ' + r.text);

    // --- master audit has rows for register/suspend/reinstate/password-reset ---
    r = await req('GET', '/api/master/audit', { master: MASTER });
    const actions = (r.json.rows || []).map((row) => row.action);
    check('audit has register rows', actions.includes('auth.register'), JSON.stringify(actions));
    check('audit has suspend row', actions.includes('master.suspend'), JSON.stringify(actions));
    check('audit has reinstate row', actions.includes('master.reinstate'), JSON.stringify(actions));
    check('audit has password-reset row', actions.includes('master.password-reset'), JSON.stringify(actions));

    // --- security headers on an API response ---
    r = await req('GET', '/api/auth/me', { cookie: ownerCookie2 });
    check('security headers present on API response',
      r.headers.get('x-content-type-options') === 'nosniff'
      && r.headers.get('x-frame-options') === 'SAMEORIGIN',
      JSON.stringify([...r.headers.entries()]));

    // ================= Phase 2: houses + link codes + tenancy approval =================
    let userSeq = 0;
    async function makeUser(role, opts) {
      userSeq++;
      const tag = 'p2' + role + userSeq;
      const body = {
        gmail: tag + '@gmail.com', password: 'password' + userSeq + 'x',
        display_name: (opts && opts.name) || ('User ' + userSeq),
        phone: (opts && opts.phone) || '0300-1234567', role,
      };
      if (role === 'tenant') body.cnic = (opts && opts.cnic) || '3520212345671';
      const rr = await req('POST', '/api/auth/register', { ip: nextIp(), body });
      if (rr.status !== 201) throw new Error('makeUser failed: ' + rr.status + ' ' + rr.text);
      return { id: rr.json.user.id, gmail: body.gmail, cookie: cookieOf(rr), password: body.password };
    }
    function houseBody(over) {
      return {
        title: 'House 12-B, Street 4', kind: 'house', address: '12-B Street 4, Gulberg',
        city: 'Lahore', area: 'Gulberg III', bedrooms: 3, bathrooms: 2, rent_pkr: 45000,
        advance_pkr: 90000, security_deposit_pkr: 45000, bills_included: ['water'],
        maps_url: 'https://www.google.com/maps/place/Gulberg', plus_code: '8H6J+2X Lahore',
        available_from: '2026-11-10', ...(over || {}),
      };
    }
    async function uploadPhoto(cookie, houseId, bytes, filename) {
      const fd = new FormData();
      fd.append('photo', new Blob([bytes], { type: 'image/jpeg' }), filename);
      const res = await fetch(BASE + '/api/owner/houses/' + houseId + '/photos', {
        method: 'POST', headers: { Cookie: cookie }, body: fd,
      });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, text, json };
    }
    const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9]);
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(16, 0)]);
    const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 '), Buffer.alloc(8, 0)]);

    const ownerA = await makeUser('owner', { name: 'Malik Sahib A' });
    const ownerB = await makeUser('owner', { name: 'Malik Sahib B' });
    const tenantA = await makeUser('tenant', { name: 'Ahmed Raza' });
    const tenantB = await makeUser('tenant', { name: 'Bilal Khan' });
    const tenantC = await makeUser('tenant', { name: 'Usman Ali' });

    // --- house create 201 + auto code ---
    r = await req('POST', '/api/owner/houses', { cookie: ownerA.cookie, body: houseBody() });
    check('owner creates house 201', r.status === 201 && r.json && r.json.house && r.json.house.status === 'vacant', r.status + ' ' + r.text);
    const houseA = r.json.house;
    const codeA = r.json.code;
    check('house create returns KRY- code + share text',
      /^KRY-[A-HJ-NP-Z2-9]{6}$/.test(codeA) && r.json.share_text === 'Your house code is ' + codeA + ' — open the app and enter it',
      r.text);
    r = await req('POST', '/api/owner/houses', { cookie: ownerB.cookie, body: houseBody({ title: 'Flat 5, Clifton', kind: 'flat', city: 'Karachi', area: 'Clifton', rent_pkr: 60000 }) });
    check('owner B creates house 201', r.status === 201, r.status + ' ' + r.text);
    const houseB = r.json.house;

    // --- list scoping ---
    r = await req('GET', '/api/owner/houses', { cookie: ownerA.cookie });
    check('owner A list sees only A houses', r.status === 200 && r.json.houses.length === 1 && r.json.houses[0].id === houseA.id, r.text);
    r = await req('GET', '/api/owner/houses', { cookie: ownerB.cookie });
    check('owner B list sees only B houses', r.status === 200 && r.json.houses.length === 1 && r.json.houses[0].id === houseB.id, r.text);
    r = await req('GET', '/api/owner/houses');
    check('houses list 401 without login', r.status === 401, r.status + ' ' + r.text);
    r = await req('GET', '/api/owner/houses', { cookie: tenantA.cookie });
    check('tenant fetching houses without a code → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/houses', { cookie: tenantA.cookie, body: houseBody() });
    check('tenant creating a house → 403', r.status === 403, r.status + ' ' + r.text);

    // --- house create validation ---
    const badHouses = [
      ['bad kind', { kind: 'palace' }],
      ['zero rent', { rent_pkr: 0 }],
      ['negative rent', { rent_pkr: -5 }],
      ['string rent', { rent_pkr: '45000' }],
      ['bad maps host', { maps_url: 'https://example.com/maps/x' }],
      ['bad maps path', { maps_url: 'https://google.com/search?q=lahore' }],
      ['bad bills_included', { bills_included: ['swimming-pool'] }],
      ['missing title', { title: '' }],
      ['unknown field', { owner_id: 999 }],
      ['bad available_from', { available_from: '10-11-2026' }],
    ];
    for (const [name, over] of badHouses) {
      r = await req('POST', '/api/owner/houses', { cookie: ownerA.cookie, body: houseBody(over) });
      check('house create ' + name + ' → 400', r.status === 400, r.status + ' ' + r.text);
    }
    r = await req('POST', '/api/owner/houses', { cookie: ownerA.cookie, body: houseBody({ maps_url: 'https://maps.google.com/?q=Gulberg+Lahore' }) });
    check('house create with maps.google.com share link 201', r.status === 201, r.status + ' ' + r.text);
    const houseMaps = r.json.house;

    // --- edit / hide ---
    r = await req('PUT', '/api/owner/houses/' + houseA.id, { cookie: ownerA.cookie, body: { rent_pkr: 50000 } });
    check('owner edits own house 200 + rent updated', r.status === 200 && r.json.house.rent_pkr === 50000, r.status + ' ' + r.text);
    r = await req('PUT', '/api/owner/houses/' + houseA.id, { cookie: ownerB.cookie, body: { rent_pkr: 1 } });
    check('edit foreign house → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('PUT', '/api/owner/houses/' + houseA.id, { cookie: ownerA.cookie, body: { status: 'occupied' } });
    check('edit with unknown field → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('PUT', '/api/owner/houses/' + houseA.id, { cookie: ownerA.cookie, body: { kind: 'palace' } });
    check('edit with bad kind → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/houses/' + houseMaps.id + '/hide', { cookie: ownerA.cookie });
    check('owner hides own house 200', r.status === 200 && r.json.house.status === 'hidden', r.status + ' ' + r.text);
    const houseHide = r.json.house;
    r = await req('POST', '/api/owner/houses/' + houseB.id + '/hide', { cookie: ownerA.cookie });
    check('hide foreign house → 403', r.status === 403, r.status + ' ' + r.text);

    // --- photos ---
    let up = await uploadPhoto(ownerA.cookie, houseA.id, JPEG, 'front.jpg');
    check('photo upload valid JPEG 201', up.status === 201 && up.json && up.json.file_url, up.status + ' ' + up.text);
    const photoUrl = up.json.file_url;
    let fr = await fetch(BASE + photoUrl, { headers: { Cookie: ownerA.cookie } });
    check('photo serves 200 with image MIME to owner', fr.status === 200 && (fr.headers.get('content-type') || '').startsWith('image/jpeg'), fr.status + ' ' + fr.headers.get('content-type'));
    fr = await fetch(BASE + photoUrl, { headers: { Cookie: ownerB.cookie } });
    check('photo serves 403 to other owner', fr.status === 403, String(fr.status));
    fr = await fetch(BASE + photoUrl);
    check('photo serves 401 without login', fr.status === 401, String(fr.status));
    up = await uploadPhoto(ownerA.cookie, houseA.id, PNG, 'plan.png');
    check('photo upload valid PNG 201', up.status === 201, up.status + ' ' + up.text);
    up = await uploadPhoto(ownerA.cookie, houseA.id, WEBP, 'view.webp');
    check('photo upload valid WebP 201', up.status === 201, up.status + ' ' + up.text);
    up = await uploadPhoto(ownerA.cookie, houseA.id, Buffer.from('hello, not an image at all'), 'fake.jpg');
    check('bad magic bytes → 400', up.status === 400, up.status + ' ' + up.text);
    up = await uploadPhoto(ownerA.cookie, houseA.id, JPEG, 'front.txt');
    check('bad extension → 400', up.status === 400, up.status + ' ' + up.text);
    up = await uploadPhoto(ownerA.cookie, houseA.id, JPEG, 'front.png');
    check('extension must match magic bytes → 400', up.status === 400, up.status + ' ' + up.text);
    up = await uploadPhoto(ownerB.cookie, houseA.id, JPEG, 'front.jpg');
    check('foreign-house upload → 403', up.status === 403, up.status + ' ' + up.text);
    const big = Buffer.alloc(5 * 1024 * 1024 + 100, 0xFF);
    big[0] = 0xFF; big[1] = 0xD8; big[2] = 0xFF;
    up = await uploadPhoto(ownerA.cookie, houseA.id, big, 'big.jpg');
    check('oversize photo → 413', up.status === 413, up.status + ' ' + up.text.slice(0, 120));
    fr = await fetch(BASE + '/api/photos/file/photo-notreal.jpg', { headers: { Cookie: ownerA.cookie } });
    check('unknown photo filename → 404', fr.status === 404, String(fr.status));
    fr = await fetch(BASE + '/api/photos/file/../../server.js', { headers: { Cookie: ownerA.cookie } });
    check('photo path traversal → 404 (never serves outside uploads)', fr.status === 404, String(fr.status));

    // --- 8-photo cap ---
    r = await req('POST', '/api/owner/houses', { cookie: ownerA.cookie, body: houseBody({ title: 'Cap House' }) });
    const houseCap = r.json.house;
    for (let i = 1; i <= 8; i++) {
      up = await uploadPhoto(ownerA.cookie, houseCap.id, JPEG, 'p' + i + '.jpg');
      check('cap photo ' + i + ' 201', up.status === 201, up.status + ' ' + up.text);
    }
    up = await uploadPhoto(ownerA.cookie, houseCap.id, JPEG, 'p9.jpg');
    check('9th photo → 400 cap', up.status === 400, up.status + ' ' + up.text);

    // --- link codes ---
    r = await req('GET', '/api/owner/houses/' + houseA.id + '/code', { cookie: ownerA.cookie });
    check('code get returns KRY- code + share text', r.status === 200 && r.json.code === codeA
      && r.json.share_text === 'Your house code is ' + codeA + ' — open the app and enter it', r.status + ' ' + r.text);
    r = await req('GET', '/api/owner/houses/' + houseA.id + '/code', { cookie: ownerB.cookie });
    check('code get foreign house → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/houses/' + houseA.id + '/code/regenerate', { cookie: ownerA.cookie });
    check('regenerate returns a new code', r.status === 200 && r.json.code !== codeA && /^KRY-[A-HJ-NP-Z2-9]{6}$/.test(r.json.code), r.status + ' ' + r.text);
    const codeA2 = r.json.code;
    r = await req('POST', '/api/owner/houses/' + houseA.id + '/code/regenerate', { cookie: ownerB.cookie });
    check('regenerate foreign house → 403', r.status === 403, r.status + ' ' + r.text);

    // --- tenant link: generic errors, hidden house, rate limit ---
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: tenantA.cookie, body: { code: codeA } });
    check('old code after regenerate → generic error', r.status === 400 && r.json.error === 'code not recognised' && !r.text.includes('House 12-B'), r.status + ' ' + r.text);
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: tenantA.cookie, body: { code: 'KRY-XXXXXX' } });
    check('wrong code → generic error, no house info', r.status === 400 && r.json.error === 'code not recognised'
      && !r.text.includes('House') && !r.text.includes('Gulberg') && !r.text.includes('Lahore'), r.status + ' ' + r.text);
    r = await req('GET', '/api/owner/houses/' + houseHide.id + '/code', { cookie: ownerA.cookie });
    const hiddenCode = r.json.code;
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: tenantC.cookie, body: { code: hiddenCode } });
    check('link to hidden house → generic error', r.status === 400 && r.json.error === 'code not recognised', r.status + ' ' + r.text);
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: ownerA.cookie, body: { code: codeA2 } });
    check('owner linking as tenant → 403', r.status === 403, r.status + ' ' + r.text);

    const tenantRL = await makeUser('tenant', { name: 'Rate Limited' });
    const linkRlIp = nextIp();
    for (let i = 1; i <= 5; i++) {
      r = await req('POST', '/api/tenant/link', { ip: linkRlIp, cookie: tenantRL.cookie, body: { code: 'KRY-000000' } });
      check('link rate limit attempt ' + i + ' is 400 generic', r.status === 400 && r.json.error === 'code not recognised', r.status + ' ' + r.text);
    }
    r = await req('POST', '/api/tenant/link', { ip: linkRlIp, cookie: tenantRL.cookie, body: { code: 'KRY-000000' } });
    check('link rate limit 6th attempt → 429', r.status === 429, r.status + ' ' + r.text);

    // --- link creates a requested tenancy ---
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: tenantA.cookie, body: { code: codeA2 } });
    check('link with valid code creates requested tenancy', r.status === 201 && r.json.tenancy && r.json.tenancy.status === 'requested', r.status + ' ' + r.text);
    const tenancyA = r.json.tenancy.id;
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: tenantA.cookie, body: { code: codeA2 } });
    check('duplicate request same house → 409', r.status === 409, r.status + ' ' + r.text);

    // --- LINK-FIRST: a requested tenancy has nothing else ---
    r = await req('GET', '/api/owner/tenancies/' + tenancyA, { cookie: ownerA.cookie });
    check('requested tenancy detail 200', r.status === 200 && r.json.tenancy.status === 'requested', r.status + ' ' + r.text);
    check('LINK-FIRST: requested tenancy has zero schedules', Array.isArray(r.json.tenancy.schedules) && r.json.tenancy.schedules.length === 0, JSON.stringify(r.json.tenancy.schedules));
    check('LINK-FIRST: requested tenancy has zero bills', Array.isArray(r.json.tenancy.bills) && r.json.tenancy.bills.length === 0, JSON.stringify(r.json.tenancy.bills));
    check('LINK-FIRST: requested tenancy has zero payments', Array.isArray(r.json.tenancy.payments) && r.json.tenancy.payments.length === 0, JSON.stringify(r.json.tenancy.payments));
    check('LINK-FIRST: owner detail shows full CNIC to the linked owner', r.json.tenancy.tenant.cnic === '3520212345671', JSON.stringify(r.json.tenancy.tenant));

    // --- link requests queue (CNIC last-4 only) ---
    r = await req('GET', '/api/owner/link-requests', { cookie: ownerA.cookie });
    check('link requests show pending request with CNIC last-4 only',
      r.status === 200 && r.json.requests.length === 1 && r.json.requests[0].tenant.cnic_last4 === '5671'
      && !r.text.includes('3520212345671'), r.status + ' ' + r.text);
    r = await req('GET', '/api/owner/link-requests', { cookie: ownerB.cookie });
    check('link requests scoped to own houses', r.status === 200 && r.json.requests.length === 0, r.status + ' ' + r.text);

    // --- second pending request (tenant B → owner B flat) for decide tests ---
    r = await req('GET', '/api/owner/houses/' + houseB.id + '/code', { cookie: ownerB.cookie });
    const codeB = r.json.code;
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: tenantB.cookie, body: { code: codeB } });
    check('tenant B links to owner B house (requested)', r.status === 201 && r.json.tenancy.status === 'requested', r.status + ' ' + r.text);
    const tenancyB = r.json.tenancy.id;
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: ownerB.cookie, body: { tenancy_id: tenancyB, decision: 'approve', rent_pkr: 60000, due_day: 29, start_date: '2026-11-10' } });
    check('approve with due_day 29 → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: ownerB.cookie, body: { tenancy_id: tenancyB, decision: 'approve', rent_pkr: 60000, due_day: 5, start_date: '2026-13-10' } });
    check('approve with bad start_date → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: ownerB.cookie, body: { tenancy_id: tenancyB, decision: 'maybe' } });
    check('decide with bad decision → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: ownerA.cookie, body: { tenancy_id: tenancyB, decision: 'reject', reason: 'Not mine.' } });
    check('decide on foreign tenancy → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: ownerB.cookie, body: { tenancy_id: tenancyB, decision: 'reject' } });
    check('reject without reason → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: ownerB.cookie, body: { tenancy_id: tenancyB, decision: 'reject', reason: 'References did not check out.' } });
    check('reject with reason → rejected', r.status === 200 && r.json.tenancy.status === 'rejected', r.status + ' ' + r.text);

    // --- approve tenancy A ---
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: ownerA.cookie, body: { tenancy_id: tenancyA, decision: 'approve', rent_pkr: 50000, due_day: 5, start_date: '2026-11-10', end_date: '2027-10-09', agreement_registered: 1, police_registered: 1, agreement_note: 'E-stamp, 11 months.' } });
    check('approve → active with rent/due day/dates', r.status === 200 && r.json.tenancy.status === 'active'
      && r.json.tenancy.rent_pkr === 50000 && r.json.tenancy.due_day === 5
      && r.json.tenancy.start_date === '2026-11-10' && r.json.tenancy.end_date === '2027-10-09', r.status + ' ' + r.text);
    check('approve sets agreement + police ticks', r.json.tenancy.agreement_registered === 1 && r.json.tenancy.police_registered === 1, r.text);
    check('approve creates rent schedule with right amount/due day',
      Array.isArray(r.json.tenancy.schedules) && r.json.tenancy.schedules.length === 1
      && r.json.tenancy.schedules[0].kind === 'rent' && r.json.tenancy.schedules[0].amount_pkr === 50000
      && r.json.tenancy.schedules[0].due_day === 5, JSON.stringify(r.json.tenancy.schedules));
    r = await req('GET', '/api/owner/houses', { cookie: ownerA.cookie });
    const houseAView = (r.json.houses || []).find((h) => h.id === houseA.id);
    check('house occupied after approve, with tenant named', houseAView && houseAView.status === 'occupied'
      && houseAView.tenant && houseAView.tenant.display_name === 'Ahmed Raza', JSON.stringify(houseAView));
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: ownerA.cookie, body: { tenancy_id: tenancyA, decision: 'approve', rent_pkr: 1, due_day: 1, start_date: '2026-11-10' } });
    check('decide on already-decided tenancy → 400', r.status === 400, r.status + ' ' + r.text);

    // --- one active tenancy per tenant ---
    r = await req('GET', '/api/owner/houses/' + houseCap.id + '/code', { cookie: ownerA.cookie });
    const codeCap = r.json.code;
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: tenantA.cookie, body: { code: codeCap } });
    check('second active tenancy for same tenant → 409', r.status === 409, r.status + ' ' + r.text);

    // --- tenant tenancy read ---
    r = await req('GET', '/api/tenant/tenancy', { cookie: tenantA.cookie });
    check('tenant sees own active tenancy', r.status === 200 && r.json.tenancy && r.json.tenancy.id === tenancyA && r.json.tenancy.status === 'active', r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/tenancy', { cookie: tenantC.cookie });
    check('tenant with no tenancy gets empty state', r.status === 200 && r.json.tenancy === null, r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/tenancy', { cookie: ownerA.cookie });
    check('tenant tenancy endpoint 403 for owner', r.status === 403, r.status + ' ' + r.text);

    // --- cross-tenant / cross-owner isolation ---
    r = await req('POST', '/api/tenant/tenancies/' + tenancyA + '/request-end', { cookie: tenantB.cookie, body: { reason: 'Moving out.' } });
    check('tenant B request-end on tenant A tenancy → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('GET', '/api/owner/tenancies/' + tenancyA, { cookie: ownerB.cookie });
    check('owner B fetching owner A tenancy → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('GET', '/api/owner/tenancies/' + tenancyB, { cookie: ownerA.cookie });
    check('owner A fetching owner B tenancy → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('GET', '/api/owner/tenancies', { cookie: ownerB.cookie });
    check('owner B tenancies list has no A tenancy', r.status === 200 && r.json.tenancies.every((t) => t.id !== tenancyA), r.text);
    r = await req('GET', '/api/owner/tenancies', { cookie: tenantA.cookie });
    check('owner tenancies list 403 for tenant', r.status === 403, r.status + ' ' + r.text);

    // --- master never sees message bodies or full CNICs ---
    r = await req('GET', '/api/master/users', { master: MASTER });
    check('master users never include full CNIC (Phase 2)', !r.text.includes('3520212345671'), 'full CNIC leaked');
    r = await req('GET', '/api/master/stats', { master: MASTER });
    check('master stats counts only, no message bodies', r.status === 200 && typeof r.json.messages === 'number' && !('"body"' in r.json) && r.json.tenancies === 2, r.status + ' ' + r.text);
    r = await req('GET', '/api/master/messages', { master: MASTER });
    check('no master message-bodies endpoint (404)', r.status === 404, r.status + ' ' + r.text);

    // --- request-end + owner end ---
    r = await req('POST', '/api/tenant/tenancies/' + tenancyA + '/request-end', { cookie: tenantA.cookie, body: { reason: 'Moving to another city.' } });
    check('tenant request-end 200', r.status === 200, r.status + ' ' + r.text);
    r = await req('POST', '/api/tenant/tenancies/' + tenancyA + '/request-end', { cookie: tenantA.cookie, body: {} });
    check('request-end without reason → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/tenancies/' + tenancyA + '/end', { cookie: ownerB.cookie, body: { reason: 'x' } });
    check('owner end foreign tenancy → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/tenancies/' + tenancyA + '/end', { cookie: ownerA.cookie, body: { reason: 'Tenant moved out.' } });
    check('owner end → ended', r.status === 200 && r.json.tenancy.status === 'ended', r.status + ' ' + r.text);
    r = await req('GET', '/api/owner/houses', { cookie: ownerA.cookie });
    check('house vacant after end', (r.json.houses || []).find((h) => h.id === houseA.id).status === 'vacant', r.text);
    r = await req('POST', '/api/owner/tenancies/' + tenancyA + '/end', { cookie: ownerA.cookie, body: { reason: 'again' } });
    check('end on ended tenancy → 400 (read-only)', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/tenant/tenancies/' + tenancyA + '/request-end', { cookie: tenantA.cookie, body: { reason: 'again' } });
    check('request-end on ended tenancy → 400 (read-only)', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: tenantA.cookie, body: { code: codeA2 } });
    check('link with deactivated code after end → generic error', r.status === 400 && r.json.error === 'code not recognised', r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/houses/' + houseA.id + '/code/regenerate', { cookie: ownerA.cookie });
    check('regenerate after end re-activates linking', r.status === 200 && r.json.code, r.status + ' ' + r.text);
    const codeA3 = r.json.code;
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: tenantA.cookie, body: { code: codeA3 } });
    check('after regenerate, tenant can link again (requested)', r.status === 201 && r.json.tenancy.status === 'requested', r.status + ' ' + r.text);

    // --- audit rows for link approve/reject + tenancy end ---
    r = await req('GET', '/api/master/audit', { master: MASTER });
    const actions2 = (r.json.rows || []).map((row) => row.action);
    check('audit has link.approved', actions2.includes('link.approved'), JSON.stringify(actions2));
    check('audit has link.rejected', actions2.includes('link.rejected'), JSON.stringify(actions2));
    check('audit has tenancy.ended', actions2.includes('tenancy.ended'), JSON.stringify(actions2));
    check('audit has link.requested', actions2.includes('link.requested'), JSON.stringify(actions2));

    // ================= Phase 3: schedules + bills + notifications =================
    // Dates are computed from today so the suite is date-independent:
    // rent is due a few days out, gas is due within 3 days (or today, or
    // already past on the 29th–31st), electricity is due yesterday.
    const nowD = new Date();
    const curMonth = nowD.getFullYear() + '-' + String(nowD.getMonth() + 1).padStart(2, '0');
    const todayDay = nowD.getDate();
    const todayStr = curMonth + '-' + String(todayDay).padStart(2, '0');
    const rentDueDay = todayDay <= 23 ? todayDay + 5 : 28;
    const rentDueDate = curMonth + '-' + String(rentDueDay).padStart(2, '0');
    const rentExpectedStatus = rentDueDate >= todayStr ? 'due' : 'overdue';
    const gasDueDay = todayDay <= 25 ? todayDay + 3 : (todayDay <= 28 ? todayDay : 28);
    const gasDueDate = curMonth + '-' + String(gasDueDay).padStart(2, '0');
    const gasKind = gasDueDate >= todayStr ? 'bill_due' : 'bill_overdue';
    const elecDueDay = todayDay > 1 ? todayDay - 1 : 5;

    const ownerC = await makeUser('owner', { name: 'Chaudhry Sahib' });
    const tenantD = await makeUser('tenant', { name: 'Danish Ali' });
    const tenantE = await makeUser('tenant', { name: 'Ehsan Ullah' });
    r = await req('POST', '/api/owner/houses', { cookie: ownerC.cookie, body: houseBody({ title: 'House 9, Model Town', rent_pkr: 40000 }) });
    check('Phase 3: owner C creates house 201', r.status === 201, r.status + ' ' + r.text);
    const houseC = r.json.house;
    r = await req('GET', '/api/owner/houses/' + houseC.id + '/code', { cookie: ownerC.cookie });
    const codeC = r.json.code;
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: tenantD.cookie, body: { code: codeC } });
    check('Phase 3: tenant D links to owner C house (requested)', r.status === 201 && r.json.tenancy.status === 'requested', r.status + ' ' + r.text);
    const tenancyC = r.json.tenancy.id;
    // A second house with a still-requested tenancy (schedules need ACTIVE).
    r = await req('POST', '/api/owner/houses', { cookie: ownerC.cookie, body: houseBody({ title: 'Flat 2, Model Town', kind: 'flat', rent_pkr: 30000 }) });
    const houseC2 = r.json.house;
    r = await req('GET', '/api/owner/houses/' + houseC2.id + '/code', { cookie: ownerC.cookie });
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: tenantE.cookie, body: { code: r.json.code } });
    check('Phase 3: tenant E links to second house (requested)', r.status === 201 && r.json.tenancy.status === 'requested', r.status + ' ' + r.text);
    const tenancyReq = r.json.tenancy.id;
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: ownerC.cookie, body: { tenancy_id: tenancyC, decision: 'approve', rent_pkr: 40000, due_day: rentDueDay, start_date: '2026-11-01' } });
    check('Phase 3: approve tenancy C → active', r.status === 200 && r.json.tenancy.status === 'active', r.status + ' ' + r.text);
    check('Phase 3: approve creates rent schedule with due day',
      Array.isArray(r.json.tenancy.schedules) && r.json.tenancy.schedules.length === 1
      && r.json.tenancy.schedules[0].kind === 'rent' && r.json.tenancy.schedules[0].amount_pkr === 40000
      && r.json.tenancy.schedules[0].due_day === rentDueDay, JSON.stringify(r.json.tenancy.schedules));

    // --- schedule create: scoping + validation ---
    r = await req('POST', '/api/owner/schedules', { cookie: tenantD.cookie, body: { tenancy_id: tenancyC, kind: 'gas', label: 'Gas', due_day: 10 } });
    check('schedule create by tenant → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/schedules', { cookie: ownerB.cookie, body: { tenancy_id: tenancyC, kind: 'gas', label: 'Gas', due_day: 10 } });
    check('schedule create on foreign tenancy → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/schedules', { cookie: ownerC.cookie, body: { tenancy_id: 999999, kind: 'gas', label: 'Gas', due_day: 10 } });
    check('schedule create on missing tenancy → 404', r.status === 404, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/schedules', { cookie: ownerC.cookie, body: { tenancy_id: tenancyReq, kind: 'gas', label: 'Gas', due_day: 10 } });
    check('schedule create on requested tenancy → 400', r.status === 400, r.status + ' ' + r.text);
    const badSchedules = [
      ['bad kind', { kind: 'swimming-pool', due_day: 10 }],
      ['due_day 0', { kind: 'gas', due_day: 0 }],
      ['due_day 29', { kind: 'gas', due_day: 29 }],
      ['negative amount', { kind: 'gas', due_day: 10, amount_pkr: -5 }],
      ['string amount', { kind: 'gas', due_day: 10, amount_pkr: '3500' }],
      ['unknown field', { kind: 'gas', due_day: 10, owner_id: 999 }],
      ['label too long', { kind: 'gas', due_day: 10, label: 'x'.repeat(101) }],
      ['missing due_day', { kind: 'gas' }],
    ];
    for (const [name, over] of badSchedules) {
      r = await req('POST', '/api/owner/schedules', { cookie: ownerC.cookie, body: { tenancy_id: tenancyC, label: 'Gas', ...over } });
      check('schedule create ' + name + ' → 400', r.status === 400, r.status + ' ' + r.text);
    }
    r = await req('POST', '/api/owner/schedules', { cookie: ownerC.cookie, body: { tenancy_id: tenancyC, kind: 'gas', label: 'SNGPL gas', amount_pkr: null, due_day: gasDueDay, note: 'Meter reading on the 8th' } });
    check('schedule create gas (variable) 201', r.status === 201 && r.json.schedule && r.json.schedule.kind === 'gas'
      && r.json.schedule.amount_pkr === null && r.json.schedule.due_day === gasDueDay, r.status + ' ' + r.text);
    const gasSchedId = r.json.schedule.id;
    r = await req('POST', '/api/owner/schedules', { cookie: ownerC.cookie, body: { tenancy_id: tenancyC, kind: 'electricity', label: 'LESCO electricity', amount_pkr: null, due_day: elecDueDay } });
    check('schedule create electricity (variable) 201', r.status === 201 && r.json.schedule.kind === 'electricity', r.status + ' ' + r.text);
    const elecSchedId = r.json.schedule.id;
    r = await req('POST', '/api/owner/schedules', { cookie: ownerC.cookie, body: { tenancy_id: tenancyC, kind: 'internet', label: 'PTCL internet', amount_pkr: 3000, due_day: 15 } });
    check('schedule create internet (fixed) 201', r.status === 201 && r.json.schedule.amount_pkr === 3000, r.status + ' ' + r.text);
    const netSchedId = r.json.schedule.id;

    // --- schedule edit ---
    r = await req('PUT', '/api/owner/schedules/' + gasSchedId, { cookie: ownerC.cookie, body: { label: 'SNGPL gas (updated)', due_day: gasDueDay, note: 'Meter reading on the 8th' } });
    check('schedule edit label 200', r.status === 200 && r.json.schedule.label === 'SNGPL gas (updated)', r.status + ' ' + r.text);
    r = await req('PUT', '/api/owner/schedules/' + gasSchedId, { cookie: ownerB.cookie, body: { label: 'x' } });
    check('schedule edit foreign → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('PUT', '/api/owner/schedules/' + gasSchedId, { cookie: tenantD.cookie, body: { label: 'x' } });
    check('schedule edit by tenant → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('PUT', '/api/owner/schedules/' + gasSchedId, { cookie: ownerC.cookie, body: { due_day: 0 } });
    check('schedule edit bad due_day → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('PUT', '/api/owner/schedules/' + gasSchedId, { cookie: ownerC.cookie, body: { tenancy_id: tenancyC } });
    check('schedule edit unknown field → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('PUT', '/api/owner/schedules/' + gasSchedId, { cookie: ownerC.cookie, body: {} });
    check('schedule edit empty body → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('PUT', '/api/owner/schedules/999999', { cookie: ownerC.cookie, body: { label: 'x' } });
    check('schedule edit missing → 404', r.status === 404, r.status + ' ' + r.text);

    // --- schedule deactivate (before any bill generation, so no bill appears) ---
    r = await req('POST', '/api/owner/schedules/' + gasSchedId + '/deactivate', { cookie: ownerB.cookie });
    check('schedule deactivate foreign → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/schedules/' + gasSchedId + '/deactivate', { cookie: tenantD.cookie });
    check('schedule deactivate by tenant → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/schedules/999999/deactivate', { cookie: ownerC.cookie });
    check('schedule deactivate missing → 404', r.status === 404, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/schedules/' + netSchedId + '/deactivate', { cookie: ownerC.cookie });
    check('schedule deactivate internet 200 (active 0)', r.status === 200 && r.json.schedule.active === 0, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/schedules/' + netSchedId + '/deactivate', { cookie: ownerC.cookie });
    check('schedule deactivate again 200 (idempotent)', r.status === 200 && r.json.schedule.active === 0, r.status + ' ' + r.text);

    // --- lazy bill generation on tenancy open ---
    r = await req('GET', '/api/owner/tenancies/' + tenancyC, { cookie: ownerC.cookie });
    check('owner tenancy detail 200', r.status === 200 && r.json.tenancy.id === tenancyC, r.status + ' ' + r.text);
    check('owner tenancy detail includes schedules',
      Array.isArray(r.json.tenancy.schedules) && r.json.tenancy.schedules.length === 4
      && r.json.tenancy.schedules.map((s) => s.kind).sort().join(',') === 'electricity,gas,internet,rent',
      JSON.stringify((r.json.tenancy.schedules || []).map((s) => s.kind)));
    const billsC = r.json.tenancy.bills || [];
    const rentBill = billsC.find((b) => b.schedule_kind === 'rent');
    check('rent bill generated for current month with right amount + due date',
      !!rentBill && rentBill.month === curMonth && rentBill.amount_pkr === 40000
      && rentBill.due_date === rentDueDate && rentBill.status === rentExpectedStatus,
      JSON.stringify(rentBill));
    const gasBill = billsC.find((b) => b.schedule_kind === 'gas');
    check('variable gas bill has amount NULL', !!gasBill && gasBill.amount_pkr === null, JSON.stringify(gasBill));
    check('variable gas bill due date matches its schedule', !!gasBill && gasBill.due_date === gasDueDate, JSON.stringify(gasBill));
    check('deactivated internet schedule generates no bill',
      !billsC.some((b) => b.schedule_id === netSchedId), JSON.stringify(billsC.map((b) => b.schedule_id)));
    check('owner tenancy detail bills count is 3 (rent + gas + electricity)', billsC.length === 3, String(billsC.length));
    const rentCount1 = billsC.filter((b) => b.schedule_kind === 'rent' && b.month === curMonth).length;
    r = await req('GET', '/api/owner/tenancies/' + tenancyC, { cookie: ownerC.cookie });
    const rentCount2 = (r.json.tenancy.bills || []).filter((b) => b.schedule_kind === 'rent' && b.month === curMonth).length;
    check('generating twice creates no duplicate rent bill (count stays 1)', rentCount1 === 1 && rentCount2 === 1, rentCount1 + ' -> ' + rentCount2);

    // --- overdue: electricity due_day is yesterday (or a test-only date move on the 1st) ---
    let elecBill = (r.json.tenancy.bills || []).find((b) => b.schedule_kind === 'electricity');
    if (todayDay === 1) {
      // No past due_day exists in this month — move the throwaway DB row's
      // due_date to yesterday (test-only; server.js has no fake clock).
      const y = new Date(Date.now() - 86400000);
      const yStr = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0');
      const tdb = new DatabaseSync(DB_FILE);
      tdb.prepare('UPDATE bills SET due_date = ? WHERE id = ?').run(yStr, elecBill.id);
      tdb.close();
      r = await req('GET', '/api/tenant/bills', { cookie: tenantD.cookie });
      elecBill = (r.json.bills || []).find((b) => b.schedule_kind === 'electricity');
    }
    check('overdue bill is marked overdue after its due date',
      !!elecBill && elecBill.status === 'overdue', JSON.stringify(elecBill));

    // --- tenant bills: scoped, statuses, WhatsApp share link ---
    r = await req('GET', '/api/tenant/bills', { cookie: tenantD.cookie });
    check('tenant bills 200 with own bills only',
      r.status === 200 && Array.isArray(r.json.bills) && r.json.bills.length === 3
      && r.json.bills.every((b) => b.tenancy_id === tenancyC), r.status + ' ' + r.text);
    const gasBillT = (r.json.bills || []).find((b) => b.schedule_kind === 'gas');
    check('tenant view: variable bill amount is NULL (not entered)',
      !!gasBillT && gasBillT.amount_pkr === null, JSON.stringify(gasBillT));
    check('tenant bills carry a wa.me share link to the owner',
      (r.json.bills || []).every((b) => typeof b.whatsapp_share_url === 'string'
        && b.whatsapp_share_url.startsWith('https://wa.me/92')),
      JSON.stringify((r.json.bills || []).map((b) => b.whatsapp_share_url)));
    r = await req('GET', '/api/tenant/bills', { cookie: tenantB.cookie });
    check('tenant B bills list is empty (never sees tenant D bills)', r.status === 200 && Array.isArray(r.json.bills) && r.json.bills.length === 0, r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/bills', { cookie: ownerC.cookie });
    check('tenant bills 403 for owner', r.status === 403, r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/bills');
    check('tenant bills 401 without login', r.status === 401, r.status + ' ' + r.text);

    // --- variable-amount entry ---
    r = await req('POST', '/api/owner/bills/' + gasBill.id + '/amount', { cookie: tenantD.cookie, body: { amount_pkr: 3500 } });
    check('bill amount entry by tenant → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/bills/' + gasBill.id + '/amount', { cookie: ownerB.cookie, body: { amount_pkr: 3500 } });
    check('bill amount entry by other owner → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/bills/' + gasBill.id + '/amount', { cookie: ownerC.cookie, body: { amount_pkr: 0 } });
    check('bill amount 0 → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/bills/' + gasBill.id + '/amount', { cookie: ownerC.cookie, body: { amount_pkr: '3500' } });
    check('bill amount string → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/bills/' + gasBill.id + '/amount', { cookie: ownerC.cookie, body: { amount_pkr: 3500, note: 'x' } });
    check('bill amount unknown field → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/bills/' + gasBill.id + '/amount', { cookie: ownerC.cookie, body: {} });
    check('bill amount missing → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/bills/999999/amount', { cookie: ownerC.cookie, body: { amount_pkr: 3500 } });
    check('bill amount missing bill → 404', r.status === 404, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/bills/' + gasBill.id + '/amount', { cookie: ownerC.cookie, body: { amount_pkr: 3500 } });
    check('owner enters amount on variable bill → 200 with amount', r.status === 200 && r.json.bill && r.json.bill.amount_pkr === 3500, r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/bills', { cookie: tenantD.cookie });
    const gasBillAfter = (r.json.bills || []).find((b) => b.schedule_kind === 'gas');
    check('tenant view shows the entered amount', !!gasBillAfter && gasBillAfter.amount_pkr === 3500, JSON.stringify(gasBillAfter));
    r = await req('POST', '/api/owner/bills/' + gasBill.id + '/amount', { cookie: ownerC.cookie, body: { amount_pkr: 3600 } });
    check('bill amount entry twice → 400 (already set)', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/bills/' + elecBill.id + '/amount', { cookie: ownerC.cookie, body: { amount_pkr: 1200 } });
    check('owner enters amount on overdue variable bill → 200', r.status === 200 && r.json.bill.amount_pkr === 1200, r.status + ' ' + r.text);

    // --- notifications ---
    r = await req('GET', '/api/notifications', { cookie: tenantD.cookie });
    check('notifications 200 for tenant D', r.status === 200 && Array.isArray(r.json.notifications), r.status + ' ' + r.text);
    const notifsD = r.json.notifications || [];
    check('notifications unread_count matches unread rows',
      r.json.unread_count === notifsD.filter((n) => !n.is_read).length, JSON.stringify(r.json.unread_count));
    check('notifications include link_approved from Phase 2',
      notifsD.some((n) => n.kind === 'link_approved'), JSON.stringify(notifsD.map((n) => n.kind)));
    check('notifications include ' + gasKind + ' for this tenancy',
      notifsD.some((n) => n.kind === gasKind && n.link === '/tenancy?id=' + tenancyC),
      JSON.stringify(notifsD.map((n) => n.kind + ':' + n.link)));
    check('notifications include bill_overdue for the electricity bill',
      notifsD.some((n) => n.kind === 'bill_overdue' && n.link === '/tenancy?id=' + tenancyC),
      JSON.stringify(notifsD.map((n) => n.kind + ':' + n.link)));
    check('notifications are newest first',
      notifsD.every((n, i) => i === 0 || (notifsD[i - 1].created_at + '|' + notifsD[i - 1].id) >= (n.created_at + '|' + n.id)),
      JSON.stringify(notifsD.map((n) => n.created_at + '#' + n.id)));
    r = await req('GET', '/api/notifications', { cookie: ownerC.cookie });
    check('owner notifications include link_request + bill kinds',
      (r.json.notifications || []).some((n) => n.kind === 'link_request')
      && (r.json.notifications || []).some((n) => n.kind === gasKind),
      JSON.stringify((r.json.notifications || []).map((n) => n.kind)));
    r = await req('GET', '/api/notifications', { cookie: tenantB.cookie });
    check('tenant B never sees tenant D notifications (no tenancy C link)',
      !(r.json.notifications || []).some((n) => n.link === '/tenancy?id=' + tenancyC),
      JSON.stringify((r.json.notifications || []).map((n) => n.link)));
    r = await req('GET', '/api/notifications');
    check('notifications 401 without login', r.status === 401, r.status + ' ' + r.text);
    const billNotifCount = (list) => (list || []).filter((n) => (n.kind === 'bill_due' || n.kind === 'bill_overdue') && n.link === '/tenancy?id=' + tenancyC).length;
    const before = billNotifCount(notifsD);
    r = await req('GET', '/api/owner/tenancies/' + tenancyC, { cookie: ownerC.cookie });
    r = await req('GET', '/api/notifications', { cookie: tenantD.cookie });
    check('bill notifications dedupe: re-opening adds no duplicate per bill per kind',
      billNotifCount(r.json.notifications) === before, before + ' -> ' + billNotifCount(r.json.notifications));
    // Review fix: the dedup used to key on the tenancy link, so a
    // second bill due in the same window never notified. A water bill
    // due in the window must add exactly one notification of its own.
    const waterDueDay = todayDay <= 26 ? todayDay + 2 : 1;
    r = await req('POST', '/api/owner/schedules', { cookie: ownerC.cookie, body: { tenancy_id: tenancyC, kind: 'water', label: 'Water', amount_pkr: null, due_day: waterDueDay } });
    check('review: water schedule added for the per-bill notification test', r.status === 201, r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/bills', { cookie: tenantD.cookie });
    check('review: water bill generated for the current month',
      (r.json.bills || []).some((b) => b.schedule_kind === 'water' && b.month === curMonth), JSON.stringify((r.json.bills || []).map((b) => [b.schedule_kind, b.month])));
    r = await req('GET', '/api/notifications', { cookie: tenantD.cookie });
    check('review: a second bill due in the window notifies once (per bill, not per tenancy)',
      billNotifCount(r.json.notifications) === before + 1, before + ' -> ' + billNotifCount(r.json.notifications));
    check('review: the new notification names the water bill',
      (r.json.notifications || []).some((n) => (n.kind === 'bill_due' || n.kind === 'bill_overdue')
        && n.link === '/tenancy?id=' + tenancyC && n.body.includes('Water for ' + curMonth)),
      JSON.stringify((r.json.notifications || []).map((n) => n.kind + ':' + n.body)));
    r = await req('GET', '/api/owner/tenancies/' + tenancyC, { cookie: ownerC.cookie });
    r = await req('GET', '/api/notifications', { cookie: tenantD.cookie });
    check('review: re-opening still adds no duplicate for the water bill',
      billNotifCount(r.json.notifications) === before + 1, before + ' -> ' + billNotifCount(r.json.notifications));
    const notifD = (r.json.notifications || [])[0];
    r = await req('POST', '/api/notifications/' + notifD.id + '/read', { cookie: tenantB.cookie });
    check('mark-read on foreign notification → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('POST', '/api/notifications/999999/read', { cookie: tenantD.cookie });
    check('mark-read missing notification → 404', r.status === 404, r.status + ' ' + r.text);
    const unreadBefore = (await req('GET', '/api/notifications', { cookie: tenantD.cookie })).json.unread_count;
    r = await req('POST', '/api/notifications/' + notifD.id + '/read', { cookie: tenantD.cookie });
    check('mark one read 200 + unread count drops by 1',
      r.status === 200 && r.json.unread_count === unreadBefore - 1, r.status + ' ' + JSON.stringify(r.json));
    r = await req('GET', '/api/notifications', { cookie: tenantD.cookie });
    check('marked notification shows is_read 1',
      (r.json.notifications || []).find((n) => n.id === notifD.id).is_read === 1, JSON.stringify((r.json.notifications || []).find((n) => n.id === notifD.id)));
    r = await req('POST', '/api/notifications/read-all', { cookie: tenantD.cookie });
    check('read-all 200 + unread count 0', r.status === 200 && r.json.unread_count === 0, r.status + ' ' + JSON.stringify(r.json));
    r = await req('GET', '/api/notifications', { cookie: tenantD.cookie });
    check('read-all marks every notification read', r.status === 200 && r.json.unread_count === 0
      && (r.json.notifications || []).every((n) => n.is_read === 1), r.status + ' ' + r.text);

    // --- audit rows for schedule + bill-amount actions ---
    r = await req('GET', '/api/master/audit', { master: MASTER });
    const actions3 = (r.json.rows || []).map((row) => row.action);
    check('audit has schedule.created', actions3.includes('schedule.created'), JSON.stringify(actions3));
    check('audit has schedule.updated', actions3.includes('schedule.updated'), JSON.stringify(actions3));
    check('audit has schedule.deactivated', actions3.includes('schedule.deactivated'), JSON.stringify(actions3));
    check('audit has bill.amount', actions3.includes('bill.amount'), JSON.stringify(actions3));

    // ================= Phase 4: payment proofs + receipts =================
    async function uploadPayment(cookie, fields, bytes, filename) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields || {})) fd.append(k, String(v));
      if (bytes !== null && bytes !== undefined) {
        fd.append('photo', new Blob([bytes], { type: 'image/jpeg' }), filename || 'proof.jpg');
      }
      const res = await fetch(BASE + '/api/tenant/payments', {
        method: 'POST', headers: { Cookie: cookie }, body: fd,
      });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, text, json };
    }
    async function getCsv(path, cookie) {
      const res = await fetch(BASE + path, { headers: cookie ? { Cookie: cookie } : {} });
      return { status: res.status, text: await res.text(), ctype: res.headers.get('content-type') || '' };
    }
    // Fresh bill ids for tenancy C (rent 40000, gas 3500, electricity 1200).
    r = await req('GET', '/api/tenant/bills', { cookie: tenantD.cookie });
    const p4Bills = r.json.bills || [];
    const p4Rent = p4Bills.find((b) => b.schedule_kind === 'rent');
    const p4Gas = p4Bills.find((b) => b.schedule_kind === 'gas');
    const p4Elec = p4Bills.find((b) => b.schedule_kind === 'electricity');
    check('Phase 4: tenancy C bills ready (rent+gas+electricity)', !!p4Rent && !!p4Gas && !!p4Elec
      && p4Rent.amount_pkr === 40000 && p4Gas.amount_pkr === 3500 && p4Elec.amount_pkr === 1200,
      JSON.stringify(p4Bills.map((b) => [b.schedule_kind, b.amount_pkr, b.status])));

    // --- submit: 201 pending, bill → paid_pending, proof serves to the pair only ---
    let up4 = await uploadPayment(tenantD.cookie, { bill_id: p4Rent.id, amount_pkr: 40000, method: 'jazzcash', txn_ref: 'JC-111', note: 'Paid via JazzCash' }, JPEG, 'rent-proof.jpg');
    check('submit payment 201 + status pending', up4.status === 201 && up4.json && up4.json.payment && up4.json.payment.status === 'pending'
      && up4.json.payment.amount_pkr === 40000 && up4.json.payment.method === 'jazzcash' && up4.json.payment.txn_ref === 'JC-111',
      up4.status + ' ' + up4.text);
    const rentPaymentId = up4.json.payment.id;
    const rentProofUrl = up4.json.payment.proof_file_url;
    check('submit payment moves bill to paid_pending', up4.json.bill && up4.json.bill.status === 'paid_pending', JSON.stringify(up4.json.bill));
    check('payment carries bill month + schedule kind', up4.json.payment.bill_month === curMonth && up4.json.payment.schedule_kind === 'rent', JSON.stringify(up4.json.payment));
    fr = await fetch(BASE + rentProofUrl, { headers: { Cookie: ownerC.cookie } });
    check('proof photo serves 200 to the owner', fr.status === 200 && (fr.headers.get('content-type') || '').startsWith('image/'), String(fr.status));
    fr = await fetch(BASE + rentProofUrl, { headers: { Cookie: tenantD.cookie } });
    check('proof photo serves 200 to the paying tenant', fr.status === 200, String(fr.status));
    fr = await fetch(BASE + rentProofUrl, { headers: { Cookie: tenantB.cookie } });
    check('proof photo 403 to another tenant', fr.status === 403, String(fr.status));
    fr = await fetch(BASE + rentProofUrl, { headers: { Cookie: ownerB.cookie } });
    check('proof photo 403 to another owner', fr.status === 403, String(fr.status));

    // --- submit: scoping + role ---
    up4 = await uploadPayment(tenantB.cookie, { bill_id: p4Rent.id, amount_pkr: 40000, method: 'cash' }, JPEG, 'proof.jpg');
    check('submit on foreign bill → 403', up4.status === 403, up4.status + ' ' + up4.text);
    up4 = await uploadPayment(ownerC.cookie, { bill_id: p4Rent.id, amount_pkr: 40000, method: 'cash' }, JPEG, 'proof.jpg');
    check('submit by owner → 403', up4.status === 403, up4.status + ' ' + up4.text);
    r = await req('POST', '/api/tenant/payments', { cookie: tenantD.cookie, body: { bill_id: p4Rent.id, amount_pkr: 40000, method: 'cash' } });
    check('submit without proof photo → 400', r.status === 400, r.status + ' ' + r.text);
    up4 = await uploadPayment(tenantD.cookie, { bill_id: 999999, amount_pkr: 40000, method: 'cash' }, JPEG, 'proof.jpg');
    check('submit on missing bill → 404', up4.status === 404, up4.status + ' ' + up4.text);

    // --- submit on a bill whose amount is still NULL → 400 ---
    r = await req('POST', '/api/owner/schedules', { cookie: ownerC.cookie, body: { tenancy_id: tenancyC, kind: 'water', label: 'Water', amount_pkr: null, due_day: 10 } });
    check('Phase 4: variable water schedule 201', r.status === 201, r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/bills', { cookie: tenantD.cookie });
    const p4Water = (r.json.bills || []).find((b) => b.schedule_kind === 'water');
    check('Phase 4: water bill generated with amount NULL', !!p4Water && p4Water.amount_pkr === null, JSON.stringify(p4Water));
    up4 = await uploadPayment(tenantD.cookie, { bill_id: p4Water.id, amount_pkr: 1000, method: 'cash' }, JPEG, 'proof.jpg');
    check('submit on NULL-amount bill → 400 (owner must enter the amount first)', up4.status === 400, up4.status + ' ' + up4.text);

    // --- submit validation: method / amount / unknown field ---
    up4 = await uploadPayment(tenantD.cookie, { bill_id: p4Gas.id, amount_pkr: 3500, method: 'crypto' }, JPEG, 'proof.jpg');
    check('submit with invalid method → 400', up4.status === 400, up4.status + ' ' + up4.text);
    up4 = await uploadPayment(tenantD.cookie, { bill_id: p4Gas.id, amount_pkr: 0, method: 'cash' }, JPEG, 'proof.jpg');
    check('submit with amount 0 → 400', up4.status === 400, up4.status + ' ' + up4.text);
    up4 = await uploadPayment(tenantD.cookie, { bill_id: p4Gas.id, amount_pkr: 'abc', method: 'cash' }, JPEG, 'proof.jpg');
    check('submit with non-numeric amount → 400', up4.status === 400, up4.status + ' ' + up4.text);
    up4 = await uploadPayment(tenantD.cookie, { bill_id: p4Gas.id, amount_pkr: -5, method: 'cash' }, JPEG, 'proof.jpg');
    check('submit with negative amount → 400', up4.status === 400, up4.status + ' ' + up4.text);
    {
      const fd = new FormData();
      fd.append('bill_id', String(p4Gas.id)); fd.append('amount_pkr', '3500'); fd.append('method', 'cash');
      fd.append('admin', 'true');
      fd.append('photo', new Blob([JPEG], { type: 'image/jpeg' }), 'proof.jpg');
      const res = await fetch(BASE + '/api/tenant/payments', { method: 'POST', headers: { Cookie: tenantD.cookie }, body: fd });
      check('submit with unknown field → 400', res.status === 400, String(res.status));
    }

    // --- submit: oversize / bad magic / extension mismatch ---
    up4 = await uploadPayment(tenantD.cookie, { bill_id: p4Gas.id, amount_pkr: 3500, method: 'cash' }, big, 'big.jpg');
    check('submit oversize proof → 413', up4.status === 413, up4.status + ' ' + up4.text.slice(0, 120));
    up4 = await uploadPayment(tenantD.cookie, { bill_id: p4Gas.id, amount_pkr: 3500, method: 'cash' }, Buffer.from('hello, not an image at all'), 'fake.jpg');
    check('submit bad magic bytes → 400', up4.status === 400, up4.status + ' ' + up4.text);
    up4 = await uploadPayment(tenantD.cookie, { bill_id: p4Gas.id, amount_pkr: 3500, method: 'cash' }, JPEG, 'proof.png');
    check('submit extension mismatch → 400', up4.status === 400, up4.status + ' ' + up4.text);
    up4 = await uploadPayment(tenantD.cookie, { bill_id: p4Gas.id, amount_pkr: 3500, method: 'cash' }, JPEG, 'proof.txt');
    check('submit bad extension → 400', up4.status === 400, up4.status + ' ' + up4.text);

    // --- correction: second payment on the same bill ---
    up4 = await uploadPayment(tenantD.cookie, { bill_id: p4Gas.id, amount_pkr: 3500, method: 'jazzcash', txn_ref: 'JC-222' }, JPEG, 'gas1.jpg');
    check('first gas payment 201 pending', up4.status === 201 && up4.json.payment.status === 'pending', up4.status + ' ' + up4.text);
    const gasPay1 = up4.json.payment.id;
    up4 = await uploadPayment(tenantD.cookie, { bill_id: p4Gas.id, amount_pkr: 3500, method: 'easypaisa', txn_ref: 'EP-333' }, PNG, 'gas2.png');
    check('second gas payment (correction) 201 pending', up4.status === 201 && up4.json.payment.status === 'pending'
      && up4.json.payment.method === 'easypaisa', up4.status + ' ' + up4.text);
    const gasPay2 = up4.json.payment.id;
    r = await req('GET', '/api/tenant/bills', { cookie: tenantD.cookie });
    const gasBillNow = (r.json.bills || []).find((b) => b.schedule_kind === 'gas');
    check('correction: current payment on the bill is the newest one',
      !!gasBillNow && gasBillNow.current_payment && gasBillNow.current_payment.id === gasPay2, JSON.stringify(gasBillNow && gasBillNow.current_payment));
    r = await req('GET', '/api/owner/tenancies/' + tenancyC, { cookie: ownerC.cookie });
    const gasPays = (r.json.tenancy.payments || []).filter((pp) => pp.bill_id === p4Gas.id);
    check('correction: old payment row stays in history (both visible)',
      gasPays.length === 2 && gasPays.some((pp) => pp.id === gasPay1) && gasPays.some((pp) => pp.id === gasPay2),
      JSON.stringify(gasPays.map((pp) => [pp.id, pp.status])));
    check('correction: old payment status unchanged (still pending)',
      (gasPays.find((pp) => pp.id === gasPay1) || {}).status === 'pending', JSON.stringify(gasPays));

    // --- owner pending queue: scoped, newest first, with proof + tenant + house ---
    r = await req('GET', '/api/owner/payments/pending', { cookie: ownerC.cookie });
    check('owner pending queue 200', r.status === 200 && Array.isArray(r.json.payments), r.status + ' ' + r.text);
    const pendC = r.json.payments || [];
    check('owner pending queue has rent + both gas payments',
      pendC.some((pp) => pp.id === rentPaymentId) && pendC.some((pp) => pp.id === gasPay1) && pendC.some((pp) => pp.id === gasPay2),
      JSON.stringify(pendC.map((pp) => pp.id)));
    check('owner pending queue is newest first',
      pendC.every((pp, i) => i === 0 || (pendC[i - 1].created_at + '|' + pendC[i - 1].id) >= (pp.created_at + '|' + pp.id)),
      JSON.stringify(pendC.map((pp) => pp.created_at + '#' + pp.id)));
    check('owner pending queue carries tenant name + house title + proof url',
      pendC.every((pp) => pp.tenant_name === 'Danish Ali' && pp.house_title === 'House 9, Model Town' && typeof pp.proof_file_url === 'string' && pp.proof_file_url.startsWith('/api/photos/file/')),
      JSON.stringify(pendC.map((pp) => [pp.tenant_name, pp.house_title, pp.proof_file_url])));
    r = await req('GET', '/api/owner/payments/pending', { cookie: ownerB.cookie });
    check('owner B pending queue has none of owner C payments',
      r.status === 200 && !(r.json.payments || []).some((pp) => pp.id === rentPaymentId || pp.id === gasPay2), r.status + ' ' + r.text);
    r = await req('GET', '/api/owner/payments/pending', { cookie: tenantD.cookie });
    check('pending queue 403 for tenant', r.status === 403, r.status + ' ' + r.text);
    r = await req('GET', '/api/owner/payments/pending');
    check('pending queue 401 without login', r.status === 401, r.status + ' ' + r.text);

    // --- decide: reject needs a reason; reject keeps the bill due; re-upload works ---
    up4 = await uploadPayment(tenantD.cookie, { bill_id: p4Elec.id, amount_pkr: 1200, method: 'bank', txn_ref: 'BK-444' }, JPEG, 'elec.jpg');
    check('electricity payment 201 pending', up4.status === 201 && up4.json.payment.status === 'pending', up4.status + ' ' + up4.text);
    const elecPay1 = up4.json.payment.id;
    r = await req('POST', '/api/owner/payments/decide', { cookie: ownerC.cookie, body: { payment_id: elecPay1, decision: 'reject' } });
    check('reject without reason → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/payments/decide', { cookie: ownerC.cookie, body: { payment_id: elecPay1, decision: 'maybe', reason: 'x' } });
    check('decide with bad decision → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/payments/decide', { cookie: ownerC.cookie, body: { payment_id: elecPay1, decision: 'reject', reason: 'Screenshot is cut off — the amount is not visible.' } });
    check('reject with reason → rejected', r.status === 200 && r.json.payment.status === 'rejected'
      && r.json.payment.decide_reason === 'Screenshot is cut off — the amount is not visible.', r.status + ' ' + r.text);
    check('reject leaves the bill unpaid (overdue, not paid)', r.json.bill && r.json.bill.status === 'overdue', JSON.stringify(r.json.bill));
    r = await req('GET', '/api/tenant/bills', { cookie: tenantD.cookie });
    const elecBillNow = (r.json.bills || []).find((b) => b.schedule_kind === 'electricity');
    check('tenant sees the rejection reason on the bill',
      !!elecBillNow && elecBillNow.current_payment && elecBillNow.current_payment.status === 'rejected'
      && elecBillNow.current_payment.decide_reason === 'Screenshot is cut off — the amount is not visible.',
      JSON.stringify(elecBillNow && elecBillNow.current_payment));
    up4 = await uploadPayment(tenantD.cookie, { bill_id: p4Elec.id, amount_pkr: 1200, method: 'bank', txn_ref: 'BK-555' }, JPEG, 'elec2.jpg');
    check('tenant can re-upload after reject (correction) 201', up4.status === 201 && up4.json.payment.status === 'pending', up4.status + ' ' + up4.text);
    const elecPay2 = up4.json.payment.id;
    r = await req('POST', '/api/owner/payments/decide', { cookie: ownerC.cookie, body: { payment_id: elecPay1, decision: 'approve' } });
    check('decide an already-decided payment → 400', r.status === 400, r.status + ' ' + r.text);

    // --- decide: approve → bill paid + receipt ---
    r = await req('POST', '/api/owner/payments/decide', { cookie: ownerC.cookie, body: { payment_id: gasPay2, decision: 'approve' } });
    check('approve → 200 with receipt', r.status === 200 && r.json.payment.status === 'approved' && r.json.receipt, r.status + ' ' + r.text);
    check('receipt number is RCP-<tenancy>-<seq>',
      /^RCP-\d+-\d+$/.test(r.json.receipt.receipt_number), JSON.stringify(r.json.receipt));
    check('receipt has date + amount + method + tenant + house',
      /^\d{4}-\d{2}-\d{2}$/.test(r.json.receipt.date) && r.json.receipt.amount_pkr === 3500
      && r.json.receipt.method === 'easypaisa' && r.json.receipt.tenant_name === 'Danish Ali'
      && r.json.receipt.house_title === 'House 9, Model Town' && r.json.receipt.txn_ref === 'EP-333',
      JSON.stringify(r.json.receipt));
    check('receipt date matches the approval day', r.json.receipt.date === String(r.json.payment.decided_at || '').slice(0, 10), JSON.stringify(r.json.receipt));
    check('approve marks the bill paid', r.json.bill && r.json.bill.status === 'paid', JSON.stringify(r.json.bill));
    check('approve: bill carries its receipt', r.json.bill && r.json.bill.receipt && r.json.bill.receipt.receipt_number === r.json.receipt.receipt_number, JSON.stringify(r.json.bill));
    const gasReceiptNo = r.json.receipt.receipt_number;
    r = await req('POST', '/api/owner/payments/decide', { cookie: ownerC.cookie, body: { payment_id: gasPay2, decision: 'approve' } });
    check('approve twice → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/payments/decide', { cookie: ownerC.cookie, body: { payment_id: gasPay1, decision: 'approve' } });
    check('decide superseded pending payment after bill paid → 400', r.status === 400, r.status + ' ' + r.text);
    up4 = await uploadPayment(tenantD.cookie, { bill_id: p4Gas.id, amount_pkr: 3500, method: 'cash' }, JPEG, 'gas3.jpg');
    check('pay an already-paid bill → 400 (no double payment)', up4.status === 400, up4.status + ' ' + up4.text);
    r = await req('POST', '/api/owner/payments/decide', { cookie: ownerC.cookie, body: { payment_id: 999999, decision: 'approve' } });
    check('decide missing payment → 404', r.status === 404, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/payments/decide', { cookie: ownerC.cookie, body: { payment_id: gasPay2, decision: 'approve', admin: true } });
    check('decide with unknown field → 400', r.status === 400, r.status + ' ' + r.text);

    // --- tenant receipts: scoped per tenant ---
    r = await req('GET', '/api/tenant/receipts', { cookie: tenantD.cookie });
    check('tenant receipts 200 with the gas receipt',
      r.status === 200 && (r.json.receipts || []).some((rc) => rc.receipt_number === gasReceiptNo && rc.amount_pkr === 3500),
      r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/receipts', { cookie: tenantB.cookie });
    check('tenant B receipts list is empty (never sees tenant D receipts)',
      r.status === 200 && Array.isArray(r.json.receipts) && r.json.receipts.length === 0, r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/receipts', { cookie: ownerC.cookie });
    check('tenant receipts 403 for owner', r.status === 403, r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/receipts');
    check('tenant receipts 401 without login', r.status === 401, r.status + ' ' + r.text);

    // --- owner tenancy detail: payments + receipts per tenancy ---
    r = await req('GET', '/api/owner/tenancies/' + tenancyC, { cookie: ownerC.cookie });
    check('owner tenancy detail carries payments + receipts',
      Array.isArray(r.json.tenancy.payments) && Array.isArray(r.json.tenancy.receipts)
      && r.json.tenancy.receipts.some((rc) => rc.receipt_number === gasReceiptNo),
      JSON.stringify([r.json.tenancy.payments && r.json.tenancy.payments.length, r.json.tenancy.receipts]));
    check('owner tenancy detail receipts show number/date/amount/method',
      (r.json.tenancy.receipts || []).every((rc) => /^RCP-\d+-\d+$/.test(rc.receipt_number) && /^\d{4}-\d{2}-\d{2}$/.test(rc.date)
        && Number.isInteger(rc.amount_pkr) && typeof rc.method === 'string'),
      JSON.stringify(r.json.tenancy.receipts));

    // --- cross-owner isolation: owner B tenancy + payment, owner C cannot decide it ---
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: tenantB.cookie, body: { code: codeB } });
    check('Phase 4: tenant B re-links to owner B house (requested)', r.status === 201 && r.json.tenancy.status === 'requested', r.status + ' ' + r.text);
    const tenancyB2 = r.json.tenancy.id;
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: ownerB.cookie, body: { tenancy_id: tenancyB2, decision: 'approve', rent_pkr: 60000, due_day: 5, start_date: '2026-11-01' } });
    check('Phase 4: owner B approves tenant B again → active', r.status === 200 && r.json.tenancy.status === 'active', r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/bills', { cookie: tenantB.cookie });
    const p4RentB = (r.json.bills || []).find((b) => b.schedule_kind === 'rent');
    check('Phase 4: tenant B rent bill exists', !!p4RentB && p4RentB.amount_pkr === 60000, JSON.stringify(p4RentB));
    up4 = await uploadPayment(tenantB.cookie, { bill_id: p4RentB.id, amount_pkr: 60000, method: 'cash' }, JPEG, 'b-rent.jpg');
    check('Phase 4: tenant B submits rent payment 201', up4.status === 201 && up4.json.payment.status === 'pending', up4.status + ' ' + up4.text);
    const rentPayB = up4.json.payment.id;
    r = await req('POST', '/api/owner/payments/decide', { cookie: ownerC.cookie, body: { payment_id: rentPayB, decision: 'approve' } });
    check('owner A cannot decide owner B payment → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/payments/decide', { cookie: tenantB.cookie, body: { payment_id: rentPayB, decision: 'approve' } });
    check('tenant cannot decide a payment → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('GET', '/api/owner/payments/pending', { cookie: ownerB.cookie });
    check('owner B pending queue has tenant B payment only',
      (r.json.payments || []).some((pp) => pp.id === rentPayB) && !(r.json.payments || []).some((pp) => pp.id === rentPaymentId),
      JSON.stringify((r.json.payments || []).map((pp) => pp.id)));
    r = await req('GET', '/api/tenant/receipts', { cookie: tenantD.cookie });
    check('tenant D receipts never include tenant B (still pending, other tenancy)',
      !(r.json.receipts || []).some((rc) => rc.payment_id === rentPayB), JSON.stringify(r.json.receipts));
    r = await req('POST', '/api/owner/payments/decide', { cookie: ownerB.cookie, body: { payment_id: rentPayB, decision: 'approve' } });
    check('owner B approves tenant B payment → receipt created', r.status === 200 && r.json.receipt && /^RCP-\d+-1$/.test(r.json.receipt.receipt_number), r.status + ' ' + r.text);
    const receiptNoB = r.json.receipt.receipt_number;
    r = await req('GET', '/api/tenant/receipts', { cookie: tenantB.cookie });
    check('tenant B sees their own receipt after approval',
      (r.json.receipts || []).some((rc) => rc.receipt_number === receiptNoB), JSON.stringify(r.json.receipts));
    r = await req('GET', '/api/tenant/receipts', { cookie: tenantD.cookie });
    check('tenant D receipts still have no tenant B receipt',
      !(r.json.receipts || []).some((rc) => rc.receipt_number === receiptNoB), JSON.stringify(r.json.receipts));

    // --- ledger CSV: scoping per role ---
    let csv = await getCsv('/api/owner/ledger.csv', ownerC.cookie);
    check('owner ledger CSV 200 + text/csv',
      csv.status === 200 && (csv.ctype || '').includes('text/csv'), csv.status + ' ' + csv.ctype);
    check('owner ledger CSV header row',
      csv.text.split('\r\n')[0] === 'month,house,tenant,bill kind,amount,method,status,receipt no', JSON.stringify(csv.text.split('\r\n')[0]));
    check('owner ledger has owner C rows (gas receipt + rent pending)',
      csv.text.includes(gasReceiptNo) && csv.text.includes('Danish Ali') && csv.text.includes('House 9, Model Town'),
      csv.text.slice(0, 400));
    check('owner ledger has no owner B rows',
      !csv.text.includes('Bilal Khan') && !csv.text.includes(receiptNoB), csv.text.slice(0, 400));
    csv = await getCsv('/api/owner/ledger.csv', ownerB.cookie);
    check('owner B ledger has only Bilal rows',
      csv.status === 200 && csv.text.includes('Bilal Khan') && csv.text.includes(receiptNoB) && !csv.text.includes('Danish Ali'),
      csv.text.slice(0, 400));
    csv = await getCsv('/api/tenant/ledger.csv', tenantD.cookie);
    check('tenant ledger has only own rows',
      csv.status === 200 && csv.text.includes('Danish Ali') && csv.text.includes(gasReceiptNo) && !csv.text.includes('Bilal Khan'),
      csv.text.slice(0, 400));
    csv = await getCsv('/api/tenant/ledger.csv', tenantB.cookie);
    check('tenant B ledger has only Bilal rows',
      csv.status === 200 && csv.text.includes('Bilal Khan') && !csv.text.includes('Danish Ali'), csv.text.slice(0, 400));
    csv = await getCsv('/api/owner/ledger.csv', tenantD.cookie);
    check('owner ledger 403 for tenant', csv.status === 403, String(csv.status));
    csv = await getCsv('/api/tenant/ledger.csv', ownerC.cookie);
    check('tenant ledger 403 for owner', csv.status === 403, String(csv.status));
    csv = await getCsv('/api/owner/ledger.csv');
    check('owner ledger 401 without login', csv.status === 401, String(csv.status));
    csv = await getCsv('/api/tenant/ledger.csv');
    check('tenant ledger 401 without login', csv.status === 401, String(csv.status));

    // --- notifications for payment events ---
    r = await req('GET', '/api/notifications', { cookie: ownerC.cookie });
    check('owner notifications include payment_pending',
      (r.json.notifications || []).some((n) => n.kind === 'payment_pending' && n.link === '/tenancy?id=' + tenancyC),
      JSON.stringify((r.json.notifications || []).map((n) => n.kind + ':' + n.link)));
    r = await req('GET', '/api/notifications', { cookie: tenantD.cookie });
    check('tenant notifications include payment_approved + payment_rejected',
      (r.json.notifications || []).some((n) => n.kind === 'payment_approved')
      && (r.json.notifications || []).some((n) => n.kind === 'payment_rejected'),
      JSON.stringify((r.json.notifications || []).map((n) => n.kind)));

    // --- audit rows for payment submit / approve / reject ---
    r = await req('GET', '/api/master/audit', { master: MASTER });
    const actions4 = (r.json.rows || []).map((row) => row.action);
    check('audit has payment.submitted', actions4.includes('payment.submitted'), JSON.stringify(actions4));
    check('audit has payment.approved', actions4.includes('payment.approved'), JSON.stringify(actions4));
    check('audit has payment.rejected', actions4.includes('payment.rejected'), JSON.stringify(actions4));

    // --- Phase 4 pages ---
    r = await req('GET', '/tenant.js');
    check('/tenant.js has upload-proof form + receipts + re-upload',
      r.status === 200 && r.text.includes('Upload proof of payment') && r.text.includes('/api/tenant/receipts')
      && r.text.includes('Upload corrected proof') && r.text.includes('/api/tenant/payments'),
      r.status);
    r = await req('GET', '/owner.js');
    check('/owner.js has pending approvals queue + receipts per tenancy',
      r.status === 200 && r.text.includes('/api/owner/payments/pending')
      && r.text.includes('Approve — bill paid') && r.text.includes('Receipts'), r.status);
    r = await req('GET', '/tenancy.js');
    check('/tenancy.js has payment history + receipt view + honest line',
      r.status === 200 && r.text.includes('Payment history') && r.text.includes('Receipt ')
      && r.text.includes('A screenshot proves the tenant showed a payment'), r.status);
    r = await req('GET', '/tenant');
    check('/tenant page has My receipts section + honest proof line',
      r.status === 200 && r.text.includes('My receipts')
      && r.text.includes('screenshot proves the tenant showed a payment'), r.status);
    r = await req('GET', '/owner');
    check('/owner page has Pending payment approvals section + honest proof line',
      r.status === 200 && r.text.includes('Pending payment approvals')
      && r.text.includes('screenshot proves the tenant showed a payment'), r.status);

    // --- Phase 3 pages + WhatsApp share links in the JS ---
    r = await req('GET', '/notifications');
    check('/notifications page 200 + bell', r.status === 200 && r.text.includes('Notifications') && r.text.includes('id="bell"'), r.status);
    r = await req('GET', '/notifications.js');
    check('/notifications.js serves + read-all', r.status === 200 && r.text.includes('read-all'), r.status);
    r = await req('GET', '/bell.js');
    check('/bell.js serves + unread_count', r.status === 200 && r.text.includes('unread_count'), r.status);
    r = await req('GET', '/index.js');
    check('/index.js serves + due list', r.status === 200 && r.text.includes('due-list'), r.status);
    r = await req('GET', '/owner.js');
    check('/owner.js has schedules + bills + wa.me + not-entered',
      r.status === 200 && r.text.includes('Add schedule') && r.text.includes('Amount not entered yet') && r.text.includes('wa.me'), r.status);
    r = await req('GET', '/tenant.js');
    check('/tenant.js has my bills + wa.me + not-entered',
      r.status === 200 && r.text.includes('/api/tenant/bills') && r.text.includes('Amount not entered yet') && r.text.includes('wa.me'), r.status);
    r = await req('GET', '/tenancy.js');
    check('/tenancy.js has bills + wa.me + not-entered',
      r.status === 200 && r.text.includes('Share on WhatsApp') && r.text.includes('wa.me') && r.text.includes('Amount not entered yet'), r.status);
    r = await req('GET', '/');
    check('home shows bell + Due now section', r.status === 200 && r.text.includes('id="bell"') && r.text.includes('Due now'), r.status);
    r = await req('GET', '/owner');
    check('/owner page has bell', r.status === 200 && r.text.includes('id="bell"'), r.status);
    r = await req('GET', '/tenant');
    check('/tenant page has bell + My bills section', r.status === 200 && r.text.includes('id="bell"') && r.text.includes('My bills'), r.status);
    r = await req('GET', '/tenancy');
    check('/tenancy page has bell', r.status === 200 && r.text.includes('id="bell"'), r.status);

    // --- Phase 2 pages ---
    r = await req('GET', '/owner');
    check('/owner page 200', r.status === 200 && r.text.includes('My houses'), r.status);
    r = await req('GET', '/tenant');
    check('/tenant page 200', r.status === 200 && r.text.includes('Link with my owner'), r.status);
    r = await req('GET', '/tenancy');
    check('/tenancy page 200', r.status === 200 && r.text.includes('Tenancy'), r.status);
    r = await req('GET', '/owner.js');
    check('/owner.js serves', r.status === 200 && r.text.includes('Link code'), r.status);
    r = await req('GET', '/tenant.js');
    check('/tenant.js serves', r.status === 200 && r.text.includes('house code'), r.status);

    // ================= Phase 5: WhatsApp-like chat =================
    async function uploadChatPhoto(cookie, tenancyId, bytes, filename) {
      const fd = new FormData();
      if (bytes !== null && bytes !== undefined) {
        fd.append('photo', new Blob([bytes], { type: 'image/jpeg' }), filename || 'chat.jpg');
      }
      const res = await fetch(BASE + '/api/chat/' + tenancyId + '/messages/photo', {
        method: 'POST', headers: { Cookie: cookie }, body: fd,
      });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, text, json };
    }
    const sleep = (ms) => new Promise((res2) => setTimeout(res2, ms));

    // A second ACTIVE tenancy for owner C (tenant E, flat 2) so the owner
    // thread list has two threads to show.
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: ownerC.cookie, body: { tenancy_id: tenancyReq, decision: 'approve', rent_pkr: 30000, due_day: 5, start_date: '2026-11-01' } });
    check('Phase 5: approve second tenancy (owner C / tenant E) → active', r.status === 200 && r.json.tenancy.status === 'active', r.status + ' ' + r.text);
    r = await req('POST', '/api/chat/' + tenancyReq + '/messages', { cookie: tenantE.cookie, body: { body: 'Hello from flat 2' } });
    check('Phase 5: tenant E sends on second tenancy 201', r.status === 201, r.status + ' ' + r.text);

    // --- threads: scoping before any chat on tenancy C ---
    r = await req('GET', '/api/chat/threads', { cookie: ownerC.cookie });
    check('threads: owner sees one thread per active tenancy (2)',
      r.status === 200 && r.json.threads.length === 2
      && r.json.threads.every((t) => typeof t.house_title === 'string' && typeof t.other_name === 'string'
        && typeof t.unread_count === 'number' && 'last_message' in t),
      r.status + ' ' + r.text);
    const threadC0 = (r.json.threads || []).find((t) => t.tenancy_id === tenancyC);
    check('threads: owner thread names the tenant + house, unread 0 before any message',
      !!threadC0 && threadC0.other_name === 'Danish Ali' && threadC0.house_title === 'House 9, Model Town'
      && threadC0.unread_count === 0, JSON.stringify(threadC0));
    r = await req('GET', '/api/chat/threads', { cookie: tenantD.cookie });
    check('threads: tenant sees exactly one thread (their own)',
      r.status === 200 && r.json.threads.length === 1 && r.json.threads[0].tenancy_id === tenancyC
      && r.json.threads[0].other_name === 'Chaudhry Sahib', r.status + ' ' + r.text);
    r = await req('GET', '/api/chat/threads', { cookie: tenantE.cookie });
    check('threads: second tenant sees exactly one thread (their own)',
      r.status === 200 && r.json.threads.length === 1 && r.json.threads[0].tenancy_id === tenancyReq, r.status + ' ' + r.text);
    // tenantC never linked anywhere — a true stranger to every tenancy.
    r = await req('GET', '/api/chat/threads', { cookie: tenantC.cookie });
    check('threads: a stranger sees no threads', r.status === 200 && r.json.threads.length === 0, r.status + ' ' + r.text);
    r = await req('GET', '/api/chat/threads');
    check('threads 401 without login', r.status === 401, r.status + ' ' + r.text);

    // --- send text 201 on an active tenancy ---
    r = await req('POST', '/api/chat/' + tenancyC + '/messages', { cookie: tenantD.cookie, body: { body: 'Assalam-o-Alaikum, rent bhej di hai.' } });
    check('send text 201 on active tenancy',
      r.status === 201 && r.json.message && r.json.message.body === 'Assalam-o-Alaikum, rent bhej di hai.'
      && r.json.message.sender_name === 'Danish Ali', r.status + ' ' + r.text);
    const msg1 = r.json.message;
    check('ticks: fresh message is sent (stored, not delivered, not read)',
      msg1.ticks === 'sent' && msg1.delivered_at === null && msg1.read_at === null, JSON.stringify(msg1));

    // --- unread count + last message on the thread ---
    r = await req('GET', '/api/chat/threads', { cookie: ownerC.cookie });
    const threadC1 = (r.json.threads || []).find((t) => t.tenancy_id === tenancyC);
    check('threads: unread count 1 for the other party after a send',
      !!threadC1 && threadC1.unread_count === 1, JSON.stringify(threadC1));
    check('threads: last message is the sent text',
      !!threadC1 && threadC1.last_message && threadC1.last_message.body === 'Assalam-o-Alaikum, rent bhej di hai.', JSON.stringify(threadC1 && threadC1.last_message));

    // --- a message notification is created for the other party ---
    r = await req('GET', '/api/notifications', { cookie: ownerC.cookie });
    const msgNotif = (r.json.notifications || []).find((n) => n.kind === 'message');
    check('message notification created for the other party',
      !!msgNotif && msgNotif.link === '/chat?id=' + tenancyC && !msgNotif.body.includes('Assalam-o-Alaikum'),
      JSON.stringify(msgNotif));

    // --- Phase 6 tick fix: the thread-LIST fetch alone = delivered, NOT read ---
    // (The owner fetched /api/chat/threads just above; that is "opened the
    // app", so the message is delivered — read needs opening the thread.)
    r = await req('GET', '/api/chat/' + tenancyC + '/messages', { cookie: tenantD.cookie });
    const msg1Delivered = (r.json.messages || []).find((m) => m.id === msg1.id);
    check('ticks: after the other party fetches the thread LIST only, sender sees delivered but NOT read',
      !!msg1Delivered && msg1Delivered.ticks === 'delivered' && typeof msg1Delivered.delivered_at === 'number' && msg1Delivered.read_at === null,
      JSON.stringify(msg1Delivered));

    // --- fetching your own messages does NOT mark them delivered/read ---
    // (msg1 is already delivered from the owner's thread-list fetch above;
    // the sender's own fetch changes nothing — it stays delivered, unread.)
    r = await req('GET', '/api/chat/' + tenancyC + '/messages', { cookie: tenantD.cookie });
    check('own fetch returns the message, still delivered (not read)',
      r.status === 200 && r.json.messages.length === 1 && r.json.messages[0].ticks === 'delivered' && r.json.messages[0].read_at === null, r.status + ' ' + r.text);

    // --- ticks: the other party fetches → delivered AND read (blue) ---
    r = await req('GET', '/api/chat/' + tenancyC + '/messages', { cookie: ownerC.cookie });
    check('other party fetch returns the message',
      r.status === 200 && r.json.messages.length === 1 && r.json.messages[0].body === 'Assalam-o-Alaikum, rent bhej di hai.', r.status + ' ' + r.text);
    r = await req('GET', '/api/chat/threads', { cookie: ownerC.cookie });
    const threadC2 = (r.json.threads || []).find((t) => t.tenancy_id === tenancyC);
    check('threads: unread count 0 after the other party opens the chat',
      !!threadC2 && threadC2.unread_count === 0, JSON.stringify(threadC2));
    r = await req('GET', '/api/chat/' + tenancyC + '/messages', { cookie: tenantD.cookie });
    const msg1Now = (r.json.messages || []).find((m) => m.id === msg1.id);
    check('ticks: after the other party fetches, sender sees delivered + read',
      !!msg1Now && msg1Now.ticks === 'read' && typeof msg1Now.delivered_at === 'number' && typeof msg1Now.read_at === 'number',
      JSON.stringify(msg1Now));

    // --- send validation ---
    r = await req('POST', '/api/chat/' + tenancyC + '/messages', { cookie: tenantD.cookie, body: { body: 'x'.repeat(2001) } });
    check('text over 2000 chars → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/chat/' + tenancyC + '/messages', { cookie: tenantD.cookie, body: { body: '' } });
    check('empty body → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/chat/' + tenancyC + '/messages', { cookie: tenantD.cookie, body: { body: '   ' } });
    check('whitespace-only body → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/chat/' + tenancyC + '/messages', { cookie: tenantD.cookie, body: { body: 'hi', admin: true } });
    check('send with unknown field → 400', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/chat/' + tenancyC + '/messages', { cookie: tenantD.cookie, body: { body: 'x'.repeat(2000) } });
    check('text of exactly 2000 chars → 201', r.status === 201, r.status + ' ' + r.text);
    const msg2000 = r.json.message;

    // --- links / script tags are stored as plain text, never HTML ---
    const nasty = '<script>alert(1)</script> see https://example.com/x MARKER-CHAT-7X9Q';
    r = await req('POST', '/api/chat/' + tenancyC + '/messages', { cookie: tenantD.cookie, body: { body: nasty } });
    check('message with link + script tag 201 (stored as plain text)', r.status === 201 && r.json.message.body === nasty, r.status + ' ' + r.text);
    const msgNasty = r.json.message;
    r = await req('GET', '/api/chat/' + tenancyC + '/messages', { cookie: ownerC.cookie });
    const nastyBack = (r.json.messages || []).find((m) => m.id === msgNasty.id);
    check('link/script message comes back byte-identical (plain text)',
      !!nastyBack && nastyBack.body === nasty, JSON.stringify(nastyBack));
    r = await req('GET', '/chat.js');
    check('chat.js escapes user strings (escHtml) + polls 5s / 15s',
      r.status === 200 && r.text.includes('function escHtml') && r.text.includes('escHtml(m.body)')
      && r.text.includes('5000') && r.text.includes('15000'), r.status);

    // --- ?since= polling returns only newer messages ---
    r = await req('POST', '/api/chat/' + tenancyC + '/messages', { cookie: ownerC.cookie, body: { body: 'Wa-Alaikum-Assalam, received.' } });
    check('owner replies 201', r.status === 201, r.status + ' ' + r.text);
    const msg2 = r.json.message;
    await sleep(15);
    r = await req('POST', '/api/chat/' + tenancyC + '/messages', { cookie: tenantD.cookie, body: { body: 'Shukriya!' } });
    check('tenant replies 201', r.status === 201, r.status + ' ' + r.text);
    const msg3 = r.json.message;
    r = await req('GET', '/api/chat/' + tenancyC + '/messages?since=' + msg2.created_at, { cookie: tenantD.cookie });
    check('?since= returns only newer messages',
      r.status === 200 && r.json.messages.length === 1 && r.json.messages[0].id === msg3.id,
      r.status + ' ' + JSON.stringify((r.json.messages || []).map((m) => m.id)));
    r = await req('GET', '/api/chat/' + tenancyC + '/messages?since=0', { cookie: tenantD.cookie });
    check('?since=0 returns the whole thread, oldest first',
      r.status === 200 && r.json.messages.length >= 5
      && r.json.messages.every((m, i) => i === 0 || r.json.messages[i - 1].created_at <= m.created_at),
      r.status + ' ' + JSON.stringify((r.json.messages || []).map((m) => m.id)));

    // --- non-party isolation (read + send) ---
    r = await req('POST', '/api/chat/' + tenancyC + '/messages', { cookie: tenantB.cookie, body: { body: 'hello' } });
    check('send as another tenant → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('POST', '/api/chat/' + tenancyC + '/messages', { cookie: ownerB.cookie, body: { body: 'hello' } });
    check('send as another owner → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('GET', '/api/chat/' + tenancyC + '/messages', { cookie: tenantB.cookie });
    check('read as another tenant → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('GET', '/api/chat/' + tenancyC + '/messages', { cookie: ownerB.cookie });
    check('read as another owner → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('GET', '/api/chat/999999/messages', { cookie: tenantD.cookie });
    check('read missing tenancy → 404', r.status === 404, r.status + ' ' + r.text);
    r = await req('POST', '/api/chat/999999/messages', { cookie: tenantD.cookie, body: { body: 'hi' } });
    check('send on missing tenancy → 404', r.status === 404, r.status + ' ' + r.text);
    r = await req('GET', '/api/chat/' + tenancyC + '/messages');
    check('read chat 401 without login', r.status === 401, r.status + ' ' + r.text);
    r = await req('POST', '/api/chat/' + tenancyC + '/messages', { body: { body: 'hi' } });
    check('send chat 401 without login', r.status === 401, r.status + ' ' + r.text);

    // --- LINK-FIRST: a requested tenancy has NO chat ---
    r = await req('GET', '/api/chat/' + tenancyA + '/messages', { cookie: tenantA.cookie });
    check('read on requested tenancy 200 (empty — nothing exists yet)',
      r.status === 200 && Array.isArray(r.json.messages) && r.json.messages.length === 0, r.status + ' ' + r.text);
    r = await req('POST', '/api/chat/' + tenancyA + '/messages', { cookie: tenantA.cookie, body: { body: 'hello?' } });
    check('send on requested tenancy → 400 (no chat before approval)', r.status === 400, r.status + ' ' + r.text);
    r = await req('POST', '/api/chat/' + tenancyA + '/messages', { cookie: ownerA.cookie, body: { body: 'hello?' } });
    check('owner send on requested tenancy → 400', r.status === 400, r.status + ' ' + r.text);
    let up5 = await uploadChatPhoto(tenantA.cookie, tenancyA, JPEG, 'chat.jpg');
    check('photo on requested tenancy → 400', up5.status === 400, up5.status + ' ' + up5.text);

    // --- photo messages ---
    up5 = await uploadChatPhoto(tenantD.cookie, tenancyC, JPEG, 'chat.jpg');
    check('photo message 201 + empty body + photo url',
      up5.status === 201 && up5.json.message && up5.json.message.body === ''
      && typeof up5.json.message.photo_url === 'string' && up5.json.message.photo_url.startsWith('/api/photos/file/'),
      up5.status + ' ' + up5.text);
    const chatPhotoUrl = up5.json.message.photo_url;
    const chatPhotoMsg = up5.json.message;
    fr = await fetch(BASE + chatPhotoUrl, { headers: { Cookie: ownerC.cookie } });
    check('chat photo serves 200 to the other party', fr.status === 200 && (fr.headers.get('content-type') || '').startsWith('image/'), String(fr.status));
    fr = await fetch(BASE + chatPhotoUrl, { headers: { Cookie: tenantD.cookie } });
    check('chat photo serves 200 to the sender', fr.status === 200, String(fr.status));
    fr = await fetch(BASE + chatPhotoUrl, { headers: { Cookie: tenantB.cookie } });
    check('chat photo 403 to another tenant', fr.status === 403, String(fr.status));
    fr = await fetch(BASE + chatPhotoUrl, { headers: { Cookie: ownerB.cookie } });
    check('chat photo 403 to another owner', fr.status === 403, String(fr.status));
    up5 = await uploadChatPhoto(tenantB.cookie, tenancyC, JPEG, 'chat.jpg');
    check('photo as non-party → 403', up5.status === 403, up5.status + ' ' + up5.text);
    up5 = await uploadChatPhoto(tenantD.cookie, tenancyC, big, 'big.jpg');
    check('oversize chat photo → 413', up5.status === 413, up5.status + ' ' + up5.text.slice(0, 120));
    up5 = await uploadChatPhoto(tenantD.cookie, tenancyC, Buffer.from('hello, not an image at all'), 'fake.jpg');
    check('chat photo bad magic bytes → 400', up5.status === 400, up5.status + ' ' + up5.text);
    up5 = await uploadChatPhoto(tenantD.cookie, tenancyC, JPEG, 'chat.png');
    check('chat photo extension mismatch → 400', up5.status === 400, up5.status + ' ' + up5.text);
    up5 = await uploadChatPhoto(tenantD.cookie, tenancyC, null, 'none.jpg');
    check('chat photo missing file → 400', up5.status === 400, up5.status + ' ' + up5.text);
    // Threads: the photo message is the last message; it is unread for the owner.
    r = await req('GET', '/api/chat/threads', { cookie: ownerC.cookie });
    const threadC3 = (r.json.threads || []).find((t) => t.tenancy_id === tenancyC);
    check('threads: last message is the photo message',
      !!threadC3 && threadC3.last_message && threadC3.last_message.id === chatPhotoMsg.id
      && threadC3.last_message.photo_url === chatPhotoUrl && threadC3.unread_count >= 1, JSON.stringify(threadC3 && threadC3.last_message));
    r = await req('GET', '/api/chat/' + tenancyC + '/messages', { cookie: ownerC.cookie });
    const photoBack = (r.json.messages || []).find((m) => m.id === chatPhotoMsg.id);
    check('photo message comes back with its photo url', !!photoBack && photoBack.photo_url === chatPhotoUrl, JSON.stringify(photoBack));
    r = await req('GET', '/api/chat/' + tenancyC + '/messages', { cookie: tenantD.cookie });
    const photoTicks = (r.json.messages || []).find((m) => m.id === chatPhotoMsg.id);
    check('ticks: photo message read after the other party fetches',
      !!photoTicks && photoTicks.ticks === 'read' && typeof photoTicks.read_at === 'number', JSON.stringify(photoTicks));

    // --- master never sees message bodies ---
    r = await req('GET', '/api/master/users', { master: MASTER });
    check('master users contain no chat message bodies', !r.text.includes('MARKER-CHAT-7X9Q') && !r.text.includes('Assalam-o-Alaikum'), 'chat body leaked to master');
    r = await req('GET', '/api/master/stats', { master: MASTER });
    check('master stats counts messages only, no bodies',
      r.status === 200 && typeof r.json.messages === 'number' && r.json.messages >= 5
      && !('body' in r.json) && !r.text.includes('MARKER-CHAT-7X9Q'), r.status + ' ' + r.text);
    r = await req('GET', '/api/master/messages', { master: MASTER });
    check('no master message-bodies endpoint (404)', r.status === 404, r.status + ' ' + r.text);

    // --- chat pages + Chat links with unread badge ---
    r = await req('GET', '/chat');
    check('/chat page 200 + tick explanation in plain words',
      r.status === 200 && r.text.includes('✓ = stored on the server.')
      && r.text.includes('Blue ✓✓ = they opened this chat.')
      && r.text.includes('This app cannot know their phone received it'), r.status);
    r = await req('GET', '/chat.js');
    check('/chat.js serves + thread header "Tenancy active since"',
      r.status === 200 && r.text.includes('Tenancy active since'), r.status);
    r = await req('GET', '/chat-badge.js');
    check('/chat-badge.js serves + reads /api/chat/threads',
      r.status === 200 && r.text.includes('/api/chat/threads') && r.text.includes('unread_count'), r.status);
    for (const [page, label] of [['/owner', 'owner'], ['/tenant', 'tenant'], ['/tenancy', 'tenancy'], ['/', 'home']]) {
      r = await req('GET', page);
      check(label + ' page has Chat link + unread badge',
        r.status === 200 && r.text.includes('id="chat-link"') && r.text.includes('id="chat-badge"')
        && r.text.includes('chat-badge.js'), r.status);
    }

    // --- ended tenancy: history stays readable, no new messages ---
    r = await req('POST', '/api/owner/tenancies/' + tenancyReq + '/end', { cookie: ownerC.cookie, body: { reason: 'Tenant moved out.' } });
    check('Phase 5: owner ends second tenancy → ended', r.status === 200 && r.json.tenancy.status === 'ended', r.status + ' ' + r.text);
    r = await req('POST', '/api/chat/' + tenancyReq + '/messages', { cookie: tenantE.cookie, body: { body: 'one more' } });
    check('send on ended tenancy → 400 (read-only)', r.status === 400, r.status + ' ' + r.text);
    r = await req('GET', '/api/chat/' + tenancyReq + '/messages', { cookie: tenantE.cookie });
    check('read on ended tenancy 200 (history is the proof)',
      r.status === 200 && r.json.messages.length === 1 && r.json.messages[0].body === 'Hello from flat 2', r.status + ' ' + r.text);
    r = await req('GET', '/api/chat/threads', { cookie: ownerC.cookie });
    check('threads: ended tenancy drops out (one active thread left)',
      r.status === 200 && r.json.threads.length === 1 && r.json.threads[0].tenancy_id === tenancyC, r.status + ' ' + r.text);

    // ================= Phase 6: final review — CSRF, fail-closed, E2E =================
    // --- CSRF: Origin/Referer check on cookie POSTs (SameSite=Lax is the
    // primary defence; a foreign Origin/Referer must be refused) ---
    r = await req('POST', '/api/auth/logout', { cookie: tenantD.cookie, headers: { Origin: 'https://evil.example' } });
    check('CSRF: logout with a foreign Origin → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('GET', '/api/auth/me', { cookie: tenantD.cookie });
    check('CSRF: foreign-Origin logout did NOT kill the session', r.status === 200, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/houses', { cookie: ownerC.cookie, headers: { Origin: 'https://evil.example' }, body: houseBody({ title: 'CSRF House' }) });
    check('CSRF: house create with a foreign Origin → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('POST', '/api/notifications/read-all', { cookie: tenantD.cookie, headers: { Referer: 'https://evil.example/x' } });
    check('CSRF: POST with a foreign Referer → 403', r.status === 403, r.status + ' ' + r.text);
    r = await req('POST', '/api/auth/login', { ip: nextIp(), body: { gmail: 'owner1@gmail.com', password: 'ownerpass2' } });
    const csrfCookie = cookieOf(r);
    check('CSRF: fresh login for the same-origin check', r.status === 200 && !!csrfCookie, r.status + ' ' + r.text);
    r = await req('POST', '/api/auth/logout', { cookie: csrfCookie, headers: { Origin: 'http://127.0.0.1:' + PORT } });
    check('CSRF: logout with the same-origin Origin → 200', r.status === 200, r.status + ' ' + r.text);
    r = await req('GET', '/api/auth/me', { cookie: csrfCookie });
    check('CSRF: same-origin logout killed the session', r.status === 401, r.status + ' ' + r.text);

    // --- Phase 6: sessions — 24h cookie + no secrets in the server log ---
    r = await req('POST', '/api/auth/login', { ip: nextIp(), body: { gmail: 'owner1@gmail.com', password: 'ownerpass2' } });
    check('session cookie carries Max-Age=86400 (24h) + HttpOnly + SameSite=Lax',
      /Max-Age=86400/.test(r.setCookie) && /HttpOnly/.test(r.setCookie) && /SameSite=Lax/.test(r.setCookie),
      r.setCookie);
    check('server log never contains a password, Gmail or session token',
      !serverLog.includes('ownerpass2') && !serverLog.includes('tenantpass9')
      && !serverLog.includes('owner1@gmail.com') && !serverLog.includes('tenant1@gmail.com')
      && !serverLog.includes('test-admin-code'),
      'log held a secret (first 200 chars: ' + serverLog.slice(0, 200) + ')');

    // --- ADMIN_CODE fail-closed: the server exits (code 1) without it ---
    {
      const noCodeEnv = { ...process.env, PORT: '3099', DB_FILE: path.join(tmp, 'nocode.sqlite'), UPLOADS_DIR: path.join(tmp, 'nocode-uploads') };
      delete noCodeEnv.ADMIN_CODE;
      const noCode = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: noCodeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let noCodeOut = '';
      noCode.stdout.on('data', (d) => { noCodeOut += d; });
      noCode.stderr.on('data', (d) => { noCodeOut += d; });
      const noCodeExit = await new Promise((resolve) => {
        const timer = setTimeout(() => { try { noCode.kill('SIGKILL'); } catch { /* ignore */ } resolve(null); }, 8000);
        noCode.on('exit', (code) => { clearTimeout(timer); resolve(code); });
      });
      check('server exits without ADMIN_CODE (exit code 1)', noCodeExit === 1, 'exit=' + noCodeExit + ' out=' + noCodeOut.slice(0, 200));
      check('server without ADMIN_CODE prints the fail-closed error', noCodeOut.includes('ADMIN_CODE'), noCodeOut.slice(0, 200));
    }

    // --- End-to-end flow, one scenario, fresh users ---
    const e2eOwner = await makeUser('owner', { name: 'E2E Malik' });
    const e2eTenant = await makeUser('tenant', { name: 'E2E Ahmed' });
    r = await req('POST', '/api/owner/houses', { cookie: e2eOwner.cookie, body: houseBody({ title: 'E2E House 1', rent_pkr: 35000 }) });
    check('E2E: owner creates house 201', r.status === 201, r.status + ' ' + r.text);
    const e2eHouse = r.json.house;
    r = await req('GET', '/api/owner/houses/' + e2eHouse.id + '/code', { cookie: e2eOwner.cookie });
    check('E2E: owner gets the link code', r.status === 200 && /^KRY-/.test(r.json.code), r.status + ' ' + r.text);
    const e2eCode = r.json.code;
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: e2eTenant.cookie, body: { code: e2eCode } });
    check('E2E: tenant links (requested)', r.status === 201 && r.json.tenancy.status === 'requested', r.status + ' ' + r.text);
    const e2eTenancy = r.json.tenancy.id;
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: e2eOwner.cookie, body: { tenancy_id: e2eTenancy, decision: 'approve', rent_pkr: 35000, due_day: 5, start_date: '2026-11-01' } });
    check('E2E: owner approves → active + rent schedule',
      r.status === 200 && r.json.tenancy.status === 'active'
      && (r.json.tenancy.schedules || []).some((s) => s.kind === 'rent' && s.amount_pkr === 35000),
      r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/bills', { cookie: e2eTenant.cookie });
    const e2eRent = (r.json.bills || []).find((b) => b.schedule_kind === 'rent');
    check('E2E: rent bill generated for the current month',
      !!e2eRent && e2eRent.month === curMonth && e2eRent.amount_pkr === 35000, JSON.stringify(e2eRent));
    let e2ePay = await uploadPayment(e2eTenant.cookie, { bill_id: e2eRent.id, amount_pkr: 35000, method: 'easypaisa', txn_ref: 'E2E-1' }, JPEG, 'e2e.jpg');
    check('E2E: tenant uploads proof 201 pending',
      e2ePay.status === 201 && e2ePay.json.payment.status === 'pending', e2ePay.status + ' ' + e2ePay.text);
    r = await req('POST', '/api/owner/payments/decide', { cookie: e2eOwner.cookie, body: { payment_id: e2ePay.json.payment.id, decision: 'approve' } });
    check('E2E: owner approves → bill paid + receipt',
      r.status === 200 && r.json.payment.status === 'approved' && r.json.bill.status === 'paid'
      && r.json.receipt && /^RCP-/.test(r.json.receipt.receipt_number), r.status + ' ' + r.text);
    const e2eReceipt = r.json.receipt.receipt_number;
    r = await req('GET', '/api/tenant/receipts', { cookie: e2eTenant.cookie });
    check('E2E: tenant sees the receipt',
      (r.json.receipts || []).some((rc) => rc.receipt_number === e2eReceipt), r.status + ' ' + r.text);
    // Chat + ticks: sent → delivered (threads fetch) → read (messages fetch).
    r = await req('POST', '/api/chat/' + e2eTenancy + '/messages', { cookie: e2eTenant.cookie, body: { body: 'E2E: rent paid, please confirm.' } });
    check('E2E: tenant sends chat 201, ticks sent',
      r.status === 201 && r.json.message.ticks === 'sent', r.status + ' ' + r.text);
    const e2eMsg = r.json.message;
    r = await req('GET', '/api/chat/threads', { cookie: e2eOwner.cookie });
    check('E2E: owner thread list shows the message, unread 1',
      (r.json.threads || []).some((t) => t.tenancy_id === e2eTenancy && t.unread_count === 1), r.status + ' ' + r.text);
    r = await req('GET', '/api/chat/' + e2eTenancy + '/messages', { cookie: e2eTenant.cookie });
    const e2eMsgD = (r.json.messages || []).find((m) => m.id === e2eMsg.id);
    check('E2E: after owner opens the app (threads only), ticks delivered — not read',
      !!e2eMsgD && e2eMsgD.ticks === 'delivered' && e2eMsgD.read_at === null, JSON.stringify(e2eMsgD));
    r = await req('GET', '/api/chat/' + e2eTenancy + '/messages', { cookie: e2eOwner.cookie });
    check('E2E: owner opens the chat',
      r.status === 200 && (r.json.messages || []).some((m) => m.id === e2eMsg.id), r.status + ' ' + r.text);
    r = await req('GET', '/api/chat/' + e2eTenancy + '/messages', { cookie: e2eTenant.cookie });
    const e2eMsgR = (r.json.messages || []).find((m) => m.id === e2eMsg.id);
    check('E2E: after owner opens the chat, ticks read',
      !!e2eMsgR && e2eMsgR.ticks === 'read' && typeof e2eMsgR.read_at === 'number', JSON.stringify(e2eMsgR));
    // Second house link blocked while the first tenancy is active.
    r = await req('POST', '/api/owner/houses', { cookie: e2eOwner.cookie, body: houseBody({ title: 'E2E House 2', rent_pkr: 20000 }) });
    const e2eHouse2 = r.json.house;
    r = await req('GET', '/api/owner/houses/' + e2eHouse2.id + '/code', { cookie: e2eOwner.cookie });
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: e2eTenant.cookie, body: { code: r.json.code } });
    check('E2E: second house link blocked (one active tenancy) → 409', r.status === 409, r.status + ' ' + r.text);
    // End the tenancy: history stays readable, new chat/payment blocked.
    r = await req('POST', '/api/owner/tenancies/' + e2eTenancy + '/end', { cookie: e2eOwner.cookie, body: { reason: 'E2E: tenancy complete.' } });
    check('E2E: owner ends tenancy → ended', r.status === 200 && r.json.tenancy.status === 'ended', r.status + ' ' + r.text);
    r = await req('GET', '/api/owner/tenancies/' + e2eTenancy, { cookie: e2eOwner.cookie });
    check('E2E: history stays readable (bills + payments + receipts on the ended tenancy)',
      r.status === 200 && (r.json.tenancy.bills || []).length >= 1 && (r.json.tenancy.payments || []).length >= 1
      && (r.json.tenancy.receipts || []).some((rc) => rc.receipt_number === e2eReceipt), r.status + ' ' + r.text);
    r = await req('GET', '/api/chat/' + e2eTenancy + '/messages', { cookie: e2eTenant.cookie });
    check('E2E: chat history stays readable after end',
      r.status === 200 && (r.json.messages || []).some((m) => m.id === e2eMsg.id), r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/receipts', { cookie: e2eTenant.cookie });
    check('E2E: receipts stay readable after end',
      (r.json.receipts || []).some((rc) => rc.receipt_number === e2eReceipt), r.status + ' ' + r.text);
    r = await req('POST', '/api/chat/' + e2eTenancy + '/messages', { cookie: e2eTenant.cookie, body: { body: 'one more' } });
    check('E2E: new chat blocked after end → 400', r.status === 400, r.status + ' ' + r.text);
    e2ePay = await uploadPayment(e2eTenant.cookie, { bill_id: e2eRent.id, amount_pkr: 35000, method: 'cash' }, JPEG, 'e2e2.jpg');
    check('E2E: new payment blocked after end → 400', e2ePay.status === 400, e2ePay.status + ' ' + e2ePay.text);

    // ================= Review (2026-11-07): fixes + market improvements =================
    // (a) Double approval: a tenant with two PENDING requests must not
    // end up with two ACTIVE tenancies when both owners approve.
    const dblOwnerA = await makeUser('owner', { name: 'Double Owner A' });
    const dblOwnerB = await makeUser('owner', { name: 'Double Owner B' });
    const dblTenant = await makeUser('tenant', { name: 'Double Tenant' });
    r = await req('POST', '/api/owner/houses', { cookie: dblOwnerA.cookie, body: houseBody({ title: 'Double House A', rent_pkr: 30000 }) });
    const dblHouseA = r.json.house;
    r = await req('GET', '/api/owner/houses/' + dblHouseA.id + '/code', { cookie: dblOwnerA.cookie });
    const dblCodeA = r.json.code;
    r = await req('POST', '/api/owner/houses', { cookie: dblOwnerB.cookie, body: houseBody({ title: 'Double House B', rent_pkr: 25000 }) });
    const dblHouseB = r.json.house;
    r = await req('GET', '/api/owner/houses/' + dblHouseB.id + '/code', { cookie: dblOwnerB.cookie });
    const dblCodeB = r.json.code;
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: dblTenant.cookie, body: { code: dblCodeA } });
    check('review: tenant holds a pending request at house A', r.status === 201 && r.json.tenancy.status === 'requested', r.status + ' ' + r.text);
    const dblTenA = r.json.tenancy.id;
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: dblTenant.cookie, body: { code: dblCodeB } });
    check('review: tenant holds a second pending request at house B', r.status === 201 && r.json.tenancy.status === 'requested', r.status + ' ' + r.text);
    const dblTenB = r.json.tenancy.id;
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: dblOwnerA.cookie, body: { tenancy_id: dblTenA, decision: 'approve', rent_pkr: 30000, due_day: 5, start_date: '2026-11-01' } });
    check('review: first approval → active', r.status === 200 && r.json.tenancy.status === 'active', r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: dblOwnerB.cookie, body: { tenancy_id: dblTenB, decision: 'approve', rent_pkr: 25000, due_day: 5, start_date: '2026-11-01' } });
    check('review: second approval for the same tenant → 409 (one active tenancy)',
      r.status === 409 && /already has an active tenancy/.test(r.json.error || ''), r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/tenancy', { cookie: dblTenant.cookie });
    check('review: tenant still sees only the first tenancy as active',
      r.status === 200 && r.json.tenancy && r.json.tenancy.id === dblTenA, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/tenancies/' + dblTenA + '/end', { cookie: dblOwnerA.cookie, body: { reason: 'review cleanup' } });
    check('review: first tenancy ended (cleanup)', r.status === 200 && r.json.tenancy.status === 'ended', r.status + ' ' + r.text);

    // (b) Re-approval after an end: one rent schedule, one rent bill.
    const reOwner = await makeUser('owner', { name: 'Re Owner' });
    const reTenant = await makeUser('tenant', { name: 'Re Tenant' });
    r = await req('POST', '/api/owner/houses', { cookie: reOwner.cookie, body: houseBody({ title: 'Re House', rent_pkr: 30000 }) });
    const reHouse = r.json.house;
    r = await req('GET', '/api/owner/houses/' + reHouse.id + '/code', { cookie: reOwner.cookie });
    const reCode1 = r.json.code;
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: reTenant.cookie, body: { code: reCode1 } });
    const reTen = r.json.tenancy.id;
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: reOwner.cookie, body: { tenancy_id: reTen, decision: 'approve', rent_pkr: 30000, due_day: 5, start_date: '2026-11-01' } });
    check('review: approve (first period) → active', r.status === 200 && r.json.tenancy.status === 'active', r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/tenancies/' + reTen + '/end', { cookie: reOwner.cookie, body: { reason: 'first period over' } });
    check('review: end (first period) → ended', r.status === 200, r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/houses/' + reHouse.id + '/code/regenerate', { cookie: reOwner.cookie });
    check('review: regenerate code after end', r.status === 200 && r.json.code, r.status + ' ' + r.text);
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: reTenant.cookie, body: { code: r.json.code } });
    check('review: tenant re-links (same tenancy row)', r.status === 201 && r.json.tenancy.id === reTen && r.json.tenancy.status === 'requested', r.status + ' ' + r.text);
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: reOwner.cookie, body: { tenancy_id: reTen, decision: 'approve', rent_pkr: 32000, due_day: 5, start_date: '2026-11-01' } });
    check('review: re-approve (second period) → active', r.status === 200 && r.json.tenancy.status === 'active' && r.json.tenancy.rent_pkr === 32000, r.status + ' ' + r.text);
    r = await req('GET', '/api/owner/tenancies/' + reTen, { cookie: reOwner.cookie });
    const reRentScheds = (r.json.tenancy.schedules || []).filter((s) => s.kind === 'rent' && s.active === 1);
    check('review: exactly one active rent schedule after re-approve',
      reRentScheds.length === 1 && reRentScheds[0].amount_pkr === 32000,
      JSON.stringify(reRentScheds));
    check('review: the old rent schedule is retired (active 0)',
      (r.json.tenancy.schedules || []).filter((s) => s.kind === 'rent' && s.active === 0).length === 1,
      JSON.stringify((r.json.tenancy.schedules || []).filter((s) => s.kind === 'rent')));
    const reRentBills = (r.json.tenancy.bills || []).filter((b) => b.schedule_kind === 'rent' && b.month === curMonth);
    check('review: exactly one rent bill for the current month after re-approve (no double billing)',
      reRentBills.length === 1, JSON.stringify(reRentBills.map((b) => [b.id, b.schedule_id, b.amount_pkr])));

    // (c) A second rent schedule cannot be added by hand, and editing
    // the rent schedule moves the tenancy's rent with it.
    r = await req('POST', '/api/owner/schedules', { cookie: reOwner.cookie, body: { tenancy_id: reTen, kind: 'rent', label: 'Second rent', amount_pkr: 1000, due_day: 5 } });
    check('review: adding a second rent schedule → 400', r.status === 400, r.status + ' ' + r.text);
    const reRentSchedId = reRentScheds[0].id;
    r = await req('PUT', '/api/owner/schedules/' + reRentSchedId, { cookie: reOwner.cookie, body: { amount_pkr: 33000 } });
    check('review: rent schedule amount edit 200', r.status === 200 && r.json.schedule.amount_pkr === 33000, r.status + ' ' + r.text);
    r = await req('GET', '/api/owner/tenancies/' + reTen, { cookie: reOwner.cookie });
    check('review: tenancy rent follows the rent schedule edit',
      r.json.tenancy.rent_pkr === 33000, JSON.stringify(r.json.tenancy.rent_pkr));
    r = await req('PUT', '/api/owner/schedules/' + reRentSchedId, { cookie: reOwner.cookie, body: { amount_pkr: null } });
    check('review: rent schedule cannot go variable (null amount) → 400', r.status === 400, r.status + ' ' + r.text);

    // (d) House create without bills_included defaults to an empty list.
    r = await req('POST', '/api/owner/houses', { cookie: reOwner.cookie, body: { title: 'No Bills House', kind: 'house', address: '2 No Bills St', city: 'Lahore', rent_pkr: 10000 } });
    check('review: house create without bills_included → 201 with empty list',
      r.status === 201 && Array.isArray(r.json.house.bills_included) && r.json.house.bills_included.length === 0,
      r.status + ' ' + r.text);

    // (e) Bill backfill: a tenancy that started two months ago bills
    // every month from its start month; a schedule added today bills
    // only this month; a future start date bills nothing yet.
    const d0 = new Date(nowD.getFullYear(), nowD.getMonth(), 1);
    const fmtM = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const mMinus2 = fmtM(new Date(d0.getFullYear(), d0.getMonth() - 2, 1));
    const mMinus1 = fmtM(new Date(d0.getFullYear(), d0.getMonth() - 1, 1));
    const mPlus1 = fmtM(new Date(d0.getFullYear(), d0.getMonth() + 1, 1));
    const bfOwner = await makeUser('owner', { name: 'Backfill Owner' });
    const bfTenant = await makeUser('tenant', { name: 'Backfill Tenant' });
    r = await req('POST', '/api/owner/houses', { cookie: bfOwner.cookie, body: houseBody({ title: 'Backfill House', rent_pkr: 20000 }) });
    const bfHouse = r.json.house;
    r = await req('GET', '/api/owner/houses/' + bfHouse.id + '/code', { cookie: bfOwner.cookie });
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: bfTenant.cookie, body: { code: r.json.code } });
    const bfTen = r.json.tenancy.id;
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: bfOwner.cookie, body: { tenancy_id: bfTen, decision: 'approve', rent_pkr: 20000, due_day: 5, start_date: mMinus2 + '-01' } });
    check('review: approve with a start date two months ago → active', r.status === 200 && r.json.tenancy.status === 'active', r.status + ' ' + r.text);
    r = await req('GET', '/api/owner/tenancies/' + bfTen, { cookie: bfOwner.cookie });
    const bfRent = (r.json.tenancy.bills || []).filter((b) => b.schedule_kind === 'rent');
    check('review: backfill creates one rent bill per month from the start month',
      bfRent.length === 3 && bfRent.map((b) => b.month).sort().join(',') === [mMinus2, mMinus1, curMonth].sort().join(',')
      && bfRent.every((b) => b.amount_pkr === 20000),
      JSON.stringify(bfRent.map((b) => [b.month, b.amount_pkr, b.status])));
    r = await req('POST', '/api/owner/schedules', { cookie: bfOwner.cookie, body: { tenancy_id: bfTen, kind: 'gas', label: 'SNGPL gas', amount_pkr: null, due_day: 10 } });
    check('review: gas schedule added today 201', r.status === 201, r.status + ' ' + r.text);
    r = await req('GET', '/api/owner/tenancies/' + bfTen, { cookie: bfOwner.cookie });
    const bfGas = (r.json.tenancy.bills || []).filter((b) => b.schedule_kind === 'gas');
    check('review: a schedule added today bills only the current month (no invented past bills)',
      bfGas.length === 1 && bfGas[0].month === curMonth && bfGas[0].amount_pkr === null,
      JSON.stringify(bfGas.map((b) => [b.month, b.amount_pkr])));
    const futOwner = await makeUser('owner', { name: 'Future Owner' });
    const futTenant = await makeUser('tenant', { name: 'Future Tenant' });
    r = await req('POST', '/api/owner/houses', { cookie: futOwner.cookie, body: houseBody({ title: 'Future House', rent_pkr: 15000 }) });
    const futHouse = r.json.house;
    r = await req('GET', '/api/owner/houses/' + futHouse.id + '/code', { cookie: futOwner.cookie });
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: futTenant.cookie, body: { code: r.json.code } });
    const futTen = r.json.tenancy.id;
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: futOwner.cookie, body: { tenancy_id: futTen, decision: 'approve', rent_pkr: 15000, due_day: 5, start_date: mPlus1 + '-01' } });
    check('review: approve with a future start date → active', r.status === 200 && r.json.tenancy.status === 'active', r.status + ' ' + r.text);
    r = await req('GET', '/api/owner/tenancies/' + futTen, { cookie: futOwner.cookie });
    check('review: future start date generates no bills yet',
      Array.isArray(r.json.tenancy.bills) && r.json.tenancy.bills.length === 0, JSON.stringify(r.json.tenancy.bills));

    // (f) Tenant history: after the tenancy ends, the tenant still
    // reads its bills, payments and receipts.
    const hOwner = await makeUser('owner', { name: 'History Owner' });
    const hTenant = await makeUser('tenant', { name: 'History Tenant' });
    const hStranger = await makeUser('tenant', { name: 'History Stranger' });
    r = await req('POST', '/api/owner/houses', { cookie: hOwner.cookie, body: houseBody({ title: 'History House', rent_pkr: 22000 }) });
    const hHouse = r.json.house;
    r = await req('GET', '/api/owner/houses/' + hHouse.id + '/code', { cookie: hOwner.cookie });
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: hTenant.cookie, body: { code: r.json.code } });
    const hTen = r.json.tenancy.id;
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: hOwner.cookie, body: { tenancy_id: hTen, decision: 'approve', rent_pkr: 22000, due_day: 5, start_date: '2026-11-01' } });
    check('review: history tenancy approved', r.status === 200 && r.json.tenancy.status === 'active', r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/bills', { cookie: hTenant.cookie });
    const hRent = (r.json.bills || []).find((b) => b.schedule_kind === 'rent');
    check('review: history tenancy has a rent bill', !!hRent && hRent.amount_pkr === 22000, JSON.stringify(hRent));
    let hPay = await uploadPayment(hTenant.cookie, { bill_id: hRent.id, amount_pkr: 22000, method: 'cash' }, JPEG, 'h.jpg');
    check('review: history tenancy payment 201', hPay.status === 201, hPay.status + ' ' + hPay.text);
    r = await req('POST', '/api/owner/payments/decide', { cookie: hOwner.cookie, body: { payment_id: hPay.json.payment.id, decision: 'approve' } });
    check('review: history tenancy payment approved + receipt', r.status === 200 && r.json.receipt, r.status + ' ' + r.text);
    const hReceipt = r.json.receipt.receipt_number;
    r = await req('POST', '/api/owner/tenancies/' + hTen + '/end', { cookie: hOwner.cookie, body: { reason: 'history test' } });
    check('review: history tenancy ended', r.status === 200 && r.json.tenancy.status === 'ended', r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/tenancy', { cookie: hTenant.cookie });
    check('review: current tenancy is null after the end', r.status === 200 && r.json.tenancy === null, r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/bills', { cookie: hTenant.cookie });
    check('review: current bills are empty after the end', r.status === 200 && (r.json.bills || []).length === 0, r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/history', { cookie: hTenant.cookie });
    check('review: history returns the ended tenancy with bills + payments + receipts',
      r.status === 200 && (r.json.tenancies || []).length === 1 && r.json.tenancies[0].id === hTen
      && (r.json.tenancies[0].bills || []).length >= 1
      && (r.json.tenancies[0].payments || []).length >= 1
      && (r.json.tenancies[0].receipts || []).some((rc) => rc.receipt_number === hReceipt),
      r.status + ' ' + JSON.stringify(r.json).slice(0, 300));
    r = await req('GET', '/api/tenant/history', { cookie: hStranger.cookie });
    check('review: another tenant history is empty (never sees the tenancy)',
      r.status === 200 && Array.isArray(r.json.tenancies) && r.json.tenancies.length === 0, r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/history', { cookie: hOwner.cookie });
    check('review: history 403 for owner', r.status === 403, r.status + ' ' + r.text);
    r = await req('GET', '/api/tenant/history');
    check('review: history 401 without login', r.status === 401, r.status + ' ' + r.text);

    // (g) Upload rate limit: 30/hour per account, 31st attempt → 429.
    const ulOwner = await makeUser('owner', { name: 'Upload Limit Owner' });
    r = await req('POST', '/api/owner/houses', { cookie: ulOwner.cookie, body: houseBody({ title: 'Upload House', rent_pkr: 10000 }) });
    const ulHouse = r.json.house;
    let lastUp = null;
    for (let i = 1; i <= 31; i++) {
      lastUp = await uploadPhoto(ulOwner.cookie, ulHouse.id, JPEG, 'up' + i + '.jpg');
    }
    check('review: 31st upload in an hour → 429 (per-account upload limit)',
      lastUp.status === 429, '31st status=' + lastUp.status + ' ' + lastUp.text.slice(0, 100));

    // (h) Pending queue carries the bill amount, so the owner can see
    // a part payment before approving it.
    r = await req('GET', '/api/owner/payments/pending', { cookie: hOwner.cookie });
    check('review: pending queue is empty after the history approval', r.status === 200 && (r.json.payments || []).length === 0, r.status + ' ' + r.text);
    const pOwner = await makeUser('owner', { name: 'Pending Owner' });
    const pTenant = await makeUser('tenant', { name: 'Pending Tenant' });
    r = await req('POST', '/api/owner/houses', { cookie: pOwner.cookie, body: houseBody({ title: 'Pending House', rent_pkr: 40000 }) });
    const pHouse = r.json.house;
    r = await req('GET', '/api/owner/houses/' + pHouse.id + '/code', { cookie: pOwner.cookie });
    r = await req('POST', '/api/tenant/link', { ip: nextIp(), cookie: pTenant.cookie, body: { code: r.json.code } });
    const pTen = r.json.tenancy.id;
    r = await req('POST', '/api/owner/link-requests/decide', { cookie: pOwner.cookie, body: { tenancy_id: pTen, decision: 'approve', rent_pkr: 40000, due_day: 5, start_date: '2026-11-01' } });
    r = await req('GET', '/api/tenant/bills', { cookie: pTenant.cookie });
    const pRent = (r.json.bills || []).find((b) => b.schedule_kind === 'rent');
    let pPay = await uploadPayment(pTenant.cookie, { bill_id: pRent.id, amount_pkr: 30000, method: 'cash' }, JPEG, 'p.jpg');
    check('review: part payment uploads 201 (owner decides with eyes open)', pPay.status === 201, pPay.status + ' ' + pPay.text);
    r = await req('GET', '/api/owner/payments/pending', { cookie: pOwner.cookie });
    const pRow = (r.json.payments || []).find((pp) => pp.id === pPay.json.payment.id);
    check('review: pending row carries the bill amount (40000) next to the paid amount (30000)',
      !!pRow && pRow.bill_amount_pkr === 40000 && pRow.amount_pkr === 30000, JSON.stringify(pRow));

    // (i) Real WCAG contrast ratios for the palette actually used
    // (the stylesheet used to claim a check in "test.js §6" that did
    // not exist). Ratios are computed, not asserted from memory.
    function relLum(hex) {
      const ch = (i) => {
        const v = parseInt(hex.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
    }
    function contrast(a, b) {
      const x = relLum(a), y = relLum(b);
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    }
    // Glass card background: rgba(255,252,246,.88) over the #ab8663 photo.
    function blend(fg, bg, alpha) {
      const px = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
      const F = px(fg), B = px(bg);
      return '#' + F.map((v, i) => Math.round(v * alpha + B[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('');
    }
    const glassBg = blend('#fffcf6', '#ab8663', 0.88);
    check('review: WCAG body text #2b2118 on glass ≥ 4.5 (AA)',
      contrast('#2b2118', glassBg) >= 4.5, contrast('#2b2118', glassBg).toFixed(2));
    check('review: WCAG muted text #5f4c3a on glass ≥ 4.5 (AA)',
      contrast('#5f4c3a', glassBg) >= 4.5, contrast('#5f4c3a', glassBg).toFixed(2));
    check('review: WCAG white on black pill #111827 ≥ 4.5 (AA)',
      contrast('#ffffff', '#111827') >= 4.5, contrast('#ffffff', '#111827').toFixed(2));
    check('review: WCAG white on red badge #b91c1c ≥ 4.5 (AA)',
      contrast('#ffffff', '#b91c1c') >= 4.5, contrast('#ffffff', '#b91c1c').toFixed(2));
    check('review: WCAG white on green lock #14532d ≥ 4.5 (AA)',
      contrast('#ffffff', '#14532d') >= 4.5, contrast('#ffffff', '#14532d').toFixed(2));
    check('review: WCAG error red #991b1b on glass ≥ 4.5 (AA)',
      contrast('#991b1b', glassBg) >= 4.5, contrast('#991b1b', glassBg).toFixed(2));

    // (j) Pages + small UI fixes from the review.
    r = await req('GET', '/owner');
    check('review: /owner has a Change password section + real Log out link',
      r.status === 200 && r.text.includes('Change password') && r.text.includes('id="logout-link"'), r.status);
    r = await req('GET', '/tenant');
    check('review: /tenant has Past tenancies + Change password + Log out',
      r.status === 200 && r.text.includes('Past tenancies') && r.text.includes('Change password') && r.text.includes('id="logout-link"'), r.status);
    r = await req('GET', '/change-password.js');
    check('review: /change-password.js serves + posts to the change endpoint',
      r.status === 200 && r.text.includes('/api/auth/change-password'), r.status);
    r = await req('GET', '/bell.js');
    check('review: /bell.js wires the logout link to POST /api/auth/logout',
      r.status === 200 && r.text.includes('logout-link') && r.text.includes('/api/auth/logout'), r.status);
    r = await req('GET', '/styles.css');
    check('review: /styles.css defines .btn-primary (was used but undefined)',
      r.status === 200 && r.text.includes('.btn-primary'), r.status);
    check('review: /styles.css has no dead Card Vault card/sidebar/securing rules left',
      r.status === 200 && !r.text.includes('.card-visual') && !r.text.includes('#sidebar')
      && !r.text.includes('securing-overlay') && !r.text.includes('.stepper')
      && !r.text.includes('test.js §6'), r.status);
    r = await req('GET', '/chat.js');
    check('review: /chat.js guards background polling with try/catch (no unhandled rejection on a dropped connection)',
      r.status === 200 && r.text.includes('next 5s poll retries') && r.text.includes('catch (e)'), r.status);
    r = await req('GET', '/owner.js');
    check('review: /owner.js flags a paid amount that differs from the bill',
      r.status === 200 && r.text.includes('differs from the bill') && r.text.includes('bill_amount_pkr'), r.status);
    r = await req('GET', '/tenant.js');
    check('review: /tenant.js loads past tenancies from /api/tenant/history',
      r.status === 200 && r.text.includes('/api/tenant/history'), r.status);
    r = await req('GET', '/tenancy.js');
    check('review: /tenancy.js falls back to /api/tenant/history for ended tenancies',
      r.status === 200 && r.text.includes('/api/tenant/history'), r.status);

    // --- static shell pages serve ---
    r = await req('GET', '/');
    check('home page 200', r.status === 200 && r.text.includes('Kiraya Register'), r.status);
    r = await req('GET', '/login');
    check('/login page 200', r.status === 200 && r.text.includes('Rent Taker'), r.status);

    // --- login page flow (jsdom): the browser login must redirect ---
    // Regression for the 2026-11-07 login bug: the login handler used
    // `data` before parsing it, so a correct login threw and the button
    // looked dead. The suite only tested the API, so the bug shipped.
    // jsdom cannot navigate to another document, so the test stubs ONLY
    // the navigation sink (window.location.href = X becomes a recorded
    // call) — the handler, the role decision and the real server response
    // all still run for real. The smoke below proves the session cookie
    // then opens /owner and /tenant.
    let jsdomMod = null;
    try { jsdomMod = require('/home/hatch/workspace/register-bug-repro/node_modules/jsdom'); }
    catch (e1) { try { jsdomMod = require('jsdom'); } catch (e2) { /* jsdom not installed */ } }
    if (!jsdomMod) {
      console.log('  SKIP - login-flow jsdom tests (jsdom not installed on this machine)');
    } else {
      const { JSDOM, VirtualConsole } = jsdomMod;
      const pageErrors = [];
      const onPageRejection = (e) => pageErrors.push(e && e.message ? e.message : String(e));
      process.on('unhandledRejection', onPageRejection);
      const sleep = (ms) => new Promise((res2) => setTimeout(res2, ms));
      function stubNavigation(html) {
        // Replace every `window.location.href = X;` with a recorded call.
        // Handles both the literal form ('/login') and the role
        // expression, which the login handler (local `role`) and the
        // register handler (local `userRole`) share — so replace ALL
        // occurrences, not just the first.
        let out = html.replace(
          /window\.location\.href = (role|userRole) === 'tenant' \? '\/tenant' : '\/owner';/g,
          "window.__redirectTo($1 === 'tenant' ? '/tenant' : '/owner');");
        out = out.replace(/window\.location\.href = ('[^']+');/g, 'window.__redirectTo($1);');
        return { html: out, stubbed: out.includes('__redirectTo') };
      }
      function drivePage(html, pageUrl, fetchImpl) {
        const redirects = [];
        const alerts = [];
        const jsdomErrors = [];
        const vc = new VirtualConsole();
        vc.on('jsdomError', (e) => jsdomErrors.push(e && e.message ? e.message : String(e)));
        const dom = new JSDOM(html, {
          url: pageUrl,
          runScripts: 'dangerously',
          virtualConsole: vc,
          beforeParse(window) {
            window.__redirects = redirects;
            window.__redirectTo = function (u) { redirects.push(String(u)); };
            window.alert = function (m) { alerts.push(String(m)); };
            window.fetch = fetchImpl || function (input, init) {
              const u = typeof input === 'string' ? new URL(input, pageUrl).toString() : input;
              return fetch(u, init);
            };
          },
        });
        return { dom, redirects, alerts, jsdomErrors };
      }
      const rawLoginHtml = fs.readFileSync(path.join(__dirname, 'public', 'login.html'), 'utf8');
      const loginStub = stubNavigation(rawLoginHtml);
      check('login flow: navigation sink stubbed (test harness)', loginStub.stubbed, 'window.location.href not found in login.html');
      const loginHtml = loginStub.html;
      // (a) correct owner login redirects to /owner
      // NOTE: the suite changed owner1's password to ownerpass2 at the
      // change-password check above, and tenant1's to tenantpass9 at the
      // master-reset check — these are the current passwords.
      {
        const p = drivePage(loginHtml, BASE + '/login');
        const doc = p.dom.window.document;
        doc.getElementById('owner-gmail').value = 'owner1@gmail.com';
        doc.getElementById('owner-password').value = 'ownerpass2';
        doc.getElementById('login-owner').dispatchEvent(new p.dom.window.Event('submit', { bubbles: true, cancelable: true }));
        await sleep(800);
        check('login flow: owner login redirects to /owner',
          p.redirects.length === 1 && p.redirects[0] === '/owner' && p.jsdomErrors.length === 0,
          'redirects=' + JSON.stringify(p.redirects) + ' alerts=' + JSON.stringify(p.alerts) + ' errors=' + JSON.stringify(p.jsdomErrors));
        p.dom.window.close();
      }
      // (b) correct tenant login redirects to /tenant
      {
        const p = drivePage(loginHtml, BASE + '/login');
        const doc = p.dom.window.document;
        doc.getElementById('tenant-gmail').value = 'tenant1@gmail.com';
        doc.getElementById('tenant-password').value = 'tenantpass9';
        doc.getElementById('login-tenant').dispatchEvent(new p.dom.window.Event('submit', { bubbles: true, cancelable: true }));
        await sleep(800);
        check('login flow: tenant login redirects to /tenant',
          p.redirects.length === 1 && p.redirects[0] === '/tenant' && p.jsdomErrors.length === 0,
          'redirects=' + JSON.stringify(p.redirects) + ' alerts=' + JSON.stringify(p.alerts) + ' errors=' + JSON.stringify(p.jsdomErrors));
        p.dom.window.close();
      }
      // (c) wrong password shows the error and does NOT redirect
      {
        const p = drivePage(loginHtml, BASE + '/login');
        const doc = p.dom.window.document;
        doc.getElementById('owner-gmail').value = 'owner1@gmail.com';
        doc.getElementById('owner-password').value = 'ownerpassWRONG';
        doc.getElementById('login-owner').dispatchEvent(new p.dom.window.Event('submit', { bubbles: true, cancelable: true }));
        await sleep(800);
        check('login flow: wrong password shows the error, no redirect',
          p.redirects.length === 0 && p.alerts.length === 1 && p.alerts[0] === 'invalid Gmail or password' && p.jsdomErrors.length === 0,
          'redirects=' + JSON.stringify(p.redirects) + ' alerts=' + JSON.stringify(p.alerts) + ' errors=' + JSON.stringify(p.jsdomErrors));
        p.dom.window.close();
      }
      // (d) server unreachable shows a plain message, no redirect
      {
        const p = drivePage(loginHtml, 'http://127.0.0.1:1/login');
        const doc = p.dom.window.document;
        doc.getElementById('owner-gmail').value = 'owner1@gmail.com';
        doc.getElementById('owner-password').value = 'ownerpass2';
        doc.getElementById('login-owner').dispatchEvent(new p.dom.window.Event('submit', { bubbles: true, cancelable: true }));
        await sleep(800);
        check('login flow: server unreachable shows a plain message, no redirect',
          p.redirects.length === 0 && p.alerts.length === 0 && p.jsdomErrors.length === 0
          && doc.getElementById('login-owner-msg').textContent === 'Could not reach the server. Please try again.',
          'redirects=' + JSON.stringify(p.redirects) + ' alerts=' + JSON.stringify(p.alerts)
          + ' msg=' + JSON.stringify(doc.getElementById('login-owner-msg').textContent) + ' errors=' + JSON.stringify(p.jsdomErrors));
        p.dom.window.close();
      }
      // (e) dashboard guard: when the server cannot be reached, the owner
      // page sends the user back to /login instead of sitting blank.
      {
        const rawOwnerHtml = fs.readFileSync(path.join(__dirname, 'public', 'owner.html'), 'utf8');
        const ownerJs = fs.readFileSync(path.join(__dirname, 'public', 'owner.js'), 'utf8');
        const ownerStub = stubNavigation(rawOwnerHtml.replace(
          '<script src="/owner.js"></script>',
          '<script>\n' + ownerJs + '\n</script>'));
        check('login flow: owner page navigation sink stubbed (test harness)', ownerStub.stubbed, 'no window.location.href in owner page');
        const p = drivePage(ownerStub.html, BASE + '/owner', () => Promise.reject(new Error('offline')));
        await sleep(800);
        check('login flow: owner dashboard unreachable sends user to /login',
          p.redirects.length === 1 && p.redirects[0] === '/login' && p.jsdomErrors.length === 0,
          'redirects=' + JSON.stringify(p.redirects) + ' errors=' + JSON.stringify(p.jsdomErrors));
        p.dom.window.close();
      }
      // (f) review: registering lands on the dashboard — the session
      // cookie is already set, so no second login is needed.
      {
        const p = drivePage(loginHtml, BASE + '/login');
        const doc = p.dom.window.document;
        doc.getElementById('reg-name').value = 'Jsdom Reg';
        doc.getElementById('reg-gmail').value = 'jsdom-reg-' + Date.now() + '@gmail.com';
        doc.getElementById('reg-phone').value = '0300-1234567';
        doc.getElementById('reg-password').value = 'jsdompass1';
        doc.getElementById('register-form').dispatchEvent(new p.dom.window.Event('submit', { bubbles: true, cancelable: true }));
        await sleep(800);
        check('login flow: register redirects to /owner',
          p.redirects.length === 1 && p.redirects[0] === '/owner' && p.jsdomErrors.length === 0,
          'redirects=' + JSON.stringify(p.redirects) + ' alerts=' + JSON.stringify(p.alerts) + ' errors=' + JSON.stringify(p.jsdomErrors)
          + ' msg=' + JSON.stringify(doc.getElementById('reg-msg').textContent));
        p.dom.window.close();
      }
      check('login flow: no unhandled rejection from any page handler', pageErrors.length === 0, JSON.stringify(pageErrors));
      process.removeListener('unhandledRejection', onPageRejection);
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((res2) => setTimeout(res2, 500));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\n' + passed + '/' + (passed + failed) + ' tests passed');
  if (failed === 0) console.log('ALL TESTS PASS');
  else { console.log('FAILURES: ' + failures.join(', ')); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exit(1); });
