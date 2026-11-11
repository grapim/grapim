// The Files half of the review desk, over real HTTP against real temp git
// repos: restore to a recorded version (and undo of it), full blame, the
// recursive listing, the worktree parameter, who acted on events, and
// undo/restore runs that need no review.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startServer } from '../src/server/index.js';
import { MAX_LISTED } from '../src/server/fs.js';
import { eventsAfter } from '../src/server/queries.js';
import { Store } from '../src/store.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'grapim.js');
const ME = `human:${os.userInfo().username}`;
const run = promisify(execFile);
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
const text = (lines) => lines.map((l) => l + '\n').join('');
const withLines = (edits) => text(TEN.map((l, i) => edits[i + 1] ?? l));

function repo(files = { 'app.js': text(TEN) }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-files-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']);
  write(dir, files);
  git(['add', '.']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return dir;
}

function write(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

const serve = (dir, opts = {}) => startServer({ cwd: dir, port: 0, env: {}, uiDir: path.join(dir, 'no-ui'), ...opts });

function request(s, method, rawPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    // agent: false, so a slow step (writing 5000 files) never reuses a socket the server closed.
    const req = http.request({ host: '127.0.0.1', port: s.port, method, path: rawPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, text: buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const getJson = async (s, p) => {
  const r = await request(s, 'GET', p);
  assert.equal(r.status, 200, `${p}: ${r.text}`);
  return r.json();
};
const post = (s, p, body, headers = {}) => request(s, 'POST', p, { headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const put = (s, agent, p, body) => request(s, 'PUT', `/fs/${p}`, { headers: { 'X-Grapim-Agent': agent }, body });
const release = (s, agent) => request(s, 'POST', '/fs/_release', { headers: { 'X-Grapim-Agent': agent } });

function assertError(r, status, code) {
  assert.equal(r.status, status, r.text);
  assert.equal(r.json().error.code, code);
}

// Two versions of app.js by agent alpha, each its own change.
async function twoVersions(s, dir) {
  const v1 = withLines({ 1: 'A one' });
  const v2 = withLines({ 1: 'A one', 2: 'A two' });
  assert.equal((await put(s, 'alpha', 'app.js', v1)).status, 200);
  await release(s, 'alpha');
  assert.equal((await put(s, 'alpha', 'app.js', v2)).status, 200);
  await release(s, 'alpha');
  assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), v2);
  return { v1, v2 };
}

// A Claude Code PreToolUse with no PostToolUse yet: an edit in progress. Warn
// mode, so the hook edits without a claim (a claim would make it a 409).
async function hookPre(session, cwd, file) {
  const child = spawn(process.execPath, [BIN, 'hook'], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, GRAPIM_MODE: 'warn' } });
  child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: session, cwd, tool_name: 'Edit', tool_use_id: `toolu_files_${session}`, tool_input: { file_path: path.join(cwd, file) } }));
  assert.equal(await new Promise((r) => child.on('close', r)), 0);
}

test('restore: plan, apply, recorded as its own approved run, then undone like any run', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    const { v1, v2 } = await twoVersions(s, dir);
    const hist = await getJson(s, '/api/files/history?path=app.js');
    assert.equal(hist.length, 2);
    const target = hist[0].after_sha;
    assert.equal(target, sha1(v1));

    // apply: false plans and changes nothing.
    const plan = (await post(s, '/api/files/restore', { path: 'app.js', sha: target, apply: false })).json();
    assert.equal(plan.applied, false);
    assert.equal(plan.action, 'replace');
    assert.equal(plan.current_sha, sha1(v2));
    assert.deepEqual([plan.added, plan.removed, plan.reason, plan.run], [1, 1, null, null]);
    assert.deepEqual(plan.from.run, 'http:alpha');
    const lines = plan.diff.hunks.flatMap((h) => h.lines).filter((l) => l.t !== ' ');
    assert.deepEqual(lines, [{ t: '-', s: 'A two' }, { t: '+', s: 'line 2' }]);
    assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), v2);

    // A stale expect is refused; the file is untouched.
    assertError(await post(s, '/api/files/restore', { path: 'app.js', sha: target, expect: sha1('other') }), 409, 'conflict');
    assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), v2);

    // The body { path, sha } restores (a prefix of the sha is enough).
    const done = (await post(s, '/api/files/restore', { path: 'app.js', sha: target.slice(0, 10), expect: plan.current_sha })).json();
    assert.equal(done.applied, true);
    assert.match(done.run, /^restore:\d+$/);
    assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), v1);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file left');

    // History, runs, blame and events all see it.
    const after = await getJson(s, '/api/files/history?path=app.js');
    assert.equal(after.length, 3);
    assert.deepEqual([after[2].run, after[2].before_sha, after[2].after_sha], [done.run, sha1(v2), sha1(v1)]);
    const runs = await getJson(s, '/api/runs');
    const r = runs.find((x) => x.run === done.run);
    assert.equal(r.label, `restore app.js ${target.slice(0, 8)}`);
    assert.deepEqual([r.review.status, r.review.note, r.review.by], ['approved', 'automatic', ME]);
    const o = await getJson(s, '/api/overview');
    assert.equal(o.counts.unreviewed, 1, 'only alpha needs review');
    const blame = await getJson(s, '/api/blame?path=app.js');
    assert.deepEqual(blame.lines.map((l) => [l.line, l.run]), [[1, 'http:alpha']]);
    const ev = (await getJson(s, '/api/events?after=0&limit=1000')).find((e) => e.kind === 'restore');
    assert.deepEqual([ev.path, ev.actor, ev.agent], ['app.js', ME, ME]);
    assert.ok(ev.detail.startsWith(target.slice(0, 12)));

    // Restoring to what is already there does nothing.
    const same = (await post(s, '/api/files/restore', { path: 'app.js', sha: target })).json();
    assert.deepEqual([same.applied, same.action, same.run], [false, 'nothing', null]);

    // The restore itself can be undone.
    const undo = (await post(s, `/api/runs/${encodeURIComponent(done.run)}/undo`, { apply: true })).json();
    assert.equal(undo.applied, true);
    assert.deepEqual(undo.files.map((f) => [f.path, f.action]), [['app.js', 'revert']]);
    assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), v2);

    // Errors: unknown version, bad sha, folder path, refused path, missing fields.
    assertError(await post(s, '/api/files/restore', { path: 'app.js', sha: '0'.repeat(40) }), 404, 'not_found');
    assertError(await post(s, '/api/files/restore', { path: 'app.js', sha: 'xyz' }), 400, 'bad_request');
    assertError(await post(s, '/api/files/restore', { path: 'src/', sha: target }), 400, 'bad_request');
    assertError(await post(s, '/api/files/restore', { path: '.git/config', sha: target }), 400, 'bad_request');
    assertError(await post(s, '/api/files/restore', { path: 'app.js' }), 400, 'bad_request');
    assertError(await request(s, 'GET', '/api/files/restore'), 405, 'method_not_allowed');
  } finally {
    await s.close();
  }
});

test('restore: a deleted file comes back, and the version must be one this file had', async () => {
  const dir = repo({ 'app.js': text(TEN), 'other.js': 'other\n' });
  const s = await serve(dir);
  try {
    assert.equal((await request(s, 'DELETE', '/fs/app.js', { headers: { 'X-Grapim-Agent': 'alpha' } })).status, 200);
    await release(s, 'alpha');
    assert.equal(fs.existsSync(path.join(dir, 'app.js')), false);
    const [h] = await getJson(s, '/api/files/history?path=app.js');
    assert.equal(h.after_sha, null);
    // A version of another file is not a version of this one.
    assert.equal((await put(s, 'alpha', 'other.js', 'changed\n')).status, 200);
    const [o] = await getJson(s, '/api/files/history?path=other.js');
    assertError(await post(s, '/api/files/restore', { path: 'app.js', sha: o.after_sha }), 404, 'not_found');
    const r = (await post(s, '/api/files/restore', { path: 'app.js', sha: h.before_sha })).json();
    assert.deepEqual([r.applied, r.action, r.current_sha], [true, 'create', null]);
    assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), text(TEN));
  } finally {
    await s.close();
  }
});

test('restore is refused while another agent holds the file or is mid-edit', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    const { v2 } = await twoVersions(s, dir);
    const [first] = await getJson(s, '/api/files/history?path=app.js');
    // beta writes and keeps its claim.
    const v3 = withLines({ 1: 'A one', 2: 'A two', 3: 'B three' });
    assert.equal((await put(s, 'beta', 'app.js', v3)).status, 200);
    const plan = (await post(s, '/api/files/restore', { path: 'app.js', sha: first.after_sha, apply: false })).json();
    assert.match(plan.reason, /held by beta/);
    const r = await post(s, '/api/files/restore', { path: 'app.js', sha: first.after_sha });
    assertError(r, 409, 'conflict');
    assert.match(r.json().error.message, /held by beta/);
    assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), v3);
    assert.ok(!(await getJson(s, '/api/runs')).some((x) => x.run.startsWith('restore:')), 'nothing recorded');
    await release(s, 'beta');

    // A hook agent in the middle of an edit (PreToolUse, no PostToolUse yet): 503.
    await hookPre('mid1edit', dir, 'app.js');
    assertError(await post(s, '/api/files/restore', { path: 'app.js', sha: first.after_sha }), 503, 'busy');
    assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), v3);
    assert.notEqual(v2, v3);
  } finally {
    await s.close();
  }
});

test('grapim restore: plan without --yes, restores with it, and its run can be undone', async () => {
  const dir = repo();
  const s = await serve(dir);
  let target, v1, v2;
  try {
    ({ v1, v2 } = await twoVersions(s, dir));
    target = (await getJson(s, '/api/files/history?path=app.js'))[0].after_sha;
  } finally {
    await s.close();
  }
  const env = { ...process.env, GRAPIM_AGENT: 'human:cli-tester' };
  const cli = (...args) => run(process.execPath, [BIN, ...args], { cwd: dir, env });
  const plan = await cli('restore', 'app.js', target.slice(0, 8));
  assert.match(plan.stdout, /Restore app\.js to [0-9a-f]{8} \(after alpha.*\) · replace, \+1 -1/);
  assert.match(plan.stdout, /^-A two$/m);
  assert.match(plan.stdout, /^\+line 2$/m);
  assert.match(plan.stdout, /Run again with --yes/);
  assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), v2);

  const json = JSON.parse((await cli('restore', 'app.js', target.slice(0, 8), '--yes', '--json')).stdout);
  assert.deepEqual([json.applied, json.action, json.sha], [true, 'replace', target]);
  assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), v1);
  const runs = JSON.parse((await cli('runs', '--json')).stdout);
  const r = runs.find((x) => x.run === json.run);
  assert.deepEqual([r.review.status, r.review.note, r.review.by], ['approved', 'automatic', 'human:cli-tester']);

  // Undo of the restore from the CLI is approved automatically too.
  await cli('undo', json.run, '--yes');
  assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), v2);
  const undo = JSON.parse((await cli('runs', '--json')).stdout).find((x) => x.run.startsWith('undo:'));
  assert.deepEqual([undo.review.status, undo.review.note, undo.review.by], ['approved', 'automatic', 'human:cli-tester']);

  const bad = await cli('restore', 'app.js', 'ffffffff').catch((e) => e);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /no recorded version/);
});

test('full blame: content of the working file in the same response; the old shape without full', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    const v = withLines({ 4: 'A four — ünïcode' });
    assert.equal((await put(s, 'alpha', 'app.js', v)).status, 200);
    const plain = await getJson(s, '/api/blame?path=app.js');
    assert.equal('content' in plain, false);
    const full = await getJson(s, '/api/blame?path=app.js&full=1');
    assert.equal(full.content, v);
    const { content, ...rest } = full;
    assert.deepEqual(rest, plain);
    assert.equal((await getJson(s, '/api/blame?path=app.js&full=0')).content, undefined);
    const gone = await getJson(s, '/api/blame?path=nope.js&full=1');
    assert.deepEqual([gone.exists, gone.content], [false, null]);
    fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    assert.equal((await getJson(s, '/api/blame?path=bin.dat&full=1')).content, null);
  } finally {
    await s.close();
  }
});

test('recursive listing: files only, .gitignore respected, never .git, capped with truncated', async () => {
  const dir = repo({ 'a.txt': 'a\n', 'src/b.js': 'b\n', 'src/deep/c.js': 'c\n', '.gitignore': 'ignored/\n*.log\n' });
  write(dir, { 'ignored/x.txt': 'x\n', 'debug.log': 'log\n', 'new.txt': 'untracked but not ignored\n' });
  fs.rmSync(path.join(dir, 'a.txt')); // deleted, still in the index
  const s = await serve(dir);
  try {
    assert.equal((await put(s, 'alpha', 'src/b.js', 'B\n')).status, 200);
    const all = await getJson(s, '/api/files?path=&recursive=1');
    assert.deepEqual(all.files.map((f) => f.path), ['.gitignore', 'new.txt', 'src/b.js', 'src/deep/c.js']);
    assert.equal(all.truncated, false);
    const b = all.files.find((f) => f.path === 'src/b.js');
    assert.deepEqual([b.name, b.type, b.size, b.held_by, b.last_change.label], ['b.js', 'file', 2, 'alpha', 'alpha']);
    const sub = await getJson(s, '/api/files?path=src/&recursive=1');
    assert.deepEqual(sub.files.map((f) => f.path), ['src/b.js', 'src/deep/c.js']);
    assert.deepEqual((await getJson(s, '/api/files?path=src&recursive=true')).files.length, 2);
    // Without recursive, the old one-folder array.
    assert.ok(Array.isArray(await getJson(s, '/api/files?path=')));
    assertError(await request(s, 'GET', '/api/files?path=.git/&recursive=1'), 400, 'bad_request');
    assertError(await request(s, 'GET', '/api/files?path=nope/&recursive=1'), 404, 'not_found');

    // The cap: MAX_LISTED files, then truncated.
    const many = path.join(dir, 'many');
    fs.mkdirSync(many);
    for (let i = 0; i < MAX_LISTED + 5; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), '');
    const big = await getJson(s, '/api/files?recursive=1');
    assert.equal(MAX_LISTED, 5000);
    assert.equal(big.files.length, MAX_LISTED);
    assert.equal(big.truncated, true);
  } finally {
    await s.close();
  }
});

test('recursive listing outside git walks the folder and skips the state folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-files-nogit-'));
  write(dir, { 'a.txt': 'a\n', 'src/b.js': 'b\n' });
  const s = await serve(dir);
  try {
    const all = await getJson(s, '/api/files?recursive=1');
    assert.deepEqual(all.files.map((f) => f.path), ['a.txt', 'src/b.js']);
    assert.ok(fs.existsSync(path.join(dir, '.grapim')), 'the state folder exists and is not listed');
  } finally {
    await s.close();
  }
});

test('worktree=: only worktrees from /api/overview; files, blame and history read that worktree', async () => {
  const dir = repo();
  const wtDir = `${dir}-wt`;
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature', wtDir], { cwd: dir, stdio: 'ignore' });
  write(wtDir, { 'only-here.txt': 'in the linked worktree\n' });
  const s = await serve(dir);
  try {
    const o = await getJson(s, '/api/overview');
    const names = o.worktrees.map((w) => w.name);
    assert.deepEqual(names, [path.basename(dir), path.basename(wtDir)]);
    assert.equal(o.worktree, path.basename(dir));
    const wt = encodeURIComponent(path.basename(wtDir));

    const here = await getJson(s, '/api/files?path=');
    assert.ok(!here.some((f) => f.name === 'only-here.txt'));
    const there = await getJson(s, `/api/files?path=&worktree=${wt}`);
    assert.ok(there.some((f) => f.name === 'only-here.txt'));
    assert.ok((await getJson(s, `/api/files?recursive=1&worktree=${wt}`)).files.some((f) => f.path === 'only-here.txt'));
    const b = await getJson(s, `/api/blame?path=only-here.txt&full=1&worktree=${wt}`);
    assert.deepEqual([b.exists, b.content], [true, 'in the linked worktree\n']);
    assert.equal((await getJson(s, '/api/blame?path=only-here.txt&full=1')).exists, false);
    assert.deepEqual(await getJson(s, `/api/files/history?path=app.js&worktree=${wt}`), []);
    // The server's own worktree by name is the same as no parameter.
    assert.deepEqual(await getJson(s, `/api/files?path=&worktree=${encodeURIComponent(path.basename(dir))}`), here);

    for (const bad of ['nope', '..', '../x', path.basename(wtDir).toUpperCase() + 'X', dir, '.git']) {
      for (const p of [`/api/files?path=&worktree=`, `/api/blame?path=app.js&worktree=`, `/api/files/history?path=app.js&worktree=`]) {
        assertError(await request(s, 'GET', p + encodeURIComponent(bad)), 400, 'bad_request');
      }
    }
    assertError(await post(s, '/api/files/restore', { path: 'app.js', sha: 'abcd', worktree: 'nope' }), 400, 'bad_request');
  } finally {
    await s.close();
  }
});

test('events carry who acted: review, branch, undo and restore', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    await twoVersions(s, dir);
    const target = (await getJson(s, '/api/files/history?path=app.js'))[0].after_sha;
    assert.equal((await post(s, '/api/runs/http%3Aalpha/review', { status: 'approved', note: 'fine' })).status, 200);
    assert.equal((await post(s, '/api/runs/http%3Aalpha/review', { status: 'rejected' }, { 'X-Grapim-Agent': 'reviewer-bot' })).status, 200);
    assert.equal((await post(s, '/api/runs/http%3Aalpha/branch', {})).status, 200);
    const restored = await post(s, '/api/files/restore', { path: 'app.js', sha: target });
    assert.equal(restored.status, 200);
    const undone = (await post(s, `/api/runs/${encodeURIComponent(restored.json().run)}/undo`, { apply: true })).json();
    assert.deepEqual(undone.files.map((f) => f.action), ['revert']);

    const ev = await getJson(s, '/api/events?after=0&limit=1000');
    for (const e of ev) assert.ok('actor' in e);
    const of = (kind) => ev.filter((e) => e.kind === kind);
    assert.deepEqual(of('review').map((e) => [e.agent, e.actor, e.detail]), [
      ['http:alpha', ME, 'approved: fine'],
      ['http:alpha', 'http:reviewer-bot', 'rejected'],
    ]);
    assert.deepEqual(of('branch').map((e) => [e.agent, e.actor]), [['http:alpha', ME]]);
    assert.deepEqual([...new Set(of('undo').map((e) => e.actor))], [ME]);
    assert.deepEqual(of('restore').map((e) => e.actor), [ME]);
    // Agents act for themselves.
    assert.ok(of('edit').every((e) => e.actor === e.agent));

    // The undo run needs no review; alpha's run keeps its own review.
    const runs = await getJson(s, '/api/runs');
    const u = runs.find((r) => r.run.startsWith('undo:'));
    assert.deepEqual([u.review.status, u.review.note, u.review.by], ['approved', 'automatic', ME]);
    assert.equal(runs.find((r) => r.run === 'http:alpha').review.status, 'rejected');
    // An automatic approval is not a review event.
    assert.equal(of('review').length, 2);
  } finally {
    await s.close();
  }
});

test('undo plans (apply: false) record nothing and approve nothing', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    await twoVersions(s, dir);
    const plan = (await post(s, '/api/runs/http%3Aalpha/undo', { apply: false })).json();
    assert.equal(plan.applied, false);
    const runs = await getJson(s, '/api/runs');
    assert.deepEqual(runs.map((r) => r.run), ['http:alpha']);
    assert.equal((await getJson(s, '/api/overview')).counts.unreviewed, 1);
  } finally {
    await s.close();
  }
});

test('events storage stays compatible: an old state file gains the actor column, old rows read as before', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-files-old-'));
  const db = new DatabaseSync(path.join(stateDir, 'state.db'));
  db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL, path TEXT, detail TEXT)`);
  const add = db.prepare('INSERT INTO events (ts, agent, kind, path, detail) VALUES (?, ?, ?, ?, ?)');
  add.run(1, 'claude-code:a', 'edit', 'app.js', '+1 -0');
  add.run(2, 'claude-code:a', 'review', null, 'approved');
  add.run(3, 'human:alex', 'undo', 'app.js', 'revert: claude a');
  db.close();
  const store = new Store(stateDir);
  try {
    store.recordEvent('claude-code:a', 'review', null, 'rejected', 'human:sam');
    const ev = eventsAfter(store, 0, 10);
    assert.deepEqual(ev.map((e) => [e.kind, e.actor]), [
      ['edit', 'claude-code:a'],
      ['review', null],
      ['undo', 'human:alex'],
      ['review', 'human:sam'],
    ]);
  } finally {
    store.close();
  }
  // Opening it again does not try to add the column twice.
  new Store(stateDir).close();
});

test('events latest=1 gives the newest events, oldest first', async () => {
  const { Store } = await import('../src/store.js');
  const { eventsAfter } = await import('../src/server/queries.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-events-'));
  const s = new Store(dir);
  for (let i = 0; i < 10; i++) s.setIntent('a', `step ${i}`);
  const paged = eventsAfter(s, 0, 3);
  const latest = eventsAfter(s, 0, 3, { latest: true });
  assert.deepEqual(paged.map((e) => e.detail), ['step 0', 'step 1', 'step 2']);
  assert.deepEqual(latest.map((e) => e.detail), ['step 7', 'step 8', 'step 9']);
  s.close();
});
