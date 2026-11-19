// Copies the modules the Actions need from src/ into their dist/ folders, byte
// for byte, so each Action runs with nothing else from the repo and no
// dependencies. Run it after changing those files:
//
//   node action/bundle.mjs           write action/dist/ and action/review/dist/
//   node action/bundle.mjs --check   exit 1 if either is out of date
//
// action/dist/ (provenance): src/provenance/render.js and pr.js, flat.
// action/review/dist/ (Grapim Review): src/airev/index.js, provenance/render.js
// and provenance/pr.js and every module they import, at their paths under
// src/ (dist/airev/, dist/provenance/, dist/storage/...), so relative imports
// work unchanged and nothing is rewritten.
//
// It refuses a module that imports anything but node: builtins and other
// bundled files: the Actions must stay self-contained.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FILES = ['render.js', 'pr.js'];
export const REVIEW_ENTRIES = ['airev/index.js', 'airev/decision.js', 'provenance/render.js', 'provenance/pr.js'];
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.join(here, '..', 'src');
const SRC = path.join(SRC_ROOT, 'provenance');
const DIST = path.join(here, 'dist');
export const REVIEW_DIST = path.join(here, 'review', 'dist');
const PKG = '{\n  "type": "module",\n  "private": true\n}\n';

// Every module specifier a file imports or re-exports (static, side-effect
// and dynamic import() with a string literal).
export function importsOf(text) {
  const out = [];
  const re = /^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function bundled() {
  const out = new Map();
  for (const f of FILES) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const spec of importsOf(text)) {
      if (spec.startsWith('node:')) continue;
      if (!FILES.includes(spec.replace(/^\.\//, ''))) throw new Error(`${f} imports ${spec}, which is not bundled: the Action must stay self-contained.`);
    }
    out.set(f, text);
  }
  out.set('package.json', PKG);
  return out;
}

// True once the engine (src/airev/, built separately) is in the repo.
export const reviewEngineReady = (root = SRC_ROOT) => fs.existsSync(path.join(root, 'airev', 'index.js'));

// The transitive closure of the review entries under src/: Map of
// 'airev/index.js'-style paths (always "/") -> text, plus package.json.
export function bundledReview({ root = SRC_ROOT, entries = REVIEW_ENTRIES } = {}) {
  const out = new Map();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.shift();
    if (out.has(rel)) continue;
    const file = path.join(root, ...rel.split('/'));
    if (!fs.existsSync(file)) throw new Error(`src/${rel} does not exist.`);
    const text = fs.readFileSync(file, 'utf8');
    out.set(rel, text);
    for (const spec of importsOf(text)) {
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('./') && !spec.startsWith('../')) throw new Error(`src/${rel} imports ${spec}, which is not bundled: the Action must stay self-contained.`);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (target.startsWith('../') || !target.endsWith('.js')) throw new Error(`src/${rel} imports ${spec}, outside src/ or not a .js file.`);
      queue.push(target);
    }
  }
  out.set('package.json', PKG);
  return out;
}

// Line endings aside: with core.autocrlf (the Git for Windows default) every
// checked-out file is CRLF, but PKG above is written with LF. Git stores both
// as LF, so CRLF vs LF in a working tree is not a stale copy.
const lf = (s) => s.replace(/\r\n/g, '\n');

function stale(files, dist) {
  const bad = [];
  for (const [f, text] of files) {
    const p = path.join(dist, ...f.split('/'));
    if (!fs.existsSync(p) || lf(fs.readFileSync(p, 'utf8')) !== lf(text)) bad.push(f);
  }
  return bad;
}

export function check() {
  return stale(bundled(), DIST);
}

// [] when action/review/dist/ matches src/ (or the engine is not there yet).
export function checkReview() {
  if (!reviewEngineReady()) return [];
  return stale(bundledReview(), REVIEW_DIST);
}

function write(files, dist) {
  fs.mkdirSync(dist, { recursive: true });
  for (const [f, text] of files) {
    const p = path.join(dist, ...f.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const a = check();
    const b = checkReview();
    if (a.length) console.error(`action/dist is out of date (${a.join(', ')}). Run: node action/bundle.mjs`);
    if (b.length) console.error(`action/review/dist is out of date (${b.join(', ')}). Run: node action/bundle.mjs`);
    if (a.length || b.length) process.exit(1);
    console.log(`action/dist is up to date.${reviewEngineReady() ? ' action/review/dist is up to date.' : ''}`);
  } else {
    const files = bundled();
    write(files, DIST);
    console.log(`Wrote ${files.size} files to action/dist.`);
    if (reviewEngineReady()) {
      const r = bundledReview();
      // Start clean so a module the engine stopped importing does not linger.
      fs.rmSync(REVIEW_DIST, { recursive: true, force: true });
      write(r, REVIEW_DIST);
      console.log(`Wrote ${r.size} files to action/review/dist.`);
    } else console.log('src/airev/index.js is not there yet: action/review/dist was not written.');
  }
}
