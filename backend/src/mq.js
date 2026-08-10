'use strict';
// SQLite-backed message queue, SQS-shaped: publish → pull (lease) → ack.
//
// Delivery contract is AT-LEAST-ONCE. A consumer that pulls a message and dies
// before acking gets it re-delivered once the lease expires — that is the whole
// point (nothing is lost), and it means a consumer MUST tolerate seeing the same
// message twice. Exactly-once would need the consumer's work and the ack to
// commit together, which is not something this side can promise.
//
// Why this is race-free without locks: better-sqlite3 is synchronous and Node
// runs one thread, so a prepared statement runs to completion before any other
// request handler is entered. There is no yield point inside the claim UPDATE,
// so two consumers pulling at the same moment are actually serialised. The one
// rule that keeps it true: never split a claim across an `await`.
const httpMod = require('http');
const httpsMod = require('https');
const db = require('./db');
const settings = require('./settings');
const { emitLog } = require('./logbus');

// Bodies are stored as text in the same SQLite file as the panel's own data. A
// megabyte blob per message would bloat the DB and the WAL; the plant already
// has a File Share, so large payloads belong there with a path in the message.
const MAX_BODY_BYTES = 512 * 1024;

// A queue name is used in URLs and shown in the panel. Same charset rule as a
// site name so there is one thing to remember.
function queueNameError(v) {
  const s = String(v || '').trim();
  if (!s) return 'queue name required';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s)) {
    return 'queue name must start with a letter/number and contain only letters, numbers, . _ -';
  }
  if (s.length > 64) return 'queue name too long (max 64)';
  return null;
}

// Prepared statements are cached by better-sqlite3 per Statement object, so
// build them once instead of on every message (logbus.js does the same).
const S = {};
function stmt(key, sql) {
  if (!S[key]) S[key] = db.prepare(sql);
  return S[key];
}

// ---- queues --------------------------------------------------------------

function getQueue(name) {
  return stmt('qGet', 'SELECT * FROM mq_queues WHERE name=?').get(String(name));
}

// Publishing to a queue that does not exist creates it. Node-RED flows are
// edited by whoever owns the line, and making them fail until an admin has
// pre-registered the name would just get the queue step deleted.
function ensureQueue(name) {
  const q = getQueue(name);
  if (q) return q;
  stmt('qIns', 'INSERT OR IGNORE INTO mq_queues (name) VALUES (?)').run(String(name));
  return getQueue(name);
}

function listQueues() {
  const rows = stmt('qAll', 'SELECT * FROM mq_queues ORDER BY name').all();
  const depth = stmt(
    'qDepth',
    `SELECT state, COUNT(*) n, MIN(created_at) oldest
       FROM mq_messages WHERE queue_id=? GROUP BY state`
  );
  return rows.map((q) => {
    const counts = { ready: 0, delivered: 0, dead: 0 };
    let oldestReady = null;
    for (const r of depth.all(q.id)) {
      counts[r.state] = r.n;
      if (r.state === 'ready') oldestReady = r.oldest;
    }
    return {
      id: q.id,
      name: q.name,
      visibility_timeout: q.visibility_timeout,
      max_attempts: q.max_attempts,
      forward_url: q.forward_url,
      forward_timeout_ms: q.forward_timeout_ms,
      forward_headers: q.forward_headers,
      listen_port: q.listen_port,
      listen_auth: !!q.listen_auth,
      listening: listening(q.id),
      created_at: q.created_at,
      ...counts,
      // How far behind the consumer is, in seconds — the number that says
      // "someone needs to look at this" better than a raw depth does.
      oldest_ready_age: oldestReady ? Math.round((Date.now() - oldestReady) / 1000) : null,
    };
  });
}

// ---- publish -------------------------------------------------------------

function publish(queueName, body, { delaySec = 0 } = {}) {
  const q = ensureQueue(queueName);
  // Objects are stored as JSON; a string is stored as-is so a plain CSV line or
  // an already-serialised payload survives the round trip byte for byte.
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  if (text === undefined) throw new Error('body required');
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new Error(
      `body too large (max ${MAX_BODY_BYTES / 1024} KB) — store the file on the File Share and send its path instead`
    );
  }
  const now = Date.now();
  const delay = Math.max(0, Math.min(7 * 24 * 3600, parseInt(delaySec, 10) || 0));
  const info = stmt(
    'mIns',
    `INSERT INTO mq_messages (queue_id, state, body, created_at, not_before)
     VALUES (?, 'ready', ?, ?, ?)`
  ).run(q.id, text, now, delay ? now + delay * 1000 : null);
  return { id: Number(info.lastInsertRowid), queue: q.name };
}

// ---- pull (atomic claim) -------------------------------------------------

function pull(queueName, { max = 1, visibilitySec } = {}) {
  const q = getQueue(queueName);
  if (!q) return { queue: queueName, messages: [] };

  // Return this consumer's own timed-out messages before claiming new ones, so
  // a crashed worker's backlog is picked up immediately instead of waiting for
  // the next reaper tick.
  reap(q.id);

  const now = Date.now();
  const limit = Math.max(1, Math.min(100, parseInt(max, 10) || 1));
  const vis = Math.max(1, Math.min(3600, parseInt(visibilitySec, 10) || q.visibility_timeout));

  const rows = stmt(
    'mClaim',
    `UPDATE mq_messages
        SET state='delivered',
            attempts=attempts+1,
            ack_token=lower(hex(randomblob(16))),
            lease_until=@lease,
            first_pulled_at=COALESCE(first_pulled_at, @now)
      WHERE id IN (
        SELECT id FROM mq_messages
         WHERE queue_id=@qid AND state='ready'
           AND (not_before IS NULL OR not_before<=@now)
         ORDER BY id
         LIMIT @limit
      )
      RETURNING id, body, attempts, ack_token, created_at`
  ).all({ qid: q.id, now, lease: now + vis * 1000, limit });

  return {
    queue: q.name,
    lease_expires_in: vis,
    messages: rows.map((r) => ({
      id: r.id,
      ack: r.ack_token,
      body: r.body,
      attempts: r.attempts,
      created_at: r.created_at,
    })),
  };
}

// ---- ack / nack ----------------------------------------------------------

// Deleting on (id + token + delivered) makes a late ack a visible failure: if
// the lease already expired and someone else now holds the message, changes is
// 0 and the caller is told, instead of silently deleting another consumer's
// in-flight work.
function ack(queueName, items) {
  const q = getQueue(queueName);
  if (!q) return { acked: 0, failed: items.map((i) => i.id) };
  const del = stmt(
    'mAck',
    "DELETE FROM mq_messages WHERE id=? AND queue_id=? AND ack_token=? AND state='delivered'"
  );
  let acked = 0;
  const failed = [];
  for (const it of items) {
    const r = del.run(parseInt(it.id, 10) || 0, q.id, String(it.ack || ''));
    if (r.changes) acked += 1;
    else failed.push(it.id);
  }
  return { acked, failed };
}

// Hand a message back after a failed attempt. Past max_attempts it goes to the
// dead pile rather than round the loop again.
const nack = db.transaction((qid, maxAttempts, id, token, delaySec, error) => {
  const m = stmt(
    'mForNack',
    "SELECT * FROM mq_messages WHERE id=? AND queue_id=? AND ack_token=? AND state='delivered'"
  ).get(id, qid, token);
  if (!m) return null;
  const now = Date.now();
  const detail = error ? String(error).slice(0, 300) : null;
  if (m.attempts >= maxAttempts) {
    stmt(
      'mDead',
      "UPDATE mq_messages SET state='dead', dead_at=?, ack_token=NULL, lease_until=NULL, last_error=? WHERE id=?"
    ).run(now, detail || 'ผู้บริโภคปฏิเสธจนครบจำนวนครั้งที่ลอง', m.id);
    return 'dead';
  }
  const delay = Math.max(0, Math.min(7 * 24 * 3600, parseInt(delaySec, 10) || 0));
  stmt(
    'mRetry',
    "UPDATE mq_messages SET state='ready', ack_token=NULL, lease_until=NULL, not_before=?, last_error=? WHERE id=?"
  ).run(delay ? now + delay * 1000 : null, detail, m.id);
  return 'ready';
});

// ---- reaper --------------------------------------------------------------

// Recover messages whose lease expired: the consumer crashed, lost its network,
// or is simply slower than its visibility timeout.
//
// Order matters. Messages already at max_attempts are moved to 'dead' FIRST; if
// the requeue ran first they would go back to 'ready', be pulled again, and only
// then be found over the cap — one extra delivery per message, forever, for
// exactly the poison messages the cap exists to stop.
function reap(queueId = null) {
  const now = Date.now();
  const where = queueId ? 'AND m.queue_id=@qid' : '';
  const dead = stmt(
    queueId ? 'rDeadQ' : 'rDead',
    `UPDATE mq_messages AS m
        SET state='dead', dead_at=@now, ack_token=NULL, lease_until=NULL,
            last_error='ไม่ได้รับ ack ภายในเวลา และครบจำนวนครั้งที่ลองแล้ว'
       FROM mq_queues q
      WHERE q.id=m.queue_id AND m.state='delivered' AND m.lease_until<@now
        AND m.attempts>=q.max_attempts ${where}`
  ).run(queueId ? { now, qid: queueId } : { now });

  const back = stmt(
    queueId ? 'rBackQ' : 'rBack',
    `UPDATE mq_messages
        SET state='ready', ack_token=NULL, lease_until=NULL
      WHERE state='delivered' AND lease_until<@now ${queueId ? 'AND queue_id=@qid' : ''}`
  ).run(queueId ? { now, qid: queueId } : { now });

  return { dead: dead.changes, requeued: back.changes };
}

// ---- push mode (forward to a destination URL) ----------------------------
//
// With forward_url set the queue stops waiting and delivers by itself: it takes
// one message, POSTs it, and treats a 2xx as the ack. The producer's URL never
// changes, and when the destination service is down the messages pile up here
// instead of evaporating — which is the whole reason this exists.
//
// One message at a time per queue, deliberately. PLC readings are a time series
// and a parallel fan-out would deliver them out of order; a single in-flight
// request keeps the destination seeing exactly the order the producer sent.

// forward_url is admin-set and points at internal services on purpose (that is
// the feature), but it is still a URL this server dials on request, so keep it
// to real HTTP and reject anything that is not.
function forwardUrlError(v) {
  const s = String(v || '').trim();
  if (!s) return null; // empty = pull mode
  if (/[\r\n\0]/.test(s)) return 'ปลายทางห้ามมีขึ้นบรรทัดใหม่';
  let u;
  try {
    u = new URL(s);
  } catch {
    return 'ปลายทางต้องเป็น URL เต็ม เช่น http://127.0.0.1:12000/testqueue';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'ปลายทางต้องขึ้นต้นด้วย http:// หรือ https://';
  return null;
}

// HTTP header names are tokens and values must be visible ASCII; Node throws a
// synchronous TypeError otherwise. Caught here, at save time, because the
// alternative is a queue that looks configured and then stalls on every single
// delivery with nothing in the UI to explain why (a Thai or emoji API key pasted
// into the box is an easy way to get there).
function headerFieldError(name, value) {
  if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(String(name))) {
    return `ชื่อ header "${name}" ใช้ไม่ได้ — ต้องเป็นตัวอักษร/ตัวเลขภาษาอังกฤษเท่านั้น`;
  }
  if (!/^[\x20-\x7E\t]*$/.test(String(value))) {
    return `ค่าของ header "${name}" มีอักขระที่ส่งใน HTTP ไม่ได้ — ใช้ได้เฉพาะ ASCII (ห้ามภาษาไทย/emoji/ขึ้นบรรทัดใหม่)`;
  }
  return null;
}

function parseHeaders(json) {
  if (!json) return {};
  try {
    const o = JSON.parse(json);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

// POST one body. Resolves — never rejects — so a delivery failure is data, not
// an exception that could take the drain loop down with it.
function postOnce(url, body, { timeoutMs, headers }) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve({ ok: false, error: 'ปลายทางไม่ถูกต้อง' });
    }
    const mod = u.protocol === 'https:' ? httpsMod : httpMod;
    const payload = Buffer.from(body, 'utf8');
    const trimmed = body.trimStart();
    const t0 = Date.now();
    // Everything below is wrapped: http.request() throws SYNCHRONOUSLY on a
    // malformed header, and an escaping throw would reject this promise instead
    // of returning a result — drain() would then abandon the message still
    // leased, so it would sit invisible until the lease expired and fail the
    // same way forever, with only a generic timeout recorded against it. As a
    // resolved failure it goes down the normal retry/backoff/dead path with the
    // real reason attached.
    let req;
    try {
      req = mod.request(
        {
          method: 'POST',
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          timeout: timeoutMs,
          headers: {
            // Operator headers first so ours below always win — a wrong
            // Content-Length would truncate the body at the destination.
            ...headers,
            'Content-Type': trimmed.startsWith('{') || trimmed.startsWith('[') ? 'application/json' : 'text/plain; charset=utf-8',
            'Content-Length': payload.length,
          },
        },
        (res) => {
          res.resume(); // drain so the socket frees promptly
          const ms = Date.now() - t0;
          // 2xx only. Unlike a health probe, a 404 here means the message was
          // NOT accepted — retrying it is right, and silently deleting it is not.
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, ms, status: res.statusCode });
          else resolve({ ok: false, ms, error: `ปลายทางตอบ HTTP ${res.statusCode}` });
        }
      );
    } catch (e) {
      return resolve({ ok: false, error: `ส่งไม่ได้: ${e.message}` });
    }
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: `ปลายทางไม่ตอบใน ${Math.round(timeoutMs / 1000)} วินาที` });
    });
    req.on('error', (e) => resolve({ ok: false, error: `ต่อปลายทางไม่ได้: ${e.message}` }));
    try {
      req.end(payload);
    } catch (e) {
      resolve({ ok: false, error: `ส่งไม่ได้: ${e.message}` });
    }
  });
}

// Grows the gap between retries so a destination that is simply down is not
// hammered once a second for as long as it stays down.
function backoffSec(attempts) {
  return Math.min(300, 2 ** Math.max(1, attempts));
}

const draining = new Set(); // queue ids with a delivery in flight
// Queue id -> epoch-ms before which no delivery is attempted. The backoff after
// a failure belongs to the QUEUE, not to the message.
//
// Found by testing: with a per-message backoff, three messages that all failed
// each ended up with their own retry time, and when the destination came back
// they arrived 11, 12, 10 — the one with the shortest remaining wait went first.
// For a PLC time series that is corruption, not a delay. Holding the whole queue
// keeps the head message at the head: it is retried until it succeeds or hits
// max_attempts and is set aside as dead, and nothing ever overtakes it.
const blockedUntil = new Map();

async function drain(q) {
  if (draining.has(q.id)) return;
  const blocked = blockedUntil.get(q.id) || 0;
  if (Date.now() < blocked) return; // still serving out the queue's backoff
  draining.add(q.id);
  try {
    const headers = parseHeaders(q.forward_headers);
    const timeoutMs = Math.max(1000, Math.min(120_000, q.forward_timeout_ms || 15000));
    // The lease must outlive the request, or the reaper hands the message to the
    // next drain pass while this one is still waiting on the destination.
    const visibilitySec = Math.ceil(timeoutMs / 1000) + 10;
    for (;;) {
      const got = pull(q.name, { max: 1, visibilitySec });
      const m = got.messages[0];
      if (!m) return; // queue drained
      const r = await postOnce(q.forward_url, m.body, { timeoutMs, headers });
      if (r.ok) {
        ack(q.name, [{ id: m.id, ack: m.ack }]);
        blockedUntil.delete(q.id); // destination is answering again
      } else {
        const wait = backoffSec(m.attempts);
        // Hand it back with NO per-message delay so it stays at the head of the
        // queue; the wait is applied to the queue instead, just below.
        const state = nack(q.id, q.max_attempts, m.id, m.ack, 0, r.error);
        if (state === 'dead') {
          // The head is now out of the way, so let the next message try at once
          // rather than serve a backoff for a message that is no longer there.
          blockedUntil.delete(q.id);
        } else {
          blockedUntil.set(q.id, Date.now() + wait * 1000);
        }
        emitLog(
          'system',
          `[mq] ${q.name} #${m.id} ส่งไป ${q.forward_url} ไม่สำเร็จ (ครั้งที่ ${m.attempts}): ${r.error}` +
            (state === 'dead' ? ' — ครบจำนวนครั้งแล้ว ย้ายเข้ากอง dead' : ` — จะลองใหม่ใน ${wait} วินาที`)
        );
        return; // stop this pass; the queue backoff decides when to try again
      }
    }
  } catch (e) {
    emitLog('system', `[mq] ${q.name} ตัวส่งต่อมีปัญหา: ${e.message}`);
  } finally {
    draining.delete(q.id);
  }
}

// Kick every queue that has somewhere to send. Not awaited: a slow destination
// on one queue must not hold up the others.
function forwardTick() {
  const rows = stmt(
    'qForward',
    "SELECT * FROM mq_queues WHERE forward_url IS NOT NULL AND forward_url<>''"
  ).all();
  for (const q of rows) drain(q);
}

// Deliver as soon as something arrives instead of waiting for the next tick —
// a PLC reading should not sit for a second before it moves.
function kick(queueName) {
  const q = getQueue(queueName);
  if (q && q.forward_url) drain(q);
}

// ---- dedicated inbound port ----------------------------------------------
//
// A queue can own a port. Producers then POST to http://<server>:<port>/ and
// never touch the panel's port or its URL space — one address per data stream,
// which is also what a firewall rule wants to point at.
//
// Worth being straight about what this does NOT buy: the listener lives in this
// same Node process, so it shares the event loop and the SQLite file with the
// panel. It separates the ADDRESS, not the load. Real isolation would need a
// separate process, which is not what this is.
const listeners = new Map(); // queue id -> { server, key }

function listenKey(q) {
  return [q.listen_port, q.listen_auth, q.name].join('|');
}

function stopListener(id) {
  const e = listeners.get(id);
  if (!e) return;
  try {
    e.server.close();
  } catch {
    /* already closed */
  }
  listeners.delete(id);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0;
    let over = false;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        // Stop buffering, but keep draining the socket instead of destroying it:
        // a destroyed request cannot carry a response back, so the producer would
        // see a bare connection reset and have no idea the body was too big.
        if (!over) {
          over = true;
          chunks.length = 0;
          reject(new Error('too-large'));
        }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function startListener(q) {
  const server = httpMod.createServer(async (req, res) => {
    // A producer that hangs up mid-request would otherwise surface as an
    // uncaught socket error and take the whole manager down with it.
    req.on('error', () => {});
    res.on('error', () => {});
    const send = (code, obj) => {
      if (res.writableEnded) return;
      try {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      } catch {
        /* client already gone */
      }
    };
    // Only publishing lives here. Reading a queue, changing it, or minting a
    // token stays on the panel's port behind a real login — a wide-open producer
    // port must not become a way to drain or inspect the data.
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      return send(200, { ok: true, queue: q.name });
    }
    if (req.method !== 'POST') return send(405, { error: 'POST only' });
    if (q.listen_auth) {
      const tok = settings.get('mq_api_token');
      const h = req.headers.authorization || '';
      const provided = req.headers['x-api-token'] || (h.startsWith('Bearer ') ? h.slice(7) : null);
      // Fail closed: auth is on but no token has been generated yet means
      // nothing can be right, so refuse rather than wave everything through.
      if (!tok || provided !== tok) return send(401, { error: 'ต้องส่ง x-api-token' });
    }
    let body;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (e) {
      if (e.message === 'too-large') {
        // Let the rest of the upload arrive and be thrown away, then answer. A
        // response written while the client is still sending gets lost.
        await new Promise((done) => {
          req.on('end', done);
          req.on('error', done);
          req.resume();
        });
        return send(413, {
          error: `body ใหญ่เกิน ${MAX_BODY_BYTES / 1024} KB — เก็บไฟล์ไว้ที่ File Share แล้วส่งแค่ path มาแทน`,
        });
      }
      return send(400, { error: 'อ่าน body ไม่สำเร็จ' });
    }
    if (!body) return send(400, { error: 'body required' });
    try {
      const out = publish(q.name, body);
      kick(q.name);
      send(201, out);
    } catch (e) {
      send(400, { error: e.message });
    }
  });
  server.on('error', (e) => {
    emitLog('system', `[mq] คิว "${q.name}" เปิดพอร์ต :${q.listen_port} ไม่ได้: ${e.message}`);
    stopListener(q.id);
  });
  server.listen(q.listen_port, '0.0.0.0', () => {
    emitLog('system', `[mq] คิว "${q.name}" รับข้อมูลที่ :${q.listen_port}`);
  });
  listeners.set(q.id, { server, key: listenKey(q) });
}

// Bring open ports in line with the table — called on boot and after any change.
function reconcileListeners() {
  const rows = stmt('qAllRows', 'SELECT * FROM mq_queues').all();
  const ids = new Set(rows.map((r) => r.id));
  for (const id of [...listeners.keys()]) if (!ids.has(id)) stopListener(id);
  for (const q of rows) {
    const shouldRun = !!q.listen_port;
    const running = listeners.get(q.id);
    if (shouldRun && (!running || running.key !== listenKey(q))) {
      stopListener(q.id);
      startListener(q);
    } else if (!shouldRun && running) {
      stopListener(q.id);
    }
  }
}

function listening(id) {
  return listeners.has(id);
}

// Ports this manager already needs. A queue that grabbed one of these would
// either fail to bind or, worse, shadow the panel itself.
function portTaken(port, exceptQueueId = 0) {
  const config = require('./config');
  if (Number(port) === Number(config.PORT)) return 'พอร์ตนี้เป็นของ panel เอง';
  const site = db.prepare('SELECT name FROM sites WHERE direct_port=?').get(port);
  if (site) return `พอร์ตนี้ถูกใช้โดย site "${site.name}"`;
  const gw = db.prepare('SELECT name FROM gateways WHERE listen_port=?').get(port);
  if (gw) return `พอร์ตนี้ถูกใช้โดย gateway "${gw.name}"`;
  const q = db.prepare('SELECT name FROM mq_queues WHERE listen_port=? AND id<>?').get(port, exceptQueueId);
  if (q) return `พอร์ตนี้ถูกใช้โดยคิว "${q.name}"`;
  return null;
}

// ---- retention -----------------------------------------------------------

function deadRetentionDays() {
  const d = parseInt(settings.get('mq_dead_retention_days'), 10);
  return d > 0 ? d : 14;
}
function setDeadRetentionDays(d) {
  settings.set('mq_dead_retention_days', String(Math.max(1, parseInt(d, 10) || 14)));
}

// Only the dead pile ages out. A 'ready' message is never deleted for being old
// — durability is the entire product, and a queue nobody has drained for a month
// is a problem to be seen on the page, not one to be quietly cleaned up.
function pruneDead(days) {
  const d = Math.max(1, parseInt(days, 10) || deadRetentionDays());
  return stmt('mPrune', "DELETE FROM mq_messages WHERE state='dead' AND dead_at<?").run(
    Date.now() - d * 24 * 3600_000
  ).changes;
}

// ---- management ----------------------------------------------------------

// Read without claiming — for the panel. Bodies are truncated: a peek is for
// "what is stuck in here", and a full 512 KB body per row would make the
// response huge for no gain.
function peek(queueName, { state = 'ready', limit = 20 } = {}) {
  const q = getQueue(queueName);
  if (!q) return [];
  const n = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  const rows = stmt(
    'mPeek',
    'SELECT id, state, attempts, created_at, first_pulled_at, dead_at, last_error, substr(body,1,500) body, length(body) body_len FROM mq_messages WHERE queue_id=? AND state=? ORDER BY id LIMIT ?'
  ).all(q.id, String(state), n);
  return rows.map((r) => ({ ...r, truncated: r.body_len > 500 }));
}

function purge(queueName, state = null) {
  const q = getQueue(queueName);
  if (!q) return 0;
  return state
    ? stmt('mPurgeState', 'DELETE FROM mq_messages WHERE queue_id=? AND state=?').run(q.id, String(state)).changes
    : stmt('mPurgeAll', 'DELETE FROM mq_messages WHERE queue_id=?').run(q.id).changes;
}

// Put the dead pile back in the queue — the "we fixed the consumer, try again"
// button. Attempts reset, otherwise every requeued message would die again on
// its first failure.
function requeueDead(queueName) {
  const q = getQueue(queueName);
  if (!q) return 0;
  return stmt(
    'mRequeue',
    `UPDATE mq_messages
        SET state='ready', attempts=0, ack_token=NULL, lease_until=NULL,
            not_before=NULL, dead_at=NULL
      WHERE queue_id=? AND state='dead'`
  ).run(q.id).changes;
}

function deleteQueue(queueName) {
  const q = getQueue(queueName);
  if (!q) return false;
  stmt('mDelAll', 'DELETE FROM mq_messages WHERE queue_id=?').run(q.id);
  stmt('qDel', 'DELETE FROM mq_queues WHERE id=?').run(q.id);
  stopListener(q.id); // free the port immediately, don't wait for a reconcile
  blockedUntil.delete(q.id);
  return q; // the caller needs listen_port to close the firewall rule
}

function updateQueue(queueName, patch) {
  const q = getQueue(queueName);
  if (!q) return null;
  const pick = (key, fallback) => (patch[key] === undefined ? fallback : patch[key]);

  const vis = parseInt(pick('visibility_timeout', q.visibility_timeout), 10);
  const max = parseInt(pick('max_attempts', q.max_attempts), 10);
  if (!(vis >= 1 && vis <= 3600)) throw new Error('ระยะเวลามองไม่เห็นต้องอยู่ระหว่าง 1-3600 วินาที');
  if (!(max >= 1 && max <= 100)) throw new Error('จำนวนครั้งที่ลองต้องอยู่ระหว่าง 1-100');

  const fwd = String(pick('forward_url', q.forward_url) || '').trim();
  const fwdErr = forwardUrlError(fwd);
  if (fwdErr) throw new Error(fwdErr);
  const fwdTimeout = parseInt(pick('forward_timeout_ms', q.forward_timeout_ms), 10) || 15000;
  if (fwdTimeout < 1000 || fwdTimeout > 120_000) throw new Error('timeout ของปลายทางต้องอยู่ระหว่าง 1000-120000 มิลลิวินาที');
  const rawHeaders = pick('forward_headers', q.forward_headers);
  const headers = rawHeaders ? (typeof rawHeaders === 'string' ? rawHeaders : JSON.stringify(rawHeaders)) : null;
  if (headers) {
    let parsedHeaders;
    try {
      parsedHeaders = JSON.parse(headers);
      if (!parsedHeaders || typeof parsedHeaders !== 'object' || Array.isArray(parsedHeaders)) throw new Error();
    } catch {
      throw new Error('header เพิ่มเติมต้องเป็น JSON object เช่น {"x-api-key":"..."}');
    }
    for (const [k, v] of Object.entries(parsedHeaders)) {
      const e = headerFieldError(k, v);
      if (e) throw new Error(e);
    }
  }

  const rawPort = pick('listen_port', q.listen_port);
  const port = rawPort === null || rawPort === '' ? null : parseInt(rawPort, 10);
  if (port !== null) {
    if (!(port >= 1 && port <= 65535)) throw new Error('พอร์ตต้องอยู่ระหว่าง 1-65535');
    const taken = portTaken(port, q.id);
    if (taken) throw new Error(taken);
  }
  const listenAuth = pick('listen_auth', q.listen_auth) ? 1 : 0;

  stmt(
    'qUpd',
    `UPDATE mq_queues
        SET visibility_timeout=?, max_attempts=?, forward_url=?, forward_timeout_ms=?,
            forward_headers=?, listen_port=?, listen_auth=?
      WHERE id=?`
  ).run(vis, max, fwd || null, fwdTimeout, headers, port, listenAuth, q.id);

  reconcileListeners();
  const updated = getQueue(queueName);
  if (updated.forward_url) {
    // The operator just changed something — most likely because they fixed the
    // destination. Drop the backoff and try immediately instead of making them
    // wait out a penalty earned by the old setting.
    blockedUntil.delete(updated.id);
    drain(updated);
  }
  return updated;
}

// ---- lifecycle -----------------------------------------------------------

function start() {
  // A crash leaves messages stuck in 'delivered' with a lease that will never be
  // acked; sweeping once on boot returns them without waiting for a full tick.
  try {
    reap();
  } catch {
    /* a broken sweep must not stop the server from starting */
  }
  setInterval(() => {
    try {
      reap();
    } catch {
      /* ignore */
    }
  }, 10_000).unref();
  setInterval(() => {
    try {
      pruneDead(deadRetentionDays());
    } catch {
      /* ignore */
    }
  }, 3600_000).unref();

  // Dedicated inbound ports, then the push loop. The 1s tick is the safety net
  // behind kick(): it also picks up messages whose retry backoff has expired.
  try {
    reconcileListeners();
  } catch (e) {
    emitLog('system', `[mq] เปิดพอร์ตของคิวไม่สำเร็จ: ${e.message}`);
  }
  setInterval(() => {
    try {
      forwardTick();
    } catch {
      /* ignore */
    }
  }, 1000).unref();
}

module.exports = {
  MAX_BODY_BYTES,
  queueNameError,
  getQueue,
  ensureQueue,
  listQueues,
  publish,
  pull,
  ack,
  nack,
  reap,
  peek,
  purge,
  requeueDead,
  deleteQueue,
  updateQueue,
  deadRetentionDays,
  setDeadRetentionDays,
  pruneDead,
  forwardUrlError,
  portTaken,
  reconcileListeners,
  listening,
  kick,
  start,
};
