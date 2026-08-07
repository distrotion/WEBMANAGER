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

// Authenticate the SMB session for one share. The password goes in on stdin
// (`net use ... *` prompts for it) so it never lands in the command line, where
// any process on the machine could read it.
async function connectOne(share, channel = CHANNEL) {
  if (!isWindows()) {
    return { ok: false, error: 'network share credentials are a Windows feature (this host is ' + process.platform + ')' };
  }
  const password = secretbox.decrypt(share.password_enc);
  if (password === null) {
    return { ok: false, error: 'stored password could not be decrypted — re-enter it' };
  }
  // Drop any half-open session first; a stale one makes `net use` fail with
  // "multiple connections to a server by the same user" (error 1219).
  await run('net', ['use', share.unc_path, '/delete', '/y'], { channel: 'silent' });
  const r = await run('net', ['use', share.unc_path, '/user:' + share.username, '*'], {
    channel,
    redact: password,
    stdin: password + '\r\n',
  });
  if (r.code !== 0) {
    const detail = (r.out || '').split(/\r?\n/).find((l) => /error|denied|password|1219|53|67/i.test(l));
    return { ok: false, error: (detail || `net use exited ${r.code}`).trim() };
  }
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
async function test({ unc_path, username, password }) {
  const share = { name: 'test', unc_path, username, password_enc: secretbox.encrypt(password) };
  const r = await connectOne(share);
  if (!r.ok) return r;
  if (await reachable(unc_path)) return { ok: true };
  return { ok: false, error: 'authenticated, but the path is still unreadable — check the share/NTFS permissions' };
}

function start() {
  if (!isWindows()) return; // nothing to mount on the dev machines
  reconcile().catch(() => {});
  setInterval(() => reconcile().catch(() => {}), 60000).unref();
}

module.exports = { reconcile, connectOne, status, test, start, reachable, isWindows };
