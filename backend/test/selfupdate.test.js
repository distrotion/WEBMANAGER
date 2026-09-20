'use strict';
// Self-update (AI full control 2.1).
//
// Part 1 — the in-process side (src/selfupdate.js) with a fake launcher:
//   validation, fetch + resolve, the lock, stale-state recovery.
// Part 2 — the out-of-process helper (scripts/selfupdate.ps1) run for real
//   under pwsh in -Simulate mode against a throwaway install: a good commit
//   must come up with the new version, a commit whose server crashes must be
//   ROLLED BACK to the previous one — automatically, within the health budget.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { section, ok, eq, until, wait, done } = require('./_harness');
const PORT = 18321;
process.env.PORT = String(PORT); // the helper probes config.PORT — must be the fake service's port
const config = require('../src/config');
const selfupdate = require('../src/selfupdate');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-selfupdate-'));
const origin = path.join(work, 'origin.git');
const author = path.join(work, 'author'); // where new commits are made
const checkout = path.join(work, 'checkout'); // what the server pulls from

const GOOD_SERVER = `'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const env = {};
for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\\r?\\n/)) {
  const m = l.match(/^(\\w+)=(.*)$/); if (m) env[m[1]] = m[2];
}
http.createServer((q, s) => { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify({ ok: true, version: env.WM_VERSION })); })
  .listen(Number(env.PORT), '127.0.0.1');
`;
const BAD_SERVER = `'use strict';\nthrow new Error('simulated broken release');\n`;

function g(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}
function commitServer(content, msg) {
  fs.writeFileSync(path.join(author, 'backend', 'src', 'server.js'), content);
  g(author, 'add', '-A');
  g(author, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg);
  g(author, 'push', '-q', 'origin', 'main');
  return g(author, 'rev-parse', 'HEAD');
}
function get(p) {
  return new Promise((resolve) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p, timeout: 2000 }, (res) => {
        let s = '';
        res.on('data', (c) => (s += c));
        res.on('end', () => resolve({ code: res.statusCode, body: s }));
      })
      .on('error', () => resolve({ code: 0, body: '' }))
      .on('timeout', function () { this.destroy(); resolve({ code: 0, body: 'timeout' }); });
  });
}
const healthVersion = async () => {
  const r = await get('/api/health');
  try { return JSON.parse(r.body).version; } catch { return null; }
};
const readState = () => JSON.parse(fs.readFileSync(selfupdate.paths.STATE_FILE, 'utf8'));
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;

(async () => {
  // ---- fixture: origin (bare) + author clone + server checkout -------------
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, author], { stdio: 'ignore' });
  fs.mkdirSync(path.join(author, 'backend', 'src'), { recursive: true });
  fs.writeFileSync(path.join(author, 'backend', 'package.json'), '{"name":"fake","private":true}\n');
  const hashA = commitServer(GOOD_SERVER, 'A: good');
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });

  section('validation');
  let err = await selfupdate.start({ launcher: async () => {} }).catch((e) => e.message);
  ok('ยังไม่ตั้ง repo dir → ปฏิเสธพร้อมบอกวิธีตั้ง', /repo dir not configured/.test(err), err);
  err = (() => { try { selfupdate.setRepoDir(work); return null; } catch (e) { return e.message; } })();
  ok('โฟลเดอร์ที่ไม่ใช่ git checkout ตั้งไม่ได้', /not a git checkout/.test(err), err);
  err = (() => { try { selfupdate.setRepoDir('relative/path'); return null; } catch (e) { return e.message; } })();
  ok('path ไม่ absolute ตั้งไม่ได้', /absolute/.test(err), err);
  eq('ตั้ง repo dir ที่ถูกต้องได้', selfupdate.setRepoDir(checkout), checkout);
  err = await selfupdate.start({ ref: '-oops', launcher: async () => {} }).catch((e) => e.message);
  ok('ref ขึ้นต้นด้วย - ปฏิเสธ (กัน git option injection)', /may not start with/.test(err), err);
  err = await selfupdate.start({ ref: 'no-such-branch', launcher: async () => {} }).catch((e) => e.message);
  ok('ref ที่ไม่มีบน origin → ปฏิเสธก่อนแตะ service', /not found after fetch/.test(err), err);

  section('fetch + resolve + launch (fake launcher)');
  const hashB = commitServer(GOOD_SERVER.replace('ok: true', 'ok: true, build: "B"'), 'B: good');
  let launched = null;
  const r = await selfupdate.start({ ref: 'main', user: { username: 'tester' }, launcher: async (args) => { launched = args; } });
  eq('resolve main → commit ล่าสุดบน origin (ต้อง fetch ก่อน)', r.target, hashB);
  ok('helper ถูกเรียกพร้อม -Target hash เต็ม', launched && launched[launched.indexOf('-Target') + 1] === hashB);
  ok('helper รู้ branch ที่ต้องเลื่อน', launched && launched[launched.indexOf('-Branch') + 1] === 'main');
  ok('helper ถูก stage ไว้นอก app/backend', launched && launched[launched.indexOf('-File') + 1].startsWith(selfupdate.paths.UPDATE_DIR));
  let st = readState();
  eq('state.json = queued + ใครสั่ง', [st.status, st.requestedBy, st.target], ['queued', 'tester', hashB]);
  ok('log เริ่มแล้ว', fs.existsSync(selfupdate.paths.LOG_FILE));

  section('lock');
  err = await selfupdate.start({ launcher: async () => {} }).catch((e) => e.message);
  ok('queued สดๆ = ยังไม่จบ → คำสั่งซ้ำถูกปฏิเสธ', /already in progress/.test(err), err);
  ok('status().inFlight = true', selfupdate.status().inFlight === true);
  // helper died (power loss): pid gone + file old → lock must open, status says interrupted
  fs.writeFileSync(selfupdate.paths.STATE_FILE, JSON.stringify({
    ...st, status: 'running', step: 'copy new code', helperPid: 999999, updatedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
  }));
  ok('helper ตายกลางคัน (pid หาย + เก่า >30 นาที) → ไม่ล็อกค้าง', selfupdate.status().inFlight === false);
  eq('รายงานเป็น interrupted พร้อม hint', selfupdate.status().state.status, 'interrupted');
  ok('hint บอกว่าต้องไปดู backup', /update\/releases|backupDir|update\.cmd/.test(selfupdate.status().state.hint));
  // helper alive (this very process) → still locked even with an old timestamp
  fs.writeFileSync(selfupdate.paths.STATE_FILE, JSON.stringify({ ...st, status: 'running', helperPid: process.pid,
    updatedAt: new Date(Date.now() - 31 * 60_000).toISOString() }));
  ok('pid ยังอยู่ = ยังล็อก แม้ไฟล์เก่า', selfupdate.status().inFlight === true);
  // launcher failure must not leave a phantom 'queued' lock
  fs.writeFileSync(selfupdate.paths.STATE_FILE, JSON.stringify({ ...st, status: 'success' }));
  err = await selfupdate.start({ launcher: async () => { throw new Error('schtasks exploded'); } }).catch((e) => e.message);
  ok('launcher พัง → error กลับไป', /schtasks exploded/.test(err), err);
  eq('และ state ถูกปิดเป็น failed ไม่ค้าง queued', readState().status, 'failed');
  ok('ปลดล็อกแล้ว', selfupdate.status().inFlight === false);

  if (!hasPwsh) {
    ok('helper e2e ข้าม: ไม่มี pwsh บนเครื่องนี้ (ติดตั้ง `brew install powershell` เพื่อรันส่วนนี้)', true);
    fs.rmSync(work, { recursive: true, force: true });
    return done();
  }

  // ---- Part 2: the helper for real, -Simulate ---------------------------------
  section('helper: อัปเดตสำเร็จ → version ใหม่ขึ้นเอง');
  const root = config.ROOT;
  const appBackend = path.join(root, 'app', 'backend');
  fs.mkdirSync(path.join(appBackend, 'src'), { recursive: true });
  g(checkout, 'checkout', '-q', hashA);
  fs.copyFileSync(path.join(checkout, 'backend', 'src', 'server.js'), path.join(appBackend, 'src', 'server.js'));
  fs.copyFileSync(path.join(checkout, 'backend', 'package.json'), path.join(appBackend, 'package.json'));
  fs.writeFileSync(path.join(appBackend, '.env'), `PORT=${PORT}\nSECRET=keep-me\nWM_VERSION=${hashA.slice(0, 7)} (2026-01-01)\n`);
  // the "service" that is currently running
  const svc = spawn(process.execPath, [path.join(appBackend, 'src', 'server.js')], { stdio: 'ignore' });
  fs.mkdirSync(selfupdate.paths.UPDATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(selfupdate.paths.UPDATE_DIR, 'sim.pid'), String(svc.pid));
  ok('เครื่องจำลองรัน version A อยู่', (await until(healthVersion, { timeoutMs: 5000 })) === `${hashA.slice(0, 7)} (2026-01-01)`);

  const helper = path.join(selfupdate.paths.UPDATE_DIR, 'selfupdate.ps1');
  fs.copyFileSync(selfupdate.paths.HELPER_SRC, helper);
  const runHelper = (target, branch) =>
    spawnSync('pwsh', selfupdate.helperArgs({ helper, dir: checkout, target, branch, healthTimeoutSec: 12, simulate: true }),
      { encoding: 'utf8', timeout: 120_000 });

  let out = runHelper(hashB, 'main');
  st = readState();
  eq('state = success', st.status, 'success', out.stdout + out.stderr);
  const today = new Date().toISOString().slice(0, 10);
  eq('health ตอบ version B', await until(healthVersion, { timeoutMs: 5000 }), `${hashB.slice(0, 7)} (${today})`);
  ok('.env เดิมรอด (SECRET ยังอยู่)', /SECRET=keep-me/.test(fs.readFileSync(path.join(appBackend, '.env'), 'utf8')));
  ok('.env ได้ WM_REPO_DIR', fs.readFileSync(path.join(appBackend, '.env'), 'utf8').includes(`WM_REPO_DIR=${checkout}`));
  ok('มี backup ของ A', fs.existsSync(path.join(st.backupDir, 'backend', 'src', 'server.js')));
  ok('backup ไม่มี .env (ไม่ก็อป secret ไปกอง)', !fs.existsSync(path.join(st.backupDir, 'backend', '.env')));
  eq('checkout เลื่อน main ไป B', g(checkout, 'rev-parse', 'HEAD'), hashB);

  section('helper: release พัง → rollback กลับ B เอง');
  const hashC = commitServer(BAD_SERVER, 'C: crashes at start');
  g(checkout, 'fetch', '-q', 'origin');
  const t0 = Date.now();
  out = runHelper(hashC, 'main');
  const secs = Math.round((Date.now() - t0) / 1000);
  st = readState();
  eq('state = rolled-back', st.status, 'rolled-back', out.stdout + out.stderr);
  ok('บอกสาเหตุ (health gate)', /health gate failed/.test(st.error), st.error);
  ok('rollback.ok = true', st.rollback && st.rollback.ok === true, JSON.stringify(st.rollback));
  eq('health กลับมาตอบ version B', await until(healthVersion, { timeoutMs: 5000 }), `${hashB.slice(0, 7)} (${today})`);
  ok('ไฟล์ server.js กลับเป็นของ B', !/simulated broken/.test(fs.readFileSync(path.join(appBackend, 'src', 'server.js'), 'utf8')));
  ok(`ทั้งรอบจบใน < 120 วิ (ใช้ ${secs} วิ)`, secs < 120);
  ok('log เล่าลำดับ (health gate → ROLLBACK)', /health gate/.test(selfupdate.tailLog()) && /ROLLBACK/.test(selfupdate.tailLog()));

  // stop the simulated service
  try { process.kill(Number(fs.readFileSync(path.join(selfupdate.paths.UPDATE_DIR, 'sim.pid'), 'utf8'))); } catch {}
  await wait(200);
  fs.rmSync(work, { recursive: true, force: true });
  done();
})();
