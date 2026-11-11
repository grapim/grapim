// Per-token access scopes (src/scope.js) and workspace folder templates
// (src/hub/templates.js), docs/workspaces.md "Access scopes" and "Folder
// templates": the glob rules on their own, then a hub with a token limited to
// docs/** (read) and docs/drafts/** (write) on every surface a token reaches
// (/fs, /api reads, every act, MCP), an unscoped token next to it, tokens
// minted with scopes by the platform API, and templates as an approved run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowed, cleanScopes, enforce, mayContain, reader, scopeOf } from '../src/scope.js';
import { createHub } from '../src/hub/server.js';

const ORIGIN = 'http://localhost:7999';
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---------------------------------------------------------------- the rules

const scoped = (rules, access = 'write') => scopeOf({ scope: access, scopes: JSON.stringify(cleanScopes(rules, { tokenScope: access })) });

test('globs: ** any folders, * and ? inside one name, literals, and a rule covers what is under the folder it names', () => {
  const s = scoped([
    { path: 'docs/**', access: 'read' },
    { path: '*.md', access: 'read' },
    { path: '**/README.txt', access: 'read' },
    { path: 'data/2026-??.csv', access: 'read' },
    { path: 'notes', access: 'read' },
    { path: 'a/**/z.js', access: 'read' },
  ]);
  const yes = ['docs', 'docs/a.md', 'docs/x/y/z.md', 'top.md', 'README.txt', 'deep/down/README.txt', 'data/2026-01.csv', 'notes/n.md', 'notes/sub/n.md', 'a/z.js', 'a/b/c/z.js'];
  const no = ['code/x.js', 'docsx/a.md', 'sub/top.md', 'README.txt.bak', 'data/2026-1.csv', 'data/2026-001.csv', 'notesx', 'a/z.ts', 'b/a/z.js'];
  for (const p of yes) assert.equal(allowed(s, p, 'read'), true, p);
  for (const p of no) assert.equal(allowed(s, p, 'read'), false, p);
  // Paths that could step out of a rule are never matched, whatever the rule.
  for (const p of ['docs/../code/x.js', 'docs/./a.md', 'docs//a.md', 'docs\\a.md', 'docs/a\u0000.md']) assert.equal(allowed(s, p, 'read'), false, p);
  // A trailing / is the folder and everything in it; "**" alone is everything.
  assert.deepEqual(cleanScopes([{ path: 'docs/', access: 'read' }]), [{ path: 'docs/**', access: 'read' }]);
  assert.equal(allowed(scoped([{ path: '**', access: 'write' }]), 'any/where/at/all.bin', 'write'), true);
});

test('the most specific rule wins: the longest literal prefix, then write over read', () => {
  const s = scoped([
    { path: 'docs/**', access: 'read' },
    { path: 'docs/drafts/**', access: 'write' },
    { path: 'data/**', access: 'write' },
    { path: 'data/raw/**', access: 'read' },
    { path: 'same/**', access: 'read' },
    { path: 'same/**', access: 'write' },
  ]);
  assert.equal(allowed(s, 'docs/a.md', 'read'), true);
  assert.equal(allowed(s, 'docs/a.md', 'write'), false);
  assert.equal(allowed(s, 'docs/drafts/b.md', 'write'), true);
  assert.equal(allowed(s, 'docs/drafts/deep/b.md', 'write'), true);
  // A narrower read rule takes write away from a broader write rule.
  assert.equal(allowed(s, 'data/clean/x.csv', 'write'), true);
  assert.equal(allowed(s, 'data/raw/x.csv', 'write'), false);
  assert.equal(allowed(s, 'data/raw/x.csv', 'read'), true);
  // A tie: write.
  assert.equal(allowed(s, 'same/x', 'write'), true);
  // Outside every rule: nothing.
  assert.equal(allowed(s, 'code/x.js', 'read'), false);
  assert.equal(allowed(s, 'code/x.js', 'write'), false);
  // A read token never writes, rules or not; a read token cannot even be given write rules.
  const ro = scoped([{ path: 'docs/**', access: 'read' }], 'read');
  assert.equal(allowed(ro, 'docs/a.md', 'write'), false);
  assert.throws(() => cleanScopes([{ path: 'docs/**', access: 'write' }], { tokenScope: 'read' }), /read-only token cannot have write rules/);
});

test('folders: a listing shows the folders on the way to a rule, and nothing else', () => {
  const s = scoped([
    { path: 'docs/**', access: 'read' },
    { path: 'docs/drafts/**', access: 'write' },
    { path: 'a/*/c/**', access: 'read' },
  ]);
  assert.equal(mayContain(s, ''), true);
  assert.equal(mayContain(s, 'docs'), true);
  assert.equal(mayContain(s, 'docs/drafts'), true);
  assert.equal(mayContain(s, 'docs/anything/below'), true);
  assert.equal(mayContain(s, 'code'), false);
  assert.equal(mayContain(s, 'a'), true);
  assert.equal(mayContain(s, 'a/x'), true);
  assert.equal(mayContain(s, 'a/x/c'), true);
  assert.equal(mayContain(s, 'a/x/d'), false);
  assert.equal(mayContain(s, 'b'), false);
  const see = reader(s);
  assert.equal(see('docs', 'dir'), true);
  assert.equal(see('code', 'dir'), false);
  assert.equal(see('a', 'file'), false, 'a file named a is not covered by a/*/c/**');
  // No rules: nothing is filtered.
  assert.equal(reader(scopeOf({ scope: 'write', scopes: null })), null);
  assert.equal(reader(null), null);
});

test('rule lists are checked: shape, size, globs', () => {
  const bad = [
    ['not a list', /list of/],
    [[{ path: '../x', access: 'read' }], /"\." and "\.\." are not allowed/],
    [[{ path: '/abs', access: 'read' }], /absolute/],
    [[{ path: 'a\\b', access: 'read' }], /forward slashes/],
    [[{ path: 'a//b', access: 'read' }], /empty part/],
    [[{ path: 'a**/b', access: 'read' }], /whole folder name/],
    [[{ path: 'docs/**', access: 'admin' }], /read or write/],
    [[{ path: 'docs/**', access: 'read', extra: 1 }], /Unknown field extra/],
    [[{ path: '', access: 'read' }], /empty path/],
    [[{ path: 'x'.repeat(301), access: 'read' }], /over 300/],
    [Array.from({ length: 33 }, (_, i) => ({ path: `f${i}/**`, access: 'read' })), /at most 32/],
  ];
  for (const [rules, re] of bad) assert.throws(() => cleanScopes(rules), re, JSON.stringify(rules).slice(0, 80));
  assert.equal(cleanScopes(null), null);
  assert.equal(cleanScopes([]), null, 'an empty list is the whole workspace');
  assert.equal(cleanScopes(Array.from({ length: 32 }, (_, i) => ({ path: `f${i}/**`, access: 'read' }))).length, 32);
  // A stored list that cannot be read is no access, never everything.
  const broken = scopeOf({ scope: 'write', scopes: '{not json' });
  assert.equal(allowed(broken, 'docs/a.md', 'read'), false);
});

test('enforce: 404 outside what the token reads, 403 with the path outside what it writes, runs judged by their files', () => {
  const s = scoped([
    { path: 'docs/**', access: 'read' },
    { path: 'docs/drafts/**', access: 'write' },
  ]);
  const status = (info) => {
    try {
      enforce(s, info);
      return 200;
    } catch (err) {
      return { status: err.status, code: err.code, extra: err.extra, message: err.message };
    }
  };
  assert.equal(status({ kind: 'fs', write: false, path: 'docs/a.md', access: 'read' }), 200);
  assert.equal(status({ kind: 'fs', write: false, path: 'code/x.js', access: 'read' }).status, 404);
  assert.equal(status({ kind: 'fs', write: false, path: 'code/', access: 'read' }).status, 404);
  assert.equal(status({ kind: 'fs', write: false, path: '', access: 'read' }), 200);
  const w = status({ kind: 'fs', write: true, path: 'docs/a.md', access: 'write' });
  assert.equal(w.status, 403);
  assert.equal(w.code, 'forbidden');
  assert.equal(w.extra.path, 'docs/a.md');
  assert.equal(status({ kind: 'fs', write: true, path: 'code/x.js', access: 'write' }).status, 403, 'a write names its own path, so 403 hides nothing');
  assert.equal(status({ kind: 'fs', write: true, path: 'docs/drafts/n.md', access: 'write' }), 200);
  // A run: invisible when none of its files is readable; refused, naming only what the token may read.
  assert.equal(status({ kind: 'api', write: true, paths: ['code/x.js'], recorded: true, access: 'write' }).status, 404);
  assert.equal(status({ kind: 'api', write: true, paths: [], recorded: true, access: 'write' }).status, 404);
  const mixed = status({ kind: 'api', write: true, paths: ['docs/drafts/d.md', 'code/x.js', 'docs/a.md'], recorded: true, access: 'write' });
  assert.equal(mixed.status, 403);
  assert.deepEqual(mixed.extra, { paths: ['docs/a.md'], hidden: 1 });
  assert.match(mixed.message, /docs\/a\.md and 1 file outside your scope/);
  assert.doesNotMatch(mixed.message, /code/);
  assert.equal(status({ kind: 'api', write: true, paths: ['docs/drafts/d.md'], recorded: true, access: 'write' }), 200);
  // No scope, or no rules: nothing to enforce here.
  assert.doesNotThrow(() => enforce(null, { path: 'code/x.js', access: 'write' }));
  assert.doesNotThrow(() => enforce(scopeOf({ scope: 'write', scopes: null }), { path: 'code/x.js', access: 'write' }));
});

// ---------------------------------------------------------------- the hub

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

async function startHub() {
  const gh = fakeGitHub();
  const dir = tmp('grapim-scope-hub-');
  const clock = { t: Date.now() };
  const hub = await createHub({
    env: { HUB_URL: ORIGIN, HUB_SECRET: 'test-secret-that-is-long-enough-0123456789', HUB_DATA: dir, GITHUB_CLIENT_ID: 'gh-client', GITHUB_CLIENT_SECRET: 'gh-secret' },
    fetch: gh.fetch,
    billing: null,
    storage: null,
    now: () => clock.t,
    log: () => {},
    platform: { resolve: async () => [{ address: '93.184.216.34', family: 4 }], transport: async () => ({ status: 200 }), worker: false },
  });
  const addr = await hub.listen(0, '127.0.0.1');
  return { hub, base: `http://127.0.0.1:${addr.port}`, gh, dir, clock, close: () => hub.close() };
}

class Browser {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }
  async req(p, { method = 'GET', form = null, headers = {} } = {}) {
    const h = { ...headers };
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

let nextId = 7700;
async function signIn(h, login) {
  const id = nextId++;
  h.gh.user(`code-${id}`, { id, login, name: login, avatar_url: null });
  const b = new Browser(h.base);
  const start = await b.req('/hub/auth/github');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const cb = await b.req(`/hub/auth/callback?code=code-${id}&state=${state}`);
  assert.equal(cb.status, 303, cb.text);
  b.user = { id, login };
  return b;
}

async function createTeam(b, name) {
  const r = await b.post('/hub/teams', { name });
  assert.equal(r.status, 303, r.text);
  return r.headers.get('location').match(/\/hub\/teams\/([^/]+)\/settings/)[1];
}

async function createWorkspace(b, team, name, template = undefined) {
  const r = await b.post(`/hub/teams/${team}/workspaces`, { name, ...(template ? { template } : {}) });
  assert.equal(r.status, 303, r.text);
  const id = r.headers.get('location').match(/\/workspaces\/([^/]+)$/)[1];
  return { id, name, team, base: `/w/${team}/${name}/` };
}

async function createWsToken(b, ws, name, scope = 'write', rows = []) {
  const form = { name, scope };
  rows.forEach(([p, access], i) => {
    form[`scope_path_${i}`] = p;
    form[`scope_access_${i}`] = access;
  });
  const r = await b.post(`/hub/teams/${ws.team}/workspaces/${ws.id}/tokens`, form);
  assert.equal(r.status, 200, r.text);
  return r.text.match(/value="(gws_[A-Za-z0-9_-]+)"/)[1];
}

async function agent(h, token, p, { method = 'GET', body = undefined, headers = {}, json = undefined } = {}) {
  const hdr = { ...headers };
  if (token) hdr.Authorization = `Bearer ${token}`;
  if (json !== undefined) {
    hdr['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(h.base + p, { method, headers: hdr, body, redirect: 'manual' });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, text, json: parsed };
}

async function mcp(h, token, base, messages, { session = null, agentName = null } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (session) headers['Mcp-Session-Id'] = session;
  if (agentName) headers['X-Grapim-Agent'] = agentName;
  const r = await agent(h, token, `${base}mcp`, { method: 'POST', body: JSON.stringify(messages), headers });
  return { ...r, session: r.headers.get('mcp-session-id') };
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test' }, capabilities: {} } };
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const toolText = (r) => r.json?.result?.content?.[0]?.text ?? '';

// One workspace with a docs folder, drafts, and code, written by an unscoped
// token: run http:full/mixed touches docs/drafts and code, http:full/coder only code.
async function seeded(h, login) {
  const owner = await signIn(h, login);
  const team = await createTeam(owner, `${login} team`);
  const ws = await createWorkspace(owner, team, 'shared');
  const full = await createWsToken(owner, ws, 'full', 'write');
  const put = async (p, body, who) => {
    const r = await agent(h, full, `${ws.base}fs/${p}`, { method: 'PUT', body, headers: { 'X-Grapim-Agent': who } });
    assert.equal(r.status, 200, r.text);
  };
  await put('docs/a.md', 'alpha\n', 'writer');
  await put('docs/drafts/d.md', 'draft one\n', 'mixed');
  await put('code/x.js', 'let x = 1;\n', 'mixed');
  await put('code/only.js', 'let only = 1;\n', 'coder');
  // Done with the files: release, so a scoped agent may claim them.
  for (const who of ['writer', 'mixed', 'coder']) await agent(h, full, `${ws.base}fs/_release`, { method: 'POST', headers: { 'X-Grapim-Agent': who } });
  const limited = await createWsToken(owner, ws, 'limited', 'write', [
    ['docs/**', 'read'],
    ['docs/drafts/**', 'write'],
  ]);
  return { owner, team, ws, full, limited };
}

const runPath = (ws, run, rest = '') => `${ws.base}api/runs/${encodeURIComponent(run)}${rest}`;

test('a token scoped to docs/** (read) and docs/drafts/** (write): /fs reads, writes and listings', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { owner, ws, full, limited } = await seeded(h, 'sc-fs');

  // Reads: docs yes; code is "not found", exactly like a file that is not there.
  const a = await agent(h, limited, `${ws.base}fs/docs/a.md`);
  assert.equal(a.status, 200);
  assert.equal(a.text, 'alpha\n');
  const hidden = await agent(h, limited, `${ws.base}fs/code/x.js`);
  const missing = await agent(h, limited, `${ws.base}fs/code/nope.js`);
  assert.equal(hidden.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(hidden.json.error.code, 'not_found');
  assert.equal(missing.json.error.code, 'not_found');
  assert.equal(hidden.json.error.message.replace('x.js', 'nope.js'), missing.json.error.message, 'the same answer whether or not the file exists');

  // Writes: only drafts. Elsewhere 403 forbidden with the path, and nothing is written.
  const ok = await agent(h, limited, `${ws.base}fs/docs/drafts/new.md`, { method: 'PUT', body: 'new\n', headers: { 'X-Grapim-Agent': 'bot' } });
  assert.equal(ok.status, 200, ok.text);
  for (const p of ['docs/a.md', 'code/x.js', 'code/new.js', 'top.md']) {
    const r = await agent(h, limited, `${ws.base}fs/${p}`, { method: 'PUT', body: 'evil\n', headers: { 'X-Grapim-Agent': 'bot' } });
    assert.equal(r.status, 403, `${p}: ${r.text}`);
    assert.equal(r.json.error.code, 'forbidden');
    assert.equal(r.json.error.path, p);
  }
  assert.equal(fs.readFileSync(path.join(h.dir, 'workspaces', ws.team, ws.id, 'docs', 'a.md'), 'utf8'), 'alpha\n');
  assert.equal(fs.existsSync(path.join(h.dir, 'workspaces', ws.team, ws.id, 'code', 'new.js')), false);
  const del = await agent(h, limited, `${ws.base}fs/code/x.js`, { method: 'DELETE', headers: { 'X-Grapim-Agent': 'bot' } });
  assert.equal(del.status, 403);
  assert.equal((await agent(h, limited, `${ws.base}fs/docs/drafts/new.md`, { method: 'DELETE', headers: { 'X-Grapim-Agent': 'bot' } })).status, 200);
  // ".." cannot walk out of the scope: the path is refused before any rule sees it.
  assert.equal((await agent(h, limited, `${ws.base}fs/docs/drafts/..%2F..%2Fcode%2Fx.js`, { method: 'PUT', body: 'x', headers: { 'X-Grapim-Agent': 'bot' } })).status, 400);

  // Listings leave code/ out instead of refusing the folder.
  const root = await agent(h, limited, `${ws.base}fs/`);
  assert.equal(root.status, 200);
  assert.deepEqual(root.json.map((e) => e.path), ['docs']);
  const docs = await agent(h, limited, `${ws.base}fs/docs/`);
  assert.deepEqual(docs.json.map((e) => e.path).sort(), ['docs/a.md', 'docs/drafts']);
  assert.equal((await agent(h, limited, `${ws.base}fs/code/`)).status, 404);
  const files = await agent(h, limited, `${ws.base}api/files`);
  assert.deepEqual(files.json.map((e) => e.path), ['docs']);
  const all = await agent(h, limited, `${ws.base}api/files?recursive=1`);
  assert.deepEqual(all.json.files.map((f) => f.path), ['docs/a.md', 'docs/drafts/d.md']);
  assert.equal((await agent(h, limited, `${ws.base}api/files?path=code`)).status, 404);

  // The unscoped token, and the person, see and do everything as before.
  assert.deepEqual((await agent(h, full, `${ws.base}fs/`)).json.map((e) => e.path), ['code', 'docs']);
  assert.equal((await agent(h, full, `${ws.base}fs/code/x.js`)).text, 'let x = 1;\n');
  assert.equal((await agent(h, full, `${ws.base}api/files?recursive=1`)).json.files.length, 4);
  assert.equal((await agent(h, full, `${ws.base}fs/code/x.js`, { method: 'PUT', body: 'let x = 2;\n', headers: { 'X-Grapim-Agent': 'fixer' } })).status, 200);
  const page = await owner.req(`/w/${ws.team}/${ws.name}/api/files?recursive=1`);
  assert.equal(JSON.parse(page.text).files.length, 4);

  // The token list shows each token's folders.
  const settings = await owner.req(`/hub/teams/${ws.team}/workspaces/${ws.id}`);
  assert.match(settings.text, /docs\/\*\* · read/);
  assert.match(settings.text, /docs\/drafts\/\*\* · write/);
  assert.match(settings.text, /Limit to folders/);
  assert.deepEqual(h.hub.workspaces.tokens({ id: ws.id }, { role: 'owner' }).find((x) => x.name === 'full').scopes, null);
});

test('a scoped token on /api: blame, history, versions, runs, run detail, events and the changes feed', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { ws, full, limited } = await seeded(h, 'sc-api');

  assert.equal((await agent(h, limited, `${ws.base}api/blame?path=docs/a.md`)).status, 200);
  assert.equal((await agent(h, limited, `${ws.base}api/blame?path=code/x.js`)).status, 404);
  assert.equal((await agent(h, limited, `${ws.base}api/files/history?path=docs/drafts/d.md`)).json.length, 1);
  assert.equal((await agent(h, limited, `${ws.base}api/files/history?path=code/x.js`)).status, 404);
  assert.equal((await agent(h, limited, `${ws.base}api/files/version?sha=${sha1('alpha\n')}`)).text, 'alpha\n');
  assert.equal((await agent(h, limited, `${ws.base}api/files/version?sha=${sha1('let x = 1;\n')}`)).status, 404);
  assert.equal((await agent(h, full, `${ws.base}api/files/version?sha=${sha1('let x = 1;\n')}`)).status, 200);

  // Runs: only those that touched something it may read.
  const runs = (await agent(h, limited, `${ws.base}api/runs`)).json.map((r) => r.run).sort();
  assert.deepEqual(runs, ['http:full/mixed', 'http:full/writer']);
  assert.equal((await agent(h, full, `${ws.base}api/runs`)).json.length, 3);
  const ov = (await agent(h, limited, `${ws.base}api/overview`)).json;
  assert.equal(ov.counts.runs, 2);

  // Run detail: the diff of code/x.js is left out and counted.
  const d = await agent(h, limited, runPath(ws, 'http:full/mixed'));
  assert.equal(d.status, 200, d.text);
  assert.deepEqual(d.json.files.map((f) => f.path), ['docs/drafts/d.md']);
  assert.equal(d.json.hidden_files, 1);
  assert.equal(d.json.scope_note, '1 file outside your scope');
  assert.doesNotMatch(d.text, /code\/x\.js|let x/);
  assert.ok(d.json.turns.every((turn) => turn.files.every((p) => p.startsWith('docs/'))));
  assert.equal((await agent(h, limited, runPath(ws, 'http:full/coder'))).status, 404, 'a run entirely outside the scope does not exist');
  // A prefix is matched among the runs it can see: "full/" names two, never coder.
  const ambiguous = await agent(h, limited, runPath(ws, 'full/'));
  assert.equal(ambiguous.status, 400);
  assert.match(ambiguous.json.error.message, /matches 2 runs/);
  assert.doesNotMatch(ambiguous.text, /coder/);
  assert.equal((await agent(h, limited, runPath(ws, 'full/m'))).json.run.run, 'http:full/mixed');
  assert.match((await agent(h, full, runPath(ws, 'full/'))).json.error.message, /matches 3 runs/);
  const unscoped = await agent(h, full, runPath(ws, 'http:full/mixed'));
  assert.equal(unscoped.json.files.length, 2);
  assert.equal('hidden_files' in unscoped.json, false);

  // Events and the changes feed leave out code/, but the cursor still moves past it.
  const events = (await agent(h, limited, `${ws.base}api/events?limit=1000`)).json;
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => !String(e.path ?? '').startsWith('code/')));
  const feed = (await agent(h, limited, `${ws.base}api/files/changes`)).json;
  const fullFeed = (await agent(h, full, `${ws.base}api/files/changes`)).json;
  assert.deepEqual(feed.changes.map((c) => c.path), ['docs/a.md', 'docs/drafts/d.md']);
  assert.equal(feed.cursor, fullFeed.cursor);
});

test('a scoped token acts only on what it may write: undo, review, branch and restore', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { ws, full, limited } = await seeded(h, 'sc-act');
  const post = (p, json) => agent(h, limited, p, { method: 'POST', json });

  // The mixed run touched code/: undo (even a plan), review and branch are refused, naming no code path.
  for (const [rest, body] of [['/undo', { apply: false }], ['/undo', { apply: true }], ['/review', { status: 'approved' }], ['/branch', {}]]) {
    const r = await post(runPath(ws, 'http:full/mixed', rest), body);
    assert.equal(r.status, 403, `${rest}: ${r.text}`);
    assert.equal(r.json.error.code, 'forbidden');
    assert.equal(r.json.error.hidden, 1);
    assert.doesNotMatch(r.text, /code\//);
  }
  assert.equal(fs.readFileSync(path.join(h.dir, 'workspaces', ws.team, ws.id, 'code', 'x.js'), 'utf8'), 'let x = 1;\n', 'nothing was undone');
  // A run entirely outside the scope: not found, as for the read.
  assert.equal((await post(runPath(ws, 'http:full/coder', '/undo'), { apply: true })).status, 404);
  // writer touched docs/a.md, which it may read but not write: refused with the path.
  const ro = await post(runPath(ws, 'http:full/writer', '/undo'), { apply: true });
  assert.equal(ro.status, 403);
  assert.deepEqual(ro.json.error.paths, ['docs/a.md']);

  // Restore: one path.
  const v = sha1('let x = 1;\n');
  assert.equal((await post(`${ws.base}api/files/restore`, { path: 'code/x.js', sha: v })).status, 403);

  // Its own run, inside drafts: undo, review and restore all work.
  assert.equal((await agent(h, limited, `${ws.base}fs/docs/drafts/d.md`, { method: 'PUT', body: 'draft two\n', headers: { 'X-Grapim-Agent': 'bot' } })).status, 200);
  await agent(h, limited, `${ws.base}fs/_release`, { method: 'POST', headers: { 'X-Grapim-Agent': 'bot' } });
  const undo = await post(runPath(ws, 'http:limited/bot', '/undo'), { apply: true });
  assert.equal(undo.status, 200, undo.text);
  assert.equal(fs.readFileSync(path.join(h.dir, 'workspaces', ws.team, ws.id, 'docs', 'drafts', 'd.md'), 'utf8'), 'draft one\n');
  assert.equal((await post(runPath(ws, 'http:limited/bot', '/review'), { status: 'rejected' })).status, 200);
  const restored = await post(`${ws.base}api/files/restore`, { path: 'docs/drafts/d.md', sha: sha1('draft two\n') });
  assert.equal(restored.status, 200, restored.text);

  // The unscoped token undoes the mixed run as before.
  const u = await agent(h, full, runPath(ws, 'http:full/mixed', '/undo'), { method: 'POST', json: { apply: true } });
  assert.equal(u.status, 200, u.text);
  assert.equal(fs.existsSync(path.join(h.dir, 'workspaces', ws.team, ws.id, 'code', 'x.js')), false);
});

test('a scoped token over MCP: write_file outside the scope is refused, reads and lists are filtered', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { ws, full, limited } = await seeded(h, 'sc-mcp');
  const open = await mcp(h, limited, ws.base, init, { agentName: 'claude' });
  assert.equal(open.status, 200, open.text);
  const s = { session: open.session, agentName: 'claude' };

  const refused = await mcp(h, limited, ws.base, call(2, 'write_file', { path: 'code/evil.js', content: 'x' }), s);
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, -32003);
  assert.equal(fs.existsSync(path.join(h.dir, 'workspaces', ws.team, ws.id, 'code', 'evil.js')), false);
  // A batch with one refused call runs nothing.
  const batch = await mcp(h, limited, ws.base, [call(3, 'write_file', { path: 'docs/drafts/ok.md', content: 'ok' }), call(4, 'delete_file', { path: 'docs/a.md' })], s);
  assert.equal(batch.status, 403);
  assert.equal(fs.existsSync(path.join(h.dir, 'workspaces', ws.team, ws.id, 'docs', 'drafts', 'ok.md')), false);
  for (const [tool, args] of [['delete_file', { path: 'code/x.js' }], ['claim_files', { paths: ['docs/drafts/d.md', 'code/x.js'] }], ['write_file', { path: 'docs/a.md', content: 'x' }]]) {
    assert.equal((await mcp(h, limited, ws.base, call(5, tool, args), s)).status, 403, tool);
  }

  const wrote = await mcp(h, limited, ws.base, call(6, 'write_file', { path: 'docs/drafts/m.md', content: 'mcp\n' }), s);
  assert.equal(wrote.status, 200, wrote.text);
  assert.match(toolText(wrote), /Wrote docs\/drafts\/m\.md/);

  // Reads outside the scope: "not found", over HTTP 200 so the client keeps its session.
  const read = await mcp(h, limited, ws.base, call(7, 'read_file', { path: 'code/x.js' }), s);
  assert.equal(read.status, 200);
  assert.equal(read.json.error.code, -32003);
  assert.match(read.json.error.message, /does not exist/);
  assert.equal((await mcp(h, limited, ws.base, call(8, 'who_wrote', { path: 'code/x.js' }), s)).json.error.code, -32003);
  assert.equal(toolText(await mcp(h, limited, ws.base, call(9, 'read_file', { path: 'docs/a.md' }), s)), 'alpha\n');

  const root = toolText(await mcp(h, limited, ws.base, call(10, 'list_dir', { path: '' }), s));
  assert.match(root, /^docs\//m);
  assert.doesNotMatch(root, /code/);
  assert.equal((await mcp(h, limited, ws.base, call(11, 'list_dir', { path: 'code' }), s)).json.error.code, -32003);
  const runs = toolText(await mcp(h, limited, ws.base, call(12, 'list_runs', {}), s));
  assert.match(runs, /full\/mixed/);
  assert.doesNotMatch(runs, /full\/coder/);
  const activity = toolText(await mcp(h, limited, ws.base, call(13, 'recent_activity', { limit: 200 }), s));
  assert.doesNotMatch(activity, /code\//);

  // The unscoped token's MCP sees everything.
  const o = await mcp(h, full, ws.base, init, { agentName: 'claude' });
  const fullRoot = toolText(await mcp(h, full, ws.base, call(2, 'list_dir', { path: '' }), { session: o.session, agentName: 'claude' }));
  assert.match(fullRoot, /code\//);
  assert.match(toolText(await mcp(h, full, ws.base, call(3, 'list_runs', {}), { session: o.session })), /full\/coder/);
});

test('scoped tokens from the hub UI are validated, and a scope does not leak to another workspace (IDOR)', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { owner, ws, limited } = await seeded(h, 'sc-idor');
  // A read token with a write rule, and a bad glob: refused on the page, nothing created.
  for (const [scope, rows, re] of [
    ['read', [['docs/**', 'write']], /read-only token cannot have write rules/],
    ['write', [['../etc', 'read']], /are not allowed/],
  ]) {
    const r = await owner.post(`/hub/teams/${ws.team}/workspaces/${ws.id}/tokens`, { name: `bad-${scope}`, scope, scope_path_0: rows[0][0], scope_access_0: rows[0][1] });
    assert.equal(r.status, 400, r.text);
    assert.match(r.text, re);
  }
  assert.equal(h.hub.db.prepare("SELECT COUNT(*) AS n FROM workspace_tokens WHERE name LIKE 'bad-%'").get().n, 0);
  const row = h.hub.db.prepare("SELECT scope, scopes FROM workspace_tokens WHERE name = 'limited'").get();
  assert.deepEqual(JSON.parse(row.scopes), [{ path: 'docs/**', access: 'read' }, { path: 'docs/drafts/**', access: 'write' }]);

  // Another team's workspace with the same folders: the scoped token is not a key to it.
  const mallory = await signIn(h, 'sc-mallory');
  const mt = await createTeam(mallory, 'Mallory');
  const other = await createWorkspace(mallory, mt, 'shared');
  for (const p of ['fs/docs/', 'fs/', 'api/runs', 'api/files?recursive=1']) assert.equal((await agent(h, limited, `${other.base}${p}`)).status, 404, p);
  // A scoped token cannot widen itself: the hub's token routes take a signed-in session, not a token.
  const widen = await agent(h, limited, `/hub/teams/${ws.team}/workspaces/${ws.id}/tokens`, { method: 'POST', body: 'name=wider&scope=write', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.notEqual(widen.status, 200);
  assert.equal(h.hub.db.prepare("SELECT COUNT(*) AS n FROM workspace_tokens WHERE name = 'wider'").get().n, 0);
});

// ---------------------------------------------------------------- platform and templates

async function platformTeam(h, login) {
  const owner = await signIn(h, login);
  const team = await createTeam(owner, `${login} Inc`);
  assert.equal((await owner.post(`/hub/teams/${team}/platform`)).status, 303);
  const r = await owner.post(`/hub/teams/${team}/platform/keys`, { name: 'backend', mode: 'live' });
  assert.equal(r.status, 200, r.text);
  return { owner, team, key: r.text.match(/value="(gpk_live_[A-Za-z0-9_-]+)"/)[1] };
}

async function v1(h, key, method, p, body = undefined) {
  h.clock.t += 50;
  const headers = { Authorization: `Bearer ${key}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(h.base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}

test('platform API: tokens minted with scopes, templates on create, and both validated', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { key } = await platformTeam(h, 'sc-pf');

  const made = await v1(h, key, 'POST', '/v1/workspaces', { external_id: 'cust_1', name: 'cust-1', template: 'research' });
  assert.equal(made.status, 200, made.text);
  const base = new URL(made.json.url).pathname;
  const tok = await v1(h, key, 'POST', `/v1/workspaces/${made.json.id}/tokens`, {
    scope: 'write',
    agent_name: 'writer',
    scopes: [
      { path: 'sources/**', access: 'read' },
      { path: 'notes/', access: 'read' },
      { path: 'drafts/**', access: 'write' },
    ],
  });
  assert.equal(tok.status, 200, tok.text);
  assert.deepEqual(tok.json.scopes, [
    { path: 'sources/**', access: 'read' },
    { path: 'notes/**', access: 'read' },
    { path: 'drafts/**', access: 'write' },
  ]);
  const gws = tok.json.token;
  assert.equal((await agent(h, gws, `${base}fs/sources/README.md`)).status, 200);
  assert.equal((await agent(h, gws, `${base}fs/drafts/post.md`, { method: 'PUT', body: 'post\n' })).status, 200);
  const no = await agent(h, gws, `${base}fs/notes/n.md`, { method: 'PUT', body: 'n\n' });
  assert.equal(no.status, 403);
  assert.equal(no.json.error.path, 'notes/n.md');
  assert.deepEqual((await agent(h, gws, `${base}fs/`)).json.map((e) => e.path), ['drafts', 'notes', 'sources']);

  // Without scopes: as before (scopes null in the reply).
  const plain = await v1(h, key, 'POST', `/v1/workspaces/${made.json.id}/tokens`, { scope: 'read' });
  assert.equal(plain.status, 200);
  assert.equal(plain.json.scopes, null);

  // Refused: bad rules, a read token with write rules, more than 32, an unknown template.
  for (const body of [
    { scope: 'write', scopes: 'docs/**' },
    { scope: 'write', scopes: [{ path: '../x', access: 'read' }] },
    { scope: 'read', scopes: [{ path: 'drafts/**', access: 'write' }] },
    { scope: 'write', scopes: Array.from({ length: 33 }, (_, i) => ({ path: `d${i}/**`, access: 'read' })) },
  ]) {
    const r = await v1(h, key, 'POST', `/v1/workspaces/${made.json.id}/tokens`, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(r.json.error.code, 'invalid_request');
  }
  const badTemplate = await v1(h, key, 'POST', '/v1/workspaces', { name: 'cust-2', template: 'everything' });
  assert.equal(badTemplate.status, 400);
  assert.match(badTemplate.json.error.message, /template must be one of blank, agent-team, research, data/);
  assert.equal(h.hub.db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE name = 'cust-2'").get().n, 0, 'nothing is created');
  // The OpenAPI document describes both.
  const doc = (await fetch(`${h.base}/v1/openapi.json`).then((r) => r.json())).components.schemas;
  assert.deepEqual(doc.WorkspaceCreate.properties.template.enum, ['blank', 'agent-team', 'research', 'data']);
  assert.equal(doc.WorkspaceTokenCreate.properties.scopes.maxItems, 32);
});

test('templates: the folders and READMEs, written as one auto-approved run template:<name> in the ledger', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const owner = await signIn(h, 'sc-tpl');
  const team = await createTeam(owner, 'Templates');
  const ws = await createWorkspace(owner, team, 'crew', 'agent-team');
  const dir = path.join(h.dir, 'workspaces', team, ws.id);
  for (const f of ['code', 'docs', 'data', 'saas']) {
    const text = fs.readFileSync(path.join(dir, f, 'README.md'), 'utf8');
    assert.match(text, new RegExp(`^# ${f}\\n\\n`));
  }
  const token = await createWsToken(owner, ws, 'reader', 'read');
  const runs = (await agent(h, token, `${ws.base}api/runs`)).json;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].run, 'template:agent-team');
  assert.equal(runs[0].label, 'template:agent-team');
  assert.equal(runs[0].files, 4);
  assert.equal(runs[0].review.status, 'approved');
  assert.equal(runs[0].review.note, 'automatic');
  assert.equal(runs[0].review.by, `human:${owner.user.login}`);
  const blame = (await agent(h, token, `${ws.base}api/blame?path=docs/README.md`)).json;
  assert.ok(blame.lines.length > 0 && blame.lines.every((l) => l.run === 'template:agent-team'));
  const feed = (await agent(h, token, `${ws.base}api/files/changes`)).json;
  assert.deepEqual(feed.changes.map((c) => c.path).sort(), ['code/README.md', 'data/README.md', 'docs/README.md', 'saas/README.md']);
  // It is a run like any other: it can be undone.
  const writer = await createWsToken(owner, ws, 'writer', 'write');
  const undo = await agent(h, writer, `${ws.base}api/runs/${encodeURIComponent('template:agent-team')}/undo`, { method: 'POST', json: { apply: true } });
  assert.equal(undo.status, 200, undo.text);
  assert.equal(fs.existsSync(path.join(dir, 'docs', 'README.md')), false);

  // Blank (the default) writes nothing; research and data their folders.
  const team2 = await createTeam(owner, 'Blank');
  const blank = await createWorkspace(owner, team2, 'empty');
  const t2 = await createWsToken(owner, blank, 'r', 'read');
  assert.deepEqual((await agent(h, t2, `${blank.base}api/runs`)).json, []);
  assert.deepEqual((await agent(h, t2, `${blank.base}fs/`)).json, []);
  const team3 = await createTeam(owner, 'Data');
  const data = await createWorkspace(owner, team3, 'numbers', 'data');
  const t3 = await createWsToken(owner, data, 'r', 'read');
  assert.deepEqual((await agent(h, t3, `${data.base}fs/`)).json.map((e) => e.path), ['clean', 'raw', 'reports']);
  // An unknown template is refused on the page, and nothing is created.
  const team4 = await createTeam(owner, 'Bad');
  const bad = await owner.post(`/hub/teams/${team4}/workspaces`, { name: 'nope', template: 'kitchen-sink' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /template must be one of/);
  assert.equal(h.hub.workspaces.live(team4).length, 0);
  // The page offers the templates.
  assert.match((await owner.req(`/hub/teams/${team4}/workspaces`)).text, /<option value="agent-team">/);
});
