// The model's answer -> validated findings, the maxComments cap, and the
// short Markdown summary.

import { md } from '../provenance/render.js';
import { SEVERITIES, CATEGORIES } from './prompt.js';

export const SEVERITY_RANK = Object.freeze({ blocker: 3, warning: 2, nit: 1 });
const MAX_TITLE = 200;
const MAX_BODY = 4000;

// The JSON text of a message (its text blocks), parsed; null if it is not JSON.
export function parseFindingsText(message) {
  const text = (message?.content ?? []).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
  if (!text.trim()) return null;
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let v = tryParse(text.trim());
  if (v === undefined) {
    // A fenced block, or prose around one object: take the outermost braces.
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a >= 0 && b > a) v = tryParse(text.slice(a, b + 1));
  }
  return v && typeof v === 'object' ? v : null;
}

const clean = (s, max) => String(s).replace(/\u0000/g, '').trim().slice(0, max);

// Keeps the findings that are well formed and sit on an added line of a hunk
// the batch reviewed. allowed: Map path -> [{ added: Set, start, end }] (one
// entry per hunk). Returns { findings, dropped }.
export function validateFindings(parsed, allowed) {
  const list = Array.isArray(parsed?.findings) ? parsed.findings : null;
  if (!list) return { findings: [], dropped: 0, malformed: true };
  const out = [];
  let dropped = 0;
  for (const f of list) {
    const ok =
      f && typeof f === 'object' &&
      typeof f.path === 'string' && allowed.has(f.path) &&
      Number.isSafeInteger(f.line) &&
      SEVERITIES.includes(f.severity) &&
      typeof f.title === 'string' && f.title.trim() &&
      typeof f.body === 'string';
    const hunk = ok ? allowed.get(f.path).find((h) => h.added.has(f.line)) : null;
    if (!hunk) {
      dropped++;
      continue;
    }
    const finding = { path: f.path, line: f.line, side: 'RIGHT', severity: f.severity, category: CATEGORIES.includes(f.category) ? f.category : 'other', title: clean(f.title, MAX_TITLE), body: clean(f.body, MAX_BODY) };
    // A multi-line finding ends on an added line of the same hunk.
    if (Number.isSafeInteger(f.end_line) && f.end_line > f.line && hunk.added.has(f.end_line)) finding.endLine = f.end_line;
    out.push(finding);
  }
  return { findings: out, dropped };
}

// Most severe first, then by file and line; the same problem twice is kept once.
export function rankFindings(findings) {
  const seen = new Set();
  return [...findings]
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line)
    .filter((f) => {
      const k = `${f.path}\u0000${f.line}\u0000${f.title.toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

// Keeps at most max findings, the most severe; the rest stay in file/line order.
export function capFindings(findings, max) {
  const ranked = rankFindings(findings);
  return { kept: ranked.slice(0, max), omitted: Math.max(0, ranked.length - max) };
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const code = (p) => `<code>${md(p, 120)}</code>`;

// The summary comment: counts, the runs reviewed and at what depth, what was
// skipped and why, model and provider, and where the code went. Reasons,
// the model id and the provider text are Grapim's own (validated) words;
// everything from the repo or a note goes through md().
// Grapim's own names for agent kinds (never repo text).
const AGENT_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini CLI', 'gemini-cli': 'Gemini CLI', mcp: 'MCP agent', http: 'API agent' };

// Test files, by the common conventions. Deleting one is a weakened check that
// no inline comment can sit on (a deleted file has no new lines), so the
// summary names it without asking the model.
const TEST_FILE = /(^|\/)(test|tests|__tests__|spec|specs)\/|\.(test|spec)\.[^/]+$|_test\.(go|py|rb|exs?)$|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|cs|swift)$/;
export const isTestFile = (p) => TEST_FILE.test(String(p ?? ''));

export function renderReviewSummary({ findings, stats, skipped, runs, providerText, requests, deletedTests = [] }) {
  const n = (s) => findings.filter((f) => f.severity === s).length;
  const lines = ['### Grapim Review', ''];
  const files = new Set(findings.map((f) => f.path)).size;
  if (findings.length) lines.push(`**${plural(n('blocker'), 'blocker')}, ${plural(n('warning'), 'warning')}, ${plural(n('nit'), 'nit')}** in ${plural(files, 'file')}.`);
  else if (stats.reviewedHunks) lines.push('**No problems found** in the reviewed changes.');
  else lines.push('**Nothing was reviewed.**');
  const human = stats.reviewedHunks - stats.reviewedAiHunks;
  lines.push(`Reviewed ${plural(stats.reviewedHunks, 'hunk')} of ${stats.hunks} changed (${stats.reviewedAiHunks} written by agent runs, ${human} human-written) in ${plural(stats.reviewedFiles, 'file')} of ${stats.files}.`);

  if (deletedTests.length) {
    lines.push('', `**Tests deleted:** this pull request deletes ${plural(deletedTests.length, 'test file')}: ${deletedTests.slice(0, 5).map(code).join(', ')}${deletedTests.length > 5 ? ` and ${plural(deletedTests.length - 5, 'more')}` : ''}. Check that was intended.`);
  }

  if (runs.length) {
    lines.push('', '**Agent runs reviewed**');
    for (const r of runs.slice(0, 10)) lines.push(`- ${AGENT_NAMES[r.kind] ?? 'Agent'}${r.label && r.label !== r.kind ? ` (${md(r.label, 60)})` : ''}, ${plural(r.hunks, 'hunk')}, depth ${r.depth}${r.intent ? `: "${md(r.intent, 140)}"` : ''}`);
    if (runs.length > 10) lines.push(`- and ${plural(runs.length - 10, 'more run')}`);
  }

  if (skipped.length) {
    lines.push('', '**Not reviewed**');
    const byReason = new Map();
    for (const s of skipped) {
      if (!byReason.has(s.reason)) byReason.set(s.reason, []);
      byReason.get(s.reason).push(s.path);
    }
    for (const [reason, paths] of byReason) {
      const shown = paths.slice(0, 5).map(code).join(', ');
      lines.push(`- ${reason}: ${shown}${paths.length > 5 ? ` and ${plural(paths.length - 5, 'more file')}` : ''}`);
    }
  }

  const notes = [];
  if (stats.droppedFindings) notes.push(`${plural(stats.droppedFindings, 'finding')} dropped (not on a changed line)`);
  if (stats.omittedFindings) notes.push(`${plural(stats.omittedFindings, 'finding')} left out over the comment limit`);
  lines.push('', `Model: ${stats.model} on ${providerText}. ${plural(requests, 'request')}, ${stats.inputTokens.toLocaleString('en-US')} input and ${stats.outputTokens.toLocaleString('en-US')} output tokens.${notes.length ? ` ${notes.join('; ')}.` : ''}`);
  lines.push('', requests ? `Your code was sent only to ${providerText}. Grapim received nothing.` : 'No code was sent to any model. Grapim received nothing.');
  return lines.join('\n');
}
