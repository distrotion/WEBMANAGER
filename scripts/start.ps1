<#
  Start WEBMANAGER on Windows.
  - If installed as NSSM services (via install.ps1) -> starts wm-manager + nginx.
  - Otherwise (dev) -> launches node + nginx directly.
#>
param([string]$Root = "D:\webmanager", [int]$Port = 8088)
$ErrorActionPreference = "SilentlyContinue"

$svc = Get-Service wm-manager -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "Starting WEBMANAGER services..." -ForegroundColor Cyan
  Start-Service wm-manager
  Start-Sleep -Seconds 2               # let the manager generate nginx.conf first
  Start-Service nginx
  Get-Service wm-manager, nginx | Format-Table Name, Status -AutoSize
  Write-Host "-> http://localhost:$Port" -ForegroundColor Green
}
else {
  Write-Host "Services not installed - running in dev mode." -ForegroundColor Yellow
  $env:WEBMANAGER_ROOT = $Root
  $env:PORT = "$Port"
  $backend = "$Root\app\backend"
  if (-not (Test-Path "$backend\src\server.js")) { $backend = (Resolve-Path "$PSScriptRoot\..\backend").Path }
  Start-Process node -ArgumentList "src\server.js" -WorkingDirectory $backend
  Start-Sleep -Seconds 2
  $ngx = "$Root\nginx\nginx.exe"; $conf = "$Root\nginx\conf\nginx.conf"
  if ((Test-Path $ngx) -and (Test-Path $conf)) {
    & $ngx -p "$Root\nginx" -c $conf -s reload 2>$null
    if ($LASTEXITCODE -ne 0) { Start-Process $ngx -ArgumentList "-p `"$Root\nginx`" -c `"$conf`"" }
    Write-Host "* nginx started/reloaded"
  } else { Write-Host "* nginx not found at $ngx - skipped" }
  Write-Host "-> http://localhost:$Port  (manager running in a new window)" -ForegroundColor Green
}
