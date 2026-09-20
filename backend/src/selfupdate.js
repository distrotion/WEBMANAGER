'use strict';
// Self-update of the manager itself, driven by the API (no one at the console).
//
// The process that answers POST /api/system/update is the one that has to be
// replaced, so the work is split:
//   here (in-process, safe)  — validate, `git fetch` (fail fast on an expired
//                              token, BEFORE any downtime), resolve the target
//                              commit, write state.json, launch the helper.
//   scripts/selfupdate.ps1   — out-of-process: stop, backup, copy, npm, start,
//                              health gate, rollback. Reports via state.json.
//
// Launch is through a run-once Windows Scheduled Task, not a child process:
// NSSM kills the service's whole process tree on Stop-Service, and a detached
// child is still in that tree. The task runs under the Task Scheduler service.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const settings = require('./settings');
const guard = require('./guard');
const git = require('./git');
const { run } = require('./runner');
const { emitLog } = require('./logbus');

const CHANNEL = 'system';
const UPDATE_DIR = path.join(config.ROOT, 'update');
const STATE_FILE = path.join(UPDATE_DIR, 'state.json');
const LOG_FILE = path.join(UPDATE_DIR, 'selfupdate.log');
const HELPER_SRC = path.join(__dirname, '..', 'scripts', 'selfupdate.ps1');
const TASK_NAME = 'wm-selfupdate';
// A helper that has not written to state.json for this long is presumed dead
// (power loss mid-update, task killed). Longer than any real step.
const STALE_MS = 30 * 60_000;
const SETTING_REPO_DIR = 'selfupdate_repo_dir';

let starting = false; // in-process lock covering the fetch window before state.json says 'running'

// Values that end up in run.cmd are parsed by cmd.exe: % expands variables even
// inside quotes, and & | ^ < > ! " break the command. No real install path
// needs them, so refuse rather than escape.
function cmdUnsafe(s) {
  const m = String(s).match(/[%&|^<>!"]/);
  return m ? `"${m[0]}"` : null;
}

// A token embedded in a clone URL (https://x-access-token:PAT@host/…) must not
// reach the log or an error message.
function scrubUrl(u) {
  return String(u).replace(/:\/\/[^@/]*@/, '://***@');
}

function readState() {
  try {
    // strip a BOM in case an older helper (PowerShell 5.1 -Encoding UTF8) wrote one
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(UPDATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

// The git checkout the helper pulls from. update.ps1 stamps WM_REPO_DIR into
// .env on the last manual update; an admin can also set it through the API.
function repoDir() {
  return settings.get(SETTING_REPO_DIR) || process.env.WM_REPO_DIR || null;
}

function setRepoDir(dir) {
  const s = String(dir || '').trim();
  if (!s) {
    settings.del(SETTING_REPO_DIR);
    return null;
  }
  if (/[\r\n\0]/.test(s) || !path.isAbsolute(s)) throw new Error('repoDir must be an absolute path');
  const badChar = cmdUnsafe(s);
  if (badChar) throw new Error(`repoDir may not contain ${badChar} (it is written into a .cmd launcher)`);
  if (!fs.existsSync(path.join(s, '.git'))) throw new Error(`${s} is not a git checkout (no .git)`);
  if (!fs.existsSync(path.join(s, 'backend', 'src', 'server.js'))) {
    throw new Error(`${s} does not look like a WEBMANAGER checkout (no backend/src/server.js)`);
  }
  settings.set(SETTING_REPO_DIR, s);
  return s;
}

// Is an update in flight right now? 'running' in state.json is trusted only
// while the helper's pid is alive or the file is fresh — otherwise the helper
// died (power loss) and the lock must not block forever.
function inFlight(state) {
  if (starting) return true;
  if (!state || !['queued', 'running'].includes(state.status)) return false;
  if (state.helperPid && pidAlive(state.helperPid)) return true;
  const stamp = Date.parse(state.updatedAt || state.requestedAt || 0) || 0;
  return Date.now() - stamp < STALE_MS;
}

function status() {
  const state = readState();
  const version = require('./version');
  const out = {
    version,
    repoDir: repoDir(),
    helperAvailable: fs.existsSync(HELPER_SRC),
    inFlight: inFlight(state),
    state,
  };
  if (state && ['queued', 'running'].includes(state.status) && !out.inFlight) {
    // The helper vanished mid-way. Say which way it went so the operator (or
    // the hub) knows whether anything needs fixing by hand.
    out.state = {
      ...state,
      status: 'interrupted',
      hint: String(version).startsWith(String(state.target || '').slice(0, 7))
        ? 'manager runs the target version — helper died after the start step; treat as success'
        : `manager runs ${version}, not the target — check ${state.backupDir || 'update/releases'} and update.cmd`,
    };
  }
  return out;
}

// At boot: if the last update never finished and we are now running the
// target, close it out as success so the lock is released and the status is
// truthful. Called from server.js.
function reconcileOnBoot() {
  const state = readState();
  if (!state || !['queued', 'running'].includes(state.status)) return;
  if (state.helperPid && pidAlive(state.helperPid)) return; // still working (it just restarted us)
  const version = String(require('./version'));
  // Only close it out once the helper's own gate window has clearly passed —
  // during the gate the helper is alive and may still roll back.
  const age = Date.now() - (Date.parse(state.updatedAt || 0) || 0);
  const gateMs = 2 * (Number(state.healthTimeoutSec) || 90) * 1000;
  if (age > gateMs && version.startsWith(String(state.target || '').slice(0, 7)) && state.step === 'health gate') {
    writeState({ ...state, status: 'success', step: 'done (closed at boot)', finishedAt: new Date().toISOString() });
  }
}

function tailLog(lines = 200) {
  try {
    // bounded read: only the last 256 KB, never the whole file into memory
    const fd = fs.openSync(LOG_FILE, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const all = buf.toString('utf8').split(/\r?\n/);
      return all.slice(Math.max(0, all.length - lines)).join('\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

async function gitOut(args, opts = {}) {
  const r = await run(config.git.exe, args, { channel: CHANNEL, env: git.gitEnv(), ...opts });
  return { code: r.code, out: (r.out || '').trim() };
}

// `git fetch origin` with the checkout's own credentials first (Git Credential
// Manager on the server), then once more with the panel's stored token — the
// case that actually bit us was an expired token in the checkout.
async function fetchOrigin(dir) {
  // 'silent' channel: the URL may carry an embedded token
  const remote = await gitOut(['-C', dir, 'remote', 'get-url', 'origin'], { channel: 'silent' });
  if (remote.code !== 0) throw new Error('checkout has no origin remote');
  const embedded = (remote.out.match(/:\/\/[^@/]*:([^@/]+)@/) || [])[1];
  let r = await gitOut(['-C', dir, 'fetch', 'origin', '--prune'], { redact: embedded || undefined });
  if (r.code === 0) return scrubUrl(remote.out);
  const plain = scrubUrl(remote.out).replace('://***@', '://');
  const authed = git.authedUrl(plain);
  if (authed !== plain) {
    emitLog(CHANNEL, '[self-update] fetch with checkout credentials failed — retrying with panel token');
    r = await gitOut(['-C', dir, 'fetch', authed, '+refs/heads/*:refs/remotes/origin/*'], {
      redact: git.tokenFor(plain) || undefined,
    });
    if (r.code === 0) return plain;
  }
  throw new Error(`git fetch failed: ${scrubUrl(r.out.split('\n').pop() || 'see system log')}`);
}

// Resolve what the user asked for to one commit. A branch name resolves to
// origin/<branch> (what fetch just brought in); a hash to itself.
async function resolveTarget(dir, ref) {
  const isHash = /^[0-9a-f]{7,40}$/i.test(ref);
  const candidates = isHash ? [ref] : [`origin/${ref}`, ref];
  for (const c of candidates) {
    const r = await gitOut(['-C', dir, 'rev-parse', '--verify', '--quiet', `${c}^{commit}`]);
    if (r.code === 0 && /^[0-9a-f]{40}$/.test(r.out)) return { hash: r.out, branch: isHash ? '' : ref };
  }
  throw new Error(`ref "${ref}" not found after fetch`);
}

// Where the helper runs from: a copy under ROOT/update, so robocopy replacing
// app/backend never touches a script that is executing.
function stageHelper() {
  fs.mkdirSync(UPDATE_DIR, { recursive: true });
  const dst = path.join(UPDATE_DIR, 'selfupdate.ps1');
  fs.copyFileSync(HELPER_SRC, dst);
  return dst;
}

function helperArgs({ helper, dir, target, branch, healthTimeoutSec, simulate }) {
  const a = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-Root', config.ROOT, '-RepoDir', dir, '-Target', target, '-Port', String(config.PORT),
    '-HealthTimeoutSec', String(healthTimeoutSec), '-GitExe', config.git.exe];
  if (branch) a.push('-Branch', branch);
  if (process.platform === 'win32') a.push('-TaskName', TASK_NAME);
  if (simulate) a.push('-Simulate', '-SkipNpm');
  return a;
}

// Windows: run-once Scheduled Task as SYSTEM. schtasks /TR is capped at 261
// chars, so the task points at a one-line .cmd wrapper carrying the real
// command. /SC ONCE needs a start time; /Run fires it immediately regardless.
async function launchWindows(args) {
  for (const a of args) {
    const bad = cmdUnsafe(a);
    if (bad) throw new Error(`launcher argument contains ${bad}, refusing to write run.cmd: ${a}`);
  }
  const cmdFile = path.join(UPDATE_DIR, 'run.cmd');
  const quoted = args.map((s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s)).join(' ');
  fs.writeFileSync(cmdFile, `@echo off\r\npowershell.exe ${quoted}\r\n`);
  const t = new Date(Date.now() + 2 * 60_000);
  const st = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const create = await run('schtasks', ['/Create', '/F', '/TN', TASK_NAME, '/SC', 'ONCE', '/ST', st,
    '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/TR', `"${cmdFile}"`], { channel: CHANNEL, timeoutMs: 30_000 });
  if (create.code !== 0) throw new Error(`schtasks /Create failed: ${create.out.trim()}`);
  const go = await run('schtasks', ['/Run', '/TN', TASK_NAME], { channel: CHANNEL, timeoutMs: 30_000 });
  if (go.code !== 0) throw new Error(`schtasks /Run failed: ${go.out.trim()}`);
  // /Run started it; the time trigger would start it AGAIN in 2 minutes. Disable
  // now (the helper also deletes the task as its first step — belt and braces).
  await run('schtasks', ['/Change', '/TN', TASK_NAME, '/DISABLE'], { channel: CHANNEL, timeoutMs: 30_000 });
}

// Dev/test (Mac/Linux): plain detached pwsh — nothing kills our tree here.
function launchPosix(args) {
  const child = spawn('pwsh', args, { detached: true, stdio: 'ignore' });
  child.unref();
}

async function launch(args) {
  if (process.platform === 'win32') return launchWindows(args);
  return launchPosix(args);
}

// Start an update. Resolves once the helper has been handed the job (seconds);
// progress is then read from status(). `launcher` is injectable for tests.
async function start({ ref = 'main', user, healthTimeoutSec = 90, simulate = false, launcher = launch } = {}) {
  const bad = guard.branch(ref);
  if (bad) throw new Error(bad);
  if (!/^[A-Za-z0-9._\-/]+$/.test(ref)) throw new Error('ref contains invalid characters');
  // `checkout -B origin/main` would create a LOCAL branch named origin/main that
  // shadows the remote-tracking ref for every later fetch. Ask for 'main'.
  if (/^(origin|refs)\//.test(ref)) throw new Error('give the branch name without origin/ (e.g. "main")');
  const dir = repoDir();
  if (!dir) throw new Error('repo dir not configured (set WM_REPO_DIR via update.cmd, or PUT /api/system/update/config)');
  if (!fs.existsSync(path.join(dir, '.git'))) throw new Error(`repo dir ${dir} is not a git checkout`);
  if (!fs.existsSync(HELPER_SRC)) throw new Error('helper script missing (scripts/selfupdate.ps1) — update once by hand first');
  if (inFlight(readState())) throw new Error('an update is already in progress');

  starting = true;
  try {
    emitLog(CHANNEL, `[self-update] fetch origin in ${dir}`);
    await fetchOrigin(dir);
    const target = await resolveTarget(dir, ref);
    const from = String(require('./version'));
    if (from.startsWith(target.hash.slice(0, 7))) {
      throw new Error(`already running ${target.hash.slice(0, 7)} — nothing to update`);
    }
    const helper = stageHelper();
    writeState({
      status: 'queued',
      step: 'launching helper',
      ref,
      target: target.hash,
      from,
      requestedBy: (user && user.username) || 'system',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      healthTimeoutSec,
      helperPid: null,
      error: null,
      log: LOG_FILE,
    });
    fs.writeFileSync(LOG_FILE, `${new Date().toISOString()} queued ${from} -> ${target.hash.slice(0, 7)} (${ref})\n`, { flag: 'a' });
    await launcher(helperArgs({ helper, dir, target: target.hash, branch: target.branch, healthTimeoutSec, simulate }));
    emitLog(CHANNEL, `[self-update] helper launched: ${from} -> ${target.hash.slice(0, 7)}`);
    return { from, target: target.hash, ref };
  } catch (e) {
    const s = readState();
    if (s && s.status === 'queued' && !s.helperPid) {
      writeState({ ...s, status: 'failed', error: e.message, finishedAt: new Date().toISOString() });
    }
    throw e;
  } finally {
    starting = false;
  }
}

module.exports = {
  start,
  status,
  repoDir,
  setRepoDir,
  tailLog,
  reconcileOnBoot,
  helperArgs,
  paths: { UPDATE_DIR, STATE_FILE, LOG_FILE, HELPER_SRC },
};
