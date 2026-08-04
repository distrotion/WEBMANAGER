'use strict';
// CI/CD watcher: for every site with autodeploy=1 and a git source, periodically
// ask the remote for the tip commit of its branch (git ls-remote — no clone). If it
// differs from the site's last deployed commit, run a full Pull & Deploy. Local-folder
// sites are skipped (nothing to poll). One deploy per site at a time.
const config = require('./config');
const db = require('./db');
const git = require('./git');
const settings = require('./settings');
const deploy = require('./deploy');
const { run } = require('./runner');
const deploylock = require('./deploylock');
const { emitLog } = require('./logbus');

// Tip commit (full sha) of the site's branch on the remote, or null on failure.
async function remoteHead(site) {
  const url = git.authedUrl(site.repo_url);
  const branch = site.branch || 'main';
  const r = await run(config.git.exe, ['ls-remote', url, branch], {
    channel: 'silent',
    env: git.gitEnv(),
    redact: git.tokenFor(site.repo_url) || undefined,
  });
  if (r.code !== 0) return null;
  return (r.out || '').trim().split(/\s+/)[0] || null;
}

// last_commit comes from `git rev-parse --short`, whose length VARIES (7, 8, …
// chars — git extends it when a shorter prefix would be ambiguous). Comparing at
// a fixed length caused endless "new commit" redeploys every tick, so compare as
// prefixes instead.
function sameCommit(a, b) {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  return n >= 7 && a.slice(0, n) === b.slice(0, n);
}

async function checkOne(site) {
  if (!site.autodeploy || site.source_type !== 'git' || !site.repo_url) return;
  if (deploylock.held(site.id)) return; // a manual deploy/rollback is running
  const channel = `site-${site.id}`;
  const remote = await remoteHead(site);
  if (!remote) return; // network / auth issue — try again next tick
  if (sameCommit(remote, site.last_commit)) return; // up to date
  // A commit that already FAILED THE HEALTH GATE is deterministic — redeploying
  // it would just bounce the rolled-back app (npm install + restart) every tick.
  // Skip it until a new commit lands. Git/network failures are NOT skipped:
  // those can be transient and should keep retrying.
  const last = db
    .prepare('SELECT ok, to_commit, message FROM autodeploy_log WHERE site_id=? ORDER BY id DESC LIMIT 1')
    .get(site.id);
  if (last && !last.ok && /step health/.test(last.message || '') && sameCommit(remote, last.to_commit)) {
    return; // this exact commit already failed health — waiting for a fix commit
  }
  // Take the shared lock only once we've decided to deploy — the manual button
  // and rollback use the same one, so they can never overlap with this.
  const releaseLock = deploylock.acquire(site.id, 'auto-deploy');
  if (!releaseLock) return; // someone grabbed it between the check and here
  emitLog(channel, `[auto-deploy] new commit ${remote.slice(0, 8)} (deployed ${site.last_commit || 'none'}) — deploying`);
  let ok = true;
  let message = '';
  try {
    const user = { username: 'auto-deploy' };
    const r = site.runtime === 'static'
      ? await deploy.deployStatic(site, user)
      : await deploy.deployNode(site, user);
    ok = !!(r && r.ok);
    if (!ok) {
      message = `deploy failed at step ${r && r.step ? r.step : '?'}`;
      if (r && r.rolledBack) message += ' — rolled back to previous version';
    }
  } catch (e) {
    ok = false;
    message = e.message;
    emitLog(channel, `[auto-deploy] failed: ${e.message}`);
  } finally {
    releaseLock();
    try {
      db.prepare(
        `INSERT INTO autodeploy_log (site_id, site_name, from_commit, to_commit, ok, message)
         VALUES (?,?,?,?,?,?)`
      ).run(site.id, site.name, site.last_commit || null, remote.slice(0, 8), ok ? 1 : 0, message || null);
    } catch {
      /* logging must never break the watcher */
    }
  }
}

async function tick() {
  let sites;
  try {
    sites = db.prepare('SELECT * FROM sites WHERE autodeploy=1').all();
  } catch {
    return;
  }
  for (const s of sites) {
    try {
      await checkOne(s);
    } catch {
      /* keep going with the next site */
    }
  }
}

// Poll interval in minutes (settings key autodeploy_interval_min, default 3, min 1).
function intervalMs() {
  const m = parseInt(settings.get('autodeploy_interval_min'), 10);
  return Math.max(1, Number.isFinite(m) ? m : 3) * 60 * 1000;
}

function start() {
  const loop = () => tick().catch(() => {});
  setTimeout(function run() {
    loop();
    setTimeout(run, intervalMs());
  }, intervalMs()).unref();
}

module.exports = { start, tick, checkOne, remoteHead, sameCommit };
