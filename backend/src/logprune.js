'use strict';
const db = require('./db');
const settings = require('./settings');

// Log retention is configurable: keep the last N months, delete older.
function retentionMonths() {
  const m = parseInt(settings.get('log_retention_months'), 10);
  return m > 0 ? m : 3; // default: keep 3 months
}
function autoPruneEnabled() {
  return settings.get('log_autoprune') !== '0'; // default: on
}

function setRetentionMonths(m) {
  settings.set('log_retention_months', String(Math.max(1, parseInt(m, 10) || 3)));
}
function setAutoPrune(on) {
  settings.set('log_autoprune', on ? '1' : '0');
}

// Delete logs older than `months`. Returns how many rows were removed.
function pruneOlderThan(months) {
  const m = Math.max(1, parseInt(months, 10) || retentionMonths());
  const info = db.prepare("DELETE FROM logs WHERE ts < datetime('now', ?)").run(`-${m} months`);
  return info.changes;
}

// Ran on a timer: prune to the configured retention if auto-prune is on.
function autoPrune() {
  if (autoPruneEnabled()) return pruneOlderThan(retentionMonths());
  return 0;
}

module.exports = {
  retentionMonths,
  autoPruneEnabled,
  setRetentionMonths,
  setAutoPrune,
  pruneOlderThan,
  autoPrune,
};
