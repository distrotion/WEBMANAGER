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
const os = require('os');
const path = require('path');
const db = require('./db');
const settings = require('./settings');
const secretbox = require('./secretbox');
const firewall = require('./firewall');
const netshare = require('./netshare');
const { emitLog } = require('./logbus');

// Commands a read-only account never gets to run. Blacklisted per connection
// (ftp-srv answers 502 before touching the file system) and refused again by
// WmFileSystem below, so a client that talks around the command table still
// cannot write.
const WRITE_COMMANDS = ['STOR', 'APPE', 'STOU', 'DELE', 'RMD', 'MKD', 'RNFR', 'RNTO', 'ALLO', 'SITE'];

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

function ipToInt(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

// The address a PASV reply tells the client to connect to. A box with several
// NICs (e.g. 172.101.11.39 + 172.23.10.217) must advertise the one the client
// can actually route to, so pick the interface whose subnet contains the
// client; the configured pasv host is only the fallback for clients on no
// local subnet (behind NAT). Loopback clients get loopback back.
function pasvAddressFor(clientIp, fallback, interfaces = os.networkInterfaces()) {
  const ip = String(clientIp || '').replace(/^::ffff:/, '');
  if (/^127\./.test(ip)) return ip;
  const c = ipToInt(ip);
  if (c !== null) {
    for (const list of Object.values(interfaces)) {
      for (const i of list || []) {
        if (i.family !== 'IPv4' && i.family !== 4) continue;
        if (i.internal) continue;
        const a = ipToInt(i.address);
        const m = ipToInt(i.netmask);
        if (a === null || m === null) continue;
        if (((a & m) >>> 0) === ((c & m) >>> 0)) return i.address;
      }
    }
  }
  return fallback;
}

function key(c) {
  return [c.enabled, c.port, c.pasvMin, c.pasvMax, c.tls, c.pasvHost].join('|');
}

const isUnc = (p) => /^\\\\[^\\]+\\[^\\]+/.test(String(p || ''));

// The Network share row whose unc_path covers this root (\\srv\Data covers
// \\srv\Data\sub, not \\srv\Data2). The share's stored credential is what the
// manager uses to open the UNC path — the service runs as LocalSystem and has
// no credentials of its own for other machines.
function shareFor(root) {
  if (!isUnc(root)) return null;
  const r = String(root).replace(/[\\/]+$/, '').toLowerCase();
  let best = null;
  for (const s of db.prepare('SELECT * FROM net_shares WHERE enabled=1').all()) {
    const u = String(s.unc_path).replace(/[\\/]+$/, '').toLowerCase();
    if (r === u || r.startsWith(u + '\\')) {
      if (!best || u.length > best.unc_path.length) best = s;
    }
  }
  return best;
}

// Make sure the share behind a UNC root is open before touching it. A quick
// read check first; only when that fails is the credential replayed (through
// netshare's own serialised, backed-off reconcile). Still unreadable = a clear
// 550 with the real reason — never an empty listing.
async function ensureShare(root) {
  const share = shareFor(root);
  if (!share) {
    throw fsError(`no Network share credential covers ${root} — add it under Network share first`);
  }
  if (await netshare.reachable(root)) return share;
  emitLog('system', `[ftp] ${share.unc_path} not readable — reconnecting`);
  await netshare.reconcile('system', { force: true });
  if (await netshare.reachable(root)) return share;
  const st = netshare.status(share.id);
  throw fsError(`network share ${share.unc_path} is not reachable${st && st.error ? ` — ${st.error}` : ''}`);
}

function fsError(message, code = 550) {
  const { ftpErrors } = requireDriver();
  return new ftpErrors.FileSystemError(message, code);
}

// ftp-srv's FileSystem, taught two things: a UNC root that may need its SMB
// session (re)established before every operation, and read-only accounts.
// Reads use fs.createReadStream, which on Windows opens with
// FILE_SHARE_READ|WRITE|DELETE — an instrument that keeps rewriting DATA.csv
// is never blocked by a download in progress.
function makeFileSystem(connection, { root, readOnly }) {
  const { FileSystem } = requireDriver();
  const unc = isUnc(root);
  class WmFileSystem extends FileSystem {
    async _ready() {
      if (unc) await ensureShare(root);
    }
    _denyWrite() {
      throw fsError('this account is read-only (list and download only)', 550);
    }
    async get(fileName) {
      await this._ready();
      return super.get(fileName);
    }
    async list(p = '.') {
      await this._ready();
      return super.list(p);
    }
    async chdir(p = '.') {
      await this._ready();
      return super.chdir(p);
    }
    async read(fileName, opts) {
      await this._ready();
      return super.read(fileName, opts);
    }
    async write(fileName, opts) {
      if (readOnly) this._denyWrite();
      await this._ready();
      return super.write(fileName, opts);
    }
    async delete(p) {
      if (readOnly) this._denyWrite();
      await this._ready();
      return super.delete(p);
    }
    async mkdir(p) {
      if (readOnly) this._denyWrite();
      await this._ready();
      return super.mkdir(p);
    }
    async rename(from, to) {
      if (readOnly) this._denyWrite();
      await this._ready();
      return super.rename(from, to);
    }
    async chmod(p, mode) {
      if (readOnly) this._denyWrite();
      await this._ready();
      return super.chmod(p, mode);
    }
  }
  return new WmFileSystem(connection, { root });
}

async function login({ connection, username, password }, resolve, reject) {
  const row = db.prepare('SELECT * FROM ftp_users WHERE username=? AND enabled=1').get(username);
  if (!row) return reject(new Error('Invalid username or password'));
  const real = secretbox.decrypt(row.password_enc);
  if (real === null || real !== password) return reject(new Error('Invalid username or password'));
  const root = row.root_path;
  const readOnly = !!row.read_only;
  if (isUnc(root)) {
    try {
      await ensureShare(root);
    } catch (e) {
      emitLog('system', `[ftp] "${username}": ${e.message}`);
      return reject(new Error(e.message));
    }
  } else {
    const fs = require('fs');
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      emitLog('system', `[ftp] "${username}" root_path ไม่มีอยู่จริง: ${root}`);
      return reject(new Error('server misconfiguration — ask an admin'));
    }
  }
  emitLog('system', `[ftp] "${username}" logged in${readOnly ? ' (read-only)' : ''}${isUnc(root) ? ` via share ${root}` : ''}`);
  resolve({
    root,
    fs: makeFileSystem(connection, { root, readOnly }),
    blacklist: readOnly ? WRITE_COMMANDS : [],
  });
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
    pasv_url: (clientIp) => pasvAddressFor(clientIp, c.pasvHost),
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

// Force a stop/start so a re-issued server cert is read from disk again.
async function restart() {
  await stopInstance();
  const c = cfg();
  if (c.enabled) {
    try {
      await startInstance(c);
    } catch (e) {
      emitLog('system', `[ftp] เริ่มไม่สำเร็จ: ${e.message}`);
    }
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
    // every non-loopback IPv4 this box has — PASV advertises the one on the
    // client's subnet, pasvHost only when no interface matches
    pasvAddresses: require('./tls').localIps().filter((ip) => ip !== '127.0.0.1'),
    userCount: db.prepare('SELECT COUNT(*) n FROM ftp_users').get().n,
  };
}

function start() {
  reconcile().catch((e) => emitLog('system', `[ftp] เริ่มไม่สำเร็จ: ${e.message}`));
}

module.exports = { start, reconcile, restart, status, shareFor, isUnc, pasvAddressFor, WRITE_COMMANDS };
