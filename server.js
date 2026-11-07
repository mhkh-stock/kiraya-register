// Kiraya Register — Phase 6 (final review): WhatsApp-like chat with
// honest ticks. Fetching the thread LIST (polled every 15s = "opened
// the app") marks the other party's messages DELIVERED only; opening
// the thread itself (GET messages) marks them READ. A message goes
// sent → delivered → read, and the intermediate ✓✓ step is observable.
// No typing indicator, no online/last-seen, no message delete (the
// record is the proof). Chat photos reuse the 'proof' photo kind, so
// /api/photos/file/ already serves them only to the two parties of the
// tenancy.
// Node.js 24+, native node:http + node:sqlite only. No external deps.
// Port 3038. Data: data/kiraya.sqlite (DB_FILE env). Uploads: uploads/
// (UPLOADS_DIR env). Master gate: env ADMIN_CODE, fail-closed.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3038);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'kiraya.sqlite');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_CODE = process.env.ADMIN_CODE;
if (!ADMIN_CODE) { console.error('FATAL: ADMIN_CODE env var is required — set a private code, there is no default.'); process.exit(1); }
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 86400); // 24h
const LOGIN_LOCK_SECONDS = Number(process.env.LOGIN_LOCK_SECONDS || 900); // 15 min
const MAX_FAILED_LOGINS = 5;
const REGISTER_LIMIT_PER_HOUR = 3;

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');

// ---- full schema (plan §Data model) — all tables upfront, Phase 1
// only wires endpoints for users/sessions/audit; later phases add the rest.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gmail TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  cnic TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK(role IN ('owner','tenant')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS houses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('house','portion','flat','shop','room')),
  address TEXT NOT NULL, city TEXT NOT NULL DEFAULT '',
  area TEXT NOT NULL DEFAULT '',
  bedrooms INTEGER, bathrooms INTEGER,
  rent_pkr INTEGER NOT NULL,
  advance_pkr INTEGER NOT NULL DEFAULT 0,
  security_deposit_pkr INTEGER NOT NULL DEFAULT 0,
  bills_included TEXT NOT NULL DEFAULT '[]',
  maps_url TEXT NOT NULL DEFAULT '',
  plus_code TEXT NOT NULL DEFAULT '',
  available_from TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'vacant' CHECK(status IN ('vacant','occupied','hidden')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS house_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  house_id INTEGER NOT NULL REFERENCES houses(id),
  code TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tenancies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  house_id INTEGER NOT NULL REFERENCES houses(id),
  owner_id INTEGER NOT NULL REFERENCES users(id),
  tenant_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'requested'
        CHECK(status IN ('requested','active','ended','rejected')),
  rent_pkr INTEGER NOT NULL,
  advance_pkr INTEGER NOT NULL DEFAULT 0,
  due_day INTEGER NOT NULL CHECK(due_day BETWEEN 1 AND 28),
  start_date TEXT NOT NULL, end_date TEXT NOT NULL DEFAULT '',
  agreement_note TEXT NOT NULL DEFAULT '',
  agreement_registered INTEGER NOT NULL DEFAULT 0,
  police_registered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by INTEGER, decided_at TEXT, decide_reason TEXT NOT NULL DEFAULT '',
  UNIQUE(house_id, tenant_id)
);
CREATE TABLE IF NOT EXISTS bill_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenancy_id INTEGER NOT NULL REFERENCES tenancies(id),
  kind TEXT NOT NULL CHECK(kind IN ('rent','gas','electricity','water','internet','maintenance','other')),
  label TEXT NOT NULL DEFAULT '',
  amount_pkr INTEGER,
  due_day INTEGER NOT NULL CHECK(due_day BETWEEN 1 AND 28),
  active INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL REFERENCES bill_schedules(id),
  tenancy_id INTEGER NOT NULL REFERENCES tenancies(id),
  month TEXT NOT NULL,
  amount_pkr INTEGER,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'due'
        CHECK(status IN ('due','paid_pending','paid','overdue','waived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(schedule_id, month)
);
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uploader_id INTEGER NOT NULL REFERENCES users(id),
  tenancy_id INTEGER REFERENCES tenancies(id),
  house_id INTEGER REFERENCES houses(id),
  kind TEXT NOT NULL CHECK(kind IN ('house','proof')),
  filename TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id INTEGER NOT NULL REFERENCES bills(id),
  tenancy_id INTEGER NOT NULL REFERENCES tenancies(id),
  payer_id INTEGER NOT NULL REFERENCES users(id),
  amount_pkr INTEGER NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('cash','jazzcash','easypaisa','bank','other')),
  txn_ref TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  proof_photo_id INTEGER REFERENCES photos(id),
  status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by INTEGER, decided_at TEXT, decide_reason TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenancy_id INTEGER NOT NULL REFERENCES tenancies(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL DEFAULT '',
  photo_id INTEGER REFERENCES photos(id),
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('bill_due','bill_overdue','payment_pending','payment_approved','payment_rejected','message','link_request','link_approved','link_rejected','tenancy_ended')),
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER, actor_role TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '', target_id INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Phase 5 migration: the messages table gains delivered_at (ticks need
// it). SQLite ALTER TABLE ... ADD COLUMN works on existing databases;
// fresh DBs get the column on first start too. Never recreate the table.
{
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!cols.includes('delivered_at')) db.exec('ALTER TABLE messages ADD COLUMN delivered_at INTEGER');
}

// Review migration (2026-11-07): bill_schedules gains created_at so lazy
// bill generation can start a schedule in the month it was created, not
// the tenancy's first month. Existing rows get the migration time, so
// they never backfill before it — no invented past bills.
{
  const cols = db.prepare('PRAGMA table_info(bill_schedules)').all().map((c) => c.name);
  if (!cols.includes('created_at')) db.exec("ALTER TABLE bill_schedules ADD COLUMN created_at TEXT DEFAULT (datetime('now'))");
}

// Review migration (2026-11-07): notifications gains a dedup column so
// one notification per bill per kind is enforced on the bill, not the
// tenancy. Rows written before this migration have dedup '' and can
// notify once more for the same bill, then dedup applies.
{
  const cols = db.prepare('PRAGMA table_info(notifications)').all().map((c) => c.name);
  if (!cols.includes('dedup')) db.exec("ALTER TABLE notifications ADD COLUMN dedup TEXT DEFAULT ''");
}

// ---- crypto helpers (Bijli pattern) ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}
function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'hex');
    const hash = Buffer.from(parts[2], 'hex');
    const test = crypto.scryptSync(password, salt, 64);
    return hash.length === test.length && crypto.timingSafeEqual(hash, test);
  } catch { return false; }
}
function hmacHex(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}
function newSessionToken() { return crypto.randomBytes(32).toString('hex'); }
function signToken(token) { return token + '.' + hmacHex(token, SESSION_SECRET); }
function verifySignedToken(signed) {
  if (!signed || typeof signed !== 'string') return null;
  const dot = signed.lastIndexOf('.');
  if (dot <= 0) return null;
  const token = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  const expect = hmacHex(token, SESSION_SECRET);
  if (sig.length !== expect.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  } catch { return null; }
  return token;
}
function killAllSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
function audit(action, actor, targetType, targetId, detail) {
  db.prepare(`INSERT INTO audit(actor_id, actor_role, action, target_type, target_id, detail)
    VALUES(?,?,?,?,?,?)`).run(
    actor ? actor.id : null, actor ? actor.role : 'master',
    action, targetType || '', targetId == null ? null : targetId, detail || '');
}

// ---- auth helpers ----
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}
function sessionUser(req) {
  const signed = parseCookies(req).kiraya_session;
  const token = verifySignedToken(signed);
  if (!token) return null;
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(hmacHex(token, SESSION_SECRET));
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at <= now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hmacHex(token, SESSION_SECRET));
    return null;
  }
  const user = db.prepare('SELECT id, gmail, display_name, phone, role, status, created_at FROM users WHERE id = ?').get(row.user_id);
  if (!user || user.status !== 'active') return null;
  return user;
}
function setSessionCookie(res, user) {
  const token = newSessionToken();
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Math.floor(Date.now() / 1000));
  db.prepare('INSERT INTO sessions(user_id, token_hash, expires_at) VALUES(?,?,?)')
    .run(user.id, hmacHex(token, SESSION_SECRET), expiresAt);
  return 'kiraya_session=' + signToken(token) + '; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=' + SESSION_TTL_SECONDS;
}
function clearSessionCookie(req) {
  const signed = parseCookies(req).kiraya_session;
  const token = verifySignedToken(signed);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hmacHex(token, SESSION_SECRET));
  return 'kiraya_session=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0';
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, display_name: u.display_name, role: u.role, status: u.status };
}
function cnicLast4(cnic) {
  const digits = String(cnic || '').replace(/[^0-9]/g, '');
  return digits ? digits.slice(-4) : '';
}

// ---- validation ----
function validGmail(g) {
  return typeof g === 'string' && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(g.trim());
}
function validPhone(p) {
  // Pakistani mobile: 03XX-XXXXXXX (dash optional).
  return typeof p === 'string' && /^03\d{2}-?\d{7}$/.test(p.trim());
}
function normalizeCnic(raw) { return String(raw || '').replace(/[^0-9]/g, ''); }
function rejectUnknown(body, allowed) {
  for (const k of Object.keys(body || {})) {
    if (!allowed.has(k)) return k;
  }
  return null;
}

// ---- rate limiting (in-memory per IP) ----
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' ? fwd.split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
}
const ipFails = new Map(); // ip -> { count, firstAt, blockedUntil }
function ipBlocked(ip) {
  const rec = ipFails.get(ip);
  if (!rec) return false;
  const now = Date.now();
  if (rec.blockedUntil && now < rec.blockedUntil) return true;
  if (now - rec.firstAt > 10 * 60 * 1000) ipFails.delete(ip);
  return false;
}
function ipFail(ip) {
  const now = Date.now();
  const rec = ipFails.get(ip) || { count: 0, firstAt: now, blockedUntil: 0 };
  if (now - rec.firstAt > 10 * 60 * 1000) { rec.count = 0; rec.firstAt = now; rec.blockedUntil = 0; }
  rec.count++;
  if (rec.count >= MAX_FAILED_LOGINS) rec.blockedUntil = now + LOGIN_LOCK_SECONDS * 1000;
  ipFails.set(ip, rec);
}
function ipReset(ip) { ipFails.delete(ip); }
// Register: max 3 attempts/hour per IP (every attempt counts, so the
// limit cannot be dodged by sending invalid bodies).
const registerCounts = new Map(); // ip -> { count, firstAt }
function registerAllowed(ip) {
  const now = Date.now();
  const rec = registerCounts.get(ip) || { count: 0, firstAt: now };
  if (now - rec.firstAt > 60 * 60 * 1000) { rec.count = 0; rec.firstAt = now; }
  return rec.count < REGISTER_LIMIT_PER_HOUR;
}
function registerCounted(ip) {
  const now = Date.now();
  const rec = registerCounts.get(ip) || { count: 0, firstAt: now };
  if (now - rec.firstAt > 60 * 60 * 1000) { rec.count = 0; rec.firstAt = now; }
  rec.count++;
  registerCounts.set(ip, rec);
}

// Uploads: max 30/hour per account (every attempt counts). The 5 MB cap
// + per-house/per-payment caps bound one upload, but nothing bounded
// how many an account could store — houses are uncapped, so an account
// could otherwise fill the disk 8 photos at a time. 30/hour is far
// above real use (a house tops out at 8 photos) and stops the flood.
// The limit reads UPLOAD_LIMIT_PER_HOUR so tests can raise it.
const UPLOAD_LIMIT_PER_HOUR = Number(process.env.UPLOAD_LIMIT_PER_HOUR || 30);
const uploadCounts = new Map(); // userId -> { count, firstAt }
function uploadAllowed(userId) {
  const now = Date.now();
  const rec = uploadCounts.get(userId) || { count: 0, firstAt: now };
  if (now - rec.firstAt > 60 * 60 * 1000) { rec.count = 0; rec.firstAt = now; }
  if (rec.count >= UPLOAD_LIMIT_PER_HOUR) return false;
  rec.count++;
  uploadCounts.set(userId, rec);
  return true;
}

// ---- HTTP helpers ----
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer-when-downgrade',
  'X-Frame-Options': 'SAMEORIGIN',
};
function sendJson(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...(extraHeaders || {}) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 200000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); } });
    req.on('error', reject);
  });
}
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// CSRF: on cookie-authenticated POSTs, a present Origin/Referer must
// belong to this host. Requests with neither header (same-origin form
// posts from older clients, curl, tests) are allowed — SameSite=Lax is
// the primary defence; this check stops cross-site posts that do send
// an Origin/Referer.
function csrfOk(req) {
  const host = req.headers.host || '';
  for (const h of ['origin', 'referer']) {
    const v = req.headers[h];
    if (!v) continue;
    try {
      const origin = new URL(v).host;
      if (origin !== host) return false;
    } catch { return false; }
  }
  return true;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/login') urlPath = '/login.html';
  if (urlPath === '/owner') urlPath = '/owner.html';
  if (urlPath === '/tenant') urlPath = '/tenant.html';
  if (urlPath === '/tenancy') urlPath = '/tenancy.html';
  if (urlPath === '/notifications') urlPath = '/notifications.html';
  if (urlPath === '/chat') urlPath = '/chat.html';
  const file = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403, SECURITY_HEADERS); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, SECURITY_HEADERS); return res.end('Not found'); }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---- Phase 2 helpers: multipart uploads, magic bytes, house codes ----
function parseMultipartBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const m = ct.match(/multipart\/form-data;\s*boundary=(.+)$/);
    if (!m) return reject(new Error('not multipart'));
    const boundary = Buffer.from('--' + m[1].trim().replace(/^"|"$/g, ''));
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (e) => { if (!done) { done = true; reject(e); } };
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); return fail(new Error('upload too large')); }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        const body = Buffer.concat(chunks);
        const fields = {};
        const files = [];
        let start = 0;
        for (;;) {
          const bIdx = body.indexOf(boundary, start);
          if (bIdx === -1) break;
          const partStart = bIdx + boundary.length;
          if (body[partStart] === 45 && body[partStart + 1] === 45) break; // closing --boundary--
          const headEnd = body.indexOf('\r\n\r\n', partStart);
          if (headEnd === -1) break;
          const head = body.slice(partStart, headEnd).toString('utf8');
          const nextB = body.indexOf(boundary, headEnd + 4);
          if (nextB === -1) break;
          const data = body.slice(headEnd + 4, nextB - 2); // strip trailing CRLF
          const nameM = head.match(/name="([^"]*)"/);
          const fileM = head.match(/filename="([^"]*)"/);
          if (nameM && fileM && fileM[1]) {
            const typeM = head.match(/Content-Type:\s*([^\r\n]+)/i);
            files.push({ name: nameM[1], filename: fileM[1], contentType: (typeM ? typeM[1] : '').trim().toLowerCase(), data });
          } else if (nameM) {
            fields[nameM[1]] = data.toString('utf8');
          }
          start = nextB;
        }
        resolve({ fields, files });
      } catch (e) { reject(e); }
    });
    req.on('error', fail);
  });
}

// Magic bytes FIRST (never trust the file name or claimed MIME), extension
// second. JPEG FF D8 FF, PNG 89 50 4E 47 0D 0A 1A 0A, WebP RIFF....WEBP.
function detectImageKind(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
    && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return 'png';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return null;
}
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PHOTO_MAX_PER_HOUSE = 8;
const PHOTO_EXTS = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp' };
const PHOTO_MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
function newHouseCode() {
  let code;
  do {
    code = 'KRY-';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  } while (db.prepare('SELECT id FROM house_codes WHERE code = ?').get(code));
  return code;
}
function shareTextFor(code) { return 'Your house code is ' + code + ' — open the app and enter it'; }

// Link-code attempts: 5/hour per IP + per account (every attempt counts).
const linkAttempts = new Map();
function linkAttemptCounted(key) {
  const now = Date.now();
  const rec = linkAttempts.get(key) || { count: 0, firstAt: now };
  if (now - rec.firstAt > 60 * 60 * 1000) { rec.count = 0; rec.firstAt = now; }
  rec.count++;
  linkAttempts.set(key, rec);
  return rec.count;
}

function validDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function validMapsUrl(u) {
  if (u === '' || u === null || u === undefined) return true;
  if (typeof u !== 'string') return false;
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return false;
    if (!['google.com', 'www.google.com', 'maps.google.com'].includes(x.hostname)) return false;
    // Embed/share paths only: /maps..., /embed..., or the bare maps host with a query.
    return x.pathname.startsWith('/maps') || x.pathname.startsWith('/embed')
      || (x.pathname === '/' && x.search.length > 1);
  } catch { return false; }
}
const HOUSE_KINDS = new Set(['house', 'portion', 'flat', 'shop', 'room']);
const BILL_KINDS = new Set(['rent', 'gas', 'electricity', 'water', 'internet', 'maintenance', 'other']);
const HOUSE_FIELDS = new Set(['title', 'kind', 'address', 'city', 'area', 'bedrooms', 'bathrooms',
  'rent_pkr', 'advance_pkr', 'security_deposit_pkr', 'bills_included', 'maps_url', 'plus_code', 'available_from']);
function cleanHouseBody(body, partial) {
  // Returns { error } or { values } with only the provided, cleaned fields.
  const values = {};
  const need = (k) => !partial || Object.prototype.hasOwnProperty.call(body, k);
  if (need('title')) {
    const v = String(body.title ?? '').trim();
    if (!v || v.length > 150) return { error: 'title is required (max 150 characters)' };
    values.title = v;
  }
  if (need('kind')) {
    if (!HOUSE_KINDS.has(String(body.kind || ''))) return { error: 'kind must be house, portion, flat, shop or room' };
    values.kind = String(body.kind);
  }
  if (need('address')) {
    const v = String(body.address ?? '').trim();
    if (!v || v.length > 300) return { error: 'address is required (max 300 characters)' };
    values.address = v;
  }
  if (need('city')) {
    const v = String(body.city ?? '').trim();
    if (v.length > 100) return { error: 'city is too long (max 100 characters)' };
    values.city = v;
  }
  if (need('area')) {
    const v = String(body.area ?? '').trim();
    if (v.length > 100) return { error: 'area is too long (max 100 characters)' };
    values.area = v;
  }
  for (const k of ['bedrooms', 'bathrooms']) {
    if (need(k)) {
      const v = body[k];
      if (v === null || v === undefined || v === '') { values[k] = null; continue; }
      if (!Number.isInteger(v) || v < 0 || v > 50) return { error: k + ' must be a whole number between 0 and 50' };
      values[k] = v;
    }
  }
  for (const k of ['rent_pkr', 'advance_pkr', 'security_deposit_pkr']) {
    if (need(k)) {
      const v = body[k];
      if (v === null || v === undefined || v === '') {
        if (k === 'rent_pkr') return { error: 'rent_pkr is required' };
        values[k] = 0; continue;
      }
      if (!Number.isInteger(v) || v < (k === 'rent_pkr' ? 1 : 0) || v > 100000000) {
        return { error: k + ' must be a whole number of rupees' + (k === 'rent_pkr' ? ' above 0' : ' of 0 or more') };
      }
      values[k] = v;
    }
  }
  if (need('bills_included')) {
    let arr = body.bills_included;
    // A missing list is an empty list (like city/area default to '') —
    // the smoke run showed create failing without it.
    if (arr === undefined && !partial) { values.bills_included = '[]'; }
    else {
      if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { return { error: 'bills_included must be a JSON array' }; } }
      if (!Array.isArray(arr)) return { error: 'bills_included must be an array' };
      if (arr.length > 10) return { error: 'bills_included has too many entries (max 10)' };
      for (const item of arr) {
        if (typeof item !== 'string' || !BILL_KINDS.has(item)) return { error: 'bills_included entries must be rent, gas, electricity, water, internet, maintenance or other' };
      }
      values.bills_included = JSON.stringify([...new Set(arr)]);
    }
  }
  if (need('maps_url')) {
    const v = String(body.maps_url ?? '').trim();
    if (v.length > 500) return { error: 'maps_url is too long (max 500 characters)' };
    if (!validMapsUrl(v)) return { error: 'maps_url must be a Google Maps share or embed link' };
    values.maps_url = v;
  }
  if (need('plus_code')) {
    const v = String(body.plus_code ?? '').trim();
    if (v.length > 50) return { error: 'plus_code is too long (max 50 characters)' };
    values.plus_code = v;
  }
  if (need('available_from')) {
    const v = String(body.available_from ?? '').trim();
    if (v && !validDateStr(v)) return { error: 'available_from must be a YYYY-MM-DD date' };
    values.available_from = v;
  }
  return { values };
}
function houseTenant(houseId) {
  const t = db.prepare(`SELECT t.id AS tenancy_id, t.status AS tenancy_status, t.tenant_id,
      u.display_name FROM tenancies t JOIN users u ON u.id = t.tenant_id
      WHERE t.house_id = ? AND t.status IN ('requested','active')
      ORDER BY CASE t.status WHEN 'active' THEN 0 ELSE 1 END, t.created_at DESC, t.id DESC LIMIT 1`).get(houseId);
  return t ? { tenancy_id: t.tenancy_id, tenant_id: t.tenant_id, display_name: t.display_name, status: t.tenancy_status } : null;
}
function housePhotos(houseId) {
  return db.prepare("SELECT id, filename, created_at FROM photos WHERE house_id = ? AND kind = 'house' ORDER BY id ASC").all(houseId)
    .map((r) => ({ id: r.id, file_url: '/api/photos/file/' + r.filename, created_at: r.created_at }));
}
function houseView(row) {
  let bills = [];
  try { bills = JSON.parse(row.bills_included || '[]'); } catch { bills = []; }
  return {
    id: row.id, owner_id: row.owner_id, title: row.title, kind: row.kind,
    address: row.address, city: row.city, area: row.area,
    bedrooms: row.bedrooms, bathrooms: row.bathrooms,
    rent_pkr: row.rent_pkr, advance_pkr: row.advance_pkr, security_deposit_pkr: row.security_deposit_pkr,
    bills_included: bills, maps_url: row.maps_url, plus_code: row.plus_code,
    available_from: row.available_from, status: row.status, created_at: row.created_at,
    tenant: houseTenant(row.id), photos: housePhotos(row.id),
  };
}
function tenancySchedules(tenancyId) {
  return db.prepare('SELECT id, kind, label, amount_pkr, due_day, active, note FROM bill_schedules WHERE tenancy_id = ? ORDER BY id ASC').all(tenancyId);
}
function tenancyBills(tenancyId) {
  return db.prepare(`SELECT b.id, b.schedule_id, b.tenancy_id, b.month, b.amount_pkr, b.due_date, b.status, b.created_at,
      s.kind AS schedule_kind, s.label AS schedule_label
    FROM bills b JOIN bill_schedules s ON s.id = b.schedule_id
    WHERE b.tenancy_id = ? ORDER BY b.due_date ASC, b.id ASC`).all(tenancyId);
}
function tenancyPayments(tenancyId) {
  return db.prepare(PAYMENT_SELECT + ' WHERE p.tenancy_id = ? ORDER BY p.created_at DESC, p.id DESC').all(tenancyId).map(paymentView);
}
function ownerTenancyView(t) {
  const tenant = db.prepare('SELECT display_name, phone, cnic FROM users WHERE id = ?').get(t.tenant_id) || {};
  const house = db.prepare('SELECT id, title, kind, address, city, area FROM houses WHERE id = ?').get(t.house_id) || {};
  return {
    id: t.id, house_id: t.house_id, house, owner_id: t.owner_id, tenant_id: t.tenant_id,
    tenant: { display_name: tenant.display_name || '', phone: tenant.phone || '', cnic_last4: cnicLast4(tenant.cnic || '') },
    status: t.status, rent_pkr: t.rent_pkr, advance_pkr: t.advance_pkr, due_day: t.due_day,
    start_date: t.start_date, end_date: t.end_date, agreement_note: t.agreement_note,
    agreement_registered: t.agreement_registered, police_registered: t.police_registered,
    created_at: t.created_at, decided_by: t.decided_by, decided_at: t.decided_at, decide_reason: t.decide_reason,
    schedules: tenancySchedules(t.id),
    bills: tenancyBills(t.id).map((b) => enrichBill(b, tenant.phone || '', 'Your')),
    payments: tenancyPayments(t.id),
    receipts: receiptsForTenancy(t.id),
  };
}
function ownerTenancyDetail(t) {
  const v = ownerTenancyView(t);
  const tenant = db.prepare('SELECT cnic FROM users WHERE id = ?').get(t.tenant_id) || {};
  v.tenant.cnic = tenant.cnic || ''; // full CNIC only on the single-tenancy detail, for the linked owner
  v.schedules = tenancySchedules(t.id);
  return v;
}
function tenantTenancyView(t) {
  const house = db.prepare('SELECT id, title, kind, address, city, area, rent_pkr FROM houses WHERE id = ?').get(t.house_id) || {};
  const owner = db.prepare('SELECT display_name, phone FROM users WHERE id = ?').get(t.owner_id) || {};
  return {
    id: t.id, house_id: t.house_id, house, owner_id: t.owner_id,
    owner: { display_name: owner.display_name || '', phone: owner.phone || '' },
    status: t.status, rent_pkr: t.rent_pkr, advance_pkr: t.advance_pkr, due_day: t.due_day,
    start_date: t.start_date, end_date: t.end_date, agreement_note: t.agreement_note,
    agreement_registered: t.agreement_registered, police_registered: t.police_registered,
    created_at: t.created_at, decide_reason: t.decide_reason,
    schedules: tenancySchedules(t.id),
    bills: tenancyBills(t.id).map((b) => enrichBill(b, owner.phone || '', 'My')),
    payments: tenancyPayments(t.id),
    receipts: receiptsForTenancy(t.id),
  };
}
// ---- Phase 3: lazy monthly bill generation + notifications ----
// No cron in zero-dep: bills are generated when either party opens the
// tenancy, and on server start — for every month from the tenancy's
// start month (or a schedule's creation month, whichever is later)
// through the current month, so a month nobody opened the app still
// gets its bill. Generating twice must never duplicate
// (UNIQUE(schedule_id, month) + INSERT OR IGNORE).
function localToday() { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1, day: d.getDate() }; }
function monthStr(y, m) { return y + '-' + String(m).padStart(2, '0'); }
function currentMonth() { const t = localToday(); return monthStr(t.y, t.m); }
function todayStr() { const t = localToday(); return monthStr(t.y, t.m) + '-' + String(t.day).padStart(2, '0'); }
function dueDateFor(month, dueDay) { return month + '-' + String(dueDay).padStart(2, '0'); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
// wa.me deep link only: the app sends NOTHING itself — the link opens the
// user's own WhatsApp with the message ready to send. Pakistani mobile
// 03XX-XXXXXXX becomes 92XXXXXXXXXX for wa.me.
function waLink(phone, text) {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  const intl = digits.startsWith('92') ? digits : (digits.startsWith('0') ? '92' + digits.slice(1) : digits);
  return 'https://wa.me/' + intl + '?text=' + encodeURIComponent(text);
}
function billShareText(bill, prefix) {
  const amt = bill.amount_pkr == null ? 'amount not entered yet' : 'Rs ' + bill.amount_pkr;
  return prefix + ' ' + (bill.schedule_kind || 'bill') + ' bill for ' + bill.month + ' is due on ' + bill.due_date + ' — ' + amt;
}
function enrichBill(row, otherPhone, prefix) {
  const current = currentPaymentForBill(row.id);
  return {
    id: row.id, schedule_id: row.schedule_id, tenancy_id: row.tenancy_id,
    month: row.month, amount_pkr: row.amount_pkr, due_date: row.due_date,
    status: row.status, created_at: row.created_at,
    schedule_kind: row.schedule_kind, schedule_label: row.schedule_label,
    whatsapp_share_url: otherPhone ? waLink(otherPhone, billShareText(row, prefix)) : '',
    current_payment: current,
    receipt: current && current.status === 'approved' ? current.receipt : null,
  };
}
// ---- Phase 4: payment proofs + receipts ----
// A receipt is DERIVED from an approved payment — there is no separate
// receipts table, so a receipt can never drift from its payment. Number:
// RCP-<tenancy>-<seq>, where seq counts approved payments for the
// tenancy in approval order. Date = the day the owner approved it.
const PAYMENT_METHODS = new Set(['cash', 'jazzcash', 'easypaisa', 'bank', 'other']);
const PROOF_HONEST_LINE = 'A screenshot proves the tenant showed a payment — only the owner, checking his own account, knows the money arrived.';
const PAYMENT_SELECT = `SELECT p.id, p.bill_id, p.tenancy_id, p.payer_id, p.amount_pkr, p.method,
    p.txn_ref, p.note, p.proof_photo_id, p.status, p.created_at, p.decided_by, p.decided_at, p.decide_reason,
    b.month AS bill_month, b.status AS bill_status, s.kind AS schedule_kind, s.label AS schedule_label
  FROM payments p JOIN bills b ON b.id = p.bill_id JOIN bill_schedules s ON s.id = b.schedule_id`;
function receiptView(pay) {
  const seq = db.prepare("SELECT COUNT(*) c FROM payments WHERE tenancy_id = ? AND status = 'approved' AND id <= ?").get(pay.tenancy_id, pay.id).c;
  const bill = db.prepare(`SELECT b.month, s.kind, s.label FROM bills b JOIN bill_schedules s ON s.id = b.schedule_id WHERE b.id = ?`).get(pay.bill_id) || {};
  const tenancy = db.prepare('SELECT house_id FROM tenancies WHERE id = ?').get(pay.tenancy_id) || {};
  const house = db.prepare('SELECT title FROM houses WHERE id = ?').get(tenancy.house_id) || {};
  const tenant = db.prepare('SELECT display_name FROM users WHERE id = ?').get(pay.payer_id) || {};
  return {
    receipt_number: 'RCP-' + pay.tenancy_id + '-' + seq,
    payment_id: pay.id, bill_id: pay.bill_id, tenancy_id: pay.tenancy_id,
    date: String(pay.decided_at || pay.created_at || '').slice(0, 10),
    amount_pkr: pay.amount_pkr, method: pay.method, txn_ref: pay.txn_ref || '',
    tenant_name: tenant.display_name || '', house_title: house.title || '',
    month: bill.month || '', schedule_kind: bill.kind || '', schedule_label: bill.label || '',
  };
}
function paymentView(pay) {
  const proof = pay.proof_photo_id ? db.prepare('SELECT filename FROM photos WHERE id = ?').get(pay.proof_photo_id) : null;
  const v = {
    id: pay.id, bill_id: pay.bill_id, tenancy_id: pay.tenancy_id, payer_id: pay.payer_id,
    amount_pkr: pay.amount_pkr, method: pay.method, txn_ref: pay.txn_ref || '', note: pay.note || '',
    status: pay.status, created_at: pay.created_at, decided_by: pay.decided_by || null,
    decided_at: pay.decided_at || null, decide_reason: pay.decide_reason || '',
    bill_month: pay.bill_month || '', bill_status: pay.bill_status || '',
    schedule_kind: pay.schedule_kind || '', schedule_label: pay.schedule_label || '',
    proof_file_url: proof ? '/api/photos/file/' + proof.filename : null,
  };
  if (pay.status === 'approved') v.receipt = receiptView(pay);
  return v;
}
function currentPaymentForBill(billId) {
  const row = db.prepare(PAYMENT_SELECT + ' WHERE p.bill_id = ? ORDER BY p.id DESC LIMIT 1').get(billId);
  return row ? paymentView(row) : null;
}
function receiptsForTenancy(tenancyId) {
  return db.prepare(PAYMENT_SELECT + " WHERE p.tenancy_id = ? AND p.status = 'approved' ORDER BY p.decided_at DESC, p.id DESC").all(tenancyId)
    .map((r) => receiptView(r));
}
// CSV export (vault csv.js approach, server-side): plain integers, no
// "Rs", no thousands commas; a field with a comma, quote or line break
// is quoted and inner quotes are doubled.
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function ledgerRows(whereSql, args) {
  return db.prepare(`SELECT p.*, b.month AS bill_month, s.kind AS schedule_kind, s.label AS schedule_label,
      h.title AS house_title, tu.display_name AS tenant_name
    FROM payments p JOIN bills b ON b.id = p.bill_id
    JOIN bill_schedules s ON s.id = b.schedule_id
    JOIN tenancies t ON t.id = p.tenancy_id
    JOIN houses h ON h.id = t.house_id
    JOIN users tu ON tu.id = p.payer_id
    WHERE ${whereSql} ORDER BY p.created_at DESC, p.id DESC`).all(...args);
}
function ledgerCsv(rows) {
  const lines = [['month', 'house', 'tenant', 'bill kind', 'amount', 'method', 'status', 'receipt no'].map(csvEscape).join(',')];
  for (const r of rows) {
    const receiptNo = r.status === 'approved' ? receiptView(r).receipt_number : '';
    lines.push([r.bill_month, r.house_title, r.tenant_name, r.schedule_kind, r.amount_pkr, r.method, r.status, receiptNo].map(csvEscape).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
function sendCsv(res, filename, text) {
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + filename + '"', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
// One notification per bill per kind: the dedup key names the bill, so
// two bills of one tenancy due in the same window each notify once.
// The stored link stays the tenancy page (existing clients/tests read
// it); the dedup key lives in its own column.
function notifyOnce(userId, kind, title, body, link, dedupKey) {
  const key = dedupKey || link;
  const ex = db.prepare('SELECT id FROM notifications WHERE user_id = ? AND kind = ? AND dedup = ?').get(userId, kind, key);
  if (ex) return;
  db.prepare('INSERT INTO notifications(user_id, kind, title, body, link, dedup) VALUES(?,?,?,?,?,?)')
    .run(userId, kind, title, body, link, key);
}
function notifyForBill(bill, tenancy) {
  const today = todayStr();
  const link = '/tenancy?id=' + tenancy.id;
  const dedupKey = link + '#bill-' + bill.id;
  const label = bill.schedule_label || bill.schedule_kind || 'Bill';
  const amt = bill.amount_pkr == null ? 'amount not entered yet' : 'Rs ' + bill.amount_pkr;
  const body = label + ' for ' + bill.month + ' — ' + amt + ', due ' + bill.due_date + '.';
  if ((bill.status === 'due' || bill.status === 'overdue') && bill.due_date < today) {
    for (const uid of [tenancy.owner_id, tenancy.tenant_id]) {
      notifyOnce(uid, 'bill_overdue', 'Bill overdue', body, link, dedupKey);
    }
  } else if (bill.status === 'due') {
    const days = daysBetween(today, bill.due_date);
    if (days >= 0 && days <= 3) {
      const title = days === 0 ? 'Bill due today' : 'Bill due in ' + days + ' day' + (days === 1 ? '' : 's');
      for (const uid of [tenancy.owner_id, tenancy.tenant_id]) {
        notifyOnce(uid, 'bill_due', title, body, link, dedupKey);
      }
    }
  }
}
function monthKey(y, m) { return y * 12 + (m - 1); }
function monthStrFromKey(k) { return Math.floor(k / 12) + '-' + String((k % 12) + 1).padStart(2, '0'); }
function generateBillsForTenancy(tenancyId) {
  const tenancy = db.prepare('SELECT * FROM tenancies WHERE id = ?').get(tenancyId);
  if (!tenancy || tenancy.status !== 'active') return;
  const cur = currentMonth();
  const [curY, curM] = cur.split('-').map(Number);
  const curKey = monthKey(curY, curM);
  // Bills start in the tenancy's start month — never before it, and
  // never for a future start date (start month after this month means
  // no bills yet). They stop at the tenancy's end month, if one is set.
  let startKey = curKey;
  if (tenancy.start_date) {
    const [y, m] = tenancy.start_date.slice(0, 7).split('-').map(Number);
    if (y && m) startKey = monthKey(y, m);
  }
  let endKey = curKey;
  if (tenancy.end_date) {
    const [y, m] = tenancy.end_date.slice(0, 7).split('-').map(Number);
    if (y && m) endKey = Math.min(curKey, monthKey(y, m));
  }
  if (startKey > endKey) return;
  const schedules = db.prepare('SELECT * FROM bill_schedules WHERE tenancy_id = ? AND active = 1').all(tenancyId);
  for (const s of schedules) {
    // A schedule only bills from the month it was created: a gas
    // schedule added this month never invents bills for earlier months.
    // (Rows predating the created_at migration start at the migration
    // month, never earlier.) Rent is the exception: its schedule is
    // created at approval but the obligation starts with the tenancy,
    // so rent bills from the tenancy's start month.
    let sStart = startKey;
    if (s.kind !== 'rent' && s.created_at) {
      const [y, m] = String(s.created_at).slice(0, 7).split('-').map(Number);
      if (y && m) sStart = Math.max(startKey, monthKey(y, m));
    }
    for (let k = sStart; k <= endKey; k++) {
      const month = monthStrFromKey(k);
      // One rent bill per month per tenancy: a re-approved tenancy
      // gets a fresh rent schedule, but the month it already billed
      // under the old schedule is not billed twice.
      if (s.kind === 'rent') {
        const already = db.prepare(`SELECT b.id FROM bills b JOIN bill_schedules s2 ON s2.id = b.schedule_id
          WHERE b.tenancy_id = ? AND b.month = ? AND s2.kind = 'rent' LIMIT 1`).get(tenancyId, month);
        if (already) continue;
      }
      // Rent bills: fixed amount from the schedule, due on the due_day.
      // Variable bills: amount NULL until the owner enters it — the bill
      // shows "Amount not entered yet", never an invented figure.
      db.prepare(`INSERT OR IGNORE INTO bills(schedule_id, tenancy_id, month, amount_pkr, due_date, status)
        VALUES(?,?,?,?,?,'due')`).run(s.id, tenancyId, month, s.amount_pkr, dueDateFor(month, s.due_day));
    }
  }
  // A bill becomes overdue when today passes its due_date and it is still unpaid.
  db.prepare("UPDATE bills SET status = 'overdue' WHERE tenancy_id = ? AND status = 'due' AND due_date < ?")
    .run(tenancyId, todayStr());
  const bills = db.prepare(`SELECT b.*, s.kind AS schedule_kind, s.label AS schedule_label
    FROM bills b JOIN bill_schedules s ON s.id = b.schedule_id WHERE b.tenancy_id = ?`).all(tenancyId);
  for (const b of bills) notifyForBill(b, tenancy);
}
function generateAllBills() {
  const rows = db.prepare("SELECT id FROM tenancies WHERE status = 'active'").all();
  for (const r of rows) generateBillsForTenancy(r.id);
}
const SCHEDULE_FIELDS = new Set(['tenancy_id', 'kind', 'label', 'amount_pkr', 'due_day', 'note']);
const SCHEDULE_EDIT_FIELDS = new Set(['label', 'amount_pkr', 'due_day', 'note']);
function cleanScheduleBody(body, partial) {
  const values = {};
  const need = (k) => !partial || Object.prototype.hasOwnProperty.call(body, k);
  if (need('kind')) {
    if (!BILL_KINDS.has(String(body.kind || ''))) {
      return { error: 'kind must be rent, gas, electricity, water, internet, maintenance or other' };
    }
    values.kind = String(body.kind);
  }
  if (need('label')) {
    const v = String(body.label ?? '').trim();
    if (v.length > 100) return { error: 'label is too long (max 100 characters)' };
    values.label = v;
  }
  if (need('amount_pkr')) {
    const v = body.amount_pkr;
    if (v === null || v === undefined || v === '') { values.amount_pkr = null; }
    else if (!Number.isInteger(v) || v < 1 || v > 100000000) {
      return { error: 'amount_pkr must be a whole number of rupees above 0, or empty for a variable bill' };
    } else values.amount_pkr = v;
  }
  if (need('due_day')) {
    const v = body.due_day;
    if (!Number.isInteger(v) || v < 1 || v > 28) return { error: 'due_day must be a whole number between 1 and 28' };
    values.due_day = v;
  }
  if (need('note')) {
    const v = String(body.note ?? '').trim();
    if (v.length > 500) return { error: 'note is too long (max 500 characters)' };
    values.note = v;
  }
  return { values };
}
function requireRole(u, role, res) {
  if (!u) { sendJson(res, 401, { error: 'login required' }); return false; }
  if (u.role !== role) { sendJson(res, 403, { error: 'this is for ' + (role === 'owner' ? 'house owners' : 'rent takers') + ' only' }); return false; }
  return true;
}

// ---- Phase 5: WhatsApp-like chat helpers ----
// Ticks, honestly: sent = stored on the server; delivered = the other
// party's app fetched it (thread list, polled every 15s); read = the
// other party opened this chat (GET messages). Fetching the thread list
// marks DELIVERED only — never read. The app cannot know their phone
// received it — that is WhatsApp, not this.
function messageView(m) {
  const sender = db.prepare('SELECT display_name FROM users WHERE id = ?').get(m.sender_id) || {};
  const photo = m.photo_id ? db.prepare('SELECT filename FROM photos WHERE id = ?').get(m.photo_id) : null;
  const ticks = m.read_at ? 'read' : (m.delivered_at ? 'delivered' : 'sent');
  return {
    id: m.id, tenancy_id: m.tenancy_id, sender_id: m.sender_id,
    sender_name: sender.display_name || '',
    body: m.body || '', photo_url: photo ? '/api/photos/file/' + photo.filename : null,
    created_at: m.created_at, delivered_at: m.delivered_at || null,
    read_at: m.read_at || null, ticks,
  };
}
function notifyChatMessage(tenancy, sender) {
  const otherId = tenancy.owner_id === sender.id ? tenancy.tenant_id : tenancy.owner_id;
  // The notification never carries the message body — the other party
  // reads it only by opening the chat.
  db.prepare("INSERT INTO notifications(user_id, kind, title, body, link) VALUES(?, 'message', ?, ?, ?)")
    .run(otherId, 'New message', sender.display_name + ' sent you a message.', '/chat?id=' + tenancy.id);
}
function isChatParty(tenancy, u) {
  return !!tenancy && (tenancy.owner_id === u.id || tenancy.tenant_id === u.id);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true });
    }

    // ---- auth ----
    if (p === '/api/auth/register' && req.method === 'POST') {
      const ip = clientIp(req);
      if (!registerAllowed(ip)) return sendJson(res, 429, { error: 'too many registrations from this connection — try again later' });
      registerCounted(ip);
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body required' });
      const unknown = rejectUnknown(body, new Set(['gmail', 'password', 'display_name', 'phone', 'cnic', 'role']));
      if (unknown) return sendJson(res, 400, { error: 'unknown field: ' + unknown });
      const gmail = String(body.gmail || '').trim().toLowerCase();
      const password = String(body.password || '');
      const displayName = String(body.display_name || '').trim();
      const phone = String(body.phone || '').trim();
      const role = String(body.role || '');
      const cnic = normalizeCnic(body.cnic);
      if (!validGmail(gmail)) return sendJson(res, 400, { error: 'a valid Gmail address is required' });
      if (password.length < 8) return sendJson(res, 400, { error: 'password must be at least 8 characters' });
      if (!displayName || displayName.length > 100) return sendJson(res, 400, { error: 'display name is required (max 100 characters)' });
      if (!validPhone(phone)) return sendJson(res, 400, { error: 'phone must be a Pakistani mobile, 03XX-XXXXXXX' });
      if (role !== 'owner' && role !== 'tenant') return sendJson(res, 400, { error: 'role must be owner or tenant' });
      if (role === 'tenant' && cnic.length !== 13) return sendJson(res, 400, { error: 'CNIC is required for rent takers — 13 digits' });
      if (role === 'owner' && body.cnic !== undefined && body.cnic !== '' && body.cnic !== null && cnic.length !== 13) {
        return sendJson(res, 400, { error: 'CNIC must be 13 digits' });
      }
      const dup = db.prepare('SELECT id FROM users WHERE gmail = ?').get(gmail);
      if (dup) return sendJson(res, 409, { error: 'an account already exists for this Gmail' });
      const row = db.prepare(`INSERT INTO users(gmail, password_hash, display_name, phone, cnic, role)
        VALUES(?,?,?,?,?,?)`).run(gmail, hashPassword(password), displayName, phone, role === 'tenant' ? cnic : (cnic || ''), role);
      const user = db.prepare('SELECT id, gmail, display_name, phone, role, status, created_at FROM users WHERE id = ?').get(Number(row.lastInsertRowid));
      audit('auth.register', user, 'user', user.id, role + ' registered');
      const cookie = setSessionCookie(res, user);
      return sendJson(res, 201, { ok: true, user: publicUser(user) }, { 'Set-Cookie': cookie });
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (ipBlocked(ip)) return sendJson(res, 429, { error: 'too many failed attempts — try again later' });
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body required' });
      const unknown = rejectUnknown(body, new Set(['gmail', 'password']));
      if (unknown) return sendJson(res, 400, { error: 'unknown field: ' + unknown });
      const gmail = String(body.gmail || '').trim().toLowerCase();
      const password = String(body.password || '');
      const fail = () => { ipFail(ip); return sendJson(res, 401, { error: 'invalid Gmail or password' }); };
      const user = db.prepare('SELECT * FROM users WHERE gmail = ?').get(gmail);
      if (!user) return fail();
      const nowSec = Math.floor(Date.now() / 1000);
      if (user.status === 'suspended') return sendJson(res, 403, { error: 'account suspended' });
      if (user.locked_until && user.locked_until > nowSec) {
        return sendJson(res, 429, { error: 'account temporarily locked after too many failed attempts — try again later' });
      }
      if (!verifyPassword(password, user.password_hash)) {
        const attempts = (user.failed_attempts || 0) + 1;
        const lockedUntil = attempts >= MAX_FAILED_LOGINS ? nowSec + LOGIN_LOCK_SECONDS : 0;
        db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
          .run(attempts, lockedUntil, user.id);
        return fail();
      }
      db.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?').run(user.id);
      ipReset(ip);
      const cookie = setSessionCookie(res, user);
      return sendJson(res, 200, { ok: true, user: publicUser(user) }, { 'Set-Cookie': cookie });
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
      const cookie = clearSessionCookie(req);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
    }
    if (p === '/api/auth/me' && req.method === 'GET') {
      const u = sessionUser(req);
      if (!u) return sendJson(res, 401, { error: 'login required' });
      return sendJson(res, 200, { logged_in: true, user: publicUser(u) });
    }
    if (p === '/api/auth/change-password' && req.method === 'POST') {
      const u = sessionUser(req);
      if (!u) return sendJson(res, 401, { error: 'login required' });
      if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body required' });
      const unknown = rejectUnknown(body, new Set(['current', 'next', 'old_password', 'new_password']));
      if (unknown) return sendJson(res, 400, { error: 'unknown field: ' + unknown });
      const current = String(body.current ?? body.old_password ?? '');
      const next = String(body.next ?? body.new_password ?? '');
      if (!current || !next) return sendJson(res, 400, { error: 'current and new password required' });
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id);
      if (!row || !verifyPassword(current, row.password_hash)) {
        return sendJson(res, 401, { error: 'current password is wrong' });
      }
      if (next.length < 8) return sendJson(res, 400, { error: 'new password must be at least 8 characters' });
      if (next === current) return sendJson(res, 400, { error: 'new password must be different from the current one' });
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), u.id);
      // Like logout, suspend and master reset, a password change ends
      // every other session (a stolen session must not survive the
      // change) — and the changing browser gets a fresh session cookie
      // so it stays logged in.
      killAllSessions(u.id);
      const cookie = setSessionCookie(res, u);
      audit('auth.password-change', u, 'user', u.id, 'password changed');
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
    }

    // ---- Phase 2: house photos served (owner-scoped in Phase 2) ----
    if (p.startsWith('/api/photos/file/') && req.method === 'GET') {
      const u = sessionUser(req);
      if (!u) return sendJson(res, 401, { error: 'login required' });
      const filename = decodeURIComponent(p.slice('/api/photos/file/'.length));
      if (!/^photo-[0-9a-f]{32}\.(jpg|jpeg|png|webp)$/.test(filename)) {
        return sendJson(res, 404, { error: 'photo not found' });
      }
      const row = db.prepare('SELECT * FROM photos WHERE filename = ?').get(filename);
      if (!row) return sendJson(res, 404, { error: 'photo not found' });
      // House photos serve only to the owning owner. Proof photos (Phase 4
      // payment proofs, Phase 5 chat photos) serve only to the linked pair
      // — the owner and that tenant.
      if (row.kind === 'house') {
        const house = db.prepare('SELECT owner_id FROM houses WHERE id = ?').get(row.house_id);
        if (!house || house.owner_id !== u.id) return sendJson(res, 403, { error: 'not your photo' });
      } else if (row.kind === 'proof') {
        const tenancy = db.prepare('SELECT owner_id, tenant_id FROM tenancies WHERE id = ?').get(row.tenancy_id);
        if (!tenancy || (tenancy.owner_id !== u.id && tenancy.tenant_id !== u.id)) return sendJson(res, 403, { error: 'not your photo' });
      } else return sendJson(res, 403, { error: 'not your photo' });
      const safe = path.join(UPLOADS_DIR, path.basename(filename));
      if (!safe.startsWith(UPLOADS_DIR)) return sendJson(res, 403, { error: 'not your photo' });
      const ext = path.extname(filename).toLowerCase();
      const mime = PHOTO_EXTS[ext] ? PHOTO_MIME[PHOTO_EXTS[ext]] : 'application/octet-stream';
      fs.readFile(safe, (err, data) => {
        if (err) return sendJson(res, 404, { error: 'photo not found' });
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': mime, 'Content-Length': data.length });
        res.end(data);
      });
      return;
    }

    // ---- owner houses ----
    if (p === '/api/owner/houses' && req.method === 'GET') {
      const u = sessionUser(req);
      if (!requireRole(u, 'owner', res)) return;
      const rows = db.prepare('SELECT * FROM houses WHERE owner_id = ? ORDER BY created_at DESC, id DESC').all(u.id);
      return sendJson(res, 200, { houses: rows.map(houseView) });
    }
    if (p === '/api/owner/houses' && req.method === 'POST') {
      const u = sessionUser(req);
      if (!requireRole(u, 'owner', res)) return;
      if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body required' });
      const unknown = rejectUnknown(body, HOUSE_FIELDS);
      if (unknown) return sendJson(res, 400, { error: 'unknown field: ' + unknown });
      const { error, values } = cleanHouseBody(body, false);
      if (error) return sendJson(res, 400, { error });
      const info = db.prepare(`INSERT INTO houses(owner_id, title, kind, address, city, area, bedrooms, bathrooms,
        rent_pkr, advance_pkr, security_deposit_pkr, bills_included, maps_url, plus_code, available_from)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(u.id, values.title, values.kind, values.address,
        values.city || '', values.area || '', values.bedrooms ?? null, values.bathrooms ?? null,
        values.rent_pkr, values.advance_pkr ?? 0, values.security_deposit_pkr ?? 0,
        values.bills_included || '[]', values.maps_url || '', values.plus_code || '', values.available_from || '');
      const houseId = Number(info.lastInsertRowid);
      const code = newHouseCode();
      db.prepare('INSERT INTO house_codes(house_id, code, active) VALUES(?,?,1)').run(houseId, code);
      const house = db.prepare('SELECT * FROM houses WHERE id = ?').get(houseId);
      audit('house.created', u, 'house', houseId, values.title + ' (' + values.kind + '), rent ' + values.rent_pkr);
      return sendJson(res, 201, { ok: true, house: houseView(house), code, share_text: shareTextFor(code) });
    }
    const houseMatch = p.match(/^\/api\/owner\/houses\/(\d+)(\/photos|\/hide|\/code|\/code\/regenerate)?$/);
    if (houseMatch) {
      const houseId = Number(houseMatch[1]);
      const sub = houseMatch[2] || '';
      const u = sessionUser(req);
      if (!requireRole(u, 'owner', res)) return;
      const house = db.prepare('SELECT * FROM houses WHERE id = ?').get(houseId);
      if (!house) return sendJson(res, 404, { error: 'house not found' });
      if (house.owner_id !== u.id) return sendJson(res, 403, { error: 'not your house' });
      // PUT /api/owner/houses/:id
      if (!sub && req.method === 'PUT') {
        if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
        const body = await readBody(req);
        if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body required' });
        const unknown = rejectUnknown(body, HOUSE_FIELDS);
        if (unknown) return sendJson(res, 400, { error: 'unknown field: ' + unknown });
        if (Object.keys(body).length === 0) return sendJson(res, 400, { error: 'nothing to update' });
        const { error, values } = cleanHouseBody(body, true);
        if (error) return sendJson(res, 400, { error });
        const sets = [];
        const args = [];
        for (const [k, v] of Object.entries(values)) { sets.push(k + ' = ?'); args.push(v); }
        if (!sets.length) return sendJson(res, 400, { error: 'nothing to update' });
        db.prepare('UPDATE houses SET ' + sets.join(', ') + ' WHERE id = ?').run(...args, houseId);
        audit('house.updated', u, 'house', houseId, 'house ' + houseId + ' updated');
        return sendJson(res, 200, { ok: true, house: houseView(db.prepare('SELECT * FROM houses WHERE id = ?').get(houseId)) });
      }
      // POST /api/owner/houses/:id/hide
      if (sub === '/hide' && req.method === 'POST') {
        if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
        db.prepare("UPDATE houses SET status = 'hidden' WHERE id = ?").run(houseId);
        audit('house.hidden', u, 'house', houseId, 'house ' + houseId + ' hidden');
        return sendJson(res, 200, { ok: true, house: houseView(db.prepare('SELECT * FROM houses WHERE id = ?').get(houseId)) });
      }
      // GET /api/owner/houses/:id/code
      if (sub === '/code' && req.method === 'GET') {
        const row = db.prepare('SELECT * FROM house_codes WHERE house_id = ? ORDER BY id DESC LIMIT 1').get(houseId);
        if (!row) return sendJson(res, 404, { error: 'no code for this house' });
        return sendJson(res, 200, { house_id: houseId, code: row.code, active: row.active === 1, share_text: shareTextFor(row.code) });
      }
      // POST /api/owner/houses/:id/code/regenerate
      if (sub === '/code/regenerate' && req.method === 'POST') {
        if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
        db.prepare('UPDATE house_codes SET active = 0 WHERE house_id = ?').run(houseId);
        const code = newHouseCode();
        db.prepare('INSERT INTO house_codes(house_id, code, active) VALUES(?,?,1)').run(houseId, code);
        audit('house.code-regenerated', u, 'house', houseId, 'link code regenerated for house ' + houseId);
        return sendJson(res, 200, { ok: true, house_id: houseId, code, active: true, share_text: shareTextFor(code) });
      }
      // POST /api/owner/houses/:id/photos (multipart)
      if (sub === '/photos' && req.method === 'POST') {
        if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
        if (!uploadAllowed(u.id)) return sendJson(res, 429, { error: 'too many uploads — try again later' });
        let parsed;
        try {
          parsed = await parseMultipartBody(req, PHOTO_MAX_BYTES + 65536);
        } catch (e) {
          return sendJson(res, e.message === 'upload too large' ? 413 : 400,
            { error: e.message === 'upload too large' ? 'photo is too large — max 5MB' : 'upload must be multipart/form-data with a photo file' });
        }
        const file = parsed.files.find((f) => f.name === 'photo');
        if (!file) return sendJson(res, 400, { error: 'photo file required (field name "photo")' });
        if (file.data.length > PHOTO_MAX_BYTES) return sendJson(res, 413, { error: 'photo is too large — max 5MB' });
        const kind = detectImageKind(file.data);
        if (!kind) return sendJson(res, 400, { error: 'photo must be a JPG, PNG or WebP image' });
        const ext = path.extname(file.filename || '').toLowerCase();
        if (!PHOTO_EXTS[ext] || PHOTO_EXTS[ext] !== kind) return sendJson(res, 400, { error: 'photo file extension must match its contents (JPG, PNG or WebP)' });
        const count = db.prepare("SELECT COUNT(*) c FROM photos WHERE house_id = ? AND kind = 'house'").get(houseId).c;
        if (count >= PHOTO_MAX_PER_HOUSE) return sendJson(res, 400, { error: 'this house already has the maximum 8 photos' });
        const stored = 'photo-' + crypto.randomBytes(16).toString('hex') + ext;
        try { fs.writeFileSync(path.join(UPLOADS_DIR, stored), file.data); }
        catch { return sendJson(res, 500, { error: 'could not store the photo on this server' }); }
        const info = db.prepare("INSERT INTO photos(uploader_id, house_id, kind, filename) VALUES(?,?, 'house', ?)").run(u.id, houseId, stored);
        audit('house.photo-added', u, 'house', houseId, 'photo added to house ' + houseId);
        return sendJson(res, 201, { ok: true, id: Number(info.lastInsertRowid), file_url: '/api/photos/file/' + stored });
      }
      return sendJson(res, 404, { error: 'not found' });
    }

    // ---- owner link requests ----
    if (p === '/api/owner/link-requests' && req.method === 'GET') {
      const u = sessionUser(req);
      if (!requireRole(u, 'owner', res)) return;
      const rows = db.prepare(`SELECT t.*, h.title AS house_title, h.rent_pkr AS house_rent,
          tu.display_name AS tenant_name, tu.phone AS tenant_phone, tu.cnic AS tenant_cnic
        FROM tenancies t JOIN houses h ON h.id = t.house_id
        JOIN users tu ON tu.id = t.tenant_id
        WHERE t.owner_id = ? AND t.status = 'requested'
        ORDER BY t.created_at DESC, t.id DESC`).all(u.id);
      return sendJson(res, 200, { requests: rows.map((r) => ({
        tenancy_id: r.id, house_id: r.house_id, house_title: r.house_title, house_rent_pkr: r.house_rent,
        tenant: { id: r.tenant_id, display_name: r.tenant_name, phone: r.tenant_phone, cnic_last4: cnicLast4(r.tenant_cnic) },
        rent_pkr: r.rent_pkr, created_at: r.created_at,
      })) });
    }
    if (p === '/api/owner/link-requests/decide' && req.method === 'POST') {
      const u = sessionUser(req);
      if (!requireRole(u, 'owner', res)) return;
      if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body required' });
      const unknown = rejectUnknown(body, new Set(['tenancy_id', 'decision', 'reason', 'rent_pkr', 'due_day',
        'start_date', 'end_date', 'agreement_registered', 'police_registered', 'agreement_note', 'advance_pkr']));
      if (unknown) return sendJson(res, 400, { error: 'unknown field: ' + unknown });
      const tenancy = db.prepare('SELECT * FROM tenancies WHERE id = ?').get(Number(body.tenancy_id));
      if (!tenancy) return sendJson(res, 404, { error: 'link request not found' });
      if (tenancy.owner_id !== u.id) return sendJson(res, 403, { error: 'not your link request' });
      if (tenancy.status !== 'requested') return sendJson(res, 400, { error: 'this request was already decided' });
      const decision = String(body.decision || '');
      if (decision !== 'approve' && decision !== 'reject') return sendJson(res, 400, { error: 'decision must be approve or reject' });
      const reason = String(body.reason ?? '').trim();
      if (reason.length > 500) return sendJson(res, 400, { error: 'reason is too long (max 500 characters)' });
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      if (decision === 'reject') {
        if (!reason) return sendJson(res, 400, { error: 'a reason is required to reject a link request' });
        db.prepare('UPDATE tenancies SET status = ?, decided_by = ?, decided_at = ?, decide_reason = ? WHERE id = ?')
          .run('rejected', u.id, now, reason, tenancy.id);
        audit('link.rejected', u, 'tenancy', tenancy.id, 'link request rejected: ' + reason);
        db.prepare("INSERT INTO notifications(user_id, kind, title, body, link) VALUES(?, 'link_rejected', ?, ?, ?)")
          .run(tenancy.tenant_id, 'Link request declined', reason, '/tenant');
        return sendJson(res, 200, { ok: true, tenancy: ownerTenancyView(db.prepare('SELECT * FROM tenancies WHERE id = ?').get(tenancy.id)) });
      }
      // approve
      const rent = body.rent_pkr;
      if (!Number.isInteger(rent) || rent < 1 || rent > 100000000) return sendJson(res, 400, { error: 'rent_pkr must be a whole number of rupees above 0' });
      const dueDay = body.due_day;
      if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 28) return sendJson(res, 400, { error: 'due_day must be a whole number between 1 and 28' });
      const startDate = String(body.start_date || '').trim();
      if (!validDateStr(startDate)) return sendJson(res, 400, { error: 'start_date must be a YYYY-MM-DD date' });
      const endDate = String(body.end_date || '').trim();
      if (endDate && !validDateStr(endDate)) return sendJson(res, 400, { error: 'end_date must be a YYYY-MM-DD date' });
      if (endDate && endDate < startDate) return sendJson(res, 400, { error: 'end_date must be on or after start_date' });
      const advance = body.advance_pkr;
      if (advance !== undefined && advance !== null && (!Number.isInteger(advance) || advance < 0 || advance > 100000000)) {
        return sendJson(res, 400, { error: 'advance_pkr must be a whole number of rupees of 0 or more' });
      }
      const agreementNote = String(body.agreement_note ?? '').trim();
      if (agreementNote.length > 500) return sendJson(res, 400, { error: 'agreement_note is too long (max 500 characters)' });
      const agreementRegistered = body.agreement_registered ? 1 : 0;
      const policeRegistered = body.police_registered ? 1 : 0;
      const house = db.prepare('SELECT * FROM houses WHERE id = ?').get(tenancy.house_id);
      if (!house || house.status !== 'vacant') return sendJson(res, 400, { error: 'this house is no longer vacant' });
      // One active tenancy per tenant: the link step checks this, but a
      // tenant can hold two PENDING requests — approving the second
      // while the first is already active must fail too.
      const otherActive = db.prepare("SELECT id FROM tenancies WHERE tenant_id = ? AND status = 'active' AND id != ?").get(tenancy.tenant_id, tenancy.id);
      if (otherActive) return sendJson(res, 409, { error: 'this tenant already has an active tenancy — one at a time' });
      db.prepare(`UPDATE tenancies SET status = 'active', rent_pkr = ?, advance_pkr = ?, due_day = ?,
        start_date = ?, end_date = ?, agreement_note = ?, agreement_registered = ?, police_registered = ?,
        decided_by = ?, decided_at = ?, decide_reason = ? WHERE id = ?`)
        .run(rent, advance ?? tenancy.advance_pkr, dueDay, startDate, endDate, agreementNote,
          agreementRegistered, policeRegistered, u.id, now, reason, tenancy.id);
      // A re-approved tenancy (ended, then linked again) reuses its row:
      // the old rent schedule is retired first, so the tenancy never
      // bills rent twice in one month. Other schedules (gas, etc.) stay
      // as they were.
      db.prepare("UPDATE bill_schedules SET active = 0 WHERE tenancy_id = ? AND kind = 'rent'").run(tenancy.id);
      db.prepare(`INSERT INTO bill_schedules(tenancy_id, kind, label, amount_pkr, due_day, active, note, created_by)
        VALUES(?, 'rent', 'Monthly rent', ?, ?, 1, '', ?)`).run(tenancy.id, rent, dueDay, u.id);
      db.prepare("UPDATE houses SET status = 'occupied' WHERE id = ?").run(house.id);
      // Bills for the current month exist from approval onward, even if
      // nobody opens the tenancy again before it ends.
      generateBillsForTenancy(tenancy.id);
      audit('link.approved', u, 'tenancy', tenancy.id, 'link approved: rent ' + rent + ', due day ' + dueDay + ', from ' + startDate);
      db.prepare("INSERT INTO notifications(user_id, kind, title, body, link) VALUES(?, 'link_approved', ?, ?, ?)")
        .run(tenancy.tenant_id, 'Link request approved', 'Your tenancy is active.', '/tenant');
      return sendJson(res, 200, { ok: true, tenancy: ownerTenancyDetail(db.prepare('SELECT * FROM tenancies WHERE id = ?').get(tenancy.id)) });
    }

    // ---- owner tenancies ----
    if (p === '/api/owner/tenancies' && req.method === 'GET') {
      const u = sessionUser(req);
      if (!requireRole(u, 'owner', res)) return;
      const rows = db.prepare('SELECT * FROM tenancies WHERE owner_id = ? ORDER BY created_at DESC, id DESC').all(u.id);
      for (const t of rows) generateBillsForTenancy(t.id);
      return sendJson(res, 200, { tenancies: rows.map(ownerTenancyView) });
    }
    const ownerTenancyMatch = p.match(/^\/api\/owner\/tenancies\/(\d+)(\/end)?$/);
    if (ownerTenancyMatch) {
      const tenancyId = Number(ownerTenancyMatch[1]);
      const u = sessionUser(req);
      if (!requireRole(u, 'owner', res)) return;
      const tenancy = db.prepare('SELECT * FROM tenancies WHERE id = ?').get(tenancyId);
      if (!tenancy) return sendJson(res, 404, { error: 'tenancy not found' });
      if (tenancy.owner_id !== u.id) return sendJson(res, 403, { error: 'not your tenancy' });
      if (ownerTenancyMatch[2] === '/end' && req.method === 'POST') {
        if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
        const body = await readBody(req);
        if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body required' });
        const unknown = rejectUnknown(body, new Set(['reason']));
        if (unknown) return sendJson(res, 400, { error: 'unknown field: ' + unknown });
        const reason = String(body.reason ?? '').trim();
        if (reason.length > 500) return sendJson(res, 400, { error: 'reason is too long (max 500 characters)' });
        if (tenancy.status !== 'active') return sendJson(res, 400, { error: 'only an active tenancy can be ended' });
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        db.prepare('UPDATE tenancies SET status = ?, decided_by = ?, decided_at = ?, decide_reason = ? WHERE id = ?')
          .run('ended', u.id, now, reason, tenancy.id);
        db.prepare("UPDATE houses SET status = 'vacant' WHERE id = ?").run(tenancy.house_id);
        // The code stays on file, but no new link works until the owner
        // re-activates it (regenerate a code for the house).
        db.prepare('UPDATE house_codes SET active = 0 WHERE house_id = ?').run(tenancy.house_id);
        audit('tenancy.ended', u, 'tenancy', tenancy.id, 'tenancy ended' + (reason ? ': ' + reason : ''));
        db.prepare("INSERT INTO notifications(user_id, kind, title, body, link) VALUES(?, 'tenancy_ended', ?, ?, ?)")
          .run(tenancy.tenant_id, 'Tenancy ended', reason || 'Your tenancy has ended.', '/tenant');
        return sendJson(res, 200, { ok: true, tenancy: ownerTenancyDetail(db.prepare('SELECT * FROM tenancies WHERE id = ?').get(tenancy.id)) });
      }
      if (!ownerTenancyMatch[2] && req.method === 'GET') {
        generateBillsForTenancy(tenancy.id);
        return sendJson(res, 200, { tenancy: ownerTenancyDetail(db.prepare('SELECT * FROM tenancies WHERE id = ?').get(tenancyId)) });
      }
      return sendJson(res, 404, { error: 'not found' });
    }

    // ---- Phase 3: owner-kept schedules ----
    if (p === '/api/owner/schedules' && req.method === 'POST') {
      const u = sessionUser(req);
      if (!requireRole(u, 'owner', res)) return;
      if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body required' });
      const unknown = rejectUnknown(body, SCHEDULE_FIELDS);
      if (unknown) return sendJson(res, 400, { error: 'unknown field: ' + unknown });
      const tenancy = db.prepare('SELECT * FROM tenancies WHERE id = ?').get(Number(body.tenancy_id));
      if (!tenancy) return sendJson(res, 404, { error: 'tenancy not found' });
      if (tenancy.owner_id !== u.id) return sendJson(res, 403, { error: 'not your tenancy' });
      if (tenancy.status !== 'active') return sendJson(res, 400, { error: 'schedules can only be kept on an active tenancy' });
      const { error, values } = cleanScheduleBody(body, false);
      if (error) return sendJson(res, 400, { error });
      if (values.due_day === undefined) return sendJson(res, 400, { error: 'due_day must be a whole number between 1 and 28' });
      if (values.kind === undefined) return sendJson(res, 400, { error: 'kind must be rent, gas, electricity, water, internet, maintenance or other' });
      // Rent already has exactly one schedule, created at approval — a
      // second one would bill rent twice in the same month.
      if (values.kind === 'rent') {
        const existingRent = db.prepare("SELECT id FROM bill_schedules WHERE tenancy_id = ? AND kind = 'rent' AND active = 1").get(tenancy.id);
        if (existingRent) return sendJson(res, 400, { error: 'this tenancy already has a rent schedule — rent is set when the owner approves the link' });
      }
      const info = db.prepare(`INSERT INTO bill_schedules(tenancy_id, kind, label, amount_pkr, due_day, active, note, created_by)
        VALUES(?,?,?,?,?,1,?,?)`).run(tenancy.id, values.kind, values.label || '', values.amount_pkr ?? null,
        values.due_day, values.note || '', u.id);
      const schedule = db.prepare('SELECT id, kind, label, amount_pkr, due_day, active, note FROM bill_schedules WHERE id = ?')
        .get(Number(info.lastInsertRowid));
      audit('schedule.created', u, 'schedule', schedule.id,
        values.kind + ' schedule for tenancy ' + tenancy.id + ' (due day ' + values.due_day + ')');
      return sendJson(res, 201, { ok: true, schedule });
    }
    const scheduleMatch = p.match(/^\/api\/owner\/schedules\/(\d+)(\/deactivate)?$/);
    if (scheduleMatch) {
      const scheduleId = Number(scheduleMatch[1]);
      const u = sessionUser(req);
      if (!requireRole(u, 'owner', res)) return;
      if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
      const schedule = db.prepare('SELECT * FROM bill_schedules WHERE id = ?').get(scheduleId);
      if (!schedule) return sendJson(res, 404, { error: 'schedule not found' });
      const tenancy = db.prepare('SELECT * FROM tenancies WHERE id = ?').get(schedule.tenancy_id);
      if (!tenancy || tenancy.owner_id !== u.id) return sendJson(res, 403, { error: 'not your schedule' });
      // POST /api/owner/schedules/:id/deactivate — deactivated schedules
      // generate no new bills (bills already generated stay on record).
      if (scheduleMatch[2] === '/deactivate' && req.method === 'POST') {
        if (schedule.active === 1) {
          db.prepare('UPDATE bill_schedules SET active = 0 WHERE id = ?').run(scheduleId);
          audit('schedule.deactivated', u, 'schedule', scheduleId, 'schedule ' + scheduleId + ' deactivated');
        }
        const row = db.prepare('SELECT id, kind, label, amount_pkr, due_day, active, note FROM bill_schedules WHERE id = ?').get(scheduleId);
        return sendJson(res, 200, { ok: true, schedule: row });
      }
      // PUT /api/owner/schedules/:id — edit label/amount/due_day/note.
      if (!scheduleMatch[2] && req.method === 'PUT') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body required' });
        const unknown = rejectUnknown(body, SCHEDULE_EDIT_FIELDS);
        if (unknown) return sendJson(res, 400, { error: 'unknown field: ' + unknown });
        if (Object.keys(body).length === 0) return sendJson(res, 400, { error: 'nothing to update' });
        const { error, values } = cleanScheduleBody(body, true);
        if (error) return sendJson(res, 400, { error });
        if (schedule.kind === 'rent' && Object.prototype.hasOwnProperty.call(values, 'amount_pkr') && values.amount_pkr === null) {
          return sendJson(res, 400, { error: 'rent must have a fixed amount — only utility bills can be variable' });
        }
        const sets = [];
        const args = [];
        for (const [k, v] of Object.entries(values)) { sets.push(k + ' = ?'); args.push(v); }
        if (!sets.length) return sendJson(res, 400, { error: 'nothing to update' });
        db.prepare('UPDATE bill_schedules SET ' + sets.join(', ') + ' WHERE id = ?').run(...args, scheduleId);
        // The rent schedule IS the tenancy's rent: editing its amount
        // or due day must move the tenancy's own rent/due day too, or
        // the tenancy page and the bills would disagree.
        if (schedule.kind === 'rent') {
          const tSets = [];
          const tArgs = [];
          if (values.amount_pkr !== undefined && values.amount_pkr !== null) { tSets.push('rent_pkr = ?'); tArgs.push(values.amount_pkr); }
          if (values.due_day !== undefined) { tSets.push('due_day = ?'); tArgs.push(values.due_day); }
          if (tSets.length) db.prepare('UPDATE tenancies SET ' + tSets.join(', ') + ' WHERE id = ?').run(...tArgs, schedule.tenancy_id);
        }
        audit('schedule.updated', u, 'schedule', scheduleId, 'schedule ' + scheduleId + ' updated');
        const row = db.prepare('SELECT id, kind, label, amount_pkr, due_day, active, note FROM bill_schedules WHERE id = ?').get(scheduleId);
        return sendJson(res, 200, { ok: true, schedule: row });
      }
      return sendJson(res, 404, { error: 'not found' });
    }

    // ---- Phase 3: variable-amount entry on a bill ----
    const billAmountMatch = p.match(/^\/api\/owner\/bills\/(\d+)\/amount$/);
    if (billAmountMatch && req.method === 'POST') {
      const billId = Number(billAmountMatch[1]);
      const u = sessionUser(req);
      if (!requireRole(u, 'owner', res)) return;
      if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body required' });
      const unknown = rejectUnknown(body, new Set(['amount_pkr']));
      if (unknown) return sendJson(res, 400, { error: 'unknown field: ' + unknown });
      const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
      if (!bill) return sendJson(res, 404, { error: 'bill not found' });
      const tenancy = db.prepare('SELECT * FROM tenancies WHERE id = ?').get(bill.tenancy_id);
      if (!tenancy || tenancy.owner_id !== u.id) return sendJson(res, 403, { error: 'not your bill' });
      if (bill.amount_pkr !== null && bill.amount_pkr !== undefined) {
        return sendJson(res, 400, { error: 'this bill already has an amount — only a variable bill (amount not entered yet) can take one' });
      }
      const amount = body.amount_pkr;
      if (!Number.isInteger(amount) || amount < 1 || amount > 100000000) {
        return sendJson(res, 400, { error: 'amount_pkr must be a whole number of rupees above 0' });
      }
      db.prepare('UPDATE bills SET amount_pkr = ? WHERE id = ?').run(amount, billId);
      audit('bill.amount', u, 'bill', billId, 'amount Rs ' + amount + ' entered for bill ' + billId);
      const row = db.prepare(`SELECT b.*, s.kind AS schedule_kind, s.label AS schedule_label
        FROM bills b JOIN bill_schedules s ON s.id = b.schedule_id WHERE b.id = ?`).get(billId);
      const tenant = db.prepare('SELECT phone FROM users WHERE id = ?').get(tenancy.tenant_id) || {};
      return sendJson(res, 200, { ok: true, bill: enrichBill(row, tenant.phone || '', 'Your') });
    }

    // ---- Phase 4: owner payment decision (approve / reject with reason) ----
    if (p === '/api/owner/payments/decide' && req.method === 'POST') {
      const u = sessionUser(req);
      if (!requireRole(u, 'owner', res)) return;
      if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body required' });
      const unknown = rejectUnknown(body, new Set(['payment_id', 'decision', 'reason']));
      if (unknown) return sendJson(res, 400, { error: 'unknown field: ' + unknown });
      const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(body.payment_id));
      if (!payment) return sendJson(res, 404, { error: 'payment not found' });
      const tenancy = db.prepare('SELECT * FROM tenancies WHERE id = ?').get(payment.tenancy_id);
      if (!tenancy || tenancy.owner_id !== u.id) return sendJson(res, 403, { error: 'not your payment' });
      const decision = String(body.decision || '');
      if (decision !== 'approve' && decision !== 'reject') return sendJson(res, 400, { error: 'decision must be approve or reject' });
      const reason = String(body.reason ?? '').trim();
      if (reason.length > 500) return sendJson(res, 400, { error: 'reason is too long (max 500 characters)' });
      if (payment.status !== 'pending') return sendJson(res, 400, { error: 'this payment was already decided' });
      const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(payment.bill_id);
      if (!bill) return sendJson(res, 404, { error: 'bill not found' });
      if (bill.status === 'paid') return sendJson(res, 400, { error: 'this bill is already paid — no double payment' });
      if (decision === 'reject' && !reason) return sendJson(res, 400, { error: 'a reason is required to reject a payment' });
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const link = '/tenancy?id=' + tenancy.id;
      if (decision === 'approve') {
        db.prepare('UPDATE payments SET status = ?, decided_by = ?, decided_at = ?, decide_reason = ? WHERE id = ?')
          .run('approved', u.id, now, reason, payment.id);
        db.prepare("UPDATE bills SET status = 'paid' WHERE id = ?").run(bill.id);
        audit('payment.approved', u, 'payment', payment.id, 'payment approved: Rs ' + payment.amount_pkr + ' (' + payment.method + ') for bill ' + bill.id);
        db.prepare("INSERT INTO notifications(user_id, kind, title, body, link) VALUES(?, 'payment_approved', ?, ?, ?)")
          .run(tenancy.tenant_id, 'Payment approved', 'Your Rs ' + payment.amount_pkr + ' payment was approved. Receipt ' + receiptView(db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id)).receipt_number + '.', link);
        const payRow = db.prepare(PAYMENT_SELECT + ' WHERE p.id = ?').get(payment.id);
        const view = paymentView(payRow);
        return sendJson(res, 200, { ok: true, payment: view, receipt: view.receipt, bill: enrichBill(db.prepare(`SELECT b.*, s.kind AS schedule_kind, s.label AS schedule_label FROM bills b JOIN bill_schedules s ON s.id = b.schedule_id WHERE b.id = ?`).get(bill.id), '', 'Your') });
      }
      // reject: the payment is rejected with the reason; the bill stays
      // due (or overdue if its date passed) so the tenant can re-upload
      // a correction — unless a newer pending proof already exists.
      db.prepare('UPDATE payments SET status = ?, decided_by = ?, decided_at = ?, decide_reason = ? WHERE id = ?')
        .run('rejected', u.id, now, reason, payment.id);
      const stillPending = db.prepare("SELECT COUNT(*) c FROM payments WHERE bill_id = ? AND status = 'pending' AND id != ?").get(bill.id, payment.id).c;
      if (!stillPending) {
        const backTo = bill.due_date < todayStr() ? 'overdue' : 'due';
        db.prepare('UPDATE bills SET status = ? WHERE id = ?').run(backTo, bill.id);
      }
      audit('payment.rejected', u, 'payment', payment.id, 'payment rejected: ' + reason);
      db.prepare("INSERT INTO notifications(user_id, kind, title, body, link) VALUES(?, 'payment_rejected', ?, ?, ?)")
        .run(tenancy.tenant_id, 'Payment rejected', reason, link);
      const payRow = db.prepare(PAYMENT_SELECT + ' WHERE p.id = ?').get(payment.id);
      return sendJson(res, 200, { ok: true, payment: paymentView(payRow), bill: enrichBill(db.prepare(`SELECT b.*, s.kind AS schedule_kind, s.label AS schedule_label FROM bills b JOIN bill_schedules s ON s.id = b.schedule_id WHERE b.id = ?`).get(bill.id), '', 'Your') });
    }

    // ---- Phase 4: owner pending payment approvals, newest first ----
    if (p === '/api/owner/payments/pending' && req.method === 'GET') {
      const u = sessionUser(req);
      if (!requireRole(u, 'owner', res)) return;
      const rows = db.prepare(`SELECT p.*, b.month AS bill_month, b.amount_pkr AS bill_amount_pkr, s.kind AS schedule_kind, s.label AS schedule_label,
          h.title AS house_title, tu.display_name AS tenant_name
        FROM payments p JOIN bills b ON b.id = p.bill_id
        JOIN bill_schedules s ON s.id = b.schedule_id
        JOIN tenancies t ON t.id = p.tenancy_id
        JOIN houses h ON h.id = t.house_id
        JOIN users tu ON tu.id = p.payer_id
        WHERE t.owner_id = ? AND p.status = 'pending'
        ORDER BY p.created_at DESC, p.id DESC`).all(u.id);
      return sendJson(res, 200, { payments: rows.map((r) => {
        const v = paymentView(r);
        v.tenant_name = r.tenant_name; v.house_title = r.house_title;
        v.bill_amount_pkr = r.bill_amount_pkr;
        return v;
      }) });
    }

    // ---- Phase 4: owner ledger CSV (only their own tenancies) ----
    if (p === '/api/owner/ledger.csv' && req.method === 'GET') {
      const u = sessionUser(req);
      if (!requireRole(u, 'owner', res)) return;
      return sendCsv(res, 'kiraya-ledger.csv', ledgerCsv(ledgerRows('t.owner_id = ?', [u.id])));
    }

    // ---- Phase 3: notifications (in-app only — no WhatsApp API, no SMS, no push) ----
    if (p === '/api/notifications' && req.method === 'GET') {
      const u = sessionUser(req);
      if (!u) return sendJson(res, 401, { error: 'login required' });
      const rows = db.prepare(`SELECT id, kind, title, body, link, is_read, created_at
        FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC`).all(u.id);
      const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 0').get(u.id).c;
      return sendJson(res, 200, { notifications: rows, unread_count: unread });
    }
    if (p === '/api/notifications/read-all' && req.method === 'POST') {
      const u = sessionUser(req);
      if (!u) return sendJson(res, 401, { error: 'login required' });
      if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
      const info = db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(u.id);
      return sendJson(res, 200, { ok: true, read: info.changes, unread_count: 0 });
    }
    const notifMatch = p.match(/^\/api\/notifications\/(\d+)\/read$/);
    if (notifMatch && req.method === 'POST') {
      const notifId = Number(notifMatch[1]);
      const u = sessionUser(req);
      if (!u) return sendJson(res, 401, { error: 'login required' });
      if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
      const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(notifId);
      if (!row) return sendJson(res, 404, { error: 'notification not found' });
      if (row.user_id !== u.id) return sendJson(res, 403, { error: 'not your notification' });
      db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(notifId);
      const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 0').get(u.id).c;
      return sendJson(res, 200, { ok: true, unread_count: unread });
    }

    // ---- tenant link + tenancy ----
    if (p === '/api/tenant/link' && req.method === 'POST') {
      const u = sessionUser(req);
      if (!requireRole(u, 'tenant', res)) return;
      if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
      const ip = clientIp(req);
      const ipCount = linkAttemptCounted('ip:' + ip);
      const acctCount = linkAttemptCounted('user:' + u.id);
      if (ipCount > 5 || acctCount > 5) return sendJson(res, 429, { error: 'too many code attempts — try again later' });
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body required' });
      const unknown = rejectUnknown(body, new Set(['code']));
      if (unknown) return sendJson(res, 400, { error: 'unknown field: ' + unknown });
      const generic = () => sendJson(res, 400, { error: 'code not recognised' });
      const code = String(body.code || '').trim().toUpperCase();
      if (!code) return generic();
      const active = db.prepare("SELECT * FROM tenancies WHERE tenant_id = ? AND status = 'active'").get(u.id);
      if (active) return sendJson(res, 409, { error: 'you already have an active tenancy — one at a time' });
      const codeRow = db.prepare('SELECT * FROM house_codes WHERE code = ? AND active = 1').get(code);
      if (!codeRow) return generic();
      const house = db.prepare('SELECT * FROM houses WHERE id = ?').get(codeRow.house_id);
      if (!house || house.status === 'hidden' || house.status === 'occupied') return generic();
      const existing = db.prepare('SELECT * FROM tenancies WHERE house_id = ? AND tenant_id = ?').get(house.id, u.id);
      if (existing && existing.status === 'requested') {
        return sendJson(res, 409, { error: 'you already have a pending request for this house' });
      }
      if (existing && existing.status === 'active') {
        return sendJson(res, 409, { error: 'you already have an active tenancy — one at a time' });
      }
      let tenancyId;
      if (existing) {
        // A rejected or ended tenancy for this house: the request starts over.
        db.prepare(`UPDATE tenancies SET status = 'requested', rent_pkr = ?, advance_pkr = ?, due_day = 1,
          start_date = '', end_date = '', agreement_note = '', agreement_registered = 0, police_registered = 0,
          decided_by = NULL, decided_at = NULL, decide_reason = '' WHERE id = ?`)
          .run(house.rent_pkr, house.advance_pkr, existing.id);
        tenancyId = existing.id;
      } else {
        const info = db.prepare(`INSERT INTO tenancies(house_id, owner_id, tenant_id, status, rent_pkr, advance_pkr, due_day, start_date)
          VALUES(?, ?, ?, 'requested', ?, ?, 1, '')`).run(house.id, house.owner_id, u.id, house.rent_pkr, house.advance_pkr);
        tenancyId = Number(info.lastInsertRowid);
      }
      // A successful link proves the tenant had the code — the guessing
      // budget resets, so one real link never eats the next hour's tries.
      linkAttempts.delete('user:' + u.id);
      audit('link.requested', u, 'tenancy', tenancyId, 'link requested for house ' + house.id);
      db.prepare("INSERT INTO notifications(user_id, kind, title, body, link) VALUES(?, 'link_request', ?, ?, ?)")
        .run(house.owner_id, 'New link request', u.display_name + ' asked to link to a house.', '/owner');
      return sendJson(res, 201, { ok: true, tenancy: { id: tenancyId, house_id: house.id, status: 'requested' }, message: 'Request sent — your owner will approve it.' });
    }
    if (p === '/api/tenant/tenancy' && req.method === 'GET') {
      const u = sessionUser(req);
      if (!requireRole(u, 'tenant', res)) return;
      const t = db.prepare(`SELECT * FROM tenancies WHERE tenant_id = ? AND status IN ('active','requested')
        ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT 1`).get(u.id);
      if (!t) return sendJson(res, 200, { tenancy: null, message: 'Enter your house code to link with your owner.' });
      generateBillsForTenancy(t.id);
      return sendJson(res, 200, { tenancy: tenantTenancyView(db.prepare('SELECT * FROM tenancies WHERE id = ?').get(t.id)) });
    }
    // ---- Phase 3: tenant bills — only the caller's own tenancy, with statuses ----
    if (p === '/api/tenant/bills' && req.method === 'GET') {
      const u = sessionUser(req);
      if (!requireRole(u, 'tenant', res)) return;
      const t = db.prepare(`SELECT * FROM tenancies WHERE tenant_id = ? AND status IN ('active','requested')
        ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT 1`).get(u.id);
      if (!t) return sendJson(res, 200, { tenancy_id: null, bills: [] });
      generateBillsForTenancy(t.id);
      const owner = db.prepare('SELECT display_name, phone FROM users WHERE id = ?').get(t.owner_id) || {};
      const bills = tenancyBills(t.id).map((b) => enrichBill(b, owner.phone || '', 'My'));
      return sendJson(res, 200, {
        tenancy_id: t.id, house_id: t.house_id,
        owner: { display_name: owner.display_name || '', phone: owner.phone || '' },
        bills,
      });
    }
    // ---- Phase 4: tenant history — ended tenancies stay readable ----
    // /api/tenant/tenancy + /api/tenant/bills cover the current tenancy
    // only, so after a tenancy ended the tenant lost its bills and
    // payments (only receipts stayed). History returns ended tenancies
    // with their full record, scoped to the caller.
    if (p === '/api/tenant/history' && req.method === 'GET') {
      const u = sessionUser(req);
      if (!requireRole(u, 'tenant', res)) return;
      const rows = db.prepare(`SELECT * FROM tenancies WHERE tenant_id = ? AND status = 'ended'
        ORDER BY created_at DESC, id DESC`).all(u.id);
      return sendJson(res, 200, { tenancies: rows.map(tenantTenancyView) });
    }
    // ---- Phase 4: tenant payment submission (proof photo + amount + method) ----
    if (p === '/api/tenant/payments' && req.method === 'POST') {
      const u = sessionUser(req);
      if (!requireRole(u, 'tenant', res)) return;
      if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
      const ct = req.headers['content-type'] || '';
      let fields = {};
      let files = [];
      if (ct.includes('multipart/form-data')) {
        if (!uploadAllowed(u.id)) return sendJson(res, 429, { error: 'too many uploads — try again later' });
        let parsed;
        try {
          parsed = await parseMultipartBody(req, PHOTO_MAX_BYTES + 65536);
        } catch (e) {
          return sendJson(res, e.message === 'upload too large' ? 413 : 400,
            { error: e.message === 'upload too large' ? 'proof photo is too large — max 5MB' : 'upload must be multipart/form-data with a proof photo' });
        }
        fields = parsed.fields;
        files = parsed.files;
      } else {
        const body = await readBody(req);
        if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body required' });
        for (const [k, v] of Object.entries(body)) fields[k] = String(v ?? '');
      }
      const unknown = rejectUnknown(fields, new Set(['bill_id', 'amount_pkr', 'method', 'txn_ref', 'note']));
      if (unknown) return sendJson(res, 400, { error: 'unknown field: ' + unknown });
      const billId = Number(fields.bill_id);
      if (!Number.isInteger(billId) || billId < 1) return sendJson(res, 400, { error: 'bill_id must be a whole number' });
      const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
      if (!bill) return sendJson(res, 404, { error: 'bill not found' });
      const tenancy = db.prepare('SELECT * FROM tenancies WHERE id = ?').get(bill.tenancy_id);
      if (!tenancy || tenancy.tenant_id !== u.id) return sendJson(res, 403, { error: 'not your bill' });
      if (tenancy.status !== 'active') return sendJson(res, 400, { error: 'this tenancy is not active' });
      const amtRaw = String(fields.amount_pkr ?? '').trim();
      if (!/^\d+$/.test(amtRaw)) return sendJson(res, 400, { error: 'amount_pkr must be a positive whole number of rupees' });
      const amount = Number(amtRaw);
      if (amount < 1 || amount > 100000000) return sendJson(res, 400, { error: 'amount_pkr must be a positive whole number of rupees' });
      const method = String(fields.method || '').trim().toLowerCase();
      if (!PAYMENT_METHODS.has(method)) return sendJson(res, 400, { error: 'method must be cash, jazzcash, easypaisa, bank or other' });
      const txnRef = String(fields.txn_ref ?? '').trim();
      if (txnRef.length > 100) return sendJson(res, 400, { error: 'txn_ref is too long (max 100 characters)' });
      const note = String(fields.note ?? '').trim();
      if (note.length > 500) return sendJson(res, 400, { error: 'note is too long (max 500 characters)' });
      if (bill.amount_pkr == null) {
        return sendJson(res, 400, { error: 'the owner must enter the amount first — this bill shows "Amount not entered yet"' });
      }
      if (bill.status === 'paid') return sendJson(res, 400, { error: 'this bill is already paid — no double payment' });
      // Proof photo: magic bytes FIRST, extension second and matching.
      const file = files.find((f) => f.name === 'photo' || f.name === 'proof');
      if (!file) return sendJson(res, 400, { error: 'proof photo required (field name "photo")' });
      if (file.data.length > PHOTO_MAX_BYTES) return sendJson(res, 413, { error: 'proof photo is too large — max 5MB' });
      const kind = detectImageKind(file.data);
      if (!kind) return sendJson(res, 400, { error: 'proof photo must be a JPG, PNG or WebP image' });
      const ext = path.extname(file.filename || '').toLowerCase();
      if (!PHOTO_EXTS[ext] || PHOTO_EXTS[ext] !== kind) return sendJson(res, 400, { error: 'proof photo file extension must match its contents (JPG, PNG or WebP)' });
      const stored = 'photo-' + crypto.randomBytes(16).toString('hex') + ext;
      try { fs.writeFileSync(path.join(UPLOADS_DIR, stored), file.data); }
      catch { return sendJson(res, 500, { error: 'could not store the proof photo on this server' }); }
      const photoInfo = db.prepare("INSERT INTO photos(uploader_id, tenancy_id, kind, filename) VALUES(?, ?, 'proof', ?)").run(u.id, tenancy.id, stored);
      const info = db.prepare(`INSERT INTO payments(bill_id, tenancy_id, payer_id, amount_pkr, method, txn_ref, note, proof_photo_id, status)
        VALUES(?,?,?,?,?,?,?,?, 'pending')`).run(bill.id, tenancy.id, u.id, amount, method, txnRef, note, Number(photoInfo.lastInsertRowid));
      const paymentId = Number(info.lastInsertRowid);
      // One current proof per bill: the bill moves to paid_pending. A
      // second payment on the same bill is a correction — the old row
      // stays untouched in history, the new one becomes the current proof.
      db.prepare("UPDATE bills SET status = 'paid_pending' WHERE id = ?").run(bill.id);
      audit('payment.submitted', u, 'payment', paymentId, 'payment proof submitted: Rs ' + amount + ' (' + method + ') for bill ' + bill.id);
      db.prepare("INSERT INTO notifications(user_id, kind, title, body, link) VALUES(?, 'payment_pending', ?, ?, ?)")
        .run(tenancy.owner_id, 'Payment proof uploaded', u.display_name + ' uploaded a Rs ' + amount + ' proof (' + method + ').', '/tenancy?id=' + tenancy.id);
      const payRow = db.prepare(PAYMENT_SELECT + ' WHERE p.id = ?').get(paymentId);
      return sendJson(res, 201, { ok: true, payment: paymentView(payRow), bill: enrichBill(db.prepare(`SELECT b.*, s.kind AS schedule_kind, s.label AS schedule_label FROM bills b JOIN bill_schedules s ON s.id = b.schedule_id WHERE b.id = ?`).get(bill.id), '', 'My') });
    }

    // ---- Phase 4: tenant receipts (approved payments only, their own) ----
    if (p === '/api/tenant/receipts' && req.method === 'GET') {
      const u = sessionUser(req);
      if (!requireRole(u, 'tenant', res)) return;
      const rows = db.prepare(PAYMENT_SELECT + " WHERE p.payer_id = ? AND p.status = 'approved' ORDER BY p.decided_at DESC, p.id DESC").all(u.id);
      return sendJson(res, 200, { receipts: rows.map((r) => receiptView(r)) });
    }

    // ---- Phase 4: tenant ledger CSV (only their own payments) ----
    if (p === '/api/tenant/ledger.csv' && req.method === 'GET') {
      const u = sessionUser(req);
      if (!requireRole(u, 'tenant', res)) return;
      return sendCsv(res, 'kiraya-ledger.csv', ledgerCsv(ledgerRows('p.payer_id = ?', [u.id])));
    }

    const tenantTenancyMatch = p.match(/^\/api\/tenant\/tenancies\/(\d+)\/request-end$/);
    if (tenantTenancyMatch && req.method === 'POST') {
      const tenancyId = Number(tenantTenancyMatch[1]);
      const u = sessionUser(req);
      if (!requireRole(u, 'tenant', res)) return;
      if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
      const tenancy = db.prepare('SELECT * FROM tenancies WHERE id = ?').get(tenancyId);
      if (!tenancy) return sendJson(res, 404, { error: 'tenancy not found' });
      if (tenancy.tenant_id !== u.id) return sendJson(res, 403, { error: 'not your tenancy' });
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body required' });
      const unknown = rejectUnknown(body, new Set(['reason']));
      if (unknown) return sendJson(res, 400, { error: 'unknown field: ' + unknown });
      const reason = String(body.reason ?? '').trim();
      if (!reason) return sendJson(res, 400, { error: 'a reason is required to ask for the tenancy to end' });
      if (reason.length > 500) return sendJson(res, 400, { error: 'reason is too long (max 500 characters)' });
      if (tenancy.status !== 'active') return sendJson(res, 400, { error: 'only an active tenancy can be asked to end' });
      audit('tenancy.end-requested', u, 'tenancy', tenancy.id, 'tenant asked to end the tenancy: ' + reason);
      db.prepare("INSERT INTO notifications(user_id, kind, title, body, link) VALUES(?, 'tenancy_ended', ?, ?, ?)")
        .run(tenancy.owner_id, 'Tenant asked to end the tenancy', u.display_name + ': ' + reason, '/owner');
      return sendJson(res, 200, { ok: true, message: 'Your owner has been asked to end the tenancy.' });
    }

    // ---- Phase 5: WhatsApp-like chat (per tenancy, both parties only) ----
    if (p === '/api/chat/threads' && req.method === 'GET') {
      const u = sessionUser(req);
      if (!u) return sendJson(res, 401, { error: 'login required' });
      const rows = db.prepare(`SELECT t.*, h.title AS house_title
        FROM tenancies t JOIN houses h ON h.id = t.house_id
        WHERE t.status = 'active' AND (t.owner_id = ? OR t.tenant_id = ?)
        ORDER BY t.created_at DESC, t.id DESC`).all(u.id, u.id);
      // Delivered ticks: opening the app (the thread list, polled every
      // 15s) marks the other party's undelivered messages in these
      // threads DELIVERED — never read. Read needs opening the thread
      // itself (GET /api/chat/:id/messages below).
      const fetchNow = Date.now();
      for (const t of rows) {
        db.prepare(`UPDATE messages SET delivered_at = ?
          WHERE tenancy_id = ? AND sender_id != ? AND delivered_at IS NULL`)
          .run(fetchNow, t.id, u.id);
      }
      const threads = rows.map((t) => {
        const otherId = t.owner_id === u.id ? t.tenant_id : t.owner_id;
        const other = db.prepare('SELECT display_name FROM users WHERE id = ?').get(otherId) || {};
        const last = db.prepare('SELECT * FROM messages WHERE tenancy_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(t.id);
        const unread = db.prepare('SELECT COUNT(*) c FROM messages WHERE tenancy_id = ? AND sender_id != ? AND read_at IS NULL').get(t.id, u.id).c;
        return {
          tenancy_id: t.id, house_id: t.house_id, house_title: t.house_title,
          other_name: other.display_name || '', other_id: otherId,
          tenancy_active_since: String(t.start_date || t.created_at || '').slice(0, 10),
          last_message: last ? messageView(last) : null,
          unread_count: unread,
        };
      });
      return sendJson(res, 200, { threads });
    }
    const chatMsgMatch = p.match(/^\/api\/chat\/(\d+)\/messages(\/photo)?$/);
    if (chatMsgMatch) {
      const tenancyId = Number(chatMsgMatch[1]);
      const isPhoto = !!chatMsgMatch[2];
      const u = sessionUser(req);
      if (!u) return sendJson(res, 401, { error: 'login required' });
      const tenancy = db.prepare('SELECT * FROM tenancies WHERE id = ?').get(tenancyId);
      if (!tenancy) return sendJson(res, 404, { error: 'tenancy not found' });
      if (!isChatParty(tenancy, u)) return sendJson(res, 403, { error: 'not your chat' });
      // GET: polling — opening the thread marks the other party's
      // messages READ (and delivered, if the thread list never fetched
      // them first). The thread list alone marks delivered only.
      if (!isPhoto && req.method === 'GET') {
        const now = Date.now();
        db.prepare(`UPDATE messages SET delivered_at = COALESCE(delivered_at, ?), read_at = ?
          WHERE tenancy_id = ? AND sender_id != ? AND read_at IS NULL`).run(now, now, tenancyId, u.id);
        const since = Number(url.searchParams.get('since')) || 0;
        const rows = db.prepare('SELECT * FROM messages WHERE tenancy_id = ? AND created_at > ? ORDER BY created_at ASC, id ASC').all(tenancyId, since);
        return sendJson(res, 200, { tenancy_id: tenancyId, messages: rows.map(messageView) });
      }
      // POST text / photo: only on an ACTIVE tenancy (LINK-FIRST — a
      // requested tenancy has no chat until the owner approves it).
      if (req.method !== 'POST') return sendJson(res, 404, { error: 'not found' });
      if (!csrfOk(req)) return sendJson(res, 403, { error: 'bad origin' });
      if (tenancy.status !== 'active') return sendJson(res, 400, { error: 'this tenancy is not active — chat starts after the owner approves the link' });
      if (!isPhoto) {
        const body = await readBody(req);
        if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body required' });
        const unknown = rejectUnknown(body, new Set(['body']));
        if (unknown) return sendJson(res, 400, { error: 'unknown field: ' + unknown });
        // Links are allowed but render as plain text, never clickable
        // HTML: the body is stored as-is and escaped on render.
        const text = String(body.body ?? '');
        if (!text.trim()) return sendJson(res, 400, { error: 'message text is required' });
        if (text.length > 2000) return sendJson(res, 400, { error: 'message is too long (max 2000 characters)' });
        const info = db.prepare('INSERT INTO messages(tenancy_id, sender_id, body, photo_id, created_at, read_at) VALUES(?,?,?,NULL,?,NULL)')
          .run(tenancyId, u.id, text, Date.now());
        notifyChatMessage(tenancy, u);
        const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid));
        return sendJson(res, 201, { ok: true, message: messageView(m) });
      }
      // POST photo message: magic bytes FIRST, extension second and matching.
      if (!uploadAllowed(u.id)) return sendJson(res, 429, { error: 'too many uploads — try again later' });
      let parsed;
      try {
        parsed = await parseMultipartBody(req, PHOTO_MAX_BYTES + 65536);
      } catch (e) {
        return sendJson(res, e.message === 'upload too large' ? 413 : 400,
          { error: e.message === 'upload too large' ? 'photo is too large — max 5MB' : 'upload must be multipart/form-data with a photo file' });
      }
      const file = parsed.files.find((f) => f.name === 'photo');
      if (!file) return sendJson(res, 400, { error: 'photo file required (field name "photo")' });
      if (file.data.length > PHOTO_MAX_BYTES) return sendJson(res, 413, { error: 'photo is too large — max 5MB' });
      const kind = detectImageKind(file.data);
      if (!kind) return sendJson(res, 400, { error: 'photo must be a JPG, PNG or WebP image' });
      const ext = path.extname(file.filename || '').toLowerCase();
      if (!PHOTO_EXTS[ext] || PHOTO_EXTS[ext] !== kind) return sendJson(res, 400, { error: 'photo file extension must match its contents (JPG, PNG or WebP)' });
      const stored = 'photo-' + crypto.randomBytes(16).toString('hex') + ext;
      try { fs.writeFileSync(path.join(UPLOADS_DIR, stored), file.data); }
      catch { return sendJson(res, 500, { error: 'could not store the photo on this server' }); }
      // Chat photos reuse the 'proof' kind: /api/photos/file/ serves a
      // proof photo only to the two parties of its tenancy.
      const photoInfo = db.prepare("INSERT INTO photos(uploader_id, tenancy_id, kind, filename) VALUES(?, ?, 'proof', ?)").run(u.id, tenancyId, stored);
      const info = db.prepare('INSERT INTO messages(tenancy_id, sender_id, body, photo_id, created_at, read_at) VALUES(?,?,?, ?,?,NULL)')
        .run(tenancyId, u.id, '', Number(photoInfo.lastInsertRowid), Date.now());
      notifyChatMessage(tenancy, u);
      const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid));
      return sendJson(res, 201, { ok: true, message: messageView(m) });
    }

    // ---- master (X-Master-Code header only; never in a query string) ----
    const masterHeaderOk = req.headers['x-master-code'] === ADMIN_CODE;
    if (p.startsWith('/api/master/')) {
      if (!masterHeaderOk) return sendJson(res, 403, { error: 'bad master code' });
      if (p === '/api/master/users' && req.method === 'GET') {
        const role = String(url.searchParams.get('role') || '');
        const status = String(url.searchParams.get('status') || '');
        if (role && role !== 'owner' && role !== 'tenant') return sendJson(res, 400, { error: 'role must be owner or tenant' });
        if (status && status !== 'active' && status !== 'suspended') return sendJson(res, 400, { error: 'status must be active or suspended' });
        let sql = 'SELECT id, gmail, display_name, phone, cnic, role, status, created_at FROM users';
        const where = [];
        const args = [];
        if (role) { where.push('role = ?'); args.push(role); }
        if (status) { where.push('status = ?'); args.push(status); }
        if (where.length) sql += ' WHERE ' + where.join(' AND ');
        sql += ' ORDER BY created_at DESC, id DESC LIMIT 200';
        // Metadata only: full CNICs never leave the server — last-4 only.
        const users = db.prepare(sql).all(...args).map((r) => ({
          id: r.id, gmail: r.gmail, display_name: r.display_name, phone: r.phone,
          cnic_last4: cnicLast4(r.cnic), role: r.role, status: r.status, created_at: r.created_at,
        }));
        return sendJson(res, 200, { users });
      }
      if ((p === '/api/master/users/suspend' || p === '/api/master/users/reinstate') && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body required' });
        const unknown = rejectUnknown(body, new Set(['user_id']));
        if (unknown) return sendJson(res, 400, { error: 'unknown field: ' + unknown });
        const target = db.prepare('SELECT id, gmail, display_name, phone, role, status, created_at FROM users WHERE id = ?').get(Number(body.user_id));
        if (!target) return sendJson(res, 404, { error: 'account not found' });
        const suspending = p.endsWith('/suspend');
        db.prepare('UPDATE users SET status = ? WHERE id = ?').run(suspending ? 'suspended' : 'active', target.id);
        killAllSessions(target.id);
        audit(suspending ? 'master.suspend' : 'master.reinstate', null, 'user', target.id,
          (suspending ? 'suspended ' : 'reinstated ') + target.gmail);
        return sendJson(res, 200, { ok: true, user: { ...publicUser(target), status: suspending ? 'suspended' : 'active' } });
      }
      if (p === '/api/master/password-reset' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body required' });
        const unknown = rejectUnknown(body, new Set(['user_id', 'new_password']));
        if (unknown) return sendJson(res, 400, { error: 'unknown field: ' + unknown });
        const newPassword = String(body.new_password || '');
        if (newPassword.length < 8) return sendJson(res, 400, { error: 'new password must be at least 8 characters' });
        const target = db.prepare('SELECT id, gmail FROM users WHERE id = ?').get(Number(body.user_id));
        if (!target) return sendJson(res, 404, { error: 'account not found' });
        db.prepare('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = 0 WHERE id = ?')
          .run(hashPassword(newPassword), target.id);
        killAllSessions(target.id);
        audit('master.password-reset', null, 'user', target.id, 'password reset by master; all sessions ended');
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/master/audit' && req.method === 'GET') {
        const rows = db.prepare(`SELECT id, actor_id, actor_role, action, target_type, target_id, detail, created_at
          FROM audit ORDER BY created_at DESC, id DESC LIMIT 100`).all();
        return sendJson(res, 200, { rows });
      }
      if (p === '/api/master/stats' && req.method === 'GET') {
        const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
        const usersByRole = db.prepare('SELECT role, COUNT(*) c FROM users GROUP BY role').all();
        const usersByStatus = db.prepare('SELECT status, COUNT(*) c FROM users GROUP BY status').all();
        return sendJson(res, 200, {
          users: count('users'),
          users_by_role: Object.fromEntries(usersByRole.map((r) => [r.role, r.c])),
          users_by_status: Object.fromEntries(usersByStatus.map((r) => [r.status, r.c])),
          houses: count('houses'), tenancies: count('tenancies'),
          bills: count('bills'), payments: count('payments'), messages: count('messages'),
        });
      }
      return sendJson(res, 404, { error: 'not found' });
    }

    if (p === '/favicon.ico' && req.method === 'GET') return serveStatic(req, res);
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(405, SECURITY_HEADERS); res.end('Method not allowed');
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: 'server error' });
  }
});

// Bills for the current month are generated on server start too (lazy
// generation — no cron in zero-dep). See generateBillsForTenancy above.
generateAllBills();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Kiraya Register (final, Phase 6) running on http://0.0.0.0:${PORT} (DB: ${DB_FILE})`);
});
