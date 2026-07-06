'use strict';
const express = require('express');
const db = require('../db');
const pm2 = require('../pm2');
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

module.exports = router;
