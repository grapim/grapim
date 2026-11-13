// Files changed by an agent's shell commands: the hook around the shell tool
// (Claude Code Bash, Codex Bash, Gemini run_shell_command) compares the
// worktree before and after, records each changed file for the run, and
// `grapim undo` reverses them. Run as the agents run it: a process with JSON
// on stdin, in a real git repo. The "command" itself is done here in between.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupAgent } from '../src/agents.js';
import { commandText, headContents } from '../src/shell.js';
import { Store } from '../src/store.js';
import { buildBatch } from '../src/sync.js';
import { parseBatch } from '../src/hub/ingest.js';
import { resolveWorkspace } from '../src/workspace.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'grapim.js');
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete ENV.GRAPIM_STATE_DIR;
delete ENV.GRAPIM_MODE;

function repo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-shell-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: ENV });
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  for (const [name, content] of Object.entries({ 'README.md': 'hi\n', ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  return dir;
}

function hook(input, { from = null, env = {} } = {}) {
  const args = [BIN, 'hook', ...(from ? ['--from', from] : [])];
  const r = spawnSync(process.execPath, args, { input: JSON.stringify(input), encoding: 'utf8', env: { ...ENV, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const cli = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...ENV, GRAPIM_AGENT: 'human:tester' } });

let n = 0;
// Runs fn between the Bash Pre and Post hooks of `session`, as Claude Code would.
function bash(dir, session, command, fn, { env, event = 'PostToolUse' } = {}) {
  const id = `toolu_${++n}`;
  const base = { session_id: session, cwd: dir, tool_name: 'Bash', tool_input: { command }, tool_use_id: id };
  const pre = hook({ ...base, hook_event_name: 'PreToolUse' }, { env });
  assert.equal(pre.code, 0);
  fn?.();
  const post = hook({ ...base, hook_event_name: event }, { env });
  assert.equal(post.code, 0);
  return { pre, post };
}

function withStore(dir, fn) {
  const s = new Store(resolveWorkspace(dir).stateDir);
  try {
    return fn(s);
  } finally {
    s.close();
  }
}

const changes = (dir) => withStore(dir, (s) => s.allChanges());
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const write = (dir, f, c) => {
  fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
  fs.writeFileSync(path.join(dir, f), c);
};
const exists = (dir, f) => fs.existsSync(path.join(dir, f));

const prompt = (dir, session, text = 'tidy up') => hook({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd: dir, prompt: text });

test('sed -i style rewrite, rm, a new file and mv are each recorded with the command, and undo reverses them all', () => {
  const dir = repo({ 'src/a.js': 'one\ntwo\nthree\n', 'src/gone.js': 'bye\n', 'src/old.js': 'moved\n' });
  prompt(dir, 'aaaa1111');
  bash(dir, 'aaaa1111', "sed -i 's/two/TWO/' src/a.js", () => write(dir, 'src/a.js', 'one\nTWO\nthree\n'));
  bash(dir, 'aaaa1111', 'rm src/gone.js', () => fs.rmSync(path.join(dir, 'src/gone.js')));
  bash(dir, 'aaaa1111', 'node gen.js > src/new.js', () => write(dir, 'src/new.js', 'generated\n'));
  bash(dir, 'aaaa1111', 'mv src/old.js src/renamed.js', () => fs.renameSync(path.join(dir, 'src/old.js'), path.join(dir, 'src/renamed.js')));

  const c = changes(dir);
  const by = Object.fromEntries(c.map((x) => [x.path, x]));
  assert.deepEqual(c.map((x) => x.path).sort(), ['src/a.js', 'src/gone.js', 'src/new.js', 'src/old.js', 'src/renamed.js']);
  assert.equal(by['src/a.js'].via, "sed -i 's/two/TWO/' src/a.js");
  assert.equal(by['src/a.js'].added, 1);
  assert.equal(by['src/a.js'].removed, 1);
  assert.equal(by['src/gone.js'].after_sha, null, 'a deletion: after is absent');
  assert.ok(by['src/gone.js'].before_sha);
  assert.equal(by['src/new.js'].before_sha, null, 'a creation: before is absent');
  assert.equal(by['src/old.js'].after_sha, null, 'mv is a delete and a create');
  assert.equal(by['src/renamed.js'].before_sha, null);
  assert.ok(c.every((x) => x.run === 'claude-code:aaaa1111' && x.turn === 1));

  const plan = cli(dir, 'undo', 'aaaa1111');
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /restore\s+src\/gone\.js\s+deleted by this run \(via shell: rm src\/gone\.js\)/);
  assert.match(plan.stdout, /delete\s+src\/new\.js/);
  assert.equal(read(dir, 'src/a.js'), 'one\nTWO\nthree\n', 'the plan changes nothing');

  const done = cli(dir, 'undo', 'aaaa1111', '--yes');
  assert.equal(done.status, 0, done.stderr);
  assert.equal(read(dir, 'src/a.js'), 'one\ntwo\nthree\n');
  assert.equal(read(dir, 'src/gone.js'), 'bye\n');
  assert.equal(read(dir, 'src/old.js'), 'moved\n');
  assert.ok(!exists(dir, 'src/new.js'));
  assert.ok(!exists(dir, 'src/renamed.js'));
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '', 'back to HEAD exactly');
});

test('git mv (a staged rename) of a path with spaces is recorded and undone', () => {
  const dir = repo({ 'docs/old name.md': 'text\n' });
  bash(dir, 'aaaa1111', 'git mv', () => execFileSync('git', ['mv', 'docs/old name.md', 'docs/new name.md'], { cwd: dir }));
  assert.deepEqual(changes(dir).map((x) => [x.path, x.before_sha === null, x.after_sha === null]).sort(), [['docs/new name.md', true, false], ['docs/old name.md', false, true]]);
  assert.equal(cli(dir, 'undo', 'aaaa1111', '--yes').status, 0);
  assert.equal(read(dir, 'docs/old name.md'), 'text\n');
  assert.ok(!exists(dir, 'docs/new name.md'));
});

test('a file already dirty before the command keeps its earlier content; an unchanged dirty file is not recorded', () => {
  const dir = repo({ 'a.txt': '1\n2\n3\n' });
  write(dir, 'a.txt', '1\n2 (mine)\n3\n'); // the human's uncommitted work
  write(dir, 'notes.txt', 'scratch\n'); // untracked, untouched by the command
  bash(dir, 'aaaa1111', "sed -i 's/3/three/' a.txt", () => write(dir, 'a.txt', '1\n2 (mine)\nthree\n'));
  const c = changes(dir);
  assert.deepEqual(c.map((x) => x.path), ['a.txt']);
  assert.equal(cli(dir, 'undo', 'aaaa1111', '--yes').status, 0);
  assert.equal(read(dir, 'a.txt'), '1\n2 (mine)\n3\n', 'the human edit made before the command stays');
});

test('a later human edit to the same file is kept by undo, or the file is left alone when it overlaps', () => {
  const lines = (k) => Array.from({ length: 12 }, (_, i) => (i === k ? `changed ${i}` : `line ${i}`)).join('\n') + '\n';
  const dir = repo({ 'a.txt': lines(-1), 'b.txt': 'x\ny\n' });
  bash(dir, 'aaaa1111', 'sed -i a.txt b.txt', () => {
    write(dir, 'a.txt', lines(1));
    write(dir, 'b.txt', 'x\nY\n');
  });
  // Later, a human edits far away in a.txt and on the same line in b.txt.
  write(dir, 'a.txt', lines(1).replace('line 10', 'human 10'));
  write(dir, 'b.txt', 'x\nY by human\n');
  const r = cli(dir, 'undo', 'aaaa1111', '--yes');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /conflict\s+b\.txt/);
  assert.equal(read(dir, 'a.txt'), lines(-1).replace('line 10', 'human 10'), 'the run is removed, the human line kept');
  assert.equal(read(dir, 'b.txt'), 'x\nY by human\n', 'conflicting file left for the user');
});

test('an edit-tool change inside the same command window is not counted twice', () => {
  const dir = repo({ 'a.txt': 'a\n' });
  const id = 'toolu_overlap';
  const base = { session_id: 'aaaa1111', cwd: dir, tool_name: 'Bash', tool_input: { command: 'npm run fmt' }, tool_use_id: id };
  hook({ ...base, hook_event_name: 'PreToolUse' });
  const edit = { session_id: 'aaaa1111', cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'a.txt') }, tool_use_id: 'toolu_edit' };
  hook({ ...edit, hook_event_name: 'PreToolUse' });
  write(dir, 'a.txt', 'a edited\n');
  hook({ ...edit, hook_event_name: 'PostToolUse' });
  hook({ ...base, hook_event_name: 'PostToolUse' });
  const c = changes(dir);
  assert.equal(c.length, 1);
  assert.equal(c[0].via, null, 'recorded once, by the edit tool');
});

test('a command that fails (PostToolUseFailure) still has its changes recorded', () => {
  const dir = repo({ 'a.txt': 'a\n' });
  bash(dir, 'aaaa1111', 'rm a.txt && false', () => fs.rmSync(path.join(dir, 'a.txt')), { event: 'PostToolUseFailure' });
  assert.deepEqual(changes(dir).map((x) => [x.path, x.after_sha]), [['a.txt', null]]);
});

test('over the file-count or byte cap: the command runs, nothing is recorded, stderr says so', () => {
  const dir = repo({ 'a.txt': 'a\n' });
  for (let i = 0; i < 3; i++) write(dir, `scratch${i}.txt`, `${i}\n`);
  const { pre } = bash(dir, 'aaaa1111', 'rm a.txt', () => fs.rmSync(path.join(dir, 'a.txt')), { env: { GRAPIM_SHELL_MAX_FILES: '2' } });
  assert.match(pre.stderr, /3 files are uncommitted \(more than 2\).*not recorded \(it runs as usual\)/);
  assert.equal(changes(dir).length, 0);

  const big = repo({ 'a.txt': 'a\n' });
  write(big, 'blob.txt', 'x'.repeat(4000));
  const r = bash(big, 'aaaa1111', 'rm a.txt', () => fs.rmSync(path.join(big, 'a.txt')), { env: { GRAPIM_SHELL_MAX_BYTES: '1000' } });
  assert.match(r.pre.stderr, /hold more than/);
  assert.equal(changes(big).length, 0);
});

test('a file over 2 MB is recorded as changed without content, and undo leaves it alone', () => {
  const dir = repo({ 'a.txt': 'a\n' });
  bash(dir, 'aaaa1111', 'make big', () => write(dir, 'big.bin', 'x'.repeat(2 * 1024 * 1024 + 10)));
  const c = changes(dir);
  assert.equal(c.length, 1);
  assert.equal(c[0].untracked, 1);
  assert.equal(c[0].after_sha, 'untracked');
  const r = cli(dir, 'undo', 'aaaa1111', '--yes');
  assert.match(r.stdout, /conflict\s+big\.bin\s+binary or over 2 MB/);
  assert.ok(exists(dir, 'big.bin'));
});

test('ignored files and files outside the repo are not recorded', () => {
  const dir = repo({ '.gitignore': 'dist/\n' });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-outside-'));
  bash(dir, 'aaaa1111', 'build', () => {
    write(dir, 'dist/app.js', 'built\n');
    write(outside, 'x.txt', 'x\n');
  });
  assert.equal(changes(dir).length, 0);
});

test('two runs whose commands overlap: a change either could have made is credited to neither, with a warning', () => {
  const dir = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const A = { session_id: 'aaaa1111', cwd: dir, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_A' };
  const B = { session_id: 'bbbb2222', cwd: dir, tool_name: 'Bash', tool_input: { command: "sed -i 's/a/A/' a.txt" }, tool_use_id: 'toolu_B' };
  hook({ ...A, hook_event_name: 'PreToolUse' });
  hook({ ...B, hook_event_name: 'PreToolUse' });
  write(dir, 'a.txt', 'A\n');
  const b = hook({ ...B, hook_event_name: 'PostToolUse' });
  assert.match(b.stderr, /another agent ran a shell command in this worktree at the same time, so 1 changed file \(a\.txt\) is not credited to either run/);
  const a = hook({ ...A, hook_event_name: 'PostToolUse' });
  assert.match(a.stderr, /not credited to either run/);
  assert.equal(changes(dir).length, 0);

  // A change made before the other run's command started is not ambiguous.
  const C = { ...A, tool_use_id: 'toolu_C' };
  const D = { ...B, tool_use_id: 'toolu_D', tool_input: { command: 'touch c' } };
  hook({ ...C, hook_event_name: 'PreToolUse' });
  write(dir, 'b.txt', 'B\n'); // run A's command changes b.txt
  hook({ ...D, hook_event_name: 'PreToolUse' }); // B starts after that
  hook({ ...D, hook_event_name: 'PostToolUse' });
  const c = hook({ ...C, hook_event_name: 'PostToolUse' });
  assert.equal(c.stderr, '');
  assert.deepEqual(changes(dir).map((x) => [x.path, x.run]), [['b.txt', 'claude-code:aaaa1111']]);
});

test('two parallel commands of the same run record a change once', () => {
  const dir = repo({ 'a.txt': 'a\n' });
  const one = { session_id: 'aaaa1111', cwd: dir, tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 'toolu_1' };
  const two = { ...one, tool_use_id: 'toolu_2' };
  hook({ ...one, hook_event_name: 'PreToolUse' });
  hook({ ...two, hook_event_name: 'PreToolUse' });
  write(dir, 'a.txt', 'A\n');
  hook({ ...one, hook_event_name: 'PostToolUse' });
  hook({ ...two, hook_event_name: 'PostToolUse' });
  assert.equal(changes(dir).length, 1);
});

test('Codex Bash and Gemini run_shell_command (with dir_path) are recorded too', () => {
  const dir = repo({ 'a.txt': 'a\n', 'sub/b.txt': 'b\n' });
  const cx = { session_id: 'cccc3333', cwd: dir, tool_name: 'Bash', tool_input: { command: 'rm a.txt' }, tool_use_id: 'call_1' };
  hook({ ...cx, hook_event_name: 'PreToolUse' }, { from: 'codex' });
  fs.rmSync(path.join(dir, 'a.txt'));
  hook({ ...cx, hook_event_name: 'PostToolUse' }, { from: 'codex' });

  const gm = { session_id: 'dddd4444', cwd: os.tmpdir(), tool_name: 'run_shell_command', tool_input: { command: 'rm b.txt', dir_path: path.join(dir, 'sub') } };
  const pre = hook({ ...gm, hook_event_name: 'BeforeTool' }, { from: 'gemini' });
  assert.equal(pre.stdout, '{}\n', 'Gemini reads stdout as JSON only');
  fs.rmSync(path.join(dir, 'sub/b.txt'));
  hook({ ...gm, hook_event_name: 'AfterTool' }, { from: 'gemini' });
  assert.deepEqual(changes(dir).map((x) => [x.path, x.run.split(':')[0]]), [['a.txt', 'codex'], ['sub/b.txt', 'gemini']]);
});

test('a command that does not change anything records nothing, and a git commit is not a change', () => {
  const dir = repo({ 'a.txt': 'a\n' });
  write(dir, 'a.txt', 'a2\n');
  bash(dir, 'aaaa1111', 'ls', () => {});
  bash(dir, 'aaaa1111', 'git commit -am x', () => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qam', 'x'], { cwd: dir }));
  assert.equal(changes(dir).length, 0);
});

test('init hooks the shell tool for Claude Code, Codex and Gemini CLI, and running it again changes nothing', () => {
  const dir = repo();
  const bin = '/opt/grapim/bin/grapim.js';
  for (const id of ['claude', 'codex', 'gemini']) setupAgent(id, dir, { bin });
  const json = (rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
  const claude = json('.claude/settings.local.json');
  assert.equal(claude.hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit|Bash');
  assert.equal(claude.hooks.PostToolUseFailure[0].matcher, 'Bash');
  assert.equal(json('.codex/hooks.json').hooks.PreToolUse[0].matcher, 'apply_patch|Edit|Write|Bash');
  assert.equal(json('.gemini/settings.json').hooks.AfterTool[0].matcher, 'write_file|replace|run_shell_command');
  for (const id of ['claude', 'codex', 'gemini']) assert.equal(setupAgent(id, dir, { bin }).changed, false);
  const plugin = JSON.parse(fs.readFileSync(path.join(path.dirname(BIN), '..', 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(plugin.hooks.PostToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit|Bash');
  assert.equal(plugin.hooks.PostToolUseFailure[0].matcher, 'Bash');
});

test('the command text keeps no secrets and at most 200 characters', () => {
  assert.equal(commandText('API_TOKEN=abc123 curl -H "Authorization: Bearer abcdefghijkl" https://u:pw@x.io --password hunter2'), 'API_TOKEN=*** curl -H "Authorization: Bearer ***" https://u:***@x.io --password ***');
  assert.equal(commandText('echo ghp_abcdefghijklmnop'), 'echo ***');
  assert.equal(commandText('a\n  b'), 'a b');
  assert.equal(commandText('x'.repeat(500)).length, 200);
});

test('content before the command for a clean file follows the checkout line endings', () => {
  const dir = repo({ 'a.txt': 'a\nb\n', 'bin.dat': 'a\0b\n', 'mixed.txt': 'a\r\nb\n' });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  execFileSync('git', ['config', 'core.autocrlf', 'true'], { cwd: dir });
  const got = headContents(dir, head, ['a.txt', 'bin.dat', 'mixed.txt', 'missing.txt']);
  assert.equal(got.get('a.txt').toString(), 'a\r\nb\r\n');
  assert.equal(got.get('bin.dat').toString(), 'a\0b\n');
  assert.equal(got.get('mixed.txt').toString(), 'a\r\nb\n', 'a blob with CR already is not converted');
  assert.equal(got.get('missing.txt'), null);
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
  assert.equal(headContents(dir, head, ['a.txt']).get('a.txt').toString(), 'a\nb\n');
});

test('sync sends the command as an optional via field, and the hub accepts batches with or without it', () => {
  const dir = repo({ 'a.txt': 'a\n' });
  bash(dir, 'aaaa1111', 'rm a.txt', () => fs.rmSync(path.join(dir, 'a.txt')));
  const b =withStore(dir, (s) => buildBatch(s, { changes: 0, events: 0, agents: 0 }));
  assert.equal(b.changes[0].via, 'rm a.txt');
  assert.ok(b.events.some((e) => e.kind === 'edit' && e.detail === '+0 -1 via shell: rm a.txt'));
  const body = { repo: { id: 'a'.repeat(40), name: 'r' }, machine: 'm', changes: b.changes, blobs: b.blobs };
  assert.equal(parseBatch(body).changes[0].via, 'rm a.txt');
  const { via, ...old } = b.changes[0];
  assert.equal(parseBatch({ ...body, changes: [old] }).changes[0].via, null, 'an older client without via');
  assert.throws(() => parseBatch({ ...body, changes: [{ ...old, via: 42 }] }), /via must be a string/);
});
