#!/usr/bin/env node
// What people would see on real pull requests: Grapim's findings on the
// hand-checked set (data/real-prs.json, data/real-labels.json) sorted into
// posted inline, listed in the summary, or not shown, and counted by label.
//
//   node bench/real-score.mjs [--results bench/results-real] [--tool grapim-lean] [--rows verify.json[,more.json]] [--held summary|verify] [--policy chill] [--list] [--set name]
//
// --rows: second-look verdicts (bench/verify-eval.mjs --out) to apply, as
// placeOf below says.
// Labels: real, false, noise (true but not worth a comment), unsure. A
// finding of a re-run is matched to a label on the same file (see labelOf),
// the closest title by shared words when several are near; findings with no
// label are listed so a person can check them (--list).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterSecondLook } from '../src/airev/verify.js';
// The "chill" rule (a candidate, not the engine's): only blockers and warnings
// the reviewer traced through the code it saw (confidence high) go inline.
const chillPost = (f) => (f.severity === 'blocker' || f.severity === 'warning') && (f.confidence ?? 'high') === 'high';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const prs = read(path.join(here, 'data', 'real-prs.json')).prs.filter((p) => !opt('set') || p.set === opt('set'));
const labels = read(path.join(here, 'data', 'real-labels.json'));
const dir = path.join(opt('results', path.join(here, 'results-real')), opt('tool', 'grapim-lean'));
const rows = (opt('rows') ? opt('rows').split(',') : []).flatMap((f) => read(f));

const words = (s) => new Set(String(s).toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? []);
const overlap = (a, b) => {
  const A = words(a);
  let n = 0;
  for (const w of words(b)) if (A.has(w)) n++;
  return n;
};
function labelOf(url, f) {
  // A re-run words and places the same problem a little differently: within
  // 5 lines, or anywhere in the file when the titles share 3 or more words.
  const near = labels.filter((l) => l.url === url && l.path === f.path && (Math.abs(l.line - f.line) <= 5 || overlap(l.title, f.title) >= 3));
  if (!near.length) return null;
  const exact = near.find((l) => f.title.startsWith(l.title));
  if (exact) return exact;
  return near.sort((a, b) => overlap(b.title, f.title) - overlap(a.title, f.title) || Math.abs(a.line - f.line) - Math.abs(b.line - f.line))[0];
}
const rowOf = (url, f) => rows.find((r) => r.url === url && r.path === f.path && r.line === f.line && r.title === f.title);

// --held summary (the engine before 11/19): held points are listed in the
// summary and never checked. --held verify (cloud review since 11/19): the
// second look checks them; one it confirms (verdict keep) is posted, the rest
// are not shown. A row with a raw verdict (keep, unsure, drop) is decided by
// the engine's own afterSecondLook; an older row by its keep/drop.
const heldMode = opt('held', 'summary');
function placeOf(f, where, row) {
  if (!row) return where;
  if (where === 'summary') {
    if (heldMode !== 'verify') return where;
    return (row.raw ?? row.verdict) === 'keep' ? 'inline' : 'hidden';
  }
  const decision = row.raw !== undefined && row.raw !== null ? afterSecondLook(f, row.raw) : row.verdict === 'drop' ? 'drop' : 'post';
  return decision === 'drop' ? 'hidden' : where;
}
// Where a finding ends up. The stored file says what the engine posted
// (findings) and what it listed in the summary (raw.held); a row with
// verdict drop removes it.
const out = [];
let missing = 0;
for (const pr of prs) {
  const file = path.join(dir, `${pr.id}.json`);
  if (!fs.existsSync(file)) {
    missing++;
    continue;
  }
  const r = read(file);
  if (r.status !== 'ok') {
    missing++;
    continue;
  }
  const all = [...(r.findings ?? []).map((f) => ({ f, where: 'inline' })), ...(r.raw?.held ?? []).map((f) => ({ f, where: 'summary' })), ...(r.raw?.minor ?? []).map((f) => ({ f, where: 'summary' }))];
  for (const { f, where } of all) {
    const row = rowOf(pr.url, f);
    let shown = placeOf(f, where, row);
    // --policy chill: an inline finding that is not a high-confidence blocker
    // or warning moves to the summary's collapsed list.
    if (opt('policy') === 'chill' && shown === 'inline' && !chillPost(f)) shown = 'summary';
    const l = labelOf(pr.url, f);
    out.push({ pr: pr.id, set: pr.set, url: pr.url, f, shown, label: l?.label ?? 'unlabeled', kind: l?.kind ?? null, labelRef: l, reason: row?.reason ?? '' });
  }
}

const count = (label, shown) => out.filter((x) => (label === '*' || x.label === label) && x.shown === shown).length;
const ran = new Set(out.map((x) => x.url));
const realLabels = labels.filter((l) => l.label === "real" && prs.some((p) => p.url === l.url && fs.existsSync(path.join(dir, `${p.id}.json`))));
const realSeen = new Set(out.filter((x) => x.label === 'real' && x.shown !== 'hidden').map((x) => x.labelRef));
const realInline = new Set(out.filter((x) => x.label === 'real' && x.shown === 'inline').map((x) => x.labelRef));
console.log(`${dir}${rows.length ? ` + ${rows.length} second-look rows` : ''}: ${prs.length - missing} PRs with results${missing ? `, ${missing} missing` : ''}`);
console.log(`real   (${realLabels.length} labelled): inline ${realInline.size}, summary only ${realSeen.size - realInline.size}, not shown ${realLabels.length - realSeen.size}`);
for (const lab of ['false', 'noise', 'unsure', 'unlabeled']) console.log(`${lab.padEnd(9)} inline ${String(count(lab, 'inline')).padStart(3)}  summary ${String(count(lab, 'summary')).padStart(3)}  hidden ${String(count(lab, 'hidden')).padStart(3)}`);
const kinds = {};
for (const x of out.filter((x) => (x.label === 'false' || x.label === 'noise') && x.shown !== 'hidden')) kinds[x.kind ?? '?'] = (kinds[x.kind ?? '?'] ?? 0) + 1;
console.log('false+noise still shown by kind:', JSON.stringify(kinds));
const inl = out.filter((x) => x.shown === 'inline');
const good = inl.filter((x) => x.label === 'real').length;
const bad = inl.filter((x) => x.label === 'false' || x.label === 'noise').length;
console.log(`inline precision on labelled: ${good}/${good + bad} = ${good + bad ? ((100 * good) / (good + bad)).toFixed(0) : '-'}%`);
for (const x of out) if (x.label === 'real' && x.shown !== 'inline') console.log(`LOST real -> ${x.shown}: ${x.pr} ${x.f.path}:${x.f.line} ${x.f.title.slice(0, 80)}${x.reason ? `\n     ${x.reason}` : ''}`);
if (argv.includes('--list')) for (const x of out) console.log(`${x.shown.padEnd(7)} ${x.label.padEnd(9)} ${(x.kind ?? '').padEnd(12)} ${x.f.severity}/${x.f.confidence}/${x.f.category} ${x.pr} ${x.f.path}:${x.f.line} ${x.f.title.slice(0, 90)}`);
if (argv.includes('--json')) fs.writeFileSync(opt('json-out', 'real-score.json'), JSON.stringify(out.map(({ f, labelRef, ...x }) => ({ ...x, path: f.path, line: f.line, title: f.title, severity: f.severity, confidence: f.confidence, category: f.category })), null, 1));
