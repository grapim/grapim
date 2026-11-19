// The merge decision card: the top of the review's summary comment answers
// three questions in a few lines (docs: src/hub/docs/review.md, "The merge
// decision"):
//
//   What was the agent asked?   the recorded run prompts, else the PR's own
//                               title and description; the card says which
//   What did it do beyond that? deleted or skipped tests, weakened checks,
//                               migrations and CI changes the request does not
//                               mention, scope findings
//   Can I merge it?             Safe to merge | Check these first | Do not merge,
//                               with at most 3 items and one line of evidence
//
// No network and no hub imports, so the GitHub Action bundles it
// (action/bundle.mjs) and cloud review calls it from the hub. Facts come from
// the engine's own collectChanges (src/airev/diff.js, factsFromGit, the only
// function here that reads git); everything else is pure. CI results from the
// caller (GitHub's Checks and commit status APIs, or the Action's
// test-command). It never changes which findings are made or posted: it only
// reads the findings it is given.
//
// Everything from a diff, a note, a pull request or the model is untrusted and
// goes through md() or <code>; the words around it are Grapim's own.

import { createHash } from 'node:crypto';
import { md } from '../provenance/render.js';
import { isTestFile, VERDICT_RE } from './findings.js';
import { collectChanges } from './diff.js';

export const CARD_MARKER = '<!-- grapim:card -->';
export const CARD_END = '<!-- /grapim:card -->';
export const VERDICTS = Object.freeze({ safe: 'Safe to merge', check: 'Check these first', block: 'Do not merge' });
export const MAX_ITEMS = 3;

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const code = (s, max = 120) => `<code>${md(s, max)}</code>`;
const AGENT_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini CLI', 'gemini-cli': 'Gemini CLI', mcp: 'MCP agent', http: 'API agent' };
const PEOPLE_KINDS = new Set(['sync', 'undo', 'restore']);
export const agentLabel = (kind) => AGENT_NAMES[kind] ?? 'Agent';

// ---- What the diff shows: test deletions and skips, weakened checks ----

// Lines that skip or disable a test, by language. Each applies to the files
// `on` accepts: test files (isTestFile), or every Rust file (Rust keeps unit
// tests next to the code, under #[cfg(test)]).
const testy = (p) => isTestFile(p) || /(^|\/)conftest\.py$/.test(p);
export const SKIP_RULES = Object.freeze([
  { lang: 'js', on: (p) => testy(p) && /\.[cm]?[jt]sx?$/.test(p), re: /\b(?:it|test|describe|context|suite)\.(?:skip|todo)\s*\(|\bx(?:it|test|describe|context)\s*\(|\b(?:it|test|describe)\.only\s*\(|\bf(?:it|describe)\s*\(/ },
  { lang: 'python', on: (p) => testy(p) && /\.py$/.test(p), re: /@pytest\.mark\.(?:skip|skipif|xfail)\b|@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|\bpytest\.skip\s*\(|\.skipTest\s*\(/ },
  { lang: 'go', on: (p) => /_test\.go$/.test(p), re: /\b[tb]\.(?:Skip|SkipNow|Skipf)\s*\(/ },
  { lang: 'rust', on: (p) => /\.rs$/.test(p), re: /#\[ignore(?:\s*=\s*"[^"]*")?\]/ },
  { lang: 'java', on: (p) => testy(p) && /\.(?:java|kt)$/.test(p), re: /@(?:Disabled|Ignore)\b/ },
  { lang: 'ruby', on: (p) => testy(p) && /\.rb$/.test(p), re: /^\s*(?:xit|xdescribe|skip|pending)\b/ },
  { lang: 'csharp', on: (p) => testy(p) && /\.cs$/.test(p), re: /\[Ignore\b|\bSkip\s*=\s*"/ },
]);

// A test case's declaration, to count tests removed from a file that stays.
const TEST_DECL = [
  { on: (p) => /\.[cm]?[jt]sx?$/.test(p), re: /^\s*(?:it|test)\s*\(\s*['"`]/ },
  { on: (p) => /\.py$/.test(p), re: /^\s*(?:async\s+)?def\s+test_\w*\s*\(/ },
  { on: (p) => /_test\.go$/.test(p), re: /^func\s+(?:Test|Benchmark|Fuzz)\w*\s*\(/ },
  { on: (p) => /\.rs$/.test(p), re: /^\s*#\[(?:tokio::)?test\]/ },
  { on: (p) => /\.(?:java|kt|cs)$/.test(p), re: /^\s*(?:@Test\b|\[(?:Test|Fact|TestMethod)\])/ },
  { on: (p) => /\.rb$/.test(p), re: /^\s*it\s+['"]/ },
];

// Added lines that turn a check off. Kept narrow: each is something a
// reviewer wants to see named, whatever the language.
const WEAKENED = [
  { re: /eslint-disable(?!-next-line\s+no-console)/, what: 'turns off a lint rule' },
  { re: /@ts-(?:ignore|nocheck)\b/, what: 'turns off a type check' },
  { re: /#\s*(?:noqa\b|type:\s*ignore\b|pragma:\s*no cover\b)/, what: 'turns off a lint, type or coverage check' },
  { re: /\/\/\s*nolint\b|istanbul ignore|c8 ignore/, what: 'turns off a lint or coverage check' },
  { re: /@SuppressWarnings\b/, what: 'suppresses compiler warnings' },
  { re: /--no-verify\b/, what: 'skips git hooks' },
  { on: (p) => isCiFile(p), re: /continue-on-error:\s*true|\|\|\s*true\b/, what: 'lets a failing CI step pass' },
];

export const isMigration = (p) => /(^|\/)(?:migrations?|migrate|alembic|flyway)\//i.test(p) || /\.sql$/i.test(p) || /(^|\/)schema\.prisma$/.test(p);
export const isCiFile = (p) => /^\.github\/workflows\//.test(p) || /(^|\/)\.gitlab-ci\.ya?ml$/.test(p) || /^\.circleci\//.test(p) || /(^|\/)(?:Jenkinsfile|azure-pipelines\.ya?ml|\.travis\.ya?ml|bitbucket-pipelines\.ya?ml)$/.test(p);
const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|rb|cs|php|swift|scala|c|cc|cpp|h|hpp|m|mm|ex|exs|erl|clj|dart|lua|vue|svelte)$/i;
export const isSourceFile = (p) => SOURCE.test(p) && !isTestFile(p) && !/(^|\/)(?:dist|build|vendor|node_modules|generated)\//.test(p);

// Skip markers on the added lines of one file: [{ line, text, lang }].
export function testSkips(path, added) {
  const rules = SKIP_RULES.filter((r) => r.on(path));
  if (!rules.length) return [];
  const out = [];
  for (const l of added) for (const r of rules) if (r.re.test(l.text)) {
    out.push({ line: l.newLine ?? null, text: l.text.trim().slice(0, 200), lang: r.lang });
    break;
  }
  return out;
}

// Test cases a file loses: declarations removed minus declarations added.
export function removedTestCount(path, added, removed) {
  const rule = TEST_DECL.find((r) => r.on(path));
  if (!rule) return 0;
  const n = (ls) => ls.filter((l) => rule.re.test(l.text)).length;
  return Math.max(0, n(removed) - n(added));
}

// Facts the card needs, from the engine's collectChanges() result. Compact:
// paths and counts, a few lines of text for skips and weakened checks.
export function decisionFacts(changes, { maxFiles = 3000 } = {}) {
  const files = [];
  const runs = new Map();
  const skips = [];
  const weakened = [];
  const removedTests = [];
  let added = 0;
  let removed = 0;
  for (const f of (changes?.files ?? []).slice(0, maxFiles)) {
    const lines = (f.hunks ?? []).flatMap((h) => h.lines ?? []);
    const plus = lines.filter((l) => l.type === '+');
    const minus = lines.filter((l) => l.type === '-');
    added += plus.length;
    removed += minus.length;
    const agentRuns = new Set();
    for (const h of f.hunks ?? []) {
      for (const r of h.runs ?? []) {
        if (PEOPLE_KINDS.has(r.kind)) continue;
        agentRuns.add(r.id);
        const agg = runs.get(r.id) ?? { id: r.id, kind: r.kind, label: r.label || r.id, intents: [], lines: 0 };
        agg.lines += r.lines ?? 0;
        for (const i of r.intents ?? []) if (i && agg.intents.length < 3 && !agg.intents.includes(i)) agg.intents.push(String(i).slice(0, 1000));
        runs.set(r.id, agg);
      }
    }
    const test = isTestFile(f.path);
    files.push({ path: f.path, status: f.status, sensitive: !!f.sensitive, test, added: plus.length, removed: minus.length, agent: agentRuns.size > 0 });
    if (f.status === 'deleted') continue;
    for (const s of testSkips(f.path, plus)) if (skips.length < 20) skips.push({ path: f.path, ...s });
    if (test) {
      const n = removedTestCount(f.path, plus, minus);
      if (n) removedTests.push({ path: f.path, count: n });
    }
    for (const l of plus) {
      const w = WEAKENED.find((x) => (!x.on || x.on(f.path)) && x.re.test(l.text));
      if (w && weakened.length < 20) weakened.push({ path: f.path, line: l.newLine ?? null, what: w.what });
    }
  }
  return { files, runs: [...runs.values()].sort((a, b) => b.lines - a.lines), skips, weakened, removedTests, size: { files: files.length, added, removed }, truncated: (changes?.files?.length ?? 0) > maxFiles };
}

// decisionFacts of base...head in a checkout (the review worker, the
// Action), with the review's config (its sensitive and ignore lists). Never
// throws: without facts the card still renders, with less in it.
export function factsFromGit({ cwd, base, head, config, log = () => {} }) {
  try {
    return decisionFacts(collectChanges({ cwd, base, head, config, limits: { contextLines: 0 } }));
  } catch (err) {
    log(`Merge decision: the changed files could not be read (${String(err?.message ?? err).slice(0, 200)}).`);
    return null;
  }
}

// ---- What was asked ----

// runs: from the notes in the repository (facts.runs) and from the hub's
// synced notes (cloud review), merged by id. pr: { title, body, issues }.
// -> { source: 'runs' | 'pr' | 'none', items: [{ who, text }], text } where
// text is everything asked, for the topic checks below.
export function askedOf({ runs = [], pr = null } = {}) {
  const byId = new Map();
  for (const r of runs) {
    if (!r || PEOPLE_KINDS.has(r.kind)) continue;
    const intents = [...(Array.isArray(r.intents) ? r.intents : []), ...(r.intent ? [r.intent] : [])].filter((s) => typeof s === 'string' && s.trim());
    const was = byId.get(r.id);
    if (was) {
      for (const i of intents) if (!was.intents.includes(i)) was.intents.push(i);
    } else byId.set(r.id, { kind: r.kind, intents: [...new Set(intents)] });
  }
  const prompted = [...byId.values()].filter((r) => r.intents.length);
  const prText = [pr?.title, pr?.body, ...(Array.isArray(pr?.issues) ? pr.issues.flatMap((i) => [i?.title, i?.body]) : [])].filter((s) => typeof s === 'string' && s.trim()).join('\n');
  if (prompted.length) {
    const items = prompted.flatMap((r) => r.intents.slice(0, 2).map((t) => ({ who: agentLabel(r.kind), text: t })));
    return { source: 'runs', runs: byId.size, items, text: items.map((i) => i.text).join('\n') };
  }
  if (prText) {
    const title = typeof pr?.title === 'string' ? pr.title.trim() : '';
    const body = typeof pr?.body === 'string' ? pr.body.trim().split(/\n\s*\n/)[0] : '';
    return { source: 'pr', runs: byId.size, items: [{ who: null, text: title || body }], detail: title && body ? body : '', text: prText };
  }
  return { source: 'none', runs: byId.size, items: [], text: '' };
}

// What a request mentions, so a change it asked for is not called unrequested.
const MENTIONS = {
  tests: /\b(?:tests?|testing|specs?|coverage|pytest|jest|vitest|mocha|flaky)\b/i,
  migrations: /\b(?:migrat\w*|schema|columns?|tables?|database|db|sql|index(?:es)?)\b/i,
  ci: /\b(?:ci|workflows?|pipelines?|github actions?)\b/i,
  deletions: /\b(?:delet\w*|remov\w*|drop\w*|clean\s?up|unused|dead code|deprecat\w*)\b/i,
  checks: /\b(?:lint\w*|eslint|type ?check\w*|mypy|tsc|warnings?|suppress\w*|flaky|skip\w*)\b/i,
};
export const mentions = (text, topic) => MENTIONS[topic].test(String(text ?? ''));

// ---- Evidence links ----

// Links point at the pull request on GitHub: a file's diff
// (/files#diff-<sha256 of the path>, R<line> for a line), the checks tab, a
// check run, an inline comment. Without a pull request URL (a local run)
// paths are plain <code>.
const PR_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d{1,10}$/;
const HTTPS = /^https:\/\/[^\s"'<>()]+$/;
export const validPrUrl = (u) => (typeof u === 'string' && PR_URL.test(u) ? u : null);
const a = (url, inner) => (url && HTTPS.test(url) ? `<a href="${url}">${inner}</a>` : inner);
export function fileUrl(prUrl, path, line = null) {
  if (!validPrUrl(prUrl)) return null;
  return `${prUrl}/files#diff-${createHash('sha256').update(String(path)).digest('hex')}${Number.isSafeInteger(line) && line > 0 ? `R${line}` : ''}`;
}
const fileRef = (ctx, path, line = null) => a(fileUrl(ctx?.prUrl, path, line), code(line ? `${path}:${line}` : path));
const refs = (ctx, paths, n = 2) => `${paths.slice(0, n).map((p) => fileRef(ctx, p)).join(', ')}${paths.length > n ? ` and ${paths.length - n} more` : ''}`;

// ---- What it did beyond that ----

// -> [{ kind, text, path?, line?, deletion?, finding? }]: unrequested changes
// in the order a reviewer should read them. text is markdown (safe), with
// each path linked to its diff. ctx: { prUrl }.
export function beyondOf({ facts, asked, findings = [], links = new Map(), ctx = {} }) {
  const f = facts ?? { files: [], skips: [], weakened: [], removedTests: [] };
  const said = asked?.text ?? '';
  const out = [];
  const files = f.files ?? [];
  const askedTests = mentions(said, 'tests');
  const deletedTests = files.filter((x) => x.status === 'deleted' && x.test).map((x) => x.path);
  if (deletedTests.length && !(askedTests && mentions(said, 'deletions'))) out.push({ kind: 'deleted_tests', deletion: true, path: deletedTests[0], text: `Deletes ${plural(deletedTests.length, 'test file')}: ${refs(ctx, deletedTests, 3)}` });
  const removed = f.removedTests ?? [];
  if (removed.length && !(askedTests && mentions(said, 'deletions'))) {
    const n = removed.reduce((s, r) => s + r.count, 0);
    out.push({ kind: 'removed_tests', deletion: true, path: removed[0].path, text: `Removes ${plural(n, 'test case')} from ${refs(ctx, removed.map((r) => r.path))}` });
  }
  const skips = f.skips ?? [];
  if (skips.length && !(askedTests && mentions(said, 'checks'))) {
    const s = skips[0];
    out.push({ kind: 'skipped_tests', deletion: true, path: s.path, line: s.line, text: `Skips ${plural(skips.length, 'test')}: ${code(s.text, 80)} in ${fileRef(ctx, s.path, s.line)}${skips.length > 1 ? ` and ${skips.length - 1} more` : ''}` });
  }
  const weak = f.weakened ?? [];
  if (weak.length && !mentions(said, 'checks')) {
    const w = weak[0];
    out.push({ kind: 'weakened_check', path: w.path, line: w.line, text: `${w.what[0].toUpperCase()}${w.what.slice(1)}: ${fileRef(ctx, w.path, w.line)}${weak.length > 1 ? ` and ${weak.length - 1} more` : ''}` });
  }
  const migrations = files.filter((x) => x.status !== 'deleted' && isMigration(x.path)).map((x) => x.path);
  if (migrations.length && !mentions(said, 'migrations')) out.push({ kind: 'migration', path: migrations[0], text: `Changes the database: ${refs(ctx, migrations)}` });
  const ci = files.filter((x) => isCiFile(x.path)).map((x) => x.path);
  if (ci.length && !mentions(said, 'ci')) out.push({ kind: 'ci', path: ci[0], text: `Changes CI: ${refs(ctx, ci)}` });
  const agentTests = files.filter((x) => x.test && x.agent && x.status !== 'deleted').map((x) => x.path);
  if (asked?.source === 'runs' && agentTests.length && !askedTests) out.push({ kind: 'agent_tests', path: agentTests[0], text: `Edits ${plural(agentTests.length, 'test file')} the prompt did not mention: ${refs(ctx, agentTests)}` });
  const deletedOther = files.filter((x) => x.status === 'deleted' && !x.test && x.removed >= 20).map((x) => x.path);
  if (deletedOther.length && !mentions(said, 'deletions')) out.push({ kind: 'deleted_files', deletion: true, path: deletedOther[0], text: `Deletes ${plural(deletedOther.length, 'file')}: ${refs(ctx, deletedOther)}` });
  // What the reviewer itself called out of scope, linked to its comment.
  for (const x of findings.filter((y) => (y.category === 'scope' || y.category === 'intent_mismatch') && y.severity !== 'nit').slice(0, 3)) {
    const url = links.get(key(x)) ?? fileUrl(ctx.prUrl, x.path, x.line);
    out.push({ kind: 'scope_finding', finding: x, path: x.path, line: x.line, text: a(url, md(x.title, 140)) });
  }
  return out;
}

// ---- Tests: CI results and test signals ----

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

// GitHub's check runs (GET /commits/{sha}/check-runs) and combined status
// (GET /commits/{sha}/status) -> one state. null for a list that could not
// be read. ignore(name, appSlug): Grapim's own checks.
// -> { state: 'passed' | 'failed' | 'running' | 'none' | 'unknown', failed,
//      running, total, partial, urls: { name: url } }
export function ciStatus({ checkRuns = null, statuses = null, ignore = () => false } = {}) {
  if (checkRuns === null && statuses === null) return { state: 'unknown', failed: [], running: [], total: 0, partial: true, urls: {} };
  const latest = new Map();
  for (const c of Array.isArray(checkRuns) ? checkRuns : []) {
    if (!c || typeof c.name !== 'string' || ignore(c.name, c.app?.slug ?? null)) continue;
    const was = latest.get(c.name);
    if (!was || String(c.started_at ?? '') >= String(was.started_at ?? '')) latest.set(c.name, c);
  }
  const failed = [];
  const running = [];
  const urls = {};
  let total = 0;
  for (const c of latest.values()) {
    if (c.status === 'completed' && c.conclusion === 'stale') continue;
    if (typeof c.html_url === 'string' && HTTPS.test(c.html_url)) urls[c.name] = c.html_url;
    if (c.status !== 'completed') running.push(c.name);
    else if (FAILED.has(c.conclusion)) failed.push(c.name);
    total++;
  }
  const ctx = new Map();
  for (const s of Array.isArray(statuses) ? statuses : []) if (s && typeof s.context === 'string' && !ignore(s.context, null) && !ctx.has(s.context)) ctx.set(s.context, s);
  for (const s of ctx.values()) {
    total++;
    if (typeof s.target_url === 'string' && HTTPS.test(s.target_url)) urls[s.context] = s.target_url;
    if (s.state === 'failure' || s.state === 'error') failed.push(s.context);
    else if (s.state === 'pending') running.push(s.context);
  }
  const partial = checkRuns === null || statuses === null;
  const state = failed.length ? 'failed' : running.length ? 'running' : total ? 'passed' : partial ? 'unknown' : 'none';
  return { state, failed, running, total, partial, urls };
}

// The Action's test-command, run on the customer's runner: exit code -> state.
export const ciFromCommand = ({ command, exitCode, timedOut = false, ms = null, url = null }) => ({
  state: exitCode === 0 && !timedOut ? 'passed' : 'failed',
  failed: exitCode === 0 && !timedOut ? [] : [String(command)],
  running: [],
  total: 1,
  partial: false,
  urls: {},
  source: 'test-command',
  command: String(command),
  exitCode,
  timedOut,
  ms,
  ...(url && HTTPS.test(url) ? { url } : {}),
});

// Signals that sit on the Tests line, besides CI.
export function testNotes({ facts, asked }) {
  const files = facts?.files ?? [];
  const notes = [];
  const source = files.filter((f) => f.status !== 'deleted' && isSourceFile(f.path));
  const tests = files.filter((f) => f.test && f.status !== 'deleted');
  if (source.length && !tests.length) notes.push(`no test added or changed for ${plural(source.length, 'changed source file')}`);
  const deleted = files.filter((f) => f.status === 'deleted' && f.test).length;
  const skips = facts?.skips?.length ?? 0;
  const removed = (facts?.removedTests ?? []).reduce((n, r) => n + r.count, 0);
  const parts = [deleted && `deletes ${plural(deleted, 'test file')}`, removed && `removes ${plural(removed, 'test case')}`, skips && `skips ${plural(skips, 'test')}`].filter(Boolean);
  if (parts.length) notes.push(`${parts.join(', ')}${mentions(asked?.text, 'tests') ? ' (the request mentions tests)' : ''}`);
  return notes;
}

// ---- The verdict ----

const SEV_RANK = { blocker: 0, warning: 1, nit: 2 };
const key = (f) => `${f.path}\u0000${f.line}\u0000${String(f.title ?? '').toLowerCase()}`;
export const findingKey = key;
export const isHttpsUrl = (u) => typeof u === 'string' && HTTPS.test(u);

// Inline comment URLs for findings, from the pull request's review comments
// (GET /pulls/{n}/comments) that Grapim wrote: same file, the finding's last
// line, and its title in the comment's first line. -> Map key -> url.
export function findingLinks(findings, comments, isOurs = () => true) {
  const out = new Map();
  const list = (Array.isArray(comments) ? comments : []).filter((c) => c && typeof c.body === 'string' && typeof c.html_url === 'string' && HTTPS.test(c.html_url) && !c.in_reply_to_id && isOurs(c));
  for (const f of findings) {
    const end = Number.isSafeInteger(f.endLine) && f.endLine > f.line ? f.endLine : f.line;
    const title = md(f.title, 200);
    const hit = list.find((c) => c.path === f.path && (c.line ?? c.original_line) === end && c.body.split('\n')[0].includes(title));
    if (hit) out.set(key(f), hit.html_url);
  }
  return out;
}

const checksUrl = (ctx) => (validPrUrl(ctx?.prUrl) ? `${ctx.prUrl}/checks` : null);
const ciNames = (ci, list, ctx, n = 3) => `${list.slice(0, n).map((x) => a(ci.urls?.[x] ?? checksUrl(ctx), code(x, 60))).join(', ')}${list.length > n ? ` and ${list.length - n} more` : ''}`;

// -> { verdict: 'safe' | 'check' | 'block', reason, items: [{ text }], more, evidence }
// findings: what this review found and stands by (posted inline, posted on an
// earlier commit and still there, or moved to the summary); nits never count.
// reason: a few words for the heading; evidence: one line, linked.
// listed: keys (findingKey) of the findings a list under the card already
// shows (the cloud summary's findings list); those are not repeated as items,
// only counted on one line that links to the first of them.
export function verdictOf({ findings = [], beyond = [], ci = null, stats = {}, links = new Map(), moved = [], ctx = {}, listed = [] }) {
  const reviewed = stats.reviewedHunks ?? 0;
  const movedKeys = new Set(moved.map(key));
  const findingItem = (f) => {
    const sev = f.severity === 'blocker' ? 'Blocker' : 'Warning';
    const url = links.get(key(f)) ?? null;
    const title = md(f.title, 120);
    return { text: url ? `[${sev}: ${title}](${url}) · ${fileRef(ctx, f.path, f.line)}` : `${sev}: ${title} · ${fileRef(ctx, f.path, f.line)}${movedKeys.has(key(f)) ? ' (below)' : ''}` };
  };
  const ranked = [...findings].filter((f) => f.severity === 'blocker' || f.severity === 'warning').sort((x, y) => SEV_RANK[x.severity] - SEV_RANK[y.severity]);
  const blockers = ranked.filter((f) => f.severity === 'blocker');
  const warnings = ranked.filter((f) => f.severity === 'warning');
  const inList = new Set(listed);
  const below = ranked.filter((f) => inList.has(key(f)));
  const own = (list) => list.filter((f) => !inList.has(key(f))).map(findingItem);
  const sevCounts = (list) => [['blocker', 'blocker'], ['warning', 'warning']].map(([s, w]) => list.filter((f) => f.severity === s).length && plural(list.filter((f) => f.severity === s).length, w)).filter(Boolean).join(', ');
  // The findings the list below shows, said once on the evidence line and
  // linked to the first one's comment (the list's first row links there too).
  const belowUrl = below.length ? links.get(key(below[0])) ?? null : null;
  const belowText = (text) => (belowUrl && HTTPS.test(belowUrl) ? `[${text}](${belowUrl})` : text);
  const failedCi = ci?.state === 'failed';
  const span = `${reviewed}${stats.hunks ? ` of ${stats.hunks}` : ''} changed ${stats.hunks === 1 || (!stats.hunks && reviewed === 1) ? 'hunk' : 'hunks'}`;
  if (blockers.length || failedCi) {
    const items = [...own(blockers), ...(failedCi ? [{ text: `Failing: ${ciNames(ci, ci.failed, ctx)}` }] : []), ...own(warnings)];
    const reason = [blockers.length && plural(blockers.length, 'blocker'), failedCi && plural(ci.failed.length, 'failing check')].filter(Boolean).join(', ');
    const allBelow = below.length > 0 && below.length === ranked.length;
    let evidence = `Reviewed ${span}`;
    if (blockers.length) evidence += `: ${allBelow ? belowText(`${sevCounts(ranked)}, listed below`) : sevCounts(ranked)}`;
    if (failedCi) evidence += '; CI failed';
    if (below.length && !(blockers.length && allBelow)) evidence += `; ${belowText(`${sevCounts(below)}, listed below`)}`;
    return { verdict: 'block', reason, items: items.slice(0, MAX_ITEMS), more: Math.max(0, items.length - MAX_ITEMS), evidence: `${evidence}.` };
  }
  const beyondItems = beyond.filter((b) => !(b.kind === 'scope_finding' && b.finding?.severity === 'warning')).map((b) => ({ text: b.text }));
  const items = [...(reviewed ? [] : [{ text: 'Grapim could not review these changes: read them yourself' }]), ...own(warnings), ...beyondItems];
  if (items.length || warnings.length) {
    const reason = [!reviewed && 'nothing reviewed', warnings.length && plural(warnings.length, 'warning'), beyondItems.length && `${plural(beyondItems.length, 'change')} beyond the request`].filter(Boolean).join(', ');
    const evidence = reviewed ? `Reviewed ${span}; no blocker${below.length ? `; ${belowText(`${sevCounts(below)}, listed below`)}` : ''}.` : 'Nothing was sent to the model.';
    return { verdict: 'check', reason, items: items.slice(0, MAX_ITEMS), more: Math.max(0, items.length - MAX_ITEMS), evidence };
  }
  const wait = ci?.state === 'running' ? 'once CI passes' : ci?.state === 'none' ? 'no CI ran' : ci?.state === 'unknown' ? 'CI not read' : '';
  return { verdict: 'safe', reason: wait, items: [], more: 0, evidence: `Reviewed ${span}: no blocker or warning, nothing beyond the request.` };
}

// ---- Rendering ----

function askedLine(asked) {
  const quote = (t) => md(t, 240);
  if (asked.source === 'runs') {
    const shown = asked.items.slice(0, 2).map((i) => `${i.who}: “${quote(i.text)}”`).join(' · ');
    return `**Asked** (${asked.items.length === 1 ? 'run prompt' : 'run prompts'}) ${shown}${asked.items.length > 2 ? ` · and ${plural(asked.items.length - 2, 'more prompt')}` : ''}`;
  }
  if (asked.source === 'pr') return `**Asked** (PR title and description${asked.runs ? '; its agent runs recorded no prompt' : ', no recorded agent run'}) “${quote(asked.items[0].text)}”`;
  return '**Asked** · not stated: no recorded run prompt and no PR description.';
}

function testsLine(ci, notes, ctx) {
  const all = checksUrl(ctx);
  let s;
  if (!ci) s = 'not checked.';
  else if (ci.source === 'test-command') s = ci.state === 'passed' ? `${a(ci.url, 'passed')}: ${code(ci.command, 80)} exited 0 on your runner.` : `${a(ci.url, 'failed')}: ${code(ci.command, 80)} ${ci.timedOut ? 'timed out' : `exited ${ci.exitCode}`} on your runner.`;
  else if (ci.state === 'passed') s = `${a(all, `passed, ${plural(ci.total, 'check')}`)}.`;
  else if (ci.state === 'failed') s = `failed: ${ciNames(ci, ci.failed, ctx, 4)}.`;
  else if (ci.state === 'running') s = `still running: ${ciNames(ci, ci.running, ctx, 3)}.${ci.live ? ' This card updates when they finish.' : ''}`;
  else if (ci.state === 'none') s = 'no CI ran on this commit.';
  else if (ci.state === 'skipped') s = 'not run. Set the `test-command` input to run them before the review.';
  else s = `could not read the CI results${ci.reason ? ` (${ci.reason})` : ''}.`;
  return `**Tests** · ${s}${notes.length ? ` ${notes.map((n) => `${n[0].toUpperCase()}${n.slice(1)}.`).join(' ')}` : ''}`;
}

// card: { asked, beyond, verdict (verdictOf), ci, notes, ctx }; gate: one line
// of markdown from the merge gate, or ''. The verdict is the first line;
// every claim links to what shows it. -> markdown between CARD_MARKER and CARD_END.
export function renderCard({ asked, beyond, verdict, ci, notes = [], ctx = {}, gate = '' }) {
  const out = [CARD_MARKER, `### ${VERDICTS[verdict.verdict]}${verdict.reason ? ` · ${verdict.reason}` : ''}`, '', verdict.evidence, ''];
  if (verdict.items.length) {
    verdict.items.forEach((it, i) => out.push(`${i + 1}. ${it.text}`));
    if (verdict.more) out.push(`${verdict.items.length + 1}. and ${plural(verdict.more, 'more')} below`);
    out.push('');
  }
  out.push(askedLine(asked), '');
  const listed = new Set(verdict.items.map((i) => i.text));
  const rest = beyond.filter((b) => !listed.has(b.text));
  if (!beyond.length) out.push('**Beyond the request** · nothing Grapim could see.', '');
  else if (rest.length) {
    out.push('**Also beyond the request**', '');
    for (const b of rest.slice(0, 5)) out.push(`- ${b.text}`);
    if (rest.length > 5) out.push(`- and ${plural(rest.length - 5, 'more')}`);
    out.push('');
  }
  out.push(testsLine(ci, notes, ctx), '');
  if (gate) out.push(gate, '');
  out.push(CARD_END);
  return out.join('\n');
}

// Everything from one review -> the card's parts (no gate line yet).
// input: { facts, runs (hub runs, optional), pr: { title, body, issues },
//   findings, stats, ci, links, moved, prUrl }
export function decideCard({ facts = null, runs = [], pr = null, findings = [], stats = {}, ci = null, links = new Map(), moved = [], prUrl = null, listed = [] }) {
  const ctx = { prUrl: validPrUrl(prUrl) };
  const asked = askedOf({ runs: [...(facts?.runs ?? []), ...runs], pr });
  const beyond = beyondOf({ facts, asked, findings, links, ctx });
  const verdict = verdictOf({ findings, beyond, ci, stats, links, moved, ctx, listed });
  const notes = testNotes({ facts, asked });
  return { asked, beyond, verdict, ci, notes, ctx };
}

// The card again with new CI results (cloud review, when CI finishes after
// the review). card: what decideCard returned (stored as JSON).
export function withCi(card, ci, { findings = [], stats = {}, links = new Map(), moved = [], listed = [] } = {}) {
  return { ...card, ci, verdict: verdictOf({ findings, beyond: card.beyond, ci, stats, links, moved, ctx: card.ctx ?? {}, listed }) };
}

// The check run's title in the card's words: "Do not merge: 1 failing check".
export const verdictTitle = (verdict) => `${VERDICTS[verdict.verdict]}${verdict.reason ? `: ${verdict.reason}` : ''}`;

// The review summary under a card: its "Fix before merging" line goes, since
// the card's heading already gives the verdict (it stays without a card).
export const withoutVerdict = (summary) => String(summary ?? '').replace(VERDICT_RE, '');

// Replaces the card in a summary comment, or puts one on top (after the
// first line, the comment's marker).
export function spliceCard(body, cardMd) {
  const s = String(body ?? '');
  const i = s.indexOf(CARD_MARKER);
  const j = s.indexOf(CARD_END);
  if (i >= 0 && j > i) return `${s.slice(0, i)}${cardMd}${s.slice(j + CARD_END.length)}`;
  const nl = s.indexOf('\n');
  return nl < 0 ? `${s}\n${cardMd}\n` : `${s.slice(0, nl + 1)}${cardMd}\n\n${s.slice(nl + 1)}`;
}
