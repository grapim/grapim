#!/usr/bin/env node
// A local hub with a realistic team, for working on the hub pages and taking
// screenshots. Local development only: it signs every request in as the demo
// user, so never point it at real data.
//
//   node scripts/dev-hub.mjs [--port 7480] [--data <folder>] [--as demo|sam] [--slow <ms>]
//
// --slow delays every page and form request (not static files) by that many
// milliseconds, to see and capture the waiting states.
//
// Ask Grapim answers from a local stand-in for the Anthropic API
// (scripts/fake-anthropic.mjs), so it can be demoed without a key:
//   --no-agent           the "not set up" state instead (no key)
//   --agent-think <ms>   the wait before the first token (default 700)
//   --agent-delay <ms>   the pause between streamed chunks (default 30)
//   --agent-tool <ms>    how long each tool seems to take (default 0)
//
// Seeds (in a fresh folder unless --data is given):
// - "Acme" (governance): five synced repos with 12 weeks of runs and provenance
//   (scripts/seed-reports.mjs), three members, hub reviews on older runs and a
//   few recent runs that still need review, agents active now, one run with
//   real file diffs and two turns, the GitHub App linked with two open pull
//   requests, require-review on, and a workspace with agent activity.
// - "Acme Lite" (team plan, the reports teaser).
// - "Acme" again, empty: the setup checklist, and a duplicate team name.
//
// Then open http://127.0.0.1:<port>/hub. GitHub is never called: the App is
// configured with a throwaway key so its pages render, and nothing is sent.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHub } from '../src/hub/server.js';
import { demoBrain, startFakeAnthropic } from './fake-anthropic.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const PORT = Number(opt('port', 7480));
const dataDir = path.resolve(opt('data', fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-dev-hub-'))));
const fresh = !fs.existsSync(path.join(dataDir, 'hub.db'));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

const USERS = [
  { id: 1001, login: 'demo', name: 'Dana Demo' },
  { id: 1002, login: 'sam', name: 'Sam Ortiz' },
  { id: 1003, login: 'priya', name: 'Priya Rao' },
];
const TEAM = 'acme-demo-gov';

if (fresh) execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-reports.mjs'), '--data', dataDir, '--reset', '--owner', '1001', 'demo'], { stdio: 'inherit' });

// Ask Grapim talks to a local stand-in for the Anthropic API (scripts/fake-anthropic.mjs):
// no key, nothing sent. --no-agent shows the "not set up" state instead;
// --agent-delay <ms> slows each streamed chunk (default 30) to watch it stream.
const agentOn = !args.includes('--no-agent');
// --agent-think <ms> is the wait before the first token, --agent-tool <ms> how long each tool seems to take.
const fakeModel = agentOn ? await startFakeAnthropic({ script: demoBrain(), chunk: 6, delayMs: Number(opt('agent-delay', 30)) || 0, firstTokenMs: Number(opt('agent-think', 700)) || 0 }) : null;

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const hub = await createHub({
  env: {
    ...(agentOn ? { ANTHROPIC_API_KEY: 'dev-hub-fake-key', ANTHROPIC_BASE_URL: fakeModel.url } : {}),
    HUB_URL: ORIGIN,
    HUB_SECRET: crypto.createHash('sha256').update(`dev-hub ${dataDir}`).digest('hex'),
    HUB_DATA: dataDir,
    // demo can open Support messages at /hub/admin/support.
    HUB_ADMINS: 'demo',
    GITHUB_CLIENT_ID: 'dev-client',
    GITHUB_CLIENT_SECRET: 'dev-secret',
    GITHUB_APP_ID: '424242',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    GITHUB_APP_WEBHOOK_SECRET: 'dev-webhook-secret-0123456789',
    GITHUB_APP_SLUG: 'grapim-dev',
  },
  billing: null,
  // Nothing leaves this machine.
  fetch: async (url) => {
    throw new Error(`dev hub: no network (${url})`);
  },
  github: { governance: (team) => team.plan === 'governance' },
  log: () => {},
});
const { db } = hub;
const now = Date.now();
const toolMs = Number(opt('agent-tool', 0)) || 0;
if (toolMs) {
  const run = hub.agent.tools.run;
  hub.agent.tools.run = async (...a) => {
    await new Promise((r) => setTimeout(r, toolMs));
    return run(...a);
  };
}

async function seedMore() {
  const repoId = (name) => sha1(`${TEAM} ${name} root`);
  const insUser = db.prepare('INSERT OR IGNORE INTO users (id, login, name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)');
  for (const u of USERS) insUser.run(u.id, u.login, u.name, now - 40 * DAY, now);
  for (const u of USERS.slice(1)) db.prepare("INSERT OR IGNORE INTO members (team_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").run(TEAM, u.id, now - 30 * DAY);

  // Who synced what: demo's laptop, the others' machines and CI.
  const owners = { 'alex-mbp': 1001, 'sam-linux': 1002, 'priya-mbp': 1003, 'ci-runner': 1002 };
  for (const [machine, user] of Object.entries(owners)) db.prepare('UPDATE machines SET user_id = ? WHERE team_id = ? AND machine = ?').run(user, TEAM, machine);

  // The seed spreads today's runs over working hours, some later than now: drop those.
  for (const t of ['h_changes', 'h_events']) db.prepare(`DELETE FROM ${t} WHERE team_id = ? AND ts > ?`).run(TEAM, now - 5 * MIN);
  db.prepare('DELETE FROM h_provenance WHERE team_id = ? AND received_at > ?').run(TEAM, now);
  db.prepare('UPDATE h_agents SET last_seen = MIN(last_seen, ?) WHERE team_id = ?').run(now - 70 * MIN, TEAM);

  // Hub reviews: everything older than a day and a half is reviewed, a few hours after it ended; newer runs wait.
  const reviews = hub.github.reviews;
  const runs = db.prepare('SELECT repo_id, machine, run, MAX(ts) AS ts FROM h_changes WHERE team_id = ? GROUP BY repo_id, machine, run').all(TEAM);
  for (const r of runs) {
    if (r.run.startsWith('undo:') || now - r.ts < 1.5 * DAY) continue;
    const owner = owners[r.machine];
    const reviewer = USERS.find((u) => u.id !== owner).id;
    const status = sha1(r.run).charCodeAt(0) % 9 === 0 ? 'rejected' : 'approved';
    try {
      reviews.record({ id: TEAM }, r.repo_id, r.run, status, reviewer, status === 'rejected' ? 'Tests do not cover the retry path.' : null);
      const at = Math.min(now - 30 * MIN, r.ts + (1 + (parseInt(sha1(r.run).slice(0, 4), 16) % 20)) * 60 * MIN);
      db.prepare('UPDATE hub_reviews SET reviewed_at = ? WHERE team_id = ? AND run = ?').run(at, TEAM, r.run);
    } catch {}
  }

  // A run with real content and two turns, synced from Sam's desktop.
  const tok = hub.teams.createToken(TEAM, { role: 'member', userId: 1002 }, 'sam-desktop');
  const files = [
    ['src/routes/orders.ts', "import { Router } from 'express';\nimport { createOrder } from '../orders/create';\n\nexport const orders = Router();\n\norders.post('/orders', async (req, res) => {\n  const order = await createOrder(req.body);\n  res.status(201).json(order);\n});\n", "import { Router } from 'express';\nimport { createOrder } from '../orders/create';\nimport { withIdempotency } from '../lib/idempotency';\n\nexport const orders = Router();\n\n// A retried POST with the same Idempotency-Key returns the first answer\n// instead of creating a second order.\norders.post('/orders', withIdempotency({ ttlSeconds: 24 * 60 * 60 }), async (req, res) => {\n  const order = await createOrder(req.body, { idempotencyKey: req.get('Idempotency-Key') });\n  res.status(201).json(order);\n});\n"],
    ['src/lib/idempotency.ts', null, "import type { RequestHandler } from 'express';\nimport { redis } from './redis';\n\nexport function withIdempotency({ ttlSeconds }: { ttlSeconds: number }): RequestHandler {\n  return async (req, res, next) => {\n    const key = req.get('Idempotency-Key');\n    if (!key) return next();\n    const seen = await redis.get(`idem:${key}`);\n    if (seen) return res.status(200).json(JSON.parse(seen));\n    const send = res.json.bind(res);\n    res.json = (body) => {\n      redis.set(`idem:${key}`, JSON.stringify(body), { EX: ttlSeconds });\n      return send(body);\n    };\n    next();\n  };\n}\n"],
    ['test/orders.test.ts', "import { request } from './helpers';\n\ntest('creates an order', async () => {\n  const res = await request.post('/orders').send({ sku: 'A1' });\n  expect(res.status).toBe(201);\n});\n", "import { request } from './helpers';\n\ntest('creates an order', async () => {\n  const res = await request.post('/orders').send({ sku: 'A1' });\n  expect(res.status).toBe(201);\n});\n\ntest('a retried POST with the same key creates one order', async () => {\n  const first = await request.post('/orders').set('Idempotency-Key', 'k1').send({ sku: 'A1' });\n  const again = await request.post('/orders').set('Idempotency-Key', 'k1').send({ sku: 'A1' });\n  expect(again.body.id).toBe(first.body.id);\n});\n"],
  ];
  const run = 'claude-code:7f3e21aa-55b0-4e0c-9d61-2f0c9a1b7e10';
  const blobs = {};
  const put = (s) => {
    if (s === null) return null;
    const b = Buffer.from(s);
    blobs[sha1(b)] = b.toString('base64');
    return sha1(b);
  };
  const t0 = now - 50 * MIN;
  const lines = (s) => (s ? s.split('\n').length - 1 : 0);
  const body = {
    repo: { id: repoId('shop-api'), name: 'shop-api' },
    machine: 'sam-desktop',
    cursor: { changes: 0, events: 0, agents: 0 },
    runs: [{ run, turn: 2, started_at: t0 }],
    agents: [{ agent: run, label: 'claude 7f3e21aa', intent: 'Add idempotency keys to POST /orders', worktree: 'shop-api', last_seen: now - 4 * MIN }],
    changes: files.map(([p, before, after], i) => ({ id: i + 1, run, label: 'claude 7f3e21aa', turn: i < 2 ? 1 : 2, worktree: 'shop-api', path: p, before_sha: put(before), after_sha: put(after), untracked: false, added: Math.max(1, lines(after) - lines(before) + 2), removed: before ? 2 : 0, ts: t0 + (i + 1) * 6 * MIN })),
    events: [
      { id: 1, ts: t0, agent: run, kind: 'intent', path: null, detail: 'Add idempotency keys to POST /orders' },
      { id: 2, ts: t0 + 15 * MIN, agent: run, kind: 'intent', path: null, detail: 'Now add a test that a retried POST with the same key creates one order' },
    ],
    blobs,
  };
  const res = await fetch(`${ORIGIN}/hub/api/sync`, { method: 'POST', headers: { Authorization: `Bearer ${tok.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) console.error('dev hub: sync failed', res.status, await res.text());

  // Agents working right now.
  const insAgent = db.prepare('INSERT OR REPLACE INTO h_agents (team_id, repo_id, machine, agent, label, intent, worktree, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insAgent.run(TEAM, repoId('web-app'), 'priya-mbp', 'cursor-vscode:4821', 'cursor 4821', 'Split the checkout page into server components', 'web-app', now - 2 * MIN);
  insAgent.run(TEAM, repoId('billing-svc'), 'ci-runner', 'http:sandbox-3', 'sandbox-3', 'Retry failed Stripe webhooks with backoff', 'billing-svc', now - 9 * MIN);

  // The GitHub App, linked, with two open pull requests holding unreviewed runs.
  db.prepare('INSERT OR REPLACE INTO gh_installations (id, account_id, account_login, account_type, sender_id, team_id, linked_by, linked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(77001, 9001, 'acme-co', 'Organization', 1001, TEAM, 1001, now - 20 * DAY, now - 20 * DAY, now);
  db.prepare("UPDATE repos SET github = 'acme-co/' || name WHERE team_id = ? AND name IN ('shop-api', 'web-app')").run(TEAM);
  hub.github.setPolicy(TEAM, { require_review: true }, 1001);
  const waiting = db
    .prepare("SELECT run, repo_id FROM h_changes WHERE team_id = ? AND ts > ? AND run NOT LIKE 'undo:%' GROUP BY run ORDER BY MAX(ts) DESC LIMIT 6")
    .all(TEAM, now - 3 * DAY);
  const pull = db.prepare('INSERT OR IGNORE INTO gh_pull_runs (team_id, installation_id, repo_gh_id, owner, name, number, head_sha, run, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  pull.run(TEAM, 77001, 5001, 'acme-co', 'shop-api', 412, sha1('h412'), run, now - 20 * MIN);
  for (const w of waiting.slice(0, 2)) pull.run(TEAM, 77001, 5001, 'acme-co', 'shop-api', 412, sha1('h412'), w.run, now - 20 * MIN);
  for (const w of waiting.slice(2, 4)) pull.run(TEAM, 77001, 5002, 'acme-co', 'web-app', 97, sha1('h97'), w.run, now - 3 * 60 * MIN);

  // A cloud workspace with agent activity, written over HTTPS like an agent would.
  const team = hub.teams.get(TEAM);
  const ws = hub.workspaces.create(team, { role: 'owner', userId: 1001 }, 'research-notes');
  hub.mount.applyTemplate(ws, 'research', 'human:demo');
  const wt = hub.workspaces.createToken(ws, { role: 'owner', userId: 1001 }, 'e2b', 'write');
  const write = (p, text, agent) =>
    fetch(`${ORIGIN}/w/${TEAM}/research-notes/fs/${p}`, { method: 'PUT', headers: { Authorization: `Bearer ${wt.token}`, 'X-Grapim-Agent': agent }, body: text });
  await write('sources/stripe-retries.md', '# Stripe retries\n\nStripe retries a failed webhook for up to 3 days with exponential backoff.\n', 'researcher');
  await write('notes/idempotency.md', '# Idempotency keys\n\n- Keep keys 24 hours.\n- Return the first answer for a retried key.\n', 'researcher');
  await write('drafts/rfc-orders.md', '# RFC: idempotent order creation\n\nStatus: draft\n', 'writer');
  await hub.mount.measure(ws).catch(() => {});

  // An empty team with the same name as one you already have: the checklist.
  const empty = hub.teams.create({ id: 1001, login: 'demo' }, 'Acme');
  db.prepare('UPDATE teams SET created_at = ? WHERE id = ?').run(now - 2 * DAY, empty.id);
  return { empty };
}

// Every request is signed in as --as (demo by default).
const as = USERS.find((u) => u.login === opt('as', 'demo')) ?? USERS[0];
let cookie = null;
const SLOW = Number(opt('slow', 0)) || 0;
let ready = false;
const server = http.createServer(async (req, res) => {
  if (SLOW && ready && !req.url.startsWith('/hub/static/')) await new Promise((r) => setTimeout(r, SLOW));
  if (cookie && !/grapim/i.test(req.headers.cookie ?? '')) req.headers.cookie = [req.headers.cookie, cookie].filter(Boolean).join('; ');
  hub.handle(req, res).catch(() => res.destroy());
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const extra = fresh ? await seedMore() : { empty: db.prepare("SELECT id FROM teams WHERE name = 'Acme' AND id != ?").get(TEAM) };
if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(as.id)) db.prepare('INSERT INTO users (id, login, name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)').run(as.id, as.login, as.name, now, now);
cookie = hub.auth.createSession(as.id).cookie.split(';')[0];
ready = true;

console.log(`Grapim dev hub on ${ORIGIN}/hub (signed in as ${as.login}), data in ${dataDir}`);
console.log(`  team:       ${ORIGIN}/hub/teams/${TEAM}`);
console.log(`  empty team: ${ORIGIN}/hub/teams/${extra.empty?.id}`);

const stop = () => {
  server.close();
  fakeModel?.close();
  hub.close().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
