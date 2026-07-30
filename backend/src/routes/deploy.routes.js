'use strict';
const express = require('express');
const db = require('../db');
const deploy = require('../deploy');
const nginx = require('../nginx');
const guard = require('../guard');

const router = express.Router();
const getSite = (id) => db.prepare('SELECT * FROM sites WHERE id=?').get(id);

// Kick off deploy; logs stream over WebSocket channel `site-<id>`.
router.post('/:id/deploy', guard.adminOnly, (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const channel = `site-${s.id}`;
  res.json({ started: true, channel });
  const job =
    s.runtime === 'node'
      ? deploy.deployNode(s, req.user)
      : s.runtime === 'nodered'
      ? require('../pm2').start(s, channel)
      : deploy.deployStatic(s, req.user);
  Promise.resolve(job).catch((e) => require('../logbus').emitLog(channel, `[fatal] ${e.message}`));
});

// Validate + reload nginx (system channel)
router.post('/:id/reload', guard.adminOnly, async (req, res) => {
  res.json({ started: true, channel: 'system' });
  const t = await nginx.test('system');
  if (t.code === 0) await nginx.reload('system');
});

module.exports = router;
