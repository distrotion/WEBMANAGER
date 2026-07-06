'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const git = require('./git');
const nginx = require('./nginx');
const { run } = require('./runner');
const { emitLog } = require('./logbus');
const { audit } = require('./audit');

function tsName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

// Atomic pointer swap: junction on Windows, symlink elsewhere (dev).
async function swapCurrent(site, releaseDir, channel) {
  const cur = path.join(config.paths.sites, site.name, 'current');
  try {
    fs.rmSync(cur, { recursive: true, force: true });
  } catch {
    /* nothing to remove */
  }
  if (process.platform === 'win32') {
    await run('cmd', ['/c', 'mklink', '/J', cur, releaseDir], { channel });
  } else {
    fs.symlinkSync(releaseDir, cur, 'dir');
    emitLog(channel, `[deploy] symlink current -> ${releaseDir}`);
  }
}

function copyRelease(srcRepo, destRelease) {
  fs.mkdirSync(destRelease, { recursive: true });
  fs.cpSync(srcRepo, destRelease, {
    recursive: true,
    filter: (s) => !s.split(path.sep).includes('.git'),
  });
}

// Publish a static *_deploy source (git repo OR a local folder) as a new release.
async function deployStatic(site, user) {
  const channel = `site-${site.id}`;
  emitLog(channel, `=== Deploy ${site.name} ===`);

  const isLocal = site.source_type === 'local';
  let source;
  let commit = null;

  if (isLocal) {
    if (!site.local_path || !fs.existsSync(site.local_path)) {
      emitLog(channel, `[deploy] local path not found: ${site.local_path}`);
      db.prepare('UPDATE sites SET status=? WHERE id=?').run('error', site.id);
      return { ok: false, step: 'config' };
    }
    emitLog(channel, `[deploy] local source ${site.local_path}`);
    source = site.local_path;
  } else {
    if (!site.repo_url) {
      emitLog(channel, '[deploy] no repo_url set, abort');
      return { ok: false, step: 'config' };
    }
    const pull = await git.ensureRepo(site, channel);
    if (pull.code !== 0) {
      emitLog(channel, '[deploy] git failed, abort');
      db.prepare('UPDATE sites SET status=? WHERE id=?').run('error', site.id);
      return { ok: false, step: 'git' };
    }
    commit = await git.currentCommit(site);
    source = git.repoDir(site);
  }

  const ts = tsName();
  const releaseDir = path.join(config.paths.sites, site.name, 'releases', ts);
  emitLog(channel, `[deploy] copy source -> releases/${ts}`);
  copyRelease(source, releaseDir);

  await swapCurrent(site, releaseDir, channel);

  nginx.writePortConf(site);
  nginx.rebuildFront();

  const t = await nginx.test(channel);
  if (t.code !== 0) {
    emitLog(channel, '[deploy] nginx -t failed — skipping reload (fix config)');
    db.prepare('UPDATE sites SET status=? WHERE id=?').run('error', site.id);
    return { ok: false, step: 'nginx-t' };
  }
  await nginx.reload(channel);

  // open the direct port in the firewall so LAN machines can reach it
  if (site.direct_port && site.direct_port_enabled) {
    await require('./firewall').openPort(site.direct_port, channel);
  }

  db.prepare(
    `UPDATE sites SET status='running', current_release=?, last_commit=?, last_deploy_at=datetime('now') WHERE id=?`
  ).run(ts, commit, site.id);
  db.prepare(
    'INSERT INTO releases (site_id, timestamp, commit_hash, deployed_by) VALUES (?,?,?,?)'
  ).run(site.id, ts, commit, (user && user.username) || 'system');
  audit(user, 'deploy', site.name, commit);

  emitLog(channel, `=== Done (${commit || 'no-commit'}) ===`);
  return { ok: true, ts, commit };
}

// Get a node backend's code (git pull OR copy local folder), install deps, and
// (re)start its PM2 process. Runs from sites/<name>/repo.
async function deployNode(site, user) {
  const pm2 = require('./pm2');
  const channel = `site-${site.id}`;
  emitLog(channel, `=== Deploy ${site.name} (node) ===`);
  const repoDir = git.repoDir(site);
  let commit = null;

  if (site.source_type === 'local') {
    if (!site.local_path || !fs.existsSync(site.local_path)) {
      emitLog(channel, `[deploy] local path not found: ${site.local_path}`);
      db.prepare('UPDATE sites SET status=? WHERE id=?').run('error', site.id);
      return { ok: false, step: 'config' };
    }
    emitLog(channel, `[deploy] local source ${site.local_path}`);
    fs.mkdirSync(repoDir, { recursive: true });
    fs.cpSync(site.local_path, repoDir, {
      recursive: true,
      filter: (s) => {
        const parts = s.split(path.sep);
        return !parts.includes('.git') && !parts.includes('node_modules');
      },
    });
  } else {
    if (!site.repo_url) {
      emitLog(channel, '[deploy] no repo_url set, abort');
      return { ok: false, step: 'config' };
    }
    const pull = await git.ensureRepo(site, channel);
    if (pull.code !== 0) {
      db.prepare('UPDATE sites SET status=? WHERE id=?').run('error', site.id);
      return { ok: false, step: 'git' };
    }
    commit = await git.currentCommit(site);
  }

  if (fs.existsSync(path.join(repoDir, 'package.json'))) {
    emitLog(channel, '[deploy] npm install --omit=dev');
    await run('npm', ['install', '--omit=dev'], { cwd: repoDir, channel, shell: true });
  }
  await pm2.restart(site, channel); // starts on first run
  nginx.rebuildFront();
  const t = await nginx.test(channel);
  if (t.code === 0) await nginx.reload(channel);
  db.prepare(
    `UPDATE sites SET status='running', last_commit=?, last_deploy_at=datetime('now') WHERE id=?`
  ).run(commit, site.id);
  db.prepare('INSERT INTO releases (site_id, timestamp, commit_hash, deployed_by) VALUES (?,?,?,?)').run(
    site.id, tsName(), commit, (user && user.username) || 'system'
  );
  audit(user, 'deploy', site.name, commit);
  emitLog(channel, `=== Done (${commit || 'no-commit'}) ===`);
  return { ok: true, commit };
}

module.exports = { deployStatic, deployNode, swapCurrent, tsName };
