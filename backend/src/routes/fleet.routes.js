'use strict';
// Fleet: one webmanager (แม่/hub) can watch several others (ลูก/agent).
// Every instance has a role setting: 'agent' (default) exposes a service token
// the hub authenticates with; 'hub' additionally keeps a registry of remote
// servers and aggregates their health/sites/PM2 state for the fleet dashboard.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const settings = require('../settings');
const { audit } = require('../audit');

const router = express.Router();
const adminOnly = (req, res, next) =>
  req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'admin only' });

// A hub must not register itself as its own child (would show up twice / loop).
function pointsToSelf(url) {
  try {
    const u = new URL(url);
    const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
    const port = parseInt(u.port || '80', 10);
    return loopback && port === config.PORT;
  } catch {
    return false;
  }
}

// ---- role + service token ----
// role: 'standalone' (default — a normal lone webmanager, no fleet), 'agent'
// (ลูก — a hub may watch/control it), 'hub' (แม่ — watches others).
const ROLES = ['standalone', 'agent', 'hub'];
router.get('/', (req, res) =>
  res.json({
    role: settings.get('fleet_role') || 'standalone',
    hasToken: !!settings.get('fleet_token'),
  })
);

router.put('/', adminOnly, (req, res) => {
  const role = ROLES.includes(req.body && req.body.role) ? req.body.role : 'standalone';
  settings.set('fleet_role', role);
  // A standalone server takes part in no fleet — drop its service token so it
  // stops accepting hub calls.
  if (role === 'standalone') settings.del('fleet_token');
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
  if (pointsToSelf(url)) {
    return res.status(400).json({ error: 'URL นี้ชี้กลับมาที่เครื่องแม่เอง — ใส่ IP/URL ของเครื่องลูกจริง' });
  }
  try {
    // upsert by name: re-joining (e.g. after a token rotate) updates in place
    db.prepare(
      `INSERT INTO remotes (name, url, token) VALUES (?,?,?)
       ON CONFLICT(name) DO UPDATE SET url=excluded.url, token=excluded.token`
    ).run(String(b.name).trim(), url, String(b.token).trim());
    const row = db.prepare('SELECT id, name, url FROM remotes WHERE name=?').get(String(b.name).trim());
    audit(req.user, 'fleet-add-server', b.name, url);
    res.status(201).json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- child self-registration (สมัครเข้ากับแม่จากหน้าลูก) ----
// The child logs into the hub with the hub-admin credentials ONCE (not stored),
// then registers its own name/url/token there. Run on the child.
router.post('/join', adminOnly, async (req, res) => {
  const b = req.body || {};
  if (!b.hubUrl || !b.username || !b.password || !b.myName || !b.myUrl) {
    return res.status(400).json({ error: 'hubUrl, username, password, myName, myUrl required' });
  }
  const hubUrl = String(b.hubUrl).trim().replace(/\/+$/, '');
  // reuse the existing service token so earlier registrations keep working
  let token = settings.get('fleet_token');
  if (!token) {
    token = 'wmt_' + crypto.randomBytes(24).toString('hex');
    settings.set('fleet_token', token);
  }
  try {
    const lr = await fetch(`${hubUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: b.username, password: b.password }),
      signal: AbortSignal.timeout(8000),
    });
    if (!lr.ok) return res.status(401).json({ error: 'hub login failed (user/password ของแม่ไม่ถูก)' });
    const jwt = (await lr.json()).token;
    const rr = await fetch(`${hubUrl}/api/fleet/remotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        name: String(b.myName).trim(),
        url: String(b.myUrl).trim().replace(/\/+$/, ''),
        token,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (rr.status !== 201) {
      const e = await rr.json().catch(() => ({}));
      return res.status(400).json({ error: e.error || `hub returned ${rr.status}` });
    }
    audit(req.user, 'fleet-join', hubUrl);
    res.json({ ok: true, hub: hubUrl });
  } catch (e) {
    res.status(502).json({ error: `hub unreachable: ${e.message}` });
  }
});

// ---- transparent REST proxy: /api/fleet/remotes/:id/proxy/<any remote path> ----
// The UI switches its API base to this prefix when a remote server is selected,
// so every existing page (sites, deploy, metrics, logs history, …) just works
// against the remote. Admin only — the remote token carries admin power there.
router.all(/^\/remotes\/(\d+)\/proxy(\/.*)$/, adminOnly, async (req, res) => {
  const remote = db.prepare('SELECT * FROM remotes WHERE id=?').get(req.params[0]);
  if (!remote) return res.status(404).json({ error: 'unknown remote' });
  // keep the remote path + query string exactly as sent
  const suffix = req.originalUrl.replace(/^\/api\/fleet\/remotes\/\d+\/proxy/, '');
  try {
    const r = await fetch(remote.url + suffix, {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        Authorization: `Bearer ${remote.token}`,
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(30000),
    });
    res.status(r.status);
    res.set('Content-Type', r.headers.get('content-type') || 'application/json');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(502).json({ error: `remote unreachable: ${e.message}` });
  }
});

// rename / re-point a registered child
router.put('/remotes/:id', adminOnly, (req, res) => {
  const r = db.prepare('SELECT * FROM remotes WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'unknown remote' });
  const b = req.body || {};
  const name = b.name ? String(b.name).trim() : r.name;
  const url = b.url ? String(b.url).trim().replace(/\/+$/, '') : r.url;
  try {
    db.prepare('UPDATE remotes SET name=?, url=? WHERE id=?').run(name, url, r.id);
    audit(req.user, 'fleet-rename-server', `${r.name} -> ${name}`);
    res.json({ id: r.id, name, url });
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
