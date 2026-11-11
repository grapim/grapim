// Unified-diff hunks (3 lines of context, like git) in the docs/api.md shape,
// built on the same line matcher the local ledger uses.

import { matchLines, splitLines } from '../diff.js';

const text = (line) => Buffer.from(line, 'latin1').toString('utf8').replace(/\r?\n$/, '');

export function hunks(before, after, context = 3) {
  const a = splitLines(before);
  const b = splitLines(after);
  const from = matchLines(a, b);
  // One op per line, deletions before additions inside each changed stretch.
  const ops = [];
  let i = 0;
  let adds = [];
  for (let j = 0; j < b.length; j++) {
    if (from[j] >= 0) {
      while (i < from[j]) ops.push({ t: '-', s: a[i++] });
      for (const x of adds) ops.push(x); // no spread: a huge added stretch would overflow the call stack
      adds = [];
      ops.push({ t: ' ', s: b[j] });
      i++;
    } else {
      adds.push({ t: '+', s: b[j] });
    }
  }
  while (i < a.length) ops.push({ t: '-', s: a[i++] });
  for (const x of adds) ops.push(x); // no spread: a huge added stretch would overflow the call stack

  // Old and new line counts before each op.
  const oldAt = [];
  const newAt = [];
  let o = 0;
  let n = 0;
  for (const op of ops) {
    oldAt.push(o);
    newAt.push(n);
    if (op.t !== '+') o++;
    if (op.t !== '-') n++;
  }

  const changed = [];
  ops.forEach((op, k) => op.t !== ' ' && changed.push(k));
  const out = [];
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, changed[k] - context);
    let end = changed[k];
    while (k + 1 < changed.length && changed[k + 1] - end <= 2 * context) end = changed[++k];
    end = Math.min(ops.length - 1, end + context);
    k++;
    const slice = ops.slice(start, end + 1);
    const oldLines = slice.filter((x) => x.t !== '+').length;
    const newLines = slice.filter((x) => x.t !== '-').length;
    out.push({
      oldStart: oldLines ? oldAt[start] + 1 : oldAt[start],
      oldLines,
      newStart: newLines ? newAt[start] + 1 : newAt[start],
      newLines,
      lines: slice.map((x) => ({ t: x.t, s: text(x.s) })),
    });
  }
  return out;
}
