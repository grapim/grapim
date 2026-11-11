// A platform backend gives an agent in a sandbox its own recorded, undoable
// workspace:
//
//   1. the backend (holding the gpk_ platform key) finds or creates the
//      customer's workspace and mints a short-lived write token for it;
//   2. the agent runs in a separate process (standing in for an E2B or Modal
//      sandbox) that gets only the workspace URL and that token, never the
//      platform key, and writes files with optimistic concurrency;
//   3. the backend lists the workspace's runs and undoes the agent's run.
//
// Run:  GRAPIM_API_KEY=gpk_test_... node sdk/examples/sandbox-agent.mjs
//       (GRAPIM_BASE_URL defaults to https://app.grapim.com)

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// In your app: import { Grapim, NotFoundError, PreconditionFailedError } from '@grapim/sdk';
import { Grapim, NotFoundError, PreconditionFailedError } from '../js/src/index.js';

const AGENT = 'fixer';

if (process.argv[2] === '--agent') await agent();
else await platform();

// ---------------------------------------------------------------- the platform backend

async function platform() {
  const grapim = new Grapim({ apiKey: process.env.GRAPIM_API_KEY, baseUrl: process.env.GRAPIM_BASE_URL });
  const externalId = process.env.CUSTOMER_ID || 'customer_42';

  // One workspace per end customer, found by your own id.
  const found = await grapim.workspaces.list({ external_id: externalId, limit: 1 });
  const ws = found.data[0] ?? (await grapim.workspaces.create({
    external_id: externalId,
    // Workspace names are URL slugs: [a-z0-9-], 1 to 40.
    name: externalId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workspace',
    metadata: { plan: 'pro' },
  }));
  console.log(`workspace ${ws.id} for ${externalId}: ${ws.url}`);

  // A write token for this one workspace, valid 15 minutes, with the agent's name pinned.
  const { token, expires_at } = await grapim.tokens.create(ws.id, { scope: 'write', ttl_seconds: 900, agent_name: AGENT });
  console.log(`minted a write token for ${AGENT}, expires at ${expires_at}`);

  // Start the agent in its "sandbox". It gets the URL and token only.
  await runSandbox({ GRAPIM_WORKSPACE_URL: ws.url, GRAPIM_WORKSPACE_TOKEN: token });

  // What did it do?
  const runs = await grapim.runs.list(ws.id);
  for (const r of runs) console.log(`run ${r.run}: ${r.files} file(s), +${r.added} -${r.removed}, review ${r.review?.status}`);
  const run = runs.find((r) => r.run.endsWith(`/${AGENT}`) || r.label === AGENT);
  if (!run) throw new Error('The agent run is missing.');

  // Look at the plan first, then undo it.
  const plan = await grapim.runs.undo(ws.id, run.run, { apply: false });
  for (const f of plan.files) console.log(`  would ${f.action} ${f.path}${f.reason ? ` (${f.reason})` : ''}`);
  const done = await grapim.runs.undo(ws.id, run.run, { apply: true });
  console.log(`undid ${done.run}: ${done.files.length} file(s), applied=${done.applied}`);

  // Let the customer review in your app: a single-use URL for an iframe.
  const embed = await grapim.embedSessions.create(ws.id, { mode: 'review', ttl_seconds: 600 });
  console.log(`review desk for the customer: ${embed.url}`);
}

function runSandbox(vars) {
  // Only what the agent needs. No GRAPIM_API_KEY.
  const env = { PATH: process.env.PATH ?? '', ...vars };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--agent'], { env, stdio: 'inherit' });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`the agent exited with ${code}`))));
  });
}

// ---------------------------------------------------------------- the agent, in the sandbox

async function agent() {
  if (process.env.GRAPIM_API_KEY) throw new Error('The sandbox must not see the platform key.');
  const ws = Grapim.workspace({
    url: process.env.GRAPIM_WORKSPACE_URL,
    token: process.env.GRAPIM_WORKSPACE_TOKEN,
    agent: AGENT,
    intent: 'Add a README and a config',
  });

  await upsert(ws, 'README.md', (old) => (old ?? '# Demo\n') + '\nEdited by the fixer agent.\n');
  await upsert(ws, 'config/app.json', () => JSON.stringify({ retries: 3 }, null, 2) + '\n');
  await ws.release();

  const files = await ws.list('', { recursive: true });
  console.log(`[agent] the workspace now has ${files.files.map((f) => f.path).join(', ')}`);
}

// Read, change, write back only if nobody wrote in between; on a clash, read again.
async function upsert(ws, path, change) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let text = null;
    let sha = null;
    try {
      const r = await ws.readText(path);
      text = r.text;
      sha = r.sha;
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
    try {
      const w = await ws.write(path, change(text), { ifMatch: sha ?? 'absent' });
      console.log(`[agent] wrote ${path} (${w.sha?.slice(0, 8)})`);
      return w;
    } catch (e) {
      if (!(e instanceof PreconditionFailedError)) throw e;
      console.log(`[agent] ${path} changed under us (now ${e.currentSha?.slice(0, 8) ?? 'absent'}), retrying`);
    }
  }
  throw new Error(`${path} kept changing`);
}
