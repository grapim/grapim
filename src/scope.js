// Per-token access scopes: which parts of a workspace a token may read or
// write (docs/workspaces.md, "Access scopes"). Implemented once, here; the
// engine's authorize hook (enforce) and its list and read filters (reader)
// both call it.
//
// A token without rules keeps its plain scope (read or write) for every path.
// A token with rules sees only the paths a rule covers:
// - A rule is { path, access }: path is a workspace-relative glob ("docs/**",
//   "notes/*.md", "**/README.md", "data/2026-??.csv"); access is "read" or
//   "write". At most MAX_RULES rules.
// - Globs: "**" (a whole segment) is any number of folders, "*" any text
//   inside one name, "?" one character; everything else is literal. No "..",
//   ".", empty segments, backslashes or a leading "/". A trailing "/" means
//   the folder and everything in it ("docs/" is "docs/**").
// - A rule covers a path when its glob matches the path or one of the
//   folders above it, as in .gitignore ("docs" covers docs/a.md).
// - Every rule grants read. Write needs the most specific rule covering the
//   path to be a write rule: the longest literal prefix (the text before the
//   first * or ?) wins, then write over read. So "docs/**" read with
//   "docs/drafts/**" write lets the token read docs and write only drafts.
// - A rule never gives more than the token's own scope: a read token cannot
//   have write rules (cleanScopes refuses them when the token is made).
//
// Refusals (enforce): a path the token may not read is 404, the same answer
// as a file that does not exist, so a scope never reveals what is outside it;
// a path it may read or name but not write is 403 forbidden, with the path.

import { HttpError } from './server/http.js';

export const MAX_RULES = 32;
const MAX_GLOB = 300;
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const ACCESS = new Set(['read', 'write']);

const fail = (message) => Object.assign(new Error(message), { code: 'bad_request', status: 400 });
const fold = (s) => (FOLD ? s.toLowerCase() : s).normalize('NFC');

// One glob segment ("*.md", "2026-??") as a regex over one name.
const segSource = (seg) => seg.replace(/[.+^${}()|[\]\\*?]/g, (c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : `\\${c}`));

function globRegex(glob) {
  const segs = glob.split('/');
  let re = '';
  segs.forEach((seg, i) => {
    if (seg === '**') {
      if (segs.length === 1) re += '.*';
      else if (i === segs.length - 1) re += '(?:/.*)?';
      else re += i === 0 ? '(?:[^/]+/)*' : '/(?:[^/]+/)*';
      return;
    }
    if (i > 0 && segs[i - 1] !== '**') re += '/';
    re += segSource(seg);
  });
  return new RegExp(`^${re}$`, 'u');
}

// The rule list as given -> clean rules [{ path, access }], or null for none.
// Throws (code bad_request) with a message a person can act on.
export function cleanScopes(raw, { tokenScope = 'write' } = {}) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw fail('scopes must be a list of { "path": "docs/**", "access": "read" | "write" }.');
  if (raw.length > MAX_RULES) throw fail(`A token can have at most ${MAX_RULES} folder rules.`);
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw fail('Each scope rule is { "path": "docs/**", "access": "read" | "write" }.');
    const extra = Object.keys(r).filter((k) => k !== 'path' && k !== 'access');
    if (extra.length) throw fail(`Unknown field ${extra[0]} in a scope rule: use path and access.`);
    if (!ACCESS.has(r.access)) throw fail(`The access of "${String(r.path ?? '').slice(0, 100)}" must be read or write.`);
    if (r.access === 'write' && tokenScope !== 'write') throw fail('A read-only token cannot have write rules. Make it a write token, or set every rule to read.');
    out.push({ path: cleanGlob(r.path), access: r.access });
  }
  const unique = out.filter((r) => {
    const k = `${fold(r.path)}|${r.access}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.length ? unique : null;
}

function cleanGlob(raw) {
  if (typeof raw !== 'string') throw fail('Each scope rule needs a path, like docs/** or notes/*.md.');
  let g = raw.trim();
  const bad = (why) => fail(`Refused scope path "${g.slice(0, 100)}": ${why}. Give a path relative to the workspace root, like docs/**.`);
  if (!g) throw fail('A scope rule has an empty path. Use ** for the whole workspace.');
  if (g.length > MAX_GLOB) throw bad(`it is over ${MAX_GLOB} characters`);
  if (/[\x00-\x1f\x7f]/.test(g)) throw bad('it has control characters');
  if (g.includes('\\')) throw bad('use forward slashes');
  if (g.startsWith('/') || /^[a-zA-Z]:/.test(g)) throw bad('absolute paths are not allowed');
  if (g.endsWith('/')) g += '**';
  for (const seg of g.split('/')) {
    if (seg === '') throw bad('it has an empty part (//)');
    if (seg === '.' || seg === '..') throw bad('"." and ".." are not allowed');
    if (seg !== '**' && seg.includes('**')) throw bad('use ** as a whole folder name, like docs/**/notes');
  }
  return g;
}

const literalPrefix = (glob) => {
  const i = glob.search(/[*?]/);
  return i < 0 ? glob.length : i;
};

function compile(rule) {
  const glob = fold(rule.path);
  return { path: rule.path, access: rule.access, re: globRegex(glob), segs: glob.split('/'), rank: literalPrefix(glob) };
}

// The scope of a workspace token row ({ scope: 'read'|'write', scopes: JSON
// text or null }): { access, rules } where rules is null for "everything".
// null (no token: a person, an embed, grapim serve) means no limits at all.
export function scopeOf(token) {
  if (!token) return null;
  let rules = null;
  if (token.scopes) {
    let list;
    try {
      list = JSON.parse(token.scopes);
    } catch {
      list = [];
    }
    // A stored list that cannot be read is no access at all, never everything.
    rules = Array.isArray(list) ? list.filter((r) => r && typeof r.path === 'string' && ACCESS.has(r.access)).map(compile) : [];
  }
  return { access: token.scope === 'write' ? 'write' : 'read', rules };
}

// "docs/a.md" as segments, or null for a path no rule may ever match: "..",
// ".", empty parts, backslashes, control characters. One leading "/" and a
// trailing "/" (a folder) are dropped.
function segsOf(p) {
  let s = String(p ?? '');
  if (s.startsWith('/')) s = s.slice(1);
  if (s.endsWith('/')) s = s.slice(0, -1);
  if (s === '') return [];
  if (/[\x00-\x1f\x7f\\]/.test(s)) return null;
  const segs = fold(s).split('/');
  return segs.some((x) => x === '' || x === '.' || x === '..') ? null : segs;
}

// The rules covering the path: matching it or a folder above it.
function covering(rules, segs) {
  const hits = [];
  for (const r of rules) {
    for (let n = segs.length; n >= 1; n--) {
      if (r.re.test(segs.slice(0, n).join('/'))) {
        hits.push(r);
        break;
      }
    }
  }
  return hits;
}

// Whether the scope lets its token read or write this path ('' is the root).
export function allowed(scope, p, access = 'read') {
  if (!scope) return true;
  if (access === 'write' && scope.access !== 'write') return false;
  if (!scope.rules) return true;
  const segs = segsOf(p);
  if (!segs) return false;
  if (!segs.length) return access === 'read' ? scope.rules.length > 0 : false;
  const hits = covering(scope.rules, segs);
  if (!hits.length) return false;
  if (access === 'read') return true;
  // The most specific rule wins: the longest literal prefix, then write over read.
  const best = hits.reduce((a, b) => (b.rank > a.rank || (b.rank === a.rank && b.access === 'write') ? b : a));
  return best.access === 'write';
}

// Whether the folder may hold anything the token can read, so a listing
// shows it: a rule covers the folder, or the folder lies on a rule's way down.
export function mayContain(scope, dir) {
  if (!scope?.rules) return true;
  const segs = segsOf(dir);
  if (!segs) return false;
  if (!segs.length) return scope.rules.length > 0;
  if (covering(scope.rules, segs).length) return true;
  return scope.rules.some((r) => {
    for (let i = 0; i < segs.length; i++) {
      const seg = r.segs[i];
      if (seg === undefined) return false;
      if (seg === '**') return true;
      if (!new RegExp(`^${segSource(seg)}$`, 'u').test(segs[i])) return false;
    }
    return true;
  });
}

// For filtering lists: null when the scope hides nothing, else
// (path, type = 'file' | 'dir') -> whether the token may see it.
export function reader(scope) {
  if (!scope?.rules) return null;
  return (p, type = 'file') => (type === 'dir' ? mayContain(scope, p) : allowed(scope, p, 'read'));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Throws when the request may not touch what info names; see the engine's
// authorize contract (src/server/engine.js). info:
// - { path, access }: one path the caller named ("" or ending in "/" for a folder).
//   Not readable: 404. Readable or not, but not writable: 403 with the path.
// - { paths, access, recorded: true }: the files a run or a version recorded.
//   None readable (or none at all): 404, so a run outside the scope does not
//   exist for the token. Some not writable: 403, naming only those it may read.
// - { paths, access } without recorded: several paths the caller named, each
//   checked as { path }.
export function enforce(scope, info) {
  if (!scope?.rules || !info) return;
  const access = info.access ?? (info.write ? 'write' : 'read');
  const one = (p) => {
    const folder = p === '' || String(p).endsWith('/');
    if (folder ? !mayContain(scope, p) : !allowed(scope, p, 'read')) {
      if (access !== 'write') throw new HttpError('not_found', `${p.replace(/\/$/, '') || '/'} does not exist.`);
    }
    if (access === 'write' && !allowed(scope, p, 'write')) {
      throw new HttpError('forbidden', `This token may not write ${p || '/'}: it is outside the folders it can write.`, {}, { path: p });
    }
  };
  if (info.path !== undefined && info.path !== null) one(String(info.path));
  if (!Array.isArray(info.paths)) return;
  if (!info.recorded) {
    for (const p of info.paths) one(String(p));
    return;
  }
  const readable = info.paths.filter((p) => allowed(scope, p, 'read'));
  if (!readable.length) throw new HttpError('not_found', 'Not found.');
  if (access !== 'write') return;
  const denied = [...new Set(info.paths.filter((p) => !allowed(scope, p, 'write')))];
  if (!denied.length) return;
  const named = denied.filter((p) => allowed(scope, p, 'read'));
  const hidden = denied.length - named.length;
  const parts = [...(named.length ? [named.join(', ')] : []), ...(hidden ? [`${plural(hidden, 'file')} outside your scope`] : [])];
  throw new HttpError('forbidden', `This token may not change ${parts.join(' and ')}, so nothing was done.`, {}, { paths: named, hidden });
}
