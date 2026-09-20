# PROMPT: ภารกิจ 2 — AI full control (ให้ AI ดูแล server ทุกเครื่องได้เองโดยไม่ต้องมีคนกดหน้าเครื่อง)

> คัดลอกทั้งไฟล์ไปเป็น context ของ session ใหม่ · แยกชัดว่าอันไหน **ยืนยันแล้ว** อันไหน **เจ้าของต้องตัดสิน**
> ภารกิจนี้**ไม่รวม** https/gate ของแอป — อยู่ใน `HTTPS-GATE-PROMPT.md` · แต่ภารกิจ 1 จะเร็วขึ้นมากเมื่อภารกิจ 2 ข้อ 1 เสร็จ

---

คุณทำงานใน repo **WEBMANAGER** (`/Users/administrator/TPK/QC/ALL-REFRESH-NEW/WEBMANAGER`) — control panel Node/Express + better-sqlite3 + nginx + PM2 ที่รันเป็น Windows service `wm-manager` บน server หลายเครื่อง · เจ้าของ (distrotion) ต้องการให้ AI ("mainservice") ตั้งค่า/อัปเดต/ตรวจทุกเครื่องผ่าน API แทนตัวเอง — เจ้าของเคยบอก "เปิดเป็น api ให้คุณเข้าไป setup ทุกอย่างแทนผม" และ "เข้าทำได้ทุกระบบเลยนะ"

## 0. ปัญหาที่เจอจริง 2026-09-20 (ที่มาของภารกิจ)

- อัปเดต webmanager ต้อง**คนกดหน้าเครื่อง** (`git pull` + `update.cmd`) — วันเดียวกด .32 ไป 4 รอบ, .34 ยังไม่ได้อัปเดตเพราะรอจังหวะคน · `.168` ค้างเวอร์ชัน 7 ส.ค. เพราะไม่มีคนเข้าเครื่อง
- อ่านไฟล์บน server (nginx conf, log) ต้องสร้าง FTP account ชั่วคราวทุกครั้ง
- AI ขอคุม AnyDesk แทนเจ้าของไม่ได้ (เจ้าของอยู่ข้างนอก กล่องอนุญาตอยู่ที่ Mac) และ pty/console ระยะไกลเคยถูก classifier บล็อก → ต้องเป็น **API ที่ออกแบบให้ AI ใช้** ไม่ใช่ shell ดิบ

## 1. ของที่มีอยู่แล้ว (ยืนยันจากโค้ด 2026-09-20)

| ชิ้น | ที่อยู่ | สถานะ |
|---|---|---|
| `update.cmd` → `update.ps1`: `git pull` (ในโฟลเดอร์ checkout) → `Stop-Service wm-manager` → `robocopy /MIR backend → app/backend` (เก็บ node_modules, .env) + `ui/build/web` → `npm install --omit=dev` → re-stamp `WM_VERSION` ใน .env → `Start-Service` → poll `/api/health` | `update.ps1` | ใช้จริงทุกวัน · **ไม่มี rollback** ถ้าเวอร์ชันใหม่ไม่ขึ้น · ต้องมีคนอยู่หน้าเครื่อง |
| `/api/health` → `{ok, version:"<hash> (<date>)"}` version มาจาก `WM_VERSION` ใน .env (`backend/src/version.js`) | | เปิดสาธารณะ ไม่ต้อง login |
| **Fleet** (แม่-ลูก): `PUT /api/fleet {role:'hub'}`, `POST /api/fleet/token`, `POST /api/fleet/remotes`, `POST /api/fleet/join {hubUrl,…}` ที่เครื่องลูก, `GET /api/fleet/overview`, REST proxy ทะลุทุก path `/api/fleet/remotes/:id/proxy/*`, `/fleet/<id>/pty` | `backend/src/routes/fleet.routes.js`, `fleetproxy.js` | โค้ดครบ **ยังไม่ผูกเครื่องไหน** · ดาบสองคม: fleet token (`wmt_…`) ผ่าน `auth.js` = **admin เต็มบนเครื่องลูก** — ฮับ task **#439** รอเจ้าของตัดสิน "ผูกมั้ย" |
| `pty` (คอนโซลผ่าน websocket) | `backend/src/pty.js` | มีอยู่ แต่ AI ใช้แล้วถูกบล็อก — ไม่ใช่ทางสำหรับ AI |
| File Share (อ่านโฟลเดอร์ผ่าน token, read-only) | `shares.js`, `routes/shares.routes.js` (`GET /api/shares`, `/:id/file`) | ใช้ได้ · ยังไม่มี share ไหนตั้งบน .32/.34 |
| FTP server + browse API | `ftp.js`, `routes/ftp.routes.js` (`POST /api/ftp/users` root_path absolute) | ใช้จริงบน .34 (user `autopackliquid`) · ใช้เป็นทางชั่วคราวอ่าน log/conf |
| audit ทุก action admin | `audit.js` | มี |
| test harness | `backend/test/run.js` — แต่ละ `*.test.js` มี `WEBMANAGER_ROOT` ของตัวเอง · nginx จริง | 7 ไฟล์ ผ่านครบ (HEAD ≥ `ea4508d`) |
| ตรวจ before/after อัปเดตจากเครื่อง dev | `scripts/https-pilot.py sites-smoke save|check` (ทุก site port ตอบเหมือนก่อน) + `health` (version ตรง origin/main, gateway TCP-connect ทุกเส้น, FTP) | ใช้จริงกับ .32 |

**เครื่อง (2026-09-20)**

| เครื่อง | version | สิ่งที่รันในโปรเซส wm-manager (ดับตอน restart) | หมายเหตุ |
|---|---|---|---|
| `.32` 172.23.10.32:8088 | `0c03e0b` | gateway 17 เส้น (PLC/ssh/camera/Node-RED), FTP ปิด | เครื่องซ้อม · TPK-AUTH stage 2 รันอยู่ (:19443) |
| `.34` 172.23.10.34:8088 | `f4ee697` (7 ก.ย.) | gateway 1, **FTP :21 มีคนใช้ (autopackliquid)**, MQ, camera bridge/sync (กล้อง 172.26.20.72) | production หลัก 19 ไซต์ · nginx service แยก ไม่ดับ |
| `.40` 172.23.10.40:8088 | `f4ee697` | ไม่ทราบ | ไม่แตะ |
| `.168` 172.23.10.168:8088 | `43d6b91` (7 ส.ค.) | ไม่ทราบ | ไม่มี monitors/camera API · **ต้องมีคนอัปเดตหน้าเครื่องครั้งสุดท้าย 1 ครั้ง** ให้ได้โค้ด self-update ก่อน |

Windows: `wm-manager` เป็น NSSM/Windows service · nginx เป็น service แยก · โฟลเดอร์ติดตั้ง `C:\webmanager\` (`app\backend`, `app\ui\build\web`, `nginx\`, `certs\`, `sites\<name>\`) · git checkout อยู่คนละโฟลเดอร์กับที่รัน (update.ps1 robocopy ข้ามมา)

## 2. สิ่งที่ต้องสร้าง (เรียงตามคุ้ม — ข้อ 1 ปลดล็อกทุกข้อที่เหลือ)

### 2.1 self-update ผ่าน API (สำคัญสุด)
`POST /api/system/update {ref?}` (admin) → เครื่องดึงโค้ดใหม่และสลับตัวเองโดย**ไม่มีคนหน้าเครื่อง** และ**กู้เองได้**เมื่อพัง
- โจทย์ยาก: โปรเซสที่รับคำสั่งคือตัวที่ต้องถูกแทน → ต้องมี **ตัวช่วยนอกโปรเซส** (PowerShell/cmd ที่ spawn แบบ detached, หรือ Windows Scheduled Task แบบ run-once) ทำงานหลัง wm-manager หยุด: `git pull` ตาม ref → สำรอง `app\backend` + `app\ui` ปัจจุบันเป็น `releases/<hash>` → robocopy ของใหม่ → `npm install --omit=dev` (ถ้า `package-lock.json` เปลี่ยน) → re-stamp version → `Start-Service` → **health gate**: poll `/api/health` ต้องได้ 200 + version ใหม่ภายใน N วิ **มิฉะนั้น rollback** (สลับ releases เดิมกลับ + start) แล้วเขียนผลลง `update-result.json` ให้ API `GET /api/system/update/status` อ่านได้ทั้งสำเร็จ/ล้ม
- ต้องรอด: git pull ล้ม (token หมด — เคยเกิด) · npm ล้ม · ไฟล์ล็อกโดย service · ไฟดับกลางคัน (เริ่มใหม่แล้วต้องรู้สถานะ) · เรียกซ้ำระหว่างทำ (lock)
- ห้ามทำ: ลบ `.env`/`certs/`/`sites/`/DB · อัปเดตโดยไม่มี health gate
- ทดสอบ: บน Mac dev ทำ dry-run ของสคริปต์ (path จำลอง) + test ของ API (lock/status) · ของจริงครั้งแรกบน **.32** โดยมีเจ้าของพร้อมกด `update.cmd` มือถ้าพัง
- หลังจากนี้การอัปเดตทุกเครื่อง = mainservice เรียก API แล้ว `sites-smoke check` เอง

### 2.2 Fleet — จุดเดียวคุมทุกเครื่อง (รอเจ้าของตัดสิน #439)
- ผูก .34 เป็น hub, .32/.40/.168 join → mainservice คุยกับ .34 ที่เดียว ผ่าน `/api/fleet/remotes/:id/proxy/*` (รวม self-update ข้อ 2.1 ของเครื่องลูก)
- ก่อนเปิดต้องปิดดาบสองคม: fleet token ควรมี **scope** (เช่น อนุญาตเฉพาะ path ที่กำหนด) + audit ว่าคำสั่งไหนมาจาก hub · ระบุ IP hub ที่รับได้ · หมุน token ได้
- ถ้าเจ้าของไม่ผูก: mainservice คุยกับแต่ละเครื่องตรง (ทำได้อยู่แล้ว แค่ต้องมี creds ต่อเครื่อง)

### 2.3 ช่องอ่าน/ตรวจสำหรับ AI (แทน FTP ชั่วคราว) — อ่านอย่างเดียว มี audit
- `GET /api/system/files?path=…` จำกัดใน allowlist โฟลเดอร์ (`nginx\conf.d`, `nginx\logs`, `logs\`, `sites\<name>\current` metadata) อ่านไฟล์/ลิสต์/tail · **ไม่มี write, ไม่มี exec**
- `GET /api/system/nginx/check` → รัน `nginx -t` คืนผล · `GET /api/system/services` → สถานะ wm-manager/nginx/pm2 apps
- diff conf ก่อน/หลัง reload ที่ `HTTPS-PLAN.md` เรียกร้อง ใช้ช่องนี้แทน FTP

### 2.4 คำสั่งที่มีขอบเขต (ไม่ใช่ shell ดิบ) — ทำเมื่อ 2.1-2.3 พอแล้วเท่านั้น
- ชุดคำสั่งที่ประกาศไว้ล่วงหน้า (restart service X, reload nginx, pm2 restart <site>, firewall open/close <port>) เรียกด้วยชื่อ ไม่รับสตริงคำสั่ง · ทุกอันมีอยู่แล้วเป็นปุ่มใน panel — แค่จัดให้เรียกได้จาก API ชุดเดียว + audit
- **ไม่ทำ** arbitrary exec/pty สำหรับ AI

### 2.5 .168
- ครั้งสุดท้ายที่ต้องมีคน: อัปเดต .168 ให้ได้ 2.1 (คนเดินไป/RDP) · ก่อนหน้านั้นสำรวจว่ามีอะไรรันในโปรเซส (gateway/FTP/MQ) และใครใช้ · หลังจากนั้นเข้าระบบเดียวกับเครื่องอื่น

## 3. เกณฑ์ผ่านของภารกิจ

1. mainservice สั่ง `POST /api/system/update` ที่ .32 จาก Mac → เครื่องขึ้นเวอร์ชันใหม่เอง → `sites-smoke check` ผ่าน — **โดยไม่มีใครแตะ .32** · และทดสอบเคสพัง (ref ที่ start ไม่ได้) ต้อง rollback กลับเวอร์ชันเดิมเองภายใน 2 นาที
2. อ่าน `nginx\conf.d\ports\*.conf` และ tail log ของ .34 ผ่าน API โดยไม่สร้าง FTP
3. (ถ้าเจ้าของผูก Fleet) สั่ง 1-2 ผ่าน .34 ไปยัง .32 ได้
4. ทุกอย่างมี test ใน harness + audit row + บันทึกใน `README.md`/`PLAN.md` ของ WEBMANAGER · ฮับ task ปิดได้

## 4. กฎ

- ตอบภาษาไทย terse (`⚡ terse`) · ไม่เดาการตัดสินใจธุรกิจ — Fleet ผูกมั้ย, ใครไป .168, ลำดับเครื่อง = ถามเจ้าของ
- **.34 = production**: ทุกการ restart/อัปเดตขอจังหวะก่อน · .32 = เครื่องซ้อม ทำได้เมื่อบอกแล้ว · ทดสอบของใหม่บน .32 ก่อนเสมอ
- ห้ามพิมพ์ `HUB_API_TOKEN`, รหัส panel (admin .32/.34 ที่เจ้าของให้ในแชท ใช้ทาง env), fleet token · `.env`/`.claude/` ห้าม commit
- push ของ WEBMANAGER ทำได้ (เจ้าของอนุญาตแล้ว) แต่ **ต้อง test suite ผ่านครบก่อน** — ตรวจด้วย grep "ผ่านครบ" อย่าใช้ `tail` กลบ exit code (เคยพลาด)
- AGENTHUB: `~/.claude/agenthub.env` (`HUB_URL`, `HUB_API_TOKEN`) header `x-api-token` · `GET /api/tasks` แล้ว `PATCH /api/tasks/:id {detail}` (GET รายตัว 404) · ปิด task `closed_by:"session_manager"` · task ที่เกี่ยว: **#439** (.168/Fleet)
- ทุกฟีเจอร์ใหม่ = ทางเข้าใหม่สู่ server → คิดเรื่อง auth/scope/audit ก่อนความสะดวก · `security-guidance` hook จะรีวิวโค้ดที่เขียน ตอบ finding ให้ครบ

## โจทย์

เริ่มที่ 2.1 self-update: ออกแบบตัวช่วยนอกโปรเซส + health gate + rollback → เขียน + test → push → ให้เจ้าของอัปเดต .32 ด้วยมือ**ครั้งสุดท้าย** → พิสูจน์เกณฑ์ข้อ 3.1 บน .32 ทั้งเคสสำเร็จและเคส rollback → แล้วค่อย 2.3 → เสนอ 2.2 ให้เจ้าของตัดสิน
