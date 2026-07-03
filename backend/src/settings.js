'use strict';
const db = require('./db');

function get(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : null;
}

function set(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, value);
}

function del(key) {
  db.prepare('DELETE FROM settings WHERE key=?').run(key);
}

module.exports = { get, set, del };
