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

module.exports = { openPort, closePort, ruleName };
