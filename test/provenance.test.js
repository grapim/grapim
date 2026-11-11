// AI code provenance that survives commit (docs/provenance.md sections 1-2):
// edits driven through the Claude Code hook as a process, committed with real
// git in temp repos, with the post-commit and pre-push hooks `grapim init`
// installs doing the recording.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_NOTE_BYTES, buildNote, kindOf, lookupLine, parseNote, serializeNote } from '../src/provenance/note.js';
import { MARKER, installGitHooks } from '../src/provenance/hooks.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'grapim.js');
const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete ENV.GRAPIM_STATE_DIR;
delete ENV.GIT_DIR;
delete ENV.GIT_WORK_TREE;
delete ENV.GIT_NOTES_REWRITE_REF;

const text = (lines, eol = '\n') => lines.map((l) => l + eol).join('');

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
}

// A repo with one commit, then `grapim init` (Claude Code hooks and git hooks).
function repo(files, { autocrlf = 'false', init = true, initArgs = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-prov-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', autocrlf);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  git(dir, 'add', ...Object.keys(files));
  git(dir, 'commit', '-qm', 'init');
  if (init) cli(dir, 'init', ...initArgs);
  return dir;
}

function cli(cwd, ...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const json = (cwd, ...args) => JSON.parse(cli(cwd, ...args, '--json'));

function hook(input) {
  const r = spawnSync(process.execPath, [BIN, 'hook'], { input: JSON.stringify(input), encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /grapim ledger/);
  return r;
}
const prompt = (session, cwd, p) => hook({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd, prompt: p });
const endSession = (session, cwd) => hook({ hook_event_name: 'SessionEnd', session_id: session, cwd });

let nextToolUse = 1;
function agentEdit(session, cwd, file, change, tool = 'Edit') {
  const abs = path.join(cwd, file);
  const input = { session_id: session, cwd, tool_name: tool, tool_use_id: `toolu_p${nextToolUse++}`, tool_input: { file_path: abs } };
  hook({ ...input, hook_event_name: 'PreToolUse' });
  change(abs);
  hook({ ...input, hook_event_name: 'PostToolUse' });
}

// Replaces lines (1-based, keeping the file's line endings); `insert` adds after a line.
const setLines = (edits, { append = [] } = {}) => (abs) => {
  const raw = fs.readFileSync(abs, 'latin1');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(eol).slice(0, -1);
  for (const [n, t] of Object.entries(edits)) lines[n - 1] = t;
  fs.writeFileSync(abs, Buffer.from(text([...lines, ...append], eol), 'latin1'));
};
const human = (dir, file, edits, opts) => setLines(edits, opts)(path.join(dir, file));

function commit(dir, msg, ...add) {
  if (add.length) git(dir, 'add', ...add);
  git(dir, 'commit', '-qam', msg);
  return git(dir, 'rev-parse', 'HEAD').trim();
}
const rawNote = (dir, rev = 'HEAD') => {
  try {
    return git(dir, 'notes', '--ref=grapim', 'show', rev);
  } catch {
    return null;
  }
};
const note = (dir, rev = 'HEAD') => json(dir, 'provenance', 'show', rev).note;

// ---------------------------------------------------------------- note format

test('note format: kinds, ranges, the 256 KB cap drops intents first, concatenated notes merge', () => {
  assert.equal(kindOf('claude-code:1a2b'), 'claude-code');
  assert.equal(kindOf('codex-mcp-client:4121'), 'codex');
  assert.equal(kindOf('cursor-vscode:77'), 'cursor');
  assert.equal(kindOf('mcp:123'), 'mcp');
  assert.equal(kindOf('http:sandbox/agent'), 'http');
  assert.equal(kindOf('sync-laptop'), 'sync');
  assert.equal(kindOf('http:sync-laptop'), 'sync');
  assert.equal(kindOf('undo:1700000000000'), 'undo');
  assert.equal(kindOf('restore:1700000000000'), 'restore');

  const lines = [1, 2, 3, 7].map((line) => ({ path: 'a.js', line, run: 'claude-code:x', turn: 1 }));
  lines.push({ path: 'a.js', line: 4, run: 'codex-mcp-client:9', turn: 2 });
  const n = buildNote(lines, (run) => ({ label: run, review: 'approved', intent: (t) => `prompt ${t}\nsecond line` }));
  assert.deepEqual(n.files['a.js'], [[1, 3, 0, 1], [4, 4, 1, 2], [7, 7, 0, 1]]);
  assert.deepEqual(n.runs[0].turns, [{ turn: 1, intent: 'prompt 1' }]);
  assert.equal(n.runs[1].kind, 'codex');
  assert.deepEqual(lookupLine(n, 'a.js', 4), { run: 'codex-mcp-client:9', label: 'codex-mcp-client:9', kind: 'codex', turn: 2, intent: 'prompt 2', review: 'approved' });
  assert.deepEqual(buildNote([], () => ({}), { commit: { ts: 1000, added: 3 } }), { v: 1, tool: 'grapim/0.1.0', runs: [], files: {}, commit: { ts: 1000, added: 3 } });
  assert.deepEqual(parseNote('{"v":1,"tool":"t","runs":[],"files":{},"commit":{"ts":5,"added":0}}').commit, { ts: 5, added: 0 });

  // Too big with intents: they are dropped and the ranges kept.
  const many = Array.from({ length: 2000 }, (_, i) => ({ path: 'big.js', line: i * 2 + 1, run: `claude-code:${i % 1000}`, turn: 1 }));
  const big = buildNote(many, () => ({ label: 'x', intent: () => 'y'.repeat(140) }));
  assert.ok(JSON.stringify(big).length > MAX_NOTE_BYTES);
  const slim = parseNote(serializeNote(big));
  assert.ok(Buffer.byteLength(serializeNote(big)) <= MAX_NOTE_BYTES);
  assert.equal(slim.files['big.js'].length, 2000);
  assert.ok(slim.runs.every((r) => r.turns.every((t) => t.intent === undefined)));
  assert.equal(slim.truncated, undefined);

  // Two notes concatenated by git (squash, notes merge): one note back.
  const a = JSON.stringify(buildNote([{ path: 'a.js', line: 1, run: 'claude-code:a', turn: 1 }], () => ({})));
  const b = JSON.stringify(buildNote([{ path: 'a.js', line: 5, run: 'claude-code:b', turn: 3 }, { path: 'b.js', line: 2, run: 'claude-code:a', turn: 2 }], () => ({})));
  const m = parseNote(`${a}\n\n${b}\n`);
  assert.deepEqual(m.runs.map((r) => [r.id, r.turns.map((t) => t.turn)]), [['claude-code:a', [1, 2]], ['claude-code:b', [3]]]);
  assert.deepEqual(m.files, { 'a.js': [[1, 1, 0, 1], [5, 5, 1, 3]], 'b.js': [[2, 2, 0, 2]] });

  for (const badNote of ['', '{', '{"v":2,"runs":[],"files":{}}', '{"v":1,"runs":[],"files":{"a":[[1,1,0,1]]}}', '{"v":1,"runs":[{"id":"x","kind":"robot","turns":[]}],"files":{}}', '{"v":1,"runs":[],"files":{"a":[[3,2,0,1]]}}']) {
    assert.throws(() => parseNote(badNote), /./, badNote);
  }
  assert.throws(() => parseNote('x'.repeat(MAX_NOTE_BYTES + 1)), /over/);
});

// ---------------------------------------------------------------- recording

test('the note lists exactly the agent lines; lines a human typed are not listed', () => {
  const dir = repo({ 'app.js': text(TEN) });
  prompt('aaaa1111', dir, 'rename the top\nand more detail');
  agentEdit('aaaa1111', dir, 'app.js', setLines({ 1: 'A one', 2: 'A two' }));
  human(dir, 'app.js', { 5: 'typed by a human' }, { append: ['also human'] });
  const sha = commit(dir, 'top');

  const raw = rawNote(dir);
  assert.equal(raw.trim().split('\n').length, 1, 'compact JSON, one line');
  const n = note(dir);
  assert.deepEqual(n.files, { 'app.js': [[1, 2, 0, 1]] });
  assert.deepEqual(n.runs, [{ id: 'claude-code:aaaa1111', label: 'claude aaaa1111', kind: 'claude-code', turns: [{ turn: 1, intent: 'rename the top' }], review: 'pending' }]);
  assert.equal(n.v, 1);
  assert.match(n.tool, /^grapim\//);
  // The optional commit block: committer time and every added line (agent or not).
  assert.equal(n.commit.added, 4);
  assert.equal(n.commit.ts, Number(git(dir, 'show', '-s', '--format=%ct', sha).trim()) * 1000);
  assert.match(cli(dir, 'provenance', 'show', sha), /2 lines written by AI agents[\s\S]*turn 1: "rename the top"[\s\S]*app\.js: 1-2/);
  // Recording again is idempotent.
  cli(dir, 'provenance', 'record', sha);
  assert.equal(rawNote(dir), raw);
});

test('two agents in one commit, each with its own run and turn', () => {
  const dir = repo({ 'app.js': text(TEN) });
  prompt('aaaa1111', dir, 'first task');
  prompt('aaaa1111', dir, 'rename the top');
  agentEdit('aaaa1111', dir, 'app.js', setLines({ 1: 'A one', 2: 'A two' }));
  endSession('aaaa1111', dir);
  prompt('bbbb2222', dir, 'fix the bottom');
  agentEdit('bbbb2222', dir, 'app.js', setLines({ 9: 'B nine', 10: 'B ten' }));
  agentEdit('bbbb2222', dir, 'util.js', (abs) => fs.writeFileSync(abs, 'export const u = 1;\n'), 'Write');
  commit(dir, 'both', 'util.js');
  const n = note(dir);
  assert.deepEqual(n.runs.map((r) => [r.label, r.turns]), [
    ['claude aaaa1111', [{ turn: 2, intent: 'rename the top' }]],
    ['claude bbbb2222', [{ turn: 1, intent: 'fix the bottom' }]],
  ]);
  assert.deepEqual(n.files, { 'app.js': [[1, 2, 0, 2], [9, 10, 1, 1]], 'util.js': [[1, 1, 1, 1]] });
});

test('a commit with only human changes gets an empty note ("recorded, human"), never a deleted one', () => {
  const dir = repo({ 'app.js': text(TEN) });
  human(dir, 'app.js', { 3: 'human three' }, { append: ['human eleven'] });
  const sha = commit(dir, 'human');
  const n = note(dir, sha);
  assert.deepEqual(n.runs, []);
  assert.deepEqual(n.files, {});
  assert.equal(n.commit.added, 2, 'the denominator is there');
  assert.equal(n.commit.ts, Number(git(dir, 'show', '-s', '--format=%ct', sha).trim()) * 1000);
  assert.match(cli(dir, 'provenance', 'show', sha), /recorded, no lines written by AI agents \(2 lines added by people\)/);
  // A commit made before init was never recorded: no note at all ("unknown").
  assert.equal(rawNote(dir, 'HEAD~1'), null);
  assert.match(cli(dir, 'provenance', 'show', 'HEAD~1'), /no provenance note \(not recorded/);

  // Agent lines committed earlier are not this commit's: an empty note.
  const dir2 = repo({ 'app.js': text(TEN) });
  agentEdit('cccc3333', dir2, 'app.js', setLines({ 1: 'C one' }));
  commit(dir2, 'agent');
  human(dir2, 'app.js', { 8: 'human eight' });
  commit(dir2, 'human');
  assert.deepEqual(note(dir2).runs, []);
  assert.equal(note(dir2).commit.added, 1);
  const agentNote = rawNote(dir2, 'HEAD~1');
  assert.deepEqual(parseNote(agentNote).files, { 'app.js': [[1, 1, 0, 0]] });

  // On a machine without that ledger, recording again finds no agent lines,
  // and the note that lists the agent run is kept, not emptied.
  fs.rmSync(path.join(dir2, '.git', 'grapim'), { recursive: true, force: true });
  assert.match(cli(dir2, 'provenance', 'record', 'HEAD~1'), /the existing note, which lists agent runs, is kept/);
  assert.equal(rawNote(dir2, 'HEAD~1'), agentNote);
});

test('a new file, a rename (the agent edited the old path), and CRLF with autocrlf', () => {
  const dir = repo({ 'app.js': text(TEN) });
  agentEdit('dddd4444', dir, 'new.js', (abs) => fs.writeFileSync(abs, 'one\ntwo\nthree\n'), 'Write');
  commit(dir, 'new file', 'new.js');
  assert.deepEqual(note(dir).files, { 'new.js': [[1, 3, 0, 0]] });

  // The agent edits app.js, a human renames it before committing.
  agentEdit('dddd4444', dir, 'app.js', setLines({ 4: 'D four' }));
  git(dir, 'mv', 'app.js', 'lib.js');
  human(dir, 'lib.js', { 7: 'human seven' });
  git(dir, 'add', 'lib.js');
  commit(dir, 'rename');
  assert.match(git(dir, 'show', '--name-status', '-M', '--format=', 'HEAD'), /^R\d+\tapp\.js\tlib\.js/m);
  assert.deepEqual(note(dir).files, { 'lib.js': [[4, 4, 0, 0]] });

  // Windows line endings: the blob has LF, the working file and the ledger CRLF.
  const crlf = repo({ 'win.txt': text(TEN, '\r\n') }, { autocrlf: 'true' });
  assert.ok(!git(crlf, 'cat-file', 'blob', 'HEAD:win.txt').includes('\r'), 'stored with LF');
  agentEdit('eeee5555', crlf, 'win.txt', setLines({ 2: 'E two', 3: 'E three' }));
  human(crlf, 'win.txt', { 6: 'human six' });
  assert.ok(fs.readFileSync(path.join(crlf, 'win.txt'), 'latin1').includes('E two\r\n'));
  commit(crlf, 'crlf');
  assert.deepEqual(note(crlf).files, { 'win.txt': [[2, 3, 0, 0]] }, 'only the edited lines, not the whole file');
});

test('--amend and rebase keep the notes (notes.rewriteRef), with no concatenated notes', () => {
  const dir = repo({ 'app.js': text(TEN), 'other.js': 'x\n' });
  assert.equal(git(dir, 'config', '--get-all', 'notes.rewriteRef').trim(), 'refs/notes/grapim');
  assert.equal(git(dir, 'config', '--bool', 'notes.rewrite.amend').trim(), 'true');
  assert.equal(git(dir, 'config', '--bool', 'notes.rewrite.rebase').trim(), 'true');
  prompt('ffff6666', dir, 'top lines');
  agentEdit('ffff6666', dir, 'app.js', setLines({ 1: 'F one', 2: 'F two' }));
  const first = commit(dir, 'agent work');
  const expected = { 'app.js': [[1, 2, 0, 1]] };
  assert.deepEqual(note(dir).files, expected);

  // Reword only.
  git(dir, 'commit', '-q', '--amend', '-m', 'agent work, reworded');
  const amended = git(dir, 'rev-parse', 'HEAD').trim();
  assert.notEqual(amended, first);
  assert.equal(rawNote(dir).trim().split('\n').filter(Boolean).length, 1, 'one note, not two concatenated');
  assert.deepEqual(note(dir).files, expected);

  // Amend with more agent lines: the note covers both.
  agentEdit('ffff6666', dir, 'app.js', setLines({ 5: 'F five' }));
  git(dir, 'commit', '-q', '-a', '--amend', '--no-edit');
  assert.equal(rawNote(dir).trim().split('\n').filter(Boolean).length, 1);
  assert.deepEqual(note(dir).files, { 'app.js': [[1, 2, 0, 1], [5, 5, 0, 1]] });
  const beforeRebase = note(dir);

  // Rebase onto a human commit made on another branch.
  git(dir, 'checkout', '-q', '-b', 'side', 'HEAD~1');
  human(dir, 'other.js', { 1: 'y' });
  commit(dir, 'human on side');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'rebase', '-q', 'side');
  const rebased = git(dir, 'rev-parse', 'HEAD').trim();
  assert.equal(git(dir, 'rev-parse', 'HEAD~1').trim(), git(dir, 'rev-parse', 'side').trim());
  assert.equal(rawNote(dir, rebased).trim().split('\n').filter(Boolean).length, 1);
  assert.deepEqual(note(dir, rebased), beforeRebase);
  assert.deepEqual(note(dir, 'side').runs, [], 'the human commit has an empty note');
  assert.equal(note(dir, 'side').commit.added, 1);
});

test('blame --history after two commits: run, turn and prompt per line, committed or not', () => {
  const dir = repo({ 'app.js': text(TEN) });
  prompt('aaaa1111', dir, 'first task');
  prompt('aaaa1111', dir, 'rename the top');
  agentEdit('aaaa1111', dir, 'app.js', setLines({ 1: 'A one', 2: 'A two' }));
  human(dir, 'app.js', {}, { append: ['human eleven'] });
  const c1 = commit(dir, 'one');
  endSession('aaaa1111', dir);
  prompt('bbbb2222', dir, 'fix the bottom');
  agentEdit('bbbb2222', dir, 'app.js', setLines({ 9: 'B nine', 10: 'B ten' }));
  const c2 = commit(dir, 'two');
  endSession('bbbb2222', dir);
  // Not committed yet: an agent line and a human line.
  prompt('cccc3333', dir, 'tweak the middle');
  agentEdit('cccc3333', dir, 'app.js', setLines({ 5: 'C five' }));
  human(dir, 'app.js', { 6: 'human six' });

  const h = json(dir, 'blame', 'app.js', '--history');
  const by = Object.fromEntries(h.lines.map((l) => [l.line, [l.label, l.turn, l.intent, l.commit, l.source]]));
  assert.deepEqual(by[1], ['claude aaaa1111', 2, 'rename the top', c1, 'note']);
  assert.deepEqual(by[2], ['claude aaaa1111', 2, 'rename the top', c1, 'note']);
  assert.deepEqual(by[9], ['claude bbbb2222', 1, 'fix the bottom', c2, 'note']);
  assert.deepEqual(by[10], ['claude bbbb2222', 1, 'fix the bottom', c2, 'note']);
  assert.deepEqual(by[5], ['claude cccc3333', 1, 'tweak the middle', null, 'ledger']);
  assert.deepEqual(by[6], ['human/unknown', null, null, null, null]);
  assert.deepEqual(by[11], ['human/unknown', null, null, c1, null]);
  assert.equal(by[3][0], 'human/unknown');
  assert.equal(h.lines.length, 11);
  assert.equal(h.agentLines, 5);
  const out = cli(dir, 'blame', 'app.js', '--history');
  assert.match(out, /^ 1 {2}claude aaaa1111 +turn 2 +[0-9a-f]{8} +\| A one$/m);
  assert.match(out, /^ 5 {2}claude cccc3333 +turn 1 +uncommitted +\| C five$/m);
  assert.match(out, /claude aaaa1111 turn 2: "rename the top"/);
});

test('stats: AI share per agent and per file over a rev range', () => {
  const dir = repo({ 'app.js': text(TEN) });
  prompt('aaaa1111', dir, 'top');
  agentEdit('aaaa1111', dir, 'app.js', setLines({ 1: 'A one', 2: 'A two' }));
  human(dir, 'app.js', {}, { append: ['human eleven'] });
  commit(dir, 'one');
  endSession('aaaa1111', dir);
  agentEdit('bbbb2222', dir, 'app.js', setLines({ 9: 'B nine', 10: 'B ten' }));
  agentEdit('bbbb2222', dir, 'b.js', (abs) => fs.writeFileSync(abs, 'b1\nb2\nb3\n'), 'Write');
  commit(dir, 'two', 'b.js');

  const all = json(dir, 'provenance', 'stats');
  assert.equal(all.commits, 3);
  assert.equal(all.withNotes, 2);
  assert.equal(all.added, 10 + 3 + 5);
  assert.equal(all.ai, 7);
  assert.equal(all.share, 38.9);
  const recent = json(dir, 'provenance', 'stats', 'HEAD~2..HEAD');
  assert.equal(recent.commits, 2);
  assert.equal(recent.added, 8);
  assert.equal(recent.ai, 7);
  assert.equal(recent.share, 87.5);
  assert.deepEqual(recent.agents.map((a) => [a.label, a.kind, a.lines, a.files, a.commits]), [
    ['claude bbbb2222', 'claude-code', 5, 2, 1],
    ['claude aaaa1111', 'claude-code', 2, 1, 1],
  ]);
  assert.deepEqual(recent.kinds, [{ kind: 'claude-code', lines: 7, share: 87.5 }]);
  assert.deepEqual(recent.files.map((f) => [f.path, f.ai, f.added]), [['app.js', 4, 5], ['b.js', 3, 3]]);
  assert.match(cli(dir, 'provenance', 'stats', 'HEAD~2..HEAD'), /8 lines added, 7 by AI agents \(87\.5%\)/);
});

// ---------------------------------------------------------------- hooks

test('the git hooks chain to an existing post-commit hook and stay idempotent across two inits', () => {
  const dir = repo({ 'app.js': text(TEN) }, { init: false });
  const hooks = path.join(dir, '.git', 'hooks');
  const mine = '#!/bin/sh\necho ran >> "$(git rev-parse --show-toplevel)/.hook-log"\n';
  fs.writeFileSync(path.join(hooks, 'post-commit'), mine, { mode: 0o755 });
  cli(dir, 'init');
  const once = fs.readFileSync(path.join(hooks, 'post-commit'), 'utf8');
  const out = cli(dir, 'init');
  assert.match(out, /chained to your existing post-commit/);
  assert.equal(fs.readFileSync(path.join(hooks, 'post-commit'), 'utf8'), once, 'the second init writes the same hook');
  assert.equal(once.split(MARKER).length, 2);
  assert.equal(fs.readFileSync(path.join(hooks, 'post-commit.grapim-prev'), 'utf8'), mine);
  assert.deepEqual(fs.readdirSync(hooks).filter((f) => f.includes('grapim')).sort(), ['post-commit.grapim-prev']);
  assert.equal(git(dir, 'config', '--get-all', 'notes.rewriteRef').trim(), 'refs/notes/grapim', 'added once');

  agentEdit('aaaa1111', dir, 'app.js', setLines({ 1: 'A one' }));
  commit(dir, 'one');
  human(dir, 'app.js', { 2: 'human' });
  commit(dir, 'two');
  assert.equal(fs.readFileSync(path.join(dir, '.hook-log'), 'utf8'), 'ran\nran\n', 'the old hook ran once per commit');
  assert.deepEqual(note(dir, 'HEAD~1').files, { 'app.js': [[1, 1, 0, 0]] });

  // core.hooksPath is respected.
  const custom = repo({ 'a.txt': 'a\n' }, { init: false });
  git(custom, 'config', 'core.hooksPath', '.githooks');
  cli(custom, 'init');
  assert.ok(fs.readFileSync(path.join(custom, '.githooks', 'post-commit'), 'utf8').includes(MARKER));
  assert.ok(!fs.existsSync(path.join(custom, '.git', 'hooks', 'post-commit')));
});

test('a failing grapim never fails the commit or the push', () => {
  const dir = repo({ 'app.js': text(TEN) }, { init: false });
  const boom = path.join(dir, '.git', 'boom.js');
  fs.writeFileSync(boom, 'throw new Error("grapim is broken");\n');
  installGitHooks(dir, { bin: boom.split(path.sep).join('/') });
  human(dir, 'app.js', { 1: 'changed' });
  const r = spawnSync('git', ['commit', '-qam', 'still commits'], { cwd: dir, encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /could not record AI provenance for this commit \(the commit is fine\)/);
  assert.equal(git(dir, 'log', '-1', '--format=%s').trim(), 'still commits');

  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-prov-remote-'));
  git(remote, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'notes', '--ref=grapim', 'add', '-m', 'x', 'HEAD');
  const p = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: dir, encoding: 'utf8', env: ENV });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stderr, /could not push AI provenance notes \(your push goes on\)/);
  assert.equal(git(remote, 'rev-parse', 'main').trim(), git(dir, 'rev-parse', 'HEAD').trim());
});

test('pre-push pushes the notes with the push, and a previous pre-push hook can still block it', () => {
  const dir = repo({ 'app.js': text(TEN) });
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-prov-remote-'));
  git(remote, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  agentEdit('aaaa1111', dir, 'app.js', setLines({ 3: 'A three' }));
  const sha = commit(dir, 'agent');
  git(dir, 'push', '-q', 'origin', 'main');
  assert.equal(git(remote, 'rev-parse', 'refs/notes/grapim').trim(), git(dir, 'rev-parse', 'refs/notes/grapim').trim());
  assert.deepEqual(parseNote(git(remote, 'notes', '--ref=grapim', 'show', sha)).files, { 'app.js': [[3, 3, 0, 0]] });

  // The user puts their own pre-push hook in place of ours, then runs init again.
  const hooks = path.join(dir, '.git', 'hooks');
  fs.writeFileSync(path.join(hooks, 'pre-push'), '#!/bin/sh\necho "tests failed" >&2\nexit 1\n', { mode: 0o755 });
  cli(dir, 'init');
  assert.ok(fs.existsSync(path.join(hooks, 'pre-push.grapim-prev')));
  human(dir, 'app.js', { 4: 'human' });
  commit(dir, 'human');
  const r = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: dir, encoding: 'utf8', env: ENV });
  assert.notEqual(r.status, 0, 'the previous hook still decides');
  assert.match(r.stderr, /tests failed/);
});

test('--no-intents writes notes without prompts', () => {
  const dir = repo({ 'app.js': text(TEN) }, { initArgs: ['--no-intents'] });
  assert.equal(git(dir, 'config', '--bool', 'grapim.notes.intents').trim(), 'false');
  prompt('aaaa1111', dir, 'a secret prompt about the payroll system');
  agentEdit('aaaa1111', dir, 'app.js', setLines({ 1: 'A one' }));
  commit(dir, 'one');
  const raw = rawNote(dir);
  assert.doesNotMatch(raw, /secret|payroll/);
  assert.deepEqual(note(dir).runs[0].turns, [{ turn: 1 }]);
  // A second plain init keeps the choice.
  cli(dir, 'init');
  assert.equal(git(dir, 'config', '--bool', 'grapim.notes.intents').trim(), 'false');
});

test('SessionStart says how to turn on commit provenance until the git hooks are installed', () => {
  const dir = repo({ 'app.js': text(TEN) }, { init: false });
  const start = () => hook({ hook_event_name: 'SessionStart', session_id: 'ssss0000', cwd: dir }).stdout;
  assert.match(start(), /run `grapim init`/);
  assert.equal(start().trim().split('\n').length, 1, 'one line');
  assert.ok(!fs.existsSync(path.join(dir, '.git', 'hooks', 'post-commit')), 'nothing installed silently');
  cli(dir, 'init');
  assert.doesNotMatch(start(), /grapim init/);
});
