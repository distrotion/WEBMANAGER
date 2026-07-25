'use strict';
// File Share: expose a folder on this server as a READ-ONLY download tree, so an
// external consumer (e.g. an ML pipeline pulling QC images to train) can list and
// fetch files over HTTP. No write/delete/upload path exists here on purpose — the
// manager runs with high privilege, so a share can only ever hand out bytes.
const fs = require('fs');
const path = require('path');

const LIST_CAP = 50000; // guard a recursive list of a huge tree from blowing memory

// Resolve a caller-supplied relative path *inside* a share root, refusing anything
// that escapes it. We realpath both sides so a symlink can't be used to jump out,
// then require the target to be the root itself or sit under root + separator.
function safeJoin(root, rel) {
  const realRoot = fs.realpathSync(root); // throws if the share folder is gone
  const cleaned = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(realRoot, cleaned);
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    real = target; // not-yet-real path — still prefix-checked below
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new Error('path escapes share root');
  }
  return real;
}

// List a folder under the share. recursive=true walks the whole subtree and
// returns every file with its path relative to the share root (what an ML script
// wants — one call to enumerate, then fetch each). Symlinks are never followed.
function listDir(root, rel, recursive) {
  const relClean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const base = safeJoin(root, relClean);
  if (!fs.statSync(base).isDirectory()) throw new Error('not a directory');

  const entries = [];
  let capped = false;
  const walk = (dir, prefix) => {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return; // unreadable dir — skip rather than fail the whole listing
    }
    names.sort();
    for (const name of names) {
      if (entries.length >= LIST_CAP) {
        capped = true;
        return;
      }
      const abs = path.join(dir, name);
      let s;
      try {
        s = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (s.isSymbolicLink()) continue; // never follow — would defeat the escape guard
      const relPath = prefix ? `${prefix}/${name}` : name;
      if (s.isDirectory()) {
        entries.push({ name, path: relPath, isDir: true, size: 0, mtime: Math.round(s.mtimeMs) });
        if (recursive) walk(abs, relPath);
      } else if (s.isFile()) {
        entries.push({ name, path: relPath, isDir: false, size: s.size, mtime: Math.round(s.mtimeMs) });
      }
    }
  };
  walk(base, relClean);
  return { entries, capped };
}

module.exports = { safeJoin, listDir, LIST_CAP };
