'use strict';
// Remote Gateway: raw-TCP port forwarder. Each enabled gateway opens a listen
// port on this server and pipes bytes two-way to dest_host:dest_port — tunnels
// HTTP/WebSocket/TLS transparently (no path rewrite; the target does its own auth).
// Reconciles live: changing a gateway re-opens/closes its listener with no restart.
const net = require('net');
const db = require('./db');
const config = require('./config');
const { emitLog } = require('./logbus');

const servers = new Map(); // id -> { server, key, live }
const live = new Map(); // id -> active connection count

// Ports webmanager itself needs — a gateway must never listen on these.
function reservedPorts() {
  const s = new Set([config.PORT]);
  for (const g of db.prepare('SELECT direct_port FROM sites WHERE direct_port IS NOT NULL').all()) {
    s.add(g.direct_port);
  }
  return s;
}

function key(g) {
  return [g.listen_port, g.dest_host, g.dest_port, g.bind_host, g.enabled, g.max_conns, g.expires_at].join('|');
}

function expired(g) {
  return g.expires_at && Date.now() > g.expires_at;
}

function stopOne(id) {
  const e = servers.get(id);
  if (e) {
    try { e.server.close(); } catch { /* already closed */ }
    servers.delete(id);
    live.delete(id);
  }
}

function startOne(g) {
  const server = net.createServer((client) => {
    const n = (live.get(g.id) || 0) + 1;
    if (g.max_conns > 0 && n > g.max_conns) {
      client.destroy();
      return;
    }
    live.set(g.id, n);
    const upstream = net.connect(g.dest_port, g.dest_host);
    const done = () => {
      client.destroy();
      upstream.destroy();
      live.set(g.id, Math.max(0, (live.get(g.id) || 1) - 1));
    };
    client.on('error', done);
    upstream.on('error', done);
    client.on('close', done);
    upstream.on('close', done);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.on('error', (e) => {
    emitLog('system', `[gateway] "${g.name}" :${g.listen_port} error: ${e.message}`);
    stopOne(g.id);
  });
  server.listen(g.listen_port, g.bind_host || '0.0.0.0', () => {
    emitLog('system', `[gateway] "${g.name}" listening :${g.listen_port} -> ${g.dest_host}:${g.dest_port}`);
  });
  servers.set(g.id, { server, key: key(g) });
}

// Bring running listeners in line with the DB (called on boot, after any change,
// and periodically to retire expired tunnels).
function reconcile() {
  const rows = db.prepare('SELECT * FROM gateways').all();
  const ids = new Set(rows.map((r) => r.id));
  for (const id of servers.keys()) if (!ids.has(id)) stopOne(id);
  for (const g of rows) {
    const shouldRun = g.enabled && !expired(g);
    const running = servers.get(g.id);
    if (shouldRun && (!running || running.key !== key(g))) {
      stopOne(g.id);
      startOne(g);
    } else if (!shouldRun && running) {
      stopOne(g.id);
    }
  }
}

function status(g) {
  if (!g.enabled) return 'disabled';
  if (expired(g)) return 'expired';
  return servers.has(g.id) ? 'listening' : 'stopped';
}

function liveConns(id) {
  return live.get(id) || 0;
}

function start() {
  reconcile();
  setInterval(reconcile, 30000).unref(); // retire expired tunnels
}

module.exports = { reconcile, status, liveConns, reservedPorts, start };
