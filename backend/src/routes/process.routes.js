'use strict';
const fs = require('fs');
const express = require('express');
const db = require('../db');
const pm2 = require('../pm2');
const services = require('../services');
const { audit } = require('../audit');

const router = express.Router();
const getSite = (id) => db.prepare('SELECT * FROM sites WHERE id=?').get(id);

function requireProcess(req, res, next) {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.runtime !== 'nodered' && s.runtime !== 'node') {
    return res.status(400).json({ error: 'not a process runtime' });
  }
  req.site = s;
  next();
}

function action(name, fn) {
  return (req, res) => {
    const s = req.site;
    const channel = `site-${s.id}`;
    res.json({ started: true, channel });
    fn(s, channel)
      .then(() => audit(req.user, name, s.name))
      .catch((e) => require('../logbus').emitLog(channel, `[fatal] ${e.message}`));
  };
}

// Live metrics for ALL wm-* PM2 apps in one call (drives the sites-list monit).
// Placed before /:id routes so 'pm2' isn't parsed as a site id.
router.get('/pm2/overview', async (req, res) => {
  try {
    res.json(await pm2.overview());
  } catch {
    res.json([]);
  }
});

router.post('/:id/start', requireProcess, action('start', pm2.start));
router.post('/:id/stop', requireProcess, action('stop', pm2.stop));
router.post('/:id/restart', requireProcess, action('restart', pm2.restart));

// Live CPU/RAM/restarts/uptime for the site's process (from `pm2 jlist`).
router.get('/:id/metrics', requireProcess, async (req, res) => {
  res.json(await pm2.metrics(req.site));
});

router.get('/:id/status', requireProcess, async (req, res) => {
  const m = await pm2.refreshStatus(req.site);
  res.json({ status: m.status });
});

router.post('/:id/logs', requireProcess, (req, res) => {
  const channel = `site-${req.site.id}`;
  res.json({ started: true, channel });
  pm2.tailLog(req.site, channel, 300);
});

// ---- Node-RED user settings (settings.user.js — survives restarts) ----
function requireNodered(req, res, next) {
  if (req.site.runtime !== 'nodered') return res.status(400).json({ error: 'not a Node-RED site' });
  next();
}

router.get('/:id/nodered-settings', requireProcess, requireNodered, (req, res) => {
  services.provisionNodeRed(req.site); // ensure the file exists (older sites)
  const p = services.noderedUserSettingsPath(req.site);
  res.json({ content: fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '' });
});

router.put('/:id/nodered-settings', requireProcess, requireNodered, (req, res) => {
  const content = String((req.body && req.body.content) || '');
  // light sanity check: must be evaluable and export an object
  try {
    const m = { exports: {} };
    new Function('module', 'exports', 'require', content)(m, m.exports, require);
    if (typeof m.exports !== 'object' || m.exports === null) throw new Error('must export an object');
  } catch (e) {
    return res.status(400).json({ error: `invalid settings.js: ${e.message}` });
  }
  fs.writeFileSync(services.noderedUserSettingsPath(req.site), content, 'utf8');
  audit(req.user, 'edit-nodered-settings', req.site.name);
  res.json({ ok: true });
});

module.exports = router;
