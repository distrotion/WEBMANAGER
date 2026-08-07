'use strict';
// Network share credentials (admin only). Lets the manager authenticate SMB
// shares on behalf of every app it launches — see netshare.js for why that is
// needed at all.
//
// The password is write-only: it goes in, it is never returned by any route, and
// it is stored encrypted. `hasPassword` is the only thing the UI learns.
const express = require('express');
const db = require('../db');
const netshare = require('../netshare');
const secretbox = require('../secretbox');
const guard = require('../guard');
const { audit } = require('../audit');

const router = express.Router();
router.use(guard.adminOnly);

const view = (s) => ({
  id: s.id,
  name: s.name,
  unc_path: s.unc_path,
  username: s.username,
  enabled: !!s.enabled,
  hasPassword: !!s.password_enc,
  created_at: s.created_at,
  ...netshare.status(s.id),
});

function validate(b, { requirePassword }) {
  const name = String(b.name || '').trim();
  const unc = String(b.unc_path || '').trim();
  const user = String(b.username || '').trim();
  if (!name || !unc || !user) return 'name, unc_path and username are required';
  if (!/^\\\\[^\\/:*?"<>|]+\\[^/:*?"<>|]+/.test(unc)) {
    return 'unc_path must look like \\\\server\\share (a mapped drive letter cannot be used — it is per-login-session and invisible to a service)';
  }
  if (/[\r\n\0]/.test(unc) || /[\r\n\0]/.test(user)) return 'value may not contain newlines';
  if (requirePassword && !String(b.password || '')) return 'password required';
  return null;
}

router.get('/', (req, res) => res.json(db.prepare('SELECT * FROM net_shares ORDER BY name').all().map(view)));

router.post('/', async (req, res) => {
  const b = req.body || {};
  const err = validate(b, { requirePassword: true });
  if (err) return res.status(400).json({ error: err });
  let info;
  try {
    info = db
      .prepare('INSERT INTO net_shares (name, unc_path, username, password_enc, enabled) VALUES (?,?,?,?,?)')
      .run(
        String(b.name).trim(),
        String(b.unc_path).trim(),
        String(b.username).trim(),
        secretbox.encrypt(b.password),
        b.enabled === false ? 0 : 1
      );
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const row = db.prepare('SELECT * FROM net_shares WHERE id=?').get(info.lastInsertRowid);
  audit(req.user, 'netshare-create', row.name, `${row.unc_path} as ${row.username}`);
  await netshare.reconcile('system', { force: true }).catch(() => {});
  res.status(201).json(view(db.prepare('SELECT * FROM net_shares WHERE id=?').get(row.id)));
});

router.put('/:id', async (req, res) => {
  const row = db.prepare('SELECT * FROM net_shares WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  // An empty password field means "keep the stored one" — the UI cannot show it
  // back, so it must not be forced to resend it on every edit.
  const merged = { name: b.name ?? row.name, unc_path: b.unc_path ?? row.unc_path, username: b.username ?? row.username };
  const err = validate(merged, { requirePassword: false });
  if (err) return res.status(400).json({ error: err });
  db.prepare('UPDATE net_shares SET name=?, unc_path=?, username=?, password_enc=?, enabled=? WHERE id=?').run(
    String(merged.name).trim(),
    String(merged.unc_path).trim(),
    String(merged.username).trim(),
    b.password ? secretbox.encrypt(b.password) : row.password_enc,
    'enabled' in b ? (b.enabled ? 1 : 0) : row.enabled,
    row.id
  );
  audit(req.user, 'netshare-update', merged.name);
  await netshare.reconcile('system', { force: true }).catch(() => {});
  res.json(view(db.prepare('SELECT * FROM net_shares WHERE id=?').get(row.id)));
});

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM net_shares WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM net_shares WHERE id=?').run(row.id);
  audit(req.user, 'netshare-delete', row.name);
  res.json({ ok: true });
});

// Reconnect everything now (the "Reconnect" button).
router.post('/reconnect', async (req, res) => {
  await netshare.reconcile('system', { force: true }).catch(() => {});
  res.json(db.prepare('SELECT * FROM net_shares ORDER BY name').all().map(view));
});

// Try a credential without storing it.
router.post('/test', async (req, res) => {
  const b = req.body || {};
  const err = validate(b, { requirePassword: true });
  if (err) return res.status(400).json({ error: err });
  const r = await netshare.test({
    unc_path: String(b.unc_path).trim(),
    username: String(b.username).trim(),
    password: String(b.password),
  });
  audit(req.user, 'netshare-test', String(b.unc_path).trim(), r.ok ? 'ok' : 'failed');
  res.json(r);
});

module.exports = router;
