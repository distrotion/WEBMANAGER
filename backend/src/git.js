'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { run } = require('./runner');

function repoDir(site) {
  return path.join(config.paths.sites, site.name, 'repo');
}

// Clone if missing, otherwise pull. Streams to the site log channel.
async function ensureRepo(site, channel) {
  const dir = repoDir(site);
  const branch = site.branch || 'main';
  if (fs.existsSync(path.join(dir, '.git'))) {
    return run(config.git.exe, ['-C', dir, 'pull', 'origin', branch], { channel });
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  return run(config.git.exe, ['clone', '-b', branch, site.repo_url, dir], { channel });
}

async function currentCommit(site) {
  const dir = repoDir(site);
  const r = await run(config.git.exe, ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
    channel: `site-${site.id}`,
  });
  return (r.out || '').trim();
}

module.exports = { repoDir, ensureRepo, currentCommit };
