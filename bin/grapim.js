#!/usr/bin/env node
// Written so that an old Node can parse it: no static imports (they load
// before any line runs), no top-level await, no syntax newer than ES2015. The
// version is checked first, then the CLI is loaded. 22.13 is the first Node
// 22 with the built-in SQLite module (node:sqlite) unflagged, which the
// ledger needs.
var MIN = [22, 13];
var have = process.versions.node.split('.').map(Number);
if (have[0] < MIN[0] || (have[0] === MIN[0] && have[1] < MIN[1])) {
  process.stderr.write(
    'grapim needs Node.js ' + MIN.join('.') + ' or newer, and this is Node ' + process.versions.node + '.\n' +
      'Install the current LTS from https://nodejs.org (with nvm: nvm install --lts), then run grapim again.\n',
  );
  process.exit(1);
}

// Keep Node's notice about the built-in SQLite module out of hook output,
// which the agents show to the model.
process.removeAllListeners('warning');

import('../src/cli.js')
  .then(function (cli) {
    return cli.main(process.argv.slice(2));
  })
  .then(
    function (code) {
      if (typeof code === 'number') process.exitCode = code;
    },
    function (err) {
      process.stderr.write('grapim: ' + (err && err.message ? err.message : String(err)) + '\n');
      if (process.env.GRAPIM_DEBUG) process.stderr.write(String(err && err.stack) + '\n');
      else process.stderr.write('If this looks like a bug in grapim: run it again with GRAPIM_DEBUG=1 for details, and tell us at https://app.grapim.com/support\n');
      process.exitCode = 1;
    },
  );
