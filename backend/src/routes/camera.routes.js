'use strict';
// Camera bridge API — read a device's FTP tree over plain HTTP.
// Auth mirrors File Share: an api-token may READ (list/file) so an unattended
// consumer on another machine can pull without a login, while CONFIGURING the
// bridge and rotating the token need a real admin session. A leaked read token
// must not be able to re-point the bridge at some other device or renew itself.
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const camera = require('../camera');
const settings = require('../settings');
const secretbox = require('../secretbox');
const { audit } = require('../audit');
const { verifyAnyToken } = require('../auth');

const router = express.Router();

function cameraAuth(req, res, next) {
  const apiTok = settings.get('camera_api_token');
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : null;
  const provided = req.headers['x-api-token'] || bearer;
  if (apiTok && provided === apiTok) {
    req.user = { username: 'api-token', role: 'admin' };
    return next();
  }
  const payload = bearer && verifyAnyToken(bearer);
  if (payload && payload.role === 'admin') {
    req.user = payload;
    return next();
  }
  return res.status(401).json({ error: 'unauthorized: need x-api-token or admin login' });
}
router.use(cameraAuth);

// Real-login gate: the api-token identity is refused here.
function manageOnly(req, res, next) {
  if (req.user && req.user.username !== 'api-token') return next();
  return res.status(403).json({ error: 'manage the camera bridge from a logged-in session' });
}

// ---- read plane (api-token OR admin login) ----

router.get('/list', async (req, res) => {
  try {
    res.json(await camera.list(req.query.path, { fresh: req.query.fresh === '1' }));
  } catch (e) {
    // "escapes root" is the caller's fault; anything else is the device or the
    // link, which is a 502 — the bridge itself is fine.
    const bad = /escapes camera root|ปิดอยู่|ยังไม่ได้ตั้งค่า/.test(e.message);
    res.status(bad ? 400 : 502).json({ error: e.message });
  }
});

router.get('/file', async (req, res) => {
  const rel = String(req.query.path || '');
  if (!rel) return res.status(400).json({ error: 'path required' });
  const ext = path.extname(rel).toLowerCase();
  const types = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json',
    '.xml': 'application/xml',
  };
  try {
    // Resolve the entry BEFORE any header goes out, so a missing file is a
    // clean 404 rather than a 200 with an empty body.
    const entry = await camera.statFile(rel);
    res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
    const fname = path.basename(rel).replace(/["\r\n]/g, '');
    // inline so a browser/UI can render an image straight from this URL; a
    // downloader still gets the right filename.
    res.setHeader('Content-Disposition', `inline; filename="${fname}"`);
    if (typeof entry.size === 'number') res.setHeader('Content-Length', entry.size);
    await camera.download(rel, res);
    res.end();
  } catch (e) {
    // The body may already be streaming — a second status would throw, so only
    // answer properly when nothing has been written yet. A truncated transfer
    // is deliberately left as a broken connection: the caller must not mistake
    // a short read for a complete file.
    if (res.headersSent) return res.destroy();
    if (e.notFound) return res.status(404).json({ error: e.message });
    const bad = /escapes camera root|ปิดอยู่|ยังไม่ได้ตั้งค่า|เป็นโฟลเดอร์|path required/.test(e.message);
    res.status(bad ? 400 : 502).json({ error: e.message });
  }
});

// ---- sync (pull images to local disk) ----
// Triggering is allowed with the api-token: the consumer that reads the folder
// is the one that knows when it wants fresh pictures, and a run cannot be
// pointed anywhere — the destination and the file filter are config, which the
// token cannot touch. Reading the report is equally harmless.
const camerasync = require('../camerasync');

router.post('/sync', async (req, res) => {
  try {
    const report = await camerasync.runOnce(req.user.username === 'api-token' ? 'api' : `manual:${req.user.username}`);
    audit(req.user, 'camera-sync', `${report.copied.length} ไฟล์`, report.ok ? 'ok' : report.error || 'มีไฟล์ที่พลาด');
    res.status(report.ok ? 200 : 502).json(report);
  } catch (e) {
    if (e.busy) return res.status(409).json({ error: e.message });
    res.status(400).json({ error: e.message });
  }
});

router.get('/sync', (req, res) => res.json(camerasync.status()));

// ---- management (real login only) ----

router.get('/status', manageOnly, (req, res) => res.json(camera.status()));

router.put('/settings', manageOnly, (req, res) => {
  const b = req.body || {};
  const port = parseInt(b.port, 10) || 21;
  if (port < 1 || port > 65535) return res.status(400).json({ error: 'port out of range' });
  const root = String(b.root || '/').trim();
  if (!root.startsWith('/')) return res.status(400).json({ error: 'root ต้องขึ้นต้นด้วย /' });
  settings.set('camera_enabled', b.enabled ? '1' : '0');
  settings.set('camera_host', String(b.host || '').trim());
  settings.set('camera_port', String(port));
  settings.set('camera_user', String(b.user || '').trim());
  settings.set('camera_root', root);
  // An empty string is a real password here (the VS camera has none), so only
  // an ABSENT field means "keep what is stored".
  if (typeof b.password === 'string') settings.set('camera_pass_enc', secretbox.encrypt(b.password));
  camera.forgetCache();
  audit(req.user, 'camera-settings', settings.get('camera_host') || '(none)', root);
  res.json(camera.status());
});

// Sync settings are separate from the connection settings above so the two
// forms can be saved independently.
router.put('/sync/settings', manageOnly, (req, res) => {
  const b = req.body || {};
  const dest = String(b.dest || '').trim();
  if (dest && !path.isAbsolute(dest)) return res.status(400).json({ error: 'โฟลเดอร์ปลายทางต้องเป็น absolute path' });
  const daily = String(b.daily_at || '').trim();
  if (daily && !/^([01]\d|2[0-3]):[0-5]\d$/.test(daily)) return res.status(400).json({ error: 'เวลาต้องเป็นรูปแบบ HH:MM' });
  settings.set('camera_sync_dest', dest);
  settings.set('camera_sync_source', String(b.source || 'Programs').trim());
  settings.set('camera_sync_images_dir', String(b.images_dir || 'ModelImages').trim());
  settings.set('camera_sync_files', String(b.files ?? '000_model.png').trim());
  settings.set('camera_sync_daily_at', daily);
  audit(req.user, 'camera-sync-settings', dest || '(none)', daily ? `daily ${daily}` : 'manual');
  res.json(camerasync.status());
});

router.post('/test', manageOnly, async (req, res) => {
  const r = await camera.test();
  audit(req.user, 'camera-test', settings.get('camera_host') || '(none)', r.ok ? 'ok' : r.error);
  res.json(r);
});

router.post('/refresh', manageOnly, (req, res) => {
  camera.forgetCache();
  res.json({ ok: true });
});

router.get('/token', manageOnly, (req, res) => res.json({ hasToken: !!settings.get('camera_api_token') }));
router.post('/token', manageOnly, (req, res) => {
  const token = 'cam_' + crypto.randomBytes(24).toString('hex');
  settings.set('camera_api_token', token);
  audit(req.user, 'camera-token', 'generate');
  res.json({ token });
});
router.delete('/token', manageOnly, (req, res) => {
  settings.del('camera_api_token');
  audit(req.user, 'camera-token', 'revoke');
  res.json({ ok: true });
});

module.exports = router;
