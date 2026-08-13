'use strict';
// The stuck-deploy-lock trap.
//
// Every deploy runs inside a per-site lock released in a `.finally`, so the lock
// lives exactly as long as the job's promise. runner.js had no timeout, so a
// `git fetch` stalled on a dead route never settled, the lock was held for the
// life of the process, and every later "Pull & Deploy" was refused — with the
// panel showing nothing at all, because the UI discarded the response. The only
// cure was restarting the manager.
const { section, ok, eq, wait, done } = require('./_harness');
const deploylock = require('../src/deploylock');
const runner = require('../src/runner');

(async () => {
  section('ล็อกกันสองงานเขียนทับกัน');
  const a = deploylock.acquire(1, 'สมชาย');
  ok('คนแรกได้ล็อก', typeof a === 'function');
  ok('คนที่สองไม่ได้', deploylock.acquire(1, 'สมหญิง') === null);
  ok('อ่านได้ว่าใครถืออยู่', deploylock.held(1).who === 'สมชาย');
  ok('คนละ site ไม่ชนกัน', typeof deploylock.acquire(2, 'สมศรี') === 'function');
  a();
  ok('ปล่อยแล้วคนอื่นเอาไปได้', typeof deploylock.acquire(1, 'สมหญิง') === 'function');

  section('เฉพาะเจ้าของเท่านั้นที่ปล่อยได้');
  const stale = deploylock.acquire(3, 'งานเก่า');
  deploylock.forceRelease(3);
  const fresh = deploylock.acquire(3, 'งานใหม่');
  stale(); // callback มาช้าจากงานที่ถูกปลดไปแล้ว
  ok('callback ของงานเก่าต้องไม่ไปปล่อยล็อกของงานใหม่', deploylock.held(3) !== null,
    JSON.stringify(deploylock.held(3)));
  fresh();

  section('ปลดล็อกด้วยมือ');
  deploylock.acquire(4, 'งานที่ค้าง');
  const was = deploylock.forceRelease(4);
  ok('คืนข้อมูลว่าปลดของใคร', was && was.who === 'งานที่ค้าง');
  ok('ปลดแล้วว่างจริง', deploylock.held(4) === null);
  ok('ปลดตอนที่ไม่ได้ล็อก = คืน null ไม่ throw', deploylock.forceRelease(99) === null);

  section('allHeld() สำหรับหน้ารายการ');
  deploylock.acquire(7, 'ก');
  deploylock.acquire(8, 'ข');
  const all = deploylock.allHeld();
  ok('บอกครบทุก site ที่กำลัง deploy', all[7].who === 'ก' && all[8].who === 'ข', JSON.stringify(all));
  ok('มี since ไว้คำนวณว่านานแค่ไหน', typeof all[7].since === 'number');
  deploylock.forceRelease(7);
  deploylock.forceRelease(8);

  section('คำสั่งที่ค้างต้องถูกตัด ไม่ค้างตลอดกาล');
  // นี่คือเคสจริง: process ที่ไม่มีวันจบเอง
  const t0 = Date.now();
  const r = await runner.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    channel: 'silent',
    timeoutMs: 1500,
  });
  const took = Date.now() - t0;
  ok('คืนค่าออกมาจริง ไม่ค้าง', r !== undefined);
  ok('บอกว่าเป็นเพราะ timeout', r.timedOut === true, JSON.stringify(r));
  ok('ข้อความบอกเวลาแบบอ่านรู้เรื่อง ไม่ใช่ "0 นาที"', /วินาที/.test(r.error) && !/0 นาที/.test(r.error), r.error);
  ok('code ไม่ใช่ 0 = ตัวเรียกรู้ว่าล้มเหลว', r.code !== 0, `code=${r.code}`);
  ok('ตัดตรงเวลา ไม่รอนานเกิน', took >= 1400 && took < 6000, `${took}ms`);

  section('คำสั่งปกติต้องไม่โดน timeout ตัด');
  const okRun = await runner.run(process.execPath, ['-e', 'console.log("เสร็จแล้ว")'], {
    channel: 'silent',
    timeoutMs: 10000,
  });
  eq('จบเองด้วย code 0', okRun.code, 0);
  ok('ไม่ได้ถูกตัด', !okRun.timedOut);
  ok('เก็บ output ไว้ให้', /เสร็จแล้ว/.test(okRun.out), okRun.out.trim());

  section('งานที่ค้างต้องคืนล็อกให้ (เคสที่ทำให้ปุ่ม Pull ตาย)');
  // จำลองสิ่งที่ deploy.routes.js ทำ: ถือล็อก → รันงาน → .finally ปล่อย
  const release = deploylock.acquire(10, 'สมชาย');
  const job = runner
    .run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { channel: 'silent', timeoutMs: 1200 })
    .finally(release);
  ok('ระหว่างทำงาน ล็อกถูกถือไว้', deploylock.held(10) !== null);
  await job;
  ok('งานค้างจบเพราะ timeout แล้วล็อกถูกปล่อยเอง', deploylock.held(10) === null);
  ok('สั่ง deploy ใหม่ได้ทันที ไม่ต้อง restart panel', typeof deploylock.acquire(10, 'รอบใหม่') === 'function');

  await wait(50);
  done();
})();
