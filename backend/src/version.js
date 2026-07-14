'use strict';
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('./config');

// Version string shown in the UI so you can tell at a glance whether a server
// runs the latest build. install.ps1 stamps WM_VERSION (git hash + date) into
// .env at install time; dev runs straight from the repo, so fall back to asking
// git for the checkout's HEAD.
let v = process.env.WM_VERSION || null;
if (!v) {
  try {
    v = execFileSync(
      config.git.exe,
      ['-C', path.join(__dirname, '..'), 'rev-parse', '--short', 'HEAD'],
      { timeout: 3000 }
    )
      .toString()
      .trim();
  } catch {
    /* not running from a git checkout */
  }
}

module.exports = v || 'unknown';
