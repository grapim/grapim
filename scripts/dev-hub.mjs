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
import { DAY, MIN, seedTeamExtras } from '../src/hub/demo-seed.js';
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
  // The team around the run history (src/hub/demo-seed.js, shared with the public demo).
  await seedTeamExtras(hub, {
    teamId: TEAM,
    users: USERS,
    machines: { 'dana-mbp': 1001, 'sam-linux': 1002, 'priya-mbp': 1003, 'ci-runner': 1002 },
    installation: { id: 77001, accountId: 9001, login: 'acme-co' },
    now,
  });

  // Slack, as if a test message just went through.
  hub.notify.save(TEAM, 'https://hooks.slack.com/services/T0DEMO1234/B0DEMO5678/demoDemoDemoDemoDemo8f2c', 1001);
  db.prepare('UPDATE team_notify SET last_ok_at = ? WHERE team_id = ?').run(now - 40 * MIN, TEAM);

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
