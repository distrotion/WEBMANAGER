'use strict';
// Fleet: one webmanager (แม่/hub) can watch several others (ลูก/agent).
// Every instance has a role setting: 'agent' (default) exposes a service token
// the hub authenticates with; 'hub' additionally keeps a registry of remote
// servers and aggregates their health/sites/PM2 state for the fleet dashboard.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const settings = require('../settings');
const { audit } = require('../audit');

const router = express.Router();
const adminOnly = (req, res, next) =>
  req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'admin only' });

// ---- role + service token ----
router.get('/', (req, res) =>
  res.json({
    role: settings.get('fleet_role') || 'agent',
    hasToken: !!settings.get('fleet_token'),
  })
);

router.put('/', adminOnly, (req, res) => {
  const role = req.body && req.body.role === 'hub' ? 'hub' : 'agent';
  settings.set('fleet_role', role);
  audit(req.user, 'fleet-role', role);
  res.json({ role });
});

// Generate (or rotate) this server's service token — paste it into the hub.
router.post('/token', adminOnly, (req, res) => {
  const token = 'wmt_' + crypto.randomBytes(24).toString('hex');
  settings.set('fleet_token', token);
  audit(req.user, 'fleet-token', 'generate');
  res.json({ token });
});

router.delete('/token', adminOnly, (req, res) => {
  settings.del('fleet_token');
  audit(req.user, 'fleet-token', 'revoke');
  res.json({ ok: true });
});

// ---- remote-servers registry (hub) ----
router.get('/remotes', adminOnly, (req, res) => {
  res.json(db.prepare('SELECT id, name, url FROM remotes ORDER BY name').all());
});

router.post('/remotes', adminOnly, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.url || !b.token) {
    return res.status(400).json({ error: 'name, url and token are required' });
  }
  const url = String(b.url).trim().replace(/\/+$/, '');
  try {
    const info = db
      .prepare('INSERT INTO remotes (name, url, token) VALUES (?,?,?)')
      .run(String(b.name).trim(), url, String(b.token).trim());
    audit(req.user, 'fleet-add-server', b.name, url);
    res.status(201).json({ id: info.lastInsertRowid, name: b.name, url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/remotes/:id', adminOnly, (req, res) => {
  const r = db.prepare('SELECT name FROM remotes WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM remotes WHERE id=?').run(req.params.id);
  audit(req.user, 'fleet-del-server', r ? r.name : req.params.id);
  res.json({ ok: true });
});

// ---- fleet overview: poll every remote in parallel ----
async function fetchJson(url, token, ms = 5000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

router.get('/overview', async (req, res) => {
  const remotes = db.prepare('SELECT id, name, url, token FROM remotes ORDER BY name').all();
  const out = await Promise.all(
    remotes.map(async (r) => {
      try {
        const [health, sites, pm2] = await Promise.all([
          fetchJson(`${r.url}/api/health`, r.token),
          fetchJson(`${r.url}/api/sites`, r.token),
          fetchJson(`${r.url}/api/sites/pm2/overview`, r.token).catch(() => []),
        ]);
        return {
          id: r.id,
          name: r.name,
          url: r.url,
          up: true,
          version: health.version || null,
          sites: sites.map((s) => ({
            name: s.name,
            runtime: s.runtime,
            port: s.direct_port,
            status: s.status,
            process_status: s.process_status,
          })),
          pm2,
        };
      } catch (e) {
        return { id: r.id, name: r.name, url: r.url, up: false, error: e.message };
      }
    })
  );
  res.json(out);
});

module.exports = router;
