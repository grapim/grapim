#!/usr/bin/env node
// Grapim on Martian's offline Code Review Bench (50 PRs, golden comments as
// text; github.com/withmartian/code-review-benchmark, MIT), judged the same
// way as the tools already published there.
//
//   node bench/martian.mjs judge --tool grapim-lean [--results bench/results-martian]
//   node bench/martian.mjs judge --published coderabbit,kodus-v2,claude-code
//   node bench/martian.mjs score [--results bench/results-martian]
//
// judge: for every PR one request to a judge model with the golden comments and
// the tool's candidate issues; it answers which candidates name the same
// underlying issue as which golden comment (the benchmark's own judge prompt,
// asked for the whole PR at once instead of pair by pair). A Grapim candidate
// is one posted finding (path, line, title, body). A published tool's
// candidates are the ones in Martian's evaluation file, so the same judge can
// be run over them: its agreement with the published verdicts says how far our
// judge is from theirs. Judging goes through the Claude Code CLI (cli-provider.mjs),
// billed to the Claude plan of the shell; BENCH_JUDGE_MODEL picks the model.
//
// score: precision, recall and F1 per tool, "core" profile (the benchmark's
// default: style and speculative golden comments do not count for recall) and
// all categories, next to the published numbers for the published tools.
//
// Data (not in the repo; put it in bench/cache/martian/):
//   benchmark_data.json      offline/results/benchmark_data.json of the benchmark repo
//   evaluations-opus-4-5.json  offline/results/anthropic_claude-opus-4-5-20251101/evaluations.json

import fs from 'node:fs';
import path from 'node:path';
import { BENCH_DIR, CACHE_DIR } from './lib/gh.mjs';
import { claudeCliProvider } from './lib/cli-provider.mjs';
import { cleanEnv } from './lib/adapters.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const log = (s) => process.stderr.write(`${s}\n`);

const DATA = path.join(CACHE_DIR, 'martian');
const resultsDir = path.resolve(opt('results', path.join(BENCH_DIR, 'results-martian')));
const judgeDir = path.join(resultsDir, 'judge');
const JUDGE_MODEL = process.env.BENCH_JUDGE_MODEL || 'claude-opus-5-5';
const CORE = new Set(['bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect']);

const bd = JSON.parse(fs.readFileSync(path.join(DATA, 'benchmark_data.json'), 'utf8'));
const dataset = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, 'data', 'martian.json'), 'utf8')).prs;
const published = () => JSON.parse(fs.readFileSync(path.join(DATA, 'evaluations-opus-4-5.json'), 'utf8'));

// The benchmark's judge prompt (step3_judge_comments.py), for all pairs of one PR.
const JUDGE_SYSTEM = `You are evaluating AI code review tools.
For one pull request you get the golden (expected) comments and the candidate issues from a tool's review. For every golden comment, determine which candidate issues match it.

Instructions:
- A candidate matches a golden comment if it identifies the SAME underlying issue as the golden comment
- Accept semantic matches - different wording is fine if it's the same problem
- Focus on whether they point to the same bug, concern, or code issue
- A golden comment can have no matching candidate, and a candidate can match no golden comment
- Judge every pair on its own; do not assume each candidate must match something

Answer with JSON: for every golden comment, the numbers of the candidates that match it (an empty list when none does), your confidence (0.0-1.0) in that verdict, and a brief reasoning.`;

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goldens'],
  properties: {
    goldens: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['golden', 'matches', 'confidence', 'reasoning'],
        properties: {
          golden: { type: 'integer', description: 'The number of the golden comment (G1 is 1).' },
          matches: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the candidates that identify the same underlying issue (C1 is 1). Empty when none does.' },
          confidence: { type: 'number' },
          reasoning: { type: 'string' },
        },
      },
    },
  },
};

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)} [...]` : String(s));

function judgeBody(goldens, candidates) {
  const text = [
    'GOLDEN COMMENTS',
    ...goldens.map((g, i) => `G${i + 1}: ${g.comment}`),
    '',
    'CANDIDATE ISSUES',
    ...candidates.map((c, i) => `C${i + 1}: ${clip(c, 1500)}`),
  ].join('\n');
  return {
    model: JUDGE_MODEL,
    system: [{ type: 'text', text: JUDGE_SYSTEM }],
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: JUDGE_SCHEMA } },
  };
}

// Candidates of one tool on one PR: [text].
function grapimCandidates(tool, pr) {
  const file = path.join(resultsDir, tool, `${pr.id}.json`);
  if (!fs.existsSync(file)) return null;
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (r.status !== 'ok') return null;
  return r.findings.map((f) => `${f.path}:${f.line} - ${f.title}. ${f.body}`);
}
function publishedCandidates(ev, tool, pr) {
  const x = ev[pr.url]?.[tool];
  if (!x || x.skipped) return null;
  return [...new Set([...x.true_positives.map((a) => a.matched_candidate), ...x.false_positives.map((a) => a.candidate)].filter(Boolean))];
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function judgeTool(tool, candidatesOf, { concurrency }) {
  const outDir = path.join(judgeDir, tool);
  fs.mkdirSync(outDir, { recursive: true });
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const provider = claudeCliProvider({ model: JUDGE_MODEL, env: { ...cleanEnv(), ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}) } });
  let done = 0;
  try {
    await pool(dataset, concurrency, async (pr) => {
      const file = path.join(outDir, `${pr.id}.json`);
      done++;
      if (!args.includes('--force') && fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).status === 'ok') return;
      const goldens = bd[pr.url].golden_comments;
      const candidates = candidatesOf(pr);
      if (candidates === null) return log(`[${done}/${dataset.length}] ${tool} ${pr.id}: no review to judge`);
      let out = { tool, pr_id: pr.id, url: pr.url, judge: JUDGE_MODEL, status: 'ok', goldens: goldens.map((g) => ({ ...g, matches: [] })), candidates };
      if (candidates.length && goldens.length) {
        try {
          const msg = await provider.send(judgeBody(goldens, candidates));
          const j = JSON.parse(msg.content[0].text);
          for (const g of j.goldens ?? []) {
            const slot = out.goldens[g.golden - 1];
            if (!slot) continue;
            slot.matches = [...new Set((g.matches ?? []).filter((m) => Number.isInteger(m) && m >= 1 && m <= candidates.length))];
            slot.confidence = g.confidence;
            slot.reasoning = g.reasoning;
          }
        } catch (err) {
          out = { ...out, status: 'error', note: String(err.message).slice(0, 400) };
        }
      }
      fs.writeFileSync(file, JSON.stringify(out, null, 1));
      log(`[${done}/${dataset.length}] ${tool} ${pr.id}: ${out.status}, ${out.goldens.filter((g) => g.matches.length).length}/${goldens.length} golden matched, ${candidates.length} candidates`);
    });
  } finally {
    provider.close();
  }
}

// tp / fp / fn of one judged tool. profile: null for every category, or a Set.
function tally(tool, profile, only = null) {
  const dir = path.join(judgeDir, tool);
  let tp = 0, fn = 0, fp = 0, cand = 0, prs = 0;
  if (!fs.existsSync(dir)) return null;
  for (const pr of dataset) {
    if (only && !only.has(pr.id)) continue;
    const file = path.join(dir, `${pr.id}.json`);
    if (!fs.existsSync(file)) continue;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j.status !== 'ok') continue;
    prs++;
    cand += j.candidates.length;
    const matched = new Set();
    for (const g of j.goldens) {
      for (const m of g.matches) matched.add(m);
      if (profile && !profile.has(g.category)) continue;
      if (g.matches.length) tp++;
      else fn++;
    }
    // A candidate that matches any golden comment (also one outside the profile) is not a false positive.
    fp += j.candidates.length - matched.size;
  }
  return { prs, cand, tp, fp, fn };
}
function tallyPublished(ev, tool, profile, only = null) {
  let tp = 0, fn = 0, fp = 0, cand = 0, prs = 0;
  const cat = {};
  for (const p of Object.values(bd)) for (const g of p.golden_comments) cat[g.comment] = g.category;
  for (const pr of dataset) {
    if (only && !only.has(pr.id)) continue;
    const x = ev[pr.url]?.[tool];
    if (!x || x.skipped) continue;
    prs++;
    cand += x.total_candidates;
    fp += x.fp;
    for (const a of x.true_positives) if (!profile || profile.has(a.category ?? cat[a.golden_comment])) tp++;
    for (const a of x.false_negatives) if (!profile || profile.has(a.category ?? cat[a.golden_comment])) fn++;
  }
  return { prs, cand, tp, fp, fn };
}
const prf = (t) => {
  const p = t.tp + t.fp ? t.tp / (t.tp + t.fp) : 0;
  const r = t.tp + t.fn ? t.tp / (t.tp + t.fn) : 0;
  return { p, r, f1: p + r ? (2 * p * r) / (p + r) : 0 };
};
const pc = (x) => `${(100 * x).toFixed(1)}%`;

if (cmd === 'judge') {
  const concurrency = Number(opt('concurrency', 4));
  if (opt('tool')) for (const t of opt('tool').split(',')) await judgeTool(t, (pr) => grapimCandidates(t, pr), { concurrency });
  if (opt('published')) {
    const ev = published();
    for (const t of opt('published').split(',')) await judgeTool(`published-${t}`, (pr) => publishedCandidates(ev, t, pr), { concurrency });
  }
  log(`judgements in ${judgeDir}; score with: node bench/martian.mjs score`);
} else if (cmd === 'score') {
  const ev = fs.existsSync(path.join(DATA, 'evaluations-opus-4-5.json')) ? published() : null;
  const tools = fs.existsSync(judgeDir) ? fs.readdirSync(judgeDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  // Every tool is scored on the PRs that have a verdict for all of them.
  const judged = (t) => new Set(dataset.filter((pr) => { const f = path.join(judgeDir, t, `${pr.id}.json`); return fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')).status === 'ok'; }).map((pr) => pr.id));
  const sets = tools.map(judged).filter((x) => x.size);
  const common = new Set(dataset.map((pr) => pr.id).filter((id) => sets.every((x) => x.has(id))));
  const L = [];
  L.push(`# Martian offline Code Review Bench: ${dataset.length} PRs, ${dataset.reduce((n, p) => n + bd[p.url].golden_comments.length, 0)} golden comments`, '');
  L.push(`Scored on the ${common.size} PRs that have a verdict for every tool listed.`, '');
  L.push(`Judge for the "our judge" rows: ${JUDGE_MODEL}, one request per PR. "published" rows: Martian's own verdicts (judge claude-opus-4-5, pair by pair).`, '');
  for (const [name, profile] of [['Core profile (the benchmark default)', CORE], ['All categories', null]]) {
    L.push(`## ${name}`, '', '| Tool | Verdicts | PRs | Candidates / PR | Precision | Recall | F1 |', '|---|---|---|---|---|---|---|');
    const row = (label, who, t) => {
      const s = prf(t);
      L.push(`| ${label} | ${who} | ${t.prs} | ${(t.cand / Math.max(1, t.prs)).toFixed(1)} | ${pc(s.p)} (${t.tp}/${t.tp + t.fp}) | ${pc(s.r)} (${t.tp}/${t.tp + t.fn}) | ${pc(s.f1)} |`);
    };
    for (const t of tools) {
      const mine = tally(t, profile, common);
      if (!mine || !mine.prs) continue;
      row(t.replace(/^published-/, ''), 'our judge', mine);
      if (ev && t.startsWith('published-')) row(t.replace(/^published-/, ''), 'published', tallyPublished(ev, t.replace(/^published-/, ''), profile, common));
    }
    L.push('');
  }
  const text = L.join('\n');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'report-martian.md'), text);
  process.stdout.write(`${text}\n`);
} else {
  log('usage: node bench/martian.mjs judge --tool <grapim tool> | --published <tool,tool> ; node bench/martian.mjs score');
  process.exit(2);
}
