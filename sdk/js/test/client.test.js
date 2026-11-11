import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { inspect } from 'node:util';

import {
  AuthenticationError,
  ConflictError,
  ConnectionError,
  Grapim,
  GrapimError,
  NotFoundError,
  RateLimitError,
} from '../src/index.js';
import { startFakeServer } from './fake-server.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let fake;
let grapim;
const v1 = (path) => (r) => r.path === '/v1' + path;

before(async () => {
  fake = await startFakeServer();
  grapim = new Grapim({ apiKey: fake.apiKey, baseUrl: fake.url, baseDelayMs: 5, maxDelayMs: 20 });
});
after(() => fake.close());
beforeEach(() => fake.reset());

describe('construction', () => {
  test('needs a gpk_ key and never echoes it', () => {
    assert.throws(() => new Grapim({ apiKey: '' }), GrapimError);
    const secretish = 'gws_' + 'x'.repeat(30);
    const e = (() => { try { new Grapim({ apiKey: secretish }); } catch (err) { return err; } })();
    assert.ok(e instanceof GrapimError);
    assert.match(e.message, /Grapim\.workspace/);
    assert.ok(!e.message.includes(secretish));
  });

  test('the key is in no inspect, JSON or error output', async () => {
    const key = 'gpk_live_' + 'k'.repeat(32);
    const c = new Grapim({ apiKey: key, baseUrl: fake.url, maxAttempts: 1 });
    assert.ok(!inspect(c, { depth: 10, showHidden: true }).includes(key));
    assert.ok(!JSON.stringify(c).includes(key));
    const err = await c.workspaces.list().catch((x) => x);
    assert.ok(err instanceof AuthenticationError);
    assert.ok(!inspect(err, { depth: 10, showHidden: true }).includes(key));
    assert.ok(!String(err.stack).includes(key));
    assert.equal(c.testMode, false);
  });

  test('accepts a baseUrl with a trailing /v1 or slash', async () => {
    const c = new Grapim({ apiKey: fake.apiKey, baseUrl: fake.url + '/v1/' });
    await c.workspaces.list();
    assert.equal(fake.requests.at(-1).path, '/v1/workspaces');
    assert.equal(c.testMode, true);
  });
});

describe('headers', () => {
  test('auth, accept, user agent, JSON content type', async () => {
    await grapim.workspaces.create({ external_id: 'cust_hdr', name: 'hdr' });
    const r = fake.requests.find(v1('/workspaces'));
    assert.equal(r.method, 'POST');
    assert.equal(r.headers.authorization, `Bearer ${fake.apiKey}`);
    assert.equal(r.headers.accept, 'application/json');
    assert.match(r.headers['user-agent'], /^grapim-js\/\d/);
    assert.equal(r.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(r.body), { external_id: 'cust_hdr', name: 'hdr' });
  });
});

describe('idempotency', () => {
  test('every POST gets a UUID Idempotency-Key; GET, PATCH and DELETE get none', async () => {
    const ws = await grapim.workspaces.create({ name: 'idem-a' });
    await grapim.workspaces.get(ws.id);
    await grapim.workspaces.update(ws.id, { metadata: { plan: 'pro' } });
    await grapim.tokens.create(ws.id, { scope: 'read' });
    await grapim.workspaces.delete(ws.id);
    const posts = fake.requests.filter((r) => r.method === 'POST');
    assert.equal(posts.length, 2);
    for (const p of posts) assert.match(p.headers['idempotency-key'], UUID);
    assert.notEqual(posts[0].headers['idempotency-key'], posts[1].headers['idempotency-key']);
    for (const r of fake.requests.filter((x) => x.method !== 'POST')) assert.equal(r.headers['idempotency-key'], undefined);
  });

  test('a caller key is used as given', async () => {
    await grapim.workspaces.create({ name: 'idem-b' }, { idempotencyKey: 'order-42' });
    assert.equal(fake.requests.at(-1).headers['idempotency-key'], 'order-42');
  });

  test('a retry after a lost response reuses the key, so the workspace is created once', async () => {
    const before = fake.state.workspaces.size;
    fake.script((req, url) => url.pathname === '/v1/workspaces' && req.method === 'POST', [{ status: 502, after: true }]);
    const ws = await grapim.workspaces.create({ external_id: 'cust_lost', name: 'lost' });
    const posts = fake.requests.filter((r) => r.method === 'POST' && r.path === '/v1/workspaces');
    assert.equal(posts.length, 2);
    assert.equal(posts[0].headers['idempotency-key'], posts[1].headers['idempotency-key']);
    assert.equal(fake.state.workspaces.size, before + 1);
    assert.equal(ws.external_id, 'cust_lost');
  });

  test('the same key with a different body is a ConflictError idempotency_mismatch', async () => {
    await grapim.workspaces.create({ name: 'idem-c' }, { idempotencyKey: 'k-mismatch' });
    const e = await grapim.workspaces.create({ name: 'idem-d' }, { idempotencyKey: 'k-mismatch' }).catch((x) => x);
    assert.ok(e instanceof ConflictError);
    assert.equal(e.code, 'idempotency_mismatch');
    assert.equal(e.status, 409);
    assert.match(e.requestId, /^req_/);
  });
});

describe('retries', () => {
  test('503 then 200, honouring Retry-After: 0', async () => {
    fake.script('/v1/usage', [{ status: 503, headers: { 'Retry-After': '0' }, code: 'busy' }]);
    const r = await grapim.usage.get();
    assert.ok(Array.isArray(r.data));
    assert.equal(fake.requests.filter(v1('/usage')).length, 2);
  });

  test('Retry-After in seconds is waited for', async () => {
    fake.script('/v1/usage', [{ status: 429, headers: { 'Retry-After': '1' }, code: 'rate_limited' }]);
    const t0 = Date.now();
    await grapim.usage.get();
    assert.ok(Date.now() - t0 >= 950, `waited only ${Date.now() - t0} ms`);
  });

  test('at most 3 attempts, then a typed RateLimitError', async () => {
    fake.script('/v1/usage', [429, 429, 429, 429].map((status) => ({ status, headers: { 'Retry-After': '0' }, code: 'rate_limited' })));
    const e = await grapim.usage.get().catch((x) => x);
    assert.ok(e instanceof RateLimitError);
    assert.equal(e.status, 429);
    assert.equal(e.code, 'rate_limited');
    assert.equal(fake.requests.filter(v1('/usage')).length, 3);
  });

  test('500 on a GET is retried with backoff; 400 is not retried', async () => {
    fake.script('/v1/webhook_endpoints', [{ status: 500 }]);
    await grapim.webhooks.list();
    assert.equal(fake.requests.filter(v1('/webhook_endpoints')).length, 2);
    fake.reset();
    const e = await grapim.webhooks.create({ url: 'http://not-https.example', events: [] }).catch((x) => x);
    assert.equal(e.status, 400);
    assert.equal(e.code, 'bad_request');
    assert.equal(fake.requests.length, 1);
  });

  test('a refused connection is a ConnectionError after the retries', async () => {
    const dead = new Grapim({ apiKey: fake.apiKey, baseUrl: 'http://127.0.0.1:1', baseDelayMs: 1, timeoutMs: 2000 });
    const e = await dead.workspaces.list().catch((x) => x);
    assert.ok(e instanceof ConnectionError);
    assert.equal(e.status, 0);
  });
});

describe('errors', () => {
  test('404 is a NotFoundError with code, status and the Request-Id header', async () => {
    const e = await grapim.workspaces.get('ws_nope').catch((x) => x);
    assert.ok(e instanceof NotFoundError);
    assert.ok(e instanceof GrapimError);
    assert.equal(e.code, 'not_found');
    assert.equal(e.status, 404);
    assert.match(e.requestId, /^req_\d+$/);
  });
});

describe('pagination', () => {
  test('for await walks every page with starting_after', async () => {
    const made = [];
    for (let i = 0; i < 7; i++) made.push((await grapim.workspaces.create({ external_id: `page_${i}`, name: `page-${i}` })).id);
    fake.reset();
    const seen = [];
    for await (const ws of grapim.workspaces.list({ limit: 3 })) if (made.includes(ws.id)) seen.push(ws.id);
    assert.deepEqual(seen, made);
    const pages = fake.requests.filter(v1('/workspaces'));
    assert.ok(pages.length >= 3);
    assert.equal(new URLSearchParams(pages[0].query).get('starting_after'), null);
    for (const p of pages.slice(1)) assert.match(new URLSearchParams(p.query).get('starting_after'), /^ws_/);
    for (const p of pages) assert.equal(new URLSearchParams(p.query).get('limit'), '3');
  });

  test('awaiting a list gives the first page; filters pass through', async () => {
    const page = await grapim.workspaces.list({ limit: 2 });
    assert.equal(page.data.length, 2);
    assert.equal(page.has_more, true);
    const one = await grapim.workspaces.list({ external_id: 'page_3' });
    assert.equal(one.data.length, 1);
    assert.equal(one.data[0].external_id, 'page_3');
    const all = await grapim.workspaces.list({ limit: 2 }).toArray({ max: 5 });
    assert.equal(all.length, 5);
  });
});

describe('resources', () => {
  test('workspaces, tokens, embed sessions, runs, usage, webhooks, settings', async () => {
    const ws = await grapim.workspaces.create({ external_id: 'cust_res', name: 'res', metadata: { tier: 'a' } });
    assert.equal(ws.object, 'workspace');
    assert.match(ws.url, /\/w\/team_fake\/res\/$/);

    const got = await grapim.workspaces.get(ws.id);
    assert.equal(got.id, ws.id);
    const upd = await grapim.workspaces.update(ws.id, { name: 'res2' });
    assert.equal(upd.name, 'res2');
    assert.equal(fake.requests.at(-1).method, 'PATCH');

    const tok = await grapim.tokens.create(ws.id, { scope: 'write', ttl_seconds: 60, agent_name: 'bot' });
    assert.match(tok.token, /^gws_/);
    assert.equal(tok.scope, 'write');
    await grapim.tokens.revoke(ws.id, tok.id);
    assert.equal(fake.requests.at(-1).method, 'DELETE');
    assert.equal(fake.requests.at(-1).path, `/v1/workspaces/${ws.id}/tokens/${tok.id}`);

    const emb = await grapim.embedSessions.create(ws.id, { mode: 'readonly', theme: 'dark' });
    assert.match(emb.url, /\/embed\//);

    assert.deepEqual(await grapim.runs.list(ws.id), []);

    await grapim.usage.get({ from: new Date(Date.UTC(2026, 10, 1)), to: '2026-11-30', group_by: 'day' });
    const q = new URLSearchParams(fake.requests.at(-1).query);
    assert.equal(q.get('from'), '2026-11-01');
    assert.equal(q.get('to'), '2026-11-30');
    assert.equal(q.get('group_by'), 'day');

    const ep = await grapim.webhooks.create({ url: 'https://example.com/hooks', events: ['run.started'] });
    assert.match(ep.secret, /^whsec_/);
    const eps = await grapim.webhooks.list().toArray();
    assert.ok(eps.some((e) => e.id === ep.id));
    await grapim.webhooks.delete(ep.id);

    const s = await grapim.settings.update({ embed_allowed_origins: ['https://app.example.com'] });
    assert.deepEqual(s.embed_allowed_origins, ['https://app.example.com']);
    assert.equal(fake.requests.at(-1).method, 'PUT');

    await grapim.workspaces.delete(ws.id);
    await assert.rejects(grapim.workspaces.get(ws.id), NotFoundError);
  });

  test('ids are URL-encoded', async () => {
    await grapim.workspaces.get('a/b?c').catch(() => {});
    assert.equal(fake.requests.at(-1).path, '/v1/workspaces/a%2Fb%3Fc');
  });
});
