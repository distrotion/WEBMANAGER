'use strict';
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const config = require('./config');
const { verifyToken } = require('./auth');
const { audit } = require('./audit');

// node-pty ships prebuilt spawn-helpers that sometimes lose their +x bit after
// npm extraction — restore it on posix so pty.spawn() doesn't fail.
function fixSpawnHelperPerms() {
  if (process.platform === 'win32') return;
  try {
    const base = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
    for (const dir of fs.existsSync(base) ? fs.readdirSync(base) : []) {
      const h = path.join(base, dir, 'spawn-helper');
      if (fs.existsSync(h)) fs.chmodSync(h, 0o755);
    }
  } catch {
    /* best effort */
  }
}

function shell() {
  if (process.platform === 'win32') {
    return { file: process.env.COMSPEC || 'powershell.exe', args: [] };
  }
  return { file: process.env.SHELL || '/bin/bash', args: [] };
}

// Interactive shell over WebSocket at /pty. ADMIN ONLY. This is a real terminal
// on the server — gate the panel behind a firewall/VPN (see README security notes).
function makeWss() {
  fixSpawnHelperPerms();
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const payload = verifyToken(url.searchParams.get('token'));
    if (!payload) return ws.close(4001, 'unauthorized');
    if (payload.role !== 'admin') return ws.close(4003, 'admin only');

    // Resolve working dir: a site name (server computes the path) or an explicit
    // cwd, falling back to ROOT. Site name is validated on creation (safe chars).
    let cwd = config.ROOT;
    const site = url.searchParams.get('site');
    if (site && /^[a-zA-Z0-9._-]+$/.test(site)) {
      const repo = path.join(config.paths.sites, site, 'repo');
      const root = path.join(config.paths.sites, site);
      cwd = fs.existsSync(repo) ? repo : fs.existsSync(root) ? root : config.ROOT;
    } else if (url.searchParams.get('cwd') && fs.existsSync(url.searchParams.get('cwd'))) {
      cwd = url.searchParams.get('cwd');
    }

    const { file, args } = shell();
    let term;
    try {
      term = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: parseInt(url.searchParams.get('cols') || '80', 10),
        rows: parseInt(url.searchParams.get('rows') || '24', 10),
        cwd,
        env: process.env,
      });
    } catch (e) {
      ws.send(`failed to open shell: ${e.message}\r\n`);
      return ws.close();
    }

    audit(payload, 'open-console', file, cwd);
    ws.send(`\x1b[32m● connected to ${file} @ ${cwd} (${payload.username})\x1b[0m\r\n`);

    term.onData((d) => {
      try {
        ws.send(d);
      } catch {
        /* closing */
      }
    });
    term.onExit(({ exitCode }) => {
      try {
        ws.send(`\r\n\x1b[33m[shell exited ${exitCode}]\x1b[0m\r\n`);
        ws.close();
      } catch {
        /* already closed */
      }
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'input') term.write(msg.data);
      else if (msg.type === 'resize') term.resize(msg.cols || 80, msg.rows || 24);
    });

    ws.on('close', () => {
      audit(payload, 'close-console', file);
      try {
        term.kill();
      } catch {
        /* already dead */
      }
    });
  });

  return wss;
}

module.exports = { makeWss };
