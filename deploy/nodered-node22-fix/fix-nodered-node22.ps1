<#
  Node-RED 1.x on Node 22: fix "Error: spawn EINVAL" at startup - offline, no downloads.

  Node >= 18.20 / 20.12 / 22 refuses child_process.spawn/execFile of a .cmd/.bat
  (npm.cmd) unless shell:true is passed (CVE-2024-27980; Node 22 has no revert flag).
  Node-RED 1.2.x calls npm.cmd that way in three places of
  @node-red/registry/lib/installer.js (palette check at start, install, remove).
  This patches those three calls to pass shell:true on Windows - the same fix newer
  Node-RED ships. Backup: installer.js.bak-node22. Safe to run again.
#>
$ErrorActionPreference = 'Stop'
$npmDir = Join-Path $env:APPDATA 'npm'
$redJs = Join-Path $npmDir 'node_modules\node-red\red.js'
$candidates = @(
  (Join-Path $npmDir 'node_modules\node-red\node_modules\@node-red\registry\lib\installer.js'),
  (Join-Path $npmDir 'node_modules\@node-red\registry\lib\installer.js')
)
if ($args.Count -gt 0 -and (Test-Path $args[0])) { $candidates = @($args[0]) + $candidates }
$target = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $target) {
  Write-Host "[!!] installer.js not found. Looked in:" -ForegroundColor Yellow
  $candidates | ForEach-Object { Write-Host "     $_" }
  Write-Host "     Pass the path as the first argument if Node-RED lives somewhere else." -ForegroundColor Yellow
  exit 1
}
Write-Host "[fix] $target"
$s = [System.IO.File]::ReadAllText($target)
$mark = '/* node22-fix */'
if ($s.Contains($mark)) {
  Write-Host "[ok ] already patched - nothing to do"
} else {
  $new = $s
  $new = [regex]::Replace($new, "exec\.run\(npmCommand,\s*args,\s*\{(?!\s*shell)", "exec.run(npmCommand,args,{ shell: process.platform === 'win32', $mark ")
  $new = [regex]::Replace($new, "child_process\.execFile\(npmCommand,\s*\['-v'\],\s*function", "child_process.execFile(npmCommand,['-v'],{ shell: process.platform === 'win32' } $mark, function")
  $hits = ([regex]::Matches($new, [regex]::Escape($mark))).Count
  if ($hits -lt 3) {
    Write-Host "[!!] expected 3 call sites, matched $hits - this Node-RED version differs, file left unchanged" -ForegroundColor Yellow
    exit 1
  }
  Copy-Item $target "$target.bak-node22" -Force
  [System.IO.File]::WriteAllText($target, $new, (New-Object System.Text.UTF8Encoding($false)))
  & node --check $target
  if ($LASTEXITCODE -ne 0) {
    Copy-Item "$target.bak-node22" $target -Force
    Write-Host "[!!] patched file failed node --check - original restored" -ForegroundColor Red
    exit 1
  }
  Write-Host "[ok ] patched $hits call sites (backup installer.js.bak-node22)" -ForegroundColor Green
}
Write-Host ""
Write-Host "[fix] Node $(& node -v) - starting Node-RED once to test (Ctrl+C to stop after 'Server now running'):"
Write-Host ""
if (Test-Path $redJs) { & node $redJs } else { Write-Host "[!!] $redJs not found - start Node-RED the way the service does" -ForegroundColor Yellow }
