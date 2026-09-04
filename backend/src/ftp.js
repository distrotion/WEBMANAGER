'use strict';
// FTP/FTPS server — general-purpose file access for any standard client
// (FileZilla, WinSCP, curl), unlike File Share (HTTP, read-only, one-off pulls)
// or Network share (credentials the manager itself uses, not exposed to others).
// One server for the whole box, not one per account: accounts (ftp_users) each
// get their own username/password and are chrooted to their own root_path by
// ftp-srv itself, the same way shares.root_path scopes File Share.
//
// Lazy-required like the DB monitor drivers (mssql/pg/mongodb): most installs
// will never turn this on, so it must not cost anything at boot, and if the
// package is ever missing this fails loud on enable, not silently at startup.
const db = require('./db');
const settings = require('./settings');
const secretbox = require('./secretbox');
const firewall = require('./firewall');
const { emitLog } = require('./logbus');

let instance = null; // the live FtpSrv
let instanceKey = null;
let instanceCfg = null; // the config the live instance was actually started with

function requireDriver() {
  try {
    return require('ftp-srv');
  } catch {
    throw new Error('ftp-srv package not installed — run npm install in backend/');
  }
}

function cfg() {
  return {
    enabled: settings.get('ftp_enabled') === '1',
    port: parseInt(settings.get('ftp_port') || '21', 10),
    pasvMin: parseInt(settings.get('ftp_pasv_min') || '50000', 10),
    pasvMax: parseInt(settings.get('ftp_pasv_max') || '50100', 10),
    tls: settings.get('ftp_tls') === '1',
    // Advertised IP for passive mode — the address a client is told to open a
    // data connection to. Without this a client behind NAT/on another subnet
    // gets told to connect to an interface it can't reach.
    pasvHost: settings.get('ftp_pasv_host') || firstLanIp(),
  };
}

function firstLanIp() {
  const ips = require('./tls').localIps().filter((ip) => ip !== '127.0.0.1');
  return ips[0] || '127.0.0.1';
}

function key(c) {
  return [c.enabled, c.port, c.pasvMin, c.pasvMax, c.tls, c.pasvHost].join('|');
}

async function login({ username, password }, resolve, reject) {
  const row = db.prepare('SELECT * FROM ftp_users WHERE username=? AND enabled=1').get(username);
  if (!row) return reject(new Error('Invalid username or password'));
  const real = secretbox.decrypt(row.password_enc);
  if (real === null || real !== password) return reject(new Error('Invalid username or password'));
  const fs = require('fs');
  if (!fs.existsSync(row.root_path) || !fs.statSync(row.root_path).isDirectory()) {
    emitLog('system', `[ftp] "${username}" root_path ไม่มีอยู่จริง: ${row.root_path}`);
    return reject(new Error('server misconfiguration — ask an admin'));
  }
  emitLog('system', `[ftp] "${username}" logged in`);
  resolve({ root: row.root_path });
}

async function stopInstance() {
  if (!instance) return;
  try {
    await instance.close();
  } catch {
    /* already down */
  }
  if (instanceCfg) {
    firewall.closePort(instanceCfg.port, 'system').catch(() => {});
    firewall.closePortRange(instanceCfg.pasvMin, instanceCfg.pasvMax, 'system').catch(() => {});
  }
  instance = null;
  instanceKey = null;
  instanceCfg = null;
}

async function startInstance(c) {
  const { FtpSrv } = requireDriver();
  const opts = {
    url: `ftp://0.0.0.0:${c.port}`,
    pasv_url: c.pasvHost,
    pasv_min: c.pasvMin,
    pasv_max: c.pasvMax,
    anonymous: false,
    greeting: ['WEBMANAGER FTP'],
  };
  if (c.tls) {
    const { certPath, keyPath } = require('./tls').ensureServerCert();
    const fs = require('fs');
    // Explicit AUTH TLS (plain ftp:// URL + a tls block) rather than implicit
    // ftps:// — every mainstream client (FileZilla included) negotiates it
    // automatically, whereas implicit FTPS needs a client set to a fixed
    // "FTPS (implicit)" mode ahead of time.
    opts.tls = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  const server = new FtpSrv(opts);
  server.on('login', login);
  server.on('client-error', ({ context, error }) => {
    emitLog('system', `[ftp] client error (${context}): ${error.message}`);
  });
  await server.listen();
  instance = server;
  instanceKey = key(c);
  instanceCfg = c;
  emitLog('system', `[ftp] listening :${c.port} (passive ${c.pasvMin}-${c.pasvMax}, advertising ${c.pasvHost}${c.tls ? ', TLS' : ''})`);
  firewall.openPort(c.port, 'system').catch(() => {});
  firewall.openPortRange(c.pasvMin, c.pasvMax, 'system').catch(() => {});
}

// Bring the running server in line with settings — called on boot and after
// any settings change. Account add/edit/delete does NOT need this: login()
// reads ftp_users live on every attempt, so those take effect immediately.
async function reconcile() {
  const c = cfg();
  if (!c.enabled) {
    await stopInstance();
    return status();
  }
  if (instance && instanceKey === key(c)) return status();
  await stopInstance();
  try {
    await startInstance(c);
  } catch (e) {
    emitLog('system', `[ftp] เริ่มไม่สำเร็จ: ${e.message}`);
  }
  return status();
}

function status() {
  const c = cfg();
  return {
    enabled: c.enabled,
    running: !!instance,
    port: c.port,
    pasvMin: c.pasvMin,
    pasvMax: c.pasvMax,
    tls: c.tls,
    pasvHost: c.pasvHost,
    userCount: db.prepare('SELECT COUNT(*) n FROM ftp_users').get().n,
  };
}

function start() {
  reconcile().catch((e) => emitLog('system', `[ftp] เริ่มไม่สำเร็จ: ${e.message}`));
}

module.exports = { start, reconcile, status };
