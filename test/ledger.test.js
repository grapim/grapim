// The attribution ledger and per-run undo, driven the way agents drive it:
// the Claude Code hook as a process with JSON on stdin, the MCP server over
// stdio, and the CLI, all in real temp git repos.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'grapim.js');
const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);

function repo(files, gitArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-ledger-'));
  const git = (args) => execFileSync('git', [...gitArgs, ...args], { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  git(['add', '.']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return dir;
}

const text = (lines, eol = '\n') => lines.map((l) => l + eol).join('');

function hook(input) {
  const r = spawnSync(process.execPath, [BIN, 'hook'], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /grapim ledger/);
  return r;
}

function cli(cwd, ...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const json = (cwd, ...args) => JSON.parse(cli(cwd, ...args, '--json'));
const prompt = (session, cwd, p = 'do the thing') => hook({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd, prompt: p });
const endSession = (session, cwd) => hook({ hook_event_name: 'SessionEnd', session_id: session, cwd });

let nextToolUse = 1;
// One Claude Code edit as Claude Code runs it: PreToolUse, the write, PostToolUse.
function agentEdit(session, cwd, file, change, tool = 'Edit') {
  const abs = path.join(cwd, file);
  const input = { session_id: session, cwd, tool_name: tool, tool_use_id: `toolu_${nextToolUse++}`, tool_input: { file_path: abs } };
  hook({ ...input, hook_event_name: 'PreToolUse' });
  change(abs);
  hook({ ...input, hook_event_name: 'PostToolUse' });
}

// Replaces lines (1-based) and keeps the file's line endings.
const setLines = (edits) => (abs) => {
  const raw = fs.readFileSync(abs, 'latin1');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(eol).slice(0, -1);
  for (const [n, t] of Object.entries(edits)) lines[n - 1] = t;
  fs.writeFileSync(abs, Buffer.from(text(lines, eol), 'latin1'));
};

const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');
const owners = (b) => b.lines.map((l) => [l.line, l.label, l.turn]);

// A edits the top (in its second turn) and B the bottom, each ending its session in between.
function twoRuns(dir, bottom = { 9: 'B nine', 10: 'B ten' }) {
  prompt('aaaa1111', dir, 'first task');
  prompt('aaaa1111', dir, 'rename the top');
  agentEdit('aaaa1111', dir, 'app.js', setLines({ 1: 'A one', 2: 'A two' }));
  endSession('aaaa1111', dir);
  prompt('bbbb2222', dir, 'fix the bottom');
  agentEdit('bbbb2222', dir, 'app.js', setLines(bottom));
  endSession('bbbb2222', dir);
}

test('blame attributes lines to the two runs that wrote them', () => {
  const dir = repo({ 'app.js': text(TEN) });
  twoRuns(dir);
  const b = json(dir, 'blame', 'app.js');
  assert.deepEqual(owners(b), [
    [1, 'claude aaaa1111', 2],
    [2, 'claude aaaa1111', 2],
    [9, 'claude bbbb2222', 1],
    [10, 'claude bbbb2222', 1],
  ]);
  assert.match(cli(dir, 'blame', 'app.js'), /1 {2}claude aaaa1111 {2}turn 2 {2}\| A one/);
  assert.match(cli(dir, 'log'), /claude aaaa1111 edited app\.js \+2 -2/);
});

test('undo of run A keeps run B\'s later edits in the same file', () => {
  const dir = repo({ 'app.js': text(TEN) });
  twoRuns(dir);
  const r = json(dir, 'undo', 'aaaa1111', '--yes');
  assert.deepEqual(r.files.map((f) => [f.path, f.action]), [['app.js', 'revert']]);
  assert.equal(read(dir, 'app.js'), text([...TEN.slice(0, 8), 'B nine', 'B ten']));
  const runs = Object.fromEntries(json(dir, 'runs').map((x) => [x.label, x.in_tree]));
  assert.equal(runs['claude aaaa1111'], 'no');
  assert.equal(runs['claude bbbb2222'], 'yes');
  assert.match(cli(dir, 'log'), /undid app\.js \(revert: claude aaaa1111\)/);
});

test('undo reports a conflict and changes nothing when B rewrote A\'s lines', () => {
  const dir = repo({ 'app.js': text(TEN) });
  twoRuns(dir, { 2: 'B two' });
  const before = fs.readFileSync(path.join(dir, 'app.js'));
  const r = json(dir, 'undo', 'claude aaaa', '--yes');
  assert.equal(r.files[0].action, 'conflict');
  assert.match(r.files[0].reason, /overlap/);
  assert.ok(fs.readFileSync(path.join(dir, 'app.js')).equals(before));
});

test('undo deletes a file the run created and restores one it deleted', async () => {
  const dir = repo({ 'app.js': text(TEN), 'old.js': 'keep me\r\nplease\n' });
  agentEdit('cccc3333', dir, 'new.js', (abs) => fs.writeFileSync(abs, 'brand new\n'), 'Write');
  endSession('cccc3333', dir);

  const c = mcp(dir, { GRAPIM_AGENT: 'codex-del' });
  await c.call('claim_files', { paths: ['old.js'], intent: 'remove old.js' });
  fs.rmSync(path.join(dir, 'old.js'));
  await c.call('release_files', {});
  await c.close();

  assert.deepEqual(json(dir, 'undo', 'cccc3333', '--yes').files.map((f) => f.action), ['delete']);
  assert.equal(fs.existsSync(path.join(dir, 'new.js')), false);
  assert.deepEqual(json(dir, 'undo', 'codex-del', '--yes').files.map((f) => f.action), ['restore']);
  assert.equal(fs.readFileSync(path.join(dir, 'old.js'), 'latin1'), 'keep me\r\nplease\n');
});

test('undo without --yes only prints the plan', () => {
  const dir = repo({ 'app.js': text(TEN) });
  twoRuns(dir);
  const before = read(dir, 'app.js');
  const out = cli(dir, 'undo', 'aaaa1111');
  assert.match(out, /revert\s+app\.js/);
  assert.match(out, /Nothing was changed\. Run again with --yes/);
  assert.equal(read(dir, 'app.js'), before);
});

test('a CRLF file round-trips byte for byte, with core.autocrlf on', () => {
  const dir = repo({ 'app.js': text(TEN, '\r\n') }, ['-c', 'core.autocrlf=true']);
  twoRuns(dir, { 8: 'B eight' });
  // HEAD holds LF (autocrlf), the working file CRLF: only the 3 edited lines differ.
  assert.deepEqual(owners(json(dir, 'blame', 'app.js')).map(([n]) => n), [1, 2, 8]);
  // Undo in a process with its own temp folder, so other tests running in
  // parallel cannot put their merge files there: it must be empty afterwards.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-own-tmp-'));
  const r = spawnSync(process.execPath, [BIN, 'undo', 'aaaa1111', '--yes', '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, TMP: tmp, TEMP: tmp, TMPDIR: tmp } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).files[0].action, 'revert');
  const want = Buffer.from(text([...TEN.slice(0, 7), 'B eight', ...TEN.slice(8)], '\r\n'));
  assert.ok(fs.readFileSync(path.join(dir, 'app.js')).equals(want));
  assert.deepEqual(fs.readdirSync(tmp), [], 'merge temp files were left behind');
});

test('an MCP agent: claim, edit on disk, release, and runs shows the change', async () => {
  const dir = repo({ 'app.js': text(TEN) });
  const c = mcp(dir, { GRAPIM_AGENT: 'codex-a' });
  await c.call('claim_files', { paths: ['app.js'], intent: 'rename the logger' });
  setLines({ 3: 'codex three', 4: 'codex four', 5: 'codex five' })(path.join(dir, 'app.js'));
  const rel = await c.call('release_files', {});
  assert.match(rel, /Recorded your changes: app\.js \+3 -3/);
  assert.match(await c.call('list_runs', {}), /codex-a .*rename the logger/);
  assert.match(await c.call('who_wrote', { path: 'app.js' }), /3 {2}codex-a {2}turn 1 {2}\| codex three/);
  await c.close();
  const [run] = json(dir, 'runs');
  assert.equal(run.run, 'codex-a');
  assert.deepEqual([run.files, run.added, run.removed, run.turns, run.in_tree], [1, 3, 3, 1, 'yes']);
});

test('a Bash-style write with no hook shows as outside agents', () => {
  const dir = repo({ 'app.js': text(TEN) });
  prompt('aaaa1111', dir);
  agentEdit('aaaa1111', dir, 'app.js', setLines({ 1: 'A one' }));
  setLines({ 5: 'sed five' })(path.join(dir, 'app.js'));
  assert.deepEqual(owners(json(dir, 'blame', 'app.js')), [
    [1, 'claude aaaa1111', 1],
    [5, 'outside agents', null],
  ]);
});

test('undo keeps edits another agent made between two edits of the run', () => {
  const dir = repo({ 'app.js': text(TEN) });
  prompt('aaaa1111', dir);
  agentEdit('aaaa1111', dir, 'app.js', setLines({ 1: 'A one' }));
  cli(dir, 'release', '--agent', 'claude-code:aaaa1111');
  agentEdit('bbbb2222', dir, 'app.js', setLines({ 5: 'B five' }));
  endSession('bbbb2222', dir);
  agentEdit('aaaa1111', dir, 'app.js', setLines({ 9: 'A nine' }));
  json(dir, 'undo', 'aaaa1111', '--yes');
  assert.equal(read(dir, 'app.js'), text(TEN.map((l, i) => (i === 4 ? 'B five' : l))));
});

test('undo --turn reverts only that turn', () => {
  const dir = repo({ 'app.js': text(TEN) });
  prompt('aaaa1111', dir, 'one');
  agentEdit('aaaa1111', dir, 'app.js', setLines({ 1: 'A one' }));
  prompt('aaaa1111', dir, 'two');
  agentEdit('aaaa1111', dir, 'app.js', setLines({ 9: 'A nine' }));
  json(dir, 'undo', 'aaaa1111', '--turn', '2', '--yes');
  assert.equal(read(dir, 'app.js'), text(TEN.map((l, i) => (i === 0 ? 'A one' : l))));
});

// A minimal MCP client over stdio.
function mcp(cwd, env) {
  const p = spawn(process.execPath, [BIN, 'mcp'], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  readline.createInterface({ input: p.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
  });
  let next = 1;
  const call = (name, args) =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, (msg) => resolve(msg.result.content[0].text));
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    });
  const close = () => new Promise((resolve) => (p.on('close', resolve), p.stdin.end()));
  return { call, close };
}

test('undo skips a file an agent is in the middle of editing, the undone run included', () => {
  const dir = repo({ 'app.js': text(TEN) });
  prompt('aaaa1111', dir, 'rename the top');
  agentEdit('aaaa1111', dir, 'app.js', setLines({ 1: 'A one' }));
  // A starts another edit: PreToolUse has run, PostToolUse has not.
  hook({ hook_event_name: 'PreToolUse', session_id: 'aaaa1111', cwd: dir, tool_name: 'Edit', tool_use_id: 'toolu_midway', tool_input: { file_path: path.join(dir, 'app.js') } });
  const before = read(dir, 'app.js');
  const r = json(dir, 'undo', 'aaaa1111', '--yes');
  assert.equal(r.files[0].action, 'skipped');
  assert.match(r.files[0].reason, /in the middle of editing/);
  assert.equal(read(dir, 'app.js'), before);
});

test('undo replaces files whole and leaves no temp files behind', () => {
  const dir = repo({ 'app.js': text(TEN) });
  twoRuns(dir);
  json(dir, 'undo', 'aaaa1111', '--yes');
  assert.equal(read(dir, 'app.js'), text(['line 1', 'line 2', ...TEN.slice(2, 8), 'B nine', 'B ten']));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
});
