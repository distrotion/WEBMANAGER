'use strict';
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(config.paths.data, { recursive: true });
const db = new Database(config.paths.db);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sites (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT UNIQUE NOT NULL,
  runtime             TEXT NOT NULL DEFAULT 'static',   -- static | nodered | node
  source_type         TEXT NOT NULL DEFAULT 'git',       -- git | local
  repo_url            TEXT,
  local_path          TEXT,                              -- local folder source (source_type=local)
  branch              TEXT DEFAULT 'main',
  last_commit         TEXT,
  direct_port         INTEGER,                          -- layer 1 port
  direct_port_enabled INTEGER NOT NULL DEFAULT 1,
  exposure_mode       TEXT,                             -- subdomain | path | NULL
  subdomain           TEXT,
  path                TEXT,
  domain              TEXT,
  ssl_enabled         INTEGER NOT NULL DEFAULT 0,
  service_name        TEXT,                             -- NSSM service (process runtimes)
  status              TEXT DEFAULT 'new',
  process_status      TEXT,
  current_release     TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_deploy_at      TEXT
);

CREATE TABLE IF NOT EXISTS releases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     INTEGER NOT NULL,
  timestamp   TEXT NOT NULL,
  commit_hash TEXT,
  deployed_by TEXT,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  who    TEXT,
  action TEXT,
  target TEXT,
  detail TEXT,
  time   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,           -- site-<id> | system
  line    TEXT NOT NULL,
  ts      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_logs_channel ON logs(channel, id);
`);

// Lightweight migrations for DBs created before a column existed.
for (const [col, def] of [
  ['source_type', "TEXT NOT NULL DEFAULT 'git'"],
  ['local_path', 'TEXT'],
  ['pm2_instances', 'INTEGER DEFAULT 1'],
  ['entry_file', 'TEXT'],
  ['env_json', 'TEXT'],
  ['autodeploy', 'INTEGER DEFAULT 0'],
]) {
  try {
    db.prepare(`ALTER TABLE sites ADD COLUMN ${col} ${def}`).run();
  } catch {
    /* column already exists */
  }
}

module.exports = db;
