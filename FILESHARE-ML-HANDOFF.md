# File Share — คู่มือให้ ML ดึงรูป (handoff)

เอกสารนี้ให้ทีม ML เอาไปดึงรูปจาก WEBMANAGER File Share ไปเทรนได้ทันที
File Share = **อ่านอย่างเดียว (read-only)** — ดึงไฟล์ออกได้อย่างเดียว เขียน/ลบไม่ได้

---

## 1. ของที่ต้องรู้ก่อน (admin เป็นคนบอกให้ 3 ค่านี้)

| ค่า | เอามาจากไหน | ตัวอย่าง |
|-----|-------------|---------|
| `BASE` | address ของ server ที่เก็บรูป | `http://172.23.10.40:8088` |
| `SHARE_ID` | เลข id ของ share (โชว์ในหน้า File Share) | `1` |
| `TOKEN` | กด "สร้าง token" ในหน้า File Share (`fst_...`) | `fst_ed7c5dda6f...` |

> **token ใส่ทำไม:** สคริปต์ ML รันจากเครื่องอื่น ไม่มี login → แนบ `x-api-token` แทนการ login
> **ยกเว้น:** ถ้าสคริปต์รันบน **เครื่องเดียวกับ server** (127.0.0.1) → ไม่ต้องใช้ token เลย

---

## 2. มี 2 endpoint เท่านั้น

### 2.1 list ไฟล์ทั้งหมด (recursive)
```
GET  {BASE}/api/shares/{SHARE_ID}/list?recursive=1
Header:  x-api-token: {TOKEN}
```
ได้ JSON กลับมา — `entries` คือรายการไฟล์+โฟลเดอร์ทั้งหมด, `path` คือ path เทียบกับราก share:
```json
{
  "share": "QC images",
  "capped": false,
  "cap": 50000,
  "entries": [
    { "name": "2026-07",      "path": "2026-07",             "isDir": true,  "size": 0,  "mtime": 1784972510871 },
    { "name": "img001.jpg",   "path": "2026-07/img001.jpg",  "isDir": false, "size": 10, "mtime": 1784972510871 },
    { "name": "img002.jpg",   "path": "2026-07/img002.jpg",  "isDir": false, "size": 10, "mtime": 1784972510871 }
  ]
}
```
- `mtime` = เวลาแก้ไขไฟล์ (epoch **มิลลิวินาที**)
- ถ้า `"capped": true` = ไฟล์เกิน 50,000 → root มันเยอะไป ให้ list ทีละโฟลเดอร์ย่อยแทน (ใส่ `?path=2026-07` แทน `?recursive=1`)

### 2.2 โหลดไฟล์ทีละไฟล์
```
GET  {BASE}/api/shares/{SHARE_ID}/file?path=2026-07/img001.jpg
Header:  x-api-token: {TOKEN}
```
ได้ตัวไฟล์ (binary) กลับมาตรงๆ

> `path` = ค่าจาก `entries[].path` ใช้ `/` (forward slash) เสมอ แม้ server เป็น Windows

---

## 3. ลองเร็วๆ ด้วย curl

```bash
BASE=http://172.23.10.40:8088
SHARE_ID=1
TOKEN=fst_xxxxxxxx

# ดูรายการไฟล์ทั้งหมด
curl -s -H "x-api-token: $TOKEN" "$BASE/api/shares/$SHARE_ID/list?recursive=1"

# โหลด 1 รูป
curl -s -H "x-api-token: $TOKEN" \
  "$BASE/api/shares/$SHARE_ID/file?path=2026-07/img001.jpg" -o img001.jpg
```

---

## 4. สคริปต์ Python พร้อมรัน (แนะนำสำหรับ ML)

ดึงรูปทั้งหมดมาเก็บในเครื่อง คงโครงสร้างโฟลเดอร์เดิม + **ดึงเฉพาะไฟล์ใหม่/ที่เปลี่ยน** (รันซ้ำได้ ไม่โหลดซ้ำ)

```python
#!/usr/bin/env python3
"""Pull all images from a WEBMANAGER File Share into ./dataset (incremental)."""
import os
import urllib.parse
import requests

# ---- config (แก้ 3 ค่านี้ หรืออ่านจาก env) ----
BASE     = os.environ.get("WM_BASE", "http://172.23.10.40:8088")
SHARE_ID = os.environ.get("WM_SHARE_ID", "1")
TOKEN    = os.environ.get("WM_TOKEN", "fst_xxxxxxxx")
OUT_DIR  = os.environ.get("WM_OUT", "dataset")
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}   # ดึงเฉพาะรูป

HEADERS = {"x-api-token": TOKEN}
API = f"{BASE}/api/shares/{SHARE_ID}"


def list_files():
    r = requests.get(f"{API}/list", params={"recursive": "1"}, headers=HEADERS, timeout=60)
    r.raise_for_status()
    data = r.json()
    if data.get("capped"):
        print(f"[warn] list capped at {data.get('cap')} entries — บาง folder อาจไม่ครบ, "
              f"ควร list ทีละ subfolder ด้วย ?path=<folder>")
    return [e for e in data["entries"] if not e["isDir"]]


def download(rel_path, size):
    local = os.path.join(OUT_DIR, rel_path)
    # ข้ามถ้ามีอยู่แล้วและขนาดเท่ากัน (incremental)
    if os.path.exists(local) and os.path.getsize(local) == size:
        return False
    os.makedirs(os.path.dirname(local), exist_ok=True)
    url = f"{API}/file?path={urllib.parse.quote(rel_path)}"
    with requests.get(url, headers=HEADERS, stream=True, timeout=120) as r:
        r.raise_for_status()
        tmp = local + ".part"
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 16):
                f.write(chunk)
        os.replace(tmp, local)   # atomic — ไฟล์ครึ่งๆ ไม่หลุดมาให้ ML อ่าน
    return True


def main():
    files = list_files()
    imgs = [f for f in files if os.path.splitext(f["name"])[1].lower() in IMAGE_EXT]
    print(f"พบรูป {len(imgs)} ไฟล์ (จากทั้งหมด {len(files)})")
    got = 0
    for i, f in enumerate(imgs, 1):
        if download(f["path"], f["size"]):
            got += 1
        if i % 200 == 0:
            print(f"  ...{i}/{len(imgs)}")
    print(f"เสร็จ: โหลดใหม่ {got} ไฟล์, ข้าม {len(imgs) - got} ที่มีอยู่แล้ว -> ./{OUT_DIR}")


if __name__ == "__main__":
    main()
```

รัน:
```bash
pip install requests
WM_BASE=http://172.23.10.40:8088 WM_SHARE_ID=1 WM_TOKEN=fst_xxxx python3 pull_images.py
```

---

## 5. เรื่องต้องระวัง

- **read-only** — endpoint นี้ทำได้แค่ list + download ไม่มีทางเขียน/ลบไฟล์บน server
- **path เทียบกับราก share** เสมอ และใช้ `/` — ห้ามใส่ `../` (ออกนอกโฟลเดอร์ = ถูกบล็อก 400)
- **token = อ่านไฟล์อย่างเดียว** ถ้าหลุดก็แค่โหลดรูปได้ deploy/ลบอะไรไม่ได้ — แต่ก็ **อย่า commit token ลง git** ใส่ผ่าน env เอา
- ถ้า list ขึ้น `"capped": true` แปลว่าไฟล์เกิน 50,000 ในคราวเดียว → ให้ไล่ list ทีละ subfolder (`?path=<folder>`) แทน `?recursive=1` ที่ราก
- อยากให้เพิ่ม **โหลดทั้ง share เป็น zip ไฟล์เดียว** บอกได้ (ตอนนี้ดึงทีละไฟล์)

---

## 6. ถาม admin ตรงไหน
- ไม่รู้ `SHARE_ID` / อยากได้ token → เปิด panel `{BASE}` → เมนู **Account → File Share (ให้ ML ดึงรูป)**
- โฟลเดอร์รูปยังไม่ถูกแชร์ → admin กด **"เพิ่ม share"** แล้วเลือกโฟลเดอร์ที่ระบบ QC เก็บรูป
