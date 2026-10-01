'use strict';
// FTP server: read-only accounts, UNC roots backed by Network-share credentials,
// per-client PASV address, root deny list. Runs a real ftp-srv on a free port
// and talks to it with basic-ftp — the same client the ISN backend uses.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable } = require('stream');
const { section, ok, eq, done } = require('./_harness');
const db = require('../src/db');
const settings = require('../src/settings');
const secretbox = require('../src/secretbox');
const guard = require('../src/guard');
const config = require('../src/config');
const ftp = require('../src/ftp');
const { Client } = require('basic-ftp');

const PORT = 21121;
const PASS = 'pw-' + Math.random().toString(36).slice(2);

function addUser(username, root_path, read_only) {
  db.prepare('INSERT INTO ftp_users (username, password_enc, root_path, enabled, read_only) VALUES (?,?,?,1,?)').run(
    username, secretbox.encrypt(PASS), root_path, read_only ? 1 : 0
  );
}

async function client(user) {
  const c = new Client(10_000);
  await c.access({ host: '127.0.0.1', port: PORT, user, password: PASS, secure: false });
  return c;
}

async function download(c, name) {
  const chunks = [];
  await c.downloadTo(new Writable({ write(ch, _e, cb) { chunks.push(ch); cb(); } }), name);
  return Buffer.concat(chunks).toString('utf8');
}

async function expectReject(label, p, re) {
  try {
    await p;
    ok(label, false, 'succeeded but should have been refused');
  } catch (e) {
    ok(label, re.test(e.message), e.message);
  }
}

(async () => {
  section('guard.ftpRoot: รูปแบบ + deny list');
  ok('C:\\ISN01 ผ่าน', guard.ftpRoot('C:\\ISN01', 'C:\\webmanager') === null);
  ok('UNC \\\\srv\\share ผ่าน', guard.ftpRoot('\\\\172.101.11.205\\Data', 'C:\\webmanager') === null);
  ok('UNC มีโฟลเดอร์ย่อยผ่าน', guard.ftpRoot('\\\\srv\\Data\\sub folder', 'C:\\webmanager') === null);
  ok('drive root ไม่ผ่าน', /drive root/.test(guard.ftpRoot('C:\\', 'C:\\webmanager')));
  ok('C:\\Windows ไม่ผ่าน', /Windows/.test(guard.ftpRoot('C:\\Windows\\Temp', 'C:\\webmanager')));
  ok('Program Files ไม่ผ่าน', /Program Files/.test(guard.ftpRoot('C:\\Program Files (x86)\\x', 'C:\\webmanager')));
  ok('C:\\data\\db (MongoDB) ไม่ผ่าน', /MongoDB/.test(guard.ftpRoot('C:\\data\\db', 'C:\\webmanager')));
  ok('D:\\mongo\\data\\db\\sub ไม่ผ่าน', /MongoDB/.test(guard.ftpRoot('D:\\mongo\\data\\db\\sub', 'C:\\webmanager')));
  ok('ใต้ webmanager root ไม่ผ่าน', /webmanager root/.test(guard.ftpRoot('C:\\webmanager\\data', 'C:\\webmanager')));
  ok('relative ไม่ผ่าน', guard.ftpRoot('ISN01', 'C:\\webmanager') !== null);
  ok('UNC ไม่มี share ไม่ผ่าน', guard.ftpRoot('\\\\server', 'C:\\webmanager') !== null);
  ok('newline ไม่ผ่าน (แม้อยู่ท้าย ซึ่ง trim ทั่วไปจะกลืน)', guard.ftpRoot('C:\\ISN01\n', 'C:\\webmanager') !== null);
  ok('newline กลางสตริงไม่ผ่าน', guard.ftpRoot('C:\\ISN\n01', 'C:\\webmanager') !== null);

  section('shareFor: เลือก Network share ที่ครอบ root (ยาวสุดชนะ, ไม่ติด prefix ชื่อคล้าย)');
  const enc = secretbox.encrypt('x');
  db.prepare("INSERT INTO net_shares (name, unc_path, username, password_enc, enabled) VALUES ('data','\\\\172.101.11.205\\Data','DESKTOP\\automation',?,1)").run(enc);
  db.prepare("INSERT INTO net_shares (name, unc_path, username, password_enc, enabled) VALUES ('data2','\\\\172.101.11.205\\Data2','DESKTOP\\automation',?,1)").run(enc);
  db.prepare("INSERT INTO net_shares (name, unc_path, username, password_enc, enabled) VALUES ('off','\\\\other\\Off','u',?,0)").run(enc);
  eq('\\\\...\\Data → share data', ftp.shareFor('\\\\172.101.11.205\\Data').name, 'data');
  eq('\\\\...\\Data\\sub → share data', ftp.shareFor('\\\\172.101.11.205\\Data\\sub').name, 'data');
  eq('\\\\...\\Data2 → share data2 (ไม่ใช่ data)', ftp.shareFor('\\\\172.101.11.205\\Data2').name, 'data2');
  eq('ตัวพิมพ์ต่าง → ยังเจอ', ftp.shareFor('\\\\172.101.11.205\\data\\X').name, 'data');
  ok('share ที่ปิดอยู่ไม่นับ', ftp.shareFor('\\\\other\\Off') === null);
  ok('local path → null', ftp.shareFor('C:\\ISN01') === null);

  section('pasvAddressFor: ตอบ IP ของ NIC ที่อยู่ subnet เดียวกับ client');
  const ifaces = {
    plant: [{ family: 'IPv4', address: '172.101.11.39', netmask: '255.255.255.0', internal: false }],
    qc: [{ family: 'IPv4', address: '172.23.10.217', netmask: '255.255.255.0', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
  };
  eq('client .40 (172.23.x) → 172.23.10.217', ftp.pasvAddressFor('172.23.10.40', '172.101.11.39', ifaces), '172.23.10.217');
  eq('client 172.101.11.205 → 172.101.11.39', ftp.pasvAddressFor('172.101.11.205', '172.23.10.217', ifaces), '172.101.11.39');
  eq('IPv4-mapped IPv6 ก็ได้', ftp.pasvAddressFor('::ffff:172.23.10.40', 'x', ifaces), '172.23.10.217');
  eq('client นอกทุก subnet → fallback (pasv host ที่ตั้งไว้)', ftp.pasvAddressFor('10.9.8.7', '203.0.113.5', ifaces), '203.0.113.5');
  eq('loopback → loopback', ftp.pasvAddressFor('127.0.0.1', 'x', ifaces), '127.0.0.1');

  section('server จริง: read-only account = list/MDTM/download ได้, เขียน/ลบไม่ได้');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-ftp-'));
  fs.writeFileSync(path.join(root, 'DATA.csv'), 'time,value\n2026-10-01 08:00,12.5\n');
  fs.writeFileSync(path.join(root, 'ACTPEAK.csv'), 'peak\n1\n');
  addUser('auto4', root, true);
  addUser('writer', root, false);
  settings.set('ftp_enabled', '1');
  settings.set('ftp_port', String(PORT));
  settings.set('ftp_pasv_min', '21500');
  settings.set('ftp_pasv_max', '21510');
  settings.set('ftp_pasv_host', '127.0.0.1');
  const st = await ftp.reconcile();
  ok('ftp server ขึ้นที่พอร์ตทดสอบ', st.running && st.port === PORT, JSON.stringify(st));
  ok('status บอก pasvAddresses', Array.isArray(st.pasvAddresses));

  const ro = await client('auto4');
  const names = (await ro.list()).map((f) => f.name).sort();
  eq('LIST เห็น DATA.csv + ACTPEAK.csv', names.join(','), 'ACTPEAK.csv,DATA.csv');
  const mtime = await ro.lastMod('DATA.csv');
  ok('MDTM คืนเวลาจริง (ภายใน 1 นาที)', Math.abs(Date.now() - mtime.getTime()) < 60_000, String(mtime));
  // the instrument keeps the file open and rewrites it: hold a write handle while downloading
  const writer = fs.openSync(path.join(root, 'DATA.csv'), 'a');
  const body = await download(ro, 'DATA.csv');
  fs.closeSync(writer);
  eq('RETR ได้ 2 บรรทัด (header + ค่า) ขณะไฟล์ถูกเปิดเขียนอยู่', body.trim().split('\n').length, 2);
  const { Readable } = require('stream');
  await expectReject('STOR ด้วย read-only ถูกปฏิเสธ', ro.uploadFrom(Readable.from(['x']), 'new.txt'), /502|blacklist|read-only/i);
  await expectReject('DELE ด้วย read-only ถูกปฏิเสธ', ro.remove('ACTPEAK.csv'), /502|blacklist|read-only/i);
  await expectReject('MKD ด้วย read-only ถูกปฏิเสธ', ro.send('MKD sub'), /502|blacklist|read-only/i);
  await expectReject('APPE ด้วย read-only ถูกปฏิเสธ', ro.send('APPE DATA.csv'), /502|blacklist|read-only/i);
  await expectReject('RNFR/RNTO ด้วย read-only ถูกปฏิเสธ', ro.rename('ACTPEAK.csv', 'z.csv'), /502|blacklist|read-only/i);
  ok('ไฟล์ยังอยู่ครบหลังพยายามเขียน/ลบ', fs.existsSync(path.join(root, 'ACTPEAK.csv')) && !fs.existsSync(path.join(root, 'new.txt')));
  ro.close();

  section('server จริง: บัญชีปกติยังเขียนได้ (read_only=0 ไม่เปลี่ยนพฤติกรรมเดิม)');
  const rw = await client('writer');
  await rw.uploadFrom(Readable.from(['hello']), 'up.txt');
  eq('STOR ผ่าน', fs.readFileSync(path.join(root, 'up.txt'), 'utf8'), 'hello');
  await rw.remove('up.txt');
  ok('DELE ผ่าน', !fs.existsSync(path.join(root, 'up.txt')));
  rw.close();

  section('UNC root: ไม่มี share ครอบ / share เปิดไม่ได้ → login ถูกปฏิเสธพร้อมเหตุผล (ไม่ใช่โฟลเดอร์ว่าง)');
  addUser('nounc', '\\\\nowhere\\Nothing', true);
  await expectReject('UNC ที่ไม่มี credential → 530 บอกว่าให้เพิ่ม Network share', client('nounc'), /Network share credential/i);
  addUser('unc', '\\\\172.101.11.205\\Data', true);
  await expectReject('UNC ที่เปิดไม่ได้ (เครื่องนี้ไม่ใช่ Windows/ไม่ถึง) → บอกว่า not reachable', client('unc'), /not reachable/i);

  settings.set('ftp_enabled', '0');
  await ftp.reconcile();
  fs.rmSync(root, { recursive: true, force: true });
  done();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
