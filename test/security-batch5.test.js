// Security review batch 5 (docs/security-review-mount-scopes-storage-notion-2026-11-11.md):
// regression tests for WebDAV mounting, path-scoped tokens, bring-your-own
// storage and the Notion connector. Each test names the finding it covers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createQueue, createSync } from '../src/connectors/index.js';
import { createConnectors } from '../src/hub/connectors.js';
import { sealer } from '../src/hub/platform/util.js';
import { createHub } from '../src/hub/server.js';
import { createTeamStorage } from '../src/hub/team-storage.js';
import { createEngine } from '../src/server/engine.js';
import { MAX_LOCKS_PER_AGENT } from '../src/server/webdav.js';
import { createStorage } from '../src/storage/index.js';

const ORIGIN = 'http://localhost:7999';
const SECRET = 'test-secret-that-is-long-enough-0123456789';
const WIN_UA = 'Microsoft-WebDAV-MiniRedir/10.0.26100';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const tick = () => new Promise((r) => setTimeout(r, 20));
const LOCK_BODY = `<?xml version="1.0" encoding="utf-8" ?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>me</D:href></D:owner></D:lockinfo>`;

function repo() {
  const dir = tmp('grapim-b5-');
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '--quiet', '--template=']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  return dir;
}

function request(port, method, target, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// One engine (no hub) on a local port; opts go to createEngine.
async function engineServer(t, opts = {}) {
  const dir = repo();
  const engine = createEngine({ cwd: dir, env: {}, ...opts });
  const server = http.createServer((req, res) => engine.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    engine.close();
  });
  return { dir, engine, port: server.address().port };
}

// ---------------------------------------------------------------- the hub (as in test/scopes.test.js)

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

async function startHub(t) {
  const gh = fakeGitHub();
  const hub = await createHub({
    env: { HUB_URL: ORIGIN, HUB_SECRET: SECRET, HUB_DATA: tmp('grapim-b5-hub-'), GITHUB_CLIENT_ID: 'gh-client', GITHUB_CLIENT_SECRET: 'gh-secret' },
    fetch: gh.fetch,
    billing: null,
    storage: null,
    log: () => {},
    platform: { resolve: async () => [{ address: '93.184.216.34', family: 4 }], transport: async () => ({ status: 200 }), worker: false },
  });
  const addr = await hub.listen(0, '127.0.0.1');
  t.after(() => hub.close());
  return { hub, port: addr.port, base: `http://127.0.0.1:${addr.port}`, gh };
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
      this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return { status: res.status, headers: res.headers, text: await res.text() };
  }
  async post(p, form = {}) {
    const csrf = JSON.parse((await this.req('/hub/api/me')).text).csrf;
    return this.req(p, { method: 'POST', form: { _csrf: csrf, ...form } });
  }
}

let nextId = 9500;
// A signed-in owner, a team, a workspace and an unscoped write token "full".
async function workspace(h, login) {
  const id = nextId++;
  h.gh.user(`code-${id}`, { id, login, name: login, avatar_url: null });
  const b = new Browser(h.base);
  const start = await b.req('/hub/auth/github');
  await b.req(`/hub/auth/callback?code=code-${id}&state=${new URL(start.headers.get('location')).searchParams.get('state')}`);
  const team = (await b.post('/hub/teams', { name: `${login} team` })).headers.get('location').match(/\/hub\/teams\/([^/?#]+)/)[1];
  const wsId = (await b.post(`/hub/teams/${team}/workspaces`, { name: 'shared' })).headers.get('location').match(/\/workspaces\/([^/]+)$/)[1];
  const ws = { id: wsId, team, base: `/w/${team}/shared/` };
  const token = async (name, scope, rows = []) => {
    const form = { name, scope };
    rows.forEach(([p, access], i) => {
      form[`scope_path_${i}`] = p;
      form[`scope_access_${i}`] = access;
    });
    const r = await b.post(`/hub/teams/${team}/workspaces/${wsId}/tokens`, form);
    assert.equal(r.status, 200, r.text);
    return r.text.match(/value="(gws_[A-Za-z0-9_-]+)"/)[1];
  };
  const full = await token('full', 'write');
  const put = async (p, body, who) => {
    const r = await request(h.port, 'PUT', `${ws.base}fs/${p}`, { headers: { Authorization: `Bearer ${full}`, 'X-Grapim-Agent': who }, body });
    assert.equal(r.status, 200, r.text);
    await request(h.port, 'POST', `${ws.base}fs/_release`, { headers: { Authorization: `Bearer ${full}`, 'X-Grapim-Agent': who } });
  };
  return { ws, full, token, put };
}

const basic = (token) => `Basic ${Buffer.from(`grapim:${token}`).toString('base64')}`;
const dav = (h, ws, token) => (method, p, headers = {}, body) =>
  request(h.port, method, `${ws.base}dav/${p}`, { headers: { 'User-Agent': WIN_UA, Authorization: basic(token), ...headers }, body });

// ---------------------------------------------------------------- WebDAV

test('M1: COPY of a folder never names a file inside it that the token cannot read', async (t) => {
  const h = await startHub(t);
  const { ws, token, put } = await workspace(h, 'b5-copy');
  await put('docs/open.md', 'open\n', 'w');
  await put('docs/secret-plan.txt', 'hidden\n', 'w');
  await put('pub/keep.txt', 'k\n', 'w');
  const limited = await token('limited', 'write', [
    ['docs/open.md', 'read'],
    ['pub/**', 'write'],
  ]);
  const send = dav(h, ws, limited);
  // The folder itself is on the way to a rule, so it may be read and listed (without the secret).
  const list = await send('PROPFIND', 'docs/', { Depth: '1' });
  assert.equal(list.status, 207);
  assert.doesNotMatch(list.text, /secret-plan/);
  const r = await send('COPY', 'docs', { Destination: `${ws.base}dav/pub/docs2` });
  assert.equal(r.status, 403, r.text);
  assert.doesNotMatch(r.text, /secret-plan/, 'the refusal does not name the hidden file');
  assert.equal((await send('GET', 'pub/docs2/open.md')).status, 404, 'nothing was copied');
  // A file of the folder it can read still copies one by one.
  assert.equal((await send('COPY', 'docs/open.md', { Destination: `${ws.base}dav/pub/open.md` })).status, 201);
});

test('L1: PUT and LOCK answer the same for a folder outside the scope as for a missing name', async (t) => {
  const h = await startHub(t);
  const { ws, token, put } = await workspace(h, 'b5-oracle');
  await put('secret/x.txt', 'x\n', 'w');
  const limited = await token('docsonly', 'write', [['docs/**', 'write']]);
  const send = dav(h, ws, limited);
  for (const method of ['PUT', 'LOCK']) {
    const body = method === 'LOCK' ? LOCK_BODY : 'data';
    const folder = await send(method, 'secret', {}, body);
    const missing = await send(method, 'no-such-name', {}, body);
    assert.equal(folder.status, 403, `${method} secret: ${folder.text}`);
    assert.equal(folder.status, missing.status, method);
  }
});

test('M2: a drive holds at most MAX_LOCKS_PER_AGENT locks; a LOCK that creates a file counts toward the file cap', async (t) => {
  const { port } = await engineServer(t);
  const lock = (p) => request(port, 'LOCK', `/dav/${p}`, { headers: { 'User-Agent': WIN_UA, Timeout: 'Second-600' }, body: LOCK_BODY });
  for (let i = 0; i < MAX_LOCKS_PER_AGENT; i++) {
    const r = await lock(`f${i}.txt`);
    assert.ok(r.status === 201 || r.status === 200, r.text);
  }
  const over = await lock('one-more.txt');
  assert.equal(over.status, 423, over.text);

  // The file cap: admit() refuses the new file, and nothing is created.
  let asked = 0;
  const capped = await engineServer(t, {
    admit: (req, { files }) => {
      asked += files;
      const e = new Error('This workspace holds 1 files, the most one workspace can have.');
      e.status = 413;
      e.code = 'too_large';
      throw e;
    },
  });
  const r = await request(capped.port, 'LOCK', '/dav/new.txt', { headers: { 'User-Agent': WIN_UA }, body: LOCK_BODY });
  assert.equal(r.status, 413, r.text);
  assert.equal(asked, 1);
  assert.equal(fs.existsSync(path.join(capped.dir, 'new.txt')), false);
});

test('M3: desktop junk files are capped in total bytes per workspace engine', async (t) => {
  const { port, engine } = await engineServer(t);
  const body = Buffer.alloc(256 * 1024, 1);
  for (let i = 0; i < 40; i++) {
    const r = await request(port, 'PUT', `/dav/._junk${i}`, { headers: { 'User-Agent': WIN_UA }, body });
    assert.equal(r.status, 201, r.text);
  }
  const kept = [...engine.ctx.dav.junk.values()];
  const total = kept.reduce((n, j) => n + j.buf.length, 0);
  assert.ok(total <= 4 * 1024 * 1024, `junk holds ${total} bytes`);
  assert.ok(kept.some((j) => j.rel === '._junk39'), 'the newest is kept');
});

// ---------------------------------------------------------------- scopes

test('L2: review notes of runs outside the scope do not reach a scoped token through /api/events or MCP', async (t) => {
  const h = await startHub(t);
  const { ws, full, token, put } = await workspace(h, 'b5-events');
  await put('docs/a.md', 'a\n', 'writer');
  await put('code/x.js', 'x\n', 'coder');
  const auth = (tk) => ({ Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' });
  const rev = (run, note) => request(h.port, 'POST', `${ws.base}api/runs/${encodeURIComponent(run)}/review`, { headers: auth(full), body: JSON.stringify({ status: 'rejected', note }) });
  assert.equal((await rev('http:full/coder', 'the coder leaked the launch codes')).status, 200);
  assert.equal((await rev('http:full/writer', 'docs look fine')).status, 200);
  const limited = await token('reader', 'read', [['docs/**', 'read']]);

  const ev = await request(h.port, 'GET', `${ws.base}api/events?limit=1000`, { headers: auth(limited) });
  assert.equal(ev.status, 200, ev.text);
  assert.doesNotMatch(ev.text, /launch codes/);
  assert.match(ev.text, /docs look fine/, 'a review of a run it can see still shows');
  assert.doesNotMatch(ev.text, /http:full\/coder/);

  const mcp = async (messages, session) =>
    request(h.port, 'POST', `${ws.base}mcp`, { headers: { ...auth(limited), Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify(messages) });
  const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 't' }, capabilities: {} } });
  const session = init.headers['mcp-session-id'];
  const act = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recent_activity', arguments: { limit: 200 } } }, session);
  assert.equal(act.status, 200, act.text);
  assert.doesNotMatch(act.text, /launch codes/);
});

// ---------------------------------------------------------------- Notion

const NOTION_TOKEN = `ntn_${'a1'.repeat(20)}`;

// createConnectors against a hub of stubs: three connected workspaces, a
// Notion whose search answers only when released.
function stubHub() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY)');
  const stateDir = tmp('grapim-b5-state-');
  const opened = [];
  const hub = {
    db,
    log: () => {},
    now: () => Date.now(),
    config: { secret: SECRET },
    workspaces: { byId: (team, id) => ({ id, team_id: team, name: id }), storageKey: (ws) => `${ws.team_id}/${ws.id}` },
    mount: {
      engineFor: (ws) => {
        opened.push(ws.id);
        return { store: null, ws: { stateDir: path.join(stateDir, ws.id), root: stateDir }, use: (fn) => fn() };
      },
      admit: () => {},
      measureSoon: () => {},
      storage: null,
    },
  };
  return { hub, db, opened };
}

test('M4: Notion pulls run at most maxPulls at a time hub wide, and a waiting pull holds no engine', async (t) => {
  const { hub, db, opened } = stubHub();
  const held = [];
  const fetch = (url) => {
    assert.match(String(url), /\/search$/);
    return new Promise((resolve) => held.push(() => resolve(new Response(JSON.stringify({ results: [], has_more: false }), { status: 200 }))));
  };
  const c = createConnectors(hub, { schedule: false, maxPulls: 2, notion: { fetch, queue: createQueue({ perSecond: 1000 }) } });
  const seal = sealer(SECRET, 'grapim connector seal v1');
  for (const id of ['w1', 'w2', 'w3']) {
    db.prepare('INSERT INTO workspaces (id) VALUES (?)').run(id);
    db.prepare('INSERT INTO workspace_connectors (workspace_id, team_id, connector, secret, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'team1', 'notion', seal.seal(NOTION_TOKEN, `workspace_connectors\nteam1\n${id}\nnotion`), 1, Date.now());
  }
  const pulls = ['w1', 'w2', 'w3'].map((id) => c.pull(id, 'notion'));
  await tick();
  assert.equal(held.length, 2, 'two pulls reach Notion; the third waits');
  assert.deepEqual(opened, ['w1', 'w2'], 'the waiting pull has not opened its engine');
  held.shift()();
  await tick();
  assert.equal(held.length, 2, 'the third starts once a slot is free');
  assert.deepEqual(opened, ['w1', 'w2', 'w3']);
  for (const go of held.splice(0)) go();
  const out = await Promise.all(pulls);
  assert.ok(out.every((s) => s && s.errors.length === 0));
  await c.close();
});

test('M5: an agent write under saas/notion/ does not wait out a long pull; it answers "queued" and is pushed after', async (t) => {
  const stateDir = tmp('grapim-b5-sync-');
  let releasePull;
  const pushed = [];
  const connector = {
    describe: () => ({ name: 'notion', title: 'Notion' }),
    pull: () => new Promise((resolve) => (releasePull = () => resolve({ items: [], present: null, cursor: null }))),
    push: async (entry, content) => {
      pushed.push(content);
      return { version: 'v2', remote: content, ops: { updated: 1, added: 0, archived: 0 } };
    },
  };
  const sync = createSync({ connector, waitMs: 50 });
  const h = { ws: { stateDir, root: stateDir }, store: null };
  const pulling = sync.pull(h);
  await tick();
  const started = Date.now();
  const r = await Promise.race([sync.afterWrite(h, { path: 'saas/notion/page--12345678.md', run: 'http:t/a' }), new Promise((res) => setTimeout(() => res('hung'), 2000))]);
  assert.notEqual(r, 'hung', 'the write answered while the pull was still running');
  assert.equal(r.status, 'queued');
  assert.ok(Date.now() - started < 1500);
  releasePull();
  await pulling;
  await tick();
});

// ---------------------------------------------------------------- storage

test('L4: the probe key is deleted even when the put fails after the object landed', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE teams (id TEXT PRIMARY KEY)');
  const ts = createTeamStorage({ db, log: () => {}, config: { secret: SECRET } });
  const objects = new Map();
  const store = {
    put: async (k, buf) => {
      objects.set(k, buf);
      throw Object.assign(new Error('timed out after 10000 ms'), { code: 'timeout' });
    },
    get: async (k) => objects.get(k) ?? null,
    has: async (k) => objects.has(k),
    list: async () => [...objects.keys()],
    delete: async (k) => void objects.delete(k),
  };
  await assert.rejects(ts.probe(store, {}), /writing a test object failed/);
  assert.equal(objects.size, 0, 'no probe object is left in the bucket');
});

test('L5: an S3 or Azure error code from an untrusted endpoint never carries free text into errors and logs', async () => {
  const reply = (body) => async () => new Response(body, { status: 403, headers: { 'content-type': 'application/xml' } });
  const evil = '<Error><Code>AccessDenied\nFAKE LOG LINE: storage switched to attacker</Code></Error>';
  const s3 = createStorage('s3://bucket-one?endpoint=https%3A%2F%2Fs3.example.com&region=us-east-1', { GRAPIM_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE', GRAPIM_S3_SECRET_ACCESS_KEY: 'secretsecret' }, { fetch: reply(evil), retry: { retries: 0 } });
  const e1 = await s3.get('ws/x').catch((e) => e);
  assert.doesNotMatch(e1.message, /FAKE LOG LINE|\n/);
  assert.match(e1.message, /HTTP 403/);
  const az = createStorage('azure://acct01/container-one?endpoint=https%3A%2F%2Facct01.blob.core.windows.net', { GRAPIM_AZURE_ACCOUNT_KEY: Buffer.alloc(64, 7).toString('base64') }, { fetch: reply(evil), retry: { retries: 0 } });
  const e2 = await az.get('ws/x').catch((e) => e);
  assert.doesNotMatch(e2.message, /FAKE LOG LINE|\n/);
  // A well-formed code still shows.
  const ok = createStorage('s3://bucket-one?endpoint=https%3A%2F%2Fs3.example.com&region=us-east-1', { GRAPIM_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE', GRAPIM_S3_SECRET_ACCESS_KEY: 'secretsecret' }, { fetch: reply('<Error><Code>AccessDenied</Code></Error>'), retry: { retries: 0 } });
  assert.match((await ok.get('ws/x').catch((e) => e)).message, /HTTP 403 AccessDenied/);
});
