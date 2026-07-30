'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { login, authMiddleware } = require('../auth');
const { audit } = require('../audit');

const router = express.Router();

// Throttle password guessing. The panel ships with a known default admin
// password, so an unthrottled login endpoint is a short brute force. Counted per
// source IP + username; a success clears the counter.
const MAX_FAILS = 8;
const LOCK_MS = 5 * 60 * 1000;
const fails = new Map(); // key -> { n, until }

function attemptKey(req, username) {
  return `${req.socket.remoteAddress || '?'}|${String(username || '').toLowerCase()}`;
}

function lockedFor(key) {
  const rec = fails.get(key);
  if (!rec || !rec.until) return 0;
  if (Date.now() >= rec.until) {
    fails.delete(key);
    return 0;
  }
  return Math.ceil((rec.until - Date.now()) / 1000);
}

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const key = attemptKey(req, username);
  const wait = lockedFor(key);
  if (wait) {
    return res.status(429).json({ error: `too many failed attempts — try again in ${wait}s` });
  }
  const result = login(username, password);
  if (!result) {
    const rec = fails.get(key) || { n: 0, until: 0 };
    rec.n += 1;
    if (rec.n >= MAX_FAILS) {
      rec.until = Date.now() + LOCK_MS;
      rec.n = 0;
      audit({ username: String(username || '?') }, 'login-locked', req.socket.remoteAddress || '?');
    }
    fails.set(key, rec);
    return res.status(401).json({ error: 'invalid credentials' });
  }
  fails.delete(key);
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
