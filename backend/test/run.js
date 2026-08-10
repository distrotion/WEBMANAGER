'use strict';
// Test runner: `npm test` from backend/.
//
// Every *.test.js runs in its OWN child process with its OWN throwaway
// WEBMANAGER_ROOT. Two reasons this is not optional:
//   - src/db.js resolves the database path at require time from that env var,
//     so it has to be set before the module loads — impossible to do per-file
//     inside a single process.
//   - a test that wrote into the real dev database would corrupt an install.
//     Isolation by construction beats remembering to clean up.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = __dirname;
const only = process.argv[2]; // node test/run.js mq   -> just mq.test.js
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => !only || f.includes(only))
  .sort();

if (!files.length) {
  console.error(only ? `ไม่พบไฟล์เทสที่ตรงกับ "${only}"` : 'ไม่พบไฟล์เทส');
  process.exit(1);
}

const roots = [];
let failed = 0;
const started = Date.now();

for (const f of files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-test-'));
  roots.push(root);
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      WEBMANAGER_ROOT: root,
      // Keep the suite's own logging out of the transcript; assertions are the
      // output that matters.
      WM_LOG_CONSOLE: '',
    },
  });
  if (r.status !== 0) failed += 1;
}

for (const root of roots) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not worth failing the run over */
  }
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  failed
    ? `\n✗ ${failed}/${files.length} ไฟล์เทสไม่ผ่าน (${secs}s)`
    : `\n✓ ผ่านครบ ${files.length} ไฟล์ (${secs}s)`
);
process.exit(failed ? 1 : 0);
