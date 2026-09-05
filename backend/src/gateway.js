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
  return [g.listen_port, g.dest_host, g.dest_port, g.bind_host, g.enabled, g.max_conns, g.expires_at, g.ftp_mode].join('|');
}

// ---- FTP mode ----
// A plain forward carries FTP's control channel fine, but every listing and
// transfer happens on a SECOND connection: the server answers PASV with
// "227 (a,b,c,d,p1,p2)" = its own IP and a fresh random port, which the client
// then tries to open — straight at a device this gateway exists to hide, on a
// port nobody forwards. So an ftp_mode gateway reads the control channel, and
// on each 227/229 reply opens a one-shot listener here, forwards it to the
// device's announced port, and rewrites the reply to advertise THIS host and
// that listener. Exactly what a NAT router's FTP helper does. The one-shot
// ports come from a fixed range so the firewall rule is opened once.
const FTP_PASV_MIN = 51000;
const FTP_PASV_MAX = 51099;
const FTP_DATA_WAIT_MS = 30000; // client must open the data socket within this
const pasvInUse = new Set();

function freePasvPort() {
  for (let p = FTP_PASV_MIN; p <= FTP_PASV_MAX; p++) if (!pasvInUse.has(p)) return p;
  return null;
}

// Open a one-shot data listener → dest_host:devicePort. Resolves the port to
// advertise, or null if none is free / listen failed.
function openDataRelay(g, devicePort) {
  return new Promise((resolve) => {
    const port = freePasvPort();
    if (!port) return resolve(null);
    pasvInUse.add(port);
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      pasvInUse.delete(port);
      try { srv.close(); } catch { /* closed */ }
    };
    const srv = net.createServer((client) => {
      release(); // one client only — the listener's job is over once it connects
      const up = net.connect(devicePort, g.dest_host);
      const end = () => { client.destroy(); up.destroy(); };
      client.on('error', end); up.on('error', end);
      client.on('close', end); up.on('close', end);
      client.pipe(up); up.pipe(client);
    });
    srv.on('error', () => { release(); resolve(null); });
    srv.listen(port, g.bind_host || '0.0.0.0', () => {
      setTimeout(release, FTP_DATA_WAIT_MS).unref(); // client never came — free the port
      resolve(port);
    });
  });
}

const PASV_RE = /^(227 .*?\()(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)(\).*)$/;
const EPSV_RE = /^(229 .*?\(\|\|\|)(\d+)(\|\).*)$/;

// Server→client relay for the control channel: pass every line through
// untouched except a passive-mode reply, which is rewritten to point at a relay
// on this host. Lines can straddle TCP chunks, so buffer up to each CRLF.
function ftpControlRelay(g, client, upstream) {
  // What the client dialled to reach us — the only address it can reach back.
  const advertise = client.localAddress.replace(/^::ffff:/, '');
  let buf = '';
  let chain = Promise.resolve();
  upstream.on('data', (chunk) => {
    buf += chunk.toString('latin1');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      chain = chain.then(async () => {
        if (client.destroyed) return;
        let out = line;
        const m = PASV_RE.exec(line);
        const e = EPSV_RE.exec(line);
        if (m || e) {
          const devicePort = m ? parseInt(m[6], 10) * 256 + parseInt(m[7], 10) : parseInt(e[2], 10);
          const relayPort = await openDataRelay(g, devicePort);
          if (relayPort === null) {
            out = '425 Cannot open data connection (gateway relay ports exhausted)';
          } else if (m) {
            const ip = advertise.split('.');
            out = ip.length === 4
              ? `${m[1]}${ip.join(',')},${Math.floor(relayPort / 256)},${relayPort % 256}${m[8]}`
              : `${m[1]}${m[2]},${m[3]},${m[4]},${m[5]},${Math.floor(relayPort / 256)},${relayPort % 256}${m[8]}`;
          } else {
            out = `${e[1]}${relayPort}${e[3]}`;
          }
        }
        client.write(out + '\r\n', 'latin1');
      });
    }
  });
  // Client→server is passed through verbatim (commands are never rewritten).
  client.pipe(upstream);
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
    if (g.ftp_mode) {
      ftpControlRelay(g, client, upstream);
    } else {
      client.pipe(upstream);
      upstream.pipe(client);
    }
  });
  server.on('error', (e) => {
    emitLog('system', `[gateway] "${g.name}" :${g.listen_port} error: ${e.message}`);
    stopOne(g.id);
  });
  server.listen(g.listen_port, g.bind_host || '0.0.0.0', () => {
    emitLog('system', `[gateway] "${g.name}" listening :${g.listen_port} -> ${g.dest_host}:${g.dest_port}${g.ftp_mode ? ` (FTP mode, data relay ${FTP_PASV_MIN}-${FTP_PASV_MAX})` : ''}`);
    if (g.ftp_mode) require('./firewall').openPortRange(FTP_PASV_MIN, FTP_PASV_MAX, 'system').catch(() => {});
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
