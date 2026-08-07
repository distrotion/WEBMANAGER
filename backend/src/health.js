'use strict';
// Post-deploy health gate. A node app is probed over HTTP on its direct port
// until it answers or the time budget runs out (apps need startup time — PM2
// returning says nothing about the app actually serving). "Healthy" = any HTTP
// answer below 500: an API backend legitimately 404s on '/', but a refused
// connection, a hang, or a 5xx means the new code is not fit to keep.
// Static sites are skipped — nginx -t already gates their deploy.
const http = require('http');
const settings = require('./settings');
const { emitLog } = require('./logbus');

function probeOnce(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 4000 }, (res) => {
      res.resume(); // drain so the socket frees up
      resolve(res.statusCode < 500);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

// Poll every 2s within the budget (settings key health_timeout_sec, default 30).
// Per-site mode: 'off' (default — nothing happens), 'warn' (probe and report,
// never roll back), 'rollback' (probe and revert a bad deploy).
async function waitHealthy(site, channel) {
  const mode = String(site.health_check || 'off').toLowerCase();
  if (mode === 'off') return { ok: true, skipped: true, mode };
  if (site.runtime !== 'node' || !site.direct_port) return { ok: true, skipped: true, mode };
  const total = Math.max(5, parseInt(settings.get('health_timeout_sec'), 10) || 30);
  const urlPath = '/';
  emitLog(channel, `[health] probing http://127.0.0.1:${site.direct_port}${urlPath} (up to ${total}s)`);
  const deadline = Date.now() + total * 1000;
  for (;;) {
    if (await probeOnce(site.direct_port, urlPath)) {
      emitLog(channel, '[health] OK — app answers');
      return { ok: true, mode };
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  emitLog(channel, `[health] FAILED — no healthy answer within ${total}s`);
  return { ok: false, mode };
}

module.exports = { waitHealthy };
