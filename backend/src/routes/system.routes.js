'use strict';
const express = require('express');
const system = require('../system');
const nginx = require('../nginx');
const settings = require('../settings');
const git = require('../git');
const config = require('../config');
const { run } = require('../runner');

const router = express.Router();

// --- Git credentials (Personal Access Token for private repos) ---
router.get('/git-credentials', (req, res) => {
  res.json({ hasToken: !!settings.get('git_token') });
});
router.put('/git-credentials', (req, res) => {
  const t = ((req.body && req.body.token) || '').trim();
  if (!t) return res.status(400).json({ error: 'token required' });
  settings.set('git_token', t);
  res.json({ ok: true, hasToken: true });
});
router.delete('/git-credentials', (req, res) => {
  settings.del('git_token');
  res.json({ ok: true, hasToken: false });
});
// Test the token against a repo URL (streams to the system channel, token masked).
router.post('/git-credentials/test', (req, res) => {
  const url = req.body && req.body.url;
  if (!url) return res.status(400).json({ error: 'url required' });
  res.json({ started: true, channel: 'system' });
  git.lsRemote(url, 'system');
});

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
