#!/usr/bin/env node
// Seeds a local hub database with a demo team whose synced runs, events and
// provenance notes make the Reports tab (docs/provenance.md section 7) look
// like a real team's: 12 weeks of Claude Code, Codex, Cursor and sandbox
// agents across five repos, three of them with `grapim init` (provenance).
//
//   node scripts/seed-reports.mjs [--data .hub-dev] [--weeks 12] [--seed 7] [--reset]
//
// Then start the hub on the same HUB_DATA (see docs/deploy.md) and sign in.
// The demo user is GitHub login "demo"; with --owner <github id> <login> your
// own GitHub account is made the owner of both demo teams instead.
//
// Two teams: "Acme" on governance (full reports) and "Acme Lite" on team (the
// teaser). Deterministic for a given --seed and day. Local development only:
// it refuses a data folder that is not empty of other teams unless --reset.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, tx } from '../src/hub/db.js';
import { ensureReportSchema } from '../src/hub/reports/index.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const dataDir = path.resolve(opt('data', process.env.HUB_DATA || '.hub-dev'));
const WEEKS = Math.min(52, Math.max(1, Number(opt('weeks', 12)) || 12));
const SEED = Number(opt('seed', 7)) || 7;
const reset = args.includes('--reset');
const ownerAt = args.indexOf('--owner');
const owner = ownerAt >= 0 ? { id: Number(args[ownerAt + 1]), login: String(args[ownerAt + 2] || '') } : { id: 1001, login: 'demo' };
if (!Number.isSafeInteger(owner.id) || !owner.login) {
  console.error('--owner needs a GitHub user id and login: --owner 12345 octocat');
  process.exit(2);
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const TEAMS = [
  { id: 'acme-demo-gov', name: 'Acme', plan: 'governance', seats: 8 },
  { id: 'acme-demo-team', name: 'Acme Lite', plan: 'team', seats: 4 },
];

// A small seeded PRNG, so a seed gives the same data.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

const REPOS = [
  { name: 'shop-api', provenance: true, weight: 1.0 },
  { name: 'web-app', provenance: true, weight: 0.8 },
  { name: 'billing-svc', provenance: true, weight: 0.45 },
  { name: 'infra', provenance: false, weight: 0.25 },
  { name: 'docs-site', provenance: false, weight: 0.15 },
];
const MACHINES = ['alex-mbp', 'sam-linux', 'priya-mbp', 'ci-runner'];
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

function main() {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openDb(dataDir);
  ensureReportSchema(db);
  const other = db.prepare(`SELECT COUNT(*) AS n FROM teams WHERE id NOT IN (${TEAMS.map(() => '?').join(',')})`).get(...TEAMS.map((t) => t.id)).n;
  if (other && !reset) {
    console.error(`${dataDir} already has ${other} other team(s). Use a fresh --data folder, or --reset to wipe it.`);
    process.exit(1);
  }
  const now = Date.now();
  const today = Math.floor(now / DAY) * DAY;
  const start = today - (WEEKS * 7 - 1) * DAY;
  const rand = rng(SEED);
  const counts = { runs: 0, changes: 0, events: 0, notes: 0 };

  tx(db, () => {
    if (reset) {
      for (const t of ['h_provenance', 'h_changes', 'h_events', 'h_runs', 'h_agents', 'h_blobs', 'machines', 'repos', 'members', 'machine_tokens', 'invites', 'team_usage']) db.exec(`DELETE FROM ${t}`);
      db.exec('DELETE FROM teams');
    } else {
      for (const t of TEAMS) {
        for (const table of ['h_provenance', 'h_changes', 'h_events', 'h_runs', 'h_agents', 'machines', 'repos', 'members']) db.prepare(`DELETE FROM ${table} WHERE team_id = ?`).run(t.id);
        db.prepare('DELETE FROM teams WHERE id = ?').run(t.id);
      }
    }
    db.prepare(
      `INSERT INTO users (id, login, name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET login = excluded.login, updated_at = excluded.updated_at`,
    ).run(owner.id, owner.login, owner.login, now, now);

    for (const team of TEAMS) {
      db.prepare("INSERT INTO teams (id, name, created_by, created_at, plan, seats, plan_status) VALUES (?, ?, ?, ?, ?, ?, 'active')").run(team.id, team.name, owner.id, start, team.plan, team.seats);
      db.prepare("INSERT INTO members (team_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(team.id, owner.id, start);
    }

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

    // Team 1 gets every repo; team 2 (the teaser) gets shop-api only.
    const plan = [
      { team: TEAMS[0], repos: REPOS },
      { team: TEAMS[1], repos: REPOS.slice(0, 1) },
    ];
    for (const { team, repos } of plan) {
      const ids = new Map(); // machine|repo -> next local id
      const nextId = (repo, machine) => {
        const k = `${repo}|${machine}`;
        const v = (ids.get(k) ?? 0) + 1;
        ids.set(k, v);
        return v;
      };
      for (const repo of repos) {
        const repoId = sha1(`${team.id} ${repo.name} root`);
        insRepo.run(team.id, repoId, repo.name, start - 30 * DAY, now - Math.round(rand() * 2 * HOUR));
        for (let day = start; day <= today; day += DAY) {
          const dow = new Date(day).getUTCDay();
          const weekday = dow !== 0 && dow !== 6;
          const progress = (day - start) / Math.max(DAY, today - start); // AI use grows over the period
          const runsToday = Math.round(repo.weight * (weekday ? 3 + rand() * 5 : rand() * 1.5) * (0.7 + progress * 0.6));
          for (let i = 0; i < runsToday; i++) {
            const seed = sha1(`${team.id}${repo.name}${day}${i}${SEED}`);
            const a = pick(rand, AGENTS);
            const run = a.id(seed);
            const label = a.label(seed);
            const machine = a.kind === 'http' ? 'ci-runner' : MACHINES[Math.floor(rand() * 3)];
            const t0 = Math.round(day + (8 + rand() * 10) * HOUR);
            const intent = INTENTS[Math.floor(rand() * INTENTS.length)];
            const turns = 1 + Math.floor(rand() * 4);
            insRun.run(team.id, repoId, machine, run, turns, t0);
            insAgent.run(team.id, repoId, machine, run, label, intent, repo.name, t0 + turns * 20 * 60 * 1000);
            insEvent.run(team.id, repoId, machine, nextId(repoId, `${machine}#e`), t0, run, 'intent', null, intent);
            counts.runs++;
            counts.events++;
            const nfiles = 1 + Math.floor(rand() * 5);
            const touched = [];
            let written = 0;
            let ts = t0;
            for (let f = 0; f < nfiles; f++) {
              const file = FILES[Math.floor(rand() * FILES.length)];
              const added = 4 + Math.floor(rand() * rand() * 140);
              ts += Math.round(rand() * 15 * 60 * 1000);
              insChange.run(team.id, repoId, machine, nextId(repoId, machine), run, label, 1 + (f % turns), repo.name, file, added, Math.floor(rand() * added * 0.4), ts);
              counts.changes++;
              touched.push({ file, added });
              written += added;
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
              const ut = ts + delay + 10 * 60 * 1000;
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
                insNote.run(team.id, repoId, sha1(`${seed} commit`), JSON.stringify(note), Math.min(now, Math.round(commitTs + rand() * 2 * HOUR)));
                counts.notes++;
              }
            }
          }
          // Commits with no agent lines (people only), so the share has a real denominator.
          if (repo.provenance && weekday) {
            const people = Math.floor(rand() * 3);
            for (let k = 0; k < people; k++) {
              const commitTs = Math.round(day + (9 + rand() * 9) * HOUR);
              if (commitTs >= now) continue;
              const note = { v: 1, tool: 'grapim/0.1.0', runs: [], files: {}, commit: { ts: commitTs, added: 5 + Math.floor(rand() * 120), default_branch: true } };
              insNote.run(team.id, repoId, sha1(`${team.id}${repo.name}${day}h${k}`), JSON.stringify(note), commitTs + HOUR);
              counts.notes++;
            }
          }
        }
        for (const m of MACHINES) insMachine.run(team.id, repoId, m, owner.id, 'seed', ids.get(`${repoId}|${m}`) ?? 0, ids.get(`${repoId}|${m}#e`) ?? 0, 0, now - Math.round(rand() * HOUR));
      }
    }
  });
  db.close();
  console.log(`Seeded ${dataDir}`);
  console.log(`  teams: ${TEAMS.map((t) => `${t.name} (${t.plan}) /hub/teams/${t.id}/reports`).join(', ')}`);
  console.log(`  owner: GitHub user ${owner.login} (id ${owner.id})`);
  console.log(`  ${counts.runs} runs, ${counts.changes} changes, ${counts.events} events, ${counts.notes} provenance notes over ${WEEKS} weeks`);
}

main();
