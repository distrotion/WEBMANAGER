<#
  WEBMANAGER one-click service restart.
  Double-click restart.cmd. Restarts wm-manager (and nginx if installed),
  waits for the panel to answer, and shows the result. PM2 apps are NOT touched
  (they live under the PM2 daemon, independent of the manager service).
#>
param([int]$Port = 8088)
$ErrorActionPreference = "SilentlyContinue"

function Info($m) { Write-Host "[restart] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[ OK ] $m" -ForegroundColor Green }
function Bad($m)  { Write-Host "[ !! ] $m" -ForegroundColor Yellow }

# --- self-elevate to admin ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Requesting administrator rights..." -ForegroundColor Cyan
  Start-Process powershell "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Port $Port" -Verb RunAs
  exit
}

Info "restarting wm-manager..."
Stop-Service wm-manager -Force
Start-Sleep -Seconds 2
Start-Service wm-manager

if (Get-Service nginx -ErrorAction SilentlyContinue) {
  Info "restarting nginx..."
  Stop-Service nginx -Force
  Start-Sleep -Seconds 1
  Start-Service nginx
}

# wait up to 20s for the panel to answer
Info "waiting for the panel on port $Port..."
$up = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest "http://localhost:$Port/api/health" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $up = $true; break }
  } catch {}
}

Write-Host ""
Get-Service wm-manager, nginx -ErrorAction SilentlyContinue | Format-Table Name, Status, StartType -AutoSize
if ($up) {
  $body = ($r.Content | ConvertFrom-Json)
  Ok "panel is UP  ->  http://localhost:$Port   (version: $($body.version))"
} else {
  Bad "panel did not answer on port $Port. Recent log:"
  if (Test-Path "C:\webmanager\logs\manager.log") { Get-Content "C:\webmanager\logs\manager.log" -Tail 20 }
}
Write-Host ""
Read-Host "Press Enter to close"
