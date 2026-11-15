#!/usr/bin/env node
// Scores the reviewers' saved outputs against the ground truth.
//
//   node bench/score.mjs [--results bench/results] [--tools grapim,pr-agent,claude-action]
//                        [--split dev|test] [--window 10] [--judge] [--dry]
//
// Writes <results>/report.md and <results>/scores.json and prints the table.
// --judge (off by default) asks claude-opus-5-5 whether each finding on the
// same file as an issue describes that issue, and uses its answer instead of
// the line/category rule for those pairs. It costs model calls (about one
// small request per such pair); --dry answers them locally with "no".

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BENCH_DIR, CACHE_DIR } from './lib/gh.mjs';
import { scoreTool, reportMarkdown, samePath } from './lib/score-lib.mjs';
import { DEFAULT_TOOLS } from './lib/adapters.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const dry = args.includes('--dry');
const resultsDir = path.resolve(opt('results', dry ? path.join(CACHE_DIR, 'dry-results') : path.join(BENCH_DIR, 'results')));
const window = Number(opt('window', 10));
const dataset = JSON.parse(fs.readFileSync(opt('data', path.join(BENCH_DIR, 'data', 'prs.json')), 'utf8'));
// --split dev|test: score one half of bench/data/split.json (dev is the half
// used for tuning; test is held out, so its score is the honest one).
const split = opt('split', null);
const half = split ? JSON.parse(fs.readFileSync(path.join(BENCH_DIR, 'data', 'split.json'), 'utf8'))[split] : null;
if (split && !Array.isArray(half)) throw new Error('--split must be dev or test');
const prs = dataset.prs.filter((p) => (!opt('only') || opt('only').split(',').includes(p.id)) && (!half || half.includes(p.id)));
const suffix = split ? `-${split}` : '';
const tools = opt('tools', null)?.split(',') ?? fs.readdirSync(resultsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort((a, b) => (DEFAULT_TOOLS.indexOf(a) + 99) % 100 - (DEFAULT_TOOLS.indexOf(b) + 99) % 100);

function loadResults(tool) {
  const m = new Map();
  const dir = path.join(resultsDir, tool);
  if (!fs.existsSync(dir)) return m;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (r.pr_id) m.set(r.pr_id, r);
  }
  return m;
}

// ---- optional LLM judge
const JUDGE_SCHEMA = { type: 'object', additionalProperties: false, required: ['same_issue'], properties: { same_issue: { type: 'boolean' } } };
async function judgePairs(tool, results) {
  const { anthropicProvider } = await import('../src/airev/index.js');
  const { startProxy } = await import('./lib/meter-proxy.mjs');
  const proxy = await startProxy({ mode: dry ? 'fake' : 'forward', reply: () => JSON.stringify({ same_issue: false }) });
  const provider = anthropicProvider({ apiKey: dry ? 'sk-ant-dry-run' : process.env.ANTHROPIC_API_KEY, model: 'claude-opus-5-5', baseUrl: proxy.url });
  const dir = path.join(CACHE_DIR, 'judge');
  fs.mkdirSync(dir, { recursive: true });
  const out = new Map();
  try {
    for (const pr of prs) {
      const r = results.get(pr.id);
      if (!r || r.status !== 'ok') continue;
      const m = new Map();
      for (const [fi, f] of (r.findings ?? []).entries()) {
        for (const [ii, iss] of (pr.issues ?? []).entries()) {
          if (!samePath(f.path, iss.path)) continue;
          const text = `GROUND-TRUTH ISSUE (found by a human reviewer)\nfile: ${iss.path}\nline: ${iss.line}\ncategory: ${iss.category}\n${iss.description}\n\nREVIEW TOOL FINDING\nfile: ${f.path}\nline: ${f.line}\n${f.title}\n${f.body}\n\nDoes the finding point out the same defect as the ground-truth issue (same root cause, so fixing what the finding asks would fix the issue)? A finding about a different problem in the same place is not the same issue.`;
          const key = crypto.createHash('sha1').update(`${dry}\n${text}`).digest('hex');
          const file = path.join(dir, `${key}.json`);
          let v;
          if (fs.existsSync(file)) v = JSON.parse(fs.readFileSync(file, 'utf8')).same_issue;
          else {
            const msg = await provider.send({ model: 'claude-opus-5-5', max_tokens: 2000, output_config: { effort: 'low', format: { type: 'json_schema', schema: JUDGE_SCHEMA } }, messages: [{ role: 'user', content: text }] });
            const t = (msg.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
            try {
              v = !!JSON.parse(t).same_issue;
            } catch {
              v = false;
            }
            fs.writeFileSync(file, JSON.stringify({ same_issue: v }));
          }
          m.set(`${fi}:${ii}`, v);
        }
      }
      out.set(pr.id, m);
    }
  } finally {
    await proxy.close();
  }
  process.stderr.write(`judge ${tool}: ${proxy.usage.requests} model requests\n`);
  return out;
}

const scores = {};
for (const t of tools) {
  const results = loadResults(t);
  const judged = args.includes('--judge') ? await judgePairs(t, results) : null;
  scores[t] = scoreTool(prs, results, { window, judged });
}
const which = split === 'dev' ? ' (dev half, used for tuning)' : split === 'test' ? ' (held-out half)' : '';
const md = reportMarkdown(scores, { prs, title: `${dry ? 'Grapim Review benchmark (DRY RUN: fake model answers, numbers are meaningless)' : 'Grapim Review benchmark'}${which}`, note: args.includes('--judge') ? 'Matches checked by an LLM judge (claude-opus-5-5).' : '' });
fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(path.join(resultsDir, `report${suffix}.md`), md);
fs.writeFileSync(path.join(resultsDir, `scores${suffix}.json`), JSON.stringify(scores, null, 1));
process.stdout.write(md);
process.stderr.write(`wrote ${path.join(resultsDir, `report${suffix}.md`)}\n`);
