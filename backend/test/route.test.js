'use strict';
// Proxy-route system (#436): the DB row → rendered nginx conf pipeline, input
// validation, and the restore-on-failed-test guarantee. Runs against a real
// nginx binary (brew on Mac, the Windows build in production) so "nginx -t
// fails" is a genuine parse failure, not a simulated one.
const fs = require('fs');
const path = require('path');
const { section, ok, eq, done } = require('./_harness');
const db = require('../src/db');
const nginx = require('../src/nginx');
const tls = require('../src/tls');
const guard = require('../src/guard');
const config = require('../src/config');

nginx.bootstrapPrefix(); // same call server.js makes at boot — creates the throwaway nginx prefix

function makeSite(overrides) {
  const info = db
    .prepare(
      `INSERT INTO sites (name, runtime, direct_port, direct_port_enabled)
       VALUES (@name,'static',@direct_port,1)`
    )
    .run({ name: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`, direct_port: 19000, ...overrides });
  return db.prepare('SELECT * FROM sites WHERE id=?').get(info.lastInsertRowid);
}

function addRoute(site, fields) {
  const info = db
    .prepare(
      `INSERT INTO proxy_routes (site_id, path_prefix, target_url, strip_prefix, sse, enabled, rewrite_from)
       VALUES (@site_id,@path_prefix,@target_url,@strip_prefix,@sse,@enabled,@rewrite_from)`
    )
    .run({
      site_id: site.id,
      path_prefix: '/api',
      target_url: 'http://172.23.10.34:15000',
      strip_prefix: 1,
      sse: 0,
      enabled: 1,
      rewrite_from: null,
      ...fields,
    });
  return db.prepare('SELECT * FROM proxy_routes WHERE id=?').get(info.lastInsertRowid);
}

(async () => {
  section('guard: path_prefix / target_url validation');
  ok('prefix ต้องขึ้นต้นด้วย /', guard.routePrefix('api') !== null);
  ok('prefix ว่างไม่ผ่าน', guard.routePrefix('') !== null);
  ok('prefix ปกติผ่าน', guard.routePrefix('/api/gw') === null);
  ok('prefix มี ; ไม่ผ่าน (กัน nginx directive injection)', guard.routePrefix('/api;evil') !== null);
  ok('prefix มีช่องว่างไม่ผ่าน', guard.routePrefix('/api gw') !== null);
  ok('target ต้องเป็น http(s)://', guard.routeTarget('172.23.10.34:15000') !== null);
  ok('target ว่างไม่ผ่าน', guard.routeTarget('') !== null);
  ok('target ปกติผ่าน (host ภายนอก ไม่ใช่แค่ 127.0.0.1)', guard.routeTarget('http://172.23.10.34:15000') === null);
  ok('target มี newline ไม่ผ่าน', guard.routeTarget('http://x:1\nevil') !== null);

  section('writePortConf: render — ไม่มี route/https = เหมือนของเดิมทุกไบต์');
  const bare = makeSite();
  nginx.writePortConf(bare);
  const bareFile = path.join(config.paths.nginxPorts, `${bare.name}.conf`);
  const bareConf = fs.readFileSync(bareFile, 'utf8');
  ok('มี listen พอร์ตตรง', bareConf.includes(`listen ${bare.direct_port};`));
  ok('ไม่มี location เพิ่ม (ไม่มี route)', !/location \/api/.test(bareConf));
  ok('ไม่มี https block (https_enabled=0)', !bareConf.includes('ssl_certificate'));
  ok('ไม่มี ssl ในบรรทัด listen เดิม', !bareConf.includes(`listen ${bare.direct_port} ssl`));

  section('writePortConf: render — มี route');
  const withRoute = makeSite();
  addRoute(withRoute, { path_prefix: '/api', target_url: 'http://172.23.10.34:15000', strip_prefix: 1 });
  addRoute(withRoute, { path_prefix: '/auth', target_url: 'http://172.23.10.34:15001', strip_prefix: 0, sse: 1 });
  nginx.writePortConf(withRoute);
  const routeFile = path.join(config.paths.nginxPorts, `${withRoute.name}.conf`);
  const routeConf = fs.readFileSync(routeFile, 'utf8');
  ok('location /api/ อยู่ในไฟล์', routeConf.includes('location /api/'));
  ok('strip_prefix=1 -> proxy_pass ลงท้าย /', /proxy_pass http:\/\/172\.23\.10\.34:15000\/;/.test(routeConf));
  ok('location /auth/ อยู่ในไฟล์', routeConf.includes('location /auth/'));
  ok('strip_prefix=0 -> proxy_pass ไม่มี / ต่อท้าย', /proxy_pass http:\/\/172\.23\.10\.34:15001;/.test(routeConf));
  ok('sse=1 -> proxy_buffering off เฉพาะ location นั้น', routeConf.includes('proxy_buffering off'));
  const beforeAuth = routeConf.indexOf('location /auth/');
  const bufIdx = routeConf.indexOf('proxy_buffering off');
  ok('proxy_buffering off อยู่ใน location /auth/ ไม่ใช่ /api/', bufIdx > beforeAuth);
  ok('ใช้ $connection_upgrade ไม่ hardcode "upgrade"', routeConf.includes('Connection $connection_upgrade'));
  ok('ไม่มี Connection "upgrade" hardcode หลงเหลือ', !routeConf.includes('Connection "upgrade"'));
  ok('fallback location / (static root) ยังอยู่หลัง route ทั้งหมด', routeConf.includes('location / { try_files'));

  section('mainConf: map $connection_upgrade ประกาศไว้ในระดับ http block');
  const mainConfText = fs.readFileSync(path.join(config.nginx.prefix, 'conf', 'nginx.conf'), 'utf8');
  ok('มี map $http_upgrade $connection_upgrade', mainConfText.includes('map $http_upgrade $connection_upgrade'));

  section('proxy_routes: UNIQUE(site_id, path_prefix) กัน prefix ซ้ำในไซต์เดียวกัน');
  try {
    addRoute(withRoute, { path_prefix: '/api', target_url: 'http://x:1' });
    ok('prefix ซ้ำต้องถูกปฏิเสธที่ DB', false, 'insert ผ่านทั้งที่ซ้ำ');
  } catch (e) {
    ok('prefix ซ้ำต้องถูกปฏิเสธที่ DB', /UNIQUE/.test(e.message));
  }

  section('https_enabled=1: second listener + cert path ถูกต้อง');
  const httpsSite = makeSite({ direct_port: 19001 });
  const { certPath, keyPath } = tls.issueCert(httpsSite.name, ['172.23.10.34', '127.0.0.1']);
  ok('cert ออกลง certs/<site>/ ไม่ใช่ certs/panel/', certPath.includes(path.join('certs', httpsSite.name)));
  ok('ไม่แตะ certs/panel/panel.crt', !certPath.includes(path.join('certs', 'panel')));
  db.prepare('UPDATE sites SET https_port=19443, https_enabled=1 WHERE id=?').run(httpsSite.id);
  const withHttps = db.prepare('SELECT * FROM sites WHERE id=?').get(httpsSite.id);
  nginx.writePortConf(withHttps);
  const httpsConf = fs.readFileSync(path.join(config.paths.nginxPorts, `${withHttps.name}.conf`), 'utf8');
  ok('มี listen 19443 ssl', httpsConf.includes('listen 19443 ssl;'));
  ok('http listen เดิมยังอยู่ ไม่ถูกแทนที่', httpsConf.includes(`listen ${withHttps.direct_port};`));
  ok('ssl_certificate ชี้ certs/<site>/fullchain.pem', httpsConf.includes(`${httpsSite.name}/fullchain.pem`.replace(/\\/g, '/')));
  ok('cert ไฟล์มีอยู่จริงบนดิสก์', fs.existsSync(certPath) && fs.existsSync(keyPath));

  // SAN correctness — a cert with the wrong SAN fails the handshake even with
  // the CA trusted, so this is worth checking directly rather than trusting
  // that issueCert() was called with the right list.
  const forge = require('node-forge');
  const leafPem = fs.readFileSync(certPath, 'utf8').split('-----END CERTIFICATE-----')[0] + '-----END CERTIFICATE-----';
  const leaf = forge.pki.certificateFromPem(leafPem);
  const san = leaf.getExtension('subjectAltName');
  const ips = (san.altNames || []).filter((n) => n.type === 7).map((n) => n.ip);
  ok('SAN มี IP 172.23.10.34 (ผู้ใช้เข้าด้วย IP ไม่ใช่โดเมน)', ips.includes('172.23.10.34'));

  section('nginx -t: conf พังแล้วต้องคืนไฟล์เดิมทุกไบต์ (ไม่ใช่แค่ไม่ reload)');
  const before = fs.readFileSync(routeFile, 'utf8');
  const beforeCount = fs.readdirSync(config.paths.nginxPorts).filter((f) => f.endsWith('.conf')).length;
  const r = await nginx.applyConfig(() => {
    // simulate a broken render the way a real bug would produce one — an
    // unterminated block, which nginx -t rejects unconditionally
    fs.writeFileSync(routeFile, 'server {\n    listen 19000;\n    location / { proxy_pass', 'utf8');
    fs.writeFileSync(path.join(config.paths.nginxPorts, '__extra_garbage__.conf'), 'not even nginx syntax {{{', 'utf8');
  }, 'silent');
  ok('applyConfig รายงาน ok:false', r.ok === false);
  ok('มีข้อความ error จริงจาก nginx -t ไม่ใช่ค่าว่าง', typeof r.error === 'string' && r.error.length > 0);
  const after = fs.readFileSync(routeFile, 'utf8');
  eq('ไฟล์ที่แก้กลับมาเหมือนเดิมทุกไบต์', after, before);
  ok('ไฟล์ garbage ที่เพิ่มเข้ามาระหว่าง mutate ถูกลบออกไปด้วย', !fs.existsSync(path.join(config.paths.nginxPorts, '__extra_garbage__.conf')));
  const afterCount = fs.readdirSync(config.paths.nginxPorts).filter((f) => f.endsWith('.conf')).length;
  eq('จำนวนไฟล์ conf กลับมาเท่าก่อน mutate', afterCount, beforeCount);
  const tAfterRestore = await nginx.test('silent');
  eq('หลัง restore nginx -t ต้องผ่านอีกครั้ง', tAfterRestore.code, 0);

  section('rebuildFront: ลบเฉพาะ front/*.conf ไม่แตะ ports/*.conf');
  const beforeRebuild = fs.readFileSync(routeFile, 'utf8');
  nginx.rebuildFront();
  ok('conf ของ route (อยู่ใน ports/) ยังอยู่หลัง rebuildFront()', fs.existsSync(routeFile));
  eq('เนื้อไฟล์ไม่เปลี่ยนเลย', fs.readFileSync(routeFile, 'utf8'), beforeRebuild);

  section('site ที่ไม่เคยเปิด https: writePortConf ยัง render เหมือนเดิมทุกไบต์ (opt-in default off)');
  const untouched1 = fs.readFileSync(bareFile, 'utf8');
  nginx.writePortConf(db.prepare('SELECT * FROM sites WHERE id=?').get(bare.id));
  const untouched2 = fs.readFileSync(bareFile, 'utf8');
  eq('render ซ้ำได้ผลลัพธ์เดิมทุกไบต์', untouched2, untouched1);

  section('guard: rewrite_from (sub_filter source) validation');
  ok('ว่าง/null = ไม่ rewrite ผ่าน', guard.routeRewriteFrom('') === null && guard.routeRewriteFrom(null) === null && guard.routeRewriteFrom(undefined) === null);
  ok('origin + / ท้ายผ่าน', guard.routeRewriteFrom('http://172.23.10.34:18000/') === null);
  ok('ไม่มี / ท้ายไม่ผ่าน (replacement ต้องคง path ที่เหลือไว้)', guard.routeRewriteFrom('http://172.23.10.34:18000') !== null);
  ok('มี path ต่อท้ายไม่ผ่าน', guard.routeRewriteFrom('http://172.23.10.34:18000/api/') !== null);
  ok("มี ' ไม่ผ่าน (หลุดจาก quoted string ของ nginx)", guard.routeRewriteFrom("http://x:1/'") !== null);
  ok('มี $ ไม่ผ่าน (nginx variable)', guard.routeRewriteFrom('http://x$host/') !== null);
  ok('มี newline ไม่ผ่าน', guard.routeRewriteFrom('http://x:1/\nevil') !== null);
  ok('ไม่ใช่ http(s) ไม่ผ่าน', guard.routeRewriteFrom('ws://x:1/') !== null);

  section('rewrite_from: sub_filter เฉพาะ https block — http block ต้องไม่โดน');
  const rwSite = makeSite({ direct_port: 19002 });
  tls.issueCert(rwSite.name, ['172.23.10.34', '127.0.0.1']);
  addRoute(rwSite, { path_prefix: '/api/gb', target_url: 'http://172.23.10.34:18000', strip_prefix: 1 });
  addRoute(rwSite, { path_prefix: '/api/gwplc', target_url: 'http://172.23.10.34:2520', strip_prefix: 1, sse: 1 });
  db.prepare('UPDATE sites SET https_port=19444, https_enabled=1 WHERE id=?').run(rwSite.id);
  const rwFile = path.join(config.paths.nginxPorts, `${rwSite.name}.conf`);
  nginx.writePortConf(db.prepare('SELECT * FROM sites WHERE id=?').get(rwSite.id));
  const noRewriteConf = fs.readFileSync(rwFile, 'utf8');
  ok('ยังไม่มี rewrite_from -> ไม่มี sub_filter เลย (opt-in)', !noRewriteConf.includes('sub_filter'));
  // switch rewrites on for both routes
  db.prepare("UPDATE proxy_routes SET rewrite_from='http://172.23.10.34:18000/' WHERE site_id=? AND path_prefix='/api/gb'").run(rwSite.id);
  db.prepare("UPDATE proxy_routes SET rewrite_from='http://172.23.10.34:2520/' WHERE site_id=? AND path_prefix='/api/gwplc'").run(rwSite.id);
  nginx.writePortConf(db.prepare('SELECT * FROM sites WHERE id=?').get(rwSite.id));
  const rwConf = fs.readFileSync(rwFile, 'utf8');
  const httpsStart = rwConf.indexOf('# layer1 direct-port TLS for');
  ok('มี https block', httpsStart > 0);
  const httpPart = rwConf.slice(0, httpsStart);
  const httpsPart = rwConf.slice(httpsStart);
  eq('http block เหมือนตอนไม่มี rewrite ทุกไบต์', httpPart, noRewriteConf.slice(0, noRewriteConf.indexOf('# layer1 direct-port TLS for')));
  ok('http block ไม่มี sub_filter', !httpPart.includes('sub_filter'));
  ok("https block มี sub_filter '…:18000/' '/api/gb/'", httpsPart.includes("sub_filter 'http://172.23.10.34:18000/' '/api/gb/';"));
  ok("https block มี sub_filter '…:2520/' '/api/gwplc/'", httpsPart.includes("sub_filter 'http://172.23.10.34:2520/' '/api/gwplc/';"));
  ok('sub_filter_types application/javascript', httpsPart.includes('sub_filter_types application/javascript;'));
  ok('sub_filter_once off (URL ปรากฏหลายครั้งใน bundle)', httpsPart.includes('sub_filter_once off;'));
  ok('sub_filter_last_modified off (ตัด ETag/Last-Modified กัน 304 ผิด)', httpsPart.includes('sub_filter_last_modified off;'));
  const locRoot = httpsPart.indexOf('location / {');
  const firstProxy = httpsPart.indexOf('location /api/gb/');
  const subIdx = httpsPart.indexOf('sub_filter_types');
  ok('sub_filter อยู่ใน location / (static) ไม่ใช่ใน route ที่ proxy', subIdx > locRoot && locRoot > firstProxy);
  ok('route location ใน https block ไม่มี sub_filter', !httpsPart.slice(firstProxy, locRoot).includes('sub_filter'));
  ok('https block ยังมี try_files ของ static', httpsPart.includes('try_files $uri $uri/ /index.html;'));
  ok('ไม่มี gzip_static ที่ไหนเลย (จะข้าม sub_filter)', !rwConf.includes('gzip_static') && !mainConfText.includes('gzip_static'));
  const tRw = await nginx.test('silent');
  eq('nginx -t ผ่านจริงกับ sub_filter (binary มี http_sub_module)', tRw.code, 0);
  // rewrite off again -> byte-identical to the no-rewrite render
  db.prepare("UPDATE proxy_routes SET rewrite_from=NULL WHERE site_id=?").run(rwSite.id);
  nginx.writePortConf(db.prepare('SELECT * FROM sites WHERE id=?').get(rwSite.id));
  eq('เอา rewrite ออก -> ไฟล์กลับมาเหมือนก่อนใส่ทุกไบต์', fs.readFileSync(rwFile, 'utf8'), noRewriteConf);

  section('https entry gate: เฉพาะ /?<token> เปิดแอปได้บน https — http block ไม่แตะ');
  ok('guard: token ปกติผ่าน', guard.entryQuery('tabletnonscada') === null);
  ok('guard: ว่าง = ไม่มี gate', guard.entryQuery('') === null && guard.entryQuery(null) === null);
  ok('guard: มี regex meta/quote ไม่ผ่าน', guard.entryQuery('a|b') !== null && guard.entryQuery('x"y') !== null && guard.entryQuery('a b') !== null);
  const gSite = makeSite({ direct_port: 19003 });
  tls.issueCert(gSite.name, ['172.23.10.34', '127.0.0.1']);
  addRoute(gSite, { path_prefix: '/api/gb', target_url: 'http://172.23.10.34:18000', strip_prefix: 1, rewrite_from: 'http://172.23.10.34:18000/' });
  db.prepare('UPDATE sites SET https_port=19445, https_enabled=1 WHERE id=?').run(gSite.id);
  const gFile = path.join(config.paths.nginxPorts, `${gSite.name}.conf`);
  nginx.writePortConf(db.prepare('SELECT * FROM sites WHERE id=?').get(gSite.id));
  const ungated = fs.readFileSync(gFile, 'utf8');
  ok('ยังไม่ตั้ง entry_query -> ไม่มี map/403', !ungated.includes('wm_entry_deny') && !ungated.includes('403'));
  db.prepare("UPDATE sites SET https_entry_query='tabletnonscada' WHERE id=?").run(gSite.id);
  nginx.writePortConf(db.prepare('SELECT * FROM sites WHERE id=?').get(gSite.id));
  const gated = fs.readFileSync(gFile, 'utf8');
  const cut = (c) => c.indexOf('# https entry gate for') > 0 ? c.indexOf('# https entry gate for') : c.indexOf('# layer1 direct-port TLS for');
  eq('http block เหมือนตอนไม่มี gate ทุกไบต์', gated.slice(0, cut(gated)), ungated.slice(0, cut(ungated)));
  ok('http block ไม่มี 403/entry', !gated.slice(0, cut(gated)).includes('403'));
  const hs = gated.slice(gated.indexOf('# layer1 direct-port TLS for'));
  ok(`map ประกาศก่อน server block ด้วยชื่อ $wm_entry_deny_${gSite.id}`, gated.indexOf(`$wm_entry_deny_${gSite.id} {`) < gated.indexOf('# layer1 direct-port TLS for'));
  ok('map: มี token ใน query -> 0', gated.includes('"~\\|([^|]*&)?tabletnonscada(=|&|$)" 0;'));
  ok('map: fetch ที่ไม่ใช่ document (service worker) -> 0', gated.includes('"~^(empty|script|worker|serviceworker)\\|" 0;'));
  ok('map: default 1 (curl/ไม่มี header = deny)', gated.includes('default 1;'));
  ok('location = / มี if deny -> 403', /location = \/ \{\n\s+if \(\$wm_entry_deny_\d+\) \{ return 403; \}/.test(hs));
  ok('location = /index.html ก็ถูก gate', /location = \/index\.html \{\n\s+if \(\$wm_entry_deny_\d+\) \{ return 403; \}/.test(hs));
  ok('location / เสิร์ฟ asset จริงเท่านั้น ไม่มี SPA fallback', hs.includes('try_files $uri =404;') && !hs.includes('try_files $uri $uri/ /index.html'));
  ok('sub_filter ยังอยู่ใน location = / (index.html) และ location / (main.dart.js)', (hs.match(/sub_filter 'http:\/\/172\.23\.10\.34:18000\/' '\/api\/gb\/';/g) || []).length === 3);
  ok('route /api/gb/ ยังอยู่ใน https block', hs.includes('location /api/gb/'));
  const tGate = await nginx.test('silent');
  eq('nginx -t ผ่านจริงกับ map + if', tGate.code, 0);
  db.prepare('UPDATE sites SET https_entry_query=NULL WHERE id=?').run(gSite.id);
  nginx.writePortConf(db.prepare('SELECT * FROM sites WHERE id=?').get(gSite.id));
  eq('เอา entry_query ออก -> ไฟล์กลับเหมือนก่อนทุกไบต์', fs.readFileSync(gFile, 'utf8'), ungated);

  done();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
