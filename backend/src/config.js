'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// Load backend/.env into process.env (no dependency). Real env vars (inline or
// set by NSSM) win — .env only fills what isn't already set.
(() => {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    /* ignore malformed .env */
  }
})();

// On Windows Server this is C:\webmanager. For local dev it falls back to ~/webmanager-dev.
// (install.ps1 sets WEBMANAGER_ROOT via .env, so this is only the no-config fallback.)
const ROOT =
  process.env.WEBMANAGER_ROOT ||
  (process.platform === 'win32'
    ? 'C:\\webmanager'
    : path.join(os.homedir(), 'webmanager-dev'));

module.exports = {
  ROOT,
  PORT: parseInt(process.env.PORT || '8088', 10),
  JWT_SECRET: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
  JWT_EXPIRES: process.env.JWT_EXPIRES || '12h',
  ADMIN_USER: process.env.ADMIN_USER || 'admin',
  ADMIN_PASS: process.env.ADMIN_PASS || 'admin1234',
  paths: {
    data: path.join(ROOT, 'data'),
    db: path.join(ROOT, 'data', 'webmanager.db'),
    sites: path.join(ROOT, 'sites'),
    services: path.join(ROOT, 'services'),
    logs: path.join(ROOT, 'logs'),
    nginxPorts: path.join(ROOT, 'nginx', 'conf.d', 'ports'),
    nginxFront: path.join(ROOT, 'nginx', 'conf.d', 'front'),
    certs: path.join(ROOT, 'certs'),
    acme: path.join(ROOT, 'acme'),                       // ACME HTTP-01 webroot
    runtimes: path.join(ROOT, 'runtimes'),               // shared node-red install
  },
  nginx: {
    exe:
      process.env.NGINX_EXE ||
      (process.platform === 'win32' ? path.join(ROOT, 'nginx', 'nginx.exe') : 'nginx'),
    prefix: process.env.NGINX_PREFIX || path.join(ROOT, 'nginx'),
  },
  git: { exe: process.env.GIT_EXE || 'git' },
  nssm: {
    exe: process.env.NSSM_EXE || (process.platform === 'win32' ? path.join(ROOT, 'tools', 'nssm.exe') : 'nssm'),
    prefix: 'wm-', // service name prefix
  },
  ssl: {
    wacs: process.env.WACS_EXE || (process.platform === 'win32' ? path.join(ROOT, 'tools', 'win-acme', 'wacs.exe') : 'wacs'),
    email: process.env.ACME_EMAIL || 'admin@example.com',
  },
  // PM2 manages node/Node-RED apps. We invoke it as `node <pm2-bin>` (a local dep),
  // so no pm2.cmd spawn (avoids EINVAL on Windows/Node 20+). PM2_HOME keeps its
  // state/dump inside ROOT so it survives reboots and is per-install.
  pm2: {
    home: process.env.PM2_HOME || path.join(ROOT, 'pm2'),
  },
  nodeExe: process.env.NODE_EXE || process.execPath,
};
