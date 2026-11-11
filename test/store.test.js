import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-store-'));
const f = (p) => ({ key: p.toLowerCase(), display: p });

test('second agent is refused while the first holds the file', () => {
  const s = new Store(tmp());
  assert.equal(s.claim('a', [f('src/app.ts')], { intent: 'billing' }).ok, true);
  const r = s.claim('b', [f('src/app.ts')]);
  assert.equal(r.ok, false);
  assert.equal(r.conflicts[0].agent, 'a');
  assert.equal(r.conflicts[0].intent, 'billing');
  s.close();
});

test('the holder can claim again (refresh) without conflict', () => {
  const s = new Store(tmp());
  assert.equal(s.claim('a', [f('x')]).ok, true);
  assert.equal(s.claim('a', [f('x')]).ok, true);
  assert.equal(s.leases().length, 1);
  s.close();
});

test('multi-file claim is all or nothing', () => {
  const s = new Store(tmp());
  s.claim('a', [f('b.ts')]);
  const r = s.claim('b', [f('a.ts'), f('b.ts'), f('c.ts')]);
  assert.equal(r.ok, false);
  assert.deepEqual(s.leases().map((l) => l.path), ['b.ts']);
  s.close();
});

test('claims expire after their ttl', () => {
  let now = 1_000_000;
  const s = new Store(tmp(), { now: () => now });
  s.claim('a', [f('x')], { ttlMs: 60_000 });
  now += 59_000;
  assert.equal(s.claim('b', [f('x')]).ok, false);
  now += 2_000;
  assert.equal(s.claim('b', [f('x')]).ok, true);
  s.close();
});

test('release frees only your own files; endSession frees all of yours', () => {
  const s = new Store(tmp());
  s.claim('a', [f('x'), f('y')]);
  s.claim('b', [f('z')]);
  assert.deepEqual(s.release('b', ['x']), []);
  assert.deepEqual(s.release('a', ['x']), ['x']);
  assert.deepEqual(s.endSession('a'), ['y']);
  assert.deepEqual(s.leases().map((l) => l.path), ['z']);
  assert.equal(s.activeAgents().some((a) => a.agent === 'a'), false);
  s.close();
});

test('intent shows on the agent and on its leases', () => {
  const s = new Store(tmp());
  s.claim('a', [f('x')]);
  s.setIntent('a', 'add /billing');
  assert.equal(s.leases()[0].intent, 'add /billing');
  assert.equal(s.activeAgents()[0].intent, 'add /billing');
  s.close();
});
