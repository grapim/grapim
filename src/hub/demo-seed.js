// Sample data for a realistic team: 12 weeks of agent runs across five repos,
// reviews, path rules, a linked GitHub App with open pull requests, a 90-day
// history scan and a workspace with agent activity.
//
// Used by the public demo (src/hub/demo.js), scripts/dev-hub.mjs and
// scripts/seed-reports.mjs. Nothing here calls the network: the GitHub rows
// are written straight to the database, and the run with real file contents
// goes through the same ingest a sync uses, in process.
//
// Deterministic for a given seed and day; timestamps are relative to `now`,
// so seeding again later keeps the newest runs a few minutes old.

import crypto from 'node:crypto';
import { tx } from './db.js';
import { parseBatch } from './ingest.js';
import { ensureReportSchema } from './reports/index.js';

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// A small seeded PRNG, so a seed gives the same data.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const REPOS = [
  { name: 'shop-api', provenance: true, weight: 1.0 },
  { name: 'web-app', provenance: true, weight: 0.8 },
  { name: 'billing-svc', provenance: true, weight: 0.45 },
  { name: 'infra', provenance: false, weight: 0.25 },
  { name: 'docs-site', provenance: false, weight: 0.15 },
];
// Three people's machines and CI (the sandbox agents run there).
export const MACHINES = ['dana-mbp', 'sam-linux', 'priya-mbp', 'ci-runner'];
const AGENTS = [
  { kind: 'claude-code', weight: 0.5, id: (r) => `claude-code:${r}`, label: (r) => `claude ${r.slice(0, 8)}` },
  { kind: 'codex', weight: 0.22, id: (r) => `codex-mcp-client:${parseInt(r.slice(0, 4), 16)}`, label: (r) => `codex ${parseInt(r.slice(0, 4), 16)}` },
  { kind: 'cursor', weight: 0.16, id: (r) => `cursor-vscode:${parseInt(r.slice(4, 8), 16)}`, label: (r) => `cursor ${parseInt(r.slice(4, 8), 16)}` },
  { kind: 'http', weight: 0.12, id: (r) => `http:sandbox-${parseInt(r.slice(0, 2), 16) % 6}`, label: (r) => `sandbox-${parseInt(r.slice(0, 2), 16) % 6}` },
];
const INTENTS = [
  'Add idempotency keys to POST /orders',
  'Fix the race in the cart total recalculation',
  'Move invoice PDFs to the new storage bucket',
  'Write tests for the refund webhook',
  'Paginate the admin user list',
  'Replace moment with date-fns in the dashboard',
  'Rate limit the password reset endpoint',
  'Split the checkout page into server components',
  'Retry failed Stripe webhooks with backoff',
  'Add an index for the orders by customer query',
  'Upgrade the Postgres driver and fix the deprecations',
  'Clean up the feature flag for the old search',
];
const FILES = ['src/routes/orders.ts', 'src/cart/total.ts', 'src/billing/invoice.ts', 'src/webhooks/refund.ts', 'src/admin/users.tsx', 'src/lib/dates.ts', 'src/auth/reset.ts', 'app/checkout/page.tsx', 'src/db/schema.sql', 'test/orders.test.ts', 'src/search/index.ts', 'package.json'];

function pick(rand, list) {
  let x = rand() * list.reduce((n, a) => n + a.weight, 0);
  for (const a of list) if ((x -= a.weight) <= 0) return a;
  return list[list.length - 1];
}

export const repoIdOf = (teamId, name) => sha1(`${teamId} ${name} root`);

// Writes the team (upserted), its owner, and `weeks` of synced runs, events
// and provenance notes. The caller holds the transaction and has cleared the
// team's old rows. team: { id, name, plan, seats }; owner: { id, login, name? }.
// Returns { runs, changes, events, notes }.
export function seedRunHistory(db, { team, owner, repos = REPOS, machines = MACHINES, weeks = 12, seed = 7, now = Date.now() }) {
  ensureReportSchema(db);
  const today = Math.floor(now / DAY) * DAY;
  const start = today - (weeks * 7 - 1) * DAY;
  const rand = rng(seed);
  const counts = { runs: 0, changes: 0, events: 0, notes: 0 };

  db.prepare(
    `INSERT INTO users (id, login, name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET login = excluded.login, updated_at = excluded.updated_at`,
  ).run(owner.id, owner.login, owner.name ?? owner.login, now, now);
  db.prepare(
    `INSERT INTO teams (id, name, created_by, created_at, plan, seats, plan_status) VALUES (?, ?, ?, ?, ?, ?, 'active')
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, created_by = excluded.created_by, created_at = excluded.created_at,
       plan = excluded.plan, seats = excluded.seats, plan_status = 'active'`,
  ).run(team.id, team.name, owner.id, start, team.plan, team.seats);
  db.prepare("INSERT INTO members (team_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?) ON CONFLICT(team_id, user_id) DO UPDATE SET role = 'owner', created_at = excluded.created_at").run(team.id, owner.id, start);

  const insRepo = db.prepare('INSERT INTO repos (team_id, id, name, created_at, last_sync_at) VALUES (?, ?, ?, ?, ?)');
  const insMachine = db.prepare('INSERT OR REPLACE INTO machines (team_id, repo_id, machine, user_id, token_id, cursor_changes, cursor_events, cursor_agents, last_sync_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insRun = db.prepare('INSERT OR REPLACE INTO h_runs (team_id, repo_id, machine, run, turn, started_at) VALUES (?, ?, ?, ?, ?, ?)');
  const insAgent = db.prepare('INSERT OR REPLACE INTO h_agents (team_id, repo_id, machine, agent, label, intent, worktree, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insChange = db.prepare(
    `INSERT INTO h_changes (team_id, repo_id, machine, local_id, run, label, turn, worktree, path, before_sha, after_sha, untracked, added, removed, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)`,
  );
  const insEvent = db.prepare('INSERT INTO h_events (team_id, repo_id, machine, local_id, ts, agent, kind, path, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insNote = db.prepare('INSERT OR REPLACE INTO h_provenance (team_id, repo_id, commit_sha, note_json, received_at) VALUES (?, ?, ?, ?, ?)');

  const ids = new Map(); // machine|repo -> next local id
  const nextId = (repo, machine) => {
    const k = `${repo}|${machine}`;
    const v = (ids.get(k) ?? 0) + 1;
    ids.set(k, v);
    return v;
  };
  const people = machines.filter((m) => m !== 'ci-runner');
  for (const repo of repos) {
    const repoId = repoIdOf(team.id, repo.name);
    insRepo.run(team.id, repoId, repo.name, start - 30 * DAY, now - Math.round(rand() * 2 * HOUR));
    for (let day = start; day <= today; day += DAY) {
      const dow = new Date(day).getUTCDay();
      const weekday = dow !== 0 && dow !== 6;
      const progress = (day - start) / Math.max(DAY, today - start); // AI use grows over the period
      const runsToday = Math.round(repo.weight * (weekday ? 3 + rand() * 5 : rand() * 1.5) * (0.7 + progress * 0.6));
      for (let i = 0; i < runsToday; i++) {
        const seedHex = sha1(`${team.id}${repo.name}${day}${i}${seed}`);
        const a = pick(rand, AGENTS);
        const run = a.id(seedHex);
        const label = a.label(seedHex);
        const machine = a.kind === 'http' && machines.includes('ci-runner') ? 'ci-runner' : people[Math.floor(rand() * people.length)];
        const t0 = Math.round(day + (8 + rand() * 10) * HOUR);
        const intent = INTENTS[Math.floor(rand() * INTENTS.length)];
        const turns = 1 + Math.floor(rand() * 4);
        insRun.run(team.id, repoId, machine, run, turns, t0);
        insAgent.run(team.id, repoId, machine, run, label, intent, repo.name, t0 + turns * 20 * MIN);
        insEvent.run(team.id, repoId, machine, nextId(repoId, `${machine}#e`), t0, run, 'intent', null, intent);
        counts.runs++;
        counts.events++;
        const nfiles = 1 + Math.floor(rand() * 5);
        const touched = [];
        let ts = t0;
        for (let f = 0; f < nfiles; f++) {
          const file = FILES[Math.floor(rand() * FILES.length)];
          const added = 4 + Math.floor(rand() * rand() * 140);
          ts += Math.round(rand() * 15 * MIN);
          insChange.run(team.id, repoId, machine, nextId(repoId, machine), run, label, 1 + (f % turns), repo.name, file, added, Math.floor(rand() * added * 0.4), ts);
          counts.changes++;
          touched.push({ file, added });
          if (rand() < 0.06) {
            // Another agent held the file: the edit was blocked.
            insEvent.run(team.id, repoId, machine, nextId(repoId, `${machine}#e`), ts - 1000, run, 'blocked', file, 'held by claude 7f3e21aa');
            counts.events++;
          }
        }
        insEvent.run(team.id, repoId, machine, nextId(repoId, `${machine}#e`), ts + 1000, run, 'end', null, null);
        counts.events++;

        // Review, some hours later (or not yet).
        const r = rand();
        const age = now - ts;
        const delay = Math.round((0.3 + rand() * rand() * 40) * HOUR);
        const status = delay > age ? null : r < 0.72 ? 'approved' : r < 0.8 ? 'rejected' : null;
        if (status) {
          insEvent.run(team.id, repoId, machine, nextId(repoId, `${machine}#e`), ts + delay, run, 'review', null, status === 'rejected' && rand() < 0.5 ? 'rejected: tests do not cover the retry path' : status);
          counts.events++;
        }
        // Some runs are undone (rejected ones more often).
        if (rand() < (status === 'rejected' ? 0.55 : 0.04)) {
          const ut = ts + delay + 10 * MIN;
          const undoRun = `undo:${ut}`;
          for (const t of touched.slice(0, 2)) {
            insChange.run(team.id, repoId, machine, nextId(repoId, machine), undoRun, `undo ${label}`, 0, repo.name, t.file, 0, t.added, ut);
            counts.changes++;
          }
          insEvent.run(team.id, repoId, machine, nextId(repoId, `${machine}#e`), ut, `human:${machine.split('-')[0]}`, 'undo', touched[0].file, `revert: ${label}`);
          counts.events++;
        }

        // The commit, with its provenance note (repos with grapim init only).
        if (repo.provenance && (status !== 'rejected' || rand() < 0.35) && rand() < 0.75) {
          const commitTs = Math.round(ts + (0.2 + rand() * 3) * HOUR);
          const files = {};
          let ai = 0;
          for (const t of touched) {
            const keep = Math.max(1, Math.round(t.added * (0.6 + rand() * 0.4)));
            const at = 1 + Math.floor(rand() * 200);
            files[t.file] = [...(files[t.file] ?? []), [at, at + keep - 1, 0, 1]];
            ai += keep;
          }
          // People's lines in the same commit; fewer as agents take over.
          const human = Math.round(ai * (1.6 - progress * 1.1) * (0.4 + rand()));
          const db_ = rand();
          const note = {
            v: 1,
            tool: 'grapim/0.1.0',
            runs: [{ id: run, label, kind: a.kind, turns: [{ turn: 1, intent }], review: status ?? 'pending' }],
            files,
            commit: { ts: commitTs, added: ai + human, ...(db_ < 0.75 ? { default_branch: true } : db_ < 0.85 ? { default_branch: false } : {}) },
          };
          if (commitTs < now) {
            insNote.run(team.id, repoId, sha1(`${seedHex} commit`), JSON.stringify(note), Math.min(now, Math.round(commitTs + rand() * 2 * HOUR)));
            counts.notes++;
          }
        }
      }
      // Commits with no agent lines (people only), so the share has a real denominator.
      if (repo.provenance && weekday) {
        const n = Math.floor(rand() * 3);
        for (let k = 0; k < n; k++) {
          const commitTs = Math.round(day + (9 + rand() * 9) * HOUR);
          if (commitTs >= now) continue;
          const note = { v: 1, tool: 'grapim/0.1.0', runs: [], files: {}, commit: { ts: commitTs, added: 5 + Math.floor(rand() * 120), default_branch: true } };
          insNote.run(team.id, repoId, sha1(`${team.id}${repo.name}${day}h${k}`), JSON.stringify(note), commitTs + HOUR);
          counts.notes++;
        }
      }
    }
    for (const m of machines) insMachine.run(team.id, repoId, m, owner.id, 'seed', ids.get(`${repoId}|${m}`) ?? 0, ids.get(`${repoId}|${m}#e`) ?? 0, 0, now - Math.round(rand() * HOUR));
  }
  return counts;
}

// A run with real content and two turns: idempotency keys for POST /orders.
const IDEMPOTENCY_RUN = 'claude-code:7f3e21aa-55b0-4e0c-9d61-2f0c9a1b7e10';
const IDEMPOTENCY_FILES = [
  ['src/routes/orders.ts', "import { Router } from 'express';\nimport { createOrder } from '../orders/create';\n\nexport const orders = Router();\n\norders.post('/orders', async (req, res) => {\n  const order = await createOrder(req.body);\n  res.status(201).json(order);\n});\n", "import { Router } from 'express';\nimport { createOrder } from '../orders/create';\nimport { withIdempotency } from '../lib/idempotency';\n\nexport const orders = Router();\n\n// A retried POST with the same Idempotency-Key returns the first answer\n// instead of creating a second order.\norders.post('/orders', withIdempotency({ ttlSeconds: 24 * 60 * 60 }), async (req, res) => {\n  const order = await createOrder(req.body, { idempotencyKey: req.get('Idempotency-Key') });\n  res.status(201).json(order);\n});\n"],
  ['src/lib/idempotency.ts', null, "import type { RequestHandler } from 'express';\nimport { redis } from './redis';\n\nexport function withIdempotency({ ttlSeconds }: { ttlSeconds: number }): RequestHandler {\n  return async (req, res, next) => {\n    const key = req.get('Idempotency-Key');\n    if (!key) return next();\n    const seen = await redis.get(`idem:${key}`);\n    if (seen) return res.status(200).json(JSON.parse(seen));\n    const send = res.json.bind(res);\n    res.json = (body) => {\n      redis.set(`idem:${key}`, JSON.stringify(body), { EX: ttlSeconds });\n      return send(body);\n    };\n    next();\n  };\n}\n"],
  ['test/orders.test.ts', "import { request } from './helpers';\n\ntest('creates an order', async () => {\n  const res = await request.post('/orders').send({ sku: 'A1' });\n  expect(res.status).toBe(201);\n});\n", "import { request } from './helpers';\n\ntest('creates an order', async () => {\n  const res = await request.post('/orders').send({ sku: 'A1' });\n  expect(res.status).toBe(201);\n});\n\ntest('a retried POST with the same key creates one order', async () => {\n  const first = await request.post('/orders').set('Idempotency-Key', 'k1').send({ sku: 'A1' });\n  const again = await request.post('/orders').set('Idempotency-Key', 'k1').send({ sku: 'A1' });\n  expect(again.body.id).toBe(first.body.id);\n});\n"],
];

// Everything around the run history, on a team seedRunHistory wrote:
// members, who owns which machine, hub reviews, a run with real diffs, agents
// active now, the GitHub App with two open pull requests and a 90-day scan,
// path rules, merged runs, machine tokens and a workspace with agent files.
//
// opts: {
//   teamId, now,
//   users: [{ id, login, name }], the owner first (already a member),
//   machines: { machine name: user id } (the agents' machines and CI),
//   installation: { id, accountId, login } for the GitHub rows,
//   workspace: false to skip the workspace (it is kept if it already exists),
// }
export async function seedTeamExtras(hub, { teamId, users, machines, installation, now = hub.now(), workspace = true }) {
  const { db } = hub;
  const TEAM = teamId;
  const [owner, second, third] = users;
  const repoId = (name) => repoIdOf(TEAM, name);

  tx(db, () => {
    const insUser = db.prepare(
      `INSERT INTO users (id, login, name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET login = excluded.login, name = excluded.name, updated_at = excluded.updated_at`,
    );
    for (const u of users) insUser.run(u.id, u.login, u.name, now - 40 * DAY, now);
    for (const u of users.slice(1)) db.prepare("INSERT OR IGNORE INTO members (team_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").run(TEAM, u.id, now - 30 * DAY);

    // Who synced what: the owner's laptop, the others' machines and CI.
    for (const [machine, user] of Object.entries(machines)) db.prepare('UPDATE machines SET user_id = ? WHERE team_id = ? AND machine = ?').run(user, TEAM, machine);

    // The seed spreads today's runs over working hours, some later than now: drop those.
    for (const t of ['h_changes', 'h_events']) db.prepare(`DELETE FROM ${t} WHERE team_id = ? AND ts > ?`).run(TEAM, now - 5 * MIN);
    db.prepare('DELETE FROM h_provenance WHERE team_id = ? AND received_at > ?').run(TEAM, now);
    db.prepare('UPDATE h_agents SET last_seen = MIN(last_seen, ?) WHERE team_id = ?').run(now - 70 * MIN, TEAM);

    // Hub reviews: everything older than a day and a half is reviewed, a few hours after it ended, by
    // someone other than whoever synced it; newer runs wait. Written as HubReviews.record() writes them
    // (src/hub/reviews.js), the newest change of the run as seen_change, in one pass.
    const runs = db.prepare('SELECT repo_id, run, MAX(machine) AS machine, MAX(ts) AS ts, MAX(id) AS head FROM h_changes WHERE team_id = ? GROUP BY repo_id, run').all(TEAM);
    const review = db.prepare("INSERT INTO hub_reviews (team_id, repo_id, run, status, reviewer_user_id, reviewed_at, note, seen_change, via, rules) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'hub', NULL)");
    for (const r of runs) {
      if (r.run.startsWith('undo:') || now - r.ts < 1.5 * DAY) continue;
      const by = machines[r.machine];
      const reviewer = users.find((u) => u.id !== by).id;
      const status = sha1(r.run).charCodeAt(0) % 9 === 0 ? 'rejected' : 'approved';
      const at = Math.min(now - 30 * MIN, r.ts + (1 + (parseInt(sha1(r.run).slice(0, 4), 16) % 20)) * 60 * MIN);
      review.run(TEAM, r.repo_id, r.run, status, reviewer, at, status === 'rejected' ? 'Tests do not cover the retry path.' : null, r.head);
    }
  });

  // Machine tokens, one per person's machine (the tokens themselves are
  // never kept: nobody can sync with them).
  const team = hub.teams.get(TEAM);
  for (const [name, userId] of [['dana-mbp', owner.id], ['sam-desktop', second.id], ['priya-mbp', third.id], ['ci-runner', second.id]]) {
    try {
      hub.teams.createToken(TEAM, { role: 'member', userId }, name);
    } catch {}
  }

  // A run with real content and two turns, synced from the second person's desktop.
  const blobs = {};
  const put = (s) => {
    if (s === null) return null;
    const b = Buffer.from(s);
    blobs[sha1(b)] = b.toString('base64');
    return sha1(b);
  };
  const run = IDEMPOTENCY_RUN;
  const t0 = now - 50 * MIN;
  const lines = (s) => (s ? s.split('\n').length - 1 : 0);
  const batch = parseBatch({
    repo: { id: repoId('shop-api'), name: 'shop-api' },
    machine: 'sam-desktop',
    cursor: { changes: 0, events: 0, agents: 0 },
    runs: [{ run, turn: 2, started_at: t0 }],
    agents: [{ agent: run, label: 'claude 7f3e21aa', intent: 'Add idempotency keys to POST /orders', worktree: 'shop-api', last_seen: now - 4 * MIN }],
    changes: IDEMPOTENCY_FILES.map(([p, before, after], i) => ({ id: i + 1, run, label: 'claude 7f3e21aa', turn: i < 2 ? 1 : 2, worktree: 'shop-api', path: p, before_sha: put(before), after_sha: put(after), untracked: false, added: Math.max(1, lines(after) - lines(before) + 2), removed: before ? 2 : 0, ts: t0 + (i + 1) * 6 * MIN })),
    events: [
      { id: 1, ts: t0, agent: run, kind: 'intent', path: null, detail: 'Add idempotency keys to POST /orders' },
      { id: 2, ts: t0 + 15 * MIN, agent: run, kind: 'intent', path: null, detail: 'Now add a test that a retried POST with the same key creates one order' },
    ],
    blobs,
  });
  hub.ingest.apply({ team, token: { id: 'demo-seed', user_id: second.id } }, batch);

  tx(db, () => {
    // Agents working right now.
    const insAgent = db.prepare('INSERT OR REPLACE INTO h_agents (team_id, repo_id, machine, agent, label, intent, worktree, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const [m1, m2] = [Object.keys(machines).find((m) => machines[m] === third.id) ?? 'priya-mbp', 'ci-runner'];
    insAgent.run(TEAM, repoId('web-app'), m1, 'cursor-vscode:4821', 'cursor 4821', 'Split the checkout page into server components', 'web-app', now - 2 * MIN);
    insAgent.run(TEAM, repoId('billing-svc'), m2, 'http:sandbox-3', 'sandbox-3', 'Retry failed Stripe webhooks with backoff', 'billing-svc', now - 9 * MIN);

    // The GitHub App, linked, with two open pull requests holding unreviewed runs.
    const inst = installation.id;
    const org = installation.login;
    db.prepare('INSERT OR REPLACE INTO gh_installations (id, account_id, account_login, account_type, sender_id, team_id, linked_by, linked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(inst, installation.accountId, org, 'Organization', owner.id, TEAM, owner.id, now - 20 * DAY, now - 20 * DAY, now);
    db.prepare("UPDATE repos SET github = ? || '/' || name WHERE team_id = ? AND name IN ('shop-api', 'web-app')").run(org, TEAM);
    hub.github.setPolicy(TEAM, { require_review: true }, owner.id);
    const waiting = db
      .prepare("SELECT run, repo_id FROM h_changes WHERE team_id = ? AND ts > ? AND run NOT LIKE 'undo:%' GROUP BY run ORDER BY MAX(ts) DESC LIMIT 6")
      .all(TEAM, now - 3 * DAY);
    const pull = db.prepare('INSERT OR IGNORE INTO gh_pull_runs (team_id, installation_id, repo_gh_id, owner, name, number, head_sha, run, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const [ghShop, ghWeb] = installation.repoIds ?? [5001, 5002];
    pull.run(TEAM, inst, ghShop, org, 'shop-api', 412, sha1('h412'), run, now - 20 * MIN);
    for (const w of waiting.slice(0, 2)) pull.run(TEAM, inst, ghShop, org, 'shop-api', 412, sha1('h412'), w.run, now - 20 * MIN);
    for (const w of waiting.slice(2, 4)) pull.run(TEAM, inst, ghWeb, org, 'web-app', 97, sha1('h97'), w.run, now - 3 * 60 * MIN);

    // The 90-day AI history scan, as if it ran when GitHub was linked.
    const scanId = Number(
      db
        .prepare("INSERT INTO gh_history_scans (team_id, status, reason, requested_by, since, created_at, started_at, finished_at, repos_total, repos_done, prs_scanned, capped) VALUES (?, 'done', 'install', ?, ?, ?, ?, ?, 4, 4, ?, '[]')")
        .run(TEAM, owner.id, now - 90 * DAY, now - 20 * DAY, now - 20 * DAY, now - 20 * DAY + 4 * MIN, 0).lastInsertRowid,
    );
    const putPr = db.prepare('INSERT INTO gh_history_prs (scan_id, team_id, repo, number, title, author, merged_at, agents, ai, approved_other, approvers, commits, commits_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const titles = ['Add idempotency keys to POST /orders', 'Retry failed Stripe webhooks with backoff', 'Split checkout into server components', 'Fix flaky cart total test', 'Bump pg to 8.12', 'Move tax calc to billing-svc', 'Add rate limit to /login', 'Cache product images at the edge', 'Terraform: separate staging VPC', 'Refactor invoice PDF renderer', 'Log refunds with request id', 'Drop the legacy v1 coupons table'];
    const people = [...users.map((u) => u.login), 'jordan', 'mei'];
    const mix = [['claude-code', 'Co-authored-by trailer'], ['cursor', 'Co-authored-by trailer'], ['copilot', 'opened the pull request'], ['codex', 'Co-authored-by trailer'], ['claude-code', 'Co-authored-by trailer']];
    let prs = 0;
    for (const [ri, repo] of [`${org}/shop-api`, `${org}/web-app`, `${org}/billing-svc`, `${org}/infra`].entries()) {
      for (let i = 0; i < [64, 51, 38, 21][ri]; i++) {
        const h = parseInt(sha1(`${repo}#${i}`).slice(0, 8), 16);
        const ai = h % 100 < [41, 35, 30, 14][ri];
        const agent = mix[h % mix.length];
        const author = agent[0] === 'copilot' && ai ? 'Copilot' : people[h % people.length];
        const approved = ai ? (h >>> 9) % 100 > 34 : (h >>> 9) % 100 > 10;
        const reviewer = people[(h >> 3) % people.length] === author ? people[(h >> 5) % people.length] : people[(h >> 3) % people.length];
        putPr.run(scanId, TEAM, repo, 900 - i * 3 - ri, titles[h % titles.length], author, now - ((i * 89) % 88) * DAY - (h % 20) * 60 * MIN, JSON.stringify(ai ? [{ agent: agent[0], how: [agent[1]] }] : []), ai ? 1 : 0, approved && reviewer !== author ? 1 : 0, JSON.stringify(approved && reviewer !== author ? [reviewer] : []), 1 + (h % 6), 1 + (h % 6));
        prs++;
      }
    }
    db.prepare('UPDATE gh_history_scans SET prs_scanned = ? WHERE id = ?').run(prs, scanId);

    // Path rules, and runs that reached a merged pull request.
    hub.github.rules.add(TEAM, { pattern: 'src/routes/**', approvals: 2 }, owner.id);
    hub.github.rules.add(TEAM, { pattern: 'src/lib/**', approvals: 1, approvers: [owner.id, third.id] }, owner.id);
    hub.github.rules.add(TEAM, { pattern: '**/migrations/**', approvals: 2, approvers: [owner.id, second.id, third.id] }, owner.id);
    const merged = db.prepare('INSERT OR IGNORE INTO gh_merged_runs (team_id, run, owner, name, number, head_sha, merged_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const done = db.prepare("SELECT DISTINCT r.run, r.reviewed_at FROM hub_reviews r WHERE r.team_id = ? AND r.status = 'approved' ORDER BY r.reviewed_at DESC LIMIT 40").all(TEAM);
    done.forEach((r, i) => merged.run(TEAM, r.run, org, i % 2 ? 'web-app' : 'shop-api', 380 + Math.floor(i / 2), sha1(`m${i}`), r.reviewed_at + 2 * 60 * MIN));
  });

  // A cloud workspace with agent activity, written as agents with a
  // workspace token would. Kept across re-seeds.
  if (workspace && !hub.workspaces.byName(TEAM, 'research-notes')) {
    const ws = hub.workspaces.create(team, { role: 'owner', userId: owner.id }, 'research-notes');
    hub.mount.applyTemplate(ws, 'research', `human:${owner.login}`);
    hub.workspaces.createToken(ws, { role: 'owner', userId: owner.id }, 'e2b', 'write');
    const fsw = hub.mount.engineFor(ws).ctx.workspace;
    const write = (p, text, agent) => fsw.write({ agent: `http:e2b/${agent}`, label: `e2b/${agent}` }, p, Buffer.from(text), {});
    await write('sources/stripe-retries.md', '# Stripe retries\n\nStripe retries a failed webhook for up to 3 days with exponential backoff.\n', 'researcher');
    await write('notes/idempotency.md', '# Idempotency keys\n\n- Keep keys 24 hours.\n- Return the first answer for a retried key.\n', 'researcher');
    await write('drafts/rfc-orders.md', '# RFC: idempotent order creation\n\nStatus: draft\n', 'writer');
    hub.mount.storage?.touch(hub.workspaces.storageKey(ws));
    await hub.mount.measure(ws).catch(() => {});
  }
}
