'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const config = require('./config');

// Browse the server filesystem so the UI can locate a local source folder.
// Returns directories first; flags whether an entry looks like a deployable
// web folder (has index.html).
function browse(p) {
  let dir = p && String(p).trim() ? String(p) : os.homedir();
  dir = path.resolve(dir);
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) dir = path.dirname(dir);
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .map((e) => {
      const full = path.join(dir, e.name);
      const isDir = e.isDirectory();
      let hasIndex = false;
      if (isDir) {
        try {
          hasIndex = fs.existsSync(path.join(full, 'index.html'));
        } catch {
          /* unreadable */
        }
      }
      return { name: e.name, path: full, dir: isDir, hasIndex };
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, entries };
}

// Quietly run `<cmd> <args>` and grab the first output line as a version string.
function tryVersion(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      const out = ((stdout || '') + (stderr || '')).trim().split(/\r?\n/)[0];
      resolve({ ok: !err, version: out });
    });
  });
}

// Resolve a tool that may be an absolute path (bundled) or on PATH.
async function checkTool(exe, versionArgs) {
  if (fs.existsSync(exe)) {
    const v = await tryVersion(exe, versionArgs);
    return { ok: true, detail: v.version || exe };
  }
  const v = await tryVersion(exe, versionArgs);
  return v.ok ? { ok: true, detail: v.version } : { ok: false, detail: `not found: ${exe}` };
}

// Platform-specific "how to install" hint per tool.
function fixHint(key) {
  const win = process.platform === 'win32';
  const mac = process.platform === 'darwin';
  const hints = {
    git: win ? 'Install from git-scm.com' : mac ? 'brew install git' : 'apt install git',
    nginx: win
      ? 'Download nginx/Windows zip, extract to <root>\\nginx (nginx.exe)'
      : mac
      ? 'brew install nginx'
      : 'apt install nginx',
    nssm: win ? 'Download nssm.exe to <root>\\tools' : 'Windows-only (skip on Mac/Linux)',
    winacme: win ? 'Extract win-acme to <root>\\tools\\win-acme' : 'Windows-only (use certbot elsewhere)',
    nodered: 'Run deploy\\install-nodered.ps1  (or: npm i node-red in <root>\\runtimes\\node-red)',
    node: win ? 'Install from nodejs.org' : mac ? 'brew install node' : 'use nodesource',
  };
  return hints[key];
}

async function requirements() {
  const items = [];

  items.push({
    key: 'node', name: 'Node.js', required: true, ok: true,
    detail: process.version, url: 'https://nodejs.org',
    note: 'Runtime for the manager backend.',
  });

  const git = await checkTool(config.git.exe, ['--version']);
  items.push({
    key: 'git', name: 'Git', required: true, ok: git.ok, detail: git.detail,
    url: 'https://git-scm.com', note: 'Clone/pull *_deploy repos.',
  });

  const nginx = await checkTool(config.nginx.exe, ['-v']);
  items.push({
    key: 'nginx', name: 'nginx', required: true, ok: nginx.ok, detail: nginx.detail,
    url: 'https://nginx.org/en/download.html',
    note: `Web server (2-layer). Expected at ${config.nginx.exe}`,
  });

  const nssmOk = fs.existsSync(config.nssm.exe) || (await tryVersion(config.nssm.exe, ['version'])).ok;
  items.push({
    key: 'nssm', name: 'NSSM', required: false, requiredFor: 'Node-RED / node runtime, auto-start services',
    ok: nssmOk, detail: nssmOk ? config.nssm.exe : `not found: ${config.nssm.exe}`,
    url: 'https://nssm.cc/download', note: 'Runs nginx / manager / apps as Windows services.',
  });

  const wacsOk = fs.existsSync(config.ssl.wacs) || (await tryVersion(config.ssl.wacs, ['--version'])).ok;
  items.push({
    key: 'winacme', name: 'win-acme', required: false, requiredFor: 'Issue SSL / TLS',
    ok: wacsOk, detail: wacsOk ? config.ssl.wacs : `not found: ${config.ssl.wacs}`,
    url: 'https://www.win-acme.com', note: "Let's Encrypt certificates (HTTP-01).",
  });

  const redJs = path.join(config.paths.runtimes, 'node-red', 'node_modules', 'node-red', 'red.js');
  const redOk = fs.existsSync(redJs);
  items.push({
    key: 'nodered', name: 'Node-RED runtime', required: false, requiredFor: 'Node-RED sites',
    ok: redOk, detail: redOk ? redJs : 'run deploy\\install-nodered.ps1',
    url: 'https://nodered.org', note: 'Shared Node-RED install used by all Node-RED sites.',
  });

  const wanted = ['sites', 'logs', 'certs', 'acme', 'nginxPorts', 'nginxFront'];
  const missing = wanted.filter((k) => !fs.existsSync(config.paths[k]));
  items.push({
    key: 'folders', name: 'Folder structure', required: true, ok: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join(', ')}` : `ok (${config.ROOT})`,
    url: '', note: 'Created by install.ps1.',
  });

  for (const it of items) if (!it.ok) it.fix = fixHint(it.key);

  const summary = {
    requiredOk: items.filter((i) => i.required).every((i) => i.ok),
    missingRequired: items.filter((i) => i.required && !i.ok).map((i) => i.name),
    missingOptional: items.filter((i) => !i.required && !i.ok).map((i) => i.name),
  };

  return { platform: process.platform, root: config.ROOT, items, summary };
}

module.exports = { requirements, browse };
