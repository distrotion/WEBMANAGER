'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const { run } = require('./runner');
const { emitLog } = require('./logbus');

const PROXY_HDR = `        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;`;

const TLS = `    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;`;

function ensureDirs() {
  for (const d of [config.paths.nginxPorts, config.paths.nginxFront, config.paths.acme]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

const MIME_TYPES = `types {
    text/html                             html htm shtml;
    text/css                              css;
    text/xml                              xml;
    application/javascript                js mjs;
    application/json                      json map;
    application/wasm                      wasm;
    image/gif                             gif;
    image/jpeg                            jpeg jpg;
    image/png                             png;
    image/svg+xml                         svg svgz;
    image/webp                            webp;
    image/x-icon                          ico;
    font/woff                             woff;
    font/woff2                            woff2;
    application/font-ttf                  ttf;
    application/octet-stream              bin otf;
}
`;

// The generated main nginx.conf uses ABSOLUTE paths (forward slashes work on both
// the Windows binary and brew/Unix nginx) so include globs resolve regardless of
// how nginx computes its prefix. Only the paths differ per platform — auto-derived.
function fwd(p) {
  return p.replace(/\\/g, '/');
}
function mainConf() {
  const prefix = fwd(config.nginx.prefix);
  const confDir = fwd(path.join(config.nginx.prefix, 'conf'));
  return `worker_processes  auto;
error_log  ${prefix}/logs/error.log;
pid        ${prefix}/logs/nginx.pid;

events { worker_connections 1024; }

http {
    include       ${confDir}/mime.types;
    default_type  application/octet-stream;

    client_body_temp_path ${prefix}/temp/client_body;
    proxy_temp_path       ${prefix}/temp/proxy;
    fastcgi_temp_path     ${prefix}/temp/fastcgi;
    uwsgi_temp_path       ${prefix}/temp/uwsgi;
    scgi_temp_path        ${prefix}/temp/scgi;

    access_log  ${prefix}/logs/access.log;
    sendfile    on;
    keepalive_timeout 65;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;

    # Layer 1: direct-port access
    include ${fwd(config.paths.nginxPorts)}/*.conf;
    # Layer 2: front 80/443 + TLS
    include ${fwd(config.paths.nginxFront)}/*.conf;
}
`;
}

// Create a self-contained nginx prefix (conf + mime.types + logs + temp dirs) if
// missing, so `nginx -t` / reload work the same on Mac and Windows.
function bootstrapPrefix() {
  const prefix = config.nginx.prefix;
  const confDir = path.join(prefix, 'conf');
  for (const d of [confDir, path.join(prefix, 'logs'), path.join(prefix, 'temp')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  // main conf is fully manager-generated → always refresh so upgrades apply
  fs.writeFileSync(path.join(confDir, 'nginx.conf'), mainConf(), 'utf8');
  const mimeFile = path.join(confDir, 'mime.types');
  if (!fs.existsSync(mimeFile)) fs.writeFileSync(mimeFile, MIME_TYPES, 'utf8');
  ensureDirs();
}

function confPath() {
  return path.join(config.nginx.prefix, 'conf', 'nginx.conf');
}

// HTTP-01 challenge location served on every :80 block so win-acme can validate.
function acmeLocation() {
  const root = config.paths.acme.replace(/\\/g, '/');
  return `    location /.well-known/acme-challenge/ {\n        root ${root};\n        default_type "text/plain";\n    }`;
}

function currentPath(site) {
  return path.join(config.paths.sites, site.name, 'current').replace(/\\/g, '/');
}

function cleanPath(p, fallback) {
  return '/' + String(p || fallback).replace(/^\/+|\/+$/g, '');
}

// ---- Layer 1: direct-port access (static is served by nginx; process apps own the port) ----
function writePortConf(site) {
  ensureDirs();
  const file = path.join(config.paths.nginxPorts, `${site.name}.conf`);
  const wantBlock = site.runtime === 'static' && site.direct_port && site.direct_port_enabled;
  if (wantBlock) {
    const conf = `# layer1 direct-port for ${site.name}
server {
    listen ${site.direct_port};
    server_name _;
    root ${currentPath(site)};
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
}
`;
    fs.writeFileSync(file, conf, 'utf8');
  } else if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

// ---- Layer 2: front (80/443 + TLS) ----
function locationFor(site) {
  if (site.runtime === 'static') {
    const root = currentPath(site);
    if (site.exposure_mode === 'path') {
      const p = cleanPath(site.path, site.name);
      return `    location ${p}/ {\n        alias ${root}/;\n        try_files $uri $uri/ ${p}/index.html;\n    }`;
    }
    return `    root ${root};\n    index index.html;\n    location / { try_files $uri $uri/ /index.html; }`;
  }
  // process runtimes (nodered / node) -> reverse proxy to the direct port
  const target = `http://127.0.0.1:${site.direct_port}`;
  if (site.exposure_mode === 'path') {
    const p = cleanPath(site.path, site.name);
    return `    location ${p}/ {\n        proxy_pass ${target}/;\n${PROXY_HDR}\n    }`;
  }
  return `    location / {\n        proxy_pass ${target};\n${PROXY_HDR}\n    }`;
}

function subdomainServer(site) {
  const name = site.subdomain;
  const body = locationFor(site);
  if (site.ssl_enabled) {
    const base = path.join(config.paths.certs, site.name).replace(/\\/g, '/');
    return `# layer2 subdomain (TLS) ${site.name}
server {
    listen 80;
    server_name ${name};
${acmeLocation()}
    location / { return 301 https://$host$request_uri; }
}
server {
    listen 443 ssl;
    http2 on;
    server_name ${name};
    ssl_certificate ${base}/fullchain.pem;
    ssl_certificate_key ${base}/privkey.pem;
${TLS}
${body}
}
`;
  }
  return `# layer2 subdomain ${site.name}
server {
    listen 80;
    server_name ${name};
${acmeLocation()}
${body}
}
`;
}

function pathServer(domain, list) {
  const locations = list.map(locationFor).join('\n\n');
  const ssl = list.some((s) => s.ssl_enabled);
  if (ssl) {
    const base = path.join(config.paths.certs, domain).replace(/\\/g, '/');
    return `# layer2 path-based (TLS) ${domain}
server {
    listen 80;
    server_name ${domain};
${acmeLocation()}
    location / { return 301 https://$host$request_uri; }
}
server {
    listen 443 ssl;
    http2 on;
    server_name ${domain};
    ssl_certificate ${base}/fullchain.pem;
    ssl_certificate_key ${base}/privkey.pem;
${TLS}

${locations}
}
`;
  }
  return `# layer2 path-based ${domain}
server {
    listen 80;
    server_name ${domain};
${acmeLocation()}

${locations}
}
`;
}

// Regenerate all front configs from the DB: one file per subdomain site,
// one aggregate file per domain for path-based sites.
function rebuildFront() {
  ensureDirs();
  for (const f of fs.readdirSync(config.paths.nginxFront)) {
    if (f.endsWith('.conf')) fs.unlinkSync(path.join(config.paths.nginxFront, f));
  }
  const sites = db.prepare('SELECT * FROM sites WHERE exposure_mode IS NOT NULL').all();

  for (const s of sites.filter((s) => s.exposure_mode === 'subdomain' && s.subdomain)) {
    fs.writeFileSync(
      path.join(config.paths.nginxFront, `sub-${s.name}.conf`),
      subdomainServer(s),
      'utf8'
    );
  }

  const byDomain = {};
  for (const s of sites.filter((s) => s.exposure_mode === 'path' && s.domain)) {
    (byDomain[s.domain] = byDomain[s.domain] || []).push(s);
  }
  for (const [domain, list] of Object.entries(byDomain)) {
    fs.writeFileSync(
      path.join(config.paths.nginxFront, `path-${domain.replace(/[^\w.-]/g, '_')}.conf`),
      pathServer(domain, list),
      'utf8'
    );
  }
}

function removeSiteConfigs(site) {
  const portFile = path.join(config.paths.nginxPorts, `${site.name}.conf`);
  const subFile = path.join(config.paths.nginxFront, `sub-${site.name}.conf`);
  for (const f of [portFile, subFile]) if (fs.existsSync(f)) fs.unlinkSync(f);
  rebuildFront();
}

function test(channel = 'system') {
  return run(config.nginx.exe, ['-p', config.nginx.prefix, '-c', confPath(), '-t'], { channel });
}

// Reload if nginx is already running; if reload fails (not started yet), start it.
// Works on Mac/dev (nginx not a service) and Windows (nginx service already up →
// reload succeeds, no double start).
async function reload(channel = 'system') {
  const base = ['-p', config.nginx.prefix, '-c', confPath()];
  const r = await run(config.nginx.exe, [...base, '-s', 'reload'], { channel });
  if (r.code === 0) return r;
  emitLog(channel, '[nginx] not running — starting it');
  return run(config.nginx.exe, base, { channel });
}

function start(channel = 'system') {
  return run(config.nginx.exe, ['-p', config.nginx.prefix, '-c', confPath()], { channel });
}

function stop(channel = 'system') {
  return run(config.nginx.exe, ['-p', config.nginx.prefix, '-c', confPath(), '-s', 'stop'], { channel });
}

module.exports = {
  ensureDirs,
  bootstrapPrefix,
  currentPath,
  writePortConf,
  rebuildFront,
  removeSiteConfigs,
  test,
  reload,
  start,
  stop,
};
