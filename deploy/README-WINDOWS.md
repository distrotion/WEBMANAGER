# WEBMANAGER — Windows Server 2019 setup

End-to-end install. Target layout lives under `D:\webmanager`.

## 1. Prerequisites (install on the server, on PATH)
- **Node.js LTS** — https://nodejs.org
- **Git** — https://git-scm.com

## 2. Download tools into place
- **nssm.exe** — https://nssm.cc/download → put at `D:\webmanager\tools\nssm.exe`
- **nginx** — https://nginx.org/en/download.html → extract so `D:\webmanager\nginx\nginx.exe` exists
- **win-acme** — https://www.win-acme.com → extract to `D:\webmanager\tools\win-acme\` (`wacs.exe`)

(The installer creates the folders; you just drop these in. It will warn about any missing.)

## 3. Build the UI (on a dev machine with Flutter, or the server if Flutter is installed)
```
cd ui
flutter build web --release
```

## 4. Run the installer (elevated PowerShell)
```powershell
cd deploy
.\install.ps1 -Root D:\webmanager -AdminPass "<choose-a-password>"
```
This copies backend + built UI into `D:\webmanager\app`, writes `.env` (with a random
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
.\scripts\start.ps1 -Root D:\webmanager      # or double-click scripts\start.cmd
.\scripts\stop.ps1  -Root D:\webmanager      # or scripts\stop.cmd
# or plain Windows service commands:
net start wm-manager ; net start nginx
net stop  nginx      ; net stop  wm-manager
```

### Uninstall
```powershell
.\deploy\uninstall.ps1 -Root D:\webmanager           # remove services + firewall rules (keeps data)
.\deploy\uninstall.ps1 -Root D:\webmanager -Purge    # also delete D:\webmanager
```

## 5. (Optional) Node-RED runtime
```powershell
.\install-nodered.ps1 -Root D:\webmanager
```
Then create a site with runtime **Node-RED** in the panel and press **Start**.

## 6. Firewall
- Allow **80** and **443** (public, for the front + ACME).
- Allow the **direct ports** you use (9500, 7500, …) only on the internal network.
- Restrict the **manager port (8088)** to trusted IPs / VPN.

## How it maps to the 2-layer design
- Layer 1 (direct ports): `D:\webmanager\nginx\conf.d\ports\*.conf` — one per static site.
- Layer 2 (front 80/443 + TLS): `D:\webmanager\nginx\conf.d\front\*.conf` — subdomain & path.
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
