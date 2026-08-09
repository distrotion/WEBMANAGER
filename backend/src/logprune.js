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

// monitor_checks is its own, much higher-volume table (a check every 10-60s per
// monitor vs. one deploy event) and needs its window to actually cover the
// uptime page's 30-day view, so it gets a separate day-based knob instead of
// sharing log_retention_months.
function monitorRetentionDays() {
  const d = parseInt(settings.get('monitor_retention_days'), 10);
  return d > 0 ? d : 35; // default: keep 35 days (covers the 30d uptime window)
}
function setMonitorRetentionDays(d) {
  settings.set('monitor_retention_days', String(Math.max(1, parseInt(d, 10) || 35)));
}

// Delete logs older than `months` — from both the console logs and the
// auto-deploy history (same retention covers both). Returns rows removed.
function pruneOlderThan(months) {
  const m = Math.max(1, parseInt(months, 10) || retentionMonths());
  const cutoff = `-${m} months`;
  const a = db.prepare("DELETE FROM logs WHERE ts < datetime('now', ?)").run(cutoff);
  const b = db.prepare("DELETE FROM autodeploy_log WHERE ts < datetime('now', ?)").run(cutoff);
  return a.changes + b.changes;
}

// Same idea, epoch-ms cutoff, one DELETE per monitor so the composite
// (monitor_id, ts) index is used instead of a full-table scan.
function pruneMonitorChecks(days) {
  const d = Math.max(1, parseInt(days, 10) || monitorRetentionDays());
  const cutoff = Date.now() - d * 24 * 3600_000;
  const ids = db.prepare('SELECT id FROM monitors').all();
  const stmt = db.prepare('DELETE FROM monitor_checks WHERE monitor_id=? AND ts<?');
  let changes = 0;
  for (const { id } of ids) changes += stmt.run(id, cutoff).changes;
  return changes;
}

// Ran on a timer: prune to the configured retention if auto-prune is on.
function autoPrune() {
  let n = 0;
  if (autoPruneEnabled()) n += pruneOlderThan(retentionMonths());
  n += pruneMonitorChecks(monitorRetentionDays());
  return n;
}

module.exports = {
  retentionMonths,
  autoPruneEnabled,
  setRetentionMonths,
  setAutoPrune,
  pruneOlderThan,
  monitorRetentionDays,
  setMonitorRetentionDays,
  pruneMonitorChecks,
  autoPrune,
};
