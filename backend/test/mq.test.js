'use strict';
// Message queue — durability, ordering and the guards around the inbound port.
const { section, ok, eq, throws, wait, until, fakeServer, post, done } = require('./_harness');
const mq = require('../src/mq');
const db = require('../src/db');

const depth = (name) => mq.listQueues().find((q) => q.name === name) || {};
// Force every delivery of ONE queue to look timed out, without touching others.
const expireLeases = (name) =>
  db
    .prepare(
      "UPDATE mq_messages SET lease_until=? WHERE state='delivered' AND queue_id=(SELECT id FROM mq_queues WHERE name=?)"
    )
    .run(Date.now() - 1000, name);

(async () => {
  section('publish / pull / ack — the basic contract');
  for (let i = 1; i <= 5; i++) mq.publish('basic', { n: i });
  eq('publish 5 ข้อความ แล้วรออยู่ 5', depth('basic').ready, 5);

  const a = mq.pull('basic', { max: 2 });
  const b = mq.pull('basic', { max: 2 });
  const claimed = [...a.messages, ...b.messages];
  eq('สอง pull ติดกันไม่แจกข้อความซ้ำ และเรียงตาม id', claimed.map((m) => m.id).join(','), '1,2,3,4');
  eq('ทุก delivery ได้ ack token ของตัวเอง', new Set(claimed.map((m) => m.ack)).size, 4);
  eq('body รอดข้ามฝั่งครบ', JSON.parse(claimed[0].body).n, 1);
  eq('attempts เริ่มที่ 1 เมื่อถูกส่งครั้งแรก', claimed.map((m) => m.attempts).join(','), '1,1,1,1');
  eq('ข้อความที่ถูกจองแล้วมองไม่เห็นจากคนอื่น', mq.pull('basic', { max: 10 }).messages.length, 1); // เหลือแค่ #5

  eq('ack ลบทิ้งจริง', mq.ack('basic', [{ id: 1, ack: claimed[0].ack }]).acked, 1);
  ok('แถวหายไปจากตาราง ไม่ได้แค่ทำเครื่องหมาย', !db.prepare('SELECT 1 FROM mq_messages WHERE id=1').get());
  const stale = mq.ack('basic', [{ id: 2, ack: 'ack-ผิด' }]);
  ok('ack ด้วย token ผิด = ล้มเหลวแบบเห็นได้', stale.acked === 0 && stale.failed.length === 1);
  ok('ข้อความยังอยู่หลัง ack ผิด', !!db.prepare('SELECT 1 FROM mq_messages WHERE id=2').get());
  eq('ack คิวที่ไม่มีจริง = ไม่ทำอะไร', mq.ack('ไม่มีคิวนี้', [{ id: 1, ack: 'x' }]).acked, 0);

  section('at-least-once — ผู้บริโภคดับแล้วของต้องไม่หาย');
  mq.publish('crash', 'งาน');
  const c1 = mq.pull('crash', { max: 1 }).messages[0];
  eq('จองแล้วคนอื่นดึงไม่ได้', mq.pull('crash', { max: 5 }).messages.length, 0);
  expireLeases('crash');
  eq('lease หมดอายุ = คืนเข้าคิว', mq.reap().requeued, 1);
  const c2 = mq.pull('crash', { max: 1 }).messages[0];
  ok('ส่งซ้ำเป็นข้อความเดิม แต่ token ใหม่', c2.id === c1.id && c2.ack !== c1.ack);
  eq('attempts นับรอบที่ส่งซ้ำด้วย', c2.attempts, 2);
  eq('token เก่าใช้ ack ไม่ได้แล้ว', mq.ack('crash', [{ id: c1.id, ack: c1.ack }]).acked, 0);

  section('poison message — ต้องหยุดที่ max_attempts ไม่วนไม่จบ');
  mq.ensureQueue('poison');
  mq.updateQueue('poison', { max_attempts: 3, visibility_timeout: 60 });
  mq.publish('poison', 'พังทุกครั้ง');
  const pq = mq.getQueue('poison');
  const states = [];
  for (let i = 0; i < 4; i++) {
    const m = mq.pull('poison', { max: 1 }).messages[0];
    if (!m) {
      states.push('ไม่มีให้ดึงแล้ว');
      break;
    }
    states.push(mq.nack(pq.id, pq.max_attempts, m.id, m.ack, 0, 'ผู้บริโภคพัง'));
  }
  eq('ลองใหม่จนครบ cap แล้วตาย', states.join(','), 'ready,ready,dead,ไม่มีให้ดึงแล้ว');
  ok('เข้ากอง dead', depth('poison').dead === 1 && depth('poison').ready === 0);
  ok(
    'เก็บสาเหตุล่าสุดไว้ให้ดู',
    /ผู้บริโภคพัง/.test(db.prepare("SELECT last_error e FROM mq_messages WHERE state='dead'").get().e)
  );
  eq('nack ด้วย token ที่ไม่ได้ถืออยู่ = ปฏิเสธ', mq.nack(pq.id, 3, 999, 'มั่ว', 0, 'x'), null);

  section('reaper ต้องฆ่าตัวที่เกิน cap ก่อนคืนเข้าคิว');
  // ถ้าคืนก่อน ตัวที่เกิน cap จะถูกดึงไปอีกรอบแล้วค่อยพบว่าเกิน = ส่งเกินไป 1 ครั้งเสมอ
  mq.ensureQueue('order');
  mq.updateQueue('order', { max_attempts: 1, visibility_timeout: 60 });
  mq.publish('order', 'x');
  mq.pull('order', { max: 1 });
  expireLeases('order');
  const reaped = mq.reap();
  ok('ไปกอง dead ตรงๆ ไม่แวะกลับเป็น ready', reaped.dead === 1 && depth('order').ready === 0,
    `dead=${reaped.dead} ready=${depth('order').ready}`);

  section('requeue กอง dead');
  eq('ส่งกลับเข้าคิวได้', mq.requeueDead('poison'), 1);
  eq('กอง dead ว่างแล้ว', depth('poison').dead, 0);
  eq(
    'attempts ถูกรีเซ็ต ไม่งั้นพลาดครั้งเดียวก็ตายอีก',
    db.prepare("SELECT attempts a FROM mq_messages WHERE queue_id=? AND state='ready'").get(pq.id).a,
    0
  );

  section('ทนการรีสตาร์ต');
  mq.publish('boot', 'ต้องรอด');
  mq.pull('boot', { max: 1 });
  eq(
    'ข้อความที่ถูกดึงแต่ยังไม่ ack อยู่บนดิสก์',
    db.prepare("SELECT state s FROM mq_messages WHERE queue_id=(SELECT id FROM mq_queues WHERE name='boot')").get().s,
    'delivered'
  );
  expireLeases('boot');
  mq.reap(); // สิ่งที่ start() ทำตอน boot
  eq('การกวาดตอน boot คืนของเข้าคิว', depth('boot').ready, 1);

  section('ตัวป้องกันขาเข้า');
  throws('body ใหญ่เกินถูกปฏิเสธพร้อมทางออก', () => mq.publish('basic', 'x'.repeat(600 * 1024)), /too large|File Share/);
  ok('ชื่อคิวที่มี .. ถูกปฏิเสธ', !!mq.queueNameError('../etc'));
  ok('ชื่อคิวที่ขึ้นต้นด้วยขีดถูกปฏิเสธ', !!mq.queueNameError('-evil'));
  ok('ชื่อคิวยาวเกิน 64 ถูกปฏิเสธ', !!mq.queueNameError('a'.repeat(65)));
  ok('ชื่อคิวปกติผ่าน', !mq.queueNameError('plc-line1.raw_2'));
  ok('ปลายทางที่ไม่ใช่ http ถูกปฏิเสธ', !!mq.forwardUrlError('file:///etc/passwd'));
  ok('ปลายทางที่มีขึ้นบรรทัดใหม่ถูกปฏิเสธ', !!mq.forwardUrlError('http://a\r\nX: 1'));
  ok('ปลายทางว่าง = โหมดให้ดึงเอง ไม่ใช่ error', !mq.forwardUrlError(''));
  ok('ปลายทาง http ปกติผ่าน', !mq.forwardUrlError('http://127.0.0.1:12000/x'));

  section('publish แบบหน่วงเวลา');
  mq.publish('later', 'x', { delaySec: 60 });
  eq('ยังไม่ถึงเวลา = ดึงไม่ได้', mq.pull('later', { max: 5 }).messages.length, 0);
  eq('แต่ยังนับเป็น ready', depth('later').ready, 1);

  section('purge / prune แยกสถานะกันจริง');
  mq.publish('mix', 'a');
  mq.publish('mix', 'b');
  mq.pull('mix', { max: 1 });
  eq('purge เฉพาะ ready ไม่แตะตัวที่กำลังทำ', mq.purge('mix', 'ready'), 1);
  eq('ตัวที่กำลังทำยังอยู่', depth('mix').delivered, 1);
  db.prepare(
    "UPDATE mq_messages SET state='dead', dead_at=? WHERE queue_id=(SELECT id FROM mq_queues WHERE name='mix')"
  ).run(Date.now() - 40 * 86400_000);
  const readyElsewhere = depth('basic').ready;
  eq('prune ลบเฉพาะกอง dead ที่เก่าพอ', mq.pruneDead(14), 1);
  eq('คิวอื่นไม่โดนลูกหลง', depth('basic').ready, readyElsewhere);

  // ---- push mode ----------------------------------------------------------
  section('push mode — คิวยิงต่อให้เอง');
  let refuse = true;
  // เก็บเฉพาะที่ "รับจริง" แยกจาก dest.received ซึ่งบันทึกทุกครั้งที่ถูกยิงรวมทั้งครั้งที่ปฏิเสธ
  const accepted = [];
  const dest = await fakeServer((req, body) => {
    if (refuse) return { status: 503, body: '' };
    accepted.push({ body, headers: req.headers });
    return { status: 200, body: 'ok' };
  });
  mq.ensureQueue('push');
  mq.updateQueue('push', { forward_url: `${dest.url}/sink`, max_attempts: 50 });
  mq.start(); // ตัวจับเวลาจริง เหมือนที่ server.js เรียก

  for (let i = 1; i <= 6; i++) mq.publish('push', { n: i });
  await wait(2500);
  ok('ปลายทางถูกลองยิงจริง แต่ไม่มีอะไรสำเร็จ', dest.received.length > 0 && accepted.length === 0,
    `ลองไป ${dest.received.length} ครั้ง สำเร็จ ${accepted.length}`);
  eq('ของกองรออยู่ครบ ไม่หาย', depth('push').ready, 6);

  refuse = false;
  const drained = await until(() => (depth('push').ready === 0 && depth('push').delivered === 0 ? true : null));
  ok('ปลายทางฟื้นแล้วคิวไล่ส่งเองจนหมด', !!drained, `เหลือ ready=${depth('push').ready}`);
  const seqs = accepted.map((r) => JSON.parse(r.body).n);
  eq('ลำดับไม่สลับ แม้ผ่านการล่มมาแล้ว', seqs.join(','), '1,2,3,4,5,6');
  eq('ส่งสำเร็จตัวละครั้งเดียว ไม่ซ้ำ', new Set(seqs).size, 6);
  const ct = accepted[accepted.length - 1].headers['content-type'];
  ok('ส่งเป็น application/json เมื่อ body เป็น JSON', /application\/json/.test(ct), ct);

  section('push mode — header เพิ่มเติม');
  mq.updateQueue('push', { forward_headers: '{"x-api-key":"secret-123"}' });
  mq.publish('push', { n: 7 });
  await until(() => (accepted.some((r) => r.headers['x-api-key']) ? true : null));
  eq('header ที่ตั้งไว้ถูกส่งไปด้วย', accepted[accepted.length - 1].headers['x-api-key'], 'secret-123');
  throws(
    'header ที่ไม่ใช่ JSON object ถูกปฏิเสธ',
    () => mq.updateQueue('push', { forward_headers: 'ไม่ใช่ json' }),
    /JSON object/
  );
  // Node โยน TypeError ทันทีถ้าค่า header ไม่ใช่ ASCII — ถ้าไม่กันตั้งแต่ตอนบันทึก
  // คิวจะดูเหมือนตั้งค่าสำเร็จ แล้วค้างทุกครั้งที่ส่งโดยไม่มีอะไรบอกสาเหตุ
  throws(
    'ค่า header ภาษาไทยถูกปฏิเสธตั้งแต่ตอนบันทึก',
    () => mq.updateQueue('push', { forward_headers: '{"x-api-key":"ค่าลับ"}' }),
    /ASCII/
  );
  throws(
    'ชื่อ header ที่ไม่ใช่ token ถูกปฏิเสธ',
    () => mq.updateQueue('push', { forward_headers: '{"x api key":"v"}' }),
    /ชื่อ header/
  );
  throws(
    'ค่า header ที่มีขึ้นบรรทัดใหม่ถูกปฏิเสธ (กัน header injection)',
    // \r\n ต้องเป็น escape ภายใน JSON (ถ้าใส่เป็นตัวอักษรจริง JSON.parse จะพังก่อน
    // ซึ่งก็กันได้เหมือนกัน แต่คนละด่าน — อันนี้เจตนาทดสอบด่าน ASCII)
    () => mq.updateQueue('push', { forward_headers: String.raw`{"x-a":"v\r\nX-Evil: 1"}` }),
    /ASCII/
  );
  eq('ของเดิมไม่ถูกเขียนทับเมื่อค่าใหม่ไม่ผ่าน', JSON.parse(mq.getQueue('push').forward_headers)['x-api-key'], 'secret-123');

  section('push mode — ปลายทางไม่รับถาวร');

  refuse = true;
  mq.updateQueue('push', { max_attempts: 2 });
  mq.publish('push', { n: 8 });
  const died = await until(() => (depth('push').dead > 0 ? true : null), { timeoutMs: 20000 });
  ok('ปลายทางปฏิเสธถาวร = ตกกอง dead ไม่วนไม่จบ', !!died, JSON.stringify(depth('push')));
  ok(
    'สาเหตุระบุ HTTP ที่ปลายทางตอบ',
    /HTTP 503/.test(db.prepare("SELECT last_error e FROM mq_messages WHERE state='dead' ORDER BY id DESC").get()?.e || '')
  );

  // ---- dedicated inbound port --------------------------------------------
  section('พอร์ตของคิวเอง');
  refuse = false;
  mq.updateQueue('push', { listen_port: null }); // null = ไม่ใช้พอร์ตของตัวเอง
  mq.ensureQueue('inbound');
  mq.updateQueue('inbound', { listen_port: 12345, listen_auth: 0, forward_url: `${dest.url}/inbound` });
  await wait(300);
  eq('พอร์ตเปิดจริง', depth('inbound').listening, true);

  const base = 'http://127.0.0.1:12345';
  eq('POST ปกติได้ 201', (await post(`${base}/`, JSON.stringify({ hello: 1 }))).code, 201);
  const big = await post(`${base}/`, 'x'.repeat(600 * 1024), { 'Content-Type': 'text/plain' });
  eq('body เกินขนาดได้ 413 ไม่ใช่สายหลุด', big.code, 413);
  ok('413 บอกเหตุผลกลับไปด้วย', /512 KB/.test(big.body), big.body.slice(0, 60));
  eq('ขนาดพอดีขอบ 500KB ยังผ่าน', (await post(`${base}/`, 'y'.repeat(500 * 1024), { 'Content-Type': 'text/plain' })).code, 201);
  eq('body ว่าง = 400', (await post(`${base}/`, '')).code, 400);
  ok('backend ยังทำงานต่อหลังเจอ body ใหญ่', (await post(`${base}/`, JSON.stringify({ hello: 2 }))).code === 201);

  section('พอร์ตของคิวต้องไม่กลายเป็นช่องอ่านข้อมูล');
  const get = (path) =>
    new Promise((resolve) => {
      require('http')
        .get(`${base}${path}`, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
        .on('error', () => resolve(0));
    });
  eq('GET / = health เท่านั้น', await get('/'), 200);
  eq('GET /queues ไม่ให้', await get('/queues'), 405);
  const putCode = await new Promise((resolve) => {
    const r = require('http').request({ method: 'PUT', host: '127.0.0.1', port: 12345, path: '/' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on('error', () => resolve(0));
    r.end();
  });
  eq('PUT ไม่ให้', putCode, 405);

  section('พอร์ตของคิวเมื่อบังคับใช้ token');
  mq.updateQueue('inbound', { listen_auth: 1 });
  await wait(300);
  const noTok = await post(`${base}/`, JSON.stringify({ x: 1 }));
  eq('ไม่มี token = 401', noTok.code, 401);
  // ยังไม่ได้ออก token เลย -> ต้อง fail closed ไม่ใช่ปล่อยผ่าน
  ok('ยังไม่มี token ในระบบก็ต้องปฏิเสธ (fail closed)', noTok.code === 401);
  require('../src/settings').set('mq_api_token', 'mqt_testtoken123');
  eq('ส่ง token ถูกต้อง = ผ่าน', (await post(`${base}/`, JSON.stringify({ x: 2 }), { 'x-api-token': 'mqt_testtoken123' })).code, 201);
  eq('token ผิด = 401', (await post(`${base}/`, JSON.stringify({ x: 3 }), { 'x-api-token': 'mqt_wrong' })).code, 401);

  section('พอร์ตชนกัน');
  const cfg = require('../src/config');
  ok('พอร์ตของ panel เองถูกกัน', !!mq.portTaken(cfg.PORT));
  mq.ensureQueue('other');
  throws('พอร์ตซ้ำกับคิวอื่นถูกปฏิเสธ', () => mq.updateQueue('other', { listen_port: 12345 }), /ถูกใช้/);
  throws('พอร์ตนอกช่วงถูกปฏิเสธ', () => mq.updateQueue('other', { listen_port: 70000 }), /1-65535/);

  section('ลบคิวแล้วต้องสะอาด');
  mq.deleteQueue('inbound');
  await wait(300);
  eq('พอร์ตถูกคืน', (await post(`${base}/`, '{}')).code, 0);
  ok('คิวหายจากรายการ', !mq.listQueues().find((q) => q.name === 'inbound'));
  eq(
    'ข้อความของคิวนั้นถูกลบตามไปด้วย',
    db.prepare('SELECT COUNT(*) c FROM mq_messages WHERE queue_id NOT IN (SELECT id FROM mq_queues)').get().c,
    0
  );

  await dest.close();
  done();
})();
