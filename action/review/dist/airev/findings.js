// The model's answer -> validated findings, the maxComments cap, and the
// short Markdown summary.

import { md } from '../provenance/render.js';
import { SEVERITIES, CATEGORIES, CONFIDENCES } from './prompt.js';

export const SEVERITY_RANK = Object.freeze({ blocker: 3, warning: 2, nit: 1 });
export const CONFIDENCE_RANK = Object.freeze({ high: 3, medium: 2, low: 1 });
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

const MAX_SUGGESTION = 4000;
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
    // An answer without a confidence (an older provider, a team's own gateway) counts as sure.
    const finding = { path: f.path, line: f.line, side: 'RIGHT', severity: f.severity, confidence: CONFIDENCES.includes(f.confidence) ? f.confidence : 'high', category: CATEGORIES.includes(f.category) ? f.category : 'other', title: clean(f.title, MAX_TITLE), body: clean(f.body, MAX_BODY) };
    // A multi-line finding ends on an added line of the same hunk.
    if (Number.isSafeInteger(f.end_line) && f.end_line > f.line && hunk.added.has(f.end_line)) finding.endLine = f.end_line;
    // A one-click fix for exactly those lines; kept only when the range the
    // comment covers is the range the model gave.
    const sameRange = (finding.endLine ?? finding.line) === (Number.isSafeInteger(f.end_line) && f.end_line >= f.line ? f.end_line : f.line);
    if (typeof f.suggestion === 'string' && f.suggestion.trim() && f.suggestion.length <= MAX_SUGGESTION && sameRange) finding.suggestion = f.suggestion.replace(/\u0000/g, '').replace(/\s+$/, '');
    out.push(finding);
  }
  return { findings: out, dropped };
}

// Low-confidence findings are not posted as inline comments: the summary lists
// them under "Worth a look", so a doubtful point costs one line, not a thread.
export function splitByConfidence(findings) {
  return { sure: findings.filter((f) => f.confidence !== 'low'), held: findings.filter((f) => f.confidence === 'low') };
}

// Findings of several passes over the same request (each carries `pass`) ->
// one list. Two passes word the same problem differently, so the test is
// place, not text: a finding within NEAR_LINES of one from another pass, in
// the same file, is that finding again. The surer wording is kept (then the
// more severe, then the earlier pass) and `raised` counts the passes that
// found it. Findings of one pass are never merged with each other: the model
// was told one finding per problem, so two of them close together are two
// problems. With a single pass the list comes back as it was.
const NEAR_LINES = 3;
const gap = (a, b) => {
  const [a1, a2, b1, b2] = [a.line, a.endLine ?? a.line, b.line, b.endLine ?? b.line];
  return a2 < b1 ? b1 - a2 : b2 < a1 ? a1 - b2 : 0;
};
export function mergePasses(findings) {
  const several = findings.some((f) => (f.pass ?? 0) > 0);
  const out = [];
  for (const f of [...findings].sort((a, b) => (a.pass ?? 0) - (b.pass ?? 0))) {
    const { pass = 0, ...rest } = f;
    const twin = out.find((o) => o.finding.path === rest.path && !o.passes.has(pass) && gap(o.finding, rest) <= NEAR_LINES);
    if (!twin) {
      out.push({ finding: rest, passes: new Set([pass]) });
      continue;
    }
    twin.passes.add(pass);
    const rank = (x) => (CONFIDENCE_RANK[x.confidence] ?? CONFIDENCE_RANK.high) * 10 + SEVERITY_RANK[x.severity];
    if (rank(rest) > rank(twin.finding)) twin.finding = rest;
  }
  return out.map((o) => (several ? { ...o.finding, raised: o.passes.size } : o.finding));
}

// Most severe first, then what more passes raised, then the surest, then by
// file and line; the same problem twice is kept once.
export function rankFindings(findings) {
  const seen = new Set();
  const conf = (f) => CONFIDENCE_RANK[f.confidence] ?? CONFIDENCE_RANK.high;
  return [...findings]
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (b.raised ?? 1) - (a.raised ?? 1) || conf(b) - conf(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line)
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

const OWN_SOURCE = /^(issue #[1-9][0-9]{0,9}|PR description|PR title)$/;

// The bold counts at the top of the summary, only the severities found:
// **2 blockers, 1 warning** or **No problems found**. COUNTS_RE matches either,
// so the cloud worker can recount after the second look (withCounts).
export function countsBold(n) {
  const parts = [n.blocker && plural(n.blocker, 'blocker'), n.warning && plural(n.warning, 'warning'), n.nit && plural(n.nit, 'nit')].filter(Boolean);
  return parts.length ? `**${parts.join(', ')}**` : '**No problems found**';
}
export const COUNTS_RE = /\*\*(?:No problems found|\d[\d,]* (?:blockers?|warnings?|nits?)(?:, \d[\d,]* (?:blockers?|warnings?|nits?))*)\*\*/;

// The "Worth a look" block of the summary (renderReviewSummary).
export const WORTH_RE = /\n\n\*\*Worth a look\*\*[^\n]*(?:\n- [^\n]*)*/;

// The verdict under the counts: what to fix before merging, from the blocker
// titles (no model call). Empty when there is no blocker. Titles go through md().
export const VERDICT_RE = /\n\n\*\*Fix before merging:\*\*[^\n]*/;
export function verdictLine(findings) {
  const blockers = findings.filter((f) => f.severity === 'blocker');
  if (!blockers.length) return '';
  const shown = blockers.slice(0, 3).map((f) => md(String(f.title ?? '').replace(/[.\s]+$/, ''), 120));
  return `\n\n**Fix before merging:** ${shown.join('; ')}${blockers.length > 3 ? `; and ${plural(blockers.length - 3, 'more')}` : ''}.`;
}

// hosted: the review ran on Grapim's server (cloud review), not in the
// customer's CI, so the last line must not say Grapim received nothing.
// Up front: the counts and the verdict, what the agents were asked, tests
// deleted and points to check. The mechanics (what was reviewed or skipped,
// model, tokens, where the code went on Grapim's server) sit in a collapsed
// "Review details", as the leading review bots do. In your own CI the last
// line stays visible: your code went only to your model account.
export function renderReviewSummary({ findings, stats, skipped, runs, providerText, requests, deletedTests = [], held = [], hosted = false }) {
  const n = (s) => findings.filter((f) => f.severity === s).length;
  const lines = ['### <a href="https://github.com/grapim/grapim">Grapim Review</a>', ''];
  const files = new Set(findings.map((f) => f.path)).size;
  if (findings.length) lines.push(`${countsBold({ blocker: n('blocker'), warning: n('warning'), nit: n('nit') })} in ${plural(files, 'file')}.${verdictLine(findings)}`);
  else if (stats.reviewedHunks) lines.push('**No problems found** in the reviewed changes.');
  else lines.push('**Nothing was reviewed.**');
  const human = stats.reviewedHunks - stats.reviewedAiHunks;
  // Without notes nobody is known to have written anything: do not call it human.
  const who = stats.noNotes ? 'no agent notes in this repository, so every changed line was a candidate' : `${stats.reviewedAiHunks} written by agent runs, ${human} human-written`;
  const detail = [`Reviewed ${plural(stats.reviewedHunks, 'hunk')} of ${stats.hunks} changed (${who}) in ${plural(stats.reviewedFiles, 'file')} of ${stats.files}.`];
  // The sources are Grapim's own labels ("issue #12", "PR description"), except
  // a caller-named source, which goes through md().
  if (stats.comparedWith?.length) lines.push('', `**Compared with:** ${stats.comparedWith.map((s) => (OWN_SOURCE.test(s) ? s : md(s, 60))).join(', ')}.`);

  if (deletedTests.length) {
    lines.push('', `**Tests deleted:** this pull request deletes ${plural(deletedTests.length, 'test file')}: ${deletedTests.slice(0, 5).map(code).join(', ')}${deletedTests.length > 5 ? ` and ${plural(deletedTests.length - 5, 'more')}` : ''}. Check that was intended.`);
  }

  if (held.length) {
    // WORTH_RE finds this block again (the cloud's second look replaces it).
    lines.push('', `**Worth a look** (${plural(held.length, 'point')} the review could not confirm from the code it saw, not posted inline)`);
    for (const f of held.slice(0, 5)) lines.push(`- ${code(f.path)} line ${f.line}: ${md(f.title, 160)}`);
    if (held.length > 5) lines.push(`- and ${plural(held.length - 5, 'more')}`);
  }

  if (runs.length) {
    lines.push('', '**Agent runs reviewed**');
    for (const r of runs.slice(0, 10)) lines.push(`- ${AGENT_NAMES[r.kind] ?? 'Agent'}${r.label && r.label !== r.kind ? ` (${md(r.label, 60)})` : ''}, ${plural(r.hunks, 'hunk')}, depth ${r.depth}${r.intent ? `: "${md(r.intent, 140)}"` : ''}`);
    if (runs.length > 10) lines.push(`- and ${plural(runs.length - 10, 'more run')}`);
  }

  if (skipped.length) {
    detail.push('', '**Not reviewed**');
    const byReason = new Map();
    for (const s of skipped) {
      if (!byReason.has(s.reason)) byReason.set(s.reason, []);
      byReason.get(s.reason).push(s.path);
    }
    for (const [reason, paths] of byReason) {
      const shown = paths.slice(0, 5).map(code).join(', ');
      detail.push(`- ${reason}: ${shown}${paths.length > 5 ? ` and ${plural(paths.length - 5, 'more file')}` : ''}`);
    }
  }

  const notes = [];
  if (stats.droppedFindings) notes.push(`${plural(stats.droppedFindings, 'finding')} dropped (not on a changed line)`);
  if (stats.omittedFindings) notes.push(`${plural(stats.omittedFindings, 'finding')} left out over the comment limit`);
  detail.push('', `Model: ${stats.model} on ${providerText}. ${plural(requests, 'request')}${stats.passes > 1 ? ` (${stats.passes} passes over each change)` : ''}, ${stats.inputTokens.toLocaleString('en-US')} input and ${stats.outputTokens.toLocaleString('en-US')} output tokens.${notes.length ? ` ${notes.join('; ')}.` : ''}`);
  if (hosted) detail.push('', `This review ran on Grapim's server: the code was fetched into a temporary folder there, ${requests ? `sent only to ${providerText}` : 'sent to no model'}, and deleted when the review ended.`);
  lines.push('', '<details><summary>Review details</summary>', '', ...detail, '', '</details>');
  if (!hosted) lines.push('', requests ? `Your code was sent only to ${providerText}. Grapim received nothing.` : 'No code was sent to any model. Grapim received nothing.');
  return lines.join('\n');
}
