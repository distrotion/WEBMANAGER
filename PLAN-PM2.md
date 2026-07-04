# WEBMANAGER — PM2 Integration Plan

เอา **PM2** มาเป็น process manager สำหรับแอป **node / Node-RED** แทนการเรียก NSSM ต่อแอปตรงๆ
โดยหน้าเว็บ (manager UI) ยังเป็นคนสั่งงานเหมือนเดิม แค่เปลี่ยน engine เบื้องหลัง

- **web deploy (static / Flutter)** → คงเดิม: git pull → swap release → `nginx -s reload`
- **node / Node-RED** → ใหม่: git pull → npm install → `pm2 restart` (concept เดียวกับ static: ดึงโค้ด แล้วรีสตาร์ท)
- **nginx + manager เอง** → ยังรันเป็น NSSM service เหมือนเดิม (ไม่แตะ)

---

## 1. ทำไม PM2

ได้ของแถมที่ NSSM per-app ไม่มี:
- monitor CPU / RAM ต่อ process (`pm2 jlist` เป็น JSON)
- auto-restart ตอน crash + นับ restart count
- ecosystem config (env / args / instances ต่อแอป) ในไฟล์เดียว
- log รวมศูนย์ (`pm2 logs`, ไฟล์ต่อ process)
- คำสั่งชุดเดียวคุมทุกแอป (`pm2 list`) → ดึงสถานะทุก site ทีเดียว

## 2. สถาปัตยกรรม process หลังเปลี่ยน

```
NSSM (คงเดิม)              PM2 (ใหม่)
├─ wm-nginx               ├─ wm-<siteA>   (node app)
└─ wm-manager             ├─ wm-<siteB>   (node app)
                          └─ wm-<siteC>   (Node-RED)
```

- PM2 daemon เองต้อง **auto-start หลัง reboot** → บน Windows ไม่ได้มาเอง
  → ลง PM2 daemon เป็น **NSSM service `wm-pm2`** ที่รัน `pm2 resurrect` ตอน boot
  (ทางเลือก: `pm2-installer`/`pm2-windows-startup` — แต่ผูกกับ NSSM ที่เรามีอยู่แล้วคุมง่ายกว่า)
- process id ใน PM2 = **ชื่อ site** (เช่น `wm-back-qc-1`) เพื่อสั่ง `pm2 restart wm-back-qc-1` ได้ตรงตัว

## 3. งานฝั่ง Backend

### 3.1 ตัวใหม่: `src/pm2.js` (แทน services.js สำหรับ node/nodered)
ฟังก์ชันหลัก เรียก pm2 ผ่าน `runner.run()`:
- `start(site)` → `pm2 start <entry> --name <svc> --cwd <dir> [-i <instances>] [env...]` แล้ว `pm2 save`
- `stop(site)` → `pm2 stop <svc>`
- `restart(site)` → `pm2 restart <svc> --update-env` (deploy เรียกตัวนี้)
- `remove(site)` → `pm2 delete <svc>` + `pm2 save`
- `status(site)` / `listAll()` → `pm2 jlist` แล้ว parse JSON: online/stopped, cpu, memory, restarts, uptime, pid
- Node-RED → `pm2 start red.js --name <svc> -- -u <userDir> -p <port> -s settings.js`
  (provisionNodeRed/settings.js เดิม reuse ได้)

### 3.2 แก้ `deploy.js` → `deployNode`
- เปลี่ยน `services.restart(...)` เป็น `pm2.restart(...)`
- flow: git pull → npm install --omit=dev → `pm2 restart` (first run = `pm2 start`)

### 3.3 แก้ `routes/process.routes.js`
- route start/stop/restart ชี้ไป pm2.js
- เพิ่ม `GET /:id/metrics` → คืน cpu/mem/restarts/uptime จาก `pm2 jlist`
- (ทางเลือก) `GET /process/overview` → `listAll()` โชว์ทุก process หน้าเดียว

### 3.4 `config.js`
- เพิ่ม `pm2: { exe, home }` — path pm2 (จาก global npm หรือ bundle ใน tools), `PM2_HOME` ชี้ใน ROOT
- คง `nssm` ไว้สำหรับ nginx/manager/pm2-daemon

### 3.5 db / migration
- เพิ่มคอลัมน์ site (nullable): `pm2_instances` (default 1), `entry_file`, `env_json` (env หลายตัว)
- `process_status` เดิม reuse ได้ (online/stopped/errored)

## 4. งานฝั่ง Installer (`deploy/install.ps1` + setup.ps1)

- ลง PM2 แบบ global: `npm i -g pm2` (ตอน setup node)
- ลง PM2 daemon เป็น service: `nssm install wm-pm2 <node> <pm2>\bin\pm2 resurrect` + set `PM2_HOME`
  (หรือ start pm2 แล้ว `nssm install` ตัว `pm2 resurrect`; ปรับตอนลงมือ)
- เปิด `PM2_HOME` = `C:\webmanager\pm2` ให้ทุก service เห็น env เดียวกัน
- uninstall.ps1 → `pm2 delete all` + `pm2 kill` + ลบ service `wm-pm2`

## 5. งานฝั่ง UI (Flutter — เฟสถัดไป หลัง backend เสร็จ)

- การ์ด process โชว์ status + CPU% + RAM + restart count (poll `/metrics`)
- ปุ่ม start/stop/restart เดิมใช้ได้ (endpoint เดิม)
- (ทางเลือก) หน้า overview รวมทุก process

## 6. ลำดับลงมือ

1. `pm2.js` + config + migration
2. แก้ deploy.js / process.routes.js ให้ node/nodered วิ่งผ่าน pm2
3. ทดสอบ local (mac/dev) ด้วย pm2 จริง — start/stop/restart/metrics
4. installer: ลง pm2 + service wm-pm2 + PM2_HOME
5. UI: metrics บนการ์ด
6. ทดสอบบน Windows Server จริง

## 7. จุดตัดสินใจ / ความเสี่ยง

- **Node-RED ไปอยู่ใต้ PM2 ด้วยไหม?** — แนะนำใช่ (เป็น node process เหมือนกัน, คุมที่เดียว). ถ้าอยากให้ Node-RED คง NSSM ไว้ บอกได้
- **PM2 auto-start บน Windows** — จุดเปราะสุด, ต้องเทสหลัง reboot จริงว่า `pm2 resurrect` คืน process ครบ
- **path / working dir บน Windows** — pm2 --cwd + backslash ต้องระวัง quoting
- **migration ของ site เดิม** — ถ้ามี node site ที่เคยลงผ่าน NSSM ต้อง `nssm remove` เก่าก่อนย้ายมา pm2 (เขียน one-time migrate ให้)
```
