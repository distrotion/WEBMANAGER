'use strict';
const { run } = require('./runner');

// Manage a Windows Firewall inbound rule per direct port so LAN machines can reach
// it. No-op on non-Windows (dev). The manager service runs as LocalSystem (admin),
// so netsh is allowed.
function ruleName(port) {
  return `wm-port-${port}`;
}

async function openPort(port, channel = 'system') {
  if (process.platform !== 'win32' || !port) return { code: 0 };
  const name = ruleName(port);
  // delete-then-add = idempotent
  await run('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`], {
    channel: 'silent',
  });
  return run(
    'netsh',
    [
      'advfirewall', 'firewall', 'add', 'rule',
      `name=${name}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`,
    ],
    { channel }
  );
}

async function closePort(port, channel = 'system') {
  if (process.platform !== 'win32' || !port) return { code: 0 };
  return run('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${ruleName(port)}`], {
    channel,
  });
}

// Port RANGE variant — FTP passive mode needs one, unlike every other feature
// here (gateway/mq/https) which opens a single port. One rule for the whole
// range instead of one per port: netsh accepts "min-max" directly.
function rangeName(min, max) {
  return `wm-portrange-${min}-${max}`;
}

async function openPortRange(min, max, channel = 'system') {
  if (process.platform !== 'win32' || !min || !max) return { code: 0 };
  const name = rangeName(min, max);
  await run('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`], {
    channel: 'silent',
  });
  return run(
    'netsh',
    [
      'advfirewall', 'firewall', 'add', 'rule',
      `name=${name}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${min}-${max}`,
    ],
    { channel }
  );
}

async function closePortRange(min, max, channel = 'system') {
  if (process.platform !== 'win32' || !min || !max) return { code: 0 };
  return run('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${rangeName(min, max)}`], {
    channel,
  });
}

module.exports = { openPort, closePort, ruleName, openPortRange, closePortRange, rangeName };
