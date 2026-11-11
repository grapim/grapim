// Unified-diff hunks as JSON, for the review desk. Built on the same line
// matching as attribution (src/diff.js), with 3 lines of context like git.

import { matchLines, splitLines } from '../diff.js';

export const CONTEXT = 3;

const text = (line) => Buffer.from(line, 'latin1').toString('utf8').replace(/\r?\n$/, '');

// The edit script from a to b: [{ t: ' ' | '-' | '+', line }]. In each changed
// stretch the removed lines come before the added ones, as git prints them.
export function editScript(a, b) {
  const from = matchLines(a, b);
  const ops = [];
  let i = 0;
  let adds = [];
  const flush = (upTo) => {
    while (i < upTo) ops.push({ t: '-', line: a[i++] });
    for (const line of adds) ops.push({ t: '+', line });
    adds = [];
  };
  b.forEach((line, j) => {
    if (from[j] < 0) return void adds.push(line);
    flush(from[j]);
    ops.push({ t: ' ', line });
    i++;
  });
  flush(a.length);
  return ops;
}

// Changed ops closer than 2 * context unchanged lines share a hunk.
function groups(ops, context) {
  const changed = [];
  ops.forEach((o, k) => o.t !== ' ' && changed.push(k));
  const out = [];
  for (const k of changed) {
    const last = out.at(-1);
    if (last && k - last[1] - 1 <= 2 * context) last[1] = k;
    else out.push([k, k]);
  }
  return out;
}

export function hunks(ops, context = CONTEXT) {
  // Old and new line counts before each op.
  const before = [];
  let o = 0;
  let n = 0;
  for (const op of ops) {
    before.push([o, n]);
    if (op.t !== '+') o++;
    if (op.t !== '-') n++;
  }
  return groups(ops, context).map(([s, e]) => {
    const from = Math.max(0, s - context);
    const slice = ops.slice(from, Math.min(ops.length, e + context + 1));
    const oldLines = slice.filter((x) => x.t !== '+').length;
    const newLines = slice.filter((x) => x.t !== '-').length;
    const [o0, n0] = before[from];
    return {
      // git's convention: an empty side starts at the line before the change.
      oldStart: oldLines ? o0 + 1 : o0,
      oldLines,
      newStart: newLines ? n0 + 1 : n0,
      newLines,
      lines: slice.map((x) => ({ t: x.t, s: text(x.line) })),
    };
  });
}

// before, after: Buffers, or null for a file that did not exist.
export function diffJson(before, after) {
  const ops = editScript(splitLines(before), splitLines(after));
  return {
    added: ops.filter((x) => x.t === '+').length,
    removed: ops.filter((x) => x.t === '-').length,
    diff: { hunks: hunks(ops) },
  };
}
