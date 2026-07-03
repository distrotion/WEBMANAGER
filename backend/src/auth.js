'use strict';
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');

function seedAdmin() {
  const { c } = db.prepare('SELECT COUNT(*) c FROM users').get();
  if (c === 0) {
    const hash = bcrypt.hashSync(config.ADMIN_PASS, 10);
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)').run(
      config.ADMIN_USER,
      hash,
      'admin'
    );
    console.log(`[auth] seeded admin user '${config.ADMIN_USER}'`);
  }
}

function login(username, password) {
  if (!username || !password) return null;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return null;
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRES }
  );
  return { token, user: { id: user.id, username: user.username, role: user.role } };
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.JWT_SECRET);
  } catch {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'unauthorized' });
  req.user = payload;
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user && req.user.role === role) return next();
    return res.status(403).json({ error: 'forbidden' });
  };
}

module.exports = { seedAdmin, login, verifyToken, authMiddleware, requireRole };
