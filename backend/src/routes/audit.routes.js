'use strict';
const express = require('express');
const db = require('../db');
const { requireRole } = require('../auth');

const router = express.Router();
router.use(requireRole('admin')); // audit trail is admin-only

router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 300, 3000);
  const rows = db
    .prepare('SELECT id, who, action, target, detail, time FROM audit ORDER BY id DESC LIMIT ?')
    .all(limit);
  res.json(rows);
});

module.exports = router;
