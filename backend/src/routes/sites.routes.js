'use strict';
const express = require('express');
const db = require('../db');
const nginx = require('../nginx');
const firewall = require('../firewall');
const { audit } = require('../audit');
const guard = require('../guard');

const router = express.Router();
const getSite = (id) => db.prepare('SELECT * FROM sites WHERE id=?').get(id);
// Reads below are open to any signed-in user (monitoring view); everything that
// changes the server is admin-only — creating a site chooses what code the
// manager will fetch and run.

// `deploying` rides along on the site row so the page can say "a deploy is
// already running, started by X at HH:MM" instead of leaving the operator to
// guess why the button does nothing.
const deploylock = require('../deploylock');
const withLock = (s, all) => ({ ...s, deploying: (all || deploylock.allHeld())[s.id] || null });

router.get('/', (req, res) => {
  const all = deploylock.allHeld();
  res.json(db.prepare('SELECT * FROM sites ORDER BY name').all().map((s) => withLock(s, all)));
});

router.get('/:id', (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(withLock(s));
});

router.post('/', guard.adminOnly, (req, res) => {
  const b = req.body || {};
  const bad = guard.siteFields(b, { requireName: true });
  if (bad) return res.status(400).json({ error: bad });
  try {
    const info = db
      .prepare(
        `INSERT INTO sites
         (name, runtime, source_type, repo_url, local_path, branch, direct_port, direct_port_enabled,
          exposure_mode, subdomain, path, domain, ssl_enabled, service_name, entry_file, env_json, pm2_instances, autodeploy,
          build_command, test_command, health_check)
         VALUES (@name,@runtime,@source_type,@repo_url,@local_path,@branch,@direct_port,@direct_port_enabled,
          @exposure_mode,@subdomain,@path,@domain,@ssl_enabled,@service_name,@entry_file,@env_json,@pm2_instances,@autodeploy,
          @build_command,@test_command,@health_check)`
      )
      .run({
        name: b.name,
        runtime: b.runtime || 'static',
        source_type: b.source_type === 'local' ? 'local' : 'git',
        repo_url: b.repo_url || null,
        local_path: b.local_path || null,
        branch: b.branch || 'main',
        entry_file: b.entry_file || null,
        env_json: b.env_json || null,
        pm2_instances: b.pm2_instances ? Number(b.pm2_instances) : 1,
        direct_port: b.direct_port ? Number(b.direct_port) : null,
        direct_port_enabled: b.direct_port_enabled === false ? 0 : 1,
        exposure_mode: b.exposure_mode || null,
        subdomain: b.subdomain || null,
        path: b.path || null,
        domain: b.domain || null,
        ssl_enabled: b.ssl_enabled ? 1 : 0,
        service_name: b.service_name || null,
        autodeploy: b.autodeploy ? 1 : 0,
        build_command: b.build_command || null,
        test_command: b.test_command || null,
        // opt-in per site; 'off' means the health gate never runs
        health_check: b.health_check || 'off',
      });
    audit(req.user, 'create-site', b.name);
    res.status(201).json(getSite(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const UPDATABLE = [
  'runtime',
  'source_type',
  'repo_url',
  'local_path',
  'branch',
  'direct_port',
  'direct_port_enabled',
  'exposure_mode',
  'subdomain',
  'path',
  'domain',
  'ssl_enabled',
  'service_name',
  'entry_file',
  'env_json',
  'pm2_instances',
  'autodeploy',
  'build_command',
  'test_command',
  'health_check',
];

router.put('/:id', guard.adminOnly, (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const bad = guard.siteFields(b); // an update must not smuggle in what create rejects
  if (bad) return res.status(400).json({ error: bad });
  const sets = [];
  const vals = {};
  const NUMERIC = new Set(['direct_port', 'pm2_instances']);
  for (const k of UPDATABLE) {
    if (k in b) {
      sets.push(`${k}=@${k}`);
      let v = b[k];
      if (typeof v === 'boolean') v = v ? 1 : 0;
      // store validated numerics as numbers — SQLite would otherwise keep the
      // original string, which is what nginx/netsh later interpolate
      else if (NUMERIC.has(k) && v !== null && v !== '') v = Number(v);
      vals[k] = v;
    }
  }
  if (sets.length) {
    vals.id = s.id;
    db.prepare(`UPDATE sites SET ${sets.join(', ')} WHERE id=@id`).run(vals);
  }
  audit(req.user, 'update-site', s.name);
  res.json(getSite(s.id));
});

router.delete('/:id', guard.adminOnly, (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  nginx.removeSiteConfigs(s);
  if (s.runtime === 'node' || s.runtime === 'nodered') {
    require('../pm2').remove(s, 'system').catch(() => {});
  }
  if (s.direct_port) firewall.closePort(s.direct_port, 'system').catch(() => {});
  db.prepare('DELETE FROM sites WHERE id=?').run(s.id);
  db.prepare('DELETE FROM releases WHERE site_id=?').run(s.id);
  audit(req.user, 'delete-site', s.name);
  res.json({ ok: true });
});

// Toggle layer-1 direct port on/off — updates nginx + Windows Firewall, logs to
// the site channel.
router.post('/:id/port', guard.adminOnly, (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const enabled = req.body && req.body.enabled ? 1 : 0;
  db.prepare('UPDATE sites SET direct_port_enabled=? WHERE id=?').run(enabled, s.id);
  const updated = getSite(s.id);
  const channel = `site-${s.id}`;
  res.json({ ok: true, direct_port_enabled: enabled });
  (async () => {
    nginx.writePortConf(updated); // add/remove the :port server block
    const t = await nginx.test(channel);
    if (t.code === 0) await nginx.reload(channel);
    if (updated.direct_port) {
      if (enabled) await firewall.openPort(updated.direct_port, channel);
      else await firewall.closePort(updated.direct_port, channel);
    }
    audit(req.user, 'toggle-port', s.name, enabled ? 'on' : 'off');
  })().catch((e) => require('../logbus').emitLog(channel, `[fatal] ${e.message}`));
});

module.exports = router;
