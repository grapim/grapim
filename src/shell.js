// Files changed by a shell command an agent runs (rm, mv, sed -i, a codegen
// script, a formatter). File-edit hooks never see these, so the hook around
// the agent's shell tool compares the worktree before and after the command:
//
//   Pre   `git status` plus a copy of every dirty or untracked file (clean
//         tracked files need none: their content is the HEAD blob). Stored as
//         an open "shell window" for this tool call.
//   Post  `git status` again. Every file that is dirty now, was dirty before,
//         or differs between the two HEADs is compared with its content before
//         the command; each one that changed becomes a change of the run, with
//         `via` = the command (secrets masked, at most 200 characters).
//
// Only the git worktree the command started in is covered, and only files git
// does not ignore. A file over 2 MB (or binary) is recorded as changed without
// its content, as for edit tools, so undo leaves it to the user. If the dirty
// files are more than MAX_FILES or MAX_TOTAL bytes, the Pre step keeps nothing,
// says so on stderr and lets the command run: nothing is recorded for it.
//
// Concurrency. Two agents running commands at once in one worktree cannot be
// told apart by looking at the disk. A file is recorded for a run only when no
// other run's shell window that overlaps this one could have seen the same
// change; otherwise it is recorded for neither, with a warning on stderr, and
// blame shows its lines as "outside agents". An edit-tool change recorded
// inside the window is not counted again: the comparison starts from the
// newest recorded content of the file.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_BYTES, UNTRACKED, countLines, sha1 } from './ledger.js';
import { fileKey, rootKey } from './workspace.js';

export const MAX_FILES = 2000;
export const MAX_TOTAL = 50 * 1024 * 1024;
const KEEP_MS = 24 * 60 * 60 * 1000;

const limit = (env, name, dflt) => {
  const n = Number(env[name]);
  return Number.isSafeInteger(n) && n > 0 ? n : dflt;
};

function git(root, args, input) {
  return execFileSync('git', ['--no-optional-locks', '--literal-pathspecs', ...args], {
    cwd: root,
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
}

const tryGit = (root, args, input) => {
  try {
    return git(root, args, input);
  } catch {
    return null;
  }
};

// Masks what looks like a secret, folds whitespace and keeps 200 characters.
export function commandText(cmd) {
  const s = (Array.isArray(cmd) ? cmd.filter((x) => typeof x === 'string').join(' ') : String(cmd ?? ''))
    .replace(/\b([A-Za-z0-9_]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|auth|credential)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, '$1=***')
    .replace(/(--?(?:token|secret|password|passwd|api[_-]?key|auth)[= ])("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/\b(?:sk-|ghp_|gho_|ghs_|ghu_|github_pat_|xox[abpr]-|AKIA|glpat-)[A-Za-z0-9_-]{6,}/g, '***')
    .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1***@')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 200 ? s.slice(0, 199) + '…' : s;
}

// What `git status` lists (dirty, staged, untracked, not ignored), as
// repo-relative paths, and the HEAD commit (null before the first commit).
// One git call: porcelain v2 carries the HEAD in its branch header.
function status(root) {
  const out = git(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=all']).toString('utf8');
  const parts = out.split('\0');
  const paths = [];
  let head = null;
  // Fields before the path, per entry kind.
  const skip = { 1: 8, 2: 9, u: 10, '?': 1 };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith('# branch.oid ')) {
      const oid = p.slice(13).trim();
      head = /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
      continue;
    }
    const n = skip[p[0]];
    if (!n) continue;
    let at = 0;
    for (let k = 0; k < n; k++) at = p.indexOf(' ', at) + 1;
    if (at > 0) paths.push(p.slice(at));
    // A rename or copy is followed by its source path.
    if (p[0] === '2') paths.push(parts[++i]);
  }
  return { paths: paths.filter(Boolean), head };
}

// One file on disk: { sha, size, mtime, buf }. sha null: absent; UNTRACKED:
// over the cap or not a regular file (size and mtime still tell a change);
// buf null: binary or over the cap, content not kept.
function readState(abs) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { sha: null, size: 0, mtime: 0, buf: null };
    throw err;
  }
  if (st.isDirectory()) return { dir: true };
  if (!st.isFile() || st.size > MAX_BYTES) return { sha: UNTRACKED, size: st.size, mtime: st.mtimeMs, buf: null };
  const buf = fs.readFileSync(abs);
  return { sha: sha1(buf), size: st.size, mtime: st.mtimeMs, buf: buf.subarray(0, 8192).includes(0) ? null : buf };
}

// Git's own text/binary statistics (convert.c), for the checkout conversion.
function stats(buf) {
  const s = { nul: 0, lonecr: 0, lonelf: 0, crlf: 0, printable: 0, nonprintable: 0 };
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 13) {
      if (buf[i + 1] === 10) {
        s.crlf++;
        i++;
      } else s.lonecr++;
      continue;
    }
    if (c === 10) {
      s.lonelf++;
      continue;
    }
    if (c === 127) s.nonprintable++;
    else if (c < 32) {
      if (c === 8 || c === 9 || c === 27 || c === 12) s.printable++;
      else if (c === 0) {
        s.nul++;
        s.nonprintable++;
      } else s.nonprintable++;
    } else s.printable++;
  }
  return s;
}

// The working-tree bytes git checks a blob out as, for line endings only.
// mode: { crlf: bool, text: 'set' | 'auto' }.
function toWorktree(buf, mode) {
  if (!mode.crlf) return buf;
  const s = stats(buf);
  if (!s.lonelf) return buf;
  if (mode.text === 'auto' && (s.crlf || s.lonecr || s.nul || s.printable >> 7 < s.nonprintable)) return buf;
  const out = [];
  let from = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10 && (i === 0 || buf[i - 1] !== 13)) {
      out.push(buf.subarray(from, i), Buffer.from('\r\n'));
      from = i + 1;
    }
  }
  out.push(buf.subarray(from));
  return Buffer.concat(out);
}

const CHUNK = 200;

// The content of each path at `head` as git would check it out: a Buffer,
// null when the path is not in that commit, or undefined when it cannot be
// told without running a filter (LFS, ident, working-tree-encoding).
export function headContents(root, head, paths) {
  const out = new Map(paths.map((p) => [p, null]));
  if (!head || !paths.length) return out;
  const ids = new Map();
  for (let i = 0; i < paths.length; i += CHUNK) {
    const listed = git(root, ['ls-tree', '-z', head, '--', ...paths.slice(i, i + CHUNK)]).toString('utf8');
    for (const line of listed.split('\0')) {
      const m = /^\d+ blob ([0-9a-f]+)\t(.*)$/s.exec(line);
      if (m) ids.set(m[2], m[1]);
    }
  }
  if (!ids.size) return out;
  const names = [...ids.keys()];
  const attrs = new Map(names.map((p) => [p, {}]));
  const raw = tryGit(root, ['check-attr', '-z', '--stdin', 'text', 'eol', 'filter', 'ident', 'working-tree-encoding'], names.join('\0') + '\0');
  if (raw) {
    const f = raw.toString('utf8').split('\0');
    for (let i = 0; i + 2 < f.length; i += 3) attrs.get(f[i]) && (attrs.get(f[i])[f[i + 1]] = f[i + 2]);
  }
  const conf = (k) => tryGit(root, ['config', '--get', k])?.toString().trim().toLowerCase() ?? '';
  const autocrlf = conf('core.autocrlf');
  const coreEol = conf('core.eol');
  const batch = git(root, ['cat-file', '--batch'], names.map((p) => ids.get(p)).join('\n') + '\n');
  let at = 0;
  for (const p of names) {
    const nl = batch.indexOf(10, at);
    const header = batch.subarray(at, nl).toString('utf8').split(' ');
    const size = Number(header[2]);
    const buf = batch.subarray(nl + 1, nl + 1 + size);
    at = nl + 1 + size + 1;
    const a = attrs.get(p);
    const set = (v) => v !== undefined && v !== 'unspecified' && v !== 'unset';
    if (set(a.filter) || set(a.ident) || set(a['working-tree-encoding'])) {
      out.set(p, undefined);
      continue;
    }
    const text = a.text === 'unset' ? null : a.text === 'set' ? 'set' : 'auto';
    let crlf = false;
    if (text && a.eol === 'crlf') crlf = true;
    else if (text && a.eol !== 'lf') crlf = autocrlf === 'true' || (autocrlf !== 'input' && coreEol === 'crlf' && a.text !== undefined && a.text !== 'unspecified');
    out.set(p, toWorktree(Buffer.from(buf), { crlf, text: text ?? 'auto' }));
  }
  return out;
}

// ---- Pre ----

// Keeps the worktree as it is before a shell command. Returns { note } when
// nothing could be kept (the command still runs).
export function beginShell(store, { id, run, label, ws, command, env = process.env }) {
  const maxFiles = limit(env, 'GRAPIM_SHELL_MAX_FILES', MAX_FILES);
  const maxTotal = limit(env, 'GRAPIM_SHELL_MAX_BYTES', MAX_TOTAL);
  const rk = rootKey(ws.root);
  const base = { id, run, label, root: ws.root, root_key: rk, command: commandText(command) };
  store.pruneShell(store.now() - KEEP_MS);
  const { paths, head } = status(ws.root);
  const over = (why) => {
    store.openShell({ ...base, head, pre: null });
    return { note: `grapim: ${why}, so changes made by this shell command are not recorded (it runs as usual).\n` };
  };
  if (paths.length > maxFiles) return over(`${paths.length} files are uncommitted (more than ${maxFiles})`);
  // Content seen in the newest window of this worktree is not read again
  // when its size and modification time are unchanged.
  const known = store.lastShellFiles(rk);
  const files = {};
  const blobs = [];
  let total = 0;
  for (const p of paths) {
    const f = fileKey(ws, path.join(ws.root, p));
    if (!f) continue;
    const abs = path.join(ws.root, f.display);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      st = null;
    }
    const k = known?.[f.key];
    if (st?.isFile() && k && k.sha && k.sha !== UNTRACKED && k.size === st.size && k.mtime === st.mtimeMs && store.hasBlob(k.sha)) {
      files[f.key] = { path: f.display, sha: k.sha, size: k.size, mtime: k.mtime };
      continue;
    }
    const s = readState(abs);
    if (s.dir) continue;
    if (s.buf) {
      total += s.buf.length;
      if (total > maxTotal) return over(`uncommitted files hold more than ${Math.round(maxTotal / 1024 / 1024)} MB`);
      blobs.push({ sha: s.sha, buf: s.buf });
    }
    files[f.key] = { path: f.display, sha: s.sha, size: s.size, mtime: s.mtime };
  }
  store.openShell({ ...base, head, pre: files }, blobs);
  return null;
}

// ---- Post ----

const CLEAN = (head) => `clean@${head ?? ''}`;
// A file's state in a window's snapshot: its sha (null: absent), or "clean at HEAD".
const stateIn = (map, key, head) => (map && Object.hasOwn(map, key) ? map[key].sha : CLEAN(head));

// Whether another run's overlapping window could have seen this file change.
function ambiguous(others, key, nowSha) {
  for (const w of others) {
    if (!w.pre) return true;
    if (w.ended_at === null) {
      if (stateIn(w.pre, key, w.head) !== nowSha) return true;
    } else if (!w.post || stateIn(w.pre, key, w.head) !== stateIn(w.post, key, w.post_head)) return true;
  }
  return false;
}

// Records what the shell command changed and closes its window. Returns
// { changes: [{ path, detail }], skipped: [path], note }.
export function finishShell(store, { id, run, ws }) {
  const w = store.shellWindow(id, run, rootKey(ws.root));
  if (!w) return { changes: [], skipped: [] };
  if (!w.pre) {
    store.closeShell(w.id, null, null);
    return { changes: [], skipped: [] };
  }
  const { paths: now, head } = status(ws.root);
  const moved = w.head && head && w.head !== head ? tryGit(ws.root, ['diff', '--name-only', '-z', '--no-renames', w.head, head])?.toString('utf8').split('\0').filter(Boolean) ?? [] : [];
  const cands = new Map();
  const add = (p) => {
    const f = fileKey(ws, path.join(ws.root, p));
    if (f && !cands.has(f.key)) cands.set(f.key, f);
  };
  for (const v of Object.values(w.pre)) add(v.path);
  for (const p of now) add(p);
  for (const p of moved) add(p);

  // Clean at Pre: its content then is the HEAD blob of that time.
  const fromHead = [...cands].filter(([k]) => !Object.hasOwn(w.pre, k)).map(([, f]) => f.display);
  const headBufs = headContents(ws.root, w.head, fromHead);

  const others = store.overlappingShells(w);
  const post = {};
  const changes = [];
  const skipped = [];
  for (const [key, f] of cands) {
    const after = readState(path.join(ws.root, f.display));
    if (after.dir) continue;
    post[key] = { path: f.display, sha: after.sha, size: after.size, mtime: after.mtime };
    let before;
    const pre = w.pre[key];
    if (pre) {
      before = { sha: pre.sha, buf: pre.sha && pre.sha !== UNTRACKED ? store.blob(pre.sha) : null, size: pre.size, mtime: pre.mtime };
    } else {
      const b = headBufs.get(f.display);
      before = b === null ? { sha: null, buf: null } : b === undefined ? { sha: UNTRACKED, buf: null } : b.length > MAX_BYTES ? { sha: UNTRACKED, buf: null } : { sha: sha1(b), buf: b.subarray(0, 8192).includes(0) ? null : b };
    }
    // An edit (by any tool) recorded since the command started: start from it.
    const since = store.changesOfFileAfter(w.root_key, key, w.mark);
    if (since.length) {
      const last = since[since.length - 1];
      before = { sha: last.after_sha, buf: last.after_sha && last.after_sha !== UNTRACKED ? store.blob(last.after_sha) : null };
    }
    // Over the cap on both sides: size and modification time tell a change.
    if (before.sha === after.sha && (after.sha !== UNTRACKED || since.length || (pre && pre.size === after.size && pre.mtime === after.mtime))) continue;
    if (ambiguous(others, key, after.sha)) {
      skipped.push(f.display);
      continue;
    }
    const untracked = before.sha === UNTRACKED || after.sha === UNTRACKED || (before.sha !== null && !before.buf) || (after.sha !== null && !after.buf);
    const counts = untracked ? { untracked: true } : { untracked: false, ...countLines(store, before.buf, after.buf) };
    changes.push({ path: f.display, path_key: key, before: { sha: before.sha, buf: before.buf }, after: { sha: after.sha, buf: after.buf }, ...counts });
  }
  store.finishShell(w, changes, post, head);
  const note = skipped.length
    ? `grapim: another agent ran a shell command in this worktree at the same time, so ${skipped.length} changed file${skipped.length === 1 ? '' : 's'} (${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''}) ${skipped.length === 1 ? 'is' : 'are'} not credited to either run.\n`
    : null;
  return {
    changes: changes.map((c) => ({ path: c.path, detail: c.untracked ? 'untracked' : `+${c.added} -${c.removed}` })),
    skipped,
    via: w.command,
    note,
  };
}
