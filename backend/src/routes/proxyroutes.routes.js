'use strict';
// Reverse-proxy routes for the "one HTTPS edge" migration (#436). Each row
// adds one nginx location to a site's own direct-port conf, proxying a path
// prefix to an arbitrary host:port — the mechanism that lets a plain-http
// backend sit behind a site's single https origin.
//
// Admin JWT only, no x-api-token branch: unlike gateway/camera/mq (data
// planes meant for unattended scripts), a route rewrites where THIS PANEL's
// own traffic goes — a leaked api-token must not be able to redirect a site's
// api/* paths anywhere it likes.
const express = require('express');
const db = require('../db');
const nginx = require('../nginx');
const guard = require('../guard');
const { audit } = require('../audit');
const { emitLog } = require('../logbus');

const router = express.Router();
const getSite = (id) => db.prepare('SELECT * FROM sites WHERE id=?').get(id);
const getRoute = (id) => db.prepare('SELECT * FROM proxy_routes WHERE id=?').get(id);

// Only a static site's direct-port block is nginx-owned (process runtimes
// bind their port themselves via PM2) — see nginx.js writePortConf().
function requireProxyableSite(req, res) {
  const s = getSite(req.params.id);
  if (!s) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  if (s.runtime !== 'static') {
    res.status(400).json({ error: 'proxy routes only attach to a static site\'s own port (nginx owns it) — process runtimes bind their port themselves' });
    return null;
  }
  if (!s.direct_port || !s.direct_port_enabled) {
    res.status(400).json({ error: 'site has no enabled direct_port — enable it first' });
    return null;
  }
  return s;
}

function validate(b) {
  return (
    guard.routePrefix(b.path_prefix) ||
    guard.routeTarget(b.target_url) ||
    null
  );
}

// Re-render the site's conf, test, and only keep the change if nginx -t
// passes — a failing test restores every conf file to what it was before
// (nginx.applyConfig), so a bad route never lands on disk even transiently.
async function applyAndReload(site, channel) {
  const r = await nginx.applyConfig(() => nginx.writePortConf(site), channel);
  if (r.ok) await nginx.reload(channel);
  return r;
}

router.get('/:id/routes', (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(db.prepare('SELECT * FROM proxy_routes WHERE site_id=? ORDER BY path_prefix').all(s.id));
});

router.post('/:id/routes', guard.adminOnly, async (req, res) => {
  const s = requireProxyableSite(req, res);
  if (!s) return;
  const b = req.body || {};
  const bad = validate(b);
  if (bad) return res.status(400).json({ error: bad });
  let info;
  try {
    info = db
      .prepare(
        `INSERT INTO proxy_routes (site_id, path_prefix, target_url, strip_prefix, sse, enabled)
         VALUES (@site_id,@path_prefix,@target_url,@strip_prefix,@sse,@enabled)`
      )
      .run({
        site_id: s.id,
        path_prefix: b.path_prefix.trim(),
        target_url: b.target_url.trim(),
        strip_prefix: b.strip_prefix === false ? 0 : 1,
        sse: b.sse ? 1 : 0,
        enabled: b.enabled === false ? 0 : 1,
      });
  } catch (e) {
    return res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'path_prefix already used on this site' : e.message });
  }
  const channel = `site-${s.id}`;
  const r = await applyAndReload(s, channel);
  if (!r.ok) {
    db.prepare('DELETE FROM proxy_routes WHERE id=?').run(info.lastInsertRowid);
    return res.status(400).json({ error: `nginx -t failed, route not saved: ${r.error}` });
  }
  audit(req.user, 'route-create', s.name, `${b.path_prefix} -> ${b.target_url}`);
  res.status(201).json(getRoute(info.lastInsertRowid));
});

const UPDATABLE = ['path_prefix', 'target_url', 'strip_prefix', 'sse', 'enabled'];

router.put('/:id/routes/:routeId', guard.adminOnly, async (req, res) => {
  const s = requireProxyableSite(req, res);
  if (!s) return;
  const row = getRoute(req.params.routeId);
  if (!row || row.site_id !== s.id) return res.status(404).json({ error: 'route not found' });
  const b = req.body || {};
  const merged = { path_prefix: b.path_prefix ?? row.path_prefix, target_url: b.target_url ?? row.target_url };
  const bad = validate(merged);
  if (bad) return res.status(400).json({ error: bad });

  const before = { ...row };
  const sets = [];
  const vals = { id: row.id };
  for (const k of UPDATABLE) {
    if (k in b) {
      sets.push(`${k}=@${k}`);
      vals[k] = typeof b[k] === 'boolean' ? (b[k] ? 1 : 0) : b[k];
    }
  }
  if (sets.length) {
    try {
      db.prepare(`UPDATE proxy_routes SET ${sets.join(', ')} WHERE id=@id`).run(vals);
    } catch (e) {
      return res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'path_prefix already used on this site' : e.message });
    }
  }
  const channel = `site-${s.id}`;
  const r = await applyAndReload(s, channel);
  if (!r.ok) {
    // undo the DB change too, so the row and the (restored) conf agree
    db.prepare(
      'UPDATE proxy_routes SET path_prefix=@path_prefix, target_url=@target_url, strip_prefix=@strip_prefix, sse=@sse, enabled=@enabled WHERE id=@id'
    ).run(before);
    return res.status(400).json({ error: `nginx -t failed, route not updated: ${r.error}` });
  }
  audit(req.user, 'route-update', s.name, `${merged.path_prefix}`);
  res.json(getRoute(row.id));
});

router.delete('/:id/routes/:routeId', guard.adminOnly, async (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const row = getRoute(req.params.routeId);
  if (!row || row.site_id !== s.id) return res.status(404).json({ error: 'route not found' });
  db.prepare('DELETE FROM proxy_routes WHERE id=?').run(row.id);
  const channel = `site-${s.id}`;
  const r = await applyAndReload(s, channel);
  if (!r.ok) {
    // restore the row — the conf itself is already back to the pre-delete
    // state via nginx.applyConfig's restore, so the DB must match it
    db.prepare(
      `INSERT INTO proxy_routes (id, site_id, path_prefix, target_url, strip_prefix, sse, enabled, created_at)
       VALUES (@id,@site_id,@path_prefix,@target_url,@strip_prefix,@sse,@enabled,@created_at)`
    ).run(row);
    emitLog(channel, `[route] ลบไม่สำเร็จ (nginx -t ล้ม): ${r.error}`);
    return res.status(400).json({ error: `nginx -t failed, route not deleted: ${r.error}` });
  }
  audit(req.user, 'route-delete', s.name, row.path_prefix);
  res.json({ ok: true });
});

module.exports = router;
