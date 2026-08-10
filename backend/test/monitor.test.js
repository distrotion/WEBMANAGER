'use strict';
// Monitor — the decision logic (query guard, pass/fail, drift, schedule) plus a
// live HTTP monitor driven through real up/down transitions.
//
// The decision functions matter more than they look: every one of them fails
// SILENTLY when wrong. A loose query guard lets a "read-only" check write; a
// wrong comparison leaves a monitor green on a broken target; a wrong schedule
// runs the nightly job in the middle of a shift.
const { section, ok, eq, wait, until, fakeServer, done } = require('./_harness');
const monitor = require('../src/monitor');
const settings = require('../src/settings');
const db = require('../src/db');
const { evaluateCondition, judgeQueryResult, judgeComparison, nextDue, humanDuration } = monitor._internal;

function makeMonitor(fields) {
  const cols = Object.keys(fields);
  const info = db
    .prepare(`INSERT INTO monitors (${cols.join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})`)
    .run(fields);
  return db.prepare('SELECT * FROM monitors WHERE id=?').get(info.lastInsertRowid);
}

(async () => {
  section('read-only query guard — กันไม่ให้ "ตรวจ" กลายเป็น "เขียน"');
  ok('ว่าง = ใช้ probe ปกติ ไม่ใช่ error', monitor.unsafeQuery('') === null);
  ok('SELECT ผ่าน', monitor.unsafeQuery('SELECT COUNT(*) FROM sys.databases') === null);
  ok('WITH ผ่าน', monitor.unsafeQuery('WITH x AS (SELECT 1 a) SELECT a FROM x') === null);
  ok('EXEC ผ่าน (sp ตรวจสถานะ)', monitor.unsafeQuery('EXEC sp_helpdb') === null);
  for (const bad of [
    'DELETE FROM users',
    'DROP TABLE monitors',
    'UPDATE sites SET name=1',
    'INSERT INTO t VALUES (1)',
    'TRUNCATE TABLE t',
    'ALTER TABLE t ADD c INT',
    'CREATE TABLE t (a INT)',
    'MERGE t USING s ON 1=1',
    'GRANT ALL TO x',
    'REVOKE ALL FROM x',
  ]) {
    ok(`ปฏิเสธ ${bad.split(' ')[0]}`, !!monitor.unsafeQuery(bad));
  }
  ok('ปฏิเสธหลาย statement ที่คั่นด้วย ;', !!monitor.unsafeQuery('SELECT 1; DROP TABLE t'));
  ok('ปฏิเสธ SELECT ที่ซ่อน DELETE ไว้ข้างใน', !!monitor.unsafeQuery('SELECT 1 FROM t WHERE 1=1 DELETE FROM t'));
  ok('ปฏิเสธ ; ที่ท้ายสุดด้วย (กันคนต่อท้าย)', !!monitor.unsafeQuery('SELECT 1;'));
  ok('ปฏิเสธคำสั่งที่ไม่ได้ขึ้นต้นด้วย SELECT/WITH/EXEC', !!monitor.unsafeQuery('sp_who'));

  section('เงื่อนไขผ่าน/ไม่ผ่าน');
  ok('eq เทียบตัวเลขแบบตัวเลข ไม่ใช่ string', evaluateCondition('0', 'eq', 0) === true);
  ok('eq "007" == 7 (เพราะเป็นตัวเลขทั้งคู่)', evaluateCondition('007', 'eq', '7') === true);
  ok('eq เทียบ string เมื่อไม่ใช่ตัวเลข', evaluateCondition('SYNCHRONIZED', 'eq', 'SYNCHRONIZED') === true);
  ok('ne ทำงาน', evaluateCondition(1, 'ne', 0) === true);
  ok('lt ทำงาน', evaluateCondition(5, 'lt', 300) === true);
  ok('lte ขอบพอดี', evaluateCondition(300, 'lte', 300) === true);
  ok('gt ทำงาน', evaluateCondition(10, 'gt', 5) === true);
  ok('gte ขอบพอดี', evaluateCondition(5, 'gte', 5) === true);
  ok('contains ไม่สนตัวพิมพ์', evaluateCondition('Fully SYNCHRONIZED', 'contains', 'synchronized') === true);
  // ค่าที่เทียบเป็นตัวเลขไม่ได้ ต้อง "ไม่ผ่าน" ไม่ใช่ผ่านเพราะ NaN
  ok('lt กับค่าที่ไม่ใช่ตัวเลข = ไม่ผ่าน (ไม่ใช่ NaN แล้วปล่อยผ่าน)', evaluateCondition('n/a', 'lt', 300) === false);
  ok('gt กับ null = ไม่ผ่าน', evaluateCondition(null, 'gt', 0) === false);
  ok('op ที่ไม่รู้จัก = ไม่ผ่าน (fail closed)', evaluateCondition(0, 'ประหลาด', 0) === false);

  section('ตัดสินผลจาก query');
  eq('ไม่มี query = แค่เช็คว่า login ได้', judgeQueryResult({}, null, 12), { ok: true, ms: 12 });
  eq(
    'ตรงเงื่อนไข = ผ่าน',
    judgeQueryResult({ check_query: 'SELECT 1', expect_op: 'eq', expect_value: '0' }, 0, 5),
    { ok: true, ms: 5 }
  );
  const failed = judgeQueryResult({ check_query: 'SELECT 1', expect_op: 'eq', expect_value: '0' }, 3, 5);
  ok('ไม่ตรง = ไม่ผ่าน และบอกค่าที่ได้จริง', failed.ok === false && /got 3/.test(failed.error), failed.error);

  section('ตรวจข้อมูลเท่ากันสองเครื่อง (drift)');
  const drift = { host: 'A', compare_host: 'B', expect_op: 'eq', expect_value: '0' };
  ok('ตัวเลขเท่ากัน = ผ่าน', judgeComparison(drift, 1000, 1000, 5).ok === true);
  ok('ตัวเลขต่างกัน = ไม่ผ่าน', judgeComparison(drift, 1000, 999, 5).ok === false);
  ok('บอกค่าทั้งสองฝั่งในข้อความ', /A=1000.*B=999/.test(judgeComparison(drift, 1000, 999, 5).error));
  ok(
    'ยอมให้ตามหลังได้ N แถว (lte 5)',
    judgeComparison({ ...drift, expect_op: 'lte', expect_value: '5' }, 1000, 996, 5).ok === true
  );
  ok(
    'ตามหลังเกินที่ยอม = ไม่ผ่าน',
    judgeComparison({ ...drift, expect_op: 'lte', expect_value: '5' }, 1000, 990, 5).ok === false
  );
  ok('checksum เป็น string เท่ากัน = ต่างกัน 0', judgeComparison(drift, 'ABC123', 'ABC123', 5).ok === true);
  ok('checksum ต่างกัน = ต่างกัน 1 จึงไม่ผ่าน eq 0', judgeComparison(drift, 'ABC123', 'ZZZ999', 5).ok === false);
  ok('ฝั่งหนึ่ง null = ถือว่าต่างกัน', judgeComparison(drift, 1000, null, 5).ok === false);

  section('ตารางเวลา');
  const base = new Date(2026, 0, 15, 10, 0, 0, 0).getTime(); // 15 ม.ค. 2026 10:00 เวลาเครื่อง
  eq('ไม่ตั้งรายวัน = บวก interval จากเวลาที่เพิ่งเสร็จ', nextDue({ interval_sec: 60 }, base), base + 60000);
  eq('interval ต่ำกว่า 10s ถูกดันขึ้นเป็น 10s', nextDue({ interval_sec: 1 }, base), base + 10000);
  const midnight = nextDue({ daily_at: '00:00', interval_sec: 60 }, base);
  const md = new Date(midnight);
  ok('daily 00:00 ตอนสายๆ = เที่ยงคืนของวันถัดไป',
    md.getHours() === 0 && md.getMinutes() === 0 && md.getDate() === 16, md.toString());
  const later = new Date(nextDue({ daily_at: '23:30' }, base));
  ok('daily 23:30 ตอนสายๆ = คืนนี้ ไม่ใช่พรุ่งนี้',
    later.getDate() === 15 && later.getHours() === 23 && later.getMinutes() === 30, later.toString());
  // เวลาผ่านไปพอดีเป๊ะต้องเลื่อนไปวันถัดไป ไม่ใช่รันซ้ำทันที
  const exact = new Date(2026, 0, 15, 0, 0, 0, 0).getTime();
  eq('อยู่ตรงเวลาพอดี = เลื่อนไปพรุ่งนี้ ไม่วนรันซ้ำ', new Date(nextDue({ daily_at: '00:00' }, exact)).getDate(), 16);
  ok('รูปแบบเวลาผิด = ตกกลับไปใช้ interval', nextDue({ daily_at: 'เที่ยงคืน', interval_sec: 60 }, base) === base + 60000);

  eq('ระยะเวลาแบบอ่านง่าย: นาที', humanDuration(5 * 60000), '5m');
  eq('ระยะเวลาแบบอ่านง่าย: ชั่วโมง', humanDuration(90 * 60000), '1h30m');
  eq('ระยะเวลาแบบอ่านง่าย: วัน', humanDuration(26 * 3600000), '1d2h');

  // ---- live transitions ---------------------------------------------------
  section('สถานะจริง: ขึ้น → ล่ม → ฟื้น และการแจ้งเตือน');
  const alerts = await fakeServer();
  settings.set('notify_webhook_url', `${alerts.url}/hook`);

  let healthy = true;
  const site = await fakeServer(() => (healthy ? { status: 200, body: 'ok' } : { status: 500, body: 'boom' }));

  const m = makeMonitor({
    name: 'เว็บทดสอบ',
    type: 'http',
    url: `${site.url}/`,
    interval_sec: 10,
    timeout_ms: 3000,
    fail_threshold: 2, // ต้องพลาด 2 ครั้งติดถึงนับว่าล่ม
    enabled: 1,
  });

  await monitor.runCheck(m);
  eq('เช็คแรกผ่าน = ขึ้นเขียว', monitor.status(m.id).up, true);
  eq('เช็คแรกที่เขียวต้องไม่ยิงแจ้งเตือน (ไม่มีอะไร "ฟื้น")', alerts.received.length, 0);

  healthy = false;
  await monitor.runCheck(m);
  eq('พลาดครั้งแรกยังไม่เปลี่ยนเป็นแดง (debounce)', monitor.status(m.id).up, true);
  eq('ยังไม่แจ้งเตือน', alerts.received.length, 0);

  await monitor.runCheck(m);
  eq('พลาดครบ fail_threshold = แดง', monitor.status(m.id).up, false);
  const down = await until(() => (alerts.received.length >= 1 ? alerts.received[0] : null));
  ok('ยิงแจ้งเตือน DOWN หนึ่งครั้ง', !!down && /monitor DOWN/.test(down.body), down && down.body.slice(0, 90));
  ok('ข้อความบอกชื่อ monitor', /เว็บทดสอบ/.test(down.body));

  await monitor.runCheck(m);
  eq('ยังแดงอยู่ = ไม่ยิงซ้ำทุกรอบ', alerts.received.length, 1);

  healthy = true;
  await monitor.runCheck(m);
  eq('สำเร็จครั้งเดียวก็กลับเขียวทันที', monitor.status(m.id).up, true);
  const up = await until(() => (alerts.received.length >= 2 ? alerts.received[1] : null));
  ok('ยิงแจ้งเตือน UP หนึ่งครั้ง', !!up && /monitor UP/.test(up.body), up && up.body.slice(0, 90));

  await monitor.runCheck(m);
  eq('เขียวต่อเนื่อง = ไม่ยิงซ้ำ', alerts.received.length, 2);

  section('monitor ใหม่ที่ชี้ไปของที่พังอยู่แล้ว ต้องเตือนตั้งแต่ครั้งแรก');
  healthy = false;
  const m2 = makeMonitor({
    name: 'พังตั้งแต่แรก',
    type: 'http',
    url: `${site.url}/`,
    interval_sec: 10,
    timeout_ms: 3000,
    fail_threshold: 1,
    enabled: 1,
  });
  const before = alerts.received.length;
  await monitor.runCheck(m2);
  eq('ขึ้นแดงทันที', monitor.status(m2.id).up, false);
  const firstDown = await until(() => (alerts.received.length > before ? alerts.received[before] : null));
  ok('แจ้งเตือนแม้เป็นผลตรวจครั้งแรก', !!firstDown && /พังตั้งแต่แรก/.test(firstDown.body));

  section('ประวัติ / uptime / การลบ');
  ok('บันทึกทุกครั้งที่ตรวจ', monitor.heartbeats(m.id).length >= 6, `${monitor.heartbeats(m.id).length} รายการ`);
  const u = monitor.uptime(m.id);
  ok('คิด uptime ออกมาเป็นตัวเลข 0-100', typeof u.d1 === 'number' && u.d1 >= 0 && u.d1 <= 100, JSON.stringify(u));
  ok('uptime ไม่ใช่ 100 เพราะมีที่พลาดไปแล้ว', u.d1 < 100, `${u.d1}%`);
  ok('ใช้ index ตอนอ่านประวัติ ไม่สแกนทั้งตาราง',
    /USING (COVERING )?INDEX idx_monitor_checks_mon_ts/.test(
      db.prepare('EXPLAIN QUERY PLAN SELECT ok,ms,error,ts FROM monitor_checks WHERE monitor_id=? ORDER BY ts DESC LIMIT 40')
        .all(m.id).map((r) => r.detail).join(' ')
    ));

  db.prepare('DELETE FROM monitors WHERE id=?').run(m2.id);
  monitor.forget(m2.id);
  eq('ลบแล้วสถานะถูกล้าง', monitor.status(m2.id).up, null);

  section('retention');
  const logprune = require('../src/logprune');
  db.prepare('INSERT INTO monitor_checks (monitor_id, ok, ms, error, ts) VALUES (?,1,1,NULL,?)')
    .run(m.id, Date.now() - 90 * 86400_000);
  const recent = db.prepare('SELECT COUNT(*) c FROM monitor_checks WHERE monitor_id=?').get(m.id).c;
  const removed = logprune.pruneMonitorChecks(35);
  eq('ลบเฉพาะที่เก่ากว่ากำหนด', removed, 1);
  eq('ของใหม่ยังอยู่ครบ', db.prepare('SELECT COUNT(*) c FROM monitor_checks WHERE monitor_id=?').get(m.id).c, recent - 1);
  eq('ค่า default คือ 35 วัน (ครอบคลุมหน้าต่าง 30 วัน)', logprune.monitorRetentionDays(), 35);

  await site.close();
  await alerts.close();
  done();
})();
