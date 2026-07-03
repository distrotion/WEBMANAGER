'use strict';
const express = require('express');
const system = require('../system');
const nginx = require('../nginx');

const router = express.Router();

router.get('/requirements', async (req, res) => {
  try {
    res.json(await system.requirements());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Browse server folders to locate a local source.
router.get('/browse', (req, res) => {
  try {
    res.json(system.browse(req.query.path));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// nginx lifecycle from the panel (logs stream on the `system` channel).
const NGINX_ACTIONS = { test: nginx.test, start: nginx.start, stop: nginx.stop, reload: nginx.reload };
router.post('/nginx/:action', (req, res) => {
  const fn = NGINX_ACTIONS[req.params.action];
  if (!fn) return res.status(400).json({ error: 'unknown action' });
  res.json({ started: true, channel: 'system' });
  fn('system').catch((e) => require('../logbus').emitLog('system', `[fatal] ${e.message}`));
});

module.exports = router;
