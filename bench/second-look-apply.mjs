// Applies a second-look run (bench/verify-eval.mjs --out) to stored reviews:
// writes <results>/<to>/ with the same files as <results>/<from>/, with the
// findings as cloud review would post them: a posted finding goes by the
// engine's afterSecondLook (src/airev/verify.js) on its verdict; with --held,
// a held (low-confidence) finding the second look confirmed (verdict keep) is
// posted too. So `martian.mjs judge --tool <to>` scores what cloud review posts.
//
//   node bench/second-look-apply.mjs --results bench/results-martian --rows bench/results-martian/second-look.json [--from grapim-lean] [--to grapim-lean-sl] [--held] [--tag t] [--split dev|test]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterSecondLook } from '../src/airev/verify.js';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const results = opt('results', 'bench/results-martian');
const from = path.join(results, opt('from', 'grapim-lean'));
const to = path.join(results, opt('to', 'grapim-lean-sl'));
const withHeld = argv.includes('--held');
const tag = opt('tag', null);
const rows = JSON.parse(fs.readFileSync(opt('rows', path.join(results, 'second-look.json')), 'utf8')).filter((r) => r.tools && (tag === null || (r.tag ?? '') === tag));

fs.mkdirSync(to, { recursive: true });
const n = { kept: 0, dropped: 0, missing: 0, promoted: 0 };
// --split dev|test: only that half of data/martian-split.json.
const half = opt('split') ? new Set(JSON.parse(fs.readFileSync(fileURLToPath(new URL('./data/martian-split.json', import.meta.url)), 'utf8'))[opt('split')]) : null;
for (const file of fs.readdirSync(from).filter((f) => f.endsWith('.json') && (!half || half.has(f.slice(0, -5)))).sort()) {
  const r = JSON.parse(fs.readFileSync(path.join(from, file), 'utf8'));
  const mine = rows.filter((x) => x.url === r.url);
  const rowOf = (f) => mine.find((x) => x.path === f.path && x.line === f.line && x.title === f.title);
  const findings = (r.findings ?? []).filter((f) => {
    const row = rowOf(f);
    if (!row) {
      n.missing++;
      return true; // not checked: a failed second look posts everything
    }
    // Rows before 11/19 have only keep/drop.
    const post = afterSecondLook(f, row.raw ?? row.verdict) === 'post';
    n[post ? 'kept' : 'dropped']++;
    return post;
  });
  const promoted = withHeld ? (r.raw?.held ?? []).filter((f) => (rowOf(f)?.raw ?? null) === 'keep') : [];
  n.promoted += promoted.length;
  fs.writeFileSync(path.join(to, file), JSON.stringify({ ...r, findings: [...findings, ...promoted], raw: { ...r.raw, held: withHeld ? [] : r.raw?.held } }, null, 1));
}
console.log(`kept ${n.kept}, dropped ${n.dropped}, not checked ${n.missing}, held confirmed and posted ${n.promoted} -> ${to}`);
