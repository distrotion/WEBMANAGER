'use strict';
// Network share credentials.
//
// Why this exists: the manager (and every app it launches through PM2) runs as
// LocalSystem. LocalSystem has no user identity on the network — it reaches a
// file server as the machine account, or anonymously in a workgroup — so a
// backend opening \\server\share gets "access denied" even though the same path
// opens fine in the operator's own Explorer session.
//
// Fix: the manager authenticates the SMB session itself with stored credentials.
// Because the deployed apps run under the same LocalSystem logon, they inherit
// that authenticated session and plain fs.readFile on the UNC path just works —
// no change needed in any deployed app.
//
// SMB sessions drop (idle timeout, server reboot, network blip), so a reconciler
// re-establishes them: connectivity is checked by actually reading the path,
// which is what the apps care about, not by parsing `net use` output.
const fs = require('fs');
const db = require('./db');
const secretbox = require('./secretbox');
const { run } = require('./runner');
const { emitLog } = require('./logbus');

const CHANNEL = 'system';
const state = new Map(); // id -> { ok, error, checkedAt }

const isWindows = () => process.platform === 'win32';

// '\\\\server\\share\\sub' -> 'server'
function serverOf(uncPath) {
  const m = String(uncPath || '').match(/^\\\\([^\\/]+)/);
  return m ? m[1] : null;
}

function rows() {
  return db.prepare('SELECT * FROM net_shares ORDER BY name').all();
}

// Can we actually read it? This is the question that matters — a share can be
// "connected" per `net use` and still be unreadable.
async function reachable(uncPath) {
  try {
    await fs.promises.access(uncPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// Turn `net use` output into something an operator can act on. Its own text is
// unhelpful on its own — the first line is the password PROMPT (which contains
// the word "password" and so is easy to mistake for the error), and the real
// cause is a numeric code further down.
const NET_ERRORS = {
  5: 'the account authenticated but has no permission on this share — grant it in the share/NTFS permissions',
  53: 'network path not found — check the server name/IP and that File and Printer Sharing is reachable',
  67: 'share name not found on that server — check the part after the server name',
  86: 'the username or password is wrong. If the file server is in a domain, use DOMAIN\\user; if it is standalone, try SERVERNAME\\user',
  1219: 'a session to that server already exists under different credentials — disconnect it first',
  1312: 'Windows could not create a logon session for this credential — the Credential Manager service (VaultSvc) is usually stopped on a server nobody signs in to. The manager starts it automatically; if this persists, start it by hand: sc start VaultSvc',
  1326: 'the username or password is wrong',
  1327: 'the account is not allowed to log on (blank password or logon-hours/account restriction)',
};

function explain(out, code) {
  const lines = String(out || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // drop the interactive prompt — it is not an error and it mentions "password"
    .filter((l) => !/^type the password/i.test(l));
  const num = (String(out || '').match(/System error (\d+)/i) || [])[1];
  const hint = num && NET_ERRORS[Number(num)];
  const said = lines.find((l) => /^the |denied|not correct|not found/i.test(l)) || lines[0];
  if (hint) return `${said || `System error ${num}`} — ${hint}`;
  return said || `net use exited ${code}`;
}

// Windows will not give a LocalSystem service a network logon session with
// alternate credentials unless the Credential Manager service is running: every
// method fails with 1312 (ERROR_NO_SUCH_LOGON_SESSION) — net use with explicit
// credentials, cmdkey, and New-SmbMapping alike. VaultSvc starts on demand, and
// the demand is normally an interactive logon, so on a server nobody is signed
// in to it just stays stopped. Start it ourselves; `sc start` on an already
// running service exits non-zero and is harmless, so the result is ignored.
//
// Run this before EVERY connect, not once per process: VaultSvc stops itself
// again once idle. An established mount keeps working, so nothing looks wrong
// until the next connect — which then fails with 1312 all over again. Connects
// only happen when a share is already broken, so the cost is negligible.
async function ensureCredentialService() {
  if (!isWindows()) return;
  await run('sc', ['start', 'VaultSvc'], { channel: 'silent' });
}

// Authenticate the SMB session for one share.
//
// The password is passed as an argument, not on stdin. `net use ... *` prompts
// by reading the console directly (CONIN$) rather than stdin, so a piped
// password is silently ignored and an EMPTY one is submitted — which fails with
// "System error 86, the specified network password is not correct", exactly as
// if the password were wrong. Verified on Windows Server 2019: a credential that
// mounts fine from Explorer failed every time through the pipe.
//
// Retrying stdin first and falling back would be worse than useless: each
// attempt is a failed logon, and the reconciler runs every 60s, so a share with
// an account-lockout policy would lock itself out. So: argument form only.
//
// Cost: the password is visible in that process's command line for the second or
// so `net.exe` lives. Accepted — the alternative silently does not work, only
// processes on this server can see it, and the log stream still redacts it.
async function connectOne(share, channel = CHANNEL) {
  if (!isWindows()) {
    return { ok: false, error: 'network share credentials are a Windows feature (this host is ' + process.platform + ')' };
  }
  const password = secretbox.decrypt(share.password_enc);
  if (password === null) {
    return { ok: false, error: 'stored password could not be decrypted — re-enter it' };
  }
  // Authenticate against the SERVER (its IPC$ pipe), not the individual share.
  // SMB keeps one session per server, so this single login covers every share on
  // it — and mounting a named share directly turned out to be unreliable: on a
  // real host `net use \\srv\Sign_Pic <pw>` failed with 1312 every time while
  // `net use \\srv\SQLBackups_LC <pw>` with the same account succeeded, and once
  // any share had authenticated, reading \\srv\Sign_Pic worked fine. IPC$ exists
  // on every Windows host and is what SMB uses for session setup, so it avoids
  // whatever the named share objected to.
  const server = serverOf(share.unc_path);
  if (!server) return { ok: false, error: 'unc_path must look like \\\\server\\share' };
  const ipc = `\\\\${server}\\IPC$`;

  await ensureCredentialService();
  // Drop any half-open session first; a stale one makes `net use` fail with
  // "multiple connections to a server by the same user" (error 1219).
  await run('net', ['use', ipc, '/delete', '/y'], { channel: 'silent' });
  const r = await run('net', ['use', ipc, password, '/user:' + share.username], {
    channel,
    redact: password,
  });
  if (r.code !== 0) return { ok: false, error: explain(r.out, r.code) };
  return { ok: true };
}

// Bring every enabled share into a usable state. Only reconnects what is
// actually broken, so the normal case costs one access() per share.
async function reconcile(channel = CHANNEL, { force = false } = {}) {
  for (const share of rows()) {
    if (!share.enabled) {
      state.set(share.id, { ok: false, error: 'disabled', checkedAt: Date.now() });
      continue;
    }
    if (!force && (await reachable(share.unc_path))) {
      state.set(share.id, { ok: true, error: null, checkedAt: Date.now() });
      continue;
    }
    const res = await connectOne(share, channel);
    const ok = res.ok && (await reachable(share.unc_path));
    state.set(share.id, {
      ok,
      error: ok ? null : res.error || 'connected but the path is still unreadable',
      checkedAt: Date.now(),
    });
    emitLog(
      channel,
      ok
        ? `[netshare] "${share.name}" ${share.unc_path} connected as ${share.username}`
        : `[netshare] "${share.name}" ${share.unc_path} FAILED — ${state.get(share.id).error}`
    );
  }
}

function status(id) {
  return state.get(id) || { ok: false, error: 'not checked yet', checkedAt: null };
}

// Verify a credential without saving it (the "Test" button).
//
// Connecting tears down any existing session to that path first, so a failed
// test would otherwise leave a working share disconnected. Always put the saved
// configuration back afterwards.
async function test({ unc_path, username, password }) {
  const share = { name: 'test', unc_path, username, password_enc: secretbox.encrypt(password) };
  try {
    const r = await connectOne(share);
    if (!r.ok) return r;
    if (await reachable(unc_path)) return { ok: true };
    return { ok: false, error: 'authenticated, but the path is still unreadable — check the share/NTFS permissions' };
  } finally {
    // Re-establish whatever is stored; a probe must not leave the server worse
    // off than it found it.
    reconcile('silent', { force: true }).catch(() => {});
  }
}

function start() {
  if (!isWindows()) return; // nothing to mount on the dev machines
  reconcile().catch(() => {});
  setInterval(() => reconcile().catch(() => {}), 60000).unref();
}

module.exports = { reconcile, connectOne, status, test, start, reachable, isWindows };
