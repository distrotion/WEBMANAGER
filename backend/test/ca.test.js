'use strict';
// CA export/import round trip: the bundle that leaves host A must recreate the
// same CA on host B, and everything B already issued must chain to it after.
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const { spawnSync } = require('child_process');
const { section, ok, eq, throws, done } = require('./_harness');
const config = require('../src/config');
const tls = require('../src/tls');

const PASS = 'correct horse battery staple';

// openssl, not forge, judges the chain: forge's verifier is stricter about
// tag classes than any real client, and openssl is what curl/browsers agree with.
function verifyChain(leafFile, caPem) {
  const leafPem = fs.readFileSync(leafFile, 'utf8').split('-----END CERTIFICATE-----')[0] + '-----END CERTIFICATE-----';
  const tmp = path.join(config.paths.certs, `_verify_${process.pid}`);
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'ca.pem'), caPem);
  fs.writeFileSync(path.join(tmp, 'leaf.pem'), leafPem);
  const r = spawnSync('openssl', ['verify', '-x509_strict', '-CAfile', path.join(tmp, 'ca.pem'), path.join(tmp, 'leaf.pem')], { encoding: 'utf8' });
  fs.rmSync(tmp, { recursive: true, force: true });
  return r.status === 0 && /: OK/.test(r.stdout);
}

(async () => {
  section('export: CA leaves only wrapped in a passphrase');
  throws('passphrase สั้นกว่า 12 ตัวถูกปฏิเสธ', () => tls.exportCa('short'), /12 characters/);
  const a = tls.exportCa(PASS);
  ok('cert เป็น PEM certificate', a.cert.includes('BEGIN CERTIFICATE'));
  ok('key เป็น encrypted PEM ไม่ใช่ key เปล่า', /BEGIN ENCRYPTED PRIVATE KEY|Proc-Type: 4,ENCRYPTED/.test(a.key));
  ok('fingerprint เป็น sha256 hex คั่น :', /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(a.fingerprint));
  eq('caInfo รายงาน fingerprint เดียวกัน', tls.caInfo().fingerprint, a.fingerprint);

  section('import ของ CA เดิม = no-op');
  const same = tls.importCa({ cert: a.cert, key: a.key, passphrase: PASS });
  eq('changed=false', same.changed, false);

  section('host B: CA ของตัวเอง + site cert ที่ออกไว้แล้ว → import CA จาก A');
  const dir = path.join(config.paths.certs, 'panel');
  fs.rmSync(dir, { recursive: true, force: true }); // "another host" = fresh CA
  const siteCert = tls.issueCert('site-b', ['10.0.0.5', 'b.local']);
  const bBefore = tls.caInfo().fingerprint;
  ok('CA ของ B ต่างจาก A', bBefore !== a.fingerprint);
  ok('site cert ของ B chain กับ CA ของ B ก่อน import', verifyChain(siteCert.certPath, fs.readFileSync(tls.caCertPath(), 'utf8')));
  ok('site cert ของ B ไม่ chain กับ CA ของ A ก่อน import', !verifyChain(siteCert.certPath, a.cert));

  throws('passphrase ผิดถูกปฏิเสธ', () => tls.importCa({ cert: a.cert, key: a.key, passphrase: 'wrong-passphrase-here' }), /decrypt/);
  throws('cert ที่ไม่ใช่ CA ถูกปฏิเสธ', () => tls.importCa({ cert: fs.readFileSync(siteCert.certPath, 'utf8'), key: a.key, passphrase: PASS }), /not a CA/);
  throws('cert ขยะถูกปฏิเสธ', () => tls.importCa({ cert: 'garbage', key: a.key, passphrase: PASS }), /PEM/);
  const mismatch = tls.exportCa(PASS); // B's own key
  throws('key ไม่ตรง cert ถูกปฏิเสธ', () => tls.importCa({ cert: a.cert, key: mismatch.key, passphrase: PASS }), /does not match/);
  eq('หลังปฏิเสธทั้งหมด CA ของ B ยังเดิม', tls.caInfo().fingerprint, bBefore);

  const r = tls.importCa({ cert: a.cert, key: a.key, passphrase: PASS });
  eq('import สำเร็จ changed=true', r.changed, true);
  eq('fingerprint ตรงกับ A', tls.caInfo().fingerprint, a.fingerprint);
  ok('site cert ถูกออกใหม่', r.reissued.includes('site-b'));
  ok('site cert ใหม่ chain กับ CA ของ A', verifyChain(siteCert.certPath, a.cert));
  const leafPem = fs.readFileSync(siteCert.certPath, 'utf8').split('-----END CERTIFICATE-----')[0] + '-----END CERTIFICATE-----';
  const san = forge.pki.certificateFromPem(leafPem).getExtension('subjectAltName').altNames;
  ok('SAN เดิมคงอยู่ (IP + DNS)', san.some((n) => n.ip === '10.0.0.5') && san.some((n) => n.value === 'b.local'));
  ok('มี backup ของ CA เดิม', fs.existsSync(path.join(r.backupDir, 'wm-ca.crt')));
  const panel = tls.ensureServerCert();
  ok('panel cert ออกใหม่ chain กับ CA ของ A', verifyChain(panel.certPath, a.cert));
  ok('fullchain ของ site ลงท้ายด้วย CA ใบใหม่', fs.readFileSync(siteCert.certPath, 'utf8').includes(a.cert.trim()));

  done();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
