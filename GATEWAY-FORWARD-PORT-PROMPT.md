# PROMPT: สร้าง forward port ผ่าน KPE SCADA Manager (:5012)

> คัดลอกทั้งบล็อกไปวางเป็น context/system prompt แล้วเติมโจทย์ท้ายสุด

---

คุณกำลังสั่งงานฟีเจอร์ **Remote Gateway** ของ KPE SCADA Manager ผ่าน HTTP API มันคือ **raw-TCP port forwarder**: Manager (serverA) เปิดพอร์ต `listenPort` บนตัวเอง แล้ว forward ทราฟฟิก TCP ดิบสองทางไปที่ `host:port` ปลายทาง (serverB) — ทะลุได้ทั้ง HTTP / WebSocket / TLS โดยไม่ rewrite path (auth จัดการปลายทางเอง)

## Endpoint (Manager REST)
- Base: **`http://<manager-host>:5012/api`**
- Auth: request **จากเครื่องอื่น (ข้ามเครื่อง) ต้องมี header** `x-api-token: <token>` (หรือ `Authorization: Bearer <token>`) · token อยู่ในไฟล์ `manager/api-token.json` บนเครื่อง Manager
  - request จาก **loopback (127.0.0.1)** ไม่ต้องมี token
- ฟีเจอร์นี้ต้องมี **license** (ถ้า Manager ถูก gate → ตอบ `403 {ok:false,error:"license"}`)

| method | path | ทำอะไร |
|---|---|---|
| GET | `/api/remote-sites` | list ทุก site + สถานะ (`online`=ปลายทางต่อได้, `listening`=เปิดพอร์ตแล้ว) |
| POST | `/api/remote-sites` | สร้าง site (เปิด forward ทันที) |
| PUT | `/api/remote-sites/:id` | แก้ site (reconcile เปิด/ปิดพอร์ตให้อัตโนมัติ) |
| DELETE | `/api/remote-sites/:id` | ลบ site (ปิดพอร์ต) |

## Body ตอนสร้าง (POST) — field
| field | จำเป็น | ความหมาย |
|---|---|---|
| `host` | ✅ | IP/hostname ปลายทาง (serverB) |
| `port` | ✅ | พอร์ตปลายทาง (เช่น 3012 = frontend ของ serverB) · default 3012 |
| `listenPort` | ✅ | พอร์ตที่ Manager จะเปิดฟังบนตัวเอง (ห้ามชนพอร์ต KPE เอง — ดูข้อห้าม) |
| `name` | – | ชื่อ site (default = host) |
| `enabled` | – | `true`(default)/`false` เปิด-ปิด tunnel |
| `bindHost` | – | จำกัด interface ที่ฟัง (default `0.0.0.0` ทุก interface) |
| `maxConns` | – | จำกัดจำนวน connection พร้อมกัน (0/ไม่ใส่ = ไม่จำกัด) |
| `expiresAt` | – | epoch ms · หมดเวลาแล้ว tunnel ปิดเอง (on-demand/timed access) |

**id** สร้างอัตโนมัติจาก name (slug · unique) · เก็บ config ที่ `config/remote-sites.json` (persist ข้าม restart · gateway start ตอน Manager boot)

## ตัวอย่าง
```bash
TOKEN=$(cat /path/to/manager/api-token.json | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

# เปิด: Manager:8080 → serverB 172.23.10.50:3012 (เปิดหน้า HMI ของ serverB ผ่าน Manager)
curl -s -X POST http://<manager-host>:5012/api/remote-sites \
  -H "x-api-token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Line-B HMI","host":"172.23.10.50","port":3012,"listenPort":8080}'
# → { ok:true, site:{ id:"line-b-hmi", host:"172.23.10.50", port:3012, listenPort:8080, ... } }

# เปิดชั่วคราว 2 ชม. + จำกัด 5 connection
curl -s -X POST http://<manager-host>:5012/api/remote-sites \
  -H "x-api-token: $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"temp\",\"host\":\"172.23.10.50\",\"port\":22,\"listenPort\":9022,\"maxConns\":5,\"expiresAt\":$(( ($(date +%s)+7200) * 1000 ))}"

# list สถานะ
curl -s http://<manager-host>:5012/api/remote-sites -H "x-api-token: $TOKEN"

# ปิด (disable ไม่ลบ)
curl -s -X PUT http://<manager-host>:5012/api/remote-sites/line-b-hmi \
  -H "x-api-token: $TOKEN" -H 'Content-Type: application/json' -d '{"enabled":false}'

# ลบ
curl -s -X DELETE http://<manager-host>:5012/api/remote-sites/line-b-hmi -H "x-api-token: $TOKEN"
```
เสร็จแล้ว client เชื่อม `http://<manager-host>:8080` → ทะลุไปที่ serverB:3012

## ข้อควรระวัง
- **`listenPort` ห้ามชนพอร์ตของ KPE เอง** (3012 frontend · 4012 backend · 5012 Manager · 9012 deploy ฯลฯ) → ตอบ 400 `listenPort ... ชนกับพอร์ตของ KPE เอง` · เลือกพอร์ตว่าง (เช่น 8080, 9022, 16xxx)
- **`listenPort` ห้ามซ้ำ**ระหว่าง site → 400 `listenPort N ซ้ำกับ site อื่น`
- forward เป็น **TCP ดิบตาบอด** — ไม่มี auth/ACL ในตัว gateway เอง (ใครต่อพอร์ตนั้นได้ = ทะลุถึงปลายทาง) → คุมด้วย `bindHost` (จำกัด interface) / `maxConns` / `expiresAt` / firewall ข้างนอก
- ปลายทางต้องเปิดพอร์ตรอ (health check ทุก 5s บอก `online` แต่ **ไม่บล็อก** การเปิด tunnel)
- Manager ต้อง restart tunnel เอง (มัน start ตอน boot) — API แก้แล้ว reconcile ทันที ไม่ต้อง restart

## งานที่ต้องทำ
<<< ใส่โจทย์ตรงนี้ เช่น "เขียน CLI สร้าง tunnel ชั่วคราวให้ SSH เข้า serverB", "หน้าเว็บจัดการ site" ฯลฯ >>>
