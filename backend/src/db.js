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

CREATE TABLE IF NOT EXISTS remotes (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT UNIQUE NOT NULL,
  url   TEXT NOT NULL,            -- http://host:8088 (no trailing slash)
  token TEXT NOT NULL             -- that server's fleet service token
);

CREATE TABLE IF NOT EXISTS git_credentials (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT,                         -- label, e.g. "work github"
  host  TEXT UNIQUE NOT NULL,         -- match on repo URL host, e.g. github.com
  token TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateways (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  listen_port INTEGER UNIQUE NOT NULL,   -- port this server opens
  dest_host   TEXT NOT NULL,             -- forward target host
  dest_port   INTEGER NOT NULL,          -- forward target port
  bind_host   TEXT NOT NULL DEFAULT '0.0.0.0',
  enabled     INTEGER NOT NULL DEFAULT 1,
  max_conns   INTEGER NOT NULL DEFAULT 0,-- 0 = unlimited
  expires_at  INTEGER,                   -- epoch ms; null = never
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Uptime monitoring. A monitor is any target worth watching, not only a site
-- this manager deploys: a URL, a bare TCP port, or a database that must accept a
-- real login (a server can hold 1433 open while rejecting every credential, so a
-- port check alone reports green on a database nothing can actually use).
CREATE TABLE IF NOT EXISTS monitors (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL,                    -- http | tcp | mssql | mongodb | postgres
  enabled        INTEGER NOT NULL DEFAULT 1,
  interval_sec   INTEGER NOT NULL DEFAULT 60,
  timeout_ms     INTEGER NOT NULL DEFAULT 10000,
  fail_threshold INTEGER NOT NULL DEFAULT 3,       -- consecutive fails before "down"
  url            TEXT,                             -- http
  host           TEXT,                             -- tcp + database types
  port           INTEGER,
  username       TEXT,                             -- database types
  password_enc   TEXT,                             -- AES-256-GCM via secretbox
  database_name  TEXT,
  ignore_tls_errors INTEGER NOT NULL DEFAULT 0,     -- http only, opt-in — see monitor.js httpCheck
  -- Database types: instead of the default liveness probe (SELECT 1) a monitor
  -- can run a custom read-only query and judge its FIRST scalar result against a
  -- condition — e.g. an MSSQL Always On query returning the count of un-synced
  -- databases, "healthy" when that equals 0. Empty check_query = plain SELECT 1.
  check_query    TEXT,
  expect_op      TEXT,                              -- eq | ne | lt | lte | gt | gte | contains
  expect_value   TEXT,                              -- compared against the query's first cell
  -- Set compare_host to turn the same check_query into a DRIFT check: the query
  -- runs on both servers with the same credentials and the condition is judged
  -- against the DIFFERENCE, so "row counts identical" is expect eq 0. Answers
  -- "is the replica actually carrying the same data", which a replication-status
  -- check cannot tell you. Expensive (COUNT/CHECKSUM over a table), so these run
  -- on a much longer interval than a liveness probe.
  compare_host   TEXT,
  compare_port   INTEGER,
  -- "HH:MM" (server local time) — when set, the monitor runs ONCE a day at that
  -- wall-clock time instead of every interval_sec. An interval would drift by
  -- however long each run takes and would never stay at midnight; a heavy nightly
  -- drift check has to land in the quiet window, not wander into working hours.
  daily_at       TEXT,
  -- Opt in, per monitor, to appearing on the no-login status page. Off by
  -- default: a monitor knows a hostname, a port and sometimes a database error
  -- string, none of which should become public by accident.
  public         INTEGER NOT NULL DEFAULT 0,
  site_id        INTEGER,                          -- set by auto-create, keeps it idempotent
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per probe. High volume (a monitor a minute is 1440 rows/day each), so
-- ts is epoch-ms for integer range scans and the index leads with monitor_id —
-- history, uptime windows and the retention DELETE all ride that one index.
CREATE TABLE IF NOT EXISTS monitor_checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL,
  ok         INTEGER NOT NULL,
  ms         INTEGER,
  error      TEXT,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monitor_checks_mon_ts ON monitor_checks(monitor_id, ts);

-- Durable message queue. The motivating loss: Node-RED's PLC pipeline drops
-- readings when a consumer falls behind ("Discarding queued 'read' item, max age
-- 2000ms") because its in-memory buffer has nowhere to spill. A producer that
-- can POST a message and get a 201 has handed the data to something on disk;
-- the consumer then takes it at whatever pace it manages.
--
-- Deliberately NOT a broker: no AMQP/MQTT wire protocol, HTTP only. Everything
-- in this plant already speaks HTTP, and a second daemon to install, secure and
-- keep alive on four servers costs more than it would buy.
CREATE TABLE IF NOT EXISTS mq_queues (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT UNIQUE NOT NULL,
  -- Seconds a pulled message stays invisible to other consumers. Longer than
  -- the slowest expected processing time, or the message is handed to a second
  -- consumer while the first is still working on it.
  visibility_timeout INTEGER NOT NULL DEFAULT 60,
  -- Deliveries before a message is parked in 'dead' instead of retried. Without
  -- this a message that always crashes its consumer is retried forever.
  max_attempts       INTEGER NOT NULL DEFAULT 5,
  -- Push mode. Empty = pull mode: the queue waits and consumers ask for work.
  -- Set it and the queue delivers by itself — it POSTs each message to this URL
  -- and treats a 2xx as the ack. That turns the queue into a shock absorber in
  -- front of an existing service: the producer's URL never changes, and when the
  -- service is down the messages pile up here instead of being lost.
  forward_url        TEXT,
  forward_timeout_ms INTEGER NOT NULL DEFAULT 15000,
  forward_headers    TEXT,                            -- JSON object, e.g. an auth header the destination needs
  -- Optional dedicated inbound port for this queue alone: producers POST to
  -- http://<server>:<listen_port>/ instead of sharing the panel's port. Keeps
  -- machine traffic off the operator's URL space and lets the firewall treat the
  -- two differently. NOTE it does NOT isolate load — same process, same event
  -- loop, same SQLite file as the panel.
  listen_port        INTEGER UNIQUE,
  -- Whether that port demands the mq api token. On by default; an operator can
  -- turn it off for a device that genuinely cannot send a header, and then the
  -- port must be firewalled to the producer.
  listen_auth        INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per message. An acked message is DELETEd, not marked done: the table
-- then only ever holds outstanding work plus the dead-letter pile, so it stays
-- small no matter how many millions have flowed through.
CREATE TABLE IF NOT EXISTS mq_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,  -- also the FIFO order
  queue_id        INTEGER NOT NULL,
  state           TEXT NOT NULL DEFAULT 'ready',      -- ready | delivered | dead
  body            TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  -- Receipt handle, regenerated on every delivery. An ack quoting a stale token
  -- fails loudly instead of deleting a message a second consumer now owns.
  ack_token       TEXT,
  lease_until     INTEGER,                            -- epoch-ms; delivery expires here
  not_before      INTEGER,                            -- epoch-ms; delayed publish / retry backoff
  created_at      INTEGER NOT NULL,
  first_pulled_at INTEGER,
  dead_at         INTEGER,
  last_error      TEXT
);
-- The claim query: queue + state + id order, all three from one index.
CREATE INDEX IF NOT EXISTS idx_mq_ready ON mq_messages(queue_id, state, id);
-- The reaper sweeps expired leases across every queue at once.
CREATE INDEX IF NOT EXISTS idx_mq_lease ON mq_messages(state, lease_until);

-- FTP/FTPS server accounts. Server-wide settings (enabled, port, passive range,
-- TLS) live in the settings table like https_enabled — one server, not one row
-- per config the way gateways/monitors are. root_path scopes the account the
-- same way shares.root_path scopes a File Share: ftp-srv itself refuses to
-- resolve outside it, so this is not merely advisory.
CREATE TABLE IF NOT EXISTS ftp_users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT UNIQUE NOT NULL,
  password_enc TEXT NOT NULL,           -- AES-256-GCM via secretbox — ftp-srv needs it back in plaintext to compare
  root_path    TEXT NOT NULL,           -- absolute folder this account is chrooted to
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS net_shares (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  unc_path     TEXT UNIQUE NOT NULL,       -- \\\\server\\share (what apps open)
  username     TEXT NOT NULL,              -- DOMAIN\\user or user
  password_enc TEXT NOT NULL,              -- AES-256-GCM, key from JWT_SECRET
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shares (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  root_path  TEXT NOT NULL,             -- absolute folder on this server (read-only)
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS autodeploy_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     INTEGER,
  site_name   TEXT,
  from_commit TEXT,
  to_commit   TEXT,
  ok          INTEGER NOT NULL DEFAULT 1,
  message     TEXT,
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_autodeploy_ts ON autodeploy_log(ts);

CREATE TABLE IF NOT EXISTS logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,           -- site-<id> | system
  line    TEXT NOT NULL,
  ts      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_logs_channel ON logs(channel, id);
`);

// Lightweight migrations for DBs created before a column existed. CREATE TABLE
// IF NOT EXISTS above only helps a FRESH database — an existing install already
// has the table and silently keeps the old column set, so every column added
// after a table first shipped has to be listed here too.
const MIGRATIONS = {
  sites: [
    ['source_type', "TEXT NOT NULL DEFAULT 'git'"],
    ['local_path', 'TEXT'],
    ['pm2_instances', 'INTEGER DEFAULT 1'],
    ['entry_file', 'TEXT'],
    ['env_json', 'TEXT'],
    ['autodeploy', 'INTEGER DEFAULT 0'],
    ['build_command', 'TEXT'],
    ['test_command', 'TEXT'],
    // off | warn | rollback — OFF by default, opt in per site. The probe calls
    // 127.0.0.1:<direct_port>, and an app that binds only to the LAN address would
    // look dead and be rolled back for no reason, so this must never switch itself
    // on for a site the operator has not checked.
    ['health_check', "TEXT DEFAULT 'off'"],
  ],
  monitors: [
    // Added after the monitors table first shipped (custom/replication checks).
    ['check_query', 'TEXT'],
    ['expect_op', 'TEXT'],
    ['expect_value', 'TEXT'],
    ['public', 'INTEGER NOT NULL DEFAULT 0'],
    ['compare_host', 'TEXT'],
    ['compare_port', 'INTEGER'],
    ['daily_at', 'TEXT'],
  ],
  mq_queues: [
    // Push mode, added after the queue tables first shipped.
    ['forward_url', 'TEXT'],
    ['forward_timeout_ms', 'INTEGER NOT NULL DEFAULT 15000'],
    ['forward_headers', 'TEXT'],
    // ALTER TABLE cannot add a UNIQUE column, so on an existing DB uniqueness
    // is enforced by the route's clash check instead of by the schema.
    ['listen_port', 'INTEGER'],
    ['listen_auth', 'INTEGER NOT NULL DEFAULT 1'],
  ],
};
for (const [table, cols] of Object.entries(MIGRATIONS)) {
  for (const [col, def] of cols) {
    try {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
    } catch {
      /* column already exists */
    }
  }
}

module.exports = db;
