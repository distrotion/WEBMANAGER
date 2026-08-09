'use strict';
// Uptime monitoring. Reads are open to any signed-in user — guard.js keeps the
// 'user' role useful as a monitoring view, and this page IS that view — but
// creating/editing/deleting a monitor (which can hold a database password) is
// admin-only, same split as everywhere else that touches a stored credential.
const express = require('express');
const db = require('../db');
const monitor = require('../monitor');
const secretbox = require('../secretbox');
const guard = require('../guard');
const settings = require('../settings');
const { audit } = require('../audit');

const router = express.Router();

const TYPES = new Set(['http', 'tcp', 'mssql', 'postgres', 'mongodb']);

const view = (m) => {
  const { password_enc, ...rest } = m;
  return {
    ...rest,
    enabled: !!m.enabled,
    ignore_tls_errors: !!m.ignore_tls_errors,
    public: !!m.public,
    hasPassword: !!password_enc,
    ...monitor.status(m.id),
    uptime: monitor.uptime(m.id),
    beats: monitor.heartbeats(m.id, 40),
  };
};

function getMonitor(id) {
  return db.prepare('SELECT * FROM monitors WHERE id=?').get(id);
}

// requirePassword only applies to database types — http/tcp never have one.
function validate(b, { requirePassword } = {}) {
  const name = String(b.name || '').trim();
  const type = String(b.type || '').trim();
  if (!name) return 'name required';
  if (!TYPES.has(type)) return `type must be one of: ${[...TYPES].join(', ')}`;
  if (/[\r\n\0]/.test(name)) return 'name may not contain newlines';

  if (type === 'http') {
    const url = String(b.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return 'url must start with http:// or https://';
    if (/[\r\n\0]/.test(url)) return 'url may not contain newlines';
  } else {
    const host = String(b.host || '').trim();
    if (!host) return 'host required';
    if (/[\r\n\0\s]/.test(host)) return 'host may not contain whitespace or newlines';
    const portErr = guard.port(b.port, 'port');
    if (portErr) return portErr;
    // tcpCheck() has no default port at all — a tcp monitor without one would
    // reach net.connect({host, port: undefined}) and fail cryptically instead
    // of being rejected here. Database types DO have sane defaults in their
    // check functions (1433/5432/27017), so this line used to (backwards)
    // require a port for every type EXCEPT tcp — exactly the one that needs it.
    if (type === 'tcp' && !b.port) return 'port required for a tcp check';
  }

  const isDbType = type === 'mssql' || type === 'postgres' || type === 'mongodb';
  const pw = String(b.password || '');
  if (isDbType && requirePassword && type !== 'mongodb' && !pw) {
    // Mongo on a LAN is very often unauthenticated by design; the other two
    // engines are not, so only they require a password up front.
    return 'password required for this database type';
  }

  const interval = parseInt(b.interval_sec, 10);
  if (b.interval_sec !== undefined) {
    if (!Number.isFinite(interval) || interval < 10 || interval > 86400) return 'interval_sec must be 10-86400';
    // Login attempts against a real database are expensive to the target and a
    // repeated-wrong-password hazard (same reasoning as netshare's backoff
    // ladder) — keep those checks from running faster than every 30s.
    if (isDbType && interval < 30) return 'interval_sec for a database monitor must be at least 30s';
  }
  const timeout = parseInt(b.timeout_ms, 10);
  if (b.timeout_ms !== undefined && (!Number.isFinite(timeout) || timeout < 500 || timeout > 60000)) {
    return 'timeout_ms must be 500-60000';
  }
  const failThreshold = parseInt(b.fail_threshold, 10);
  if (b.fail_threshold !== undefined && (!Number.isFinite(failThreshold) || failThreshold < 1 || failThreshold > 20)) {
    return 'fail_threshold must be 1-20';
  }

  // Daily schedule: "HH:MM" on the server's clock, replaces interval_sec.
  const dailyAt = String(b.daily_at || '').trim();
  if (dailyAt) {
    const hm = dailyAt.match(/^(\d{1,2}):(\d{2})$/);
    if (!hm || Number(hm[1]) > 23 || Number(hm[2]) > 59) return 'daily_at must look like HH:MM (00:00-23:59)';
  }

  // Drift check: same query on two servers, judged on the difference.
  const compareHost = String(b.compare_host || '').trim();
  if (compareHost) {
    if (!isDbType) return 'compare_host is only for database monitors';
    if (!String(b.check_query || '').trim()) return 'compare_host needs a check_query to compare';
    if (/[\r\n\0\s]/.test(compareHost)) return 'compare_host may not contain whitespace or newlines';
    const cpErr = guard.port(b.compare_port, 'compare_port');
    if (cpErr) return cpErr;
    // These queries scan tables (COUNT/CHECKSUM). Running one every minute
    // against production would be the monitor causing the problem it watches
    // for, so hold them to a slow cadence unless pinned to a daily slot.
    if (!dailyAt && Number(b.interval_sec || 0) < 600) {
      return 'a compare check must run no more often than every 600s — or set daily_at (e.g. 00:00)';
    }
  }

  // Custom query (e.g. a replication-health check) — database types only, must
  // be read-only, and if present needs a condition to judge its result by.
  const query = String(b.check_query || '').trim();
  if (query) {
    if (!isDbType) return 'check_query is only for database monitors';
    if (type === 'mongodb') return 'custom query is not supported for mongodb yet (use mssql/postgres)';
    const q = monitor.unsafeQuery(query);
    if (q) return q;
    const OPS = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains']);
    if (!OPS.has(String(b.expect_op || ''))) return `expect_op must be one of: ${[...OPS].join(', ')}`;
    if (b.expect_value === undefined || b.expect_value === null || b.expect_value === '') {
      return 'expect_value required when a custom query is set';
    }
  }
  return null;
}

// ---- reads: any signed-in user ----
router.get('/', (req, res) => res.json(db.prepare('SELECT * FROM monitors ORDER BY name').all().map(view)));

router.get('/:id/beats', (req, res) => {
  const m = getMonitor(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 200));
  res.json(monitor.heartbeats(m.id, limit));
});

// Report: every recorded run, newest first, with the detail line. A daily drift
// check produces one row a day, so the point of it is the history — "were the
// two databases equal each night for the last month" is a question the
// heartbeat bar cannot answer but this can. ?format=csv downloads it.
router.get('/:id/report', (req, res) => {
  const m = getMonitor(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
  const since = Date.now() - days * 24 * 3600_000;
  const rows = db
    .prepare('SELECT ok, ms, error, ts FROM monitor_checks WHERE monitor_id=? AND ts>=? ORDER BY ts DESC LIMIT 5000')
    .all(m.id, since);

  if (req.query.format === 'csv') {
    // Quote every field and double internal quotes — an error line legitimately
    // contains commas and quotes ("got 5, expected eq 0").
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['time,result,ms,detail']
      .concat(rows.map((r) => [q(new Date(r.ts).toLocaleString()), q(r.ok ? 'OK' : 'FAIL'), q(r.ms ?? ''), q(r.error ?? '')].join(',')))
      .join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${m.name.replace(/[^\w.-]/g, '_')}-report.csv"`);
    return res.send('﻿' + csv); // BOM so Excel opens Thai text correctly
  }

  const failed = rows.filter((r) => !r.ok).length;
  res.json({
    name: m.name,
    days,
    total: rows.length,
    failed,
    passed: rows.length - failed,
    rows,
  });
});

// ---- public status page switch (admin) ----
// Off by default. Turning it on exposes /status and /api/public/status to anyone
// who can reach this port, showing only monitors individually flagged public.
// Declared BEFORE the /:id routes: Express matches in order, so a literal path
// registered after '/:id' would be swallowed by it ("public-page" read as an id).
router.get('/public-page', guard.adminOnly, (req, res) => {
  res.json({
    enabled: settings.get('public_status_enabled') === '1',
    count: db.prepare('SELECT COUNT(*) c FROM monitors WHERE public=1').get().c,
  });
});

router.put('/public-page', guard.adminOnly, (req, res) => {
  const on = !!(req.body && req.body.enabled);
  settings.set('public_status_enabled', on ? '1' : '0');
  audit(req.user, 'monitor-public-page', on ? 'enabled' : 'disabled');
  res.json({ enabled: on });
});

// Flip the public flag on every monitor at once. Auto-create makes dozens of
// monitors in one click, so requiring the operator to open and tick each one
// would be the difference between using the status page and not bothering.
router.put('/public-all', guard.adminOnly, (req, res) => {
  const on = !!(req.body && req.body.public);
  const r = db.prepare('UPDATE monitors SET public=?').run(on ? 1 : 0);
  audit(req.user, 'monitor-public-all', on ? 'show all' : 'hide all', `${r.changes} monitors`);
  res.json({ changed: r.changes, public: on });
});

// ---- writes: admin only ----
router.post('/', guard.adminOnly, (req, res) => {
  const b = req.body || {};
  const err = validate(b, { requirePassword: true });
  if (err) return res.status(400).json({ error: err });
  const info = db
    .prepare(
      `INSERT INTO monitors
       (name, type, enabled, interval_sec, timeout_ms, fail_threshold, url, host, port,
        username, password_enc, database_name, ignore_tls_errors, check_query, expect_op, expect_value,
        compare_host, compare_port, daily_at, public, site_id)
       VALUES (@name,@type,@enabled,@interval_sec,@timeout_ms,@fail_threshold,@url,@host,@port,
        @username,@password_enc,@database_name,@ignore_tls_errors,@check_query,@expect_op,@expect_value,
        @compare_host,@compare_port,@daily_at,@public,@site_id)`
    )
    .run({
      name: String(b.name).trim(),
      type: b.type,
      enabled: b.enabled === false ? 0 : 1,
      interval_sec: parseInt(b.interval_sec, 10) || 60,
      timeout_ms: parseInt(b.timeout_ms, 10) || 10000,
      fail_threshold: parseInt(b.fail_threshold, 10) || 3,
      url: b.type === 'http' ? String(b.url || '').trim() : null,
      host: b.type !== 'http' ? String(b.host || '').trim() : null,
      port: b.port ? Number(b.port) : null,
      username: b.username ? String(b.username).trim() : null,
      password_enc: b.password ? secretbox.encrypt(b.password) : null,
      database_name: b.database_name ? String(b.database_name).trim() : null,
      ignore_tls_errors: b.ignore_tls_errors ? 1 : 0,
      check_query: b.check_query ? String(b.check_query).trim() : null,
      expect_op: b.check_query ? b.expect_op : null,
      expect_value: b.check_query ? String(b.expect_value) : null,
      compare_host: b.compare_host ? String(b.compare_host).trim() : null,
      compare_port: b.compare_port ? Number(b.compare_port) : null,
      daily_at: b.daily_at ? String(b.daily_at).trim() : null,
      public: b.public ? 1 : 0,
      site_id: b.site_id || null,
    });
  const row = getMonitor(info.lastInsertRowid);
  audit(req.user, 'monitor-create', row.name, `${row.type} ${row.url || `${row.host}:${row.port}`}`);
  // Kick a first check so the operator sees a result immediately instead of
  // waiting for the scheduler — but NOT for a monitor pinned to a wall-clock
  // slot: those exist precisely because their query is too heavy to run at an
  // arbitrary moment, and the Test button already covers "did I configure this
  // right". Saving one must not fire a table scan at production on the spot.
  if (!row.daily_at) monitor.runCheck(row).catch(() => {});
  res.status(201).json(view(getMonitor(row.id)));
});

const FIELDS = [
  'name', 'type', 'enabled', 'interval_sec', 'timeout_ms', 'fail_threshold',
  'url', 'host', 'port', 'username', 'database_name', 'ignore_tls_errors',
  'check_query', 'expect_op', 'expect_value', 'public',
  'compare_host', 'compare_port', 'daily_at',
];

router.put('/:id', guard.adminOnly, (req, res) => {
  const row = getMonitor(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const merged = { ...row, ...b };
  const err = validate(merged, { requirePassword: false });
  if (err) return res.status(400).json({ error: err });

  const sets = [];
  const vals = { id: row.id };
  for (const f of FIELDS) {
    if (f in b) {
      sets.push(`${f}=@${f}`);
      let v = b[f];
      if (typeof v === 'boolean') v = v ? 1 : 0;
      else if (['port', 'interval_sec', 'timeout_ms', 'fail_threshold'].includes(f) && v !== null && v !== '') v = Number(v);
      vals[f] = v;
    }
  }
  // Blank password field means "keep the stored one" — same contract as
  // netshares.routes.js:99, the UI can never echo the real value back to edit.
  if (b.password) {
    sets.push('password_enc=@password_enc');
    vals.password_enc = secretbox.encrypt(b.password);
  }
  if (sets.length) db.prepare(`UPDATE monitors SET ${sets.join(', ')} WHERE id=@id`).run(vals);
  audit(req.user, 'monitor-update', merged.name);
  // A config change invalidates the current schedule slot — recheck promptly
  // rather than waiting up to interval_sec for a stale interval to expire.
  // Same exception as create: a wall-clock monitor keeps its slot, so editing
  // its name does not touch the database it watches.
  const updated = getMonitor(row.id);
  if (!updated.daily_at) monitor.runCheck(updated).catch(() => {});
  res.json(view(getMonitor(row.id)));
});

router.delete('/:id', guard.adminOnly, (req, res) => {
  const row = getMonitor(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM monitors WHERE id=?').run(row.id);
  db.prepare('DELETE FROM monitor_checks WHERE monitor_id=?').run(row.id);
  monitor.forget(row.id);
  audit(req.user, 'monitor-delete', row.name);
  res.json({ ok: true });
});

// Force an immediate check outside the schedule (the "เช็คตอนนี้" button). Unlike
// the fire-and-forget runCheck() calls in POST/PUT above, this one is awaited —
// the whole point is to show the result — so a rejection here must not leave
// the request hanging with no response.
router.post('/:id/run', guard.adminOnly, async (req, res) => {
  const row = getMonitor(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  try {
    await monitor.runCheck(row);
    res.json(view(getMonitor(row.id)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Try a config without saving it.
router.post('/test', guard.adminOnly, async (req, res) => {
  const b = req.body || {};
  // Password is required only when there is no stored one to fall back to —
  // same rule PUT already uses (blank password = keep/reuse existing). Without
  // this, "tweak the host, then test with my already-saved password" — the
  // whole reason the id-based fallback below exists — would 400 before ever
  // reaching it.
  const err = validate(b, { requirePassword: !b.id });
  if (err) return res.status(400).json({ error: err });
  let passwordEnc = null;
  if (b.password) {
    passwordEnc = secretbox.encrypt(b.password);
  } else if (b.id) {
    // Editing with a blank password means "reuse the stored one" — but the
    // stored row must actually be the SAME target. Without this check, id
    // could name any monitor in the system and its decrypted credential would
    // be sent to whatever host/port this request specifies, which is exactly
    // the write-only-password invariant every other credential feature in
    // this app (netshare, git creds) is built to prevent.
    const stored = getMonitor(b.id);
    if (stored && stored.type === b.type) passwordEnc = stored.password_enc || null;
  }
  const r = await monitor.probe({ ...b, password_enc: passwordEnc, password: undefined });
  audit(req.user, 'monitor-test', b.name || '(test)', r.ok ? 'ok' : 'failed');
  res.json(r);
});

// Auto-create an http monitor for every site that has a direct_port and does
// not already have one (site_id makes this idempotent — safe to click twice).
router.post('/from-sites', guard.adminOnly, (req, res) => {
  const sites = db.prepare('SELECT id, name, direct_port FROM sites WHERE direct_port IS NOT NULL').all();
  const already = new Set(db.prepare('SELECT site_id FROM monitors WHERE site_id IS NOT NULL').all().map((r) => r.site_id));
  const insert = db.prepare(
    `INSERT INTO monitors (name, type, url, interval_sec, site_id) VALUES (?, 'http', ?, 60, ?)`
  );
  let created = 0;
  for (const s of sites) {
    if (already.has(s.id)) continue;
    insert.run(s.name, `http://127.0.0.1:${s.direct_port}/`, s.id);
    created++;
  }
  audit(req.user, 'monitor-from-sites', `${created} created`, `${sites.length - created} already had one`);
  res.json({ created, skipped: sites.length - created });
});

module.exports = router;
