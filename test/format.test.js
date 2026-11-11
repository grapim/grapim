// Output formatting of runs, status, blame and undo, from plain rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blameText, runsText, statusText, undoText } from '../src/format.js';

const NOW = 1_000_000;
const run = (over) => ({ run: 'r', label: 'r', intent: 'x', worktree: 'main', turns: 1, files: 1, added: 1, removed: 0, last_ts: NOW, ...over });

test('runs hides the WORKTREE column when every run is in one worktree', () => {
  const one = runsText([run({ run: 'a', label: 'claude aaaa1111' }), run({ run: 'b', label: 'codex 42' })], new Map(), NOW);
  assert.match(one.split('\n')[0], /^RUN {14}WORKING ON {2}TURNS/);
  assert.doesNotMatch(one, /WORKTREE|main/);
  const two = runsText([run({ run: 'a' }), run({ run: 'b', worktree: 'billing' })], new Map(), NOW);
  assert.match(two.split('\n')[0], /^RUN {2}WORKTREE {2}WORKING ON/);
  assert.match(two, /billing/);
});

test('status hides the WORKTREE column only when agents and claims share one worktree', () => {
  const store = (leaseWorktree) => ({
    activeAgents: () => [{ agent: 'a', label: 'claude aaaa1111', intent: 'x', worktree: 'main', last_seen: NOW }],
    leases: () => [{ path: 'src/a.js', agent: 'a', label: 'claude aaaa1111', intent: 'x', worktree: leaseWorktree, acquired_at: NOW }],
  });
  assert.doesNotMatch(statusText({ repo: 'shop' }, store('main'), NOW), /WORKTREE/);
  const mixed = statusText({ repo: 'shop' }, store('billing'), NOW);
  assert.match(mixed, /AGENT {12}WORKTREE/);
  assert.match(mixed, /FILE {6}HELD BY {10}WORKTREE/);
});

test('blame lines the turn column up under labels of different lengths', () => {
  const text = blameText({
    path: 'src/routes.js',
    base: 'HEAD',
    exists: true,
    removed: 0,
    lines: [
      { line: 3, run: 'codex:42', label: 'codex 42', turn: 1, text: 'a' },
      { line: 4, run: 'claude-code:7c41', label: 'claude 7c41e0d2', turn: 2, text: 'b' },
      { line: 12, run: null, label: 'outside agents', turn: null, text: 'c' },
    ],
  });
  assert.deepEqual(text.split('\n').slice(2), [
    ' 3  codex 42         turn 1  | a',
    ' 4  claude 7c41e0d2  turn 2  | b',
    '12  outside agents           | c',
  ]);
});

test('an applied undo says how many files it changed', () => {
  const plan = (actions) => ({ run: { run: 'r', label: 'claude aaaa1111' }, turn: null, files: actions.map((action, i) => ({ path: `f${i}.js`, action })) });
  assert.match(undoText(plan(['revert', 'delete']), true), /\nDone: 2 files changed\.$/);
  assert.match(undoText(plan(['revert', 'conflict']), true), /\nDone: 1 file changed\. Left 1 file with conflicts untouched\.$/);
});
