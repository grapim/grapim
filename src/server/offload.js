// An engine whose diff, blame and replay work runs elsewhere: the hub gives
// each workspace engine a `compute` ({ run(task, input) -> Promise }, from
// src/hub/compute-pool.js) and this wraps it. grapim serve has none and
// computes in place, exactly as before.
//
// Reads (blame, the runs list, a run's detail, a restore's diff) are read in
// place, compared in a worker, and answered.
//
// Writes cannot wait in the middle: everything from the claim to the rename
// is synchronous on purpose (src/server/fs.js). So the line counts a write
// will need are computed first, in a worker, and remembered by content;
// `ensure(pairsOf, op)` then runs the synchronous write in the same tick as
// its last check that every count it needs is known. The ledger and the
// engine count lines through store.countLines (ledger.js countLines), which
// here answers from those remembered counts. Contents small enough to count
// in about a millisecond are counted in place. A count nobody prepared (a
// path without a prepare step, such as an MCP session ending) is never
// computed on the event loop: it is recorded as a whole-file replacement.

import path from 'node:path';
import { blameInputs, inTreeInputs } from '../attribution.js';
import { lineCounts } from '../diff.js';
import { MAX_BYTES, sha1, snapshot } from '../ledger.js';
import { busy } from './http.js';
import { listRuns, runDetailFrom, runDetailInputs } from './runs.js';

export const INLINE_BYTES = 64 * 1024; // contents this small (and with few lines) are counted in place
export const INLINE_LINES = 2000;
const REMEMBERED = 512; // counts kept per engine
const TRIES = 3;

// Lines in buf as splitLines counts them, without making strings.
export function lineTotal(buf) {
  if (!buf || !buf.length) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

function small(buf) {
  if (!buf || !buf.length) return true;
  if (buf.length > INLINE_BYTES) return false;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10 && ++n > INLINE_LINES) return false;
  return true;
}

// Whether the ledger keeps (and so counts) this content: text up to 2 MB.
export const kept = (buf) => !!buf && buf.length <= MAX_BYTES && !buf.subarray(0, 8192).includes(0);

const id = (buf) => (buf && buf.length ? sha1(buf) : '-');
const keyOf = (a, b) => `${id(a)}|${id(b)}`;

// The counts closing an agent's open snapshots will need (ledger.js
// finishRun): each snapshot's content against the file now. keys: only
// these path keys, or all.
export function pendingPairs(store, agent, keys = null) {
  const wanted = keys && new Set(keys);
  const pairs = [];
  for (const p of store.pendingOf(agent)) {
    if (wanted && !wanted.has(p.path_key)) continue;
    const before = p.before_sha === null ? null : store.blob(p.before_sha);
    const now = snapshot(path.join(p.root, p.path));
    if ((p.before_sha === null || before) && now.sha !== p.before_sha && (now.sha === null || now.buf)) pairs.push([before, now.buf]);
  }
  return pairs;
}

// The counts applying an undo plan will need: each file now against what the
// undo writes (undo.js applyFile).
export const undoPairs = (plan) => plan.files.filter((f) => f.end && f.now?.buf !== undefined).map((f) => [f.now.buf, f.end.buf]);

// The counts a restore will need: the file now against the version (restore.js).
export function restorePairs(store, t, sha) {
  const now = snapshot(t.abs);
  const version = typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? store.blob(sha) : null;
  return now.buf && version ? [[now.buf, version]] : [];
}

export function createOffload({ compute, log = () => {} }) {
  const known = new Map(); // `${sha a}|${sha b}` -> { added, removed }, least recently used first

  const remember = (k, v) => {
    known.delete(k);
    known.set(k, v);
    if (known.size > REMEMBERED) known.delete(known.keys().next().value);
  };
  // Pairs that cannot be counted in place and are not known yet.
  const missing = (pairs) => pairs.filter(([a, b]) => !(small(a) && small(b)) && !(!a?.length || !b?.length) && !known.has(keyOf(a, b)));

  // store.countLines on the hub.
  function countLines(a, b) {
    if (!a?.length || !b?.length) return { added: lineTotal(b), removed: lineTotal(a) };
    if (small(a) && small(b)) return lineCounts(a, b);
    const k = keyOf(a, b);
    const hit = known.get(k);
    if (hit) {
      remember(k, hit);
      return { ...hit };
    }
    log('grapim workspace: line counts were not prepared; recorded as a whole-file replacement');
    return { added: lineTotal(b), removed: lineTotal(a) };
  }

  async function prepare(pairs) {
    const todo = missing(pairs);
    if (!todo.length) return;
    const out = await compute.run('counts', { pairs: todo });
    todo.forEach(([a, b], i) => remember(keyOf(a, b), out[i]));
  }

  // Runs op() synchronously once every count in pairsOf() is known. pairsOf
  // is read again after each wait, since the files may have changed.
  async function ensure(pairsOf, op) {
    for (let i = 0; i < TRIES; i++) {
      const pairs = pairsOf();
      if (!missing(pairs).length) return op();
      await prepare(pairs);
    }
    throw busy('This file keeps changing while Grapim compares it. Try again in a moment.');
  }

  // ---- reads ----

  async function blame(store, ws, file) {
    const i = blameInputs(store, ws, file);
    return i.done ?? (await compute.run('blame', i));
  }

  // Map(run -> status). Past the time budget, every status is unknown (the
  // runs list still answers, with in_tree null).
  async function inTree(store) {
    try {
      return new Map(await compute.run('inTree', { files: inTreeInputs(store) }));
    } catch (err) {
      if (err?.code === 'too_large') return new Map();
      throw err;
    }
  }

  async function runs(store) {
    return listRuns(store, await inTree(store));
  }

  async function runDetail(store, query) {
    const i = runDetailInputs(store, query);
    const files = await compute.run('runFiles', { run: i.run, files: i.files });
    return runDetailFrom(store, i, await inTree(store), files);
  }

  const diff = (before, after) => compute.run('diff', { before, after });

  return { countLines, ensure, prepare, blame, inTree, runs, runDetail, diff, known };
}
