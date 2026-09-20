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
const sockets = new Set(); // track live sockets so "off" drops them immediately

function caCertPath() {
  return CA_CERT;
}

// Let other TLS-capable listeners (FTPS) reuse the same server cert instead of
// minting their own — one cert to trust, one CA to install on client machines.
function ensureServerCert() {
  if (!fs.existsSync(SRV_CERT) || !fs.existsSync(SRV_KEY)) makeServerCert();
  return { certPath: SRV_CERT, keyPath: SRV_KEY };
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
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true },
    { name: 'subjectKeyIdentifier' },
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
  // Encode names as UTF8String — the default PrintableString rejects chars like
  // '_' (common in Windows hostnames, e.g. THAIPARKER_QC_SYSTEM), producing a
  // malformed cert that strict parsers (Chrome/BoringSSL) refuse with
  // ERR_SSL_SERVER_CERT_BAD_FORMAT even though OpenSSL/curl accept it.
  const U = forge.asn1.Type.UTF8;
  cert.setSubject([{ name: 'commonName', value: os.hostname(), valueTagClass: U }]);
  cert.setIssuer(ca.cert.subject.attributes.map((a) => ({ ...a, valueTagClass: U })));
  const altNames = [{ type: 2, value: 'localhost' }];
  // dNSName is IA5String (allows '_'); include the hostname only if it has no
  // whitespace, then all IPs.
  if (os.hostname() && !/\s/.test(os.hostname())) altNames.push({ type: 2, value: os.hostname() });
  for (const ip of localIps()) altNames.push({ type: 7, ip });
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: ca.cert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  fs.writeFileSync(SRV_CERT, forge.pki.certificateToPem(cert));
  fs.writeFileSync(SRV_KEY, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  emitLog('system', `[https] issued server cert (SAN: ${localIps().join(', ')}, ${os.hostname()})`);
}

// Issue a cert for something OTHER than the panel itself (a proxied site),
// signed by the same local CA so one CA install on a client machine covers
// everything. Deliberately separate from makeServerCert(): that function
// overwrites certs/panel/panel.crt|key, which ftp.js's ensureServerCert() also
// serves for FTPS — reusing it here would silently re-key FTPS and, via
// regenerate()/start(), drop every live panel HTTPS connection. This writes
// its own file pair under certs/<key>/ instead, the same layout ssl.js's
// win-acme path already uses, so nginx.js needs no change to read either kind.
//
// `names` must include every literal address a browser will type — SAN
// checking is exact-match, so a site reached by raw IP (172.23.10.34, no DNS
// name) needs that IP as an iPAddress entry or the handshake fails even with
// the CA trusted. Caller decides what belongs there; localIps() is available
// via module.exports for building that list.
function issueCert(key, names) {
  if (!key || /[\\/]/.test(key)) throw new Error('issueCert: key must be a plain folder name');
  const list = (names || []).filter(Boolean);
  if (!list.length) throw new Error('issueCert: at least one name/IP is required');

  const ca = ensureCa();
  const dir = path.join(config.paths.certs, key);
  fs.mkdirSync(dir, { recursive: true });

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '03' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 86400000);
  cert.validity.notAfter = new Date(now.getFullYear() + 5, now.getMonth(), now.getDate());
  const U = forge.asn1.Type.UTF8;
  cert.setSubject([{ name: 'commonName', value: key, valueTagClass: U }]);
  cert.setIssuer(ca.cert.subject.attributes.map((a) => ({ ...a, valueTagClass: U })));
  const altNames = list.map((n) =>
    /^\d{1,3}(\.\d{1,3}){3}$/.test(n) ? { type: 7, ip: n } : { type: 2, value: n }
  );
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: ca.cert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());

  // fullchain = leaf + CA, so a client that only trusts the CA (not this leaf
  // directly) can still build the chain — same shape ssl.js's win-acme output
  // and nginx.js's ssl_certificate directive already expect.
  const fullchain = forge.pki.certificateToPem(cert) + forge.pki.certificateToPem(ca.cert);
  fs.writeFileSync(path.join(dir, 'fullchain.pem'), fullchain, 'utf8');
  fs.writeFileSync(path.join(dir, 'privkey.pem'), forge.pki.privateKeyToPem(keys.privateKey), {
    mode: 0o600,
  });
  emitLog('system', `[tls] issued cert for "${key}" (SAN: ${list.join(', ')})`);
  return { certPath: path.join(dir, 'fullchain.pem'), keyPath: path.join(dir, 'privkey.pem') };
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
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
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
      if (server.closeAllConnections) server.closeAllConnections();
    } catch {
      /* ignore */
    }
    // close() only stops NEW connections; destroy live keep-alive sockets too so
    // an already-open browser tab is dropped the moment HTTPS is turned off.
    for (const s of sockets) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    sockets.clear();
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

// ---- one CA for every manager host ----------------------------------------
// Each host mints its own CA by default, so client PCs would have to trust one
// per server. Export from the host whose CA the PCs already trust, import on
// the others: from then on every cert those hosts issue chains to that one CA.
// The private key only ever leaves the box wrapped in a passphrase (PKCS#8,
// AES-256) — the panel itself may be reached over plain http.
function caFingerprint(cert) {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const hex = forge.md.sha256.create().update(der).digest().toHex().toUpperCase();
  return hex.match(/.{2}/g).join(':');
}

function caInfo() {
  if (!fs.existsSync(CA_CERT)) return { hasCa: false };
  const cert = forge.pki.certificateFromPem(fs.readFileSync(CA_CERT, 'utf8'));
  const cn = cert.subject.getField('CN');
  return {
    hasCa: true,
    fingerprint: caFingerprint(cert),
    subject: cn ? cn.value : '',
    notAfter: cert.validity.notAfter.toISOString(),
  };
}

function exportCa(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) {
    throw new Error('passphrase must be at least 12 characters');
  }
  const ca = ensureCa();
  return {
    cert: forge.pki.certificateToPem(ca.cert),
    key: forge.pki.encryptRsaPrivateKey(ca.key, passphrase, { algorithm: 'aes256' }),
    fingerprint: caFingerprint(ca.cert),
  };
}

// Every leaf under certs/<name>/ (issueCert output) re-signed by the current CA,
// keeping each cert's own SAN list. Returns the names that were re-issued.
function reissueLeafCerts() {
  const done = [];
  if (!fs.existsSync(config.paths.certs)) return done;
  for (const name of fs.readdirSync(config.paths.certs)) {
    if (name === 'panel' || name.startsWith('backup-')) continue;
    const file = path.join(config.paths.certs, name, 'fullchain.pem');
    if (!fs.existsSync(file)) continue;
    const leafPem = fs.readFileSync(file, 'utf8').split('-----END CERTIFICATE-----')[0] + '-----END CERTIFICATE-----';
    const san = forge.pki.certificateFromPem(leafPem).getExtension('subjectAltName');
    const names = ((san && san.altNames) || []).map((n) => (n.type === 7 ? n.ip : n.value)).filter(Boolean);
    if (!names.length) continue;
    issueCert(name, names);
    done.push(name);
  }
  return done;
}

function importCa({ cert, key, passphrase }) {
  let caCert;
  try {
    caCert = forge.pki.certificateFromPem(String(cert || ''));
  } catch {
    throw new Error('cert is not a PEM certificate');
  }
  const bc = caCert.getExtension('basicConstraints');
  if (!bc || !bc.cA) throw new Error('certificate is not a CA (basicConstraints cA=false)');
  if (caCert.validity.notAfter <= new Date()) throw new Error('CA certificate has expired');
  const caKey = forge.pki.decryptRsaPrivateKey(String(key || ''), String(passphrase || ''));
  if (!caKey) throw new Error('cannot decrypt key — wrong passphrase or not an encrypted PEM key');
  const pubFromKey = forge.pki.publicKeyToPem(forge.pki.setRsaPublicKey(caKey.n, caKey.e));
  if (pubFromKey !== forge.pki.publicKeyToPem(caCert.publicKey)) throw new Error('key does not match certificate');

  const fingerprint = caFingerprint(caCert);
  const current = caInfo();
  if (current.hasCa && current.fingerprint === fingerprint) {
    return { changed: false, fingerprint, reissued: [] };
  }

  fs.mkdirSync(DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(config.paths.certs, `backup-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const f of [CA_CERT, CA_KEY, SRV_CERT, SRV_KEY]) {
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(backupDir, path.basename(f)));
  }
  fs.writeFileSync(CA_CERT, forge.pki.certificateToPem(caCert));
  fs.writeFileSync(CA_KEY, forge.pki.privateKeyToPem(caKey), { mode: 0o600 });

  // Everything signed by the old CA is now untrusted by anyone holding the new
  // one — re-mint the panel/FTPS cert and every site cert right away.
  regenerate();
  const reissued = reissueLeafCerts();
  emitLog('system', `[tls] imported CA ${fingerprint} — re-issued panel cert + ${reissued.length} site cert(s); old files in ${backupDir}`);
  return { changed: true, fingerprint, reissued, backupDir };
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

module.exports = {
  attach,
  start,
  stop,
  regenerate,
  status,
  caCertPath,
  caInfo,
  exportCa,
  importCa,
  ensureServerCert,
  issueCert,
  localIps,
  HTTPS_PORT,
};
