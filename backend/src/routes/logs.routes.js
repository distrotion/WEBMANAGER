'use strict';
const express = require('express');
const db = require('../db');

const router = express.Router();

// Recent persisted log lines for a channel (site-<id> or system).
router.get('/history', (req, res) => {
  const channel = req.query.channel || 'system';
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
  const rows = db
    .prepare('SELECT line, ts FROM logs WHERE channel=? ORDER BY id DESC LIMIT ?')
    .all(channel, limit);
  res.json(rows.reverse());
});

// Clear a channel's history.
router.delete('/history', (req, res) => {
  const channel = req.query.channel;
  if (!channel) return res.status(400).json({ error: 'channel required' });
  db.prepare('DELETE FROM logs WHERE channel=?').run(channel);
  res.json({ ok: true });
});

module.exports = router;
