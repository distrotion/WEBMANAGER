'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const settings = require('./settings');
const { run } = require('./runner');

function repoDir(site) {
  return path.join(config.paths.sites, site.name, 'repo');
}

// Pick the token for a repo URL: a per-host credential whose host matches the
// URL's host wins; otherwise the legacy single shared token (git_token).
function tokenFor(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const db = require('./db');
    const rows = db.prepare('SELECT host, token FROM git_credentials').all();
    const hit = rows.find((r) => {
      const h = String(r.host).toLowerCase();
      return host === h || host.endsWith('.' + h);
    });
    if (hit) return hit.token;
  } catch {
    /* not a parseable URL / no table yet */
  }
  return settings.get('git_token');
}

// Any token configured at all (for masking in logs).
function anyToken() {
  try {
    const db = require('./db');
    const r = db.prepare('SELECT token FROM git_credentials LIMIT 1').get();
    if (r) return r.token;
  } catch {
    /* ignore */
  }
  return settings.get('git_token');
}

// Inject a PAT into https URLs so private repos work without an interactive prompt.
// SSH / non-https URLs are returned unchanged (use a deploy key + agent for those).
function authedUrl(url) {
  const t = tokenFor(url);
  if (t && /^https:\/\//i.test(url)) {
    return url.replace(/^https:\/\//i, `https://x-access-token:${t}@`);
  }
  return url;
}

// Never let git block on a credential prompt — fail fast with a clear error.
// We KEEP the machine's credential helper (osxkeychain / git-credential-store /
// Windows Git Credential Manager) so that a server already logged into git just
// works with no token setup. GIT_TERMINAL_PROMPT=0 turns a *missing* credential
// into a fast error instead of a hang. A panel token (authedUrl) overrides these.
function gitEnv() {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
  };
}

// Clone if missing, otherwise pull. The token is passed on the command line for
// this invocation only (not saved to .git/config) and masked from the log stream.
async function ensureRepo(site, channel) {
  const dir = repoDir(site);
  const branch = site.branch || 'main';
  const url = authedUrl(site.repo_url);
  const opts = { channel, env: gitEnv(), redact: tokenFor(site.repo_url) || undefined };

  if (fs.existsSync(path.join(dir, '.git'))) {
    return run(config.git.exe, ['-C', dir, 'pull', url, branch], opts);
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = await run(config.git.exe, ['clone', '-b', branch, url, dir], opts);
  // scrub any token from the stored remote so it isn't left on disk
  if (r.code === 0 && url !== site.repo_url) {
    await run(config.git.exe, ['-C', dir, 'remote', 'set-url', 'origin', site.repo_url], {
      channel: 'silent',
      env: gitEnv(),
    });
  }
  return r;
}

async function currentCommit(site) {
  const dir = repoDir(site);
  const r = await run(config.git.exe, ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
    channel: `site-${site.id}`,
  });
  return (r.out || '').trim();
}

// Validate access to a repo URL (used by the credentials test button).
function lsRemote(url, channel) {
  return run(config.git.exe, ['ls-remote', authedUrl(url)], {
    channel,
    env: gitEnv(),
    redact: tokenFor(url) || undefined,
  });
}

module.exports = { repoDir, ensureRepo, currentCommit, authedUrl, gitEnv, lsRemote, tokenFor, anyToken };
