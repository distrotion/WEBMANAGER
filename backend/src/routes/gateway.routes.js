'use strict';
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const gateway = require('../gateway');
const firewall = require('../firewall');
const settings = require('../settings');
const { audit } = require('../audit');
const { verifyAnyToken } = require('../auth');

const router = express.Router();

// Gateway API auth (per the Remote Gateway spec): accept either
//   1. header `x-api-token: <token>`  (or `Authorization: Bearer <token>`)
//   2. an admin login JWT / fleet token — so the UI and hub proxy keep working
// The api-token lets scripts on other machines drive gateways without a login.
// There is deliberately NO loopback exemption: a gateway opens a TCP path into
// the network, and apps this manager deploys run on this same host — "from
// 127.0.0.1" would let any of them open one with no credential at all.
function gatewayAuth(req, res, next) {
  const apiTok = settings.get('gateway_api_token');
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : null;
  const provided = req.headers['x-api-token'] || bearer;
  if (apiTok && provided === apiTok) {
    req.user = { username: 'api-token', role: 'admin' };
    return next();
  }
  const payload = bearer && verifyAnyToken(bearer);
  if (payload && payload.role === 'admin') {
    req.user = payload;
    return next();
  }
  return res.status(401).json({ error: 'unauthorized: need x-api-token or admin login' });
}
router.use(gatewayAuth);

const adminOnly = (req, res, next) =>
  req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'admin only' });

// ---- API token management (view/generate/revoke) — real login only ----
// Guarded so a leaked api-token can't rotate itself: a JWT/fleet login passes,
// the api-token identity does not.
function tokenAdmin(req, res, next) {
  if (req.user && req.user.username !== 'api-token') return next();
  return res.status(403).json({ error: 'manage the token from a logged-in session' });
}
router.get('/token', adminOnly, tokenAdmin, (req, res) =>
  res.json({ hasToken: !!settings.get('gateway_api_token') })
);
router.post('/token', adminOnly, tokenAdmin, (req, res) => {
  const token = 'gwt_' + crypto.randomBytes(24).toString('hex');
  settings.set('gateway_api_token', token);
  audit(req.user, 'gateway-token', 'generate');
  res.json({ token });
});
router.delete('/token', adminOnly, tokenAdmin, (req, res) => {
  settings.del('gateway_api_token');
  audit(req.user, 'gateway-token', 'revoke');
  res.json({ ok: true });
});

const view = (g) => ({
  id: g.id,
  name: g.name,
  listen_port: g.listen_port,
  dest_host: g.dest_host,
  dest_port: g.dest_port,
  bind_host: g.bind_host,
  enabled: !!g.enabled,
  max_conns: g.max_conns,
  expires_at: g.expires_at,
  ftp_mode: !!g.ftp_mode,
  status: gateway.status(g),
  conns: gateway.liveConns(g.id),
});

router.get('/', adminOnly, (req, res) => {
  res.json(db.prepare('SELECT * FROM gateways ORDER BY listen_port').all().map(view));
});

function validate(b, id) {
  const listen = parseInt(b.listen_port, 10);
  const destPort = parseInt(b.dest_port, 10);
  if (!b.name || !b.dest_host || !listen || !destPort) return 'name, dest_host, listen_port, dest_port required';
  if (listen < 1 || listen > 65535) return 'listen_port out of range';
  if (gateway.reservedPorts().has(listen)) return `listen_port ${listen} is reserved by webmanager/a site`;
  const clash = db.prepare('SELECT id FROM gateways WHERE listen_port=? AND id!=?').get(listen, id || 0);
  if (clash) return `listen_port ${listen} already used by another gateway`;
  return null;
}

router.post('/', adminOnly, async (req, res) => {
  const b = req.body || {};
  const err = validate(b);
  if (err) return res.status(400).json({ error: err });
  const info = db
    .prepare(
      `INSERT INTO gateways (name, listen_port, dest_host, dest_port, bind_host, enabled, max_conns, expires_at, ftp_mode)
       VALUES (@name,@listen_port,@dest_host,@dest_port,@bind_host,@enabled,@max_conns,@expires_at,@ftp_mode)`
    )
    .run({
      ftp_mode: b.ftp_mode ? 1 : 0,
      name: String(b.name).trim(),
      listen_port: parseInt(b.listen_port, 10),
      dest_host: String(b.dest_host).trim(),
      dest_port: parseInt(b.dest_port, 10),
      bind_host: b.bind_host || '0.0.0.0',
      enabled: b.enabled === false ? 0 : 1,
      max_conns: parseInt(b.max_conns, 10) || 0,
      expires_at: b.expires_at ? parseInt(b.expires_at, 10) : null,
    });
  const g = db.prepare('SELECT * FROM gateways WHERE id=?').get(info.lastInsertRowid);
  gateway.reconcile();
  if (g.enabled) firewall.openPort(g.listen_port, 'system').catch(() => {});
  audit(req.user, 'gateway-create', g.name, `:${g.listen_port} -> ${g.dest_host}:${g.dest_port}`);
  res.status(201).json(view(g));
});

const FIELDS = ['name', 'listen_port', 'dest_host', 'dest_port', 'bind_host', 'enabled', 'max_conns', 'expires_at', 'ftp_mode'];
router.put('/:id', adminOnly, (req, res) => {
  const g = db.prepare('SELECT * FROM gateways WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if ('listen_port' in b) {
    const err = validate({ ...g, ...b }, g.id);
    if (err) return res.status(400).json({ error: err });
  }
  const sets = [];
  const vals = { id: g.id };
  for (const f of FIELDS) {
    if (f in b) {
      sets.push(`${f}=@${f}`);
      vals[f] = typeof b[f] === 'boolean' ? (b[f] ? 1 : 0) : b[f];
    }
  }
  if (sets.length) db.prepare(`UPDATE gateways SET ${sets.join(', ')} WHERE id=@id`).run(vals);
  gateway.reconcile();
  audit(req.user, 'gateway-update', g.name);
  res.json(view(db.prepare('SELECT * FROM gateways WHERE id=?').get(g.id)));
});

router.delete('/:id', adminOnly, (req, res) => {
  const g = db.prepare('SELECT * FROM gateways WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM gateways WHERE id=?').run(g.id);
  gateway.reconcile();
  firewall.closePort(g.listen_port, 'system').catch(() => {});
  audit(req.user, 'gateway-delete', g.name);
  res.json({ ok: true });
});

module.exports = router;
