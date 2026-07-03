'use strict';
const express = require('express');
const { login } = require('../auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const result = login(username, password);
  if (!result) return res.status(401).json({ error: 'invalid credentials' });
  res.json(result);
});

module.exports = router;
