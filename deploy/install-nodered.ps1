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
# node npm-cli.js directly — the npm.ps1 shim mangles args on some hosts
$NodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) { $NodeExe = "$env:ProgramFiles\nodejs\node.exe" }
# pinned to major 4 — Node-RED 5.x breaks older contrib nodes (e.g. mcprotocol-ind)
& $NodeExe (Join-Path (Split-Path $NodeExe) "node_modules\npm\bin\npm-cli.js") install node-red@4
Pop-Location
Write-Host "[nodered] done. red.js at $dir\node_modules\node-red\red.js" -ForegroundColor Green
