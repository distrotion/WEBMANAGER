'use strict';
// Deploy notifications. A CI/CD pipeline that rolls back silently is only half a
// pipeline — someone has to learn the old version is back up. Posts a small JSON
// body to a webhook URL (settings key notify_webhook_url), which covers Teams,
// Slack, Discord, Google Chat and any custom receiver.
//
// Never throws and never blocks a deploy: a broken webhook must not fail a
// release. Only failures/rollbacks/recoveries are sent — a green deploy every
// three minutes would train people to ignore the channel.
const settings = require('./settings');
const { emitLog } = require('./logbus');

// Slack/Discord/Teams all render a plain `text` field; extra keys are ignored by
// them and available to a custom receiver.
function payload(event) {
  const icon = event.ok ? '✅' : event.rolledBack ? '↩️' : '❌';
  const what = event.ok
    ? `recovered — now on ${event.commit || 'latest'}`
    : event.rolledBack
    ? `deploy FAILED at ${event.step} — rolled back to ${event.commit || 'previous version'}`
    : `deploy FAILED at ${event.step}`;
  return {
    text: `${icon} [${event.host}] ${event.site}: ${what}`,
    site: event.site,
    host: event.host,
    ok: event.ok,
    step: event.step || null,
    commit: event.commit || null,
    rolledBack: !!event.rolledBack,
    triggeredBy: event.by || null,
  };
}

async function send(event) {
  const url = (settings.get('notify_webhook_url') || '').trim();
  if (!url) return;
  try {
    const body = JSON.stringify(payload({ host: require('os').hostname(), ...event }));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ctrl.signal,
      });
      if (!r.ok) emitLog('system', `[notify] webhook returned HTTP ${r.status}`);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    emitLog('system', `[notify] webhook failed: ${e.message}`);
  }
}

// Fire-and-forget: callers must not await this in a deploy path.
function fire(event) {
  send(event).catch(() => {
    /* already logged */
  });
}

module.exports = { fire, send };
