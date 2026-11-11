// Regression tests for docs/security-review-2026-11-11.md. Each test names the
// finding it pins down. Real temp git repos, real HTTP, no mocks except where a
// test must prove a path was never touched.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startServer } from '../src/server/index.js';
import { resolvePath } from '../src/server/paths.js';
import { MAX_STREAMS } from '../src/server/stream.js';
import { MAX_SESSIONS } from '../src/server/mcp-http.js';
import { runHook } from '../src/hook.js';
import { leavesRoot } from '../src/undo.js';
import { term } from '../src/cli.js';
import { createBilling } from '../src/hub/billing.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'grapim.js');
const WIN = process.platform === 'win32';
const run = promisify(execFile);
const sha1 = (s) => createHash('sha1').update(s).digest('hex');

function repo(files = { 'app.js': 'one\ntwo\n' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-sec-'));
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

const outsideDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-sec-out-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
};

// A link to a folder that needs no privileges on Windows (a junction).
const linkDir = (target, link) => fs.symlinkSync(target, link, WIN ? 'junction' : 'dir');

async function serve(dir, opts = {}) {
  return startServer({ cwd: dir, port: 0, env: {}, uiDir: path.join(dir, 'no-ui'), ...opts });
}

function request(s, method, rawPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, method, path: rawPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Opens /api/stream and resolves with the status once headers arrive; the socket stays open.
function openStream(s, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/stream', headers, agent: false }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

function mcp(s, headers = {}) {
  let session = null;
  let id = 1;
  const send = async (method, params) => {
    const h = { 'Content-Type': 'application/json', ...headers, ...(session ? { 'Mcp-Session-Id': session } : {}) };
    const r = await request(s, 'POST', '/mcp', { headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) });
    if (method === 'initialize') session = r.headers['mcp-session-id'];
    return r;
  };
  const call = async (name, args) => (await send('tools/call', { name, arguments: args })).json().result;
  return { send, call };
}

// ---- H1: MCP over HTTP core tools ----

test('H1: claim_files, release_files and who_wrote over HTTP cannot read .git or follow a link out of the repo', async () => {
  const dir = repo();
  const out = outsideDir({ 'secret.txt': 'TOP SECRET\n' });
  linkDir(out, path.join(dir, 'escape'));
  const config = fs.readFileSync(path.join(dir, '.git', 'config'));
  const s = await serve(dir);
  try {
    const c = mcp(s);
    await c.send('initialize', { clientInfo: { name: 'probe' } });
    for (const [tool, args] of [
      ['who_wrote', { path: '.git/config' }],
      ['who_wrote', { path: 'escape/secret.txt' }],
      ['who_wrote', { path: path.join(dir, 'escape', 'secret.txt') }],
      ['claim_files', { paths: ['.git/config'] }],
      ['claim_files', { paths: ['escape/secret.txt'] }],
      ['claim_files', { paths: ['app.js', '.GIT/config'] }],
      ['release_files', { paths: ['.git/config'] }],
    ]) {
      const r = await c.call(tool, args);
      assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)} must be refused: ${JSON.stringify(r)}`);
      assert.doesNotMatch(r.content[0].text, /TOP SECRET|repositoryformatversion/);
    }
    // Nothing was snapshotted into the blob store, so the API cannot serve it either.
    for (const sha of [sha1(config), sha1('TOP SECRET\n')]) {
      assert.equal((await request(s, 'GET', `/api/files/version?sha=${sha}`)).status, 404);
    }
    // A normal file still works.
    assert.match((await c.call('claim_files', { paths: ['app.js'] })).content[0].text, /^Claimed: app\.js/);
    assert.match((await c.call('who_wrote', { path: 'app.js' })).content[0].text, /app\.js/);
  } finally {
    await s.close();
  }
});

// ---- M3: browser reads from another site ----

test('M3: cross-site reads are refused (SSE, no-cors fetch, CORS fetch); a plain link and same-origin reads still work', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    const crossSse = await openStream(s, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'empty' });
    crossSse.close();
    assert.equal(crossSse.status, 403);
    const corsSse = await openStream(s, { Origin: 'http://evil.example', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' });
    corsSse.close();
    assert.equal(corsSse.status, 403);
    for (const headers of [
      { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' },
      { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' },
      { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' },
      { Origin: 'http://evil.example' },
      { Origin: 'null' },
    ]) {
      assert.equal((await request(s, 'GET', '/fs/app.js', { headers })).status, 403, JSON.stringify(headers));
    }
    // A link from another site opens the desk; the page itself loads same-origin.
    const nav = await request(s, 'GET', '/', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } });
    assert.notEqual(nav.status, 403);
    const same = await request(s, 'GET', '/fs/app.js', { headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' } });
    assert.equal(same.status, 200);
    assert.equal(same.headers['cross-origin-resource-policy'], 'same-origin');
    const sameSse = await openStream(s, { 'Sec-Fetch-Site': 'same-origin' });
    sameSse.close();
    assert.equal(sameSse.status, 200);
    // Agents (no browser headers) are unaffected.
    assert.equal((await request(s, 'GET', '/fs/app.js')).status, 200);
  } finally {
    await s.close();
  }
});

test('CSRF (regression): no-cors text/plain POST, form POST, PUT and DELETE from another origin change nothing', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    const before = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
    const attempts = [
      ['POST', '/api/runs/x/undo', { Origin: 'http://evil.example', 'Content-Type': 'text/plain' }, '{"apply":true}'],
      ['POST', '/api/runs/x/review', { Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' }, 'status=approved'],
      ['POST', '/api/runs/x/branch', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }, ''],
      ['POST', '/fs/_release', { Origin: 'http://localhost:3000', 'X-Grapim-Agent': 'a' }, ''],
      ['PUT', '/fs/app.js', { Origin: 'http://evil.example', 'X-Grapim-Agent': 'a' }, 'pwned'],
      ['PUT', '/fs/new.js', { 'Sec-Fetch-Site': 'same-site', 'X-Grapim-Agent': 'a' }, 'pwned'],
      ['DELETE', '/fs/app.js', { Origin: `http://127.0.0.1:${s.port + 1}`, 'X-Grapim-Agent': 'a' }, undefined],
      ['POST', '/mcp', { Origin: 'http://evil.example', 'Content-Type': 'text/plain' }, '{"jsonrpc":"2.0","id":1,"method":"initialize"}'],
    ];
    for (const [method, p, headers, body] of attempts) {
      const r = await request(s, method, p, { headers, body });
      assert.equal(r.status, 403, `${method} ${p} ${JSON.stringify(headers)}: ${r.text}`);
    }
    assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), before);
    assert.equal(fs.existsSync(path.join(dir, 'new.js')), false);
    // DNS rebinding: a foreign Host is refused before anything else.
    assert.equal((await request(s, 'PUT', '/fs/app.js', { headers: { Host: 'rebind.evil.example', 'X-Grapim-Agent': 'a' }, body: 'x' })).status, 403);
  } finally {
    await s.close();
  }
});

test('M3: at most MAX_STREAMS live streams; the next gets 503 and a closed one frees a slot', async () => {
  const dir = repo();
  const s = await serve(dir);
  const open = [];
  try {
    for (let i = 0; i < MAX_STREAMS; i++) open.push(await openStream(s));
    assert.ok(open.every((o) => o.status === 200));
    const extra = await openStream(s);
    extra.close();
    assert.equal(extra.status, 503);
    open.pop().close();
    await new Promise((r) => setTimeout(r, 100));
    const again = await openStream(s);
    open.push(again);
    assert.equal(again.status, 200);
  } finally {
    open.forEach((o) => o.close());
    await s.close();
  }
});

test('MCP sessions are capped at MAX_SESSIONS; ending one frees a slot', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'flood' } } });
    const ids = [];
    for (let i = 0; i < MAX_SESSIONS; i += 50) {
      const batch = await Promise.all(Array.from({ length: Math.min(50, MAX_SESSIONS - i) }, () => request(s, 'POST', '/mcp', { headers: { 'Content-Type': 'application/json' }, body })));
      for (const r of batch) {
        assert.equal(r.status, 200);
        ids.push(r.headers['mcp-session-id']);
      }
    }
    assert.equal((await request(s, 'POST', '/mcp', { headers: { 'Content-Type': 'application/json' }, body })).status, 503);
    assert.equal((await request(s, 'DELETE', '/mcp', { headers: { 'Mcp-Session-Id': ids[0] } })).status, 204);
    assert.equal((await request(s, 'POST', '/mcp', { headers: { 'Content-Type': 'application/json' }, body })).status, 200);
  } finally {
    await s.close();
  }
});

// ---- M1: undo writing through a link ----

test('M1: undo does not write or delete through a folder that became a link out of the worktree', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    const put = await request(s, 'PUT', '/fs/sub/x.txt', { headers: { 'X-Grapim-Agent': 'linker' }, body: 'v1\n' });
    assert.equal(put.status, 200, put.text);
    // The folder is swapped for a junction to a folder outside, holding the same bytes.
    const out = outsideDir({ 'x.txt': 'v1\n' });
    fs.rmSync(path.join(dir, 'sub'), { recursive: true });
    linkDir(out, path.join(dir, 'sub'));
    assert.equal(leavesRoot(dir, path.join(dir, 'sub', 'x.txt')), true);
    assert.equal(leavesRoot(dir, path.join(dir, 'app.js')), false);
    assert.equal(leavesRoot(dir, path.join(dir, 'new', 'deep', 'y.txt')), false);

    const r = await request(s, 'POST', '/api/runs/linker/undo', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apply: true }) });
    assert.equal(r.status, 200, r.text);
    const f = r.json().files.find((x) => x.path === 'sub/x.txt');
    assert.equal(f.action, 'skipped', JSON.stringify(f));
    assert.match(f.reason, /link/);
    assert.equal(fs.readFileSync(path.join(out, 'x.txt'), 'utf8'), 'v1\n', 'the file outside the repo is untouched');
  } finally {
    await s.close();
  }
});

test('M1: undo leaves no temp files and writes through a fresh temp name', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    assert.equal((await request(s, 'PUT', '/fs/app.js', { headers: { 'X-Grapim-Agent': 'tmp' }, body: 'changed\n' })).status, 200);
    const r = await request(s, 'POST', '/api/runs/tmp/undo', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apply: true }) });
    assert.equal(r.status, 200, r.text);
    assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), 'one\ntwo\n');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  } finally {
    await s.close();
  }
});

// ---- Command injection: option-looking paths and labels reach git safely ----

test('git (regression): files named like options and a hostile agent label go on a branch as plain names', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    const agent = { 'X-Grapim-Agent': '--upload-pack=touch PWNED; -c core.pager=x' };
    for (const name of ['--output=pwn.txt', '-x', '--', 'a b;$(touch PWNED2)']) {
      const r = await request(s, 'PUT', `/fs/${encodeURIComponent(name)}`, { headers: agent, body: `${name}\n` });
      assert.equal(r.status, 200, `${name}: ${r.text}`);
    }
    const runs = (await request(s, 'GET', '/api/runs')).json();
    const b = await request(s, 'POST', `/api/runs/${encodeURIComponent(runs[0].run)}/branch`, { headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(b.status, 200, b.text);
    const { branch, commit } = b.json();
    assert.match(branch, /^grapim\/[a-z0-9_-]+$/);
    const listed = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', commit], { cwd: dir }).toString().split('\0');
    for (const name of ['--output=pwn.txt', '-x', '--', 'a b;$(touch PWNED2)']) assert.ok(listed.includes(name), `${name} in ${listed}`);
    for (const stray of ['pwn.txt', 'PWNED', 'PWNED2']) {
      assert.equal(fs.existsSync(path.join(dir, stray)), false, stray);
      assert.equal(fs.existsSync(path.join(process.cwd(), stray)), false, stray);
    }
  } finally {
    await s.close();
  }
});

// ---- Paths ----

test('paths: Windows device names in all their spellings, ADS and 8.3 names of .git are refused', { skip: !WIN && 'Windows names' }, async () => {
  const dir = repo();
  const ws = { root: dir, stateDir: path.join(dir, '.git', 'grapim') };
  for (const p of ['nul', 'NUL.txt', 'nul .txt', 'COM¹', 'lpt³.log', 'CONIN$', 'conout$', 'a.txt:stream', 'a.txt::$DATA', 'GIT~1/config', '.git./config']) {
    assert.throws(() => resolvePath(ws, p), /Refused path/, p);
  }
  assert.equal(resolvePath(ws, 'console.js').rel, 'console.js');
  assert.equal(resolvePath(ws, 'com10.txt').rel, 'com10.txt');
});

test('/fs: a broken link in the way is a 409 without absolute paths; reads of non-files are refused', async () => {
  const dir = repo();
  const gone = path.join(outsideDir(), 'missing');
  linkDir(gone, path.join(dir, 'dangling'));
  const s = await serve(dir);
  try {
    const r = await request(s, 'PUT', '/fs/dangling/x.txt', { headers: { 'X-Grapim-Agent': 'a' }, body: 'x' });
    assert.ok([400, 409].includes(r.status), r.text);
    assert.ok(!r.text.includes(JSON.stringify(fs.realpathSync(os.tmpdir())).slice(1, -1)) && !r.text.includes(JSON.stringify(os.tmpdir()).slice(1, -1)), r.text);
    assert.equal(fs.existsSync(gone), false, 'the link target was not created');
    if (!WIN) {
      execFileSync('mkfifo', [path.join(dir, 'pipe')]);
      const p = await request(s, 'GET', '/fs/pipe');
      assert.equal(p.status, 400, p.text);
    }
  } finally {
    await s.close();
  }
});

test('/fs serves agent bytes inertly: octet-stream and nosniff, so an agent-written page cannot run in the desk origin', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    const html = '<script>fetch("/api/runs/x/undo",{method:"POST"})</script>';
    assert.equal((await request(s, 'PUT', '/fs/evil.html', { headers: { 'X-Grapim-Agent': 'a' }, body: html })).status, 200);
    const r = await request(s, 'GET', '/fs/evil.html');
    assert.equal(r.headers['content-type'], 'application/octet-stream');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    const v = await request(s, 'GET', `/api/files/version?sha=${sha1(html)}`);
    assert.match(v.headers['content-type'], /^text\/plain/);
  } finally {
    await s.close();
  }
});

// ---- Token mode ----

test('token mode: every route with repo data needs the token (/api, /fs, /mcp); the desk\'s static files do not', async () => {
  const dir = repo();
  const token = 'tok-0123456789abcdef-0123456789';
  const ui = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-sec-ui-'));
  fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>desk</title>');
  fs.writeFileSync(path.join(ui, 'app.js'), 'console.log(1)');
  const s = await serve(dir, { token, uiDir: ui });
  try {
    for (const [m, p] of [['GET', '/fs/app.js'], ['GET', '/fs/'], ['POST', '/mcp'], ['GET', '/api/stream'], ['GET', '/api/overview'], ['GET', '/api/overview?token=x'], ['PUT', '/fs/app.js'], ['POST', '/api/files/restore'], ['POST', '/']]) {
      const r = await request(s, m, p, { headers: { 'X-Grapim-Agent': 'a', Authorization: 'Bearer tok-0123456789abcdef-012345678X' }, body: m === 'GET' ? undefined : '{}' });
      assert.equal(r.status, 401, `${m} ${p}`);
      assert.ok(!r.text.includes(token));
    }
    // The page loads first and then sends the token itself (from ?token=, kept in sessionStorage).
    for (const p of ['/', '/?token=whatever', '/app.js']) assert.equal((await request(s, 'GET', p)).status, 200, p);
    assert.equal((await request(s, 'GET', '/missing.js')).status, 404);
    assert.equal((await request(s, 'GET', '/fs/app.js', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  } finally {
    await s.close();
  }
});

test('M6: on loopback, a GRAPIM_TOKEN in the environment is required too', async () => {
  const dir = repo();
  const token = 'loopback-token-0123456789abcdef';
  await assert.rejects(serve(dir, { env: { GRAPIM_TOKEN: 'short' } }), /too short/);
  const s = await serve(dir, { env: { GRAPIM_TOKEN: token } });
  try {
    assert.equal(s.token, token);
    const no = await request(s, 'GET', '/api/overview');
    assert.equal(no.status, 401);
    assert.equal(no.json().error.code, 'unauthorized');
    assert.equal((await request(s, 'GET', '/api/overview', { headers: { Authorization: 'Bearer nope-nope-nope-nope' } })).status, 401);
    assert.equal((await request(s, 'GET', '/fs/app.js')).status, 401);
    assert.equal((await request(s, 'GET', '/api/overview', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await request(s, 'GET', '/fs/app.js', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  } finally {
    await s.close();
  }
  // Without the variable, loopback stays open as before.
  const open = await serve(dir, { env: {} });
  try {
    assert.equal(open.token, null);
    assert.equal((await request(open, 'GET', '/api/overview')).status, 200);
  } finally {
    await open.close();
  }
});

// ---- M7: files that run code by themselves ----

const SENSITIVE = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/settings.team.json',
  '.Claude/Settings.Local.JSON',
  'pkg/.claude/settings.json',
  '.vscode/tasks.json',
  '.envrc',
  'web/.envrc',
  '.git/hooks/pre-commit',
  '.git/config',
  '.GIT/HEAD',
];

test('M7: /fs and MCP refuse writes to settings, .git, tasks.json and .envrc with 403 forbidden', async () => {
  const dir = repo({ 'app.js': 'one\ntwo\n', '.envrc': 'export A=1\n', '.claude/settings.local.json': '{}\n', '.claude/notes.md': 'x\n' });
  const s = await serve(dir);
  try {
    for (const p of SENSITIVE) {
      const r = await request(s, 'PUT', `/fs/${p}`, { headers: { 'X-Grapim-Agent': 'mallory' }, body: 'pwned\n' });
      assert.equal(r.status, 403, `PUT ${p} -> ${r.status} ${r.text}`);
      assert.equal(r.json().error.code, 'forbidden');
      assert.match(r.json().error.message, /Refused to write/);
    }
    assert.equal(fs.readFileSync(path.join(dir, '.envrc'), 'utf8'), 'export A=1\n');
    assert.equal(fs.existsSync(path.join(dir, '.vscode')), false);
    assert.equal(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'), '{}\n');
    for (const p of ['.envrc', '.claude/settings.local.json']) {
      const r = await request(s, 'DELETE', `/fs/${p}`, { headers: { 'X-Grapim-Agent': 'mallory' } });
      assert.equal(r.status, 403, `DELETE ${p}`);
      assert.ok(fs.existsSync(path.join(dir, ...p.split('/'))));
    }
    // A link to .claude under another name is caught by its real path.
    linkDir(path.join(dir, '.claude'), path.join(dir, 'cfg'));
    assert.equal((await request(s, 'PUT', '/fs/cfg/settings.local.json', { headers: { 'X-Grapim-Agent': 'mallory' }, body: 'pwned\n' })).status, 403);
    assert.equal(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'), '{}\n');
    // The same refusal over MCP, as a tool error.
    const c = mcp(s);
    await c.send('initialize', { clientInfo: { name: 'probe' } });
    for (const p of ['.claude/settings.local.json', '.vscode/tasks.json', '.envrc', '.git/config']) {
      const r = await c.call('write_file', { path: p, content: 'pwned\n' });
      assert.equal(r.isError, true, `write_file ${p}`);
      assert.match(r.content[0].text, /Refused to write/);
      assert.equal((await c.call('delete_file', { path: p })).isError, true, `delete_file ${p}`);
    }
    assert.equal(fs.readFileSync(path.join(dir, '.envrc'), 'utf8'), 'export A=1\n');
    // Ordinary files, including others under .claude and .vscode, are fine.
    for (const p of ['app.js', '.claude/notes.md', '.vscode/settings.json', 'envrc.txt']) {
      assert.equal((await request(s, 'PUT', `/fs/${p}`, { headers: { 'X-Grapim-Agent': 'ok' }, body: 'fine\n' })).status, 200, p);
    }
    assert.ok(!(await request(s, 'GET', '/api/runs')).json().some((r) => r.run === 'http:mallory'), 'nothing was recorded for the refused writes');
  } finally {
    await s.close();
  }
});

test('M7: GRAPIM_ALLOW_SENSITIVE_WRITES=1 allows them, except .git; restore over HTTP follows the same rule', async () => {
  const dir = repo({ 'app.js': 'one\n', '.envrc': 'export A=1\n' });
  const s = await serve(dir, { env: { GRAPIM_ALLOW_SENSITIVE_WRITES: '1' } });
  try {
    for (const p of ['.claude/settings.local.json', '.vscode/tasks.json', '.envrc']) {
      const r = await request(s, 'PUT', `/fs/${p}`, { headers: { 'X-Grapim-Agent': 'trusted' }, body: '{"ok":true}\n' });
      assert.equal(r.status, 200, `${p}: ${r.text}`);
      assert.equal(fs.readFileSync(path.join(dir, ...p.split('/')), 'utf8'), '{"ok":true}\n');
    }
    assert.equal((await request(s, 'PUT', '/fs/.git/config', { headers: { 'X-Grapim-Agent': 'trusted' }, body: 'x' })).status, 403);
    // The same agent over MCP (it still holds .envrc from its PUT).
    const c = mcp(s, { 'X-Grapim-Agent': 'trusted' });
    await c.send('initialize', { clientInfo: { name: 'trusted' } });
    const w = await c.call('write_file', { path: '.envrc', content: 'export B=2\n' });
    assert.ok(!w.isError, JSON.stringify(w));
  } finally {
    await s.close();
  }
  // Without the override, restoring .envrc to its recorded version is refused too.
  const strict = await serve(dir);
  try {
    const [first] = (await request(strict, 'GET', '/api/files/history?path=.envrc')).json();
    const r = await request(strict, 'POST', '/api/files/restore', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '.envrc', sha: first.before_sha }) });
    assert.equal(r.status, 403, r.text);
    assert.equal(fs.readFileSync(path.join(dir, '.envrc'), 'utf8'), 'export B=2\n');
  } finally {
    await strict.close();
  }
});

// ---- M2: the hook and network paths ----

test('M2: the hook never touches a \\\\host\\share path from tool_input', { skip: !WIN && 'UNC paths are Windows only' }, () => {
  const dir = repo();
  const touched = [];
  const spies = ['existsSync', 'statSync', 'mkdirSync', 'readFileSync', 'realpathSync'].map((name) =>
    mock.method(fs, name, function (p, ...rest) {
      if (typeof p === 'string' && /^[\\/]{2}/.test(p)) touched.push(`${name} ${p}`);
      return this[name].mock.original.call(this, p, ...rest);
    }),
  );
  try {
    for (const target of ['\\\\attacker.invalid\\share\\x.txt', '//attacker.invalid/share/x.txt', '\\\\attacker.invalid@SSL\\DavWWWRoot\\x.txt']) {
      for (const ev of ['PreToolUse', 'PostToolUse']) {
        const r = runHook({ hook_event_name: ev, session_id: 's1', cwd: dir, tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: target } });
        assert.equal(r.code, 0);
      }
    }
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
  assert.deepEqual(touched, []);
});

// ---- M4: terminal escapes ----

test('M4: agent text cannot put escape sequences on the terminal (status, log, hook output)', async () => {
  assert.equal(term('a\x1b]52;c;ZXZpbA==\x07b\x1b[2Jc\u009b31md\r\ne\rf\tg'), 'a�]52;c;ZXZpbA==�b�[2Jc�31md\r\ne�f\tg');
  const dir = repo();
  const env = { ...process.env, GRAPIM_AGENT: 'evil' };
  await run(process.execPath, [BIN, 'claim', 'app.js', '--intent', 'fix \x1b]52;c;cm0gLXJmIH4=\x07 bug \x1b[8m hidden'], { cwd: dir, env });
  for (const cmd of [['status'], ['log']]) {
    const { stdout } = await run(process.execPath, [BIN, ...cmd], { cwd: dir, env: { ...process.env, GRAPIM_AGENT: 'me' } });
    assert.match(stdout, /fix/);
    assert.ok(!stdout.includes('\x1b'), `${cmd}: ${JSON.stringify(stdout)}`);
  }
});

// ---- L6: racing first open ----

test('L6: many processes opening a new state file at the same moment all succeed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-sec-race-'));
  const store = new URL('../src/store.js', import.meta.url).href;
  const code = `const { Store } = await import(${JSON.stringify(store)}); const s = new Store(process.argv[1]); s.touch('a' + process.pid); s.close();`;
  for (let round = 0; round < 3; round++) {
    const state = path.join(dir, `state-${round}`);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => run(process.execPath, ['--input-type=module', '-e', code, state])));
    for (const r of results) assert.equal(r.status, 'fulfilled', r.reason?.stderr);
  }
});

// ---- Billing ----

test('billing: setPlan gets the Stripe event id so a replayed or retried delivery can be skipped', async () => {
  const secret = 'whsec_sec_test';
  const now = Date.now();
  const t = Math.floor(now / 1000);
  const body = JSON.stringify({ id: 'evt_42', created: t, type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active', customer: 'cus_1', metadata: { team_id: 'team_9' }, items: { data: [{ quantity: 3 }] } } } });
  const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const calls = [];
  const billing = createBilling({ env: { STRIPE_WEBHOOK_SECRET: secret }, fetch: () => assert.fail('no Stripe calls') });
  const r = await billing.handleWebhook(Buffer.from(body), `t=${t},v1=${sig}`, { setPlan: async (...a) => calls.push(a), now });
  assert.equal(r.handled, true);
  assert.deepEqual(calls[0][2], { eventId: 'evt_42', type: 'customer.subscription.updated' });
  // A tampered body or an old signature never reaches setPlan.
  await assert.rejects(billing.handleWebhook(Buffer.from(body.replace('team_9', 'team_1')), `t=${t},v1=${sig}`, { setPlan: () => assert.fail(), now }), /signature/);
  await assert.rejects(billing.handleWebhook(Buffer.from(body), `t=${t},v1=${sig}`, { setPlan: () => assert.fail(), now: now + 6 * 60 * 1000 }), /tolerance/);
});
