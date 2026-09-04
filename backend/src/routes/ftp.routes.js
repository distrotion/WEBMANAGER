'use strict';
// FTP server management — admin only, real login required. Unlike the FTP
// protocol itself (its own username/password per account), this route manages
// the server AND the accounts, so it rides the panel's own auth, not a token.
const fs = require('fs');
const express = require('express');
const db = require('../db');
const ftp = require('../ftp');
const settings = require('../settings');
const secretbox = require('../secretbox');
const guard = require('../guard');
const { audit } = require('../audit');

const router = express.Router();
router.use(guard.adminOnly);

router.get('/status', (req, res) => res.json(ftp.status()));

function validateSettings(b) {
  const port = parseInt(b.port, 10);
  const pasvMin = parseInt(b.pasv_min, 10);
  const pasvMax = parseInt(b.pasv_max, 10);
  if (!port || port < 1 || port > 65535) return 'port out of range';
  if (!pasvMin || !pasvMax || pasvMin < 1024 || pasvMax > 65535 || pasvMin > pasvMax) {
    return 'pasv_min/pasv_max ต้องเป็นช่วงพอร์ตที่ถูกต้อง (>=1024)';
  }
  if (port >= pasvMin && port <= pasvMax) return 'port ต้องไม่อยู่ในช่วง passive';
  return null;
}

router.put('/settings', async (req, res) => {
  const b = req.body || {};
  const err = validateSettings(b);
  if (err) return res.status(400).json({ error: err });
  settings.set('ftp_enabled', b.enabled ? '1' : '0');
  settings.set('ftp_port', String(parseInt(b.port, 10)));
  settings.set('ftp_pasv_min', String(parseInt(b.pasv_min, 10)));
  settings.set('ftp_pasv_max', String(parseInt(b.pasv_max, 10)));
  settings.set('ftp_tls', b.tls ? '1' : '0');
  if (b.pasv_host) settings.set('ftp_pasv_host', String(b.pasv_host).trim());
  else settings.del('ftp_pasv_host');
  const status = await ftp.reconcile();
  audit(req.user, 'ftp-settings', status.enabled ? 'enabled' : 'disabled', `:${status.port}`);
  res.json(status);
});

const view = (u) => ({
  id: u.id,
  username: u.username,
  root_path: u.root_path,
  enabled: !!u.enabled,
  hasPassword: !!u.password_enc,
  created_at: u.created_at,
});

router.get('/users', (req, res) => res.json(db.prepare('SELECT * FROM ftp_users ORDER BY username').all().map(view)));

function validateUser(b, { requirePassword }) {
  const username = String(b.username || '').trim();
  const root = String(b.root_path || '').trim();
  if (!username || !root) return 'username และ root_path จำเป็น';
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) return 'username: ใช้ได้แค่ตัวอักษร/ตัวเลข/._- ยาว 3-64';
  if (requirePassword && !String(b.password || '')) return 'password required';
  if (!fs.existsSync(root)) return `path ไม่มีอยู่จริง: ${root}`;
  if (!fs.statSync(root).isDirectory()) return `path ไม่ใช่โฟลเดอร์: ${root}`;
  return null;
}

router.post('/users', (req, res) => {
  const b = req.body || {};
  const err = validateUser(b, { requirePassword: true });
  if (err) return res.status(400).json({ error: err });
  let info;
  try {
    info = db
      .prepare('INSERT INTO ftp_users (username, password_enc, root_path, enabled) VALUES (?,?,?,?)')
      .run(String(b.username).trim(), secretbox.encrypt(b.password), String(b.root_path).trim(), b.enabled === false ? 0 : 1);
  } catch (e) {
    return res.status(400).json({ error: e.message.includes('UNIQUE') ? 'username นี้มีอยู่แล้ว' : e.message });
  }
  const row = db.prepare('SELECT * FROM ftp_users WHERE id=?').get(info.lastInsertRowid);
  audit(req.user, 'ftp-user-create', row.username, row.root_path);
  res.status(201).json(view(row));
});

router.put('/users/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM ftp_users WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const merged = { username: b.username ?? row.username, root_path: b.root_path ?? row.root_path };
  const err = validateUser(merged, { requirePassword: false });
  if (err) return res.status(400).json({ error: err });
  try {
    db.prepare('UPDATE ftp_users SET username=?, root_path=?, password_enc=?, enabled=? WHERE id=?').run(
      String(merged.username).trim(),
      String(merged.root_path).trim(),
      b.password ? secretbox.encrypt(b.password) : row.password_enc,
      'enabled' in b ? (b.enabled ? 1 : 0) : row.enabled,
      row.id
    );
  } catch (e) {
    return res.status(400).json({ error: e.message.includes('UNIQUE') ? 'username นี้มีอยู่แล้ว' : e.message });
  }
  audit(req.user, 'ftp-user-update', merged.username);
  res.json(view(db.prepare('SELECT * FROM ftp_users WHERE id=?').get(row.id)));
});

router.delete('/users/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM ftp_users WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM ftp_users WHERE id=?').run(row.id);
  audit(req.user, 'ftp-user-delete', row.username);
  res.json({ ok: true });
});

// ---- in-panel folder browser (FileZilla-like view over one account's root) ----
// Admin-only like the rest of this router. Every path goes through
// shares.safeJoin, so neither `..` nor a symlink can step outside root_path —
// the same jail the FTP protocol side already enforces.
const path = require('path');
const shares = require('../shares');

function account(req, res) {
  const row = db.prepare('SELECT * FROM ftp_users WHERE id=?').get(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'account not found' });
    return null;
  }
  return row;
}

// One path segment (file/folder name) — no separators, no traversal, printable.
function badName(name) {
  const n = String(name || '');
  if (!n || n === '.' || n === '..') return 'ชื่อว่างหรือไม่ถูกต้อง';
  if (/[\\/\r\n\0]/.test(n)) return 'ชื่อห้ามมี / หรือ \\';
  if (n.length > 255) return 'ชื่อยาวเกินไป';
  return null;
}

router.get('/users/:id/list', (req, res) => {
  const acc = account(req, res);
  if (!acc) return;
  try {
    const { entries, capped } = shares.listDir(acc.root_path, req.query.path, false);
    res.json({ username: acc.username, path: String(req.query.path || ''), capped, entries });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/users/:id/file', (req, res) => {
  const acc = account(req, res);
  if (!acc) return;
  let abs;
  try {
    abs = shares.safeJoin(acc.root_path, req.query.path);
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

// Upload one file as a raw body (?path=<folder>&name=<filename>). Raw, not
// JSON/multipart: the global express.json 2mb cap doesn't apply, and the bytes
// land untouched. 200MB cap — bigger belongs on the FTP protocol itself.
router.post('/users/:id/upload', express.raw({ type: '*/*', limit: '200mb' }), (req, res) => {
  const acc = account(req, res);
  if (!acc) return;
  const nameErr = badName(req.query.name);
  if (nameErr) return res.status(400).json({ error: nameErr });
  let dir;
  try {
    dir = shares.safeJoin(acc.root_path, req.query.path);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return res.status(400).json({ error: 'โฟลเดอร์ปลายทางไม่มีอยู่' });
  const target = path.join(dir, String(req.query.name));
  try {
    fs.writeFileSync(target, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  audit(req.user, 'ftp-upload', acc.username, `${req.query.path || '/'} ${req.query.name}`);
  res.status(201).json({ ok: true, name: String(req.query.name) });
});

router.post('/users/:id/mkdir', (req, res) => {
  const acc = account(req, res);
  if (!acc) return;
  const b = req.body || {};
  const nameErr = badName(b.name);
  if (nameErr) return res.status(400).json({ error: nameErr });
  let dir;
  try {
    dir = shares.safeJoin(acc.root_path, b.path);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const target = path.join(dir, String(b.name));
  if (fs.existsSync(target)) return res.status(400).json({ error: 'มีชื่อนี้อยู่แล้ว' });
  try {
    fs.mkdirSync(target);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  audit(req.user, 'ftp-mkdir', acc.username, `${b.path || '/'} ${b.name}`);
  res.status(201).json({ ok: true });
});

router.post('/users/:id/rename', (req, res) => {
  const acc = account(req, res);
  if (!acc) return;
  const b = req.body || {};
  const nameErr = badName(b.new_name);
  if (nameErr) return res.status(400).json({ error: nameErr });
  let abs;
  try {
    abs = shares.safeJoin(acc.root_path, b.path);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'ไม่พบไฟล์/โฟลเดอร์' });
  const target = path.join(path.dirname(abs), String(b.new_name));
  if (fs.existsSync(target)) return res.status(400).json({ error: 'มีชื่อนี้อยู่แล้ว' });
  try {
    fs.renameSync(abs, target);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  audit(req.user, 'ftp-rename', acc.username, `${b.path} -> ${b.new_name}`);
  res.json({ ok: true });
});

// Delete a file, or an EMPTY folder only — no recursive delete on purpose: this
// runs as a high-privilege service, and one mis-click must not erase a tree.
router.post('/users/:id/delete', (req, res) => {
  const acc = account(req, res);
  if (!acc) return;
  const b = req.body || {};
  let abs;
  try {
    abs = shares.safeJoin(acc.root_path, b.path);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (abs === fs.realpathSync(acc.root_path)) return res.status(400).json({ error: 'ลบ root ไม่ได้' });
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return res.status(404).json({ error: 'ไม่พบไฟล์/โฟลเดอร์' });
  }
  try {
    if (st.isDirectory()) {
      if (fs.readdirSync(abs).length > 0) {
        return res.status(400).json({ error: 'โฟลเดอร์ไม่ว่าง — ลบไฟล์ข้างในก่อน (กันลบพลาดยกทั้งก้อน)' });
      }
      fs.rmdirSync(abs);
    } else {
      fs.unlinkSync(abs);
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  audit(req.user, 'ftp-delete', acc.username, String(b.path));
  res.json({ ok: true });
});

module.exports = router;
