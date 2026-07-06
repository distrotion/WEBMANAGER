<#
  WEBMANAGER installer for Windows Server 2019.
  Run from an elevated PowerShell:  .\install.ps1 -Root C:\webmanager

  Prerequisites (install first, on PATH):
    - Node.js 22 LTS      https://nodejs.org
    - Git                 https://git-scm.com

  Everything else is automatic:
    - nssm.exe  -> bundled in the repo (deploy\tools\nssm.exe), copied into place
    - nginx     -> downloaded from nginx.org and extracted to <Root>\nginx
    - (optional) win-acme for SSL -> drop into <Root>\tools\win-acme yourself

  This script:
    0. checks Node + Git, provisions nssm (bundled) and nginx (download)
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
function Die($m){ Write-Host "[error]   $m" -ForegroundColor Red; exit 1 }

# --- prerequisite: Node.js (must be on PATH) --------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die "Node.js not found on PATH. Install Node 22 LTS from https://nodejs.org then re-open PowerShell and re-run."
}
$nodeVer = (& node -v)
Info "Node $nodeVer"
if ($nodeVer -match '^v(\d+)') {
  $maj = [int]$Matches[1]
  if ($maj -lt 18) { Die "Node $nodeVer is too old for native modules. Install Node 22 LTS (or run setup.cmd which does it for you)." }
  if ($maj -ge 23) { Warn "Node $nodeVer may break native modules (better-sqlite3/node-pty). Node 22 LTS recommended." }
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Die "Git not found on PATH. Install from https://git-scm.com then re-run."
}

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

# 1b. Provision tools (nssm bundled in repo, nginx auto-downloaded) ----------
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# nssm: use the copy bundled in the repo (deploy\tools\nssm.exe) if none present
if (-not (Test-Path "$Root\tools\nssm.exe")) {
  $bundledNssm = Join-Path $PSScriptRoot "tools\nssm.exe"
  if (Test-Path $bundledNssm) {
    Info "installing bundled nssm.exe"
    Copy-Item $bundledNssm "$Root\tools\nssm.exe" -Force
  } else {
    Warn "nssm.exe not bundled and not present - download from https://nssm.cc"
  }
}

# nginx: auto-download the Windows build if missing
if (-not (Test-Path "$Root\nginx\nginx.exe")) {
  $nginxVer = $env:NGINX_VERSION; if ([string]::IsNullOrWhiteSpace($nginxVer)) { $nginxVer = "1.28.0" }
  Info "downloading nginx $nginxVer ..."
  try {
    $tmp = "$env:TEMP\wm-nginx.zip"
    Invoke-WebRequest "https://nginx.org/download/nginx-$nginxVer.zip" -OutFile $tmp -UseBasicParsing
    $ex = "$env:TEMP\wm-nginx-x"
    if (Test-Path $ex) { Remove-Item $ex -Recurse -Force }
    Expand-Archive $tmp $ex -Force
    Copy-Item "$ex\nginx-$nginxVer\*" "$Root\nginx\" -Recurse -Force
    Info "nginx installed to $Root\nginx"
  } catch {
    Warn "nginx download failed ($($_.Exception.Message)). Put nginx.exe at $Root\nginx\ manually and re-run."
  }
}

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
  "WACS_EXE=$Root\tools\win-acme\wacs.exe",
  "PM2_HOME=$Root\pm2"
)
Set-Content -Encoding ASCII -Path "$Root\app\backend\.env" -Value $envLines

Info "npm install (backend)"
# drop stale native modules so npm re-fetches prebuilts matching the CURRENT node
# (e.g. after a node upgrade) instead of a broken/mismatched build.
foreach ($nm in @("better-sqlite3", "node-pty")) {
  $p = "$Root\app\backend\node_modules\$nm"
  if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
}
Push-Location "$Root\app\backend"
& npm install --omit=dev
if ($LASTEXITCODE -ne 0) {
  Pop-Location
  Die "npm install failed. Usually means Node is not 22 LTS (native prebuild missing). Install Node 22 LTS and re-run."
}
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
  # free port 8088 from any stray manual 'node src\server.js' so the service can bind
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*backend\src\server.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  # restart = start if stopped, or reload new files if already running
  & $nssm restart wm-manager 2>$null
  Start-Sleep -Seconds 3
  & $nssm restart nginx 2>$null
  Start-Sleep -Seconds 2

  $m = Get-Service wm-manager -ErrorAction SilentlyContinue
  if ($m -and $m.Status -ne 'Running') {
    Warn "wm-manager did not reach Running. Recent log:"
    if (Test-Path "$Root\logs\manager.log") { Get-Content "$Root\logs\manager.log" -Tail 15 }
  }
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
