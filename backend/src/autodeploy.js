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
const { emitLog } = require('./logbus');

const inFlight = new Set(); // site ids currently deploying

// Tip commit (full sha) of the site's branch on the remote, or null on failure.
async function remoteHead(site) {
  const url = git.authedUrl(site.repo_url);
  const branch = site.branch || 'main';
  const r = await run(config.git.exe, ['ls-remote', url, branch], {
    channel: 'silent',
    env: git.gitEnv(),
    redact: settings.get('git_token') || undefined,
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
  if (inFlight.has(site.id)) return;
  const channel = `site-${site.id}`;
  const remote = await remoteHead(site);
  if (!remote) return; // network / auth issue — try again next tick
  if (sameCommit(remote, site.last_commit)) return; // up to date
  inFlight.add(site.id);
  emitLog(channel, `[auto-deploy] new commit ${remote.slice(0, 8)} (deployed ${site.last_commit || 'none'}) — deploying`);
  try {
    const user = { username: 'auto-deploy' };
    if (site.runtime === 'static') await deploy.deployStatic(site, user);
    else await deploy.deployNode(site, user);
  } catch (e) {
    emitLog(channel, `[auto-deploy] failed: ${e.message}`);
  } finally {
    inFlight.delete(site.id);
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
