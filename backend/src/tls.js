'use strict';
// Optional HTTPS for the panel using a self-generated LOCAL CA (method B): the
// server mints its own CA + a server cert (SAN = this box's IPs + hostname). Once
// the CA cert is installed as a Trusted Root on the machines that open the panel,
// browsers show a normal padlock with no warning. HTTPS runs on its own port
// alongside plain HTTP, so toggling it never drops the current session.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const forge = require('node-forge');
const config = require('./config');
const settings = require('./settings');
const { emitLog } = require('./logbus');

const DIR = path.join(config.paths.certs, 'panel');
const CA_CERT = path.join(DIR, 'wm-ca.crt');
const CA_KEY = path.join(DIR, 'wm-ca.key');
const SRV_CERT = path.join(DIR, 'panel.crt');
const SRV_KEY = path.join(DIR, 'panel.key');
const HTTPS_PORT = parseInt(process.env.WM_HTTPS_PORT || '8443', 10);

let server = null;
let _app = null;
let _onUpgrade = null;

function caCertPath() {
  return CA_CERT;
}

function localIps() {
  const ips = ['127.0.0.1'];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
  }
  return [...new Set(ips)];
}

function ensureCa() {
  fs.mkdirSync(DIR, { recursive: true });
  if (fs.existsSync(CA_CERT) && fs.existsSync(CA_KEY)) {
    return {
      cert: forge.pki.certificateFromPem(fs.readFileSync(CA_CERT, 'utf8')),
      key: forge.pki.privateKeyFromPem(fs.readFileSync(CA_KEY, 'utf8')),
    };
  }
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 86400000);
  cert.validity.notAfter = new Date(now.getFullYear() + 10, now.getMonth(), now.getDate());
  const attrs = [
    { name: 'commonName', value: 'WEBMANAGER Local CA' },
    { name: 'organizationName', value: 'WEBMANAGER' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  fs.writeFileSync(CA_CERT, forge.pki.certificateToPem(cert));
  fs.writeFileSync(CA_KEY, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  emitLog('system', '[https] generated local CA');
  return { cert, key: keys.privateKey };
}

// (Re)issue the server cert, e.g. to pick up new IPs. Regenerates on demand.
function makeServerCert() {
  const ca = ensureCa();
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 86400000);
  cert.validity.notAfter = new Date(now.getFullYear() + 5, now.getMonth(), now.getDate());
  cert.setSubject([{ name: 'commonName', value: os.hostname() }]);
  cert.setIssuer(ca.cert.subject.attributes);
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: os.hostname() },
  ];
  for (const ip of localIps()) altNames.push({ type: 7, ip });
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  fs.writeFileSync(SRV_CERT, forge.pki.certificateToPem(cert));
  fs.writeFileSync(SRV_KEY, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  emitLog('system', `[https] issued server cert (SAN: ${localIps().join(', ')}, ${os.hostname()})`);
}

// Remember the express app + ws upgrade handler so start() can reuse them.
function attach(app, onUpgrade) {
  _app = app;
  _onUpgrade = onUpgrade;
}

function start() {
  if (server || !_app) return status();
  if (!fs.existsSync(SRV_CERT) || !fs.existsSync(SRV_KEY)) makeServerCert();
  const opts = { key: fs.readFileSync(SRV_KEY), cert: fs.readFileSync(SRV_CERT) };
  server = https.createServer(opts, _app);
  if (_onUpgrade) server.on('upgrade', _onUpgrade);
  server.on('error', (e) => {
    emitLog('system', `[https] listen error: ${e.message}`);
    server = null;
  });
  server.listen(HTTPS_PORT, () => emitLog('system', `[https] panel on https://<host>:${HTTPS_PORT}`));
  settings.set('https_enabled', '1');
  require('./firewall').openPort(HTTPS_PORT, 'system').catch(() => {});
  return status();
}

function stop() {
  if (server) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    server = null;
  }
  settings.set('https_enabled', '0');
  return status();
}

// Re-mint the server cert and restart the listener (after an IP change).
function regenerate() {
  makeServerCert();
  if (server) {
    stop();
    settings.set('https_enabled', '1');
    start();
  }
  return status();
}

function status() {
  return {
    enabled: settings.get('https_enabled') === '1',
    running: !!server,
    port: HTTPS_PORT,
    hasCa: fs.existsSync(CA_CERT),
    ips: localIps().filter((x) => x !== '127.0.0.1'),
    hostname: os.hostname(),
  };
}

module.exports = { attach, start, stop, regenerate, status, caCertPath, HTTPS_PORT };
