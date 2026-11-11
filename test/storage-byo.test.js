// A team's own bucket (docs/storage.md, src/hub/team-storage.js): the
// settings card, the probe, credentials sealed at rest and bound to the team
// and column, the move (resumable, idempotent, dual writes, read fallback,
// switch only when complete), owner-only and IDOR, SSRF on the endpoint, and
// PUT /v1/settings { storage } (live keys only). An in-process hub with GitHub
// mocked, an injected DNS resolver, and fake S3 / GCS / Azure servers that
// verify signatures (test/fake-clouds.js), reached through the team storage
// transport hook instead of the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../src/hub/server.js';
import { makeSafeFetch } from '../src/hub/team-storage.js';
import { startFakeAzure, startFakeS3, transportTo } from './fake-clouds.js';

const ORIGIN = 'http://localhost:7999';
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S3 = { accessKeyId: 'AKIABYOTESTKEY0001', secretAccessKey: 'byo/s3+secret-NEVER-SHOWN-0001', region: 'eu-west-1' };
const GCS = { accessKeyId: 'GOOG1EBYOHMACKEY0002', secretAccessKey: 'byo/gcs+secret-NEVER-SHOWN-0002', region: 'auto' };
const AZ_KEY = crypto.randomBytes(64).toString('base64');
const S3_HOST = 's3.fake-cloud.example';

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

// The hub's own store, in memory, counting writes.
function memStore() {
  const map = new Map();
  const puts = new Map();
  return {
    map,
    puts,
    put: async (k, buf) => {
      map.set(k, Buffer.from(buf));
      puts.set(k, (puts.get(k) ?? 0) + 1);
    },
    get: async (k) => map.get(k) ?? null,
    has: async (k) => map.has(k),
    delete: async (k) => void map.delete(k),
    list: async (prefix = '') => [...map.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
}

// The clouds, shared by every test (each test uses its own team, so its own keys).
let clouds = null;
async function getClouds() {
  if (clouds) return clouds;
  const s3 = await startFakeS3({ bucket: 'acme-grapim', creds: S3 });
  const gcs = await startFakeS3({ bucket: 'acme-gcs', creds: GCS, gcs: true });
  const azure = await startFakeAzure({ account: 'acmeblob', container: 'grapim', key: AZ_KEY });
  clouds = { s3, gcs, azure, hosts: { [S3_HOST]: s3, 'storage.googleapis.com': gcs, 'acmeblob.blob.core.windows.net': azure } };
  return clouds;
}
test.after(async () => {
  if (clouds) await Promise.all([clouds.s3.close(), clouds.gcs.close(), clouds.azure.close()]);
});

async function startHub({ dir = tmp('grapim-byo-'), store = memStore(), onCopied = null, gh = fakeGitHub(), dns = fakeDns() } = {}) {
  const c = await getClouds();
  const logs = [];
  const calls = [];
  const hub = await createHub({
    env: {
      HUB_URL: ORIGIN,
      HUB_SECRET: 'test-secret-that-is-long-enough-0123456789',
      HUB_DATA: dir,
      GITHUB_CLIENT_ID: 'gh-client',
      GITHUB_CLIENT_SECRET: 'gh-secret',
    },
    fetch: gh.fetch,
    billing: null,
    storage: store,
    log: (l) => logs.push(l),
    platform: { resolve: dns.resolve, worker: false },
    teamStorage: {
      transport: transportTo(c.hosts, calls),
      storageOpts: { retry: { retries: 1, baseDelayMs: 1, maxDelayMs: 2 }, timeoutMs: 3000 },
      onCopied,
    },
  });
  const addr = await hub.listen(0, '127.0.0.1');
  return { hub, base: `http://127.0.0.1:${addr.port}`, gh, dns, logs, calls, dir, store, clouds: c, close: () => hub.close() };
}

class Browser {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }
  async req(p, { method = 'GET', form = null, headers = {} } = {}) {
    const h = { ...headers };
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
      if (/Max-Age=0/i.test(c)) this.jar.delete(pair.slice(0, i));
      else this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return { status: res.status, headers: res.headers, text: await res.text() };
  }
  async post(p, form = {}) {
    const csrf = JSON.parse((await this.req('/hub/api/me')).text).csrf;
    return this.req(p, { method: 'POST', form: { _csrf: csrf, ...form } });
  }
}

let nextId = 31000;
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
  return r.headers.get('location').match(/\/hub\/teams\/([^/]+)\/settings/)[1];
}

async function createWorkspace(b, team, name) {
  const r = await b.post(`/hub/teams/${team}/workspaces`, { name });
  assert.equal(r.status, 303, r.text);
  const id = r.headers.get('location').match(/\/workspaces\/([^/]+)$/)[1];
  return { id, name, team, base: `/w/${team}/${name}/` };
}

async function createWsToken(b, ws, name) {
  const r = await b.post(`/hub/teams/${ws.team}/workspaces/${ws.id}/tokens`, { name, scope: 'write' });
  assert.equal(r.status, 200, r.text);
  return r.text.match(/value="(gws_[A-Za-z0-9_-]+)"/)[1];
}

async function putFile(h, token, ws, rel, body) {
  const res = await fetch(`${h.base}${ws.base}fs/${rel}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'X-Grapim-Agent': 'a' }, body });
  assert.equal(res.status, 200, await res.text());
}

const s3Form = (prefix, extra = {}) => ({
  provider: 's3', bucket: 'acme-grapim', prefix, endpoint: `https://${S3_HOST}`, region: 'eu-west-1',
  access_key_id: S3.accessKeyId, secret_access_key: S3.secretAccessKey, ...extra,
});

// Blobs and manifests a team already has in the hub's store.
async function seed(store, team, n = 6, ws = 'wsseed01') {
  const keys = [];
  for (let i = 0; i < n; i++) {
    const buf = Buffer.from(`seeded file ${i} of ${team}`);
    const k = `ws/${team}/${ws}/blobs/${sha1(buf)}`;
    await store.put(k, buf);
    keys.push(k);
  }
  const m = `ws/${team}/${ws}/manifest.json`;
  await store.put(m, Buffer.from(JSON.stringify({ version: 1, head: null, files: {}, written_at: new Date().toISOString() })));
  keys.push(m);
  return keys.sort();
}

const inBucket = (fake, prefix, key) => fake.objects.get(`${prefix}/${key}`);
const probeKeys = (fake) => [...fake.objects.keys()].filter((k) => k.includes('grapim-probe/'));

async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await sleep(10);
  }
  assert.fail('timed out waiting');
}

function assertNoSecrets(text, what) {
  for (const s of [S3.secretAccessKey, S3.accessKeyId, GCS.secretAccessKey, GCS.accessKeyId, AZ_KEY]) assert.ok(!String(text).includes(s), `${what} must not contain a credential`);
}

// ---------------------------------------------------------------- the flow

test('an owner brings an S3 bucket: probe, copy, switch; later writes and restores use it; secrets never shown, logged or stored in clear', async (t) => {
  const store = memStore();
  const dir = tmp('grapim-byo-flow-');
  const gh = fakeGitHub();
  let h = await startHub({ dir, store, gh });
  t.after(() => h.close());
  const { s3 } = h.clouds;
  const alice = await signIn(h, 'byo-alice');
  const team = await createTeam(alice, 'Acme');
  const ws = await createWorkspace(alice, team, 'docs');
  const token = await createWsToken(alice, ws, 'w');
  await putFile(h, token, ws, 'a.md', '# A\n');
  await h.hub.mount.storage.flush();
  const wsKey = `ws/${team}/${ws.id}`;
  assert.ok(store.map.has(`${wsKey}/blobs/${sha1('# A\n')}`));

  let page = await alice.req(`/hub/teams/${team}/settings`);
  assert.match(page.text, /id="storage"/);
  assert.match(page.text, /In use: the hub&#39;s own storage|In use: the hub's own storage/);

  const before = s3.requests.length;
  const r = await alice.post(`/hub/teams/${team}/storage`, s3Form('flow'));
  assert.equal(r.status, 303, r.text);
  assert.equal(r.headers.get('location'), `/hub/teams/${team}/settings#storage`);
  // The probe: put, get, list, delete of one random key, then gone.
  const probe = s3.requests.slice(before).filter((q) => q.url.includes('grapim-probe'));
  assert.deepEqual(probe.map((q) => q.method), ['PUT', 'GET', 'GET', 'DELETE', 'HEAD']);
  assert.deepEqual(probeKeys(s3), [], 'the probe key is deleted');

  await h.hub.teamStorage.job(team);
  const st = h.hub.teamStorage.status(team);
  assert.equal(st.provider, 's3');
  assert.equal(st.move, null);
  assert.equal(h.hub.db.prepare('SELECT storage_url FROM teams WHERE id = ?').get(team).storage_url, `s3://acme-grapim/flow?endpoint=${encodeURIComponent(`https://${S3_HOST}`)}&region=eu-west-1`);
  assert.deepEqual(inBucket(s3, 'flow', `${wsKey}/blobs/${sha1('# A\n')}`)?.toString(), '# A\n');
  assert.ok(inBucket(s3, 'flow', `${wsKey}/manifest.json`), 'the manifest was copied');
  assert.equal(s3.signatureFailures, 0);

  // From now on, new versions go to the bucket only.
  await putFile(h, token, ws, 'b.md', '# B\n');
  await h.hub.mount.storage.flush();
  assert.ok(inBucket(s3, 'flow', `${wsKey}/blobs/${sha1('# B\n')}`));
  assert.ok(!store.map.has(`${wsKey}/blobs/${sha1('# B\n')}`), 'not in the hub store');

  // The card shows where, never the keys.
  page = await alice.req(`/hub/teams/${team}/settings`);
  assert.match(page.text, /acme-grapim/);
  assert.match(page.text, /Credentials saved/);
  assertNoSecrets(page.text, 'the settings page');
  assert.ok(!/type="password"[^>]*value="[^"]+"/.test(page.text), 'secret fields are always empty');

  // At rest: sealed, bound; the database file never holds them in clear.
  const row = h.hub.db.prepare('SELECT * FROM team_storage WHERE team_id = ?').get(team);
  assert.match(row.credentials, /^v2\./);
  assertNoSecrets(JSON.stringify(row), 'the row');
  assertNoSecrets(h.logs.join('\n'), 'the logs');
  await h.close();
  for (const f of fs.readdirSync(dir).filter((n) => n.startsWith('hub.db'))) assertNoSecrets(fs.readFileSync(path.join(dir, f)).toString('latin1'), f);

  // The volume loses the folder: it comes back from the team's bucket.
  fs.rmSync(path.join(dir, 'workspaces', team, ws.id), { recursive: true, force: true });
  h = await startHub({ dir, store, gh });
  await h.hub.restored;
  assert.equal(fs.readFileSync(path.join(dir, 'workspaces', team, ws.id, 'b.md'), 'utf8'), '# B\n');
});

test('GCS and Azure buckets through the card: signed requests, probe, move', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { gcs, azure } = h.clouds;
  const alice = await signIn(h, 'byo-multi');
  const g = await createTeam(alice, 'GCS team');
  const keysG = await seed(h.store, g, 3);
  let r = await alice.post(`/hub/teams/${g}/storage`, { provider: 'gcs', bucket: 'acme-gcs', prefix: 'gt', access_key_id: GCS.accessKeyId, secret_access_key: GCS.secretAccessKey });
  assert.equal(r.status, 303, r.text);
  await h.hub.teamStorage.job(g);
  assert.equal(h.hub.teamStorage.status(g).provider, 'gcs');
  for (const k of keysG) assert.ok(gcs.objects.has(`gt/${k}`), k);
  assert.ok(gcs.requests.every((q) => /^\/acme-gcs(\/|\?)/.test(q.url) && !('x-amz-security-token' in q.headers)));
  assert.equal(gcs.signatureFailures, 0);
  assert.deepEqual(probeKeys(gcs), []);

  const a = await createTeam(alice, 'Azure team');
  const keysA = await seed(h.store, a, 3);
  r = await alice.post(`/hub/teams/${a}/storage`, { provider: 'azure', account: 'acmeblob', bucket: 'grapim', prefix: 'at', account_key: AZ_KEY });
  assert.equal(r.status, 303, r.text);
  await h.hub.teamStorage.job(a);
  assert.equal(h.hub.teamStorage.status(a).provider, 'azure');
  for (const k of keysA) assert.ok(azure.blobs.has(`at/${k}`), k);
  assert.equal(azure.signatureFailures, 0);
  assert.deepEqual([...azure.blobs.keys()].filter((k) => k.includes('grapim-probe/')), []);
  assertNoSecrets(h.logs.join('\n'), 'the logs');
  assertNoSecrets((await alice.req(`/hub/teams/${a}/settings`)).text, 'the settings page');
});

// ---------------------------------------------------------- encryption

test('credentials are sealed to the team and the column: a ciphertext swapped between teams or columns does not open', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'byo-seal');
  const A = await createTeam(alice, 'Sealed A');
  const B = await createTeam(alice, 'Sealed B');
  for (const [team, prefix] of [[A, 'seal-a'], [B, 'seal-b']]) {
    const r = await alice.post(`/hub/teams/${team}/storage`, s3Form(prefix));
    assert.equal(r.status, 303, r.text);
    await h.hub.teamStorage.job(team);
  }
  const db = h.hub.db;
  const ts = h.hub.teamStorage;
  const rowA = db.prepare('SELECT * FROM team_storage WHERE team_id = ?').get(A);
  const rowB = db.prepare('SELECT * FROM team_storage WHERE team_id = ?').get(B);
  assert.notEqual(rowA.credentials, rowB.credentials, 'a fresh IV each time');
  assert.equal(ts.status(A).credentials_ok, true);

  // Team A's sealed credentials copied into team B's row.
  db.prepare('UPDATE team_storage SET credentials = ? WHERE team_id = ?').run(rowA.credentials, B);
  const fresh = await startHub({ dir: h.dir, store: h.store });
  t.after(fresh.close);
  assert.equal(fresh.hub.teamStorage.status(B).credentials_ok, false);
  assert.equal(fresh.hub.teamStorage.status(A).credentials_ok, true);
  assert.throws(() => fresh.hub.teamStorage.storeOf(B, 'active'), { code: 'credentials_unreadable' });
  await assert.rejects(() => fresh.hub.teamStorage.router.put(`ws/${B}/wsx00001/blobs/${sha1('x')}`, Buffer.from('x')), { code: 'credentials_unreadable' });
  const page = await (async () => {
    const b = await signIn(fresh, 'byo-seal-2');
    db.prepare("INSERT INTO members (team_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(B, b.user.id, Date.now());
    return b.req(`/hub/teams/${B}/settings`);
  })();
  assert.match(page.text, /cannot be read any more/);

  // The same team, the other column: bound to the column too.
  db.prepare("UPDATE team_storage SET move_state = 'failed', move_config = config, move_credentials = credentials WHERE team_id = ?").run(A);
  const third = await startHub({ dir: h.dir, store: h.store });
  t.after(third.close);
  assert.throws(() => third.hub.teamStorage.storeOf(A, 'move'), { code: 'credentials_unreadable' });
  assert.ok(third.hub.teamStorage.storeOf(A, 'active'), 'the right column still opens');
});

// ---------------------------------------------------------------- probe

test('the probe: a refused write, read or delete is a clear error, nothing is saved, and the probe key is cleaned up', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { s3 } = h.clouds;
  const alice = await signIn(h, 'byo-probe');
  const team = await createTeam(alice, 'Probe');

  // A wrong secret: the bucket refuses the signature.
  let r = await alice.post(`/hub/teams/${team}/storage`, s3Form('probe', { secret_access_key: 'wrong-secret-WRONG-0001' }));
  s3.signatureFailures = 0;
  assert.equal(r.status, 400);
  assert.match(r.text, /Grapim could not use this bucket: writing a test object failed: S3 PutObject &quot;grapim-probe\/[0-9a-f]{32}&quot; failed: HTTP 403 SignatureDoesNotMatch\. Nothing was saved\./);
  assert.ok(!r.text.includes('wrong-secret-WRONG-0001'));
  assert.match(r.text, /value="acme-grapim"/, 'what was typed is kept, except the secrets');
  assertNoSecrets(r.text, 'the error page');
  assert.equal(h.hub.teamStorage.status(team).provider, 'hub');
  assert.equal(h.hub.teamStorage.status(team).move, null);

  // Reading back fails: the key written is deleted anyway.
  s3.failWhen = (req) => (req.method === 'GET' && req.url.includes('grapim-probe/') ? 403 : null);
  r = await alice.post(`/hub/teams/${team}/storage`, s3Form('probe'));
  s3.failWhen = null;
  assert.equal(r.status, 400);
  assert.match(r.text, /reading the test object back failed: S3 GetObject .* HTTP 403 AccessDenied/);
  assert.deepEqual(probeKeys(s3), [], 'cleaned up');

  // Listing is refused (the migration needs it to move back).
  s3.failWhen = (req) => (req.method === 'GET' && req.url.includes('list-type=2') ? 403 : null);
  r = await alice.post(`/hub/teams/${team}/storage`, s3Form('probe'));
  s3.failWhen = null;
  assert.equal(r.status, 400);
  assert.match(r.text, /listing the test object failed/);
  assert.deepEqual(probeKeys(s3), [], 'cleaned up');

  // No delete permission: said so (the key cannot be removed by Grapim then).
  s3.failWhen = (req) => (req.method === 'DELETE' && req.url.includes('grapim-probe/') ? 403 : null);
  r = await alice.post(`/hub/teams/${team}/storage`, s3Form('probe'));
  s3.failWhen = null;
  assert.equal(r.status, 400);
  assert.match(r.text, /deleting the test object failed/);
  for (const k of probeKeys(s3)) s3.objects.delete(k);

  // Shape errors never reach the network.
  const calls = h.calls.length;
  for (const [form, re] of [
    [{ ...s3Form('p'), provider: 'ftp' }, /provider is one of/],
    [{ ...s3Form('p'), bucket: 'Bad_Bucket!' }, /bucket is the bucket name/],
    [{ ...s3Form('p'), prefix: 'a/../b' }, /prefix is up to 200/],
    [{ ...s3Form('p'), secret_access_key: '' }, /are required/],
    [{ provider: 'r2', bucket: 'b-1', access_key_id: 'a', secret_access_key: 'b' }, /endpoint is required for R2/],
    [{ provider: 'azure', account: 'acmeblob', bucket: 'grapim', account_key: 'short' }, /account_key is the base64 key/],
  ]) {
    r = await alice.post(`/hub/teams/${team}/storage`, form);
    assert.equal(r.status, 400, JSON.stringify(form));
    assert.match(r.text, re);
  }
  assert.equal(h.calls.length, calls);
  assert.equal(h.hub.teamStorage.status(team).provider, 'hub');
});

// ------------------------------------------------------------- the move

test('the move is resumable after a crash, and idempotent: every object is copied once, back and forth', async (t) => {
  const store = memStore();
  const dir = tmp('grapim-byo-crash-');
  const gh = fakeGitHub();
  let n = 0;
  // The 4th copy never returns: the process "dies" there.
  const crash = async () => {
    if (++n === 4) await new Promise(() => {});
  };
  const h1 = await startHub({ dir, store, gh, onCopied: crash });
  t.after(h1.close);
  const { s3 } = h1.clouds;
  const alice = await signIn(h1, 'byo-crash');
  const team = await createTeam(alice, 'Crashy');
  const keys = await seed(store, team, 8);
  const r = await alice.post(`/hub/teams/${team}/storage`, s3Form('crash'));
  assert.equal(r.status, 303, r.text);
  await waitFor(() => h1.hub.teamStorage.status(team).move?.done === 4);
  const row = { ...h1.hub.db.prepare('SELECT move_state, move_cursor, move_done, move_total FROM team_storage WHERE team_id = ?').get(team) };
  assert.deepEqual(row, { move_state: 'copying', move_cursor: keys[3], move_done: 4, move_total: keys.length });
  assert.equal(h1.hub.teamStorage.status(team).provider, 'hub', 'not switched before the copy completes');
  await h1.close();

  // A new process: the move carries on from the cursor.
  const h2 = await startHub({ dir, store, gh });
  t.after(h2.close);
  await h2.hub.teamStorage.job(team);
  assert.equal(h2.hub.teamStorage.status(team).provider, 's3');
  for (const k of keys) {
    assert.deepEqual(inBucket(s3, 'crash', k), store.map.get(k), k);
    assert.equal(s3.puts.get(`crash/${k}`), 1, `${k} copied once`);
  }
  assert.ok(h2.logs.some((l) => /now uses s3/.test(l)));

  // Back to the hub's store (it has everything: nothing to copy), and again to the bucket (same).
  const hubPuts = new Map(store.puts);
  const alice2 = await signIn(h2, 'byo-crash-2');
  h2.hub.db.prepare("INSERT INTO members (team_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(team, alice2.user.id, Date.now());
  let back = await alice2.post(`/hub/teams/${team}/storage/hub`);
  assert.equal(back.status, 303, back.text);
  await h2.hub.teamStorage.job(team);
  assert.equal(h2.hub.teamStorage.status(team).provider, 'hub');
  assert.equal(h2.hub.db.prepare('SELECT storage_url FROM teams WHERE id = ?').get(team).storage_url, null);
  assert.deepEqual(store.puts, hubPuts, 'nothing re-copied into the hub store');
  back = await alice2.post(`/hub/teams/${team}/storage`, s3Form('crash'));
  assert.equal(back.status, 303, back.text);
  await h2.hub.teamStorage.job(team);
  assert.equal(h2.hub.teamStorage.status(team).provider, 's3');
  for (const k of keys) assert.equal(s3.puts.get(`crash/${k}`), 1, `${k} still copied once`);
});

test('during a move: writes go to both stores, blob reads fall back to the old one, manifests are read from the old one, and the switch waits for the copy', async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  let first = true;
  const h = await startHub({
    onCopied: async () => {
      if (first) {
        first = false;
        await gate;
      }
    },
  });
  t.after(h.close);
  const { s3 } = h.clouds;
  const store = h.store;
  const alice = await signIn(h, 'byo-dual');
  const team = await createTeam(alice, 'Dual');
  const keys = await seed(store, team, 5, 'wsdual01');
  const r = await alice.post(`/hub/teams/${team}/storage`, s3Form('dual'));
  assert.equal(r.status, 303, r.text);
  await waitFor(() => h.hub.teamStorage.status(team).move?.done === 1);
  const router = h.hub.teamStorage.router;
  const ts = h.hub.teamStorage;

  // Not switched while copying.
  assert.equal(ts.status(team).provider, 'hub');
  assert.equal(ts.status(team).move.state, 'copying');
  assert.equal(h.hub.db.prepare('SELECT storage_url FROM teams WHERE id = ?').get(team).storage_url, null);
  assert.match((await alice.req(`/hub/teams/${team}/settings`)).text, /<progress max="100" value="\d+"/);

  // A new version: written to both.
  const nb = Buffer.from('written during the move');
  const nk = `ws/${team}/wsdual01/blobs/${sha1(nb)}`;
  await router.put(nk, nb);
  assert.deepEqual(store.map.get(nk), nb);
  assert.deepEqual(inBucket(s3, 'dual', nk), nb);

  // A blob not copied yet: read from the old store.
  const late = keys[keys.length - 2];
  assert.ok(!inBucket(s3, 'dual', late));
  assert.deepEqual(await router.get(late), store.map.get(late));
  assert.equal(await router.has(late), true);

  // A blob only in the new store: read from it.
  const onlyNew = Buffer.from('only in the bucket');
  const onk = `ws/${team}/wsdual01/blobs/${sha1(onlyNew)}`;
  s3.objects.set(`dual/${onk}`, onlyNew);
  assert.deepEqual(await router.get(onk), onlyNew);

  // A manifest: the old store is authoritative until the switch, even if the bucket holds an older one.
  const mk = `ws/${team}/wsdual01/manifest.json`;
  s3.objects.set(`dual/${mk}`, Buffer.from('{"stale":true}'));
  assert.deepEqual(await router.get(mk), store.map.get(mk));
  const m2 = Buffer.from(JSON.stringify({ version: 1, head: null, files: {}, written_at: 'later' }));
  await router.put(mk, m2);
  assert.deepEqual(store.map.get(mk), m2);
  assert.deepEqual(inBucket(s3, 'dual', mk), m2);

  // A dual write the bucket refuses: the write still succeeds (the old store has it), and the key is copied again before the switch.
  const fb = Buffer.from('the bucket refused this one');
  const fk = `ws/${team}/wsdual01/blobs/${sha1(fb)}`;
  s3.failWhen = (req) => (req.method === 'PUT' && req.url.endsWith(sha1(fb)) ? 403 : null);
  await router.put(fk, fb);
  s3.failWhen = null;
  assert.deepEqual(store.map.get(fk), fb);
  assert.ok(!inBucket(s3, 'dual', fk));

  release();
  await ts.job(team);
  assert.equal(ts.status(team).provider, 's3');
  for (const k of [...keys, nk, fk]) assert.deepEqual(inBucket(s3, 'dual', k), store.map.get(k), k);
  assert.deepEqual(inBucket(s3, 'dual', mk), m2, 'the newest manifest');

  // After the switch: the bucket only.
  const after = Buffer.from('after the switch');
  const ak = `ws/${team}/wsdual01/blobs/${sha1(after)}`;
  await router.put(ak, after);
  assert.ok(inBucket(s3, 'dual', ak));
  assert.ok(!store.map.has(ak));
  assert.deepEqual(await router.get(ak), after);
  // Another team's keys are untouched by this one's bucket.
  const other = `ws/zzzzzzzz/w/blobs/${sha1('o')}`;
  await router.put(other, Buffer.from('o'));
  assert.ok(store.map.has(other));
});

test('a failed move can be retried or cancelled; a move in progress refuses another change', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { s3 } = h.clouds;
  const alice = await signIn(h, 'byo-fail');
  const team = await createTeam(alice, 'Failing');
  await seed(h.store, team, 3);
  // The probe passes; copying a blob is refused.
  s3.failWhen = (req) => (req.method === 'PUT' && req.url.includes('/fail/ws/') ? 403 : null);
  let r = await alice.post(`/hub/teams/${team}/storage`, s3Form('fail'));
  assert.equal(r.status, 303, r.text);
  await h.hub.teamStorage.job(team);
  let st = h.hub.teamStorage.status(team);
  assert.equal(st.move.state, 'failed');
  assert.match(st.move.error, /HTTP 403 AccessDenied/);
  assert.equal(st.provider, 'hub');
  let page = (await alice.req(`/hub/teams/${team}/settings`)).text;
  assert.match(page, /The move to Amazon S3 stopped/);
  assertNoSecrets(page, 'the settings page');

  r = await alice.post(`/hub/teams/${team}/storage`, s3Form('other'));
  assert.equal(r.status, 409);
  assert.match(r.text, /A move to another store is in progress/);

  s3.failWhen = null;
  r = await alice.post(`/hub/teams/${team}/storage/retry`);
  assert.equal(r.status, 303);
  await h.hub.teamStorage.job(team);
  st = h.hub.teamStorage.status(team);
  assert.equal(st.provider, 's3');
  assert.equal(st.move, null);

  // Cancel: back to what it was, nothing switched.
  let release;
  const h2 = await startHub({ onCopied: () => new Promise((res) => (release = res)) });
  t.after(h2.close);
  const bob = await signIn(h2, 'byo-cancel');
  const t2 = await createTeam(bob, 'Cancelling');
  await seed(h2.store, t2, 3);
  r = await bob.post(`/hub/teams/${t2}/storage`, s3Form('cancel'));
  assert.equal(r.status, 303);
  await waitFor(() => h2.hub.teamStorage.status(t2).move?.done === 1);
  r = await bob.post(`/hub/teams/${t2}/storage/cancel`);
  assert.equal(r.status, 303);
  release();
  await h2.hub.teamStorage.job(t2);
  assert.equal(h2.hub.teamStorage.status(t2).provider, 'hub');
  assert.equal(h2.hub.teamStorage.status(t2).move, null);
  page = (await bob.req(`/hub/teams/${t2}/settings`)).text;
  assert.match(page, /Use your own bucket/);
});

// ------------------------------------------------------- owner and IDOR

test('owner only, and no IDOR: a member gets 403 and no card; another team\'s owner gets 404 on every storage route', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'byo-owner');
  const A = await createTeam(alice, 'Owner A');
  const bob = await signIn(h, 'byo-member');
  h.hub.db.prepare("INSERT INTO members (team_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").run(A, bob.user.id, Date.now());
  const mallory = await signIn(h, 'byo-mallory');
  const M = await createTeam(mallory, 'Mallory');
  const routes = ['/storage', '/storage/hub', '/storage/cancel', '/storage/retry'];
  const calls = h.calls.length;

  assert.doesNotMatch((await bob.req(`/hub/teams/${A}/settings`)).text, /id="storage"/, 'members do not see the card');
  for (const p of routes) {
    const asMember = await bob.post(`/hub/teams/${A}${p}`, s3Form('idor'));
    assert.equal(asMember.status, 403, p);
    const asOther = await mallory.post(`/hub/teams/${A}${p}`, s3Form('idor'));
    assert.equal(asOther.status, 404, p);
    // The form's own fields cannot point a request at another team.
    const smuggled = await mallory.post(`/hub/teams/${M}${p}`, { ...s3Form('idor'), team: A, team_id: A });
    assert.notEqual(smuggled.status, 500, p);
  }
  assert.equal(h.hub.teamStorage.status(A).provider, 'hub');
  assert.equal(h.hub.teamStorage.status(A).move, null);
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM team_storage WHERE team_id = ?').get(A).n, 0, 'nothing written for team A');
  assert.ok(h.calls.slice(calls).every((c) => c.host === S3_HOST), 'only mallory\'s own team reached a bucket');
  // Unsigned and cross-site posts are refused before anything runs.
  const anon = new Browser(h.base);
  const anonPost = await anon.req(`/hub/teams/${A}/storage`, { method: 'POST', form: s3Form('x') });
  assert.ok([303, 401, 403].includes(anonPost.status), String(anonPost.status));
  assert.equal(h.hub.teamStorage.status(A).provider, 'hub');
});

// ------------------------------------------------------------------ SSRF

test('SSRF: the endpoint must be https on public addresses after DNS, redirects are not followed, and a host that turns private later is refused', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { s3 } = h.clouds;
  const alice = await signIn(h, 'byo-ssrf');
  const team = await createTeam(alice, 'SSRF');
  h.dns.set('metadata-alias.example', '169.254.169.254');
  h.dns.set('mixed.example', '93.184.216.34', '10.1.2.3');
  h.dns.set('v6-loop.example', '::1');
  h.dns.set('nat64.example', '64:ff9b::a9fe:a9fe');
  const calls = h.calls.length;
  for (const endpoint of [
    'http://s3.fake-cloud.example',
    'https://127.0.0.1',
    'https://10.0.0.5',
    'https://169.254.169.254',
    'https://[::1]',
    'https://[fd00:ec2::254]',
    'https://localhost',
    'https://localhost.',
    'https://metadata.google.internal',
    'https://redis',
    'https://key:secret@s3.fake-cloud.example',
    'https://s3.fake-cloud.example/redirect?to=x',
    'https://metadata-alias.example',
    'https://mixed.example',
    'https://v6-loop.example',
    'https://nat64.example',
    'file:///etc/passwd',
  ]) {
    const r = await alice.post(`/hub/teams/${team}/storage`, s3Form('ssrf', { endpoint }));
    assert.equal(r.status, 400, endpoint);
    assert.match(r.text, /endpoint/, endpoint);
  }
  assert.equal(h.calls.length, calls, 'no request was sent');

  // A redirect is an answer, not followed.
  s3.failWhen = (req) => (req.url.includes('grapim-probe/') ? 301 : null);
  const r = await alice.post(`/hub/teams/${team}/storage`, s3Form('ssrf'));
  s3.failWhen = null;
  assert.equal(r.status, 400);
  assert.match(r.text, /HTTP 301/);
  assert.ok(h.calls.slice(calls).every((c) => c.host === S3_HOST), 'nothing went to the Location');
  assert.equal(h.hub.teamStorage.status(team).provider, 'hub');

  // DNS rebinding later: every request re-checks (cached a minute at most).
  const dns = fakeDns();
  const clock = { t: 0 };
  const seen = [];
  const safe = makeSafeFetch({ resolve: dns.resolve, transport: async (u, init, v) => (seen.push(v.address), { status: 200, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) }), now: () => clock.t });
  assert.equal((await safe('https://bucket.example/x', { method: 'GET' })).status, 200);
  dns.set('bucket.example', '10.0.0.7');
  clock.t += 61_000;
  await assert.rejects(() => safe('https://bucket.example/x', { method: 'GET' }), { code: 'endpoint_refused' });
  await assert.rejects(() => safe('http://bucket2.example/x', { method: 'GET' }), { code: 'endpoint_refused' });
  assert.deepEqual(seen, ['93.184.216.34'], 'the connection goes to the vetted address');
});

// ------------------------------------------------------------------ /v1

async function platformKeys(h, login) {
  const owner = await signIn(h, login);
  const team = await createTeam(owner, `${login} Inc`);
  const on = await owner.post(`/hub/teams/${team}/platform`);
  assert.equal(on.status, 303, on.text);
  const key = async (name, mode) => {
    const r = await owner.post(`/hub/teams/${team}/platform/keys`, { name, mode });
    assert.equal(r.status, 200, r.text);
    return r.text.match(/value="(gpk_(?:live|test)_[A-Za-z0-9_-]+)"/)[1];
  };
  return { owner, team, live: await key('backend', 'live'), test: await key('ci', 'test') };
}

async function api(h, key, method, p, body = undefined) {
  const headers = { Authorization: `Bearer ${key}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(h.base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}

test('PUT /v1/settings { storage }: live keys only (a test key gets 403 and changes nothing), the probe, the move, never a secret back', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const { gcs } = h.clouds;
  const P = await platformKeys(h, 'byo-platform');
  const gcsBody = { provider: 'gcs', bucket: 'acme-gcs', prefix: 'pf', access_key_id: GCS.accessKeyId, secret_access_key: GCS.secretAccessKey };
  await seed(h.store, P.team, 3);

  // Test mode: refused before anything, whatever else is in the body.
  const calls = h.calls.length;
  for (const storage of [gcsBody, null]) {
    const r = await api(h, P.test, 'PUT', '/v1/settings', { storage, embed_allowed_origins: ['https://ci.example.com'] });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.error.code, 'livemode_required');
  }
  assert.equal(h.calls.length, calls, 'no probe');
  assert.deepEqual((await api(h, P.test, 'GET', '/v1/settings')).json.embed_allowed_origins, [], 'nothing applied');
  assert.equal((await api(h, P.test, 'GET', '/v1/settings')).json.storage, undefined, 'test keys do not see storage');

  // Live: shape errors and a failing probe change nothing.
  let r = await api(h, P.live, 'GET', '/v1/settings');
  assert.equal(r.json.storage.provider, 'hub');
  r = await api(h, P.live, 'PUT', '/v1/settings', { storage: { ...gcsBody, password: 'x' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /Unknown field storage\.password/);
  r = await api(h, P.live, 'PUT', '/v1/settings', { storage: 'gs://acme-gcs' });
  assert.equal(r.status, 400);
  r = await api(h, P.live, 'PUT', '/v1/settings', { storage: { ...gcsBody, secret_access_key: 'nope-wrong-0003' }, embed_allowed_origins: ['https://app.example.com'] });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.error.code, 'storage_unreachable');
  assert.ok(!r.text.includes('nope-wrong-0003'));
  gcs.signatureFailures = 0;
  assert.deepEqual((await api(h, P.live, 'GET', '/v1/settings')).json.embed_allowed_origins, [], 'a refused probe applies nothing');
  r = await api(h, P.live, 'PUT', '/v1/settings', { storage: { ...gcsBody, endpoint: 'https://169.254.169.254' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'invalid_storage');

  // Live and valid: probed, moving, then switched.
  r = await api(h, P.live, 'PUT', '/v1/settings', { storage: gcsBody });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.storage.move.to, 'gcs');
  assertNoSecrets(r.text, 'the reply');
  await h.hub.teamStorage.job(P.team);
  r = await api(h, P.live, 'GET', '/v1/settings');
  assert.deepEqual(r.json.storage, { object: 'storage', provider: 'gcs', bucket: 'acme-gcs', prefix: 'pf', endpoint: 'https://storage.googleapis.com', region: null, account: null, credentials: 'saved', move: null });
  assertNoSecrets(r.text, 'GET /v1/settings');
  assertNoSecrets((await api(h, P.live, 'GET', '/v1/openapi.json')).text, 'the OpenAPI document');

  // null: back to the hub's storage.
  r = await api(h, P.live, 'PUT', '/v1/settings', { storage: null });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.storage.move.to, 'hub');
  await h.hub.teamStorage.job(P.team);
  assert.equal((await api(h, P.live, 'GET', '/v1/settings')).json.storage.provider, 'hub');

  // Another platform's key cannot touch this one: its storage is its own.
  const Q = await platformKeys(h, 'byo-platform-q');
  r = await api(h, Q.live, 'PUT', '/v1/settings', { storage: { ...gcsBody, prefix: 'q' } });
  assert.equal(r.status, 200, r.text);
  await h.hub.teamStorage.job(Q.team);
  assert.equal(h.hub.teamStorage.status(P.team).provider, 'hub');
  assert.equal(h.hub.teamStorage.status(Q.team).provider, 'gcs');
  assertNoSecrets(h.logs.join('\n'), 'the logs');
});
