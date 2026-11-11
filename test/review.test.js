// Per-run branches and review state, driven like test/ledger.test.js: real
// temp git repos, the Claude Code hook as a process, and the CLI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { getReview, setReview } from '../src/review.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'grapim.js');
const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
const text = (lines, eol = '\n') => lines.map((l) => l + eol).join('');

// Every process in these tests sees no global or system git config and no
// identity, so the tests do not depend on the machine they run on.
const EMPTY_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-review-cfg-')), 'gitconfig');
fs.writeFileSync(EMPTY_CONFIG, '');
const BASE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(GIT_|EMAIL$)/.test(k)),
);
Object.assign(BASE_ENV, { GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_NOSYSTEM: '1' });

// Extra git config for one process, through env (as `git -c` would).
const withConfig = (pairs) => {
  const entries = Object.entries(pairs);
  const env = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([k, v], i) => Object.assign(env, { [`GIT_CONFIG_KEY_${i}`]: k, [`GIT_CONFIG_VALUE_${i}`]: v }));
  return env;
};

const gitIn = (dir, args, env = {}) => execFileSync('git', args, { cwd: dir, env: { ...BASE_ENV, ...env } });
const gitStr = (dir, args, env) => gitIn(dir, args, env).toString('utf8').trim();

function repo(files, gitArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-review-'));
  const git = (args) => gitIn(dir, [...gitArgs, ...args]);
  git(['init', '-q']);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  git(['add', '.']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return dir;
}

function hook(input) {
  const r = spawnSync(process.execPath, [BIN, 'hook'], { input: JSON.stringify(input), encoding: 'utf8', env: BASE_ENV });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /grapim ledger/);
}

function run(cwd, args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...BASE_ENV, ...env } });
}

function cli(cwd, args, env) {
  const r = run(cwd, args, env);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const json = (cwd, args, env) => JSON.parse(cli(cwd, [...args, '--json'], env));
const prompt = (session, cwd, p) => hook({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd, prompt: p });
const endSession = (session, cwd) => hook({ hook_event_name: 'SessionEnd', session_id: session, cwd });

let nextToolUse = 1;
function agentEdit(session, cwd, file, change, tool = 'Edit') {
  const abs = path.join(cwd, file);
  const input = { session_id: session, cwd, tool_name: tool, tool_use_id: `toolu_r${nextToolUse++}`, tool_input: { file_path: abs } };
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

// A edits the top (in its second turn) and B the bottom of the same file.
function twoRuns(dir) {
  prompt('aaaa1111', dir, 'first task');
  prompt('aaaa1111', dir, 'rename the top');
  agentEdit('aaaa1111', dir, 'app.js', setLines({ 1: 'A one', 2: 'A two' }));
  endSession('aaaa1111', dir);
  prompt('bbbb2222', dir, 'fix the bottom');
  agentEdit('bbbb2222', dir, 'app.js', setLines({ 9: 'B nine', 10: 'B ten' }));
  endSession('bbbb2222', dir);
}

// Everything git and the user see: working files, the real index, HEAD.
function untouched(dir) {
  const files = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const p = path.posix.join(rel, e.name);
      if (p === '.git') continue;
      if (e.isDirectory()) walk(p);
      else files[p] = fs.readFileSync(path.join(dir, p)).toString('base64');
    }
  };
  walk('');
  return {
    files,
    index: fs.readFileSync(path.join(dir, '.git', 'index')).toString('base64'),
    head: gitStr(dir, ['rev-parse', 'HEAD']),
    ref: gitStr(dir, ['symbolic-ref', 'HEAD']),
  };
}

const blob = (dir, spec) => gitIn(dir, ['cat-file', 'blob', spec]);

test('the branch for run A holds only A\'s change on top of HEAD, and nothing else moves', () => {
  const dir = repo({ 'app.js': text(TEN) });
  twoRuns(dir);
  const before = untouched(dir);
  const b = json(dir, ['branch', 'aaaa1111']);
  assert.equal(b.branch, 'grapim/claude-aaaa1111');
  assert.deepEqual(b.files, [{ path: 'app.js', status: 'applied' }]);
  assert.equal(blob(dir, `${b.branch}:app.js`).toString(), text(['A one', 'A two', ...TEN.slice(2)]));
  assert.equal(gitStr(dir, ['rev-parse', `${b.branch}^`]), before.head);
  assert.equal(gitStr(dir, ['rev-parse', b.branch]), b.commit);
  assert.deepEqual(untouched(dir), before, 'working tree, index or HEAD changed');
  assert.match(cli(dir, ['runs']), /REVIEW/);
});

test('branching the same run twice gives -2, and runs shows the newest branch', () => {
  const dir = repo({ 'app.js': text(TEN) });
  twoRuns(dir);
  const first = json(dir, ['branch', 'bbbb2222']);
  const second = json(dir, ['branch', 'bbbb2222']);
  assert.equal(first.branch, 'grapim/claude-bbbb2222');
  assert.equal(second.branch, 'grapim/claude-bbbb2222-2');
  assert.equal(gitStr(dir, ['rev-parse', `${first.branch}^{tree}`]), gitStr(dir, ['rev-parse', `${second.branch}^{tree}`]));
  const row = json(dir, ['runs']).find((r) => r.label === 'claude bbbb2222');
  assert.equal(row.branch, 'grapim/claude-bbbb2222-2');
  const out = cli(dir, ['branch', 'bbbb2222']);
  assert.match(out, /Branch grapim\/claude-bbbb2222-3 created/);
  assert.match(out, /app\.js \| 4 \+\+--/);
});

test('the commit is authored by the agent; the committer is the user, or the agent when git has no identity', () => {
  const dir = repo({ 'app.js': text(TEN) });
  twoRuns(dir);
  const fmt = ['log', '-1', '--format=%an <%ae>%n%cn <%ce>%n%B'];

  const anon = json(dir, ['branch', 'aaaa1111']);
  const [author, committer, subject, , ...body] = gitStr(dir, [...fmt, anon.commit]).split('\n');
  assert.equal(author, 'claude aaaa1111 <agent@grapim.local>');
  assert.equal(committer, 'claude aaaa1111 <agent@grapim.local>');
  assert.equal(subject, 'rename the top');
  const msg = body.join('\n');
  assert.match(msg, /Turns:\n {2}2\. rename the top \(app\.js\)/);
  assert.match(msg, /Files:\n {2}M app\.js/);
  assert.match(msg, /Grapim-Run: claude-code:aaaa1111$/);

  const pat = json(dir, ['branch', 'aaaa1111'], withConfig({ 'user.name': 'Pat Doe', 'user.email': 'pat@example.com' }));
  const [author2, committer2] = gitStr(dir, [...fmt, pat.commit]).split('\n');
  assert.equal(author2, 'claude aaaa1111 <agent@grapim.local>');
  assert.equal(committer2, 'Pat Doe <pat@example.com>');
});

test('a file the run created and a file it deleted both land in the branch commit', () => {
  const dir = repo({ 'app.js': text(TEN), 'old.js': 'old\n' });
  prompt('cccc3333', dir, 'replace old.js with new.js');
  agentEdit('cccc3333', dir, 'new.js', (abs) => fs.writeFileSync(abs, 'brand new\n'), 'Write');
  agentEdit('cccc3333', dir, 'old.js', (abs) => fs.rmSync(abs), 'Write');
  const before = untouched(dir);
  const b = json(dir, ['branch', 'cccc3333']);
  assert.deepEqual(b.files.map((f) => [f.path, f.status]), [['new.js', 'applied'], ['old.js', 'applied']]);
  assert.equal(gitStr(dir, ['diff', '--name-status', 'HEAD', b.branch]), 'A\tnew.js\nD\told.js');
  assert.equal(blob(dir, `${b.branch}:new.js`).toString(), 'brand new\n');
  assert.match(gitStr(dir, ['ls-tree', b.branch, 'new.js']), /^100644 blob /);
  assert.match(gitStr(dir, ['log', '-1', '--format=%B', b.commit]), /A new\.js\n {2}D old\.js/);
  assert.deepEqual(untouched(dir), before);
});

test('a file whose run edits overlap uncommitted work is reported as a conflict and left out', () => {
  const dir = repo({ 'app.js': text(TEN), 'other.js': text(TEN) });
  // Someone outside any run edits line 2 and does not commit; then D rewrites that line.
  setLines({ 2: 'human two' })(path.join(dir, 'app.js'));
  prompt('dddd4444', dir, 'tidy up');
  agentEdit('dddd4444', dir, 'app.js', setLines({ 2: 'D two' }));
  agentEdit('dddd4444', dir, 'other.js', setLines({ 5: 'D five' }));
  const b = json(dir, ['branch', 'dddd4444']);
  const byPath = Object.fromEntries(b.files.map((f) => [f.path, f]));
  assert.equal(byPath['app.js'].status, 'conflict');
  assert.match(byPath['app.js'].reason, /overlap/);
  assert.equal(byPath['other.js'].status, 'applied');
  assert.equal(gitStr(dir, ['diff', '--name-only', 'HEAD', b.branch]), 'other.js');
  assert.match(gitStr(dir, ['log', '-1', '--format=%B', b.commit]), /Left out \(conflict\):\n {2}app\.js: /);

  // A run where every file conflicts gets no branch at all.
  endSession('dddd4444', dir);
  prompt('eeee5555', dir, 'again');
  agentEdit('eeee5555', dir, 'app.js', setLines({ 2: 'E two' }));
  const r = run(dir, ['branch', 'eeee5555']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Nothing could go on a branch: app\.js/);
  assert.equal(gitStr(dir, ['branch', '--list', 'grapim/claude-eeee5555']), '');
});

test('CRLF is byte-exact in the branch blob with core.autocrlf=true', () => {
  const AUTOCRLF = withConfig({ 'core.autocrlf': 'true' });
  const want = (eol) => Buffer.from(text(['A one', 'A two', ...TEN.slice(2)], eol));

  // HEAD stores CRLF: autocrlf must not turn the run's blob into LF.
  const crlf = repo({ 'app.js': text(TEN, '\r\n') }, ['-c', 'core.autocrlf=false']);
  assert.ok(blob(crlf, 'HEAD:app.js').equals(Buffer.from(text(TEN, '\r\n'))));
  twoRuns(crlf);
  const before = untouched(crlf);
  const a = json(crlf, ['branch', 'aaaa1111'], AUTOCRLF);
  assert.ok(blob(crlf, `${a.branch}:app.js`).equals(want('\r\n')));
  assert.deepEqual(untouched(crlf), before);

  // HEAD stores LF and the checkout is CRLF (autocrlf): the branch keeps HEAD's LF
  // and changes only A's two lines, instead of conflicting on every line.
  const lf = repo({ 'app.js': text(TEN, '\r\n') }, ['-c', 'core.autocrlf=true']);
  assert.ok(blob(lf, 'HEAD:app.js').equals(Buffer.from(text(TEN))));
  twoRuns(lf);
  const b = json(lf, ['branch', 'aaaa1111'], AUTOCRLF);
  assert.ok(blob(lf, `${b.branch}:app.js`).equals(want('\n')));
  assert.equal(gitStr(lf, ['diff', '--numstat', 'HEAD', b.branch], AUTOCRLF), '2\t2\tapp.js');
});

test('review: approve with a note, read it back, see the event and the REVIEW column', () => {
  const dir = repo({ 'app.js': text(TEN) });
  twoRuns(dir);
  const set = json(dir, ['review', 'aaaa1111', '--approve', '--note', 'looks good', '--agent', 'human:pat']);
  assert.equal(set.run, 'claude-code:aaaa1111');
  assert.deepEqual([set.review.status, set.review.note, set.review.by], ['approved', 'looks good', 'human:pat']);
  assert.equal(typeof set.review.at, 'number');
  assert.deepEqual(json(dir, ['review', 'aaaa1111']).review, set.review);

  const runs = Object.fromEntries(json(dir, ['runs']).map((r) => [r.label, r]));
  assert.deepEqual(runs['claude aaaa1111'].review, set.review);
  assert.equal(runs['claude bbbb2222'].review.status, 'pending');
  assert.equal(runs['claude aaaa1111'].branch, null);
  assert.match(cli(dir, ['runs']), /claude aaaa1111 .* approved/);
  assert.match(cli(dir, ['log']), /claude aaaa1111 was reviewed: approved: looks good/);

  const r = run(dir, ['review', 'bbbb2222', '--reject']);
  assert.match(r.stdout, /claude bbbb2222: rejected by human:/);
  assert.match(r.stdout, /grapim undo "claude bbbb2222" --yes/);

  const store = new Store(path.join(dir, '.git', 'grapim'));
  try {
    const ev = store.events(50).filter((e) => e.kind === 'review');
    assert.deepEqual(ev.map((e) => [e.agent, e.detail]), [['claude-code:aaaa1111', 'approved: looks good'], ['claude-code:bbbb2222', 'rejected']]);
    assert.equal(getReview(store, 'claude-code:bbbb2222').status, 'rejected');
    assert.equal(getReview(store, 'nobody'), null);
    assert.throws(() => setReview(store, 'claude-code:aaaa1111', 'merged'), (err) => err.code === 'bad_request');
  } finally {
    store.close();
  }
});
