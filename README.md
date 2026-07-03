# WEBMANAGER

A web control panel to deploy and manage many web apps behind **nginx** on
**Windows Server 2019** (also runs on macOS/Linux for development).

- **Git-based deploy** — pull a `*_deploy` repo (or point at a local folder), publish
  atomically, reload nginx. One-click **Pull & Deploy**, **Restart**, **Reload**.
- **Two-layer nginx** — each app on its own **direct port** (layer 1, toggle on/off) and
  behind a shared **front on 80/443 with TLS** (layer 2), by **subdomain** or **path**.
- **Runtimes** — static Flutter web, **Node-RED** (start/stop/restart), and Node backends.
- **SSL/TLS** — Let's Encrypt via win-acme, auto-renew.
- **Live logs** — every action streams its output to an in-browser console.
- **Requirements page** — checks the server has everything (auto-adapts Mac/Windows).

```
                 ┌─── layer 1: direct ports (internal) ───┐
 git *_deploy ──►  app1 (static)  :9500  [on/off]          │
 local folder ──►  app2 (static)  :7500  [on/off]          │
        run   ──►  Node-RED        :1880  [start/stop]      │
                 └───────────────────────┬──────────────────┘
                 ┌───────────────────────▼──────────────────┐
                 │ layer 2: nginx 80/443 + TLS              │
                 │  app1.domain → :9500   domain/app2 → :7500│
                 └──────────────────────────────────────────┘
```

Stack: **Node.js/Express + SQLite** backend, **Flutter web** UI, **nginx**, **NSSM**
(Windows services), **win-acme** (TLS).

---

## Install on Windows Server 2019

### 1. Prerequisites (on PATH)
- [Node.js LTS](https://nodejs.org)
- [Git](https://git-scm.com)

### 2. Get the tools into `D:\webmanager`
- [nssm.exe](https://nssm.cc/download) → `D:\webmanager\tools\nssm.exe`
- [nginx (Windows zip)](https://nginx.org/en/download.html) → extract so `D:\webmanager\nginx\nginx.exe` exists
- [win-acme](https://www.win-acme.com) → `D:\webmanager\tools\win-acme\`

> The installer creates the folders — you just drop these in. It warns about anything missing.

### 3. Build the UI (needs Flutter; can be a dev machine)
```bash
cd ui
flutter build web --release
```

### 4. Run the installer (elevated PowerShell)
```powershell
cd deploy
.\install.ps1 -Root D:\webmanager -AdminPass "<choose-a-password>"
```
It installs the backend, and registers **wm-manager** + **nginx** as NSSM services that
**auto-start on every boot/reboot**, **auto-restart on crash**, and start in the right
order (nginx depends on wm-manager). It also opens the firewall for 80/443.

Open **http://\<server\>:8088** and sign in (`admin` / your password).

### Start / stop / uninstall
```powershell
.\scripts\start.ps1        # or double-click scripts\start.cmd  (or: net start wm-manager)
.\scripts\stop.ps1         # or scripts\stop.cmd
.\deploy\uninstall.ps1 -Root D:\webmanager          # remove services (keep data)
```
Full details: [deploy/README-WINDOWS.md](deploy/README-WINDOWS.md).

---

## Run locally (macOS / Linux, for development)

```bash
# backend deps
cd backend && npm install && cd ..
# nginx (optional, for full flow):  brew install nginx     # mac
# build the UI once:
cd ui && flutter build web --release && cd ..

# start / stop (backend + nginx)
./scripts/start.sh          # → http://localhost:8088
./scripts/stop.sh
./scripts/status.sh
```
Override target/port: `WEBMANAGER_ROOT=~/wm PORT=9000 ./scripts/start.sh`.
The backend serves the built UI itself, so one process = whole panel.

---

## Using the panel
1. **New site** → pick runtime + source (Git repo **or** Local folder — use **Browse** to
   locate a folder on the server), set a direct port and front exposure (subdomain/path).
2. **Pull & Deploy** (static/node) or **Start** (Node-RED) — watch the live console.
3. **Open** the site via its direct port or the TLS front.
4. **Issue SSL** to get a Let's Encrypt cert; **Reload nginx**, **Restart**, etc. as needed.

The login and the create-site form defaults are remembered across refreshes.

---

## Project layout
```
backend/    Node/Express API — auth, git/local deploy, nginx config gen, NSSM, win-acme, WS logs
ui/         Flutter web control panel
deploy/     install.ps1, uninstall.ps1, install-nodered.ps1, README-WINDOWS.md
scripts/    start/stop/status for macOS/Linux + Windows
PLAN.md     full design & decisions
```

See [PLAN.md](PLAN.md) for the complete architecture and rationale.
