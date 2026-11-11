// Many separate processes race for the same file. Exactly one may win, every
// round. This is the property the whole product rests on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claim-worker.js');

function run(stateDir, agent, files) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [worker, stateDir, agent, ...files], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || `exit ${code}`))));
  });
}

test('30 processes racing for one file: exactly one wins, 5 rounds', async () => {
  for (let round = 0; round < 5; round++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-race-'));
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => run(dir, `agent-${i}`, ['src/routes.ts'])));
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, `round ${round}: ${winners.length} winners`);
  }
});

test('overlapping multi-file claims never give one file to two agents', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-race-'));
  const sets = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a'], ['a', 'c'], ['b', 'd'], ['e'], ['e', 'a']];
  const results = await Promise.all(sets.flatMap((s, i) => [run(dir, `x${i}`, s), run(dir, `y${i}`, s)]));
  const held = new Map();
  for (const r of results.filter((r) => r.ok)) {
    for (const file of r.claimed) {
      assert.equal(held.has(file), false, `${file} given to ${held.get(file)} and ${r.agent}`);
      held.set(file, r.agent);
    }
  }
  assert.ok(held.size > 0);
});
