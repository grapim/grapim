// Turns a path from a request into a file inside the repo, or refuses it.
//
// Two layers. First the text: no "..", no absolute or drive paths, no
// backslashes, nothing inside .git. Then the disk: the real path of the
// nearest existing part must still be inside the repo, so a symlink cannot
// lead out of it, and must not be inside .git or the Grapim state folder.

import fs from 'node:fs';
import path from 'node:path';
import { fileKey } from '../workspace.js';
import { HttpError, badRequest } from './http.js';

const WIN = process.platform === 'win32';
const FOLD = WIN || process.platform === 'darwin';
// Older Windows also treats "nul .txt", "COM¹" and CONIN$ as devices.
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$) *(\..*)?$/i;

const fold = (p) => (FOLD ? p.toLowerCase() : p);
const inside = (child, parent) => {
  const c = fold(child);
  const p = fold(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
};

function realOrSelf(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

// The real path of `abs`, or of its nearest existing parent joined with the rest.
function realPath(abs) {
  let dir = abs;
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(dir), ...rest.reverse());
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    }
    const up = path.dirname(dir);
    if (up === dir) return abs;
    rest.push(path.basename(dir));
    dir = up;
  }
}

// A name some file system treats as ".git": ".git." or ".git " (Windows drops
// the trailing dots and spaces), "git~1" (the 8.3 short name of .git),
// ".git::$INDEX_ALLOCATION" (an NTFS stream), or ".git" with characters HFS+
// ignores. Refused on every platform: a cloud workspace on Linux is synced to
// Windows and macOS laptops, where these would land inside the real .git.
export function isGitAlias(seg) {
  const s = String(seg).toLowerCase().replace(/[‌-‏‪-‮⁪-⁯﻿]/g, '');
  return /^\.git[. ]*(:.*)?$/.test(s) || /^git~\d+$/.test(s);
}

function checkSegment(seg, rel) {
  const refuse = (why) => badRequest(`Refused path "${rel}": ${why}. Give a path relative to the repo root, like src/app.js.`);
  if (seg === '') return refuse('it has an empty part (//)');
  if (seg === '.' || seg === '..') return refuse('"." and ".." are not allowed');
  if (isGitAlias(seg)) return refuse('.git is not part of the workspace');
  if (WIN && /[<>:"|?*]/.test(seg)) return refuse('it has a character Windows does not allow in file names');
  if (WIN && /[. ]$/.test(seg)) return refuse('a name ending in a dot or space is not allowed on Windows');
  if (WIN && DEVICE.test(seg)) return refuse(`"${seg}" is a reserved device name on Windows`);
  return null;
}

// rel: a decoded repo-relative path, "" for the root. A trailing "/" marks a folder.
// Returns { abs, rel, dir, file } where file is { key, display } (null for the root).
export function resolvePath(ws, rel) {
  rel = String(rel ?? '');
  const refuse = (why) => badRequest(`Refused path "${rel}": ${why}. Give a path relative to the repo root, like src/app.js.`);
  if (/[\x00-\x1f\x7f]/.test(rel)) throw refuse('it has control characters');
  if (rel.includes('\\')) throw refuse('use forward slashes');
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) throw refuse('absolute paths are not allowed');
  const dir = rel === '' || rel.endsWith('/');
  const trimmed = dir ? rel.slice(0, -1) : rel;
  const segs = trimmed === '' ? [] : trimmed.split('/');
  for (const seg of segs) {
    const err = checkSegment(seg, rel);
    if (err) throw err;
  }
  const abs = path.join(ws.root, ...segs);
  const file = segs.length ? fileKey(ws, abs) : null;
  if (segs.length && !file) throw refuse('it is outside the repo');
  guardRealPath(ws, abs, refuse);
  return { abs, rel: file?.display ?? '', dir, file };
}

function guardRealPath(ws, abs, refuse) {
  const root = realOrSelf(ws.root);
  const real = realPath(abs);
  if (!inside(real, root)) throw refuse('it leads outside the repo');
  for (const p of [path.join(ws.root, '.git'), ws.stateDir]) {
    if (inside(real, realOrSelf(p))) throw refuse('it is inside Grapim or git state');
  }
}

// Files that run code by themselves the next time a tool starts (security
// review M7): Claude Code settings (hooks), git internals (hooks, config),
// VS Code tasks, direnv. Matched at any depth, case-insensitively.
const SENSITIVE = [
  { why: 'Claude Code settings can run hooks', test: (s) => s.length >= 2 && s.at(-2) === '.claude' && /^settings.*\.json$/.test(s.at(-1)) },
  // No override for .git: resolvePath refuses it in any case.
  { why: 'git runs hooks and config from .git', test: (s) => s.some(isGitAlias), always: true },
  { why: 'VS Code can run tasks from it', test: (s) => s.length >= 2 && s.at(-2) === '.vscode' && s.at(-1) === 'tasks.json' },
  { why: 'direnv runs it when you enter the folder', test: (s) => s.at(-1) === '.envrc' },
  // HEAD next to objects/ and refs/ makes the folder a bare git repo: git,
  // a shell prompt or an editor opened there would run its config (core.fsmonitor).
  { why: 'with objects/ and refs/ beside it, git treats the folder as a repository and runs its config', test: (s) => s.at(-1) === 'head' },
];

// Why an agent may never write `rel` (a file that runs code by itself), or
// null. The folder sync client also refuses to write these from a workspace.
export function sensitiveReason(rel) {
  return sensitiveRule(String(rel ?? ''), false)?.why ?? null;
}

const hint = (r) =>
  r.always
    ? 'It is never part of the workspace.'
    : 'Agents may not write it through /fs or MCP. Edit it yourself, or start grapim serve with GRAPIM_ALLOW_SENSITIVE_WRITES=1 to allow it.';

const sensitiveRule = (rel, allowed) => {
  const segs = rel.toLowerCase().split('/').filter(Boolean);
  return (segs.length && SENSITIVE.find((r) => (r.always || !allowed) && r.test(segs))) || null;
};

// Refuses (403 forbidden) an agent write to a file that runs code by itself;
// env.GRAPIM_ALLOW_SENSITIVE_WRITES=1 allows all but .git. Checks the path as
// given first (before resolvePath, so .git gets this 403 rather than a 400),
// and with `abs` also the real path, so a link or an 8.3 name cannot get around it.
export function guardSensitiveWrite(ws, rel, env = {}, abs = null) {
  const allowed = env.GRAPIM_ALLOW_SENSITIVE_WRITES === '1';
  const refuse = (r) => new HttpError('forbidden', `Refused to write "${rel}": ${r.why}. ${hint(r)}`);
  let r = sensitiveRule(String(rel ?? ''), allowed);
  if (r) throw refuse(r);
  if (!abs) return;
  const real = path.relative(realOrSelf(ws.root), realPath(abs));
  r = sensitiveRule(real.split(path.sep).join('/'), allowed);
  if (r) throw refuse(r);
}

// A path segment from a URL, decoded. Malformed escapes are a bad request.
export function decodePath(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw badRequest(`The path "${raw}" has a malformed %-escape.`);
  }
}

// Whether a directory entry is internal (never listed or served).
export function isHidden(ws, abs) {
  return path.basename(abs).toLowerCase() === '.git' || inside(abs, ws.stateDir);
}
