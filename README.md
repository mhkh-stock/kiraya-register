# Kiraya Register — کرایہ رجسٹر

**Kiraya Register is a free, open-source web app for one Pakistani house owner and his rent takers: the owner lists his houses and keeps every schedule, the tenant logs in and links to his owner with a house code, they chat like WhatsApp, bills arrive on schedule, and the tenant proves each payment with a screenshot the owner approves.**

## How the flow works

```
OWNER                                    TENANT
  |                                        |
  | 1. Registers (Gmail + password         |
  |    + phone + name)                     |
  | 2. Adds houses (address, type,         |
  |    rent, advance, photos, map)         |
  | 3. Each house gets a LINK CODE         |
  |    (e.g. KRY-4X7Q2) — shared          |
  |    directly with the tenant            |
  |    (in person / WhatsApp)              |
  |                                        | 4. Registers (Gmail + password
  |                                        |    + name + phone + CNIC)
  |                                        | 5. Enters the house code
  |                                        |    → LINK REQUEST (pending)
  | 6. Sees the request (tenant name,      |
  |    phone, CNIC last-4) → APPROVES      |
  |    (sets rent, due day, agreement      |
  |    dates) or REJECTS with a reason     |
  |                                        |
  |    ★ THE LINK IS MADE — only now does the process start ★
  |    No schedule, no bill, no chat, no payment exists before this.
  |                                        |
  | 7. Keeps the schedule: rent monthly    |
  |    on the due day; gas / electricity   |
  |    monthly (amount when the bill comes)|
  | 8. Bills generate each month; both     | 8. Sees the same bills
  |    sides see the same list             |    on their own page
  | 9. In-app notifications (bell):       | 9. Same notifications
  |    due in 3 days / due today / overdue |
  |                                        | 10. Pays in real life
  |                                        |     (cash / JazzCash /
  |                                        |     Easypaisa / bank)
  |                                        | 11. Uploads the paid-bill
  |                                        |     screenshot + amount +
  |                                        |     method + txn ref
  | 12. APPROVES (bill → paid, receipt     |
  |     shown) or REJECTS with a reason    |
  |     (tenant can re-upload)             |
  |                                        |
  | 13. Chat, per tenancy, WhatsApp-like:  | 13. Same thread
  |     bubbles, ticks, timestamps,        |
  |     photo messages                     |
```

- **One owner, many houses and tenants** (one tenancy per house). **One tenant, one active tenancy at a time** — a second house needs a second account.
- A tenancy ends only when the owner ends it, or the tenant asks and the owner confirms. Ended tenancies stay read-only — the history is the proof. The tenant keeps reading an ended tenancy (bills, payments, receipts) under Past tenancies; the owner reads it the same way as always.
- There is **no public browse of houses and no owner directory**. A tenant finds a house ONLY through the code the owner shares directly.
- Bills generate lazily for every month from the tenancy's start month through the current month when either party opens the tenancy (and on server start, and at approval). A schedule the owner adds later bills only from the month it was added — the app never invents a bill for a month before a schedule existed, and a future start date generates no bills until that month. Rent bills carry a fixed amount; gas/electricity/water bills carry **no amount until the owner enters the real figure** — the app never invents a utility figure.
- A payment is one proof per bill; a second payment on the same bill is a correction (the old row stays in history, the new one becomes the current proof). Approving a payment marks the bill paid and creates a receipt (`RCP-<tenancy>-<seq>`). The ledger exports as CSV (owner: their tenancies; tenant: their own payments). The owner's pending-approvals queue shows the bill amount next to the paid amount, and flags a payment whose amount differs from its bill — so a part payment is never approved by mistake.
- Chat ticks, honestly: ✓ = stored on the server; ✓✓ = the other person opened the app and it fetched the message; blue ✓✓ = they opened this chat. The app cannot know their phone received it — that is WhatsApp, not this. No typing indicator, no online / last seen, no message delete.

## Run it (on your PC)

Requirements: **Node.js 24+**. No dependencies, no `npm install`.

```bash
ADMIN_CODE=your-private-code node server.js
```

Then open **http://127.0.0.1:3038** (port **3038**).

- `ADMIN_CODE` is **required** — the server exits immediately without it. There is no default. Pick a private code and never share it, never commit it, never put it in a file in this repo.
- Data lives in `data/kiraya.sqlite` (created on first run) and photos in `uploads/`. Both are git-ignored and must never be pushed.
- `node test.js` runs the full test suite (530 tests, throwaway DB on port 3098).

## Deploy (SnapDeploy container)

Environment variables:

| Variable | Value |
|---|---|
| `NODE_VERSION` | `24` |
| `DB_FILE` | `/tmp/kiraya.sqlite` |
| `UPLOADS_DIR` | `/tmp/kiraya-uploads` |
| `ADMIN_CODE` | `<private value — set in the deploy dashboard, never in code>` |
| `SESSION_SECRET` | `<private value — optional; set it so logins survive a restart (without it the server picks a random secret each start and every session ends)>` |
| `UPLOAD_LIMIT_PER_HOUR` | `30` (default; max photo uploads per account per hour) |
| `PORT` | `3038` (default) |

## Honest limits (printed in the app, not buried)

- This is a **record + chat + approval tool** — not a legal agreement and not a payment system.
- A screenshot proves the tenant **showed** a payment. Only the owner, checking his own account, knows the money arrived. A proof is not money, and the app never claims a payment was received — only that a proof was approved by the owner.
- Gas and electricity amounts are entered when the real bill arrives — the app never invents a utility figure. Until the amount is entered, the bill shows "Amount not entered yet".
- **No reminders when the app is closed.** No real WhatsApp messages in v1 — the bell is in-app only, and "Share on WhatsApp" only opens your own WhatsApp with a message ready to send. No SMS, no push notifications.
- Chat ticks mean "stored / fetched / opened in the app", not WhatsApp delivery.
- Photos live on the container disk until a persistent store exists; **a redeploy can lose them**.
- The app **never verifies** an owner's identity, a tenant's identity, or a house's ownership. It records what the two parties entered and agreed.
- Legal lines are general information, not legal advice — check with the Rent Registrar / a lawyer. Rent law is provincial and changes.
- No real money ever moves in the app. The tenant pays in real life (cash / JazzCash / Easypaisa / bank); the app records the payment and its proof.

## Legal note

A tenancy must be in writing (Punjab Rented Premises Act 2009, Section 5) and registered with the Rent Registrar; police registration of the tenant is a separate, mandatory step (Punjab Information of Temporary Residents Act 2015). The app only **records** the agreement dates and the two ticks (Rent Registrar, police) and shows a plain checklist — it never generates a legal agreement and never claims a tenancy is legally valid. **All legal lines in the app are general information, not legal advice — check with the Rent Registrar / a lawyer. Laws are provincial.**

## Hosting note

There is **no live date yet**: the SnapDeploy free tier is 4/4 full, so Kiraya Register has no container slot until one frees or is paid for. Until then it runs on Hashir's PC on port 3038 for demo — owner and tenant log in from two browser profiles on the same machine. A localhost copy on one PC cannot chat with a tenant on another phone; the app only works between two people when it runs on a live server container.

## Security summary

- **Passwords:** scrypt only, salt per account, constant-time verify. No password, token or Gmail in any log.
- **Sessions:** random 32-byte token, HMAC-SHA256 hash stored in the DB, 24h expiry, `HttpOnly; SameSite=Lax` cookie. Logout, suspend, master password-reset and change-password all kill sessions (change-password hands the changing browser a fresh cookie, so it stays logged in).
- **Lockout:** 5 failed logins → 15-minute lock (account + IP), generic "invalid Gmail or password" errors, 429s on register / login / link-code abuse.
- **Strict isolation, tested on every endpoint:** tenant A vs tenant B (tenancy / bill / payment / photo / message → 403), owner A vs owner B (house / tenancy / bill / chat → 403), tenant without a code → 403, master → no message bodies, no full CNICs (404 / last-4 only).
- **Link codes:** random 6 characters (`KRY-XXXXXX`, no 0/O/1/I), per house, regenerable; wrong-code error is generic ("code not recognised"); 5 attempts/hour per IP + per account; a code reveals nothing about the house until the owner approves.
- **Uploads:** magic bytes first, extension second (must match), 5 MB cap, 8 photos per house, 1 current proof per bill, 30 uploads/hour per account, random stored names, path guard, `nosniff`; photos are served only to the linked pair, never as HTML.
- **XSS:** every user string is escaped on render (`esc()` / `escHtml()` in every `public/*.js`); chat links render as plain text, never clickable HTML.
- **CSRF:** `SameSite=Lax` cookies + Origin/Referer check on all cookie-authenticated POSTs.
- **Input validation on every boundary:** enums, ranges, length caps, Pakistani phone format, Gmail format, CNIC 13 digits for tenants; unknown fields rejected. Map URLs must be Google Maps share/embed links.
- **Security headers on every response:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer-when-downgrade`, `X-Frame-Options: SAMEORIGIN`.
- **Master (ADMIN_CODE, fail-closed):** the server exits without `ADMIN_CODE`; master can suspend/reinstate accounts and reset passwords (killing all sessions) and read the audit trail + metadata counts — but cannot read chat message bodies or full CNICs.
- **Privacy:** Gmail is never shown to the other party (display name only); phone only to the linked pair; full CNIC only to the tenant + linked owner, last-4 elsewhere.
- **Audit rows** for: link approve/reject, schedule create/edit/deactivate, bill amount entered, payment approve/reject, tenancy end, suspend, password reset.

## What is NOT in v1 (closed P2 list)

Real WhatsApp API messages; SMS; push notifications; in-app rent payment (money movement); auto-debit; public house listings / owner directory; typing indicator / online presence; message delete; multi-house tenant; rent agreement generation; any verification of owner / tenant / house identity.

## Tests

`node test.js` — **530/530 passing** (final, Phase 6 + 2026-11-07 review). The suite covers auth + lockout, houses + codes + tenancy approval, schedules + bills + notifications, payment proofs + receipts + ledger CSV, chat + ticks (sent → delivered → read), isolation on every endpoint, CSRF, ADMIN_CODE fail-closed (spawn without the env var → exit code 1), one full end-to-end scenario (register → house → code → link → approve → bill → proof → approve → receipt → chat ticks → second-link blocked → end tenancy → history readable, new chat/payment blocked), and the review fixes: second approval for one tenant → 409, re-approve → one rent schedule and one rent bill, bill backfill from the start month (schedules added later bill only from their month, future start bills nothing), tenant history after the end, change-password killing other sessions, per-account upload limit (31st upload → 429), per-bill notification dedup, and real WCAG contrast ratios for the palette.

The real-browser pass (owner creates a house → tenant links → schedule → bill → proof → approve → chat) still needs Hashir's PC re-test — subagents have no browser.
