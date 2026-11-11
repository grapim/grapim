// The agent workspace: read, write, delete and list files in the repo for
// agents that work over HTTP (/fs) or MCP over HTTP instead of a checkout.
//
// A write is the same as a hook agent's edit: claim the file (409 if someone
// else holds it), snapshot it, replace it atomically, snapshot it again and
// record one change. So runs, blame and undo see HTTP agents like any other.
// Everything between the claim and the record is synchronous, so no other
// request in this process can interleave with it.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lineCounts } from '../diff.js';
import { ago, who } from '../format.js';
import { beginEdit, finishEdit, finishRun, sha1, snapshot } from '../ledger.js';
import { rootKey } from '../workspace.js';
import { badRequest, busy, conflict, notFound } from './http.js';
import { guardSensitiveWrite, isHidden, resolvePath } from './paths.js';
import { lastChanges } from './queries.js';

const MAX_NAME = 100;
const MAX_INTENT = 300;
// GET /api/files?recursive=1 lists at most this many files.
export const MAX_LISTED = 5000;
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const TEMP = /\.grapim-\d+-[0-9a-f]+\.tmp$/;

// An HTTP agent from its name: run id http:<name>, labelled with the name.
export function httpAgent(name) {
  const n = String(name ?? '').trim();
  if (!n) throw badRequest('Say who you are: send the header X-Grapim-Agent: <name>.');
  if (n.length > MAX_NAME || /[\x00-\x1f\x7f]/.test(n)) throw badRequest(`X-Grapim-Agent must be 1 to ${MAX_NAME} printable characters.`);
  return { agent: `http:${n}`, label: n };
}

export const cleanIntent = (s) => {
  const line = String(s ?? '').trim().split(/\r?\n/)[0].trim();
  return line ? line.slice(0, MAX_INTENT) : null;
};

const statOf = (abs) => {
  try {
    return fs.statSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Windows refuses a rename over a file another process has open for a moment
// (an editor, a virus scanner). Retry briefly before giving up.
function renameRetrying(from, to) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      if (i >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      sleep(25 * (i + 1));
    }
  }
}

// Replaces the file in one step: a temp file next to it, then a rename over
// it. A crash leaves the old file or the new one, never half of one.
export function atomicWrite(abs, buf) {
  const parent = path.dirname(abs);
  try {
    fs.mkdirSync(parent, { recursive: true });
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'ENOTDIR') throw conflict(`A file is in the way of the folder ${path.basename(parent)}.`);
    // A link whose target is gone; the error would name absolute paths.
    if (err.code === 'ENOENT') throw conflict(`A broken link is in the way of the folder ${path.basename(parent)}.`);
    throw err;
  }
  const mode = statOf(abs)?.mode;
  const tmp = path.join(parent, `.${path.basename(abs)}.grapim-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, buf, { flag: 'wx' });
    if (mode !== undefined && process.platform !== 'win32') fs.chmodSync(tmp, mode & 0o7777);
    renameRetrying(tmp, abs);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// +/- lines between two snapshots; null when either side's content is not kept.
function counts(before, after) {
  if (before.sha === after.sha) return { added: 0, removed: 0 };
  const kept = (s) => s.sha === null || s.buf !== null;
  return kept(before) && kept(after) ? lineCounts(before.buf, after.buf) : { added: null, removed: null };
}

function heldMessage(c) {
  return `${c.path} is held by ${who(c)} for ${ago(Date.now() - c.acquired_at)}${c.intent ? `, working on "${c.intent}"` : ''}. Work on other files and try this one later.`;
}

// env: GRAPIM_ALLOW_SENSITIVE_WRITES=1 lets agents write files that run code
// by themselves (see guardSensitiveWrite in paths.js).
export function createWorkspace({ store, ws, env = {} }) {
  const target = (rel) => {
    const t = resolvePath(ws, rel);
    if (t.dir || !t.file) throw badRequest(`"${rel}" is a folder path. Give a file path without a trailing /.`);
    return t;
  };
  const writable = (rel) => {
    guardSensitiveWrite(ws, rel, env);
    const t = target(rel);
    guardSensitiveWrite(ws, rel, env, t.abs);
    return t;
  };

  const intentOf = (agent) => store.db.prepare('SELECT intent FROM agents WHERE agent = ?').get(agent)?.intent ?? null;

  // A new turn on the agent's first write and whenever its intent changes.
  // `current` is the intent before this request's claim (which stores the new one).
  function startTurn(me, intent, current) {
    const changed = intent && intent !== current;
    if (changed) store.setIntent(me.agent, intent, { label: me.label, worktree: ws.worktree });
    if (changed || store.turn(me.agent) === 0) store.nextTurn(me.agent);
  }

  function claim(me, t, intent) {
    const take = () => {
      const r = store.claim(me.agent, [t.file], { intent, worktree: ws.worktree, label: me.label });
      if (!r.ok) throw conflict(heldMessage(r.conflicts[0])); // the claim logged the block
    };
    // Someone holds it: fail as a conflict (409) before anything else.
    if (store.holder(t.file.key, me.agent)) take();
    // A hook agent in warn mode edits without a claim; writing under its
    // half-finished edit would credit our bytes to it.
    const p = store.editInProgress(rootKey(ws.root), t.file.key);
    if (p && p.run !== me.agent) throw busy(`${p.label || p.run} is in the middle of editing ${t.rel}. Try again in a moment.`);
    const current = intentOf(me.agent);
    take();
    startTurn(me, intent, current);
    // An open snapshot from an MCP claim_files is closed first, so this write
    // is recorded as its own change and not folded into that one.
    for (const c of finishRun(store, me.agent, [t.file.key])) store.recordEdit(me.agent, c.path, c.detail);
  }

  // Snapshot, apply, snapshot, record. `apply` changes the file on disk.
  function edit(me, t, apply) {
    const id = `${me.agent}|fs|${crypto.randomUUID()}`;
    const before = snapshot(t.abs);
    beginEdit(store, { run: me.agent, label: me.label, ws, file: t.file, id });
    try {
      apply();
    } catch (err) {
      store.dropPending({ id });
      throw err;
    }
    const done = finishEdit(store, { run: me.agent, ws, file: t.file, id });
    if (done) store.recordEdit(me.agent, done.path, done.detail);
    return { path: t.rel, ...counts(before, snapshot(t.abs)) };
  }

  function write(me, rel, buf, { intent = null } = {}) {
    const t = writable(rel);
    if (statOf(t.abs)?.isDirectory()) throw badRequest(`${t.rel} is a folder.`);
    claim(me, t, cleanIntent(intent));
    const r = edit(me, t, () => atomicWrite(t.abs, buf));
    return { path: r.path, sha: sha1(buf), added: r.added, removed: r.removed };
  }

  function remove(me, rel, { intent = null } = {}) {
    const t = writable(rel);
    const st = statOf(t.abs);
    if (!st) throw notFound(`${t.rel} does not exist.`);
    if (!st.isFile()) throw badRequest(`${t.rel} is not a file.`);
    claim(me, t, cleanIntent(intent));
    const r = edit(me, t, () => fs.rmSync(t.abs));
    return { path: r.path, sha: null, added: r.added, removed: r.removed };
  }

  function read(rel) {
    const t = target(rel);
    const st = statOf(t.abs);
    if (!st) throw notFound(`${t.rel} does not exist.`);
    if (st.isDirectory()) throw badRequest(`${t.rel} is a folder. Add a trailing / to list it.`);
    // A FIFO or device would block the whole server on readFileSync.
    if (!st.isFile()) throw badRequest(`${t.rel} is not a regular file.`);
    return { path: t.rel, buf: fs.readFileSync(t.abs) };
  }

  // The folder's entries, folders first, as GET /api/files returns them.
  function list(rel) {
    const t = resolvePath(ws, rel === '' || rel.endsWith('/') ? rel : `${rel}/`);
    const st = statOf(t.abs);
    if (!st) throw notFound(`${t.rel || '/'} does not exist.`);
    if (!st.isDirectory()) throw badRequest(`${t.rel} is a file, not a folder.`);
    const changes = lastChanges(store, ws);
    const holders = new Map(store.leases().map((l) => [l.path_key, who(l)]));
    const out = [];
    for (const d of fs.readdirSync(t.abs, { withFileTypes: true })) {
      const abs = path.join(t.abs, d.name);
      if (isHidden(ws, abs) || TEMP.test(d.name)) continue;
      const s = statOf(abs);
      if (!s || !(s.isFile() || s.isDirectory())) continue;
      const display = t.rel ? `${t.rel}/${d.name}` : d.name;
      const key = t.file ? `${t.file.key}/${d.name}` : d.name;
      const k = FOLD ? key.toLowerCase() : key;
      const type = s.isDirectory() ? 'dir' : 'file';
      out.push({
        name: d.name,
        path: display,
        type,
        size: type === 'file' ? s.size : 0,
        last_change: type === 'file' ? changes.get(k) ?? null : newestUnder(changes, `${k}/`),
        held_by: type === 'file' ? holders.get(k) ?? null : null,
      });
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  }

  // Every file under the folder at `rel`, as one flat list (no folders), for
  // GET /api/files?recursive=1. In git: tracked and untracked files that are
  // not ignored (git ls-files -co --exclude-standard). Otherwise a walk of the
  // folder. Never .git or the state folder; at most MAX_LISTED files.
  function listAll(rel, { max = MAX_LISTED } = {}) {
    const t = resolvePath(ws, rel === '' || rel.endsWith('/') ? rel : `${rel}/`);
    const st = statOf(t.abs);
    if (!st) throw notFound(`${t.rel || '/'} does not exist.`);
    if (!st.isDirectory()) throw badRequest(`${t.rel} is a file, not a folder.`);
    const prefix = t.rel ? `${t.rel}/` : '';
    const names = ws.isGit ? gitFiles(ws.root) : walk(ws, t.abs, prefix, max + 1);
    const changes = lastChanges(store, ws);
    const holders = new Map(store.leases().map((l) => [l.path_key, who(l)]));
    const fold = (p) => (FOLD ? p.toLowerCase() : p);
    const want = fold(prefix);
    const files = [];
    let truncated = false;
    for (const p of names) {
      if (!fold(p).startsWith(want) || TEMP.test(p)) continue;
      const abs = path.join(ws.root, ...p.split('/'));
      if (isHidden(ws, abs) || p.split('/').some((s) => s.toLowerCase() === '.git')) continue;
      const s = statOf(abs);
      if (!s?.isFile()) continue; // deleted but still in the index, a submodule, a link to a folder
      if (files.length === max) {
        truncated = true;
        break;
      }
      const k = fold(p);
      files.push({ name: path.posix.basename(p), path: p, type: 'file', size: s.size, last_change: changes.get(k) ?? null, held_by: holders.get(k) ?? null });
    }
    return { files: files.sort((a, b) => a.path.localeCompare(b.path)), truncated };
  }

  // Releases everything the agent holds and records its open snapshots.
  function release(me) {
    const recorded = finishRun(store, me.agent);
    for (const c of recorded) store.recordEdit(me.agent, c.path, c.detail);
    return { released: store.release(me.agent, null), recorded };
  }

  return { write, remove, read, list, listAll, release };
}

// Tracked and untracked, not ignored, files of a git worktree, repo-relative.
function gitFiles(root) {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`git ls-files failed in this worktree: ${err.message}`);
  }
  // A nested repo is listed as "dir/"; unmerged files once per stage.
  return [...new Set(out.toString('utf8').split('\0').filter((p) => p && !p.endsWith('/')))];
}

// Files under abs (repo-relative, prefix + name), outside git. Stops at `limit`.
function walk(ws, abs, prefix, limit) {
  const out = [];
  const queue = [[abs, prefix]];
  while (queue.length && out.length < limit) {
    const [dir, rel] = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(dir, d.name);
      if (isHidden(ws, child)) continue;
      if (d.isDirectory()) queue.push([child, `${rel}${d.name}/`]);
      else out.push(`${rel}${d.name}`);
      if (out.length >= limit) break;
    }
  }
  return out;
}

function newestUnder(changes, prefix) {
  let best = null;
  for (const [k, c] of changes) if (k.startsWith(prefix) && (!best || c.ts > best.ts)) best = c;
  return best;
}
