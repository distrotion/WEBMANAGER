'use strict';
const db = require('./db');

function audit(user, action, target, detail) {
  db.prepare('INSERT INTO audit (who, action, target, detail) VALUES (?,?,?,?)').run(
    (user && user.username) || 'system',
    action,
    target || null,
    detail != null ? String(detail) : null
  );
}

module.exports = { audit };
