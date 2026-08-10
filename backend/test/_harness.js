'use strict';
// Minimal test harness — no framework, no dependency.
//
// Each test file runs in its own process against its own throwaway
// WEBMANAGER_ROOT (see run.js), so tests never see each other's rows and can
// never touch a real install's database. That isolation is the whole reason for
// a runner: an earlier throwaway script used the wrong env var name and wrote
// its fixtures straight into the dev database.
const http = require('http');

let passed = 0;
let failed = 0;
const failures = [];

function section(title) {
  console.log(`\n  ${title}`);
}

function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`    ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`    ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, a === e ? '' : `ได้ ${a} คาดว่า ${e}`);
}

// Assert that a call rejects, and that it says why in a recognisable way — a
// guard that throws the wrong error is as good as no guard when an operator has
// to act on the message.
function throws(name, fn, pattern) {
  try {
    fn();
    ok(name, false, 'ไม่ได้โยน error');
  } catch (e) {
    ok(name, pattern.test(e.message), pattern.test(e.message) ? '' : `ข้อความ: ${e.message}`);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/// Wait for `check()` to become truthy, up to `timeoutMs`. Polling beats a fixed
/// sleep: it keeps the suite fast when things are quick and still passes on a
/// loaded machine instead of failing on a hard-coded delay.
async function until(check, { timeoutMs = 15000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await wait(everyMs);
  }
}

/// A throwaway HTTP server that records what it receives. Used as a stand-in
/// both for a delivery destination and for the alert webhook.
async function fakeServer(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      const r = handler ? handler(req, body) : { status: 200, body: 'ok' };
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise((r) => server.close(r)),
  };
}

/// POST to a URL and return {code, body}. Resolves on transport failure too
/// (code 0), because "the connection died" is itself an assertable outcome.
function post(url, body, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const payload = Buffer.from(body ?? '', 'utf8');
    // http.request() throws synchronously on a header Node will not send. A
    // test that does that should get an assertable result, not take the whole
    // file down before the later sections run.
    let req;
    try {
      req = http.request(
        {
          method: 'POST',
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          timeout: 20000,
          headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, ...headers },
        },
        (res) => {
          let s = '';
          res.on('data', (c) => (s += c));
          res.on('end', () => resolve({ code: res.statusCode, body: s }));
        }
      );
    } catch (e) {
      return resolve({ code: 0, body: e.message });
    }
    req.on('timeout', () => {
      req.destroy();
      resolve({ code: 0, body: 'timeout' });
    });
    req.on('error', (e) => resolve({ code: 0, body: e.message }));
    req.end(payload);
  });
}

function done() {
  console.log(failed ? `\n  ${failed} ล้มเหลว: ${failures.join(', ')}` : `\n  ผ่านทั้งหมด ${passed} ข้อ`);
  process.exit(failed ? 1 : 0);
}

module.exports = { section, ok, eq, throws, wait, until, fakeServer, post, done };
