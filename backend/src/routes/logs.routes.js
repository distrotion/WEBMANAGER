'use strict';
const express = require('express');
const db = require('../db');
const logprune = require('../logprune');

const guard = require('../guard');

const router = express.Router();

// Retention settings (keep last N months + auto-prune on/off).
router.get('/settings', (req, res) => {
  res.json({
    retentionMonths: logprune.retentionMonths(),
    autoPrune: logprune.autoPruneEnabled(),
  });
});
router.put('/settings', guard.adminOnly, (req, res) => {
  const b = req.body || {};
  if (b.retentionMonths != null) logprune.setRetentionMonths(b.retentionMonths);
  if (b.autoPrune != null) logprune.setAutoPrune(!!b.autoPrune);
  res.json({
    ok: true,
    retentionMonths: logprune.retentionMonths(),
    autoPrune: logprune.autoPruneEnabled(),
  });
});

// Auto-deploy history — when the git watcher pulled + deployed each site.
router.get('/autodeploy', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
  res.json(
    db.prepare('SELECT * FROM autodeploy_log ORDER BY id DESC LIMIT ?').all(limit)
  );
});

// Delete logs older than N months now (defaults to the configured retention).
router.post('/prune', guard.adminOnly, (req, res) => {
  const months = (req.body && req.body.months) || logprune.retentionMonths();
  const deleted = logprune.pruneOlderThan(months);
  res.json({ ok: true, deleted, months });
});

// Recent persisted log lines for a channel (site-<id> or system).
// Same rule as the WebSocket (logbus.js): log lines carry command output — git
// URLs, share names, DOMAIN\\account, netsh and nginx calls — so the server-wide
// channel is an admin view. It was admin-only over ws:// but open over REST.
function channelGuard(req, res, next) {
  const channel = String(req.query.channel || 'system');
  if (channel === 'system' || channel === '*') return guard.adminOnly(req, res, next);
  return next();
}

router.get('/history', channelGuard, (req, res) => {
  const channel = req.query.channel || 'system';
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
  const rows = db
    .prepare('SELECT line, ts FROM logs WHERE channel=? ORDER BY id DESC LIMIT ?')
    .all(channel, limit);
  res.json(rows.reverse());
});

// Download a channel's full history as a .log text file.
router.get('/download', channelGuard, (req, res) => {
  const channel = req.query.channel || 'system';
  const rows = db.prepare('SELECT line FROM logs WHERE channel=? ORDER BY id ASC').all(channel);
  const text = rows.map((r) => r.line).join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${channel.replace(/[^\w.-]/g, '_')}.log"`);
  res.send(text);
});

// Clear a channel's history.
router.delete('/history', guard.adminOnly, (req, res) => {
  const channel = req.query.channel;
  if (!channel) return res.status(400).json({ error: 'channel required' });
  db.prepare('DELETE FROM logs WHERE channel=?').run(channel);
  res.json({ ok: true });
});

module.exports = router;
