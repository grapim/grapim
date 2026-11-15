// The five buyer-objection features (research/core-features-2026-11.md):
// the 90-day AI history scan, approving from the GitHub check, Slack
// notifications, sensitive path rules and the audit evidence export, against
// a fake GitHub (REST and GraphQL) and a fake Slack.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../src/hub/server.js';
import { agentOfEmail, approvedByOther, coAuthors, detectAgents } from '../src/hub/github/agents.js';
import { approveAction, decide } from '../src/hub/github/pull.js';
import { signBody } from '../src/hub/github/webhook.js';
import { slackUrl } from '../src/hub/notify.js';
import { compilePattern } from '../src/hub/rules.js';
import { renderSummary } from '../src/provenance/render.js';

const ORIGIN = 'http://localhost:7999';
const SECRET = 'whsec-test-0123456789abcdef';
const SLUG = 'grapim-test';
const SLACK = 'https://hooks.slack.com/services/T0123ABCD/B0456EFGH/abcdefghijklmnopqrstuvwx';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const b64 = (t) => Buffer.from(t).toString('base64');
const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- unit: agent signals

test('agents: trailers, bot authors and Aider names are recognised; humans and look-alikes are not', () => {
  assert.equal(agentOfEmail('noreply@anthropic.com'), 'claude-code');
  assert.equal(agentOfEmail('NoReply@Anthropic.com'), 'claude-code');
  assert.equal(agentOfEmail('198982749+Copilot@users.noreply.github.com'), 'copilot');
  assert.equal(agentOfEmail('161369871+google-labs-jules[bot]@users.noreply.github.com'), 'jules');
  assert.equal(agentOfEmail('12345+alice@users.noreply.github.com'), null, 'a person\'s noreply address');
  assert.equal(agentOfEmail('noreply@anthropic.com.evil.example'), null);
  assert.deepEqual(coAuthors('Fix\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nco-authored-by: Cursor Agent <cursoragent@cursor.com>'), [
    { name: 'Claude Opus 5.5', email: 'noreply@anthropic.com' },
    { name: 'Cursor Agent', email: 'cursoragent@cursor.com' },
  ]);
  assert.deepEqual(coAuthors('mentions Co-Authored-By: Claude <noreply@anthropic.com> mid-line'), [], 'only trailer lines');

  const human = { author: { login: 'alice', __typename: 'User' }, commits: [{ message: 'Fix bug', author: { name: 'Alice', email: 'alice@acme.dev', user: { login: 'alice' } } }] };
  assert.equal(detectAgents(human).size, 0);
  const claude = { ...human, commits: [{ message: 'Add page\n\nCo-Authored-By: Claude <noreply@anthropic.com>', author: human.commits[0].author }] };
  assert.deepEqual([...detectAgents(claude).keys()], ['claude-code']);
  assert.deepEqual([...detectAgents(claude).get('claude-code')], ['Co-authored-by trailer']);
  const copilot = { author: { login: 'Copilot', __typename: 'Bot' }, commits: [{ message: 'Initial plan', author: { name: 'Copilot', email: '198982749+Copilot@users.noreply.github.com', user: null } }] };
  assert.deepEqual([...detectAgents(copilot).get('copilot')].sort(), ['commit author', 'opened the pull request']);
  const aider = { ...human, commits: [{ message: 'feat: x', author: { name: 'Alice (aider)', email: 'alice@acme.dev', user: null } }] };
  assert.deepEqual([...detectAgents(aider).keys()], ['aider']);
  // A squash merge: the trailers live in the merge commit's message.
  const squash = { ...human, mergeCommit: { message: 'Big change (#12)\n\n* wip\n\nCo-authored-by: devin-ai-integration[bot] <158243242+devin-ai-integration[bot]@users.noreply.github.com>' } };
  assert.deepEqual([...detectAgents(squash).keys()], ['devin']);

  // Approvals: a person other than the author. Bots, the author and deleted accounts do not count.
  const pr = { author: { login: 'alice' } };
  assert.deepEqual(approvedByOther({ ...pr, reviews: [{ author: { login: 'alice', __typename: 'User' } }] }), []);
  assert.deepEqual(approvedByOther({ ...pr, reviews: [{ author: { login: 'copilot-pull-request-reviewer[bot]', __typename: 'Bot' } }, { author: null }, { author: { login: 'ghost', __typename: 'User' } }] }), []);
  assert.deepEqual(approvedByOther({ ...pr, reviews: [{ author: { login: 'bob', __typename: 'User' } }, { author: { login: 'bob', __typename: 'User' } }] }), ['bob']);
});

test('path patterns: ** spans folders, * stays in one name, patterns start at the root; nothing else is a regex', () => {
  const m = (p, f) => compilePattern(p).test(f);
  assert.ok(m('payments/**', 'payments/stripe/charge.ts'));
  assert.ok(!m('payments/**', 'src/payments/x.ts'));
  assert.ok(m('**/payments/**', 'src/payments/x.ts'));
  assert.ok(m('**/payments/**', 'payments/x.ts'));
  assert.ok(m('infra/', 'infra/main.tf'));
  assert.ok(m('*.sql', 'schema.sql'));
  assert.ok(!m('*.sql', 'db/schema.sql'));
  assert.ok(m('db/*.sql', 'db/schema.sql'));
  assert.ok(m('/src/a?.js', 'src/ab.js'));
  assert.ok(!m('a.b', 'axb'), 'a dot is a dot');
  for (const bad of ['', '../etc/**', 'a\\b', '(a|b)', 'x'.repeat(201), '[ab]']) assert.equal(compilePattern(bad), null, bad);
});

test('slack URLs: only https://hooks.slack.com/services/... is accepted', () => {
  assert.equal(slackUrl(SLACK), SLACK);
  assert.equal(slackUrl(`  ${SLACK}  `), SLACK);
  for (const bad of [
    SLACK.replace('https:', 'http:'),
    SLACK.replace('hooks.slack.com', 'hooks.slack.com.evil.example'),
    SLACK.replace('hooks.slack.com', 'evil.example'),
    SLACK.replace('hooks.slack.com', 'hooks.slack.com:8443'),
    SLACK.replace('https://', 'https://user:pass@'),
    `${SLACK}?redirect=http://169.254.169.254`,
    `${SLACK}#x`,
    'https://hooks.slack.com/workflows/T0123ABCD/A0456/abc/def',
    'https://hooks.slack.com/services/../../admin',
    'https://127.0.0.1/services/T0123ABCD/B0456EFGH/abcdefghijklmnopqrstuvwx',
    'file:///etc/passwd',
    'not a url',
  ]) assert.equal(slackUrl(bad), null, bad);
});

test('check buttons and the comment link: GitHub\'s limits, and links only from the caller', () => {
  const a = approveAction({ label: 'claude-code 1a2b3c4d5e6f', intent: 'Refactor the whole billing module and its tests' }, 'r0123456789abcdef');
  assert.ok(a.label.length <= 20 && a.label.startsWith('Approve'), a.label);
  assert.ok(a.description.length <= 40, a.description);
  assert.ok(a.identifier.length <= 20);
  const C = sha('c');
  const r = renderSummary({
    files: [{ path: 'a.js', added: [[1, 2]] }],
    blameByFile: { 'a.js': [{ start: 1, end: 2, commit: C, orig: 1 }] },
    notesByCommit: { [C]: { v: 1, runs: [{ id: 'claude-code:x', label: 'claude x', turns: [] }], files: { 'a.js': [[1, 2, 0, 1]] } } },
    reviewLinks: { 'claude-code:x': `${ORIGIN}/hub/teams/t/repos/r/runs/claude-code%3Ax?machine=m` },
  });
  assert.match(r.markdown, /- claude x: 2 lines in 1 file · \[Review in Grapim\]\(http:\/\/localhost:7999\/hub\/teams\/t\/repos\/r\/runs\/claude-code%3Ax\?machine=m\)/);
  const bad = renderSummary({ files: [{ path: 'a.js', added: [[1, 2]] }], blameByFile: { 'a.js': [{ start: 1, end: 2, commit: C, orig: 1 }] }, notesByCommit: { [C]: { v: 1, runs: [{ id: 'claude-code:x', label: 'claude x', turns: [] }], files: { 'a.js': [[1, 2, 0, 1]] } } }, reviewLinks: { 'claude-code:x': 'javascript:alert(1)' } });
  assert.doesNotMatch(bad.markdown, /javascript:|\]\(/);
  // decide(): an approval that does not meet a rule still fails, and says what is missing.
  const d = decide({
    requireProvenance: false,
    runs: [{ id: 'run1', label: 'claude 1', lines: 3 }],
    hubReviews: new Map([['run1', { status: 'approved', stale: false, reviewer_login: 'bob' }]]),
    localReviews: new Map(),
    places: new Map(),
    unrecorded: [],
    incomplete: [],
    peopleLines: 0,
    link: () => '',
    rules: new Map([['run1', { ok: false, rules: [{ pattern: 'payments/**', approvals: 2, approvers: [], have: ['bob'], need: 1, ok: false }] }]]),
  });
  assert.equal(d.conclusion, 'failure');
  // Escaped like every other text in the check: inert Markdown.
  assert.match(d.summary, /payments&#47;&#42;&#42; needs 2 approvals&#59; has 1 &#40;bob&#41;/);
});

// ---------------------------------------------------------------- the hub against a fake GitHub

function fakeGitHub() {
  const s = { requests: [], files: new Map(), blame: new Map(), prFiles: [], comments: [], checks: [], installs: new Map(), nextId: 1000, repos: [], history: new Map(), rate: 5000, graphqlCalls: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const url = new URL(req.url, 'http://x');
    s.requests.push(`${req.method} ${url.pathname}`);
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const auth = String(req.headers.authorization || '');
    let m;
    if ((m = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(url.pathname))) {
      const [h, b, sig] = auth.replace('Bearer ', '').split('.');
      if (!sig || !crypto.verify('RSA-SHA256', Buffer.from(`${h}.${b}`), publicKey, Buffer.from(sig, 'base64url'))) return send(401, { message: 'bad jwt' });
      if (m[2]) return send(201, { token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      const inst = s.installs.get(Number(m[1]));
      return inst ? send(200, inst) : send(404, { message: 'Not Found' });
    }
    if (auth !== 'Bearer ghs_test') return send(401, { message: 'bad token' });
    if (url.pathname === '/installation/repositories') {
      const page = Number(url.searchParams.get('page'));
      return send(200, { total_count: s.repos.length, repositories: s.repos.slice((page - 1) * 100, page * 100) });
    }
    if (req.method === 'POST' && url.pathname === '/graphql') {
      const v = body.variables;
      if (body.query.includes('pullRequests(')) {
        s.graphqlCalls++;
        const all = s.history.get(`${v.owner}/${v.name}`) ?? [];
        const start = v.after ? Number(v.after) : 0;
        const nodes = all.slice(start, start + 20);
        return send(200, { data: { repository: { pullRequests: { pageInfo: { hasNextPage: start + 20 < all.length, endCursor: String(start + 20) }, nodes } }, rateLimit: { remaining: s.rate, resetAt: new Date(Date.now() + 60_000).toISOString() } } });
      }
      if (body.query.includes('blame(')) return send(200, { data: { repository: { object: { blame: { ranges: s.blame.get(`${v.oid}:${v.path}`) ?? [] } } } } });
      const repository = {};
      for (const [k, e] of Object.entries(v)) {
        if (!/^e\d+$/.test(k)) continue;
        const text = s.files.get(e);
        repository[`f${k.slice(1)}`] = text === undefined ? null : { byteSize: Buffer.byteLength(text), isBinary: false, ...(body.query.includes('text') ? { text } : {}) };
      }
      return send(200, { data: { repository } });
    }
    if (url.pathname === '/repos/acme/api/pulls/7/commits') return send(200, []);
    if (url.pathname === '/repos/acme/api/pulls/7/files') {
      const page = Number(url.searchParams.get('page'));
      return send(200, s.prFiles.slice((page - 1) * 100, page * 100));
    }
    if (url.pathname === '/repos/acme/api/issues/7/comments') {
      if (req.method === 'GET') return send(200, s.comments.slice((Number(url.searchParams.get('page')) - 1) * 100, Number(url.searchParams.get('page')) * 100));
      const c = { id: s.nextId++, body: body.body, user: { login: `${SLUG}[bot]`, type: 'Bot' } };
      s.comments.push(c);
      return send(201, c);
    }
    if ((m = /^\/repos\/acme\/api\/issues\/comments\/(\d+)$/.exec(url.pathname)) && req.method === 'PATCH') {
      const c = s.comments.find((x) => x.id === Number(m[1]));
      c.body = body.body;
      return send(200, c);
    }
    if ((m = /^\/repos\/acme\/api\/commits\/([0-9a-f]+)\/check-runs$/.exec(url.pathname))) {
      return send(200, { total_count: 0, check_runs: s.checks.filter((c) => c.head_sha === m[1] && c.name === url.searchParams.get('check_name')) });
    }
    if (url.pathname === '/repos/acme/api/check-runs' && req.method === 'POST') {
      const c = { id: s.nextId++, ...body, app: { slug: SLUG } };
      s.checks.push(c);
      return send(201, c);
    }
    if ((m = /^\/repos\/acme\/api\/check-runs\/(\d+)$/.exec(url.pathname)) && req.method === 'PATCH') {
      const c = s.checks.find((x) => x.id === Number(m[1]));
      Object.assign(c, body);
      return send(200, c);
    }
    send(404, { message: `fake: no route ${req.method} ${url.pathname}` });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ s, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

// OAuth for sign in, and Slack: every hooks.slack.com post is recorded.
function fakeFetch() {
  const codes = new Map();
  const slack = { posts: [], status: 200 };
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
    if (String(url).startsWith('https://hooks.slack.com/')) {
      assert.equal(init.redirect, 'manual', 'Slack redirects are never followed');
      slack.posts.push({ url, body: JSON.parse(init.body) });
      return new Response(slack.status === 200 ? 'ok' : 'channel_is_archived', { status: slack.status });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, slack, user: (code, profile) => codes.set(code, profile) };
}

async function startHub(t, { governance = () => true, clock = null, github = {} } = {}) {
  const ff = fakeFetch();
  const gh = await fakeGitHub();
  const env = {
    HUB_URL: ORIGIN,
    HUB_SECRET: 'test-secret-that-is-long-enough-0123456789',
    HUB_DATA: tmp('grapim-core-'),
    GITHUB_CLIENT_ID: 'gh-client',
    GITHUB_CLIENT_SECRET: 'gh-secret',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: Buffer.from(PEM).toString('base64'),
    GITHUB_APP_WEBHOOK_SECRET: SECRET,
    GITHUB_APP_SLUG: SLUG,
  };
  const hub = await createHub({
    env,
    fetch: ff.fetch,
    billing: null,
    log: () => {},
    ...(clock ? { now: () => clock.t } : {}),
    github: { fetch: globalThis.fetch, apiBase: gh.base, sleep: async () => {}, governance, historyTimers: false, ...github },
    notify: { fetch: ff.fetch, schedule: false },
    platform: { worker: false },
  });
  const addr = await hub.listen(0, '127.0.0.1');
  const h = { hub, gh, ff, base: `http://127.0.0.1:${addr.port}` };
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
      if (/Max-Age=0/i.test(c)) this.jar.delete(pair.slice(0, i));
      else this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text(), headers: res.headers };
  }
  async post(p, form = {}) {
    const me = JSON.parse((await this.req('/hub/api/me')).text);
    return this.req(p, { method: 'POST', form: { _csrf: me.csrf, ...form } });
  }
}

let nextUser = 31000;
async function signIn(h, login) {
  const id = nextUser++;
  h.ff.user(`code-${id}`, { id, login, name: login, avatar_url: null });
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
async function join(owner, b, team) {
  const inv = await owner.post(`/hub/teams/${team}/invites`);
  const token = inv.text.match(/\/hub\/invite\/([A-Za-z0-9_-]+)/)[1];
  assert.equal((await b.post('/hub/invite/accept', { token })).status, 303);
}
async function machineToken(b, team) {
  const tok = await b.post(`/hub/teams/${team}/tokens`, { name: 'laptop' });
  return tok.text.match(/value="(cmh_[A-Za-z0-9_-]+)"/)[1];
}
async function sync(h, token, body) {
  const res = await fetch(`${h.base}/hub/api/sync`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(res.status, 200, await res.text());
}

let delivery = 1;
async function hook(h, event, payload, { sig } = {}) {
  const raw = Buffer.from(JSON.stringify(payload));
  const headers = { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': `core-${delivery++}` };
  if (sig !== null) headers['X-Hub-Signature-256'] = sig ?? signBody(SECRET, raw);
  const res = await fetch(`${h.base}/hub/github/webhook`, { method: 'POST', headers, body: raw });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function link(h, b, team, id) {
  const r = await b.post(`/hub/teams/${team}/github/install`);
  const url = new URL(r.location);
  await hook(h, 'installation', { action: 'created', installation: { id, account: { id: 555, login: 'acme', type: 'Organization' } }, sender: { id: b.user.id, login: b.user.login }, repositories: [{ id: 99, full_name: 'acme/api' }] });
  const cb = await b.req(`/hub/github/setup?installation_id=${id}&setup_action=install&state=${encodeURIComponent(url.searchParams.get('state'))}`);
  assert.equal(cb.status, 303, cb.text);
}

// ---------------------------------------------------------------- 1. the 90-day history scan

const pr = (number, { author = 'alice', bot = false, commits = [], reviews = [], merged = Date.now() - 5 * DAY, title = `PR ${number}` } = {}) => ({
  number,
  title,
  mergedAt: new Date(merged).toISOString(),
  updatedAt: new Date(merged + 1000).toISOString(),
  author: { login: author, __typename: bot ? 'Bot' : 'User' },
  mergeCommit: { message: title },
  commits: { totalCount: commits.length, nodes: commits.map((c) => ({ commit: c })) },
  reviews: { nodes: reviews.map((login) => ({ author: { login, __typename: login.endsWith('[bot]') ? 'Bot' : 'User' } })) },
});
const human = (msg = 'Fix') => ({ message: msg, author: { name: 'Alice', email: 'alice@acme.dev', user: { login: 'alice' } } });
const claude = (msg = 'Add billing page') => ({ message: `${msg}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, author: { name: 'Alice', email: 'alice@acme.dev', user: { login: 'alice' } } });

test('history scan: starts when GitHub is linked, reads 90 days of merged PRs, and reports "at least N, M without another person\'s approval"', async (t) => {
  const h = await startHub(t, { governance: () => false });
  const s = h.gh.s;
  const now = Date.now();
  s.repos = [
    { id: 99, full_name: 'acme/api', pushed_at: new Date(now - DAY).toISOString() },
    { id: 98, full_name: 'acme/web', pushed_at: new Date(now - 2 * DAY).toISOString() },
    { id: 97, full_name: 'acme/old', pushed_at: new Date(now - 200 * DAY).toISOString() }, // no push in the window: skipped
    { id: 96, full_name: 'acme/archive', pushed_at: new Date(now - DAY).toISOString(), archived: true },
  ];
  const api = [
    pr(1, { commits: [claude()], reviews: [] }), // AI, no approval
    pr(2, { commits: [claude()], reviews: ['alice'] }), // AI, self-approval only
    pr(3, { commits: [claude()], reviews: ['bob'] }), // AI, approved by bob
    pr(4, { author: 'Copilot', bot: true, commits: [{ message: 'Initial plan', author: { name: 'Copilot', email: '198982749+Copilot@users.noreply.github.com', user: null } }], reviews: ['copilot-pull-request-reviewer[bot]'] }),
    pr(5, { commits: [human()], reviews: [] }), // human
  ];
  for (let i = 6; i <= 25; i++) api.push(pr(i, { commits: [human()], reviews: ['bob'] }));
  api.push(pr(90, { commits: [claude()], merged: now - 120 * DAY })); // updated before the window: stops the repo
  s.history.set('acme/api', api);
  s.history.set('acme/web', [pr(1, { title: '<script>alert(1)</script>', commits: [{ message: 'x\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>', author: { name: 'Bob', email: 'bob@acme.dev', user: { login: 'bob' } } }], author: 'bob', reviews: ['alice'] })]);

  const alice = await signIn(h, 'hist-alice');
  const bob = await signIn(h, 'hist-bob');
  const A = await createTeam(alice, 'History Co');
  await join(alice, bob, A);
  await link(h, alice, A, 801);
  await h.hub.github.scans.idle();

  const scan = h.hub.github.scans.latest(A);
  assert.equal(scan.status, 'done', scan.error ?? '');
  assert.equal(scan.reason, 'install');
  const rep = h.hub.github.scans.report(A);
  assert.equal(rep.scan.repos_total, 2, 'old and archived repos are skipped');
  assert.equal(rep.totals.merged, 26, '25 in api (the 120-day-old one excluded) and 1 in web');
  assert.equal(rep.totals.ai, 5);
  assert.equal(rep.totals.unapproved, 3, '#1 no review, #2 self-approval, #4 bot approval');
  assert.deepEqual(rep.agents.map((a) => [a.agent, a.prs, a.unapproved]), [['claude-code', 3, 2], ['copilot', 1, 1], ['cursor', 1, 0]]);
  assert.deepEqual(rep.prs.slice(0, 3).map((p) => `${p.repo}#${p.number}`).sort(), ['acme/api#1', 'acme/api#2', 'acme/api#4']);
  assert.ok(s.graphqlCalls >= 3, 'paged: api has two pages');

  // The page, for any member: the verdict sentence, tables, links to GitHub, escaped titles.
  const page = await bob.req(`/hub/teams/${A}/github/history`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<strong>at least 5<\/strong> of 26 merged pull requests had commits from AI agents/);
  assert.match(page.text, /<strong class="warn-text">3<\/strong> of them were merged without an approving review by someone other than the author/);
  assert.match(page.text, /href="https:\/\/github\.com\/acme\/api\/pull\/1"/);
  assert.doesNotMatch(page.text, /<script>alert/);
  assert.match(page.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(page.text, /\sstyle=|<script>(?!<\/script>)[^<]/, 'no inline style or script');
  // CSV and JSON.
  const csv = await bob.req(`/hub/api/teams/${A}/github/history.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /^repo,number,title,url,author,merged_at,agents,signals,approved_by_other,approvers\r\n/);
  assert.match(csv.text, /acme\/api,1,PR 1,https:\/\/github\.com\/acme\/api\/pull\/1,alice,[^,]+,Claude Code,Co-authored-by trailer,no,/);
  assert.equal(JSON.parse((await bob.req(`/hub/api/teams/${A}/github/history`)).text).totals.ai, 5);

  // Only owners start a scan; a new one waits an hour.
  assert.equal((await bob.post(`/hub/teams/${A}/github/history/scan`)).status, 403);
  const again = await alice.post(`/hub/teams/${A}/github/history/scan`);
  assert.equal(again.status, 429);
  assert.match(again.text, /less than an hour ago/);

  // Another team sees nothing.
  const mallory = await signIn(h, 'hist-mallory');
  const M = await createTeam(mallory, 'Mallory');
  for (const p of [`/hub/teams/${A}/github/history`, `/hub/api/teams/${A}/github/history`, `/hub/api/teams/${A}/github/history.csv`]) assert.equal((await mallory.req(p)).status, 404, p);
  assert.equal((await mallory.post(`/hub/teams/${A}/github/history/scan`)).status, 404);
  const none = await mallory.req(`/hub/api/teams/${M}/github/history.csv`);
  assert.equal(none.status, 200);
  assert.equal(none.text.trim().split(/\n/).length, 1, 'no scan for her own team: the header only');
  const empty = await mallory.req(`/hub/teams/${M}/github/history`);
  assert.match(empty.text, /Link GitHub to see your last 90 days/);
});

test('history scan: pauses when GitHub points run low and resumes from its saved page, also after a restart', async (t) => {
  const clock = { t: Date.now() };
  const h = await startHub(t, { governance: () => false, clock });
  const s = h.gh.s;
  s.repos = [{ id: 99, full_name: 'acme/api', pushed_at: new Date(clock.t - DAY).toISOString() }];
  const list = [];
  for (let i = 1; i <= 45; i++) list.push(pr(i, { commits: [i % 3 ? human() : claude()], merged: clock.t - i * 60_000 }));
  s.history.set('acme/api', list);
  s.rate = 100; // under the reserve: the scan waits after its first page
  const alice = await signIn(h, 'pause-alice');
  const A = await createTeam(alice, 'Pause Co');
  await link(h, alice, A, 802);
  await h.hub.github.scans.idle();
  let scan = h.hub.github.scans.latest(A);
  assert.equal(scan.status, 'waiting');
  assert.equal(scan.prs_scanned, 20);
  assert.equal(JSON.parse(scan.state).cursor, '20', 'its position is saved');
  const page = await alice.req(`/hub/teams/${A}/github/history`);
  assert.match(page.text, /data-refresh="5"/);
  assert.match(page.text, /Paused to leave GitHub API points/);

  // Before the reset nothing runs; after it, the scan carries on from page 2.
  h.hub.github.scans.kick();
  await h.hub.github.scans.idle();
  assert.equal(h.hub.github.scans.latest(A).status, 'waiting');
  s.rate = 5000;
  const before = s.graphqlCalls;
  clock.t += 2 * 60_000;
  h.hub.github.scans.kick();
  await h.hub.github.scans.idle();
  scan = h.hub.github.scans.latest(A);
  assert.equal(scan.status, 'done');
  assert.equal(scan.prs_scanned, 45);
  assert.equal(s.graphqlCalls - before, 2, 'pages 2 and 3 only, not page 1 again');
  assert.equal(h.hub.github.scans.report(A).totals.ai, 15);

  // A scan interrupted mid-run (status running, a saved cursor) resumes on the next kick, like a restart.
  h.hub.db.prepare("UPDATE gh_history_scans SET status = 'running', state = ?, finished_at = NULL WHERE id = ?").run(JSON.stringify({ repos: [{ inst: 802, id: 99, full_name: 'acme/api' }], i: 0, cursor: '40', n: 40 }), scan.id);
  const calls = s.graphqlCalls;
  h.hub.github.scans.kick();
  await h.hub.github.scans.idle();
  assert.equal(h.hub.github.scans.latest(A).status, 'done');
  assert.equal(s.graphqlCalls - calls, 1, 'only the last page was read again');
});

// ---------------------------------------------------------------- shared PR fixture for 2, 4 and 5

const BASE = sha('base');
const H = sha('head');
const C1 = sha('c1x');
const ROOT = sha('core-root');
const RUN1 = 'claude-code:aaaa1111';
const RUN2 = 'mcp:codex-bbbb';
const V0 = 'const a = 1;\n';
const V1 = 'const a = 1;\nfunction f() {\n  return 42;\n}\n';
const V2 = `${V1}export { f };\n`;
const NOTE_C1 = { v: 1, tool: 'grapim/0.1.0', runs: [{ id: RUN1, label: 'claude aaaa1111', kind: 'claude-code', turns: [{ turn: 1, intent: 'Charge cards in payments' }], review: 'pending' }], files: { 'src/app.js': [[4, 6, 0, 1]] } };
const NOTE_H = { v: 1, tool: 'grapim/0.1.0', runs: [{ id: RUN2, label: 'codex bbbb', kind: 'codex', turns: [{ turn: 2, intent: 'Export f' }], review: 'pending' }], files: { 'src/app.js': [[7, 7, 0, 2]] } };

function seedPr(s) {
  s.files.set(`${C1}:src/app.js`, '// old header\nconst a = 1;\nconst b = 2;\nfunction f() {\n  return 42;\n}\n');
  s.files.set(`${H}:src/app.js`, 'const a = 1;\nconst b = 2;\nfunction f() {\n  return 42;\n}\n// tuned\nexport { f };\n');
  s.blame.set(`${H}:src/app.js`, [
    { startingLine: 1, endingLine: 2, commit: { oid: BASE } },
    { startingLine: 3, endingLine: 5, commit: { oid: C1 } },
    { startingLine: 6, endingLine: 7, commit: { oid: H } },
  ]);
  s.prFiles = [{ filename: 'src/app.js', status: 'modified', additions: 5, patch: '@@ -2,0 +3,5 @@\n+function f() {\n+  return 42;\n+}\n+// tuned\n+export { f };' }];
  return { [C1]: NOTE_C1, [H]: NOTE_H };
}
const prEvent = (id, action = 'synchronize', extra = {}) => ({
  action,
  installation: { id },
  repository: { id: 99, name: 'api', full_name: 'acme/api', owner: { login: 'acme' } },
  pull_request: { number: 7, draft: false, head: { sha: H }, base: { sha: BASE }, ...extra },
});
const change = (id, run, label, before, after, file = 'src/app.js') => ({ id, run, label, turn: 1, worktree: 'wt', path: file, before_sha: sha(before), after_sha: sha(after), added: 3, removed: 0, ts: Date.now() - 1000 });

// alice syncs both runs (RUN1 also touched payments/charge.js); bob and carol are members.
async function governed(t, opts = {}) {
  const h = await startHub(t, opts);
  const alice = await signIn(h, `gov-alice-${nextUser}`);
  const bob = await signIn(h, `gov-bob-${nextUser}`);
  const carol = await signIn(h, `gov-carol-${nextUser}`);
  const A = await createTeam(alice, 'Gov Co');
  h.hub.db.prepare("UPDATE teams SET plan = 'governance' WHERE id = ?").run(A); // seats past the free plan's 3
  await join(alice, bob, A);
  await join(alice, carol, A);
  const inst = 900 + (nextUser % 90);
  await link(h, alice, A, inst);
  await h.hub.github.scans.idle();
  const notes = seedPr(h.gh.s);
  const token = await machineToken(alice, A);
  await sync(h, token, {
    repo: { id: ROOT, name: 'api', github: 'github.com/acme/api' },
    machine: 'alice-laptop',
    runs: [{ run: RUN1, turn: 1, started_at: Date.now() - 5000 }, { run: RUN2, turn: 1, started_at: Date.now() - 5000 }],
    changes: [change(1, RUN1, 'claude aaaa1111', V0, V1), change(2, RUN2, 'codex bbbb', V1, V2), change(3, RUN1, 'claude aaaa1111', '', V0, 'payments/charge.js')],
    blobs: { [sha(V0)]: b64(V0), [sha(V1)]: b64(V1), [sha(V2)]: b64(V2), [sha('')]: b64('') },
    provenance: Object.entries(notes).map(([commit, note]) => ({ commit, note: JSON.stringify(note) })),
  });
  return { h, alice, bob, carol, A, inst, token };
}
const check = (h) => h.gh.s.checks.find((c) => c.name === 'Grapim provenance (app)');
const runPath = (A, run) => `/hub/teams/${A}/repos/${ROOT}/runs/${encodeURIComponent(run)}`;

// ---------------------------------------------------------------- 2. approve from GitHub

const click = (inst, identifier, sender, over = {}) => ({
  action: 'requested_action',
  installation: { id: inst },
  repository: { id: 99, name: 'api', full_name: 'acme/api', owner: { login: 'acme' } },
  check_run: { id: 1, head_sha: H, name: 'Grapim provenance (app)', app: { slug: SLUG } },
  requested_action: { identifier },
  sender,
  ...over,
});

test('approve from GitHub: buttons on the check; a member\'s click approves as that member; spoofed, self and outsider clicks record nothing', async (t) => {
  const { h, alice, bob, A, inst } = await governed(t);
  const db = h.hub.db;
  assert.equal((await alice.post(`/hub/teams/${A}/github/policy`, { require_review: '1' })).status, 303);
  await hook(h, 'pull_request', prEvent(inst));
  await h.hub.github.queue.idle();
  const c = check(h);
  assert.equal(c.conclusion, 'failure');
  assert.equal(c.actions.length, 2, 'one button per run to approve');
  for (const a of c.actions) {
    assert.ok(a.label.length <= 20 && a.description.length <= 40 && a.identifier.length <= 20, JSON.stringify(a));
    assert.match(a.label, /^Approve /);
  }
  assert.match(c.output.summary, /Approve from GitHub/);
  // The comment links each run to its review page.
  assert.ok(h.gh.s.comments[0].body.includes(`[Review in Grapim](${ORIGIN}/hub/teams/${A}/repos/${ROOT}/runs/claude-code%3Aaaaa1111?machine=alice-laptop)`), h.gh.s.comments[0].body);
  const [b1, b2] = c.actions.map((a) => a.identifier);
  const reviews = () => db.prepare('SELECT COUNT(*) AS n FROM hub_reviews').get().n;

  // Unsigned or wrongly signed: refused before anything.
  assert.equal((await hook(h, 'check_run', click(inst, b1, { id: bob.user.id, login: bob.user.login, type: 'User' }), { sig: null })).status, 401);
  assert.equal((await hook(h, 'check_run', click(inst, b1, { id: bob.user.id, login: bob.user.login, type: 'User' }), { sig: signBody('nope-0123456789abcdefg', Buffer.from('{}')) })).status, 401);
  // A GitHub user who is not in the team, wearing bob's login: the id decides, not the login.
  const r1 = await hook(h, 'check_run', click(inst, b1, { id: 4242424, login: bob.user.login, type: 'User' }));
  assert.equal(r1.body.refused, 'not_member');
  // Alice synced the run: she cannot approve it from GitHub either.
  const r2 = await hook(h, 'check_run', click(inst, b1, { id: alice.user.id, login: alice.user.login, type: 'User' }));
  assert.equal(r2.body.refused, 'own_run');
  // A bot, a made-up identifier, another repository: nothing.
  assert.equal((await hook(h, 'check_run', click(inst, b1, { id: bob.user.id, login: 'x[bot]', type: 'Bot' }))).body.refused, 'not_a_user');
  assert.equal((await hook(h, 'check_run', click(inst, 'rAAAAAAAAAAAAAAAA', { id: bob.user.id, login: bob.user.login, type: 'User' }))).body.ignored, 'unknown_action');
  assert.equal((await hook(h, 'check_run', click(inst, b1, { id: bob.user.id, login: bob.user.login, type: 'User' }, { repository: { id: 12345, name: 'other', owner: { login: 'acme' } } }))).body.ignored, 'unknown_action');
  assert.equal((await hook(h, 'check_run', click(inst, b1, { id: bob.user.id, login: bob.user.login, type: 'User' }, { check_run: { head_sha: H, app: { slug: 'someone-else' } } }))).body.ignored, 'not_ours');
  assert.equal(reviews(), 0, 'nothing recorded so far');
  await h.hub.github.queue.idle();
  assert.match(check(h).output.summary, /^> Not approved&#58;/, 'a refused click is explained on the next check');

  // Bob's two clicks: recorded as bob, via GitHub; the check passes without a push.
  assert.equal((await hook(h, 'check_run', click(inst, b1, { id: bob.user.id, login: bob.user.login, type: 'User' }))).body.approved, true);
  assert.equal((await hook(h, 'check_run', click(inst, b2, { id: bob.user.id, login: bob.user.login, type: 'User' }))).body.approved, true);
  await h.hub.github.queue.idle();
  const rows = db.prepare('SELECT run, reviewer_user_id, via, note FROM hub_reviews ORDER BY id').all();
  assert.deepEqual(rows.map((r) => [r.reviewer_user_id, r.via]), [[bob.user.id, 'github'], [bob.user.id, 'github']]);
  assert.match(rows[0].note, /Approved from the GitHub check on acme\/api#7/);
  assert.equal(check(h).conclusion, 'success', check(h).output.summary);
  assert.equal(check(h).actions.length, 0, 'no buttons once everything is approved');
  assert.match((await bob.req(`${runPath(A, RUN1)}?machine=alice-laptop`)).text, /from the GitHub check/);

  // An installation linked to another team cannot use this team's buttons.
  const mallory = await signIn(h, 'core-mallory');
  const M = await createTeam(mallory, 'Mallory');
  await link(h, mallory, M, 7777);
  assert.equal((await hook(h, 'check_run', click(7777, b1, { id: mallory.user.id, login: 'core-mallory', type: 'User' }))).body.ignored, 'unknown_action');
});

// ---------------------------------------------------------------- 4. path rules

test('path rules: payments/** needs 2 approvals from named people; the check and the hub enforce it; the run page shows who is missing', async (t) => {
  const { h, alice, bob, carol, A, inst } = await governed(t);
  assert.equal((await alice.post(`/hub/teams/${A}/github/policy`, { require_review: '1' })).status, 303);
  // The same switches on Settings, Approval rules come back there, with a refusal shown there.
  assert.match((await alice.post(`/hub/teams/${A}/github/policy`, { require_provenance: '1', from: 'settings' })).location, /\/settings\/rules\?done=policy_saved$/);
  const nothing = await alice.post(`/hub/teams/${A}/github/policy`, { from: 'settings' });
  assert.equal(nothing.status, 400);
  assert.match(nothing.text, /<h1>Approval rules<\/h1>[\s\S]*Nothing to change/);
  assert.match((await alice.req(`/hub/teams/${A}/settings/rules`)).text, /id="require-review"[\s\S]*id="rules"[\s\S]*class="field rule-review-only"/);
  assert.doesNotMatch((await bob.req(`/hub/teams/${A}/settings/rules`)).text, /id="require-review"/, 'the policy is for owners');
  // Validation: a bad pattern, too few approvers for the count.
  assert.equal((await alice.post(`/hub/teams/${A}/rules`, { pattern: '../x', approvals: '1' })).status, 400);
  const few = await alice.post(`/hub/teams/${A}/rules`, { pattern: 'payments/**', approvals: '2', [`approver_${bob.user.id}`]: '1' });
  assert.equal(few.status, 400);
  assert.match(few.text, /needs 2 approvals but names 1 approver/);
  // Only owners add rules.
  assert.equal((await bob.post(`/hub/teams/${A}/rules`, { pattern: 'payments/**', approvals: '1' })).status, 403);
  const ok = await alice.post(`/hub/teams/${A}/rules`, { pattern: 'payments/**', approvals: '2', [`approver_${bob.user.id}`]: '1', [`approver_${carol.user.id}`]: '1', from: 'settings' });
  assert.equal(ok.status, 303, ok.text);
  assert.match(ok.location, /\/settings\/rules\?done=rule_added$/);
  assert.equal(h.hub.github.rules.list(A).length, 1);

  // A member not named by the rule cannot approve RUN1 (it changed payments/charge.js).
  const dave = await signIn(h, 'rules-dave');
  await join(alice, dave, A);
  const refused = await dave.post(`${runPath(A, RUN1)}/decision`, { status: 'approved' });
  assert.equal(refused.status, 403);
  assert.match(refused.text, /only .*can approve it/);
  // RUN2 touched no rule path: one approval from anyone is enough.
  assert.equal((await dave.post(`${runPath(A, RUN2)}/decision`, { status: 'approved' })).status, 303);

  // Bob approves RUN1: still one short.
  assert.equal((await bob.post(`${runPath(A, RUN1)}/decision`, { status: 'approved' })).status, 303);
  await hook(h, 'pull_request', prEvent(inst));
  await h.hub.github.queue.idle();
  assert.equal(check(h).conclusion, 'failure');
  assert.match(check(h).output.summary, /a path rule needs more: payments&#47;&#42;&#42; needs 2 approvals from .*&#59; has 1/);
  const page = await carol.req(`${runPath(A, RUN1)}?machine=alice-laptop`);
  assert.match(page.text, /Approvals this run needs/);
  assert.match(page.text, /<b>1 more approval needed<\/b>, from gov-carol/);
  assert.match(page.text, /Needs approval/, 'the badge does not say Approved while a rule is unmet');
  // Carol approves: the check passes through re-evaluation.
  assert.equal((await carol.post(`${runPath(A, RUN1)}/decision`, { status: 'approved' })).status, 303);
  await h.hub.github.queue.idle();
  assert.equal(check(h).conclusion, 'success', check(h).output.summary);
  // The decision recorded the rule that applied.
  const snap = h.hub.db.prepare("SELECT rules FROM hub_reviews WHERE run = ? AND reviewer_user_id = ?").get(RUN1, carol.user.id);
  assert.match(snap.rules, /payments\/\*\*/);

  // Rules page: members read, owners remove; another team gets 404.
  assert.match((await bob.req(`/hub/teams/${A}/rules`)).location, /\/settings\/rules$/, 'the old address goes to Settings, Approval rules');
  assert.match((await bob.req(`/hub/teams/${A}/settings/rules`)).text, /payments\/\*\*/);
  const id = h.hub.github.rules.list(A)[0].id;
  assert.equal((await bob.post(`/hub/teams/${A}/rules/${id}/delete`)).status, 403);
  const mallory = await signIn(h, 'rules-mallory');
  await createTeam(mallory, 'M');
  assert.equal((await mallory.req(`/hub/teams/${A}/rules`)).status, 404);
  assert.equal((await mallory.post(`/hub/teams/${A}/rules/${id}/delete`)).status, 404);
  assert.equal((await alice.post(`/hub/teams/${A}/rules/${id}/delete`)).status, 303);
  assert.equal(h.hub.github.rules.list(A).length, 0);
});

test('path rules are a Governance feature: refused without the plan, and kept but inert when the plan lapses', async (t) => {
  let gov = true;
  const { h, alice, bob, A } = await governed(t, { governance: () => gov });
  assert.equal((await alice.post(`/hub/teams/${A}/rules`, { pattern: 'payments/**', approvals: '2' })).status, 303);
  gov = false;
  const r = await alice.post(`/hub/teams/${A}/rules`, { pattern: 'infra/**', approvals: '1' });
  assert.equal(r.status, 402);
  assert.match((await alice.req(`/hub/teams/${A}/settings/rules`)).text, /Path rules are on the Governance plan/);
  // Inert: bob's single approval is not refused or held back by the rule.
  assert.equal((await bob.post(`${runPath(A, RUN1)}/decision`, { status: 'approved' })).status, 303);
  assert.equal(h.hub.github.rulesFor({ id: A }, [ROOT], [RUN1]).size, 0);
});

// ---------------------------------------------------------------- 3. Slack

test('slack: owners save a webhook (sealed, never shown); a 15-minute digest of runs awaiting review; failed checks once per head; a dead webhook turns off', async (t) => {
  const clock = { t: Date.now() };
  const { h, alice, bob, A, inst, token } = await governed(t, { clock });
  const db = h.hub.db;
  const slack = h.ff.slack;
  // Validation and permissions.
  const bad = await alice.post(`/hub/teams/${A}/notifications/slack`, { url: 'https://evil.example/services/T0123ABCD/B0456EFGH/abcdefghijklmnopqrstuvwx' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Paste a Slack incoming webhook URL/);
  assert.equal((await bob.post(`/hub/teams/${A}/notifications/slack`, { url: SLACK })).status, 403);
  assert.equal((await alice.post(`/hub/teams/${A}/notifications/slack`, { url: SLACK })).status, 303);
  const row = db.prepare('SELECT * FROM team_notify WHERE team_id = ?').get(A);
  assert.ok(!row.slack_url.includes('hooks.slack.com') && row.slack_url.startsWith('v2.'), 'sealed');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM team_notify').all()).includes('abcdefghijklmnopqrstuvwx'));
  const settings = await alice.req(`/hub/teams/${A}/settings/notifications`);
  assert.match(settings.text, /Webhook ending in <code>…uvwx<\/code>/);
  assert.doesNotMatch(settings.text, /abcdefghijklmnopqrst/);
  // Copied into another team's row, the sealed URL does not open.
  const mallory = await signIn(h, 'slack-mallory');
  const M = await createTeam(mallory, 'M');
  db.prepare('INSERT INTO team_notify (team_id, slack_url, hint, set_at) VALUES (?, ?, ?, ?)').run(M, row.slack_url, 'uvwx', clock.t);
  assert.equal(await h.hub.notify.post(M, 'stolen'), false);
  assert.equal(slack.posts.length, 0);
  db.prepare('DELETE FROM team_notify WHERE team_id = ?').run(M);

  // Test message.
  assert.match((await alice.post(`/hub/teams/${A}/notifications/slack/test`)).location, /done=slack_tested/);
  assert.equal(slack.posts.length, 1);
  assert.equal(slack.posts[0].url, SLACK);

  // Runs synced before the webhook was saved are not announced; new ones are, once.
  assert.equal(await h.hub.notify.tick(), 0);
  await sync(h, token, { repo: { id: ROOT, name: 'api', github: 'github.com/acme/api' }, machine: 'alice-laptop', runs: [{ run: 'claude-code:cccc', turn: 1, started_at: clock.t }], changes: [{ ...change(4, 'claude-code:cccc', 'claude cccc <!channel>', V0, V1) }] });
  assert.equal(await h.hub.notify.tick(), 1);
  const digest = slack.posts.at(-1).body.text;
  assert.match(digest, /\*1 agent run waiting for approval\* in Gov Co/);
  assert.match(digest, /claude cccc &lt;!channel&gt;/, 'synced text is escaped for Slack');
  assert.ok(digest.includes(`<${ORIGIN}/hub/teams/${A}/repos/${ROOT}/runs/claude-code%3Acccc?machine=alice-laptop|`));
  // Within 15 minutes: no second digest, even with a new run.
  await sync(h, token, { repo: { id: ROOT, name: 'api', github: 'github.com/acme/api' }, machine: 'alice-laptop', runs: [{ run: 'claude-code:dddd', turn: 1, started_at: clock.t }], changes: [change(5, 'claude-code:dddd', 'claude dddd', V1, V2)] });
  assert.equal(await h.hub.notify.tick(), 0);
  clock.t += 16 * 60 * 1000;
  assert.equal(await h.hub.notify.tick(), 1);
  assert.match(slack.posts.at(-1).body.text, /claude dddd/);
  assert.doesNotMatch(slack.posts.at(-1).body.text, /cccc/, 'each run is announced once');

  // A failing check posts once per head commit.
  assert.equal((await alice.post(`/hub/teams/${A}/github/policy`, { require_review: '1' })).status, 303);
  const n = slack.posts.length;
  await hook(h, 'pull_request', prEvent(inst));
  await h.hub.github.queue.idle();
  await hook(h, 'pull_request', prEvent(inst));
  await h.hub.github.queue.idle();
  const failed = slack.posts.slice(n).filter((p) => /Grapim check failed/.test(p.body.text));
  assert.equal(failed.length, 1);
  assert.match(failed[0].body.text, /<https:\/\/github\.com\/acme\/api\/pull\/7\|acme\/api#7>/);

  // Slack answers 410 (channel archived): the webhook turns off and says so.
  slack.status = 410;
  assert.equal(await h.hub.notify.post(A, 'x'), false);
  assert.ok(db.prepare('SELECT disabled_at FROM team_notify WHERE team_id = ?').get(A).disabled_at);
  assert.match((await alice.req(`/hub/teams/${A}/settings/notifications`)).text, /Slack answered 410/);
  const before = slack.posts.length;
  await h.hub.notify.post(A, 'y');
  assert.equal(slack.posts.length, before, 'no more posts while off');
  // Removing it.
  assert.equal((await alice.post(`/hub/teams/${A}/notifications/slack/remove`)).status, 303);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM team_notify WHERE team_id = ?').get(A).n, 0);
});

// ---------------------------------------------------------------- 5. audit evidence

test('audit evidence: every run in the range with its decisions, merged pull request and rules, as CSV and a print view; Governance only; team scoped', async (t) => {
  let gov = true;
  const { h, alice, bob, carol, A, inst } = await governed(t, { governance: () => gov });
  h.hub.db.prepare("UPDATE teams SET plan = 'governance' WHERE id = ?").run(A);
  assert.equal((await alice.post(`/hub/teams/${A}/github/policy`, { require_review: '1' })).status, 303);
  assert.equal((await alice.post(`/hub/teams/${A}/rules`, { pattern: 'payments/**', approvals: '1' })).status, 303);
  assert.equal((await bob.post(`${runPath(A, RUN1)}/decision`, { status: 'rejected', note: 'no tests' })).status, 303);
  assert.equal((await carol.post(`${runPath(A, RUN1)}/decision`, { status: 'approved' })).status, 303);
  await hook(h, 'pull_request', prEvent(inst));
  await h.hub.github.queue.idle();
  // The pull request merges: its runs are kept as having reached a merged PR.
  await hook(h, 'pull_request', prEvent(inst, 'closed', { merged: true, merged_at: new Date().toISOString() }));
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM gh_merged_runs WHERE team_id = ?').get(A).n, 2);

  const today = new Date().toISOString().slice(0, 10);
  const q = `?from=${today}&to=${today}`;
  const csv = await bob.req(`/hub/api/teams/${A}/reports/evidence.csv${q}`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /grapim-evidence-/);
  const lines = csv.text.trim().split('\r\n');
  assert.equal(lines[0], 'run_id,repo,agent,agent_label,intent,first_change_utc,last_change_utc,lines_added,lines_removed,files,synced_by,review_status,approved_by,approved_at_utc,rejected_by,rejected_at_utc,all_decisions,merged_pull_requests,merged_at_utc,open_pull_requests,path_rules_now,path_rules_at_decision');
  assert.equal(lines.length, 3, 'two runs');
  const run1 = lines.find((l) => l.startsWith(RUN1));
  assert.match(run1, /acme\/api,Claude Code,claude aaaa1111,/);
  assert.match(run1, /,approved,gov-carol-\d+,/);
  assert.match(run1, /rejected by gov-bob-\d+; [^,]+ approved by gov-carol/);
  assert.match(run1, /https:\/\/github\.com\/acme\/api\/pull\/7/);
  assert.match(run1, /payments\/\*\* \(met\),payments\/\*\*$/);
  assert.match(lines.find((l) => l.startsWith(RUN2)), /,not reviewed,/);

  const pageHtml = await bob.req(`/hub/teams/${A}/reports/evidence${q}`);
  assert.equal(pageHtml.status, 200);
  assert.match(pageHtml.text, /not a certification/);
  assert.match(pageHtml.text, /Reached a merged PR/);
  const print = await bob.req(`/hub/teams/${A}/reports/evidence/print${q}`);
  assert.equal(print.status, 200);
  assert.match(print.text, /agent run evidence/);
  assert.match(print.text, /not a certification, an attestation or proof of compliance/);
  assert.match(print.text, /data-print/);
  assert.doesNotMatch(print.text, /\sstyle=|<script>[^<]/);

  // Without the plan: the page shows the upsell; CSV and print are 402.
  gov = false;
  h.hub.db.prepare("UPDATE teams SET plan = 'free' WHERE id = ?").run(A);
  assert.equal((await bob.req(`/hub/api/teams/${A}/reports/evidence.csv${q}`)).status, 402);
  assert.equal((await bob.req(`/hub/teams/${A}/reports/evidence/print${q}`)).status, 402);
  assert.match((await bob.req(`/hub/teams/${A}/reports/evidence`)).text, /Governance/);
  // Another team: 404.
  const mallory = await signIn(h, 'ev-mallory');
  await createTeam(mallory, 'M');
  for (const p of ['/reports/evidence', '/reports/evidence/print']) assert.equal((await mallory.req(`/hub/teams/${A}${p}`)).status, 404);
  assert.equal((await mallory.req(`/hub/api/teams/${A}/reports/evidence.csv`)).status, 404);
});

test('automatic rules: a run whose every file is covered passes on its own with the rule and its author on record; review rules always win', async (t) => {
  const { h, alice, bob, A, inst, token } = await governed(t);
  assert.equal((await alice.post(`/hub/teams/${A}/github/policy`, { require_review: '1' })).status, 303);
  // Only owners add automatic rules; the starter set is refused once rules exist.
  assert.equal((await bob.post(`/hub/teams/${A}/rules`, { pattern: 'src/**', action: 'auto' })).status, 403);
  assert.equal((await alice.post(`/hub/teams/${A}/rules`, { pattern: 'src/**', action: 'auto' })).status, 303);
  assert.equal((await alice.post(`/hub/teams/${A}/rules`, { pattern: 'payments/**', approvals: '1' })).status, 303);
  assert.equal((await alice.post(`/hub/teams/${A}/rules/starter`)).status, 409);
  const list = h.hub.github.rules.list(A);
  assert.deepEqual(list.map((r) => [r.pattern, r.action]), [['src/**', 'auto'], ['payments/**', 'review']]);

  // RUN2 changed only src/app.js: approved by rule. RUN1 also changed payments/charge.js: a person must review it.
  await hook(h, 'pull_request', prEvent(inst));
  await h.hub.github.queue.idle();
  assert.equal(check(h).conclusion, 'failure');
  assert.match(check(h).output.summary, /Approved by rule \(1\)/);
  assert.match(check(h).output.summary, /codex bbbb\*\*: approved by rule/);
  const rows = h.hub.db.prepare("SELECT run, reviewer_user_id, rules FROM hub_reviews WHERE team_id = ? AND via = 'rule'").all(A);
  assert.deepEqual(rows.map((r) => r.run), [RUN2]);
  assert.equal(rows[0].reviewer_user_id, 0);
  assert.match(rows[0].rules, /"login":"gov-alice/);
  // A rule approval is not a member's approval.
  assert.equal(h.hub.github.reviews.approvals(A, [ROOT], RUN2).length, 0);
  // The run page names the rule and who set it.
  const page = await bob.req(`${runPath(A, RUN2)}?machine=alice-laptop`);
  assert.match(page.text, /Approved by <span class="strong">rule src\/\*\* \(set by gov-alice/);

  // Bob reviews RUN1: everything passes, one of them by rule.
  assert.equal((await bob.post(`${runPath(A, RUN1)}/decision`, { status: 'approved' })).status, 303);
  await h.hub.github.queue.idle();
  assert.equal(check(h).conclusion, 'success', check(h).output.summary);
  assert.match(check(h).output.title, /\(1 by rule\)/);

  // RUN2 later changes payments/: its rule approval goes stale and no new one is written.
  await sync(h, token, {
    repo: { id: ROOT, name: 'api', github: 'github.com/acme/api' },
    machine: 'alice-laptop',
    changes: [change(4, RUN2, 'codex bbbb', '', V0, 'payments/refund.js')],
    blobs: { [sha(V0)]: b64(V0), [sha('')]: b64('') },
  });
  assert.equal(h.hub.github.reviews.latest(A, [ROOT], [RUN2]).get(RUN2).stale, true);
  assert.equal(h.hub.db.prepare("SELECT COUNT(*) AS n FROM hub_reviews WHERE team_id = ? AND via = 'rule'").get(A).n, 1);
  // A rule-only change after a sync is approved without a pull request event.
  await sync(h, token, {
    repo: { id: ROOT, name: 'api', github: 'github.com/acme/api' },
    machine: 'alice-laptop',
    runs: [{ run: 'claude-code:cccc', turn: 1, started_at: Date.now() - 1000 }],
    changes: [change(5, 'claude-code:cccc', 'claude cccc', V0, V1, 'src/util.js')],
    blobs: { [sha(V0)]: b64(V0), [sha(V1)]: b64(V1) },
  });
  assert.equal(h.hub.github.reviews.latest(A, [ROOT], ['claude-code:cccc']).get('claude-code:cccc')?.via, 'rule');

  // The starter set on a team without rules.
  for (const r of h.hub.github.rules.list(A)) h.hub.github.rules.remove(A, r.id);
  assert.equal((await alice.post(`/hub/teams/${A}/rules/starter`, { from: 'settings' })).status, 303);
  const starter = h.hub.github.rules.list(A);
  assert.ok(starter.some((r) => r.pattern === 'docs/**' && r.action === 'auto'));
  assert.ok(starter.some((r) => r.pattern === '**/payments/**' && r.action === 'review'));
  // Another team cannot add rules here.
  const mallory = await signIn(h, 'auto-mallory');
  await createTeam(mallory, 'M2');
  assert.equal((await mallory.post(`/hub/teams/${A}/rules/starter`)).status, 404);
});
