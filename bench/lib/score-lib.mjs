// Matching tool findings to ground-truth issues, and the per-tool metrics.
// Pure functions (tested in test/bench-score.test.js).
//
// A finding matches an issue when it is on the same file and either
//   - its lines are within ±window (default 10) of the issue's lines, or
//   - its category equals the issue's category.
// Tools that give no category (PR-Agent, the Claude action) get one inferred
// from the finding's text by inferCategory, the same rules for every tool.

export const CATEGORIES = Object.freeze(['correctness', 'security', 'data_loss', 'destructive_migration', 'secret', 'weakened_check', 'scope', 'intent_mismatch', 'performance', 'other']);

// $ per million tokens, claude-opus-5-5 on the Claude API (the claude-api
// skill's model table, cached 2026-11-03; src/hub/agent/index.js PRICES).
// Cache writes are 1.25x input (5-minute TTL).
export const PRICES = Object.freeze({
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
});

export function costUsd(usage, model = 'claude-opus-5-5') {
  if (!usage) return 0;
  const p = PRICES[model] ?? PRICES['claude-opus-5-5'];
  return ((usage.input ?? 0) * p.input + (usage.output ?? 0) * p.output + (usage.cacheRead ?? 0) * p.cacheRead + (usage.cacheWrite ?? 0) * p.cacheWrite) / 1e6;
}

export function normPath(p) {
  if (typeof p !== 'string') return null;
  let s = p.trim().replace(/\\/g, '/').replace(/^`|`$/g, '');
  s = s.replace(/^(?:\.\/)+/, '').replace(/^[ab]\//, '').replace(/^\/+/, '');
  return s || null;
}

export function samePath(a, b) {
  const x = normPath(a);
  const y = normPath(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // One tool may print a shorter or longer prefix: match on a "/" boundary.
  return x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

const RULES = [
  ['secret', /\b(?:hard[- ]?coded|leak(?:ed|s)?|exposed?)\b[^.]{0,40}\b(?:secret|token|api[- ]?key|password|credential)s?|\b(?:secret|api[- ]?key|password|credential|private key)s?\b[^.]{0,40}\b(?:committed|in (?:the )?(?:code|repo|log)s?|logged|hard[- ]?coded)/i],
  ['destructive_migration', /\bmigrations?\b[^.]{0,60}\b(?:drop|delet|truncat|irrevers|destruct|data loss)|\b(?:drop(?:s|ping)?|alter(?:s|ing)?)\s+(?:the\s+)?(?:table|column|index)\b/i],
  ['data_loss', /\bdata[- ]loss\b|\b(?:los(?:e|es|t|ing)|overwrit(?:e|es|ten|ing)|wip(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|clobber)\b[^.]{0,40}\b(?:data|records?|rows?|files?|user|history|state|changes)\b/i],
  ['weakened_check', /\b(?:test|assert(?:ion)?|check|validation|lint|type[- ]check|CI)s?\b[^.]{0,40}\b(?:removed|deleted|skipped|disabled|weakened|loosened|commented out|no longer)\b|\b(?:remov|delet|skip|disabl|weaken|loosen)(?:e|es|ed|ing)?\b[^.]{0,30}\b(?:tests?|assertions?|checks?|validation)\b|@ts-ignore|eslint-disable|\.skip\(|xit\(|pytest\.mark\.skip/i],
  ['security', /\b(?:security|vulnerab|injection|xss|csrf|ssrf|rce|sanitiz|escap(?:e|ing)|authori[sz]|authenticat|permission|privilege|traversal|insecure|unsafe|tls|certificate|cve)\w*/i],
  ['scope', /\b(?:out of scope|unrelated|beyond (?:the )?(?:scope|request|task|issue)|not (?:asked|requested)|scope creep|unnecessary change|should not (?:be )?(?:changed|modified|touched)|revert (?:this|these) change)/i],
  ['intent_mismatch', /\b(?:does(?:n't| not) (?:address|implement|fix|match|do what)|not what (?:the )?(?:issue|request|task)|contradicts the (?:issue|request|spec)|misread|misunderst|instead of what)/i],
  ['performance', /\b(?:performance|slow|O\(n\^?2\)|quadratic|n\+1|inefficien|allocat|memory leak|leak|cache miss|hot path|blocking call|unbounded)\w*/i],
  ['correctness', /\b(?:bug|incorrect|wrong|broken|break(?:s|ing)?|crash|null|undefined|nil|exception|throws?|off[- ]by[- ]one|race|deadlock|regression|fail(?:s|ure)?|error|mismatch|missing|never|always|invalid)\b/i],
];

export function inferCategory(text) {
  const t = String(text ?? '');
  for (const [cat, re] of RULES) if (re.test(t)) return cat;
  return 'other';
}

export function categoryOf(f) {
  return CATEGORIES.includes(f?.category) ? f.category : inferCategory(`${f?.title ?? ''}\n${f?.body ?? ''}`);
}

// Distance between two inclusive line ranges (0 when they overlap).
export function lineDistance(a1, a2, b1, b2) {
  const [x1, x2] = [a1, a2 ?? a1].sort((p, q) => p - q);
  const [y1, y2] = [b1, b2 ?? b1].sort((p, q) => p - q);
  if (x2 < y1) return y1 - x2;
  if (y2 < x1) return x1 - y2;
  return 0;
}

// -> null, or how it matched: 'line' | 'category'
// lineOnly: the strict rule, lines only (issues without a line still match by category).
export function matchFinding(f, issue, { window = 10, lineOnly = false } = {}) {
  if (!samePath(f?.path, issue?.path)) return null;
  const fl = Number.isFinite(f.line) ? f.line : null;
  const il = Number.isFinite(issue.line) ? issue.line : null;
  if (fl !== null && il !== null) {
    const fe = Number.isFinite(f.end_line) ? f.end_line : fl;
    const ie = Number.isFinite(issue.end_line) ? issue.end_line : il;
    if (lineDistance(fl, fe, il, ie) <= window) return 'line';
  }
  if (lineOnly && il !== null) return null;
  if (issue.category && categoryOf(f) === issue.category) return 'category';
  return null;
}

// One PR: which issues were found, which findings are true positives.
// judged: optional Map "findingIndex:issueIndex" -> boolean from the LLM judge
// (true adds a match the rules missed; false removes a rule match).
export function scorePr(pr, findings, { window = 10, judged = null, lineOnly = false } = {}) {
  const issues = pr.issues ?? [];
  const found = new Array(issues.length).fill(false);
  const tp = new Array(findings.length).fill(false);
  const pairs = [];
  findings.forEach((f, fi) => {
    issues.forEach((iss, ii) => {
      let how = matchFinding(f, iss, { window, lineOnly });
      const j = judged?.get(`${fi}:${ii}`);
      if (j === false) how = null;
      else if (j === true && !how) how = 'judge';
      if (how) {
        found[ii] = true;
        tp[fi] = true;
        pairs.push({ finding: fi, issue: ii, how });
      }
    });
  });
  return { found, tp, pairs, issues: issues.length, findings: findings.length, foundCount: found.filter(Boolean).length, tpCount: tp.filter(Boolean).length };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// results: Map prId -> tool result (from bench/results/<tool>/<id>.json).
export function scoreTool(prs, results, opts = {}) {
  const per = [];
  let issues = 0;
  let found = 0;
  let findings = 0;
  let tp = 0;
  let cleanFindings = 0;
  let cleanPrs = 0;
  let cleanPrsFlagged = 0;
  const costs = [];
  const secs = [];
  let ran = 0;
  let missing = 0;
  let failed = 0;
  let skipped = 0;
  let foundStrict = 0;
  let tpStrict = 0;
  const byCat = {};
  for (const pr of prs) {
    const r = results.get(pr.id);
    if (!r) {
      missing++;
      continue;
    }
    if (r.status === 'skipped') {
      skipped++;
      continue;
    }
    if (r.status !== 'ok') {
      failed++;
      continue;
    }
    ran++;
    const fs = r.findings ?? [];
    const s = scorePr(pr, fs, { window: opts.window, judged: opts.judged?.get?.(pr.id) ?? null });
    issues += s.issues;
    found += s.foundCount;
    const strict = scorePr(pr, fs, { window: opts.window, lineOnly: true });
    foundStrict += strict.foundCount;
    tpStrict += strict.tpCount;
    findings += s.findings;
    tp += s.tpCount;
    (pr.issues ?? []).forEach((iss, i) => {
      const c = (byCat[iss.category] ??= { issues: 0, found: 0 });
      c.issues++;
      if (s.found[i]) c.found++;
    });
    if (!(pr.issues ?? []).length) {
      cleanPrs++;
      cleanFindings += s.findings;
      if (s.findings) cleanPrsFlagged++;
    }
    costs.push(r.cost_usd ?? costUsd(r.usage));
    if (Number.isFinite(r.seconds)) secs.push(r.seconds);
    per.push({ id: pr.id, ...s });
  }
  const recall = issues ? found / issues : null;
  const precision = findings ? tp / findings : null;
  return {
    ran,
    missing,
    failed,
    skipped,
    foundStrict,
    tpStrict,
    recallStrict: issues ? foundStrict / issues : null,
    precisionStrict: findings ? tpStrict / findings : null,
    issues,
    found,
    findings,
    tp,
    recall,
    precision,
    f1: recall !== null && precision !== null && recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : null,
    commentsPerPr: ran ? findings / ran : null,
    cleanPrs,
    cleanFindingsPerPr: cleanPrs ? cleanFindings / cleanPrs : null,
    cleanPrsFlagged,
    costPerPr: mean(costs),
    costTotal: costs.reduce((a, b) => a + b, 0),
    secondsPerPr: mean(secs),
    secondsMedian: median(secs),
    byCategory: byCat,
    per,
  };
}

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const num = (x, d = 2) => (x === null || x === undefined ? 'n/a' : x.toFixed(d));

export function reportMarkdown(scores, { title = 'Grapim Review benchmark', prs = [], note = '' } = {}) {
  const tools = Object.keys(scores);
  const L = [];
  L.push(`# ${title}`, '');
  const problem = prs.filter((p) => p.issues?.length).length;
  L.push(`${prs.length} PRs (${problem} with ground-truth problems, ${prs.length - problem} clean), ${prs.reduce((n, p) => n + (p.issues?.length ?? 0), 0)} ground-truth issues.${note ? ` ${note}` : ''}`, '');
  L.push('| Tool | PRs run | Recall | Precision | F1 | Recall, lines only | Precision, lines only | Comments / PR | Findings on clean PRs (per PR) | Cost / PR | Time / PR (mean, median) |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const t of tools) {
    const s = scores[t];
    L.push(`| ${t} | ${s.ran}${s.failed ? ` (+${s.failed} failed)` : ''}${s.skipped ? ` (${s.skipped} skipped)` : ''}${s.missing ? ` (${s.missing} not run)` : ''} | ${pct(s.recall)} (${s.found}/${s.issues}) | ${pct(s.precision)} (${s.tp}/${s.findings}) | ${pct(s.f1)} | ${pct(s.recallStrict)} | ${pct(s.precisionStrict)} | ${num(s.commentsPerPr, 1)} | ${num(s.cleanFindingsPerPr, 1)} (${s.cleanPrsFlagged}/${s.cleanPrs} flagged) | $${num(s.costPerPr, 3)} | ${num(s.secondsPerPr, 0)} s, ${num(s.secondsMedian, 0)} s |`);
  }
  const cats = [...new Set(tools.flatMap((t) => Object.keys(scores[t].byCategory)))].sort();
  if (cats.length) {
    L.push('', '## Recall by ground-truth category', '');
    L.push(`| Category | ${tools.join(' | ')} |`);
    L.push(`|---|${tools.map(() => '---').join('|')}|`);
    for (const c of cats) L.push(`| ${c} | ${tools.map((t) => { const x = scores[t].byCategory[c]; return x ? `${x.found}/${x.issues}` : '-'; }).join(' | ')} |`);
  }
  L.push('', 'Recall: ground-truth issues with at least one matching finding. Precision: findings that match some ground-truth issue; every finding on a clean PR counts against it. A finding matches an issue on the same file when its lines are within ±10 lines or its category is the same (categories inferred from the text for tools that give none). The "lines only" columns drop the category rule (it is lenient: most issues are correctness, so any correctness comment on the file counts); issues without a line still match by category there. Cost at claude-opus-5-5 list prices ($4 / $20 per million input / output tokens, cache reads $0.20, cache writes $5), from the API usage the metering proxy saw.');
  return L.join('\n') + '\n';
}
