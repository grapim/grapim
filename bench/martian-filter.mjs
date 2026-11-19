#!/usr/bin/env node
// Martian P/R/F1 of a judged Grapim run when only some of its findings are
// posted, reusing the judge's verdicts (no new judge calls). A candidate that
// is not posted drops out of precision; a golden comment whose only matches
// are not posted is missed.
//
//   node bench/martian-filter.mjs --tool grapim-lean [--results bench/results-martian] [--split dev] [--rows sl.json] [--policy all|chill]
//
// --rows: second-look verdicts (verify-eval --out) applied with the engine's
// afterSecondLook. --policy chill: inline only blocker and warning findings
// of high confidence (the rest would go to a collapsed summary list, which
// Martian's offline bench does not read).
import fs from 'node:fs';
import path from 'node:path';
import { BENCH_DIR } from './lib/gh.mjs';
import { afterSecondLook } from '../src/airev/verify.js';
// The "chill" rule (a candidate, not the engine's): only blockers and warnings
// the reviewer traced through the code it saw (confidence high) go inline.
const chillPost = (f) => (f.severity === 'blocker' || f.severity === 'warning') && (f.confidence ?? 'high') === 'high';

const args = process.argv.slice(2);
const opt = (n, d = null) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : d);
const tool = opt('tool', 'grapim-lean');
const res = path.resolve(opt('results', path.join(BENCH_DIR, 'results-martian')));
const ids = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, 'data', 'martian-split.json'), 'utf8'))[opt('split', 'dev')];
const rows = opt('rows') ? opt('rows').split(',').flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8'))) : [];
const policy = opt('policy', 'all');
const CORE = new Set(['bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect']); // as bench/martian.mjs

let tp = 0, fp = 0, fn = 0, posted = 0, prs = 0;
for (const id of ids) {
  const read = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
  const j = read(path.join(res, 'judge', tool, `${id}.json`));
  const r = read(path.join(res, tool, `${id}.json`));
  if (!j || j.status !== 'ok' || !r) continue;
  prs++;
  const keep = new Set();
  r.findings.forEach((f, i) => {
    const row = rows.find((x) => x.url === r.url && x.path === f.path && x.line === f.line && x.title === f.title);
    if (row && afterSecondLook(f, row.raw ?? row.verdict) === 'drop') return;
    if (policy === 'chill' && !chillPost(f)) return;
    keep.add(i + 1);
  });
  posted += keep.size;
  const matched = new Set();
  for (const g of j.goldens) {
    const m = g.matches.filter((x) => keep.has(x));
    m.forEach((x) => matched.add(x));
    if (!CORE.has(g.category)) continue;
    if (m.length) tp++;
    else fn++;
  }
  fp += keep.size - matched.size;
}
const P = tp / (tp + fp || 1);
const R = tp / (tp + fn || 1);
console.log(`${tool}${rows.length ? ' + rows' : ''} policy ${policy}, ${prs} PRs (${opt('split', 'dev')}): ${(posted / prs).toFixed(1)}/PR  P ${(100 * P).toFixed(1)}% (${tp}/${tp + fp})  R ${(100 * R).toFixed(1)}% (${tp}/${tp + fn})  F1 ${((200 * P * R) / (P + R || 1)).toFixed(1)}`);
