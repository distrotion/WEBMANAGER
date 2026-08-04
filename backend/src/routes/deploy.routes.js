'use strict';
const express = require('express');
const db = require('../db');
const deploy = require('../deploy');
const nginx = require('../nginx');
const guard = require('../guard');
const deploylock = require('../deploylock');
const { audit } = require('../audit');

const router = express.Router();
const getSite = (id) => db.prepare('SELECT * FROM sites WHERE id=?').get(id);

// Take the per-site deploy lock or answer 409. Shared with the CI/CD watcher and
// rollback: two jobs writing the same working tree would corrupt it.
function lockOr409(req, res, s) {
  const release = deploylock.acquire(s.id, (req.user && req.user.username) || 'manual');
  if (release) return release;
  const who = deploylock.held(s.id);
  res.status(409).json({ error: `already deploying (started by ${who ? who.who : 'another job'})` });
  return null;
}

// Kick off deploy; logs stream over WebSocket channel `site-<id>`.
router.post('/:id/deploy', guard.adminOnly, (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const release = lockOr409(req, res, s);
  if (!release) return;
  const channel = `site-${s.id}`;
  res.json({ started: true, channel });
  const job =
    s.runtime === 'node'
      ? deploy.deployNode(s, req.user)
      : s.runtime === 'nodered'
      ? require('../pm2').start(s, channel)
      : deploy.deployStatic(s, req.user);
  Promise.resolve(job)
    .catch((e) => require('../logbus').emitLog(channel, `[fatal] ${e.message}`))
    .finally(release);
});

// Deploy history for the site (drives the rollback picker).
router.get('/:id/releases', (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const rows = db
    .prepare(
      'SELECT id, timestamp, commit_hash, deployed_by, note FROM releases WHERE site_id=? ORDER BY id DESC LIMIT 50'
    )
    .all(s.id);
  res.json(
    rows.map((r) => ({
      ...r,
      current: r.timestamp === s.current_release || (!!r.commit_hash && r.commit_hash === s.last_commit),
    }))
  );
});

// Roll back to a specific earlier release (manual, admin).
router.post('/:id/rollback/:releaseId', guard.adminOnly, (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const rel = db.prepare('SELECT * FROM releases WHERE id=? AND site_id=?').get(req.params.releaseId, s.id);
  if (!rel) return res.status(404).json({ error: 'release not found' });
  const release = lockOr409(req, res, s);
  if (!release) return;
  const channel = `site-${s.id}`;
  res.json({ started: true, channel });
  deploy
    .rollbackTo(s, rel, req.user)
    .catch((e) => require('../logbus').emitLog(channel, `[fatal] ${e.message}`))
    .finally(release);
});

// Validate + reload nginx (system channel)
router.post('/:id/reload', guard.adminOnly, async (req, res) => {
  res.json({ started: true, channel: 'system' });
  const t = await nginx.test('system');
  if (t.code === 0) await nginx.reload('system');
  audit(req.user, 'nginx-reload', 'system');
});

module.exports = router;
