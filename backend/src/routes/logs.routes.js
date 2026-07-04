'use strict';
const express = require('express');
const db = require('../db');
const logprune = require('../logprune');

const router = express.Router();

// Retention settings (keep last N months + auto-prune on/off).
router.get('/settings', (req, res) => {
  res.json({
    retentionMonths: logprune.retentionMonths(),
    autoPrune: logprune.autoPruneEnabled(),
  });
});
router.put('/settings', (req, res) => {
  const b = req.body || {};
  if (b.retentionMonths != null) logprune.setRetentionMonths(b.retentionMonths);
  if (b.autoPrune != null) logprune.setAutoPrune(!!b.autoPrune);
  res.json({
    ok: true,
    retentionMonths: logprune.retentionMonths(),
    autoPrune: logprune.autoPruneEnabled(),
  });
});

// Delete logs older than N months now (defaults to the configured retention).
router.post('/prune', (req, res) => {
  const months = (req.body && req.body.months) || logprune.retentionMonths();
  const deleted = logprune.pruneOlderThan(months);
  res.json({ ok: true, deleted, months });
});

// Recent persisted log lines for a channel (site-<id> or system).
router.get('/history', (req, res) => {
  const channel = req.query.channel || 'system';
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
  const rows = db
    .prepare('SELECT line, ts FROM logs WHERE channel=? ORDER BY id DESC LIMIT ?')
    .all(channel, limit);
  res.json(rows.reverse());
});

// Download a channel's full history as a .log text file.
router.get('/download', (req, res) => {
  const channel = req.query.channel || 'system';
  const rows = db.prepare('SELECT line FROM logs WHERE channel=? ORDER BY id ASC').all(channel);
  const text = rows.map((r) => r.line).join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${channel.replace(/[^\w.-]/g, '_')}.log"`);
  res.send(text);
});

// Download a channel's full history as a .log text file.
router.get('/download', (req, res) => {
  const channel = req.query.channel || 'system';
  const rows = db.prepare('SELECT line FROM logs WHERE channel=? ORDER BY id ASC').all(channel);
  const text = rows.map((r) => r.line).join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${channel.replace(/[^\w.-]/g, '_')}.log"`);
  res.send(text);
});

// Clear a channel's history.
router.delete('/history', (req, res) => {
  const channel = req.query.channel;
  if (!channel) return res.status(400).json({ error: 'channel required' });
  db.prepare('DELETE FROM logs WHERE channel=?').run(channel);
  res.json({ ok: true });
});

module.exports = router;
