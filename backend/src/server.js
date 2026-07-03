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

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, root: config.ROOT }));

app.use('/api/auth', require('./routes/auth.routes'));
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
  app.use(express.static(uiDir));
  app.get(/^(?!\/api|\/ws).*/, (req, res) => res.sendFile(path.join(uiDir, 'index.html')));
  console.log(`[webmanager] serving UI from ${uiDir}`);
} else {
  console.log(`[webmanager] UI build not found at ${uiDir} (build the Flutter app to enable)`);
}

const server = http.createServer(app);
logbus.attach(server);

server.listen(config.PORT, () => {
  console.log(`[webmanager] API on :${config.PORT}  (root=${config.ROOT})`);
  console.log(`[webmanager] WebSocket logs on ws://localhost:${config.PORT}/ws?channel=<ch>&token=<jwt>`);
});
