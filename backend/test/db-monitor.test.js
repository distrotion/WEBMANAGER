'use strict';
// Database monitors against REAL servers.
//
// The whole reason this monitor type exists is that a port check lies: a
// database holds its port open while rejecting every credential, and a TCP
// probe calls that green. Proving the opposite needs a server that actually
// enforces a login, so these cases cannot be faked — they are skipped unless a
// server is reachable, and the skip is printed rather than passed silently.
//
// Bring servers up (macOS, Homebrew — ports chosen to avoid the defaults):
//
//   initdb -D /tmp/pg1 -U wmadmin --auth=scram-sha-256 --pwfile=<(echo pgpass123)
//   pg_ctl -D /tmp/pg1 -o "-p 15432 -c listen_addresses=127.0.0.1" -l /tmp/pg1.log start
//   # a second one on 15433 for the drift case, then in each:
//   #   CREATE TABLE qc(id serial primary key, v int);
//   #   INSERT INTO qc(v) SELECT generate_series(1,1000);   -- 997 on the second
//
//   mongod --dbpath /tmp/mongo1 --port 27020 --bind_ip 127.0.0.1 --fork --logpath /tmp/mongo1.log
//   mongosh --port 27020 --eval 'db.getSiblingDB("admin").createUser({user:"wmadmin",pwd:"mongopass123",roles:["root"]})'
//   # restart the same command with --auth
//
// Override with WM_TEST_PG_PORT / WM_TEST_PG2_PORT / WM_TEST_MONGO_PORT.
const net = require('net');
const { section, ok, eq, done } = require('./_harness');
const monitor = require('../src/monitor');
const secretbox = require('../src/secretbox');

const PG = Number(process.env.WM_TEST_PG_PORT || 15432);
const PG2 = Number(process.env.WM_TEST_PG2_PORT || 15433);
const MONGO = Number(process.env.WM_TEST_MONGO_PORT || 27020);
const PG_USER = process.env.WM_TEST_PG_USER || 'wmadmin';
const PG_PASS = process.env.WM_TEST_PG_PASS || 'pgpass123';
const MONGO_USER = process.env.WM_TEST_MONGO_USER || 'wmadmin';
const MONGO_PASS = process.env.WM_TEST_MONGO_PASS || 'mongopass123';

const enc = (p) => secretbox.encrypt(p);

function reachable(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const finish = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs);
    s.on('connect', () => finish(true));
    s.on('timeout', () => finish(false));
    s.on('error', () => finish(false));
  });
}

const pgCfg = (extra) => ({
  type: 'postgres',
  host: '127.0.0.1',
  port: PG,
  username: PG_USER,
  password_enc: enc(PG_PASS),
  database_name: 'postgres',
  timeout_ms: 5000,
  ...extra,
});

const mongoCfg = (extra) => ({
  type: 'mongodb',
  host: '127.0.0.1',
  port: MONGO,
  timeout_ms: 5000,
  ...extra,
});

(async () => {
  section('driver ถูกติดตั้งครบ');
  for (const name of ['mssql', 'pg', 'mongodb']) {
    let installed = true;
    try {
      require(name);
    } catch {
      installed = false;
    }
    ok(`${name} ติดตั้งแล้ว`, installed);
  }

  const havePg = await reachable(PG);
  const havePg2 = await reachable(PG2);
  const haveMongo = await reachable(MONGO);

  // ---- PostgreSQL --------------------------------------------------------
  section(`PostgreSQL :${PG}`);
  if (!havePg) {
    console.log(`    – ข้าม: ไม่มี PostgreSQL ที่ 127.0.0.1:${PG} (ดูวิธีตั้งในหัวไฟล์)`);
  } else {
    const good = await monitor.probe(pgCfg());
    ok('รหัสถูก = เขียว', good.ok === true, good.error || `${good.ms}ms`);

    // The motivating case: the port is open either way, so only a real login
    // tells these two apart.
    const bad = await monitor.probe(pgCfg({ password_enc: enc('รหัสมั่ว') }));
    ok('รหัสผิด = แดง (ไม่ใช่เขียวหลอกแบบเช็คแค่พอร์ต)', bad.ok === false, bad.error);
    ok('บอกว่าเป็นเรื่อง authentication', /auth/i.test(bad.error || ''), bad.error);

    const noDb = await monitor.probe(pgCfg({ database_name: 'ฐานที่ไม่มีจริง' }));
    ok('database ไม่มีจริง = แดง', noDb.ok === false, noDb.error);

    const pass = await monitor.probe(pgCfg({ check_query: 'SELECT count(*) FROM qc', expect_op: 'eq', expect_value: '1000' }));
    ok('custom query เข้าเงื่อนไข = เขียว', pass.ok === true, pass.error);
    const fail = await monitor.probe(pgCfg({ check_query: 'SELECT count(*) FROM qc', expect_op: 'eq', expect_value: '5' }));
    ok('custom query ไม่เข้าเงื่อนไข = แดง', fail.ok === false, fail.error);
    ok('บอกค่าที่ได้จริงมาด้วย', /1000/.test(fail.error || ''), fail.error);

    // count(*) มาเป็น string ("1000") จาก bigint — ต้องเทียบแบบตัวเลข ไม่ใช่ string
    const numeric = await monitor.probe(pgCfg({ check_query: 'SELECT count(*) FROM qc', expect_op: 'gt', expect_value: '999' }));
    ok('bigint ที่ driver คืนเป็น string ยังเทียบแบบตัวเลขได้', numeric.ok === true, numeric.error);
  }

  section(`PostgreSQL drift :${PG} ↔ :${PG2}`);
  if (!havePg || !havePg2) {
    console.log(`    – ข้าม: ต้องมี PostgreSQL สองตัว (:${PG} 1000 แถว และ :${PG2} 997 แถว)`);
  } else {
    const q = { check_query: 'SELECT count(*) FROM qc', compare_host: '127.0.0.1', compare_port: PG2 };
    // เคสที่เคยพลาด: เดิม postgresCheck ไม่สนใจ compare_host เลย จึงเอาค่าของ
    // เครื่องแรกไปเทียบกับเงื่อนไขที่เขียนไว้สำหรับ "ผลต่าง" — ตัดสินผิดเงียบๆ
    const differs = await monitor.probe(pgCfg({ ...q, expect_op: 'eq', expect_value: '0' }));
    ok('ข้อมูลไม่เท่ากัน = แดง', differs.ok === false, differs.error);
    ok('ข้อความบอกค่าของทั้งสองเครื่อง', /1000/.test(differs.error || '') && /997/.test(differs.error || ''), differs.error);
    ok('ข้อความมีพอร์ตด้วย (สองอินสแตนซ์บนเครื่องเดียวกันแยกออก)', new RegExp(`:${PG2}`).test(differs.error || ''), differs.error);

    const tolerated = await monitor.probe(pgCfg({ ...q, expect_op: 'lte', expect_value: '5' }));
    ok('ยอมให้ตามหลังได้ 5 แถว = เขียว', tolerated.ok === true, tolerated.error);

    const same = await monitor.probe(pgCfg({ ...q, compare_port: PG, expect_op: 'eq', expect_value: '0' }));
    ok('เทียบกับตัวเอง = เท่ากันเป๊ะ = เขียว', same.ok === true, same.error);

    const unreachable = await monitor.probe(pgCfg({ ...q, compare_port: 15499, expect_op: 'eq', expect_value: '0' }));
    ok('เครื่องที่สองต่อไม่ได้ = แดง (ไม่ใช่ผ่านเพราะเทียบไม่ได้)', unreachable.ok === false, unreachable.error);
  }

  // ---- MongoDB -----------------------------------------------------------
  section(`MongoDB :${MONGO} (เปิด auth)`);
  if (!haveMongo) {
    console.log(`    – ข้าม: ไม่มี MongoDB ที่ 127.0.0.1:${MONGO} (ดูวิธีตั้งในหัวไฟล์)`);
  } else {
    const good = await monitor.probe(
      mongoCfg({ username: MONGO_USER, password_enc: enc(MONGO_PASS), database_name: 'admin' })
    );
    ok('รหัสถูก = เขียว', good.ok === true, good.error || `${good.ms}ms`);

    // ping เองไม่ต้องใช้สิทธิ์ แต่ driver ทำ authentication ตอน connect เมื่อมี
    // credential ให้ — รหัสผิดจึงต้องแดง ไม่ใช่เขียวเพราะ ping ผ่าน
    const bad = await monitor.probe(
      mongoCfg({ username: MONGO_USER, password_enc: enc('รหัสมั่ว'), database_name: 'admin' })
    );
    ok('รหัสผิด = แดง', bad.ok === false, bad.error);
    ok('บอกว่าเป็นเรื่อง authentication', /auth/i.test(bad.error || ''), bad.error);

    const wrongUser = await monitor.probe(
      mongoCfg({ username: 'ไม่มีผู้ใช้นี้', password_enc: enc(MONGO_PASS), database_name: 'admin' })
    );
    ok('ผู้ใช้ไม่มีจริง = แดง', wrongUser.ok === false, wrongUser.error);

    // ไม่ใส่ credential = ตรวจแค่ว่าเซิร์ฟเวอร์ยังตอบอยู่ ตามที่หน้าจอเขียนไว้
    // ("เว้นว่างได้ถ้า mongo ไม่ตั้ง auth") — บันทึกพฤติกรรมนี้ไว้ให้ชัด
    const anon = await monitor.probe(mongoCfg({}));
    ok('ไม่ใส่ credential = ตรวจแค่ว่าเซิร์ฟเวอร์ยังมีชีวิต', anon.ok === true, anon.error);
  }

  section('พอร์ตที่ไม่มีอะไรฟัง');
  const deadPg = await monitor.probe(pgCfg({ port: 15499, timeout_ms: 3000 }));
  ok('postgres ต่อไม่ได้ = แดง', deadPg.ok === false, deadPg.error);
  const deadMongo = await monitor.probe(mongoCfg({ port: 27099, timeout_ms: 3000 }));
  ok('mongodb ต่อไม่ได้ = แดง', deadMongo.ok === false, deadMongo.error);

  section('driver ที่ไม่มีต้องไม่ทำให้ล้ม');
  const unknown = await monitor.probe({ type: 'ประเภทที่ไม่รู้จัก', timeout_ms: 1000 });
  ok('type ที่ไม่รู้จัก = แดงพร้อมเหตุผล ไม่ throw', unknown.ok === false && /unknown monitor type/.test(unknown.error));

  done();
})();
