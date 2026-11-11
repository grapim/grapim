// The CPU-heavy parts of the engine as pure functions of their inputs: line
// counts, blame, the in-tree replay and a run's file diffs. `grapim serve`
// calls them directly (through blame(), inTree(), runDetail()). The hub runs
// them in worker threads (src/hub/compute-pool.js), so one workspace's large
// file never stalls the event loop that serves every team.
//
// A task gets only its own inputs (contents and change rows of one call) and
// keeps nothing between calls.

import { blameFrom, inTreeFrom } from '../attribution.js';
import { lineCounts } from '../diff.js';
import { diffJson } from './json-diff.js';
import { fileDetailFrom } from './runs.js';

export const TASKS = {
  // [[before, after], ...] -> [{ added, removed }, ...]
  counts: ({ pairs }) => pairs.map(([a, b]) => lineCounts(a, b)),
  blame: (input) => blameFrom(input),
  // -> [[run, status], ...] (a Map does not cross the thread boundary as one)
  inTree: ({ files }) => [...inTreeFrom(files)],
  runFiles: ({ run, files }) => files.map((f) => fileDetailFrom(f, run)),
  diff: ({ before, after }) => diffJson(before, after),
};

// Buffers arrive in a worker as plain Uint8Arrays; the diff code reads them
// as Buffers (latin1 strings). A view, not a copy.
export function revive(x) {
  if (x instanceof Uint8Array) return Buffer.isBuffer(x) ? x : Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  if (Array.isArray(x)) return x.map(revive);
  if (x && typeof x === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(x)) out[k] = revive(v);
    return out;
  }
  return x;
}

export function runTask(task, input) {
  const fn = Object.hasOwn(TASKS, task) ? TASKS[task] : null;
  if (!fn) throw new Error(`unknown compute task ${String(task).slice(0, 40)}`);
  return fn(revive(input));
}
