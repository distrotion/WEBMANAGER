<#
  Stop WEBMANAGER on Windows (services if installed, else dev processes).
#>
param([string]$Root = "C:\webmanager")
$ErrorActionPreference = "SilentlyContinue"

$svc = Get-Service wm-manager -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "Stopping WEBMANAGER services..." -ForegroundColor Cyan
  Stop-Service nginx
  Stop-Service wm-manager
  Get-Service wm-manager, nginx | Format-Table Name, Status -AutoSize
}
else {
  Write-Host "Stopping dev processes..." -ForegroundColor Yellow
  # stop the manager node process (matched by its server.js command line)
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*backend\src\server.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "* manager stopped (pid $($_.ProcessId))" }
  # stop nginx
  $ngx = "$Root\nginx\nginx.exe"; $conf = "$Root\nginx\conf\nginx.conf"
  if ((Test-Path $ngx) -and (Test-Path $conf)) { & $ngx -p "$Root\nginx" -c $conf -s stop 2>$null; Write-Host "* nginx stopped" }
}
