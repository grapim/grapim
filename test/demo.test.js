// The launch demo (scripts/demo.mjs) run with --fast: the moments it is meant
// to show must really happen, in the output and in the repo it leaves behind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'demo.mjs');

test('the demo blocks the edit, undoes one run and keeps the others', () => {
  const r = spawnSync(process.execPath, [DEMO, '--fast', '--keep'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.doesNotMatch(out, /\x1b\[/, 'no ANSI codes with NO_COLOR');
  assert.doesNotMatch(r.stderr, /grapim (ledger|hook error)/);
  const repo = out.match(/repo kept at (.+)/)[1].trim();
  try {
    // Four agents, three files claimed.
    assert.match(out, /4 agents active · 3 files claimed/);

    // The block, as the Claude Code agent receives it from the hook (unwrapped for the check).
    const message = [...out.matchAll(/^ {2}│ (.*)$/gm)].map((m) => m[1]).join(' ');
    assert.match(message, /^Grapim: src\/routes\.js is claimed by another agent, codex \d+, \d+s ago, working on: "Add a \/billing endpoint"\./);
    assert.match(message, /so this edit was not applied/);

    const [before, after] = out.split('$ grapim undo ');
    assert.ok(after, 'the demo runs grapim undo');

    // Before the undo, three runs share src/routes.js and the tests fail.
    const routeLines = (s) => [...s.matchAll(/^\s*\d+ {2}(\S+ \S+) +turn \d+ {2}\| (.*)$/gm)].map((m) => [m[1], m[2].trim()]);
    const blameBefore = routeLines(before.slice(before.indexOf('$ grapim blame src/routes.js')));
    assert.equal(new Set(blameBefore.map(([who]) => who)).size, 3);
    assert.ok(blameBefore.some(([who, line]) => who === 'claude 7c41e0d2' && line.includes('rateLimit')));
    assert.match(before, /5 passed, 1 failed\n {2}FAIL {2}GET \/nope returns 404: got 429/);

    // The undo itself.
    assert.match(after, /^7c41 --yes\nUndo claude 7c41e0d2 · 2 files/);
    assert.match(after, /deleted {3}src\/ratelimit\.js/);
    assert.match(after, /reverted {2}src\/routes\.js {5}its edits removed, later work by others kept/);

    // After it: B's lines are gone, A's (Codex) and C's (the other Claude) stay, the tests pass.
    const blameAfter = routeLines(after);
    assert.equal(blameAfter.filter(([who]) => who === 'claude 7c41e0d2').length, 0);
    assert.deepEqual(blameAfter.map(([who]) => who.split(' ')[0]), ['codex', 'claude', 'codex']);
    assert.ok(blameAfter.some(([who, line]) => who === 'claude 3e8b51a9' && line.includes('/users/verify')));
    assert.match(after, /\n6 passed\n/);

    // And on disk.
    const read = (f) => fs.readFileSync(path.join(repo, f), 'utf8');
    const routes = read('src/routes.js');
    assert.doesNotMatch(routes, /rateLimit/);
    assert.match(routes, /import \* as billing from '\.\/billing\.js';/);
    assert.match(routes, /app\.post\('\/billing\/invoices', billing\.create\);/);
    assert.match(routes, /app\.post\('\/users\/verify', users\.verify\);/);
    assert.equal(fs.existsSync(path.join(repo, 'src/ratelimit.js')), false);
    assert.match(read('src/users.js'), /export function verify/);
    assert.match(read('src/server.js'), /status: 500/);
    assert.ok(fs.existsSync(path.join(repo, 'src/billing.js')));
  } finally {
    fs.rmSync(path.dirname(repo), { recursive: true, force: true });
  }
});
