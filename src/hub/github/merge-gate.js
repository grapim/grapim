// The merge gate (Governance, like path rules and require-approval): after a
// cloud review, sort the pull request into low, normal or high risk and act.
//
//   low    the card says "Safe to merge", the CI checks passed, no sensitive
//          path (the review config's `sensitive` list and the team's path
//          rules that need approval), at most maxLines changed lines, and the
//          author is not excluded
//   high   "Do not merge", a sensitive path, failing CI, or tests or files
//          deleted or skipped that the request did not ask for
//   normal anything else: nothing happens, the card speaks for itself
//
// Modes, per repository (Settings, Review; a repository's .grapim/review.json
// "gate" can only make it stricter, gate-config.js):
//   off           nothing (the default)
//   suggest       the card says what the gate would do; nothing else
//   auto-approve  low: an APPROVE review with a one-line reason, once per head.
//                 high: review requested from CODEOWNERS for the touched
//                 paths (else the path rules' named approvers, else the
//                 team's reviewer list), Grapim's earlier approval dismissed,
//                 and the cloud check fails with the reason as its title.
//
// Every decision except "nothing happens" is logged in gh_gate_log, the audit
// trail Settings, Review shows. Every query is scoped by team id.

import { compilePattern } from '../rules.js';
import { csrfField } from '../pages/layout.js';
import { date, html } from '../pages/html.js';
import { GATE_DEFAULTS, GATE_LIMITS, GATE_MODES, stricterGate, validLogin, validReviewer } from '../../airev/gate-config.js';
import { compileGlob } from '../../airev/config.js';

export const GATE_SCHEMA = `
-- The merge gate's settings per team (Settings, Review): JSON of mode,
-- maxLines, excludeAuthors, reviewers and repos ({ "owner/name": mode }).
CREATE TABLE IF NOT EXISTS gh_merge_gate (
  team_id     TEXT PRIMARY KEY,
  json        TEXT NOT NULL,
  updated_by  TEXT,
  updated_at  INTEGER
);
-- Every approval and routing decision of the gate (the audit trail). action:
-- approved | approve_failed | would_approve | routed | route_failed | would_route.
CREATE TABLE IF NOT EXISTS gh_gate_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     TEXT NOT NULL,
  owner       TEXT NOT NULL,
  name        TEXT NOT NULL,
  number      INTEGER NOT NULL,
  head_sha    TEXT NOT NULL,
  mode        TEXT NOT NULL,
  risk        TEXT NOT NULL,
  action      TEXT NOT NULL,
  reasons     TEXT NOT NULL DEFAULT '[]',
  reviewers   TEXT NOT NULL DEFAULT '[]',
  detail      TEXT,
  at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS gh_gate_log_once ON gh_gate_log (team_id, owner, name, number, head_sha, action);
CREATE INDEX IF NOT EXISTS gh_gate_log_team ON gh_gate_log (team_id, at);
`;

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_REPOS = 200;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const MODE_TEXT = Object.freeze({ off: 'Off', suggest: 'Suggest only', 'auto-approve': 'Auto-approve' });

export class GateConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GateConfigError';
  }
}

// A stored (or handed over) team gate -> only valid fields; never throws.
export function cleanGate(v) {
  const out = { ...GATE_DEFAULTS, excludeAuthors: [], reviewers: [], repos: {} };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  if (GATE_MODES.includes(v.mode)) out.mode = v.mode;
  if (Number.isSafeInteger(v.maxLines) && v.maxLines >= GATE_LIMITS.minLines && v.maxLines <= GATE_LIMITS.maxLines) out.maxLines = v.maxLines;
  if (Array.isArray(v.excludeAuthors)) out.excludeAuthors = v.excludeAuthors.filter(validLogin).slice(0, GATE_LIMITS.logins);
  if (Array.isArray(v.reviewers)) out.reviewers = v.reviewers.filter(validReviewer).slice(0, GATE_LIMITS.logins);
  if (v.repos && typeof v.repos === 'object' && !Array.isArray(v.repos)) {
    for (const [k, m] of Object.entries(v.repos).slice(0, MAX_REPOS)) if (REPO.test(k) && GATE_MODES.includes(m)) out.repos[k.toLowerCase()] = m;
  }
  return out;
}

const lines = (s) => String(s ?? '').slice(0, 64 * 1024).split(/\r\n?|\n|,/).map((l) => l.trim()).filter(Boolean);

// The Settings, Review gate form -> a team gate, or a GateConfigError.
export function parseGateForm(form = {}) {
  const mode = GATE_MODES.includes(form.gateMode) ? form.gateMode : null;
  if (!mode) throw new GateConfigError('Choose off, suggest only or auto-approve for the merge gate.');
  const raw = String(form.gateMaxLines ?? '').trim();
  const maxLines = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
  if (!(maxLines >= GATE_LIMITS.minLines && maxLines <= GATE_LIMITS.maxLines)) throw new GateConfigError(`Changed lines must be a whole number from ${GATE_LIMITS.minLines} to ${GATE_LIMITS.maxLines.toLocaleString('en-US')}.`);
  const list = (field, ok, what) => {
    const out = [];
    for (const l of lines(form[field])) {
      const v = l.replace(/^@/, '');
      if (!ok(v)) throw new GateConfigError(`"${l.slice(0, 60)}" is not ${what}.`);
      if (!out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
    }
    if (out.length > GATE_LIMITS.logins) throw new GateConfigError(`At most ${GATE_LIMITS.logins} names in each list.`);
    return out;
  };
  const excludeAuthors = list('gateExclude', validLogin, 'a GitHub login');
  const reviewers = list('gateReviewers', validReviewer, 'a GitHub login or org/team');
  const repos = {};
  for (const l of String(form.gateRepos ?? '').slice(0, 64 * 1024).split(/\r\n?|\n/).map((x) => x.trim()).filter(Boolean)) {
    const [name, m, ...rest] = l.split(/\s+/);
    if (rest.length || !REPO.test(name ?? '') || !GATE_MODES.includes(m)) throw new GateConfigError(`"${l.slice(0, 80)}": write one repository per line, like "acme/api auto-approve" (off, suggest or auto-approve).`);
    repos[name.toLowerCase()] = m;
  }
  if (Object.keys(repos).length > MAX_REPOS) throw new GateConfigError(`At most ${MAX_REPOS} repositories.`);
  return { mode, maxLines, excludeAuthors, reviewers, repos };
}

// The team's gate for one repository: its own line in `repos`, else the
// team's mode; then the repository file, which can only make it stricter.
export function gateFor(teamGate, repoFull, repoFile = null) {
  const t = cleanGate(teamGate);
  const mode = t.repos[String(repoFull).toLowerCase()] ?? t.mode;
  return stricterGate({ mode, maxLines: t.maxLines, excludeAuthors: t.excludeAuthors, reviewers: t.reviewers }, repoFile);
}

// ---- CODEOWNERS ----

export const CODEOWNERS_PATHS = Object.freeze(['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']);
const OWNER = /^@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]{1,100})?)$/;

// CODEOWNERS text -> [{ pattern, owners: ['alice', 'acme/web'] }], in file
// order (the last rule that matches a path wins). Emails are left out: a
// review can only be requested from a login or a team.
export function parseCodeowners(text) {
  const out = [];
  for (const raw of String(text ?? '').slice(0, 3 * 1024 * 1024).split(/\r\n?|\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line || line.startsWith('[') || line.startsWith('!')) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    const res = codeownersRegexes(pattern);
    if (!res.length) continue;
    out.push({ pattern, res, owners: owners.map((o) => OWNER.exec(o)?.[1]).filter(Boolean) });
  }
  return out;
}

// gitignore-style, as GitHub reads CODEOWNERS: "/x" is anchored at the root,
// a name without "/" matches anywhere, "dir/" everything under it, and a
// pattern that names a folder covers what is inside it.
function codeownersRegexes(pattern) {
  const p = pattern.replace(/\\ /g, ' ');
  if (p === '*') return [/^.*$/];
  const a = compileGlob(p);
  if (!a) return [];
  const b = !p.endsWith('/') && !p.endsWith('**') ? compileGlob(`${p.replace(/\/+$/, '')}/**`) : null;
  return [a, b].filter(Boolean);
}

// The owners of each path (last match wins; a match with no owners clears
// it). -> Map owner -> [paths]
export function ownersFor(rules, paths) {
  const out = new Map();
  for (const p of paths) {
    let hit = null;
    for (const r of rules) if (r.res.some((re) => re.test(p))) hit = r;
    for (const o of hit?.owners ?? []) {
      if (!out.has(o)) out.set(o, []);
      out.get(o).push(p);
    }
  }
  return out;
}

// ---- The decision (pure) ----

// card: from decideCard (src/airev/decision.js); facts: decisionFacts;
// gate: gateFor(); sensitive: paths on a sensitive path; author: the PR's login;
// trusted: the author is an owner, member or collaborator (author_association).
// -> { risk: 'low' | 'normal' | 'high', reasons: [text], blockers: [text] }
// reasons: why it is high, or why it is not low.
export function gateDecision({ card, facts, gate, sensitive = [], author = '', trusted = false }) {
  const high = [];
  const notLow = [];
  const verdict = card?.verdict?.verdict;
  const ci = card?.ci?.state ?? 'unknown';
  if (verdict === 'block' && /blocker/.test(card.verdict.reason ?? '')) high.push('the review found a blocker');
  if (ci === 'failed') high.push(`${plural(card.ci.failed.length, 'CI check')} failed`);
  if (sensitive.length) high.push(`it changes ${plural(sensitive.length, 'sensitive path')} (${sensitive.slice(0, 2).join(', ')}${sensitive.length > 2 ? ', …' : ''})`);
  const deletions = (card?.beyond ?? []).filter((b) => b.deletion);
  if (deletions.length) high.push('it deletes or skips tests or files nobody asked it to');
  if (verdict !== 'safe' && verdict !== 'block') notLow.push('the review has points to check');
  if (ci === 'running') notLow.push('CI is still running');
  else if (ci === 'none') notLow.push('no CI ran on this commit');
  else if (ci === 'unknown') notLow.push('the CI results could not be read');
  const size = facts ? facts.size.added + facts.size.removed : null;
  if (size === null) notLow.push('the changed files could not be read');
  else if (size > gate.maxLines) notLow.push(`${size.toLocaleString('en-US')} changed lines, over the ${gate.maxLines.toLocaleString('en-US')} limit`);
  if (facts?.truncated) notLow.push('too many files to check them all');
  // A drive-by pull request (no write access) is never approved by a model's say-so.
  if (!trusted) notLow.push('the author has no write access to the repository');
  if (author && gate.excludeAuthors.some((a) => a.toLowerCase() === author.toLowerCase())) notLow.push(`${author} is on the exclude list`);
  if (high.length) return { risk: 'high', reasons: high };
  if (notLow.length) return { risk: 'normal', reasons: notLow };
  return { risk: 'low', reasons: [`safe to merge, CI passed, no sensitive path, ${size.toLocaleString('en-US')} changed lines`] };
}

// Paths that count as sensitive: the review config's list (facts.files[].sensitive)
// and the team's path rules that need approval.
export function sensitivePaths(facts, rules = []) {
  const review = rules.filter((r) => r.action !== 'auto').map((r) => ({ ...r, re: compilePattern(r.pattern) })).filter((r) => r.re);
  return (facts?.files ?? []).filter((f) => f.sensitive || review.some((r) => r.re.test(f.path))).map((f) => f.path);
}

// One line for the card.
export function gateLine(gate, d, outcome = null) {
  if (!gate || gate.mode === 'off') return '';
  const who = (list) => list.map((r) => `<code>${String(r).replace(/[<>&]/g, '')}</code>`).join(', ');
  if (gate.mode === 'suggest') {
    if (d.risk === 'low') return '**Merge gate** (suggest only) · This pull request qualifies for auto-approval. Turn on auto-approve to let Grapim approve ones like it.';
    if (d.risk === 'high') return `**Merge gate** (suggest only) · High risk: ${d.reasons.join('; ')}. With auto-approve on, Grapim would ask ${outcome?.reviewers?.length ? who(outcome.reviewers) : 'a person'} to review and fail the check.`;
    return '';
  }
  if (d.risk === 'low') return outcome?.ok === false ? `**Merge gate** · Qualifies for auto-approval, but GitHub refused the approval (${outcome.error}).` : '**Merge gate** · Approved by Grapim: low risk.';
  if (d.risk === 'high') {
    const asked = outcome?.reviewers?.length ? `Review requested from ${who(outcome.reviewers)}${outcome.via ? ` (${outcome.via})` : ''}.` : outcome?.error ? `Could not request a review (${outcome.error}).` : 'Nobody to request a review from: add a CODEOWNERS file or reviewers in Settings, Review.';
    return `**Merge gate** · Needs a person: ${d.reasons.join('; ')}. ${asked}`;
  }
  return '';
}

export const checkTitle = (d) => `Needs a person: ${d.reasons[0]}`.slice(0, 200);

// ---- Store, log and the settings card ----

export function createMergeGate({ db, now, governance = () => false, rules = null, log = () => {} }) {
  db.exec(GATE_SCHEMA);
  const settings = (teamId) => {
    const row = db.prepare('SELECT json FROM gh_merge_gate WHERE team_id = ?').get(teamId);
    try {
      return cleanGate(row ? JSON.parse(row.json) : null);
    } catch {
      return cleanGate(null);
    }
  };
  const save = (teamId, value, userId) =>
    db
      .prepare('INSERT INTO gh_merge_gate (team_id, json, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(team_id) DO UPDATE SET json = excluded.json, updated_by = excluded.updated_by, updated_at = excluded.updated_at')
      .run(teamId, JSON.stringify(cleanGate(value)), userId == null ? null : String(userId), now());
  // The gate for a team's repository, or null when it does not apply (no
  // team, no Governance plan, off).
  function forRepo(team, owner, name, repoFile = null) {
    if (!team || !governance(team)) return null;
    const g = gateFor(settings(team.id), `${owner}/${name}`, repoFile);
    return g.mode === 'off' ? null : g;
  }
  // Inserted once per head and action: a re-run on the same commit adds nothing.
  function record({ teamId, owner, name, number, headSha, mode, risk, action, reasons = [], reviewers = [], detail = null }) {
    const r = db
      .prepare('INSERT OR IGNORE INTO gh_gate_log (team_id, owner, name, number, head_sha, mode, risk, action, reasons, reviewers, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(teamId, owner, name, number, headSha, mode, risk, action, JSON.stringify(reasons.slice(0, 10)), JSON.stringify(reviewers.slice(0, 20)), detail ? String(detail).slice(0, 500) : null, now());
    if (r.changes) log(`merge gate: ${action}`);
    return r.changes > 0;
  }
  const done = (teamId, owner, name, number, headSha, action) => !!db.prepare('SELECT 1 FROM gh_gate_log WHERE team_id = ? AND owner = ? AND name = ? AND number = ? AND head_sha = ? AND action = ?').get(teamId, owner, name, number, headSha, action);
  const recent = (teamId, n = 20) =>
    db
      .prepare('SELECT owner, name, number, head_sha, mode, risk, action, reasons, reviewers, detail, at FROM gh_gate_log WHERE team_id = ? ORDER BY at DESC, id DESC LIMIT ?')
      .all(teamId, n)
      .map((r) => ({ ...r, reasons: safeJson(r.reasons), reviewers: safeJson(r.reviewers) }));
  const teamRules = (teamId) => (rules ? rules.list(teamId) : []);
  return { settings, save, forRepo, record, done, recent, teamRules };
}

const safeJson = (s) => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const ACTION_TEXT = {
  approved: 'Approved',
  approve_failed: 'Approval refused by GitHub',
  would_approve: 'Would approve',
  routed: 'Review requested',
  route_failed: 'Review request refused by GitHub',
  would_route: 'Would request review',
};

// Settings, Review: the gate's settings (owners change them on Governance)
// and its last decisions (every member reads them).
export function gateCard({ team, csrf, owner, allowed, values, recent = [], draft = null }) {
  const v = draft ?? values;
  const lock = owner && allowed ? '' : html`disabled`;
  const reposText = draft?.reposText ?? Object.entries(v.repos ?? {}).map(([k, m]) => `${k} ${m}`).join('\n');
  return html`<section class="card review-settings" id="merge-gate" aria-labelledby="merge-gate-title">
  <div class="card-head"><h2 id="merge-gate-title" class="card-title">Merge gate</h2>${allowed ? html`<span class="badge ${v.mode !== 'off' ? 'badge-ok' : ''}">${MODE_TEXT[v.mode]}</span>` : html`<span class="badge">Governance</span>`}</div>
  <p class="card-sub">After each cloud review, Grapim sorts the pull request by risk. Low risk (safe to merge, CI passed, no sensitive path, small, author not excluded) can be approved by Grapim. High risk (do not merge, a sensitive path, failing CI, deleted or skipped tests) asks CODEOWNERS for a review and fails the <code>Grapim Review (cloud)</code> check.</p>
  <form method="post" action="/hub/teams/${team.id}/settings/review/gate">
    ${csrfField(csrf)}
    <fieldset class="setting-rows" ${lock}>
      <legend class="sr-only">Merge gate settings</legend>
      <div class="policy-row">
        <div class="setting-text"><label class="strong" for="mg-mode">Mode</label><p class="fine">Suggest only: the review comment says what the gate would do, and nothing else happens. Start here and watch a few pull requests.</p></div>
        <select id="mg-mode" name="gateMode">${['off', 'suggest', 'auto-approve'].map((m) => html`<option value="${m}" ${v.mode === m ? html`selected` : ''}>${MODE_TEXT[m]}</option>`)}</select>
      </div>
      <div class="policy-row setting-row-wide">
        <div class="setting-text"><label class="strong" for="mg-repos">Per repository</label><p class="fine">One per line, like <code>acme/api auto-approve</code>. Other repositories use the mode above. A repository's <code>.grapim/review.json</code> can only make its gate stricter.</p></div>
        <textarea id="mg-repos" name="gateRepos" rows="3" spellcheck="false" autocapitalize="off">${reposText}</textarea>
      </div>
      <div class="policy-row">
        <div class="setting-text"><label class="strong" for="mg-lines">Changed lines, at most</label><p class="fine">A larger pull request is never low risk.</p></div>
        <input id="mg-lines" class="input-narrow" type="number" name="gateMaxLines" min="1" max="100000" step="1" inputmode="numeric" value="${v.maxLines}" required>
      </div>
      <div class="policy-row setting-row-wide">
        <div class="setting-text"><label class="strong" for="mg-exclude">Never auto-approve</label><p class="fine">GitHub logins, one per line, like <code>dependabot[bot]</code>.</p></div>
        <textarea id="mg-exclude" name="gateExclude" rows="2" spellcheck="false" autocapitalize="off">${(v.excludeAuthors ?? []).join('\n')}</textarea>
      </div>
      <div class="policy-row setting-row-wide">
        <div class="setting-text"><label class="strong" for="mg-reviewers">Reviewers when nobody owns the path</label><p class="fine">Asked when CODEOWNERS and your path rules name nobody. Logins or <code>org/team</code>, one per line.</p></div>
        <textarea id="mg-reviewers" name="gateReviewers" rows="2" spellcheck="false" autocapitalize="off">${(v.reviewers ?? []).join('\n')}</textarea>
      </div>
    </fieldset>
    ${owner && allowed ? html`<div class="setting-foot"><button class="btn btn-primary" type="submit">Save</button></div>` : ''}
  </form>
  ${!allowed ? html`<p class="fine">The merge gate is on the Governance plan.</p>` : owner ? '' : html`<p class="fine">Only an owner can change these.</p>`}
  <h3 class="sub-title">Recent decisions</h3>
  ${recent.length
    ? html`<ul class="list list-flush">${recent.map(
        (r) => html`<li class="row"><span class="row-main"><span class="row-title">${r.owner}/${r.name}#${r.number}</span><span class="badge ${r.action === 'approved' ? 'badge-ok' : r.risk === 'high' ? 'badge-warn' : ''}">${ACTION_TEXT[r.action] ?? r.action}</span></span><span class="row-meta">${r.reasons.join('; ')}${r.reviewers.length ? ` · ${r.reviewers.join(', ')}` : ''} · ${r.head_sha.slice(0, 7)} · ${date(r.at)}</span></li>`,
      )}</ul>`
    : html`<p class="muted small">No decisions yet.</p>`}
</section>`;
}
