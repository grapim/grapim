// Cloud workspaces (docs/workspaces.md section 1): the src/server engine
// mounted in the hub at /w/<team>/<name>/, workspace tokens, access and
// isolation, quota, soft delete, and the storage wiring with a fake backend.
// An in-process hub with GitHub mocked, as in test/hub.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../src/hub/server.js';
import { UI_DIR } from '../src/server/engine.js';

const ORIGIN = 'http://localhost:7999';
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

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

// A storage backend in memory, with the contract's interface.
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

async function startHub({ env = {}, dir = tmp('grapim-ws-hub-'), storage = null, gh = fakeGitHub() } = {}) {
  const logs = [];
  const hub = await createHub({
    env: {
      HUB_URL: ORIGIN,
      HUB_SECRET: 'test-secret-that-is-long-enough-0123456789',
      HUB_DATA: dir,
      GITHUB_CLIENT_ID: 'gh-client',
      GITHUB_CLIENT_SECRET: 'gh-secret',
      ...env,
    },
    fetch: gh.fetch,
    billing: null,
    // null: no storage; 'default': HUB_STORAGE_URL or the folder in HUB_DATA; else a backend object.
    ...(storage === 'default' ? {} : { storage }),
    log: (l) => logs.push(l),
  });
  const addr = await hub.listen(0, '127.0.0.1');
  return { hub, base: `http://127.0.0.1:${addr.port}`, gh, logs, dir, close: () => hub.close() };
}

class Browser {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
    this.wsCsrf = null;
  }
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async req(p, { method = 'GET', form = null, headers = {}, origin = ORIGIN, body = undefined } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.Cookie = this.cookie();
    if (method !== 'GET' && origin && !('Origin' in h)) h.Origin = origin;
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
    if (res.headers.get('x-grapim-csrf')) this.wsCsrf = res.headers.get('x-grapim-csrf');
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
  }
  async csrf() {
    return (await this.req('/hub/api/me')).json().csrf;
  }
  async post(p, form = {}) {
    return this.req(p, { method: 'POST', form: { _csrf: await this.csrf(), ...form } });
  }
  // A request from the review desk: same origin, with the CSRF token the hub gave it.
  async desk(p, { method = 'GET', json = undefined, body = undefined, headers = {} } = {}) {
    if (!this.wsCsrf) await this.req(p.replace(/(\/w\/[^/]+\/[^/]+\/).*/, '$1api/overview'));
    const h = { ...headers };
    if (method !== 'GET') h['X-Grapim-Csrf'] = this.wsCsrf;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    return this.req(p, { method, headers: h, body });
  }
}

let nextId = 5000;
async function signIn(t, login = `user${nextId}`) {
  const id = nextId++;
  t.gh.user(`code-${id}`, { id, login, name: login, avatar_url: null });
  const b = new Browser(t.base);
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

async function createWorkspace(b, team, name) {
  const r = await b.post(`/hub/teams/${team}/workspaces`, { name });
  assert.equal(r.status, 303, r.text);
  const id = r.headers.get('location').match(/\/workspaces\/([^/]+)$/)[1];
  return { id, name, team, base: `/w/${team}/${name}/` };
}

async function createWsToken(b, ws, name, scope = 'write') {
  const r = await b.post(`/hub/teams/${ws.team}/workspaces/${ws.id}/tokens`, { name, scope });
  assert.equal(r.status, 200, r.text);
  return r.text.match(/value="(gws_[A-Za-z0-9_-]+)"/)[1];
}

// A request whose target is sent exactly as written (fetch would resolve "..").
function rawRequest(t, target, headers = {}) {
  const u = new URL(t.base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: target, method: 'GET', headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

// An agent with a workspace token.
async function agent(t, token, p, { method = 'GET', body = undefined, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const ac = new AbortController();
  const res = await fetch(t.base + p, { method, headers: h, body, redirect: 'manual', signal: ac.signal });
  const stream = (res.headers.get('content-type') || '').startsWith('text/event-stream');
  const text = stream ? '' : await res.text();
  ac.abort();
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
}

async function mcp(t, token, base, messages, { session = null, agentName = null } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (session) headers['Mcp-Session-Id'] = session;
  if (agentName) headers['X-Grapim-Agent'] = agentName;
  const r = await agent(t, token, `${base}mcp`, { method: 'POST', body: JSON.stringify(messages), headers });
  return { ...r, session: r.headers.get('mcp-session-id') };
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test' }, capabilities: {} } };
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

// ---------------------------------------------------------------- the flow

test('a workspace: created as a git repo, written by a token, reviewed, blamed and undone through the mounted engine', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'ws-alice');
  const team = await createTeam(alice, 'Docs Team');
  const ws = await createWorkspace(alice, team, 'research-notes');

  // The folder: a git repo with one empty commit by the fixed identity.
  const dir = path.join(h.dir, 'workspaces', team, ws.id);
  const log = execFileSync('git', ['log', '--format=%an <%ae>|%s'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(log, 'Grapim <workspace@grapim.local>|Workspace created');
  const row = h.hub.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(ws.id);
  assert.equal(row.team_id, team);
  assert.equal(row.created_by, alice.user.id);
  assert.equal(row.deleted_at, null);
  assert.ok(row.bytes > 0, 'the new folder is measured');

  // The team page lists it with an Open link; the free plan allows one.
  const list = await alice.req(`/hub/teams/${team}/workspaces`);
  assert.match(list.text, new RegExp(`href="/w/${team}/research-notes/"`));
  const second = await alice.post(`/hub/teams/${team}/workspaces`, { name: 'second' });
  assert.equal(second.status, 402);
  assert.match(second.text, /free plan includes 1 workspace/);

  const writer = await createWsToken(alice, ws, 'writer', 'write');
  const page = await alice.req(`/hub/teams/${team}/workspaces/${ws.id}`);
  assert.doesNotMatch(page.text, /gws_[A-Za-z0-9_-]{20,}/, 'the token is shown once');
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM workspace_tokens WHERE token_hash = ?').get(crypto.createHash('sha256').update(writer).digest('hex')).n, 1);

  // A write token PUTs a file; the run is http:<token-name>/<agent>.
  const put = await agent(h, writer, `${ws.base}fs/notes/plan.md`, { method: 'PUT', body: 'one\ntwo\n', headers: { 'X-Grapim-Agent': 'bot', 'X-Grapim-Intent': 'Draft the plan' } });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json().sha, sha1('one\ntwo\n'));
  assert.equal(fs.readFileSync(path.join(dir, 'notes', 'plan.md'), 'utf8'), 'one\ntwo\n');
  const put2 = await agent(h, writer, `${ws.base}fs/notes/plan.md`, { method: 'PUT', body: 'one\nTWO\nthree\n', headers: { 'X-Grapim-Agent': 'bot' } });
  assert.equal(put2.status, 200, put2.text);
  // Without the header, the token itself is the agent.
  assert.equal((await agent(h, writer, `${ws.base}fs/readme.txt`, { method: 'PUT', body: 'hi' })).status, 200);
  // A header naming another token's agent stays inside this token's namespace.
  assert.equal((await agent(h, writer, `${ws.base}fs/spoof.txt`, { method: 'PUT', body: 'x', headers: { 'X-Grapim-Agent': 'other/bot' } })).status, 200);

  const runs = (await agent(h, writer, `${ws.base}api/runs`)).json();
  const ids = runs.map((r) => r.run).sort();
  assert.deepEqual(ids, ['http:writer', 'http:writer/bot', 'http:writer/other/bot']);
  const bot = runs.find((r) => r.run === 'http:writer/bot');
  assert.equal(bot.intent, 'Draft the plan');

  const blame = (await agent(h, writer, `${ws.base}api/blame?path=notes/plan.md&full=1`)).json();
  assert.equal(blame.content, 'one\nTWO\nthree\n');
  assert.ok(JSON.stringify(blame).includes('writer/bot'), 'blame names the token agent');
  const detail = (await agent(h, writer, `${ws.base}api/runs/${encodeURIComponent('http:writer/bot')}`)).json();
  assert.equal(detail.files[0].path, 'notes/plan.md');

  // Undo through the workspace API, by the token: the file goes back to absent.
  const plan = await agent(h, writer, `${ws.base}api/runs/${encodeURIComponent('http:writer/bot')}/undo`, { method: 'POST', body: JSON.stringify({ apply: true }), headers: { 'Content-Type': 'application/json', 'X-Grapim-Agent': 'bot' } });
  assert.equal(plan.status, 200, plan.text);
  assert.equal(plan.json().applied, true);
  assert.equal(fs.existsSync(path.join(dir, 'notes', 'plan.md')), false);
  const events = (await agent(h, writer, `${ws.base}api/events?latest=1`)).json();
  assert.equal(events.filter((e) => e.kind === 'undo').at(-1).actor, 'http:writer/bot');

  // A person reviewing in the desk is human:<github-login>, and needs the desk's CSRF token.
  const noCsrf = await alice.req(`${ws.base}api/runs/${encodeURIComponent('http:writer')}/review`, { method: 'POST', body: JSON.stringify({ status: 'approved' }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(noCsrf.status, 403);
  const review = await alice.desk(`${ws.base}api/runs/${encodeURIComponent('http:writer')}/review`, { method: 'POST', json: { status: 'approved', note: 'ok' } });
  assert.equal(review.status, 200, review.text);
  assert.equal(review.json().by, 'human:ws-alice');
  const humanUndo = await alice.desk(`${ws.base}api/runs/${encodeURIComponent('http:writer')}/undo`, { method: 'POST', json: { apply: true }, headers: { 'X-Grapim-Agent': 'pretend-agent' } });
  assert.equal(humanUndo.status, 200, humanUndo.text);
  assert.ok(humanUndo.json().files.length >= 1);
  const undoRun = (await agent(h, writer, `${ws.base}api/runs`)).json().find((r) => r.run.startsWith('undo:') && r.review.by === 'human:ws-alice');
  assert.ok(undoRun, 'the person\'s undo is recorded as human:<login>, whatever X-Grapim-Agent says');
  assert.equal(fs.existsSync(path.join(dir, 'readme.txt')), false);

  // The session's own /fs writes are http:@<login>.
  const mine = await alice.desk(`${ws.base}fs/by-hand.txt`, { method: 'PUT', body: 'typed', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(mine.status, 200, mine.text);
  assert.ok((await agent(h, writer, `${ws.base}api/runs`)).json().some((r) => r.run === 'http:@ws-alice'));
});

test('the review desk is served at the base path, its assets resolve, and its CSP allows only its own code', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'desk-alice');
  const team = await createTeam(alice, 'Desk');
  const ws = await createWorkspace(alice, team, 'desk');

  const bare = await alice.req(`/w/${team}/desk`);
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.get('location'), ws.base);

  const page = await alice.req(ws.base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(page.text, fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8'));
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
  assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/);
  assert.equal(page.headers.get('referrer-policy'), 'same-origin', 'the hub policy, so desk writes carry a real Origin');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  // The inline theme script is exactly the one the hash allows.
  const inline = page.text.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\r\n?/g, '\n');
  assert.ok(csp.includes(`'sha256-${crypto.createHash('sha256').update(inline).digest('base64')}'`));

  // Every asset the page names, relative to the base path, and every view module.
  const refs = [...page.text.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]).filter((r) => !r.startsWith('data:'));
  assert.ok(refs.includes('app.js') && refs.includes('styles.css'), refs.join(','));
  for (const r of [...refs, ...fs.readdirSync(path.join(UI_DIR, 'views')).map((f) => `views/${f}`), 'api.js']) {
    const res = await alice.req(ws.base + r);
    assert.equal(res.status, 200, r);
  }
  assert.match((await alice.req(`${ws.base}app.js`)).headers.get('content-type'), /javascript/);
  // The UI derives its API base from the page's own path.
  assert.match(fs.readFileSync(path.join(UI_DIR, 'api.js'), 'utf8'), /location\.pathname/);
  const ov = await alice.req(`${ws.base}api/overview`);
  assert.equal(ov.status, 200);
  assert.ok(ov.headers.get('x-grapim-csrf'), 'the desk gets its CSRF token on API responses');
  assert.match(ov.headers.get('content-security-policy'), /sandbox/);

  // Signed out: a navigation goes to sign in and comes back; the API says 401.
  const anon = new Browser(h.base);
  const nav = await anon.req(ws.base);
  assert.equal(nav.status, 303);
  assert.equal(nav.headers.get('location'), `/hub/login?next=${encodeURIComponent(`/w/${team}/desk`)}`);
  assert.equal((await anon.req(`${ws.base}api/overview`)).status, 401);
  // ?token= never reaches the page here (a link cannot sign a tab into another workspace).
  const withToken = await alice.req(`${ws.base}?token=gws_x&a=1`);
  assert.equal(withToken.status, 303);
  assert.equal(withToken.headers.get('location'), `${ws.base}?a=1`);
  // Cross-site reads and writes from the browser are refused.
  assert.equal((await alice.req(`${ws.base}api/overview`, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' } })).status, 403);
  assert.equal((await alice.req(`${ws.base}api/overview`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  await alice.req(`${ws.base}api/overview`);
  const evil = await alice.req(`${ws.base}fs/x.txt`, { method: 'PUT', body: 'x', origin: 'https://evil.example', headers: { 'X-Grapim-Csrf': alice.wsCsrf } });
  assert.equal(evil.status, 403);
  const sibling = await alice.req(`${ws.base}fs/x.txt`, { method: 'PUT', body: 'x', headers: { 'X-Grapim-Csrf': alice.wsCsrf, 'Sec-Fetch-Site': 'same-site' } });
  assert.equal(sibling.status, 403);
  assert.equal(fs.existsSync(path.join(h.dir, 'workspaces', team, ws.id, 'x.txt')), false);
});

test('a read token reads, and gets 403 on every write and act route, MCP write tools included', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'ro-alice');
  const team = await createTeam(alice, 'Read Only');
  const ws = await createWorkspace(alice, team, 'ro');
  const writer = await createWsToken(alice, ws, 'writer');
  const reader = await createWsToken(alice, ws, 'reader', 'read');
  assert.equal((await agent(h, writer, `${ws.base}fs/a.txt`, { method: 'PUT', body: 'a\n', headers: { 'X-Grapim-Agent': 'w' } })).status, 200);
  const dir = path.join(h.dir, 'workspaces', team, ws.id);

  assert.equal((await agent(h, reader, `${ws.base}fs/a.txt`)).text, 'a\n');
  assert.equal((await agent(h, reader, `${ws.base}fs/`)).status, 200);
  assert.equal((await agent(h, reader, `${ws.base}api/runs`)).status, 200);
  assert.equal((await agent(h, reader, `${ws.base}api/overview`)).status, 200);

  const run = encodeURIComponent('http:writer/w');
  const sha = sha1('a\n');
  const writes = [
    ['PUT', 'fs/a.txt', 'changed'],
    ['PUT', 'fs/new.txt', 'new'],
    ['DELETE', 'fs/a.txt'],
    ['POST', 'fs/_release'],
    ['POST', `api/runs/${run}/undo`, JSON.stringify({ apply: true })],
    ['POST', `api/runs/${run}/undo`, JSON.stringify({ apply: false })],
    ['POST', `api/runs/${run}/review`, JSON.stringify({ status: 'rejected' })],
    ['POST', `api/runs/${run}/branch`, '{}'],
    ['POST', 'api/files/restore', JSON.stringify({ path: 'a.txt', sha, apply: true })],
  ];
  for (const [method, p, body] of writes) {
    const r = await agent(h, reader, ws.base + p, { method, body, headers: { 'Content-Type': 'application/json', 'X-Grapim-Agent': 'r' } });
    assert.equal(r.status, 403, `${method} ${p}: ${r.text}`);
    assert.match(r.json().error.message, /read-only/);
  }
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(fs.existsSync(path.join(dir, 'new.txt')), false);
  const runs = (await agent(h, writer, `${ws.base}api/runs`)).json();
  assert.equal(runs.find((r) => r.run === 'http:writer/w').review.status, 'pending');

  // MCP: initialize and read tools work; every write tool is 403, and nothing runs.
  const i = await mcp(h, reader, ws.base, init);
  assert.equal(i.status, 200, i.text);
  const sid = i.session;
  const read = await mcp(h, reader, ws.base, call(2, 'read_file', { path: 'a.txt' }), { session: sid });
  assert.equal(read.json().result.content[0].text, 'a\n');
  assert.equal((await mcp(h, reader, ws.base, call(3, 'list_runs', {}), { session: sid })).status, 200);
  for (const [name, args] of [
    ['write_file', { path: 'a.txt', content: 'pwned' }],
    ['delete_file', { path: 'a.txt' }],
    ['claim_files', { paths: ['a.txt'] }],
    ['release_files', {}],
    ['set_intent', { intent: 'x' }],
  ]) {
    const r = await mcp(h, reader, ws.base, call(4, name, args), { session: sid });
    assert.equal(r.status, 403, `${name}: ${r.text}`);
    assert.equal(r.json().error.code, -32003);
  }
  // A batch hiding a write behind a read is refused as a whole.
  const batch = await mcp(h, reader, ws.base, [call(5, 'read_file', { path: 'a.txt' }), call(6, 'write_file', { path: 'b.txt', content: 'x' })], { session: sid });
  assert.equal(batch.status, 403);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(fs.existsSync(path.join(dir, 'b.txt')), false);
});

test('MCP over HTTP at the workspace path: initialize, write_file, list_runs', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'mcp-alice');
  const team = await createTeam(alice, 'Mcp');
  const ws = await createWorkspace(alice, team, 'agents');
  const token = await createWsToken(alice, ws, 'e2b');

  const i = await mcp(h, token, ws.base, init, { agentName: 'sandbox-1' });
  assert.equal(i.status, 200, i.text);
  assert.equal(i.json().result.serverInfo.name, 'grapim');
  assert.ok(i.session);
  const tools = (await mcp(h, token, ws.base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { session: i.session, agentName: 'sandbox-1' })).json().result.tools.map((x) => x.name);
  assert.ok(tools.includes('write_file') && tools.includes('list_runs'));
  const w = await mcp(h, token, ws.base, call(3, 'write_file', { path: 'src/hello.py', content: 'print("hi")\n', intent: 'Say hi' }), { session: i.session, agentName: 'sandbox-1' });
  assert.equal(w.status, 200, w.text);
  assert.ok(!w.json().result.isError, w.text);
  assert.equal(fs.readFileSync(path.join(h.dir, 'workspaces', team, ws.id, 'src', 'hello.py'), 'utf8'), 'print("hi")\n');
  const runs = await mcp(h, token, ws.base, call(4, 'list_runs', {}), { session: i.session, agentName: 'sandbox-1' });
  assert.match(runs.json().result.content[0].text, /e2b\/sandbox-1/);
  assert.ok((await agent(h, token, `${ws.base}api/runs`)).json().some((r) => r.run === 'http:e2b/sandbox-1'));
  // GET /mcp is 405 as in grapim serve; a session id from another workspace is unknown here.
  assert.equal((await agent(h, token, `${ws.base}mcp`)).status, 405);
  const del = await agent(h, token, `${ws.base}mcp`, { method: 'DELETE', headers: { 'Mcp-Session-Id': i.session } });
  assert.equal(del.status, 204);
});

// ---------------------------------------------------------------- isolation

// Every route the mounted engine serves, with a body where it takes one.
function engineRoutes(run, sha) {
  return [
    ['GET', ''],
    ['GET', 'app.js'],
    ['GET', 'api/overview'],
    ['GET', 'api/runs'],
    ['GET', `api/runs/${run}`],
    ['GET', 'api/blame?path=secret.txt&full=1'],
    ['GET', 'api/files?path='],
    ['GET', 'api/files?path=&recursive=1'],
    ['GET', 'api/files/history?path=secret.txt'],
    ['GET', `api/files/version?sha=${sha}`],
    ['GET', 'api/files/changes?after=0'],
    ['GET', 'api/events?after=0&latest=1'],
    ['GET', 'api/stream'],
    ['GET', 'fs/'],
    ['GET', 'fs/secret.txt'],
    ['PUT', 'fs/secret.txt', 'overwritten'],
    ['PUT', 'fs/planted.txt', 'planted'],
    ['DELETE', 'fs/secret.txt'],
    ['POST', 'fs/_release'],
    ['POST', `api/runs/${run}/undo`, JSON.stringify({ apply: true })],
    ['POST', `api/runs/${run}/review`, JSON.stringify({ status: 'rejected' })],
    ['POST', `api/runs/${run}/branch`, '{}'],
    ['POST', 'api/files/restore', JSON.stringify({ path: 'secret.txt', sha, apply: true })],
    ['POST', 'mcp', JSON.stringify(init)],
    ['DELETE', 'mcp'],
  ];
}

test('IDOR: team B (session and tokens) and a wrong-workspace token get 404 on every workspace route of team A', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'idor-alice');
  const mallory = await signIn(h, 'idor-mallory');
  const A = await createTeam(alice, 'Alpha Corp');
  const M = await createTeam(mallory, 'Mallory Corp');
  // Team A gets the team plan, for a second workspace.
  h.hub.db.prepare("UPDATE teams SET plan = 'team' WHERE id = ?").run(A);
  const wsA = await createWorkspace(alice, A, 'alpha-private');
  const wsA2 = await createWorkspace(alice, A, 'alpha-other');
  const wsM = await createWorkspace(mallory, M, 'mallory-ws');
  const aToken = await createWsToken(alice, wsA, 'alpha-writer');
  const a2Token = await createWsToken(alice, wsA2, 'alpha2-writer');
  const mToken = await createWsToken(mallory, wsM, 'mallory-writer');
  assert.equal((await agent(h, aToken, `${wsA.base}fs/secret.txt`, { method: 'PUT', body: 'alpha-secret-content\n', headers: { 'X-Grapim-Agent': 'bot' } })).status, 200);
  const run = encodeURIComponent('http:alpha-writer/bot');
  const sha = sha1('alpha-secret-content\n');
  const dirA = path.join(h.dir, 'workspaces', A, wsA.id);
  const LEAK = /alpha-secret-content|Alpha Corp|alpha-private|alpha-writer/;
  const snapshot = () =>
    JSON.stringify({
      files: fs.readdirSync(dirA).sort(),
      secret: fs.readFileSync(path.join(dirA, 'secret.txt'), 'utf8'),
      workspaces: h.hub.db.prepare('SELECT id, name, deleted_at FROM workspaces WHERE team_id = ? ORDER BY id').all(A),
      tokens: h.hub.db.prepare('SELECT id, revoked_at FROM workspace_tokens WHERE team_id = ? ORDER BY id').all(A),
    });
  const before = snapshot();

  const routes = engineRoutes(run, sha);
  await mallory.req(`${wsM.base}api/overview`); // Mallory's own desk CSRF token, for her session writes
  let checked = 0;
  for (const [method, sub, body] of routes) {
    const name = `${method} /${sub}`;
    const headers = { 'Content-Type': 'application/json', 'X-Grapim-Agent': 'evil' };
    // Mallory's session, with every browser credential she has.
    const viaSession = await agent(h, null, wsA.base + sub, { method, body, headers: { ...headers, Cookie: mallory.cookie(), Origin: ORIGIN, 'X-Grapim-Csrf': mallory.wsCsrf } });
    assert.equal(viaSession.status, 404, `mallory session ${name}: ${viaSession.status}`);
    assert.doesNotMatch(viaSession.text, LEAK, name);
    // Mallory's workspace token, on team A's workspace.
    const viaToken = await agent(h, mToken, wsA.base + sub, { method, body, headers });
    assert.equal(viaToken.status, 404, `mallory token ${name}: ${viaToken.status}`);
    assert.doesNotMatch(viaToken.text, LEAK, name);
    // A token of team A's other workspace.
    const wrongWs = await agent(h, a2Token, wsA.base + sub, { method, body, headers });
    assert.equal(wrongWs.status, 404, `other workspace's token ${name}: ${wrongWs.status}`);
    // Team A's workspace by name under Mallory's team, with her own token and session.
    const underM = await agent(h, mToken, `/w/${M}/alpha-private/${sub}`, { method, body, headers });
    assert.equal(underM.status, 404, `under team M ${name}`);
    const underMSession = await agent(h, null, `/w/${M}/alpha-private/${sub}`, { method, body, headers: { ...headers, Cookie: mallory.cookie(), Origin: ORIGIN, 'X-Grapim-Csrf': mallory.wsCsrf } });
    assert.equal(underMSession.status, 404, `under team M by session ${name}`);
    // A workspace that does not exist answers the same.
    assert.equal((await agent(h, mToken, `/w/${A}/no-such-ws/${sub}`, { method, body, headers })).status, 404);
    // A machine token (cmh_) or garbage is not a workspace token, whatever the URL.
    assert.equal((await agent(h, 'cmh_whatever', wsA.base + sub, { method, body, headers })).status, 401);
    checked++;
  }
  assert.equal(checked, routes.length);
  assert.equal(snapshot(), before, "team A's workspace is unchanged");
  assert.equal(fs.existsSync(path.join(dirA, 'planted.txt')), false);

  // Path tricks stay inside the mount: the team and name segments are matched raw.
  for (const p of [`/w/${A}/alpha-private/../alpha-other/fs/`, `/w/${A}/../${M}/mallory-ws/fs/`, `/w/${A}/ALPHA-PRIVATE/fs/`, `/w/${A}/alpha-private/fs/../../alpha-other/fs/x`]) {
    const r = await agent(h, aToken, p);
    assert.ok([400, 404].includes(r.status), `${p}: ${r.status}`);
    assert.doesNotMatch(r.text, /alpha-other|mallory/);
  }

  // Sent raw, ".." never climbs out of the workspace or into another one.
  for (const p of [`/w/${A}/alpha-private/../alpha-other/fs/`, `/w/${A}/alpha-private/fs/../../alpha-other/fs/x`, `/w/${A}/alpha-private/fs/../secret.txt`, `/w/${A}/alpha-private/fs/%2e%2e/secret.txt`, `/w/${A}/alpha-private/..%2falpha-other/fs/`, `/w/${A}/../${M}/mallory-ws/fs/`]) {
    const r = await rawRequest(h, p, { Authorization: `Bearer ${aToken}` });
    assert.ok([400, 404].includes(r.status), `${p}: ${r.status} ${r.text.slice(0, 200)}`);
    assert.doesNotMatch(r.text, /alpha-secret-content|mallory/);
  }

  // The hub pages of a workspace (enumerated from the router) are 404 to Mallory, and to her token.
  const fill = (pattern, ids) => pattern.replace(/:(\w+)/g, (_, k) => encodeURIComponent(ids[k]));
  const ids = { team: A, ws: wsA.id, wstoken: h.hub.db.prepare('SELECT id FROM workspace_tokens WHERE workspace_id = ?').get(wsA.id).id };
  const wsRoutes = h.hub.router.routes.filter((r) => r.pattern.includes('/workspaces'));
  assert.ok(wsRoutes.length >= 7, `workspace page routes: ${wsRoutes.length}`);
  for (const r of wsRoutes) {
    assert.ok(r.opts.team && r.opts.auth === 'session', `${r.pattern} is guarded`);
    if (r.pattern.includes(':ws')) assert.ok(r.opts.workspace, `${r.pattern} looks the workspace up inside the team`);
    if (r.method === 'POST') assert.ok(r.opts.csrf, `${r.pattern} is CSRF checked`);
    const p = fill(r.pattern, ids);
    const res = r.method === 'GET' ? await mallory.req(p) : await mallory.post(p, { name: 'evil-name', scope: 'write', confirm: 'alpha-private' });
    assert.equal(res.status, 404, `mallory ${r.method} ${r.pattern}: ${res.status}`);
    assert.doesNotMatch(res.text, LEAK);
    // Team A's workspace id under Mallory's own team.
    if (r.pattern.includes(':ws')) {
      const q = fill(r.pattern, { ...ids, team: M });
      const res2 = r.method === 'GET' ? await mallory.req(q) : await mallory.post(q, { name: 'evil-name', scope: 'write', confirm: 'alpha-private' });
      assert.equal(res2.status, 404, `mallory ${r.method} ${r.pattern} under her team`);
    }
  }
  assert.equal(snapshot(), before);
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM workspace_tokens WHERE workspace_id = ? AND revoked_at IS NULL').get(wsA.id).n, 1);
});

// ---------------------------------------------------------------- limits

test('the team storage quota counts workspace bytes and refuses an upload past it', async (t) => {
  const h = await startHub({ env: { HUB_TEAM_STORAGE_MB: '1' } });
  t.after(h.close);
  const alice = await signIn(h, 'quota-alice');
  const team = await createTeam(alice, 'Quota');
  const ws = await createWorkspace(alice, team, 'big');
  const token = await createWsToken(alice, ws, 'up');
  const used = () => h.hub.db.prepare('SELECT bytes FROM team_usage WHERE team_id = ?').get(team)?.bytes ?? 0;
  assert.ok(used() > 0, 'the new workspace folder counts');

  assert.equal((await agent(h, token, `${ws.base}fs/small.txt`, { method: 'PUT', body: 'x'.repeat(10_000), headers: { 'X-Grapim-Agent': 'a' } })).status, 200);
  const big = await agent(h, token, `${ws.base}fs/big.bin`, { method: 'PUT', body: Buffer.alloc(1024 * 1024 + 1), headers: { 'X-Grapim-Agent': 'a' } });
  assert.equal(big.status, 413, big.text);
  assert.equal(big.json().error.code, 'storage_limit');
  assert.equal(fs.existsSync(path.join(h.dir, 'workspaces', team, ws.id, 'big.bin')), false);
  // Through MCP too.
  const i = await mcp(h, token, ws.base, init, { agentName: 'a' });
  const w = await mcp(h, token, ws.base, call(2, 'write_file', { path: 'big.txt', content: 'y'.repeat(1024 * 1024) }), { session: i.session, agentName: 'a' });
  assert.equal(w.status, 413, w.text);
  assert.equal(fs.existsSync(path.join(h.dir, 'workspaces', team, ws.id, 'big.txt')), false);

  // Measured after the write settles: the small file is in the team's usage.
  await new Promise((r) => setTimeout(r, 1500));
  const row = h.hub.db.prepare('SELECT bytes FROM workspaces WHERE id = ?').get(ws.id);
  assert.ok(row.bytes > 10_000, `workspace bytes ${row.bytes}`);
  assert.ok(used() >= row.bytes);
});

test('rate limits apply to the workspace API per token', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'rate-alice');
  const team = await createTeam(alice, 'Rate');
  const ws = await createWorkspace(alice, team, 'rate');
  const token = await createWsToken(alice, ws, 'loop', 'read');
  for (let i = 0; i < 590; i++) h.hub.rate.hit(`workspace:t:${h.hub.db.prepare('SELECT id FROM workspace_tokens').get().id}`, 600, 60_000);
  let last;
  for (let i = 0; i < 12; i++) last = await agent(h, token, `${ws.base}api/overview`);
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
});

// ---------------------------------------------------------------- rename and delete

test('rename moves the address; soft delete needs the typed name, moves the folder to the trash, and every URL and token stops working', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'del-alice');
  const bob = await signIn(h, 'del-bob');
  const team = await createTeam(alice, 'Delete');
  const invite = (await alice.post(`/hub/teams/${team}/invites`)).text.match(/\/hub\/invite\/([A-Za-z0-9_-]+)/)[1];
  assert.equal((await bob.post('/hub/invite/accept', { token: invite })).status, 303);
  let ws = await createWorkspace(alice, team, 'old-name');
  const token = await createWsToken(alice, ws, 'tok');
  assert.equal((await agent(h, token, `${ws.base}fs/a.txt`, { method: 'PUT', body: 'a', headers: { 'X-Grapim-Agent': 'x' } })).status, 200);

  const renamed = await bob.post(`/hub/teams/${team}/workspaces/${ws.id}/rename`, { name: 'new-name' });
  assert.equal(renamed.status, 303, renamed.text);
  assert.equal((await agent(h, token, `${ws.base}fs/a.txt`)).status, 404, 'the old address is gone');
  ws = { ...ws, name: 'new-name', base: `/w/${team}/new-name/` };
  assert.equal((await agent(h, token, `${ws.base}fs/a.txt`)).text, 'a', 'the token keeps working at the new address');
  assert.equal((await bob.post(`/hub/teams/${team}/workspaces/${ws.id}/rename`, { name: 'Bad Name!' })).status, 400);

  // Only an owner deletes, and only with the exact name typed.
  assert.equal((await bob.post(`/hub/teams/${team}/workspaces/${ws.id}/delete`, { confirm: 'new-name' })).status, 403);
  const wrong = await alice.post(`/hub/teams/${team}/workspaces/${ws.id}/delete`, { confirm: 'new-nam' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.text, /Type new-name exactly/);
  assert.equal((await agent(h, token, `${ws.base}api/overview`)).status, 200);

  const dir = path.join(h.dir, 'workspaces', team, ws.id);
  const del = await alice.post(`/hub/teams/${team}/workspaces/${ws.id}/delete`, { confirm: 'new-name' });
  assert.equal(del.status, 200, del.text);
  assert.equal(fs.existsSync(dir), false);
  const trashed = fs.readdirSync(path.join(h.dir, 'trash', team));
  assert.equal(trashed.length, 1);
  assert.equal(fs.readFileSync(path.join(h.dir, 'trash', team, trashed[0], 'a.txt'), 'utf8'), 'a');
  assert.ok(h.hub.db.prepare('SELECT deleted_at FROM workspaces WHERE id = ?').get(ws.id).deleted_at);

  for (const sub of ['', 'api/overview', 'fs/a.txt', 'app.js']) assert.equal((await alice.req(ws.base + sub)).status, 404, `session ${sub}`);
  assert.equal((await agent(h, token, `${ws.base}fs/a.txt`)).status, 401, 'the token is revoked');
  assert.equal((await alice.req(`/hub/teams/${team}/workspaces/${ws.id}`)).status, 404);
  // The name is free again (the free plan's one workspace was released).
  const again = await createWorkspace(alice, team, 'new-name');
  assert.notEqual(again.id, ws.id);
  assert.equal((await agent(h, token, `${again.base}fs/`)).status, 401);
});

// ---------------------------------------------------------------- storage

test('storage wiring: writes are persisted write-behind with a manifest, and a missing folder is restored on boot', async (t) => {
  const storage = fakeStorage();
  const dataDir = tmp('grapim-ws-store-');
  const gh = fakeGitHub();
  let h = await startHub({ dir: dataDir, storage, gh });
  t.after(h.close);
  const alice = await signIn(h, 'store-alice');
  const team = await createTeam(alice, 'Store');
  const ws = await createWorkspace(alice, team, 'kept');
  const token = await createWsToken(alice, ws, 'w');
  assert.equal((await agent(h, token, `${ws.base}fs/docs/a.md`, { method: 'PUT', body: '# A\n', headers: { 'X-Grapim-Agent': 'x' } })).status, 200);
  assert.equal((await agent(h, token, `${ws.base}fs/b.bin`, { method: 'PUT', body: Buffer.from([0, 1, 2, 3]), headers: { 'X-Grapim-Agent': 'x' } })).status, 200);
  const wsKey = `${team}/${ws.id}`;

  // Write-behind: the request did not wait; the blob arrives right after.
  await h.hub.mount.storage.flush();
  assert.ok(storage.map.has(`ws/${wsKey}/blobs/${sha1('# A\n')}`), [...storage.map.keys()].join('\n'));
  assert.ok(storage.map.has(`ws/${wsKey}/blobs/${sha1(Buffer.from([0, 1, 2, 3]))}`));
  const manifest = JSON.parse(storage.map.get(`ws/${wsKey}/manifest.json`).toString('utf8'));
  assert.deepEqual(manifest.files, { 'b.bin': sha1(Buffer.from([0, 1, 2, 3])), 'docs/a.md': sha1('# A\n') });
  assert.match(manifest.head, /^[0-9a-f]{40}$/);
  assert.ok(Object.keys(manifest.files).every((p) => !p.startsWith('.git')));
  await h.close();

  // The volume lost the folder: the next boot rebuilds it from storage.
  const dir = path.join(dataDir, 'workspaces', team, ws.id);
  fs.rmSync(dir, { recursive: true, force: true });
  h = await startHub({ dir: dataDir, storage, gh });
  t.after(h.close);
  await h.hub.restored;
  assert.equal(fs.readFileSync(path.join(dir, 'docs', 'a.md'), 'utf8'), '# A\n');
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'b.bin'))], [0, 1, 2, 3]);
  assert.ok(fs.existsSync(path.join(dir, '.git')), 'a git repo again');
  assert.ok(h.logs.some((l) => /restored from storage \(2 files\)/.test(l)), h.logs.join('\n'));
  assert.equal((await agent(h, token, `${ws.base}fs/docs/a.md`)).text, '# A\n');
});

test('storage defaults to a folder in HUB_DATA, and can be switched off', async (t) => {
  const h = await startHub({ storage: 'default' });
  t.after(h.close);
  assert.ok(h.logs.some((l) => /workspace storage: the local folder/.test(l)), h.logs.join('\n'));
  const alice = await signIn(h, 'default-store');
  const team = await createTeam(alice, 'Default Store');
  const ws = await createWorkspace(alice, team, 'files');
  const token = await createWsToken(alice, ws, 'w');
  assert.equal((await agent(h, token, `${ws.base}fs/x.txt`, { method: 'PUT', body: 'x', headers: { 'X-Grapim-Agent': 'a' } })).status, 200);
  await h.hub.mount.storage.flush();
  assert.ok(fs.existsSync(path.join(h.dir, 'storage')), 'file:// storage under HUB_DATA');

  const off = await startHub();
  t.after(off.close);
  assert.equal(off.hub.mount.storage, null, 'storage: null switches it off; workspaces still work');
});
