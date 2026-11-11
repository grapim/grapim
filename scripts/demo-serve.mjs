// Builds the demo repo (four agents, a block, an undo) and opens the review
// desk on it, so you can click through Grapim with real data in one command:
//
//   node scripts/demo-serve.mjs [--port 7420]
//
// The repo lives in a temp folder; its path is printed.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '7420';

const demo = spawnSync(process.execPath, [path.join(here, 'demo.mjs'), '--fast', '--keep'], {
  encoding: 'utf8',
  env: { ...process.env, NO_COLOR: '1' },
});
const repo = /repo kept at (.+)$/m.exec(demo.stdout ?? '')?.[1]?.trim();
if (demo.status !== 0 || !repo) {
  process.stderr.write(`The demo did not finish:\n${demo.stderr || demo.stdout}\n`);
  process.exit(1);
}
console.log(`Demo repo: ${repo}`);

const server = spawn(process.execPath, [path.join(here, '..', 'bin', 'grapim.js'), 'serve', '--port', port], {
  cwd: repo,
  stdio: 'inherit',
});
server.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill());
