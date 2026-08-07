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

// CI stages: build then test, run in the repo before anything is published or
// restarted. A failure here aborts the deploy while the previous version is
// still serving — cheaper than the health gate, which only catches a bad build
// AFTER the app has been swapped and has to be rolled back.
// Empty setting = stage skipped, so existing sites are unaffected.
async function ciStage(site, label, command, cwd, channel) {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: true, skipped: true };
  emitLog(channel, `[${label}] ${cmd}`);
  const r = await run(cmd, [], { cwd, channel, shell: true });
  if (r.code !== 0) {
    emitLog(channel, `[${label}] FAILED (exit ${r.code}) — deploy aborted, current version left running`);
    return { ok: false };
  }
  emitLog(channel, `[${label}] passed`);
  return { ok: true };
}

// Run both CI stages; returns the failing step name, or null when all passed.
async function runCi(site, cwd, channel) {
  const build = await ciStage(site, 'build', site.build_command, cwd, channel);
  if (!build.ok) return 'build';
  const test = await ciStage(site, 'test', site.test_command, cwd, channel);
  if (!test.ok) return 'test';
  return null;
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

  // CI gate before publishing: a failing build/test leaves the live release untouched.
  const ciFail = await runCi(site, source, channel);
  if (ciFail) {
    db.prepare('UPDATE sites SET status=? WHERE id=?').run('error', site.id);
    require('./notify').fire({ site: site.name, ok: false, step: ciFail, by: (user && user.username) || 'system' });
    return { ok: false, step: ciFail };
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

  // CI gate before restarting: catches a bad commit while the current process is
  // still serving, instead of relying on the health gate + rollback afterwards.
  const ciFail = await runCi(site, repoDir, channel);
  if (ciFail) {
    db.prepare('UPDATE sites SET status=? WHERE id=?').run('error', site.id);
    require('./notify').fire({ site: site.name, ok: false, step: ciFail, by: (user && user.username) || 'system' });
    return { ok: false, step: ciFail };
  }

  await pm2.restart(site, channel); // starts on first run

  // --- health gate: the new code must actually answer before we call it done.
  // On failure, roll back ONE step to the previously deployed commit (still in
  // the local git objects) and stop there — no cascading walk into history.
  const health = await require('./health').waitHealthy(site, channel);
  // 'warn' mode: report the failure and leave the new version running. The
  // operator asked to be told, not corrected — used to watch how the probe
  // behaves for a site before trusting it to revert anything.
  let warned = false;
  if (!health.ok && health.mode === 'warn') {
    warned = true;
    emitLog(channel, '[health] NOT answering — site is set to "warn", so the new version is LEFT RUNNING (no rollback)');
    require('./notify').fire({
      site: site.name,
      ok: false,
      step: 'health-warn',
      commit,
      by: (user && user.username) || 'system',
    });
  }
  if (!health.ok && !warned) {
    const prev = site.last_commit; // commit that was running before this deploy
    if (site.source_type === 'git' && prev) {
      emitLog(channel, `[rollback] health failed — rolling back to ${prev}`);
      const rb = await run(config.git.exe, ['-C', repoDir, 'reset', '--hard', prev], {
        channel,
        env: git.gitEnv(),
      });
      if (rb.code === 0) {
        if (fs.existsSync(path.join(repoDir, 'package.json'))) {
          emitLog(channel, '[rollback] npm install --omit=dev');
          await run('npm', ['install', '--omit=dev'], { cwd: repoDir, channel, shell: true });
        }
        await pm2.restart(site, channel);
        const again = await require('./health').waitHealthy(site, channel);
        db.prepare('UPDATE sites SET status=? WHERE id=?').run(again.ok ? 'rolled-back' : 'error', site.id);
        audit(user, 'rollback', site.name, prev);
        emitLog(
          channel,
          again.ok
            ? `=== Rolled back to ${prev} — new commit failed health check ===`
            : '=== Rollback also unhealthy — manual attention needed ==='
        );
        require('./notify').fire({
          site: site.name,
          ok: false,
          step: 'health',
          commit: prev,
          rolledBack: again.ok,
          by: (user && user.username) || 'system',
        });
        return { ok: false, step: 'health', rolledBack: again.ok };
      }
    }
    db.prepare('UPDATE sites SET status=? WHERE id=?').run('error', site.id);
    emitLog(channel, '=== Deploy failed health check (no previous version to roll back to) ===');
    require('./notify').fire({
      site: site.name,
      ok: false,
      step: 'health',
      by: (user && user.username) || 'system',
    });
    return { ok: false, step: 'health' };
  }

  // A node app is reached directly on its port. Only touch nginx if it's also
  // exposed via a front (subdomain/path proxy).
  if (site.exposure_mode) {
    nginx.rebuildFront();
    const t = await nginx.test(channel);
    if (t.code === 0) await nginx.reload(channel);
  }
  // open the app's direct port in the firewall for LAN access
  if (site.direct_port) await require('./firewall').openPort(site.direct_port, channel);
  // 'unhealthy' = deployed and left running, but the probe never got an answer
  // (warn mode). Distinct from 'running' so it is visible, and from 'error' so
  // it is clear the site was not taken down.
  db.prepare(
    `UPDATE sites SET status=?, last_commit=?, last_deploy_at=datetime('now') WHERE id=?`
  ).run(warned ? 'unhealthy' : 'running', commit, site.id);
  db.prepare('INSERT INTO releases (site_id, timestamp, commit_hash, deployed_by) VALUES (?,?,?,?)').run(
    site.id, tsName(), commit, (user && user.username) || 'system'
  );
  audit(user, 'deploy', site.name, commit);
  emitLog(channel, `=== Done (${commit || 'no-commit'})${warned ? ' — health warning, see above' : ''} ===`);
  return { ok: true, commit, warned };
}

// Roll back on purpose (a button, not a health failure) to a release already in
// the history. The two runtimes keep their versions in different places: a
// static site has the actual files in releases/<ts>, so the junction just points
// back; a node app runs straight from the repo, so we check out that commit and
// reinstall. Either way the CI stages are NOT re-run — this version passed them
// when it was first deployed, and re-running them could fail on a moved
// dependency and leave the site with nothing to serve.
async function rollbackTo(site, release, user) {
  const channel = `site-${site.id}`;
  emitLog(channel, `=== Rollback ${site.name} -> ${release.commit_hash || release.timestamp} ===`);

  if (site.runtime === 'static') {
    const releaseDir = path.join(config.paths.sites, site.name, 'releases', release.timestamp);
    if (!fs.existsSync(releaseDir)) {
      emitLog(channel, `[rollback] release folder is gone: releases/${release.timestamp}`);
      return { ok: false, step: 'missing-release' };
    }
    await swapCurrent(site, releaseDir, channel);
    nginx.writePortConf(site);
    nginx.rebuildFront();
    const t = await nginx.test(channel);
    if (t.code !== 0) {
      emitLog(channel, '[rollback] nginx -t failed');
      return { ok: false, step: 'nginx-t' };
    }
    await nginx.reload(channel);
    db.prepare(
      `UPDATE sites SET status='running', current_release=?, last_commit=?, last_deploy_at=datetime('now') WHERE id=?`
    ).run(release.timestamp, release.commit_hash, site.id);
  } else {
    if (!release.commit_hash) {
      emitLog(channel, '[rollback] this release has no commit recorded');
      return { ok: false, step: 'no-commit' };
    }
    const dir = git.repoDir(site);
    const r = await run(config.git.exe, ['-C', dir, 'reset', '--hard', release.commit_hash], {
      channel,
      env: git.gitEnv(),
    });
    if (r.code !== 0) {
      emitLog(channel, '[rollback] git reset failed — is that commit still in the local repo?');
      return { ok: false, step: 'git' };
    }
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      emitLog(channel, '[rollback] npm install --omit=dev');
      await run('npm', ['install', '--omit=dev'], { cwd: dir, channel, shell: true });
    }
    await require('./pm2').restart(site, channel);
    const health = await require('./health').waitHealthy(site, channel);
    if (!health.ok) {
      db.prepare('UPDATE sites SET status=? WHERE id=?').run('error', site.id);
      emitLog(channel, '=== Rollback target is also unhealthy — manual attention needed ===');
      require('./notify').fire({
        site: site.name,
        ok: false,
        step: 'health',
        commit: release.commit_hash,
        by: (user && user.username) || 'system',
      });
      return { ok: false, step: 'health' };
    }
    db.prepare(
      `UPDATE sites SET status='running', last_commit=?, last_deploy_at=datetime('now') WHERE id=?`
    ).run(release.commit_hash, site.id);
  }

  db.prepare('INSERT INTO releases (site_id, timestamp, commit_hash, deployed_by, note) VALUES (?,?,?,?,?)').run(
    site.id,
    tsName(),
    release.commit_hash,
    (user && user.username) || 'system',
    `rollback to ${release.timestamp}`
  );
  audit(user, 'rollback-manual', site.name, release.commit_hash || release.timestamp);
  require('./notify').fire({
    site: site.name,
    ok: true,
    commit: release.commit_hash || release.timestamp,
    rolledBack: true,
    by: (user && user.username) || 'system',
  });
  emitLog(channel, `=== Rolled back (${release.commit_hash || release.timestamp}) ===`);
  return { ok: true, commit: release.commit_hash };
}

module.exports = { deployStatic, deployNode, swapCurrent, tsName, rollbackTo, runCi };
