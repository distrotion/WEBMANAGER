'use strict';
// The manager must survive a broken subsystem at boot.
//
// This panel is what an operator uses to deploy and restart everything else. If
// a monitoring or queue subsystem throws while starting, the process must not
// die — that would leave a crash-looping service with no panel and no way to
// deploy the fix. Every start() call in server.js is guarded; this proves it by
// breaking two of them deliberately and checking the panel still answers.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { section, ok, eq, until, done } = require('./_harness');

const PORT = 8199;

function get(p) {
  return new Promise((resolve) => {
    require('http')
      .get({ host: '127.0.0.1', port: PORT, path: p, timeout: 3000 }, (res) => {
        let s = '';
        res.on('data', (c) => (s += c));
        res.on('end', () => resolve({ code: res.statusCode, body: s }));
      })
      .on('error', () => resolve({ code: 0, body: '' }))
      .on('timeout', () => resolve({ code: 0, body: 'timeout' }));
  });
}

(async () => {
  section('subsystem พังตอน boot ต้องไม่ลาก panel ล้ม');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-boot-'));
  const bootstrap = path.join(root, 'bootstrap.js');
  const srcDir = path.join(__dirname, '..', 'src');
  // แทนที่ start() ของสอง subsystem ก่อน server.js จะ require (ใช้ require cache ร่วมกัน)
  fs.writeFileSync(
    bootstrap,
    `require(${JSON.stringify(path.join(srcDir, 'monitor'))}).start = () => { throw new Error('จำลอง: seed() พัง'); };\n` +
      `require(${JSON.stringify(path.join(srcDir, 'mq'))}).start = () => { throw new Error('จำลอง: เปิดพอร์ตคิวไม่ได้'); };\n` +
      `require(${JSON.stringify(path.join(srcDir, 'server.js'))});\n`
  );

  let out = '';
  const child = spawn(process.execPath, [bootstrap], {
    env: { ...process.env, WEBMANAGER_ROOT: root, PORT: String(PORT) },
  });
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));

  const health = await until(async () => {
    const r = await get('/api/health');
    return r.code === 200 ? r : null;
  }, { timeoutMs: 25000, everyMs: 300 });

  ok('panel ยังตอบ /api/health ทั้งที่ subsystem พัง 2 ตัว', !!health, health ? health.body : 'ไม่ตอบเลย');
  ok('โปรเซสยังไม่ตาย', child.exitCode === null);
  ok('บอกใน log ว่าตัวไหนพัง (ไม่กลืนเงียบ)', /monitor failed to start/.test(out) && /mq failed to start/.test(out),
    out.split('\n').filter((l) => /failed to start/.test(l)).join(' | ') || '(ไม่มีในlog)');
  ok('ยังบอกเหตุผลจริงมาด้วย', /seed\(\) พัง/.test(out));

  const login = await get('/api/auth/login'); // GET ผิด method แต่ route ต้องมีอยู่
  ok('route อื่นยังถูก mount ปกติ', login.code !== 0, `HTTP ${login.code}`);

  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(root, { recursive: true, force: true });
  done();
})();
