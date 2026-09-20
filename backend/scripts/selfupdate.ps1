<#
  WEBMANAGER self-update helper — runs OUTSIDE the wm-manager process.

  The API (POST /api/system/update) cannot swap its own code: the process that
  received the request is the one that has to be stopped. So selfupdate.js copies
  this file to <Root>\update\selfupdate.ps1 and launches it through a run-once
  Scheduled Task (NSSM kills the service's whole process tree on stop, so a plain
  child process would die with the manager). From then on this script owns the
  update and reports back only through <Root>\update\state.json.

  Flow:  checkout target  ->  back up app\backend + app\ui  ->  stop wm-manager
         ->  copy new code (keep node_modules + .env)  ->  npm install
         ->  re-stamp WM_VERSION  ->  start  ->  HEALTH GATE (200 + new version)
         ->  on failure: ROLLBACK to the backup and start again.

  Never touches: .env, certs\, sites\, data\ (the DB), nginx\.
  -Simulate is for the dev-machine test (no Windows service / robocopy): the
  "service" is `node <app>\backend\src\server.js` tracked by a pid file, and
  rsync stands in for robocopy. Same control flow, same state file.
#>
param(
  [Parameter(Mandatory)][string]$Root,
  [Parameter(Mandatory)][string]$RepoDir,
  [Parameter(Mandatory)][string]$Target,      # full commit hash (resolved by the API)
  [string]$Branch = '',                        # local branch to move; empty = detached
  [int]$Port = 8088,
  [int]$HealthTimeoutSec = 90,
  [int]$KeepReleases = 3,
  [string]$GitExe = 'git',                     # SYSTEM's PATH is not the admin's — the API passes config.git.exe
  [string]$TaskName = '',                      # the Scheduled Task that launched us; deleted first thing
  [switch]$Simulate,
  [switch]$SkipNpm
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# $IsWindows does not exist on PowerShell 5.1 (Windows Server 2019)
$OnWindows = ($env:OS -eq 'Windows_NT')

$UpdateDir = Join-Path $Root 'update'
$StateFile = Join-Path $UpdateDir 'state.json'
$LogFile   = Join-Path $UpdateDir 'selfupdate.log'
$AppDir    = Join-Path $Root 'app'
$BackendDir = Join-Path $AppDir 'backend'
$UiDir      = Join-Path $AppDir 'ui\build\web'
$EnvFile    = Join-Path $BackendDir '.env'
$NewBackend = Join-Path $RepoDir 'backend'
$NewUi      = Join-Path $RepoDir 'ui\build\web'
$ShortTarget = $Target.Substring(0, [Math]::Min(7, $Target.Length))
$Stamp = (Get-Date).ToString('yyyyMMdd-HHmmss', [Globalization.CultureInfo]::InvariantCulture)
$PidFile = Join-Path $UpdateDir 'sim.pid'
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
New-Item -ItemType Directory -Force -Path $UpdateDir | Out-Null

# The run-once task keeps its time trigger after /Run; delete it before it can
# fire a second update on top of this one.
if ($TaskName -and $OnWindows) { & schtasks /Delete /TN $TaskName /F 2>&1 | Out-Null }

# keep the log bounded (npm output lands here too)
if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 5MB) { Move-Item -Force $LogFile "$LogFile.1" }

# ---------------------------------------------------------------- state ----
# state.json is the ONLY channel back to the API. Every step rewrites it, so a
# reader (or a reboot) always sees how far the update got.
$script:State = @{}
# (no -AsHashtable: Windows Server 2019 ships PowerShell 5.1)
if (Test-Path $StateFile) {
  try {
    $obj = Get-Content $StateFile -Raw | ConvertFrom-Json
    foreach ($p in $obj.PSObject.Properties) { $script:State[$p.Name] = $p.Value }
  } catch { $script:State = @{} }
}
function Set-State([hashtable]$fields) {
  foreach ($k in $fields.Keys) { $script:State[$k] = $fields[$k] }
  $script:State['updatedAt'] = (Get-Date).ToString('o')
  $tmp = "$StateFile.tmp"
  # PowerShell 5.1's -Encoding UTF8 writes a BOM, which Node's JSON.parse rejects
  [IO.File]::WriteAllText($tmp, ($script:State | ConvertTo-Json -Depth 5), $Utf8NoBom)
  Move-Item -Force $tmp $StateFile
}
function Log([string]$m) {
  $line = "$((Get-Date).ToString('HH:mm:ss')) $m"
  Add-Content -Encoding UTF8 $LogFile $line
  Write-Host $line
}
function Step([string]$name) { Log "== $name"; Set-State @{ step = $name } }

# Run a native command, log its output, return the exit code. PowerShell 5.1
# turns native stderr into a terminating error under ErrorActionPreference=Stop
# when it is redirected with 2>&1 — git writes progress to stderr — so the
# preference is relaxed for the call only.
function Invoke-Native([string]$exe, [string[]]$argv) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $global:LASTEXITCODE = $null   # so a command that never ran cannot report the previous exit code
  try {
    & $exe @argv 2>&1 | ForEach-Object { Log "    $_" }
    if ($null -eq $LASTEXITCODE) { Log "    (could not run $exe)"; return -1 }
    return $LASTEXITCODE
  } catch {
    Log "    (could not run ${exe}: $($_.Exception.Message))"
    return -1
  } finally { $ErrorActionPreference = $prev }
}

# ------------------------------------------------------------ platform -----
function Copy-Tree([string]$from, [string]$to, [string[]]$excludeDirs = @(), [string[]]$excludeFiles = @()) {
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  if ($Simulate -and -not $OnWindows) {
    $rc = @('-a', '--delete')
    foreach ($d in $excludeDirs)  { $rc += "--exclude=/$d" }
    foreach ($f in $excludeFiles) { $rc += "--exclude=/$f" }
    $code = Invoke-Native 'rsync' ($rc + @("$from/", "$to/"))
    if ($code -ne 0) { throw "rsync $from -> $to failed ($code)" }
    return
  }
  $rc = @($from, $to, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:3', '/W:2')
  if ($excludeDirs.Count)  { $rc += '/XD'; $rc += $excludeDirs }
  if ($excludeFiles.Count) { $rc += '/XF'; $rc += $excludeFiles }
  # robocopy: 0-7 = success variants, 8+ = at least one copy failed, -1 = did not run
  $code = Invoke-Native 'robocopy' $rc
  if ($code -ge 8 -or $code -lt 0) { throw "robocopy $from -> $to failed ($code)" }
}

function Stop-Manager {
  if ($Simulate) {
    if (Test-Path $PidFile) {
      $p = Get-Content $PidFile
      try { Stop-Process -Id ([int]$p) -Force -ErrorAction Stop } catch {}
      Remove-Item -Force $PidFile
    }
    Start-Sleep -Milliseconds 300
    return
  }
  $script:DependentsWereRunning = Get-RunningDependents
  if ($script:DependentsWereRunning.Count) { Log "dependents running (will restart after): $($script:DependentsWereRunning -join ', ')" }
  Stop-Service wm-manager -Force -ErrorAction SilentlyContinue
  $svc = Get-Service wm-manager -ErrorAction SilentlyContinue
  if (-not $svc) { throw 'service wm-manager not found - refusing to copy over a possibly running manager' }
  $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
  $svc.Refresh()
  if ($svc.Status -ne 'Stopped') { throw "wm-manager did not stop (status $($svc.Status))" }
  Start-Sleep -Seconds 2   # let node-pty / better-sqlite3 file handles close
}

# nginx is registered with DependOnService wm-manager, so stopping the manager
# takes nginx (every static site) down with it — and Start-Service wm-manager
# does NOT bring a dependent back. Remember what was running and restart it.
$script:DependentsWereRunning = @()
function Get-RunningDependents {
  if ($Simulate) { return @() }
  $svc = Get-Service wm-manager -ErrorAction SilentlyContinue
  if (-not $svc) { return @() }
  return @($svc.DependentServices | Where-Object { $_.Status -eq 'Running' } | ForEach-Object { $_.Name })
}
function Start-Dependents {
  $result = @{}
  foreach ($name in $script:DependentsWereRunning) {
    try {
      Start-Service $name -ErrorAction Stop
      $d = Get-Service $name
      $d.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
      $result[$name] = 'running'
      Log "dependent service $name started"
    } catch {
      $result[$name] = "FAILED: $($_.Exception.Message)"
      Log "!! dependent service $name did not start: $($_.Exception.Message) - start it from the panel (nginx -> Start)"
    }
  }
  Set-State @{ dependents = $result }
}

function Start-Manager {
  if ($Simulate) {
    $p = Start-Process -FilePath 'node' -ArgumentList @((Join-Path $BackendDir 'src\server.js').Replace('\', '/')) `
      -WorkingDirectory $BackendDir -PassThru -RedirectStandardOutput (Join-Path $UpdateDir 'sim-stdout.log') `
      -RedirectStandardError (Join-Path $UpdateDir 'sim-stderr.log')
    Set-Content $PidFile $p.Id
    return
  }
  Start-Service wm-manager
}

# Health gate: 200 on /api/health AND the version it reports is the one we
# just installed. "Service is Running" alone proves nothing — node may still be
# crash-looping under NSSM's auto-restart.
function Wait-Healthy([string]$expectShort, [int]$timeoutSec, [string]$rejectShort = '') {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  $last = ''
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    try {
      $r = Invoke-WebRequest "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) {
        $b = $r.Content | ConvertFrom-Json
        $last = "$($b.version)"
        # empty expectation = "any real version that is NOT the release we just rejected"
        $accept = if ($expectShort) { $last.StartsWith($expectShort) } else { $last -and ($rejectShort -eq '' -or -not $last.StartsWith($rejectShort)) }
        if ($accept) { return @{ ok = $true; version = $last } }
      }
    } catch { $last = "no answer: $($_.Exception.Message)" }
  }
  return @{ ok = $false; version = $last }
}

function Read-EnvValue([string]$key) {
  if (-not (Test-Path $EnvFile)) { return $null }
  $m = Get-Content -Encoding UTF8 $EnvFile | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
  if ($m) { return $m.Substring($key.Length + 1) }
  return $null
}
function Write-EnvValue([string]$key, [string]$value) {
  if (-not (Test-Path $EnvFile)) { return }
  # atomic (tmp + move) and BOM-less UTF-8: this file holds JWT_SECRET/ADMIN_PASS —
  # a truncated or ASCII-flattened .env is not recoverable
  $keep = @(Get-Content -Encoding UTF8 $EnvFile | Where-Object { $_ -notmatch "^$key=" })
  $tmp = "$EnvFile.tmp"
  [IO.File]::WriteAllText($tmp, (($keep + "$key=$value") -join "`r`n") + "`r`n", $Utf8NoBom)
  Move-Item -Force $tmp $EnvFile
}

function Invoke-Npm([string]$dir) {
  if ($SkipNpm) { Log 'npm install skipped (-SkipNpm)'; return }
  $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $nodeExe -and $OnWindows) { $nodeExe = "$env:ProgramFiles\nodejs\node.exe" }
  if (-not $nodeExe) { throw 'node not found for npm install' }
  # node npm-cli.js directly: the npm.ps1 shim mangles args on some Windows hosts.
  $npmCli = Join-Path (Split-Path $nodeExe) 'node_modules\npm\bin\npm-cli.js'
  if (-not (Test-Path $npmCli)) { $npmCli = Join-Path (Split-Path (Split-Path $nodeExe)) 'lib\node_modules\npm\bin\npm-cli.js' }
  Push-Location $dir
  try {
    $code = Invoke-Native $nodeExe @($npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund')
    if ($code -ne 0) { throw "npm install failed ($code)" }
  } finally { Pop-Location }
}

# ---------------------------------------------------------------- main -----
$oldVersion = Read-EnvValue 'WM_VERSION'
if (-not $oldVersion) { $oldVersion = 'unknown' }
$oldShort = ($oldVersion -split ' ')[0]
$backupDir = Join-Path $UpdateDir "releases\$Stamp-$oldShort"
$lockChanged = $false
$backedUp = $false
$stopped = $false

Set-State @{
  status = 'running'; helperPid = $PID; from = $oldVersion; target = $Target
  startedAt = (Get-Date).ToString('o'); backupDir = $backupDir; error = $null
  health = $null; rollback = $null; log = $LogFile
}
Log "self-update $oldShort -> $ShortTarget (repo $RepoDir)"

function Invoke-Rollback([string]$why) {
  Set-State @{ rollback = @{ attempted = $true; reason = $why; ok = $null } }
  Log "!! ROLLBACK: $why"
  try {
    Step 'rollback: stop'
    Stop-Manager
    Step 'rollback: restore files'
    # /XD node_modules: the backup has none (unless the lockfile changed, handled
    # below), and /MIR without it would purge the live one
    Copy-Tree (Join-Path $backupDir 'backend') $BackendDir @('node_modules') @('.env')
    if (Test-Path (Join-Path $backupDir 'ui')) { Copy-Tree (Join-Path $backupDir 'ui') $UiDir }
    if (Test-Path (Join-Path $backupDir 'node_modules')) {
      Step 'rollback: restore node_modules'
      Copy-Tree (Join-Path $backupDir 'node_modules') (Join-Path $BackendDir 'node_modules')
    }
    $envBak = Join-Path $backupDir 'env.bak'
    if (Test-Path $envBak) { Copy-Item -Force $envBak "$EnvFile.tmp"; Move-Item -Force "$EnvFile.tmp" $EnvFile } else { Write-EnvValue 'WM_VERSION' $oldVersion }
    Step 'rollback: start'
    Start-Manager
    Start-Dependents
    $expect = if ($oldShort -eq 'unknown') { '' } else { $oldShort }
    $h = Wait-Healthy $expect $HealthTimeoutSec $ShortTarget
    Set-State @{
      status = 'rolled-back'; step = 'done'; finishedAt = (Get-Date).ToString('o')
      error = $why; health = $h
      rollback = @{ attempted = $true; reason = $why; ok = $h.ok; version = $h.version }
    }
    if ($h.ok) { Log "rollback OK - running $($h.version)" } else { Log "rollback: manager still not healthy ($($h.version)) - manual action needed" }
  } catch {
    Set-State @{
      status = 'failed'; step = 'rollback failed'; finishedAt = (Get-Date).ToString('o')
      error = "$why; rollback failed: $($_.Exception.Message)"
      rollback = @{ attempted = $true; reason = $why; ok = $false }
    }
    Log "rollback FAILED: $($_.Exception.Message) - run update.cmd by hand"
  }
}

try {
  Step 'checkout'
  $co = if ($Branch) { @('-C', $RepoDir, 'checkout', '-q', '-B', $Branch, $Target) } else { @('-C', $RepoDir, 'checkout', '-q', '--detach', $Target) }
  if ((Invoke-Native $GitExe $co) -ne 0) { throw "git checkout $ShortTarget failed" }
  $head = (& $GitExe -C $RepoDir rev-parse HEAD 2>$null)
  if ("$head".Trim() -ne $Target) { throw "checkout did not land on $ShortTarget (HEAD is '$head')" }
  if (-not (Test-Path (Join-Path $NewBackend 'src\server.js'))) { throw "checkout has no backend\src\server.js" }

  Step 'backup'
  # node_modules is only backed up when the lockfile changes: that is the only
  # case where rolling back the code alone would leave mismatched deps.
  $oldLock = Join-Path $BackendDir 'package-lock.json'
  $newLock = Join-Path $NewBackend 'package-lock.json'
  if ((Test-Path $oldLock) -and (Test-Path $newLock)) {
    $lockChanged = (Get-FileHash $oldLock).Hash -ne (Get-FileHash $newLock).Hash
  } elseif ((Test-Path $oldLock) -or (Test-Path $newLock)) { $lockChanged = $true }
  Copy-Tree $BackendDir (Join-Path $backupDir 'backend') @('node_modules') @('.env')
  # .env is excluded from the tree copy (secrets stay out of releases\backend) but
  # it IS rewritten below, so keep one private copy to restore from
  if (Test-Path $EnvFile) { Copy-Item -Force $EnvFile (Join-Path $backupDir 'env.bak') }
  if (Test-Path $UiDir) { Copy-Tree $UiDir (Join-Path $backupDir 'ui') }
  if ($lockChanged -and (Test-Path (Join-Path $BackendDir 'node_modules'))) {
    Log 'package-lock changed -> backing up node_modules too'
    Copy-Tree (Join-Path $BackendDir 'node_modules') (Join-Path $backupDir 'node_modules')
  }
  $backedUp = $true

  Step 'stop manager'
  Stop-Manager
  $stopped = $true

  Step 'copy new code'
  Copy-Tree $NewBackend $BackendDir @('node_modules') @('.env')
  if (Test-Path (Join-Path $NewUi 'index.html')) { Copy-Tree $NewUi $UiDir } else { Log 'no ui\build\web in checkout - UI left as is' }

  Step 'npm install'
  Invoke-Npm $BackendDir

  Step 'stamp version'
  # invariant culture: a Thai-locale host formats yyyy as the Buddhist year (2569)
  $newVersion = "$ShortTarget ($((Get-Date).ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)))"
  Write-EnvValue 'WM_VERSION' $newVersion
  Write-EnvValue 'WM_REPO_DIR' $RepoDir

  Step 'start manager'
  Start-Manager
  Start-Dependents

  Step 'health gate'
  $h = Wait-Healthy $ShortTarget $HealthTimeoutSec
  if (-not $h.ok) { throw "health gate failed: expected version $ShortTarget, got '$($h.version)' within ${HealthTimeoutSec}s" }

  Set-State @{ status = 'success'; step = 'done'; finishedAt = (Get-Date).ToString('o'); health = $h; version = $newVersion }
  Log "OK - running $($h.version)"

  # prune old backups (newest first)
  $rel = Join-Path $UpdateDir 'releases'
  if (Test-Path $rel) {
    Get-ChildItem $rel -Directory | Sort-Object Name -Descending | Select-Object -Skip $KeepReleases |
      ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }
  }
} catch {
  $why = $_.Exception.Message
  Log "!! $why"
  if ($backedUp -and $stopped) {
    Invoke-Rollback $why
  } elseif ($backedUp) {
    # failed before the service was touched (e.g. checkout/backup) — nothing to restore
    Set-State @{ status = 'failed'; step = 'aborted before stop'; finishedAt = (Get-Date).ToString('o'); error = $why }
  } else {
    Set-State @{ status = 'failed'; finishedAt = (Get-Date).ToString('o'); error = $why }
  }
}
