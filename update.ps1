<#
  WEBMANAGER quick update — swaps in new backend/UI code and restarts the service,
  WITHOUT the heavy first-install steps (nginx download, NSSM re-register, native-
  module wipe) that make repeated setup.cmd runs slow and crash-prone on Windows.

  Flow:  git pull  ->  stop wm-manager  ->  copy code (keep node_modules + .env)
         ->  npm install (only pulls new deps)  ->  restart  ->  show version.
  Run setup.cmd instead only for the very first install.
#>
param([string]$Root = "C:\webmanager", [int]$Port = 8088)
$ErrorActionPreference = "Stop"
function Info($m) { Write-Host "[update] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[ OK ] $m" -ForegroundColor Green }
function Bad($m)  { Write-Host "[ !! ] $m" -ForegroundColor Yellow }

# --- self-elevate ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Start-Process powershell "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Root `"$Root`" -Port $Port" -Verb RunAs
  exit
}
$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path "$Root\app\backend\src\server.js")) {
  Bad "not installed yet ($Root\app\backend missing) - run setup.cmd first (initial install)"
  Read-Host "Press Enter to exit"; exit 1
}

# 1. pull latest code (if this folder is a git checkout)
if (Test-Path "$RepoDir\.git") {
  Info "git pull"
  Push-Location $RepoDir
  & git pull
  Pop-Location
}

# 2. stop the manager so native modules (better-sqlite3 / node-pty) aren't locked
Info "stopping wm-manager"
Stop-Service wm-manager -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 3. copy backend code + built UI. Keep node_modules and the generated .env.
Info "copying backend + UI"
robocopy "$RepoDir\backend" "$Root\app\backend" /MIR /XD node_modules /XF .env /NFL /NDL /NJH /NJS /NP | Out-Null
if (Test-Path "$RepoDir\ui\build\web\index.html") {
  robocopy "$RepoDir\ui\build\web" "$Root\app\ui\build\web" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
} else {
  Bad "UI build not found at $RepoDir\ui\build\web - UI not updated (run 'flutter build web' if needed)"
}

# 4. install any NEW dependencies (fast no-op if nothing changed). node npm-cli.js
#    directly avoids the npm.ps1 shim that mangles args on some Windows hosts.
Info "npm install (deps)"
$NodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) { $NodeExe = "$env:ProgramFiles\nodejs\node.exe" }
Push-Location "$Root\app\backend"
& $NodeExe (Join-Path (Split-Path $NodeExe) "node_modules\npm\bin\npm-cli.js") install --omit=dev
if ($LASTEXITCODE -ne 0) { Pop-Location; Bad "npm install failed - see output above"; Read-Host "Press Enter"; exit 1 }
Pop-Location

# 5. re-stamp WM_VERSION in .env so the UI shows the new build
try {
  $v = & git -C $RepoDir rev-parse --short HEAD 2>$null
  if ($LASTEXITCODE -eq 0 -and $v) {
    $ver = "$($v.Trim()) ($(Get-Date -Format 'yyyy-MM-dd'))"
    $envFile = "$Root\app\backend\.env"
    if (Test-Path $envFile) {
      $keep = Get-Content $envFile | Where-Object { $_ -notmatch '^WM_VERSION=' }
      ($keep + "WM_VERSION=$ver") | Set-Content -Encoding ASCII $envFile
    }
  }
} catch {}

# 6. restart + verify
Info "starting wm-manager"
Start-Service wm-manager
$up = $false; $r = $null
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  try { $r = Invoke-WebRequest "http://localhost:$Port/api/health" -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { $up = $true; break } } catch {}
}
Write-Host ""
if ($up) {
  $b = $r.Content | ConvertFrom-Json
  Ok "updated  ->  http://localhost:$Port   (version: $($b.version))"
} else {
  Bad "panel did not answer on :$Port. Recent log:"
  if (Test-Path "$Root\logs\manager.log") { Get-Content "$Root\logs\manager.log" -Tail 20 }
}
Write-Host ""
Read-Host "Press Enter to close"
