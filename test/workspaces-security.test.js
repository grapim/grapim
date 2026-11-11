// Cloud workspaces, adversarially (docs/security-review-workspaces-2026-11-11.md).
// Each test pins one finding of that review: remove its fix and it fails.
// An in-process hub with GitHub mocked, as in test/workspaces.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createFolderSync, safeRel } from '../src/folder-sync.js';
import { createHub } from '../src/hub/server.js';
import { createWorkspaceMount } from '../src/hub/workspace-mount.js';
import { createComputePool } from '../src/hub/compute-pool.js';
import { blame, inTree } from '../src/attribution.js';
import { lineCounts } from '../src/diff.js';
import { fileKey } from '../src/workspace.js';
import { diffJson } from '../src/server/json-diff.js';
import { listRuns, runDetail } from '../src/server/runs.js';
import { isGitAlias, sensitiveReason } from '../src/server/paths.js';

const ORIGIN = 'http://localhost:7999';
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeGitHub() {
  const codes = new Map();
  const fetch = async (url, init = {}) => {
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://github.com/login/oauth/access_token') {
      const { code } = JSON.parse(init.body);
      return codes.has(code) ? reply(200, { access_token: `gho_${code}` }) : reply(200, { error: 'bad_verification_code' });
    }
    if (url === 'https://api.github.com/user') {
      const u = codes.get(String(init.headers?.Authorization || '').replace('Bearer gho_', ''));
      return u ? reply(200, u) : reply(401, {});
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, user: (code, profile) => codes.set(code, profile) };
}

function fakeStorage() {
  const map = new Map();
  return {
    map,
    put: async (k, buf) => void map.set(k, Buffer.from(buf)),
    get: async (k) => map.get(k) ?? null,
    has: async (k) => map.has(k),
    delete: async (k) => void map.delete(k),
    list: async (prefix = '') => [...map.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
}

async function startHub({ env = {}, storage = null, compute = undefined } = {}) {
  const dir = tmp('grapim-wssec-hub-');
  const gh = fakeGitHub();
  const hub = await createHub({
    env: { HUB_URL: ORIGIN, HUB_SECRET: 'test-secret-that-is-long-enough-0123456789', HUB_DATA: dir, GITHUB_CLIENT_ID: 'gh-client', GITHUB_CLIENT_SECRET: 'gh-secret', ...env },
    fetch: gh.fetch,
    billing: null,
    storage,
    log: () => {},
    ...(compute ? { compute } : {}),
  });
  const addr = await hub.listen(0, '127.0.0.1');
  return { hub, base: `http://127.0.0.1:${addr.port}`, gh, dir, close: () => hub.close() };
}

class Browser {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }
  async req(p, { method = 'GET', form = null } = {}) {
    const h = {};
    if (this.jar.size) h.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (method !== 'GET') h.Origin = ORIGIN;
    if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(this.base + p, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (/Max-Age=0/i.test(c)) this.jar.delete(pair.slice(0, i));
      else this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  }
  async post(p, form = {}) {
    const csrf = JSON.parse((await this.req('/hub/api/me')).text).csrf;
    return this.req(p, { method: 'POST', form: { _csrf: csrf, ...form } });
  }
}

let nextId = 9000;
async function signIn(h, login) {
  const id = nextId++;
  h.gh.user(`code-${id}`, { id, login, name: login, avatar_url: null });
  const b = new Browser(h.base);
  const start = await b.req('/hub/auth/github');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  assert.equal((await b.req(`/hub/auth/callback?code=code-${id}&state=${state}`)).status, 303);
  return b;
}

async function setup(h, login, name = 'ws') {
  const b = await signIn(h, login);
  const r = await b.post('/hub/teams', { name: `${login} team` });
  const team = r.headers.get('location').match(/\/hub\/teams\/([^/]+)\/settings/)[1];
  const c = await b.post(`/hub/teams/${team}/workspaces`, { name });
  assert.equal(c.status, 303, c.text);
  const id = c.headers.get('location').match(/\/workspaces\/([^/]+)$/)[1];
  const ws = { id, name, team, base: `/w/${team}/${name}/`, dir: path.join(h.dir, 'workspaces', team, id) };
  const token = async (tname, scope = 'write') => {
    const t = await b.post(`/hub/teams/${team}/workspaces/${id}/tokens`, { name: tname, scope });
    assert.equal(t.status, 200, t.text);
    return t.text.match(/value="(gws_[A-Za-z0-9_-]+)"/)[1];
  };
  return { b, team, ws, token };
}

async function agent(base, token, p, { method = 'GET', body = undefined, headers = {} } = {}) {
  const h = { 'X-Grapim-Agent': 'a', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(base + p, { method, headers: h, body, redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
}

const enc = (rel) => rel.split('/').map(encodeURIComponent).join('/');
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test' }, capabilities: {} } };
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
async function mcp(base, token, wsBase, message, session = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) headers['Mcp-Session-Id'] = session;
  const r = await agent(base, token, `${wsBase}mcp`, { method: 'POST', body: JSON.stringify(message), headers });
  return { ...r, session: r.headers.get('mcp-session-id') };
}

// A second mount over the same hub with small limits, on its own port: the
// limits of the real one are too big to reach in a test.
async function smallMount(h, opts) {
  const m = createWorkspaceMount(h.hub, opts);
  const srv = http.createServer((req, res) => {
    const ctx = { req, res, ip: '127.0.0.1', cookies: {}, json: true };
    m.handle(ctx, req.url).catch((err) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(err.status ?? 500, { 'Content-Type': 'application/json', ...(err.extra?.retryAfter ? { 'Retry-After': String(err.extra.retryAfter) } : {}) });
      res.end(JSON.stringify({ error: { code: err.code, message: err.message } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    m,
    base: `http://127.0.0.1:${srv.address().port}`,
    close: async () => {
      srv.closeAllConnections();
      await new Promise((r) => srv.close(r));
      await m.closeAll();
    },
  };
}

// ---------------------------------------------------------------- H3: names that are .git elsewhere

test('names that are .git on Windows or macOS (git~1, ".git.", HFS+ ignorables) and a bare repo HEAD are refused on every platform', async (t) => {
  for (const s of ['.git', '.GIT', '.git.', '.git ', '.git. .', 'git~1', 'GIT~12', '.git::$INDEX_ALLOCATION', '.g‌it', '﻿.git']) assert.ok(isGitAlias(s), s);
  for (const s of ['.github', 'git', '.gitignore', 'digit~1', 'git~', '.git-hooks']) assert.ok(!isGitAlias(s), s);
  assert.match(sensitiveReason('HEAD'), /repository/);
  assert.match(sensitiveReason('vendor/lib/HEAD'), /repository/);
  assert.equal(sensitiveReason('README.md'), null);

  const h = await startHub();
  t.after(h.close);
  const { ws, token } = await setup(h, 'alias-alice');
  const w = await token('w');
  for (const rel of ['git~1/hooks/post-commit', '.g‌it/hooks/post-commit', 'sub/.git./config', 'HEAD', 'deep/repo/HEAD']) {
    const r = await agent(h.base, w, `${ws.base}fs/${enc(rel)}`, { method: 'PUT', body: '#!/bin/sh\nid\n' });
    assert.ok(r.status === 400 || r.status === 403, `${rel}: ${r.status} ${r.text}`);
    const m = await mcp(h.base, w, ws.base, init);
    const mw = await mcp(h.base, w, ws.base, call(2, 'write_file', { path: rel, content: 'x' }), m.session);
    assert.equal(mw.json().result?.isError, true, `${rel} over MCP: ${mw.text}`);
  }
  assert.deepEqual(
    fs.readdirSync(ws.dir).filter((n) => n !== '.git'),
    [],
    'nothing was written',
  );
});

// ---------------------------------------------------------------- H3: the sync client and a hostile workspace

test('folder sync never writes .git aliases, 8.3 short names or files that run code, whatever the workspace sends', async (t) => {
  for (const p of ['git~1/hooks/post-commit', 'CLAUDE~1/settings.json', 'GRAPIM~1/state.json', '.git./config', '.g‌it/config']) assert.equal(safeRel(p), false, p);
  for (const p of ['src/a~b.js', 'notes~1.md.bak', 'a/b.txt']) assert.equal(safeRel(p), true, p);

  // A workspace that lists poisoned paths and serves them.
  const files = {
    'ok.txt': 'fine\n',
    'objects/info': 'x',
    'git~1/hooks/post-commit': '#!/bin/sh\necho pwned\n',
    'CLAUDE~1/settings.json': '{"hooks":{}}',
    '.claude/settings.json': '{"hooks":{}}',
    '.vscode/tasks.json': '{}',
    '.envrc': 'echo pwned',
    HEAD: 'ref: refs/heads/main\n',
  };
  const fetched = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (o) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (u.pathname === '/api/files/changes') return json({ changes: [], cursor: 0 });
    if (u.pathname === '/api/files') return json({ files: Object.keys(files).map((p) => ({ path: p, type: 'file' })), truncated: false });
    if (u.pathname === '/fs/_release') return json({ released: [] });
    if (u.pathname.startsWith('/fs/')) {
      const rel = decodeURIComponent(u.pathname.slice(4));
      fetched.push(rel);
      const body = files[rel];
      if (body === undefined) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { ETag: `"${sha1(body)}"`, 'Content-Length': Buffer.byteLength(body) });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const dir = path.join(tmp('grapim-wssec-sync-'), 'folder');
  const out = [];
  const c = createFolderSync({ url: `http://127.0.0.1:${srv.address().port}/`, dir, machine: 'laptop', say: (l) => out.push(l) });
  await c.syncOnce();

  assert.equal(fs.readFileSync(path.join(dir, 'ok.txt'), 'utf8'), 'fine\n');
  assert.ok(fs.existsSync(path.join(dir, 'objects', 'info')));
  for (const rel of ['git~1', 'CLAUDE~1', '.claude', '.vscode', '.envrc', 'HEAD']) assert.equal(fs.existsSync(path.join(dir, rel)), false, `${rel} was written: ${out.join('\n')}`);
  assert.deepEqual(fetched.sort(), ['objects/info', 'ok.txt'], 'refused paths are not even downloaded');
});

// ---------------------------------------------------------------- H1: request bodies held in memory

test('uploads and MCP posts in flight are capped per caller, so one token cannot fill the hub memory', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { ws, token } = await setup(h, 'body-alice');
  const w = await token('w');
  const sm = await smallMount(h, { maxBodiesPerCaller: 2, maxBodies: 10 });
  t.after(sm.close);
  const u = new URL(sm.base);

  // Two uploads that send their headers and then stall, holding their slots.
  const stalled = [];
  for (let i = 0; i < 2; i++) {
    const req = http.request({ host: u.hostname, port: u.port, path: `${ws.base}fs/big${i}.bin`, method: 'PUT', headers: { Authorization: `Bearer ${w}`, 'X-Grapim-Agent': 'a', 'Content-Length': 10_000_000 } });
    req.on('error', () => {});
    req.write(Buffer.alloc(1000));
    stalled.push(req);
  }
  await wait(300);
  const third = await agent(sm.base, w, `${ws.base}mcp`, { method: 'POST', body: JSON.stringify(init), headers: { 'Content-Type': 'application/json' } });
  assert.equal(third.status, 429, third.text);
  // Reads are not held back.
  assert.equal((await agent(sm.base, w, `${ws.base}api/overview`)).status, 200);
  for (const r of stalled) r.destroy();
  await wait(300);
  assert.equal((await agent(sm.base, w, `${ws.base}mcp`, { method: 'POST', body: JSON.stringify(init), headers: { 'Content-Type': 'application/json' } })).status, 200);
});

// ---------------------------------------------------------------- M7: many tiny files

test('a workspace holds at most maxFiles files: empty files cost no quota, but every measure walks them', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { ws, token } = await setup(h, 'files-alice');
  const w = await token('w');
  const sm = await smallMount(h, { maxFiles: 3 });
  t.after(sm.close);
  for (let i = 0; i < 3; i++) assert.equal((await agent(sm.base, w, `${ws.base}fs/f${i}.txt`, { method: 'PUT', body: '' })).status, 200);
  await sm.m.measure({ id: ws.id, team_id: ws.team, name: ws.name });
  const r = await agent(sm.base, w, `${ws.base}fs/f3.txt`, { method: 'PUT', body: '' });
  assert.equal(r.status, 413, r.text);
  const m = await mcp(sm.base, w, ws.base, init);
  const mw = await mcp(sm.base, w, ws.base, call(2, 'write_file', { path: 'f4.txt', content: '' }), m.session);
  assert.equal(mw.status, 413, mw.text);
  // Deleting is still allowed.
  assert.equal((await agent(sm.base, w, `${ws.base}fs/f0.txt`, { method: 'DELETE' })).status, 200);
});

// ---------------------------------------------------------------- M2/M3: live streams

async function openStream(base, token, p) {
  const ac = new AbortController();
  const res = await fetch(base + p, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
  const reader = res.body.getReader();
  const ended = (async () => {
    try {
      for (;;) if ((await reader.read()).done) return true;
    } catch {
      return true;
    }
  })();
  return { status: res.status, ended, abort: () => ac.abort() };
}

test('an open workspace stream ends once its token is revoked', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { b, ws, team, token } = await setup(h, 'stream-alice');
  const r = await token('reader', 'read');
  const sm = await smallMount(h, { streamCheckMs: 100 });
  t.after(sm.close);
  const s = await openStream(sm.base, r, `${ws.base}api/stream`);
  assert.equal(s.status, 200);
  t.after(s.abort);
  const tokenId = h.hub.db.prepare('SELECT id FROM workspace_tokens WHERE name = ?').get('reader').id;
  assert.equal((await b.post(`/hub/teams/${team}/workspaces/${ws.id}/tokens/${tokenId}/revoke`)).status, 303);
  const done = await Promise.race([s.ended, wait(3000).then(() => false)]);
  assert.equal(done, true, 'the stream was closed after the revoke');
  for (let i = 0; i < 20 && (h.hub.streams.get('*') ?? 0) > 0; i++) await wait(50);
  assert.equal(h.hub.streams.get('*') ?? 0, 0, 'and uncounted');
});

test('at the engine cap, an engine held open only by streams gives way instead of locking every workspace out', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const a = await setup(h, 'pin-alice', 'pinned');
  const c = await setup(h, 'pin-carol', 'other');
  const ta = await a.token('a', 'read');
  const tc = await c.token('c', 'read');
  const sm = await smallMount(h, { maxEngines: 1 });
  t.after(sm.close);
  const s = await openStream(sm.base, ta, `${a.ws.base}api/stream`);
  t.after(s.abort);
  assert.equal(s.status, 200);
  const r = await agent(sm.base, tc, `${c.ws.base}api/overview`);
  assert.equal(r.status, 200, r.text);
  assert.equal(await Promise.race([s.ended, wait(3000).then(() => false)]), true, 'the pinned engine was closed');
});

// ---------------------------------------------------------------- H2: storage counts toward the quota

test('every version uploaded to storage counts toward the team quota', async (t) => {
  const storage = fakeStorage();
  const h = await startHub({ storage });
  t.after(h.close);
  const { ws, team, token } = await setup(h, 'store-alice');
  const w = await token('w');
  const used = () => h.hub.db.prepare('SELECT bytes FROM team_usage WHERE team_id = ?').get(team)?.bytes ?? 0;
  const before = used();
  // Over 2 MB: the ledger keeps no copy, so only storage holds the old version.
  const big = (n) => Buffer.alloc(3 * 1024 * 1024, n);
  // (Deleted in between: Windows may refuse a rename over a file its virus scanner is reading.)
  for (const n of [1, 2, 3]) {
    assert.equal((await agent(h.base, w, `${ws.base}fs/data.bin`, { method: 'PUT', body: big(n) })).status, 200);
    if (n < 3) assert.equal((await agent(h.base, w, `${ws.base}fs/data.bin`, { method: 'DELETE' })).status, 200);
  }
  await h.hub.mount.storage.flush();
  for (const n of [1, 2, 3]) assert.ok(storage.map.has(`ws/${team}/${ws.id}/blobs/${sha1(big(n))}`));
  // A file the ledger does not hash still gets a real manifest entry (it used to be "untracked", which no manifest accepts).
  const manifest = JSON.parse(storage.map.get(`ws/${team}/${ws.id}/manifest.json`).toString('utf8'));
  assert.equal(manifest.files['data.bin'], sha1(big(3)));
  await wait(1500); // the folder is measured too
  assert.ok(used() - before >= 3 * big(1).length + big(1).length * 0.9, `usage grew by ${used() - before}`);
});

// ---------------------------------------------------------------- isolation and revocation, pinned

test('an MCP session of one workspace is unknown on another, and a revoked token stops at once on a live session', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const a = await setup(h, 'mcp-alice', 'alpha');
  const c = await setup(h, 'mcp-carol', 'beta');
  const ta = await a.token('a');
  const tc = await c.token('c');
  const sa = await mcp(h.base, ta, a.ws.base, init);
  assert.equal(sa.status, 200);
  const cross = await mcp(h.base, tc, c.ws.base, call(2, 'list_runs', {}), sa.session);
  assert.equal(cross.status, 404, cross.text);
  // The session itself works, then the token is revoked: the next call is 401.
  assert.equal((await mcp(h.base, ta, a.ws.base, call(3, 'write_file', { path: 'x.md', content: 'x' }), sa.session)).status, 200);
  const id = h.hub.db.prepare('SELECT id FROM workspace_tokens WHERE name = ?').get('a').id;
  assert.equal((await a.b.post(`/hub/teams/${a.team}/workspaces/${a.ws.id}/tokens/${id}/revoke`)).status, 303);
  const after = await mcp(h.base, ta, a.ws.base, call(4, 'write_file', { path: 'y.md', content: 'y' }), sa.session);
  assert.equal(after.status, 401, after.text);
  assert.equal(fs.existsSync(path.join(a.ws.dir, 'y.md')), false);
});

// ---------------------------------------------------------------- L: hub paths in answers

test('the workspace API names its mount, never the hub folder', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { ws, token } = await setup(h, 'paths-alice');
  const w = await token('w');
  const o = await agent(h.base, w, `${ws.base}api/overview`);
  assert.equal(o.json().root, `/w/${ws.team}/${ws.name}`);
  assert.ok(o.json().worktrees.every((x) => x.root === `/w/${ws.team}/${ws.name}`));
  assert.equal((await agent(h.base, w, `${ws.base}fs/a.md`, { method: 'PUT', body: 'a\n' })).status, 200);
  const runs = (await agent(h.base, w, `${ws.base}api/runs`)).json();
  const run = (Array.isArray(runs) ? runs : runs.runs)[0].run;
  const plan = await agent(h.base, w, `${ws.base}api/runs/${encodeURIComponent(run)}/undo`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(plan.status, 200, plan.text);
  const dirs = [h.dir, h.dir.split(path.sep).join('/'), fs.realpathSync(h.dir), fs.realpathSync(h.dir).split(path.sep).join('/')];
  for (const text of [o.text, plan.text]) for (const d of dirs) assert.ok(!text.includes(d), `${d} in ${text}`);
});

// ---------------------------------------------------------------- M7: diff and blame off the event loop

// A worker for the pool tests: echoes its input after input.ms.
const SLEEP_WORKER = new URL(
  `data:text/javascript,${encodeURIComponent("import { parentPort } from 'node:worker_threads'; parentPort.on('message', ({ id, input }) => setTimeout(() => parentPort.postMessage({ id, ok: true, value: input }), input.ms)); parentPort.postMessage({ ready: true });")}`,
);

test('M7: the compute pool answers exactly what the in-place code answers: line counts, diffs, blame, in-tree states and run details', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { ws, team, token } = await setup(h, 'pool-alice');
  const w = await token('w');
  const put = async (p, body, as) => {
    const r = await agent(h.base, w, `${ws.base}fs/${p}`, { method: 'PUT', body, headers: { 'X-Grapim-Agent': as } });
    await agent(h.base, w, `${ws.base}fs/_release`, { method: 'POST', headers: { 'X-Grapim-Agent': as } }); // the next run may take the file
    return r;
  };
  // Several runs over the same files: replaced, kept, deleted and CRLF lines.
  assert.equal((await put('a.txt', 'one\ntwo\nthree\nfour\n', 'r1')).status, 200);
  assert.equal((await put('b.txt', 'x\r\ny\r\n', 'r1')).status, 200);
  assert.equal((await put('a.txt', 'one\nTWO\nthree\nfour\nfive\n', 'r2')).status, 200);
  assert.equal((await put('c.txt', 'gone soon\n', 'r2')).status, 200);
  assert.equal((await put('a.txt', 'zero\none\nTWO\nfour\nfive\n', 'r3')).status, 200);
  assert.equal((await agent(h.base, w, `${ws.base}fs/c.txt`, { method: 'DELETE', headers: { 'X-Grapim-Agent': 'r3' } })).status, 200);
  await agent(h.base, w, `${ws.base}fs/_release`, { method: 'POST', headers: { 'X-Grapim-Agent': 'r3' } });
  fs.writeFileSync(path.join(ws.dir, 'b.txt'), 'x\r\ny\r\nby hand\r\n'); // outside agents

  const engine = h.hub.mount.engineFor(h.hub.workspaces.byId(team, ws.id));
  const { store, offload } = engine.ctx;
  assert.ok(offload, 'hub workspace engines compute in the pool');
  for (const p of ['a.txt', 'b.txt', 'c.txt']) {
    const file = fileKey(engine.ws, path.join(engine.ws.root, p));
    assert.deepEqual(await offload.blame(store, engine.ws, file), blame(store, engine.ws, file), p);
  }
  assert.deepEqual([...(await offload.inTree(store))], [...inTree(store)]);
  assert.deepEqual(await offload.runs(store), listRuns(store));
  for (const r of ['r1', 'r2', 'r3']) assert.deepEqual(await offload.runDetail(store, `http:w/${r}`), runDetail(store, `http:w/${r}`), r);
  const a = Buffer.from('a\nb\nc\nd\n'.repeat(3000));
  const b = Buffer.from('a\nB\nc\nd\n'.repeat(3000));
  assert.deepEqual(await h.hub.compute.run(team, 'counts', { pairs: [[a, b], [b, null], [null, a]] }), [lineCounts(a, b), lineCounts(b, null), lineCounts(null, a)]);
  assert.deepEqual(await offload.diff(a, b), diffJson(a, b));
  // The ledger's own counts for big contents came from the pool too.
  assert.equal((await put('big.txt', a, 'r4')).status, 200);
  const r = await put('big.txt', b, 'r4');
  assert.deepEqual({ added: r.json().added, removed: r.json().removed }, lineCounts(a, b));
  assert.deepEqual({ ...store.db.prepare("SELECT added, removed FROM changes WHERE path = 'big.txt' ORDER BY id DESC LIMIT 1").get() }, lineCounts(a, b));
  // And over HTTP, the answer is the in-place one.
  const viaHttp = (await agent(h.base, w, `${ws.base}api/blame?path=a.txt`)).json();
  assert.deepEqual(viaHttp, JSON.parse(JSON.stringify(blame(store, engine.ws, fileKey(engine.ws, path.join(engine.ws.root, 'a.txt'))))));
});

test('M7: a write whose diff runs past the time budget is refused with too_large and writes nothing; the stopped worker is replaced', async (t) => {
  const h = await startHub({ compute: { budgetMs: 100 } });
  t.after(h.close);
  const { ws, token } = await setup(h, 'budget-alice');
  const w = await token('w');
  // Hundreds of milliseconds of line matching in place (review M7): one-byte lines.
  const base = Buffer.from('a\n'.repeat(1_000_000));
  const next = Buffer.from(`b\n${'a\n'.repeat(999_999)}`);
  const created = await agent(h.base, w, `${ws.base}fs/lines.txt`, { method: 'PUT', body: base });
  assert.equal(created.status, 200, created.text);
  const r = await agent(h.base, w, `${ws.base}fs/lines.txt`, { method: 'PUT', body: next });
  assert.equal(r.status, 413, r.text);
  assert.equal(r.json().error.code, 'too_large');
  assert.ok(fs.readFileSync(path.join(ws.dir, 'lines.txt')).equals(base), 'nothing was written');
  assert.ok(h.hub.compute.stats().terminated >= 1);
  // The pool keeps working, on a fresh worker.
  assert.equal((await agent(h.base, w, `${ws.base}fs/small.txt`, { method: 'PUT', body: 'a\n'.repeat(5000) })).status, 200);
  const again = await agent(h.base, w, `${ws.base}fs/small.txt`, { method: 'PUT', body: `${'a\n'.repeat(4999)}b\n` });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json().added, 1);
  // The runs list still answers when its replay does not fit in the budget.
  const runs = await agent(h.base, w, `${ws.base}api/runs`);
  assert.equal(runs.status, 200, runs.text);

  // The pool itself: past the budget, too_large, and the next job runs.
  const pool = createComputePool({ size: 1, budgetMs: 50 });
  t.after(() => pool.close());
  await assert.rejects(pool.run('t', 'counts', { pairs: [[base, next]] }), (err) => err.code === 'too_large' && err.status === 413);
  assert.deepEqual(await pool.run('t', 'counts', { pairs: [[Buffer.from('a\n'), Buffer.from('b\n')]] }), [{ added: 1, removed: 1 }]);
  assert.equal(pool.stats().terminated, 1);
});

test('M7: a heavy writer does not stall the event loop that serves every team', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { ws, token } = await setup(h, 'lag-alice');
  const w = await token('w');
  const base = Buffer.from('a\n'.repeat(500_000));
  const next = Buffer.from(`b\n${'a\n'.repeat(499_999)}`);
  let started = Date.now();
  lineCounts(base, next);
  const inPlace = Date.now() - started;
  assert.equal((await agent(h.base, w, `${ws.base}fs/lines.txt`, { method: 'PUT', body: base })).status, 200);
  // The hub runs in this process: its event loop is this one.
  let lag = 0;
  let last = Date.now();
  const tick = setInterval(() => {
    const now = Date.now();
    lag = Math.max(lag, now - last - 5);
    last = now;
  }, 5);
  started = Date.now();
  const r = await agent(h.base, w, `${ws.base}fs/lines.txt`, { method: 'PUT', body: next });
  clearInterval(tick);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual({ added: r.json().added, removed: r.json().removed }, { added: 1, removed: 1 });
  // In place, that write compared the lines twice (the ledger, then the reply).
  assert.ok(lag < Math.max(100, inPlace), `the event loop stalled ${lag} ms (in place: ${inPlace} ms per comparison)`);
});

test('M7: at most 2 jobs of one team run at once, and free workers go to the next team in turn', async (t) => {
  const pool = createComputePool({ size: 3, perTeam: 2, budgetMs: 5000, workerUrl: SLEEP_WORKER });
  t.after(() => pool.close());
  const done = [];
  const job = (team, ms, name) => pool.run(team, 'sleep', { ms }).then(() => done.push(name));
  const all = [job('A', 400, 'a1'), job('A', 400, 'a2'), job('A', 400, 'a3'), job('A', 400, 'a4'), job('B', 20, 'b1')];
  assert.deepEqual(pool.stats().running, { A: 2, B: 1 }, 'team A holds 2 of the 3 workers, never the third');
  assert.deepEqual(pool.stats().queued, { A: 2 });
  await wait(250);
  assert.deepEqual(done, ['b1'], "team B did not wait for team A's queue");
  await Promise.all(all);

  // One worker: B's one job runs right after A's current one, not after A's whole queue.
  const one = createComputePool({ size: 1, perTeam: 2, budgetMs: 5000, workerUrl: SLEEP_WORKER });
  t.after(() => one.close());
  const order = [];
  const jobs = ['a1', 'a2', 'a3'].map((n) => one.run('A', 'sleep', { ms: 30 }).then(() => order.push(n)));
  jobs.push(one.run('B', 'sleep', { ms: 30 }).then(() => order.push('b1')));
  await Promise.all(jobs);
  assert.deepEqual(order, ['a1', 'b1', 'a2', 'a3']);
  // A team with too many jobs waiting is told to come back later.
  const tiny = createComputePool({ size: 1, maxQueued: 1, budgetMs: 5000, workerUrl: SLEEP_WORKER });
  t.after(() => tiny.close());
  const first = tiny.run('A', 'sleep', { ms: 50 });
  const second = tiny.run('A', 'sleep', { ms: 50 });
  await assert.rejects(tiny.run('A', 'sleep', { ms: 50 }), (err) => err.code === 'busy');
  await Promise.all([first, second]);
});
