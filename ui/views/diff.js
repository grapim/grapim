// Diff rendering (unified and split), light syntax colouring, and a small line
// diff for comparing two stored versions in the browser.

import { html, raw } from '../app.js';

// ---------------------------------------------------------------- syntax

const KW = new Set(('abstract as async await break case catch class const continue debugger declare default delete do else enum export extends ' +
  'false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return ' +
  'set static super switch this throw true try type typeof undefined var void while yield satisfies keyof infer never unknown').split(' '));
const TOKEN = /(\/\/.*$|\/\*.*?\*\/|\/\*.*$|^\s*\*.*$)|('(?:[^'\\]|\\.)*'?|"(?:[^"\\]|\\.)*"?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g;
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ESC[c]);

export function highlight(text, lang) {
  if (!text) return '';
  if (lang === 'plain') return esc(text);
  let out = '';
  let last = 0;
  TOKEN.lastIndex = 0;
  for (let m; (m = TOKEN.exec(text)); ) {
    out += esc(text.slice(last, m.index));
    const [all, com, str, num, fn, word] = m;
    if (com) out += `<span class="tk-com">${esc(all)}</span>`;
    else if (str) out += `<span class="tk-str">${esc(all)}</span>`;
    else if (num) out += `<span class="tk-num">${esc(all)}</span>`;
    else if (fn) out += KW.has(fn) ? `<span class="tk-kw">${esc(fn)}</span>` : `<span class="tk-fn">${esc(fn)}</span>`;
    else if (word && KW.has(word)) out += `<span class="tk-kw">${esc(word)}</span>`;
    else out += esc(all);
    last = m.index + all.length;
    if (!all.length) TOKEN.lastIndex++;
  }
  return out + esc(text.slice(last));
}
export const langOf = (path) => (/\.(m?[jt]sx?|json|css|c|go|rs|java|swift|kt)$/i.test(path) ? 'code' : 'plain');

// ---------------------------------------------------------------- unified and split

export function renderDiff(hunks, { mode = 'unified', path = '' } = {}) {
  if (!hunks?.length) return html`<div class="file-note">No line changes. The file's content is the same before and after this run.</div>`;
  const lang = langOf(path);
  const code = (s) => raw(highlight(s, lang) || ' ');
  if (mode === 'split') return renderSplit(hunks, code);
  const rows = [];
  for (const h of hunks) {
    rows.push(html`<tr class="hunk"><td class="ln"></td><td class="ln"></td><td colspan="2">@@ −${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</td></tr>`);
    let o = h.oldStart, n = h.newStart;
    for (const l of h.lines) {
      if (l.t === '+') rows.push(html`<tr class="add"><td class="ln"></td><td class="ln">${n++}</td><td class="mk" aria-label="added">+</td><td class="code">${code(l.s)}</td></tr>`);
      else if (l.t === '-') rows.push(html`<tr class="del"><td class="ln">${o++}</td><td class="ln"></td><td class="mk" aria-label="removed">−</td><td class="code">${code(l.s)}</td></tr>`);
      else rows.push(html`<tr><td class="ln">${o++}</td><td class="ln">${n++}</td><td class="mk"></td><td class="code">${code(l.s)}</td></tr>`);
    }
  }
  return html`<div class="diff" tabindex="0" role="region" aria-label="Diff of ${path}"><table><tbody>${rows}</tbody></table></div>`;
}

function renderSplit(hunks, code) {
  const rows = [];
  for (const h of hunks) {
    rows.push(html`<tr class="hunk"><td class="ln"></td><td colspan="3">@@ −${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</td></tr>`);
    let o = h.oldStart, n = h.newStart;
    const ls = h.lines;
    for (let i = 0; i < ls.length; ) {
      if (ls[i].t === ' ') {
        rows.push(html`<tr><td class="ln">${o++}</td><td class="code">${code(ls[i].s)}</td><td class="ln mid">${n++}</td><td class="code">${code(ls[i].s)}</td></tr>`);
        i++;
        continue;
      }
      const dels = [], adds = [];
      while (i < ls.length && ls[i].t === '-') dels.push(ls[i++]);
      while (i < ls.length && ls[i].t === '+') adds.push(ls[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const d = dels[k], a = adds[k];
        rows.push(html`<tr>
          ${d ? html`<td class="ln del">${o++}</td><td class="code del">${code(d.s)}</td>` : html`<td class="ln empty"></td><td class="code empty"></td>`}
          ${a ? html`<td class="ln add mid">${n++}</td><td class="code add">${code(a.s)}</td>` : html`<td class="ln empty mid"></td><td class="code empty"></td>`}
        </tr>`);
      }
    }
  }
  return html`<div class="diff split" tabindex="0" role="region" aria-label="Side-by-side diff"><table><colgroup><col style="width:48px"><col><col style="width:48px"><col></colgroup><tbody>${rows}</tbody></table></div>`;
}

// ---------------------------------------------------------------- line diff for versions

const split = (s) => (s ? s.replace(/\n$/, '').split('\n') : []);

// Hunks between two texts, with 3 lines of context, shaped like the API's.
export function diffTexts(a, b, ctx = 3) {
  const A = split(a), B = split(b);
  const n = A.length, m = B.length;
  if (n * m > 4_000_000) return [{ oldStart: 1, oldLines: n, newStart: 1, newLines: m, lines: [...A.map((s) => ({ t: '-', s })), ...B.map((s) => ({ t: '+', s }))] }];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { ops.push({ t: ' ', s: A[i], o: ++i, n: ++j }); }
    else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { ops.push({ t: '-', s: A[i], o: ++i, n: j }); }
    else { ops.push({ t: '+', s: B[j], n: ++j, o: i }); }
  }
  const out = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === ' ') { k++; continue; }
    let lo = Math.max(0, k - ctx), hi = k;
    while (hi < ops.length) {
      let next = hi;
      while (next < ops.length && ops[next].t !== ' ') next++;
      let run = next;
      while (run < ops.length && ops[run].t === ' ') run++;
      if (run < ops.length && run - next <= ctx * 2) hi = run;
      else { hi = Math.min(ops.length, next + ctx); break; }
    }
    const part = ops.slice(lo, hi);
    const first = part[0];
    const oldLines = part.filter((o) => o.t !== '+').length;
    const newLines = part.filter((o) => o.t !== '-').length;
    out.push({
      oldStart: oldLines ? (first.t === '+' ? first.o + 1 : first.o) : first.o,
      oldLines,
      newStart: newLines ? (first.t === '-' ? first.n + 1 : first.n) : first.n,
      newLines,
      lines: part.map(({ t, s }) => ({ t, s })),
    });
    k = hi;
  }
  return out;
}
