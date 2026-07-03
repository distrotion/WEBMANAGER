<#
  Installs a shared Node-RED runtime under <Root>\runtimes\node-red.
  The manager points each Node-RED site's NSSM service at this red.js,
  with its own userDir + port. Run after install.ps1.
#>
param([string]$Root = "C:\webmanager")
$ErrorActionPreference = "Stop"
$dir = "$Root\runtimes\node-red"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Push-Location $dir
if (-not (Test-Path "$dir\package.json")) { '{ "name": "wm-nodered-runtime", "private": true }' | Set-Content "$dir\package.json" }
Write-Host "[nodered] installing node-red into $dir ..." -ForegroundColor Cyan
& npm install node-red
Pop-Location
Write-Host "[nodered] done. red.js at $dir\node_modules\node-red\red.js" -ForegroundColor Green
