'use strict';
const path = require('path');
const os = require('os');

// On Windows Server this is D:\webmanager. For local dev it falls back to ~/webmanager-dev.
const ROOT =
  process.env.WEBMANAGER_ROOT ||
  (process.platform === 'win32'
    ? 'D:\\webmanager'
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
  nodeExe: process.env.NODE_EXE || process.execPath,
};
