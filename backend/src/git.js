'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const settings = require('./settings');
const { run } = require('./runner');

function repoDir(site) {
  return path.join(config.paths.sites, site.name, 'repo');
}

// Normalize a credential match value or a repo URL to `host/path` (lowercase, no
// scheme, no trailing slash, no `.git`). GitHub users/orgs share one host, so a
// credential can be scoped to an owner: 'github.com/distrotion', 'github.com/acme',
// 'dev.azure.com/myorg', or just a bare host 'github.com' as a catch-all.
function normKey(s) {
  let v = String(s || '').trim().toLowerCase();
  v = v.replace(/^[a-z]+:\/\//, ''); // strip scheme
  v = v.replace(/^[^@/]+@/, ''); // strip any user@ (ssh-ish)
  v = v.replace(/\.git$/, '').replace(/\/+$/, '');
  return v;
}

// Pick the token for a repo URL: among per-host/owner credentials whose prefix
// matches the URL, the LONGEST (most specific) wins; else the legacy shared token.
function tokenFor(url) {
  try {
    const key = normKey(url); // e.g. github.com/distrotion/back-qc
    const db = require('./db');
    const rows = db.prepare('SELECT host, token FROM git_credentials').all();
    let best = null;
    for (const r of rows) {
      const pfx = normKey(r.host);
      if (pfx && (key === pfx || key.startsWith(pfx + '/'))) {
        if (!best || pfx.length > best.len) best = { token: r.token, len: pfx.length };
      }
    }
    if (best) return best.token;
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
  const plain = site.repo_url;
  const authed = authedUrl(plain);
  const usedToken = authed !== plain;
  const opts = { channel, env: gitEnv(), redact: tokenFor(plain) || undefined };
  const isClone = !fs.existsSync(path.join(dir, '.git'));
  if (isClone) fs.mkdirSync(path.dirname(dir), { recursive: true });

  // Update = fetch + hard reset to the remote branch (not `git pull`). A plain
  // pull refuses with "local changes would be overwritten" when tracked files got
  // modified on the server — npm install touching package-lock, an app writing
  // into its own dir, or CRLF churn — making auto-deploy fail every cycle. Reset
  // --hard forces the tree to match the remote; untracked files (node_modules,
  // runtime logs) are left intact.
  const gitCmd = async (url) => {
    if (isClone) return run(config.git.exe, ['clone', '-b', branch, url, dir], opts);
    const f = await run(config.git.exe, ['-C', dir, 'fetch', url, branch], opts);
    if (f.code !== 0) return f;
    return run(config.git.exe, ['-C', dir, 'reset', '--hard', 'FETCH_HEAD'], {
      channel,
      env: gitEnv(),
    });
  };

  let r = await gitCmd(authed);
  // A public repo is readable anonymously, but a scoped/expired token injected
  // into the URL makes GitHub reject it (403 "write access not granted" — even
  // for public repos not in a fine-grained token's allowlist). Retry once with
  // no token so public repos always work regardless of token scope.
  if (r.code !== 0 && usedToken) {
    require('./logbus').emitLog(channel, '[git] auth failed — retrying without token (public repo?)');
    r = await gitCmd(plain);
  }
  // scrub any token from the stored remote so it isn't left on disk
  if (isClone && r.code === 0 && usedToken) {
    await run(config.git.exe, ['-C', dir, 'remote', 'set-url', 'origin', plain], {
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
