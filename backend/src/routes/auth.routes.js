'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { login, authMiddleware } = require('../auth');
const { audit } = require('../audit');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const result = login(username, password);
  if (!result) return res.status(401).json({ error: 'invalid credentials' });
  res.json(result);
});

// Any logged-in user can change their own password (needs the current one).
router.post('/change-password', authMiddleware, (req, res) => {
  const { current, next } = req.body || {};
  if (!next || String(next).length < 4) return res.status(400).json({ error: 'new password too short (min 4)' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!u || !bcrypt.compareSync(current || '', u.password_hash)) {
    return res.status(403).json({ error: 'current password is wrong' });
  }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(next, 10), u.id);
  audit(req.user, 'change-own-password', u.username);
  res.json({ ok: true });
});

module.exports = router;
