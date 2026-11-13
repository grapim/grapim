// "No code storage" (src/hub/code-storage.js): the owner-only team setting,
// ingest dropping file contents, deleting stored contents (owner only, this
// team only), the run page without contents, the live diff from GitHub (not
// saved), and `grapim sync` no longer sending contents.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../src/hub/server.js';
import { patchHunks, runCommits } from '../src/hub/code-storage.js';
import { runHook } from '../src/hook.js';
import { Store } from '../src/store.js';
import { resolveWorkspace } from '../src/workspace.js';
import { syncOnce } from '../src/sync.js';

const ORIGIN = 'http://localhost:7999';
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });

// A fake GitHub API: installation tokens and one commit's files.
function fakeGitHubApi() {
  const s = { requests: [], commits: new Map() };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    s.requests.push(`${req.method} ${url.pathname}`);
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) return send(201, { token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    if (req.headers.authorization !== 'Bearer ghs_test') return send(401, { message: 'bad token' });
    const m = /^\/repos\/acme\/api\/commits\/([0-9a-f]{40})$/.exec(url.pathname);
    if (m && s.commits.has(m[1])) return send(200, { sha: m[1], files: s.commits.get(m[1]) });
    send(404, { message: 'Not Found' });
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

async function startHub({ app = false } = {}) {
  const oauth = fakeOAuth();
  const gh = app ? await fakeGitHubApi() : null;
  const hub = await createHub({
    env: {
      HUB_URL: ORIGIN,
      HUB_SECRET: 'test-secret-that-is-long-enough-0123456789',
      HUB_DATA: tmp('grapim-cs-'),
      GITHUB_CLIENT_ID: 'gh-client',
      GITHUB_CLIENT_SECRET: 'gh-secret',
      ...(app ? { GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: Buffer.from(PEM).toString('base64'), GITHUB_APP_WEBHOOK_SECRET: 'whsec-test-0123456789abcdef', GITHUB_APP_SLUG: 'grapim-test' } : {}),
    },
    fetch: oauth.fetch,
    billing: null,
    log: () => {},
    ...(app ? { github: { fetch: globalThis.fetch, apiBase: gh.base, sleep: async () => {}, historyBoot: false } } : {}),
    platform: { worker: false },
  });
  const addr = await hub.listen(0, '127.0.0.1');
  return { hub, gh, oauth, base: `http://127.0.0.1:${addr.port}`, close: async () => { await hub.close(); await gh?.close(); } };
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
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text, json: () => JSON.parse(text) };
  }
  async post(p, form = {}) {
    const me = JSON.parse((await this.req('/hub/api/me')).text);
    return this.req(p, { method: 'POST', form: { _csrf: me.csrf, ...form } });
  }
}

let nextUser = 31000;
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
  assert.equal(r.status, 303, r.text);
  return r.location.match(/\/hub\/teams\/([^/?#]+)/)[1];
}

async function createToken(b, team, name = 'laptop') {
  const r = await b.post(`/hub/teams/${team}/tokens`, { name });
  assert.equal(r.status, 200, r.text);
  return r.text.match(/value="(cmh_[A-Za-z0-9_-]+)"/)[1];
}

async function join(owner, member, team) {
  const r = await owner.post(`/hub/teams/${team}/invites`);
  const token = r.text.match(/\/hub\/invite\/([A-Za-z0-9_-]+)/)[1];
  assert.equal((await member.post('/hub/invite/accept', { token })).status, 303);
}

const RUN = 'claude-code:5e5e5e5e-0000';
const REPO_ID = sha1('root commit of api');
const COMMIT = sha1('commit with the run');
const SECRET_LINE = 'const apiKey = loadFromVault("billing-7f3a");';

function batch({ github = null, provenance = undefined } = {}) {
  const before = Buffer.from('a\nb\nc\n');
  const after = Buffer.from(`a\nB\nc\n${SECRET_LINE}\n`);
  return {
    repo: { id: REPO_ID, name: 'api', ...(github ? { github } : {}) },
    machine: 'alex-mbp',
    cursor: { changes: 0, events: 0, agents: 0 },
    runs: [{ run: RUN, turn: 1, started_at: 1000 }],
    agents: [{ agent: RUN, label: 'claude 5e5e5e5e', intent: 'Load the key from the vault', worktree: 'api', last_seen: Date.now() }],
    changes: [{ id: 1, run: RUN, label: 'claude 5e5e5e5e', turn: 1, worktree: 'api', path: 'src/app.js', before_sha: sha1(before), after_sha: sha1(after), untracked: false, added: 2, removed: 1, ts: Date.now() }],
    events: [{ id: 1, ts: Date.now() - 10, agent: RUN, kind: 'intent', path: null, detail: 'Load the key from the vault' }],
    blobs: { [sha1(before)]: before.toString('base64'), [sha1(after)]: after.toString('base64') },
    ...(provenance ? { provenance } : {}),
  };
}

const sync = (h, token, body) =>
  fetch(`${h.base}/hub/api/sync`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const blobsOf = (h, team) => h.hub.db.prepare('SELECT COUNT(*) AS n FROM h_blobs WHERE team_id = ?').get(team).n;
const usageOf = (h, team) => h.hub.db.prepare('SELECT bytes FROM team_usage WHERE team_id = ?').get(team)?.bytes ?? 0;

// Every value in every table, as one string: to check what the hub kept.
function dump(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all(), (k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v))).join('\n');
}

test('metadata mode: ingest keeps hashes and metadata, never file contents, and says the mode', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'cs-alice');
  const A = await createTeam(alice, 'Alpha');
  const tokenA = await createToken(alice, A);

  // Off by default: the card says so, and contents are kept.
  const settings = await alice.req(`/hub/teams/${A}/settings/data`);
  assert.match(settings.text, /id="code-storage"/);
  assert.match(settings.text, /never the code itself/);
  assert.doesNotMatch(settings.text, /style="|<script>/);

  const on = await alice.post(`/hub/teams/${A}/code-storage`, { mode: 'metadata' });
  assert.equal(on.status, 303, on.text);
  assert.match(on.location, /\/settings\/data\?done=code_storage_on$/);
  assert.equal(h.hub.db.prepare('SELECT code_storage FROM teams WHERE id = ?').get(A).code_storage, 'metadata');

  // An older client still sends contents: accepted, contents dropped.
  const r = await sync(h, tokenA, batch());
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.code_storage, 'metadata');
  assert.equal(body.stored.blobs, 0);
  assert.equal(body.stored.changes, 1);
  assert.equal(blobsOf(h, A), 0);
  const change = h.hub.db.prepare('SELECT before_sha, after_sha, added, removed FROM h_changes WHERE team_id = ?').get(A);
  assert.equal(change.after_sha.length, 40, 'the hash is kept');
  assert.equal(change.added, 2);
  assert.doesNotMatch(dump(h.hub.db), /loadFromVault/, 'the content is nowhere in the hub database');
  // The dropped contents do not count toward storage.
  assert.ok(usageOf(h, A) < 2000);

  // A team in the default mode keeps contents, and says so.
  const bob = await signIn(h, 'cs-bob');
  const B = await createTeam(bob, 'Beta');
  const rb = await (await sync(h, await createToken(bob, B), batch())).json();
  assert.equal(rb.code_storage, 'full');
  assert.equal(rb.stored.blobs, 2);
  assert.equal(blobsOf(h, B), 2);
});

test('delete stored contents: owner only, needs the mode on and a confirmation, and touches only this team', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const owner = await signIn(h, 'del-owner');
  const member = await signIn(h, 'del-member');
  const other = await signIn(h, 'del-other');
  const A = await createTeam(owner, 'Alpha');
  await join(owner, member, A);
  const B = await createTeam(other, 'Beta');
  await sync(h, await createToken(owner, A), batch());
  await sync(h, await createToken(other, B), batch());
  assert.equal(blobsOf(h, A), 2);
  assert.equal(blobsOf(h, B), 2);
  const usedB = usageOf(h, B);

  // A member sees the setting but cannot change it or delete anything.
  const page = await member.req(`/hub/teams/${A}/settings/data`);
  assert.match(page.text, /id="code-storage"/);
  assert.match(page.text, /Only an owner can change this/);
  assert.doesNotMatch(page.text, /code-storage\/delete|name="mode"/);
  assert.equal((await member.post(`/hub/teams/${A}/code-storage`, { mode: 'metadata' })).status, 403);
  assert.equal((await member.post(`/hub/teams/${A}/code-storage/delete`, { confirm: 'delete' })).status, 403);

  // Another team's owner: not found, and nothing changes.
  assert.equal((await other.post(`/hub/teams/${A}/code-storage`, { mode: 'metadata' })).status, 404);
  assert.equal((await other.post(`/hub/teams/${A}/code-storage/delete`, { confirm: 'delete' })).status, 404);
  assert.equal(h.hub.db.prepare('SELECT code_storage FROM teams WHERE id = ?').get(A).code_storage, 'full');
  assert.equal(blobsOf(h, A), 2);

  // Deleting needs the mode on first, then the confirmation box.
  const early = await owner.post(`/hub/teams/${A}/code-storage/delete`, { confirm: 'delete' });
  assert.equal(early.status, 409);
  assert.match(early.text, /Turn on No code storage first/);
  assert.equal((await owner.post(`/hub/teams/${A}/code-storage`, { mode: 'nonsense' })).status, 400);
  assert.equal((await owner.post(`/hub/teams/${A}/code-storage`, { mode: 'metadata' })).status, 303);
  const card = await owner.req(`/hub/teams/${A}/settings/data`);
  assert.match(card.text, /action="\/hub\/teams\/[^"]+\/code-storage\/delete"/);
  assert.match(card.text, /name="confirm" value="delete" required/);
  assert.match(card.text, /2 file versions/);
  assert.doesNotMatch(card.text, /data-confirm="[^"]*stored file contents/, 'a form step, not a JS dialog');
  const unconfirmed = await owner.post(`/hub/teams/${A}/code-storage/delete`);
  assert.equal(unconfirmed.status, 400);
  assert.equal(blobsOf(h, A), 2);

  const before = usageOf(h, A);
  const done = await owner.post(`/hub/teams/${A}/code-storage/delete`, { confirm: 'delete' });
  assert.equal(done.status, 303, done.text);
  assert.match(done.location, /\/settings\/data\?done=contents_deleted$/);
  assert.equal(blobsOf(h, A), 0);
  assert.ok(usageOf(h, A) < before, 'the deleted bytes leave the storage count');
  assert.equal(blobsOf(h, B), 2, "another team's contents are untouched");
  assert.equal(usageOf(h, B), usedB);
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM h_changes WHERE team_id = ?').get(A).n, 1, 'run metadata stays');
  assert.match((await owner.req(`/hub/teams/${A}/settings/data?done=contents_deleted`)).text, /Grapim holds no code for this team/);

  // Turning it off again works, and new syncs keep contents again.
  assert.match((await owner.post(`/hub/teams/${A}/code-storage`, { mode: 'full' })).location, /done=code_storage_off/);
});

test('the run page and the run API without contents: a clear state, no crash', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'view-alice');
  const A = await createTeam(alice, 'Alpha');
  await alice.post(`/hub/teams/${A}/code-storage`, { mode: 'metadata' });
  assert.equal((await sync(h, await createToken(alice, A), batch())).status, 200);

  const repo = await alice.req(`/hub/teams/${A}/repos/${REPO_ID}`);
  assert.equal(repo.status, 200);
  assert.match(repo.text, /Load the key from the vault/);

  const page = await alice.req(`/hub/teams/${A}/repos/${REPO_ID}/runs/${encodeURIComponent(RUN)}?machine=alex-mbp`);
  assert.equal(page.status, 200, page.text);
  assert.match(page.text, /The code stays on the developer’s computer/);
  assert.match(page.text, /<code>grapim serve<\/code> on alex-mbp/);
  assert.match(page.text, /src\/app\.js/);
  assert.doesNotMatch(page.text, /Binary or large/);
  assert.doesNotMatch(page.text, /style="|<script>/);

  const api = await alice.req(`/hub/api/teams/${A}/repos/${REPO_ID}/runs/${encodeURIComponent(RUN)}`);
  assert.equal(api.status, 200);
  const f = api.json().files[0];
  assert.equal(f.content, 'not_stored');
  assert.equal(f.diff, null);
  assert.equal(f.added, 2);
});

test('live diff: read from GitHub for the run\'s commits with the installation token, shown, and never saved', async (t) => {
  const h = await startHub({ app: true });
  t.after(h.close);
  const alice = await signIn(h, 'live-alice');
  const A = await createTeam(alice, 'Alpha');
  await alice.post(`/hub/teams/${A}/code-storage`, { mode: 'metadata' });
  const note = JSON.stringify({ v: 1, tool: 'grapim/0.1.0', runs: [{ id: RUN, label: 'claude 5e5e5e5e', kind: 'claude-code', turns: [{ turn: 1, intent: 'Load the key' }], review: 'pending' }], files: { 'src/app.js': [[2, 4, 0, 1]] } });
  const r = await sync(h, await createToken(alice, A), batch({ github: 'github.com/acme/api', provenance: [{ commit: COMMIT, note }] }));
  assert.equal(r.status, 200, await r.clone().text());

  const runPath = `/hub/teams/${A}/repos/${REPO_ID}/runs/${encodeURIComponent(RUN)}?machine=alex-mbp`;
  // Not linked to the App yet: the local-only state, and GitHub is not called.
  assert.match((await alice.req(runPath)).text, /The code stays on the developer/);
  assert.equal(h.gh.s.requests.filter((x) => x.includes('/commits/')).length, 0);

  // Link an installation that can read acme/api (as the App's link flow would).
  const t0 = Date.now();
  h.hub.db.prepare("INSERT INTO gh_installations (id, account_id, account_login, account_type, team_id, linked_by, linked_at, created_at, updated_at) VALUES (77, 555, 'acme', 'Organization', ?, ?, ?, ?, ?)").run(A, alice.user.id, t0, t0, t0);
  h.hub.db.prepare("INSERT INTO gh_installation_repos (installation_id, repo_id, full_name) VALUES (77, 1, 'acme/api')").run();
  h.gh.s.commits.set(COMMIT, [
    { filename: 'src/app.js', patch: `@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+${SECRET_LINE}` },
    { filename: 'README.md', patch: '@@ -1 +1 @@\n-x\n+not this run' },
  ]);
  const page = await alice.req(runPath);
  assert.equal(page.status, 200, page.text);
  assert.match(page.text, /loadFromVault/, 'the diff from GitHub is shown');
  assert.match(page.text, new RegExp(`From commit <code>${COMMIT.slice(0, 7)}</code>, loaded from GitHub just for this page`));
  assert.doesNotMatch(page.text, /not this run/, 'only the run\'s files');
  assert.doesNotMatch(page.text, /The code stays on the developer/);
  assert.ok(h.gh.s.requests.includes(`GET /repos/acme/api/commits/${COMMIT}`));
  assert.ok(h.gh.s.requests.some((x) => x === 'POST /app/installations/77/access_tokens'));
  assert.doesNotMatch(dump(h.hub.db), /loadFromVault/, 'nothing of the diff is stored');
  assert.equal(blobsOf(h, A), 0);

  // Another team cannot reach the run, and so never triggers the fetch.
  const mallory = await signIn(h, 'live-mallory');
  await createTeam(mallory, 'Mallory');
  assert.equal((await mallory.req(runPath)).status, 404);

  // GitHub failing: the page falls back, no crash.
  h.gh.s.commits.clear();
  const down = await alice.req(runPath);
  assert.equal(down.status, 200);
  assert.match(down.text, /The code stays on the developer/);
});

test('patchHunks and runCommits: GitHub patches as hub hunks; only commits whose note names the run', () => {
  const hunks = patchHunks('@@ -1,3 +1,4 @@ fn\n a\n-b\n+B\n c\n+d\n\\ No newline at end of file\n@@ -10 +11 @@\n-x\n+y');
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0], { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [{ t: ' ', s: 'a' }, { t: '-', s: 'b' }, { t: '+', s: 'B' }, { t: ' ', s: 'c' }, { t: '+', s: 'd' }] });
  assert.deepEqual(hunks[1], { oldStart: 10, oldLines: 1, newStart: 11, newLines: 1, lines: [{ t: '-', s: 'x' }, { t: '+', s: 'y' }] });
  assert.deepEqual(patchHunks(undefined), []);

  const rows = [];
  const db = { prepare: () => ({ all: (team, repo, needle) => (team === 'T' ? rows.filter((r) => r.note_json.includes(needle)) : []) }) };
  const n = (runs, files) => JSON.stringify({ v: 1, runs, files });
  rows.push({ commit_sha: COMMIT, note_json: n([{ id: 'other', kind: 'mcp', turns: [], review: 'pending' }, { id: RUN, kind: 'claude-code', turns: [], review: 'pending' }], { 'a.js': [[1, 2, 1, 1]], 'b.js': [[1, 1, 0, 1]] }) });
  rows.push({ commit_sha: sha1('x'), note_json: n([{ id: `${RUN}-not`, kind: 'claude-code', turns: [], review: 'pending' }], { 'c.js': [[1, 1, 0, 1]] }) });
  const out = runCommits(db, 'T', REPO_ID, RUN);
  assert.equal(out.length, 1);
  assert.deepEqual([...out[0].paths], ['a.js']);
  assert.deepEqual(runCommits(db, 'other-team', REPO_ID, RUN), []);
});

// ---------------------------------------------------------------- the CLI

function gitRepo() {
  const root = tmp('grapim-cs-repo-');
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'routes.js'), 'export const routes = [];\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return root;
}

function edit(root, session, name, text) {
  const env = { ...process.env };
  delete env.GRAPIM_STATE_DIR;
  const hook = (input) => runHook({ session_id: session, cwd: root, ...input }, env);
  const file = path.join(root, 'src', name);
  const e = { tool_name: 'Write', tool_input: { file_path: file }, tool_use_id: `tu-${name}` };
  hook({ hook_event_name: 'PreToolUse', ...e });
  fs.writeFileSync(file, text);
  hook({ hook_event_name: 'PostToolUse', ...e });
}

test('grapim sync learns the mode before sending anything, sends no contents when it is on, and sends them again when it is off', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'cli-alice');
  const A = await createTeam(alice, 'Alpha');
  const token = await createToken(alice, A);
  await alice.post(`/hub/teams/${A}/code-storage`, { mode: 'metadata' });

  const root = gitRepo();
  const session = 'c5c5c5c5-1111-2222-3333-444455556666';
  edit(root, session, 'billing.js', 'export const SECRET_TOKEN_NAME = "billing";\n');
  const ws = resolveWorkspace(root);
  const store = new Store(ws.stateDir);
  t.after(() => store.close());
  const sent = [];
  const spy = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return globalThis.fetch(url, init);
  };

  const first = await syncOnce({ ws, store, hubUrl: h.base, token, machine: 'box', fetch: spy });
  assert.equal(first.code_storage, 'metadata');
  assert.equal(first.changes, 1);
  assert.equal(first.blobs, 0);
  assert.equal(sent[0].changes.length, 0, 'the first request only asks for the mode');
  assert.ok(sent.every((b) => Object.keys(b.blobs ?? {}).length === 0), 'no request carried file contents');
  assert.equal(blobsOf(h, A), 0);
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM h_changes WHERE team_id = ?').get(A).n, 1);

  // The mode is remembered: no extra request on the next sync.
  sent.length = 0;
  edit(root, session, 'more.js', 'export const x = 1;\n');
  await syncOnce({ ws, store, hubUrl: h.base, token, machine: 'box', fetch: spy });
  assert.equal(sent.length, 1);
  assert.equal(Object.keys(sent[0].blobs).length, 0);

  // Turned off: the batch sent without contents is sent again with them.
  await alice.post(`/hub/teams/${A}/code-storage`, { mode: 'full' });
  sent.length = 0;
  edit(root, session, 'third.js', 'export const y = 2;\n');
  const back = await syncOnce({ ws, store, hubUrl: h.base, token, machine: 'box', fetch: spy });
  assert.equal(back.code_storage, 'full');
  assert.equal(sent.length, 2);
  assert.equal(Object.keys(sent[0].blobs).length, 0);
  assert.ok(Object.keys(sent[1].blobs).length >= 1);
  assert.equal(back.changes, 1, 'the resent batch is counted once');
  assert.ok(blobsOf(h, A) >= 1);
});
