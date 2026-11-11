// The team hub: GitHub sign in (mocked through an injected fetch), sessions,
// teams and invites, cross-team isolation, machine tokens, sync ingest, the
// team read API, CSRF, billing wiring, and one end-to-end sync from a real
// repo edited through the Claude Code hook.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../src/hub/server.js';
import { ConfigError, loadConfig } from '../src/hub/config.js';
import { loadBilling } from '../src/hub/plans.js';
import { runHook } from '../src/hook.js';
import { Store } from '../src/store.js';
import { resolveWorkspace } from '../src/workspace.js';
import { syncOnce } from '../src/sync.js';

const ORIGIN = 'http://localhost:7999';
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// GitHub, faked: each code maps to a profile.
function fakeGitHub() {
  const codes = new Map();
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://github.com/login/oauth/access_token') {
      const { code, client_secret } = JSON.parse(init.body);
      if (client_secret !== 'gh-secret' || !codes.has(code)) return reply(200, { error: 'bad_verification_code' });
      return reply(200, { access_token: `gho_${code}`, token_type: 'bearer' });
    }
    if (url === 'https://api.github.com/user') {
      const code = String(init.headers?.Authorization || '').replace('Bearer gho_', '');
      const u = codes.get(code);
      return u ? reply(200, u) : reply(401, { message: 'Bad credentials' });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, calls, user: (code, profile) => codes.set(code, profile) };
}

async function startHub({ env = {}, billing = null, clock = null } = {}) {
  const dir = tmp('grapim-hub-');
  const gh = fakeGitHub();
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
    billing,
    now: clock ? () => clock.t : undefined,
    log: (l) => logs.push(l),
  });
  const addr = await hub.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  return { hub, base, gh, logs, dir, close: () => hub.close() };
}

// A browser: a cookie jar, no redirects followed, Origin on posts.
class Browser {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }
  async req(p, { method = 'GET', form = null, headers = {}, origin = ORIGIN, body = undefined } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET' && origin && !('Origin' in h)) h.Origin = origin;
    if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(this.base + p, { method, headers: h, body, redirect: 'manual' });
    const setCookies = res.headers.getSetCookie();
    for (const c of setCookies) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (/Max-Age=0/i.test(c) || v === '') this.jar.delete(k);
      else this.jar.set(k, v);
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, setCookies, json: () => JSON.parse(text) };
  }
  async csrf() {
    return (await this.req('/hub/api/me')).json().csrf;
  }
  async post(p, form = {}) {
    return this.req(p, { method: 'POST', form: { _csrf: await this.csrf(), ...form } });
  }
}

let nextId = 1000;
async function signIn(t, login = `user${nextId}`) {
  const id = nextId++;
  const code = `code-${id}`;
  t.gh.user(code, { id, login, name: login.toUpperCase(), avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4` });
  const b = new Browser(t.base);
  const start = await b.req('/hub/auth/github');
  assert.equal(start.status, 303);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const cb = await b.req(`/hub/auth/callback?code=${code}&state=${state}`);
  assert.equal(cb.status, 303, cb.text);
  b.user = { id, login };
  return b;
}

async function createTeam(b, name = 'Acme') {
  const r = await b.post('/hub/teams', { name });
  assert.equal(r.status, 303, r.text);
  return r.headers.get('location').match(/\/hub\/teams\/([^/]+)\/settings/)[1];
}

async function createToken(b, team, name = 'laptop') {
  const r = await b.post(`/hub/teams/${team}/tokens`, { name });
  assert.equal(r.status, 200, r.text);
  return r.text.match(/value="(cmh_[A-Za-z0-9_-]+)"/)[1];
}

async function createInvite(b, team) {
  const r = await b.post(`/hub/teams/${team}/invites`);
  assert.equal(r.status, 200, r.text);
  return r.text.match(/\/hub\/invite\/([A-Za-z0-9_-]+)/)[1];
}

async function joinTeam(owner, member, team) {
  const token = await createInvite(owner, team);
  const r = await member.post('/hub/invite/accept', { token });
  assert.equal(r.status, 303, r.text);
}

const REPO_ID = sha1('root commit of shop-api');

function batch({ machine = 'alex-mbp', blobs = true, extra = {} } = {}) {
  const before = Buffer.from('a\nb\nc\n');
  const after = Buffer.from('a\nB\nc\nd\n');
  return {
    repo: { id: REPO_ID, name: 'shop-api' },
    machine,
    cursor: { changes: 0, events: 0, agents: 0 },
    runs: [{ run: 'claude-code:1a2b3c4d-0000', turn: 1, started_at: 1000 }],
    agents: [{ agent: 'claude-code:1a2b3c4d-0000', label: 'claude 1a2b3c4d', intent: 'Add /billing', worktree: 'shop-api', last_seen: Date.now() }],
    changes: [
      { id: 1, run: 'claude-code:1a2b3c4d-0000', label: 'claude 1a2b3c4d', turn: 1, worktree: 'shop-api', path: 'src/app.js', before_sha: sha1(before), after_sha: sha1(after), untracked: false, added: 2, removed: 1, ts: Date.now() },
    ],
    events: [
      { id: 1, ts: Date.now() - 10, agent: 'claude-code:1a2b3c4d-0000', kind: 'intent', path: null, detail: 'Add /billing' },
      { id: 2, ts: Date.now(), agent: 'claude-code:1a2b3c4d-0000', kind: 'edit', path: 'src/app.js', detail: '+2 -1' },
    ],
    blobs: blobs ? { [sha1(before)]: before.toString('base64'), [sha1(after)]: after.toString('base64') } : {},
    ...extra,
  };
}

const sync = (t, token, body, raw = null) =>
  fetch(`${t.base}/hub/api/sync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });

// ---------------------------------------------------------------- config

test('the hub refuses to start without its required env, and with a weak secret or plain http', () => {
  assert.throws(() => loadConfig({}), (e) => e instanceof ConfigError && /HUB_URL, HUB_SECRET, HUB_DATA, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET/.test(e.message));
  const ok = { HUB_URL: 'https://app.example.com', HUB_SECRET: 'k7Qp2VxL9mRt4ZsB8nWc3HyF6dJg1TaE', HUB_DATA: '/data', GITHUB_CLIENT_ID: 'a', GITHUB_CLIENT_SECRET: 'b' };
  assert.equal(loadConfig(ok).secure, true);
  assert.throws(() => loadConfig({ ...ok, HUB_SECRET: 'short' }), /at least 32 bytes/);
  assert.throws(() => loadConfig({ ...ok, HUB_SECRET: 'x'.repeat(32) }), /guessable/);
  assert.throws(() => loadConfig({ ...ok, HUB_URL: 'http://app.example.com' }), /https/);
  assert.throws(() => loadConfig({ ...ok, HUB_URL: 'https://app.example.com/hub' }), /bare origin/);
  assert.equal(loadConfig({ ...ok, HUB_URL: 'http://localhost:8080' }).secure, false);
  const c = loadConfig({ ...ok, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' });
  assert.equal(c.billingEnabled, true);
  assert.doesNotMatch(JSON.stringify(c), /sk_test_x|whsec_x|"b"|k7Qp2VxL|107,55/, 'secrets never show up when the config is serialised');
  assert.equal(c.github.clientSecret, 'b');
  assert.equal(c.secret.length, 32);
});

// ---------------------------------------------------------------- auth

test('GitHub sign in: state checked server side and bound to the browser; mismatch, replay and foreign browser rejected', async (t) => {
  const h = await startHub();
  t.after(h.close);
  h.gh.user('good', { id: 42, login: 'alex', name: 'Alex', avatar_url: 'https://avatars.githubusercontent.com/u/42?v=4' });

  const b = new Browser(h.base);
  const start = await b.req('/hub/auth/github?next=/hub/teams/abcdefgh');
  assert.equal(start.status, 303);
  const loc = new URL(start.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(loc.searchParams.get('client_id'), 'gh-client');
  assert.equal(loc.searchParams.get('redirect_uri'), `${ORIGIN}/hub/auth/callback`);
  const state = loc.searchParams.get('state');
  assert.ok(state.length >= 40);
  // Only its hash is stored.
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM oauth_states WHERE state_hash = ?').get(sha256(state)).n, 1);

  // A wrong state: rejected, no session.
  const bad = await b.req(`/hub/auth/callback?code=good&state=${'x'.repeat(43)}`);
  assert.equal(bad.status, 400);
  assert.ok(!bad.setCookies.some((c) => c.startsWith('grapim_session=') && !/Max-Age=0/.test(c)));
  assert.equal(h.gh.calls.length, 0, 'GitHub is never called for a bad state');

  // The right state from another browser (no binding cookie): rejected.
  const b2 = new Browser(h.base);
  const s2 = new URL((await b2.req('/hub/auth/github')).headers.get('location')).searchParams.get('state');
  const thief = new Browser(h.base);
  assert.equal((await thief.req(`/hub/auth/callback?code=good&state=${s2}`)).status, 400);

  // The real flow.
  const b3 = new Browser(h.base);
  const s3 = new URL((await b3.req('/hub/auth/github?next=/hub/teams/abcdefgh')).headers.get('location')).searchParams.get('state');
  const ok = await b3.req(`/hub/auth/callback?code=good&state=${s3}`);
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/hub/teams/abcdefgh');
  const tokenCall = h.gh.calls.find((c) => c.url.includes('access_token'));
  assert.equal(JSON.parse(tokenCall.init.body).client_secret, 'gh-secret', 'the code is exchanged server side');
  const me = (await b3.req('/hub/api/me')).json();
  assert.equal(me.user.id, 42);
  assert.equal(me.user.login, 'alex');
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.doesNotMatch(JSON.stringify(h.hub.db.prepare('SELECT * FROM sessions').all()), /gho_/, 'the GitHub token is not stored');

  // The same state again (replay): rejected, it was single use.
  b3.jar.set('grapim_oauth', [...b3.jar].find(([k]) => k === 'grapim_oauth')?.[1] ?? 'x');
  assert.equal((await b3.req(`/hub/auth/callback?code=good&state=${s3}`)).status, 400);

  // An open redirect in next is ignored.
  const b4 = new Browser(h.base);
  const s4 = new URL((await b4.req('/hub/auth/github?next=//evil.example/x')).headers.get('location')).searchParams.get('state');
  assert.equal((await b4.req(`/hub/auth/callback?code=good&state=${s4}`)).headers.get('location'), '/hub');

  // No secrets in the logs.
  const logs = h.logs.join('\n');
  assert.doesNotMatch(logs, /gh-secret|gho_|good|state=/);
});

test('session cookie: HttpOnly, SameSite=Lax, 30 days, Secure and __Host- on https; logout kills it server side', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const b = await signIn(h, 'sam');
  const cookie = b.jar.get('grapim_session');
  assert.ok(cookie);
  // The flags, from a fresh sign in.
  const b2 = new Browser(h.base);
  h.gh.user('c2', { id: 7, login: 'kim' });
  const st = new URL((await b2.req('/hub/auth/github')).headers.get('location')).searchParams.get('state');
  const cb = await b2.req(`/hub/auth/callback?code=c2&state=${st}`);
  const set = cb.setCookies.find((c) => c.startsWith('grapim_session='));
  assert.match(set, /; HttpOnly/);
  assert.match(set, /; SameSite=Lax/);
  assert.match(set, /; Path=\//);
  assert.match(set, /; Max-Age=2592000/);
  assert.doesNotMatch(set, /Secure/, 'not Secure on localhost');

  // A tampered cookie is refused.
  const forged = new Browser(h.base);
  forged.jar.set('grapim_session', cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')));
  assert.equal((await forged.req('/hub/api/me')).status, 401);

  // Logout deletes the server row: a copy of the old cookie stops working.
  const copy = new Browser(h.base);
  copy.jar.set('grapim_session', cookie);
  assert.equal((await copy.req('/hub/api/me')).status, 200);
  const out = await b.post('/hub/logout');
  assert.equal(out.status, 303);
  assert.ok(out.setCookies.some((c) => /^grapim_session=;.*Max-Age=0/.test(c)));
  assert.equal((await copy.req('/hub/api/me')).status, 401);

  // On https the cookie is Secure and __Host- prefixed.
  const hs = await startHub({ env: { HUB_URL: 'https://hub.example.test' } });
  t.after(hs.close);
  hs.gh.user('c3', { id: 8, login: 'lee' });
  const bs = new Browser(hs.base);
  const s3 = new URL((await bs.req('/hub/auth/github')).headers.get('location')).searchParams.get('state');
  const cs = await bs.req(`/hub/auth/callback?code=c3&state=${s3}`);
  const sec = cs.setCookies.find((c) => c.startsWith('__Host-grapim_session='));
  assert.ok(sec, cs.setCookies.join(' | '));
  assert.match(sec, /; Secure/);
  assert.match(sec, /; HttpOnly/);
  assert.match(cs.headers.get('strict-transport-security') || '', /max-age=/);
});

test('security headers on every response: CSP without inline script, nosniff, frame-ancestors none, referrer policy', async (t) => {
  const h = await startHub();
  t.after(h.close);
  for (const p of ['/hub', '/hub/api/me', '/hub/static/hub.css', '/nope']) {
    const r = await fetch(h.base + p, { redirect: 'manual' });
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/, p);
    assert.match(csp, /script-src 'self'(;|$)/, p);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, p);
    assert.match(csp, /frame-ancestors 'none'/, p);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
    assert.equal(r.headers.get('referrer-policy'), 'same-origin', p);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
  }
  const page = await (await fetch(`${h.base}/hub`)).text();
  assert.doesNotMatch(page, /<script>|<script(?![^>]*\bsrc=)[^>]*>|\son\w+=|style="/, 'no inline script, handler or style');
});

test('rate limiting on sign in and on sync', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const codes = [];
  for (let i = 0; i < 22; i++) codes.push((await fetch(`${h.base}/hub/auth/github`, { redirect: 'manual' })).status);
  assert.equal(codes.filter((c) => c === 303).length, 20);
  assert.equal(codes.at(-1), 429);
  const r = await fetch(`${h.base}/hub/auth/github`, { redirect: 'manual' });
  assert.ok(Number(r.headers.get('retry-after')) >= 1);

  let last;
  for (let i = 0; i < 245; i++) last = (await sync(h, 'cmh_nope', {})).status;
  assert.equal(last, 429, 'unknown tokens are throttled by address');
});

// ---------------------------------------------------------------- teams

test('team create, invite accept; an expired, reused or revoked invite is rejected', async (t) => {
  const clock = { t: Date.now() };
  const h = await startHub({ clock });
  t.after(h.close);
  const owner = await signIn(h, 'owner1');
  const team = await createTeam(owner, 'Acme platform');
  const teams = (await owner.req('/hub/api/teams')).json();
  assert.deepEqual(teams.map((x) => [x.id, x.name, x.role]), [[team, 'Acme platform', 'owner']]);

  // Accept.
  const link = await createInvite(owner, team);
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM invites WHERE token_hash = ?').get(sha256(link)).n, 1, 'stored hashed');
  assert.doesNotMatch(JSON.stringify(h.hub.db.prepare('SELECT * FROM invites').all()), new RegExp(link));
  const bob = await signIn(h, 'bob');
  const page = await bob.req(`/hub/invite/${link}`);
  assert.match(page.text, /Join Acme platform/);
  const acc = await bob.post('/hub/invite/accept', { token: link });
  assert.equal(acc.status, 303);
  assert.equal(acc.headers.get('location'), `/hub/teams/${team}`);
  const members = (await owner.req(`/hub/api/teams/${team}/members`)).json();
  assert.deepEqual(members.map((m) => [m.login, m.role]).sort(), [['bob', 'member'], ['owner1', 'owner']]);

  // Reused: someone else with the same link.
  const carol = await signIn(h, 'carol');
  assert.equal((await carol.post('/hub/invite/accept', { token: link })).status, 410);
  assert.match((await carol.req(`/hub/invite/${link}`)).text, /no longer valid/);

  // Revoked.
  const link2 = await createInvite(owner, team);
  const inv = (await owner.req(`/hub/api/teams/${team}/invites`)).json();
  assert.equal(inv.length, 1);
  assert.equal((await owner.post(`/hub/teams/${team}/invites/${inv[0].id}/revoke`)).status, 303);
  assert.equal((await carol.post('/hub/invite/accept', { token: link2 })).status, 410);

  // Expired: 7 days and a minute later.
  const link3 = await createInvite(owner, team);
  clock.t += 7 * 24 * 60 * 60 * 1000 + 60_000;
  assert.equal((await carol.post('/hub/invite/accept', { token: link3 })).status, 410);
  assert.equal((await owner.req(`/hub/api/teams/${team}/members`)).json().length, 2);

  // A member cannot invite; an owner can remove; the last owner cannot leave.
  assert.equal((await bob.post(`/hub/teams/${team}/invites`)).status, 403);
  assert.equal((await owner.post(`/hub/teams/${team}/leave`)).status, 409);
  const bobToken = await createToken(bob, team, 'bob-laptop');
  assert.equal((await owner.post(`/hub/teams/${team}/members/${bob.user.id}/remove`)).status, 303);
  assert.equal((await bob.req(`/hub/api/teams/${team}`)).status, 404);
  assert.equal((await sync(h, bobToken, batch())).status, 401, "a removed member's tokens stop working");
});

test('cross-team access: every team route answers 404 to a non-member, for sessions and machine tokens', async (t) => {
  const h = await startHub({ billing: fakeBilling().api, env: { STRIPE_PRICE_TEAM_MONTH: 'price_x' } });
  t.after(h.close);
  const alice = await signIn(h, 'alice');
  const mallory = await signIn(h, 'mallory');
  const A = await createTeam(alice, 'Team A');
  const M = await createTeam(mallory, 'Team M');
  const aToken = await createToken(alice, A);
  const mToken = await createToken(mallory, M);
  assert.equal((await sync(h, aToken, batch())).status, 200);
  const [inviteId] = (await alice.req(`/hub/api/teams/${A}/invites`, {})).json().map((i) => i.id).concat('x');
  const tokenId = h.hub.db.prepare('SELECT id FROM machine_tokens WHERE team_id = ?').get(A).id;
  const run = encodeURIComponent('claude-code:1a2b3c4d-0000');
  const R = `/hub/api/teams/${A}/repos/${REPO_ID}`;

  const gets = [
    `/hub/teams/${A}`,
    `/hub/teams/${A}/settings`,
    `/hub/teams/${A}/repos/${REPO_ID}`,
    `/hub/teams/${A}/repos/${REPO_ID}/runs/${run}`,
    `/hub/api/teams/${A}`,
    `/hub/api/teams/${A}/repos`,
    `/hub/api/teams/${A}/members`,
    `/hub/api/teams/${A}/invites`,
    `/hub/api/teams/${A}/tokens`,
    `/hub/api/teams/${A}/billing`,
    `${R}/overview`,
    `${R}/runs`,
    `${R}/runs/${run}`,
    `${R}/events`,
    `${R}/stream`,
  ];
  for (const p of gets) {
    // Alice can (the stream is opened and dropped).
    if (!p.endsWith('/stream')) assert.equal((await alice.req(p)).status, 200, `alice ${p}`);
    const r = await mallory.req(p);
    assert.equal(r.status, 404, `mallory GET ${p}`);
    assert.doesNotMatch(r.text, /Team A|shop-api|alice/, `nothing about team A leaks from ${p}`);
    const byToken = await fetch(h.base + p, { headers: { Authorization: `Bearer ${mToken}` }, redirect: 'manual' });
    // 404 where machine tokens may read, 401 (or a sign-in redirect) where they may not.
    assert.ok([404, 401, 303].includes(byToken.status), `mallory's token ${p}: ${byToken.status}`);
    if (p.startsWith(R) || p.endsWith('/repos')) assert.equal(byToken.status, 404, `mallory's token ${p}`);
  }
  // A non-existent team looks exactly the same.
  assert.equal((await mallory.req('/hub/api/teams/doesnotexist')).status, 404);

  const posts = [
    [`/hub/teams/${A}/invites`, {}],
    [`/hub/teams/${A}/invites/${inviteId}/revoke`, {}],
    [`/hub/teams/${A}/tokens`, { name: 'evil' }],
    [`/hub/teams/${A}/tokens/${tokenId}/revoke`, {}],
    [`/hub/teams/${A}/members/${alice.user.id}/remove`, {}],
    [`/hub/teams/${A}/leave`, {}],
    ['/hub/billing/checkout', { team: A, seats: '5', interval: 'month' }],
    ['/hub/billing/portal', { team: A }],
    [`${R}/runs/${run}/undo`, {}],
  ];
  for (const [p, form] of posts) assert.equal((await mallory.post(p, form)).status, 404, `mallory POST ${p}`);

  // Mallory's repo listing is empty, and the repo synced by A is invisible under M.
  assert.deepEqual((await mallory.req(`/hub/api/teams/${M}/repos`)).json(), []);
  assert.equal((await mallory.req(`/hub/api/teams/${M}/repos/${REPO_ID}/runs`)).status, 404);
  // Alice's data is untouched.
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM machine_tokens WHERE team_id = ? AND revoked_at IS NULL').get(A).n, 1);
  assert.equal((await alice.req(`/hub/api/teams/${A}/members`)).json().length, 1);
});

// ---------------------------------------------------------------- machine tokens

test('a machine token is shown once and stored only as sha256', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const b = await signIn(h, 'tok');
  const team = await createTeam(b);
  const r = await b.post(`/hub/teams/${team}/tokens`, { name: 'ci-runner' });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const token = r.text.match(/value="(cmh_[A-Za-z0-9_-]+)"/)[1];
  assert.ok(token.length >= 40);
  const rows = h.hub.db.prepare('SELECT * FROM machine_tokens').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, sha256(token));
  assert.equal(rows[0].hint, token.slice(-4));
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(token.slice(4, 20)));

  // Never again: not on the settings page, not in the API.
  const again = await b.req(`/hub/teams/${team}/settings`);
  assert.match(again.text, /ci-runner/);
  assert.doesNotMatch(again.text, new RegExp(token));
  const list = (await b.req(`/hub/api/teams/${team}/tokens`)).json();
  assert.equal(list.length, 1);
  assert.doesNotMatch(JSON.stringify(list), new RegExp(token));
  assert.equal(list[0].last_used_at, null);

  // Works, records last use, and stops after revoke.
  assert.equal((await sync(h, token, batch())).status, 200);
  assert.ok((await b.req(`/hub/api/teams/${team}/tokens`)).json()[0].last_used_at > 0);
  assert.equal((await b.post(`/hub/teams/${team}/tokens/${rows[0].id}/revoke`)).status, 303);
  assert.equal((await sync(h, token, batch())).status, 401);
  assert.doesNotMatch(h.logs.join('\n'), new RegExp(token));
});

// ---------------------------------------------------------------- sync ingest

test('sync is idempotent, verifies blob shas and enforces size limits', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const b = await signIn(h, 'syncer');
  const team = await createTeam(b);
  const token = await createToken(b, team);

  const one = await sync(h, token, batch());
  assert.equal(one.status, 200);
  const j1 = await one.json();
  assert.deepEqual(j1.cursor, { changes: 1, events: 2, agents: j1.cursor.agents });
  assert.equal(j1.stored.changes, 1);
  const two = await (await sync(h, token, batch())).json();
  assert.equal(two.stored.changes, 0);
  assert.equal(two.stored.events, 0);
  const count = (tbl) => h.hub.db.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).get().n;
  assert.equal(count('h_changes'), 1);
  assert.equal(count('h_events'), 2);
  assert.equal(count('h_blobs'), 2);
  assert.equal(count('h_runs'), 1);
  assert.equal(count('repos'), 1);

  // A blob whose content does not hash to its key: the whole batch is refused.
  const bad = batch();
  const [k] = Object.keys(bad.blobs);
  bad.blobs[k] = Buffer.from('something else\n').toString('base64');
  bad.changes[0].id = 2;
  const rb = await sync(h, token, bad);
  assert.equal(rb.status, 400);
  assert.equal((await rb.json()).error.code, 'sha_mismatch');
  assert.equal(count('h_changes'), 1, 'nothing from the bad batch was written');

  // A blob over 2 MB.
  const big = Buffer.alloc(2 * 1024 * 1024 + 1, 'a');
  const over = batch();
  over.changes[0].after_sha = sha1(big);
  over.blobs = { [sha1(big)]: big.toString('base64') };
  assert.equal((await sync(h, token, over)).status, 413);

  // A body over 8 MB.
  const huge = JSON.stringify({ ...batch(), pad: 'x'.repeat(8 * 1024 * 1024) });
  assert.equal((await sync(h, token, null, huge)).status, 413);

  // Malformed input.
  assert.equal((await sync(h, token, { ...batch(), repo: { id: 'nope', name: 'x' } })).status, 400);
  assert.equal((await sync(h, token, { ...batch(), machine: '../../etc' })).status, 400);
  assert.equal((await sync(h, token, null, '{not json')).status, 400);
  // An unreferenced blob.
  const stray = Buffer.from('stray\n');
  assert.equal((await sync(h, token, { ...batch(), blobs: { [sha1(stray)]: stray.toString('base64') } })).status, 400);
  // No token, or not a bearer.
  assert.equal((await fetch(`${h.base}/hub/api/sync`, { method: 'POST', body: '{}' })).status, 401);

  // A client that believes it sent more than the hub has gets the hub's cursor back.
  const ahead = batch({ machine: 'other-box' });
  ahead.cursor = { changes: 50, events: 50, agents: 0 };
  const ra = await sync(h, token, ahead);
  assert.equal(ra.status, 409);
  assert.deepEqual((await ra.json()).cursor, { changes: 0, events: 0, agents: 0 });

  // Another member cannot write into a machine name someone else owns.
  const m2 = await signIn(h, 'second');
  await joinTeam(b, m2, team);
  const t2 = await createToken(m2, team);
  assert.equal((await sync(h, t2, batch())).status, 409);
});

test('plan limits: repos per team from the plan (defaults without the billing module)', async (t) => {
  const h = await startHub({ billing: null });
  t.after(h.close);
  const b = await signIn(h, 'lim');
  const team = await createTeam(b);
  const token = await createToken(b, team);
  const repo = (n) => ({ ...batch(), repo: { id: sha1(`repo ${n}`), name: `r${n}` } });
  assert.equal((await sync(h, token, repo(1))).status, 200);
  assert.equal((await sync(h, token, repo(2))).status, 200);
  const r = await sync(h, token, repo(3));
  assert.equal(r.status, 402);
  assert.equal((await r.json()).error.code, 'plan_limit');
});

// ---------------------------------------------------------------- read API

test('the team runs API matches the local contract shape (docs/api.md)', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const b = await signIn(h, 'reader');
  const team = await createTeam(b);
  const token = await createToken(b, team);
  assert.equal((await sync(h, token, batch())).status, 200);
  const R = `/hub/api/teams/${team}/repos/${REPO_ID}`;

  const repos = (await b.req(`/hub/api/teams/${team}/repos`)).json();
  assert.equal(repos[0].id, REPO_ID);
  assert.equal(repos[0].name, 'shop-api');

  const runs = (await b.req(`${R}/runs`)).json();
  assert.equal(runs.length, 1);
  const keys = ['run', 'label', 'worktree', 'intent', 'turns', 'files', 'added', 'removed', 'in_tree', 'first_ts', 'last_ts', 'active', 'review', 'branch'];
  for (const k of keys) assert.ok(k in runs[0], `runs[0].${k}`);
  assert.equal(runs[0].run, 'claude-code:1a2b3c4d-0000');
  assert.equal(runs[0].label, 'claude 1a2b3c4d');
  assert.equal(runs[0].intent, 'Add /billing');
  assert.equal(runs[0].files, 1);
  assert.equal(runs[0].added, 2);
  assert.equal(runs[0].in_tree, 'all');
  assert.equal(runs[0].active, true);
  assert.deepEqual(runs[0].review, { status: 'pending', note: null, at: null, by: null });
  assert.equal(runs[0].branch, null);
  assert.equal(runs[0].machine, 'alex-mbp');

  // By session id prefix, like `grapim undo 1a2b`.
  const detail = (await b.req(`${R}/runs/1a2b`)).json();
  assert.deepEqual(Object.keys(detail).sort(), ['files', 'run', 'turns']);
  assert.deepEqual(detail.turns, [{ turn: 1, intent: 'Add /billing', ts: detail.turns[0].ts, files: ['src/app.js'] }]);
  const f = detail.files[0];
  assert.equal(f.path, 'src/app.js');
  assert.equal(f.state, 'in_tree');
  assert.equal(f.untracked, false);
  assert.deepEqual(f.diff.hunks, [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
      lines: [
        { t: ' ', s: 'a' },
        { t: '-', s: 'b' },
        { t: '+', s: 'B' },
        { t: ' ', s: 'c' },
        { t: '+', s: 'd' },
      ],
    },
  ]);

  const ov = (await b.req(`${R}/overview`)).json();
  for (const k of ['repo', 'root', 'worktrees', 'agents', 'leases', 'counts']) assert.ok(k in ov, `overview.${k}`);
  assert.equal(ov.repo, 'shop-api');
  assert.equal(ov.agents[0].label, 'claude 1a2b3c4d');
  assert.deepEqual(Object.keys(ov.counts).sort(), ['agents', 'leases', 'runs', 'unreviewed']);

  const ev = (await b.req(`${R}/events?after=0&limit=100`)).json();
  assert.deepEqual(ev.map((e) => e.kind), ['intent', 'edit']);
  for (const k of ['id', 'ts', 'agent', 'label', 'kind', 'path', 'detail']) assert.ok(k in ev[0], `events[0].${k}`);
  assert.deepEqual((await b.req(`${R}/events?after=${ev[1].id}`)).json(), []);

  // The machine token can read its own team's repos too.
  const viaToken = await fetch(`${h.base}${R}/runs`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(viaToken.status, 200);

  // Code is read-only on the hub.
  const undo = await b.post(`${R}/runs/1a2b/undo`);
  assert.equal(undo.status, 405);
  assert.match(undo.json().error.message, /read-only/);

  // The pages render the same data.
  const page = await b.req(`/hub/teams/${team}/repos/${REPO_ID}`);
  assert.match(page.text, /claude 1a2b3c4d/);
  const runPageRes = await b.req(`/hub/teams/${team}/repos/${REPO_ID}/runs/${encodeURIComponent('claude-code:1a2b3c4d-0000')}`);
  assert.equal(runPageRes.status, 200);
  assert.match(runPageRes.text, /src\/app\.js/);
});

test('the SSE stream ticks when a sync lands', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const b = await signIn(h, 'streamer');
  const team = await createTeam(b);
  const token = await createToken(b, team);
  assert.equal((await sync(h, token, batch())).status, 200);
  const ac = new AbortController();
  t.after(() => ac.abort());
  const res = await fetch(`${h.base}/hub/api/teams/${team}/repos/${REPO_ID}/stream`, { headers: { Cookie: `grapim_session=${b.jar.get('grapim_session')}` }, signal: ac.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const next = async () => dec.decode((await reader.read()).value);
  assert.match(await next(), /event: tick\ndata: \{"last_event_id":2\}/);
  const more = batch();
  more.cursor = { changes: 1, events: 2, agents: 0 };
  more.events = [{ id: 3, ts: Date.now(), agent: 'claude-code:1a2b3c4d-0000', kind: 'end', path: null, detail: null }];
  more.changes = [];
  more.blobs = {};
  assert.equal((await sync(h, token, more)).status, 200);
  assert.match(await next(), /"last_event_id":3/);
  ac.abort();
});

// ---------------------------------------------------------------- CSRF

test('CSRF: state-changing browser routes need the same Origin and the session token', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const b = await signIn(h, 'csrf');
  const csrf = await b.csrf();
  const post = (opts) => b.req('/hub/teams', { method: 'POST', ...opts });

  assert.equal((await post({ form: { name: 'x' } })).status, 403, 'no token');
  assert.equal((await post({ form: { name: 'x', _csrf: 'wrong' } })).status, 403, 'wrong token');
  assert.equal((await post({ form: { name: 'x', _csrf: csrf }, origin: 'https://evil.example' })).status, 403, 'foreign Origin');
  assert.equal((await post({ form: { name: 'x', _csrf: csrf }, origin: null })).status, 403, 'no Origin, no Referer');
  assert.equal((await post({ form: { name: 'x', _csrf: csrf }, headers: { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' } })).status, 403, 'cross-site fetch metadata');
  // Another user's token does not work for this session.
  const other = await signIn(h, 'csrf2');
  assert.equal((await post({ form: { name: 'x', _csrf: await other.csrf() } })).status, 403);
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM teams').get().n, 0);

  // Referer from the hub is accepted when Origin is missing; then the real thing.
  assert.equal((await post({ form: { name: 'x', _csrf: csrf }, origin: null, headers: { Referer: `${ORIGIN}/hub` } })).status, 303);
  assert.equal((await post({ form: { name: 'y', _csrf: csrf } })).status, 303);
  // Logout is CSRF checked too.
  assert.equal((await b.req('/hub/logout', { method: 'POST', form: {} })).status, 403);
});

// ---------------------------------------------------------------- billing wiring

function fakeBilling() {
  const calls = { checkout: [], portal: [], webhook: [] };
  const api = {
    limitsFor: (plan, { seats } = {}) => (plan === 'team' ? { seats: seats ?? 10, historyDays: 90, repos: Infinity } : { seats: 3, historyDays: 7, repos: 2 }),
    createCheckout: async (args) => {
      calls.checkout.push(args);
      return { url: 'https://checkout.stripe.com/c/pay/cs_test_123' };
    },
    createPortal: async (args) => {
      calls.portal.push(args);
      return { url: 'https://billing.stripe.com/p/session/test_123' };
    },
    handleWebhook: async (raw, sig, { setPlan }) => {
      calls.webhook.push({ raw, sig });
      if (sig !== 't=1,v1=good') throw Object.assign(new Error('Bad Stripe signature'), { code: 'bad_signature' });
      const ev = JSON.parse(raw.toString('utf8'));
      await setPlan(ev.team, { plan: 'team', seats: 12, status: 'active', customerId: 'cus_123', subscriptionId: 'sub_123', periodEnd: 1_900_000_000_000, eventAt: Date.now() });
      return { handled: true, type: ev.type };
    },
  };
  return { api, calls };
}

test('billing routes call the billing module; the webhook gets the raw body; plan fields land on the team', async (t) => {
  const fake = fakeBilling();
  const h = await startHub({ billing: fake.api, env: { STRIPE_PRICE_TEAM_MONTH: 'price_month' } });
  t.after(h.close);
  const owner = await signIn(h, 'payer');
  const team = await createTeam(owner, 'Payers');
  const member = await signIn(h, 'notpayer');
  await joinTeam(owner, member, team);

  const settings = await owner.req(`/hub/teams/${team}/settings`);
  assert.match(settings.text, /Upgrade to Team/);

  const co = await owner.post('/hub/billing/checkout', { team, seats: '5', interval: 'month' });
  assert.equal(co.status, 303);
  assert.equal(co.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_test_123');
  const args = fake.calls.checkout[0];
  assert.equal(args.team.id, team);
  assert.equal(args.user.id, owner.user.id);
  assert.equal(args.seats, 5);
  assert.equal(args.successUrl, `${ORIGIN}/hub/teams/${team}/settings?billing=success#billing`);
  assert.equal(args.cancelUrl, `${ORIGIN}/hub/teams/${team}/settings?billing=cancel#billing`);
  assert.equal((await member.post('/hub/billing/checkout', { team, seats: '5' })).status, 403, 'members cannot buy');
  assert.equal((await owner.post('/hub/billing/checkout', { team, seats: '1' })).status, 400, 'fewer seats than members');

  // The webhook: raw bytes passed through exactly, no CSRF or session needed.
  const raw = `{ "type": "checkout.session.completed",\n  "team": "${team}" }`;
  const bad = await fetch(`${h.base}/hub/stripe/webhook`, { method: 'POST', body: raw, headers: { 'Stripe-Signature': 't=1,v1=forged', 'Content-Type': 'application/json' } });
  assert.equal(bad.status, 400);
  const ok = await fetch(`${h.base}/hub/stripe/webhook`, { method: 'POST', body: raw, headers: { 'Stripe-Signature': 't=1,v1=good', 'Content-Type': 'application/json' } });
  assert.equal(ok.status, 200);
  assert.ok(Buffer.isBuffer(fake.calls.webhook[1].raw));
  assert.equal(fake.calls.webhook[1].raw.toString('utf8'), raw, 'the exact bytes Stripe signed');
  const row = h.hub.db.prepare('SELECT plan, seats, plan_status, customer_id, subscription_id, period_end FROM teams WHERE id = ?').get(team);
  assert.deepEqual({ ...row }, { plan: 'team', seats: 12, plan_status: 'active', customer_id: 'cus_123', subscription_id: 'sub_123', period_end: 1_900_000_000_000 });
  const billing = (await owner.req(`/hub/api/teams/${team}/billing`)).json();
  assert.equal(billing.plan, 'team');
  assert.equal(billing.limits.seats, 12);

  // The portal, now that there is a customer.
  const portal = await owner.post('/hub/billing/portal', { team });
  assert.equal(portal.status, 303);
  assert.equal(portal.headers.get('location'), 'https://billing.stripe.com/p/session/test_123');
  assert.equal(fake.calls.portal[0].team.stripe_customer_id, 'cus_123');

  // A billing module answering with a non-Stripe URL is not followed.
  fake.api.createPortal = async () => ({ url: 'https://evil.example/phish' });
  assert.equal((await owner.post('/hub/billing/portal', { team })).status, 502);
});

test('without billing configured the billing routes answer 503, and billing.js (if present) loads behind a dynamic import', async (t) => {
  const h = await startHub({ billing: null });
  t.after(h.close);
  const b = await signIn(h, 'nobill');
  const team = await createTeam(b);
  assert.equal((await b.post('/hub/billing/checkout', { team, seats: '2' })).status, 503);
  assert.equal((await fetch(`${h.base}/hub/stripe/webhook`, { method: 'POST', body: '{}' })).status, 503);
  const mod = await loadBilling({ env: {}, fetch: async () => new Response('{}') });
  if (fs.existsSync(new URL('../src/hub/billing.js', import.meta.url))) {
    assert.equal(typeof mod.limitsFor, 'function');
    const free = mod.limitsFor('free');
    assert.ok(free.seats >= 1 && free.historyDays >= 1);
  } else {
    assert.equal(mod, null);
  }
});

// ---------------------------------------------------------------- end to end

function gitRepo() {
  const root = tmp('grapim-hub-repo-');
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'routes.js'), 'export const routes = [];\nexport default routes;\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return root;
}

test('end to end: hook edits in a real repo, syncOnce to an in-process hub, the hub shows the run with its diff', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const b = await signIn(h, 'e2e');
  const team = await createTeam(b, 'E2E');
  const token = await createToken(b, team, 'ci');

  const root = gitRepo();
  const file = path.join(root, 'src', 'routes.js');
  const session = 'e2e0000a-1111-2222-3333-444455556666';
  const env = { ...process.env, GRAPIM_STATE_DIR: '' };
  delete env.GRAPIM_STATE_DIR;
  const hook = (input) => runHook({ session_id: session, cwd: root, ...input }, env);
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Add a /billing route' });
  const edit = { tool_name: 'Edit', tool_input: { file_path: file }, tool_use_id: 'tu1' };
  assert.equal(hook({ hook_event_name: 'PreToolUse', ...edit }).code, 0);
  fs.writeFileSync(file, "export const routes = [];\nroutes.push('/billing');\nexport default routes;\n");
  assert.equal(hook({ hook_event_name: 'PostToolUse', ...edit }).code, 0);
  const created = path.join(root, 'src', 'billing.js');
  const edit2 = { tool_name: 'Write', tool_input: { file_path: created }, tool_use_id: 'tu2' };
  hook({ hook_event_name: 'PreToolUse', ...edit2 });
  fs.writeFileSync(created, 'export function bill() {\n  return 1;\n}\n');
  hook({ hook_event_name: 'PostToolUse', ...edit2 });

  const ws = resolveWorkspace(root);
  const store = new Store(ws.stateDir);
  t.after(() => store.close());
  const first = await syncOnce({ ws, store, hubUrl: h.base, token, machine: 'ci-box' });
  assert.equal(first.changes, 2);
  assert.equal(first.blobs, 3);
  // Nothing new: a second sync sends nothing again.
  const second = await syncOnce({ ws, store, hubUrl: h.base, token, machine: 'ci-box' });
  assert.equal(second.changes, 0);
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM h_changes').get().n, 2);
  // The cursor lives in the state dir.
  assert.ok(fs.existsSync(path.join(ws.stateDir, 'hub-sync.json')));

  const repoId = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const R = `/hub/api/teams/${team}/repos/${repoId}`;
  const runs = (await b.req(`${R}/runs`)).json();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].run, `claude-code:${session}`);
  assert.equal(runs[0].label, 'claude e2e0000a');
  assert.equal(runs[0].intent, 'Add a /billing route');
  assert.equal(runs[0].files, 2);
  assert.equal(runs[0].machine, 'ci-box');
  assert.equal(runs[0].in_tree, 'all');

  const detail = (await b.req(`${R}/runs/e2e0`)).json();
  const routes = detail.files.find((f) => f.path === 'src/routes.js');
  assert.deepEqual(
    routes.diff.hunks[0].lines.filter((l) => l.t !== ' '),
    [{ t: '+', s: "routes.push('/billing');" }],
  );
  const billing = detail.files.find((f) => f.path === 'src/billing.js');
  assert.equal(billing.diff.hunks[0].oldStart, 0);
  assert.equal(billing.diff.hunks[0].newLines, 3);
  assert.deepEqual(detail.turns.map((x) => [x.turn, x.intent]), [[1, 'Add a /billing route']]);
  // No local absolute paths reached the hub.
  const stored = JSON.stringify(h.hub.db.prepare('SELECT * FROM h_changes').all());
  assert.ok(!stored.includes(root.split(path.sep).join('/')) && !stored.includes(root), 'the local root path is not synced');

  // A plain-http hub that is not on this machine is refused before any request.
  await assert.rejects(syncOnce({ ws, store, hubUrl: 'http://hub.example.com', token }), /https/);
});
