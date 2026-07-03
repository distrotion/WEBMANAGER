# WEBMANAGER start/stop scripts

Control the manager server (backend + nginx) on either platform.

## macOS / Linux
```bash
./scripts/start.sh     # start backend + nginx
./scripts/stop.sh      # stop both
./scripts/status.sh    # show status
```
Override target/port: `WEBMANAGER_ROOT=/srv/wm PORT=9000 ./scripts/start.sh`
(default root `~/webmanager-dev`, port `8088`).

## Windows
Double-click **start.cmd** / **stop.cmd**, or from PowerShell:
```powershell
.\scripts\start.ps1 -Root C:\webmanager
.\scripts\stop.ps1  -Root C:\webmanager
```
- If installed as services via `deploy\install.ps1` → controls the **wm-manager** + **nginx** NSSM services (auto-start on boot).
- If not installed → runs node + nginx directly (dev mode).

## Notes
- The manager generates `nginx\conf\nginx.conf` on startup, so start order is **manager → nginx** (the scripts handle this).
- nginx is also controllable from the panel: **Requirements page → nginx control** (Test/Start/Reload/Stop).
