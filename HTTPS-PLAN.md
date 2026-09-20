# HTTPS-PLAN — บันทึกผลเฟส 0 (ตัดสินใจ + สำรวจ)

> ไฟล์นี้คือ "คำตอบ" ที่เฟส 1-4 (task #436-#439 ในฮับ) อ่านต่อ — ตามที่ #435 กำหนดไว้ว่าต้องมีที่บันทึกถาวร
> ไม่ใช่แชท · อัปเดตเมื่อคำตอบเปลี่ยน พร้อมวันที่ + ใครตอบ

ทางที่เลือก: **B — https ขอบเดียว + reverse proxy** (nginx บน .34 ถือ cert ที่พอร์ตเดิม เสิร์ฟ static + proxy
เส้นทาง api ไป backend ที่ยังเป็น http) — โค้ดเฟส 1 เสร็จแล้ว commit `54ba98d` (ยังไม่ deploy ลง .34)

## ข้อ 1-4 — คำตอบเจ้าของ (ตอบ 2026-09-19 ทางแชท)

| ข้อ | คำถาม | คำตอบ | ผลต่อแผน |
|---|---|---|---|
| 1 | downtime window สำหรับแตะ .34 | **"จะอัปเกรดตอนที่ปลอดภัย"** → ระบุแล้ว 2026-09-19: **พรุ่งนี้ 2026-09-20 หยุดทั้งวัน = window** · สำรวจให้ครบก่อน แล้ว **อัปเดต .34 ครั้งเดียว** ทำ #437 ขั้น 1/3/5 ต่อในรอบเดียวกัน | เตรียมทุกอย่างให้พร้อมกดได้ · **การ deploy เฟส 1 ลง .34 (restart wm-manager) และการสลับพอร์ตจริง รอเจ้าของสั่ง ณ เวลานั้น** ห้ามนัดเอง |
| 2 | เครื่องที่ต้องลง CA มีมือถือ/แท็บเล็ตมั้ย | **PC/Windows เท่านั้น** | ลง `panel-ca.crt` เป็น Trusted Root แบบปกติ · ไม่มีเงื่อนไข "ห้ามเริ่มเฟส 1" จากข้อนี้ |
| 3 | ใครแก้ config ของแต่ละ UI | ดูตารางขอบเขตด้านล่าง — 4 ตัวอยู่ใน `SOI8MASTER/buildup.sh` แล้ว = mainservice build เองได้ | ตัวที่เหลือต้องดูสคริปต์ build / ถามเจ้าของ (WWT-TTC ไม่มี repo บนเครื่องนี้) |
| 4 | ยอมให้ผู้ใช้หลุด login ตอนสลับมั้ย | **"จะไม่เกิด เพราะจะค่อยๆ เปลี่ยน และยังคงระบบเดิมไว้"** | ยึดหลัก **เปิดพอร์ต http เดิมค้างไว้คู่กับ https ตลอด** ไม่ทำ hard cutover · ขั้น 6 ของ #437 (สลับ :2521 เป็น https) **เลื่อนออก/ไม่ทำ** จนกว่าเจ้าของสั่งแยกอีกครั้ง |

## ตารางขอบเขต UI (ตรวจ 2026-09-19 · ทุกตัวบน .34 · source ใต้ `/Users/administrator/TPK/QC/ALL-REFRESH-NEW/SOI8MASTER`)

| UI | พอร์ต | source repo | deploy repo | endpoint ตั้งที่ไหน | build ได้เองมั้ย |
|---|---|---|---|---|---|
| UI-SOI8GWPLC-DEPLOY | 2521 | UI-SOI8GWPLC | UI-SOI8GWPLC-DEPLOY | `--dart-define GWPLC_BACKEND / GWPLC_AUTH` (lib/config/app_config.dart) | ✓ buildup.sh |
| automobile-soi8 | 6500 | automobile-soi8 | /Users/administrator/TPK/SOI8/automobile-soi8-deploy | — | ✓ buildup.sh |
| soi8-adjust-app-deploy | 2710 | soi8adjust/soi8-adjust-app | — | — | ✗ ไม่อยู่ใน buildup.sh ต้องดูวิธี build |
| UI-INVENTORY-DEPLOY | 7250 | UI-INVENTORY | UI-INVENTORY-DEPLOY | const ใน lib/data/global.dart (ตรวจก่อนแก้) | ✓ buildup.sh |
| SOI8QCFINAL6010 | 6010 | SOI8QCFINAL | SOI8QCFINAL-DEPLOY | — | ✓ buildup.sh |
| WWT-TTC-DEPLOY | 9600 | **ไม่มีบนเครื่องนี้** | — | — | ✗ ต้องถามเจ้าของ |
| superapp | 7000 | soi8-superapp-app | DEPLOY/soi8-superapp-app-deploy | `serverGB` ใน lib/data/global.dart สลับด้วย buildup-superapp.sh | ✗ ใช้สคริปต์แยก |

## ข้อ 5 — สำรวจ client ที่ไม่ใช่เบราว์เซอร์บนพอร์ต UI (.34)

**วิธี:** ดึง `C:\webmanager\nginx\logs\access.log` (44.7 MB, 518,463 บรรทัด, **14 Jul → 19 Sep 2026** = 2 เดือนเต็ม)
ผ่านบัญชี FTP ชั่วคราว `tmp-log-survey` root=`nginx\logs` (เจ้าของอนุมัติ 2026-09-19 · **ลบบัญชีทิ้งแล้ว**หลังใช้)
แยกเบราว์เซอร์ด้วย UA มี `Mozilla` · ระบุพอร์ตด้วย **ขนาด response ของ `GET /`** (combined log ไม่มี `$server_port`):
`1558`=:2521 · `13351`=:6500 · `1249`=:2710 · `1698`=:7250 · `968`=:9600 · `4127`=:6010 · `1898`=:7000 · `11312`=build เก่าที่ถูก deploy ทับไปแล้ว (ระบุตัวไม่ได้)

**ผล:** เบราว์เซอร์ 14,551 บรรทัด · **ไม่ใช่เบราว์เซอร์ 503,912 บรรทัด (97%) จาก UA เพียง 3 แบบ อธิบายได้ครบทุกแบบ**

| IP | UA | requests | ช่วงเวลา | พอร์ตที่โดน | คืออะไร | ผลต่อการสลับ https |
|---|---|---|---|---|---|---|
| **172.23.10.34** (ตัวเอง) | `-` | **476,802** ทุก ~2.5-3 วิ | 25 Aug 11:03 → ตอนนี้ (ต่อเนื่อง) | **:2710 และ :6500** สลับกันเป๊ะ (238,402 / 238,400) | **SOI8STATUS** (PM2 :18020) `flow/001/status.js` → `probeHttp()` ทุก `CACHE_TTL_MS`=5000 ms · ระบบใน `config/systems.json` id `adjust-front` (:2710) และ `automobile-soi8` (:6500) · Node core `http.get` ไม่ตั้ง User-Agent → `-` | **ไม่กระทบ**ถ้าเปิด https เป็นพอร์ตที่สองตามแผน (พอร์ต http เดิมยังอยู่) · ถ้าวันหน้าปิดพอร์ต http: URL hardcode `http://` (status.js:55) จะไปชน TLS port → ตอบ 400/301 ซึ่ง probeHttp **นับทุก response เป็น UP** (probe.js:110) = ไม่แดง แต่ก็ไม่ได้วัดของจริง · แก้ที่ `systems.json` ให้ probe https ได้เพราะ probe.js รองรับ https อยู่แล้ว (บรรทัด 91) |
| 172.101.34.209 | `-` | 850 (bursts) | 17 Aug → **26 Aug** (หยุดแล้ว) | :2710, :6500, 11312 | **น่าจะ** SOI8STATUS ตัวเดียวกันรันจากเครื่อง dev บนวง 172.101 ก่อน deploy ขึ้น .34 (25 Aug) — signature เหมือนกันทุกอย่าง (ยิงคู่ 1249+13351 ในวินาทีเดียว, UA `-`) และหยุด 1 วันหลัง .34 เริ่ม · *เป็นการอนุมาน ยังไม่ได้ยืนยันกับเจ้าของเครื่อง* | ไม่มี (หยุดแล้ว 3 สัปดาห์) |
| 172.18.41.160 / 172.31.11.7 | `-`, `curl/8.7.1`, `WebKit.Networking` | 26,260 | 16 Aug → 18 Sep | :2710, :6500, 11312, `/version.json`, `/main.dart.js` | **เครื่อง Mac ของ mainservice เอง** (IP ตรงกับที่เห็นตอนทดสอบ FTP) — curl เช็คเวอร์ชัน/แกะ bundle ระหว่างทำงาน + Safari preview | ไม่มี (ไม่ใช่ production) |
| :2521 · :7250 · :9600 · :6010 · :7000 | — | **0** | 2 เดือน | — | **ไม่พบ client ที่ไม่ใช่เบราว์เซอร์เลย** | ปลอดภัยที่จะเป็นตัวนำร่อง (:2521 ตามแผน) |

หลักฐานดิบ (ตัดจาก log):
```
172.23.10.34   - - [25/Aug/2026:11:03:42 +0700] "GET / HTTP/1.1" 200 1249  "-" "-"   <- บรรทัดแรกของ poller
172.23.10.34   - - [19/Sep/2026:09:09:23 +0700] "GET / HTTP/1.1" 200 1249  "-" "-"
172.23.10.34   - - [19/Sep/2026:09:09:23 +0700] "GET / HTTP/1.1" 200 13351 "-" "-"
172.101.34.209 - - [26/Aug/2026:13:35:16 +0700] "GET / HTTP/1.1" 200 13351 "-" "-"   <- บรรทัดสุดท้ายของเครื่องนี้
172.101.34.209 - - [26/Aug/2026:13:35:16 +0700] "GET / HTTP/1.1" 200 1249  "-" "-"
```
error.log (14 Jul → 18 Sep): สะอาด — มีแค่ `[emerg] bind() to 0.0.0.0:6010 failed (10013)` 2 ครั้งวันที่ 14 Jul ตอนติดตั้งครั้งแรก ไม่มี upstream/502/504 เลย
เศษ 1 บรรทัด: TLS ClientHello ยิงเข้าพอร์ต http (มีคนลอง https:// บนพอร์ตที่เป็น http ครั้งเดียว) — ไม่มีนัยสำคัญ

**ข้อสรุปข้อ 5:** client ที่ไม่ใช่เบราว์เซอร์บนพอร์ต UI มีตัวเดียวคือ **SOI8STATUS บน .34 เอง** (ไม่ใช่ PLC/Pi/Node-RED) ยิง :2710 กับ :6500 เท่านั้น
และ**ไม่ถูกกระทบ**จากแผน B ที่เปิด https เป็นพอร์ตที่สองโดยคงพอร์ต http ไว้ · พอร์ตนำร่อง :2521 และอีก 4 พอร์ตไม่มี client แบบนี้เลย

## เงื่อนไขไม่ผ่านที่เคยตั้งไว้ — สถานะ

- ข้อ 2 มีมือถือที่ลง CA ไม่ได้ → **ไม่เกิด** (PC เท่านั้น)
- ข้อ 1 ไม่มี window → **ไม่ใช่ "ไม่มี"** แต่เจ้าของเลือกเอง → เฟส 1 ทำได้ (ทำแล้ว) · ขั้นแตะ .34 รอสั่ง
- ข้อ 5 พบ client ยิงพอร์ต UI → **พบที่ :2710/:6500 (SOI8STATUS)** → สองพอร์ตนี้ **ห้ามปิดพอร์ต http** ตราบที่ systems.json ยังชี้ `http://` (สอดคล้องกับข้อ 4 อยู่แล้ว)

## ด่านผ่านไปเฟส 1/2

- (ก) ข้อ 1-4 มีคำตอบ + วันที่ ✓ (2026-09-19, เจ้าของทางแชท)
- (ข) ข้อ 5 มีตาราง + หลักฐานดิบ ✓
- (ค) สรุป: **ไปต่อได้** — เฟส 1 เสร็จแล้ว (`54ba98d`) · เฟส 2 ขั้น 1/3/5 พร้อมทำเมื่อเจ้าของให้จังหวะ deploy ลง .34 · ขั้น 6 (สลับพอร์ตจริง) **ไม่ทำ** ตามข้อ 4

## สำรวจเพิ่ม 2026-09-19 (ก่อน window พรุ่งนี้ · อ่านอย่างเดียว ไม่แตะ .34)

**Baseline ยิงตรง (ไว้เทียบหลังใส่เส้นทาง — status ต้องเท่ากันทุกเส้น):**

| ปลายทาง | path ที่ UI-SOI8GWPLC เรียก | status ตรง |
|---|---|---|
| :2520 | `/gw/plcs` `/qc_peers` `/plc_source` `/register_map` `/gw_log` | 200 json |
| :2520 | `/gw/stream` | 200 `text/event-stream` (SSE จริง) |
| :2520 | `/gw/tags` (ไม่มี query) | 400 json |
| :2520 | `/` `/FATA`(GET) `/version.json` | 404 (UI ไม่เรียก root — ปกติ) |
| :15000 | GET `/gwplcstate` `/gwplcregistermap` · POST `/login` `/getitemregistry` (body `{}`) | 200 json |
| :15000 | POST `/gwplcregistermap` (body `{}`) | 400 json |

- **CORS:** ทั้ง :2520 และ :15000 ตอบ `Access-Control-Allow-Origin: *` → Origin เปลี่ยนเป็น `https://172.23.10.34:2443` ไม่มีผล · proxy ส่ง `Host $host`, `X-Forwarded-Proto $scheme` (nginx.js PROXY_HDR) — backend ไม่เช็ค Host
- **nginx บน .34 = 1.28.0** → `http2 on;` ใช้ได้ (ต้อง ≥1.25.1) · สมมติว่า Windows build มี `http_ssl_module` (official build มีทุกรุ่น) — ยืนยันจริงตอน `nginx -t` ผ่านในขั้น 3
- **CA ยังไม่มีบน .34:** `GET :8088/panel-ca.crt` → 404 "no CA yet" · FTP บน .34 เป็น FTP เปล่า (`tls:false`) จึงไม่เคยสร้าง panel cert/CA · `issueCert()` → `ensureCa()` จะสร้าง CA ตอนขั้น 3 → **ดาวน์โหลด CA (ขั้น 4) ได้หลังขั้น 3 เท่านั้น** · FTP เดิมไม่กระทบ
- **ตอน restart wm-manager:** `bootstrapPrefix()` เขียน nginx.conf ใหม่ (เพิ่ม `map $connection_upgrade`) แต่ไม่ reload · nginx เป็น Windows service แยก → **หน้าเว็บทุกพอร์ตยังเสิร์ฟต่อระหว่างอัปเดต** · nginx.conf ใหม่มีผลตอน reload ครั้งแรก (ขั้น 1) ซึ่งผ่าน `applyConfig` nginx -t + คืนไฟล์อัตโนมัติถ้าพัง
- **อ่าน conf.d บน .34 ระยะไกลไม่ได้:** `GET /api/shares` = `[]` ไม่มี share · ถ้าจะสำรอง/diff conf.d ก่อน reload ตามข้อกำหนดใน #437 ต้องมี FTP account ชั่วคราว root=`nginx\conf.d` (อ่านอย่างเดียว) — ขอเจ้าของใน window · ไม่มีก็พึ่ง snapshot/restore ของ applyConfig
- **เวอร์ชัน fleet:** .34 `f4ee697` · .32 `b6e68b6` · .40 `f4ee697` · .168 `43d6b91` (ยังไม่มี monitors/camera)

**ขอบเขต #438 (สำรวจ source 5 UI ที่เหลือ):**

| UI | endpoint กำหนดที่ | ปลายทาง (host:port) | ข้อสังเกต |
|---|---|---|---|
| automobile-soi8 :6500 | `lib/data/global.dart:21` const `serverG` | .34:17000 | ไม่มี define → ต้องแก้ const เป็น `/api/` |
| soi8-adjust-app :2710 | `lib/config.dart:4,11` `String.fromEnvironment('ADJUST_BACKEND'/'ADJUST_AUTH')` default localhost:2701 / .34:15000 | .34:2701, .34:15000 | **ไม่อยู่ใน buildup.sh** — build ด้วย dart-define เอง (แบบเดียวกับ GWPLC) |
| UI-INVENTORY :7250 | `lib/data/global.dart:67-68` const | .34:18000, .34:18010 | ไม่มี define |
| SOI8QCFINAL :6010 | `lib/data/server_url.dart:4`, `global.dart:57,62` **+ hardcode 4 ไฟล์** (`item_registry_page.dart:12`, `master_v2_page.dart:21`, `P12PROGRESS/PROGRESS.dart:36`, `main_master_v2_demo.dart:52`) | .34:15000, .34:15010, **.51:6001 (OCR)**, **iframe http://.34:2710** | iframe http ในหน้า https = mixed content ถูกบล็อก |
| soi8-superapp-app :7000 | `global.dart:74-77` + hardcode ~10 หน้า (P108/P145/P146/P147/P148/P143…) | .34:18000/15000/18010, **.168:14094**, iframe **.168:12135/12130/12140/12121**, .168:5510, iframe .34:2710/6010/6500, .32:10000, **ws://.34:2520/gw/weightstream**, POST **172.101.5.6:1880** | มากสุด — ท้ายสุดตามแผน |

**ข้อสรุปใหม่สำหรับ #438 — ลำดับบังคับจาก iframe:** เบราว์เซอร์บล็อก `<iframe src="http://…">` ในหน้า https (blockable mixed content) → **แอปที่ถูกฝังต้องเป็น https ก่อนแอปที่ฝัง** (callee-before-caller ใช้กับ iframe ด้วย):
`adjust :2710` → ก่อน `SOI8QCFINAL :6010` และ `superapp` · `:6010`/`:6500` → ก่อน `superapp` · แอปบน **.168** (4 iframe + backend :14094) ต้องรอ .168 อัปเดต (#439) หรือ proxy ผ่าน nginx .34 (route target เป็น host อื่นได้) · `ws://` ของ superapp ต้องเป็น `wss://` ผ่าน route (`$connection_upgrade` รองรับแล้ว) · `172.101.5.6:1880` (Node-RED คนละวง) proxy ผ่าน .34 ได้ถ้าเจ้าของอนุญาต (#439)

## Runbook 2026-09-20 (window หยุดทั้งวัน · ทำรอบเดียว)

> ทุกขั้นมีคำสั่งใน `scripts/https-pilot.py` (รันจากเครื่อง dev · `WM_PASS` ทาง env · state/backup ที่ `~/.webmanager-pilot/` · ขั้นที่แก้ .34 มี `--dry-run`)
> ลำดับ: (.32 ก่อน: `sites-smoke save`✓ → update → `sites-smoke check`) แล้ว .34: `sites-smoke save`✓ → update → `sites-smoke check` → `health` → `status` → `baseline`(ทำแล้ว 19 ก.ย.) → `ftp-open` → `backup before` → `routes` → `verify-routes` → `backup after-routes` → `diff before after-routes`
> → `build-defines` → `./buildup.sh UI-SOI8GWPLC` → `verify-build` → `https` → `verify-https` → `backup after-https` → `diff before after-https` → `ftp-close`
> `verify-*` ล้มเมื่อไหร่ = หยุดขั้นถัดไป · `verify-https` ตรวจ chain+IP SAN ด้วย CA จาก panel จริง (ไม่ bypass TLS)

0-pre. **ซ้อมที่ .32 ก่อน** (เจ้าของเลือก 2026-09-19): `.32` อยู่ที่ `b6e68b6` (15 ส.ค.) → HEAD ข้าม migration หลายตัว (proxy_routes, sites.https_*, ftp_users, gateways.ftp_mode, camera) เจอปัญหาที่นี่ก่อนดีกว่า .34
   mainservice: `WM_URL=http://172.23.10.32:8088 scripts/https-pilot.py sites-smoke save` (ทำแล้ว 19 ก.ย.: 3 ไซต์ · `TPK-POLICY-BACK:16190` ไม่ตอบอยู่แล้วก่อนอัปเดต — ไม่ใช่ผลจากอัปเดต)
   เจ้าของที่ .32: `git pull` → `update.cmd` → mainservice: `... sites-smoke check` + health version ตรง HEAD → ผ่านแล้วค่อยไป .34
0. **เจ้าของที่หน้าเครื่อง .34:** `git pull` แล้วดับเบิลคลิก `update.cmd` → mainservice เช็ค `curl http://172.23.10.34:8088/api/health` ต้องได้ version `bbda78b` (HEAD ปัจจุบัน) · เช็ค FTP/gateway/camera-sync กลับมา
0a. **CA ใบเดียวทุกเครื่อง** (เจ้าของตัดสินใจ 2026-09-20): `WM_URL=http://172.23.10.34:8088 scripts/https-pilot.py ca import` (bundle เข้ารหัสอยู่ `~/.webmanager-pilot/ca-bundle.json`, passphrase ใน `ca-pass`) **ก่อน** ขั้น 1/3 — cert ของ :2443 จะได้ออกด้วย CA กลาง fingerprint `F9:F7:32:…:2E:27` ใบเดียวกับ .32 · PC ลง `panel-ca.crt` จากเครื่องไหนก็ได้ครั้งเดียว
0b. (ถ้าเจ้าของอนุมัติ) FTP ชั่วคราว root=`nginx\conf.d` อ่านอย่างเดียว → สำรอง `ports/*.conf` + `front/*.conf` ไว้ diff หลังทุกขั้น · ลบบัญชีตอนจบ
1. `POST /api/sites/18/routes` ×2: `{path_prefix:"/api", target_url:"http://127.0.0.1:2520", strip_prefix:true, sse:true}` และ `{path_prefix:"/auth", target_url:"http://172.23.10.34:15000", strip_prefix:true}` (sse ทั้ง /api เพราะ `/gw/stream` อยู่ใต้ prefix เดียวกัน — proxy_buffering off กับ json ปกติไม่มีผลเสีย)
   ตรวจ: ทุก path ในตาราง baseline ยิงผ่าน `http://172.23.10.34:2521/api/<p>` และ `/auth/<p>` **status เท่า baseline ทุกเส้น** · `curl -N -m 5 http://172.23.10.34:2521/api/gw/stream` ต้องเห็น event ไหล · diff conf ไซต์อื่นต้องไม่เปลี่ยน
2. แก้ `SOI8MASTER/buildup.sh:14` define → `GWPLC_BACKEND=/api` `GWPLC_AUTH=/auth/` → `./buildup.sh UI-SOI8GWPLC` → autodeploy ขึ้น .34 · ตรวจ `curl -s http://172.23.10.34:2521/main.dart.js | grep -c "172\.23\.10\.34"` = **0** · เปิดหน้า :2521 ใช้งานได้จริง (login/PLC list/stream) — ระวัง fetchMonitor/fetchQcLink กลืน error
3. `POST /api/sites/18/https/enable {https_port:2443}` → ตรวจ `curl -k -o /dev/null -w "%{http_code}" https://172.23.10.34:2443/` = 200 · `openssl s_client -connect 172.23.10.34:2443 </dev/null 2>/dev/null | openssl x509 -noout -ext subjectAltName` มี `IP:172.23.10.34` · `http://…:2521/` ยัง 200 · firewall 2443 เปิดอัตโนมัติ (ssl.routes.js:78)
4. เครื่องทดสอบ (PC/Windows): โหลด `http://172.23.10.34:8088/panel-ca.crt` → Trusted Root → เปิด `https://172.23.10.34:2443` กุญแจไม่เตือน · ทดสอบ login/stream/write
5. ปิดงาน: FTP/gateway/camera-sync/MQ ขึ้นครบ · ลบ FTP ชั่วคราว (ถ้ามี) · บันทึกผลลง #437 · **ขั้น 6 ไม่ทำ**
