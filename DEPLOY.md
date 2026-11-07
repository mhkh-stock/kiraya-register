# Kiraya Register — Deploy Guide

Kiraya Register is a zero-dependency Node.js app (native `node:http` +
`node:sqlite` only). There is nothing to install: no `npm install` step,
no build step.

## Requirements

- **Node.js 24+** (`package.json` declares `"engines": { "node": ">=24" }`
  — `node:sqlite` (`DatabaseSync`) requires Node 24).
- No external dependencies, no database server. The SQLite file is created
  automatically on first run.

## Start command

```bash
node server.js
# or
npm start
```

Local run:

```bash
ADMIN_CODE=your-private-code node server.js
# then open http://127.0.0.1:3038 (port 3038)
```

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `ADMIN_CODE` | _(none — **required**)_ | **Fail-closed: the server exits immediately without it.** There is no default. Pick a private code; never share it, never commit it, never put it in a file in this repo. The master gate is the `X-Master-Code` header only, never a query string. |
| `PORT` | `3038` | Port the server listens on. Hosts that assign a port (SnapDeploy) set this themselves — do not hard-code it on the host. |
| `NODE_VERSION` | — | `24` on SnapDeploy (see below). Only needed where the host picks the Node version from an env var. |
| `SESSION_SECRET` | _(random per start)_ | **Recommended: set a fixed private value.** Without it the server picks a random secret on every start, so every session ends on a restart/redeploy. With it set, logins survive restarts. Never share or commit it. |
| `DB_FILE` | `data/kiraya.sqlite` | Path to the SQLite database. On SnapDeploy set `/tmp/kiraya.sqlite` (see below). |
| `UPLOADS_DIR` | `uploads/` | Directory for uploaded photos (payment proofs, chat photos). On SnapDeploy set `/tmp/kiraya-uploads` (see below). |
| `SESSION_TTL_SECONDS` | `86400` (24h) | How long a login session lasts. |
| `LOGIN_LOCK_SECONDS` | `900` (15 min) | Lockout after 5 failed logins for an account. |
| `UPLOAD_LIMIT_PER_HOUR` | `30` | Max photo uploads per account per hour. |

## Writable directory / data storage

The app writes two things at runtime: the SQLite database
(`data/kiraya.sqlite`) and uploaded photos (`uploads/` — payment proofs
and chat photos, PNG/JPEG only).

- On a normal PC/server the app directory is writable, so the database
  and uploads live next to `server.js` exactly as before.
- **Read-only app directory fallback (already in `server.js`, via
  `lib/paths.js`):** if the app directory cannot be written (e.g.
  SnapDeploy's `/app`, which is read-only), the database and uploads
  automatically move to a writable temp directory — the database to
  `/tmp/kiraya.sqlite` and uploads to `/tmp/kiraya-uploads`. The app logs
  `Kiraya Register data directory (read-only app dir fallback): /tmp` on
  startup when the fallback is active. No code or env change is needed
  for this; setting `DB_FILE` / `UPLOADS_DIR` explicitly (below) does the
  same thing and is the documented route.
- **Warning:** data under `/tmp` is ephemeral — it can disappear on a
  container restart/redeploy, taking the database and uploads with it.
  On a host that offers a persistent disk/volume, mount one and point
  `DB_FILE` / `UPLOADS_DIR` at it so the database survives restarts.
  Until then, treat a `/tmp` deploy as demo data only.

## Deploy settings

### SnapDeploy

- Start command: `node server.js` (Node 24 image)
- Env vars to set in the container dashboard:

| Variable | Value |
| --- | --- |
| `NODE_VERSION` | `24` |
| `DB_FILE` | `/tmp/kiraya.sqlite` |
| `UPLOADS_DIR` | `/tmp/kiraya-uploads` |
| `ADMIN_CODE` | `<private value — set in the deploy dashboard, never in code>` |
| `SESSION_SECRET` | `<private value — set it so logins survive a restart>` |
| `PORT` | assigned by the host — do not hard-code it |

- The read-only `/app` fallback above applies automatically even if
  `DB_FILE` / `UPLOADS_DIR` are left unset; see the `/tmp` ephemerality
  warning before treating the deploy as permanent.
- **Hosting note:** there is no live date yet — the SnapDeploy free tier
  is 4/4 full, so Kiraya Register has no container slot until one frees
  or is paid for.

## First login after deploy

- There are no seeded accounts. The owner registers first
  (`/login` → register as owner), then lists a house and shares its
  `KRY-…` code with the tenant, who registers and links with that code.
- Master (ADMIN_CODE) actions — suspend/reinstate accounts, reset a
  password (kills all sessions), read the audit trail — are done with the
  `X-Master-Code` header, never in a query string. The master cannot read
  chat message bodies or full CNICs.

## Local plain-HTTP login and the Secure cookie

The session cookie is set with `Secure; HttpOnly; SameSite=Lax`. That is
intentional and tested (see `test.js` — register, login and logout all
assert `Secure` on `Set-Cookie`).

- Over plain HTTP on `127.0.0.1` / `localhost`, login still works: the
  test suite logs in over real HTTP on `127.0.0.1` and the session cookie
  is accepted on the next request, and browsers grant loopback origins
  (`localhost`) the secure-context exception for `Secure` cookies. For
  local browser testing prefer `http://localhost:3038`.
- Over plain HTTP on any non-loopback host the browser will not store
  the `Secure` cookie, so login would appear to succeed and then bounce
  back to `/login`. That is intended: **live sites are HTTPS-only.**
  Do not remove the flag to "fix" local HTTP — use HTTPS or loopback.

## Smoke check after deploy

1. Open the site — the home page loads; `/health` returns `{"ok":true}`.
2. Register an owner account, list a house, copy its `KRY-…` code.
3. Register a tenant account, link with the code, owner approves.
4. A bill generates for the current month; a payment proof upload
   creates a receipt (`RCP-<tenancy>-<seq>`) on approval.
5. Locally, the full suite covers all of this: `node test.js`
   (539 checks, fresh temp copy on port 3098, exit 0 = all green).
