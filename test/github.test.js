// The GitHub integration (docs/provenance.md sections 4 and 6): the shared
// renderer, and the GitHub App in the hub against a fake GitHub (REST and
// GraphQL) on a local port.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../src/hub/server.js';
import { appJwt, AppAuth, TOKEN_MARGIN_MS } from '../src/hub/github/auth.js';
import { GitHubClient } from '../src/hub/github/client.js';
import { githubConfig } from '../src/hub/github/config.js';
import { parsePatch } from '../src/hub/github/pull.js';
import { normaliseRemote, provenanceSource } from '../src/hub/github/source.js';
import { signBody, verifySignature } from '../src/hub/github/webhook.js';
import { GITHUB_LIMIT, MARKER, md, renderEmpty, renderSummary } from '../src/provenance/render.js';

const ORIGIN = 'http://localhost:7999';
const SECRET = 'whsec-test-0123456789abcdef';
const SLUG = 'grapim-test';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });

// ---------------------------------------------------------------- renderer

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const C1 = sha('c1');
const C2 = sha('c2');

function fixture(intent = 'Add the billing page', label = 'claude 1a2b3c4d', file = 'src/app.ts') {
  return {
    files: [{ path: file, added: [[1, 10]] }],
    blameByFile: { [file]: [{ start: 1, end: 6, commit: C1, orig: 11 }, { start: 7, end: 10, commit: C2, orig: 7 }] },
    notesByCommit: {
      [C1]: { v: 1, tool: 'grapim/0.1.0', runs: [{ id: 'claude-code:1a2b3c4d', label, kind: 'claude-code', turns: [{ turn: 2, intent }], review: 'pending' }], files: { [file]: [[11, 14, 0, 2]] } },
      [C2]: JSON.stringify({ v: 1, runs: [{ id: 'mcp:codex-41', label: 'codex 4121', turns: [], review: 'approved' }], files: { [file]: [[7, 7, 0, 1]] } }),
    },
  };
}

test('render: attribution through blame and notes, headline, tables, unreviewed list', () => {
  const { markdown, stats } = renderSummary(fixture());
  assert.ok(markdown.startsWith(`${MARKER}\n`));
  assert.equal(stats.added, 10);
  assert.equal(stats.ai, 5, '4 lines of claude (orig 11-14) and 1 of codex');
  assert.deepEqual(stats.runs.map((r) => [r.label, r.lines, r.review]), [['claude 1a2b3c4d', 4, 'pending'], ['codex 4121', 1, 'approved']]);
  assert.match(markdown, /\*\*1 agent run of 2 not reviewed yet\.\*\* 50% of the added lines came from agent runs \(5 of 10\): claude 1a2b3c4d 4, codex 4121 1/);
  assert.match(markdown, /#### Not reviewed in Grapim\n\n- claude 1a2b3c4d: 4 lines in 1 file/);
  assert.match(markdown, /<details><summary>Per-file breakdown \(1 file\)<\/summary>/);
  // The hub's review status beats the note's snapshot.
  const r2 = renderSummary({ ...fixture(), reviews: { 'claude-code:1a2b3c4d': 'approved' } });
  assert.equal(r2.stats.unapproved.length, 0);
  assert.match(r2.markdown, /Every agent run here was reviewed and approved in Grapim/);
  // No notes at all: human or unknown.
  assert.equal(renderSummary({ ...fixture(), notesByCommit: {} }).stats.ai, 0);
  assert.match(renderEmpty({ via: 'app' }), /grapim sync/);
});

test('render escaping: a malicious intent, label or path cannot ping, link, inject HTML or break the table', () => {
  const evil = 'x | y\n</details><img src=x onerror=alert(1)> @octocat @github/security [click](https://evil.example) www.evil.example user@evil.example #1 owner/repo#2 <!-- --> `code` **bold** :tada: ‮RTL\u0007 mailto:a@b.c';
  const { markdown } = renderSummary(fixture(evil, `label ${evil}`, `src/${evil.slice(0, 40)}.ts`));
  const RLO = String.fromCharCode(0x202e);
  const BEL = String.fromCharCode(7);
  for (const bad of [/@[A-Za-z]/, /\]\(/, /<img/i, /https?:\/\//, /www\./i, /(?<!&)#\d/, /owner\/repo#/, /<!-- -->/, /`/, /\*\*bold/, new RegExp(`[${RLO}${BEL}]`), /mailto:/]) {
    assert.doesNotMatch(markdown, bad, `escaped: ${bad}`);
  }
  assert.equal(markdown.split('</details>').length - 1, 1, 'only our own </details>');
  assert.equal(markdown.split('<details>').length - 1, 1);
  assert.equal(markdown.split('<!--').length - 1, 1, 'only the marker is a comment');
  // Every table row keeps its column count: a raw "|" never comes from input.
  for (const line of markdown.split('\n').filter((l) => l.startsWith('| '))) {
    const pipes = line.split('|').length - 1;
    assert.ok(pipes === 7 || pipes === 5, `row has ${pipes} pipes: ${line.slice(0, 80)}`);
  }
  assert.equal(md('a\nb\r\nc'), 'a b c');
  assert.equal(md('x'.repeat(300), 10).length, 10);
});

test('render truncation: a huge PR stays under GitHub\'s 65,536 characters and says what it left out', () => {
  const files = [];
  const blameByFile = {};
  const notesByCommit = {};
  for (let i = 0; i < 3000; i++) {
    const p = `src/module-${i}/a-rather-long-file-name-${i}.ts`;
    const c = sha(`c${i}`);
    files.push({ path: p, added: [[1, 20]] });
    blameByFile[p] = [{ start: 1, end: 20, commit: c, orig: 1 }];
    notesByCommit[c] = { v: 1, runs: [{ id: `claude-code:run-${i}`, label: `claude run-${i}`, turns: [{ turn: 1, intent: `${'Refactor everything about the module carefully '.repeat(3)}${i}` }], review: 'pending' }], files: { [p]: [[1, 15, 0, 1]] } };
  }
  const { markdown, stats } = renderSummary({ files, blameByFile, notesByCommit, omittedFiles: 120 });
  assert.ok(markdown.length <= GITHUB_LIMIT, `${markdown.length}`);
  assert.ok(stats.truncated);
  assert.equal(stats.runs.length, 3000, 'stats are complete even when the comment is not');
  assert.match(markdown, /more runs? not shown/);
  assert.match(markdown, /Shortened to fit GitHub/);
  assert.match(markdown, /120 more files were not/);
  assert.ok(markdown.startsWith(MARKER));
  assert.equal(markdown.split('<details>').length, markdown.split('</details>').length, 'details stay balanced');
  // With a small budget too.
  const small = renderSummary({ files, blameByFile, notesByCommit, limit: 5000 });
  assert.ok(small.markdown.length <= 5000, `${small.markdown.length}`);
});

test('parsePatch: added head lines from a unified diff', () => {
  assert.deepEqual(parsePatch('@@ -1,2 +1,3 @@\n a\n+b\n c\n@@ -10,0 +11,2 @@\n+x\n+y\n-z\n\\ No newline at end of file'), [[2, 2], [11, 12]]);
  assert.deepEqual(parsePatch(undefined), []);
  assert.equal(normaliseRemote('git@github.com:Owner/Repo.git'), 'github.com/owner/repo');
  assert.equal(normaliseRemote('https://x@github.com/o/r'), 'github.com/o/r');
  assert.equal(normaliseRemote('https://gitlab.com/o/r'), null);
});

// ---------------------------------------------------------------- auth

test('JWT: RS256 with iat 60 s back, exp within 10 minutes, iss = app id; verified with node:crypto', () => {
  const now = Date.UTC(2026, 10, 11, 12, 0, 0);
  const jwt = appJwt({ appId: '12345', key: privateKey, now });
  const [h, b, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(b, 'base64url'));
  assert.equal(claims.iss, '12345');
  assert.equal(claims.iat, now / 1000 - 60);
  assert.ok(claims.exp > now / 1000 && claims.exp - claims.iat <= 600, 'exp at most 10 minutes after iat');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, 'base64url')));
  assert.ok(!crypto.verify('RSA-SHA256', Buffer.from(`${h}.${b}x`), publicKey, Buffer.from(s, 'base64url')));
  // The PEM is accepted raw, base64, or with literal \n; anything else is a config problem.
  for (const v of [PEM, Buffer.from(PEM).toString('base64'), PEM.replace(/\n/g, '\\n')]) assert.ok(githubConfig({ GITHUB_APP_PRIVATE_KEY: v, GITHUB_APP_ID: '1', GITHUB_APP_WEBHOOK_SECRET: SECRET, GITHUB_APP_SLUG: 'a' }).configured);
  const broken = githubConfig({ GITHUB_APP_PRIVATE_KEY: 'not a key', GITHUB_APP_ID: '1', GITHUB_APP_WEBHOOK_SECRET: SECRET, GITHUB_APP_SLUG: 'a' });
  assert.equal(broken.configured, false);
  assert.ok(!JSON.stringify(githubConfig({ GITHUB_APP_PRIVATE_KEY: PEM, GITHUB_APP_WEBHOOK_SECRET: SECRET })).includes(SECRET), 'secrets are not enumerable');
});

test('installation tokens are cached until 5 minutes before they expire', async () => {
  let clock = Date.UTC(2026, 10, 11, 12, 0, 0);
  let calls = 0;
  const fetch = async (url, init) => {
    assert.match(url, /\/app\/installations\/77\/access_tokens$/);
    assert.equal(init.method, 'POST');
    const jwt = init.headers.Authorization.replace('Bearer ', '');
    const [h, b, s] = jwt.split('.');
    assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, 'base64url')));
    calls++;
    return new Response(JSON.stringify({ token: `ghs_${calls}`, expires_at: new Date(clock + 60 * 60 * 1000).toISOString() }), { status: 201 });
  };
  const auth = new AppAuth({ appId: '1', key: privateKey, apiBase: 'https://api.example', fetch, now: () => clock });
  const [a, b] = await Promise.all([auth.installationToken(77), auth.installationToken(77)]);
  assert.equal(a, 'ghs_1');
  assert.equal(b, 'ghs_1', 'concurrent callers share one request');
  clock += 54 * 60 * 1000;
  assert.equal(await auth.installationToken(77), 'ghs_1', 'still cached 6 minutes before expiry');
  clock += 2 * 60 * 1000;
  assert.ok(60 * 60 * 1000 - 56 * 60 * 1000 < TOKEN_MARGIN_MS);
  assert.equal(await auth.installationToken(77), 'ghs_2', 'refreshed inside the 5-minute margin');
  assert.equal(calls, 2);
});

test('client: backs off on a 403 with rate-limit headers, and gives up past the wait cap', async () => {
  const waits = [];
  let n = 0;
  const fetch = async () => {
    n++;
    if (n === 1) return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 30) } });
    if (n === 2) return new Response('{}', { status: 429, headers: { 'retry-after': '2' } });
    return new Response('{"ok":true}', { status: 200 });
  };
  const gh = new GitHubClient({ apiBase: 'https://api.example', token: 't', fetch, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(await gh.rest('GET', '/x'), { ok: true });
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 29_000 && waits[0] <= 32_000, `${waits[0]}`);
  assert.equal(waits[1], 2000);
  const slow = new GitHubClient({ apiBase: 'https://api.example', token: 't', fetch: async () => new Response('{}', { status: 403, headers: { 'retry-after': '3600' } }), sleep: async () => {} });
  await assert.rejects(slow.rest('GET', '/x'), /rate limit/);
  // A plain 403 (no rate-limit header) is not retried.
  let plain = 0;
  const noRetry = new GitHubClient({ apiBase: 'https://api.example', token: 't', fetch: async () => (plain++, new Response('{}', { status: 403 })), sleep: async () => {} });
  await assert.rejects(noRetry.rest('GET', '/x'), /403/);
  assert.equal(plain, 1);
});

// ---------------------------------------------------------------- the App in the hub

// A fake GitHub: REST and GraphQL, state in memory.
function fakeGitHub() {
  const s = { requests: [], files: new Map(), blame: new Map(), prFiles: [], comments: [], checks: [], installs: new Map(), nextId: 1000 };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const url = new URL(req.url, 'http://x');
    s.requests.push(`${req.method} ${url.pathname}`);
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
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
    if (req.method === 'POST' && url.pathname === '/graphql') {
      const v = body.variables;
      if (body.query.includes('blame(')) return send(200, { data: { repository: { object: { blame: { ranges: s.blame.get(`${v.oid}:${v.path}`) ?? [] } } } } });
      const repository = {};
      for (const [k, e] of Object.entries(v)) {
        if (!/^e\d+$/.test(k)) continue;
        const text = s.files.get(e);
        repository[`f${k.slice(1)}`] = text === undefined ? null : { byteSize: Buffer.byteLength(text), isBinary: false, ...(body.query.includes('text') ? { text } : {}) };
      }
      return send(200, { data: { repository } });
    }
    if (url.pathname === '/repos/acme/api/pulls/7/commits') {
      const page = Number(url.searchParams.get('page'));
      return send(200, (s.prCommits ?? []).slice((page - 1) * 100, page * 100));
    }
    if ((m = /^\/repos\/acme\/api\/pulls\/7\/files$/.exec(url.pathname))) {
      const page = Number(url.searchParams.get('page'));
      return send(200, s.prFiles.slice((page - 1) * 100, page * 100));
    }
    if ((m = /^\/repos\/acme\/api\/issues\/7\/comments$/.exec(url.pathname))) {
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

async function startHub({ configured = true, github = {}, clock = null, env: extraEnv = {} } = {}) {
  const oauth = fakeOAuth();
  const gh = await fakeGitHub();
  const env = {
    HUB_URL: ORIGIN,
    HUB_SECRET: 'test-secret-that-is-long-enough-0123456789',
    HUB_DATA: tmp('grapim-gh-'),
    GITHUB_CLIENT_ID: 'gh-client',
    GITHUB_CLIENT_SECRET: 'gh-secret',
    ...(configured ? { GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: Buffer.from(PEM).toString('base64'), GITHUB_APP_WEBHOOK_SECRET: SECRET, GITHUB_APP_SLUG: SLUG } : {}),
    ...extraEnv,
  };
  const logs = [];
  const hub = await createHub({
    env,
    fetch: oauth.fetch,
    billing: null,
    log: (l) => logs.push(l),
    ...(clock ? { now: () => clock.t } : {}),
    github: { fetch: globalThis.fetch, apiBase: gh.base, sleep: async () => {}, ...github },
    platform: { worker: false },
  });
  const addr = await hub.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  return { hub, gh, oauth, base, logs, close: async () => { await hub.close(); await gh.close(); } };
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
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
  async post(p, form = {}) {
    const me = JSON.parse((await this.req('/hub/api/me')).text);
    return this.req(p, { method: 'POST', form: { _csrf: me.csrf, ...form } });
  }
}

let nextUser = 9000;
async function signIn(h, login) {
  const id = nextUser++;
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
async function hook(h, event, payload, { sig, id = `d-${delivery++}` } = {}) {
  const raw = Buffer.from(JSON.stringify(payload));
  const headers = { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': id };
  if (sig !== null) headers['X-Hub-Signature-256'] = sig ?? signBody(SECRET, raw);
  const res = await fetch(`${h.base}/hub/github/webhook`, { method: 'POST', headers, body: raw });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const installed = (id, user, account = { id: 555, login: 'acme', type: 'Organization' }) => ({ action: 'created', installation: { id, account }, sender: { id: user.id, login: user.login }, repositories: [{ id: 1, full_name: 'acme/api' }] });

// Links installation `id` to `team`, as the owner `b` would through GitHub.
async function link(h, b, team, id) {
  const r = await b.post(`/hub/teams/${team}/github/install`);
  assert.equal(r.status, 303);
  const url = new URL(r.location);
  assert.equal(`${url.origin}${url.pathname}`, `https://github.com/apps/${SLUG}/installations/new`);
  assert.equal((await hook(h, 'installation', installed(id, b.user))).status, 200);
  const cb = await b.req(`/hub/github/setup?installation_id=${id}&setup_action=install&state=${encodeURIComponent(url.searchParams.get('state'))}`);
  assert.equal(cb.status, 303, cb.text);
  assert.match(cb.location, new RegExp(`/hub/teams/${team}/github\\?done=linked`));
  return url.searchParams.get('state');
}

test('webhook: signature valid, invalid and missing; deliveries are deduped; no secret configured refuses all', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const payload = { zen: 'hi', hook_id: 1 };
  assert.deepEqual((await hook(h, 'ping', payload)).status, 200);
  assert.equal((await hook(h, 'ping', payload, { sig: signBody('wrong-secret', Buffer.from(JSON.stringify(payload))) })).status, 401);
  assert.equal((await hook(h, 'ping', payload, { sig: null })).status, 401);
  assert.equal((await hook(h, 'ping', payload, { sig: 'sha256=zz' })).status, 401);
  // A body that changed after signing.
  const raw = Buffer.from(JSON.stringify(payload));
  const res = await fetch(`${h.base}/hub/github/webhook`, { method: 'POST', headers: { 'X-GitHub-Event': 'ping', 'X-GitHub-Delivery': 'tamper', 'X-Hub-Signature-256': signBody(SECRET, raw) }, body: `${raw} ` });
  assert.equal(res.status, 401);
  // The signature is checked before parsing: a signed non-JSON body is 400, an unsigned one 401.
  assert.equal((await fetch(`${h.base}/hub/github/webhook`, { method: 'POST', headers: { 'X-GitHub-Event': 'ping', 'X-GitHub-Delivery': 'nj1', 'X-Hub-Signature-256': signBody(SECRET, Buffer.from('{nope')) }, body: '{nope' })).status, 400);
  assert.equal((await fetch(`${h.base}/hub/github/webhook`, { method: 'POST', headers: { 'X-GitHub-Event': 'ping', 'X-GitHub-Delivery': 'nj2' }, body: '{nope' })).status, 401);

  // Dedupe: the same delivery id twice applies once.
  const ins = installed(4242, { id: 1, login: 'x' });
  assert.equal((await hook(h, 'installation', ins, { id: 'dup-1' })).status, 200);
  h.hub.db.prepare('DELETE FROM gh_installations WHERE id = 4242').run();
  const again = await hook(h, 'installation', ins, { id: 'dup-1' });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM gh_installations WHERE id = 4242').get().n, 0, 'the redelivery did nothing');
  // Kept 7 days, then swept.
  h.hub.db.prepare("UPDATE gh_deliveries SET received_at = ? WHERE id = 'dup-1'").run(Date.now() - 8 * 24 * 3600_000);
  h.hub.github.deliveries.sweep();
  assert.equal(h.hub.db.prepare("SELECT COUNT(*) AS n FROM gh_deliveries WHERE id = 'dup-1'").get().n, 0);

  assert.ok(verifySignature(SECRET, raw, signBody(SECRET, raw)));
  assert.ok(!verifySignature('', raw, signBody('', raw)), 'an empty secret never verifies');

  const off = await startHub({ configured: false });
  t.after(off.close);
  assert.equal((await hook(off, 'ping', payload)).status, 503);
  const alice = await signIn(off, 'off-alice');
  const team = await createTeam(alice, 'Off');
  const page = await alice.req(`/hub/teams/${team}/github`);
  assert.equal(page.status, 200);
  assert.match(page.text, /not configured/);
  assert.equal((await alice.post(`/hub/teams/${team}/github/install`)).status, 503);
  assert.equal((await alice.req('/hub/github/setup?installation_id=1&state=x')).status, 503);
});

test('linking: a forged, expired, reused or someone else\'s state is refused; the right one links', async (t) => {
  const clock = { t: Date.now() };
  const h = await startHub({ clock });
  t.after(h.close);
  const alice = await signIn(h, 'link-alice');
  const mallory = await signIn(h, 'link-mallory');
  const A = await createTeam(alice, 'Alpha');
  await createTeam(mallory, 'Mallory');
  const db = h.hub.db;
  const teamOf = (id) => db.prepare('SELECT team_id FROM gh_installations WHERE id = ?').get(id)?.team_id ?? null;

  const issue = async () => new URL((await alice.post(`/hub/teams/${A}/github/install`)).location).searchParams.get('state');
  await hook(h, 'installation', installed(501, alice.user));
  const setup = (b, state, id = 501) => b.req(`/hub/github/setup?installation_id=${id}&setup_action=install&state=${encodeURIComponent(state)}`);

  // Forged: a changed signature, a changed payload, a state from another purpose.
  const good = await issue();
  const [payload, mac] = [good.slice(0, good.lastIndexOf('.')), good.slice(good.lastIndexOf('.') + 1)];
  const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), t: 'otherteam' })).toString('base64url');
  for (const bad of [`${payload}.${mac.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))}`, `${forgedPayload}.${mac}`, 'garbage', `${payload}.`]) {
    const r = await setup(alice, bad);
    assert.equal(r.status, 400, bad);
    assert.equal(teamOf(501), null);
  }
  // Someone else's: mallory cannot use alice's state (it names alice).
  const s2 = await issue();
  assert.equal((await setup(mallory, s2)).status, 400);
  assert.equal(teamOf(501), null);
  // Expired.
  const s3 = await issue();
  clock.t += 31 * 60 * 1000;
  assert.equal((await setup(alice, s3)).status, 400);
  assert.equal(teamOf(501), null);
  // Fresh and right: links. Used again: refused.
  const s4 = await issue();
  assert.equal((await setup(alice, s4)).status, 303);
  assert.equal(teamOf(501), A);
  assert.equal((await setup(alice, s4)).status, 400, 'single use');

  // The setup redirect beats the webhook: the link waits for installation.created, and only its sender completes it.
  const s5 = await issue();
  h.gh.s.installs.set(502, { id: 502, account: { id: 777, login: 'acme-two', type: 'Organization' } });
  const early = await setup(alice, s5, 502);
  assert.match(early.location, /done=pending/);
  assert.equal(teamOf(502), null);
  await hook(h, 'installation', installed(502, alice.user, { id: 777, login: 'acme-two', type: 'Organization' }));
  assert.equal(teamOf(502), A, 'completed by the installation.created event from alice');
  const s6 = await issue();
  h.gh.s.installs.set(503, { id: 503, account: { id: 778, login: 'acme-three', type: 'Organization' } });
  await setup(alice, s6, 503);
  await hook(h, 'installation', installed(503, mallory.user, { id: 778, login: 'acme-three', type: 'Organization' }));
  assert.equal(teamOf(503), null, 'installed by someone else: never linked');
  // A user-account installation on alice's own account links straight from the App API.
  const s7 = await issue();
  h.gh.s.installs.set(504, { id: 504, account: { id: alice.user.id, login: alice.user.login, type: 'User' } });
  assert.match((await setup(alice, s7, 504)).location, /done=linked/);
  assert.equal(teamOf(504), A);
});

test('IDOR: team B cannot link, unlink, see or take over team A\'s installation; members cannot link at all', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'idor-alice');
  const bob = await signIn(h, 'idor-bob');
  const mallory = await signIn(h, 'idor-mallory');
  const A = await createTeam(alice, 'Alpha');
  const M = await createTeam(mallory, 'Mallory');
  await link(h, alice, A, 601);
  const teamOf = () => h.hub.db.prepare('SELECT team_id FROM gh_installations WHERE id = 601').get().team_id;

  // Mallory, owner of her own team, with alice's installation id.
  assert.equal((await mallory.post(`/hub/teams/${M}/github/link`, { installation: '601' })).status, 404);
  assert.equal((await mallory.post(`/hub/teams/${M}/github/unlink`, { installation: '601' })).status, 404);
  const ms = new URL((await mallory.post(`/hub/teams/${M}/github/install`)).location).searchParams.get('state');
  const take = await mallory.req(`/hub/github/setup?installation_id=601&state=${encodeURIComponent(ms)}`);
  assert.ok([403, 409].includes(take.status), `${take.status}`);
  assert.equal(teamOf(), A);
  const page = await mallory.req(`/hub/teams/${M}/github`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /acme/, 'team A\'s account is not listed for team B');
  // Team A's routes are 404 to mallory.
  assert.equal((await mallory.req(`/hub/teams/${A}/github`)).status, 404);
  assert.equal((await mallory.post(`/hub/teams/${A}/github/unlink`, { installation: '601' })).status, 404);
  // Even alice cannot move it to another team she owns while it is linked.
  const A2 = await createTeam(alice, 'Alpha Two');
  assert.equal((await alice.post(`/hub/teams/${A2}/github/link`, { installation: '601' })).status, 409);
  assert.equal(teamOf(), A);

  // A member (not owner) of team A cannot see the page or change anything.
  const inv = await alice.post(`/hub/teams/${A}/invites`);
  const token = inv.text.match(/\/hub\/invite\/([A-Za-z0-9_-]+)/)[1];
  await bob.post('/hub/invite/accept', { token });
  assert.equal((await bob.req(`/hub/teams/${A}/github`)).status, 403);
  for (const p of ['install', 'link', 'unlink', 'policy']) assert.equal((await bob.post(`/hub/teams/${A}/github/${p}`, { installation: '601', require_review: '1' })).status, 403, p);
  assert.equal(teamOf(), A);
  // The owner unlinks.
  assert.equal((await alice.post(`/hub/teams/${A}/github/unlink`, { installation: '601' })).status, 303);
  assert.equal(teamOf(), null);
});

// The PR fixture: src/app.js at head H. Lines 3-5 came from C1 (where they
// were lines 4-6: a header line was deleted since), lines 6-7 from H.
const BASE = sha('base');
const H = sha('head');
const NOTE_C1 = { v: 1, tool: 'grapim/0.1.0', runs: [{ id: 'claude-code:aaaa1111', label: 'claude aaaa1111', kind: 'claude-code', turns: [{ turn: 1, intent: 'Add f, cc @octocat' }], review: 'pending' }], files: { 'src/app.js': [[4, 6, 0, 1]] } };
const NOTE_H = { v: 1, tool: 'grapim/0.1.0', runs: [{ id: 'mcp:codex-bbbb', label: 'codex bbbb', kind: 'codex', turns: [{ turn: 2, intent: 'Export f' }], review: 'pending' }], files: { 'src/app.js': [[7, 7, 0, 2]] } };

function seedPr(s) {
  const C1x = sha('c1x');
  s.files.set(`${C1x}:src/app.js`, '// old header\nconst a = 1;\nconst b = 2;\nfunction f() {\n  return 42;\n}\n');
  s.files.set(`${H}:src/app.js`, 'const a = 1;\nconst b = 2;\nfunction f() {\n  return 42;\n}\n// tuned\nexport { f };\n');
  s.files.set(`${H}:README.md`, 'hello\nworld\n');
  s.blame.set(`${H}:src/app.js`, [
    { startingLine: 1, endingLine: 2, commit: { oid: BASE } },
    { startingLine: 3, endingLine: 5, commit: { oid: C1x } },
    { startingLine: 6, endingLine: 7, commit: { oid: H } },
  ]);
  s.blame.set(`${H}:README.md`, [{ startingLine: 1, endingLine: 2, commit: { oid: H } }]);
  s.prFiles = [
    { filename: 'src/app.js', status: 'modified', additions: 5, patch: '@@ -2,0 +3,5 @@\n+function f() {\n+  return 42;\n+}\n+// tuned\n+export { f };' },
    { filename: 'README.md', status: 'added', additions: 2, patch: '@@ -0,0 +1,2 @@\n+hello\n+world' },
    { filename: 'gone.js', status: 'removed', additions: 0, patch: '@@ -1 +0,0 @@\n-x' },
  ];
  return { [C1x]: NOTE_C1, [H]: NOTE_H };
}

const prEvent = (id, action = 'synchronize') => ({
  action,
  installation: { id },
  repository: { id: 99, name: 'api', full_name: 'acme/api', owner: { login: 'acme' } },
  pull_request: { number: 7, draft: false, head: { sha: H }, base: { sha: BASE } },
});

test('PR flow end to end: files, GraphQL blame, provenanceFor, comment upsert, check run with and without require_review', async (t) => {
  let gov = false;
  let notes = {};
  const reviews = new Map();
  const seen = { repoFor: [], provenanceFor: [] };
  const h = await startHub({
    github: {
      governance: () => gov,
      repoFor: (team, fullName) => (seen.repoFor.push([team.id, fullName]), fullName === 'acme/api' ? { id: sha('root'), team_id: team.id } : null),
      provenanceFor: (team, repo, shas) => (seen.provenanceFor.push(shas), shas.filter((s) => notes[s]).map((s) => ({ commit: s, note: JSON.stringify(notes[s]) }))),
      hasProvenance: () => Object.keys(notes).length > 0,
      reviewsFor: () => reviews,
    },
  });
  t.after(h.close);
  const alice = await signIn(h, 'pr-alice');
  const A = await createTeam(alice, 'Alpha');
  await link(h, alice, A, 701);
  const s = h.gh.s;

  // No provenance yet: the "how to enable" comment, once, and a neutral check.
  const fixtureNotes = seedPr(s);
  const r0 = await hook(h, 'pull_request', prEvent(701, 'opened'));
  assert.equal(r0.status, 202);
  await h.hub.github.queue.idle();
  assert.equal(s.comments.length, 1);
  assert.match(s.comments[0].body, /No AI provenance was found/);
  assert.equal(s.checks[0].conclusion, 'neutral');
  await hook(h, 'pull_request', prEvent(701));
  await h.hub.github.queue.idle();
  assert.equal(s.comments.length, 1, 'posted at most once');
  assert.ok(!s.requests.some((r) => r.startsWith('PATCH /repos/acme/api/issues/comments')), 'and not rewritten');

  // With provenance: the real summary replaces it, in place.
  notes = fixtureNotes;
  await hook(h, 'pull_request', prEvent(701));
  await h.hub.github.queue.idle();
  assert.equal(s.comments.length, 1);
  const body = s.comments[0].body;
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /57% of the added lines came from agent runs \(4 of 7\): claude aaaa1111 3, codex bbbb 1/);
  assert.doesNotMatch(body, /@octocat/, 'the intent cannot ping');
  assert.match(body, /Not reviewed in Grapim/);
  assert.equal(s.checks.length, 1);
  assert.equal(s.checks[0].conclusion, 'neutral', 'no policy: neutral');
  assert.deepEqual(seen.repoFor.at(-1), [A, 'acme/api']);
  assert.ok(!seen.provenanceFor.at(-1).includes(BASE), 'only the commits of added lines are looked up');
  assert.ok(s.requests.includes('POST /graphql'));
  assert.ok(!s.requests.some((r) => r.includes('gone.js')));

  // require_review without the governance plan: refused, the check stays neutral.
  const refused = await alice.post(`/hub/teams/${A}/github/policy`, { require_review: '1' });
  assert.equal(refused.status, 402);
  gov = true;
  assert.equal((await alice.post(`/hub/teams/${A}/github/policy`, { require_review: '1' })).status, 303);
  await hook(h, 'pull_request', prEvent(701));
  await h.hub.github.queue.idle();
  assert.equal(s.checks.length, 1, 'the same check run is updated');
  assert.equal(s.checks[0].name, 'Grapim provenance (app)');
  assert.equal(s.checks[0].conclusion, 'failure');
  assert.match(s.checks[0].output.title, /2 agent runs not approved in the Grapim hub/);

  // Approved on a machine (the team's synced review events): shown, never counted.
  reviews.set('claude-code:aaaa1111', 'approved');
  reviews.set('mcp:codex-bbbb', 'approved');
  await hook(h, 'pull_request', prEvent(701));
  await h.hub.github.queue.idle();
  assert.equal(s.checks[0].conclusion, 'failure');
  assert.match(s.checks[0].output.summary, /Approved locally by .* \(informational, does not count\)/);
  assert.match(s.comments[0].body, /Approved locally by a machine&#44; not in the hub/);
  assert.doesNotMatch(s.comments[0].body, /Every agent run here was reviewed and approved in Grapim/);
  // Losing the plan makes the policy inert.
  gov = false;
  reviews.clear();
  await hook(h, 'pull_request', prEvent(701));
  await h.hub.github.queue.idle();
  assert.equal(s.checks[0].conclusion, 'neutral');

  // A comment by someone else carrying the marker is never edited.
  s.comments.unshift({ id: 1, body: `${MARKER}\nfake`, user: { login: 'mallory', type: 'User' } });
  await hook(h, 'pull_request', prEvent(701));
  await h.hub.github.queue.idle();
  assert.equal(s.comments[0].body, `${MARKER}\nfake`);
  // Logs never carry the repo, the owner or the PR.
  assert.ok(!h.logs.some((l) => /acme|aaaa1111|octocat/.test(l)), h.logs.filter((l) => /acme/.test(l)).join('\n'));
});

test('events for unlinked installations are ignored; drafts and other actions too', async (t) => {
  const h = await startHub({ github: { repoFor: () => ({ id: 'x' }), provenanceFor: () => [], hasProvenance: () => true } });
  t.after(h.close);
  seedPr(h.gh.s);
  // Never linked.
  await hook(h, 'installation', installed(801, { id: 1, login: 'someone' }));
  const r = await hook(h, 'pull_request', prEvent(801));
  assert.equal(r.status, 200);
  assert.equal(r.body.ignored, 'unlinked');
  // Never seen at all.
  assert.equal((await hook(h, 'pull_request', prEvent(802))).body.ignored, 'unlinked');
  await h.hub.github.queue.idle();
  assert.deepEqual(h.gh.s.requests, [], 'GitHub was never called');
  // Linked, then deleted on GitHub: ignored again.
  const alice = await signIn(h, 'unl-alice');
  const A = await createTeam(alice, 'Alpha');
  await link(h, alice, A, 803);
  assert.equal((await hook(h, 'pull_request', { ...prEvent(803), pull_request: { ...prEvent(803).pull_request, draft: true } })).body.ignored, 'action');
  assert.equal((await hook(h, 'pull_request', prEvent(803, 'closed'))).body.ignored, 'action');
  await hook(h, 'installation', { action: 'deleted', installation: { id: 803, account: { id: 555, login: 'acme' } }, sender: { id: alice.user.id } });
  assert.equal((await hook(h, 'pull_request', prEvent(803))).body.ignored, 'unlinked');
  assert.equal(h.hub.db.prepare('SELECT team_id FROM gh_installations WHERE id = 803').get().team_id, null);
});

test('default provenance source: review statuses from synced review events, scoped to the team and repo', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const db = h.hub.db;
  const ins = db.prepare('INSERT INTO h_events (team_id, repo_id, machine, local_id, ts, agent, kind, path, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run('teamA', 'repo1', 'box', 1, 1, 'run-1', 'review', null, 'rejected: no tests');
  ins.run('teamA', 'repo1', 'box', 2, 2, 'run-1', 'review', null, 'approved');
  ins.run('teamA', 'repo1', 'box', 3, 3, 'run-2', 'review', null, 'pending');
  ins.run('teamB', 'repo1', 'box', 4, 4, 'run-2', 'review', null, 'approved');
  ins.run('teamA', 'repo1', 'box', 5, 5, 'run-3', 'intent', null, 'approved');
  const src = provenanceSource(h.hub);
  const r = await src.reviewsFor({ id: 'teamA' }, { id: 'repo1' }, ['run-1', 'run-2', 'run-3']);
  assert.deepEqual(Object.fromEntries(r), { 'run-1': 'approved', 'run-2': 'pending' });
  assert.equal(await src.repoFor({ id: 'teamA' }, 'acme/api'), null, 'no mapping yet: null, not a guess');

  // The hub's own mapping (repos.github) and notes (h_provenance), through the provenance builder's helpers.
  const alice = await signIn(h, 'src-alice');
  const mallory = await signIn(h, 'src-mallory');
  const A = await createTeam(alice, 'Alpha');
  const M = await createTeam(mallory, 'Mallory');
  const root = sha('root-a');
  const c = sha('commit-a');
  for (const team of [A, M]) db.prepare('INSERT INTO repos (team_id, id, name, created_at, github) VALUES (?, ?, ?, ?, ?)').run(team, root, 'api', Date.now(), team === A ? 'Acme/API' : 'mallory/other');
  db.prepare('INSERT INTO h_provenance (team_id, repo_id, commit_sha, note_json, received_at) VALUES (?, ?, ?, ?, ?)').run(A, root, c, JSON.stringify(NOTE_H), Date.now());
  const repoA = await src.repoFor({ id: A }, 'acme/api');
  assert.equal(repoA.id, root, 'owner/name matches case-insensitively');
  assert.equal(await src.repoFor({ id: M }, 'acme/api'), null, 'another team never maps to it');
  const notes = await src.notesFor({ id: A }, repoA, [c, sha('none')]);
  assert.deepEqual([...notes.keys()], [c]);
  assert.equal((await src.notesFor({ id: M }, { id: root }, [c])).size, 0, 'notes stay in their team');
  assert.ok(await src.hasAny({ id: A }, repoA));
  assert.ok(!(await src.hasAny({ id: M }, { id: root })));
});

// ---------------------------------------------------------------- require_review: approvals in the hub

const ROOT = sha('gov-root');
const RUN1 = 'claude-code:aaaa1111';
const RUN2 = 'mcp:codex-bbbb';
const V0 = 'const a = 1;\n';
const V1 = 'const a = 1;\nfunction f() {\n  return 42;\n}\n';
const V2 = `${V1}export { f };\n`;
const V3 = `${V2}// more\n`;
const b64 = (t) => Buffer.from(t).toString('base64');

async function machineToken(b, team) {
  const tok = await b.post(`/hub/teams/${team}/tokens`, { name: 'laptop' });
  return tok.text.match(/value="(cmh_[A-Za-z0-9_-]+)"/)[1];
}

async function join(owner, b, team) {
  const inv = await owner.post(`/hub/teams/${team}/invites`);
  const token = inv.text.match(/\/hub\/invite\/([A-Za-z0-9_-]+)/)[1];
  assert.equal((await b.post('/hub/invite/accept', { token })).status, 303);
}

async function sync(h, token, body) {
  const res = await fetch(`${h.base}/hub/api/sync`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(res.status, 200, await res.text());
}

const change = (id, run, label, before, after) => ({ id, run, label, turn: 1, worktree: 'wt', path: 'src/app.js', before_sha: sha(before), after_sha: sha(after), added: 1, removed: 0, ts: Date.now() - 1000 });

test('require_review: a self-approval is refused, a synced local approval does not count, another member\'s hub approval flips the check through re-evaluation', async (t) => {
  const h = await startHub({ github: { governance: () => true } });
  t.after(h.close);
  const alice = await signIn(h, 'gov-alice');
  const bob = await signIn(h, 'gov-bob');
  const A = await createTeam(alice, 'Gov');
  await join(alice, bob, A);
  await link(h, alice, A, 711);
  const s = h.gh.s;
  const notes = seedPr(s);
  const db = h.hub.db;

  // Alice's machine syncs both runs, their diffs, the notes, and her own `grapim review` approvals.
  const token = await machineToken(alice, A);
  await sync(h, token, {
    repo: { id: ROOT, name: 'api', github: 'github.com/acme/api' },
    machine: 'alice-laptop',
    runs: [{ run: RUN1, turn: 1, started_at: Date.now() - 5000 }, { run: RUN2, turn: 1, started_at: Date.now() - 5000 }],
    changes: [change(1, RUN1, 'claude aaaa1111', V0, V1), change(2, RUN2, 'codex bbbb', V1, V2)],
    events: [
      { id: 1, ts: Date.now() - 500, agent: RUN1, kind: 'review', detail: 'approved' },
      { id: 2, ts: Date.now() - 500, agent: RUN2, kind: 'review', detail: 'approved' },
    ],
    blobs: { [sha(V0)]: b64(V0), [sha(V1)]: b64(V1), [sha(V2)]: b64(V2) },
    provenance: Object.entries(notes).map(([commit, note]) => ({ commit, note: JSON.stringify(note) })),
  });
  assert.equal((await alice.post(`/hub/teams/${A}/github/policy`, { require_review: '1' })).status, 303);

  // 1. Only local approvals: failure, with each run's hub review link.
  await hook(h, 'pull_request', prEvent(711));
  await h.hub.github.queue.idle();
  const check = () => s.checks.find((c) => c.name === 'Grapim provenance (app)');
  assert.equal(check().conclusion, 'failure');
  assert.match(check().output.title, /2 agent runs not approved in the Grapim hub/);
  const summary = check().output.summary;
  assert.match(summary, /Approved locally by gov&#45;alice \(informational, does not count\)/);
  assert.ok(summary.includes(`[Review in the hub](${ORIGIN}/hub/teams/${A}/repos/${ROOT}/runs/claude-code%3Aaaaa1111?machine=alice-laptop)`), summary);
  assert.ok(summary.includes(`[Review in the hub](${ORIGIN}/hub/teams/${A}/repos/${ROOT}/runs/mcp%3Acodex-bbbb?machine=alice-laptop)`));
  assert.match(s.comments[0].body, /Approved locally by gov&#45;alice&#44; not in the hub/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gh_pull_runs WHERE team_id = ?').get(A).n, 2, "the pull request's runs are tracked");

  // 2. Alice synced the runs: she cannot approve them, by the form or by hand.
  const runPath = (run) => `/hub/teams/${A}/repos/${ROOT}/runs/${encodeURIComponent(run)}`;
  const own = await alice.post(`${runPath(RUN1)}/decision`, { status: 'approved', machine: 'alice-laptop' });
  assert.equal(own.status, 403, own.text);
  assert.match(own.text, /another member has to approve it/);
  assert.match((await alice.req(`${runPath(RUN1)}?machine=alice-laptop`)).text, /Your run: a teammate approves it/);
  assert.throws(() => h.hub.github.reviews.record(A, ROOT, RUN1, 'approved', alice.user.id), { code: 'own_run' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hub_reviews').get().n, 0);

  // 3. Bob reads the diff on the run page and approves the first run: re-checked at once, still one to go.
  const page = await bob.req(`${runPath(RUN1)}?machine=alice-laptop`);
  assert.equal(page.status, 200);
  assert.match(page.text, /return 42/, "the run's diff, from the synced blobs");
  assert.match(page.text, /value="approved"/);
  const requests = s.requests.length;
  const ok = await bob.post(`${runPath(RUN1)}/decision`, { status: 'approved', note: 'read it', machine: 'alice-laptop' });
  assert.equal(ok.status, 303, ok.text);
  assert.match(ok.location, /done=approved/);
  await h.hub.github.queue.idle();
  assert.ok(s.requests.length > requests, 're-evaluated without a webhook');
  assert.equal(check().conclusion, 'failure');
  assert.match(check().output.title, /^1 agent run not approved/);
  const row = db.prepare('SELECT * FROM hub_reviews WHERE team_id = ? AND run = ?').get(A, RUN1);
  assert.deepEqual({ status: row.status, reviewer: row.reviewer_user_id, note: row.note, repo: row.repo_id }, { status: 'approved', reviewer: bob.user.id, note: 'read it', repo: ROOT });

  // 4. The second: success, through re-evaluation alone.
  assert.equal((await bob.post(`${runPath(RUN2)}/decision`, { status: 'approved' })).status, 303);
  await h.hub.github.queue.idle();
  assert.equal(check().conclusion, 'success', check().output.summary);
  assert.equal(check().output.title, 'Every agent run is approved in the Grapim hub');
  assert.match(s.comments[0].body, /Every agent run here was reviewed and approved in Grapim/);
  assert.match((await bob.req(`${runPath(RUN1)}?machine=alice-laptop`)).text, /Approved by <span class="strong">gov-bob<\/span>/);

  // 5. The run changes after the approval: the approval no longer covers it.
  await sync(h, token, { repo: { id: ROOT, name: 'api', github: 'github.com/acme/api' }, machine: 'alice-laptop', changes: [change(3, RUN2, 'codex bbbb', V2, V3)], blobs: { [sha(V3)]: b64(V3) } });
  await hook(h, 'pull_request', prEvent(711));
  await h.hub.github.queue.idle();
  assert.equal(check().conclusion, 'failure');
  assert.match(check().output.summary, /the run changed after that/);

  // 6. A rejection re-checks too; a closed pull request is forgotten.
  assert.equal((await bob.post(`${runPath(RUN1)}/decision`, { status: 'rejected', note: 'no tests' })).status, 303);
  await h.hub.github.queue.idle();
  assert.match(check().output.summary, /Rejected in the hub by gov&#45;bob/);
  await hook(h, 'pull_request', prEvent(711, 'closed'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gh_pull_runs WHERE team_id = ?').get(A).n, 0);
});

test('require_provenance: a commit without a note fails (and passes with the toggle off); an empty human note counts as recorded; no repo mapping fails closed', async (t) => {
  let notes = {};
  let mapped = true;
  const h = await startHub({
    github: {
      governance: () => true,
      repoFor: (team, fullName) => (mapped && fullName === 'acme/api' ? { id: sha('root') } : null),
      provenanceFor: (team, repo, shas) => shas.filter((x) => notes[x]).map((x) => ({ commit: x, note: JSON.stringify(notes[x]) })),
      hasProvenance: () => true,
      hubReviewsFor: (team, repo, ids) => new Map(ids.map((id) => [id, { status: 'approved', reviewer_login: 'bob', stale: false }])),
      placesFor: () => ({}),
    },
  });
  t.after(h.close);
  const alice = await signIn(h, 'prov-alice');
  const A = await createTeam(alice, 'Prov');
  await link(h, alice, A, 721);
  const s = h.gh.s;
  const fixture = seedPr(s);
  const [C1x] = Object.keys(fixture).filter((k) => k !== H);
  const check = () => s.checks.find((c) => c.name === 'Grapim provenance (app)');
  const run = async () => {
    await hook(h, 'pull_request', prEvent(721));
    await h.hub.github.queue.idle();
    return check();
  };
  assert.equal((await alice.post(`/hub/teams/${A}/github/policy`, { require_review: '1' })).status, 303);
  assert.deepEqual({ ...h.hub.github.policy(A) }, { require_review: 1, require_provenance: 1 }, 'require_provenance is on by default with require_review');

  // C1x added lines and has no note at all: not recorded.
  notes = { [H]: fixture[H] };
  let c = await run();
  assert.equal(c.conclusion, 'failure');
  assert.match(c.output.title, /1 commit not recorded/);
  assert.match(c.output.summary, /Not recorded: 1 commit without a Grapim note/);
  assert.ok(c.output.summary.includes(`\`${C1x.slice(0, 12)}\``), 'the commit is listed');

  // An empty note (a human-only commit recorded by Grapim) counts as recorded.
  notes = { [H]: fixture[H], [C1x]: { v: 1, tool: 'grapim/0.1.0', runs: [], files: {}, commit: { ts: Date.now(), added: 3 } } };
  c = await run();
  assert.equal(c.conclusion, 'success', c.output.summary);

  // Require provenance off: the commit without a note is accepted (and said so).
  notes = { [H]: fixture[H] };
  assert.equal((await alice.post(`/hub/teams/${A}/github/policy`, { require_provenance: '0' })).status, 303);
  assert.deepEqual({ ...h.hub.github.policy(A) }, { require_review: 1, require_provenance: 0 });
  c = await run();
  assert.equal(c.conclusion, 'success', c.output.summary);
  assert.match(c.output.summary, /Require provenance is off, so it is accepted as human/);

  // No repo mapping under the policy: never neutral, every commit is unrecorded.
  assert.equal((await alice.post(`/hub/teams/${A}/github/policy`, { require_provenance: '1' })).status, 303);
  mapped = false;
  c = await run();
  assert.equal(c.conclusion, 'failure');
  assert.match(c.output.title, /2 commits not recorded/);

  // The GitHub page says exactly how to make the check required, from the App.
  const settings = await alice.req(`/hub/teams/${A}/github`);
  assert.match(settings.text, /Require status checks to pass/);
  assert.match(settings.text, /<code>Grapim provenance \(app\)<\/code>/);
  assert.match(settings.text, /source to the GitHub App <b>Grapim<\/b> \(<code>grapim-test<\/code>\)/);
});

test('require_review fails closed on what it cannot check line by line: a file without a readable diff counts every run its notes list there', async (t) => {
  const notes = {};
  const h = await startHub({
    github: {
      governance: () => true,
      repoFor: () => ({ id: sha('root') }),
      provenanceFor: (team, repo, shas) => shas.filter((x) => notes[x]).map((x) => ({ commit: x, note: JSON.stringify(notes[x]) })),
      hasProvenance: () => true,
      hubReviewsFor: () => new Map(),
      placesFor: () => ({}),
    },
  });
  t.after(h.close);
  const alice = await signIn(h, 'cap-alice');
  const A = await createTeam(alice, 'Cap');
  await link(h, alice, A, 731);
  const s = h.gh.s;
  Object.assign(notes, seedPr(s));
  // The lock file's diff is too large for GitHub to include: it is never blamed.
  const big = sha('big');
  s.prFiles.push({ filename: 'package-lock.json', status: 'modified', additions: 9000 });
  s.files.set(`${H}:package-lock.json`, '{}\n');
  s.prCommits = [{ sha: big, parents: [{ sha: BASE }] }, { sha: H, parents: [{ sha: big }] }];
  notes[big] = { v: 1, tool: 'grapim/0.1.0', runs: [{ id: 'claude-code:lock', label: 'claude lock', kind: 'claude-code', turns: [], review: 'approved' }], files: { 'package-lock.json': [[1, 40, 0, 1]] } };
  assert.equal((await alice.post(`/hub/teams/${A}/github/policy`, { require_review: '1' })).status, 303);
  await hook(h, 'pull_request', prEvent(731));
  await h.hub.github.queue.idle();
  const c = s.checks.find((x) => x.name === 'Grapim provenance (app)');
  assert.equal(c.conclusion, 'failure');
  assert.match(c.output.summary, /\*\*claude lock\*\*: up to 40 lines\. Not reviewed in the hub\./, c.output.summary);
});

// Regression (twfly104/grapim#2, 2026-11-14): the agent commit's note was
// pushed to refs/notes/grapim but never sent with `grapim sync`. The hub had
// older notes for the repo, so the App rendered a summary from hub notes only
// and said "None of the 28 added lines came from an AI agent run", while the
// Grapim Review Action, reading the pushed notes, found the Claude Code run.
// Layout: BASE (users.js + its test) <- AG (the agent commit, with the note)
// <- H (an empty "Re-run review" commit, the PR head).
test('App reads notes pushed to refs/notes/grapim for commits the hub has no note for (PR #2 regression)', async (t) => {
  const AG = sha('agent-commit');
  const NOTE = '{"v":1,"tool":"grapim","runs":[{"id":"claude-code:demo-session-1","label":"claude-code","kind":"claude-code","turns":[{"turn":1,"intent":"Add pagination to the users list endpoint"}],"review":"pending"}],"files":{"examples/review-demo/src/users.js":[[1,12,0,1]],"examples/review-demo/migrations/20261114_users_cleanup.sql":[[1,3,0,1]]}}\n';
  let gov = false;
  const h = await startHub({
    github: {
      governance: () => gov,
      repoFor: () => ({ id: sha('root') }),
      provenanceFor: () => [], // nothing synced for these commits
      hasProvenance: () => true, // but the repo has older synced notes
      hubReviewsFor: () => new Map(),
      placesFor: () => ({}),
    },
  });
  t.after(h.close);
  const alice = await signIn(h, 'pushed-alice');
  const A = await createTeam(alice, 'Pushed');
  await link(h, alice, A, 741);
  const s = h.gh.s;

  const USERS = 'examples/review-demo/src/users.js';
  const SQL = 'examples/review-demo/migrations/20261114_users_cleanup.sql';
  const WF = '.github/workflows/grapim-review.yml';
  const users = [
    "import { db } from './db.js';",
    '',
    "const BILLING_KEY = 'sk_live_DEMO_NOT_A_REAL_KEY';",
    '',
    'export async function listUsers(req, res) {',
    '  const page = Number(req.query.page ?? 1);',
    '  const size = Number(req.query.size ?? 20);',
    '  const offset = page * size;',
    "  const sort = req.query.sort ?? 'id';",
    "  const rows = await db.query('SELECT id, name FROM users ORDER BY ' + sort + ' LIMIT ' + size + ' OFFSET ' + offset);",
    '  res.json({ page, size, rows, billing: BILLING_KEY.slice(0, 7) });',
    '}',
  ];
  const sql = ['-- Tidy up the users table.', 'ALTER TABLE users DROP COLUMN email;', "DELETE FROM users WHERE last_login_at < now() - interval '90 days';"];
  const wf = Array.from({ length: 17 }, (_, i) => `# workflow line ${i + 1}`);
  for (const c of [AG, H]) {
    s.files.set(`${c}:${USERS}`, `${users.join('\n')}\n`);
    s.files.set(`${c}:${SQL}`, `${sql.join('\n')}\n`);
    s.files.set(`${c}:${WF}`, `${wf.join('\n')}\n`);
  }
  s.blame.set(`${H}:${USERS}`, [
    { startingLine: 1, endingLine: 2, commit: { oid: BASE } },
    { startingLine: 3, endingLine: 4, commit: { oid: AG } },
    { startingLine: 5, endingLine: 5, commit: { oid: BASE } },
    { startingLine: 6, endingLine: 11, commit: { oid: AG } },
    { startingLine: 12, endingLine: 12, commit: { oid: BASE } },
  ]);
  s.blame.set(`${H}:${SQL}`, [{ startingLine: 1, endingLine: 3, commit: { oid: AG } }]);
  s.blame.set(`${H}:${WF}`, [{ startingLine: 1, endingLine: 17, commit: { oid: AG } }]);
  const plus = (lines) => lines.map((l) => `+${l}`).join('\n');
  s.prFiles = [
    { filename: WF, status: 'added', additions: 17, patch: `@@ -0,0 +1,17 @@\n${plus(wf)}` },
    { filename: SQL, status: 'added', additions: 3, patch: `@@ -0,0 +1,3 @@\n${plus(sql)}` },
    { filename: USERS, status: 'modified', additions: 8, patch: `@@ -1,6 +1,12 @@\n ${users[0]}\n \n${plus(users.slice(2, 4))}\n ${users[4]}\n-  const rows = await db.query('SELECT id, name, email FROM users ORDER BY id');\n-  res.json(rows);\n${plus(users.slice(5, 11))}\n }` },
    { filename: 'examples/review-demo/test/users.test.js', status: 'removed', additions: 0, deletions: 9 },
  ];
  const comment = () => s.comments.find((c) => c.body.startsWith(MARKER)).body;
  const run = async () => {
    await hook(h, 'pull_request', prEvent(741, 'opened'));
    await h.hub.github.queue.idle();
    return comment();
  };

  // Before the fix: no note anywhere the App looked. Never "human" without a word:
  // the lines are in a commit with no note, so they are unknown.
  let body = await run();
  assert.match(body, /None of the 28 added lines came from an AI agent run Grapim recorded\.\*\* 28 added lines are in commits with no Grapim note, so who wrote them is unknown\./);

  // The note as pushed (flat path in the notes tree): the agent's 11 lines are found.
  s.files.set(`refs/notes/grapim:${AG}`, NOTE);
  body = await run();
  assert.doesNotMatch(body, /None of the/);
  assert.match(body, /\*\*1 agent run of 1 not reviewed yet\.\*\* 39% of the added lines came from agent runs \(11 of 28\): claude&#45;code 11/, body);
  assert.match(body, /Add pagination to the users list endpoint/);
  assert.doesNotMatch(body, /unknown/, 'the workflow lines are in a noted commit: human, not unknown');
  // In git's fan-out layout (a larger notes tree) too.
  s.files.delete(`refs/notes/grapim:${AG}`);
  s.files.set(`refs/notes/grapim:${AG.slice(0, 2)}/${AG.slice(2)}`, NOTE);
  body = await run();
  assert.match(body, /\(11 of 28\)/);

  // Under require_review a pushed note adds the run to approve, but never makes
  // the commit count as recorded: anyone who can push can write one.
  gov = true;
  assert.equal((await alice.post(`/hub/teams/${A}/github/policy`, { require_review: '1' })).status, 303);
  await run();
  const c = s.checks.find((x) => x.name === 'Grapim provenance (app)');
  assert.equal(c.conclusion, 'failure');
  assert.match(c.output.summary, /\*\*claude&#45;code\*\*: 11 lines\. Not reviewed in the hub\./, c.output.summary);
  assert.match(c.output.summary, /Not recorded: 1 commit without a Grapim note in the hub/);
  assert.ok(c.output.summary.includes(`\`${AG.slice(0, 12)}\``));
});

test('cloud review: an owner turns it on in Settings, GitHub; pull request events then queue a review; members cannot', async (t) => {
  const h = await startHub({ env: { GRAPIM_REVIEW_ANTHROPIC_KEY: 'sk-test-cloud-key' }, github: { repoFor: () => null, provenanceFor: () => [], hasProvenance: () => false } });
  t.after(h.close);
  const owner = await signIn(h, 'cloud-owner');
  const T = await createTeam(owner, 'Cloudy');
  // Not linked yet: the card says so and cannot be turned on.
  let page = await owner.req(`/hub/teams/${T}/settings/github`);
  assert.match(page.text, /Cloud review/);
  assert.match(page.text, /Connect the GitHub App first/);
  assert.equal((await owner.post(`/hub/teams/${T}/github/cloud-review`, { enabled: '1' })).status, 409);
  await link(h, owner, T, 901);
  assert.equal((await hook(h, 'pull_request', prEvent(901))).body.review, undefined, 'off by default');
  // A new team's overview leads with cloud review: GitHub connected, turn it on, open a pull request.
  let ov = await owner.req(`/hub/teams/${T}`);
  assert.match(ov.text, /Connect GitHub <span class="badge badge-ok">Done<\/span>/);
  assert.match(ov.text, /Connected to <span class="strong">acme<\/span>/);
  assert.match(ov.text, /<input type="hidden" name="from" value="overview"><button class="btn btn-primary" type="submit" >Turn on<\/button>/);
  assert.match(ov.text, /about 50 pull requests/);
  assert.match(ov.text, /Or run it in your own CI/);
  const fromOverview = await owner.post(`/hub/teams/${T}/github/cloud-review`, { enabled: '1', from: 'overview' });
  assert.equal(fromOverview.location, `/hub/teams/${T}`);
  ov = await owner.req(`/hub/teams/${T}`);
  assert.match(ov.text, /Turn on cloud review <span class="badge badge-ok">Done<\/span>/);
  assert.equal((await owner.post(`/hub/teams/${T}/github/cloud-review`, { enabled: '0' })).status, 303);
  const on = await owner.post(`/hub/teams/${T}/github/cloud-review`, { enabled: '1' });
  assert.equal(on.status, 303);
  assert.match(on.location, new RegExp(`/hub/teams/${T}/settings/github#cloud-review`));
  page = await owner.req(`/hub/teams/${T}/settings/github`);
  assert.match(page.text, /Claude Opus 5\.5/);
  assert.match(page.text, /\$0\.00 of \$10\.00 credit/);
  assert.ok(!page.text.includes('sk-test-cloud-key'));
  // A member is not an owner: refused.
  const bob = await signIn(h, 'cloud-member');
  await join(owner, bob, T);
  assert.equal((await bob.post(`/hub/teams/${T}/github/cloud-review`, { enabled: '0' })).status, 403);
  // A pull request event now queues a cloud review too.
  const before = { comments: h.gh.s.comments.length, checks: h.gh.s.checks.length };
  const r = await hook(h, 'pull_request', prEvent(901));
  assert.equal(r.status, 202);
  assert.equal(r.body.review, true);
  await h.hub.github.queue.idle();
  await h.hub.github.cloud.queue.idle();
  // One voice per pull request: with cloud review on, no separate provenance comment, and no provenance check while it cannot block.
  assert.ok(!h.gh.s.comments.slice(before.comments).some((c) => c.body.startsWith('<!-- grapim:provenance')), 'no provenance comment of its own');
  assert.ok(!h.gh.s.checks.slice(before.checks).some((c) => c.name === 'Grapim provenance (app)'), 'no neutral provenance check');
  const row = h.hub.db.prepare('SELECT status FROM cloud_reviews').get();
  assert.ok(row, 'the review ran');
  assert.ok(!JSON.stringify(h.logs).includes('sk-test-cloud-key'));
  assert.equal((await owner.post(`/hub/teams/${T}/github/cloud-review`, { enabled: '0' })).status, 303);
  assert.equal(h.hub.github.cloud.enabled(T), false);
});

test('installed straight from GitHub, no team: the setup page says public repositories are reviewed free, signed in or not', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const anon = new Browser(h.base);
  const r = await anon.req('/hub/github/setup?installation_id=182&setup_action=install');
  assert.equal(r.status, 200);
  assert.match(r.text, /Grapim is installed/);
  assert.match(r.text, /public repositories are now reviewed free/);
  const bob = await signIn(h, 'oss-bob');
  const s = await bob.req('/hub/github/setup?installation_id=182&setup_action=install');
  assert.equal(s.status, 200);
  assert.match(s.text, /Connect it to a team/);
  // A state still needs a session.
  assert.match((await anon.req('/hub/github/setup?installation_id=182&state=x')).location, /^\/hub\/login/);
});
