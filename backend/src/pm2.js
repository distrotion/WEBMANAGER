'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const services = require('./services'); // reuse provisionNodeRed()
const { run } = require('./runner');
const { emitLog } = require('./logbus');

// Manage node / Node-RED apps with PM2. We invoke PM2 as `node <pm2-bin>` so there
// is no pm2.cmd spawn (avoids EINVAL on Windows/Node 20+). PM2_HOME lives in ROOT.
const PM2_BIN = require.resolve('pm2/bin/pm2');

// Programmatic PM2 client — talks to the daemon over its RPC socket, no process
// spawn per query (~2ms vs ~150ms for a CLI jlist). The pm2 module captures
// PM2_HOME once at require time, so point it at our home just for the require,
// then restore the ambient value (children spawned later inherit the original
// env — the server's own PM2 stays untouched).
let pm2api = null;
(() => {
  const prev = process.env.PM2_HOME;
  process.env.PM2_HOME = config.pm2.home;
  try {
    pm2api = require('pm2');
  } catch {
    pm2api = null; // CLI fallback still works
  }
  if (prev === undefined) delete process.env.PM2_HOME;
  else process.env.PM2_HOME = prev;
})();

let apiConnected = false;
function apiList() {
  return new Promise((resolve, reject) => {
    if (!pm2api) return reject(new Error('pm2 api unavailable'));
    fs.mkdirSync(config.pm2.home, { recursive: true });
    const doList = () =>
      pm2api.list((err, list) => {
        if (err) {
          // daemon may have died — drop the connection so next call reconnects
          apiConnected = false;
          try {
            pm2api.disconnect();
          } catch {
            /* ignore */
          }
          return reject(err);
        }
        resolve(list);
      });
    if (apiConnected) return doList();
    pm2api.connect((err) => {
      if (err) return reject(err);
      apiConnected = true;
      doList();
    });
  });
}

function pm2env(extra) {
  return { PM2_HOME: config.pm2.home, ...(extra || {}) };
}
function pm2(args, { channel = 'system', env } = {}) {
  fs.mkdirSync(config.pm2.home, { recursive: true });
  return run(config.nodeExe, [PM2_BIN, ...args], { channel, env: pm2env(env) });
}

function serviceName(site) {
  return site.service_name || `${config.nssm.prefix}${site.name}`; // wm-<name>
}

// ---- process list / metrics ----
// jlist spawns a node process, so cache it briefly (single-flight): the sites
// list, PM2 list, and detail pages all poll every 3s — with this, any number of
// concurrent pollers/tabs cost at most one spawn per 2s.
let _jcache = { t: 0, p: null };
function jlist() {
  const now = Date.now();
  if (_jcache.p && now - _jcache.t < 2000) return _jcache.p;
  _jcache = {
    t: now,
    p: (async () => {
      // fast path: daemon RPC (no spawn); fall back to CLI jlist
      try {
        return await apiList();
      } catch {
        /* fall through to CLI */
      }
      const r = await pm2(['jlist'], { channel: 'silent' });
      const out = r.out || '';
      const s = out.indexOf('[');
      const e = out.lastIndexOf(']');
      if (s < 0 || e < 0) return [];
      try {
        return JSON.parse(out.slice(s, e + 1));
      } catch {
        return [];
      }
    })(),
  };
  return _jcache.p;
}

// Lifecycle actions change the process list — drop the cache so the next
// poll reflects the new state immediately.
function invalidateJlist() {
  _jcache = { t: 0, p: null };
}

function metricsOf(list, svc) {
  const p = list.find((x) => x.name === svc);
  if (!p) return { status: 'stopped' };
  const pe = p.pm2_env || {};
  return {
    status: pe.status || 'unknown',
    cpu: p.monit ? p.monit.cpu : null,
    memory: p.monit ? p.monit.memory : null,
    restarts: pe.restart_time || 0,
    uptime: pe.pm_uptime || null,
    instances: pe.instances || 1,
    pid: p.pid || null,
  };
}

async function refreshStatus(site) {
  const m = metricsOf(await jlist(), serviceName(site));
  db.prepare('UPDATE sites SET process_status=? WHERE id=?').run(m.status, site.id);
  return m;
}

async function metrics(site) {
  return metricsOf(await jlist(), serviceName(site));
}
async function overview() {
  const list = await jlist();
  return list
    .filter((p) => (p.name || '').startsWith(config.nssm.prefix))
    .map((p) => ({ name: p.name, ...metricsOf([p], p.name) }));
}

// ---- lifecycle ----
// Env the app runs with (PORT + custom env_json). Node-RED gets its port via args.
function envFor(site) {
  const env = {};
  if (site.runtime !== 'nodered') {
    if (site.direct_port) env.PORT = String(site.direct_port);
    if (site.env_json) {
      try {
        Object.assign(env, JSON.parse(site.env_json));
      } catch {
        /* ignore bad env json */
      }
    }
  }
  return env;
}

// Build `pm2 start` argv for a site.
function startArgs(site) {
  const svc = serviceName(site);
  let program;
  let cwd;
  const passthru = [];

  if (site.runtime === 'nodered') {
    cwd = services.provisionNodeRed(site);
    program = path.join(config.paths.runtimes, 'node-red', 'node_modules', 'node-red', 'red.js');
    passthru.push('-u', cwd, '-p', String(site.direct_port || 1880), '-s', path.join(cwd, 'settings.js'));
  } else {
    cwd = path.join(config.paths.sites, site.name, 'repo');
    program = path.join(cwd, site.entry_file || 'server.js');
  }

  const args = ['start', program, '--name', svc, '--cwd', cwd];
  if (site.pm2_instances && site.pm2_instances > 1) args.push('-i', String(site.pm2_instances));
  if (passthru.length) args.push('--', ...passthru);
  return args;
}

async function start(site, channel) {
  const env = envFor(site);
  const svc = serviceName(site);
  // If PM2 already knows this app (e.g. it was stopped), resume it by name —
  // `pm2 start <script> --name` on an existing app errors "already launched".
  const known = (await jlist()).some((p) => p.name === svc);
  const r = known
    ? await pm2(['start', svc, '--update-env'], { channel, env })
    : await pm2(startArgs(site), { channel, env });
  await pm2(['save'], { channel: 'silent', env });
  db.prepare('UPDATE sites SET service_name=? WHERE id=?').run(serviceName(site), site.id);
  invalidateJlist();
  await refreshStatus(site);
  return r;
}

// Restart (used by deploy). Passes the same env so the app keeps its port.
// Falls back to start on first run.
async function restart(site, channel) {
  const svc = serviceName(site);
  const env = envFor(site);
  emitLog(channel, `[pm2] restart ${svc}`);
  const r = await pm2(['restart', svc, '--update-env'], { channel, env });
  if (r.code !== 0) {
    emitLog(channel, '[pm2] not running yet — starting');
    return start(site, channel);
  }
  await pm2(['save'], { channel: 'silent', env });
  invalidateJlist();
  await refreshStatus(site);
  return r;
}

async function stop(site, channel) {
  const r = await pm2(['stop', serviceName(site)], { channel });
  invalidateJlist();
  await refreshStatus(site);
  return r;
}

async function remove(site, channel) {
  await pm2(['delete', serviceName(site)], { channel });
  invalidateJlist();
  return pm2(['save'], { channel: 'silent' });
}

// Recent logs for a site (non-streaming).
async function tailLog(site, channel, lines = 200) {
  return pm2(['logs', serviceName(site), '--nostream', '--lines', String(lines)], { channel });
}

// On manager startup: if the PM2 daemon has no processes (e.g. after a reboot),
// resurrect the saved set. Skips when the daemon already holds processes.
async function ensureUp() {
  try {
    const list = await jlist();
    if (list.length === 0) await pm2(['resurrect'], { channel: 'system' });
  } catch {
    /* best effort */
  }
}

module.exports = {
  serviceName,
  start,
  stop,
  restart,
  remove,
  refreshStatus,
  metrics,
  overview,
  tailLog,
  ensureUp,
};
