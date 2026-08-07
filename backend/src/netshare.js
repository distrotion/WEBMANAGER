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
// Everything here is organised PER SERVER, not per share, because that is how
// SMB actually works: one authenticated session per server, shared by every
// share on it. Treating shares independently made them tear down each other's
// session, and made two rows on one host with different accounts fight forever.
const fs = require('fs');
const db = require('./db');
const secretbox = require('./secretbox');
const { run } = require('./runner');
const { emitLog } = require('./logbus');

const CHANNEL = 'system';
const state = new Map(); // share id -> { ok, error, checkedAt, fails, nextTryAt }

// How long to wait before trying a credential again, indexed by consecutive
// failures. A wrong password replayed every 60s is dozens of failed logons an
// hour against the file server, which is exactly how an account-lockout policy
// gets tripped — by us. Only applied to CREDENTIAL rejections; a server that is
// merely unreachable is retried on the normal tick, so a boot-time network blip
// does not park a good share for half an hour.
const BACKOFF_MS = [0, 5 * 60_000, 15 * 60_000, 30 * 60_000];
const backoffFor = (fails) => BACKOFF_MS[Math.min(fails, BACKOFF_MS.length - 1)];
const AUTH_ERRORS = new Set([5, 86, 1326, 1327]); // the credential itself was refused
const REACH_TIMEOUT_MS = 10_000;

const isWindows = () => process.platform === 'win32';

// '\\\\server\\share\\sub' -> 'server' (lowercased; SMB hosts are case-insensitive)
function serverOf(uncPath) {
  const m = String(uncPath || '').match(/^\\\\([^\\/]+)/);
  return m ? m[1].toLowerCase() : null;
}

function rows() {
  return db.prepare('SELECT * FROM net_shares ORDER BY name').all();
}

// Can we actually read it? This is the question that matters — a share can be
// "connected" per `net use` and still be unreadable. Bounded, because a dead
// host can otherwise hang the whole pass past the next tick.
async function reachable(uncPath) {
  try {
    await Promise.race([
      fs.promises.access(uncPath, fs.constants.R_OK),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), REACH_TIMEOUT_MS)),
    ]);
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
  const num = Number((String(out || '').match(/System error (\d+)/i) || [])[1]) || null;
  const hint = num && NET_ERRORS[num];
  const said = lines.find((l) => /^the |denied|not correct|not found/i.test(l)) || lines[0];
  const text = hint ? `${said || `System error ${num}`} — ${hint}` : said || `net use exited ${code}`;
  return { text, num };
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
// until the next connect — which then fails with 1312 all over again.
async function ensureCredentialService() {
  if (!isWindows()) return;
  await run('sc', ['start', 'VaultSvc'], { channel: 'silent' });
}

const ipcOf = (server) => `\\\\${server}\\IPC$`;

// Drop the authenticated session to a server. This is the inverse operation the
// feature was missing: the session belongs to the LocalSystem LOGON, not to this
// Node process, so deleting a row or restarting the manager does not revoke
// anything — without this the access survives until the machine reboots.
async function disconnect(server, channel = CHANNEL) {
  if (!isWindows() || !server) return;
  await run('net', ['use', ipcOf(server), '/delete', '/y'], { channel });
  emitLog(channel, `[netshare] disconnected ${server}`);
}

// Revoke a share's server session unless a still-enabled row needs it. Called
// when a row is deleted or switched off, so the UI's off switch means something.
async function disconnectIfUnused(server, { exceptId } = {}, channel = CHANNEL) {
  if (!server) return;
  const stillUsed = rows().some(
    (r) => r.enabled && r.id !== exceptId && serverOf(r.unc_path) === server
  );
  if (stillUsed) {
    emitLog(channel, `[netshare] keeping the session to ${server} — another enabled share still uses it`);
    return;
  }
  await disconnect(server, channel);
}

// Authenticate against the SERVER (its IPC$ pipe), not an individual share.
// SMB keeps one session per server, so this single login covers every share on
// it — and mounting a named share directly turned out to be unreliable: on a
// real host `net use \\srv\Sign_Pic <pw>` failed with 1312 every time while
// `net use \\srv\SQLBackups_LC <pw>` with the same account succeeded, and once
// any share had authenticated, reading \\srv\Sign_Pic worked fine.
//
// The password is passed as an argument, not on stdin. `net use ... *` prompts
// by reading the console directly (CONIN$) rather than stdin, so a piped
// password is silently ignored and an EMPTY one is submitted — which fails as
// "System error 86, password is not correct", exactly like a wrong password.
// Cost: it is visible in that process's command line for the second or so
// net.exe lives. Accepted — the alternative silently does not work; run()
// redacts it from the log stream and from the output it returns.
async function connectOne(share, channel = CHANNEL) {
  if (!isWindows()) {
    return { ok: false, error: `network share credentials are a Windows feature (this host is ${process.platform})` };
  }
  const password = secretbox.decrypt(share.password_enc);
  if (password === null) {
    return { ok: false, error: 'stored password could not be decrypted — re-enter it' };
  }
  const server = serverOf(share.unc_path);
  if (!server) return { ok: false, error: 'unc_path must look like \\\\server\\share' };

  await ensureCredentialService();
  // Drop any half-open session first; a stale one makes `net use` fail with
  // "multiple connections to a server by the same user" (error 1219).
  await run('net', ['use', ipcOf(server), '/delete', '/y'], { channel: 'silent', redact: password });
  const r = await run('net', ['use', ipcOf(server), password, `/user:${share.username}`], {
    channel,
    redact: password,
  });
  if (r.code !== 0) {
    const { text, num } = explain(r.out, r.code);
    return { ok: false, error: text, code: num };
  }
  return { ok: true };
}

// Group the configured rows by the server they live on — the unit SMB actually
// authenticates.
function serverGroups() {
  const map = new Map();
  for (const share of rows()) {
    const server = serverOf(share.unc_path);
    if (!server) continue;
    if (!map.has(server)) map.set(server, []);
    map.get(server).push(share);
  }
  return map;
}

function setState(id, patch) {
  // Re-read immediately before writing: a queued pass may have updated this row
  // while we were awaiting, and a stale snapshot would walk the counter back.
  state.set(id, { ...(state.get(id) || {}), ...patch });
}

async function reconcileOnce(channel, { force }) {
  for (const [server, shares] of serverGroups()) {
    const enabled = shares.filter((s) => s.enabled);
    for (const off of shares.filter((s) => !s.enabled)) {
      setState(off.id, { ok: false, error: 'disabled', checkedAt: Date.now(), fails: 0, nextTryAt: null });
    }
    if (!enabled.length) continue;

    // One session per server means one account per server. Two enabled rows with
    // different usernames would take turns evicting each other forever, so say
    // so instead of thrashing.
    const accounts = [...new Set(enabled.map((s) => s.username.toLowerCase()))];
    if (accounts.length > 1) {
      const msg =
        `${server} has ${accounts.length} shares configured with different accounts ` +
        `(${accounts.join(', ')}). SMB allows one session per server — use the same account for all of them.`;
      for (const s of enabled) {
        setState(s.id, { ok: false, error: msg, checkedAt: Date.now(), fails: 0, nextTryAt: null });
      }
      emitLog(channel, `[netshare] ${msg}`);
      continue;
    }

    // Free, credential-free check — always runs, even while backed off, so a
    // server that comes back on its own is noticed immediately. A forced pass
    // still short-circuits here when everything already works: re-authenticating
    // a healthy server would drop a session apps are actively reading through.
    const reach = await Promise.all(enabled.map((s) => reachable(s.unc_path)));
    if (reach.every(Boolean)) {
      enabled.forEach((s) => setState(s.id, { ok: true, error: null, checkedAt: Date.now(), fails: 0, nextTryAt: null }));
      continue;
    }

    // Hold off on replaying a credential that keeps being rejected. Tracked on
    // the first row of the group — they share one login, so they share the ladder.
    const lead = enabled[0];
    const prev = state.get(lead.id) || {};
    if (!force && prev.nextTryAt && Date.now() < prev.nextTryAt) {
      enabled.forEach((s) => setState(s.id, { checkedAt: Date.now() }));
      continue;
    }

    const res = await connectOne(lead, channel);
    const after = await Promise.all(enabled.map((s) => reachable(s.unc_path)));
    const authRejected = !res.ok && AUTH_ERRORS.has(res.code);
    const fails = res.ok ? 0 : authRejected ? (force ? 1 : (prev.fails || 0) + 1) : 0;
    const wait = authRejected ? backoffFor(fails) : 0;

    enabled.forEach((s, i) => {
      const ok = res.ok && after[i];
      setState(s.id, {
        ok,
        error: ok ? null : res.error || 'authenticated, but this path is still unreadable — check the share/NTFS permissions',
        checkedAt: Date.now(),
        fails,
        nextTryAt: ok || !wait ? null : Date.now() + wait,
      });
    });

    if (res.ok && after.every(Boolean)) {
      emitLog(channel, `[netshare] ${server} connected as ${lead.username} (${enabled.length} share${enabled.length > 1 ? 's' : ''})`);
    } else {
      const mins = Math.round(wait / 60000);
      emitLog(
        channel,
        `[netshare] ${server} FAILED${authRejected ? ` (${fails}x)` : ''} — ${res.error || 'path unreadable'}` +
          (mins ? ` — not retrying for ${mins} min, so a rejected credential is not replayed into a lockout` : '')
      );
    }
  }
}

// Serialised: five call sites (the 60s timer, create, update, the reconnect
// button, and test()'s cleanup) would otherwise interleave `net use /delete` and
// `net use <auth>` against the same server, deleting each other's fresh session
// and recording the result against a stale snapshot.
let queue = Promise.resolve();
function reconcile(channel = CHANNEL, { force = false } = {}) {
  queue = queue.then(() => reconcileOnce(channel, { force })).catch((e) => {
    emitLog(channel, `[netshare] reconcile error: ${e.message}`);
  });
  return queue;
}

function status(id) {
  return state.get(id) || { ok: false, error: 'not checked yet', checkedAt: null, fails: 0, nextTryAt: null };
}

function forget(id) {
  state.delete(id);
}

// Verify a credential without saving it (the "Test" button).
//
// Connecting tears down the server's existing session first, so this always puts
// things back: awaited, so the HTTP response cannot arrive while the real mount
// is still down. If the tested server has no stored row at all, the ad-hoc
// session is dropped rather than left authenticated behind the operator's back.
async function test({ unc_path, username, password }) {
  const share = { name: 'test', unc_path, username, password_enc: secretbox.encrypt(password) };
  const server = serverOf(unc_path);
  try {
    const r = await connectOne(share);
    if (!r.ok) return r;
    if (await reachable(unc_path)) return { ok: true };
    return { ok: false, error: 'authenticated, but the path is still unreadable — check the share/NTFS permissions' };
  } finally {
    const configured = rows().some((r) => r.enabled && serverOf(r.unc_path) === server);
    if (configured) await reconcile('silent', { force: true });
    else await disconnect(server, 'silent'); // probe only — do not outlive the request
  }
}

function start() {
  if (!isWindows()) return; // nothing to mount on the dev machines
  reconcile().catch(() => {});
  setInterval(() => reconcile().catch(() => {}), 60000).unref();
}

module.exports = {
  reconcile,
  connectOne,
  disconnect,
  disconnectIfUnused,
  status,
  forget,
  test,
  start,
  reachable,
  isWindows,
  serverOf,
};
