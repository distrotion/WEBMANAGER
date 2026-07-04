<#
  Remove WEBMANAGER from Windows: services + firewall rules (and optionally data).
  Double-click uninstall.cmd, or run:
    .\uninstall.ps1 -Root C:\webmanager            (keep data)
    .\uninstall.ps1 -Root C:\webmanager -Purge     (also delete C:\webmanager)
    add -Yes to skip the confirmation prompt.
#>
param([string]$Root = "C:\webmanager", [switch]$Purge, [switch]$Yes)
$ErrorActionPreference = "SilentlyContinue"
function Info($m) { Write-Host "[uninstall] $m" -ForegroundColor Cyan }

# --- self-elevate ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $a = "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Root `"$Root`""
  if ($Purge) { $a += " -Purge" }
  if ($Yes) { $a += " -Yes" }
  Start-Process powershell $a -Verb RunAs
  exit
}

Write-Host ""
Write-Host "This will remove the WEBMANAGER services and firewall rules." -ForegroundColor Yellow
if ($Purge) { Write-Host "It will ALSO DELETE all data under $Root." -ForegroundColor Red }
else { Write-Host "Data under $Root will be kept (use -Purge to delete it)." -ForegroundColor Yellow }
if (-not $Yes) {
  $ans = Read-Host "Type 'yes' to continue"
  if ($ans -ne 'yes') { Write-Host "Cancelled."; exit }
}

$nssm = "$Root\tools\nssm.exe"

# --- core services ---
foreach ($svc in @("nginx", "wm-manager")) {
  if (Get-Service $svc -ErrorAction SilentlyContinue) {
    Info "removing service '$svc'"
    if (Test-Path $nssm) { & $nssm stop $svc 2>$null; & $nssm remove $svc confirm 2>$null }
    else { Stop-Service $svc -Force 2>$null; sc.exe delete $svc | Out-Null }
  }
}

# --- per-site process services (wm-*) ---
Get-Service "wm-*" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.Name -ne "wm-manager") {
    Info "removing per-site service '$($_.Name)'"
    if (Test-Path $nssm) { & $nssm stop $_.Name 2>$null; & $nssm remove $_.Name confirm 2>$null }
    else { Stop-Service $_.Name -Force 2>$null; sc.exe delete $_.Name | Out-Null }
  }
}

# --- firewall rules (panel/front + per-port rules the manager created) ---
Info "removing firewall rules"
foreach ($r in @("WEBMANAGER http", "WEBMANAGER https", "WEBMANAGER panel")) {
  netsh advfirewall firewall delete rule name="$r" | Out-Null
}
Get-NetFirewallRule -DisplayName "wm-port-*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName "wm-site-*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue

# --- data ---
if ($Purge) {
  Info "deleting $Root"
  Remove-Item -Recurse -Force $Root
}

Write-Host ""
Info "done."
Get-Service wm-manager, nginx -ErrorAction SilentlyContinue | Format-Table Name, Status -AutoSize
if (-not (Get-Service wm-manager -ErrorAction SilentlyContinue)) { Write-Host "WEBMANAGER services removed." -ForegroundColor Green }
if (-not $Purge) { Write-Host "Data kept at $Root (delete manually or re-run with -Purge)." -ForegroundColor Cyan }
Write-Host ""
Read-Host "Press Enter to close"
