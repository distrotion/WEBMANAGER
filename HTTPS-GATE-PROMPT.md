# PROMPT: ภารกิจ 1 — HTTPS gate สำหรับ "บางตัว" (เริ่มที่ superapp เพื่อกล้อง tablet)

> คัดลอกทั้งไฟล์ไปเป็น context ของ session ใหม่ · ข้อมูลแยกชัดว่าอันไหน **ยืนยันแล้ว** อันไหน **ต้องเช็คก่อน**
> ภารกิจนี้**ไม่รวม** เรื่อง AI คุมเครื่องเอง (self-update/fleet) — อยู่ใน `AI-FULL-CONTROL-PROMPT.md`

---

คุณทำงานใน repo **WEBMANAGER** (`/Users/administrator/TPK/QC/ALL-REFRESH-NEW/WEBMANAGER`, Node/Express + better-sqlite3 + nginx, deploy บน Windows Server) และ workspace **SOI8MASTER** (`/Users/administrator/TPK/QC/ALL-REFRESH-NEW/SOI8MASTER`, Flutter web UI หลายตัว)

## 0. เป้าหมายจริง (อย่าขยาย)

- **เหตุผลเดียวที่ต้อง https:** กล้องสแกนบาร์โค้ดสด (`navigator.mediaDevices.getUserMedia` + `BarcodeDetector`) บน **tablet Android/Chrome** ใช้ได้เฉพาะ secure context
- **ขอบเขต:** superapp ตัวเดียว · https เป็น **"ทางเลือก"** พอร์ตเพิ่ม **:7002** คู่กับ :7000 เดิม — **http :7000 ยังเป็นทางหลักของ PC และห้ามกระเทือน**
- ใช้งานผ่าน https จริงแค่ **feature เดียว** (เจ้าของยังไม่ระบุว่า P60 PROCESS MANUAL หรือ P149 INV MASTER — **ถามก่อน** แล้วใช้เป็นเกณฑ์รับของ) · หน้าอื่นเปิดผ่าน :7002 พังได้ ไม่ต้องแก้
- UI ตัวอื่นเพิ่มเฉพาะเมื่อมี feature ต้องใช้ ไม่ทำเผื่อ
- **SSL ภายในเท่านั้น:** CA ของเราเอง (เจ้าของตัดสิน 2026-09-20 ไม่เอา cert สาธารณะ/โดเมน) · ทุกอุปกรณ์ที่จะใช้ https ต้องลง CA กลาง 1 ครั้ง (tablet Android: Settings → Security → Install certificate → CA)

## 1. ของที่มีอยู่แล้ว — ยืนยันด้วย test + ใช้จริงบน .32 แล้ว (2026-09-20)

โค้ดทั้งหมดอยู่บน `origin/main` ของ WEBMANAGER (HEAD ≥ `ea4508d`)

| ชิ้น | ที่อยู่ | สถานะ |
|---|---|---|
| **back gate — proxy_routes** ต่อ site static: `location <prefix>/ { proxy_pass <target>[/] }` target เป็น host:port ใด ๆ (ข้ามเครื่องได้) · `strip_prefix` · `sse` (buffering off) · WebSocket ผ่าน `map $connection_upgrade` | `backend/src/nginx.js` `routeLocations/writePortConf`, `backend/src/routes/proxyroutes.routes.js` (`GET/POST/PUT/DELETE /api/sites/:id/routes`), ตาราง `proxy_routes` ใน `db.js` | test `backend/test/route.test.js` 40 ข้อ ผ่าน · ยังไม่มี route จริงบนเครื่องไหน |
| **front gate — https second listener** บนพอร์ตแยกของ site static (`listen <https_port> ssl; http2 on;`) cert จาก local CA SAN = IP ทุกตัวของเครื่อง | `POST /api/sites/:id/https/enable {https_port}` / `.../https/disable` ใน `ssl.routes.js` · เปิด firewall ให้เอง | test ผ่าน · ยังไม่เปิดจริงที่ไหน |
| **ทุกการแก้ conf ผ่าน `applyConfig`** — `nginx -t` ก่อน reload ล้มแล้วคืนไฟล์ทุกไบต์ | `nginx.js` | test ผ่าน |
| **CA กลางใบเดียวทุกเครื่อง** — export/import (key เข้ารหัส passphrase) + re-issue cert ลูกทุกใบ + restart ผู้ถือ cert | `tls.js` `exportCa/importCa`, `GET /api/system/ca`, `POST /api/system/ca/export|import` · test `ca.test.js` 22 ข้อ | **.32 import แล้ว** fingerprint `F9:F7:32:D5:D4:60:08:31:D3:EA:53:16:00:E2:AC:4F:CE:E9:50:1D:C8:93:7E:3E:51:97:87:17:48:DF:2E:27` · bundle เข้ารหัสที่ `~/.webmanager-pilot/ca-bundle.json`, passphrase `~/.webmanager-pilot/ca-pass` (0600) · **.34/.40 ยังไม่ import** |
| cert ให้แอปที่ทำ TLS เอง (node) | `POST /api/sites/:id/cert/issue`, `GET /api/sites/:id/cert` → `certs/<site>/fullchain.pem` + `privkey.pem` | ใช้จริงกับ BACK-TPK-AUTH บน .32 |
| CA ดาวน์โหลด | `http://<host>:8088/panel-ca.crt` (มีเมื่อ CA ถูกสร้าง/import แล้ว) | ทดสอบลงบน Mac (Keychain) + PC Windows (Trusted Root) แล้ว เบราว์เซอร์กุญแจเขียว |
| สคริปต์รันทีละขั้น | `scripts/https-pilot.py` — default `SITE_NAME=superapp SITE_PORT=7000 HTTPS_PORT=7002` บน .34 · คำสั่ง `health status baseline ftp-open backup routes verify-routes verify-build https verify-https diff ftp-close sites-smoke ca` · ขั้นแก้เครื่องมี `--dry-run` · `WM_PASS` ทาง env | ใช้จริงกับ .32 แล้ว |
| แผน/บันทึก | `HTTPS-PLAN.md` (คำตอบเฟส 0, ผลสำรวจ log, ขอบเขต UI 7 ตัว, runbook) · ฮับ AGENTHUB task **#437** (pilot) **#438** (ขยาย) **#439** (.168/Fleet) | อัปเดตล่าสุด 2026-09-20 |

**เครื่อง (ยืนยัน 2026-09-20)**

| เครื่อง | webmanager | หมายเหตุ |
|---|---|---|
| `.32` (172.23.10.32:8088) | `0c03e0b` มีทุกอย่างข้างบน (ยกเว้น sub_filter) · CA กลางแล้ว | site: TPK-POLICY-BACK:16190(node, ไม่ตอบอยู่ก่อนแล้ว), TPK-POLICY-FRONT-DEPLOY:6500, TPK-VISION-SAFTY-WEB:12000, BACK-TPK-AUTH:19443(node TLS), UI-TPK-AUTH-DEPLOY:19400 · gateway 17 เส้น · **:7000/:7002 ว่าง** · git token `github.com/distrotion` ใช้ได้ |
| `.34` (172.23.10.34:8088) | **`f4ee697` (7 ก.ย.) — ไม่มี gate เลย ต้องอัปเดต 1 ครั้ง** | superapp = **site id 1** static :7000 autodeploy จาก `https://github.com/distrotion/soi8-superapp-app-deploy` last `faa6e72` · **:7002 ว่าง** · 19 ไซต์ (baseline เก็บแล้วที่ `~/.webmanager-pilot/sites-172.23.10.34.json`) · gateway 1 · FTP :21 plain (user `autopackliquid`) · camera bridge/sync รันในโปรเซสเดียวกัน |
| `.40` | `f4ee697` | ยังไม่แตะ |
| `.168` | `43d6b91` (7 ส.ค.) ไม่มี monitors/camera | ต้องมีคนอัปเดตหน้าเครื่อง |

**การอัปเดต webmanager บนเครื่อง = คนกดหน้าเครื่อง**: `git pull` แล้ว `update.cmd` (Stop-Service wm-manager → robocopy → npm install → Start-Service) · nginx เป็น service แยก **หน้าเว็บไม่ดับ** · gateway/FTP/MQ/camera-sync ดับ ~20 วิ · ไม่มี API อัปเดตระยะไกล (เป็นภารกิจ 2)

## 2. superapp — ข้อเท็จจริงที่ตรวจจาก source (2026-09-20)

repo `SOI8MASTER/soi8-superapp-app` (ไม่ใช่ git ของ SOI8MASTER — ตัว SOI8MASTER ไม่ใช่ repo) · deploy repo `SOI8MASTER/DEPLOY/soi8-superapp-app-deploy` → .34 autodeploy ทันทีที่ push

- base URL ทั้งแอปอยู่ที่ `lib/data/global.dart:74-95` **8 const** ไม่มี hardcode absolute ที่อื่นในโค้ด:
  `serverGB` .34:18000 (login) · `serverQC` .34:15000 · `serverINV` .34:18010 · `server2` .168:14094 (SAP buffer) · `serverSAPBUF` .168:14090 · `serverSTATUS` .34:18020 · `serverOCR` .34:18030 · `serverGWPLC` .34:2520 (WebSocket กราฟน้ำหนัก P318 เท่านั้น)
- backend ทั้ง 8 ตอบอยู่ (GET / → 404 = ขึ้น) · `:2520/gw/weightstream` upgrade → **101** · CORS ทุกตัวไม่เกี่ยว (ผ่าน gate = same-origin)
- กล้องสด: `lib/widget/common/ComBarcodeScanner.dart` (getUserMedia+BarcodeDetector) ใช้ใน **P60 PROCESS MANUAL** และ **P149 INV MASTER (diff screen)** · `widget/QCWIDGET/CameraWeightRecord.dart` · `CameraOcr.dart` ใช้ `<input capture>` ทำงานบน http ได้อยู่แล้ว
- **`BarcodeDetector` มีใน Chrome Android ✓ · ไม่มีใน Safari/iPad ✗ · Chrome Windows ส่วนใหญ่ ✗** — tablet ต้องเป็น Android+Chrome (ยังไม่ได้ยืนยันกับเจ้าของ)
- หน้าที่ฝัง `<iframe src="http://…">` (adjust .34:2710, .34:6010/6500, .168:12135/12130/12140/12121) จะ**ถูกบล็อกเมื่อเปิดผ่าน https** — ยอมรับ ไม่แก้
- build: `SOI8MASTER/buildup-superapp.sh` (ไม่ใช่ buildup.sh) `--no-tree-shake-icons` · **แก้แล้ว 2026-09-20 (ยังไม่ได้ใช้):** สลับ 8 const เป็น `/api/*` ชั่วคราวตอน build แล้วคืนไฟล์ — เป็นของ "ทาง ก" ด้านล่าง; สำเนาเดิมอยู่ scratchpad ของ session เก่า (หายได้) ถ้าเลือกทาง ข ให้ **revert การแก้นี้**
- `lib/page/P318LOTTABLE/P318TANKGRAPH.dart:122` **แก้แล้ว ยังไม่ commit**: สร้าง ws(s):// จาก `Uri.base` เมื่อ `serverGWPLC` เป็น path — ไม่ใช่ feature กล้อง ถ้าเลือกทาง ข จะไม่ถูกใช้ ให้ revert หรือ commit แยกตามที่เจ้าของบอก
- **repo มีงานค้างไม่ commit ของคนอื่น**: `M lib/page/P60PRCESSMANUAL/P60PRCESSMANUALMAIN.dart`, untracked `lib/widget/common/ComBarcodeScanner.dart`, `ComBarcodePhoto.dart`, `UI-RESTYLE/`, `.claude/` — **ห้าม stash/checkout/ลบ** ถามเจ้าของว่าใครทำ พร้อมมั้ย

## 3. ทางที่เลือกแล้ว: **ข — gate แก้ URL ใน bundle เองตอนเสิร์ฟ** (เจ้าของ 2026-09-20)

เหตุผล: ทดสอบทั้งสายบน .32 ด้วย **bundle production ตัวเดียวกัน** ได้โดยไม่ push อะไร (ทาง ก ต้อง build ใหม่แล้ว push deploy repo → .34 autodeploy = แตะ production) และทางหลัก :7000 ไม่เปลี่ยนแม้ไบต์เดียว

**ต้องเขียนเพิ่มใน webmanager (ยังไม่มี):**
1. ฝั่ง **https ของ site เท่านั้น** ใช้ nginx `sub_filter` แทนที่ absolute base URL ใน `main.dart.js` ด้วย path ของ route: `sub_filter 'http://172.23.10.34:18000/' '/api/gb/'; … sub_filter_types application/javascript; sub_filter_once off;` — ต้อง**แยก server block https ออกจาก http** ใน `writePortConf` (ตอนนี้สอง listen อยู่ block เดียว) เพื่อไม่ให้ http :7000 โดน rewrite
2. ที่เก็บตาราง rewrite: เพิ่มคอลัมน์ใน `proxy_routes` เช่น `rewrite_from TEXT` (absolute URL เดิมที่จะถูกแทนด้วย `path_prefix + '/'`) · guard: ต้องเป็น `http(s)://host[:port]/` เท่านั้น ไม่มี `'` `"` `;` `\n`
3. `sub_filter` ต้องปิด gzip จาก upstream/static (`gzip` เปิดที่ response ก็ได้ แต่ห้าม serve ไฟล์ที่ pre-compressed) และเพิ่ม `proxy_set_header Accept-Encoding ""` เฉพาะถ้าไป proxy — สำหรับ static root ธรรมดา sub_filter ทำงานตรง ๆ · ตรวจ `sub_filter_last_modified off` และ Flutter service worker (`flutter_service_worker.js` มี hash ของ `main.dart.js` — **เนื้อไฟล์เปลี่ยนแต่ hash ในตาราง SW เป็นของต้นฉบับ**: ทดสอบว่า offline-first PWA ไม่ทำให้ tablet ค้าง bundle เดิม; ถ้าติด ต้อง sub_filter `flutter_service_worker.js` ด้วยหรือปิด SW เฉพาะ https)
4. test ใน `route.test.js` หรือไฟล์ใหม่: render https block มี sub_filter ครบ, http block **ไม่มี** sub_filter, `nginx -t` ผ่านจริง, byte-identical เมื่อไม่มี rewrite
5. เพิ่มใน `scripts/https-pilot.py`: route ทั้ง 8 ใส่ `rewrite_from` = ค่า absolute เดิม · `verify-build` ยิง `https://<host>:7002/main.dart.js` (ด้วย CA) ต้องมี absolute = 0, relative ครบ 8 · ยิง `http://<host>:7000/main.dart.js` ต้อง**เหมือน deploy repo ทุกไบต์**

**ทางสำรอง ก (มีโค้ดพร้อมแล้ว ไม่ต้องเขียน):** สลับ const เป็น relative ตอน build (`buildup-superapp.sh` ที่แก้ไว้) → build เดียวใช้ทั้ง :7000/:7002 → PC บน :7000 จะวิ่งผ่าน nginx proxy ด้วย (ทางหลักเปลี่ยน) → ทดสอบบน .32 ต้องมี deploy repo แยก

## 4. ลำดับงาน (ทำบน .32 ให้ครบก่อน .34)

**A. โค้ด** — ข้อ 3.1-3.5 → test suite ผ่านทั้งชุด (`cd backend && node test/run.js`) → push (เจ้าของอนุญาต push ของ WEBMANAGER แล้ว)
**B. .32 อัปเดต** — เจ้าของกด `git pull` + `update.cmd` → `WM_URL=http://172.23.10.32:8088 scripts/https-pilot.py sites-smoke check` + `health` ต้องตรง HEAD
**C. site ทดสอบบน .32** — สร้าง site static ชื่อ `superapp` (หรือ `superapp-https-test`) repo `https://github.com/distrotion/soi8-superapp-app-deploy` branch main direct_port **7000** autodeploy **ปิด** (ห้ามให้ .32 ไล่ตาม push production เอง) → deploy → route 8 เส้นพร้อม `rewrite_from` → `POST /https/enable {https_port:7002}` → `verify-routes` (status ผ่าน gate = ยิงตรง) → `verify-build` → `verify-https` (chain ผ่าน CA กลาง)
**D. tablet** — ลง CA (`http://172.23.10.32:8088/panel-ca.crt`) → เปิด `https://172.23.10.32:7002` → login → เข้า feature ที่เจ้าของระบุ → กล้องเปิด → สแกนได้ → บันทึกผ่าน backend จริง (.34) สำเร็จ = **เกณฑ์ผ่าน** · เก็บ screenshot/ผลลง `HTTPS-PLAN.md`
**E. .34** — เมื่อ D ผ่านและเจ้าของเลือกจังหวะ (ระบบสำคัญ ตอบเฟส 0 ว่า "อัปเกรดตอนที่ปลอดภัย"): `sites-smoke save` (มีแล้ว) → เจ้าของอัปเดต → `sites-smoke check` → `ca import` **ก่อน** → `baseline` → route 8 เส้นบน site id 1 → `verify-routes` → `https` :7002 → `verify-*` → tablet ซ้ำ D กับ `https://172.23.10.34:7002` · **ห้ามแตะ direct_port 7000 / ห้าม disable http**
**F. ปิดงาน** — ลบ site ทดสอบบน .32 (+ ปิด firewall 7000/7002 บน .32) · อัปเดตฮับ #437 (ปิดได้เมื่อ E ผ่าน) · บันทึก `HTTPS-PLAN.md`

## 5. กับดักที่เจอจริงแล้ว — อย่าเจอซ้ำ

- เบราว์เซอร์ที่ไม่มี CA ให้แค่ **"Failed to fetch"** ไม่บอกสาเหตุ → ทุกครั้งที่ UI ต่อ https ไม่ได้ เช็ค CA ก่อน (เปิด `https://<host>:<port>/api/...` ตรง ๆ ดูหน้าเตือน)
- **ไฟล์ `panel-ca.crt` เก่าค้างใน Downloads** (ทั้ง Mac และ PC) — ลงใบผิด 2 รอบวันนี้ · ใบกลางต้อง Valid from **19/9/2569 (2026-09-19)** ถึง 2036-09 · ใบเก่าของ .32 = 14/7/2569
- macOS: ดับเบิลคลิก `.crt` **ไม่ import** เสมอ → ใช้ Keychain Access → File → Import Items แล้วตั้ง Always Trust หรือ `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db <file>` (ผู้ใช้รันเอง — AI ห้ามแก้ security setting)
- Windows: Install Certificate → **Local Machine** → Trusted Root Certification Authorities · Chrome ต้องปิด-เปิดใหม่
- ตัวตรวจ Python (`ssl.create_default_context(cafile=CA)`) เข้มกว่าเบราว์เซอร์ — CA เก่าไม่มี SKI/AKI/critical BC จะล้ม ใบกลางแก้แล้วผ่าน `openssl verify -x509_strict`
- `tail -1` กลบ exit code ของ test → ตรวจ "ผ่านครบ N ไฟล์" ด้วย grep ก่อน push
- `dart analyze` ของ superapp ขึ้น "Future isn't a type" 421 จุด**ทั้งโปรเจกต์อยู่ก่อนแล้ว** — ไม่ใช่ตัววัด ใช้ `flutter build web` แทน
- `PUT /api/sites/:id` แก้ `direct_port` **ไม่** gen conf/ย้าย firewall → ห้ามใช้เปลี่ยนพอร์ต
- ทุก site บน .32/.34 ใช้ IP ตรง ไม่มีโดเมน → SAN ต้องมี IP (issueCert ใส่ให้อัตโนมัติ)
- VPN บน Mac ของเจ้าของหลุดได้ → วง 172.23/172.20 หายทั้งหมด ไม่ใช่ server ล่ม — ping `172.23.10.32` ก่อนสรุป

## 6. กฎการทำงานกับเจ้าของ

- ตอบภาษาไทย terse (`⚡ terse`) · ไม่เดาการตัดสินใจธุรกิจ — ถามสั้น ๆ
- **แตะ production (.34) ต้องขอ**: จังหวะอัปเดต, สร้าง/ลบ site, เปิดพอร์ต · .32 ถือเป็นเครื่องซ้อม ทำได้เมื่อบอกแล้ว
- ห้าม commit/push repo อื่นนอก WEBMANAGER (superapp, deploy) โดยไม่สั่ง · ห้ามแตะ WIP ของคนอื่นใน superapp
- ห้ามพิมพ์ `HUB_API_TOKEN`, รหัส panel (admin ของ .32/.34 = ที่เจ้าของให้ในแชท ใช้ทาง env), passphrase CA
- AGENTHUB: `~/.claude/agenthub.env` (`HUB_URL`, `HUB_API_TOKEN`) header `x-api-token` · `GET /api/tasks` แล้ว `PATCH /api/tasks/:id {detail}` ต่อท้าย (GET รายตัว 404) · ปิด task ใช้ `closed_by:"session_manager"`

## โจทย์

ทำภารกิจ 1 ตามข้อ 3 (ทาง ข) และลำดับข้อ 4 จนถึงเกณฑ์ผ่านข้อ D บน .32 · เริ่มจากถามเจ้าของ 3 ข้อ: feature เดียวที่จะใช้คือหน้าไหน · tablet เป็น Android+Chrome มั้ย · WIP ใน repo superapp ใครทำ พร้อมมั้ย — แล้วเขียนโค้ดข้อ 3 ระหว่างรอคำตอบ
