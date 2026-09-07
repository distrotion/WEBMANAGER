'use strict';
// "Pull the images down" — the job behind POST /api/camera/sync.
//
// The bridge (camera.js) lets a caller read the device live, but a consumer that
// wants the pictures on every page load would be fetching 4-6 MB over FTP each
// time, from a device that is frequently powered off. So this copies what
// changed into a folder on this server; whatever reads that folder then keeps
// working while the camera is dark. The camera side stays strictly read-only —
// this writes only to local disk.
const fs = require('fs');
const path = require('path');
const camera = require('./camera');
const settings = require('./settings');
const { emitLog } = require('./logbus');

const MANIFEST = '.camera-sync.json';

// One run at a time. A second trigger while a run is in flight is answered as
// "already running" rather than queued: two runs would fight over the same
// .part files, and the device cannot serve two transfers usefully anyway.
let running = null; // { startedAt, trigger }
let lastReport = null;
let timer = null;

function config() {
  return {
    dest: settings.get('camera_sync_dest') || '',
    // Which folders under the camera root to walk. The VS camera keeps programs
    // in Programs/<NNNN_name>/ModelImages.
    source: settings.get('camera_sync_source') || 'Programs',
    imagesDir: settings.get('camera_sync_images_dir') || 'ModelImages',
    // Comma-separated filenames to copy; empty = every file found. Defaults to
    // the master image alone, because the sibling 001_PE.png is byte-identical
    // in every program folder — copying it 20 times moves 65 MB for one file.
    files: (settings.get('camera_sync_files') || '000_model.png')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // "HH:MM" local time for the automatic daily run; empty = manual only.
    dailyAt: settings.get('camera_sync_daily_at') || '',
  };
}

// A folder is a "program" if it starts with a digit — the operator's rule. The
// name is reused verbatim as the local folder so what lands on disk matches
// what the camera shows.
function isProgramFolder(name) {
  return /^[0-9]/.test(name);
}

// Reject anything that could not have come from the camera listing, so a
// hostile or broken device name cannot walk out of the destination folder.
function safeSegment(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[\\/:*?"<>|\r\n\0]/.test(name) && name !== '.' && name !== '..';
}

function readManifest(dest) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dest, MANIFEST), 'utf8'));
  } catch {
    return {};
  }
}

function writeManifest(dest, m) {
  try {
    fs.writeFileSync(path.join(dest, MANIFEST), JSON.stringify(m, null, 1));
  } catch (e) {
    emitLog('system', `[camera-sync] เขียน manifest ไม่ได้: ${e.message}`);
  }
}

// The device reports no parseable mtime (it answers MDTM/SIZE with 500), so
// "has this changed" is decided by size first — the reliable half — with the
// raw listing date as a tiebreaker for a same-size edit. The raw string also
// rewrites itself once a file passes ~6 months old ("Sep  3 20:12" becomes
// "Sep  3  2026"), which is why it must never be the primary signal: that would
// re-download the whole set twice a year for no reason.
function changed(prev, remote, localSize) {
  if (localSize !== remote.size) return true;
  if (!prev) return false; // file is there and the right size — trust it
  return prev.mtime_raw !== remote.mtime_raw;
}

async function runOnce(trigger = 'manual') {
  if (running) {
    const e = new Error('กำลังดึงอยู่แล้ว');
    e.busy = true;
    throw e;
  }
  const c = config();
  if (!c.dest) throw new Error('ยังไม่ได้ตั้งโฟลเดอร์ปลายทาง');
  if (!path.isAbsolute(c.dest)) throw new Error('โฟลเดอร์ปลายทางต้องเป็น absolute path');
  running = { startedAt: Date.now(), trigger };
  const started = Date.now();
  const report = {
    ok: true,
    trigger,
    startedAt: started,
    programs: 0,
    copied: [],
    skipped: 0,
    failed: [],
    bytes: 0,
  };
  try {
    fs.mkdirSync(c.dest, { recursive: true });
    const manifest = readManifest(c.dest);
    const top = await camera.list(c.source, { fresh: true });
    const programs = top.folders.map((f) => f.name).filter(isProgramFolder).filter(safeSegment);
    report.programs = programs.length;

    for (const prog of programs) {
      const remoteDir = `${c.source}/${prog}/${c.imagesDir}`;
      let listing;
      try {
        listing = await camera.list(remoteDir, { fresh: true });
      } catch (e) {
        // A program with no images folder is normal (0000_NewProgram) — not an
        // error worth failing the run over.
        if (/ไม่พบ|No such|550/i.test(e.message)) continue;
        report.failed.push({ path: remoteDir, error: e.message });
        continue;
      }
      const wanted = listing.files.filter((f) => safeSegment(f.name) && (c.files.length === 0 || c.files.includes(f.name)));
      if (!wanted.length) continue;

      const localDir = path.join(c.dest, prog);
      fs.mkdirSync(localDir, { recursive: true });

      for (const f of wanted) {
        const rel = `${remoteDir}/${f.name}`;
        const localFile = path.join(localDir, f.name);
        const key = `${prog}/${f.name}`;
        let localSize = -1;
        try {
          localSize = fs.statSync(localFile).size;
        } catch {
          /* not there yet */
        }
        if (!changed(manifest[key], f, localSize)) {
          report.skipped++;
          continue;
        }
        // Download to a temp name and rename into place, so a half-transferred
        // image never appears to whatever is reading this folder, and an
        // interrupted run leaves the previous good copy untouched.
        const tmp = `${localFile}.part`;
        try {
          const out = fs.createWriteStream(tmp);
          await new Promise((resolve, reject) => {
            out.on('error', reject);
            camera.download(rel, out).then(resolve, reject);
          });
          await new Promise((resolve) => out.end(resolve));
          fs.renameSync(tmp, localFile);
          manifest[key] = { size: f.size, mtime_raw: f.mtime_raw, at: Date.now() };
          report.copied.push(key);
          report.bytes += f.size || 0;
        } catch (e) {
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* nothing to clean */
          }
          report.failed.push({ path: rel, error: e.message });
        }
      }
    }
    writeManifest(c.dest, manifest);
  } catch (e) {
    report.ok = false;
    report.error = e.message;
  } finally {
    running = null;
  }
  report.ms = Date.now() - started;
  report.ok = report.ok && report.failed.length === 0;
  lastReport = report;
  // One line per run, not per file: a nightly job that logged 40 lines would
  // bury everything else in the system channel within a week.
  emitLog(
    'system',
    `[camera-sync] ${report.ok ? 'เสร็จ' : 'มีปัญหา'} (${trigger}): โหลดใหม่ ${report.copied.length} ไฟล์ ` +
      `${(report.bytes / 1048576).toFixed(1)} MB · เหมือนเดิม ${report.skipped} · พลาด ${report.failed.length} · ${report.ms} ms` +
      (report.error ? ` · ${report.error}` : '')
  );
  return report;
}

function status() {
  const c = config();
  return {
    dest: c.dest,
    source: c.source,
    imagesDir: c.imagesDir,
    files: c.files,
    dailyAt: c.dailyAt,
    running: !!running,
    startedAt: running ? running.startedAt : null,
    last: lastReport,
  };
}

// Fire the daily run when the wall clock passes the configured time. Checked
// once a minute against the minute string itself, so it cannot drift or fire
// twice, and a restart in the same minute at worst repeats one cheap run.
let lastFiredKey = null;
function tick() {
  const c = config();
  if (!c.dailyAt || running) return;
  const now = new Date();
  const key = `${now.toDateString()} ${c.dailyAt}`;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (hhmm !== c.dailyAt || lastFiredKey === key) return;
  lastFiredKey = key;
  runOnce('daily').catch((e) => emitLog('system', `[camera-sync] daily run ล้มเหลว: ${e.message}`));
}

function start() {
  if (timer) return;
  timer = setInterval(tick, 60_000);
  timer.unref();
}

module.exports = { runOnce, status, start, _internal: { changed, isProgramFolder, safeSegment } };
