'use strict';
// File Share API. Read-only exposure of server folders for external consumers
// (e.g. an ML job pulling QC images). Auth mirrors the Remote Gateway:
//   1. header `x-api-token: <token>`  (or `Authorization: Bearer <token>`)
//   2. an admin login JWT / fleet token — so the UI + hub proxy keep working
// There is deliberately NO loopback exemption: apps this manager deploys run on
// this same host, so "from 127.0.0.1" is not evidence of an operator — it would
// hand every deployed app admin over the share API.
// The api-token can ONLY read files (list/download). Managing shares and the
// token itself needs a real login — a leaked read token must not be able to
// point a new share at some other folder, or rotate itself.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const shares = require('../shares');
const settings = require('../settings');
const config = require('../config');
const { audit } = require('../audit');
const { verifyAnyToken } = require('../auth');

const router = express.Router();

function shareAuth(req, res, next) {
  const apiTok = settings.get('share_api_token');
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : null;
  const provided = req.headers['x-api-token'] || bearer;
  if (apiTok && provided === apiTok) {
    req.user = { username: 'api-token', role: 'admin' };
    return next();
  }
  const payload = bearer && verifyAnyToken(bearer);
  if (payload && payload.role === 'admin') {
    req.user = payload;
    return next();
  }
  return res.status(401).json({ error: 'unauthorized: need x-api-token or admin login' });
}
router.use(shareAuth);

// Real-login gate for anything beyond reading files: the api-token identity is
// blocked, an admin JWT / fleet login passes.
function manageOnly(req, res, next) {
  if (req.user && req.user.username !== 'api-token') return next();
  return res.status(403).json({ error: 'manage shares from a logged-in session' });
}

function getShare(id) {
  return db.prepare('SELECT * FROM shares WHERE id=?').get(id);
}

// ---- share management (real login only) ----
router.get('/', manageOnly, (req, res) => {
  res.json(db.prepare('SELECT * FROM shares ORDER BY name').all());
});

// A share hands its whole tree to the read-only api-token, which is by design
// given to outside jobs. So the root must never be able to reach the manager's
// own secrets: backend/.env, data/webmanager.db and data/jwt.secret. That last
// file is the key secretbox derives from, so exposing it would decrypt every
// stored SMB password AND allow forging an admin JWT — a read-only image token
// would become full control.
//
// Rejected: the root IS the manager root, sits inside it, or contains it (e.g.
// C:\ or /). Publishing something the manager merely deployed — ROOT/sites/... —
// is still allowed, since that is only a copy of the app's own files.
function insideManagerRoot(root) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const r = norm(root);
  const managerRoot = norm(config.ROOT);
  const sites = norm(path.join(config.ROOT, 'sites'));
  if (r === sites || r.startsWith(sites + path.sep)) return null; // deployed apps are fine
  if (r === managerRoot) return 'root_path may not be the webmanager root itself — it holds the database, the JWT secret and .env';
  if (r.startsWith(managerRoot + path.sep)) {
    return 'root_path may not point inside the webmanager root — it holds the database, the JWT secret and .env';
  }
  if (managerRoot.startsWith(r + path.sep)) {
    return 'root_path contains the webmanager root, which would expose the database, the JWT secret and .env — pick a narrower folder';
  }
  return null;
}

function validate(b) {
  const name = String(b.name || '').trim();
  const root = String(b.root_path || '').trim();
  if (!name || !root) return 'name and root_path required';
  if (!path.isAbsolute(root)) return 'root_path must be an absolute path';
  if (/[\r\n\0]/.test(root)) return 'root_path may not contain newlines';
  let st;
  try {
    st = fs.statSync(root);
  } catch {
    return `folder not found: ${root}`;
  }
  if (!st.isDirectory()) return 'root_path is not a folder';
  // Resolve symlinks before the containment check, or a link into the data dir
  // would walk straight past it.
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    /* fall back to the literal path */
  }
  return insideManagerRoot(real);
}

router.post('/', manageOnly, (req, res) => {
  const b = req.body || {};
  const err = validate(b);
  if (err) return res.status(400).json({ error: err });
  const info = db
    .prepare('INSERT INTO shares (name, root_path, enabled) VALUES (?,?,?)')
    .run(String(b.name).trim(), String(b.root_path).trim(), b.enabled === false ? 0 : 1);
  const sh = getShare(info.lastInsertRowid);
  audit(req.user, 'share-create', sh.name, sh.root_path);
  res.status(201).json(sh);
});

router.put('/:id', manageOnly, (req, res) => {
  const sh = getShare(req.params.id);
  if (!sh) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const next = { name: b.name ?? sh.name, root_path: b.root_path ?? sh.root_path };
  const err = validate(next);
  if (err) return res.status(400).json({ error: err });
  db.prepare('UPDATE shares SET name=?, root_path=?, enabled=? WHERE id=?').run(
    String(next.name).trim(),
    String(next.root_path).trim(),
    'enabled' in b ? (b.enabled ? 1 : 0) : sh.enabled,
    sh.id
  );
  audit(req.user, 'share-update', next.name);
  res.json(getShare(sh.id));
});

router.delete('/:id', manageOnly, (req, res) => {
  const sh = getShare(req.params.id);
  if (!sh) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM shares WHERE id=?').run(sh.id);
  audit(req.user, 'share-delete', sh.name);
  res.json({ ok: true });
});

// ---- api-token management (real login only) ----
router.get('/token', manageOnly, (req, res) => res.json({ hasToken: !!settings.get('share_api_token') }));
router.post('/token', manageOnly, (req, res) => {
  const token = 'fst_' + crypto.randomBytes(24).toString('hex');
  settings.set('share_api_token', token);
  audit(req.user, 'share-token', 'generate');
  res.json({ token });
});
router.delete('/token', manageOnly, (req, res) => {
  settings.del('share_api_token');
  audit(req.user, 'share-token', 'revoke');
  res.json({ ok: true });
});

// ---- read access (admin login OR x-api-token) ----
function activeShare(req, res) {
  const sh = getShare(req.params.id);
  if (!sh) {
    res.status(404).json({ error: 'share not found' });
    return null;
  }
  if (!sh.enabled) {
    res.status(403).json({ error: 'share disabled' });
    return null;
  }
  return sh;
}

// List a folder in the share. ?recursive=1 flattens the whole subtree — one call
// gives an ML script every file path to fetch.
router.get('/:id/list', (req, res) => {
  const sh = activeShare(req, res);
  if (!sh) return;
  try {
    const { entries, capped } = shares.listDir(sh.root_path, req.query.path, req.query.recursive === '1');
    res.json({ share: sh.name, path: String(req.query.path || ''), capped, cap: shares.LIST_CAP, entries });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Download a single file from the share.
router.get('/:id/file', (req, res) => {
  const sh = activeShare(req, res);
  if (!sh) return;
  let abs;
  try {
    abs = shares.safeJoin(sh.root_path, req.query.path);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return res.status(404).json({ error: 'file not found' });
  }
  if (!st.isFile()) return res.status(400).json({ error: 'not a file' });
  const fname = path.basename(abs).replace(/["\r\n]/g, '');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.setHeader('Content-Length', st.size);
  fs.createReadStream(abs)
    .on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    })
    .pipe(res);
});

module.exports = router;
