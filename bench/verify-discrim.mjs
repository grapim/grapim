#!/usr/bin/env node
// How well a second-look run tells matched from unmatched findings on
// Martian: counts of judge-matched (TP) and unmatched (FP) findings per raw
// verdict and confidence, for a judged tool and a verify-eval --out file.
//   node bench/verify-discrim.mjs --tool grapim-lean --rows sl.json [--results bench/results-martian] [--split dev]
import fs from 'node:fs';
import path from 'node:path';
import { BENCH_DIR } from './lib/gh.mjs';

const args = process.argv.slice(2);
const opt = (n, d = null) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : d);
const tool = opt('tool', 'grapim-lean');
const res = path.resolve(opt('results', path.join(BENCH_DIR, 'results-martian')));
const ids = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, 'data', 'martian-split.json'), 'utf8'))[opt('split', 'dev')];
const rows = JSON.parse(fs.readFileSync(opt('rows'), 'utf8'));
const t = {};
const add = (k) => (t[k] = (t[k] ?? 0) + 1);
for (const id of ids) {
  const rf = path.join(res, tool, `${id}.json`);
  const jf = path.join(res, 'judge', tool, `${id}.json`);
  if (!fs.existsSync(rf) || !fs.existsSync(jf)) continue;
  const r = JSON.parse(fs.readFileSync(rf, 'utf8'));
  const j = JSON.parse(fs.readFileSync(jf, 'utf8'));
  const m = new Set(j.goldens.flatMap((g) => g.matches));
  const rowOf = (f) => rows.find((x) => x.url === r.url && x.path === f.path && x.line === f.line && x.title === f.title);
  r.findings.forEach((f, i) => {
    const row = rowOf(f);
    add(`${m.has(i + 1) ? 'TP' : 'FP'} ${row ? (row.raw === null ? 'failed' : row.raw ?? row.verdict) : 'no-row'} ${f.confidence}`);
  });
  for (const f of r.raw?.held ?? []) add(`held ${rowOf(f)?.raw ?? 'no-row'}`);
}
for (const k of Object.keys(t).sort()) console.log(`${k.padEnd(28)} ${t[k]}`);
