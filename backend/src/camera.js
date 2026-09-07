'use strict';
// Camera bridge: this server talks FTP to a device on an isolated plant subnet
// and re-exposes what it finds over plain HTTP, so consumers that cannot route
// to that subnet (or cannot cross FTP's second data connection) can still read
// the files. The VS camera at 172.26.20.72 is the motivating case: it answers
// PASV with its own IP and a random port, so only a machine on its own network
// can ever list it — this manager is on that network, its callers are not.
//
// READ-ONLY BY CONSTRUCTION. There is no upload, rename or delete path in this
// file and there must never be one: the camera accepts a blank password, so
// anything that can reach this bridge would inherit the ability to erase the
// device's programs. Reading is the whole contract.
const path = require('path');
const settings = require('./settings');
const secretbox = require('./secretbox');
const { emitLog } = require('./logbus');

// The device is not robust — it is an inspection camera, not a file server — so
// every call is short-fused and listings are cached. A UI that polls must not
// turn into a hammer on it.
const CONNECT_TIMEOUT_MS = 8000;
const LIST_CACHE_MS = 45_000;
const CACHE_CAP = 200; // bounded so a walk of a deep tree cannot grow forever

const listCache = new Map(); // relPath -> { at, value }

function requireDriver() {
  try {
    return require('basic-ftp');
  } catch {
    throw new Error('basic-ftp package not installed — run npm install in backend/');
  }
}

function config() {
  return {
    enabled: settings.get('camera_enabled') === '1',
    host: settings.get('camera_host') || '',
    port: parseInt(settings.get('camera_port') || '21', 10),
    user: settings.get('camera_user') || '',
    // A device with no password is normal here (the VS camera has none), so an
    // empty password is a valid configuration, not a missing one.
    password: settings.get('camera_pass_enc') ? secretbox.decrypt(settings.get('camera_pass_enc')) || '' : '',
    // Everything this bridge may read lives under here. Paths from callers are
    // resolved inside it and may not escape — the device holds far more than
    // the images we mean to publish.
    root: settings.get('camera_root') || '/',
  };
}

// Join a caller-supplied relative path onto the configured root, refusing any
// escape. Mirrors shares.safeJoin, but purely textual: the tree is on a remote
// device, so there is nothing to realpath and no symlink to resolve here.
function safeRemotePath(root, rel) {
  const cleaned = String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (cleaned.split('/').includes('..')) throw new Error('path escapes camera root');
  const base = String(root || '/').replace(/\/+$/, '') || '/';
  // Drop any trailing slash: "Programs" and "Programs/" name the same folder,
  // and the cache is keyed on this string — two spellings would mean two
  // entries and two round trips to a device we are trying not to hammer.
  const joined = path.posix.normalize(`${base}/${cleaned}`).replace(/(?!^)\/+$/, '');
  if (joined !== base && !joined.startsWith(base === '/' ? '/' : base + '/')) {
    throw new Error('path escapes camera root');
  }
  return joined;
}

// One connection per call, always closed. A pooled/kept-open control channel
// would be faster, but this device drops idle sessions silently and a stale
// handle then fails in ways that look like the camera being down.
async function withClient(fn) {
  const c = config();
  if (!c.enabled) throw new Error('camera bridge ปิดอยู่');
  if (!c.host) throw new Error('ยังไม่ได้ตั้งค่า host ของกล้อง');
  const { Client } = requireDriver();
  const client = new Client(CONNECT_TIMEOUT_MS);
  client.ftp.encoding = 'latin1'; // device is not UTF-8; MLSD is all it advertises
  try {
    await client.access({
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      secure: false, // device rejects AUTH TLS and drops the connection
    });
    return await fn(client, c);
  } finally {
    client.close();
  }
}

// Folder listing, cached. Returns { folders:[{name}], files:[{name,size,mtime}] }.
async function list(rel, { fresh = false } = {}) {
  const c = config();
  const remote = safeRemotePath(c.root, rel);
  const hit = listCache.get(remote);
  if (!fresh && hit && Date.now() - hit.at < LIST_CACHE_MS) return { ...hit.value, cached: true };

  const entries = await withClient((client) => client.list(remote));
  const value = { path: String(rel || ''), folders: [], files: [] };
  for (const e of entries) {
    if (e.name === '.' || e.name === '..') continue;
    if (e.isDirectory) value.folders.push({ name: e.name });
    else if (e.isFile) {
      value.files.push({
        name: e.name,
        size: e.size,
        // rawModifiedAt is what the device actually printed; modifiedAt is the
        // library's parse of it and is null for some devices. Send both rather
        // than silently losing the only freshness signal these files have —
        // their names carry no timestamp.
        mtime: e.modifiedAt ? e.modifiedAt.getTime() : null,
        mtime_raw: e.rawModifiedAt || null,
      });
    }
  }
  if (listCache.size >= CACHE_CAP) listCache.clear();
  listCache.set(remote, { at: Date.now(), value });
  return { ...value, cached: false };
}

// Look a file up in its parent's (usually cached) listing. The device answers
// SIZE with "500 Unsupported", so this is the only way to learn a file's size
// before fetching it — and the only way to tell "missing" from "empty".
async function statFile(rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const i = clean.lastIndexOf('/');
  const parent = i < 0 ? '' : clean.slice(0, i);
  const name = i < 0 ? clean : clean.slice(i + 1);
  if (!name) throw new Error('path required');
  const listing = await list(parent);
  const hit = listing.files.find((f) => f.name === name);
  if (!hit) {
    if (listing.folders.some((f) => f.name === name)) throw new Error('path เป็นโฟลเดอร์ ไม่ใช่ไฟล์');
    const e = new Error('ไม่พบไฟล์บนกล้อง');
    e.notFound = true;
    throw e;
  }
  return hit;
}

// Stream one file to a writable (the HTTP response), after confirming it really
// exists and how big it should be. Both checks matter: RETR on a missing file
// came back as a clean empty transfer, so without them a caller asking for a
// name that is not there received "200 OK, 0 bytes" and would write an empty
// image over a good one. A short read now fails loudly instead.
async function download(rel, writable) {
  const c = config();
  const entry = await statFile(rel);
  const remote = safeRemotePath(c.root, rel);
  const { PassThrough } = require('stream');
  const counter = new PassThrough();
  let bytes = 0;
  counter.on('data', (chunk) => {
    bytes += chunk.length;
  });
  counter.pipe(writable, { end: false }); // we decide how this response ends
  await withClient((client) => client.downloadTo(counter, remote));
  if (typeof entry.size === 'number' && bytes !== entry.size) {
    throw new Error(`โหลดไม่ครบ: ได้ ${bytes} จาก ${entry.size} bytes`);
  }
  return { bytes, size: entry.size };
}

// Connectivity + credentials check for the "Test" button. Never throws.
async function test() {
  const started = Date.now();
  try {
    const entries = await withClient((client, c) => client.list(c.root));
    return { ok: true, ms: Date.now() - started, entries: entries.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function status() {
  const c = config();
  return {
    enabled: c.enabled,
    host: c.host,
    port: c.port,
    user: c.user,
    root: c.root,
    hasPassword: !!settings.get('camera_pass_enc'),
    hasToken: !!settings.get('camera_api_token'),
    cacheSeconds: Math.round(LIST_CACHE_MS / 1000),
  };
}

function forgetCache() {
  listCache.clear();
  emitLog('system', '[camera] ล้าง cache รายการไฟล์แล้ว');
}

module.exports = { list, download, statFile, test, status, forgetCache, safeRemotePath, _internal: { safeRemotePath } };
