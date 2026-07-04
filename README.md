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
- [Node.js **22 LTS**](https://nodejs.org)  *(Node 23+ can break native modules)*
- [Git](https://git-scm.com)

That's it — **nssm is bundled** in the repo and **nginx is auto-downloaded** by the installer.
(The UI is already built and committed, so Flutter is not needed on the server.)

### 2. One-click setup
```powershell
git clone https://github.com/distrotion/WEBMANAGER C:\src\WEBMANAGER
```
Then **double-click `setup.cmd`** (or run `.\setup.cmd`). It elevates to admin, checks the
system (Node/Git/drive/nginx/nssm), **auto-installs Node 22 if missing**, downloads nginx,
drops in the bundled nssm, installs the backend, registers **wm-manager** + **nginx** as
auto-start services, opens the firewall, and finally tells you whether the panel is **READY**.

Prefer explicit args? `.\setup.cmd -Root C:\webmanager -AdminPass "yourpass"`
(or run the engine directly: `.\deploy\install.ps1 -Root C:\webmanager -AdminPass "yourpass"`).

When it prints **READY**, open **http://\<server\>:8088** and sign in (`admin` / your password).
It auto-starts on every reboot. Direct app ports are opened in the firewall automatically per site.

> Use a writable drive for `-Root` (`C:\webmanager` is safe). `D:` is often a read-only DVD drive.
> For SSL, drop [win-acme](https://www.win-acme.com) into `C:\webmanager\tools\win-acme\`.

### Start / stop / uninstall
```powershell
.\scripts\start.ps1        # or double-click scripts\start.cmd  (or: net start wm-manager)
.\scripts\stop.ps1         # or scripts\stop.cmd
.\deploy\uninstall.ps1 -Root C:\webmanager          # remove services (keep data)
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
