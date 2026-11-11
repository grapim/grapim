// Undo one run (or one turn of it) and keep everyone else's work.
//
// Per file, the run's changes are cut into segments: stretches where nobody
// else touched the file between two of its changes. Newest first, each
// segment is reverted with a three-way merge, current=C, base=after,
// other=before, which removes exactly that segment's edits from C. If a later
// edit by someone else overlaps, the merge conflicts and the file is left alone.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { history } from './attribution.js';
import { lineCounts } from './diff.js';
import { sha1, snapshot } from './ledger.js';
import { rootKey } from './workspace.js';

const idPart = (run) => run.slice(run.indexOf(':') + 1);

// The one run matching an id, an id prefix, a label prefix or a session id prefix.
export function findRun(store, query) {
  const runs = store.runs();
  const exact = runs.filter((r) => r.run === query || r.label === query);
  const hits = exact.length
    ? exact
    : runs.filter((r) => r.run.startsWith(query) || (r.label ?? '').startsWith(query) || idPart(r.run).startsWith(query));
  if (!hits.length) throw new Error(`No run matches "${query}". See \`grapim runs\`.`);
  if (hits.length > 1) throw new Error(`"${query}" matches ${hits.length} runs (${hits.map((r) => r.label || r.run).join(', ')}). Give more of the id.`);
  return hits[0];
}

// git merge-file -p current base other, through temp files. Raw bytes in and out.
export function mergeFile(current, base, other) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-merge-'));
  try {
    const files = Object.entries({ current, base, other }).map(([name, buf]) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, buf);
      return f;
    });
    try {
      const buf = execFileSync('git', ['merge-file', '-p', ...files], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { clean: true, buf };
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error('git was not found on PATH. Undo needs `git merge-file` to revert a file that others also changed.');
      if (err.status > 0 && err.status < 128) return { clean: false, conflicts: err.status };
      throw new Error(`git merge-file failed: ${String(err.stderr ?? err.message).trim()}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The target's changes to one file, cut into segments, newest first.
export function segments(changes, mine) {
  const segs = [];
  let cur = null;
  let prevAfter;
  for (const c of changes) {
    if (!mine(c)) cur = null;
    else if (cur && c.before_sha === prevAfter) Object.assign(cur, { after: c.after, after_sha: c.after_sha });
    else segs.push((cur = { before: c.before, before_sha: c.before_sha, after: c.after, after_sha: c.after_sha }));
    if (cur) cur.untracked ||= c.before === undefined || c.after === undefined;
    prevAfter = c.after_sha;
  }
  return segs.reverse();
}

const conflict = (reason) => ({ action: 'conflict', reason });

// Reverts one segment from state. Returns the new state or a conflict.
function revertSegment(state, s) {
  if (state.sha === s.after_sha) return { sha: s.before_sha, buf: s.before };
  if (state.sha === s.before_sha) return state; // already reverted
  if (state.sha === null) return conflict('deleted by someone else after this run changed it');
  if (s.after === null) return conflict('this run deleted it and it was created again since');
  if (s.before === null) return conflict('this run created it and others changed it since');
  const m = mergeFile(state.buf, s.after, s.before);
  if (!m.clean) return conflict(`later edits overlap this run's lines (${m.conflicts} conflicting hunk${m.conflicts === 1 ? '' : 's'})`);
  return { sha: sha1(m.buf), buf: m.buf };
}

function actionOf(now, end) {
  if (now.sha === end.sha) return 'nothing';
  if (end.sha === null) return 'delete';
  return now.sha === null ? 'restore' : 'revert';
}

function planFile(store, f, mine) {
  const segs = segments(history(store, f.root, f.path_key), mine);
  const now = snapshot(path.join(f.root, f.path));
  const item = { path: f.path, root: f.root, path_key: f.path_key, now };
  if (segs.some((s) => s.untracked) || (now.sha !== null && !now.buf)) return { ...item, ...conflict('binary or over 2 MB: content was not recorded') };
  let state = now;
  for (const s of segs) {
    state = revertSegment(state, s);
    if (state.action) return { ...item, ...state };
  }
  return { ...item, action: actionOf(now, state), end: state };
}

const CLEAN = new Set(['revert', 'delete', 'restore']);

// Why this file must not be touched right now, or null. Another agent holding
// it, or any agent (the undone run included) in the middle of an edit to it:
// writing under a half-finished edit would make the ledger record our revert
// as that agent's change.
function busyReason(store, f, actor, run) {
  const h = store.holder(f.path_key, actor);
  if (h && h.agent !== run.run) return `held by ${h.label || h.agent} right now`;
  const p = store.editInProgress(rootKey(f.root), f.path_key);
  if (p) return `${p.label || p.run} is in the middle of editing it`;
  return null;
}

// Replaces the file in one step: write a temp file next to it, then rename over
// it. A crash leaves either the old file or the new one, never half of one.
// The temp name is random and opened with wx, so a link planted at a guessable
// name cannot redirect the write. end.sha === null deletes the file.
export function writeFile(abs, end) {
  if (end.sha === null) {
    fs.rmSync(abs, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.grapim-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, end.buf, { flag: 'wx' });
    fs.renameSync(tmp, abs);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// What undoing this run (or one turn) would do to each file it touched. Changes nothing.
export function planUndo(store, query, { turn = null, actor = null } = {}) {
  const run = findRun(store, query);
  const mine = (c) => c.run === run.run && (turn === null || c.turn === turn);
  const files = new Map();
  for (const c of store.changesOfRun(run.run).filter(mine)) files.set(`${c.root_key}|${c.path_key}`, c);
  if (!files.size) throw new Error(`${run.label || run.run} has no recorded changes${turn === null ? '' : ` in turn ${turn}`}.`);
  const planned = [...files.values()].map((f) => planFile(store, f, mine));
  for (const f of planned) {
    const why = CLEAN.has(f.action) && busyReason(store, f, actor, run);
    if (why) f.reason = `${why}, so --yes will skip it`;
  }
  return { run, turn, actor, files: planned };
}

const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const fold = (p) => (FOLD ? p.toLowerCase() : p);

// The real path of p: its nearest existing parent with links resolved, joined with the rest.
function realPath(p) {
  const rest = [];
  for (let dir = p; ; ) {
    try {
      return path.join(fs.realpathSync.native(dir), ...rest.reverse());
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    }
    const up = path.dirname(dir);
    if (up === dir) return p;
    rest.push(path.basename(dir));
    dir = up;
  }
}

// Whether writing abs would land outside root: a folder on its way was
// replaced by a link (or junction) since the run recorded it.
export function leavesRoot(root, abs) {
  const r = fold(realPath(root));
  const d = fold(realPath(path.dirname(abs)));
  return d !== r && !d.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

// Applies one planned file. Skips it if it changed since the plan or is busy.
function applyFile(store, plan, f, actor, undoRun) {
  const why = busyReason(store, f, actor, plan.run);
  if (why) return { ...f, action: 'skipped', reason: why };
  const abs = path.join(f.root, f.path);
  if (leavesRoot(f.root, abs)) return { ...f, action: 'skipped', reason: 'a folder on its path is now a link that leads outside the worktree' };
  const now = snapshot(abs);
  if (now.sha !== f.now.sha) return { ...f, action: 'skipped', reason: 'changed while undoing' };
  writeFile(abs, f.end);
  const label = `undo ${plan.run.label || plan.run.run}`;
  const ref = { root: f.root, root_key: rootKey(f.root), path_key: f.path_key, path: f.path };
  store.recordChange({ ...ref, run: undoRun, label, turn: 0, untracked: false, ...lineCounts(now.buf, f.end.buf) }, now, f.end);
  store.recordUndo(actor, f.path, `${f.action}: ${plan.run.label || plan.run.run}${plan.turn === null ? '' : ` turn ${plan.turn}`}`);
  return f;
}

// The result has undoRun: the run id the reverts were recorded under (callers
// approve it with autoApprove from review.js when any file changed).
export function applyUndo(store, plan, actor) {
  const undoRun = `undo:${Date.now()}`;
  return { ...plan, undoRun, files: plan.files.map((f) => (CLEAN.has(f.action) ? applyFile(store, plan, f, actor, undoRun) : f)) };
}

// Whether an applied undo changed at least one file.
export const changedAny = (result) => result.files.some((f) => CLEAN.has(f.action));
