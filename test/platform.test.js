// The platform API (docs/platform.md): platforms and their keys, every /v1
// endpoint, pagination, idempotency, workspace tokens with a TTL and a pinned
// agent, embed sessions, webhooks (signing, retries, disabling, SSRF),
// metering, test-mode caps, and isolation between two platforms on every
// /v1 route, enumerated from the router. An in-process hub with GitHub
// mocked, an injected clock, DNS resolver and webhook transport.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLATFORM_PRICES } from '../src/hub/billing.js';
import { createHub } from '../src/hub/server.js';
import { isBlockedAddress } from '../src/hub/platform/ssrf.js';
import { BACKOFF_MS } from '../src/hub/platform/webhooks.js';

const ORIGIN = 'http://localhost:7999';
const APP = 'https://app.example.com';
const DAY = 24 * 60 * 60 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const settle = () => new Promise((r) => setTimeout(r, 120));

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

// DNS: every name is public unless the test says otherwise.
function fakeDns() {
  const names = new Map();
  const resolve = async (host) => {
    if (names.has(host)) return names.get(host).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    return [{ address: '93.184.216.34', family: 4 }];
  };
  return { resolve, set: (host, ...addrs) => names.set(host, addrs) };
}

// The webhook receiver: records every delivery, answers `status`.
function fakeReceiver() {
  const calls = [];
  const r = {
    calls,
    status: 200,
    transport: async (target, { headers, body }) => {
      calls.push({ url: target.url.toString(), address: target.address, headers, body });
      return { status: typeof r.status === 'function' ? r.status() : r.status };
    },
  };
  return r;
}

async function startHub({ env = {} } = {}) {
  const gh = fakeGitHub();
  const dns = fakeDns();
  const receiver = fakeReceiver();
  const clock = { t: Date.now() };
  const logs = [];
  const dir = tmp('grapim-pf-hub-');
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
    storage: null,
    now: () => clock.t,
    log: (l) => logs.push(l),
    platform: { resolve: dns.resolve, transport: receiver.transport, worker: false },
  });
  const addr = await hub.listen(0, '127.0.0.1');
  return { hub, base: `http://127.0.0.1:${addr.port}`, gh, dns, receiver, clock, logs, dir, close: () => hub.close() };
}

class Browser {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async req(p, { method = 'GET', form = null, headers = {} } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.Cookie = this.cookie();
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
  const cb = await b.req(`/hub/auth/callback?code=code-${id}&state=${state}`);
  assert.equal(cb.status, 303, cb.text);
  b.user = { id, login };
  return b;
}

async function createTeam(b, name) {
  const r = await b.post('/hub/teams', { name });
  assert.equal(r.status, 303, r.text);
  return r.headers.get('location').match(/\/hub\/teams\/([^/?#]+)/)[1];
}

async function createKey(b, team, name, mode) {
  const r = await b.post(`/hub/teams/${team}/platform/keys`, { name, mode });
  assert.equal(r.status, 200, r.text);
  return r.text.match(/value="(gpk_(?:live|test)_[A-Za-z0-9_-]+)"/)[1];
}

// A signed-in owner with a platform team and a live and a test key.
async function platform(h, login) {
  const owner = await signIn(h, login);
  const team = await createTeam(owner, `${login} Inc`);
  const on = await owner.post(`/hub/teams/${team}/platform`);
  assert.equal(on.status, 303, on.text);
  return { owner, team, live: await createKey(owner, team, 'backend', 'live'), test: await createKey(owner, team, 'ci', 'test') };
}

// A /v1 call. Each one moves the clock 50 ms, which refills the key's bucket
// by one, so long tests never trip the rate limit by accident.
async function api(h, key, method, p, body = undefined, headers = {}) {
  h.clock.t += 50;
  const hdr = { ...headers };
  if (key) hdr.Authorization = `Bearer ${key}`;
  if (body !== undefined) hdr['Content-Type'] = 'application/json';
  const res = await fetch(h.base + p, { method, headers: hdr, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

// An agent with a workspace token, at /w/....
async function agent(h, token, p, { method = 'GET', body = undefined, headers = {} } = {}) {
  const hdr = { ...headers };
  if (token) hdr.Authorization = `Bearer ${token}`;
  const res = await fetch(h.base + p, { method, headers: hdr, body, redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
}

const wsPath = (ws) => new URL(ws.url).pathname;

function verify(body, header, secret) {
  const t = /t=(\d+)/.exec(header)[1];
  const v1 = /v1=([0-9a-f]{64})/.exec(header)[1];
  const want = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(want, 'hex'));
}

// ---------------------------------------------------------------- keys

test('platforms are gated by HUB_TEAM_CREATORS, and keys are shown once, hashed, used and revocable', async (t) => {
  const h = await startHub({ env: { HUB_TEAM_CREATORS: 'pf-alice' } });
  t.after(h.close);
  const alice = await signIn(h, 'pf-alice');
  const team = await createTeam(alice, 'Agents Co');
  const page = await alice.req(`/hub/teams/${team}/platform`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Turn into a platform/);
  assert.match((await alice.req(`/hub/teams/${team}/settings/general`)).text, /\/platform">Set it up/);
  // Keys need a platform first.
  assert.equal((await alice.post(`/hub/teams/${team}/platform/keys`, { name: 'x', mode: 'live' })).status, 409);

  // An owner who is not on the list cannot turn their team into a platform.
  const bob = await signIn(h, 'pf-bob');
  const bobTeam = h.hub.teams.create({ id: bob.user.id, login: 'pf-bob' }, 'Bob Co').id;
  const refused = await bob.post(`/hub/teams/${bobTeam}/platform`);
  assert.equal(refused.status, 403);
  assert.match(refused.text, /closed beta/);
  assert.equal(h.hub.teams.get(bobTeam).kind, 'team');

  assert.equal((await alice.post(`/hub/teams/${team}/platform`)).status, 303);
  assert.equal(h.hub.teams.get(team).kind, 'platform');
  assert.match((await alice.req(`/hub/teams/${team}`)).text, /href="\/hub\/teams\/[^"]+\/platform"/, 'the team tabs show Platform');

  const created = await alice.post(`/hub/teams/${team}/platform/keys`, { name: 'backend', mode: 'live' });
  const live = created.text.match(/value="(gpk_live_[A-Za-z0-9_-]{43})"/)[1];
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const test = await createKey(alice, team, 'ci', 'test');
  assert.match(test, /^gpk_test_/);
  const listed = await alice.req(`/hub/teams/${team}/platform`);
  assert.doesNotMatch(listed.text, /gpk_(live|test)_[A-Za-z0-9_-]{20,}/, 'shown once');
  const row = h.hub.db.prepare('SELECT * FROM platform_keys WHERE key_hash = ?').get(sha256(live));
  assert.equal(row.mode, 'live');
  assert.equal(row.hint, live.slice(-4));
  assert.equal(row.last_used_at, null);
  assert.equal(h.hub.db.prepare("SELECT COUNT(*) AS n FROM platform_keys WHERE key_hash LIKE 'gpk_%'").get().n, 0, 'never stored in clear');

  const ok = await api(h, live, 'GET', '/v1/workspaces');
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json, { object: 'list', data: [], has_more: false });
  assert.match(ok.headers.get('request-id'), /^req_/);
  assert.ok(h.hub.db.prepare('SELECT last_used_at FROM platform_keys WHERE id = ?').get(row.id).last_used_at);

  // Errors: the contract's shape, with the request id of the response.
  for (const bad of [null, 'gpk_live_nope', live.replace('gpk_live_', 'gpk_test_'), 'gws_x', 'cmh_x']) {
    const r = await api(h, bad, 'GET', '/v1/workspaces');
    assert.equal(r.status, 401, String(bad));
    assert.equal(r.json.error.code, 'unauthorized');
    assert.equal(r.json.error.request_id, r.headers.get('request-id'));
  }
  // A hub session is not an API credential.
  assert.equal((await fetch(`${h.base}/v1/workspaces`, { headers: { Cookie: alice.cookie() } })).status, 401);
  const unknown = await api(h, live, 'GET', '/v1/nothing');
  assert.equal(unknown.status, 404);
  assert.ok(unknown.json.error.request_id);

  // Revoked: 401 at once.
  assert.equal((await alice.post(`/hub/teams/${team}/platform/keys/${row.id}/revoke`)).status, 303);
  assert.equal((await api(h, live, 'GET', '/v1/workspaces')).status, 401);
  assert.equal((await api(h, test, 'GET', '/v1/workspaces')).status, 200);
});

test('rate limit: 50 requests at once per key, then 429 with Retry-After', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'pf-rate');
  const id = h.hub.db.prepare('SELECT id FROM platform_keys WHERE key_hash = ?').get(sha256(p.live)).id;
  let allowed = 0;
  while (h.hub.platform.limiter.take(id) === true) allowed++;
  assert.equal(allowed, 50);
  const r = await fetch(`${h.base}/v1/workspaces`, { headers: { Authorization: `Bearer ${p.live}` } });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal((await r.json()).error.code, 'rate_limited');
  // 20 a second sustained: one second later, 20 more.
  h.clock.t += 1000;
  let again = 0;
  while (h.hub.platform.limiter.take(id) === true) again++;
  assert.equal(again, 20);
  // Another key of the same platform has its own bucket.
  assert.equal((await api(h, p.test, 'GET', '/v1/workspaces')).status, 200);
});

// ---------------------------------------------------------------- endpoints

test('every endpoint: workspaces, tokens (TTL, pinned agent), runs, undo, embed sessions, usage, webhooks, settings, OpenAPI', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'pf-happy');

  // Create, with external_id and metadata.
  const c = await api(h, p.live, 'POST', '/v1/workspaces', { external_id: 'cust_1', metadata: { plan: 'pro', seats: 3 } });
  assert.equal(c.status, 200, c.text);
  const ws = c.json;
  assert.equal(ws.object, 'workspace');
  assert.equal(ws.external_id, 'cust_1');
  assert.deepEqual(ws.metadata, { plan: 'pro', seats: 3 });
  assert.equal(ws.livemode, true);
  assert.match(ws.name, /^ws-[a-z0-9]{10}$/);
  assert.equal(ws.url, `${ORIGIN}/w/${p.team}/${ws.name}/`);
  assert.equal(ws.mcp_url, `${ws.url}mcp`);
  assert.equal(ws.fs_url, `${ws.url}fs/`);
  assert.ok(ws.usage.bytes > 0, 'the git folder is measured');
  assert.equal(ws.usage.writes_30d, 0);
  assert.ok(fs.existsSync(path.join(h.dir, 'workspaces', p.team, ws.id, '.git')), 'a git repo');
  // external_id is unique among the platform's live workspaces.
  const dup = await api(h, p.live, 'POST', '/v1/workspaces', { external_id: 'cust_1' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'external_id_taken');
  assert.equal((await api(h, p.live, 'POST', '/v1/workspaces', { metadata: { x: 'y'.repeat(5000) } })).status, 400, 'metadata over 4 KB');
  assert.equal((await api(h, p.live, 'POST', '/v1/workspaces', { name: 'Bad Name' })).status, 400);
  assert.equal((await api(h, p.live, 'POST', '/v1/workspaces', { nope: 1 })).json.error.code, 'invalid_request');

  // Get, list with a filter, update.
  assert.equal((await api(h, p.live, 'GET', `/v1/workspaces/${ws.id}`)).json.id, ws.id);
  const other = (await api(h, p.live, 'POST', '/v1/workspaces', { external_id: 'cust_2', name: 'second' })).json;
  const filtered = await api(h, p.live, 'GET', '/v1/workspaces?external_id=cust_2');
  assert.deepEqual(filtered.json.data.map((w) => w.id), [other.id]);
  const patched = await api(h, p.live, 'PATCH', `/v1/workspaces/${other.id}`, { name: 'renamed', metadata: { a: 1 } });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.name, 'renamed');
  assert.deepEqual(patched.json.metadata, { a: 1 });

  // Tokens: a write token with a TTL and a pinned agent name.
  const tok = await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/tokens`, { scope: 'write', ttl_seconds: 600, agent_name: 'sandbox-7', name: 'e2b' });
  assert.equal(tok.status, 200, tok.text);
  assert.match(tok.json.token, /^gws_/);
  assert.equal(tok.json.agent_name, 'sandbox-7');
  assert.equal(tok.json.expires_at, Math.floor(h.clock.t / 1000) + 600);
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM workspace_tokens WHERE token_hash = ?').get(sha256(tok.json.token)).n, 1);
  assert.equal((await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/tokens`, { scope: 'admin' })).status, 400);
  assert.equal((await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/tokens`, { scope: 'read', ttl_seconds: 31 * 86400 })).status, 400);
  const base = wsPath(ws);
  // The agent writes and reads; X-Grapim-Agent cannot change its pinned identity.
  const put = await agent(h, tok.json.token, `${base}fs/notes.md`, { method: 'PUT', body: 'hello\n', headers: { 'X-Grapim-Agent': 'somebody-else' } });
  assert.equal(put.status, 200, put.text);
  assert.equal((await agent(h, tok.json.token, `${base}fs/notes.md`)).text, 'hello\n');
  await settle();

  // Runs: the same objects as /api/runs; the run is http:e2b/sandbox-7.
  const runs = await api(h, p.live, 'GET', `/v1/workspaces/${ws.id}/runs`);
  assert.equal(runs.status, 200, runs.text);
  assert.deepEqual(runs.json.data.map((r) => r.run), ['http:e2b/sandbox-7'], 'the pinned agent is the run identity');
  assert.deepEqual(runs.json.data, (await agent(h, tok.json.token, `${base}api/runs`)).json());

  // Undo: plan, then apply.
  const run = encodeURIComponent('http:e2b/sandbox-7');
  const plan = await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/runs/${run}/undo`, { apply: false });
  assert.equal(plan.status, 200, plan.text);
  assert.equal(plan.json.applied, false);
  const done = await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/runs/${run}/undo`, { apply: true });
  assert.equal(done.json.applied, true);
  assert.equal(fs.existsSync(path.join(h.dir, 'workspaces', p.team, ws.id, 'notes.md')), false);
  assert.equal((await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/runs/${encodeURIComponent('http:nobody')}/undo`, { apply: true })).status, 404);

  // Embed sessions need allowed origins first.
  assert.equal((await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/embed_sessions`, { mode: 'review' })).status, 400);
  const settings = await api(h, p.live, 'PUT', '/v1/settings', { embed_allowed_origins: [APP, 'https://admin.example.com/'] });
  assert.equal(settings.status, 200, settings.text);
  assert.deepEqual(settings.json.embed_allowed_origins, [APP, 'https://admin.example.com']);
  assert.deepEqual((await api(h, p.live, 'GET', '/v1/settings')).json, settings.json);
  for (const bad of [['http://app.example.com'], ['https://app.example.com/path'], ['javascript:alert(1)'], ["https://a.com; script-src *"], 'x']) {
    assert.equal((await api(h, p.live, 'PUT', '/v1/settings', { embed_allowed_origins: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/embed_sessions`, { mode: 'review' })).status, 400, 'two origins: parent_origin is required');
  const es = await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/embed_sessions`, { mode: 'readonly', theme: 'dark', parent_origin: APP, ttl_seconds: 300 });
  assert.equal(es.status, 200, es.text);
  assert.match(es.json.url, new RegExp(`^${ORIGIN}/hub/embed/es_`));
  assert.equal(es.json.expires_at, Math.floor(h.clock.t / 1000) + 300);
  assert.equal((await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/embed_sessions`, { mode: 'edit', parent_origin: APP })).status, 400);
  assert.equal((await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/embed_sessions`, { parent_origin: 'https://evil.example' })).status, 400);

  // Usage.
  h.hub.platform.metering.flush();
  const usage = await api(h, p.live, 'GET', '/v1/usage?group_by=workspace');
  assert.equal(usage.status, 200, usage.text);
  const mine = usage.json.data.find((r) => r.workspace_id === ws.id);
  assert.equal(mine.external_id, 'cust_1');
  assert.ok(mine.writes >= 2, 'the write and its undo');

  // Webhook endpoints.
  const we = await api(h, p.live, 'POST', '/v1/webhook_endpoints', { url: 'https://hooks.example.com/grapim', events: ['run.started', 'run.undone'] });
  assert.equal(we.status, 200, we.text);
  assert.match(we.json.secret, /^whsec_/);
  assert.equal(we.json.status, 'enabled');
  const wl = await api(h, p.live, 'GET', '/v1/webhook_endpoints');
  assert.deepEqual(wl.json.data.map((e) => e.id), [we.json.id]);
  assert.equal(wl.json.data[0].secret, undefined, 'the secret is shown once');
  assert.equal((await api(h, p.live, 'GET', `/v1/webhook_endpoints/${we.json.id}`)).json.url, 'https://hooks.example.com/grapim');
  assert.equal(h.hub.db.prepare('SELECT secret_sealed FROM webhook_endpoints WHERE id = ?').get(we.json.id).secret_sealed.includes(we.json.secret), false, 'sealed at rest');
  assert.equal((await api(h, p.live, 'POST', '/v1/webhook_endpoints', { url: 'https://hooks.example.com/x', events: ['nope'] })).status, 400);
  assert.deepEqual((await api(h, p.live, 'DELETE', `/v1/webhook_endpoints/${we.json.id}`)).json, { id: we.json.id, object: 'webhook_endpoint', deleted: true });
  assert.equal((await api(h, p.live, 'GET', `/v1/webhook_endpoints/${we.json.id}`)).status, 404);

  // Revoke the token: the agent is out.
  assert.deepEqual((await api(h, p.live, 'DELETE', `/v1/workspaces/${ws.id}/tokens/${tok.json.id}`)).json, { id: tok.json.id, object: 'workspace_token', deleted: true });
  assert.equal((await agent(h, tok.json.token, `${base}fs/`)).status, 401);
  assert.equal((await api(h, p.live, 'DELETE', `/v1/workspaces/${ws.id}/tokens/${tok.json.id}`)).status, 404);

  // Delete (soft): gone from the API and the desk, folder in the trash.
  assert.deepEqual((await api(h, p.live, 'DELETE', `/v1/workspaces/${other.id}`)).json, { id: other.id, object: 'workspace', deleted: true });
  assert.equal((await api(h, p.live, 'GET', `/v1/workspaces/${other.id}`)).status, 404);
  assert.ok(h.hub.db.prepare('SELECT deleted_at FROM workspaces WHERE id = ?').get(other.id).deleted_at);
  assert.ok(fs.readdirSync(path.join(h.dir, 'trash', p.team)).some((d) => d.startsWith(other.id)));
  // external_id is free again once its workspace is deleted.
  assert.equal((await api(h, p.live, 'POST', '/v1/workspaces', { external_id: 'cust_2' })).status, 200);

  // The OpenAPI document is public and matches the router exactly.
  const doc = await fetch(`${h.base}/v1/openapi.json`);
  assert.equal(doc.status, 200);
  const spec = await doc.json();
  assert.equal(spec.openapi, '3.1.0');
  const documented = Object.entries(spec.paths).flatMap(([p2, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p2}`)).sort();
  const served = h.hub.platform.router.routes.map((r) => `${r.method} ${r.pattern.replace(/:(\w+)/g, '{$1}')}`).sort();
  assert.deepEqual(documented, served);
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    for (const ref of JSON.stringify(schema).matchAll(/"#\/components\/schemas\/(\w+)"/g)) assert.ok(spec.components.schemas[ref[1]], `${name} -> ${ref[1]}`);
  }
  // The objects carry every property the document says they must.
  const got = (await api(h, p.live, 'GET', `/v1/workspaces/${ws.id}`)).json;
  for (const k of spec.components.schemas.Workspace.required) assert.ok(k in got, `workspace.${k}`);
  for (const k of spec.components.schemas.WorkspaceToken.required) assert.ok(k in tok.json, `token.${k}`);
  for (const k of spec.components.schemas.EmbedSession.required) assert.ok(k in es.json, `embed.${k}`);
  for (const k of spec.components.schemas.WebhookEndpoint.required) assert.ok(k in we.json, `endpoint.${k}`);
  for (const k of spec.components.schemas.UsageRow.required) assert.ok(k in mine, `usage.${k}`);
  for (const k of spec.components.schemas.Error.properties.error.required) assert.ok(k in dup.json.error, `error.${k}`);
});

test('pagination: limit and starting_after walk every workspace once, newest first', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'pf-pages');
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await api(h, p.test, 'POST', '/v1/workspaces', { external_id: `c${i}` })).json.id);
  const seen = [];
  let after = null;
  let pages = 0;
  for (;;) {
    const r = await api(h, p.test, 'GET', `/v1/workspaces?limit=2${after ? `&starting_after=${after}` : ''}`);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.data.length <= 2);
    seen.push(...r.json.data.map((w) => w.id));
    pages++;
    if (!r.json.has_more) break;
    after = r.json.data.at(-1).id;
  }
  assert.equal(pages, 3);
  assert.deepEqual(seen, [...ids].reverse());
  assert.equal((await api(h, p.test, 'GET', '/v1/workspaces?limit=0')).status, 400);
  assert.equal((await api(h, p.test, 'GET', '/v1/workspaces?limit=101')).status, 400);
  assert.equal((await api(h, p.test, 'GET', '/v1/workspaces?starting_after=nosuchworkspace')).status, 400);
  // A live key's list does not page through test workspaces.
  assert.deepEqual((await api(h, p.live, 'GET', '/v1/workspaces')).json.data, []);
  assert.equal((await api(h, p.live, 'GET', `/v1/workspaces?starting_after=${ids[0]}`)).status, 400);
});

test('Idempotency-Key: the same body replays the stored reply, a different body is 409, and nothing runs twice', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'pf-idem');
  const count = () => h.hub.db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE team_id = ?').get(p.team).n;
  const first = await api(h, p.live, 'POST', '/v1/workspaces', { external_id: 'once' }, { 'Idempotency-Key': 'k-1' });
  assert.equal(first.status, 200, first.text);
  const again = await api(h, p.live, 'POST', '/v1/workspaces', { external_id: 'once' }, { 'Idempotency-Key': 'k-1' });
  assert.equal(again.status, 200);
  assert.equal(again.json.id, first.json.id);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.equal(count(), 1);
  const other = await api(h, p.live, 'POST', '/v1/workspaces', { external_id: 'twice' }, { 'Idempotency-Key': 'k-1' });
  assert.equal(other.status, 409);
  assert.equal(other.json.error.code, 'idempotency_mismatch');
  assert.equal(count(), 1);
  // The same key on another path is another request: also a mismatch.
  assert.equal((await api(h, p.live, 'POST', `/v1/workspaces/${first.json.id}/tokens`, { external_id: 'once' }, { 'Idempotency-Key': 'k-1' })).status, 409);

  // A replayed token creation returns the same token (sealed at rest, never in clear).
  const tk = await api(h, p.live, 'POST', `/v1/workspaces/${first.json.id}/tokens`, { scope: 'read' }, { 'Idempotency-Key': 'tok-1' });
  const tk2 = await api(h, p.live, 'POST', `/v1/workspaces/${first.json.id}/tokens`, { scope: 'read' }, { 'Idempotency-Key': 'tok-1' });
  assert.equal(tk2.json.token, tk.json.token);
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM workspace_tokens WHERE workspace_id = ?').get(first.json.id).n, 1);
  assert.equal(h.hub.db.prepare("SELECT COUNT(*) AS n FROM platform_idempotency WHERE instr(body, 'gws_') > 0").get().n, 0);

  // A refusal is stored too.
  const bad = await api(h, p.live, 'POST', '/v1/workspaces', { name: 'Bad Name!' }, { 'Idempotency-Key': 'bad-1' });
  assert.equal(bad.status, 400);
  const bad2 = await api(h, p.live, 'POST', '/v1/workspaces', { name: 'Bad Name!' }, { 'Idempotency-Key': 'bad-1' });
  assert.equal(bad2.status, 400);
  assert.equal(bad2.json.error.request_id, bad.json.error.request_id);

  // Keys are per platform and expire after 24 hours.
  const q = await platform(h, 'pf-idem-2');
  assert.equal((await api(h, q.live, 'POST', '/v1/workspaces', { external_id: 'x' }, { 'Idempotency-Key': 'k-1' })).status, 200, 'another platform, same key');
  h.clock.t += 24 * 60 * 60 * 1000 + 1;
  const later = await api(h, p.live, 'POST', '/v1/workspaces', { external_id: 'twice' }, { 'Idempotency-Key': 'k-1' });
  assert.equal(later.status, 200, later.text);
  assert.equal(count(), 2);
  assert.equal((await api(h, p.live, 'POST', '/v1/workspaces', {}, { 'Idempotency-Key': 'x'.repeat(256) })).status, 400);
});

test('a token minted with a TTL stops at expires_at; tokens made in the hub UI keep working', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'pf-ttl');
  const ws = (await api(h, p.live, 'POST', '/v1/workspaces', {})).json;
  const tok = (await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/tokens`, { scope: 'read', ttl_seconds: 60 })).json;
  const ui = await p.owner.post(`/hub/teams/${p.team}/workspaces/${ws.id}/tokens`, { name: 'forever', scope: 'read' });
  const forever = ui.text.match(/value="(gws_[A-Za-z0-9_-]+)"/)[1];
  const base = wsPath(ws);
  assert.equal((await agent(h, tok.token, `${base}api/overview`)).status, 200);
  h.clock.t += 59_000;
  assert.equal((await agent(h, tok.token, `${base}api/overview`)).status, 200);
  h.clock.t += 1_000;
  assert.equal((await agent(h, tok.token, `${base}api/overview`)).status, 401, 'expired');
  assert.equal((await agent(h, forever, `${base}api/overview`)).status, 200, 'no expires_at: never expires');
  // Expired tokens leave the list.
  assert.doesNotMatch((await p.owner.req(`/hub/teams/${p.team}/workspaces/${ws.id}/tokens`)).text, new RegExp(tok.name));
});

test('agent_name pins the run identity in the ledger, over /fs and MCP', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'pf-pin');
  const ws = (await api(h, p.live, 'POST', '/v1/workspaces', {})).json;
  const pinned = (await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/tokens`, { scope: 'write', name: 'modal', agent_name: 'job-42' })).json;
  const free = (await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/tokens`, { scope: 'write', name: 'free' })).json;
  const base = wsPath(ws);
  assert.equal((await agent(h, pinned.token, `${base}fs/a.txt`, { method: 'PUT', body: 'a', headers: { 'X-Grapim-Agent': 'job-99' } })).status, 200);
  assert.equal((await agent(h, free.token, `${base}fs/b.txt`, { method: 'PUT', body: 'b', headers: { 'X-Grapim-Agent': 'job-99' } })).status, 200);
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 't' }, capabilities: {} } };
  const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Grapim-Agent': 'claimed' };
  const i = await agent(h, pinned.token, `${base}mcp`, { method: 'POST', body: JSON.stringify(init), headers: mcpHeaders });
  const w = await agent(h, pinned.token, `${base}mcp`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'c.txt', content: 'c' } } }),
    headers: { ...mcpHeaders, 'Mcp-Session-Id': i.headers.get('mcp-session-id') },
  });
  assert.equal(w.status, 200, w.text);
  const runs = (await agent(h, free.token, `${base}api/runs`)).json().map((r) => r.run).sort();
  assert.deepEqual(runs, ['http:free/job-99', 'http:modal/job-42']);
  const blame = (await agent(h, free.token, `${base}api/blame?path=c.txt`)).json();
  assert.ok(JSON.stringify(blame).includes('modal/job-42'));
});

// ---------------------------------------------------------------- embed

test('embed sessions: single use, a cookie scoped to one workspace, readonly enforced on undo, PUT and MCP, frame-ancestors only on embed responses', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'pf-embed');
  await api(h, p.live, 'PUT', '/v1/settings', { embed_allowed_origins: [APP] });
  const ws = (await api(h, p.live, 'POST', '/v1/workspaces', { external_id: 'e1' })).json;
  const ws2 = (await api(h, p.live, 'POST', '/v1/workspaces', { external_id: 'e2' })).json;
  const writer = (await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/tokens`, { scope: 'write', name: 'w', agent_name: 'bot' })).json;
  const base = wsPath(ws);
  assert.equal((await agent(h, writer.token, `${base}fs/a.txt`, { method: 'PUT', body: 'a\n' })).status, 200);
  const run = encodeURIComponent('http:w/bot');

  const es = (await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/embed_sessions`, { mode: 'readonly', theme: 'dark', branding: false })).json;
  assert.equal(es.parent_origin, APP, 'the only allowed origin is the default');
  const link = new URL(es.url).pathname;
  const open = await fetch(h.base + link, { redirect: 'manual', headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' } });
  assert.equal(open.status, 303);
  const loc = new URL(open.headers.get('location'), ORIGIN);
  assert.equal(loc.pathname, base);
  assert.deepEqual(Object.fromEntries(loc.searchParams), { embed: '1', theme: 'dark', mode: 'readonly', brand: '0' });
  const setCookie = open.headers.get('set-cookie');
  for (const attr of [`Path=${base}`, 'HttpOnly', 'Secure', 'SameSite=None', 'Partitioned', 'Max-Age=600']) assert.ok(setCookie.includes(attr), `${attr} in ${setCookie}`);
  assert.match(open.headers.get('content-security-policy'), new RegExp(`frame-ancestors ${APP}`));
  assert.equal(open.headers.get('x-frame-options'), null);
  const cookie = setCookie.split(';')[0];
  // Single use.
  const reuse = await fetch(h.base + link, { redirect: 'manual' });
  assert.equal(reuse.status, 410);
  assert.equal(reuse.headers.get('set-cookie'), null);
  assert.equal((await fetch(`${h.base}${link.slice(0, -3)}AAA`, { redirect: 'manual' })).status, 410, 'a forged link');

  // The desk, as the iframe navigates to it: the embedding origin, mode and theme are in the page.
  const desk = await fetch(`${h.base}${base}?${loc.searchParams}`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' } });
  assert.equal(desk.status, 200);
  const page = await desk.text();
  assert.match(page, new RegExp(`<meta name="grapim-embed-origin" content="${APP}">`));
  assert.match(page, /<meta name="grapim-embed-mode" content="readonly">/);
  const csp = desk.headers.get('content-security-policy');
  assert.match(csp, new RegExp(`frame-ancestors ${APP}(;|$)`));
  assert.doesNotMatch(csp, /frame-ancestors 'none'/);
  assert.equal(desk.headers.get('x-frame-options'), null);
  const csrf = desk.headers.get('x-grapim-csrf');
  assert.ok(csrf);
  // The desk's own scripts: same CSP, same frame-ancestors.
  const appJs = await fetch(`${h.base}${base}app.js`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'script' } });
  assert.equal(appJs.status, 200);
  assert.match(appJs.headers.get('content-security-policy'), new RegExp(`frame-ancestors ${APP}`));
  // The demo page in ui/ is never served by the hub.
  for (const demo of ['embed-demo.html', 'EMBED-DEMO.HTML', 'embed-demo.html.', 'embed%2Ddemo.html']) {
    assert.equal((await fetch(`${h.base}${base}${demo}`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } })).status, 404, demo);
  }

  const desktop = (pth, init = {}) =>
    fetch(h.base + pth, { ...init, headers: { Cookie: cookie, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'X-Grapim-Csrf': csrf, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const runsRes = await desktop(`${base}api/runs`);
  assert.equal(runsRes.status, 200);
  assert.match(runsRes.headers.get('content-security-policy'), /frame-ancestors 'none'/, 'data is never framed');
  // Readonly: undo, review, restore, PUT and MCP writes are refused server-side.
  for (const [method, sub, body] of [
    ['POST', `api/runs/${run}/undo`, { apply: true }],
    ['POST', `api/runs/${run}/review`, { status: 'approved' }],
    ['POST', `api/runs/${run}/branch`, {}],
    ['PUT', 'fs/a.txt', null],
    ['DELETE', 'fs/a.txt', null],
  ]) {
    const r = await desktop(base + sub, { method, body: body ? JSON.stringify(body) : 'x' });
    assert.equal(r.status, 403, `${method} ${sub}`);
  }
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 't' }, capabilities: {} } };
  const mi = await desktop(`${base}mcp`, { method: 'POST', body: JSON.stringify(init), headers: { Accept: 'application/json, text/event-stream' } });
  assert.equal(mi.status, 200, await mi.clone().text());
  const mw = await desktop(`${base}mcp`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'a.txt', content: 'pwned' } } }),
    headers: { Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': mi.headers.get('mcp-session-id') },
  });
  assert.equal(mw.status, 403);
  assert.equal((await mw.json()).error.code, -32003);
  assert.equal(fs.readFileSync(path.join(h.dir, 'workspaces', p.team, ws.id, 'a.txt'), 'utf8'), 'a\n');
  // Writes need the CSRF header and the hub's origin, like a hub session.
  const r1 = await fetch(`${h.base}${base}api/overview`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' } });
  assert.equal(r1.status, 403, 'a cross-site read is refused');

  // The cookie opens this workspace only.
  for (const target of [`${wsPath(ws2)}api/runs`, wsPath(ws2), `/w/${p.team}/nope/api/runs`]) {
    const r = await fetch(h.base + target, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' }, redirect: 'manual' });
    assert.ok([401, 303].includes(r.status), `${target}: ${r.status}`);
  }
  // Nor once it expires.
  h.clock.t += 601_000;
  assert.equal((await desktop(`${base}api/runs`)).status, 401);

  // A review session: undo works, as human:embed:<user>; files still cannot be written.
  const rs = (await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/embed_sessions`, { mode: 'review', user: 'dana@customer.com' })).json;
  const ropen = await fetch(h.base + new URL(rs.url).pathname, { redirect: 'manual' });
  const rcookie = ropen.headers.get('set-cookie').split(';')[0];
  const rdesk = await fetch(`${h.base}${base}`, { headers: { Cookie: rcookie, 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' } });
  const rcsrf = rdesk.headers.get('x-grapim-csrf');
  const as = (pth, init = {}) => fetch(h.base + pth, { ...init, headers: { Cookie: rcookie, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'X-Grapim-Csrf': rcsrf, 'Content-Type': 'application/json' } });
  assert.equal((await as(`${base}fs/a.txt`, { method: 'PUT', body: 'x' })).status, 403);
  const noCsrf = await fetch(`${h.base}${base}api/runs/${run}/undo`, { method: 'POST', body: '{"apply":true}', headers: { Cookie: rcookie, Origin: ORIGIN, 'Content-Type': 'application/json' } });
  assert.equal(noCsrf.status, 403);
  const undo = await as(`${base}api/runs/${run}/undo`, { method: 'POST', body: JSON.stringify({ apply: true }) });
  assert.equal(undo.status, 200, await undo.clone().text());
  const events = await (await agent(h, writer.token, `${base}api/events?latest=1`)).json();
  assert.equal(events.filter((e) => e.kind === 'undo').at(-1).actor, 'human:embed:dana@customer.com');

  // Everything that is not an embed response keeps frame-ancestors 'none'.
  const sess = await p.owner.req(base);
  assert.match(sess.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(sess.headers.get('x-frame-options'), 'DENY');
  assert.doesNotMatch(sess.text, /grapim-embed-origin/);
  for (const hubPage of ['/hub', `/hub/teams/${p.team}/platform`]) {
    const r = await p.owner.req(hubPage);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  const apiRes = await api(h, p.live, 'GET', '/v1/workspaces');
  assert.match(apiRes.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  // A deleted workspace's embed links stop working.
  const late = (await api(h, p.live, 'POST', `/v1/workspaces/${ws2.id}/embed_sessions`, {})).json;
  await api(h, p.live, 'DELETE', `/v1/workspaces/${ws2.id}`);
  assert.equal((await fetch(h.base + new URL(late.url).pathname, { redirect: 'manual' })).status, 410);
});

// ---------------------------------------------------------------- webhooks

test('webhooks: signed events from the API and the workspace engine; run.updated is debounced', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'pf-hooks');
  const we = (await api(h, p.live, 'POST', '/v1/webhook_endpoints', { url: 'https://hooks.example.com/in', events: ['*'] })).json;
  const testWe = (await api(h, p.test, 'POST', '/v1/webhook_endpoints', { url: 'https://hooks.example.com/test', events: ['workspace.created'] })).json;
  const ws = (await api(h, p.live, 'POST', '/v1/workspaces', { external_id: 'hook-1' })).json;
  await api(h, p.test, 'POST', '/v1/workspaces', { external_id: 'hook-test' });
  const tok = (await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/tokens`, { scope: 'write', name: 'w', agent_name: 'bot' })).json;
  const base = wsPath(ws);
  const put = (file, body) => agent(h, tok.token, `${base}fs/${file}`, { method: 'PUT', body });

  assert.equal((await put('a.txt', '1')).status, 200);
  await settle();
  assert.equal((await put('a.txt', '2')).status, 200); // same run, inside 30 s: folded
  await settle();
  await h.hub.platform.webhooks.deliverDue();
  const types = () => h.receiver.calls.filter((c) => c.url.endsWith('/in')).map((c) => JSON.parse(c.body).type);
  assert.deepEqual(types(), ['workspace.created', 'run.started']);
  // Test events go to test endpoints only.
  const testCalls = h.receiver.calls.filter((c) => c.url.endsWith('/test'));
  assert.equal(testCalls.length, 1);
  assert.equal(JSON.parse(testCalls[0].body).livemode, false);

  // The signature verifies with the secret, and a changed body does not.
  const call = h.receiver.calls[0];
  assert.ok(verify(call.body, call.headers['Grapim-Signature'], we.secret));
  assert.ok(!verify(call.body.replace('hook-1', 'hook-2'), call.headers['Grapim-Signature'], we.secret));
  assert.ok(!verify(call.body, call.headers['Grapim-Signature'], testWe.secret));
  const evt = JSON.parse(call.body);
  assert.match(evt.id, /^evt_/);
  assert.deepEqual(evt.workspace, { id: ws.id, external_id: 'hook-1' });
  assert.equal(evt.livemode, true);
  assert.equal(typeof evt.created, 'number');
  assert.equal(call.headers['Grapim-Event-Id'], evt.id);
  const started = JSON.parse(h.receiver.calls.find((c) => JSON.parse(c.body).type === 'run.started').body);
  assert.equal(started.data.run, 'http:w/bot');

  // 31 s later the next write sends one run.updated with the latest totals.
  h.clock.t += 31_000;
  await put('b.txt', '3');
  await settle();
  await put('b.txt', '4');
  await settle();
  await h.hub.platform.webhooks.deliverDue();
  assert.deepEqual(types().filter((x) => x === 'run.updated').length, 1);
  const upd = JSON.parse(h.receiver.calls.find((c) => JSON.parse(c.body).type === 'run.updated').body);
  assert.equal(upd.data.files, 2);
  // The folded write is sent when its window ends.
  h.hub.platform.events.flushDebounced();
  await h.hub.platform.webhooks.deliverDue();
  assert.deepEqual(types().filter((x) => x === 'run.updated').length, 2);
  assert.equal(JSON.parse(h.receiver.calls.filter((c) => JSON.parse(c.body).type === 'run.updated').at(-1).body).data.edits, 4);

  // Review and undo by the token, undo through the API, delete.
  const run = encodeURIComponent('http:w/bot');
  assert.equal((await agent(h, tok.token, `${base}api/runs/${run}/review`, { method: 'POST', body: JSON.stringify({ status: 'rejected', note: 'no' }), headers: { 'Content-Type': 'application/json' } })).status, 200);
  await settle();
  assert.equal((await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/runs/${run}/undo`, { apply: true })).status, 200);
  await api(h, p.live, 'DELETE', `/v1/workspaces/${ws.id}`);
  await h.hub.platform.webhooks.deliverDue();
  const byType = (type) => h.receiver.calls.map((c) => JSON.parse(c.body)).filter((e) => e.type === type);
  assert.deepEqual(byType('run.reviewed')[0].data, { run: 'http:w/bot', status: 'rejected', note: 'no', by: 'http:w/bot' });
  assert.equal(byType('run.undone')[0].data.run, 'http:w/bot');
  assert.deepEqual(byType('run.undone')[0].data.files.sort(), ['a.txt', 'b.txt']);
  assert.equal(byType('run.undone')[0].data.by, 'api:backend');
  assert.equal(byType('workspace.deleted')[0].workspace.id, ws.id);
  assert.equal(byType('run.started').length, 1, 'undo runs are not new runs');

  // The deliveries log page.
  const log = await p.owner.req(`/hub/teams/${p.team}/platform/webhooks`);
  assert.equal(log.status, 200);
  assert.match(log.text, /run\.reviewed/);
  assert.match(log.text, /hooks\.example\.com\/in/);
  assert.doesNotMatch(log.text, /whsec_/);
});

test('webhooks: a 500 is retried with backoff; 3 days of failures disable the endpoint', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'pf-retry');
  const we = (await api(h, p.live, 'POST', '/v1/webhook_endpoints', { url: 'https://hooks.example.com/flaky', events: ['workspace.created'] })).json;
  const del = () => h.hub.db.prepare('SELECT * FROM webhook_deliveries ORDER BY id DESC LIMIT 1').get();
  h.receiver.status = 500;
  await api(h, p.live, 'POST', '/v1/workspaces', {});
  await h.hub.platform.webhooks.deliverDue();
  assert.equal(h.receiver.calls.length, 1);
  assert.equal(del().status, 'pending');
  assert.equal(del().attempts, 1);
  assert.equal(del().last_status, 500);
  assert.equal(del().next_attempt_at, h.clock.t + BACKOFF_MS[0]);
  await h.hub.platform.webhooks.deliverDue();
  assert.equal(h.receiver.calls.length, 1, 'not due yet');
  h.clock.t += BACKOFF_MS[0];
  h.receiver.status = 200;
  await h.hub.platform.webhooks.deliverDue();
  assert.equal(h.receiver.calls.length, 2);
  assert.equal(del().status, 'delivered');
  assert.equal(del().attempts, 2);
  assert.equal(h.receiver.calls[0].body, h.receiver.calls[1].body, 'the same event, re-signed');

  // Fails for good after about 24 h.
  h.receiver.status = 503;
  await api(h, p.live, 'POST', '/v1/workspaces', {});
  for (let i = 0; i < 12; i++) {
    await h.hub.platform.webhooks.deliverDue();
    h.clock.t += 14 * 60 * 60 * 1000;
  }
  assert.equal(del().status, 'failed');
  assert.ok(del().attempts <= 8);

  // Three days of failures in a row: disabled, and the settings page says so.
  const ep = () => h.hub.db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(we.id);
  assert.equal(ep().enabled, 1);
  for (let day = 0; day < 3; day++) {
    h.clock.t += 24 * 60 * 60 * 1000;
    await api(h, p.live, 'POST', '/v1/workspaces', {});
    await h.hub.platform.webhooks.deliverDue();
  }
  h.clock.t += 60 * 60 * 1000;
  await h.hub.platform.webhooks.deliverDue();
  assert.equal(ep().enabled, 0);
  assert.match(ep().disabled_reason, /3 days/);
  assert.equal((await api(h, p.live, 'GET', `/v1/webhook_endpoints/${we.id}`)).json.status, 'disabled');
  assert.match((await p.owner.req(`/hub/teams/${p.team}/platform`)).text, /disabled after failing for 3 days/);
  const before = h.hub.db.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries').get().n;
  await api(h, p.live, 'POST', '/v1/workspaces', {});
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries').get().n, before, 'a disabled endpoint gets nothing');
});

test('webhooks: SSRF refused for loopback, private, link-local and metadata addresses, localhost, and a name resolving to a private IP', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'pf-ssrf');
  h.dns.set('internal.example.com', '10.0.0.5');
  h.dns.set('mixed.example.com', '93.184.216.34', '192.168.1.1');
  h.dns.set('v6.example.com', 'fd00:ec2::254');
  for (const url of [
    'http://hooks.example.com/x',
    'https://127.0.0.1/x',
    'https://127.1/x',
    'https://2130706433/x',
    'https://10.1.2.3/x',
    'https://169.254.169.254/latest/meta-data',
    'https://100.100.100.200/x',
    'https://localhost/x',
    'https://foo.localhost/x',
    'https://[::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://[::ffff:a9fe:a9fe]/x',
    'https://internal.example.com/x',
    'https://mixed.example.com/x',
    'https://v6.example.com/x',
    'https://user:pass@hooks.example.com/x',
    'ftp://hooks.example.com/x',
  ]) {
    const r = await api(h, p.live, 'POST', '/v1/webhook_endpoints', { url, events: ['*'] });
    assert.equal(r.status, 400, `${url}: ${r.text}`);
    assert.ok(['url_not_allowed', 'url_invalid'].includes(r.json.error.code), url);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111']) assert.equal(isBlockedAddress(ip), false, ip);
  for (const ip of ['0.0.0.0', '172.31.255.255', '192.168.0.1', '::', 'fe80::1', '64:ff9b::7f00:1', '2002:7f00:1::1', 'not-an-ip']) assert.equal(isBlockedAddress(ip), true, ip);

  // DNS rebinding: public when created, private when delivered: refused, never sent.
  const ok = await api(h, p.live, 'POST', '/v1/webhook_endpoints', { url: 'https://rebind.example.com/x', events: ['workspace.created'] });
  assert.equal(ok.status, 200, ok.text);
  h.dns.set('rebind.example.com', '169.254.169.254');
  await api(h, p.live, 'POST', '/v1/workspaces', {});
  await h.hub.platform.webhooks.deliverDue();
  assert.equal(h.receiver.calls.length, 0);
  const d = h.hub.db.prepare('SELECT * FROM webhook_deliveries').get();
  assert.equal(d.status, 'pending');
  assert.match(d.last_error, /refused/);
  // Back to public: delivered, to the address that was checked.
  h.dns.set('rebind.example.com', '93.184.216.34');
  h.clock.t += BACKOFF_MS[0];
  await h.hub.platform.webhooks.deliverDue();
  assert.equal(h.receiver.calls.length, 1);
  assert.equal(h.receiver.calls[0].address, '93.184.216.34');
});

// ---------------------------------------------------------------- metering

test('metering: writes and API calls per workspace per day, storage samples, usage aggregation, the estimate page', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'pf-meter');
  const a = (await api(h, p.live, 'POST', '/v1/workspaces', { external_id: 'a' })).json;
  const b = (await api(h, p.live, 'POST', '/v1/workspaces', { external_id: 'b' })).json;
  const ta = (await api(h, p.live, 'POST', `/v1/workspaces/${a.id}/tokens`, { scope: 'write', ttl_seconds: 2592000 })).json.token;
  const tb = (await api(h, p.live, 'POST', `/v1/workspaces/${b.id}/tokens`, { scope: 'write', ttl_seconds: 2592000 })).json.token;
  for (let i = 0; i < 3; i++) assert.equal((await agent(h, ta, `${wsPath(a)}fs/f${i}.txt`, { method: 'PUT', body: `${i}`, headers: { 'X-Grapim-Agent': 'x' } })).status, 200);
  await agent(h, ta, `${wsPath(a)}api/runs`);
  await settle();
  h.hub.platform.metering.sampleStorage();
  const day1 = new Date(h.clock.t).toISOString().slice(0, 10);
  h.clock.t += 24 * 60 * 60 * 1000;
  const day2 = new Date(h.clock.t).toISOString().slice(0, 10);
  assert.equal((await agent(h, tb, `${wsPath(b)}fs/g.txt`, { method: 'PUT', body: 'g', headers: { 'X-Grapim-Agent': 'y' } })).status, 200);
  await settle();
  h.hub.platform.metering.sampleStorage();
  h.hub.platform.metering.sampleStorage(); // once a day: the second sample changes nothing

  const all = (await api(h, p.live, 'GET', `/v1/usage?from=${day1}&to=${day2}`)).json;
  const row = (ws, day) => all.data.find((r) => r.workspace_id === ws && r.day === day);
  assert.equal(row(a.id, day1).writes, 3);
  assert.ok(row(a.id, day1).api_calls >= 4, `api calls ${row(a.id, day1).api_calls}`);
  assert.ok(row(a.id, day1).storage_byte_days > 0);
  assert.equal(row(a.id, day1).active, true);
  assert.equal(row(a.id, day2).writes, 0);
  assert.equal(row(a.id, day2).active, false);
  assert.equal(row(b.id, day2).writes, 1);
  const bytes = h.hub.db.prepare('SELECT bytes FROM workspaces WHERE id = ?').get(b.id).bytes;
  assert.equal(row(b.id, day2).storage_byte_days, bytes);

  const byWs = (await api(h, p.live, 'GET', `/v1/usage?from=${day1}&to=${day2}&group_by=workspace`)).json.data;
  const ra = byWs.find((r) => r.workspace_id === a.id);
  assert.equal(ra.writes, 3);
  assert.equal(ra.day, null);
  assert.equal(ra.external_id, 'a');
  assert.equal(ra.storage_byte_days, row(a.id, day1).storage_byte_days + row(a.id, day2).storage_byte_days);
  const byDay = (await api(h, p.live, 'GET', `/v1/usage?from=${day1}&to=${day2}&group_by=day`)).json.data;
  assert.deepEqual(byDay.map((r) => [r.day, r.writes, r.active]), [
    [day1, 3, 1],
    [day2, 1, 1],
  ]);
  assert.equal((await api(h, p.live, 'GET', '/v1/usage?from=2026-01-01&to=2026-12-31')).status, 400, 'at most 93 days');
  assert.equal((await api(h, p.live, 'GET', '/v1/usage?group_by=team')).status, 400);
  // The test key sees test usage only.
  assert.deepEqual((await api(h, p.test, 'GET', `/v1/usage?from=${day1}&to=${day2}`)).json.data, []);

  // The estimate: two active workspaces, 4 writes, the $500 minimum.
  const est = h.hub.platform.metering.estimate(p.team, 'live', day2.slice(0, 7));
  if (day1.slice(0, 7) === day2.slice(0, 7)) {
    assert.equal(est.active_workspaces, 2);
    assert.equal(est.writes, 4);
    assert.equal(est.lines[0].amount, 2 * PLATFORM_PRICES.activeWorkspaceMonth);
  }
  assert.equal(est.total, PLATFORM_PRICES.monthlyMinimum);
  const pageRes = await p.owner.req(`/hub/teams/${p.team}/platform/usage`);
  assert.equal(pageRes.status, 200);
  assert.match(pageRes.text, /Estimated bill/);
  assert.match(pageRes.text, /\$500\.00/);
  // A deleted workspace's history stays in the usage.
  await api(h, p.live, 'DELETE', `/v1/workspaces/${a.id}`);
  assert.ok((await api(h, p.live, 'GET', `/v1/usage?from=${day1}&to=${day2}`)).json.data.some((r) => r.workspace_id === a.id));
});

test('Stripe meter reporter: off without configuration; once per (platform, day, meter) with idempotent identifiers', async (t) => {
  const calls = [];
  const stripeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response('{"object":"billing.meter_event"}', { status: 200 });
  };
  const off = await startHub();
  t.after(off.close);
  assert.deepEqual(await off.hub.platform.metering.reportMeters(), { reported: 0, skipped: 'not configured' });

  const h = await startHub({ env: { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_METER_WRITES: 'grapim_writes', STRIPE_METER_ACTIVE_WORKSPACES: 'grapim_active', STRIPE_METER_STORAGE: 'grapim_storage' } });
  t.after(h.close);
  // A reporter of its own, with Stripe's fetch mocked.
  const p = await platform(h, 'pf-stripe');
  h.hub.db.prepare("UPDATE teams SET customer_id = 'cus_123' WHERE id = ?").run(p.team);
  const yesterday = new Date(h.clock.t - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  h.hub.db.prepare("INSERT INTO usage_daily (team_id, workspace_id, day, mode, writes, api_calls, storage_bytes) VALUES (?, 'wsx', ?, 'live', 2500, 10, ?)").run(p.team, yesterday, 3 * 1024 * 1024);
  h.hub.db.prepare("INSERT INTO usage_daily (team_id, workspace_id, day, mode, writes, api_calls) VALUES (?, 'wst', ?, 'test', 999, 1)").run(p.team, yesterday);
  const { createBilling } = await import('../src/hub/billing.js');
  const billing = createBilling({ env: { STRIPE_SECRET_KEY: 'sk_test_x' }, fetch: stripeFetch });
  const { createMetering } = await import('../src/hub/platform/metering.js');
  const m = createMetering({ hub: h.hub, env: { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_METER_WRITES: 'grapim_writes', STRIPE_METER_ACTIVE_WORKSPACES: 'grapim_active', STRIPE_METER_STORAGE: 'grapim_storage' }, log: () => {}, reportMeterEvent: billing.reportMeterEvent });
  t.after(() => m.close());
  await m.reportMeters();
  const sent = calls.map((c) => Object.fromEntries(new URLSearchParams(c.init.body)));
  assert.equal(calls.every((c) => c.url === 'https://api.stripe.com/v1/billing/meter_events'), true);
  const byName = Object.fromEntries(sent.map((s) => [s.event_name, s]));
  assert.equal(byName.grapim_writes['payload[value]'], '2500', 'live writes only');
  assert.equal(byName.grapim_writes['payload[stripe_customer_id]'], 'cus_123');
  assert.equal(byName.grapim_writes.identifier, `grapim-${p.team}-${yesterday}-writes`);
  assert.equal(calls.find((c) => c.init.body.includes('grapim_writes')).init.headers['Idempotency-Key'], `grapim-${p.team}-${yesterday}-writes`);
  assert.equal(byName.grapim_active['payload[value]'], '1');
  assert.equal(byName.grapim_storage['payload[value]'], '3');
  const n = calls.length;
  await m.reportMeters();
  assert.equal(calls.length, n, 'reported once');
});

test('test keys: free and capped at 25 workspaces and 2,000 writes a day', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'pf-caps');
  const ws = (await api(h, p.test, 'POST', '/v1/workspaces', {})).json;
  assert.equal(ws.livemode, false);
  const live = (await api(h, p.live, 'POST', '/v1/workspaces', {})).json;
  const tt = (await api(h, p.test, 'POST', `/v1/workspaces/${ws.id}/tokens`, { scope: 'write', ttl_seconds: 2592000 })).json.token;
  const lt = (await api(h, p.live, 'POST', `/v1/workspaces/${live.id}/tokens`, { scope: 'write' })).json.token;
  // A test key never sees live objects and the other way round.
  assert.equal((await api(h, p.test, 'GET', `/v1/workspaces/${live.id}`)).status, 404);
  assert.equal((await api(h, p.live, 'GET', `/v1/workspaces/${ws.id}`)).status, 404);

  // 2,000 test writes today: the next write is refused; live writes are not.
  const today = new Date(h.clock.t).toISOString().slice(0, 10);
  h.hub.db.prepare("INSERT INTO usage_daily (team_id, workspace_id, day, mode, writes) VALUES (?, 'other-test-ws', ?, 'test', ?)").run(p.team, today, PLATFORM_PRICES.testCaps.writesPerDay);
  const refused = await agent(h, tt, `${wsPath(ws)}fs/x.txt`, { method: 'PUT', body: 'x' });
  assert.equal(refused.status, 429, refused.text);
  assert.equal(refused.json().error.code, 'test_mode_limit');
  assert.equal((await agent(h, tt, `${wsPath(ws)}fs/`)).status, 200, 'reads still work');
  assert.equal((await agent(h, lt, `${wsPath(live)}fs/x.txt`, { method: 'PUT', body: 'x', headers: { 'X-Grapim-Agent': 'a' } })).status, 200);
  h.clock.t += 24 * 60 * 60 * 1000;
  assert.equal((await agent(h, tt, `${wsPath(ws)}fs/x.txt`, { method: 'PUT', body: 'x', headers: { 'X-Grapim-Agent': 'a' } })).status, 200, 'a new day');

  // 25 test workspaces: the next is refused.
  const ins = h.hub.db.prepare("INSERT INTO workspaces (id, team_id, name, created_by, created_at, mode) VALUES (?, ?, ?, 1, 1, 'test')");
  for (let i = 0; i < PLATFORM_PRICES.testCaps.workspaces - 1; i++) ins.run(`fakews${String(i).padStart(4, '0')}`, p.team, `fake-${i}`);
  const capped = await api(h, p.test, 'POST', '/v1/workspaces', {});
  assert.equal(capped.status, 429);
  assert.equal(capped.json.error.code, 'test_mode_limit');
  assert.equal((await api(h, p.live, 'POST', '/v1/workspaces', {})).status, 200, 'live keys are not capped');
  // Test usage is never billed.
  assert.equal(h.hub.platform.metering.estimate(p.team, 'test').total, 0);
});

// ---------------------------------------------------------------- isolation

test('IDOR: platform B (live and test keys) and platform A\'s test key get 404 on every /v1 route with A\'s ids, enumerated from the router', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const A = await platform(h, 'pf-idor-a');
  const B = await platform(h, 'pf-idor-b');
  await api(h, A.live, 'PUT', '/v1/settings', { embed_allowed_origins: ['https://alpha.example.com'] });
  const wsA = (await api(h, A.live, 'POST', '/v1/workspaces', { external_id: 'alpha-customer', metadata: { secret: 'alpha-meta' } })).json;
  const tokA = (await api(h, A.live, 'POST', `/v1/workspaces/${wsA.id}/tokens`, { scope: 'write', name: 'alpha-writer', agent_name: 'bot' })).json;
  assert.equal((await agent(h, tokA.token, `${wsPath(wsA)}fs/secret.txt`, { method: 'PUT', body: 'alpha-secret-content\n' })).status, 200);
  const weA = (await api(h, A.live, 'POST', '/v1/webhook_endpoints', { url: 'https://alpha-hooks.example.com/x', events: ['*'] })).json;
  await settle();
  const ids = { id: wsA.id, token_id: tokA.id, run: 'http:alpha-writer/bot', endpoint: weA.id };
  const LEAK = new RegExp([wsA.id, 'alpha-customer', 'alpha-meta', 'alpha-secret-content', 'alpha-writer', weA.id, 'alpha-hooks', 'alpha.example.com'].join('|'));
  const db = h.hub.db;
  const snapshot = () =>
    JSON.stringify({
      ws: db.prepare('SELECT id, name, metadata, external_id, deleted_at FROM workspaces WHERE team_id = ? ORDER BY id').all(A.team),
      tokens: db.prepare('SELECT id, revoked_at FROM workspace_tokens WHERE team_id = ? ORDER BY id').all(A.team),
      hooks: db.prepare('SELECT id, deleted_at, enabled FROM webhook_endpoints WHERE team_id = ? ORDER BY id').all(A.team),
      settings: db.prepare('SELECT mode, embed_allowed_origins, workspace_storage_mb FROM platform_settings WHERE team_id = ? ORDER BY mode').all(A.team),
      embeds: db.prepare('SELECT COUNT(*) AS n FROM embed_sessions WHERE team_id = ?').get(A.team).n,
      file: fs.readFileSync(path.join(h.dir, 'workspaces', A.team, wsA.id, 'secret.txt'), 'utf8'),
    });
  const before = snapshot();

  // A valid body for every route, so a 404 can only come from scoping.
  const BODIES = {
    'POST /v1/workspaces': { external_id: 'b-new' },
    'PATCH /v1/workspaces/:id': { name: 'stolen', metadata: { x: 1 } },
    'POST /v1/workspaces/:id/tokens': { scope: 'write' },
    'POST /v1/workspaces/:id/embed_sessions': { mode: 'review', parent_origin: 'https://alpha.example.com' },
    'POST /v1/workspaces/:id/runs/:run/undo': { apply: true },
    'POST /v1/webhook_endpoints': { url: 'https://b-hooks.example.com/x', events: ['*'] },
    'PUT /v1/settings': { embed_allowed_origins: ['https://b.example.com'] },
  };
  const fill = (pattern) => pattern.replace(/:(\w+)/g, (_, k) => encodeURIComponent(ids[k]));
  const routes = h.hub.platform.router.routes;
  assert.ok(routes.length >= 18, `routes: ${routes.length}`);
  let scoped = 0;
  for (const r of routes) {
    const name = `${r.method} ${r.pattern}`;
    const body = BODIES[name] ?? (['POST', 'PUT', 'PATCH'].includes(r.method) ? {} : undefined);
    const target = fill(r.pattern);
    if (r.opts.public) {
      const pub = await api(h, null, r.method, target);
      assert.equal(pub.status, 200, name);
      assert.doesNotMatch(pub.text, LEAK, name);
      continue;
    }
    // No key, and a hub session: 401 everywhere.
    assert.equal((await api(h, null, r.method, target, body)).status, 401, `no key ${name}`);
    const viaCookie = await fetch(h.base + target, { method: r.method, headers: { Cookie: A.owner.cookie(), Origin: ORIGIN, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(viaCookie.status, 401, `A's session ${name}`);
    for (const [who, key] of [
      ['B live', B.live],
      ['B test', B.test],
      ['A test', A.test],
    ]) {
      // A's test key is A itself: only its reach into A's live objects is under test here.
      if (who === 'A test' && !r.pattern.includes(':')) continue;
      const res = await api(h, key, r.method, target, body);
      if (r.pattern.includes(':')) {
        assert.equal(res.status, 404, `${who} ${name}: ${res.status} ${res.text}`);
        assert.equal(res.json.error.code, 'not_found');
      } else {
        assert.ok(res.status < 500, `${who} ${name}: ${res.status}`);
      }
      assert.doesNotMatch(res.text, LEAK, `${who} ${name} leaks`);
    }
    if (r.pattern.includes(':')) scoped++;
  }
  assert.ok(scoped >= 10);
  assert.equal(snapshot(), before, "platform A is unchanged");
  // A's own live key still reaches all of it.
  assert.equal((await api(h, A.live, 'GET', `/v1/workspaces/${wsA.id}`)).status, 200);
  assert.equal((await api(h, A.live, 'GET', `/v1/webhook_endpoints/${weA.id}`)).status, 200);
  // B's workspace token cannot open A's workspace, nor can an embed cookie of B.
  const wsB = (await api(h, B.live, 'POST', '/v1/workspaces', {})).json;
  const tokB = (await api(h, B.live, 'POST', `/v1/workspaces/${wsB.id}/tokens`, { scope: 'read' })).json.token;
  assert.equal((await agent(h, tokB, `${wsPath(wsA)}fs/secret.txt`)).status, 404);
  await api(h, B.live, 'PUT', '/v1/settings', { embed_allowed_origins: ['https://b.example.com'] });
  const esB = (await api(h, B.live, 'POST', `/v1/workspaces/${wsB.id}/embed_sessions`, {})).json;
  const cookieB = (await fetch(h.base + new URL(esB.url).pathname, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
  const cross = await fetch(`${h.base}${wsPath(wsA)}fs/secret.txt`, { headers: { Cookie: cookieB, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(cross.status, 401);
  assert.doesNotMatch(await cross.text(), LEAK);
});
