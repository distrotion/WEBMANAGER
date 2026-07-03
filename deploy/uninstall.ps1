<#
  Remove WEBMANAGER Windows services + firewall rules.
  Run from an elevated PowerShell:  .\uninstall.ps1 -Root C:\webmanager
  Data under <Root> (sites, certs, db) is KEPT unless -Purge is given.
#>
param([string]$Root = "C:\webmanager", [switch]$Purge)
$ErrorActionPreference = "SilentlyContinue"
function Info($m){ Write-Host "[uninstall] $m" -ForegroundColor Cyan }

$nssm = "$Root\tools\nssm.exe"

foreach ($svc in @("nginx", "wm-manager")) {
  if (Get-Service $svc -ErrorAction SilentlyContinue) {
    Info "stopping + removing service '$svc'"
    if (Test-Path $nssm) {
      & $nssm stop $svc 2>$null
      & $nssm remove $svc confirm 2>$null
    } else {
      Stop-Service $svc -Force 2>$null
      sc.exe delete $svc | Out-Null
    }
  }
}

# also remove any per-site process services created by the manager (wm-*)
Get-Service "wm-*" -ErrorAction SilentlyContinue | ForEach-Object {
  Info "removing per-site service '$($_.Name)'"
  if (Test-Path $nssm) { & $nssm stop $_.Name 2>$null; & $nssm remove $_.Name confirm 2>$null }
  else { Stop-Service $_.Name -Force 2>$null; sc.exe delete $_.Name | Out-Null }
}

Info "removing firewall rules"
foreach ($r in @("WEBMANAGER http", "WEBMANAGER https", "WEBMANAGER panel")) {
  netsh advfirewall firewall delete rule name="$r" | Out-Null
}

if ($Purge) {
  Info "PURGE: deleting $Root"
  Remove-Item -Recurse -Force $Root
} else {
  Info "services removed. Data under $Root kept (use -Purge to delete it all)."
}
