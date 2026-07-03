'use strict';
const express = require('express');
const db = require('../db');
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

router.post('/:id/start', requireProcess, action('start', services.start));
router.post('/:id/stop', requireProcess, action('stop', services.stop));
router.post('/:id/restart', requireProcess, action('restart', services.restart));

router.get('/:id/status', requireProcess, async (req, res) => {
  const status = await services.refreshStatus(req.site);
  res.json({ status });
});

router.post('/:id/logs', requireProcess, (req, res) => {
  const channel = `site-${req.site.id}`;
  res.json({ started: true, channel });
  services.tailLog(req.site, channel, 300);
});

module.exports = router;
