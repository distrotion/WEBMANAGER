# WEBMANAGER — Windows Server 2019 setup

End-to-end install. Target layout lives under `C:\webmanager`.

## 1. Prerequisites (install on the server, on PATH)
- **Node.js LTS** — https://nodejs.org
- **Git** — https://git-scm.com

## 2. Download tools into place
- **nssm.exe** — https://nssm.cc/download → put at `C:\webmanager\tools\nssm.exe`
- **nginx** — https://nginx.org/en/download.html → extract so `C:\webmanager\nginx\nginx.exe` exists
- **win-acme** — https://www.win-acme.com → extract to `C:\webmanager\tools\win-acme\` (`wacs.exe`)

(The installer creates the folders; you just drop these in. It will warn about any missing.)

## 3. Build the UI (on a dev machine with Flutter, or the server if Flutter is installed)
```
cd ui
flutter build web --release
```

## 4. Run the installer (elevated PowerShell)
```powershell
cd deploy
.\install.ps1 -Root C:\webmanager -AdminPass "<choose-a-password>"
```
> **Pick a writable drive for `-Root`.** `C:\webmanager` is the safe default. Avoid `D:`
> unless you know it's a real data drive — on many servers `D:` is the DVD drive (read-only),
> which fails with *"Access to the path is denied"*. Check drives with
> `Get-PSDrive -PSProvider FileSystem`.
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
