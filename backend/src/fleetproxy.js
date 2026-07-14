'use strict';
// WebSocket proxy for fleet mode: the hub pipes /fleet/<id>/ws (live logs) and
// /fleet/<id>/pty (console) to the remote server's own /ws and /pty, swapping
// the caller's login JWT for the remote's fleet service token. Admin only.
const { WebSocketServer, WebSocket } = require('ws');
const db = require('./db');
const { verifyToken } = require('./auth');
const { audit } = require('./audit');

const wss = new WebSocketServer({ noServer: true });

// Returns true when the request was a fleet-proxy path (handled here).
function handleUpgrade(req, socket, head) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return false;
  }
  const m = url.pathname.match(/^\/fleet\/(\d+)\/(ws|pty)$/);
  if (!m) return false;

  const payload = verifyToken(url.searchParams.get('token'));
  if (!payload || payload.role !== 'admin') {
    socket.destroy();
    return true;
  }
  const remote = db.prepare('SELECT * FROM remotes WHERE id=?').get(m[1]);
  if (!remote) {
    socket.destroy();
    return true;
  }

  wss.handleUpgrade(req, socket, head, (client) => {
    const q = new URLSearchParams(url.searchParams);
    q.set('token', remote.token);
    const target = `${remote.url.replace(/^http/, 'ws')}/${m[2]}?${q.toString()}`;
    const upstream = new WebSocket(target);
    const closeBoth = () => {
      try { client.close(); } catch { /* closing */ }
      try { upstream.close(); } catch { /* closing */ }
    };

    // buffer client->remote messages until the upstream socket is open
    const pending = [];
    client.on('message', (d) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(d.toString());
      else pending.push(d.toString());
    });
    upstream.on('open', () => {
      for (const d of pending) upstream.send(d);
      pending.length = 0;
    });
    upstream.on('message', (d) => {
      try { client.send(d.toString()); } catch { /* closing */ }
    });
    upstream.on('close', closeBoth);
    upstream.on('error', () => {
      try { client.send(`[fleet] cannot reach ${remote.name} (${remote.url})`); } catch { /* closing */ }
      closeBoth();
    });
    client.on('close', closeBoth);
    client.on('error', closeBoth);
    if (m[2] === 'pty') audit(payload, 'fleet-console', remote.name);
  });
  return true;
}

module.exports = { handleUpgrade };
