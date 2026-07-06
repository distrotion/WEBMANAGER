'use strict';
const { spawn } = require('child_process');
const { emitLog } = require('./logbus');

// Spawn a command and stream stdout/stderr line-by-line to the given log channel.
// Resolves with { code, out } — never rejects, so callers can branch on exit code.
// `redact` (a secret string) is masked in everything shown/streamed to the log.
function run(cmd, args, { cwd, channel = 'system', env, redact, shell } = {}) {
  const mask = (s) => (redact ? s.split(redact).join('***') : s);
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
      return resolve({ code: -1, error: e.message, out: '' });
    }
    let out = '';
    const onData = (buf) => {
      const s = buf.toString();
      out += s;
      for (const line of s.split(/\r?\n/)) if (line.length) emitLog(channel, mask(line));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      emitLog(channel, `[error] ${e.message}`);
      resolve({ code: -1, error: e.message, out });
    });
    child.on('close', (code) => {
      emitLog(channel, `[exit ${code}]`);
      resolve({ code, out });
    });
  });
}

module.exports = { run };
