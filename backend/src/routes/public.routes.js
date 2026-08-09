'use strict';
// Public status page API — the ONLY route in this app with no authentication at
// all. Two independent switches guard it, both off by default:
//   1. settings key `public_status_enabled` must be '1' (off = 404, as if the
//      feature did not exist — no hint that there is anything here)
//   2. each monitor must individually have public=1
//
// The response is built from an explicit WHITELIST of fields, never by removing
// keys from a row. A monitor row knows a hostname, a port, a username, a SQL
// query and an error string that routinely contains a server or database name —
// none of that may leak to an unauthenticated caller, and a whitelist stays safe
// when new columns are added later, whereas a blacklist silently starts leaking.
const express = require('express');
const db = require('../db');
const monitor = require('../monitor');
const settings = require('../settings');

const router = express.Router();

const enabled = () => settings.get('public_status_enabled') === '1';

// Cache the whole payload briefly: this endpoint is unauthenticated, so it can
// be polled by anyone at any rate, and each build touches the DB once per
// monitor for its heartbeats.
let cache = { at: 0, body: null };
const CACHE_MS = 5000;

function build() {
  const rows = db.prepare('SELECT id, name, enabled, public FROM monitors WHERE public=1 ORDER BY name').all();
  const monitors = rows.map((m) => {
    const st = monitor.status(m.id);
    return {
      name: m.name,
      // A disabled monitor reports "paused" rather than its last known state —
      // stale green would be worse than honestly saying it is not being checked.
      up: m.enabled ? (st.up === undefined ? null : st.up) : null,
      paused: !m.enabled,
      checkedAt: st.checkedAt || null,
      uptime: monitor.uptime(m.id),
      // ok + timestamp only: no latency, no error text.
      beats: monitor.heartbeats(m.id, 40).map((b) => ({ ok: b.ok, ts: b.ts })),
    };
  });
  const active = monitors.filter((m) => !m.paused);
  return {
    updatedAt: Date.now(),
    total: monitors.length,
    up: active.filter((m) => m.up === true).length,
    down: active.filter((m) => m.up === false).length,
    monitors,
  };
}

router.get('/status', (req, res) => {
  if (!enabled()) return res.status(404).json({ error: 'not found' });
  const now = Date.now();
  if (!cache.body || now - cache.at > CACHE_MS) cache = { at: now, body: build() };
  res.json(cache.body);
});

module.exports = router;
