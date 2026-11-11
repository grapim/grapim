// The Claude Code hook, run as Claude Code runs it: a process with JSON on stdin,
// in a real git repo with a second worktree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHooks } from '../src/cli.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'grapim.js');

function repoWithWorktree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-hook-'));
  const main = path.join(base, 'main');
  const wt = path.join(base, 'feature');
  fs.mkdirSync(main);
  const git = (args, cwd = main) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git(['init', '-q']);
  fs.mkdirSync(path.join(main, 'src'));
  fs.writeFileSync(path.join(main, 'src', 'routes.ts'), 'export {}\n');
  git(['add', '.']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  git(['worktree', 'add', '-q', wt]);
  return { main, wt };
}

function hook(input) {
  const r = spawnSync(process.execPath, [BIN, 'hook'], { input: JSON.stringify(input), encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const edit = (session, cwd, file, event = 'PreToolUse') => ({
  hook_event_name: event,
  session_id: session,
  cwd,
  tool_name: 'Edit',
  tool_input: { file_path: path.join(cwd, file) },
});

test('an edit to a file another session holds is blocked, even from another worktree', () => {
  const { main, wt } = repoWithWorktree();
  hook({ hook_event_name: 'UserPromptSubmit', session_id: 'aaaa1111', cwd: main, prompt: 'Add a /billing route\nand tests' });
  assert.equal(hook(edit('aaaa1111', main, 'src/routes.ts')).code, 0);

  const r = hook(edit('bbbb2222', wt, 'src/routes.ts'));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /src\/routes\.ts is claimed by another agent, claude aaaa1111 in worktree main, /);
  assert.match(r.stderr, /Add a \/billing route/);
  // From the holder's own worktree, naming the worktree would only repeat it.
  const same = hook(edit('cccc3333', main, 'src/routes.ts'));
  assert.equal(same.code, 2);
  assert.match(same.stderr, /claimed by another agent, claude aaaa1111, \d+s ago/);
  assert.doesNotMatch(r.stderr, /ExperimentalWarning/);

  // A different file is fine.
  assert.equal(hook(edit('bbbb2222', wt, 'src/other.ts')).code, 0);
  // The holder keeps editing.
  assert.equal(hook(edit('aaaa1111', main, 'src/routes.ts')).code, 0);
});

test('the second session is told what others hold when it gets a prompt', () => {
  const { main, wt } = repoWithWorktree();
  hook(edit('aaaa1111', main, 'src/routes.ts'));
  const r = hook({ hook_event_name: 'UserPromptSubmit', session_id: 'bbbb2222', cwd: wt, prompt: 'fix the header' });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /src\/routes\.ts: claude aaaa1111 \(worktree main\)/);
});

test('ending a session frees its files', () => {
  const { main, wt } = repoWithWorktree();
  hook(edit('aaaa1111', main, 'src/routes.ts'));
  assert.equal(hook(edit('bbbb2222', wt, 'src/routes.ts')).code, 2);
  hook({ hook_event_name: 'SessionEnd', session_id: 'aaaa1111', cwd: main });
  assert.equal(hook(edit('bbbb2222', wt, 'src/routes.ts')).code, 0);
});

test('warn mode lets the edit through and warns afterwards', () => {
  const { main, wt } = repoWithWorktree();
  hook(edit('aaaa1111', main, 'src/routes.ts'));
  const env = { ...process.env, GRAPIM_MODE: 'warn' };
  const run = (input) => spawnSync(process.execPath, [BIN, 'hook'], { input: JSON.stringify(input), encoding: 'utf8', env });
  assert.equal(run(edit('bbbb2222', wt, 'src/routes.ts')).status, 0);
  const post = run(edit('bbbb2222', wt, 'src/routes.ts', 'PostToolUse'));
  assert.equal(post.status, 2);
  assert.match(post.stderr, /Grapim warning/);
});

test('non-edit tools, files outside the repo and broken input never block', () => {
  const { main } = repoWithWorktree();
  assert.equal(hook({ hook_event_name: 'PreToolUse', session_id: 'x', cwd: main, tool_name: 'Bash', tool_input: { command: 'ls' } }).code, 0);
  assert.equal(hook({ ...edit('x', main, 'a'), tool_input: { file_path: path.join(os.tmpdir(), 'elsewhere.txt') } }).code, 0);
  const r = spawnSync(process.execPath, [BIN, 'hook'], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
});

test('init merges into existing settings and is idempotent', () => {
  const { main } = repoWithWorktree();
  fs.mkdirSync(path.join(main, '.claude'));
  const file = path.join(main, '.claude', 'settings.local.json');
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  installHooks(main);
  installHooks(main);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] });
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
  assert.equal(s.hooks.SessionEnd.length, 1);
});

test('hooks installed twice (plugin and init) count one prompt as one turn', async () => {
  const { main } = repoWithWorktree();
  const p = { hook_event_name: 'UserPromptSubmit', session_id: 'dddd4444', cwd: main, prompt: 'Add a /health route' };
  hook(p);
  hook(p);
  hook({ ...p, prompt: 'Now add tests' });
  const { Store } = await import('../src/store.js');
  const { resolveWorkspace } = await import('../src/workspace.js');
  const s = new Store(resolveWorkspace(main).stateDir);
  assert.equal(s.turn('claude-code:dddd4444'), 2);
  s.close();
});
