# WEBMANAGER — Windows Server 2019 setup

End-to-end install. Target layout lives under `C:\webmanager`.

## 1. Prerequisites (on PATH)
- **Node.js 22 LTS** — https://nodejs.org  *(Node 23+ can break native modules)*
- **Git** — https://git-scm.com

Nothing else to download — **nssm is bundled** in the repo and **nginx is auto-downloaded**
by the installer. The UI is pre-built and committed, so Flutter is not needed on the server.
(For SSL, drop **win-acme** into `C:\webmanager\tools\win-acme\` yourself — https://www.win-acme.com)

## 2. Clone + run the installer (elevated PowerShell)
```powershell
git clone https://github.com/distrotion/WEBMANAGER C:\src\WEBMANAGER
cd C:\src\WEBMANAGER\deploy
.\install.ps1 -Root C:\webmanager -AdminPass "<choose-a-password>"
```
> **Pick a writable drive for `-Root`.** `C:\webmanager` is the safe default. Avoid `D:`
> unless you know it's a real data drive — on many servers `D:` is the DVD drive (read-only),
> which fails with *"Access to the path is denied"*. Check drives with
> `Get-PSDrive -PSProvider FileSystem`.

The installer checks Node/Git, drops in nssm, downloads nginx, copies backend + built UI
into `C:\webmanager\app`, writes `.env` (random JWT secret), `npm install`s the backend,
and registers **wm-manager** + **nginx** as NSSM services that:
- **auto-start on every boot / reboot**
- **auto-restart on crash**
- start in the right order (**nginx depends on wm-manager**, which generates `nginx.conf`)
This copies backend + built UI into `C:\webmanager\app`, writes `.env` (with a random
JWT secret), `npm install`s the backend, and registers **wm-manager** + **nginx** as
NSSM services that:
- **auto-start on every boot / reboot**
- **auto-restart on crash**
- start in the right order (**nginx depends on wm-manager**, which generates `nginx.conf`)

It also opens the firewall (80/443; panel port limited to LocalSubnet) and prints
service status. Re-running the installer is safe (idempotent).

Open the panel at `http://<server>:8088` (default admin / your password).

### Auto-start on reboot
Nothing extra to do — the services are registered `SERVICE_AUTO_START`, so closing/
restarting the server brings WEBMANAGER back up automatically. Verify with:
```powershell
Get-Service wm-manager, nginx | Format-Table Name, Status, StartType
```

### Start / stop manually
```powershell
.\scripts\start.ps1 -Root C:\webmanager      # or double-click scripts\start.cmd
.\scripts\stop.ps1  -Root C:\webmanager      # or scripts\stop.cmd
# or plain Windows service commands:
net start wm-manager ; net start nginx
net stop  nginx      ; net stop  wm-manager
```

### Uninstall
```powershell
.\deploy\uninstall.ps1 -Root C:\webmanager           # remove services + firewall rules (keeps data)
.\deploy\uninstall.ps1 -Root C:\webmanager -Purge    # also delete C:\webmanager
```

## 5. (Optional) Node-RED runtime
```powershell
.\install-nodered.ps1 -Root C:\webmanager
```
Then create a site with runtime **Node-RED** in the panel and press **Start**.

## 6. Firewall
- **80** and **443** are opened by the installer (front + ACME).
- **Direct ports** (9500, 7500, …) are opened/closed **automatically** by the manager
  when you enable/disable a site's port (inbound TCP rule `wm-port-<port>`).
- The **manager port (8088)** is limited to `LocalSubnet` by the installer — tighten the
  `WEBMANAGER panel` rule to trusted IPs / VPN as needed.

## How it maps to the 2-layer design
- Layer 1 (direct ports): `C:\webmanager\nginx\conf.d\ports\*.conf` — one per static site.
- Layer 2 (front 80/443 + TLS): `C:\webmanager\nginx\conf.d\front\*.conf` — subdomain & path.
- The manager writes these files and runs `nginx -t` then `nginx -s reload` on every change.

## Updating
Pull the WEBMANAGER repo, rebuild the UI, re-run `install.ps1` (it re-copies + restarts),
or just `nssm restart wm-manager` after copying new backend files.

## Services cheat-sheet
```
nssm status  wm-manager
nssm restart wm-manager
nssm restart nginx
```
