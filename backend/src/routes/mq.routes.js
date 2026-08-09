'use strict';
// HTTP face of the message queue. Two planes with different guards:
//
//   data plane   (publish / pull / ack / nack) — x-api-token OR admin login.
//     Scripts, Node-RED flows and PLC bridges live here. They run unattended on
//     other machines, so they get a token rather than a password.
//
//   management   (list / inspect / purge / rotate token) — real login only.
//     A leaked token can therefore pump and drain queues, but cannot read what
//     is inside them, delete a queue, or mint itself a new token. That is the
//     same split gateway.routes.js uses, for the same reason.
const crypto = require('crypto');
const express = require('express');
const mq = require('../mq');
const firewall = require('../firewall');
const settings = require('../settings');
const { audit } = require('../audit');
const { verifyAnyToken } = require('../auth');

const router = express.Router();

function mqAuth(req, res, next) {
  const apiTok = settings.get('mq_api_token');
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : null;
  const provided = req.headers['x-api-token'] || bearer;
  if (apiTok && provided === apiTok) {
    req.user = { username: 'api-token', role: 'admin' };
    return next();
  }
  const payload = bearer && verifyAnyToken(bearer);
  if (payload && payload.role === 'admin') {
    req.user = payload;
    return next();
  }
  return res.status(401).json({ error: 'unauthorized: need x-api-token or admin login' });
}
router.use(mqAuth);

const adminOnly = (req, res, next) =>
  req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'admin only' });

// The api-token identity fails this, so a leaked token cannot rotate itself.
function tokenAdmin(req, res, next) {
  if (req.user && req.user.username !== 'api-token') return next();
  return res.status(403).json({ error: 'manage the token from a logged-in session' });
}

// ---- token management (real login only) ----
router.get('/token', adminOnly, tokenAdmin, (req, res) =>
  res.json({ hasToken: !!settings.get('mq_api_token') })
);
router.post('/token', adminOnly, tokenAdmin, (req, res) => {
  const token = 'mqt_' + crypto.randomBytes(24).toString('hex');
  settings.set('mq_api_token', token);
  audit(req.user, 'mq-token', 'generate');
  res.json({ token });
});
router.delete('/token', adminOnly, tokenAdmin, (req, res) => {
  settings.del('mq_api_token');
  audit(req.user, 'mq-token', 'revoke');
  res.json({ ok: true });
});

// ---- management: queues ----
router.get('/queues', adminOnly, tokenAdmin, (req, res) => res.json(mq.listQueues()));

router.post('/queues', adminOnly, tokenAdmin, (req, res) => {
  const b = req.body || {};
  const err = mq.queueNameError(b.name);
  if (err) return res.status(400).json({ error: err });
  if (mq.getQueue(b.name)) return res.status(409).json({ error: 'queue already exists' });
  mq.ensureQueue(String(b.name).trim());
  const SETTABLE = ['visibility_timeout', 'max_attempts', 'forward_url', 'forward_timeout_ms',
    'forward_headers', 'listen_port', 'listen_auth'];
  try {
    if (SETTABLE.some((k) => b[k] !== undefined)) mq.updateQueue(String(b.name).trim(), b);
  } catch (e) {
    // The queue exists by now (ensureQueue), so a rejected setting would leave a
    // half-configured queue behind — remove it and report the real reason.
    mq.deleteQueue(String(b.name).trim());
    return res.status(400).json({ error: e.message });
  }
  const created = mq.listQueues().find((q) => q.name === String(b.name).trim());
  if (created.listen_port) firewall.openPort(created.listen_port, 'system').catch(() => {});
  audit(req.user, 'mq-queue-create', created.name, created.listen_port ? `port :${created.listen_port}` : null);
  res.status(201).json(created);
});

// ---- data plane ----
// Declared after the literal /queues and /token paths but on a distinct /q
// prefix, so no route here can shadow another.

// `POST /q/:name` publishes too — the short form is what goes into a Node-RED
// http-request node, and one less path segment is one less thing to get wrong.
function publishHandler(req, res) {
  const err = mq.queueNameError(req.params.name);
  if (err) return res.status(400).json({ error: err });
  const b = req.body || {};
  // `{body: ...}` is the documented shape, but a flow that posts its payload
  // straight through (no wrapper) is the obvious mistake to make, so accept the
  // whole request body in that case rather than storing an empty message.
  const payload = 'body' in b ? b.body : b;
  if (payload === undefined || payload === null || payload === '') {
    return res.status(400).json({ error: 'body required' });
  }
  try {
    const name = String(req.params.name).trim();
    const out = mq.publish(name, payload, { delaySec: b.delay_s });
    mq.kick(name); // push mode: deliver now, don't wait for the next tick
    res.status(201).json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}
router.post('/q/:name/messages', publishHandler);
// Short form — this is what goes into a Node-RED http-request node, and one
// fewer path segment is one fewer thing to get wrong.
router.post('/q/:name', publishHandler);

router.post('/q/:name/pull', (req, res) => {
  const err = mq.queueNameError(req.params.name);
  if (err) return res.status(400).json({ error: err });
  const b = req.body || {};
  res.json(mq.pull(String(req.params.name).trim(), { max: b.max, visibilitySec: b.visibility_s }));
});

router.post('/q/:name/ack', (req, res) => {
  const err = mq.queueNameError(req.params.name);
  if (err) return res.status(400).json({ error: err });
  const b = req.body || {};
  const items = Array.isArray(b.acks) ? b.acks : [{ id: b.id, ack: b.ack }];
  if (!items.length || items.some((i) => !i || i.id === undefined || !i.ack)) {
    return res.status(400).json({ error: 'each ack needs {id, ack}' });
  }
  res.json(mq.ack(String(req.params.name).trim(), items));
});

router.post('/q/:name/nack', (req, res) => {
  const err = mq.queueNameError(req.params.name);
  if (err) return res.status(400).json({ error: err });
  const b = req.body || {};
  const q = mq.getQueue(String(req.params.name).trim());
  if (!q) return res.status(404).json({ error: 'queue not found' });
  if (b.id === undefined || !b.ack) return res.status(400).json({ error: '{id, ack} required' });
  const state = mq.nack(q.id, q.max_attempts, parseInt(b.id, 10) || 0, String(b.ack), b.delay_s, b.error);
  if (!state) return res.status(409).json({ error: 'not held by you any more (lease expired or already acked)' });
  res.json({ id: parseInt(b.id, 10), state });
});

// ---- management: one queue ----
router.get('/q/:name/peek', adminOnly, tokenAdmin, (req, res) => {
  res.json(mq.peek(String(req.params.name).trim(), { state: req.query.state || 'ready', limit: req.query.limit }));
});

router.put('/q/:name', adminOnly, tokenAdmin, (req, res) => {
  const before = mq.getQueue(String(req.params.name).trim());
  try {
    const q = mq.updateQueue(String(req.params.name).trim(), req.body || {});
    if (!q) return res.status(404).json({ error: 'queue not found' });
    // Keep the firewall in step with the port the queue actually listens on.
    if (before && before.listen_port !== q.listen_port) {
      if (before.listen_port) firewall.closePort(before.listen_port, 'system').catch(() => {});
      if (q.listen_port) firewall.openPort(q.listen_port, 'system').catch(() => {});
    }
    audit(req.user, 'mq-queue-update', q.name,
      `visibility=${q.visibility_timeout}s attempts=${q.max_attempts}` +
      (q.forward_url ? ` forward=${q.forward_url}` : ' forward=off') +
      (q.listen_port ? ` port=:${q.listen_port}` : ''));
    res.json(mq.listQueues().find((x) => x.name === q.name));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/q/:name', adminOnly, tokenAdmin, (req, res) => {
  const name = String(req.params.name).trim();
  const removed = mq.deleteQueue(name);
  if (!removed) return res.status(404).json({ error: 'queue not found' });
  if (removed.listen_port) firewall.closePort(removed.listen_port, 'system').catch(() => {});
  audit(req.user, 'mq-queue-delete', name);
  res.json({ ok: true });
});

router.post('/q/:name/purge', adminOnly, tokenAdmin, (req, res) => {
  const name = String(req.params.name).trim();
  if (!mq.getQueue(name)) return res.status(404).json({ error: 'queue not found' });
  const state = req.body && req.body.state ? String(req.body.state) : null;
  if (state && !['ready', 'delivered', 'dead'].includes(state)) {
    return res.status(400).json({ error: 'state must be ready, delivered or dead' });
  }
  const removed = mq.purge(name, state);
  audit(req.user, 'mq-purge', name, `${removed} messages${state ? ` (${state})` : ''}`);
  res.json({ removed });
});

router.post('/q/:name/dead/requeue', adminOnly, tokenAdmin, (req, res) => {
  const name = String(req.params.name).trim();
  if (!mq.getQueue(name)) return res.status(404).json({ error: 'queue not found' });
  const requeued = mq.requeueDead(name);
  audit(req.user, 'mq-requeue-dead', name, `${requeued} messages`);
  res.json({ requeued });
});

module.exports = router;
