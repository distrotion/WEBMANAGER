'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const nginx = require('./nginx');
const { run } = require('./runner');
const { emitLog } = require('./logbus');

// Issue/renew a Let's Encrypt cert via win-acme (HTTP-01, webroot validation),
// export PEM files to certs\<key>\ and wire them into nginx.
//
// For subdomain sites the cert key = site.name and host = site.subdomain.
// For path sites the cert key = site.domain and host = site.domain (shared).

function certTarget(site) {
  if (site.exposure_mode === 'subdomain' && site.subdomain) {
    return { key: site.name, host: site.subdomain };
  }
  if (site.exposure_mode === 'path' && site.domain) {
    return { key: site.domain, host: site.domain };
  }
  return null;
}

async function issue(site, channel) {
  const t = certTarget(site);
  if (!t) {
    emitLog(channel, '[ssl] site has no subdomain/domain — set exposure first');
    return { ok: false };
  }
  const pemDir = path.join(config.paths.certs, t.key);
  fs.mkdirSync(pemDir, { recursive: true });
  fs.mkdirSync(config.paths.acme, { recursive: true });

  // Make sure a :80 server with the ACME challenge location is live, then validate.
  nginx.rebuildFront();
  const test = await nginx.test(channel);
  if (test.code === 0) await nginx.reload(channel);

  emitLog(channel, `[ssl] requesting cert for ${t.host}`);
  const r = await run(
    config.ssl.wacs,
    [
      '--source', 'manual',
      '--host', t.host,
      '--validation', 'filesystem',
      '--webroot', config.paths.acme,
      '--store', 'pemfiles',
      '--pemfilespath', pemDir,
      '--accepttos',
      '--emailaddress', config.ssl.email,
      // run our reload hook after each (re)issue, including scheduled renewals
      '--installation', 'script',
      '--script', path.join(config.ROOT, 'tools', 'reload-nginx.cmd'),
    ],
    { channel }
  );
  if (r.code !== 0) {
    emitLog(channel, '[ssl] win-acme failed');
    return { ok: false };
  }

  // win-acme pemfiles store names files after the host; normalize to fullchain/privkey.
  normalizePem(pemDir, t.host, channel);

  db.prepare('UPDATE sites SET ssl_enabled=1 WHERE id=?').run(site.id);
  nginx.rebuildFront();
  const t2 = await nginx.test(channel);
  if (t2.code === 0) await nginx.reload(channel);
  emitLog(channel, `[ssl] enabled for ${t.host}`);
  return { ok: true };
}

// win-acme pemfiles output: <host>-chain.pem / <host>-key.pem (varies by version).
// Copy whatever it produced into the fullchain.pem / privkey.pem our configs expect.
function normalizePem(pemDir, host, channel) {
  const files = fs.readdirSync(pemDir);
  const pick = (re) => files.find((f) => re.test(f));
  const chain = pick(/chain.*\.pem$/i) || pick(/fullchain.*\.pem$/i) || pick(new RegExp(`${host}.*crt.*\\.pem$`, 'i'));
  const key = pick(/key.*\.pem$/i);
  if (chain) fs.copyFileSync(path.join(pemDir, chain), path.join(pemDir, 'fullchain.pem'));
  if (key) fs.copyFileSync(path.join(pemDir, key), path.join(pemDir, 'privkey.pem'));
  if (!chain || !key) {
    emitLog(channel, `[ssl] WARN: could not auto-detect PEM files in ${pemDir} (found: ${files.join(', ')})`);
  }
}

async function disable(site, channel) {
  db.prepare('UPDATE sites SET ssl_enabled=0 WHERE id=?').run(site.id);
  nginx.rebuildFront();
  const t = await nginx.test(channel);
  if (t.code === 0) await nginx.reload(channel);
  emitLog(channel, '[ssl] disabled');
  return { ok: true };
}

module.exports = { issue, disable, certTarget };
