# WEBMANAGER

A web control panel to deploy and manage many web apps behind **nginx** on
**Windows Server 2019** (also runs on macOS/Linux for development).

- **Git-based deploy** — pull a `*_deploy` repo (or point at a local folder), publish
  atomically (junction swap), reload nginx. One-click **Pull & Deploy**, **Restart**, **Reload**.
- **Two-layer nginx** — each app on its own **direct port** (layer 1, toggle on/off, firewall
  managed automatically) and behind a shared **front on 80/443 with TLS** (layer 2), by
  **subdomain** or **path**.
- **Runtimes** — static Flutter web, **Node-RED** (auto-installs the shared runtime on
  first start; CORS + editor-login togglable), and Node backends managed by **PM2**
  (live CPU/RAM/status, PM2-list view, reboot-safe).
- **CI/CD auto-deploy** — watch a git branch and Pull & Deploy automatically on new commits.
- **Fleet (แม่/ลูก)** — one webmanager (hub) manages many others (agents): live fleet
  dashboard, and a server switcher that reroutes the whole panel (sites, deploy, logs,
  console) through the hub to any child. Children can self-register at the hub.
- **Remote Gateway** — raw-TCP port forwarders (tunnel HTTP/WS/TLS to any host:port).
- **Port tools** — inspect and kill whatever holds a port, from the panel.
- **SSL/TLS** — Let's Encrypt via win-acme, auto-renew.
- **Interactive console** — a real shell (xterm + node-pty) per site or server-wide, admin-only.
- **Multi-user** — admin-managed accounts and roles; login is remembered.
- **Live logs** — every action streams its output to an in-browser console.

```
                 +--- layer 1: direct ports (internal) ---+
 git *_deploy -->  app1 (static)  :9500  [on/off]          |
 local folder -->  app2 (static)  :7500  [on/off]          |
        run   -->  Node-RED        :1880  [start/stop]      |
                 +-----------------------+------------------+
                 +-----------------------v------------------+
                 | layer 2: nginx 80/443 + TLS             |
                 |  app1.domain -> :9500   domain/app2 ...  |
                 +------------------------------------------+
```

Stack: **Node.js/Express + SQLite** backend, **Flutter web** UI, **nginx**, **NSSM**
(Windows services), **win-acme** (TLS).

---

## Install on Windows Server 2019 (one click)

**Prerequisites:** [Git](https://git-scm.com) on PATH. (Node 22 LTS is installed automatically
if missing; nssm is bundled; nginx is auto-downloaded; the UI is pre-built — no Flutter needed.)

```powershell
git clone https://github.com/distrotion/WEBMANAGER C:\src\WEBMANAGER
```
Then **double-click `setup.cmd`** in `C:\src\WEBMANAGER`.

`setup.cmd` elevates to admin, runs a system check, installs everything, registers
**wm-manager** + **nginx** as auto-start services, opens the firewall, and reports readiness:

```
System check:
[ OK ] Node.js              v22.23.1
[ OK ] Git                  git version 2.x
[ OK ] Writable drive       C:\webmanager OK
[ OK ] nssm                 bundled in repo
[ OK ] nginx                will auto-download
...
Result:
[ OK ] wm-manager service   Running / Automatic
[ OK ] nginx service        Running / Automatic
[ OK ] Panel responds       http://localhost:8088

  READY.  Open  http://localhost:8088   (admin / admin1234)
```

Open **http://\<server\>:8088** and sign in. It auto-starts on every reboot.

**Options / notes**
- Custom root/password: `.\setup.cmd -Root C:\webmanager -AdminPass "yourpass"`
- Use a **writable drive** for `-Root` (`C:\webmanager` is safe; `D:` is often a read-only DVD).
- **SSL:** drop [win-acme](https://www.win-acme.com) into `C:\webmanager\tools\win-acme\`, then
  press **Issue SSL** on a site.
- **Node-RED:** run `.\deploy\install-nodered.ps1 -Root C:\webmanager` once.
- **Update:** `git pull` then `.\setup.cmd` (or `.\deploy\install.ps1 -Root C:\webmanager`).

### Start / stop / uninstall
```powershell
.\scripts\start.cmd            # or: net start wm-manager
.\scripts\stop.cmd             # or: net stop  wm-manager
.\uninstall.cmd                # double-click: remove services + firewall (keeps data)
.\uninstall.cmd -Purge         # also delete C:\webmanager
```
More detail: [deploy/README-WINDOWS.md](deploy/README-WINDOWS.md).

---

## Run locally (macOS / Linux, for development)

```bash
cd backend && npm install && cd ..
# nginx (optional, for the full flow):  brew install nginx      # mac
cd ui && flutter build web --release && cd ..                   # build the UI once

./scripts/start.sh     # -> http://localhost:8088   (backend + nginx)
./scripts/stop.sh
./scripts/status.sh
```
Override target/port: `WEBMANAGER_ROOT=~/wm PORT=9000 ./scripts/start.sh`.
The backend serves the built UI itself, so one process = the whole panel.

---

## Using the panel
1. **New site** — pick runtime + source (Git repo **or** Local folder, with a **Browse** picker),
   a direct port, front exposure (subdomain/path), and branch (for git).
2. **Pull & Deploy** (static/node) or **Start** (Node-RED) — watch the live console.
3. **Open** the site via its direct port or the TLS front (buttons on the site page).
4. **Edit** a site anytime (branch/repo/source/port/exposure), then Pull & Deploy to apply.
5. **Issue SSL**, **Reload nginx**, **Restart**, toggle the **direct port** (firewall auto).
6. **Console** (admin) — a real shell in the site's folder or server-wide.
7. **Account menu** (admin) — **Users**, **Fleet** (แม่/ลูก), **Remote Gateway**, change
   password, requirements page (with **Port tools**: inspect / kill a port).

Login and the create-site form defaults are remembered across refreshes.

---

## Remote Gateway (raw-TCP port forward)

**Account menu → Remote Gateway** (admin). Each gateway opens a **listen port** on this
server and pipes bytes two-way to a **destination `host:port`** — tunnelling HTTP,
WebSocket, and TLS transparently (no path rewrite; the target handles its own auth).

- Fields: `name`, `listen_port` (opened here), `dest_host` + `dest_port` (target),
  optional `bind_host` (limit interface), `max_conns`, and an auto-expiry (1/2/8/24 h).
- Changes reconcile **live** (no restart); expired tunnels retire automatically; the
  listen port's firewall rule opens/closes with the gateway.
- `listen_port` can't collide with the manager's own port or a site's direct port, and
  can't be reused by another gateway.
- Example: `Line-B HMI · :8080 → 172.23.10.50:3012` — browse `http://<server>:8080` to
  reach serverB's HMI through this manager.

## Fleet — one hub, many servers (แม่/ลูก)

**Account menu → Fleet** (admin). Set each server's role:

- **ลูก (agent)** — generate a revocable service token, or use **"สมัครเข้ากับเครื่องแม่"**
  to self-register: enter the hub URL + hub admin password once and the child registers
  itself (name/url/token) at the hub.
- **แม่ (hub)** — see every child's health/version/sites/PM2 in one dashboard. A server
  switcher (chips under the app bar) reroutes the **entire** panel — sites, Pull & Deploy,
  live logs, shell console, port tools, gateways — through the hub to the selected child.

---

## Project layout
```
setup.cmd / setup.ps1   one-click Windows setup (check + install + verify)
backend/    Node/Express API - auth, users, git/local deploy, nginx config gen,
            firewall, PM2/NSSM process control, win-acme, WebSocket logs + shell (pty),
            autodeploy (CI/CD), fleet (hub/agent + proxy), gateway (TCP forward), ports
ui/         Flutter web control panel
deploy/     install.ps1, uninstall.ps1, install-nodered.ps1, bundled tools\nssm.exe
scripts/    start/stop/status for macOS/Linux + Windows
PLAN.md     full design & decisions
```

See [PLAN.md](PLAN.md) for the complete architecture and rationale.
