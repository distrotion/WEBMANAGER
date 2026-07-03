'use strict';
const { spawn } = require('child_process');
const { emitLog } = require('./logbus');

// Spawn a command and stream stdout/stderr line-by-line to the given log channel.
// Resolves with { code, out } — never rejects, so callers can branch on exit code.
function run(cmd, args, { cwd, channel = 'system', env } = {}) {
  return new Promise((resolve) => {
    emitLog(channel, `$ ${cmd} ${args.join(' ')}`);
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
      });
    } catch (e) {
      emitLog(channel, `[error] ${e.message}`);
      return resolve({ code: -1, error: e.message, out: '' });
    }
    let out = '';
    const onData = (buf) => {
      const s = buf.toString();
      out += s;
      for (const line of s.split(/\r?\n/)) if (line.length) emitLog(channel, line);
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
