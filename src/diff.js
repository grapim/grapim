// A line diff for attribution and +/- counts, no dependencies.
//
// Lines keep their terminators and are decoded as latin1, so each byte is one
// char: "a\r\n" and "a\n" are different lines and CRLF survives byte for byte.
// Common prefix and suffix are trimmed first, then Myers runs on the middle.
// If the middle needs more than CAP edits, it is treated as fully replaced.

const CAP = 2000;

export function splitLines(buf) {
  if (!buf || !buf.length) return [];
  const s = buf.toString('latin1');
  const out = [];
  let start = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', start)) {
    out.push(s.slice(start, i + 1));
    start = i + 1;
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

export const exact = (line) => line;
export const ignoreEol = (line) => line.replace(/\r?\n$/, '');

function toIds(a, b, key) {
  const seen = new Map();
  const id = (line) => {
    const k = key(line);
    let v = seen.get(k);
    if (v === undefined) seen.set(k, (v = seen.size));
    return v;
  };
  return [a.map(id), b.map(id)];
}

// Walks back through the saved V arrays to list the matched [i, j] pairs.
function backtrack(trace, D, n, m) {
  const pairs = [];
  let x = n;
  let y = m;
  for (let d = D; d > 0; d--) {
    const V = trace[d];
    const at = (k) => V[k + d - 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) pairs.push([--x, --y]);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) pairs.push([--x, --y]);
  return pairs;
}

// Myers' O(ND) diff on two int arrays. Returns matched pairs; none past `cap` edits.
function myers(a, b, cap) {
  const n = a.length;
  const m = b.length;
  if (!n || !m || Math.abs(n - m) > cap) return [];
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= Math.min(max, cap); d++) {
    trace.push(d === 0 ? null : v.slice(off - d + 1, off + d));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m);
    }
  }
  return [];
}

// For each line of b, the index of the line of a it was kept from, or -1 if it is new.
export function matchLines(a, b, key = exact) {
  const [x, y] = toIds(a, b, key);
  const from = new Array(y.length).fill(-1);
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) from[p] = p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) {
    from[y.length - 1 - s] = x.length - 1 - s;
    s++;
  }
  for (const [i, j] of myers(x.slice(p, x.length - s), y.slice(p, y.length - s), CAP)) from[p + j] = p + i;
  return from;
}

export function lineCounts(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  const kept = matchLines(a, b).filter((i) => i >= 0).length;
  return { added: b.length - kept, removed: a.length - kept };
}
