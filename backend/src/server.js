'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const { seedAdmin, authMiddleware } = require('./auth');
const nginx = require('./nginx');
const logbus = require('./logbus');

seedAdmin();
nginx.bootstrapPrefix();
for (const d of [config.paths.logs, config.paths.certs, config.paths.services, config.paths.sites]) {
  fs.mkdirSync(d, { recursive: true });
}

// Auto-prune persisted logs to the configured retention (on boot + hourly).
const logprune = require('./logprune');
const runPrune = () => {
  try {
    logprune.autoPrune();
  } catch {
    /* ignore */
  }
};
runPrune();
setInterval(runPrune, 60 * 60 * 1000).unref();

// Restore PM2-managed apps after a reboot (best effort).
require('./pm2').ensureUp().catch(() => {});

// CI/CD: poll git remotes and auto-deploy sites that have autodeploy enabled.
require('./autodeploy').start();

// Remote Gateway: open raw-TCP forwarders for enabled gateways.
require('./gateway').start();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) =>
  res.json({ ok: true, root: config.ROOT, version: require('./version') })
);

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/users', authMiddleware, require('./routes/users.routes'));
app.use('/api/logs', authMiddleware, require('./routes/logs.routes'));
app.use('/api/audit', authMiddleware, require('./routes/audit.routes'));
app.use('/api/system', authMiddleware, require('./routes/system.routes'));
app.use('/api/fleet', authMiddleware, require('./routes/fleet.routes'));
// gateway routes do their own auth (loopback / x-api-token / admin login)
app.use('/api/gateways', require('./routes/gateway.routes'));
app.use('/api/sites', authMiddleware, require('./routes/sites.routes'));
app.use('/api/sites', authMiddleware, require('./routes/deploy.routes'));
app.use('/api/sites', authMiddleware, require('./routes/process.routes'));
app.use('/api/sites', authMiddleware, require('./routes/ssl.routes'));

// Serve the built Flutter UI if present (one-process deploy). nginx can also serve it.
const uiDir =
  process.env.MANAGER_UI ||
  path.join(__dirname, '..', '..', 'ui', 'build', 'web');
// Public download of the local-CA cert (public part only) so client machines can
// install it as a Trusted Root and get a warning-free padlock. Not secret.
app.get('/panel-ca.crt', (req, res) => {
  const p = require('./tls').caCertPath();
  if (!fs.existsSync(p)) return res.status(404).send('no CA yet — enable HTTPS first');
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="webmanager-ca.crt"');
  res.send(fs.readFileSync(p));
});

if (fs.existsSync(path.join(uiDir, 'index.html'))) {
  // Never cache the app shell / bootstrap so a redeploy is picked up immediately.
  app.use((req, res, next) => {
    if (/\/(index\.html)?$|flutter_bootstrap\.js|flutter_service_worker\.js/.test(req.path)) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    next();
  });
  app.use(express.static(uiDir));
  app.get(/^(?!\/api|\/ws).*/, (req, res) => res.sendFile(path.join(uiDir, 'index.html')));
  console.log(`[webmanager] serving UI from ${uiDir}`);
} else {
  console.log(`[webmanager] UI build not found at ${uiDir} (build the Flutter app to enable)`);
}

const server = http.createServer(app);

// Route WebSocket upgrades by path: /ws = live logs, /pty = interactive shell.
// Shared by the HTTP and (optional) HTTPS listeners.
const logWss = logbus.makeWss();
const ptyWss = require('./pty').makeWss();
function handleUpgrade(req, socket, head) {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return socket.destroy();
  }
  if (pathname === '/ws') {
    logWss.handleUpgrade(req, socket, head, (ws) => logWss.emit('connection', ws, req));
  } else if (pathname === '/pty') {
    ptyWss.handleUpgrade(req, socket, head, (ws) => ptyWss.emit('connection', ws, req));
  } else if (require('./fleetproxy').handleUpgrade(req, socket, head)) {
    // fleet ws/pty proxy handled it
  } else {
    socket.destroy();
  }
}
server.on('upgrade', handleUpgrade);

// Optional HTTPS panel (self-generated local CA) — starts if it was left enabled.
const tls = require('./tls');
tls.attach(app, handleUpgrade);
if (require('./settings').get('https_enabled') === '1') {
  try {
    tls.start();
  } catch (e) {
    console.error('[webmanager] https start failed:', e.message);
  }
}

server.listen(config.PORT, () => {
  console.log(`[webmanager] API on :${config.PORT}  (root=${config.ROOT})`);
  console.log(`[webmanager] WebSocket logs on ws://localhost:${config.PORT}/ws?channel=<ch>&token=<jwt>`);
});
