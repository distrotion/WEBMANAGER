'use strict';
const express = require('express');
const db = require('../db');
const ssl = require('../ssl');
const tls = require('../tls');
const nginx = require('../nginx');
const firewall = require('../firewall');
const { audit } = require('../audit');
const { emitLog } = require('../logbus');
const guard = require('../guard');

const router = express.Router();
const getSite = (id) => db.prepare('SELECT * FROM sites WHERE id=?').get(id);

router.post('/:id/ssl/issue', guard.adminOnly, (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const channel = `site-${s.id}`;
  res.json({ started: true, channel });
  ssl
    .issue(s, channel)
    .then(() => audit(req.user, 'ssl-issue', s.name))
    .catch((e) => require('../logbus').emitLog(channel, `[fatal] ${e.message}`));
});

router.post('/:id/ssl/disable', guard.adminOnly, (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const channel = `site-${s.id}`;
  res.json({ started: true, channel });
  ssl
    .disable(s, channel)
    .then(() => audit(req.user, 'ssl-disable', s.name))
    .catch((e) => require('../logbus').emitLog(channel, `[fatal] ${e.message}`));
});

// ---- https on a site's own direct_port, second listener, local-CA cert ----
// This is the #436/#437 mechanism — separate from ssl/issue above (win-acme,
// subdomain/path exposure): opt-in per site, default off, renders nothing
// extra in writePortConf() until enabled. See tls.issueCert() for why this
// mints its own certs/<site>/ cert pair instead of reusing the panel's.
router.post('/:id/https/enable', guard.adminOnly, async (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.runtime !== 'static') {
    return res.status(400).json({ error: 'https on direct_port only applies to a static site (nginx owns the port)' });
  }
  if (!s.direct_port || !s.direct_port_enabled) {
    return res.status(400).json({ error: 'site has no enabled direct_port — enable it first' });
  }
  const httpsPort = guard.port(req.body && req.body.https_port, 'https_port');
  if (httpsPort) return res.status(400).json({ error: httpsPort });
  const port = Number((req.body && req.body.https_port) || 0);
  if (!port) return res.status(400).json({ error: 'https_port required' });
  if (port === s.direct_port) return res.status(400).json({ error: 'https_port must differ from direct_port — both listen at once during the pilot' });
  const clash = db
    .prepare('SELECT name FROM sites WHERE id!=? AND (direct_port=? OR https_port=?)')
    .get(s.id, port, port);
  if (clash) return res.status(400).json({ error: `port ${port} already used by site "${clash.name}"` });

  const names = [...tls.localIps().filter((ip) => ip !== '127.0.0.1'), '127.0.0.1'];
  try {
    tls.issueCert(s.name, names);
  } catch (e) {
    return res.status(400).json({ error: `cert issue failed: ${e.message}` });
  }

  db.prepare('UPDATE sites SET https_port=?, https_enabled=1 WHERE id=?').run(port, s.id);
  const channel = `site-${s.id}`;
  const updated = getSite(s.id);
  const r = await nginx.applyConfig(() => nginx.writePortConf(updated), channel);
  if (!r.ok) {
    db.prepare('UPDATE sites SET https_enabled=0 WHERE id=?').run(s.id);
    emitLog(channel, `[https] เปิดไม่สำเร็จ (nginx -t ล้ม): ${r.error}`);
    return res.status(400).json({ error: `nginx -t failed, https not enabled: ${r.error}` });
  }
  await nginx.reload(channel);
  await firewall.openPort(port, channel).catch(() => {});
  audit(req.user, 'https-enable', s.name, `:${port}`);
  res.json(getSite(s.id));
});

router.post('/:id/https/disable', guard.adminOnly, async (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const oldPort = s.https_port;
  db.prepare('UPDATE sites SET https_enabled=0 WHERE id=?').run(s.id);
  const channel = `site-${s.id}`;
  const updated = getSite(s.id);
  const r = await nginx.applyConfig(() => nginx.writePortConf(updated), channel);
  if (!r.ok) {
    // https_enabled=0 renders LESS than before, so a failing test here would
    // mean the .conf was already broken beforehand — restore DB to match the
    // restored file rather than leave the two disagreeing.
    db.prepare('UPDATE sites SET https_enabled=1 WHERE id=?').run(s.id);
    return res.status(400).json({ error: `nginx -t failed, https not disabled: ${r.error}` });
  }
  await nginx.reload(channel);
  if (oldPort) await firewall.closePort(oldPort, channel).catch(() => {});
  audit(req.user, 'https-disable', s.name);
  res.json(getSite(s.id));
});

module.exports = router;
