// The public read-only demo (src/hub/demo.js, GRAPIM_DEMO=1): /demo signs a
// visitor in as a synthetic viewer of a sample team; every write is refused,
// checked by walking every registered route, and no other team is reachable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../src/hub/server.js';
import { DEMO_READ_ONLY, DEMO_TEAM_ID, DEMO_VIEWER } from '../src/hub/demo.js';

const ORIGIN = 'http://localhost:7998';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const BANNER = /You're viewing a demo team with sample data\. <a href="\/hub\/login">Sign in with GitHub<\/a> to try Grapim on your repos\./;

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

async function startHub({ demo = true, env = {} } = {}) {
  const gh = fakeGitHub();
  const hub = await createHub({
    env: {
      HUB_URL: ORIGIN,
      HUB_SECRET: 'test-secret-that-is-long-enough-0123456789',
      HUB_DATA: tmp('grapim-demo-'),
      GITHUB_CLIENT_ID: 'gh-client',
      GITHUB_CLIENT_SECRET: 'gh-secret',
      ...(demo ? { GRAPIM_DEMO: '1' } : {}),
      ...env,
    },
    fetch: gh.fetch,
    billing: null,
    log: () => {},
  });
  const addr = await hub.listen(0, '127.0.0.1');
  return { hub, gh, base: `http://127.0.0.1:${addr.port}`, close: () => hub.close() };
}

class Browser {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
    this.cookies = [];
  }
  async req(p, { method = 'GET', form = null, body = undefined, headers = {}, origin = ORIGIN } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET' && method !== 'HEAD' && origin && !('Origin' in h)) h.Origin = origin;
    if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(this.base + p, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      this.cookies.push(c);
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (/Max-Age=0/i.test(c) || pair.slice(i + 1) === '') this.jar.delete(pair.slice(0, i));
      else this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
  }
  async csrf() {
    return (await this.req('/hub/api/me')).json().csrf;
  }
  async post(p, form = {}, opts = {}) {
    return this.req(p, { method: 'POST', form: { _csrf: await this.csrf(), ...form }, ...opts });
  }
}

let nextId = 7000;
async function signIn(h, login) {
  const id = nextId++;
  h.gh.user(`code-${id}`, { id, login, name: login, avatar_url: null });
  const b = new Browser(h.base);
  const start = await b.req('/hub/auth/github');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const cb = await b.req(`/hub/auth/callback?code=code-${id}&state=${state}`);
  assert.equal(cb.status, 303, cb.text);
  return b;
}

async function visitDemo(h) {
  const b = new Browser(h.base);
  const r = await b.req('/demo');
  assert.equal(r.status, 303, r.text);
  assert.equal(r.headers.get('location'), `/hub/teams/${DEMO_TEAM_ID}`);
  return { b, r };
}

// Every table row of the demo team and of every other team, to prove nothing changed.
function snapshot(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('sessions', 'oauth_states')")
    .all()
    .map((r) => r.name);
  return JSON.stringify(Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n])));
}

const fill = (pattern, params) => pattern.replace(/:(\w+)/g, (_, k) => encodeURIComponent(params[k] ?? 'x'));

test('GRAPIM_DEMO off: /demo is not found and a synthetic session never loads', async (t) => {
  const h = await startHub({ demo: false });
  t.after(h.close);
  assert.equal((await new Browser(h.base).req('/demo')).status, 404);
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM teams WHERE id = ?').get(DEMO_TEAM_ID).n, 0, 'no demo team seeded');
  // Even a session row for a negative id (left over from when it was on) is ignored.
  h.hub.db.prepare('INSERT INTO users (id, login, name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, 0)').run(DEMO_VIEWER.id, DEMO_VIEWER.login, DEMO_VIEWER.name);
  const s = h.hub.auth.createSession(DEMO_VIEWER.id);
  const b = new Browser(h.base);
  const [pair] = s.cookie.split(';');
  b.jar.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
  assert.equal((await b.req('/hub/api/me')).status, 401);
});

test('/demo starts a two-hour read-only session as the viewer, and every page the visitor clicks renders', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { db } = h.hub;
  const { b, r } = await visitDemo(h);
  const set = r.headers.get('set-cookie');
  assert.match(set, /grapim_session=/);
  assert.match(set, /Max-Age=7200/, 'two hours');
  assert.match(set, /HttpOnly/);
  const row = db.prepare('SELECT user_id, expires_at - created_at AS ttl FROM sessions ORDER BY created_at DESC LIMIT 1').get();
  assert.equal(row.user_id, DEMO_VIEWER.id);
  assert.equal(row.ttl, 2 * 60 * 60 * 1000);

  // The viewer is in the demo team only, as a member.
  const me = (await b.req('/hub/api/me')).json();
  assert.equal(me.user.id, DEMO_VIEWER.id);
  assert.equal(me.user.demo, undefined, 'the demo flag stays out of JSON');
  assert.deepEqual(me.teams.map((x) => [x.id, x.role]), [[DEMO_TEAM_ID, 'member']]);
  // Everyone in the demo team is synthetic: negative ids no GitHub account has.
  const ids = db.prepare('SELECT user_id FROM members WHERE team_id = ?').all(DEMO_TEAM_ID).map((x) => x.user_id);
  assert.ok(ids.length >= 4 && ids.every((id) => id < 0), `synthetic members: ${ids}`);

  // A second visit reuses the session.
  const again = await b.req('/demo');
  assert.equal(again.status, 303);
  assert.equal(again.headers.get('set-cookie'), null);
  assert.equal((await b.req('/hub')).headers.get('location'), `/hub/teams/${DEMO_TEAM_ID}`, '/hub goes straight to the demo team');

  // The pages a visitor clicks through.
  const T = `/hub/teams/${DEMO_TEAM_ID}`;
  const repos = (await b.req(`/hub/api/teams/${DEMO_TEAM_ID}/repos`)).json();
  assert.equal(repos.length, 5);
  const shop = repos.find((x) => x.folder === 'shop-api');
  const run = 'claude-code:7f3e21aa-55b0-4e0c-9d61-2f0c9a1b7e10';
  const pages = [
    T,
    `${T}/reviews`,
    `${T}/reviews?f=done`,
    `${T}/repos`,
    `${T}/repos/${shop.id}`,
    `${T}/repos/${shop.id}/runs/${encodeURIComponent(run)}`,
    `${T}/reports`,
    `${T}/reports/ai-share`,
    `${T}/reports/agents`,
    `${T}/reports/activity`,
    `${T}/agents`,
    `${T}/github/history`,
    `${T}/workspaces`,
    ...['general', 'members', 'rules', 'machines', 'data', 'plan'].map((s) => `${T}/settings/${s}`),
  ];
  for (const p of pages) {
    const res = await b.req(p);
    assert.equal(res.status, 200, `${p}: ${res.status} ${res.text.slice(0, 300)}`);
    assert.match(res.text, BANNER, `${p} shows the demo banner`);
    assert.doesNotMatch(res.text, /Something went wrong/, p);
  }
  const overview = await b.req(T);
  assert.match(overview.text, /#412/, 'the open pull requests');
  assert.match(overview.text, /data-demo="1"/, 'Ask Grapim is there, with the demo note');
  const runPage = await b.req(`${T}/repos/${shop.id}/runs/${encodeURIComponent(run)}`);
  assert.match(runPage.text, /withIdempotency/, 'the run shows its diff');
  const rules = await b.req(`${T}/settings/rules`);
  assert.match(rules.text, /src\/routes\/\*\*/, 'the path rules');
  const ws = db.prepare('SELECT id FROM workspaces WHERE team_id = ?').get(DEMO_TEAM_ID);
  const wsPage = await b.req(`${T}/workspaces/${ws.id}`);
  assert.equal(wsPage.status, 200);
  assert.match(wsPage.text, BANNER);
  // The workspace's files read fine through the mount.
  const file = await b.req(`/w/${DEMO_TEAM_ID}/research-notes/fs/notes/idempotency.md`);
  assert.equal(file.status, 200);
  assert.match(file.text, /Idempotency keys/);
  // The newest runs are minutes old, not days.
  const newest = db.prepare('SELECT MAX(ts) AS t FROM h_changes WHERE team_id = ?').get(DEMO_TEAM_ID).t;
  assert.ok(Date.now() - newest < 2 * 60 * 60 * 1000, 'recent runs');

  // The landing page and docs treat the visitor as signed out.
  const home = await b.req('/');
  assert.equal(home.status, 200, 'the landing page, not a redirect to the hub');
  assert.equal((await b.req('/hub/login')).status, 200, 'sign in is offered, not skipped');

  // A real member never sees the banner.
  const alice = await signIn(h, 'demo-alice');
  const pick = await alice.req('/hub');
  assert.equal(pick.status, 200);
  assert.doesNotMatch(pick.text, /demo-banner/);
  assert.equal((await alice.req(T)).status, 404, 'a real account is not in the demo team');
});

test('a demo session is refused every write: every registered non-GET route, the workspace mount, WebDAV and /v1', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { db } = h.hub;
  const { b } = await visitDemo(h);
  const csrf = await b.csrf();
  const ws = db.prepare('SELECT id FROM workspaces WHERE team_id = ?').get(DEMO_TEAM_ID);
  const repo = db.prepare("SELECT id FROM repos WHERE team_id = ? AND name = 'shop-api'").get(DEMO_TEAM_ID);
  const run = db.prepare('SELECT run FROM h_changes WHERE team_id = ? AND repo_id = ? LIMIT 1').get(DEMO_TEAM_ID, repo.id).run;
  const params = { team: DEMO_TEAM_ID, ws: ws.id, repo: repo.id, run, token: 'x', wstoken: 'x', id: '1', invite: 'x', user: String(-1002) };
  const before = snapshot(db);

  const writes = h.hub.router.routes.filter((r) => r.method !== 'GET');
  assert.ok(writes.length >= 50, `every write route is enumerated, got ${writes.length}`);
  let refused = 0;
  for (const r of writes) {
    const name = `${r.method} ${r.pattern}`;
    if (name === 'POST /hub/logout') continue; // signing out is allowed (checked below)
    const p = fill(r.pattern, params);
    const res = await b.req(p, { method: r.method, form: { _csrf: csrf, team: DEMO_TEAM_ID, name: 'x', seats: '5', interval: 'month', token: 'x', status: 'approved', message: 'hello' } });
    assert.equal(res.status, 403, `${name}: ${res.status}`);
    if (res.headers.get('content-type')?.includes('json')) {
      assert.deepEqual(res.json().error, { code: 'demo_read_only', message: DEMO_READ_ONLY }, name);
    } else {
      assert.match(res.text, /This is a read-only demo/, name);
      assert.match(res.text, /Sign in with GitHub/, name);
    }
    refused++;
  }
  assert.equal(refused, writes.length - 1);

  // Ask Grapim: no model call, refused before the route.
  const ask = await b.req(`/hub/api/teams/${DEMO_TEAM_ID}/agent/messages`, { method: 'POST', form: { _csrf: csrf, text: 'hi' } });
  assert.equal(ask.status, 403);
  assert.equal(ask.json().error.code, 'demo_read_only');

  // The workspace mount: /fs, /api, /mcp and WebDAV writes.
  const W = `/w/${DEMO_TEAM_ID}/research-notes`;
  for (const [method, p, extra] of [
    ['PUT', `${W}/fs/notes/new.md`, { body: 'x', headers: { 'X-Grapim-Csrf': csrf, 'X-Grapim-Agent': 'me' } }],
    ['DELETE', `${W}/fs/notes/idempotency.md`, { headers: { 'X-Grapim-Csrf': csrf, 'X-Grapim-Agent': 'me' } }],
    ['POST', `${W}/api/undo`, { body: '{}', headers: { 'X-Grapim-Csrf': csrf, 'Content-Type': 'application/json' } }],
    ['POST', `${W}/mcp`, { body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', headers: { 'Content-Type': 'application/json' } }],
    ['PROPFIND', `${W}/dav/`, {}],
    ['MKCOL', `${W}/dav/new/`, {}],
  ]) {
    const res = await b.req(p, { method, ...extra });
    assert.equal(res.status, 403, `${method} ${p}: ${res.status} ${res.text.slice(0, 200)}`);
    assert.equal(res.json().error.code, 'demo_read_only', `${method} ${p}`);
  }
  // The platform API and sync ingest.
  for (const p of ['/v1/workspaces', '/hub/api/sync']) {
    const res = await b.req(p, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.status, 403, p);
  }
  // GitHub linking is refused even though it is a GET.
  assert.equal((await b.req('/hub/github/setup?installation_id=1&state=x')).status, 403);

  assert.equal(snapshot(db), before, 'nothing in the database changed');
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(DEMO_VIEWER.id).n >= 1);

  // Signing out ends the demo session.
  const out = await b.post('/hub/logout');
  assert.equal(out.status, 303);
  assert.equal((await b.req('/hub/api/me')).status, 401);
});

test('a demo session never sees or reaches another team, and cannot create one', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { db } = h.hub;
  const alice = await signIn(h, 'iso-alice');
  const made = await alice.post('/hub/teams', { name: 'Private Co' });
  assert.equal(made.status, 303);
  const other = made.headers.get('location').match(/\/hub\/teams\/([^/?#]+)/)[1];

  const { b } = await visitDemo(h);
  assert.deepEqual((await b.req('/hub/api/teams')).json().map((x) => x.id), [DEMO_TEAM_ID]);
  const reads = h.hub.router.routes.filter((r) => r.method === 'GET' && r.opts.team && r.opts.team !== 'form');
  assert.ok(reads.length >= 20);
  for (const r of reads) {
    const res = await b.req(fill(r.pattern, { team: other }));
    assert.equal(res.status, 404, `GET ${r.pattern} for another team: ${res.status}`);
    assert.doesNotMatch(res.text, /Private Co/);
  }
  const teams = db.prepare('SELECT COUNT(*) AS n FROM teams').get().n;
  const create = await b.post('/hub/teams', { name: 'Demo made this' });
  assert.equal(create.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM teams').get().n, teams);
  const invite = await alice.post(`/hub/teams/${other}/invites`);
  const token = invite.text.match(/\/hub\/invite\/([A-Za-z0-9_-]+)/)[1];
  assert.equal((await b.post('/hub/invite/accept', { token })).status, 403, 'an invite cannot be accepted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM members WHERE team_id = ?').get(other).n, 1);
  assert.equal((await b.req(`/w/${other}/anything/fs/`)).status, 404);
});

test('/demo is rate limited per address, and nobody can sign in as a synthetic user', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await new Browser(h.base).req('/demo')).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(303));
  assert.equal(statuses[11], 429);

  // GitHub ids are positive; a profile claiming the viewer's id is refused.
  h.gh.user('code-neg', { id: DEMO_VIEWER.id, login: 'demo-visitor', name: 'x', avatar_url: null });
  const b = new Browser(h.base);
  const start = await b.req('/hub/auth/github');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const cb = await b.req(`/hub/auth/callback?code=code-neg&state=${state}`);
  assert.notEqual(cb.status, 303);
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 10, 'only the ten demo sessions');
});

test('seeding again keeps the viewer, the workspace and its files, and moves the runs to now', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { db } = h.hub;
  const { b } = await visitDemo(h);
  const ws = db.prepare('SELECT id FROM workspaces WHERE team_id = ?').get(DEMO_TEAM_ID).id;
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM h_changes WHERE team_id = ?').get(DEMO_TEAM_ID).n;
  const n = count();
  await h.hub.demo.seed();
  assert.equal(count(), n, 'the same history, not twice');
  assert.equal(db.prepare('SELECT id FROM workspaces WHERE team_id = ? AND deleted_at IS NULL').get(DEMO_TEAM_ID).id, ws);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gh_installations WHERE team_id = ?').get(DEMO_TEAM_ID).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hub_path_rules WHERE team_id = ?').get(DEMO_TEAM_ID).n, 3);
  assert.equal((await b.req(`/hub/teams/${DEMO_TEAM_ID}`)).status, 200, 'the session still works');
});
