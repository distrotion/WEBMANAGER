'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const { run } = require('./runner');
const { emitLog } = require('./logbus');

// Windows process lifecycle for `nodered` / `node` runtimes via NSSM.
// Service name = nssm.prefix + site.name  (e.g. wm-nodered1).

function serviceName(site) {
  return site.service_name || `${config.nssm.prefix}${site.name}`;
}

function logFile(site) {
  return path.join(config.paths.logs, `${site.name}.log`);
}

function cleanPath(p, fallback) {
  return '/' + String(p || fallback).replace(/^\/+|\/+$/g, '');
}

// --- Node-RED provisioning: per-site userDir + settings.js (httpRoot for path mode) ---
function provisionNodeRed(site) {
  const userDir = path.join(config.paths.services, site.name);
  fs.mkdirSync(userDir, { recursive: true });
  const httpRoot =
    site.exposure_mode === 'path' ? cleanPath(site.path, site.name) : '/';
  const settings = `module.exports = {
    uiPort: ${site.direct_port || 1880},
    httpRoot: ${JSON.stringify(httpRoot)},
    flowFile: 'flows.json',
    // NOTE: secure your editor — set adminAuth before exposing publicly.
    functionGlobalContext: {},
};
`;
  fs.writeFileSync(path.join(userDir, 'settings.js'), settings, 'utf8');
  return userDir;
}

// Build the NSSM `install` argv for a site based on runtime.
function installArgs(site) {
  const svc = serviceName(site);
  if (site.runtime === 'nodered') {
    const userDir = provisionNodeRed(site);
    const redJs = path.join(config.paths.runtimes, 'node-red', 'node_modules', 'node-red', 'red.js');
    return {
      svc,
      program: config.nodeExe,
      args: [redJs, '-u', userDir, '-p', String(site.direct_port || 1880), '-s', path.join(userDir, 'settings.js')],
      appDir: userDir,
    };
  }
  // generic node app: run from its repo dir, entry from package.json main (server.js default)
  const repoDir = path.join(config.paths.sites, site.name, 'repo');
  return {
    svc,
    program: config.nodeExe,
    args: [path.join(repoDir, process.env.NODE_ENTRY || 'server.js')],
    appDir: repoDir,
    env: site.direct_port ? `PORT=${site.direct_port}` : null,
  };
}

async function nssm(args, channel) {
  return run(config.nssm.exe, args, { channel });
}

async function exists(site) {
  const r = await nssm(['status', serviceName(site)], 'silent');
  return r.code === 0;
}

async function install(site, channel) {
  const a = installArgs(site);
  if (await exists(site)) {
    emitLog(channel, `[svc] ${a.svc} already installed`);
  } else {
    const r = await nssm(['install', a.svc, a.program, ...a.args], channel);
    if (r.code !== 0) return r;
    await nssm(['set', a.svc, 'AppDirectory', a.appDir], channel);
    await nssm(['set', a.svc, 'AppStdout', logFile(site)], channel);
    await nssm(['set', a.svc, 'AppStderr', logFile(site)], channel);
    await nssm(['set', a.svc, 'AppRotateFiles', '1'], channel);
    await nssm(['set', a.svc, 'Start', 'SERVICE_AUTO_START'], channel);
    if (a.env) await nssm(['set', a.svc, 'AppEnvironmentExtra', a.env], channel);
  }
  db.prepare('UPDATE sites SET service_name=? WHERE id=?').run(a.svc, site.id);
  return { code: 0 };
}

async function start(site, channel) {
  await install(site, channel);
  const r = await nssm(['start', serviceName(site)], channel);
  await refreshStatus(site);
  return r;
}
async function stop(site, channel) {
  const r = await nssm(['stop', serviceName(site)], channel);
  await refreshStatus(site);
  return r;
}
async function restart(site, channel) {
  emitLog(channel, `[svc] restart ${serviceName(site)}`);
  await nssm(['restart', serviceName(site)], channel);
  await refreshStatus(site);
  return { code: 0 };
}
async function remove(site, channel) {
  await nssm(['stop', serviceName(site)], channel);
  return nssm(['remove', serviceName(site), 'confirm'], channel);
}

async function refreshStatus(site) {
  const r = await nssm(['status', serviceName(site)], 'silent');
  const status = (r.out || '').trim() || 'unknown';
  db.prepare('UPDATE sites SET process_status=? WHERE id=?').run(status, site.id);
  return status;
}

// Tail the last N lines of a site's NSSM log into the log channel.
function tailLog(site, channel, lines = 200) {
  const f = logFile(site);
  if (!fs.existsSync(f)) {
    emitLog(channel, `[svc] no log yet at ${f}`);
    return;
  }
  const data = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  for (const l of data.slice(-lines)) if (l) emitLog(channel, l);
}

module.exports = {
  serviceName,
  logFile,
  install,
  start,
  stop,
  restart,
  remove,
  refreshStatus,
  tailLog,
  provisionNodeRed,
};
