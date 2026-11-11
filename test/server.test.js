// `grapim serve`, spoken to over real HTTP the way the review desk, a sandboxed
// agent and an MCP client would, against real temp git repos. Hook agents are
// driven as real processes, so the server and the hooks share one state file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startServer, UI_DIR } from '../src/server/index.js';
import { diffJson } from '../src/server/json-diff.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'grapim.js');
const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
const text = (lines) => lines.map((l) => l + '\n').join('');
const run = promisify(execFile);

function repo(files = { 'app.js': text(TEN) }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-server-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  git(['add', '.']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return dir;
}

// One HTTP request with the path sent exactly as given (no normalising).
function request(s, method, rawPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, method, path: rawPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const get = (s, p, o) => request(s, 'GET', p, o);
const getJson = async (s, p) => {
  const r = await get(s, p);
  assert.equal(r.status, 200, `${p}: ${r.text}`);
  assert.match(r.headers['content-type'], /^application\/json/);
  return r.json();
};
const post = (s, p, body, headers = {}) => request(s, 'POST', p, { headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const put = (s, agent, p, body, headers = {}) => request(s, 'PUT', `/fs/${p}`, { headers: { 'X-Grapim-Agent': agent, ...headers }, body });

// A Claude Code hook call, as its own process (async, so the server keeps serving).
async function hook(input) {
  const child = spawn(process.execPath, [BIN, 'hook'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  child.stdin.end(JSON.stringify(input));
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /grapim ledger/);
}

let nextToolUse = 1;
// A Claude Code edit as Claude Code runs it: prompt, PreToolUse, the write, PostToolUse.
async function hookEdit(session, cwd, file, edits, prompt = 'tidy the file') {
  await hook({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd, prompt });
  const abs = path.join(cwd, file);
  const input = { session_id: session, cwd, tool_name: 'Edit', tool_use_id: `toolu_srv_${nextToolUse++}`, tool_input: { file_path: abs } };
  await hook({ ...input, hook_event_name: 'PreToolUse' });
  const lines = fs.readFileSync(abs, 'utf8').split('\n').slice(0, -1);
  for (const [n, t] of Object.entries(edits)) lines[n - 1] = t;
  fs.writeFileSync(abs, text(lines));
  await hook({ ...input, hook_event_name: 'PostToolUse' });
}
const endSession = (session, cwd) => hook({ hook_event_name: 'SessionEnd', session_id: session, cwd });

const withLines = (edits) => text(TEN.map((l, i) => edits[i + 1] ?? l));

// env: {} so a GRAPIM_TOKEN in the developer's shell does not change the tests.
async function serve(dir, opts = {}) {
  return startServer({ cwd: dir, port: 0, env: {}, uiDir: path.join(dir, 'no-ui-here'), ...opts });
}

function assertError(r, status, code) {
  assert.equal(r.status, status, r.text);
  const body = r.json();
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, 'string');
  assert.ok(body.error.message.length > 0);
}

test('every GET endpoint returns contract-shaped JSON', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    await hookEdit('aaaa1111', dir, 'app.js', { 1: 'A one' }, 'rename the top');
    await endSession('aaaa1111', dir);
    const w = await put(s, 'sandbox-1', 'app.js', withLines({ 1: 'A one', 9: 'S nine' }), { 'X-Grapim-Intent': 'fix the bottom' });
    assert.equal(w.status, 200, w.text);

    const o = await getJson(s, '/api/overview');
    assert.equal(o.repo, path.basename(dir));
    assert.equal(path.basename(o.root), path.basename(dir));
    assert.doesNotMatch(o.root, /\\/, 'forward slashes only');
    assert.equal(o.worktrees.length, 1);
    assert.deepEqual(Object.keys(o.worktrees[0]).sort(), ['branch', 'name', 'root']);
    assert.deepEqual(Object.keys(o.counts).sort(), ['agents', 'leases', 'runs', 'unreviewed']);
    assert.equal(o.counts.runs, 2);
    const lease = o.leases.find((l) => l.agent === 'http:sandbox-1');
    assert.deepEqual(Object.keys(lease).sort(), ['acquired_at', 'agent', 'expires_at', 'intent', 'label', 'path', 'worktree']);
    assert.equal(lease.path, 'app.js');
    assert.equal(lease.intent, 'fix the bottom');
    const agent = o.agents.find((a) => a.agent === 'http:sandbox-1');
    assert.deepEqual(Object.keys(agent).sort(), ['agent', 'files', 'intent', 'label', 'last_seen', 'worktree']);
    assert.deepEqual(agent.files, ['app.js']);

    const runs = await getJson(s, '/api/runs');
    assert.deepEqual(runs.map((r) => r.run), ['http:sandbox-1', 'claude-code:aaaa1111']);
    const keys = ['active', 'added', 'branch', 'files', 'first_ts', 'in_tree', 'intent', 'label', 'last_ts', 'removed', 'review', 'run', 'turns', 'worktree'];
    for (const r of runs) assert.deepEqual(Object.keys(r).sort(), keys);
    const [mine, hooked] = runs;
    assert.equal(mine.label, 'sandbox-1');
    assert.deepEqual([mine.files, mine.added, mine.removed, mine.turns, mine.in_tree, mine.active], [1, 1, 1, 1, 'all', true]);
    assert.equal(hooked.active, false);
    assert.ok(['pending', 'approved', 'rejected'].includes(mine.review.status));
    assert.ok(mine.branch === null || typeof mine.branch === 'string');

    const d = await getJson(s, `/api/runs/${encodeURIComponent('http:sandbox-1')}`);
    assert.equal(d.run.run, 'http:sandbox-1');
    assert.deepEqual(d.turns, [{ turn: 1, intent: 'fix the bottom', ts: d.turns[0].ts, files: ['app.js'] }]);
    const [f] = d.files;
    assert.deepEqual([f.path, f.added, f.removed, f.untracked, f.state], ['app.js', 1, 1, false, 'in_tree']);
    // Its net effect: line 9 only (line 1 was the hook agent's, before it).
    assert.deepEqual(f.diff.hunks, [
      {
        oldStart: 6, oldLines: 5, newStart: 6, newLines: 5,
        lines: [
          { t: ' ', s: 'line 6' }, { t: ' ', s: 'line 7' }, { t: ' ', s: 'line 8' },
          { t: '-', s: 'line 9' }, { t: '+', s: 'S nine' },
          { t: ' ', s: 'line 10' },
        ],
      },
    ]);
    // Prefixes work like grapim undo: the session id prefix of the hook run.
    assert.equal((await getJson(s, '/api/runs/aaaa')).run.run, 'claude-code:aaaa1111');
    assertError(await get(s, '/api/runs/nobody'), 404, 'not_found');

    const b = await getJson(s, '/api/blame?path=app.js');
    assert.deepEqual(b.lines.map((l) => [l.line, l.label, l.text]), [[1, 'claude aaaa1111', 'A one'], [9, 'sandbox-1', 'S nine']]);

    const files = await getJson(s, '/api/files?path=');
    const app = files.find((e) => e.name === 'app.js');
    assert.deepEqual(Object.keys(app).sort(), ['held_by', 'last_change', 'name', 'path', 'size', 'type']);
    assert.deepEqual([app.type, app.held_by, app.last_change.label, app.last_change.run], ['file', 'sandbox-1', 'sandbox-1', 'http:sandbox-1']);
    assert.ok(!files.some((e) => e.name === '.git'), '.git is never listed');

    const h = await getJson(s, '/api/files/history?path=app.js');
    assert.deepEqual(h.map((c) => [c.run, c.turn, c.added, c.removed]), [['claude-code:aaaa1111', 1, 1, 1], ['http:sandbox-1', 1, 1, 1]]);
    for (const c of h) assert.deepEqual(Object.keys(c).sort(), ['added', 'after_sha', 'before_sha', 'id', 'label', 'removed', 'run', 'ts', 'turn']);

    const v = await get(s, `/api/files/version?sha=${h[0].before_sha}`);
    assert.equal(v.status, 200);
    assert.match(v.headers['content-type'], /^text\/plain/);
    assert.equal(v.text, text(TEN));
    assertError(await get(s, `/api/files/version?sha=${'0'.repeat(40)}`), 404, 'not_found');
    assertError(await get(s, '/api/files/version?sha=nope'), 400, 'bad_request');

    const ev = await getJson(s, '/api/events?after=0&limit=100');
    assert.ok(ev.length > 3);
    assert.deepEqual(Object.keys(ev[0]).sort(), ['actor', 'agent', 'detail', 'id', 'kind', 'label', 'path', 'ts']);
    assert.ok(ev.some((e) => e.kind === 'edit' && e.agent === 'http:sandbox-1' && e.detail === '+1 -1'));
    const later = await getJson(s, `/api/events?after=${ev.at(-2).id}`);
    assert.deepEqual(later.map((e) => e.id), [ev.at(-1).id]);
    assert.equal((await getJson(s, '/api/events?after=0&limit=2')).length, 2);

    assertError(await get(s, '/api/nothing'), 404, 'not_found');
    assertError(await request(s, 'DELETE', '/api/runs'), 405, 'method_not_allowed');
    assertError(await get(s, '/api/blame'), 400, 'bad_request');
  } finally {
    await s.close();
  }
});

test('the SSE stream sends a tick after a hook edit', async () => {
  const dir = repo();
  const s = await serve(dir);
  const ticks = [];
  let res;
  try {
    await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: s.port, path: '/api/stream' }, (r) => {
        res = r;
        assert.match(r.headers['content-type'], /^text\/event-stream/);
        let buf = '';
        r.on('data', (c) => {
          buf += c;
          for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (/^event: tick$/m.test(frame)) ticks.push(JSON.parse(frame.match(/^data: (.*)$/m)[1]));
          }
        });
        resolve();
      }).on('error', reject);
    });
    const until = async (fn) => {
      for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(fn(), `ticks so far: ${JSON.stringify(ticks)}`);
    };
    await until(() => ticks.length >= 1);
    const first = ticks[0].last_event_id;
    await hookEdit('cccc3333', dir, 'app.js', { 2: 'C two' });
    const edit = (await getJson(s, `/api/events?after=${first}`)).find((e) => e.kind === 'edit' && e.agent === 'claude-code:cccc3333');
    assert.ok(edit, 'the hook recorded the edit');
    await until(() => ticks.at(-1).last_event_id >= edit.id);
  } finally {
    res?.destroy();
    await s.close();
  }
});

test('/fs: a PUT is claimed and recorded, and a second agent gets 409', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    const w = await put(s, 'alpha', 'src/new.js', 'export const a = 1;\n');
    assert.equal(w.status, 200, w.text);
    assert.deepEqual(w.json(), { path: 'src/new.js', sha: w.json().sha, added: 1, removed: 0 });
    assert.match(w.json().sha, /^[0-9a-f]{40}$/);
    assert.equal(fs.readFileSync(path.join(dir, 'src', 'new.js'), 'utf8'), 'export const a = 1;\n');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'src')), ['new.js'], 'no temp file is left behind');

    const g = await get(s, '/fs/src/new.js');
    assert.equal(g.status, 200);
    assert.equal(g.text, 'export const a = 1;\n');
    const listing = await getJson(s, '/fs/src/');
    assert.deepEqual(listing.map((e) => [e.name, e.type, e.held_by]), [['new.js', 'file', 'alpha']]);
    assert.deepEqual((await getJson(s, '/fs/')).map((e) => e.name), ['src', 'app.js']);

    const runs = await getJson(s, '/api/runs');
    assert.deepEqual(runs.map((r) => [r.run, r.files, r.added]), [['http:alpha', 1, 1]]);
    const b = await getJson(s, '/api/blame?path=src/new.js');
    assert.deepEqual(b.lines.map((l) => [l.label, l.turn, l.text]), [['alpha', 1, 'export const a = 1;']]);
    // The CLI reads the same ledger.
    const { stdout } = await run(process.execPath, [BIN, 'runs', '--json'], { cwd: dir });
    assert.equal(JSON.parse(stdout)[0].run, 'http:alpha');

    const no = await put(s, 'beta', 'src/new.js', 'export const b = 2;\n');
    assertError(no, 409, 'conflict');
    assert.match(no.json().error.message, /held by alpha/);
    assert.equal(fs.readFileSync(path.join(dir, 'src', 'new.js'), 'utf8'), 'export const a = 1;\n');
    assert.ok((await getJson(s, '/api/events?after=0')).some((e) => e.kind === 'blocked' && e.agent === 'http:beta'));

    assertError(await put(s, '', 'x.js', 'x'), 400, 'bad_request');
    assertError(await request(s, 'PUT', '/fs/x.js', { body: 'x' }), 400, 'bad_request');
    assertError(await get(s, '/fs/missing.js'), 404, 'not_found');
    assertError(await get(s, '/fs/src'), 400, 'bad_request');

    const rel = await request(s, 'POST', '/fs/_release', { headers: { 'X-Grapim-Agent': 'alpha' } });
    assert.equal(rel.status, 200, rel.text);
    assert.deepEqual(rel.json().released, ['src/new.js']);
    const del = await request(s, 'DELETE', '/fs/src/new.js', { headers: { 'X-Grapim-Agent': 'beta' } });
    assert.equal(del.status, 200, del.text);
    assert.deepEqual(del.json(), { path: 'src/new.js', sha: null, added: 0, removed: 1 });
    assert.equal(fs.existsSync(path.join(dir, 'src', 'new.js')), false);
  } finally {
    await s.close();
  }
});

test('undo through the API reverts an HTTP agent and keeps a hook agent\'s edit in the same file', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    assert.equal((await put(s, 'sandbox-2', 'app.js', withLines({ 1: 'S one', 2: 'S two' }))).status, 200);
    assert.equal((await request(s, 'POST', '/fs/_release', { headers: { 'X-Grapim-Agent': 'sandbox-2' } })).status, 200);
    await hookEdit('dddd4444', dir, 'app.js', { 9: 'D nine', 10: 'D ten' });
    await endSession('dddd4444', dir);
    const before = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');

    const plan = await post(s, `/api/runs/${encodeURIComponent('http:sandbox-2')}/undo`, { turn: null, apply: false });
    assert.equal(plan.status, 200, plan.text);
    assert.deepEqual({ ...plan.json(), files: plan.json().files.map((f) => [f.path, f.action, f.reason]) }, {
      applied: false, run: 'http:sandbox-2', label: 'sandbox-2', turn: null, files: [['app.js', 'revert', null]],
    });
    assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), before, 'a plan changes nothing');

    const done = await post(s, '/api/runs/sandbox-2/undo', { apply: true });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json().applied, true);
    assert.deepEqual(done.json().files.map((f) => f.action), ['revert']);
    assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), withLines({ 9: 'D nine', 10: 'D ten' }));
    const runs = Object.fromEntries((await getJson(s, '/api/runs')).map((r) => [r.run, r.in_tree]));
    assert.equal(runs['http:sandbox-2'], 'none');
    assert.equal(runs['claude-code:dddd4444'], 'all');

    assertError(await post(s, '/api/runs/nobody/undo', {}), 404, 'not_found');
    assertError(await post(s, '/api/runs/sandbox-2/undo', { turn: 'two' }), 400, 'bad_request');
    assertError(await request(s, 'POST', '/api/runs/sandbox-2/undo', { body: '{oops' }), 400, 'bad_request');
  } finally {
    await s.close();
  }
});

test('review and branch answer with the review module, stub or real', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    assert.equal((await put(s, 'sandbox-3', 'app.js', withLines({ 5: 'S five' }))).status, 200);
    const r = await post(s, '/api/runs/sandbox-3/review', { status: 'approved', note: 'looks right' });
    if (r.status === 200) assert.equal(r.json().status, 'approved');
    else assertError(r, 500, 'internal');
    assertError(await post(s, '/api/runs/sandbox-3/review', { status: 'maybe' }), 400, 'bad_request');
    assertError(await post(s, '/api/runs/nobody/review', { status: 'approved' }), 404, 'not_found');

    const b = await post(s, '/api/runs/sandbox-3/branch', {});
    if (b.status === 200) assert.match(b.json().branch, /^grapim\//);
    else assertError(b, 500, 'internal');
  } finally {
    await s.close();
  }
});

test('paths that leave the repo or reach into .git are refused', async () => {
  const dir = repo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
  const s = await serve(dir);
  // Where an escape from the repo would land: a name nothing else in the temp folder uses.
  const x = `escaped-${path.basename(dir)}`;
  try {
    const bad = [
      `/fs/../${x}`,
      `/fs/..%2f${x}`,
      `/fs/..%2F${x}`,
      `/fs/%2e%2e/${x}`,
      `/fs/%2E%2E%2F${x}`,
      `/fs/sub/../../${x}`,
      `/fs/..%5c${x}`,
      `/fs/sub%5c..%5c..%5c${x}`,
      '/fs//etc/passwd',
      '/fs/%2Fetc%2Fpasswd',
      '/fs/C:/Windows/win.ini',
      '/fs/C%3A%5CWindows%5Cwin.ini',
      `/fs/${encodeURIComponent(path.join(outside, 'secret.txt'))}`,
      '/fs/.git/config',
      '/fs/.GIT/HEAD',
      '/fs/.git/grapim/state.db',
      '/fs/%00x',
      '/fs/%zz',
    ];
    for (const p of bad) {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const r = await request(s, method, p, { headers: { 'X-Grapim-Agent': 'mallory' }, body: method === 'PUT' ? 'pwned\n' : undefined });
        // A write into .git is a 403 (security review M7); every other refusal a 400.
        const [status, code] = method !== 'GET' && /^\/fs\/\.git\//i.test(p) ? [403, 'forbidden'] : [400, 'bad_request'];
        assert.equal(r.status, status, `${method} ${p} -> ${r.status} ${r.text}`);
        assert.equal(r.json().error.code, code);
      }
    }
    for (const q of ['../x', '/etc/passwd', '.git/config', 'C:\\x']) {
      assertError(await get(s, `/api/blame?path=${encodeURIComponent(q)}`), 400, 'bad_request');
      assertError(await get(s, `/api/files?path=${encodeURIComponent(q)}`), 400, 'bad_request');
    }
    assert.equal(fs.existsSync(path.join(path.dirname(dir), x)), false);
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret\n');

    // A link inside the repo that points outside it.
    let linked = true;
    try {
      fs.symlinkSync(outside, path.join(dir, 'link'), 'junction');
    } catch {
      linked = false;
    }
    if (linked) {
      assertError(await get(s, '/fs/link/secret.txt'), 400, 'bad_request');
      assertError(await put(s, 'mallory', 'link/secret.txt', 'pwned\n'), 400, 'bad_request');
      assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret\n');
    }
    assert.ok(!(await getJson(s, '/api/runs')).length, 'nothing was recorded');
  } finally {
    await s.close();
  }
});

test('security: a non-local host needs a token; Host, token and Origin are checked', async () => {
  const dir = repo();
  await assert.rejects(startServer({ cwd: dir, host: '0.0.0.0', port: 0, env: {} }), /without a token/);
  await assert.rejects(startServer({ cwd: dir, host: '0.0.0.0', port: 0, env: { GRAPIM_TOKEN: 'short' } }), /too short/);
  const cli = await run(process.execPath, [BIN, 'serve', '--host', '0.0.0.0', '--port', '0'], { cwd: dir, env: { ...process.env, GRAPIM_TOKEN: '' } }).catch((e) => e);
  assert.equal(cli.code, 1);
  assert.match(cli.stderr, /GRAPIM_TOKEN/);

  const token = 'a-long-random-test-token-0123456789';
  const s = await serve(dir, { token });
  try {
    assertError(await get(s, '/api/overview'), 401, 'unauthorized');
    assertError(await get(s, '/api/overview', { headers: { Authorization: 'Bearer wrong-token-wrong-token' } }), 401, 'unauthorized');
    const auth = { Authorization: `Bearer ${token}` };
    assert.equal((await get(s, '/api/overview', { headers: auth })).status, 200);
    assertError(await get(s, '/api/overview', { headers: { ...auth, Host: 'evil.example:7420' } }), 403, 'forbidden');
    assert.equal((await get(s, '/api/overview', { headers: { ...auth, Host: `localhost:${s.port}` } })).status, 200);
    const cross = await post(s, '/api/runs/x/undo', {}, { ...auth, Origin: 'http://evil.example' });
    assertError(cross, 403, 'forbidden');
    assertError(await post(s, '/api/runs/x/undo', {}, { ...auth, 'Sec-Fetch-Site': 'cross-site' }), 403, 'forbidden');
    // Same origin passes the guard (and then finds no such run).
    assertError(await post(s, '/api/runs/x/undo', {}, { ...auth, Origin: `http://127.0.0.1:${s.port}` }), 404, 'not_found');
  } finally {
    await s.close();
  }
  const local = await serve(dir);
  try {
    assertError(await get(local, '/api/overview', { headers: { Host: 'rebind.attacker.example' } }), 403, 'forbidden');
    assert.equal((await get(local, '/api/overview')).status, 200);
  } finally {
    await local.close();
  }
});

// A minimal MCP client over HTTP.
function mcpClient(s, headers = {}) {
  let session = null;
  let next = 1;
  const send = async (method, params) => {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers, ...(session ? { 'Mcp-Session-Id': session } : {}) };
    const r = await request(s, 'POST', '/mcp', { headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: next++, method, params }) });
    assert.equal(r.status, 200, r.text);
    if (method === 'initialize') session = r.headers['mcp-session-id'];
    return r.json();
  };
  const call = async (name, args) => (await send('tools/call', { name, arguments: args })).result;
  return { send, call, session: () => session };
}

test('MCP over HTTP: initialize, the workspace tools, and write_file shows in list_runs', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    const a = mcpClient(s, { 'X-Grapim-Agent': 'remote-codex' });
    const init = await a.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'grapim');
    assert.match(a.session(), /^[0-9a-f-]{36}$/);
    const note = await request(s, 'POST', '/mcp', { headers: { 'Mcp-Session-Id': a.session() }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(note.status, 202);

    const names = (await a.send('tools/list', {})).result.tools.map((t) => t.name);
    for (const n of ['claim_files', 'release_files', 'who_is_editing', 'set_intent', 'recent_activity', 'list_runs', 'who_wrote', 'read_file', 'write_file', 'list_dir', 'delete_file']) {
      assert.ok(names.includes(n), `${n} in ${names}`);
    }

    const w = await a.call('write_file', { path: 'notes/plan.md', content: '# Plan\n\nship it\n', intent: 'write the plan' });
    assert.equal(w.isError, undefined, w.content[0].text);
    assert.match(w.content[0].text, /Wrote notes\/plan\.md \(\+3 -0\)/);
    assert.equal(fs.readFileSync(path.join(dir, 'notes', 'plan.md'), 'utf8'), '# Plan\n\nship it\n');
    assert.match((await a.call('list_runs', {})).content[0].text, /remote-codex .*write the plan/);
    assert.equal((await a.call('read_file', { path: 'notes/plan.md' })).content[0].text, '# Plan\n\nship it\n');
    assert.match((await a.call('list_dir', { path: 'notes' })).content[0].text, /notes\/plan\.md .*held by remote-codex/);
    assert.equal((await a.call('read_file', { path: '../outside' })).isError, true);

    // A second session without X-Grapim-Agent is its own agent, and is refused.
    const b = mcpClient(s);
    await b.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cursor', version: '1' } });
    const no = await b.call('write_file', { path: 'notes/plan.md', content: 'mine now\n' });
    assert.equal(no.isError, true);
    assert.match(no.content[0].text, /held by remote-codex/);
    const runs = await getJson(s, '/api/runs');
    assert.deepEqual(runs.map((r) => r.run), ['http:remote-codex']);

    // Without a session: a JSON-RPC error, not a crash.
    const lost = await request(s, 'POST', '/mcp', { headers: { 'Mcp-Session-Id': 'not-a-session' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(lost.status, 404);
    assert.equal(lost.json().error.code, -32001);
    assertError(await get(s, '/mcp'), 405, 'method_not_allowed');

    // Ending session a releases its files, as a stdio disconnect does.
    const end = await request(s, 'DELETE', '/mcp', { headers: { 'Mcp-Session-Id': a.session() } });
    assert.equal(end.status, 204);
    assert.equal((await b.call('write_file', { path: 'notes/plan.md', content: 'mine now\n' })).isError, undefined);
  } finally {
    await s.close();
  }
});

test('static: ui/index.html at /, content types, no traversal, a 404 page without ui/', async () => {
  const dir = repo();
  const ui = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-ui-'));
  fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>desk</title>');
  fs.writeFileSync(path.join(ui, 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(ui, '.env'), 'SECRET=1');
  const s = await serve(dir, { uiDir: ui });
  try {
    const home = await get(s, '/');
    assert.equal(home.status, 200);
    assert.match(home.headers['content-type'], /^text\/html/);
    assert.equal(home.text, '<!doctype html><title>desk</title>');
    assert.equal(home.headers['x-frame-options'], 'DENY');
    assert.match((await get(s, '/app.js')).headers['content-type'], /^text\/javascript/);
    for (const p of ['/missing.js', '/.env', '/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/..%5cpackage.json']) {
      const r = await get(s, p);
      assert.equal(r.status, 404, `${p} -> ${r.status}`);
      assert.match(r.headers['content-type'], /^text\/html/);
    }
    assert.equal((await request(s, 'HEAD', '/')).status, 200);
  } finally {
    await s.close();
  }
  const bare = await serve(dir);
  try {
    const r = await get(bare, '/');
    assert.equal(r.status, 404);
    assert.match(r.text, /not built yet/);
  } finally {
    await bare.close();
  }
  if (fs.existsSync(path.join(UI_DIR, 'index.html'))) {
    const real = await startServer({ cwd: dir, port: 0 });
    try {
      const r = await get(real, '/');
      assert.equal(r.status, 200);
      assert.ok(r.buf.equals(fs.readFileSync(path.join(UI_DIR, 'index.html'))));
    } finally {
      await real.close();
    }
  }
});

test('grapim serve starts from the CLI and prints where it listens', async () => {
  const dir = repo();
  const p = spawn(process.execPath, [BIN, 'serve', '--port', '0'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const url = await new Promise((resolve, reject) => {
      let out = '';
      p.stdout.on('data', (c) => {
        out += c;
        const m = out.match(/API\s+(http:\/\/127\.0\.0\.1:\d+)\/api\/overview/);
        if (m) resolve(m[1]);
      });
      p.on('close', (code) => reject(new Error(`serve exited ${code}: ${out}`)));
    });
    const port = Number(new URL(url).port);
    const o = await getJson({ port }, '/api/overview');
    assert.equal(o.repo, path.basename(dir));
  } finally {
    p.kill();
  }
});

test('json diff: hunks with 3 lines of context, like git', () => {
  const before = Buffer.from(text(Array.from({ length: 20 }, (_, i) => `l${i + 1}`)));
  const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
  lines[1] = 'two';
  lines.splice(15, 1);
  const d = diffJson(before, Buffer.from(text(lines)));
  assert.deepEqual([d.added, d.removed], [1, 2]);
  assert.deepEqual(d.diff.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines]), [[1, 5, 1, 5], [13, 7, 13, 6]]);
  assert.deepEqual(d.diff.hunks[0].lines.slice(0, 3), [{ t: ' ', s: 'l1' }, { t: '-', s: 'l2' }, { t: '+', s: 'two' }]);
  // A new file is one hunk from line 0.
  assert.deepEqual(diffJson(null, Buffer.from('a\nb\n')).diff.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines]), [[0, 0, 1, 2]]);
});
