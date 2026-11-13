// Runs as the API shows them: the list, one run in detail, and the undo plan.

import path from 'node:path';
import { history, inTree, isTracked, replay, replayFields } from '../attribution.js';
import { snapshot } from '../ledger.js';
import { branchOf, getReview } from '../review.js';
import { findRun } from '../undo.js';
import { badRequest, notFound } from './http.js';
import { diffJson } from './json-diff.js';
import { intentsOf } from './queries.js';

const IN_TREE = { yes: 'all', partly: 'some', no: 'none' };
const NO_REVIEW = Object.freeze({ status: 'pending', note: null, at: null, by: null });

// findRun with its two failures told apart: no match is 404, several is 400.
export function resolveRun(store, query) {
  try {
    return findRun(store, query);
  } catch (err) {
    throw /^No run matches/.test(err.message) ? notFound(err.message) : badRequest(err.message);
  }
}

// The agents that count as active: seen recently and not ended, or holding a file.
function activeSet(store) {
  return new Set([...store.activeAgents().map((a) => a.agent), ...store.leases().map((l) => l.agent)]);
}

function runRow(r, status, active, store) {
  return {
    run: r.run,
    label: r.label ?? r.run,
    worktree: r.worktree ?? (r.root ? path.basename(r.root) : null),
    intent: r.intent ?? null,
    turns: r.turns,
    files: r.files,
    added: r.added,
    removed: r.removed,
    in_tree: IN_TREE[status.get(r.run)] ?? null,
    first_ts: r.first_ts,
    last_ts: r.last_ts,
    active: active.has(r.run),
    review: getReview(store, r.run) ?? { ...NO_REVIEW },
    branch: branchOf(store, r.run) ?? null,
  };
}

// status: Map(run -> in-tree status), from inTree(store) unless given (the
// hub computes it off its event loop, src/server/offload.js).
export function listRuns(store, status = inTree(store)) {
  const active = activeSet(store);
  return store.runs().map((r) => runRow(r, status, active, store));
}

// Is the run's work in this file still in the working tree? Mirrors
// fileStatus in attribution.js, per file instead of per run. s is the
// file's replayable history from fileInputs, or null.
function fileState(s, run) {
  if (!s) return null;
  const r = replay(s.changes, s.now);
  const end = r.ends.get(run) ?? 0;
  const kept = r.who.filter((a) => a?.run === run).length;
  if (end > 0) return kept === end ? 'in_tree' : kept === 0 ? 'gone' : 'partial';
  if (s.now.sha === s.lastAfter) return 'in_tree';
  if (s.now.sha === s.firstBefore) return 'gone';
  return null;
}

// Content for a sha: null if the file did not exist, undefined if it was not kept.
const content = (store, sha) => (sha === null ? null : store.blob(sha) ?? undefined);

// What a file's detail is computed from (reading only): its first and last
// content in the run, and its whole history for the in-tree state.
function fileInputs(store, f) {
  const before = content(store, f.first.before_sha);
  const after = content(store, f.last.after_sha);
  const untracked = f.changes.some((c) => c.untracked) || before === undefined || after === undefined;
  const changes = history(store, f.root, f.path_key);
  const now = snapshot(path.join(f.root, f.path));
  const state = isTracked(changes, now) ? { changes: changes.map(replayFields), now: { sha: now.sha, buf: now.buf }, lastAfter: f.last.after_sha, firstBefore: f.first.before_sha } : null;
  // via: the newest shell command of the run that changed it (src/shell.js), or null.
  const via = f.changes.reduce((v, c) => c.via || v, null);
  return { path: f.path, untracked, before: untracked ? null : before, after: untracked ? null : after, state, via };
}

// A file's detail from fileInputs (CPU only: the diff and the replay).
export function fileDetailFrom(fi, run) {
  const d = fi.untracked ? { added: null, removed: null, diff: null } : diffJson(fi.before, fi.after);
  return { path: fi.path, added: d.added, removed: d.removed, untracked: fi.untracked, state: fileState(fi.state, run), diff: d.diff, via: fi.via ?? null };
}

// The run's changes grouped by file, in the order it first touched each.
function byFile(changes) {
  const files = new Map();
  for (const c of changes) {
    const k = `${c.root_key}|${c.path_key}`;
    if (!files.has(k)) files.set(k, { root: c.root, path: c.path, path_key: c.path_key, first: c, changes: [] });
    files.get(k).changes.push(c);
    files.get(k).last = c;
  }
  return [...files.values()];
}

// One entry per turn that changed files, with the intent the run had then.
function turnsOf(store, run, changes) {
  const intents = intentsOf(store, run);
  const turns = new Map();
  for (const c of changes) {
    if (!turns.has(c.turn)) turns.set(c.turn, { turn: c.turn, intent: null, ts: c.ts, files: [] });
    const t = turns.get(c.turn);
    if (!t.files.includes(c.path)) t.files.push(c.path);
  }
  for (const t of turns.values()) t.intent = intents.filter((i) => i.ts <= t.ts).at(-1)?.detail ?? null;
  return [...turns.values()].sort((a, b) => a.turn - b.turn);
}

// runDetail() in two halves, as blame(): what to compute, then the answer
// from the in-tree statuses and the files' details.
export function runDetailInputs(store, query) {
  const r = resolveRun(store, query);
  const changes = store.changesOfRun(r.run);
  return { run: r.run, turns: turnsOf(store, r.run, changes), files: byFile(changes).map((f) => fileInputs(store, f)) };
}

export function runDetailFrom(store, inputs, status, files) {
  return { run: listRuns(store, status).find((x) => x.run === inputs.run), turns: inputs.turns, files };
}

export function runDetail(store, query) {
  const i = runDetailInputs(store, query);
  return runDetailFrom(store, i, inTree(store), i.files.map((f) => fileDetailFrom(f, i.run)));
}

// The same JSON as `grapim undo --json`.
export const planJson = (plan, applied) => ({
  applied,
  run: plan.run.run,
  label: plan.run.label,
  turn: plan.turn,
  files: plan.files.map((f) => ({ path: f.path, root: f.root, action: f.action, reason: f.reason ?? null })),
});
