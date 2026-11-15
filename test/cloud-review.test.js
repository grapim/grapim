// Cloud review (src/hub/github/cloud-review.js): the App reviews a pull
// request on Grapim's model account. End to end against a fake GitHub, a
// local git repository standing in for github.com, and a fake Anthropic API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CLOUD_CHECK, CLOUD_MARKER, cloudConfig, costMicros, createCloudReview, DEFAULT_MODEL, provenanceSection } from '../src/hub/github/cloud-review.js';

const TOKEN = 'ghs_cloudtest_secret_token';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A repository with main and a pull request head at refs/pull/7/head.
function sourceRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-cloud-src-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/small.js'), 'export const a = 1;\nexport const b = 2;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'src/small.js'), 'export const a = 10;\nexport const b = 20;\n');
  git(dir, 'commit', '-qam', 'change');
  const head = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'update-ref', 'refs/pull/7/head', head);
  git(dir, 'checkout', '-q', 'main');
  return { dir, head };
}

function listen(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    handler(req, new URL(req.url, 'http://x'), body, send);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

function fakeGitHub(head) {
  const s = { checks: [], reviews: [], comments: [], nextId: 1, auth: [] };
  return listen((req, url, body, send) => {
    s.auth.push(req.headers.authorization);
    const p = url.pathname;
    if (p === '/repos/acme/api/pulls/7' && req.method === 'GET') return send(200, { number: 7, state: 'open', title: 'Make the constants bigger', body: 'Bump a and b.', base: { ref: 'main' }, head: { sha: head } });
    if (p === '/repos/acme/api/check-runs' && req.method === 'POST') {
      const c = { id: s.nextId++, ...body };
      s.checks.push(c);
      return send(201, c);
    }
    let m;
    if ((m = /^\/repos\/acme\/api\/check-runs\/(\d+)$/.exec(p))) {
      Object.assign(s.checks.find((c) => c.id === Number(m[1])), body);
      return send(200, {});
    }
    if (p === '/repos/acme/api/pulls/7/reviews') {
      if (req.method === 'GET') return send(200, s.reviews);
      const r = { id: s.nextId++, ...body, user: { login: 'grapim-test[bot]', type: 'Bot' } };
      s.reviews.push(r);
      return send(200, r);
    }
    if (p === '/repos/acme/api/issues/7/comments') {
      if (req.method === 'GET') return send(200, s.comments);
      const c = { id: s.nextId++, body: body.body, user: { login: 'grapim-test[bot]', type: 'Bot' } };
      s.comments.push(c);
      return send(201, c);
    }
    if ((m = /^\/repos\/acme\/api\/issues\/comments\/(\d+)$/.exec(p))) {
      s.comments.find((c) => c.id === Number(m[1])).body = body.body;
      return send(200, {});
    }
    send(404, { message: `fake: no route ${req.method} ${p}` });
  }).then((srv) => ({ ...srv, s }));
}

function fakeAnthropic() {
  const s = { requests: [] };
  return listen((req, url, body, send) => {
    s.requests.push({ key: req.headers['x-api-key'], model: body.model });
    const findings = [{ path: 'src/small.js', line: 1, end_line: 1, severity: 'blocker', confidence: 'high', category: 'correctness', title: 'a is now 10', body: 'Callers expect 1.' }];
    send(200, { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: JSON.stringify({ findings }) }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } });
  }).then((srv) => ({ ...srv, s }));
}

async function setup(t, { plan = 'free', credit = null } = {}) {
  const src = sourceRepo();
  const gh = await fakeGitHub(src.head);
  const model = await fakeAnthropic();
  t.after(async () => {
    await gh.close();
    await model.close();
  });
  const db = new DatabaseSync(':memory:');
  const logs = [];
  const hub = { db, now: () => Date.now(), log: (l) => logs.push(l), teams: { get: (id) => ({ id, plan }) } };
  const env = { GRAPIM_REVIEW_ANTHROPIC_KEY: 'sk-test-cloud', ANTHROPIC_BASE_URL: model.base, ...(credit ? { GRAPIM_REVIEW_MONTHLY_CREDIT: JSON.stringify(credit) } : {}) };
  const cloud = createCloudReview(hub, {
    auth: { installationToken: async () => TOKEN },
    installs: { forTeam: () => [{ id: 1 }] },
    apiBase: gh.base,
    fetch: globalThis.fetch,
    slug: 'grapim-test',
    env,
    gitUrl: () => src.dir,
    provenanceWaitMs: 5,
  });
  t.after(() => cloud.close());
  const job = { installationId: 1, repoId: 99, teamId: 'team1', owner: 'acme', name: 'api', number: 7, headSha: src.head };
  return { cloud, gh, model, db, logs, job, src };
}

test('config: Opus 5.5 by default (the benchmarked model), its price, the key never enumerable', () => {
  const c = cloudConfig({ ANTHROPIC_API_KEY: 'sk-secret-xyz' });
  assert.equal(c.model, DEFAULT_MODEL);
  assert.equal(DEFAULT_MODEL, 'claude-opus-5-5');
  assert.deepEqual({ ...c.price }, { input: 4, output: 20 });
  assert.ok(c.configured);
  assert.ok(!JSON.stringify(c).includes('sk-secret-xyz'));
  assert.equal(cloudConfig({}).configured, false);
  assert.equal(costMicros(c.price, 1_000_000, 0), 4_000_000, '$4 per million input tokens');
});

test('a pull request is reviewed in the cloud: check in progress, inline review, summary, blocker fails the check, cost counted', async (t) => {
  const { cloud, gh, model, db, job } = await setup(t);
  assert.equal(cloud.onPullRequest(job), false, 'off until an owner turns it on');
  cloud.setEnabled('team1', true, 'u1');
  const r = await cloud.review(job, AbortSignal.timeout(60_000));
  assert.equal(r.done, true, JSON.stringify(r));
  assert.equal(r.counts.blocker, 1);

  assert.ok(model.s.requests.length >= 1);
  assert.ok(model.s.requests.every((q) => q.key === 'sk-test-cloud' && q.model === 'claude-opus-5-5'));

  const check = gh.s.checks.find((c) => c.name === CLOUD_CHECK);
  assert.equal(check.status, 'completed');
  assert.equal(check.conclusion, 'failure');
  assert.match(check.output.title, /1 blocker/);
  assert.equal(gh.s.reviews.length, 1);
  assert.equal(gh.s.reviews[0].comments[0].path, 'src/small.js');
  assert.equal(gh.s.comments.length, 1);
  assert.ok(gh.s.comments[0].body.startsWith(CLOUD_MARKER));
  assert.ok(!JSON.stringify({ checks: gh.s.checks, reviews: gh.s.reviews, comments: gh.s.comments }).includes(TOKEN), 'the token never reaches a comment or check');
  assert.ok(gh.s.auth.every((a) => a === `Bearer ${TOKEN}`), 'every API call uses the installation token');

  const row = db.prepare('SELECT * FROM cloud_reviews').get();
  assert.equal(row.status, 'done');
  assert.ok(row.cost_micros > 0);
  assert.equal(row.cost_micros, costMicros(cloud.config.price, row.input_tokens, row.output_tokens));
  assert.equal(cloud.usage({ id: 'team1', plan: 'free' }).reviews, 1);

  // Run again on the same head: the summary is updated, no second inline review.
  await cloud.review(job, AbortSignal.timeout(60_000));
  assert.equal(gh.s.reviews.length, 1);
  assert.equal(gh.s.comments.length, 1);
});

test('no credit left: a neutral check, and the model is never called', async (t) => {
  const { cloud, gh, model, job } = await setup(t, { credit: { free: 0 } });
  cloud.setEnabled('team1', true, 'u1');
  const r = await cloud.review(job, AbortSignal.timeout(30_000));
  assert.equal(r.skipped, 'no_credit');
  assert.equal(model.s.requests.length, 0);
  const check = gh.s.checks.find((c) => c.name === CLOUD_CHECK);
  assert.equal(check.conclusion, 'neutral');
  assert.match(check.output.title, /No review credit/);
});

test('a fetch that fails ends the check as neutral, without the token in the message', async (t) => {
  const { cloud, gh, model, job } = await setup(t);
  cloud.setEnabled('team1', true, 'u1');
  const bad = createCloudReview({ db: new DatabaseSync(':memory:'), now: Date.now, log: () => {}, teams: { get: (id) => ({ id, plan: 'free' }) } }, {
    auth: { installationToken: async () => TOKEN },
    installs: { forTeam: () => [{ id: 1 }] },
    apiBase: gh.base,
    fetch: globalThis.fetch,
    slug: 'grapim-test',
    env: { GRAPIM_REVIEW_ANTHROPIC_KEY: 'sk-test-cloud', ANTHROPIC_BASE_URL: model.base },
    gitUrl: () => path.join(os.tmpdir(), 'no-such-repo-grapim'),
  });
  t.after(() => bad.close());
  bad.setEnabled('team1', true, 'u1');
  const r = await bad.review(job, AbortSignal.timeout(30_000));
  assert.ok(r.failed);
  const check = gh.s.checks.at(-1);
  assert.equal(check.conclusion, 'neutral');
  assert.ok(!JSON.stringify(check).includes(TOKEN));
  assert.equal(model.s.requests.length, 0);
});

test('one comment per pull request: the provenance section joins the review summary', async (t) => {
  const { cloud, gh, job } = await setup(t);
  cloud.setEnabled('team1', true, 'u1');
  const prov = '<!-- grapim:provenance -->\n### Grapim provenance\n\n**1 agent run of 1 not reviewed yet.** 39% of the added lines came from agent runs (11 of 28): claude-code 11\n';
  cloud.saveProvenance({ installationId: job.installationId, repoId: job.repoId, number: job.number, headSha: job.headSha, markdown: prov });
  const r = await cloud.review(job, AbortSignal.timeout(60_000));
  assert.equal(r.done, true);
  const body = gh.s.comments[0].body;
  assert.ok(body.startsWith(CLOUD_MARKER));
  assert.match(body, /### Who wrote it\n\n\*\*1 agent run of 1 not reviewed yet\.\*\*/);
  assert.ok(!body.includes('grapim:provenance'), 'the provenance marker is not carried over');
  // A stale head is not shown; nothing rendered yet shows nothing.
  cloud.saveProvenance({ installationId: job.installationId, repoId: job.repoId, number: job.number, headSha: 'f'.repeat(40), markdown: prov });
  assert.equal(cloud.provenanceFor(job), undefined);
  assert.equal(provenanceSection(null), '');
});
