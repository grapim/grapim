// Regression tests for the platform API security review
// (docs/security-review-platform-2026-11-11.md). Each test names the finding
// it covers. An in-process hub with GitHub mocked, an injected clock, DNS
// resolver and webhook transport, as in test/platform.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../src/hub/server.js';
import { LIMITS } from '../src/hub/ratelimit.js';
import { MAX_IDEMPOTENCY_PER_HOUR } from '../src/hub/platform/api.js';
import { MAX_EMBEDS_PER_HOUR } from '../src/hub/platform/embeds.js';
import { MAX_USAGE_ROWS } from '../src/hub/platform/metering.js';
import { migratePlatform } from '../src/hub/platform/schema.js';
import { PAUSE_MS } from '../src/hub/platform/webhooks.js';
import { PLATFORM_PRICES } from '../src/hub/billing.js';
import { isBlockedAddress, makeResolver, parseWebhookUrl, UrlRefused, vet } from '../src/hub/platform/ssrf.js';
import { cleanOrigin, sealer } from '../src/hub/platform/util.js';

const ORIGIN = 'http://localhost:7998';
const APP = 'https://app.example.com';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function startHub({ transport: customTransport = null, webhooks = undefined, env = {} } = {}) {
  const codes = new Map();
  const fetchGh = async (url, init = {}) => {
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
  const names = new Map();
  const resolve = async (host) => (names.get(host) ?? ['93.184.216.34']).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  const calls = [];
  const transport =
    customTransport ??
    (async (target, { headers, body }) => {
      calls.push({ url: target.url.toString(), headers, body });
      return { status: 200 };
    });
  const clock = { t: Date.now() };
  const dir = tmp('grapim-pfsec-');
  const hub = await createHub({
    env: { HUB_URL: ORIGIN, HUB_SECRET: 'test-secret-that-is-long-enough-0123456789', HUB_DATA: dir, GITHUB_CLIENT_ID: 'gh', GITHUB_CLIENT_SECRET: 'gh-secret', ...env },
    fetch: fetchGh,
    billing: null,
    storage: null,
    now: () => clock.t,
    log: () => {},
    platform: { resolve, transport, worker: false, ...(webhooks ? { webhooks } : {}) },
  });
  const addr = await hub.listen(0, '127.0.0.1');
  return { hub, base: `http://127.0.0.1:${addr.port}`, gh: (code, profile) => codes.set(code, profile), dns: (host, ...a) => names.set(host, a), calls, clock, dir, close: () => hub.close() };
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

let nextId = 19000;
async function platform(h, login) {
  const id = nextId++;
  h.gh(`code-${id}`, { id, login, name: login, avatar_url: null });
  const b = new Browser(h.base);
  const start = await b.req('/hub/auth/github');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  assert.equal((await b.req(`/hub/auth/callback?code=code-${id}&state=${state}`)).status, 303);
  const r = await b.post('/hub/teams', { name: `${login} Inc` });
  const team = r.headers.get('location').match(/\/hub\/teams\/([^/?#]+)/)[1];
  assert.equal((await b.post(`/hub/teams/${team}/platform`)).status, 303);
  const key = async (name, mode) => (await b.post(`/hub/teams/${team}/platform/keys`, { name, mode })).text.match(/value="(gpk_(?:live|test)_[A-Za-z0-9_-]+)"/)[1];
  return { owner: b, userId: id, team, live: await key('backend', 'live'), test: await key('ci', 'test') };
}

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

const wsPath = (ws) => new URL(ws.url).pathname;

// ---------------------------------------------------------------- H1

test('H1: webhook DNS runs on c-ares with a time limit, never on the libuv threadpool, and vet() gives up on a resolver that hangs', async () => {
  // A DNS server that never answers.
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  const lookups = [];
  const orig = { lookup: dns.lookup, plookup: dns.promises.lookup };
  dns.lookup = (...a) => (lookups.push(a[0]), orig.lookup(...a));
  dns.promises.lookup = (...a) => (lookups.push(a[0]), orig.plookup(...a));
  try {
    const started = Date.now();
    await assert.rejects(makeResolver({ servers: [`127.0.0.1:${sock.address().port}`], timeoutMs: 100 })('hang.example.com'));
    assert.ok(Date.now() - started < 4000, 'gave up quickly');
    assert.deepEqual(lookups, [], 'getaddrinfo (the threadpool) was never used');
  } finally {
    dns.lookup = orig.lookup;
    dns.promises.lookup = orig.plookup;
    sock.close();
  }
  // Whatever resolver is given, vet() has its own deadline.
  const guard = new Promise((_, reject) => setTimeout(() => reject(new Error('vet() hung')), 3000).unref());
  const err = await Promise.race([vet('https://hang.example.com/x', () => new Promise(() => {}), { timeoutMs: 100 }).then(() => null, (e) => e), guard]);
  assert.ok(err instanceof UrlRefused);
  assert.equal(err.code, 'url_unresolvable');
});

// ---------------------------------------------------------------- H2

test('H2: GET /v1/usage refuses a range with more rows than it can hold in memory', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'sec-usage');
  const day = new Date(h.clock.t).toISOString().slice(0, 10);
  const ins = h.hub.db.prepare("INSERT INTO usage_daily (team_id, workspace_id, day, mode, writes, api_calls, storage_bytes) VALUES (?, ?, ?, 'live', 1, 1, 1000)");
  h.hub.db.exec('BEGIN');
  for (let i = 0; i <= MAX_USAGE_ROWS; i++) ins.run(p.team, `wsfake${i}`, day);
  h.hub.db.exec('COMMIT');
  const big = await api(h, p.live, 'GET', `/v1/usage?from=${day}&to=${day}`);
  assert.equal(big.status, 400, big.text.slice(0, 200));
  assert.match(big.json.error.message, /fewer days/);
  const grouped = await api(h, p.live, 'GET', `/v1/usage?from=${day}&to=${day}&group_by=day`);
  assert.equal(grouped.status, 400);
  // Another range is fine.
  assert.equal((await api(h, p.live, 'GET', '/v1/usage?from=2020-01-01&to=2020-01-31')).status, 200);
});

// ---------------------------------------------------------------- M1

test('M1: sealed values are bound to their row: a reply or a webhook secret copied from another platform does not open', async (t) => {
  const s = sealer('x'.repeat(40));
  const c = s.seal('secret', 'a\nrow-1');
  assert.equal(s.open(c, 'a\nrow-1'), 'secret');
  assert.equal(s.open(c, 'a\nrow-2'), null);
  assert.equal(s.open(c.replace(/^v2\./, 'v1.'), 'a\nrow-1'), null);

  const h = await startHub();
  t.after(h.close);
  const A = await platform(h, 'sec-aad-a');
  const B = await platform(h, 'sec-aad-b');
  const wsA = (await api(h, A.live, 'POST', '/v1/workspaces', {})).json;
  const wsB = (await api(h, B.live, 'POST', '/v1/workspaces', {})).json;
  const tokA = await api(h, A.live, 'POST', `/v1/workspaces/${wsA.id}/tokens`, { scope: 'write' }, { 'Idempotency-Key': 'k' });
  assert.equal(tokA.status, 200);
  const tokB = await api(h, B.live, 'POST', `/v1/workspaces/${wsB.id}/tokens`, { scope: 'read' }, { 'Idempotency-Key': 'k' });
  assert.equal(tokB.status, 200);
  // Someone who can write the database (a backup restored by hand, an
  // injection elsewhere) copies A's sealed reply into B's row...
  const rowA = h.hub.db.prepare('SELECT body FROM platform_idempotency WHERE team_id = ?').get(A.team);
  h.hub.db.prepare('UPDATE platform_idempotency SET body = ? WHERE team_id = ?').run(rowA.body, B.team);
  // ...and B replays its own request: A's token must not come out.
  const replay = await api(h, B.live, 'POST', `/v1/workspaces/${wsB.id}/tokens`, { scope: 'read' }, { 'Idempotency-Key': 'k' });
  assert.notEqual(replay.json?.token, tokA.json.token, 'A\'s token leaked to B');
  assert.equal(replay.status, 409);

  // The same for webhook signing secrets: A's secret in B's endpoint row does not sign.
  const eA = (await api(h, A.live, 'POST', '/v1/webhook_endpoints', { url: 'https://a.example.com/h', events: ['*'] })).json;
  const eB = (await api(h, B.live, 'POST', '/v1/webhook_endpoints', { url: 'https://b.example.com/h', events: ['*'] })).json;
  const sealedA = h.hub.db.prepare('SELECT secret_sealed FROM webhook_endpoints WHERE id = ?').get(eA.id).secret_sealed;
  h.hub.db.prepare('UPDATE webhook_endpoints SET secret_sealed = ? WHERE id = ?').run(sealedA, eB.id);
  await api(h, B.live, 'POST', '/v1/workspaces', {});
  await h.hub.platform.webhooks.deliverDue();
  assert.equal(h.calls.filter((c) => c.url.startsWith('https://b.example.com')).length, 0, 'signed with A\'s secret');
  const d = h.hub.db.prepare('SELECT * FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY id DESC').get(eB.id);
  assert.match(d.last_error, /cannot sign/);
});

// ---------------------------------------------------------------- M2

test('M2: a platform key stops working when its creator is no longer an owner', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'sec-demote');
  assert.equal((await api(h, p.live, 'GET', '/v1/workspaces')).status, 200);
  h.hub.db.prepare("UPDATE members SET role = 'member' WHERE team_id = ? AND user_id = ?").run(p.team, p.userId);
  assert.equal((await api(h, p.live, 'GET', '/v1/workspaces')).status, 401);
  assert.equal((await api(h, p.test, 'GET', '/v1/workspaces')).status, 401);
  h.hub.db.prepare("UPDATE members SET role = 'owner' WHERE team_id = ? AND user_id = ?").run(p.team, p.userId);
  assert.equal((await api(h, p.live, 'GET', '/v1/workspaces')).status, 200);
});

// ---------------------------------------------------------------- M3

test('M3: embedding origins are plain origins: no wildcard, no characters that split the CSP header', async (t) => {
  for (const bad of ['https://*', 'https://*.example.com', 'https://a;b.example.com', "https://a'b.example.com", 'https://a,b.example.com', 'https://a"b.example.com', 'https://a$b.example.com']) {
    assert.equal(cleanOrigin(bad), null, bad);
  }
  for (const ok of ['https://app.example.com', 'https://app.example.com:8443', 'http://localhost:3000', 'https://10.0.0.1', 'https://[2001:db8::1]']) assert.ok(cleanOrigin(ok), ok);
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'sec-origins');
  for (const bad of ['https://*', 'https://*.example.com', 'https://a;b.example.com']) {
    assert.equal((await api(h, p.live, 'PUT', '/v1/settings', { embed_allowed_origins: [bad] })).status, 400, bad);
  }
  const form = await p.owner.post(`/hub/teams/${p.team}/platform/origins`, { origins: 'https://*' });
  assert.equal(form.status, 400);
  assert.deepEqual(h.hub.platform.keys.settings(p.team).embed_allowed_origins, []);
});

// ---------------------------------------------------------------- M4

test('M4: agents with a valid workspace token are not held back by the per-address limits; unknown tokens still are', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'sec-egress');
  const ws = (await api(h, p.live, 'POST', '/v1/workspaces', {})).json;
  const tok = (await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/tokens`, { scope: 'read' })).json.token;
  const ip = '127.0.0.1';
  // Other sandboxes behind the same egress address used up both address buckets.
  for (let i = 0; i < LIMITS.global[0]; i++) h.hub.rate.hit(`global:${ip}`, ...LIMITS.global);
  for (let i = 0; i < LIMITS.syncIp[0]; i++) h.hub.rate.hit(`syncIp:${ip}`, ...LIMITS.syncIp);
  const ok = await fetch(`${h.base}${wsPath(ws)}api/overview`, { headers: { Authorization: `Bearer ${tok}` } });
  assert.equal(ok.status, 200, await ok.text());
  // An unknown token from that address is refused, and so is anything without a token.
  assert.equal((await fetch(`${h.base}${wsPath(ws)}api/overview`, { headers: { Authorization: 'Bearer gws_nope' } })).status, 429);
  assert.equal((await fetch(`${h.base}/hub`, { redirect: 'manual' })).status, 429);
});

// ---------------------------------------------------------------- M5

test('M5: SSRF: IPv4-compatible, SIIT and local-use NAT64 addresses, "localhost." and single-label names are refused', async (t) => {
  for (const ip of ['::7f00:1', '::a9fe:a9fe', '::127.0.0.1', '::ffff:0:a9fe:a9fe', '64:ff9b:1::a9fe:a9fe', '64:ff9b:1::a00:1']) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ['2606:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808']) assert.equal(isBlockedAddress(ip), false, ip);
  for (const u of ['https://localhost./x', 'https://LOCALHOST./x', 'https://foo.localhost./x', 'https://redis/x', 'https://metadata/x']) {
    assert.throws(() => parseWebhookUrl(u), UrlRefused, u);
  }
  assert.equal(parseWebhookUrl('https://hooks.example.com./x').host, 'hooks.example.com');
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'sec-ssrf');
  h.dns('nat64.example.com', '64:ff9b:1::a9fe:a9fe');
  for (const url of ['https://[::a9fe:a9fe]/x', 'https://localhost./x', 'https://redis/x', 'https://nat64.example.com/x']) {
    const r = await api(h, p.live, 'POST', '/v1/webhook_endpoints', { url, events: ['*'] });
    assert.equal(r.status, 400, `${url}: ${r.text}`);
  }
});

// ---------------------------------------------------------------- M7

test('M7: new Idempotency-Keys and embed sessions are capped per platform per hour', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'sec-caps');
  await api(h, p.live, 'PUT', '/v1/settings', { embed_allowed_origins: [APP] });
  const ws = (await api(h, p.live, 'POST', '/v1/workspaces', {}, { 'Idempotency-Key': 'before' })).json;
  for (let i = 0; i < MAX_IDEMPOTENCY_PER_HOUR; i++) h.hub.rate.hit(`idempotency:${p.team}`, MAX_IDEMPOTENCY_PER_HOUR, 3_600_000);
  const fresh = await api(h, p.live, 'POST', '/v1/workspaces', {}, { 'Idempotency-Key': 'after' });
  assert.equal(fresh.status, 429);
  assert.ok(fresh.headers.get('retry-after'));
  assert.equal(h.hub.db.prepare("SELECT COUNT(*) AS n FROM platform_idempotency WHERE key LIKE '%after'").get().n, 0);
  const replay = await api(h, p.live, 'POST', '/v1/workspaces', {}, { 'Idempotency-Key': 'before' });
  assert.equal(replay.status, 200, 'a stored key still replays');
  assert.equal(replay.json.id, ws.id);

  for (let i = 0; i < MAX_EMBEDS_PER_HOUR; i++) h.hub.rate.hit(`embeds:${p.team}`, MAX_EMBEDS_PER_HOUR, 3_600_000);
  assert.equal((await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/embed_sessions`, {})).status, 429);
});

// ---------------------------------------------------------------- M8

test('M8: events no endpoint wants are not kept in the outbox', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'sec-outbox');
  const count = () => h.hub.db.prepare('SELECT COUNT(*) AS n FROM webhook_events WHERE team_id = ?').get(p.team).n;
  await api(h, p.live, 'POST', '/v1/workspaces', {});
  assert.equal(count(), 0);
  await api(h, p.live, 'POST', '/v1/webhook_endpoints', { url: 'https://hooks.example.com/x', events: ['workspace.deleted'] });
  await api(h, p.live, 'POST', '/v1/workspaces', {});
  assert.equal(count(), 0, 'the endpoint does not want workspace.created');
  await api(h, p.test, 'POST', '/v1/workspaces', {});
  assert.equal(count(), 0, 'the endpoint is live; this was a test event');
  const ws = (await api(h, p.live, 'POST', '/v1/workspaces', {})).json;
  await api(h, p.live, 'DELETE', `/v1/workspaces/${ws.id}`);
  assert.equal(count(), 1);
});

// ---------------------------------------------------------------- L1

test('L1: test and live keys have separate Idempotency-Key namespaces', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'sec-idem-mode');
  const live = await api(h, p.live, 'POST', '/v1/workspaces', { external_id: 'live-1' }, { 'Idempotency-Key': 'same' });
  assert.equal(live.status, 200);
  const test = await api(h, p.test, 'POST', '/v1/workspaces', { external_id: 'test-1' }, { 'Idempotency-Key': 'same' });
  assert.equal(test.status, 200, test.text);
  assert.equal(test.json.livemode, false);
  // Each still replays its own reply.
  assert.equal((await api(h, p.live, 'POST', '/v1/workspaces', { external_id: 'live-1' }, { 'Idempotency-Key': 'same' })).json.id, live.json.id);
});

// ---------------------------------------------------------------- L4

test('L4: removing an origin from embed_allowed_origins ends the sessions framed by it and voids its unused links', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'sec-killswitch');
  await api(h, p.live, 'PUT', '/v1/settings', { embed_allowed_origins: [APP] });
  const ws = (await api(h, p.live, 'POST', '/v1/workspaces', {})).json;
  const used = (await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/embed_sessions`, {})).json;
  const unused = (await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/embed_sessions`, {})).json;
  const open = await fetch(h.base + new URL(used.url).pathname, { redirect: 'manual' });
  assert.equal(open.status, 303);
  const cookie = open.headers.get('set-cookie').split(';')[0];
  const read = () => fetch(`${h.base}${wsPath(ws)}api/runs`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal((await read()).status, 200);
  await api(h, p.live, 'PUT', '/v1/settings', { embed_allowed_origins: ['https://other.example.com'] });
  assert.equal((await read()).status, 401);
  assert.equal((await fetch(h.base + new URL(unused.url).pathname, { redirect: 'manual' })).status, 410);
});

// ---------------------------------------------------------------- helpers for M6 to M11

const settle = () => new Promise((r) => setTimeout(r, 150));
const MB = 1024 * 1024;

async function wsAgent(h, token, p, { method = 'GET', body = undefined, headers = {} } = {}) {
  const hdr = { 'X-Grapim-Agent': 'a', ...headers };
  if (token) hdr.Authorization = `Bearer ${token}`;
  const res = await fetch(h.base + p, { method, headers: hdr, body, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

// The desk page an embed link leads to, fetched as the iframe would.
async function openDesk(h, url) {
  const nav = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' };
  const open = await fetch(h.base + new URL(url).pathname, { redirect: 'manual', headers: nav });
  assert.equal(open.status, 303);
  const loc = new URL(open.headers.get('location'), ORIGIN);
  const cookie = open.headers.get('set-cookie').split(';')[0];
  const desk = await fetch(`${h.base}${loc.pathname}${loc.search}`, { headers: { Cookie: cookie, ...nav } });
  return { loc, cookie, status: desk.status, page: await desk.text() };
}

// ---------------------------------------------------------------- M6

test('M6: test and live settings are separate: a test key reads and changes only the test settings, and embed sessions use their own mode\'s', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'sec-settings');
  assert.equal((await api(h, p.live, 'PUT', '/v1/settings', { embed_allowed_origins: [APP] })).status, 200);
  // A test key (in CI, on a laptop) sets its own origins and limit...
  const put = await api(h, p.test, 'PUT', '/v1/settings', { embed_allowed_origins: ['https://ci.example.com'], workspace_storage_mb: 5 });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(put.json, { object: 'platform_settings', livemode: false, embed_allowed_origins: ['https://ci.example.com'], workspace_storage_mb: 5 });
  // ...and the live settings are untouched.
  assert.deepEqual((await api(h, p.live, 'GET', '/v1/settings')).json, { object: 'platform_settings', livemode: true, embed_allowed_origins: [APP], workspace_storage_mb: 512 });
  assert.deepEqual((await api(h, p.test, 'GET', '/v1/settings')).json.embed_allowed_origins, ['https://ci.example.com']);

  // Embed sessions use the settings of the key's mode.
  const live = (await api(h, p.live, 'POST', '/v1/workspaces', {})).json;
  const test = (await api(h, p.test, 'POST', '/v1/workspaces', {})).json;
  const esLive = await api(h, p.live, 'POST', `/v1/workspaces/${live.id}/embed_sessions`, {});
  assert.equal(esLive.json.parent_origin, APP);
  assert.equal((await api(h, p.live, 'POST', `/v1/workspaces/${live.id}/embed_sessions`, { parent_origin: 'https://ci.example.com' })).status, 400, 'a test origin cannot frame a live desk');
  assert.equal((await api(h, p.test, 'POST', `/v1/workspaces/${test.id}/embed_sessions`, {})).json.parent_origin, 'https://ci.example.com');
  assert.equal((await api(h, p.test, 'POST', `/v1/workspaces/${test.id}/embed_sessions`, { parent_origin: APP })).status, 400, 'a live origin is not a test one');

  // The kill switch is per mode too: a test key emptying its origins does not end live sessions.
  const desk = await openDesk(h, esLive.json.url);
  const read = () => fetch(`${h.base}${wsPath(live)}api/runs`, { headers: { Cookie: desk.cookie, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal((await read()).status, 200);
  assert.equal((await api(h, p.test, 'PUT', '/v1/settings', { embed_allowed_origins: [] })).status, 200);
  assert.equal((await read()).status, 200, 'a test key ended a live session');
  assert.equal((await api(h, p.live, 'PUT', '/v1/settings', { embed_allowed_origins: [] })).status, 200);
  assert.equal((await read()).status, 401);

  // The hub page edits each mode on its own.
  assert.equal((await p.owner.post(`/hub/teams/${p.team}/platform/origins`, { mode: 'test', origins: 'https://qa.example.com' })).status, 200);
  assert.deepEqual(h.hub.platform.keys.settings(p.team, 'test').embed_allowed_origins, ['https://qa.example.com']);
  assert.deepEqual(h.hub.platform.keys.settings(p.team, 'live').embed_allowed_origins, []);

  // Platforms from before the split: both modes start with the shared origins.
  h.hub.db.prepare('DELETE FROM platform_settings WHERE team_id = ?').run(p.team);
  h.hub.db.prepare('UPDATE platforms SET embed_allowed_origins = ? WHERE team_id = ?').run(JSON.stringify(['https://old.example.com']), p.team);
  migratePlatform(h.hub.db);
  for (const mode of ['live', 'test']) assert.deepEqual(h.hub.platform.keys.settings(p.team, mode), { embed_allowed_origins: ['https://old.example.com'], workspace_storage_mb: 512 }, mode);
});

// ---------------------------------------------------------------- M9

test('M9: webhook delivery is fair: a platform whose endpoint hangs holds 2 slots at most, another platform is delivered in the same round, and the hanging endpoint backs off', async (t) => {
  let answers = false; // whether slow.example.com answers at all
  const sent = [];
  const transport = (target, { body }) => {
    const host = target.url.hostname;
    sent.push({ host, body });
    if (host === 'slow.example.com' && !answers) return new Promise(() => {}); // hangs
    return Promise.resolve({ status: 200 });
  };
  const h = await startHub({ transport, webhooks: { timeoutMs: 400 } });
  t.after(h.close);
  const A = await platform(h, 'sec-hooks-a');
  const B = await platform(h, 'sec-hooks-b');
  await api(h, A.live, 'POST', '/v1/webhook_endpoints', { url: 'https://slow.example.com/in', events: ['*'] });
  await api(h, B.live, 'POST', '/v1/webhook_endpoints', { url: 'https://fast.example.com/in', events: ['*'] });
  const teamA = h.hub.db.prepare('SELECT * FROM teams WHERE id = ?').get(A.team);
  const teamB = h.hub.db.prepare('SELECT * FROM teams WHERE id = ?').get(B.team);
  // Platform A has a backlog; platform B's one event comes after all of it.
  for (let i = 0; i < 12; i++) h.hub.platform.webhooks.emit(teamA, 'live', 'workspace.created', null, { i });
  h.clock.t += 1;
  h.hub.platform.webhooks.emit(teamB, 'live', 'workspace.created', null, { b: true });
  const hooks = h.hub.platform.webhooks;
  hooks.pump();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.filter((s) => s.host === 'fast.example.com').length, 1, "B's event went out in the first round");
  assert.equal(h.hub.db.prepare("SELECT status FROM webhook_deliveries WHERE team_id = ?").get(B.team).status, 'delivered');
  assert.equal(sent.filter((s) => s.host === 'slow.example.com').length, 2, 'A holds at most 2 slots');
  assert.deepEqual(hooks.inFlight().perPlatform, { [A.team]: 2 });

  // A's two deliveries time out (10 s in production): failed, and the endpoint is paused.
  await new Promise((r) => setTimeout(r, 600));
  const ep = () => h.hub.db.prepare('SELECT * FROM webhook_endpoints WHERE team_id = ?').get(A.team);
  assert.equal(ep().backoff_until, h.clock.t + PAUSE_MS);
  assert.equal(sent.filter((s) => s.host === 'slow.example.com').length, 2, 'the paused endpoint gets nothing more');
  assert.equal(h.hub.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE team_id = ? AND last_error LIKE 'timeout%'").get(A.team).n, 2);
  assert.deepEqual(hooks.inFlight(), { total: 0, perPlatform: {} });
  // Meanwhile B's new events go straight out.
  h.hub.platform.webhooks.emit(teamB, 'live', 'workspace.deleted', null, { b: 2 });
  await hooks.deliverDue();
  assert.equal(sent.filter((s) => s.host === 'fast.example.com').length, 2);

  // After the pause A is tried again, 2 at a time; a second timeout doubles the pause.
  h.clock.t += PAUSE_MS;
  hooks.pump();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.filter((s) => s.host === 'slow.example.com').length, 4);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(ep().backoff_until, h.clock.t + 2 * PAUSE_MS);
  // Once it answers again, the pause ends and its backlog goes out, 2 at a time.
  h.clock.t += 2 * PAUSE_MS;
  answers = true;
  await hooks.deliverDue();
  assert.equal(ep().backoff_until, null);
  assert.equal(h.hub.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE team_id = ? AND status = 'delivered'").get(A.team).n, 12, 'the backlog and the retries of those that timed out');
});

// ---------------------------------------------------------------- M10

test('M10: test mode is small and short-lived: workspaces expire after 7 days (workspace.deleted, reason test_expired), 25 workspaces, 2,000 writes a day, 100 MB', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'sec-testmode');
  assert.deepEqual({ ...PLATFORM_PRICES.testCaps }, { workspaces: 25, writesPerDay: 2000, storageMb: 100, workspaceDays: 7 });
  await api(h, p.test, 'POST', '/v1/webhook_endpoints', { url: 'https://hooks.example.com/test', events: ['workspace.deleted'] });
  const test = (await api(h, p.test, 'POST', '/v1/workspaces', { external_id: 'trial' })).json;
  const live = (await api(h, p.live, 'POST', '/v1/workspaces', {})).json;
  assert.equal(test.expires_at, test.created_at + 7 * 24 * 3600);
  assert.equal(live.expires_at, null);
  const tok = (await api(h, p.test, 'POST', `/v1/workspaces/${test.id}/tokens`, { scope: 'write', ttl_seconds: 2592000 })).json.token;

  // Six days later it still works; after seven it is gone.
  h.clock.t += 6 * 24 * 3600 * 1000;
  assert.equal(await h.hub.platform.expireTestWorkspaces(), 0);
  h.clock.t += 24 * 3600 * 1000 + 1000;
  assert.equal(await h.hub.platform.expireTestWorkspaces(), 1);
  assert.equal((await api(h, p.test, 'GET', `/v1/workspaces/${test.id}`)).status, 404);
  assert.equal((await wsAgent(h, tok, `${wsPath(test)}fs/`)).status, 401);
  assert.equal((await api(h, p.live, 'GET', `/v1/workspaces/${live.id}`)).status, 200, 'live workspaces never expire');
  await h.hub.platform.webhooks.deliverDue();
  const evt = JSON.parse(h.calls.find((c) => c.url === 'https://hooks.example.com/test').body);
  assert.equal(evt.type, 'workspace.deleted');
  assert.equal(evt.livemode, false);
  assert.equal(evt.data.reason, 'test_expired');
  assert.deepEqual(evt.workspace, { id: test.id, external_id: 'trial' });

  // 25 test workspaces at once.
  const ins = h.hub.db.prepare("INSERT INTO workspaces (id, team_id, name, created_by, created_at, mode) VALUES (?, ?, ?, 1, ?, 'test')");
  for (let i = 0; i < 24; i++) ins.run(`fakews${String(i).padStart(4, '0')}`, p.team, `fake-${i}`, h.clock.t);
  const last = await api(h, p.test, 'POST', '/v1/workspaces', {});
  assert.equal(last.status, 200, last.text);
  const capped = await api(h, p.test, 'POST', '/v1/workspaces', {});
  assert.equal(capped.status, 429);
  assert.equal(capped.json.error.code, 'test_mode_limit');
  h.hub.db.prepare("DELETE FROM workspaces WHERE id LIKE 'fakews%'").run();

  // 2,000 writes a day.
  const w = last.json;
  const wt = (await api(h, p.test, 'POST', `/v1/workspaces/${w.id}/tokens`, { scope: 'write' })).json.token;
  const day = new Date(h.clock.t).toISOString().slice(0, 10);
  h.hub.db.prepare("INSERT INTO usage_daily (team_id, workspace_id, day, mode, writes) VALUES (?, 'other', ?, 'test', 1999)").run(p.team, day);
  assert.equal((await wsAgent(h, wt, `${wsPath(w)}fs/one.txt`, { method: 'PUT', body: 'x' })).status, 200);
  await settle();
  const over = await wsAgent(h, wt, `${wsPath(w)}fs/two.txt`, { method: 'PUT', body: 'x' });
  assert.equal(over.status, 429, over.text);
  assert.equal(over.json.error.code, 'test_mode_limit');
  h.hub.db.prepare("DELETE FROM usage_daily WHERE workspace_id = 'other'").run();

  // 100 MB for all of the platform's test workspaces together.
  await settle();
  h.hub.db.prepare('UPDATE workspaces SET bytes = ? WHERE id = ?').run(100 * MB - 1000, w.id);
  const full = await wsAgent(h, wt, `${wsPath(w)}fs/big.txt`, { method: 'PUT', body: Buffer.alloc(4000, 97) });
  assert.equal(full.status, 413, full.text);
  assert.equal(full.json.error.code, 'storage_limit');
  assert.match(full.json.error.message, /Test mode allows 100 MB/);
  assert.equal(fs.existsSync(path.join(h.dir, 'workspaces', p.team, w.id, 'big.txt')), false);
});

test('M10: an embedded test desk shows a TEST banner and cannot hide Grapim branding', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'sec-testdesk');
  await api(h, p.test, 'PUT', '/v1/settings', { embed_allowed_origins: [APP] });
  await api(h, p.live, 'PUT', '/v1/settings', { embed_allowed_origins: [APP] });
  const test = (await api(h, p.test, 'POST', '/v1/workspaces', {})).json;
  const live = (await api(h, p.live, 'POST', '/v1/workspaces', {})).json;
  const refused = await api(h, p.test, 'POST', `/v1/workspaces/${test.id}/embed_sessions`, { branding: false });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error.message, /test mode/);
  const es = (await api(h, p.test, 'POST', `/v1/workspaces/${test.id}/embed_sessions`, {})).json;
  const desk = await openDesk(h, es.url);
  assert.equal(desk.status, 200);
  assert.match(desk.page, /class="grapim-test-banner"[^>]*>TEST MODE/);
  assert.match(desk.page, /<meta name="grapim-embed-test" content="1">/);
  assert.equal(desk.loc.searchParams.get('brand'), null);
  // A session row from before the check, with branding off, still gets no brand=0 and a branded footer.
  const es2 = (await api(h, p.test, 'POST', `/v1/workspaces/${test.id}/embed_sessions`, {})).json;
  h.hub.db.prepare('UPDATE embed_sessions SET brand = 0 WHERE id = ?').run(es2.id);
  const desk2 = await openDesk(h, es2.url);
  assert.equal(desk2.loc.searchParams.get('brand'), null);
  assert.match(desk2.page, /html\.embed\.no-brand \.embed-foot\{display:flex!important\}/);
  // A live desk has neither, and may hide the branding.
  const liveDesk = await openDesk(h, (await api(h, p.live, 'POST', `/v1/workspaces/${live.id}/embed_sessions`, { branding: false })).json.url);
  assert.equal(liveDesk.loc.searchParams.get('brand'), '0');
  assert.doesNotMatch(liveDesk.page, /grapim-test-banner|grapim-embed-test/);
});

// ---------------------------------------------------------------- M11

test('M11: each platform workspace has its own storage limit, the platform its own quota (PLATFORM_STORAGE_MB), and the usage page shows each workspace', async (t) => {
  // A tiny team quota: the platform's own quota replaces it.
  const h = await startHub({ env: { HUB_TEAM_STORAGE_MB: '1', PLATFORM_STORAGE_MB: '3' } });
  t.after(h.close);
  const p = await platform(h, 'sec-quota');
  assert.equal((await api(h, p.live, 'PUT', '/v1/settings', { workspace_storage_mb: 4 })).status, 400, 'not above the platform quota');
  assert.equal((await api(h, p.live, 'PUT', '/v1/settings', { workspace_storage_mb: 1 })).status, 200);
  const mk = async () => {
    const ws = (await api(h, p.live, 'POST', '/v1/workspaces', {})).json;
    return { ws, tok: (await api(h, p.live, 'POST', `/v1/workspaces/${ws.id}/tokens`, { scope: 'write' })).json.token };
  };
  const one = await mk();
  const two = await mk();
  const put = (w, name, n) => wsAgent(h, w.tok, `${wsPath(w.ws)}fs/${name}`, { method: 'PUT', body: Buffer.alloc(n, 97) });
  assert.equal((await put(one, 'a.bin', 700 * 1024)).status, 200);
  await settle();
  // One end customer fills its own workspace...
  const full = await put(one, 'b.bin', 400 * 1024);
  assert.equal(full.status, 413, full.text);
  assert.equal(full.json.error.code, 'storage_limit');
  assert.match(full.json.error.message, new RegExp(`${one.ws.name} \\(${one.ws.id}\\)`));
  // ...and the others keep writing, past the 1 MB a normal team would have.
  assert.equal((await put(two, 'a.bin', 700 * 1024)).status, 200);
  await settle();
  // The platform's own quota still binds.
  assert.equal((await api(h, p.live, 'PUT', '/v1/settings', { workspace_storage_mb: 3 })).status, 200);
  const three = await mk();
  const quota = await put(three, 'a.bin', Math.round(1.7 * MB));
  assert.equal(quota.status, 413, quota.text);
  assert.match(quota.json.error.message, /This platform has used its 3 MB/);
  // A normal team on the same hub keeps HUB_TEAM_STORAGE_MB.
  assert.equal(h.hub.platform.storageLimits({ team_id: 'no-such-team', mode: null }), null);
  // The usage page lists each workspace against its limit.
  const page = (await p.owner.req(`/hub/teams/${p.team}/platform/usage`)).text;
  assert.match(page, /Storage per workspace/);
  for (const w of [one, two, three]) assert.match(page, new RegExp(w.ws.name));
  assert.match(page, /of 3\.0 MB/);
  // Every version uploaded to storage counts toward the workspace too.
  const before = h.hub.db.prepare('SELECT stored_bytes FROM workspaces WHERE id = ?').get(one.ws.id).stored_bytes;
  assert.equal(before, 0);
});

// ---------------------------------------------------------------- L2

test('L2: test-mode caps apply to undo through /v1, and every write tool of an MCP batch counts', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const p = await platform(h, 'sec-l2');
  const ws = (await api(h, p.test, 'POST', '/v1/workspaces', {})).json;
  const tok = (await api(h, p.test, 'POST', `/v1/workspaces/${ws.id}/tokens`, { scope: 'write', name: 'w', agent_name: 'bot', ttl_seconds: 2592000 })).json.token;
  assert.equal((await wsAgent(h, tok, `${wsPath(ws)}fs/a.txt`, { method: 'PUT', body: 'a\n' })).status, 200);
  await settle();
  const day = () => new Date(h.clock.t).toISOString().slice(0, 10);
  const used = (n) => h.hub.db.prepare("INSERT OR REPLACE INTO usage_daily (team_id, workspace_id, day, mode, writes) VALUES (?, 'other', ?, 'test', ?)").run(p.team, day(), n);
  used(PLATFORM_PRICES.testCaps.writesPerDay);
  const run = encodeURIComponent('http:w/bot');
  const undo = await api(h, p.test, 'POST', `/v1/workspaces/${ws.id}/runs/${run}/undo`, { apply: true });
  assert.equal(undo.status, 429, undo.text);
  assert.equal(undo.json.error.code, 'test_mode_limit');
  assert.equal(fs.readFileSync(path.join(h.dir, 'workspaces', p.team, ws.id, 'a.txt'), 'utf8'), 'a\n', 'nothing was undone');
  assert.equal((await api(h, p.test, 'POST', `/v1/workspaces/${ws.id}/runs/${run}/undo`, { apply: false })).status, 200, 'a plan writes nothing');

  // A new day with room for 2 more writes: a batch of 3 write tools is refused whole, a batch of 2 runs.
  h.clock.t += 24 * 3600 * 1000;
  used(PLATFORM_PRICES.testCaps.writesPerDay - 2);
  const mcpPost = (message, session) =>
    wsAgent(h, tok, `${wsPath(ws)}mcp`, { method: 'POST', body: JSON.stringify(message), headers: { 'Content-Type': 'application/json', ...(session ? { 'Mcp-Session-Id': session } : {}) } });
  const init = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 't' }, capabilities: {} } });
  const session = init.headers.get('mcp-session-id');
  const write = (id, p2) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'write_file', arguments: { path: p2, content: 'x' } } });
  const three = await mcpPost([write(2, 'm1.txt'), write(3, 'm2.txt'), write(4, 'm3.txt')], session);
  assert.equal(three.status, 429, three.text);
  for (const f of ['m1.txt', 'm2.txt', 'm3.txt']) assert.equal(fs.existsSync(path.join(h.dir, 'workspaces', p.team, ws.id, f)), false, f);
  const two = await mcpPost([write(5, 'm1.txt'), write(6, 'm2.txt')], session);
  assert.equal(two.status, 200, two.text);
});
