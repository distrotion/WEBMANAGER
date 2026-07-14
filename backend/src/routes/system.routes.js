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

// --- Multiple git credentials, one per host (e.g. github.com, gitlab.com,
// git.company.com). The token whose host matches a repo URL is used; the legacy
// single git_token above still works as a catch-all fallback. ---
const db = require('../db');
router.get('/git-credentials/list', (req, res) => {
  res.json(db.prepare('SELECT id, name, host FROM git_credentials ORDER BY host').all());
});
router.post('/git-credentials/list', (req, res) => {
  const b = req.body || {};
  // Accept a bare host ('github.com'), host+owner ('github.com/distrotion',
  // 'dev.azure.com/myorg'), or a full repo URL — normalized to 'host/path'.
  let host = String(b.host || '').trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const token = String(b.token || '').trim();
  if (!host || !token) return res.status(400).json({ error: 'host and token required' });
  try {
    db.prepare(
      `INSERT INTO git_credentials (name, host, token) VALUES (?,?,?)
       ON CONFLICT(host) DO UPDATE SET name=excluded.name, token=excluded.token`
    ).run(String(b.name || '').trim() || null, host, token);
    res.status(201).json({ ok: true, host });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
router.delete('/git-credentials/list/:id', (req, res) => {
  db.prepare('DELETE FROM git_credentials WHERE id=?').run(req.params.id);
  res.json({ ok: true });
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

// ---- port tools (admin): who holds a port / kill it ----
const adminOnly = (req, res, next) =>
  req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'admin only' });

router.get('/port/:port', adminOnly, async (req, res) => {
  const port = parseInt(req.params.port, 10);
  if (!port || port < 1 || port > 65535) return res.status(400).json({ error: 'bad port' });
  res.json(await require('../ports').whoOnPort(port));
});

router.post('/killport', adminOnly, async (req, res) => {
  const port = parseInt(req.body && req.body.port, 10);
  if (!port || port < 1 || port > 65535) return res.status(400).json({ error: 'bad port' });
  if (port === config.PORT) {
    return res.status(400).json({ error: `port ${port} is webmanager itself - restart the service instead` });
  }
  const results = await require('../ports').killPort(port);
  require('../audit').audit(req.user, 'kill-port', String(port),
    results.map((r) => `${r.name || ''}(${r.pid})${r.killed ? '' : ' FAILED'}`).join(', '));
  res.json(results);
});

module.exports = router;
