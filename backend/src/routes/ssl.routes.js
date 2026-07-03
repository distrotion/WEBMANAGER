'use strict';
const express = require('express');
const db = require('../db');
const ssl = require('../ssl');
const { audit } = require('../audit');

const router = express.Router();
const getSite = (id) => db.prepare('SELECT * FROM sites WHERE id=?').get(id);

router.post('/:id/ssl/issue', (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const channel = `site-${s.id}`;
  res.json({ started: true, channel });
  ssl
    .issue(s, channel)
    .then(() => audit(req.user, 'ssl-issue', s.name))
    .catch((e) => require('../logbus').emitLog(channel, `[fatal] ${e.message}`));
});

router.post('/:id/ssl/disable', (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const channel = `site-${s.id}`;
  res.json({ started: true, channel });
  ssl
    .disable(s, channel)
    .then(() => audit(req.user, 'ssl-disable', s.name))
    .catch((e) => require('../logbus').emitLog(channel, `[fatal] ${e.message}`));
});

module.exports = router;
