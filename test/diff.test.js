import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineCounts, matchLines, splitLines } from '../src/diff.js';

function lcsLength(a, b) {
  const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  return t[0][0];
}

test('matchLines keeps a longest common subsequence, in order (2000 random cases)', () => {
  const random = () => Array.from({ length: Math.floor(Math.random() * 14) }, () => 'abcd'[Math.floor(Math.random() * 4)] + '\n');
  for (let r = 0; r < 2000; r++) {
    const a = random();
    const b = random();
    const from = matchLines(a, b);
    const kept = from.map((i, j) => [i, j]).filter(([i]) => i >= 0);
    kept.forEach(([i, j], k) => {
      assert.equal(a[i], b[j]);
      if (k) assert.ok(i > kept[k - 1][0]);
    });
    assert.equal(kept.length, lcsLength(a, b), JSON.stringify({ a, b }));
  }
});

test('lines keep their endings, so CRLF and LF lines differ', () => {
  assert.deepEqual(splitLines(Buffer.from('a\r\nb\nc')), ['a\r\n', 'b\n', 'c']);
  assert.deepEqual(lineCounts(Buffer.from('a\r\nb\r\n'), Buffer.from('a\r\nb\n')), { added: 1, removed: 1 });
  assert.deepEqual(lineCounts(null, Buffer.from('x\ny\n')), { added: 2, removed: 0 });
});
