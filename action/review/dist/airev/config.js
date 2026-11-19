// .grapim/review.json (docs/design-ai-review.md, "Config"): read, validated,
// merged with the defaults. Unknown keys are errors, and every error is a
// ConfigError whose message says in plain words what to change.
//
// Security: a pull request can edit .grapim/review.json too (ignore "**",
// review "ai-only", instructions that tell the reviewer to approve). Callers
// that review someone else's change should read the config from the base
// commit: loadConfig(cwd, { rev: base }).

import fs from 'node:fs';
import path from 'node:path';
import { git } from '../provenance/pr.js';
import { repoGate } from './gate-config.js';

export const CONFIG_FILE = '.grapim/review.json';
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const REVIEW_MODES = Object.freeze(['ai-and-sensitive', 'all', 'ai-only']);
export const FAIL_ON = Object.freeze(['blocker', 'never']);

export const DEFAULT_CONFIG = Object.freeze({
  model: DEFAULT_MODEL,
  review: 'all',
  // Anywhere in the tree: monorepos keep these under packages/ or services/.
  sensitive: Object.freeze(['**/migrations/**', '**/auth/**', '**/infra/**', '**/*.sql', '.github/workflows/**']),
  ignore: Object.freeze(['**/*.lock', '**/dist/**', '**/*.snap']),
  instructions: '',
  maxComments: 15,
  maxFiles: 100,
  failOn: 'blocker',
  // How many times each request is reviewed. A second pass finds problems the
  // first missed (the same prompt does not always notice the same things);
  // the findings are merged, and a problem raised twice is posted once.
  passes: 1,
  // The merge gate (gate-config.js): null leaves the team's setting as it is.
  gate: null,
});

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_PATTERNS = 200;
const MAX_INSTRUCTIONS = 4000;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const quote = (v) => JSON.stringify(v)?.slice(0, 80) ?? String(v);
const list = (xs) => xs.map((x) => `"${x}"`).join(', ').replace(/, ([^,]*)$/, ' or $1');

// A path pattern -> RegExp over repo-relative paths ("src/a.js").
//   **  any number of directories (none too), *  any characters but "/",
//   ?  one character but "/". A trailing "/" means everything under it. A
//   leading "/" anchors at the repo root; a pattern without any "/" (like
//   "*.lock") matches the file name in any directory, as in .gitignore.
// Returns null for a pattern it cannot accept. (Same grammar as the hub's path
// rules, written again here because the engine ships without src/hub.)
export function compileGlob(pattern) {
  let p = String(pattern ?? '').trim();
  if (!p || p.length > 200 || /[\u0000-\u001f\\]/.test(p) || p.split('/').includes('..')) return null;
  if (p.startsWith('/')) p = p.replace(/^\/+/, '');
  else if (!p.replace(/\/+$/, '').includes('/')) p = `**/${p}`;
  if (!p) return null;
  if (p.endsWith('/')) p += '**';
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      i++;
      if (p[i + 1] === '/') {
        i++;
        re += '(?:[^/]*/)*';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// patterns -> (path) => boolean
export function matcher(patterns) {
  const res = patterns.map(compileGlob).filter(Boolean);
  return (p) => res.some((re) => re.test(p));
}

function patterns(key, v) {
  if (!Array.isArray(v)) throw new ConfigError(`${CONFIG_FILE}: "${key}" must be a list of path patterns, like ["migrations/**"].`);
  if (v.length > MAX_PATTERNS) throw new ConfigError(`${CONFIG_FILE}: "${key}" has ${v.length} patterns; at most ${MAX_PATTERNS} are allowed.`);
  for (const p of v) {
    if (typeof p !== 'string' || !compileGlob(p)) throw new ConfigError(`${CONFIG_FILE}: ${quote(p)} in "${key}" is not a path pattern Grapim understands. Use paths with * and **, like "src/**/*.sql", without ".." or backslashes.`);
  }
  return Object.freeze([...v]);
}

function int(key, v, min, max) {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new ConfigError(`${CONFIG_FILE}: "${key}" must be a whole number from ${min} to ${max} (got ${quote(v)}).`);
  return v;
}

function oneOf(key, v, allowed) {
  if (!allowed.includes(v)) throw new ConfigError(`${CONFIG_FILE}: "${key}" must be ${list(allowed)} (got ${quote(v)}).`);
  return v;
}

// Checks a parsed config object and returns it merged with the defaults
// (a list given in the file replaces the default list).
export function validateConfig(raw) {
  if (raw === undefined || raw === null) return { ...DEFAULT_CONFIG };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`${CONFIG_FILE} must hold one JSON object, like {"review": "all"}.`);
  const known = Object.keys(DEFAULT_CONFIG);
  for (const k of Object.keys(raw)) {
    if (!known.includes(k)) throw new ConfigError(`${CONFIG_FILE} has a setting Grapim does not know: ${quote(k)}. The settings are ${list(known)}.`);
  }
  const c = { ...DEFAULT_CONFIG };
  if ('model' in raw) {
    if (typeof raw.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@\-]{0,99}$/.test(raw.model)) throw new ConfigError(`${CONFIG_FILE}: "model" must be a model id such as "${DEFAULT_MODEL}" (got ${quote(raw.model)}).`);
    c.model = raw.model;
  }
  if ('review' in raw) c.review = oneOf('review', raw.review, REVIEW_MODES);
  if ('sensitive' in raw) c.sensitive = patterns('sensitive', raw.sensitive);
  if ('ignore' in raw) c.ignore = patterns('ignore', raw.ignore);
  if ('instructions' in raw) {
    if (typeof raw.instructions !== 'string') throw new ConfigError(`${CONFIG_FILE}: "instructions" must be text.`);
    if (raw.instructions.length > MAX_INSTRUCTIONS) throw new ConfigError(`${CONFIG_FILE}: "instructions" is ${raw.instructions.length} characters long; keep it under ${MAX_INSTRUCTIONS}.`);
    c.instructions = raw.instructions.replace(/\u0000/g, '').trim();
  }
  if ('maxComments' in raw) c.maxComments = int('maxComments', raw.maxComments, 0, 100);
  if ('maxFiles' in raw) c.maxFiles = int('maxFiles', raw.maxFiles, 1, 1000);
  if ('failOn' in raw) c.failOn = oneOf('failOn', raw.failOn, FAIL_ON);
  if ('passes' in raw) c.passes = int('passes', raw.passes, 1, 3);
  if ('gate' in raw) {
    try {
      c.gate = repoGate(raw.gate);
    } catch (err) {
      throw new ConfigError(`${CONFIG_FILE}: ${err.message}`);
    }
  }
  return c;
}

export function parseConfigText(text) {
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new ConfigError(`${CONFIG_FILE} is over ${MAX_CONFIG_BYTES / 1024} KB.`);
  let raw;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON: ${err.message}`);
  }
  return validateConfig(raw);
}

// The config of the checkout at `cwd` (its working tree), or with { rev } the
// file as committed at that revision. No file: the defaults.
export function loadConfig(cwd, { rev = null } = {}) {
  let text = null;
  if (rev) {
    const out = git(cwd, ['cat-file', 'blob', `${rev}:${CONFIG_FILE}`], { allowFail: true });
    text = out === null ? null : out;
  } else {
    const file = path.join(cwd, CONFIG_FILE);
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw new ConfigError(`${CONFIG_FILE} could not be read: ${err.code ?? err.message}.`);
    }
  }
  return text === null ? { ...DEFAULT_CONFIG } : parseConfigText(text);
}
