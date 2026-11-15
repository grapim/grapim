#!/usr/bin/env node
// Runs the reviewers on the benchmark PRs and saves each raw result to
// bench/results/<tool>/<owner>__<repo>__<n>.json.
//
//   node bench/run.mjs --estimate                 token and USD estimate, no model calls
//   node bench/run.mjs --dry                      whole pipeline against a local fake model
//   node bench/run.mjs --check                    ground-truth lines exist on the reviewed heads
//   node bench/run.mjs --via-cli --tools grapim-lean --split dev
//                                                 tuning run through the logged-in Claude Code CLI (plan, not API key)
//   node bench/run.mjs [--tools grapim,pr-agent,claude-action] [--only <id,...>]
//                      [--split dev|test] [--limit N] [--max-usd N]
//                      [--concurrency 2] [--force] [--verbose]
//
// A real run (no --dry, no --estimate) calls the model with ANTHROPIC_API_KEY
// and refuses to start without --yes, so nothing is spent by accident.
// Git data comes from GitHub over HTTPS into bench/cache/ (free, read-only).

import fs from 'node:fs';
import path from 'node:path';
import { BENCH_DIR, CACHE_DIR } from './lib/gh.mjs';
import { fetchPr, prRepo, warm } from './lib/git.mjs';
import { ADAPTERS, DEFAULT_TOOLS, MODEL } from './lib/adapters.mjs';
import { estimatePr, ASSUMPTIONS } from './lib/estimate.mjs';
import { costUsd } from './lib/score-lib.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);
const log = (s) => process.stderr.write(`${s}\n`);

const dry = flag('dry');
const estimate = flag('estimate');
const tools = opt('tools', estimate ? 'grapim,grapim-noprov,pr-agent,claude-action' : DEFAULT_TOOLS.join(',')).split(',');
for (const t of tools) if (!ADAPTERS[t]) throw new Error(`unknown tool ${t}; tools: ${Object.keys(ADAPTERS).join(', ')}`);
const dataset = JSON.parse(fs.readFileSync(opt('data', path.join(BENCH_DIR, 'data', 'prs.json')), 'utf8'));
let prs = dataset.prs;
if (opt('only')) prs = prs.filter((p) => opt('only').split(',').includes(p.id));
// --split dev|test: one half of bench/data/split.json (dev is for tuning, test is held out).
if (opt('split')) {
  const half = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, 'data', 'split.json'), 'utf8'))[opt('split')];
  if (!Array.isArray(half)) throw new Error('--split must be dev or test');
  prs = prs.filter((p) => half.includes(p.id));
}
if (opt('limit')) prs = prs.slice(0, Number(opt('limit')));
// --via-cli: a tuning run of the Grapim variants through the logged-in Claude
// Code CLI, billed to that Claude plan and not to an API key. Its results go
// to bench/results-cli, never next to the API-metered ones.
const viaCli = flag('via-cli');
if (viaCli && tools.some((t) => !t.startsWith('grapim') && t !== 'claude-action')) throw new Error('--via-cli runs the grapim variants and claude-action only');
const resultsDir = path.resolve(opt('results', dry ? path.join(CACHE_DIR, 'dry-results') : path.join(BENCH_DIR, viaCli ? 'results-cli' : 'results')));

if (!dry && !estimate && !flag('check') && !viaCli) {
  if (!flag('yes')) {
    log('A real run calls claude-opus-5-5 for every PR and tool and costs money. Run --estimate first, then add --yes to start.');
    process.exit(2);
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.GRAPIM_REVIEW_PROVIDER) {
    log('Set ANTHROPIC_API_KEY (see bench/README.md).');
    process.exit(2);
  }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

const ctx = {
  dry,
  viaCli,
  verbose: flag('verbose'),
  log,
  intentChars: Number(opt('intent-chars', 1000)),
  claudeMaxTurns: Number(opt('max-turns', 60)),
  gitDir: (pr) => prRepo(pr, { fresh: false }),
  workDir(pr, tool) {
    const d = path.join(CACHE_DIR, 'work', pr.id, tool);
    fs.mkdirSync(d, { recursive: true });
    return d;
  },
};

// PRs of one repository run one after another (they share a clone).
const byRepo = new Map();
for (const p of prs) byRepo.set(p.repo, [...(byRepo.get(p.repo) ?? []), p]);

// --check: every ground-truth issue points at a file of the reviewed head and
// at (or within 10 lines of) a line the PR added. No model calls.
if (flag('check')) {
  const { prDiff, addedRanges, git: g } = await import('./lib/git.mjs');
  let bad = 0;
  await pool([...byRepo.values()], Number(opt('concurrency', 6)), async (group) => {
    for (const pr of group) {
      try {
        await fetchPr(pr, { log });
        const dir = prRepo(pr);
        const added = addedRanges(prDiff(dir, pr));
        for (const iss of pr.issues) {
          const exists = g(dir, ['cat-file', '-e', `${pr.head_sha}:${iss.path}`], { allowFail: true }) !== null;
          const near = Number.isFinite(iss.line) && (added[iss.path] ?? []).some(([s, e]) => iss.line >= s - 10 && iss.line <= e + 10);
          const status = !exists ? (iss.line === null ? 'ok (deleted file)' : 'FILE NOT AT HEAD') : iss.line === null ? 'ok (no line)' : near ? 'ok' : 'LINE NOT NEAR AN ADDED LINE';
          if (!status.startsWith('ok')) bad++;
          log(`${status.padEnd(28)} ${pr.id} ${iss.path}:${iss.line}`);
        }
      } catch (err) {
        bad++;
        log(`ERROR ${pr.id}: ${err.message}`);
      }
    }
  });
  log(`${bad} problems`);
  process.exit(bad ? 1 : 0);
}

if (estimate) {
  const rows = [];
  await pool([...byRepo.values()], Number(opt('concurrency', 3)), async (group) => {
    for (const pr of group) {
      try {
        await fetchPr(pr, { log });
        prRepo(pr);
        rows.push({ id: pr.id, ...estimatePr(pr, ctx.gitDir(pr)) });
      } catch (err) {
        log(`${pr.id}: ${err.message}`);
      }
    }
  });
  const sum = (t, k) => rows.reduce((n, r) => n + (r[t]?.[k] ?? 0), 0);
  const L = [];
  L.push(`Estimate for ${rows.length} of ${prs.length} PRs, model ${MODEL} ($4 / $20 per MTok in / out, cache read $0.20, cache write $5).`);
  L.push(`Diff size: median ${rows.map((r) => r.diffTokens).sort((a, b) => a - b)[rows.length >> 1] ?? 0} tokens, max ${Math.max(0, ...rows.map((r) => r.diffTokens))}.`);
  L.push('');
  L.push('| Tool | Requests | Input tok | Cache write | Cache read | Output tok | USD total | USD / PR |');
  L.push('|---|---|---|---|---|---|---|---|');
  let grand = 0;
  for (const t of tools) {
    const usd = sum(t, 'usd');
    grand += usd;
    L.push(`| ${t} | ${sum(t, 'requests')} | ${sum(t, 'input').toLocaleString('en-US')} | ${sum(t, 'cacheWrite').toLocaleString('en-US')} | ${sum(t, 'cacheRead').toLocaleString('en-US')} | ${sum(t, 'output').toLocaleString('en-US')} | $${usd.toFixed(2)} | $${(usd / Math.max(1, rows.length)).toFixed(3)} |`);
  }
  L.push('', `All tools, one pass: $${grand.toFixed(2)}. Output-token and agent-turn figures are assumptions (bench/lib/estimate.mjs): ${JSON.stringify(ASSUMPTIONS)}`);
  fs.mkdirSync(path.join(CACHE_DIR), { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, 'estimate.json'), JSON.stringify(rows, null, 1));
  process.stdout.write(L.join('\n') + '\n');
  process.exit(0);
}

let done = 0;
const total = prs.length * tools.length;
// --max-usd N: stop starting new reviews once this run has spent N dollars
// (metered from real usage). A review already in flight can still finish,
// so set it a little under the real limit.
const maxUsd = opt('max-usd', null) == null ? Infinity : Number(opt('max-usd'));
let spent = 0;
let capped = false;
// A --via-cli run reviews one PR at a time: it names the repository in GIT_DIR (adapters.mjs).
await pool([...byRepo.values()], viaCli ? 1 : Number(opt('concurrency', 2)), async (group) => {
  for (const pr of group) {
    try {
      await fetchPr(pr, { log });
      await warm(prRepo(pr), pr, { commits: tools.includes('grapim') });
    } catch (err) {
      log(`${pr.id}: git: ${err.message}`);
      continue;
    }
    for (const tool of tools) {
      const file = path.join(resultsDir, tool, `${pr.id}.json`);
      done++;
      if (!flag('force') && fs.existsSync(file)) {
        const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (prev.status === 'ok') continue;
      }
      if (spent >= maxUsd) {
        if (!capped) log(`Spend cap reached: $${spent.toFixed(2)} of $${maxUsd}. No new reviews start.`);
        capped = true;
        continue;
      }
      const t0 = Date.now();
      let r;
      try {
        r = await ADAPTERS[tool](pr, ctx);
      } catch (err) {
        r = { status: 'error', note: err.stack ?? err.message };
      }
      const out = { tool, pr_id: pr.id, url: pr.url, head_sha: pr.head_sha, model: MODEL, dry, at: new Date().toISOString(), seconds: r.seconds ?? (Date.now() - t0) / 1000, ...r };
      out.cost_usd = costUsd(out.usage);
      if (!dry) spent += out.cost_usd || 0;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(out, null, 1));
      log(`[${done}/${total}] ${tool} ${pr.id}: ${out.status}${out.status === 'ok' ? `, ${out.findings.length} findings, ${out.usage?.requests ?? 0} requests, $${out.cost_usd.toFixed(3)}, ${out.seconds.toFixed(0)} s` : ` (${String(out.note ?? '').split('\n')[0].slice(0, 200)})`}`);
    }
  }
});
if (!dry) log(`Spent this run: $${spent.toFixed(2)}${capped ? ' (stopped at the cap; re-run to continue)' : ''}.`);
log(`results in ${resultsDir}; score with: node bench/score.mjs${dry ? ' --dry' : ''}`);
