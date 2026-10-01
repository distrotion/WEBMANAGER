# WEBMANAGER — offline install package (Windows, no internet)

Built by `deploy/pack-offline.sh` on a machine that has internet. The zip carries
everything the installer would otherwise download:

| inside the zip | replaces |
|---|---|
| `WEBMANAGER\` | the git checkout (backend, built UI, scripts) |
| `WEBMANAGER\VERSION` | `git rev-parse` — the panel shows this as its version |
| `WEBMANAGER\backend\node_modules\` | `npm install` — prebuilt for **win32-x64 / Node 22** |
| `WEBMANAGER\offline\nginx-<v>.zip` | the nginx download |
| `WEBMANAGER\offline\node-v22.x-x64.msi` | the Node.js download (used only if Node is missing) |

`setup.ps1`, `deploy\install.ps1` and `update.ps1` detect this layout by themselves
(`VERSION` + bundled `node_modules` + `offline\`). Git is **not** required.

## First install

1. Copy the zip to the server (USB / share) and unzip it, e.g. `C:\Users\<you>\Desktop\webmanager-offline-<hash>\`
2. Double-click `WEBMANAGER\setup.cmd` → UAC Yes
   - installs Node 22 from the bundled msi if the machine has none
   - extracts nginx from the bundled zip, copies the bundled `node_modules`, registers the
     `wm-manager` + `nginx` services (auto-start), opens the firewall for the panel port
3. Open `http://localhost:8088` (admin / `admin1234` — change it in the panel on first login)

Default root is `C:\webmanager`. Other root/port/password: run from an elevated PowerShell
`.\setup.ps1 -Root D:\webmanager -Port 8088 -AdminPass '<pass>'`.

## Update an existing offline install

1. Unzip the **new** package next to (or over) the old one
2. Double-click `WEBMANAGER\update.cmd` → stops `wm-manager`, copies code + bundled
   `node_modules`, re-stamps the version from `VERSION`, starts the service, shows `/api/health`
   - hosted sites keep serving: nginx is a separate service and is not restarted
   - gateway / FTP / MQ / camera-sync run inside `wm-manager` and are down for ~20 s

Keep `.env`, `certs\`, `sites\`, `pm2\` and the SQLite DB under `C:\webmanager` — the update
never touches them. The API self-update (`POST /api/system/update`) needs Git + internet and
therefore does not apply to offline machines; use this zip flow instead.

## Requirements on the target

- Windows Server 2016/2019/2022 or Windows 10/11, x64, administrator rights
- Node 22 LTS (bundled msi installs it) — Node 23+ breaks the native modules
- nothing else: no Git, no npm registry, no nginx.org access

## Rebuilding the package

```bash
./deploy/pack-offline.sh                     # HEAD must be committed (package = one git hash)
NODE_VERSION=22.18.0 ./deploy/pack-offline.sh # bundle a different Node 22 msi
```

Output: `dist/webmanager-offline-<hash>.zip` (~130 MB). `dist/`, `offline/` and `VERSION`
are git-ignored. Downloads are cached in `dist/cache/`.
