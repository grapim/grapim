#!/usr/bin/env node
// Seeds a local hub database with a demo team whose synced runs, events and
// provenance notes make the Reports tab (docs/provenance.md section 7) look
// like a real team's: 12 weeks of Claude Code, Codex, Cursor and sandbox
// agents across five repos, three of them with `grapim init` (provenance).
// The data itself comes from src/hub/demo-seed.js (shared with the public
// demo, src/hub/demo.js, and scripts/dev-hub.mjs).
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

import fs from 'node:fs';
import path from 'node:path';
import { openDb, tx } from '../src/hub/db.js';
import { ensureReportSchema } from '../src/hub/reports/index.js';
import { REPOS, seedRunHistory } from '../src/hub/demo-seed.js';

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

const TEAMS = [
  { id: 'acme-demo-gov', name: 'Acme', plan: 'governance', seats: 8 },
  { id: 'acme-demo-team', name: 'Acme Lite', plan: 'team', seats: 4 },
];

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
    // Team 1 gets every repo; team 2 (the teaser) gets shop-api only.
    const plan = [
      { team: TEAMS[0], repos: REPOS },
      { team: TEAMS[1], repos: REPOS.slice(0, 1) },
    ];
    for (const { team, repos } of plan) {
      const c = seedRunHistory(db, { team, owner, repos, weeks: WEEKS, seed: SEED, now });
      for (const k of Object.keys(counts)) counts[k] += c[k];
    }
  });
  db.close();
  console.log(`Seeded ${dataDir}`);
  console.log(`  teams: ${TEAMS.map((t) => `${t.name} (${t.plan}) /hub/teams/${t.id}/reports`).join(', ')}`);
  console.log(`  owner: GitHub user ${owner.login} (id ${owner.id})`);
  console.log(`  ${counts.runs} runs, ${counts.changes} changes, ${counts.events} events, ${counts.notes} provenance notes over ${WEEKS} weeks`);
}

main();
