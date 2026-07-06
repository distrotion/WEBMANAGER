'use strict';
const express = require('express');
const db = require('../db');
const nginx = require('../nginx');
const firewall = require('../firewall');
const { audit } = require('../audit');

const router = express.Router();
const getSite = (id) => db.prepare('SELECT * FROM sites WHERE id=?').get(id);

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM sites ORDER BY name').all());
});

router.get('/:id', (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(s);
});

router.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  if (!/^[a-zA-Z0-9._-]+$/.test(b.name)) {
    return res.status(400).json({ error: 'name may only contain letters, numbers, . _ - (no spaces)' });
  }
  try {
    const info = db
      .prepare(
        `INSERT INTO sites
         (name, runtime, source_type, repo_url, local_path, branch, direct_port, direct_port_enabled,
          exposure_mode, subdomain, path, domain, ssl_enabled, service_name, entry_file, env_json, pm2_instances)
         VALUES (@name,@runtime,@source_type,@repo_url,@local_path,@branch,@direct_port,@direct_port_enabled,
          @exposure_mode,@subdomain,@path,@domain,@ssl_enabled,@service_name,@entry_file,@env_json,@pm2_instances)`
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
        pm2_instances: b.pm2_instances || 1,
        direct_port: b.direct_port || null,
        direct_port_enabled: b.direct_port_enabled === false ? 0 : 1,
        exposure_mode: b.exposure_mode || null,
        subdomain: b.subdomain || null,
        path: b.path || null,
        domain: b.domain || null,
        ssl_enabled: b.ssl_enabled ? 1 : 0,
        service_name: b.service_name || null,
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
];

router.put('/:id', (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const sets = [];
  const vals = {};
  for (const k of UPDATABLE) {
    if (k in b) {
      sets.push(`${k}=@${k}`);
      vals[k] = typeof b[k] === 'boolean' ? (b[k] ? 1 : 0) : b[k];
    }
  }
  if (sets.length) {
    vals.id = s.id;
    db.prepare(`UPDATE sites SET ${sets.join(', ')} WHERE id=@id`).run(vals);
  }
  audit(req.user, 'update-site', s.name);
  res.json(getSite(s.id));
});

router.delete('/:id', (req, res) => {
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
router.post('/:id/port', (req, res) => {
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
