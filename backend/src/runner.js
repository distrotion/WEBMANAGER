'use strict';
const { spawn } = require('child_process');
const { emitLog } = require('./logbus');

// Spawn a command and stream stdout/stderr line-by-line to the given log channel.
// Resolves with { code, out } — never rejects, so callers can branch on exit code.
// `redact` (a secret string) is masked BOTH in what is streamed to the log and in
// the returned `out`. Masking only the stream was a leak: a caller that builds an
// error message out of `out` and logs it puts the secret straight back into the
// log it was redacted from — and net.exe echoes an argument it fails to parse
// (a password starting with `-` or `/`) into its own error text.
// `stdin` is written to the child then closed — use it for secrets, so they never
// appear in the command line (which any process on the box can read).
// Nothing here may run forever. Every caller of run() is inside a job that holds
// a lock — the per-site deploy lock — released in a `.finally`, which only runs
// when the promise settles. A `git fetch` stalled on a dead network route, or an
// npm that sits waiting on a prompt, therefore did not merely hang one deploy:
// it held that site's lock for the life of the process, and every later
// "Pull & Deploy" answered 409 with nothing on screen to say why. Restarting the
// whole manager was the only way out.
//
// 15 minutes is deliberately generous — a real `npm install` on this codebase is
// well under it — so the timeout only ever fires on something genuinely stuck,
// and when it does the command fails loudly like any other failure.
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

// child.kill() on Windows kills the shell we spawned, not the npm/git it
// launched, so the real work would keep running unseen. taskkill /T ends the
// whole tree. The promise settles either way — that is what frees the lock.
function killTree(child, channel, mask) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch (e) {
    emitLog(channel, mask(`[error] ฆ่าโปรเซสที่ค้างไม่สำเร็จ: ${e.message}`));
  }
}

function run(cmd, args, { cwd, channel = 'system', env, redact, shell, stdin, timeoutMs } = {}) {
  const mask = (s) => (redact ? s.split(redact).join('***') : s);
  const limitMs = Math.max(1000, timeoutMs || DEFAULT_TIMEOUT_MS);
  return new Promise((resolve) => {
    emitLog(channel, mask(`$ ${cmd} ${args.join(' ')}`));
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        // shell:true is needed to run .cmd/.bat (e.g. npm) on Windows/Node 20+
        // where spawning them directly throws EINVAL.
        shell: !!shell,
      });
    } catch (e) {
      emitLog(channel, mask(`[error] ${e.message}`));
      return resolve({ code: -1, error: mask(e.message), out: '' });
    }
    if (stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        /* child exited before reading — the exit code is the real signal */
      });
      child.stdin.end(stdin);
    }
    let out = '';
    const onData = (buf) => {
      const s = mask(buf.toString()); // mask once, at the boundary
      out += s;
      for (const line of s.split(/\r?\n/)) if (line.length) emitLog(channel, line);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    // Resolve at most once: a killed child fires 'close' after the timeout has
    // already answered, and a second resolve would be silently ignored — but
    // clearing the timer here is what stops it from firing after a clean exit.
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // Read by an operator, so say "90 วินาที" rather than "2 นาที" — and never
    // "0 นาที", which is what rounding a short limit produced.
    const forHumans =
      limitMs >= 60_000 ? `${Math.round(limitMs / 60_000)} นาที` : `${Math.round(limitMs / 1000)} วินาที`;
    const timer = setTimeout(() => {
      emitLog(channel, mask(`[timeout] ไม่จบใน ${forHumans} — ยกเลิกคำสั่งนี้`));
      killTree(child, channel, mask);
      finish({ code: -1, timedOut: true, error: `คำสั่งค้างเกิน ${forHumans}`, out });
    }, limitMs);

    child.on('error', (e) => {
      emitLog(channel, mask(`[error] ${e.message}`));
      finish({ code: -1, error: mask(e.message), out });
    });
    child.on('close', (code) => {
      emitLog(channel, `[exit ${code}]`);
      finish({ code, out });
    });
  });
}

module.exports = { run };
