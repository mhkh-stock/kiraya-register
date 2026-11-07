// Kiraya Register — writable-location resolution (deploy fallback).
// Same pattern as FoodScope (server.js): try the app directory first; if it
// cannot be written (read-only host such as SnapDeploy's /app), fall back to
// the OS temp directory so the server can still start. Kept in its own
// module so test.js can exercise the helper directly without booting the
// server. No API, schema or seed changes either way.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Returns candidateDir when it is writable, otherwise os.tmpdir().
function writableBase(candidateDir) {
  try { fs.accessSync(candidateDir, fs.constants.W_OK); return candidateDir; }
  catch { return os.tmpdir(); }
}

// Resolves the runtime data paths for an app directory + env.
// Local (writable app dir): data/kiraya.sqlite + uploads/ next to server.js.
// Fallback (read-only app dir): /tmp/kiraya.sqlite + /tmp/kiraya-uploads.
// Explicit DB_FILE / UPLOADS_DIR env vars always win in either mode.
function resolvePaths(appDir, env) {
  const e = env || {};
  const base = writableBase(appDir);
  const fallback = base !== appDir;
  return {
    dataRoot: base,
    fallback,
    dbFile: e.DB_FILE || (fallback
      ? path.join(os.tmpdir(), 'kiraya.sqlite')
      : path.join(appDir, 'data', 'kiraya.sqlite')),
    uploadsDir: e.UPLOADS_DIR || (fallback
      ? path.join(os.tmpdir(), 'kiraya-uploads')
      : path.join(appDir, 'uploads')),
  };
}

module.exports = { writableBase, resolvePaths };
