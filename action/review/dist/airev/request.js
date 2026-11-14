// The pull request's own stated request as an intent source: its title and
// description, and the issues it says it closes. Everything here is untrusted
// text from the pull request's author; prompt.js fences it like the diff.
//
//   normalizeRequest(raw) -> { title, body, issues: [{ number, title, body, source }], sources } | null
//   closingIssues(text, repo, { max }) -> [issue numbers]

// Caps per piece and overall. The request goes into every batch, so it is kept
// to about 2,000 tokens (some 8,000 characters) however long the issues are.
export const REQUEST_LIMITS = Object.freeze({
  maxIssues: 3,
  titleChars: 200,
  issueChars: 2500,
  bodyChars: 3000,
  totalChars: 8000,
});

const CUT = '\n[... cut for length]';

const text = (v) => (typeof v === 'string' ? v : '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
const oneLine = (v, max) => text(v).replace(/\s+/g, ' ').slice(0, max);
const cap = (s, max) => (max <= 0 ? '' : s.length <= max ? s : `${s.slice(0, Math.max(0, max - CUT.length)).trimEnd()}${CUT}`);

// The request in the shape the prompt uses, cut to the limits; null when there
// is nothing to compare with (then the review is exactly as without it).
// raw: { title?, body?, issues?: [{ number?, title?, body?, source? }] }.
// Linked issues come first in the budget: they are what was asked.
export function normalizeRequest(raw, limits = REQUEST_LIMITS) {
  if (!raw || typeof raw !== 'object') return null;
  const lim = { ...REQUEST_LIMITS, ...limits };
  let left = lim.totalChars;
  const issues = [];
  for (const i of Array.isArray(raw.issues) ? raw.issues : []) {
    if (issues.length >= lim.maxIssues) break;
    if (!i || typeof i !== 'object') continue;
    const number = Number.isSafeInteger(i.number) && i.number > 0 ? i.number : null;
    const title = oneLine(i.title, lim.titleChars);
    const body = cap(text(i.body), Math.min(lim.issueChars, left - title.length));
    if (!title && !body) continue;
    left -= title.length + body.length;
    const source = number ? null : oneLine(i.source, 40) || 'stated request';
    issues.push({ number, title, body, source });
  }
  const title = oneLine(raw.title, lim.titleChars);
  left -= title.length;
  const body = cap(text(raw.body), Math.min(lim.bodyChars, left));
  if (!title && !body && !issues.length) return null;
  const sources = [...issues.map((i) => (i.number ? `issue #${i.number}` : i.source)), ...(body ? ['PR description'] : title ? ['PR title'] : [])];
  return { title, body, issues, sources };
}

const NAME = '[A-Za-z0-9_.-]+';
// "closes #12", "Fixes: acme/api#3", "resolved https://github.com/acme/api/issues/9".
const CLOSING = new RegExp(`(?:^|[^A-Za-z0-9_])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+(?:(${NAME}/${NAME})?#(\\d+)|https?://[^\\s/]+/(${NAME}/${NAME})/issues/(\\d+))(?![A-Za-z0-9_])`, 'gi');

// The issue numbers a pull request body closes with GitHub's closing keywords,
// in order, without repeats, only in the same repository (repo: "owner/name"),
// at most max. Code spans and fenced code are skipped.
export function closingIssues(body, repo, { max = REQUEST_LIMITS.maxIssues } = {}) {
  const s = text(body).replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const here = String(repo ?? '').toLowerCase();
  const out = [];
  for (const m of s.matchAll(CLOSING)) {
    const other = m[1] ?? m[3];
    if (other && other.toLowerCase() !== here) continue;
    const n = Number(m[2] ?? m[4]);
    if (!Number.isSafeInteger(n) || n <= 0 || out.includes(n)) continue;
    out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

// A request file for `grapim review --ai --request-file`: JSON in the shape
// above, or Markdown (or plain text) taken as the stated request itself, its
// first "# " heading as the title.
export function requestFromFile(content, file = '') {
  const t = text(content).replace(/^﻿/, '');
  if (/\.json$/i.test(file) || t.startsWith('{')) {
    const v = JSON.parse(t);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SyntaxError('expected an object like { "title", "body", "issues": [...] }');
    return v;
  }
  const m = /^#\s+(.+)$/m.exec(t);
  return { issues: [{ title: m ? m[1] : '', body: m ? t.replace(m[0], '').trim() : t, source: 'request file' }] };
}
