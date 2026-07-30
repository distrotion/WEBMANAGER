'use strict';
// Central authorization guard + input validation for anything that reaches the
// OS (git transport, process launch, filesystem paths, generated nginx config).
//
// Threat model: this manager runs as LocalSystem/root. Deploying is by nature
// code execution (npm runs postinstall from the deployed repo), so every route
// that deploys, launches, or configures must be admin-only — a logged-in
// non-admin is NOT a trusted operator. Reads stay open to any signed-in user so
// the 'user' role remains useful as a monitoring view.

// Any authenticated admin. Used on every state-changing route.
const adminOnly = (req, res, next) =>
  req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'admin only' });

// ---- input validation ----------------------------------------------------
// Each returns an error string, or null when the value is acceptable.

// A site name becomes a folder under sites/ and (on Windows) an argument to
// `cmd /c mklink`. '..' passed the old charset check and made deploy's
// rmSync(sites/<name>/current) delete outside the sites tree.
function siteName(v) {
  const s = String(v || '');
  if (!s) return 'name required';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s)) {
    return 'name must start with a letter/number and contain only letters, numbers, . _ -';
  }
  if (s === '.' || s === '..' || s.includes('..')) return 'name may not contain ".."';
  if (s.length > 64) return 'name too long (max 64)';
  return null;
}

// git treats some URLs as "run this command": `ext::sh -c <cmd>` spawns a shell,
// and a leading '-' is parsed as an option (--upload-pack=<cmd>). Allow only the
// transports we actually use.
function repoUrl(v) {
  const s = String(v || '').trim();
  if (!s) return null; // optional — the caller decides whether it is required
  if (s.startsWith('-')) return 'repo URL may not start with "-"';
  if (/^(https?|ssh|git):\/\//i.test(s) || /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/.test(s)) {
    if (/[\r\n\0]/.test(s)) return 'repo URL may not contain newlines';
    return null;
  }
  return 'repo URL must be https://, ssh://, or user@host:path (ext:: and local transports are not allowed)';
}

// A branch/ref is also a positional git argument.
function branch(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (s.startsWith('-')) return 'branch may not start with "-"';
  if (!/^[A-Za-z0-9._\-/]+$/.test(s)) return 'branch contains invalid characters';
  return null;
}

// entry_file is joined onto the repo dir and launched by PM2 — traversal would
// run any .js on the disk as a permanent, reboot-surviving process.
function entryFile(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (s.includes('..')) return 'entry file may not contain ".."';
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(s)) return 'entry file must be relative to the repo';
  if (/[\r\n\0]/.test(s)) return 'entry file may not contain newlines';
  return null;
}

// A local source folder is copied wholesale into a release and then served by
// nginx — pointing it at the data dir would publish the SQLite DB (password
// hashes, git tokens) over HTTP. Only an absolute path, and never inside the
// manager's own root.
function localPath(v, managerRoot) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/[\r\n\0]/.test(s)) return 'local path may not contain newlines';
  const path = require('path');
  if (!path.isAbsolute(s)) return 'local path must be absolute';
  const norm = path.resolve(s).toLowerCase();
  const root = path.resolve(managerRoot).toLowerCase();
  if (norm === root || norm.startsWith(root + path.sep)) {
    return 'local path may not point inside the webmanager root (it holds the database and tokens)';
  }
  return null;
}

// subdomain / domain / path are interpolated into generated nginx directives.
// A newline lets the value close the block and append arbitrary directives.
function nginxField(v, label) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/[\r\n;{}\0]/.test(s)) return `${label} may not contain newlines, ; { or }`;
  if (!/^[A-Za-z0-9._\-/*]+$/.test(s)) return `${label} contains invalid characters`;
  return null;
}

// The port is interpolated into `listen ${port};` and into a netsh firewall
// rule. parseInt is NOT enough: it reads "9500; evil" as 9500 while the original
// string is what gets stored and later written into the config. Require the
// whole value to be digits.
function port(v, label) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    return Number.isInteger(v) && v >= 1 && v <= 65535 ? null : `${label} must be a number 1-65535`;
  }
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return `${label} must be digits only`;
  const n = Number(s);
  if (n < 1 || n > 65535) return `${label} must be a number 1-65535`;
  return null;
}

// pm2_instances becomes a `-i <n>` argument to the pm2 CLI.
function count(v, label) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return `${label} must be digits only`;
  const n = Number(s);
  if (n < 1 || n > 128) return `${label} must be 1-128`;
  return null;
}

// Validate whichever site fields are present in a create/update body. Returns an
// error string or null. Applied to POST and PUT alike so an update can't smuggle
// in what create rejects.
function siteFields(b, { requireName } = {}) {
  const config = require('./config');
  if (requireName || 'name' in b) {
    const e = siteName(b.name);
    if (e) return e;
  }
  const checks = [
    repoUrl(b.repo_url),
    branch(b.branch),
    entryFile(b.entry_file),
    localPath(b.local_path, config.ROOT),
    nginxField(b.subdomain, 'subdomain'),
    nginxField(b.domain, 'domain'),
    nginxField(b.path, 'path'),
    port(b.direct_port, 'direct_port'),
    count(b.pm2_instances, 'pm2_instances'),
  ];
  return checks.find(Boolean) || null;
}

module.exports = {
  adminOnly,
  siteName,
  repoUrl,
  branch,
  entryFile,
  localPath,
  nginxField,
  port,
  count,
  siteFields,
};
