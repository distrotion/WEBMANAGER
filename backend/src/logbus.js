'use strict';
const { WebSocketServer } = require('ws');
const { EventEmitter } = require('events');
const { verifyAnyToken } = require('./auth');
const db = require('./db');

// Central event bus: every spawned command line is emitted here, persisted to
// SQLite, and fanned out to WebSocket clients subscribed to the matching channel.
const bus = new EventEmitter();
bus.setMaxListeners(0);

const _insertLog = db.prepare('INSERT INTO logs (channel, line) VALUES (?, ?)');

function emitLog(channel, line) {
  if (process.env.WM_LOG_CONSOLE) console.log(`[${channel}] ${line}`);
  if (channel && channel !== 'silent') {
    try {
      _insertLog.run(channel, String(line));
    } catch {
      /* logging must never break the action */
    }
  }
  bus.emit('log', { channel, line, t: Date.now() });
}

function makeWss() {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const channel = url.searchParams.get('channel') || 'system';
    if (!verifyAnyToken(token)) {
      ws.close(4001, 'unauthorized');
      return;
    }
    const handler = (evt) => {
      if (channel === '*' || evt.channel === channel) {
        try {
          ws.send(JSON.stringify(evt));
        } catch {
          /* socket closing */
        }
      }
    };
    bus.on('log', handler);
    ws.send(JSON.stringify({ channel, line: `[connected to ${channel}]`, t: Date.now() }));
    ws.on('close', () => bus.off('log', handler));
  });
  return wss;
}

module.exports = { emitLog, makeWss, bus };
