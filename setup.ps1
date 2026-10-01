<#
  WEBMANAGER one-shot setup for Windows.
  Double-click setup.cmd (or run this with PowerShell).
  It checks the system, installs everything (Node if missing, nginx, nssm, services),
  and tells you whether the panel is ready to run.
#>
param(
  [string]$Root = "C:\webmanager",
  [string]$AdminPass = "admin1234",
  [int]$Port = 8088,
  # Node 22 installer to use instead of downloading (offline package puts one in offline\)
  [string]$NodeMsi = ""
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# Offline package (deploy\pack-offline.sh): offline\node-v22*-x64.msi + offline\nginx-*.zip,
# VERSION file, prebuilt backend\node_modules. No Git, no internet needed.
$offlineDir = Join-Path $here "offline"
$offline = (Test-Path (Join-Path $here "VERSION")) -and (Test-Path "$here\backend\node_modules\better-sqlite3\build\Release\better_sqlite3.node")
if (-not $NodeMsi -and (Test-Path $offlineDir)) {
  $m = Get-ChildItem "$offlineDir\node-v22*-x64.msi" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($m) { $NodeMsi = $m.FullName }
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Line($ok, $label, $detail) {
  $mark = if ($ok) { "[ OK ]" } else { "[ !! ]" }
  $col = if ($ok) { "Green" } else { "Yellow" }
  Write-Host ("{0} {1,-20} {2}" -f $mark, $label, $detail) -ForegroundColor $col
}
function Fail($m) { Write-Host "[error] $m" -ForegroundColor Red; Read-Host "Press Enter to exit"; exit 1 }

# --- self-elevate to admin ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Requesting administrator rights..." -ForegroundColor Cyan
  $a = "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Root `"$Root`" -AdminPass `"$AdminPass`" -Port $Port"
  if ($NodeMsi) { $a += " -NodeMsi `"$NodeMsi`"" }
  Start-Process powershell $a -Verb RunAs
  exit
}

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  WEBMANAGER setup   root=$Root  port=$Port$(if ($offline) { '  (offline package)' })" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "System check:"

# Node
$node = Get-Command node -ErrorAction SilentlyContinue
$nodeMaj = 0
if ($node) { $v = (& node -v); if ($v -match '^v(\d+)') { $nodeMaj = [int]$Matches[1] } }
$nodeOk = ($nodeMaj -ge 18 -and $nodeMaj -le 22)
if ($node) { Line $nodeOk "Node.js" ($v + $(if ($nodeMaj -ge 23) { "  (23+ risky - 22 LTS recommended)" } elseif (-not $nodeOk) { "  (need 18-22)" } else { "" })) }
else { Line $false "Node.js" $(if ($NodeMsi) { "not found - will install from $(Split-Path -Leaf $NodeMsi)" } else { "not found - will auto-install v22 LTS" }) }

# Git
$git = Get-Command git -ErrorAction SilentlyContinue
Line ([bool]$git -or $offline) "Git" $(if ($git) { (& git --version) } elseif ($offline) { "not found - not needed for an offline package" } else { "not found - install git-scm.com" })

# Writable drive
$driveOk = $false
try { New-Item -ItemType Directory -Force $Root | Out-Null; $t = Join-Path $Root ".wtest"; Set-Content $t "x"; Remove-Item $t -Force; $driveOk = $true } catch {}
Line $driveOk "Writable drive" $(if ($driveOk) { "$Root OK" } else { "$Root NOT writable - use another drive" })

# nssm bundled
$nssmBundled = Test-Path (Join-Path $here "deploy\tools\nssm.exe")
Line $nssmBundled "nssm" $(if ($nssmBundled) { "bundled in repo" } else { "missing" })

# nginx
$nginxHave = Test-Path "$Root\nginx\nginx.exe"
$nginxZip = if (Test-Path $offlineDir) { Get-ChildItem "$offlineDir\nginx-*.zip" -ErrorAction SilentlyContinue | Select-Object -First 1 } else { $null }
Line $true "nginx" $(if ($nginxHave) { "present at $Root\nginx" } elseif ($nginxZip) { "from package $($nginxZip.Name)" } else { "will auto-download" })
if ($offline) { Line $true "node_modules" "bundled (win32-x64, Node 22) - npm not needed" }

Write-Host ""

# --- fix prerequisites ---
if (-not $git -and -not $offline) { Fail "Git is required. Install from https://git-scm.com then re-run." }
if (-not $driveOk) { Fail "$Root is not writable. Re-run setup with a writable drive (default C:\webmanager)." }

# install/upgrade to Node 22 LTS when missing or too old (< 18). Node 23+ can't be
# safely downgraded via MSI, so we only warn there.
if ((-not $node) -or ($nodeMaj -lt 18)) {
  $why = if (-not $node) { "not installed" } else { "v$nodeMaj too old" }
  Write-Host "Installing Node.js 22 LTS ($why) ..." -ForegroundColor Cyan
  try {
    if ($NodeMsi) {
      if (-not (Test-Path $NodeMsi)) { throw "Node installer not found: $NodeMsi" }
      $out = $NodeMsi
    } else {
      $idx = Invoke-WebRequest "https://nodejs.org/dist/latest-v22.x/" -UseBasicParsing
      $msi = ([regex]::Match($idx.Content, 'node-v22\.[0-9.]+-x64\.msi')).Value
      if (-not $msi) { throw "MSI name not found" }
      $out = "$env:TEMP\$msi"
      Invoke-WebRequest "https://nodejs.org/dist/latest-v22.x/$msi" -OutFile $out -UseBasicParsing
    }
    Start-Process msiexec.exe -ArgumentList "/i `"$out`" /qn /norestart" -Wait
    $env:Path = "$env:ProgramFiles\nodejs;$env:Path"
    $nv2 = (& "$env:ProgramFiles\nodejs\node.exe" -v)
    if (-not $nv2) { throw "node still not found after install" }
    Line $true "Node.js installed" $nv2
  } catch {
    Fail "Node auto-install failed ($($_.Exception.Message)). Install Node 22 LTS from https://nodejs.org and re-run."
  }
} elseif ($nodeMaj -ge 23) {
  Write-Host "[warn] Node $v may break native modules; Node 22 LTS recommended." -ForegroundColor Yellow
  Write-Host "       If install fails on better-sqlite3/node-pty, uninstall Node and install 22 LTS." -ForegroundColor Yellow
}

# --- install ---
Write-Host ""
Write-Host $(if ($offline) { "Installing WEBMANAGER from the offline package (no downloads)..." } else { "Installing WEBMANAGER (this downloads nginx + npm deps, ~1-2 min)..." }) -ForegroundColor Cyan
& (Join-Path $here "deploy\install.ps1") -Root $Root -AdminPass $AdminPass -ManagerPort $Port

# --- verify it actually runs ---
Write-Host ""
Write-Host "Verifying..." -ForegroundColor Cyan
Start-Sleep -Seconds 3
$mgr = Get-Service wm-manager -ErrorAction SilentlyContinue
$ngx = Get-Service nginx -ErrorAction SilentlyContinue
$health = $false
try { $health = ((Invoke-WebRequest "http://localhost:$Port/api/health" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) } catch {}

Write-Host ""
Write-Host "Result:"
Line ($mgr -and $mgr.Status -eq 'Running') "wm-manager service" $(if ($mgr) { "$($mgr.Status) / $($mgr.StartType)" } else { "not installed" })
Line ($ngx -and $ngx.Status -eq 'Running') "nginx service" $(if ($ngx) { "$($ngx.Status) / $($ngx.StartType)" } else { "not installed" })
Line $health "Panel responds" "http://localhost:$Port/api/health"

Write-Host ""
if ($health) {
  Write-Host "  READY.  Open  http://localhost:$Port   (admin / $AdminPass)" -ForegroundColor Green
  Write-Host "  It auto-starts on every reboot." -ForegroundColor Green
} else {
  Write-Host "  NOT READY. Check the log:  Get-Content $Root\logs\manager.log -Tail 30" -ForegroundColor Yellow
}
Write-Host ""
Read-Host "Press Enter to close"
