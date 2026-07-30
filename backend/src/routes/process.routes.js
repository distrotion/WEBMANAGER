'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const db = require('../db');
const pm2 = require('../pm2');
const services = require('../services');
const { audit } = require('../audit');
const guard = require('../guard');

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

router.post('/:id/start', guard.adminOnly, requireProcess, action('start', pm2.start));
router.post('/:id/stop', guard.adminOnly, requireProcess, action('stop', pm2.stop));
router.post('/:id/restart', guard.adminOnly, requireProcess, action('restart', pm2.restart));

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

router.get('/:id/nodered-settings', guard.adminOnly, requireProcess, requireNodered, (req, res) => {
  services.provisionNodeRed(req.site); // ensure the file exists (older sites)
  const p = services.noderedUserSettingsPath(req.site);
  res.json({ content: fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '' });
});

// bcrypt-hash an editor password for adminAuth (same format as node-red-admin hash-pw).
router.post('/:id/nodered-hash', guard.adminOnly, requireProcess, requireNodered, (req, res) => {
  const pw = String((req.body && req.body.password) || '');
  if (pw.length < 4) return res.status(400).json({ error: 'password too short (min 4)' });
  res.json({ hash: require('bcryptjs').hashSync(pw, 8) });
});

router.put('/:id/nodered-settings', guard.adminOnly, requireProcess, requireNodered, (req, res) => {
  const content = String((req.body && req.body.content) || '');
  // Syntax-check WITHOUT running it. The previous version validated by calling
  // `new Function(...)(module, exports, require)` — that executed the request
  // body inside the manager process (LocalSystem), i.e. remote code execution
  // for anyone who could reach this route. `node --check` parses only.
  const tmp = path.join(os.tmpdir(), `wm-nodered-${req.site.id}-${process.pid}.js`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    const chk = require('child_process').spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    if (chk.status !== 0) {
      const msg = String(chk.stderr || '').split('\n').find((l) => /SyntaxError|Error/.test(l)) || 'syntax error';
      return res.status(400).json({ error: `invalid settings.js: ${msg.trim()}` });
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  }
  if (!/module\.exports/.test(content)) {
    return res.status(400).json({ error: 'invalid settings.js: must assign module.exports' });
  }
  fs.writeFileSync(services.noderedUserSettingsPath(req.site), content, 'utf8');
  audit(req.user, 'edit-nodered-settings', req.site.name);
  res.json({ ok: true });
});

module.exports = router;
