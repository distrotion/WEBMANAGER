'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./../db');
const { requireRole } = require('../auth');
const { audit } = require('../audit');

const router = express.Router();
router.use(requireRole('admin')); // all user management is admin-only

const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role, created_at: u.created_at });
const adminCount = () => db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY username').all();
  res.json(rows.map(publicUser));
});

router.post('/', (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    return res.status(400).json({ error: 'username may only contain letters, numbers, . _ - (no spaces)' });
  }
  if (String(password).length < 4) return res.status(400).json({ error: 'password too short (min 4)' });
  const r = role === 'admin' ? 'admin' : 'user';
  try {
    const info = db
      .prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)')
      .run(username, bcrypt.hashSync(password, 10), r);
    audit(req.user, 'create-user', username, r);
    res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid)));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'username already exists' });
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/password', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  const { password } = req.body || {};
  if (!password || String(password).length < 4) return res.status(400).json({ error: 'password too short (min 4)' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), u.id);
  audit(req.user, 'reset-password', u.username);
  res.json({ ok: true });
});

router.post('/:id/role', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  const role = req.body && req.body.role === 'admin' ? 'admin' : 'user';
  if (u.role === 'admin' && role !== 'admin' && adminCount() <= 1) {
    return res.status(400).json({ error: 'cannot demote the last admin' });
  }
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role, u.id);
  audit(req.user, 'set-role', u.username, role);
  res.json({ ok: true, role });
});

router.delete('/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (u.role === 'admin' && adminCount() <= 1) {
    return res.status(400).json({ error: 'cannot delete the last admin' });
  }
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  audit(req.user, 'delete-user', u.username);
  res.json({ ok: true });
});

module.exports = router;
