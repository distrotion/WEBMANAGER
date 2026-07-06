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

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, root: config.ROOT }));

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/users', authMiddleware, require('./routes/users.routes'));
app.use('/api/logs', authMiddleware, require('./routes/logs.routes'));
app.use('/api/audit', authMiddleware, require('./routes/audit.routes'));
app.use('/api/system', authMiddleware, require('./routes/system.routes'));
app.use('/api/sites', authMiddleware, require('./routes/sites.routes'));
app.use('/api/sites', authMiddleware, require('./routes/deploy.routes'));
app.use('/api/sites', authMiddleware, require('./routes/process.routes'));
app.use('/api/sites', authMiddleware, require('./routes/ssl.routes'));

// Serve the built Flutter UI if present (one-process deploy). nginx can also serve it.
const uiDir =
  process.env.MANAGER_UI ||
  path.join(__dirname, '..', '..', 'ui', 'build', 'web');
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
const logWss = logbus.makeWss();
const ptyWss = require('./pty').makeWss();
server.on('upgrade', (req, socket, head) => {
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
  } else {
    socket.destroy();
  }
});

server.listen(config.PORT, () => {
  console.log(`[webmanager] API on :${config.PORT}  (root=${config.ROOT})`);
  console.log(`[webmanager] WebSocket logs on ws://localhost:${config.PORT}/ws?channel=<ch>&token=<jwt>`);
});
