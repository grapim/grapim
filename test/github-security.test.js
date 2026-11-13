// Regression tests for docs/security-review-github-reports-2026-11-11.md: the
// GitHub App, provenance ingest, the manager reports, the Action's note
// reading and the local provenance client. Each test names its finding.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHub } from '../src/hub/server.js';
import { githubConfig } from '../src/hub/github/config.js';
import { JobQueue } from '../src/hub/github/queue.js';
import { signBody } from '../src/hub/github/webhook.js';
import { provenanceFor } from '../src/hub/provenance.js';
import { toCsv } from '../src/hub/reports/csv.js';
import { COMPUTE_BUDGET_MS, TEASER_MS } from '../src/hub/reports/index.js';
import { parseNote } from '../src/provenance/note.js';
import { installGitHooks } from '../src/provenance/hooks.js';
import { readNotes } from '../src/provenance/pr.js';

const ORIGIN = 'http://localhost:7999';
const SECRET = 'whsec-test-0123456789abcdef';
const SLUG = 'grapim-test';
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'grapim.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });
const RUN = { id: 'claude-code:aaaa', label: 'claude aaaa', kind: 'claude-code', turns: [{ turn: 1 }], review: 'pending' };

// ---------------------------------------------------------------- a hub, a fake GitHub, browsers

function fakeGitHub() {
  const s = { installs: new Map(), comments: [], checks: [], nextId: 1, rateLimitComments: false };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const url = new URL(req.url, 'http://x');
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    let m;
    if ((m = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(url.pathname))) {
      if (m[2]) return send(201, { token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      const inst = s.installs.get(Number(m[1]));
      return inst ? send(200, inst) : send(404, { message: 'Not Found' });
    }
    if (url.pathname === '/repos/acme/api/issues/7/comments') {
      if (s.rateLimitComments) return send(403, { message: 'secondary rate limit' }, { 'retry-after': '120' });
      if (req.method === 'GET') return send(200, Number(url.searchParams.get('page')) === 1 ? s.comments : []);
      const c = { id: s.nextId++, body: body.body, user: { login: `${SLUG}[bot]`, type: 'Bot' } };
      s.comments.push(c);
      return send(201, c);
    }
    if ((m = /^\/repos\/acme\/api\/commits\/([0-9a-f]+)\/check-runs$/.exec(url.pathname))) {
      return send(200, { check_runs: s.checks.filter((c) => c.head_sha === m[1] && c.name === url.searchParams.get('check_name')) });
    }
    if (url.pathname === '/repos/acme/api/check-runs' && req.method === 'POST') {
      const c = { id: s.nextId++, ...body, app: { slug: SLUG } };
      s.checks.push(c);
      return send(201, c);
    }
    if ((m = /^\/repos\/acme\/api\/check-runs\/(\d+)$/.exec(url.pathname)) && req.method === 'PATCH') {
      const c = s.checks.find((x) => x.id === Number(m[1]));
      Object.assign(c, body, { patchedBy: SLUG });
      return send(200, c);
    }
    send(404, { message: `fake: no route ${req.method} ${url.pathname}` });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ s, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

function fakeOAuth() {
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

async function startHub(t, { github = {} } = {}) {
  const oauth = fakeOAuth();
  const gh = await fakeGitHub();
  const clock = { t: NOW };
  const hub = await createHub({
    env: {
      HUB_URL: ORIGIN,
      HUB_SECRET: 'test-secret-that-is-long-enough-0123456789',
      HUB_DATA: tmp('grapim-ghsec-'),
      GITHUB_CLIENT_ID: 'gh-client',
      GITHUB_CLIENT_SECRET: 'gh-secret',
      GITHUB_APP_ID: '12345',
      GITHUB_APP_PRIVATE_KEY: Buffer.from(PEM).toString('base64'),
      GITHUB_APP_WEBHOOK_SECRET: SECRET,
      GITHUB_APP_SLUG: SLUG,
    },
    fetch: oauth.fetch,
    billing: null,
    log: () => {},
    now: () => clock.t,
    github: { fetch: globalThis.fetch, apiBase: gh.base, sleep: async () => {}, ...github },
    platform: { worker: false },
  });
  const addr = await hub.listen(0, '127.0.0.1');
  const h = { hub, gh, oauth, clock, base: `http://127.0.0.1:${addr.port}` };
  t.after(async () => {
    await hub.close();
    await gh.close();
  });
  return h;
}

class Browser {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }
  async req(p, { method = 'GET', form = null } = {}) {
    const h = {};
    if (this.jar.size) h.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET') h.Origin = ORIGIN;
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
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
  async post(p, form = {}) {
    const me = JSON.parse((await this.req('/hub/api/me')).text);
    return this.req(p, { method: 'POST', form: { _csrf: me.csrf, ...form } });
  }
}

let nextUser = 41000;
async function signIn(h, login, id = nextUser++) {
  h.oauth.user(`code-${id}`, { id, login, name: login, avatar_url: null });
  const b = new Browser(h.base);
  const start = await b.req('/hub/auth/github');
  const state = new URL(start.location).searchParams.get('state');
  assert.equal((await b.req(`/hub/auth/callback?code=code-${id}&state=${state}`)).status, 303);
  b.user = { id, login };
  return b;
}

async function createTeam(b, name) {
  const r = await b.post('/hub/teams', { name });
  return r.location.match(/\/hub\/teams\/([^/?#]+)/)[1];
}

let delivery = 1;
async function hook(h, event, payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  const res = await fetch(`${h.base}/hub/github/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': `sec-${delivery++}`, 'X-Hub-Signature-256': signBody(SECRET, raw) },
    body: raw,
  });
  return res.status;
}

async function installState(b, team) {
  const r = await b.post(`/hub/teams/${team}/github/install`);
  assert.equal(r.status, 303);
  return new URL(r.location).searchParams.get('state');
}

async function machineToken(b, team) {
  const tok = await b.post(`/hub/teams/${team}/tokens`, { name: 'laptop' });
  return tok.text.match(/value="(cmh_[A-Za-z0-9_-]+)"/)[1];
}

// ---------------------------------------------------------------- H1: note merging

test('H1: a tiny note claiming millions of lines twice is merged by range, not line by line', () => {
  const one = JSON.stringify({ v: 1, runs: [RUN], files: { 'a.js': [[1, 4_000_000, 0, 1]] } });
  const started = performance.now();
  const n = parseNote(`${one}\n${one}`);
  const ms = performance.now() - started;
  assert.ok(ms < 1000, `parsed in ${Math.round(ms)} ms`);
  assert.deepEqual(n.files['a.js'], [[1, 4_000_000, 0, 1]]);
  // The largest line the format allows, in a 250-byte body.
  const huge = JSON.stringify({ v: 1, runs: [RUN], files: { 'a.js': [[1, 100_000_000, 0, 1]] } });
  assert.deepEqual(parseNote(`${huge}\n${huge}`).files['a.js'], [[1, 100_000_000, 0, 1]]);
  // First claim wins, across notes and inside one note; adjacent ranges of one run and turn join.
  const other = { ...RUN, id: 'codex-mcp-client:1', label: 'codex', kind: 'codex' };
  const a = JSON.stringify({ v: 1, runs: [RUN], files: { f: [[5, 10, 0, 1], [1, 6, 0, 2], [11, 12, 0, 1]] } });
  const b = JSON.stringify({ v: 1, runs: [other], files: { f: [[1, 20, 0, 1]] } });
  assert.deepEqual(parseNote(a).files.f, [[1, 4, 0, 2], [5, 12, 0, 1]]);
  assert.deepEqual(parseNote(`${a}\n${b}`).files.f, [[1, 4, 0, 2], [5, 12, 0, 1], [13, 20, 1, 1]]);
});

test('H1: the sync endpoint answers such a note at once instead of stalling the hub', async (t) => {
  const h = await startHub(t);
  const alice = await signIn(h, 'alice');
  const A = await createTeam(alice, 'Alpha');
  const token = await machineToken(alice, A);
  const one = JSON.stringify({ v: 1, runs: [RUN], files: { 'a.js': [[1, 4_000_000, 0, 1]] } });
  const started = performance.now();
  const res = await fetch(`${h.base}/hub/api/sync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: { id: sha1('root'), name: 'api', github: 'github.com/acme/api' }, machine: 'laptop', provenance: [{ commit: sha1('c1'), note: `${one}\n${one}` }] }),
  });
  assert.equal(res.status, 200, await res.text());
  assert.ok(performance.now() - started < 2000, `answered in ${Math.round(performance.now() - started)} ms`);
  const stored = h.hub.db.prepare('SELECT note_json FROM h_provenance WHERE team_id = ?').get(A).note_json;
  assert.deepEqual(JSON.parse(stored).files['a.js'], [[1, 4_000_000, 0, 1]]);
});

// ---------------------------------------------------------------- H2: report compute budget

function seedNotes(db, team, n, ts) {
  const put = db.prepare('INSERT INTO h_provenance (team_id, repo_id, commit_sha, note_json, received_at) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < n; i++) put.run(team, sha1('repo'), sha1(`${team}${ts}${i}`), JSON.stringify({ v: 1, runs: [RUN], files: { f: [[1, 3, 0, 1]] }, commit: { ts, added: 10 } }), ts);
}

test('H2: a team past its report compute budget gets the cached answer or a 429, never a fresh scan', async (t) => {
  const h = await startHub(t);
  const alice = await signIn(h, 'alice');
  const A = await createTeam(alice, 'Alpha');
  const db = h.hub.db;
  db.prepare("UPDATE teams SET plan = 'governance' WHERE id = ?").run(A);
  seedNotes(db, A, 3, Date.UTC(2026, 10, 3));
  const reports = h.hub.reports;
  const q = 'from=2026-10-26&to=2026-11-08';
  const first = await alice.req(`/hub/api/teams/${A}/reports/ai-share?${q}`);
  assert.equal(first.status, 200);
  // The team spends its budget, then syncs a note (a new cache key).
  reports.spent.set(A, [[performance.now(), COMPUTE_BUDGET_MS + 1]]);
  seedNotes(db, A, 1, Date.UTC(2026, 10, 4));
  const n = reports.computed;
  const again = await alice.req(`/hub/api/teams/${A}/reports/ai-share?${q}`);
  assert.equal(again.status, 200);
  assert.equal(JSON.parse(again.text).totals.commits, 3, 'the stale answer, not a recompute');
  assert.equal(reports.computed, n);
  // A query never computed before has nothing stale: 429.
  const other = await alice.req(`/hub/api/teams/${A}/reports/activity?${q}`);
  assert.equal(other.status, 429);
  assert.equal(reports.computed, n);
  // Another team is not affected by A's budget.
  const bob = await signIn(h, 'bob');
  const B = await createTeam(bob, 'Beta');
  db.prepare("UPDATE teams SET plan = 'governance' WHERE id = ?").run(B);
  assert.equal((await bob.req(`/hub/api/teams/${B}/reports/activity?${q}`)).status, 200);
  // A minute later A can compute again.
  reports.spent.set(A, [[performance.now() - 61_000, COMPUTE_BUDGET_MS + 1]]);
  const fresh = await alice.req(`/hub/api/teams/${A}/reports/ai-share?${q}`);
  assert.equal(JSON.parse(fresh.text).totals.commits, 4);
});

test('H2: the teaser (every plan) is not recomputed by each sync', async (t) => {
  const h = await startHub(t);
  const alice = await signIn(h, 'alice');
  const A = await createTeam(alice, 'Alpha');
  const db = h.hub.db;
  const reports = h.hub.reports;
  seedNotes(db, A, 2, Date.UTC(2026, 10, 3));
  assert.equal((await alice.req(`/hub/teams/${A}/reports`)).status, 200);
  const n = reports.computed;
  for (let i = 0; i < 3; i++) {
    seedNotes(db, A, 1, Date.UTC(2026, 10, 4) + i); // what a sync does to the stamp
    reports.bump(A);
    assert.equal((await alice.req(`/hub/teams/${A}/reports`)).status, 200);
  }
  assert.equal(reports.computed, n, 'syncs do not force a teaser recompute');
  h.clock.t += TEASER_MS;
  const page = await alice.req(`/hub/teams/${A}/reports`);
  assert.equal(reports.computed, n + 1);
  assert.match(page.text, /in 5 recorded commits/);
});

// ---------------------------------------------------------------- M: CSV

test('M: CSV cells that a spreadsheet could run are defused, also after spaces, full-width or past a ";"', () => {
  const labels = [' =1+1', '\t=1+1', '\n=1', '\uff1dHYPERLINK("x")', 'x;=cmd|\' /C calc\'!A0', 'a\tb', '@SUM(A1)', 'plain'];
  const csv = toCsv('unreviewed', { runs: labels.map((label, i) => ({ repo_name: 'r', run: `r${i}`, label, kind: 'mcp', status: 'pending', lines: 1, files: 1, commits: 1, first_ts: 0, last_ts: 0, intent: null })) });
  const rows = csv.trimEnd().split('\r\n').slice(1);
  const label = (row) => row.split(',')[2];
  assert.equal(label(rows[0]), "' =1+1");
  assert.ok(rows[1].includes(`"'\t=1+1"`), rows[1]);
  assert.ok(csv.includes(`"'\n=1"`));
  assert.ok(csv.includes(`,"'\uff1dHYPERLINK(""x"")",`), 'a full-width equals sign is defused');
  assert.match(csv, /,"x;=cmd\|' \/C calc'!A0",/, 'a ";" cell is quoted, so no locale splits it into a formula cell');
  assert.match(csv, /,"a\tb",/);
  assert.match(csv, /,'@SUM\(A1\),/);
  assert.match(csv, /,plain,/);
});

// ---------------------------------------------------------------- M: queue fairness

test('M: one installation cannot hold every worker or fill the queue', async () => {
  const started = [];
  const gates = new Map();
  const q = new JobQueue({ concurrency: 2, max: 200, maxPerGroup: 20, run: (job) => new Promise((r) => (started.push(job.id), gates.set(job.id, r))) });
  const tick = () => new Promise((r) => setImmediate(r));
  for (let i = 0; i < 25; i++) q.push(`big:${i}`, { id: `big${i}` }, 'big');
  await tick();
  assert.deepEqual(started, ['big0'], 'one job per installation at a time');
  assert.equal(q.waiting.size, 20, 'at most 20 waiting per installation');
  assert.equal(q.push('small:1', { id: 'small1' }, 'small'), true);
  await tick();
  assert.deepEqual(started, ['big0', 'small1'], 'another installation runs at once');
  gates.get('small1')();
  gates.get('big0')();
  await tick();
  await tick();
  assert.deepEqual(started.slice(2), ['big1']);
  q.close();
});

test('M: a rate-limited job gives up after a minute instead of holding a worker for five', async (t) => {
  const waits = [];
  const h = await startHub(t, { github: { sleep: async (ms) => waits.push(ms), repoFor: async () => null } });
  const alice = await signIn(h, 'alice');
  const A = await createTeam(alice, 'Alpha');
  const state = await installState(alice, A);
  assert.equal(await hook(h, 'installation', { action: 'created', installation: { id: 61, account: { id: 555, login: 'acme', type: 'Organization' } }, sender: { id: alice.user.id } }), 200);
  assert.equal((await alice.req(`/hub/github/setup?installation_id=61&state=${encodeURIComponent(state)}`)).status, 303);
  h.gh.s.rateLimitComments = true;
  await assert.rejects(h.hub.github.process({ installationId: 61, owner: 'acme', name: 'api', number: 7, headSha: sha1('head') }), /rate limit/);
  assert.ok(waits.every((ms) => ms < 120_000), `waited ${waits}`);
});

// ---------------------------------------------------------------- L: check run of another App

test('L, M6: a "Grapim provenance (app)" check run made by someone else is never updated', async (t) => {
  const h = await startHub(t, { github: { repoFor: async () => null } });
  const alice = await signIn(h, 'alice');
  const A = await createTeam(alice, 'Alpha');
  const state = await installState(alice, A);
  assert.equal(await hook(h, 'installation', { action: 'created', installation: { id: 62, account: { id: 555, login: 'acme', type: 'Organization' } }, sender: { id: alice.user.id } }), 200);
  assert.equal((await alice.req(`/hub/github/setup?installation_id=62&state=${encodeURIComponent(state)}`)).status, 303);
  const head = sha1('head2');
  h.gh.s.checks.push({ id: 900, name: 'Grapim provenance (app)', head_sha: head, conclusion: 'success' }); // no app: a workflow's or another App's
  h.gh.s.checks.push({ id: 901, name: 'Grapim provenance (app)', head_sha: head, conclusion: 'success', app: { slug: 'impostor' } });
  const r = await h.hub.github.process({ installationId: 62, owner: 'acme', name: 'api', number: 7, headSha: head });
  assert.equal(r.check.action, 'created');
  assert.equal(h.gh.s.checks.find((c) => c.id === 900).patchedBy, undefined);
  assert.equal(h.gh.s.checks.find((c) => c.id === 901).patchedBy, undefined);
});

// ---------------------------------------------------------------- L: linking

test('L: another owner naming the same installation id cannot replace the installer\'s pending link', async (t) => {
  const h = await startHub(t);
  const alice = await signIn(h, 'alice');
  const A = await createTeam(alice, 'Alpha');
  const mallory = await signIn(h, 'mallory');
  const M = await createTeam(mallory, 'Mal');
  h.gh.s.installs.set(70, { id: 70, account: { id: 556, login: 'acme', type: 'Organization' } });
  // Alice's setup redirect beats the installation webhook: pending.
  const sa = await installState(alice, A);
  assert.match((await alice.req(`/hub/github/setup?installation_id=70&state=${encodeURIComponent(sa)}`)).location, /done=pending/);
  // Mallory names the same id with a state of her own.
  const sm = await installState(mallory, M);
  assert.match((await mallory.req(`/hub/github/setup?installation_id=70&state=${encodeURIComponent(sm)}`)).location, /done=pending/);
  const pending = h.hub.db.prepare('SELECT team_id, user_id FROM gh_pending_links WHERE installation_id = 70').get();
  assert.deepEqual({ ...pending }, { team_id: A, user_id: alice.user.id });
  // The webhook arrives with Alice as the sender: linked to Alpha.
  assert.equal(await hook(h, 'installation', { action: 'created', installation: { id: 70, account: { id: 556, login: 'acme', type: 'Organization' } }, sender: { id: alice.user.id } }), 200);
  assert.equal(h.hub.db.prepare('SELECT team_id FROM gh_installations WHERE id = 70').get().team_id, A);
});

test('L: an Enterprise installation is not linkable by the user who happens to have its account id', async (t) => {
  const h = await startHub(t);
  const mallory = await signIn(h, 'mallory');
  const M = await createTeam(mallory, 'Mal');
  assert.equal(await hook(h, 'installation', { action: 'created', installation: { id: 71, account: { id: mallory.user.id, slug: 'bigcorp', type: 'Enterprise' } }, sender: { id: 1 } }), 200);
  const r = await mallory.post(`/hub/teams/${M}/github/link`, { installation: '71' });
  assert.equal(r.status, 404);
  assert.equal(h.hub.db.prepare('SELECT team_id FROM gh_installations WHERE id = 71').get().team_id, null);
});

test('L: a short webhook secret leaves the App unconfigured', () => {
  const env = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: PEM, GITHUB_APP_SLUG: 'a' };
  const weak = githubConfig({ ...env, GITHUB_APP_WEBHOOK_SECRET: 'secret' });
  assert.equal(weak.canVerify, false);
  assert.equal(weak.configured, false);
  assert.match(weak.problems.join(' '), /at least 20/);
  assert.equal(githubConfig({ ...env, GITHUB_APP_WEBHOOK_SECRET: SECRET }).configured, true);
});

// ---------------------------------------------------------------- M: note budget on the App's path

test('M: provenanceFor stops parsing past its byte budget', async (t) => {
  const h = await startHub(t);
  const db = h.hub.db;
  const alice = await signIn(h, 'alice');
  const A = await createTeam(alice, 'Alpha');
  const repo = sha1('repo');
  const shas = [1, 2, 3].map((i) => sha1(`b${i}`));
  const json = JSON.stringify({ v: 1, runs: [RUN], files: { f: [[1, 1, 0, 1]] }, pad: 'x'.repeat(1000) });
  for (const s of shas) db.prepare('INSERT INTO h_provenance (team_id, repo_id, commit_sha, note_json, received_at) VALUES (?, ?, ?, ?, ?)').run(A, repo, s, json, NOW);
  assert.equal(Object.keys(provenanceFor(db, A, repo, shas)).length, 3);
  assert.equal(Object.keys(provenanceFor(db, A, repo, shas, { maxBytes: json.length * 2 })).length, 2);
  assert.equal(Object.keys(provenanceFor(db, 'other-team', repo, shas)).length, 0);
});

// ---------------------------------------------------------------- local client and the Action

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tempRepo() {
  const dir = tmp('grapim-ghsec-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  return dir;
}

test('L: grapim blame --history never runs a textconv driver the repo\'s attributes name', () => {
  const dir = tempRepo();
  const mark = path.join(dir, 'textconv-ran');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '* diff=evil\n');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nb\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'one');
  const script = path.join(dir, 'conv.js');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(mark)}, 'x'); process.stdout.write(require('fs').readFileSync(process.argv[2]));`);
  git(dir, 'config', 'diff.evil.textconv', `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`);
  // Sanity: plain git blame does run it.
  git(dir, 'blame', '--line-porcelain', '--', 'f.txt');
  assert.ok(fs.existsSync(mark), 'the driver works');
  fs.rmSync(mark);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete env.GRAPIM_STATE_DIR;
  const r = spawnSync(process.execPath, [BIN, 'blame', 'f.txt', '--history', '--json'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(mark), false, 'grapim blame --history ran the textconv driver');
});

test('L: grapim init never writes through a link planted at the hook temp name', (t) => {
  const dir = tempRepo();
  const hooks = path.join(dir, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'keep me');
  try {
    fs.symlinkSync(victim, path.join(hooks, 'post-commit.grapim-tmp'));
  } catch {
    t.skip('symbolic links are not available here');
    return;
  }
  installGitHooks(dir, { bin: '/opt/grapim/bin/grapim.js' });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me');
  assert.match(fs.readFileSync(path.join(hooks, 'post-commit'), 'utf8'), /grapim-hook v1/);
  assert.equal(fs.lstatSync(path.join(hooks, 'post-commit')).isSymbolicLink(), false);
});

test('L: the Action reads note sizes first and skips a note over its cap', () => {
  const dir = tempRepo();
  fs.writeFileSync(path.join(dir, 'f.txt'), 'a\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'one');
  const c1 = git(dir, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nb\n');
  git(dir, 'commit', '-qam', 'two');
  const c2 = git(dir, 'rev-parse', 'HEAD').trim();
  const small = JSON.stringify({ v: 1, runs: [RUN], files: { 'f.txt': [[1, 1, 0, 1]] } });
  const notes = path.join(dir, 'n');
  fs.writeFileSync(notes, small);
  git(dir, 'notes', '--ref=refs/notes/grapim', 'add', '-F', notes, c1);
  fs.writeFileSync(notes, 'x'.repeat(600 * 1024));
  git(dir, 'notes', '--ref=refs/notes/grapim', 'add', '-F', notes, c2);
  const got = readNotes(dir, [c1, c2]);
  assert.deepEqual(Object.keys(got), [c1]);
  assert.equal(got[c1].trim(), small);
});

// ---------------------------------------------------------------- M5: require_review is a control, not a reminder

const GOV_ROOT = sha1('gov-root');
const GOV_RUN = 'claude-code:gov1';

async function joinTeam(owner, b, team) {
  const inv = await owner.post(`/hub/teams/${team}/invites`);
  const token = inv.text.match(/\/hub\/invite\/([A-Za-z0-9_-]+)/)[1];
  assert.equal((await b.post('/hub/invite/accept', { token })).status, 303);
}

// One run with one change of src/a.js, synced by `b`'s machine.
async function syncRun(h, b, team, { root = GOV_ROOT, run = GOV_RUN, machine = 'laptop', events = [] } = {}) {
  const token = await machineToken(b, team);
  const before = 'a\n';
  const after = 'a\nb\n';
  const res = await fetch(`${h.base}/hub/api/sync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repo: { id: root, name: 'api', github: 'github.com/acme/api' },
      machine,
      runs: [{ run, turn: 1, started_at: NOW - 5000 }],
      changes: [{ id: 1, run, label: 'claude gov1', turn: 1, worktree: 'wt', path: 'src/a.js', before_sha: sha1(before), after_sha: sha1(after), added: 1, removed: 0, ts: NOW - 1000 }],
      events,
      blobs: { [sha1(before)]: Buffer.from(before).toString('base64'), [sha1(after)]: Buffer.from(after).toString('base64') },
    }),
  });
  assert.equal(res.status, 200, await res.text());
  return token;
}

const decisions = (h) => h.hub.db.prepare('SELECT COUNT(*) AS n FROM hub_reviews').get().n;

test('M5: a run cannot be approved by the person whose machine synced it, nor by a machine token', async (t) => {
  const h = await startHub(t);
  const alice = await signIn(h, 'alice');
  const bob = await signIn(h, 'bob');
  const A = await createTeam(alice, 'Alpha');
  await joinTeam(alice, bob, A);
  const token = await syncRun(h, bob, A); // bob's machine: bob is the run's owner
  const path = `/hub/teams/${A}/repos/${GOV_ROOT}/runs/${encodeURIComponent(GOV_RUN)}/decision`;

  // The owner, through the hub: refused, whatever the role.
  const own = await bob.post(path, { status: 'approved' });
  assert.equal(own.status, 403);
  assert.equal(decisions(h), 0);
  // The run page offers bob no buttons.
  const page = await bob.req(`/hub/teams/${A}/repos/${GOV_ROOT}/runs/${encodeURIComponent(GOV_RUN)}`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /value="approved"/);
  // A machine token is not a signed-in person: no decision either way.
  const viaToken = await fetch(h.base + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'status=approved', redirect: 'manual' });
  assert.ok([303, 401, 403].includes(viaToken.status), `${viaToken.status}`);
  assert.equal(decisions(h), 0);
  // Another member may.
  assert.equal((await alice.post(path, { status: 'approved' })).status, 303);
  assert.equal(decisions(h), 1);
  // A second machine (alice's) syncing rows of the same run makes alice an owner too.
  await syncRun(h, alice, A, { machine: 'alice-box' });
  assert.equal((await alice.post(path, { status: 'approved' })).status, 403);
});

test('M5: a synced local approval never satisfies the policy; only a fresh hub approval does', async () => {
  const { decide } = await import('../src/hub/github/pull.js');
  const runs = [{ id: GOV_RUN, label: 'claude gov1', kind: 'claude-code', lines: 3 }];
  const base = { requireProvenance: true, runs, places: new Map([[GOV_RUN, { repo_id: GOV_ROOT, machine: 'laptop' }]]), unrecorded: [], incomplete: [], peopleLines: 0, link: () => 'https://hub.example/r' };
  const local = new Map([[GOV_RUN, { status: 'approved', login: 'bob', machine: 'laptop' }]]);
  const none = decide({ ...base, hubReviews: new Map(), localReviews: local });
  assert.equal(none.conclusion, 'failure');
  assert.match(none.summary, /Approved locally by bob \(informational, does not count\)/);
  assert.match(none.summary, /\[Review in the hub\]\(https:\/\/hub\.example\/r\)/);
  const stale = decide({ ...base, hubReviews: new Map([[GOV_RUN, { status: 'approved', reviewer_login: 'alice', stale: true }]]), localReviews: local });
  assert.equal(stale.conclusion, 'failure', 'an approval of an older state of the run');
  const rejected = decide({ ...base, hubReviews: new Map([[GOV_RUN, { status: 'rejected', reviewer_login: 'alice', stale: false }]]), localReviews: local });
  assert.equal(rejected.conclusion, 'failure');
  const ok = decide({ ...base, hubReviews: new Map([[GOV_RUN, { status: 'approved', reviewer_login: 'alice', stale: false }]]), localReviews: new Map() });
  assert.equal(ok.conclusion, 'success');
  // Unrecorded commits fail only with require_provenance; anything unchecked always fails.
  assert.equal(decide({ ...base, hubReviews: new Map([[GOV_RUN, { status: 'approved', stale: false }]]), localReviews: new Map(), unrecorded: ['a'.repeat(40)] }).conclusion, 'failure');
  assert.equal(decide({ ...base, requireProvenance: false, hubReviews: new Map([[GOV_RUN, { status: 'approved', stale: false }]]), localReviews: new Map(), unrecorded: ['a'.repeat(40)] }).conclusion, 'success');
  assert.equal(decide({ ...base, requireProvenance: false, hubReviews: new Map([[GOV_RUN, { status: 'approved', stale: false }]]), localReviews: new Map(), incomplete: ['x'] }).conclusion, 'failure');
});

test('M5: IDOR on the hub review route: team B cannot approve team A\'s run, by A\'s path or under its own team', async (t) => {
  const h = await startHub(t);
  const alice = await signIn(h, 'alice');
  const bob = await signIn(h, 'bob');
  const mallory = await signIn(h, 'mallory');
  const A = await createTeam(alice, 'Alpha');
  await joinTeam(alice, bob, A);
  const M = await createTeam(mallory, 'Mal');
  await syncRun(h, bob, A);
  // Mallory's own team has a repo with the same root and a run of the same id, synced by someone else in it.
  const eve = await signIn(h, 'eve');
  await joinTeam(mallory, eve, M);
  await syncRun(h, eve, M);
  const enc = encodeURIComponent(GOV_RUN);

  // Team A's path: 404, nothing recorded, nothing of A leaks.
  const r1 = await mallory.post(`/hub/teams/${A}/repos/${GOV_ROOT}/runs/${enc}/decision`, { status: 'approved' });
  assert.equal(r1.status, 404);
  assert.doesNotMatch(r1.text, /Alpha|claude gov1/);
  assert.equal((await mallory.req(`/hub/teams/${A}/repos/${GOV_ROOT}/runs/${enc}`)).status, 404);
  // Her own team: the decision lands in team M only, never on A's run.
  assert.equal((await mallory.post(`/hub/teams/${M}/repos/${GOV_ROOT}/runs/${enc}/decision`, { status: 'approved' })).status, 303);
  const rows = h.hub.db.prepare('SELECT team_id FROM hub_reviews').all();
  assert.deepEqual(rows.map((r) => r.team_id), [M]);
  assert.equal(h.hub.github.reviews.latest(A, [GOV_ROOT], [GOV_RUN]).size, 0, "team A's run is still unreviewed");
  // A repo or run that team M does not have: 404.
  assert.equal((await mallory.post(`/hub/teams/${M}/repos/${sha1('other')}/runs/${enc}/decision`, { status: 'approved' })).status, 404);
  assert.equal((await mallory.post(`/hub/teams/${M}/repos/${GOV_ROOT}/runs/${encodeURIComponent('claude-code:none')}/decision`, { status: 'approved' })).status, 404);
  // Team A's member approves A's run: only team A's row.
  assert.equal((await alice.post(`/hub/teams/${A}/repos/${GOV_ROOT}/runs/${enc}/decision`, { status: 'approved' })).status, 303);
  assert.equal(h.hub.github.reviews.latest(A, [GOV_ROOT], [GOV_RUN]).get(GOV_RUN).reviewer_login, 'alice');
  assert.equal(h.hub.github.reviews.latest(M, [GOV_ROOT], [GOV_RUN]).get(GOV_RUN).reviewer_login, 'mallory');
});

test('M5: CSRF on the hub review route: no token, another origin or a sibling site records nothing', async (t) => {
  const h = await startHub(t);
  const alice = await signIn(h, 'alice');
  const bob = await signIn(h, 'bob');
  const A = await createTeam(alice, 'Alpha');
  await joinTeam(alice, bob, A);
  await syncRun(h, bob, A);
  const path = `/hub/teams/${A}/repos/${GOV_ROOT}/runs/${encodeURIComponent(GOV_RUN)}/decision`;
  const csrf = JSON.parse((await alice.req('/hub/api/me')).text).csrf;
  const cookie = [...alice.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const post = (headers, form) =>
    fetch(h.base + path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form).toString(), redirect: 'manual' });
  assert.equal((await post({ Origin: ORIGIN }, { status: 'approved' })).status, 403, 'no CSRF token');
  assert.equal((await post({ Origin: ORIGIN }, { status: 'approved', _csrf: 'x'.repeat(43) })).status, 403, 'a wrong token');
  assert.equal((await post({ Origin: 'https://evil.example' }, { status: 'approved', _csrf: csrf })).status, 403, 'another origin');
  assert.equal((await post({ Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' }, { status: 'approved', _csrf: csrf })).status, 403, 'a cross-site request');
  assert.equal((await post({}, { status: 'approved', _csrf: csrf })).status, 403, 'no Origin or Referer');
  assert.equal(decisions(h), 0);
  assert.equal((await post({ Origin: ORIGIN }, { status: 'approved', _csrf: csrf })).status, 303, 'the real form');
  assert.equal(decisions(h), 1);
});
