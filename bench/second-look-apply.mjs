// Applies a second-look run (bench/verify-eval.mjs --out) to stored reviews:
// writes <results>/<to>/ with the same files as <results>/<from>/, minus the
// findings the second look dropped, so `martian.mjs judge --tool <to>` scores
// the review as cloud review would post it.
//
//   node bench/second-look-apply.mjs --results bench/results-martian --rows bench/results-martian/second-look.json [--from grapim-lean] [--to grapim-lean-sl]

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const results = opt('results', 'bench/results-martian');
const from = path.join(results, opt('from', 'grapim-lean'));
const to = path.join(results, opt('to', 'grapim-lean-sl'));
const rows = JSON.parse(fs.readFileSync(opt('rows', path.join(results, 'second-look.json')), 'utf8')).filter((r) => r.tools);

fs.mkdirSync(to, { recursive: true });
let kept = 0;
let dropped = 0;
let missing = 0;
for (const file of fs.readdirSync(from).filter((f) => f.endsWith('.json')).sort()) {
  const r = JSON.parse(fs.readFileSync(path.join(from, file), 'utf8'));
  const mine = rows.filter((x) => x.url === r.url);
  const findings = (r.findings ?? []).filter((f) => {
    const row = mine.find((x) => x.path === f.path && x.line === f.line && x.title === f.title);
    if (!row) {
      missing++;
      return true; // not checked: a failed second look posts everything
    }
    if (row.verdict === 'drop') {
      dropped++;
      return false;
    }
    kept++;
    return true;
  });
  fs.writeFileSync(path.join(to, file), JSON.stringify({ ...r, findings }, null, 1));
}
console.log(`kept ${kept}, dropped ${dropped}, not checked ${missing} -> ${to}`);
