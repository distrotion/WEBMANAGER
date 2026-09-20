'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const { run } = require('./runner');
const { emitLog } = require('./logbus');

// $connection_upgrade (defined once in mainConf()'s http block) is "upgrade"
// only when the client actually sent an Upgrade header, "close" otherwise —
// the literal "upgrade" this used to send on EVERY proxied request is
// harmless for plain HTTP but is the wrong value on a keepalive connection a
// client reuses for a later WebSocket attempt on the same socket.
const PROXY_HDR = `        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;`;

// Added only inside a route's location block, and only when the route is
// marked sse=1 — a normal proxied API call must keep nginx's buffering, or a
// slow client would tie up the upstream connection. Without this, an SSE
// stream sits in nginx's buffer and arrives in one burst on close instead of
// as it happens — the exact "looks fine, actually broken" failure #436 warns
// about testing for.
const SSE_HDR = `        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;`;

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

    # Upgrade→Connection mapping for proxied WebSocket/SSE, shared by every
    # location that includes PROXY_HDR (see nginx.js). Declared once here
    # instead of hardcoding "upgrade" per-location, which used to send that
    # value on every plain HTTP request too.
    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

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

// One location block per enabled proxy_routes row for this site — see #436:
// rendered into the SAME file writePortConf() writes (never into front/,
// which rebuildFront() wipes on every unrelated site's edit).
function enabledRoutes(siteId) {
  return db
    .prepare('SELECT * FROM proxy_routes WHERE site_id=? AND enabled=1 ORDER BY path_prefix')
    .all(siteId);
}

function routeLocations(rows) {
  return rows.map((r) => {
    const prefix = cleanPath(r.path_prefix, '');
    const target = r.target_url.replace(/\/+$/, '');
    // strip_prefix=1: proxy_pass carries a URI (trailing /), so nginx replaces
    // the matched location prefix before forwarding — the backend never sees
    // /api/gw. strip_prefix=0: proxy_pass is bare host:port with no URI, so
    // nginx forwards the original request URI untouched.
    const passTarget = r.strip_prefix ? `${target}/` : target;
    return `    location ${prefix}/ {\n        proxy_pass ${passTarget};\n${PROXY_HDR}\n${
      r.sse ? SSE_HDR + '\n' : ''
    }    }`;
  });
}

// sub_filter lines for the HTTPS block's static `location /` only — one per
// enabled route that carries rewrite_from. Rewrites the absolute backend
// origin baked into a Flutter bundle (main.dart.js) to the route's relative
// prefix, so the SAME bundle serves http :7000 untouched (absolute URLs, no
// gate) and https :7002 through the gate (same-origin, no mixed content).
// Notes that matter for correctness:
//   - sub_filter runs before the gzip filter, so `gzip on` at http level is
//     fine; what must NOT exist is gzip_static / pre-compressed files, which
//     bypass sub_filter — mainConf() never enables gzip_static.
//   - sub_filter_last_modified off (nginx default, stated explicitly): nginx
//     drops Last-Modified AND ETag on rewritten responses, so a client never
//     gets a 304 for a body that differs from the original file.
//   - Only the static location gets it, never the proxied route locations —
//     a backend's JS/HTML response must pass through unmodified.
//   - Flutter's service worker keys its cache by origin and compares its
//     own manifest hashes (old vs new), not the fetched bytes, so a rewritten
//     main.dart.js is cached as-is on https and never mixed with :7000's.
function rewriteFilters(rows) {
  const lines = [];
  for (const r of rows) {
    if (!r.rewrite_from) continue;
    const prefix = cleanPath(r.path_prefix, '');
    lines.push(`        sub_filter '${r.rewrite_from}' '${prefix}/';`);
  }
  if (!lines.length) return '';
  return `        sub_filter_types application/javascript;
        sub_filter_once off;
        sub_filter_last_modified off;
${lines.join('\n')}`;
}

// ---- Layer 1: direct-port access (static is served by nginx; process apps own the port) ----
// Process runtimes (node/nodered) bind direct_port themselves via PM2 — nginx
// never listens there, so proxy_routes/https only ever attach to a STATIC
// site's block, which is the one case nginx already owns the port.
function writePortConf(site) {
  ensureDirs();
  const file = path.join(config.paths.nginxPorts, `${site.name}.conf`);
  const wantBlock = site.runtime === 'static' && site.direct_port && site.direct_port_enabled;
  if (wantBlock) {
    const rows = enabledRoutes(site.id);
    const routes = routeLocations(rows);
    const head = `    root ${currentPath(site)};
    index index.html;
${routes.length ? routes.join('\n\n') + '\n\n' : ''}`;
    // http block: NEVER carries sub_filter — the plain port must serve the
    // deployed bundle byte-for-byte (it is the main path for every PC).
    const body = `${head}    location / { try_files $uri $uri/ /index.html; }`;
    const filters = rewriteFilters(rows);
    const httpsBody = filters
      ? `${head}    location / {
        try_files $uri $uri/ /index.html;
${filters}
    }`
      : body;
    let conf = `# layer1 direct-port for ${site.name}
server {
    listen ${site.direct_port};
    server_name _;
${body}
}
`;
    // Opt-in second listener on https_port, same cert layout tls.issueCert()
    // and ssl.js both write (certs/<site.name>/fullchain.pem+privkey.pem).
    // Default (https_enabled=0) renders NOTHING extra — a site that has never
    // touched this must get byte-identical output to before this feature
    // existed, since writePortConf() is the one function every site's config
    // renders through on every deploy.
    if (site.https_enabled && site.https_port) {
      const base = path.join(config.paths.certs, site.name).replace(/\\/g, '/');
      conf += `
# layer1 direct-port TLS for ${site.name}
server {
    listen ${site.https_port} ssl;
    http2 on;
    server_name _;
    ssl_certificate ${base}/fullchain.pem;
    ssl_certificate_key ${base}/privkey.pem;
${TLS}
${httpsBody}
}
`;
    }
    fs.writeFileSync(file, conf, 'utf8');
  } else if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

// ---- reversible config writes ----
// Snapshot every .conf under ports/ and front/ before a mutation, so a failed
// `nginx -t` can restore the exact bytes that were serving before — not just
// skip the reload. Without this, writePortConf()/rebuildFront() write-then-
// overwrite with no backup, and a broken file left on disk only shows up on
// the NEXT nginx restart (service restart, reboot, or reload()'s own
// fallback to `start` when `-s reload` fails) — by then it takes every site
// down at once, not just the one being edited. See #436/#437/#438.
function snapshotConfigs() {
  const snap = {};
  for (const dir of [config.paths.nginxPorts, config.paths.nginxFront]) {
    const files = {};
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.conf')) files[f] = fs.readFileSync(path.join(dir, f), 'utf8');
      }
    }
    snap[dir] = files;
  }
  return snap;
}

function restoreConfigs(snap) {
  for (const [dir, files] of Object.entries(snap)) {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.conf') && !(f in files)) fs.unlinkSync(path.join(dir, f));
      }
    }
    for (const [f, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, f), content, 'utf8');
    }
  }
}

// Run `mutate` (a writePortConf/rebuildFront call, or several), test the
// result, and only keep it if the test passes — otherwise every .conf file
// under ports/ and front/ is restored to exactly what it was, and the caller
// gets the real `nginx -t` error text to show the operator. Callers reload()
// themselves on ok:true; this only decides whether the write sticks.
async function applyConfig(mutate, channel = 'system') {
  const snap = snapshotConfigs();
  mutate();
  const t = await test(channel);
  if (t.code !== 0) {
    restoreConfigs(snap);
    return { ok: false, error: (t.error || t.out || 'nginx -t failed').trim() };
  }
  return { ok: true };
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

// On Windows nginx is registered as a service (install.ps1). Starting it as a
// bare process instead makes it a child of the manager: it dies with the
// manager's process tree on every restart/self-update while the service stays
// Stopped, so nothing brings the sites back. Prefer the service when it exists.
async function winService(action, channel) {
  if (process.platform !== 'win32') return null;
  const q = await run('sc', ['query', 'nginx'], { channel: 'silent', timeoutMs: 15_000 });
  if (q.code !== 0) return null; // no such service: dev-style install
  return run('net', [action, 'nginx'], { channel, timeoutMs: 60_000 });
}

async function start(channel = 'system') {
  const r = await winService('start', channel);
  if (r && r.code === 0) return r;
  if (r) emitLog(channel, '[nginx] service start failed — starting nginx.exe directly');
  return run(config.nginx.exe, ['-p', config.nginx.prefix, '-c', confPath()], { channel });
}

async function stop(channel = 'system') {
  const r = await winService('stop', channel);
  if (r && r.code === 0) return r;
  return run(config.nginx.exe, ['-p', config.nginx.prefix, '-c', confPath(), '-s', 'stop'], { channel });
}

module.exports = {
  ensureDirs,
  bootstrapPrefix,
  currentPath,
  writePortConf,
  rebuildFront,
  removeSiteConfigs,
  applyConfig,
  test,
  reload,
  start,
  stop,
};
