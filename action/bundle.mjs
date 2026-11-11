// Copies the provenance modules the Action needs from src/provenance/ into
// action/dist/, byte for byte, so the Action runs with nothing else from the
// repo and no dependencies. Run it after changing those files:
//
//   node action/bundle.mjs           write action/dist/
//   node action/bundle.mjs --check   exit 1 if action/dist/ is out of date
//
// It refuses a module that imports anything but node: builtins and the other
// bundled files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FILES = ['render.js', 'pr.js'];
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src', 'provenance');
const DIST = path.join(here, 'dist');
const PKG = '{\n  "type": "module",\n  "private": true\n}\n';

export function bundled() {
  const out = new Map();
  for (const f of FILES) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const m of text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith('node:')) continue;
      if (!FILES.includes(spec.replace(/^\.\//, ''))) throw new Error(`${f} imports ${spec}, which is not bundled: the Action must stay self-contained.`);
    }
    out.set(f, text);
  }
  out.set('package.json', PKG);
  return out;
}

export function check() {
  const stale = [];
  for (const [f, text] of bundled()) {
    const p = path.join(DIST, f);
    if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== text) stale.push(f);
  }
  return stale;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const stale = check();
    if (stale.length) {
      console.error(`action/dist is out of date (${stale.join(', ')}). Run: node action/bundle.mjs`);
      process.exit(1);
    }
    console.log('action/dist is up to date.');
  } else {
    fs.mkdirSync(DIST, { recursive: true });
    for (const [f, text] of bundled()) fs.writeFileSync(path.join(DIST, f), text);
    console.log(`Wrote ${FILES.length + 1} files to action/dist.`);
  }
}
