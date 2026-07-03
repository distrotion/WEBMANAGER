<#
  WEBMANAGER installer for Windows Server 2019.
  Run from an elevated PowerShell:  .\install.ps1 -Root C:\webmanager

  Prerequisites (install first, on PATH):
    - Node.js LTS         https://nodejs.org
    - Git                 https://git-scm.com
  Place these tools under <Root>\tools (the script will tell you what's missing):
    - nssm.exe            https://nssm.cc/download
    - nginx (folder)      https://nginx.org/en/download.html  -> <Root>\nginx
    - win-acme (folder)   https://www.win-acme.com            -> <Root>\tools\win-acme

  This script:
    1. creates the <Root> folder structure
    2. copies the repo (backend + built UI) into <Root>\app
    3. installs backend npm deps + writes .env (random JWT secret)
    4. writes the win-acme renewal hook
    5. registers NSSM services (wm-manager + nginx) with:
         - AUTO-START on every boot / reboot
         - auto-restart on crash
         - boot order: nginx depends on wm-manager (which generates nginx.conf)
    6. opens Windows Firewall (80/443; panel port limited to LocalSubnet)
    7. prints service status

  Re-running is safe (idempotent): it updates files and re-applies service config.
  To remove everything: .\uninstall.ps1 -Root <Root>
#>
param(
  [string]$Root = "C:\webmanager",
  [string]$RepoDir = (Split-Path -Parent $PSScriptRoot),
  [int]$ManagerPort = 8088,
  [string]$AdminPass = "admin1234",
  [string]$JwtSecret = ""
)

$ErrorActionPreference = "Stop"
function Info($m){ Write-Host "[install] $m" -ForegroundColor Cyan }
function Warn($m){ Write-Host "[warn]    $m" -ForegroundColor Yellow }

if ([string]::IsNullOrWhiteSpace($JwtSecret)) {
  # Works on Windows PowerShell 5.1 (.NET Framework) and PowerShell 7 alike.
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object 'System.Byte[]' 32
  $rng.GetBytes($bytes)
  $JwtSecret = [Convert]::ToBase64String($bytes)
}

# 1. Folder structure -------------------------------------------------------
Info "creating folders under $Root"
$dirs = @(
  "$Root", "$Root\data", "$Root\sites", "$Root\services", "$Root\logs",
  "$Root\certs", "$Root\acme", "$Root\runtimes", "$Root\tools",
  "$Root\nginx\conf", "$Root\nginx\conf.d\ports", "$Root\nginx\conf.d\front",
  "$Root\app"
)
foreach ($d in $dirs) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# 2. Copy repo (backend + built UI) ----------------------------------------
Info "copying backend from $RepoDir\backend"
robocopy "$RepoDir\backend" "$Root\app\backend" /MIR /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
if (Test-Path "$RepoDir\ui\build\web\index.html") {
  Info "copying built UI"
  robocopy "$RepoDir\ui\build\web" "$Root\app\ui\build\web" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
} else {
  Warn "UI build not found at $RepoDir\ui\build\web - run 'flutter build web --release' in ui\ then re-copy."
}

# 3. backend .env + npm install --------------------------------------------
Info "writing backend\.env"
# Built as an array (not a here-string) so it parses under any line ending.
$envLines = @(
  "WEBMANAGER_ROOT=$Root",
  "PORT=$ManagerPort",
  "JWT_SECRET=$JwtSecret",
  "ADMIN_USER=admin",
  "ADMIN_PASS=$AdminPass",
  "MANAGER_UI=$Root\app\ui\build\web",
  "NGINX_EXE=$Root\nginx\nginx.exe",
  "NGINX_PREFIX=$Root\nginx",
  "NSSM_EXE=$Root\tools\nssm.exe",
  "WACS_EXE=$Root\tools\win-acme\wacs.exe"
)
Set-Content -Encoding ASCII -Path "$Root\app\backend\.env" -Value $envLines

Info "npm install (backend)"
Push-Location "$Root\app\backend"
& npm install --omit=dev
Pop-Location

# 4. nginx.conf -------------------------------------------------------------
# NOTE: the manager GENERATES nginx\conf\nginx.conf (absolute paths, both config
# layers) on every startup via bootstrapPrefix() - no need to copy a template.
# renewal hook used by win-acme
$reloadLines = @(
  '@echo off',
  "`"$Root\nginx\nginx.exe`" -p `"$Root\nginx`" -s reload"
)
Set-Content -Encoding ASCII -Path "$Root\tools\reload-nginx.cmd" -Value $reloadLines

# 5. NSSM services (auto-start on boot + auto-restart on crash) --------------
$nssm = "$Root\tools\nssm.exe"
if (-not (Test-Path $nssm)) {
  Warn "nssm.exe not found at $nssm - download it, then re-run this installer."
} else {
  Info "registering 'wm-manager' service (auto-start)"
  $node = (Get-Command node).Source
  & $nssm install wm-manager $node "$Root\app\backend\src\server.js" 2>$null
  & $nssm set wm-manager AppDirectory "$Root\app\backend"
  & $nssm set wm-manager AppStdout "$Root\logs\manager.log"
  & $nssm set wm-manager AppStderr "$Root\logs\manager.log"
  & $nssm set wm-manager AppRotateFiles 1
  & $nssm set wm-manager Start SERVICE_AUTO_START          # start on every boot
  & $nssm set wm-manager AppExit Default Restart           # auto-restart if it crashes
  & $nssm set wm-manager AppRestartDelay 5000
  & $nssm set wm-manager DisplayName "WEBMANAGER (control panel)"
  & $nssm set wm-manager Description "WEBMANAGER deploy control panel (Node backend)"

  Info "registering 'nginx' service (auto-start, depends on wm-manager)"
  if (Test-Path "$Root\nginx\nginx.exe") {
    & $nssm install nginx "$Root\nginx\nginx.exe" "-p" "$Root\nginx" "-c" "$Root\nginx\conf\nginx.conf" 2>$null
    & $nssm set nginx AppDirectory "$Root\nginx"
    & $nssm set nginx Start SERVICE_AUTO_START
    & $nssm set nginx AppExit Default Restart
    & $nssm set nginx AppRestartDelay 5000
    # boot order: manager must run first (it generates nginx.conf) before nginx starts
    & $nssm set nginx DependOnService wm-manager
    & $nssm set nginx DisplayName "WEBMANAGER nginx"
  } else { Warn "nginx.exe not found at $Root\nginx - extract nginx there first, then re-run." }

  Info "starting services now (manager first, then nginx)"
  & $nssm start wm-manager 2>$null
  Start-Sleep -Seconds 3
  & $nssm start nginx 2>$null
}

# 6. Firewall ---------------------------------------------------------------
Info "configuring Windows Firewall"
function Allow-Port([string]$name, [int]$port, [string]$remote = "Any") {
  netsh advfirewall firewall delete rule name="$name" | Out-Null
  netsh advfirewall firewall add rule name="$name" dir=in action=allow protocol=TCP localport=$port remoteip=$remote | Out-Null
}
Allow-Port "WEBMANAGER http"  80
Allow-Port "WEBMANAGER https" 443
# Manager panel: restrict to LAN by default - edit remoteip to your admin subnet/VPN.
Allow-Port "WEBMANAGER panel" $ManagerPort "LocalSubnet"
Warn "Panel port $ManagerPort is allowed from LocalSubnet only - adjust the 'WEBMANAGER panel' rule for your network."
Info "Direct app ports open/close automatically when you enable/disable a site's port (firewall rule wm-port-<port>)."

# 7. Verify -----------------------------------------------------------------
Write-Host ""
Info "service status:"
Get-Service wm-manager, nginx -ErrorAction SilentlyContinue | Format-Table Name, Status, StartType -AutoSize

Write-Host ""
Info "done. Manager:  http://localhost:$ManagerPort   (admin / $AdminPass)"
Info "Services are set to AUTO-START on boot and auto-restart on crash."
Info "Control anytime with:  scripts\start.ps1 / scripts\stop.ps1  (or 'net start/stop wm-manager')."
Info "JWT secret written to backend\.env - keep it safe."
