# WEBMANAGER — Plan & Spec

Web UI control panel สำหรับ deploy หลายแอป (Flutter web static + Node-RED + node backend)
บน **Windows Server 2019** ด้วยสถาปัตยกรรม **nginx 2 ชั้น** (ทางเข้า 2 จุด), deploy แบบ **git-based**, จัดการ **SSL/โดเมน** อัตโนมัติ

---

## 1. การตัดสินใจหลัก (locked)

| หัวข้อ | เลือก |
|--------|-------|
| รูปแบบ | Web UI control panel เต็มรูปแบบ |
| Target server | Windows Server 2019 |
| Web server | nginx for Windows — **1 instance, 2 กลุ่ม config** |
| Deploy model | git-based (git pull → swap → reload) |
| แหล่งโค้ด static | repo `*_deploy` = Flutter web ที่ build แล้ว commit ลง git → **ไม่ต้อง build/ไม่ต้องลง Flutter SDK บน server** |
| Runtime ที่รองรับ | static (Flutter), Node-RED, node backend (เฟสขยาย) |
| Routing ชั้น 2 | รองรับทั้ง **subdomain** และ **path** (เลือกได้ต่อ site) |
| Console | ปุ่มสำเร็จรูป + stream log สด (ไม่มี free-form shell) |
| Process control | Start / Stop / **Restart** ต่อ process app (ผ่าน NSSM) |
| Manager UI | Flutter web |
| Manager backend | Node.js + Express |
| Metadata store | SQLite (better-sqlite3) |
| รัน service | NSSM (nginx + manager + Node-RED + node apps auto-start) |
| SSL | win-acme (wacs.exe) + Windows Task Scheduler ต่ออายุ |
| Auth | JWT + bcrypt, role-based |

## 2. สถาปัตยกรรม 2 ชั้น (ทางเข้า 2 จุด)

```
                      ┌─── ชั้น 1: เข้าตรงด้วย port (สไตล์ที่ทีมชิน) ───┐
  git *_deploy ─pull─► webapp1 (static)  → :9500  [เปิด/ปิด port]      │
  git *_deploy ─pull─► webapp2 (static)  → :7500  [เปิด/ปิด port]      │
              ─run──► Node-RED (process) → :1880  [start/stop/restart] │
                      └──────────────────────┬───────────────────────┘
                                             │  proxy_pass / root
                      ┌──────────────────────▼───────────────────────┐
                      │  ชั้น 2: nginx หน้า :80/:443 + SSL            │
                      │   subdomain: webapp1.domain → :9500           │
                      │   path:      domain/webapp2  → :7500          │
                      └──────────────────────────────────────────────┘
```

ทุกแอปเข้าได้ 2 ทาง: (1) ตรงทาง port ภายใน `http://server:9500` (2) ผ่าน SSL ชั้น 2
nginx ตัวเดียว listen ทั้ง port ตรง (ชั้น 1) และ 80/443 (ชั้น 2) — รันเป็น service เดียว

### กลุ่ม config (nginx เดียว)
```
nginx\conf\nginx.conf
  http {
    include conf.d\ports\*.conf;   # ชั้น 1: server block ต่อ port (toggle = สร้าง/ลบไฟล์)
    include conf.d\front\*.conf;   # ชั้น 2: 80/443 + SSL routing
  }
```
- **static** → ชั้น 1 = `server{ listen 9500; root ...current; try_files ... /index.html; }`
  ชั้น 2 (subdomain) = serve static ตรงจาก root / (path) = `location /webapp1/ { alias ...; }`
- **Node-RED / node** → ชั้น 1 = process ที่ port (NSSM); ชั้น 2 = `proxy_pass http://127.0.0.1:<port>` (+ websocket headers)

## 3. โครงสร้างโฟลเดอร์บนเซิร์ฟเวอร์

```
D:\webmanager\
├─ app\
│   ├─ backend\          # Node/Express
│   └─ ui\               # Flutter web (build → www\_manager)
├─ nginx\
│   ├─ nginx.exe
│   ├─ conf\nginx.conf   # include conf.d\ports + conf.d\front
│   └─ conf.d\ports\  conf.d\front\   # manager เขียน
├─ sites\<site>\
│   ├─ repo\             # git clone ของ *_deploy (static = ราก = servable)
│   ├─ releases\<ts>\    # snapshot ต่อ deploy (static)
│   └─ current ─────────► junction → release ล่าสุด
├─ services\<site>\      # Node-RED userDir / node app
├─ certs\
├─ data\webmanager.db
└─ logs\<site>.log       # stdout/stderr ของ process (NSSM redirect)
```

## 4. Data model

```
site {
  id, name,
  runtime: "static" | "nodered" | "node",
  repoUrl, branch, lastCommit,           // git (static/node)
  directPort, directPortEnabled,         // ชั้น 1
  exposure: {                            // ชั้น 2
    mode: "subdomain" | "path",
    subdomain?, path?,
    ssl: { enabled, certPath, expiry, autoRenew }
  },
  serviceName,                           // NSSM service (process types)
  status, processStatus,
  rootPath, currentRelease, createdAt, lastDeployAt
}
release { id, siteId, timestamp, commit, deployedBy, note }
user    { id, username, passwordHash, role:"admin"|"user" }
audit   { who, action, target, time }
```

## 5. Actions ต่อ runtime (ทุกปุ่ม stream log สด)

| runtime | ปุ่ม |
|---------|------|
| static  | Pull & Deploy · **เปิด/ปิด direct port** · ตั้ง/แก้ exposure (subdomain/path) · ออก SSL · Reload nginx · Rollback |
| nodered | **Start / Stop / Restart** · ดู log · ตั้ง exposure + SSL · เปิด/ปิด direct port |
| node    | Pull · **Start / Stop / Restart** · ดู log · exposure + SSL |

### Flow: Pull & Deploy (static)
1. `git -C sites\<site>\repo pull origin <branch>`
2. copy ราก repo → `releases\<ts>\` (static `_deploy` ไม่ต้อง build)
3. สลับ junction `current` → release ใหม่
4. `nginx -t` → `nginx -s reload` (ไม่ผ่าน → ยกเลิก)
5. บันทึก commit + audit

### Flow: Node-RED
- ติดตั้งเป็น service: `nssm install nodered-<id> node <node-red>\red.js -- -u services\<site> -p <port>`
- ถ้า exposure = path → ตั้ง `httpRoot` ใน settings.js ให้ตรง path
- ปุ่ม Restart → `nssm restart nodered-<id>`; log → tail `logs\<site>.log`

## 6. Flow: SSL/TLS + โดเมน (win-acme)

- subdomain → cert ต่อ subdomain (หรือ wildcard); path → ใช้ cert ของ domain หลัก
- ต้องเปิด port 80 + โดเมนชี้มาที่ server (HTTP-01)
- manager เรียก `wacs.exe` unattended → เขียน vhost :443 → reload
- Windows Task Scheduler ต่ออายุ; UI แสดง expiry + แจ้งเตือน

### TLS config (ตั้งให้ปลอดภัยตั้งแต่ต้น ใน template ชั้น 2)
- `ssl_protocols TLSv1.2 TLSv1.3;` (ปิด SSLv3/TLS1.0/1.1)
- `ssl_ciphers` ชุด modern + `ssl_prefer_server_ciphers off;`
- redirect 80 → 443 อัตโนมัติ (`return 301 https://...`)
- `Strict-Transport-Security` (HSTS) — เปิดได้ต่อ site (ระวัง internal ที่ไม่มีโดเมน)
- `ssl_session_cache` + OCSP stapling
- direct port (ชั้น 1) เป็น HTTP ภายใน; TLS ทำที่ชั้น 2 (TLS termination) — ถ้าต้อง TLS ถึงชั้น 1 ด้วยค่อยเพิ่มภายหลัง

## 7. git auth (private repo)

- HTTPS + Personal Access Token (Windows Credential Manager) — แนะนำ / หรือ SSH deploy key
- manager มีหน้าใส่/ทดสอบ credential

## 8. ความปลอดภัย

- Auth บังคับทุก endpoint/WebSocket (JWT + bcrypt)
- Role: admin จัดการทุกอย่าง / user pull+deploy+restart
- Audit log ทุก action
- Firewall: panel เปิดเฉพาะ IP/VPN ที่ไว้ใจ; direct port (ชั้น 1) จำกัดเป็น internal
- ไม่มี free-form shell — เฉพาะปุ่มที่กำหนด

## 9. ข้อควรระวัง Windows Server 2019

- junction (`mklink /J`) แทน symlink
- nginx + manager + process apps ลงเป็น service ผ่าน NSSM (auto-start หลัง reboot)
- `nginx -t` ก่อน reload เสมอ
- ไฟล์ conf UTF-8 (ไม่มี BOM); path ใช้ `\`
- Flutter subpath: path mode ต้อง build `_deploy` ด้วย `--base-href /webappN/`; subdomain ใช้ `/` เดิมได้
- Node-RED path mode ต้องตั้ง `httpRoot`
- เปิด firewall 80/443 + direct ports ที่ใช้

## 10. Roadmap

- **เฟส 1 (MVP):** backend + UI + SQLite + auth · CRUD site (static) · git clone/pull · gen ชั้น1 port block + toggle · gen ชั้น2 (subdomain+path) · nginx -t + reload · stream log · list+status
- **เฟส 2:** Node-RED runtime (NSSM install + start/stop/restart + log + proxy)
- **เฟส 3:** SSL ผ่าน win-acme + ต่ออายุ + expiry
- **เฟส 4:** release history + rollback 1 คลิก · audit log
- **เฟส 5 (ขยาย):** node backend runtime (รองรับ BACK-QC-* เดิม)
```
