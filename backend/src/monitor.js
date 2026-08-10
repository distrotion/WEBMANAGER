'use strict';
// Uptime monitoring for anything worth watching — not only sites this manager
// deploys, but any URL/port/database on the network. Motivating bug: a database
// can hold its TCP port open while rejecting every login (wrong password,
// account lockout), so a plain port check reports green on something nothing
// can actually use — a monitor of type mssql/mongodb/postgres has to log in and
// run a trivial query, not just connect.
//
// Scheduler shape follows netshare.js (module-level state Map keyed by row id,
// status()/forget() accessors, start() called once from server.js) but diverges
// on one point: netshare sweeps every row on one shared 60s tick because SMB
// sessions are per-SERVER and have to be coordinated. Monitors are independent —
// each keeps its own interval_sec, so this is a real per-item scheduler: a 1s
// driver tick picks whichever rows are due and runs them in parallel, and a slow
// check never delays anyone else's.
const httpMod = require('http');
const httpsMod = require('https');
const net = require('net');
const { URL } = require('url');
const db = require('./db');
const secretbox = require('./secretbox');
const settings = require('./settings');
const { emitLog } = require('./logbus');
const notify = require('./notify');

const state = new Map(); // monitor id -> { up, ok, ms, error, checkedAt, fails, nextDueAt, running, lastChangeAt }
const uptimeCache = new Map(); // monitor id -> { at, value }
const UPTIME_TTL_MS = 60_000;

// Cached prepared statements — this table takes one insert per check per
// monitor, the only genuinely hot write path in the app (logbus.js:12 is the
// only other precedent for caching one).
const insertCheck = db.prepare('INSERT INTO monitor_checks (monitor_id, ok, ms, error, ts) VALUES (?,?,?,?,?)');
const monitorExists = db.prepare('SELECT 1 FROM monitors WHERE id=?');

function rows() {
  return db.prepare('SELECT * FROM monitors').all();
}

function setState(id, patch) {
  state.set(id, { ...(state.get(id) || {}), ...patch });
}

function status(id) {
  return (
    state.get(id) || {
      up: null,
      error: 'not checked yet',
      checkedAt: null,
      fails: 0,
      nextDueAt: null,
    }
  );
}

function forget(id) {
  state.delete(id);
  uptimeCache.delete(id);
}

// Last N checks, oldest first — what the heartbeat bar renders.
function heartbeats(id, limit = 40) {
  return db
    .prepare('SELECT ok, ms, error, ts FROM monitor_checks WHERE monitor_id=? ORDER BY id DESC LIMIT ?')
    .all(id, limit)
    .reverse();
}

// Uptime % over 24h/7d/30d in one indexed range scan, cached briefly — the list
// page polls every few seconds and does not need a fresh aggregate every time.
function uptime(id) {
  const cached = uptimeCache.get(id);
  if (cached && Date.now() - cached.at < UPTIME_TTL_MS) return cached.value;
  const now = Date.now();
  const d1 = now - 24 * 3600_000;
  const d7 = now - 7 * 24 * 3600_000;
  const d30 = now - 30 * 24 * 3600_000;
  const row = db
    .prepare(
      `SELECT
         COUNT(*) t30, SUM(ok) u30,
         SUM(CASE WHEN ts>=@d7 THEN 1 ELSE 0 END) t7,  SUM(CASE WHEN ts>=@d7  THEN ok ELSE 0 END) u7,
         SUM(CASE WHEN ts>=@d1 THEN 1 ELSE 0 END) t1,  SUM(CASE WHEN ts>=@d1  THEN ok ELSE 0 END) u1
       FROM monitor_checks WHERE monitor_id=@id AND ts>=@d30`
    )
    .get({ id, d1, d7, d30 });
  const pct = (u, t) => (t ? Math.round((u / t) * 1000) / 10 : null); // null = no data yet
  const value = {
    d1: pct(row.u1, row.t1),
    d7: pct(row.u7, row.t7),
    d30: pct(row.u30, row.t30),
  };
  uptimeCache.set(id, { at: Date.now(), value });
  return value;
}

// ---- checks --------------------------------------------------------------

function httpCheck(m, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(m.url);
    } catch {
      return resolve({ ok: false, error: 'invalid url' });
    }
    const mod = u.protocol === 'https:' ? httpsMod : httpMod;
    const t0 = Date.now();
    const req = mod.get(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        timeout: timeoutMs,
        // Verify by default — a monitor on a real public endpoint SHOULD go red
        // when its certificate expires or a MITM swaps it; that is a legitimate
        // thing to be alerted about, not noise. Only skip verification when the
        // operator explicitly says so (e.g. this manager's own local-CA front,
        // or another self-signed LAN endpoint they already trust) — a per-
        // monitor opt-in, never a blanket default.
        rejectUnauthorized: !m.ignore_tls_errors,
      },
      (res) => {
        res.resume(); // drain so the socket frees promptly
        const ms = Date.now() - t0;
        // Same rule as the deploy health gate (health.js:16): an API
        // legitimately 404s on '/'. Only 5xx/refused/timeout count as down.
        if (res.statusCode < 500) resolve({ ok: true, ms });
        else resolve({ ok: false, ms, error: `HTTP ${res.statusCode}` });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

function tcpCheck(m, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host: m.host, port: m.port });
    const done = (result) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(timeoutMs, () => done({ ok: false, error: 'timeout' }));
    sock.once('connect', () => done({ ok: true, ms: Date.now() - t0 }));
    sock.once('error', (e) => done({ ok: false, error: e.message }));
  });
}

// Lazy driver loading: mssql/mongodb/pg are only required if a monitor of that
// type actually exists, so a plain HTTP/TCP install never pays for them, and a
// missing driver degrades one monitor to a clear red error instead of crashing
// the server at boot.
const drivers = {};
function requireDriver(name) {
  if (drivers[name]) return drivers[name];
  try {
    // eslint-disable-next-line import/no-dynamic-require
    return (drivers[name] = require(name));
  } catch {
    throw new Error(`"${name}" driver not installed — run npm install in backend/`);
  }
}

function monitorPassword(m) {
  if (!m.password_enc) return '';
  const pw = secretbox.decrypt(m.password_enc);
  if (pw === null) throw new Error('stored password could not be decrypted — re-enter it');
  return pw;
}

// A database monitor can carry a custom query (e.g. a replication-health check).
// It runs every interval, so it MUST be read-only — reject anything that is not
// a plain SELECT/WITH read or a monitoring EXEC. This is not a full SQL parser
// (an admin with the stored credential could do damage regardless), just a
// guard against an accidental UPDATE/DELETE/DROP sitting in a monitor that fires
// on a timer. Returns an error string, or null when the query is acceptable.
function unsafeQuery(q) {
  const s = String(q || '').trim();
  if (!s) return null; // empty = use the default liveness probe
  if (s.includes(';')) return 'query must be a single statement (no ";")';
  if (!/^(select|with|exec\b|execute\b)/i.test(s)) return 'query must start with SELECT, WITH, or EXEC';
  if (/\b(insert|update|delete|drop|truncate|alter|create|merge|grant|revoke)\b/i.test(s)) {
    return 'query may only read — INSERT/UPDATE/DELETE/DROP/ALTER etc. are not allowed';
  }
  return null;
}

// Compare a query's first scalar result against the monitor's condition. Numbers
// are compared numerically when both sides parse as numbers; otherwise string.
function evaluateCondition(value, op, expected) {
  const nv = Number(value);
  const ne = Number(expected);
  const bothNum = Number.isFinite(nv) && Number.isFinite(ne);
  switch (op) {
    case 'eq': return bothNum ? nv === ne : String(value) === String(expected);
    case 'ne': return bothNum ? nv !== ne : String(value) !== String(expected);
    case 'lt': return bothNum && nv < ne;
    case 'lte': return bothNum && nv <= ne;
    case 'gt': return bothNum && nv > ne;
    case 'gte': return bothNum && nv >= ne;
    case 'contains': return String(value).toLowerCase().includes(String(expected).toLowerCase());
    default: return false;
  }
}

// Given the first cell of a query result and the monitor's expected condition,
// produce a {ok, ms, error} result. Used by every database check.
function judgeQueryResult(m, firstCell, ms) {
  if (!m.check_query) return { ok: true, ms }; // liveness only, no condition
  const passed = evaluateCondition(firstCell, m.expect_op, m.expect_value);
  if (passed) return { ok: true, ms };
  return {
    ok: false,
    ms,
    error: `check failed: got ${JSON.stringify(firstCell)}, expected ${m.expect_op} ${JSON.stringify(m.expect_value)}`,
  };
}

// Extract the first column of the first row from a driver's result shape.
function firstCellMssql(res) {
  const row = res.recordset && res.recordset[0];
  return row ? row[Object.keys(row)[0]] : null;
}
function firstCellPg(res) {
  const row = res.rows && res.rows[0];
  return row ? row[Object.keys(row)[0]] : null;
}

// Drift check: the same query ran on two servers, judged on how far apart the
// answers are. Numbers compare by absolute difference so a condition like
// "lte 5" means "allowed to be 5 rows behind"; anything else compares for exact
// equality (0 = identical, 1 = different) so a checksum or a string still works
// with the natural "eq 0".
const where = (host, port) => (port ? `${host}:${port}` : `${host}`);

function judgeComparison(m, a, b, ms) {
  const na = Number(a);
  const nb = Number(b);
  const diff = Number.isFinite(na) && Number.isFinite(nb) ? Math.abs(na - nb) : String(a) === String(b) ? 0 : 1;
  if (evaluateCondition(diff, m.expect_op, m.expect_value)) {
    return { ok: true, ms };
  }
  return {
    ok: false,
    ms,
    // Name each side by host:port when a port is known — comparing two
    // instances on one host is a legitimate setup, and "127.0.0.1=1000 vs
    // 127.0.0.1=997" tells the reader nothing. The port is optional for
    // database types (the driver has a default), so leave it out when unset
    // rather than printing "host:null".
    error:
      `ข้อมูลไม่ตรงกัน: ${where(m.host, m.port)}=${JSON.stringify(a)}` +
      ` vs ${where(m.compare_host, m.compare_port || m.port)}=${JSON.stringify(b)}` +
      ` (ต่างกัน ${diff}, เงื่อนไข ${m.expect_op} ${m.expect_value})`,
  };
}

// Run one query against one MSSQL host and return its first cell.
async function mssqlQuery(m, host, port, timeoutMs) {
  const sql = requireDriver('mssql');
  const pool = new sql.ConnectionPool({
    server: host,
    port: port || 1433,
    user: m.username || undefined,
    password: monitorPassword(m),
    database: m.database_name || 'master',
    connectionTimeout: timeoutMs,
    requestTimeout: timeoutMs,
    options: { encrypt: false, trustServerCertificate: true },
  });
  try {
    await pool.connect();
    const res = await pool.request().query(m.check_query || 'SELECT 1');
    return m.check_query ? firstCellMssql(res) : 1;
  } finally {
    await pool.close().catch(() => {});
  }
}

async function mssqlCheck(m, timeoutMs) {
  const t0 = Date.now();
  if (m.compare_host) {
    // Both sides in parallel: a drift check would otherwise take twice as long
    // as its timeout budget allows, and the two servers are independent.
    const [a, b] = await Promise.all([
      mssqlQuery(m, m.host, m.port, timeoutMs),
      mssqlQuery(m, m.compare_host, m.compare_port || m.port, timeoutMs),
    ]);
    return judgeComparison(m, a, b, Date.now() - t0);
  }
  const value = await mssqlQuery(m, m.host, m.port, timeoutMs);
  return judgeQueryResult(m, value, Date.now() - t0);
}

// Run one query against one PostgreSQL host and return its first cell.
async function postgresQuery(m, host, port, timeoutMs) {
  const { Client } = requireDriver('pg');
  const client = new Client({
    host,
    port: port || 5432,
    user: m.username || undefined,
    password: monitorPassword(m),
    database: m.database_name || 'postgres',
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  try {
    await client.connect();
    const res = await client.query(m.check_query || 'SELECT 1');
    return m.check_query ? firstCellPg(res) : 1;
  } finally {
    await client.end().catch(() => {});
  }
}

async function postgresCheck(m, timeoutMs) {
  const t0 = Date.now();
  if (m.compare_host) {
    // Same shape as mssqlCheck: both sides in parallel, judged on the
    // difference. Without this branch a Postgres drift monitor saves happily
    // and then only ever queries the first host — judging one server's number
    // against a condition written for a difference, which passes or fails for
    // reasons that have nothing to do with whether the two agree.
    const [a, b] = await Promise.all([
      postgresQuery(m, m.host, m.port, timeoutMs),
      postgresQuery(m, m.compare_host, m.compare_port || m.port, timeoutMs),
    ]);
    return judgeComparison(m, a, b, Date.now() - t0);
  }
  const value = await postgresQuery(m, m.host, m.port, timeoutMs);
  return judgeQueryResult(m, value, Date.now() - t0);
}

async function mongoCheck(m, timeoutMs) {
  const { MongoClient } = requireDriver('mongodb');
  const t0 = Date.now();
  const auth = m.username ? { auth: { username: m.username, password: monitorPassword(m) }, authSource: m.database_name || 'admin' } : {};
  const client = new MongoClient(`mongodb://${m.host}:${m.port || 27017}`, {
    serverSelectionTimeoutMS: timeoutMs,
    connectTimeoutMS: timeoutMs,
    directConnection: true,
    ...auth,
  });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return { ok: true, ms: Date.now() - t0 };
  } finally {
    await client.close().catch(() => {});
  }
}

const CHECKS = { http: httpCheck, tcp: tcpCheck, mssql: mssqlCheck, postgres: postgresCheck, mongodb: mongoCheck };

function target(m) {
  return m.type === 'http' ? m.url : `${m.host}:${m.port}`;
}

// When the next run is due. A monitor with daily_at runs at that wall-clock time
// once a day; everything else runs interval_sec after the run that just ended
// (measured from completion, so a slow check can never stack on itself).
function nextDue(m, from = Date.now()) {
  const at = String(m.daily_at || '').trim();
  const hm = at.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date(from);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    // Already past today — schedule tomorrow. Using the local clock on purpose:
    // "midnight" means midnight where the plant is, and this is what an operator
    // sees on the server's own clock.
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return from + Math.max(10, m.interval_sec || 60) * 1000;
}

// Run one type-appropriate check without saving anything — the Test button.
async function probe(cfg) {
  const fn = CHECKS[cfg.type];
  if (!fn) return { ok: false, error: `unknown monitor type "${cfg.type}"` };
  try {
    return await fn(cfg, Math.max(1000, cfg.timeout_ms || 10000));
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- transition / alert ---------------------------------------------------

// A database check that is being REJECTED (as opposed to unreachable) must not
// keep hammering the login. netshare.js learned this the hard way: a domain
// account replaying a wrong password gets locked out, and at the 30s floor a
// database monitor would try 2,880 times a day. The irony is direct — this
// monitor type exists because a rejected login is invisible to a port check,
// and left unthrottled it becomes the thing that locks the account.
//
// Only credential REJECTION backs off. A refused connection or a timeout means
// the server is down, and that must keep being checked at the normal interval
// so recovery is noticed promptly.
// Indexed by how many rejections there have been PAST the monitor's own
// fail_threshold. Backing off from the very first rejection would delay the
// alert by the length of the ladder — with the default threshold of 3 the
// operator would learn about a wrong password twenty minutes late. So the first
// fail_threshold attempts run at the normal interval (the alert fires on time),
// and only after the monitor is already declared down does it stop hammering,
// since a rejected credential needs a human either way. An operator who sets
// fail_threshold to 1 gets the strict behaviour with no extra knob.
const AUTH_BACKOFF_MS = [0, 5 * 60_000, 15 * 60_000, 30 * 60_000];
const authBackoffFor = (rejectionsPastThreshold) =>
  AUTH_BACKOFF_MS[Math.min(Math.max(0, rejectionsPastThreshold), AUTH_BACKOFF_MS.length - 1)];

// Driver wording differs per engine: mssql "Login failed for user"/ELOGIN,
// postgres "password authentication failed for user", mongodb "Authentication
// failed."
function isAuthRejection(error) {
  return /login failed|authentication failed|ELOGIN|not authorized|auth(?:entication)? error/i.test(String(error || ''));
}

function humanDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}

function recordResult(m, result, prev) {
  const now = Date.now();
  const ok = !!result.ok;
  const error = result.error ? String(result.error).slice(0, 300) : null;
  // A monitor deleted while its check was in flight must not resurrect a state
  // Map entry that forget() already cleared on delete — check once, reuse for
  // both the insert and every write-back below.
  const exists = !!monitorExists.get(m.id);
  if (exists) insertCheck.run(m.id, ok ? 1 : 0, result.ms ?? null, error, now);
  uptimeCache.delete(m.id);
  if (!exists) return;

  const fails = ok ? 0 : (prev.fails || 0) + 1;
  // Counted separately from `fails`: that one drives the up/down badge, this one
  // only decides how long to wait before offering the same credential again.
  const authFails = !ok && isAuthRejection(error) ? (prev.authFails || 0) + 1 : 0;
  // Debounce: a single blip does not flip the badge or fire an alert — only
  // fail_threshold CONSECUTIVE failures count as "down". Recovery is immediate
  // on the first success, same asymmetry as the netshare backoff ladder (an
  // outage should be slow to declare, fast to clear).
  let up = prev.up;
  if (ok) up = true;
  else if (fails >= (m.fail_threshold || 3)) up = false;

  const changed = prev.up !== up && (up === true || up === false);
  const lastChangeAt = changed ? now : prev.lastChangeAt || now;
  setState(m.id, { up, ok, ms: result.ms ?? null, error, checkedAt: now, fails, authFails, lastChangeAt, running: false });

  // A brand-new monitor's first-ever result is never a transition worth
  // announcing AS a transition, but the two directions differ: settling on
  // "up" first is just the initial state (nothing recovered, stay silent);
  // settling on "down" first is new, useful information (an operator who just
  // pointed a monitor at something broken should be told on day one, not only
  // on the next flip) — so only null->true is suppressed, null->false alerts
  // like any other transition.
  const silentFirstUp = prev.up === null && up === true;
  if (changed && !silentFirstUp) {
    if (up === false) {
      emitLog('system', `[monitor] "${m.name}" DOWN — ${error || 'check failed'} (${fails}x)`);
      notify.fire({ ok: false, text: `monitor DOWN: ${m.name} (${target(m)}) — ${error || 'check failed'}` });
    } else {
      emitLog('system', `[monitor] "${m.name}" back UP after ${humanDuration(now - (prev.lastChangeAt || now))}`);
      notify.fire({ ok: true, text: `monitor UP: ${m.name} — recovered after ${humanDuration(now - (prev.lastChangeAt || now))}` });
    }
  }
  // else: first-ever check for a brand-new monitor (prev.up === null) — record
  // state silently, nothing to have "recovered" or "gone down" from yet.
}

async function runCheck(m) {
  // The guard lives HERE, not just in tick()'s dispatch loop — tick() is the
  // only caller that checks `running` before calling in, but routes.js also
  // calls runCheck() directly (create, edit, the "run now" button), and a
  // second concurrent call for the same monitor would race two `prev`
  // snapshots against one `fails` counter and could double-fire an alert.
  // Centralising the check here protects every caller uniformly.
  if ((state.get(m.id) || {}).running) return;
  // Snapshot the logical previous state BEFORE mutating it with running:true —
  // state.get(m.id) below would otherwise return {running:true} instead of the
  // "never checked" default, turning prev.up from null into undefined and
  // defeating the brand-new-monitor guard in recordResult (undefined !== null).
  const prev = state.get(m.id) || { fails: 0, up: null, lastChangeAt: Date.now() };
  setState(m.id, { running: true });
  const timeoutMs = Math.max(1000, m.timeout_ms || 10000);
  try {
    const fn = CHECKS[m.type];
    const result = fn
      ? await Promise.race([
          fn(m, timeoutMs).catch((e) => ({ ok: false, error: e.message })),
          new Promise((r) => setTimeout(() => r({ ok: false, error: 'check did not return in time' }), timeoutMs + 2000)),
        ])
      : { ok: false, error: `unknown monitor type "${m.type}"` };
    recordResult(m, result, prev);
  } finally {
    // Any early-return above already set running:false via recordResult; this
    // covers the one path that cannot reach it (monitor deleted mid-check —
    // recordResult's own exists-guard returns before touching state at all).
    const st = state.get(m.id);
    if (st && st.running) setState(m.id, { running: false });
    if (monitorExists.get(m.id)) {
      // Never earlier than the normal schedule; later while a credential keeps
      // being rejected. The "run now" button calls in here directly and does not
      // consult nextDueAt, so an operator who has just fixed the password is
      // never made to wait out the ladder.
      const authFails = (state.get(m.id) || {}).authFails || 0;
      const wait = authBackoffFor(authFails - (m.fail_threshold || 3) + 1);
      setState(m.id, { nextDueAt: Math.max(nextDue(m), Date.now() + wait) });
    }
  }
}

// Sync sweep, runs every second: pick whatever is due, launch it, move on.
// Never awaits a check — a slow database timing out must not delay every other
// monitor's tick. Overlap with itself is prevented by the `running` flag (both
// here and, authoritatively, inside runCheck() itself).
function tick() {
  // setInterval's callback has no error boundary of its own — an uncaught
  // synchronous throw here (a locked/corrupt DB, a disk-full write) would not
  // just skip one tick, it would surface as an unhandled exception and could
  // take the whole manager process down, not only monitoring. Every other
  // scheduler in this codebase (gateway.js, netshare.js) is wrapped the same
  // way at its call site; tick() guards itself since it IS the call site.
  try {
    const now = Date.now();
    for (const m of rows()) {
      if (!m.enabled) {
        const st = state.get(m.id);
        if (!st || st.up !== null || st.error !== 'disabled') {
          setState(m.id, { up: null, error: 'disabled', checkedAt: now, fails: 0, running: false });
        }
        continue;
      }
      const st = state.get(m.id) || {};
      if (st.running) continue;
      if (st.nextDueAt === undefined && m.daily_at) {
        // First sight of a daily monitor: park it on its next wall-clock slot
        // rather than running it at whatever time it happened to be created.
        setState(m.id, { nextDueAt: nextDue(m) });
        continue;
      }
      if (st.nextDueAt && now < st.nextDueAt) continue;
      runCheck(m).catch(() => {});
    }
  } catch (e) {
    emitLog('system', `[monitor] scheduler tick error: ${e.message}`);
  }
}

// Seed in-memory state from the last recorded check per monitor, so a manager
// restart does not fire a false "recovered" alert (unknown -> up) or re-alert
// an outage that was already known before the restart.
function seed() {
  const byId = new Map(rows().map((m) => [m.id, m]));
  const last = db
    .prepare(
      `SELECT c.monitor_id, c.ok, c.error, c.ts
       FROM monitor_checks c
       JOIN (SELECT monitor_id, MAX(id) mid FROM monitor_checks GROUP BY monitor_id) x
         ON x.mid = c.id`
    )
    .all();
  let i = 0;
  for (const row of last) {
    setState(row.monitor_id, {
      up: !!row.ok,
      ok: !!row.ok,
      error: row.error,
      checkedAt: row.ts,
      fails: row.ok ? 0 : 1,
      lastChangeAt: row.ts,
      // Stagger the first re-check per monitor so a fleet of 40+ rows does not
      // all fire in the same tick right after boot — except a daily monitor,
      // which keeps its wall-clock slot instead of re-running on every restart.
      nextDueAt: byId.get(row.monitor_id) && byId.get(row.monitor_id).daily_at
        ? nextDue(byId.get(row.monitor_id))
        : Date.now() + (i++ % 40) * 250,
    });
  }
}

function start() {
  seed();
  tick();
  setInterval(tick, 1000).unref();
}

module.exports = {
  start,
  status,
  heartbeats,
  uptime,
  probe,
  runCheck,
  forget,
  unsafeQuery,
  // Test seam. These are pure decision functions — the read-only query guard,
  // the pass/fail comparison, the drift judgement and the schedule — and they
  // are exactly the parts where a wrong answer is silent: a monitor stays green
  // on a broken target, or a nightly job runs at the wrong hour. Exported so
  // test/monitor.test.js can drive them directly instead of trying to infer
  // them from a live check.
  _internal: { evaluateCondition, judgeQueryResult, judgeComparison, nextDue, humanDuration, isAuthRejection, authBackoffFor },
};
