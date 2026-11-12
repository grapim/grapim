// Regression tests for the hub security review of 2026-11-11
// (docs/security-review-hub-2026-11-11.md). Tenant isolation is checked by
// enumerating the router's routes, so a new team route is covered (or fails
// the structural checks) without anyone remembering to add it here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../src/hub/server.js';
import { loadConfig } from '../src/hub/config.js';
import { safeNext } from '../src/hub/auth.js';
import { rateKey } from '../src/hub/http.js';
import { RateLimiter } from '../src/hub/ratelimit.js';
import { hunks } from '../src/hub/hunks.js';
import { time, date } from '../src/hub/pages/html.js';
import { MAX_STREAMS_PER_USER } from '../src/hub/routes-api.js';

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

function fakeBilling() {
  return {
    limitsFor: (plan, { seats } = {}) => (plan === 'team' ? { seats: seats ?? 10, historyDays: 90, repos: Infinity } : { seats: 3, historyDays: 7, repos: 2 }),
    createCheckout: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }),
    createPortal: async () => ({ url: 'https://billing.stripe.com/p/session/test_1' }),
    handleWebhook: async () => ({ handled: false }),
  };
}

async function startHub({ env = {}, billing = null, loadRealBilling = false } = {}) {
  const gh = fakeGitHub();
  const opts = {
    env: {
      HUB_URL: ORIGIN,
      HUB_SECRET: 'test-secret-that-is-long-enough-0123456789',
      HUB_DATA: tmp('grapim-hubsec-'),
      GITHUB_CLIENT_ID: 'gh-client',
      GITHUB_CLIENT_SECRET: 'gh-secret',
      ...env,
    },
    fetch: gh.fetch,
    log: () => {},
  };
  if (!loadRealBilling) opts.billing = billing;
  const hub = await createHub(opts);
  const addr = await hub.listen(0, '127.0.0.1');
  return { hub, gh, base: `http://127.0.0.1:${addr.port}`, port: addr.port, close: () => hub.close() };
}

class Browser {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }
  async req(p, { method = 'GET', form = null, headers = {}, origin = ORIGIN } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET' && origin && !('Origin' in h)) h.Origin = origin;
    let body;
    if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(this.base + p, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
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

let nextId = 5000;
async function signIn(h, login) {
  const id = nextId++;
  h.gh.user(`code-${id}`, { id, login, name: login, avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4` });
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
  const r = await member.post('/hub/invite/accept', { token: await createInvite(owner, team) });
  assert.equal(r.status, 303, r.text);
}

const REPO_A = sha1('alpha root commit');
const REPO_M = sha1('mallory root commit');
const RUN_A = 'claude-code:alpha-run-0001';
const RUN_M = 'claude-code:mallo-run-0001';

function batch({ repo = REPO_A, name = 'alpha-api', run = RUN_A, file = 'src/alpha.js', before = 'one\ntwo\n', after = 'one\nalpha-secret-content\n', machine = 'box', label = 'claude alpha', intent = 'alpha intent', cursor = { changes: 0, events: 0, agents: 0 }, id = 1, blobs = true, extra = {} } = {}) {
  const b = Buffer.from(before);
  const a = Buffer.from(after);
  return {
    repo: { id: repo, name },
    machine,
    cursor,
    runs: [{ run, turn: 1, started_at: Date.now() - 1000 }],
    agents: [{ agent: run, label, intent, worktree: 'wt', last_seen: Date.now() }],
    changes: [{ id, run, label, turn: 1, worktree: 'wt', path: file, before_sha: sha1(b), after_sha: sha1(a), untracked: false, added: 1, removed: 1, ts: Date.now() }],
    events: [{ id, ts: Date.now() - 5, agent: run, kind: 'intent', path: null, detail: intent }],
    blobs: blobs ? { [sha1(b)]: b.toString('base64'), [sha1(a)]: a.toString('base64') } : {},
    ...extra,
  };
}

const sync = (h, token, body) =>
  fetch(`${h.base}/hub/api/sync`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const fill = (pattern, ids) =>
  pattern.replace(/:(\w+)/g, (_, k) => {
    if (!(k in ids)) throw new Error(`the isolation test has no value for :${k} in ${pattern}: add one`);
    return encodeURIComponent(ids[k]);
  });

// GET that never hangs on an event stream.
async function getOnce(h, p, headers) {
  const ac = new AbortController();
  const res = await fetch(h.base + p, { headers, redirect: 'manual', signal: ac.signal });
  const stream = (res.headers.get('content-type') || '').startsWith('text/event-stream');
  const text = stream ? '' : await res.text();
  ac.abort();
  return { status: res.status, text };
}

const cookieOf = (b) => [...b.jar].map(([k, v]) => `${k}=${v}`).join('; ');

// A cloud workspace with one token in the team, for the :ws and :wstoken ids.
async function workspaceIds(b, team, name = 'notes') {
  const r = await b.post(`/hub/teams/${team}/workspaces`, { name });
  assert.equal(r.status, 303, r.text);
  const ws = r.headers.get('location').match(/\/workspaces\/([^/]+)$/)[1];
  assert.equal((await b.post(`/hub/teams/${team}/workspaces/${ws}/tokens`, { name: `${name}-token`, scope: 'write' })).status, 200);
  return ws;
}

// ---------------------------------------------------------------- tenant isolation

test('every team route (enumerated from the router) is guarded, and answers 404 to another team by session, by token and by foreign ids', async (t) => {
  const h = await startHub({ billing: fakeBilling(), env: { STRIPE_PRICE_TEAM_MONTH: 'price_x' } });
  t.after(h.close);
  const alice = await signIn(h, 'alice');
  const mallory = await signIn(h, 'mallory');
  const A = await createTeam(alice, 'Team Alpha');
  const M = await createTeam(mallory, 'Team Mallory');
  const aToken = await createToken(alice, A, 'alpha-laptop');
  const mToken = await createToken(mallory, M, 'mallory-laptop');
  assert.equal((await sync(h, aToken, batch())).status, 200);
  assert.equal((await sync(h, mToken, batch({ repo: REPO_M, name: 'mallory-api', run: RUN_M, file: 'src/m.js', before: 'm\n', after: 'mm\n', label: 'claude m', intent: 'm intent' }))).status, 200);
  await createInvite(alice, A);
  const wsA = await workspaceIds(alice, A, 'alpha-ws');
  const db = h.hub.db;
  const idsA = {
    ws: wsA,
    wstoken: db.prepare('SELECT id FROM workspace_tokens WHERE workspace_id = ?').get(wsA).id,
    team: A,
    repo: REPO_A,
    run: RUN_A,
    invite: db.prepare('SELECT id FROM invites WHERE team_id = ?').get(A).id,
    token: db.prepare('SELECT id FROM machine_tokens WHERE team_id = ?').get(A).id,
    user: String(alice.user.id),
    key: 'no-such-platform-key', // platform API keys (team A is not a platform; the team guard answers first)
  };

  // Structural guarantees, for every route the hub serves.
  const routes = h.hub.router.routes;
  const READ_ONLY_STUB = /\/runs\/:run\/(undo|branch|review)$/;
  for (const r of routes) {
    const name = `${r.method} ${r.pattern}`;
    if (r.pattern.includes(':team')) assert.ok(r.opts.team, `${name} takes a team id but has no membership guard`);
    if (r.pattern.includes(':repo')) assert.ok(r.opts.repo, `${name} takes a repo id but does not look it up inside the team`);
    if (r.pattern.includes(':ws')) assert.ok(r.opts.workspace, `${name} takes a workspace id but does not look it up inside the team`);
    if (r.opts.team === 'form') assert.ok(r.opts.csrf, `${name} reads the team from a form without CSRF`);
    if (r.opts.team) assert.equal(r.opts.auth, 'session', `${name} is a team route without sign in`);
    if (r.method === 'POST' && !r.opts.csrf) {
      assert.ok(['/hub/api/sync', '/hub/stripe/webhook', '/hub/github/webhook'].includes(r.pattern) || READ_ONLY_STUB.test(r.pattern), `${name} changes state without CSRF`);
    }
  }
  const teamRoutes = routes.filter((r) => r.opts.team);
  assert.ok(teamRoutes.length >= 26, `expected every team route to be enumerated, got ${teamRoutes.length}`);

  const snapshot = () =>
    JSON.stringify({
      team: db.prepare('SELECT * FROM teams WHERE id = ?').get(A),
      members: db.prepare('SELECT * FROM members WHERE team_id = ? ORDER BY user_id').all(A),
      invites: db.prepare('SELECT * FROM invites WHERE team_id = ? ORDER BY id').all(A),
      tokens: db.prepare('SELECT id, revoked_at FROM machine_tokens WHERE team_id = ? ORDER BY id').all(A),
      rows: db.prepare('SELECT COUNT(*) AS n FROM h_changes WHERE team_id = ?').get(A).n,
    });
  const before = snapshot();
  const LEAK = /Team Alpha|alpha-api|alpha-secret-content|alpha intent|alpha-laptop|claude alpha/;

  let checked = 0;
  for (const r of teamRoutes) {
    const name = `${r.method} ${r.pattern}`;
    const p = fill(r.pattern, idsA);
    const form = r.opts.team === 'form' ? { team: A, seats: '5', interval: 'month' } : { name: 'evil' };

    // 1. Mallory's session, on team A's ids.
    const viaSession = r.method === 'GET' ? await getOnce(h, p, { Cookie: cookieOf(mallory) }) : await mallory.post(p, form);
    assert.equal(viaSession.status, 404, `mallory ${name}`);
    assert.doesNotMatch(viaSession.text, LEAK, `nothing of team A leaks from ${name}`);

    // 2. Mallory's machine token, on team A's ids.
    const headers = { Authorization: `Bearer ${mToken}` };
    const viaToken =
      r.method === 'GET'
        ? await getOnce(h, p, headers)
        : await (async () => {
            const res = await fetch(h.base + p, { method: 'POST', headers: { ...headers, Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(), redirect: 'manual' });
            return { status: res.status, text: await res.text() };
          })();
    if (r.opts.token) assert.equal(viaToken.status, 404, `mallory's token ${name}`);
    else assert.ok([401, 303].includes(viaToken.status), `mallory's token ${name}: ${viaToken.status}`);
    assert.doesNotMatch(viaToken.text, LEAK, `nothing of team A leaks from ${name} by token`);

    // 3. Mallory's own team, with team A's repo, run, invite, token or user id.
    if (/:(repo|run|invite|token|user|ws|wstoken)\b/.test(r.pattern)) {
      const ids = { ...idsA, team: M, repo: r.pattern.includes(':run') ? REPO_M : REPO_A };
      const q = fill(r.pattern, ids);
      const cross = r.method === 'GET' ? await getOnce(h, q, { Cookie: cookieOf(mallory) }) : await mallory.post(q, form);
      const expected = READ_ONLY_STUB.test(r.pattern) ? [405] : [404];
      assert.ok(expected.includes(cross.status), `mallory ${name} with team A's ids under her own team: ${cross.status}`);
      assert.doesNotMatch(cross.text, LEAK, `nothing of team A leaks from ${name} with foreign ids`);
    }
    checked++;
  }
  assert.equal(checked, teamRoutes.length);
  assert.equal(snapshot(), before, 'team A is unchanged');

  // Alice can use the same GET routes (the substitutions are real ids). The
  // report API is on the governance plan (a free team gets 402 plan_required).
  db.prepare("UPDATE teams SET plan = 'governance' WHERE id = ?").run(A);
  for (const r of teamRoutes.filter((x) => x.method === 'GET' && !x.pattern.endsWith('/stream'))) {
    assert.equal((await getOnce(h, fill(r.pattern, idsA), { Cookie: cookieOf(alice) })).status, 200, `alice GET ${r.pattern}`);
  }
});

test('roles: a member cannot do owner things on any team route, nor touch another member\'s token', async (t) => {
  const h = await startHub({ billing: fakeBilling(), env: { STRIPE_PRICE_TEAM_MONTH: 'price_x' } });
  t.after(h.close);
  const alice = await signIn(h, 'owner-alice');
  const bob = await signIn(h, 'member-bob');
  const A = await createTeam(alice, 'Roles');
  await joinTeam(alice, bob, A);
  await createToken(alice, A, 'alice-box');
  await createInvite(alice, A);
  const ws = await workspaceIds(alice, A);
  const db = h.hub.db;
  const ids = {
    ws,
    wstoken: db.prepare('SELECT id FROM workspace_tokens WHERE workspace_id = ?').get(ws).id,
    team: A,
    repo: REPO_A,
    run: RUN_A,
    invite: db.prepare('SELECT id FROM invites WHERE team_id = ? AND used_at IS NULL').get(A).id,
    token: db.prepare('SELECT id FROM machine_tokens WHERE team_id = ?').get(A).id,
    user: String(alice.user.id),
    key: 'no-such-platform-key', // platform API keys (team A is not a platform; the team guard answers first)
  };
  assert.equal(db.prepare('SELECT role FROM members WHERE team_id = ? AND user_id = ?').get(A, bob.user.id).role, 'member', 'an invite grants member, never owner');

  // What a member may do; every other state-changing team route is owner only.
  // Any member may also create, rename and make tokens for cloud workspaces; deleting one is owner only.
  const MEMBER_MAY = new Set([
    'POST /hub/teams/:team/tokens',
    'POST /hub/teams/:team/leave',
    'POST /hub/teams/:team/workspaces',
    'POST /hub/teams/:team/workspaces/:ws/rename',
    'POST /hub/teams/:team/workspaces/:ws/tokens',
    // Ask Grapim (src/hub/agent/) is for every member: these only talk to the
    // assistant or record a decision on a proposal; any write it proposes goes
    // through the page route above, with that route's own role check.
    'POST /hub/api/teams/:team/agent/messages',
    'POST /hub/api/teams/:team/agent/stop',
    'POST /hub/api/teams/:team/agent/new',
    'POST /hub/api/teams/:team/agent/actions',
    'POST /hub/api/teams/:team/agent/open',
    'POST /hub/api/teams/:team/agent/feedback',
  ]);
  const before = JSON.stringify(db.prepare('SELECT * FROM invites').all()) + JSON.stringify(db.prepare('SELECT * FROM members').all());
  for (const r of h.hub.router.routes.filter((x) => x.opts.team && x.method === 'POST')) {
    const name = `${r.method} ${r.pattern}`;
    if (MEMBER_MAY.has(name) || /\/runs\/:run\//.test(r.pattern) || !r.opts.csrf) continue;
    const form = r.opts.team === 'form' ? { team: A, seats: '5', interval: 'month' } : {};
    const res = await bob.post(fill(r.pattern, ids), form);
    if (/\/tokens\/:(token|wstoken)\/revoke$/.test(r.pattern)) assert.equal(res.status, 404, `bob revoking alice's token: ${res.status}`);
    else assert.equal(res.status, 403, `bob ${name}: ${res.status}`);
  }
  for (const r of h.hub.router.routes.filter((x) => x.opts.owner && x.method === 'GET')) {
    assert.equal((await bob.req(fill(r.pattern, ids))).status, 403, `bob GET ${r.pattern}`);
  }
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM invites').all()) + JSON.stringify(db.prepare('SELECT * FROM members').all()), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM machine_tokens WHERE revoked_at IS NULL').get().n, 1);
  assert.deepEqual((await bob.req(`/hub/api/teams/${A}/tokens`)).json(), [], "a member does not see other members' tokens");
});

test('the same repo id in two teams stays two repos, and blobs never cross teams', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'blob-alice');
  const mallory = await signIn(h, 'blob-mallory');
  const A = await createTeam(alice, 'Blob A');
  const M = await createTeam(mallory, 'Blob M');
  const aToken = await createToken(alice, A);
  const mToken = await createToken(mallory, M);
  assert.equal((await sync(h, aToken, batch())).status, 200);

  // Mallory forks the same repo (same root commit) and references the shas of
  // A's content without uploading it.
  const probe = batch({ run: RUN_M, label: 'claude m', intent: 'm intent', blobs: false });
  assert.equal((await sync(h, mToken, probe)).status, 200);
  const runs = (await mallory.req(`/hub/api/teams/${M}/repos/${REPO_A}/runs`)).json();
  assert.deepEqual(runs.map((r) => r.run), [RUN_M], "only M's own run");
  const detail = await mallory.req(`/hub/api/teams/${M}/repos/${REPO_A}/runs/${encodeURIComponent(RUN_M)}`);
  assert.equal(detail.status, 200);
  assert.doesNotMatch(detail.text, /alpha-secret-content/, "A's blob is never served to M");
  assert.equal(detail.json().files[0].diff, null, 'content not kept, from M\'s point of view');
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM h_blobs WHERE team_id = ?').get(M).n, 0);
  assert.equal((await mallory.req(`/hub/teams/${M}/repos/${REPO_A}/runs/${encodeURIComponent(RUN_A)}`)).status, 404, "A's run id under M");
  const events = (await mallory.req(`/hub/api/teams/${M}/repos/${REPO_A}/events?after=0`)).json();
  assert.ok(events.every((e) => e.agent === RUN_M), 'the events cursor stays inside the team');
  assert.deepEqual((await alice.req(`/hub/api/teams/${A}/repos/${REPO_A}/runs`)).json().map((r) => r.run), [RUN_A]);
});

test('a machine token syncs only into its own team, whatever the body says, and revocation is immediate', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'tok-alice');
  const bob = await signIn(h, 'tok-bob');
  const mallory = await signIn(h, 'tok-mallory');
  const A = await createTeam(alice, 'Tok A');
  const M = await createTeam(mallory, 'Tok M');
  await joinTeam(alice, bob, A);
  const mToken = await createToken(mallory, M);
  const bToken = await createToken(bob, A);
  const db = h.hub.db;

  const r = await sync(h, mToken, batch({ extra: { team: A, team_id: A } }));
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM h_changes WHERE team_id = ?').get(A).n, 0, 'nothing landed in A');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM h_changes WHERE team_id = ?').get(M).n, 1);

  // Removing bob kills his token on the very next request.
  assert.equal((await sync(h, bToken, batch({ repo: REPO_M }))).status, 200);
  const rm = await alice.post(`/hub/teams/${A}/members/${bob.user.id}/remove`);
  assert.equal(rm.status, 303);
  assert.equal((await sync(h, bToken, batch({ repo: REPO_M, id: 2 }))).status, 401);
  assert.equal((await fetch(`${h.base}/hub/api/teams/${A}/repos`, { headers: { Authorization: `Bearer ${bToken}` } })).status, 401);

  // A revoked token, likewise.
  const aToken = await createToken(alice, A);
  assert.equal((await sync(h, aToken, batch({ repo: REPO_M, machine: 'alice-box' }))).status, 200);
  const id = db.prepare('SELECT id FROM machine_tokens WHERE team_id = ? AND user_id = ? AND revoked_at IS NULL').get(A, alice.user.id).id;
  assert.equal((await alice.post(`/hub/teams/${A}/tokens/${id}/revoke`)).status, 303);
  assert.equal((await sync(h, aToken, batch({ repo: REPO_M, machine: 'alice-box', id: 3 }))).status, 401);
  // Tokens are stored as sha256 only.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM machine_tokens WHERE token_hash = ?').get(aToken).n, 0);
});

// ---------------------------------------------------------------- invites

test('invites: two people accepting one link at once, only one gets in', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'race-alice');
  const u1 = await signIn(h, 'race-u1');
  const u2 = await signIn(h, 'race-u2');
  const A = await createTeam(alice, 'Race');
  const token = await createInvite(alice, A);
  const [c1, c2] = await Promise.all([u1.csrf(), u2.csrf()]);
  const go = (b, csrf) => b.req('/hub/invite/accept', { method: 'POST', form: { _csrf: csrf, token } });
  const res = await Promise.all([go(u1, c1), go(u2, c2)]);
  assert.deepEqual(res.map((r) => r.status).sort(), [303, 410]);
  assert.equal(h.hub.teams.seatsUsed(A), 2);
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM invites WHERE token_hash = ?').get(token).n, 0, 'only the hash is stored');
});

test('invites: the last seat cannot be taken twice under a race', async (t) => {
  const h = await startHub(); // free plan: 3 seats
  t.after(h.close);
  const alice = await signIn(h, 'seat-alice');
  const bob = await signIn(h, 'seat-bob');
  const A = await createTeam(alice, 'Seats');
  await joinTeam(alice, bob, A);
  const u1 = await signIn(h, 'seat-u1');
  const u2 = await signIn(h, 'seat-u2');
  const [t1, t2] = [await createInvite(alice, A), await createInvite(alice, A)];
  const [c1, c2] = await Promise.all([u1.csrf(), u2.csrf()]);
  const res = await Promise.all([
    u1.req('/hub/invite/accept', { method: 'POST', form: { _csrf: c1, token: t1 } }),
    u2.req('/hub/invite/accept', { method: 'POST', form: { _csrf: c2, token: t2 } }),
  ]);
  assert.deepEqual(res.map((r) => r.status).sort(), [303, 402]);
  assert.equal(h.hub.teams.seatsUsed(A), 3);
});

// ---------------------------------------------------------------- CSRF, sessions, OAuth

test('CSRF: every state-changing browser route (enumerated) refuses a missing token, a foreign Origin and a cross-site fetch', async (t) => {
  const h = await startHub({ billing: fakeBilling(), env: { STRIPE_PRICE_TEAM_MONTH: 'price_x' } });
  t.after(h.close);
  const alice = await signIn(h, 'csrf-alice');
  const A = await createTeam(alice, 'Csrf');
  await createToken(alice, A);
  await createInvite(alice, A);
  const ws = await workspaceIds(alice, A);
  const db = h.hub.db;
  const ids = {
    ws,
    wstoken: db.prepare('SELECT id FROM workspace_tokens WHERE workspace_id = ?').get(ws).id,
    team: A,
    invite: db.prepare('SELECT id FROM invites WHERE team_id = ?').get(A).id,
    token: db.prepare('SELECT id FROM machine_tokens WHERE team_id = ?').get(A).id,
    user: '1',
    key: 'no-such-platform-key',
    repo: REPO_A, // the hub review route (docs/provenance.md section 6)
    run: RUN_A,
  };
  const csrf = await alice.csrf();
  const before = JSON.stringify(db.prepare('SELECT * FROM invites').all()) + JSON.stringify(db.prepare('SELECT id, revoked_at FROM machine_tokens').all()) + db.prepare('SELECT COUNT(*) AS n FROM teams').get().n;
  const csrfRoutes = h.hub.router.routes.filter((r) => r.opts.csrf);
  assert.ok(csrfRoutes.some((r) => r.pattern === '/hub/invite/accept') && csrfRoutes.some((r) => r.pattern === '/hub/billing/checkout') && csrfRoutes.some((r) => r.pattern === '/hub/logout'));
  for (const r of csrfRoutes) {
    const p = fill(r.pattern, ids);
    const form = { team: A, seats: '5', interval: 'month', token: 'x'.repeat(43), name: 'n' };
    assert.equal((await alice.req(p, { method: 'POST', form })).status, 403, `${p} without a token`);
    assert.equal((await alice.req(p, { method: 'POST', form: { ...form, _csrf: csrf }, origin: 'https://evil.example' })).status, 403, `${p} from another origin`);
    assert.equal((await alice.req(p, { method: 'POST', form: { ...form, _csrf: csrf }, headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403, `${p} from a sibling site`);
  }
  const after = JSON.stringify(db.prepare('SELECT * FROM invites').all()) + JSON.stringify(db.prepare('SELECT id, revoked_at FROM machine_tokens').all()) + db.prepare('SELECT COUNT(*) AS n FROM teams').get().n;
  assert.equal(after, before);
  assert.equal((await alice.req('/hub/api/me')).status, 200, 'still signed in: logout was refused too');
});

test('sessions and OAuth: tampered cookies fail, sign in rotates the session, next never leaves the hub', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const a = await signIn(h, 'sess-alice');
  const name = 'grapim_session';
  const good = a.jar.get(name);
  const tampered = new Browser(h.base);
  tampered.jar.set(name, good.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')));
  assert.equal((await tampered.req('/hub/api/me')).status, 401);

  // Signing in again in the same browser replaces the session; the old cookie is dead.
  const id = nextId++;
  h.gh.user(`code-${id}`, { id: a.user.id, login: 'sess-alice', name: 'x', avatar_url: null });
  const start = await a.req('/hub/auth/github');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  assert.equal((await a.req(`/hub/auth/callback?code=code-${id}&state=${state}`)).status, 303);
  assert.notEqual(a.jar.get(name), good);
  const old = new Browser(h.base);
  old.jar.set(name, good);
  assert.equal((await old.req('/hub/api/me')).status, 401);

  for (const bad of ['//evil.com', '/hub//evil.com', 'https://evil.com/hub', '/hub/\\evil.com', '/hub/../x', '/hub?x=//evil', 'javascript:alert(1)', '/hubx']) {
    assert.equal(safeNext(bad), '/hub', bad);
  }
  assert.equal(safeNext('/hub/invite/abc_DEF-123'), '/hub/invite/abc_DEF-123');
});

test('HUB_SECRET: placeholder and low-entropy values are refused, random ones accepted', () => {
  const env = { HUB_URL: 'https://app.example.com', HUB_DATA: '/data', GITHUB_CLIENT_ID: 'a', GITHUB_CLIENT_SECRET: 'b' };
  for (const weak of ['x'.repeat(32), 'changeme'.repeat(4), 'passwordpasswordpasswordpassword', '0123456789'.repeat(4), 'ab'.repeat(20)]) {
    assert.throws(() => loadConfig({ ...env, HUB_SECRET: weak }), /HUB_SECRET/, weak);
  }
  for (let i = 0; i < 200; i++) {
    assert.doesNotThrow(() => loadConfig({ ...env, HUB_SECRET: crypto.randomBytes(32).toString('base64url') }));
    assert.doesNotThrow(() => loadConfig({ ...env, HUB_SECRET: crypto.randomBytes(16).toString('hex') }));
  }
});

test('HUB_TEAM_CREATORS limits who can create teams; invited people still join', async (t) => {
  const h = await startHub({ env: { HUB_TEAM_CREATORS: ' Creator-Alice , 1 ' } });
  t.after(h.close);
  const alice = await signIn(h, 'creator-alice');
  const carol = await signIn(h, 'outsider-carol');
  const A = await createTeam(alice, 'Beta');
  const r = await carol.post('/hub/teams', { name: 'Not allowed' });
  assert.equal(r.status, 403);
  assert.match(r.text, /private beta/);
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM teams').get().n, 1);
  await joinTeam(alice, carol, A);
  assert.equal(h.hub.teams.seatsUsed(A), 2);
});

// ---------------------------------------------------------------- XSS

test('synced strings and names are escaped on every page; no inline script', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const EVIL = '<script>alert(1)</script>"\'><img src=x onerror=alert(2)>';
  const alice = await signIn(h, 'xss-alice');
  const A = await createTeam(alice, EVIL);
  const token = await createToken(alice, A, EVIL);
  const body = batch({ name: EVIL, run: RUN_A, file: `src/${EVIL}.js`, label: EVIL, intent: EVIL, before: `${EVIL}\n`, after: `${EVIL}\n${EVIL}2\n` });
  body.agents[0].worktree = EVIL;
  body.changes[0].worktree = EVIL;
  assert.equal((await sync(h, token, body)).status, 200);
  const pages = [
    '/hub',
    `/hub/teams/${A}`,
    `/hub/teams/${A}/settings`,
    `/hub/teams/${A}/repos/${REPO_A}`,
    `/hub/teams/${A}/repos/${REPO_A}/runs/${encodeURIComponent(RUN_A)}`,
    `/hub/teams/${A}/repos/${REPO_A}/runs/${encodeURIComponent(EVIL)}`,
  ];
  for (const p of pages) {
    const r = await alice.req(p);
    assert.ok([200, 404].includes(r.status), `${p}: ${r.status}`);
    assert.doesNotMatch(r.text, /<script>alert|<img src=x/i, `${p} renders synced text as HTML`);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    for (const s of r.text.match(/<script[^>]*>/g) ?? []) assert.match(s, /src="\/hub\/static\/(hub|theme|sidebar|agent)\.js"/, `inline script on ${p}`);
    // Attribute values are escaped text; only real attribute names count.
    assert.doesNotMatch(r.text.replace(/"[^"]*"/g, '""'), /<[^>]*\s(style|on[a-z]+)=/i, `inline style or handler on ${p}`);
  }
  assert.match((await alice.req(`/hub/teams/${A}/repos/${REPO_A}/runs/${encodeURIComponent(RUN_A)}`)).text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

// ---------------------------------------------------------------- DoS and ingest

test('reads have a per-request diff budget: replaying huge synced content degrades to "unknown" instead of stalling the hub', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'dos-alice');
  const A = await createTeam(alice, 'Dos');
  const token = await createToken(alice, A);
  // Two ~1 MB versions of one file, flipped back and forth 40 times: about
  // 80 MB of diff input for one page if every use were diffed.
  const lines = (tag) => Array.from({ length: 70_000 }, (_, i) => (i % 997 === 0 ? `${tag} ${i}\n` : `line ${i}\n`)).join('');
  const x = Buffer.from(lines('x'));
  const y = Buffer.from(lines('y'));
  const changes = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1, run: RUN_A, label: 'big', turn: i + 1, worktree: 'wt', path: 'big.txt',
    before_sha: sha1(i % 2 ? y : x), after_sha: sha1(i % 2 ? x : y), untracked: false, added: 1, removed: 1, ts: Date.now() - 1000 + i,
  }));
  const body = { ...batch(), changes, events: [], blobs: { [sha1(x)]: x.toString('base64'), [sha1(y)]: y.toString('base64') } };
  const r = await sync(h, token, body);
  assert.equal(r.status, 200, await r.text());

  const t0 = Date.now();
  const runs = await alice.req(`/hub/api/teams/${A}/repos/${REPO_A}/runs`);
  const detail = await alice.req(`/hub/api/teams/${A}/repos/${REPO_A}/runs/${encodeURIComponent(RUN_A)}`);
  const page = await alice.req(`/hub/teams/${A}/repos/${REPO_A}`);
  assert.equal(runs.status, 200);
  assert.equal(detail.status, 200);
  assert.equal(page.status, 200);
  assert.equal(runs.json()[0].in_tree, null, 'over budget: the in-tree state is unknown, not computed');
  assert.ok(Date.now() - t0 < 20_000, `three reads took ${Date.now() - t0} ms`);

  // A small repo still gets real states.
  const small = batch({ repo: REPO_M, id: 1 });
  assert.equal((await sync(h, token, small)).status, 200);
  assert.equal((await alice.req(`/hub/api/teams/${A}/repos/${REPO_M}/runs`)).json()[0].in_tree, 'all');
});

test('a run that adds a very large file renders (no call-stack overflow in the diff)', async (t) => {
  const big = Buffer.from(Array.from({ length: 300_000 }, (_, i) => `l${i}\n`).join(''));
  const out = hunks(null, big);
  assert.equal(out.length, 1);
  assert.equal(out[0].newLines, 300_000);
});

test('synced timestamps a Date cannot hold are refused; page helpers never throw on them', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'ts-alice');
  const A = await createTeam(alice, 'Ts');
  const token = await createToken(alice, A);
  const b = batch();
  b.agents[0].last_seen = 9e15;
  const r = await sync(h, token, b);
  assert.equal(r.status, 400);
  const c = batch();
  c.changes[0].ts = Number.MAX_SAFE_INTEGER;
  assert.equal((await sync(h, token, c)).status, 400);
  assert.doesNotThrow(() => String(time(9e15)) + date(9e15) + String(time(-1)));
});

test('per-team storage quota: a team cannot fill the shared volume', async (t) => {
  const h = await startHub({ env: { HUB_TEAM_STORAGE_MB: '1' } });
  t.after(h.close);
  const alice = await signIn(h, 'quota-alice');
  const other = await signIn(h, 'quota-other');
  const A = await createTeam(alice, 'Quota');
  const O = await createTeam(other, 'Other');
  const token = await createToken(alice, A);
  const oToken = await createToken(other, O);
  const blob = (tag) => crypto.randomBytes(300 * 1024).toString('hex').slice(0, 600 * 1024) + tag;
  assert.equal((await sync(h, token, batch({ before: '', after: blob('a') }))).status, 200);
  const r = await sync(h, token, batch({ id: 2, cursor: { changes: 1, events: 1, agents: 0 }, before: blob('b'), after: blob('c') }));
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error.code, 'storage_limit');
  assert.equal((await sync(h, oToken, batch({ before: '', after: blob('d') }))).status, 200, 'other teams are unaffected');
  // Re-sending what is already stored does not grow the usage.
  const used = h.hub.db.prepare('SELECT bytes FROM team_usage WHERE team_id = ?').get(O).bytes;
  await sync(h, oToken, batch({ before: '', after: 'x' }));
  assert.ok(h.hub.db.prepare('SELECT bytes FROM team_usage WHERE team_id = ?').get(O).bytes - used < 10_000);
});

test('SSE: a person\'s sessions and machine tokens share one stream cap', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'sse-alice');
  const A = await createTeam(alice, 'Sse');
  const tokens = [await createToken(alice, A, 'a'), await createToken(alice, A, 'b'), await createToken(alice, A, 'c')];
  assert.equal((await sync(h, tokens[0], batch())).status, 200);
  const url = `${h.base}/hub/api/teams/${A}/repos/${REPO_A}/stream`;
  const open = [];
  t.after(() => open.forEach((ac) => ac.abort()));
  const statuses = [];
  for (let i = 0; i < MAX_STREAMS_PER_USER + 1; i++) {
    const ac = new AbortController();
    open.push(ac);
    const headers = i % 4 === 3 ? { Cookie: cookieOf(alice) } : { Authorization: `Bearer ${tokens[i % 4]}` };
    const res = await fetch(url, { headers, signal: ac.signal });
    statuses.push(res.status);
    if (res.status !== 200) await res.text();
  }
  assert.equal(statuses.filter((s) => s === 200).length, MAX_STREAMS_PER_USER);
  assert.equal(statuses.at(-1), 429);
});

test('sync: in-flight batches per team are capped, and an aborted upload releases its slot', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'flight-alice');
  const A = await createTeam(alice, 'Flight');
  const token = await createToken(alice, A);
  const slow = () => {
    const req = http.request({ host: '127.0.0.1', port: h.port, path: '/hub/api/sync', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': 1_000_000 } });
    req.on('error', () => {});
    req.write('{"repo":');
    return req;
  };
  const a = slow();
  const b = slow();
  await new Promise((r) => setTimeout(r, 300));
  const busy = await sync(h, token, batch());
  assert.equal(busy.status, 429);
  assert.equal((await busy.json()).error.code, 'busy');
  a.destroy();
  b.destroy();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await sync(h, token, batch())).status, 200, 'the aborted uploads released their slots');
});

// ---------------------------------------------------------------- rate limits and proxies

test('rate limits: X-Forwarded-For cannot be spoofed past the last hop; IPv6 is limited per /64; the limiter stays bounded', async (t) => {
  const h = await startHub({ env: { TRUST_PROXY: '1' } });
  t.after(h.close);
  const statuses = [];
  for (let i = 0; i < 21; i++) {
    const res = await fetch(`${h.base}/hub/auth/github`, { redirect: 'manual', headers: { 'X-Forwarded-For': `10.0.${i}.1, 203.0.113.9` } });
    statuses.push(res.status);
  }
  assert.equal(statuses.at(-1), 429, 'spoofed leading entries did not buy new buckets');
  assert.equal((await fetch(`${h.base}/hub/auth/github`, { redirect: 'manual', headers: { 'X-Forwarded-For': '203.0.113.10' } })).status, 303, 'another client is not affected');

  const v6 = [];
  for (let i = 0; i < 21; i++) {
    v6.push((await fetch(`${h.base}/hub/auth/github`, { redirect: 'manual', headers: { 'X-Forwarded-For': `2001:db8:1:2::${(i + 1).toString(16)}` } })).status);
  }
  assert.equal(v6.at(-1), 429, 'rotating inside one /64 does not dodge the limit');
  assert.equal(rateKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), rateKey('2001:db8:1:2::1'));
  assert.notEqual(rateKey('2001:db8:1:3::1'), rateKey('2001:db8:1:2::1'));
  assert.equal(rateKey('::ffff:198.51.100.7'), '198.51.100.7');

  const h2 = await startHub();
  t.after(h2.close);
  const s2 = [];
  for (let i = 0; i < 21; i++) s2.push((await fetch(`${h2.base}/hub/auth/github`, { redirect: 'manual', headers: { 'X-Forwarded-For': `198.51.100.${i}` } })).status);
  assert.equal(s2.at(-1), 429, 'without TRUST_PROXY the header is ignored');

  const rl = new RateLimiter({ maxKeys: 1000 });
  const t0 = Date.now();
  for (let i = 0; i < 200_000; i++) rl.hit(`k${i}`, 10, 60_000);
  assert.ok(rl.buckets.size <= 1000, `${rl.buckets.size} buckets`);
  assert.ok(Date.now() - t0 < 5000, 'no full sweep on every hit');
});

// ---------------------------------------------------------------- Stripe webhook wiring

test('Stripe webhook (real billing module): raw body verified before parsing; tampering, replays and same-second revivals change nothing', async (t) => {
  const secret = 'whsec_test_review';
  const h = await startHub({ loadRealBilling: true, env: { STRIPE_SECRET_KEY: 'sk_test_review', STRIPE_WEBHOOK_SECRET: secret, STRIPE_PRICE_TEAM_MONTH: 'price_x' } });
  t.after(h.close);
  assert.ok(h.hub.billing, 'billing.js loaded');
  const alice = await signIn(h, 'stripe-alice');
  const A = await createTeam(alice, 'Paying');
  const team = () => h.hub.teams.get(A);
  const sign = (raw, ts = Math.floor(Date.now() / 1000)) => `t=${ts},v1=${crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
  const send = (raw, sig) => fetch(`${h.base}/hub/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig }, body: raw });
  const created = Math.floor(Date.now() / 1000);
  const event = (id, type, status, at = created) =>
    JSON.stringify({ id, type, created: at, data: { object: { id: 'sub_1', customer: 'cus_1', status, metadata: { team_id: A }, items: { data: [{ quantity: 7 }] } } } });

  const up = event('evt_up', 'customer.subscription.updated', 'active');
  assert.equal((await send(up, 't=1,v1=' + '0'.repeat(64))).status, 400, 'bad signature');
  assert.equal((await send(up.replace('"active"', '"trialing"'), sign(up))).status, 400, 'body changed after signing');
  assert.equal((await send('not json', sign('not json'))).status, 400, 'signed garbage');
  assert.equal(team().plan, 'free', 'nothing applied before a valid signature');

  assert.equal((await send(up, sign(up))).status, 200);
  assert.equal(team().plan, 'team');
  assert.equal(team().seats, 7);

  // The subscription is deleted; a different event with the same timestamp
  // and the replayed "updated" event must not bring the plan back.
  const del = event('evt_del', 'customer.subscription.deleted', 'canceled');
  assert.equal((await send(del, sign(del))).status, 200);
  assert.equal(team().plan, 'free');
  const sameSecond = event('evt_up2', 'customer.subscription.updated', 'active');
  assert.equal((await send(sameSecond, sign(sameSecond))).status, 200);
  assert.equal((await send(up, sign(up))).status, 200);
  assert.equal(team().plan, 'free', 'replays and same-second events do not revive a canceled plan');
  assert.deepEqual(h.hub.db.prepare('SELECT event_id FROM billing_events ORDER BY event_id').all().map((r) => r.event_id), ['evt_del', 'evt_up', 'evt_up2'], 'each event id recorded once');
});

test('headers: HSTS on https, CSP frame-ancestors none, nosniff, referrer policy', async (t) => {
  const h = await startHub({ env: { HUB_URL: 'https://app.example.com' } });
  t.after(h.close);
  const r = await fetch(`${h.base}/hub/health`);
  assert.match(r.headers.get('strict-transport-security'), /max-age=31536000/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'same-origin');
  assert.ok(r.headers.get('permissions-policy'));
});
