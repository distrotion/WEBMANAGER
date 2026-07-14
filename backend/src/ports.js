'use strict';
// Who holds a port + kill it. Windows: netstat/tasklist/taskkill; unix: lsof/kill.
// Safety: never kills this manager's own process, PID <= 4 (Windows System/Idle),
// and reports PM2-managed wm-* apps so the UI can warn (PM2 revives them).
const { run } = require('./runner');

const isWin = process.platform === 'win32';

async function whoOnPort(port) {
  const out = [];
  if (isWin) {
    const r = await run('netstat', ['-ano'], { channel: 'silent' });
    for (const line of (r.out || '').split(/\r?\n/)) {
      const c = line.trim().split(/\s+/);
      // TCP local foreign state pid | UDP local foreign pid
      if (c.length < 4 || (c[0] !== 'TCP' && c[0] !== 'UDP')) continue;
      if (!c[1].endsWith(`:${port}`)) continue;
      const pid = parseInt(c[c.length - 1], 10);
      const state = c[0] === 'TCP' ? c[3] : 'UDP';
      if (c[0] === 'TCP' && state !== 'LISTENING') continue;
      if (!Number.isFinite(pid) || out.some((x) => x.pid === pid)) continue;
      out.push({ pid, proto: state });
    }
    for (const p of out) {
      const t = await run('tasklist', ['/fi', `PID eq ${p.pid}`, '/fo', 'csv', '/nh'], { channel: 'silent' });
      const m = (t.out || '').match(/^"([^"]+)"/m);
      p.name = m ? m[1] : 'unknown';
    }
  } else {
    const r = await run('lsof', ['-nP', `-i:${port}`, '-Fpcn'], { channel: 'silent' });
    let pid = null;
    let name = '';
    for (const line of (r.out || '').split(/\n/)) {
      if (line.startsWith('p')) pid = parseInt(line.slice(1), 10);
      if (line.startsWith('c')) {
        name = line.slice(1);
        if (pid && !out.some((x) => x.pid === pid)) out.push({ pid, name, proto: '' });
      }
    }
  }
  return out;
}

async function killPort(port) {
  const procs = await whoOnPort(port);
  const results = [];
  for (const p of procs) {
    if (p.pid === process.pid) {
      results.push({ ...p, killed: false, reason: 'this is the webmanager itself' });
      continue;
    }
    if (p.pid <= 4) {
      results.push({ ...p, killed: false, reason: 'system process' });
      continue;
    }
    const r = isWin
      ? await run('taskkill', ['/F', '/PID', String(p.pid)], { channel: 'silent' })
      : await run('kill', ['-9', String(p.pid)], { channel: 'silent' });
    results.push({ ...p, killed: r.code === 0 });
  }
  return results;
}

module.exports = { whoOnPort, killPort };
