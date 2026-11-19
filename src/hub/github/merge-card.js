// The merge decision card of a cloud review, and the merge gate acting on it
// (src/airev/decision.js renders the card, merge-gate.js decides the risk).
//
// cloud-review.js calls prepare() once the review's findings are posted: it
// reads the head's CI results from GitHub (check runs, and commit statuses
// when the App may read them), links each finding to its inline comment,
// builds the card, runs the merge gate, and returns the card's markdown for
// the top of the summary comment plus any change to the check. save() keeps
// what the card needs so that refresh() can redo it when CI finishes later
// (a check_run or check_suite "completed" event, or a status event), without
// a new review. Nothing here runs code from the repository: CI results are
// what GitHub already has.

import { CARD_MARKER, ciStatus, decideCard, findingKey, findingLinks, isHttpsUrl, renderCard, spliceCard, verdictTitle, withCi } from '../../airev/decision.js';
import { compilePattern } from '../rules.js';
import { checkTitle, CODEOWNERS_PATHS, gateDecision, gateLine, ownersFor, parseCodeowners, sensitivePaths } from './merge-gate.js';

export const CARDS_SCHEMA = `
-- What the merge decision card of a pull request's newest cloud review needs
-- to be redone when its CI finishes (merge-card.js). One row per pull request.
CREATE TABLE IF NOT EXISTS gh_merge_cards (
  installation_id INTEGER NOT NULL,
  repo_gh_id      INTEGER NOT NULL,
  number          INTEGER NOT NULL,
  team_id         TEXT,
  owner           TEXT NOT NULL,
  name            TEXT NOT NULL,
  head_sha        TEXT NOT NULL,
  marker          TEXT NOT NULL,
  state           TEXT NOT NULL,
  check_id        INTEGER,
  ci              TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (installation_id, repo_gh_id, number)
);
CREATE INDEX IF NOT EXISTS gh_merge_cards_head ON gh_merge_cards (head_sha);
`;

const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_PATHS = 1000;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const compact = (f) => ({ path: f.path, line: f.line, ...(f.endLine ? { endLine: f.endLine } : {}), severity: f.severity, category: f.category, title: String(f.title ?? '').slice(0, 200) });
// The review check under a card. base: the review's own check ({ conclusion,
// title, summary }: failure on a blocker, neutral when nothing was reviewed);
// gate: the merge gate's check, when it decides. The title is the card's
// verdict, so the two never disagree in words, and a check that would pass
// under a "Do not merge" card (CI failing, no blocker) is neutral instead.
export function cardCheck({ base, verdict, gate = null }) {
  if (gate) return { ...base, conclusion: gate.conclusion, title: gate.title };
  if (!verdict) return base;
  const conclusion = verdict.verdict === 'block' && base.conclusion === 'success' ? 'neutral' : base.conclusion;
  return { ...base, conclusion, title: verdictTitle(verdict) };
}

const ciKey = (ci) => `${ci.state}|${ci.failed.join(',')}|${ci.running.length}`;

export function createMergeCard({ db, now, log = () => {}, slug = null, gate = null, teams = null, ownChecks = [] }) {
  db.exec(CARDS_SCHEMA);
  const bot = slug ? `${slug}[bot]` : null;
  const own = new Set(ownChecks);
  const ignore = (name, app) => own.has(name) || (!!slug && app === slug);

  // The head's CI from GitHub. Checks: the App's checks permission (read and
  // write) covers reading them. Statuses need "Commit statuses: read"; without
  // it GitHub answers 403/404 and the card says the statuses could not be read
  // only when nothing else is known.
  async function readCi(client, repo, sha) {
    let checkRuns = null;
    let statuses = null;
    try {
      const all = [];
      for (let page = 1; page <= 5; page++) {
        const r = await client.request('GET', `/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`);
        if (!r.ok || !Array.isArray(r.json?.check_runs)) break;
        all.push(...r.json.check_runs);
        checkRuns = all;
        if (r.json.check_runs.length < 100) break;
      }
    } catch {}
    try {
      const r = await client.request('GET', `/repos/${repo}/commits/${sha}/status?per_page=100`);
      if (r.ok && Array.isArray(r.json?.statuses)) statuses = r.json.statuses;
    } catch {}
    const ci = ciStatus({ checkRuns, statuses, ignore });
    if (ci.state === 'unknown') ci.reason = checkRuns === null ? 'GitHub did not list the checks' : 'GitHub did not list the commit statuses';
    return ci;
  }

  async function reviewComments(client, repo, number) {
    const all = [];
    try {
      for (let page = 1; page <= 10; page++) {
        const r = await client.request('GET', `/repos/${repo}/pulls/${number}/comments?per_page=100&page=${page}`);
        if (!r.ok || !Array.isArray(r.json)) break;
        all.push(...r.json);
        if (r.json.length < 100) break;
      }
    } catch {}
    return all;
  }

  // CODEOWNERS at the base commit (a pull request cannot name its own owners).
  async function codeowners(client, repo, ref) {
    for (const p of CODEOWNERS_PATHS) {
      try {
        const r = await client.request('GET', `/repos/${repo}/contents/${p}?ref=${encodeURIComponent(ref)}`);
        if (!r.ok || typeof r.json?.content !== 'string') continue;
        if (Number(r.json.size) > 3 * 1024 * 1024) return [];
        return parseCodeowners(Buffer.from(r.json.content, 'base64').toString('utf8'));
      } catch {}
    }
    return [];
  }

  const loginOf = (id) => {
    try {
      return db.prepare('SELECT login FROM users WHERE id = ?').get(id)?.login ?? null;
    } catch {
      return null;
    }
  };

  // Who to ask: CODEOWNERS of the touched paths, else the named approvers of
  // the team's path rules that apply, else the team's reviewer list. Never
  // the author. -> { reviewers: ['alice', 'acme/web'], via }
  async function whoToAsk({ client, repo, owner, base, paths, team, cfg, author }) {
    const notAuthor = (r) => !author || r.toLowerCase() !== author.toLowerCase();
    const co = await codeowners(client, repo, base);
    const fromCo = [...ownersFor(co, paths).keys()].filter(notAuthor);
    if (fromCo.length) return { reviewers: fromCo.slice(0, 15), via: 'CODEOWNERS' };
    const rules = team && gate ? gate.teamRules(team.id) : [];
    const ids = new Set();
    for (const rule of rules.filter((r) => r.action !== 'auto' && r.approvers?.length)) {
      const re = compilePattern(rule.pattern);
      if (re && paths.some((p) => re.test(p))) for (const id of rule.approvers) ids.add(id);
    }
    const fromRules = [...ids].map(loginOf).filter((l) => l && notAuthor(l));
    if (fromRules.length) return { reviewers: fromRules.slice(0, 15), via: 'path rules' };
    const listed = (cfg.reviewers ?? []).filter(notAuthor).filter((r) => !r.includes('/') || r.split('/')[0].toLowerCase() === owner.toLowerCase());
    return { reviewers: listed.slice(0, 15), via: listed.length ? 'team reviewers' : null };
  }

  // POST requested_reviewers; on a refusal (someone without access), one at a time.
  async function requestReviews(client, repo, number, reviewers) {
    const split = (list) => ({ reviewers: list.filter((r) => !r.includes('/')), team_reviewers: list.filter((r) => r.includes('/')).map((r) => r.split('/')[1]) });
    const r = await client.request('POST', `/repos/${repo}/pulls/${number}/requested_reviewers`, split(reviewers));
    if (r.ok) return { ok: true, reviewers };
    if (r.status !== 422 || reviewers.length < 2) return { ok: false, reviewers: [], error: `HTTP ${r.status}` };
    const ok = [];
    for (const one of reviewers) {
      const x = await client.request('POST', `/repos/${repo}/pulls/${number}/requested_reviewers`, split([one]));
      if (x.ok) ok.push(one);
    }
    return ok.length ? { ok: true, reviewers: ok } : { ok: false, reviewers: [], error: 'HTTP 422' };
  }

  // Grapim's own approvals on earlier commits go when a newer head is not low risk.
  async function dismissOld(client, repo, number, head) {
    let n = 0;
    try {
      const r = await client.request('GET', `/repos/${repo}/pulls/${number}/reviews?per_page=100`);
      for (const rv of Array.isArray(r.json) ? r.json : []) {
        if (rv?.state !== 'APPROVED' || rv.user?.type !== 'Bot' || (bot && rv.user.login !== bot) || rv.commit_id === head) continue;
        const d = await client.request('PUT', `/repos/${repo}/pulls/${number}/reviews/${rv.id}/dismissals`, { message: 'Grapim merge gate: a newer commit is not low risk, so this approval no longer stands.', event: 'DISMISS' });
        if (d.ok) n++;
      }
    } catch {}
    return n;
  }

  // The gate on one card: decide, act (auto-approve) or say (suggest), log.
  // -> { line, check: { conclusion, title } | null, decision }
  async function runGate({ client, job, team, cfg, card, facts, sensitive, paths, author, trusted = false, base }) {
    if (!cfg) return { line: '', check: null, decision: null };
    const repo = `${job.owner}/${job.name}`;
    const d = gateDecision({ card, facts, gate: cfg, sensitive, author, trusted });
    const entry = { teamId: team.id, owner: job.owner, name: job.name, number: job.number, headSha: job.headSha, mode: cfg.mode, risk: d.risk };
    let outcome = null;
    if (cfg.mode === 'suggest') {
      if (d.risk === 'low') gate.record({ ...entry, action: 'would_approve', reasons: d.reasons });
      if (d.risk === 'high') {
        outcome = await whoToAsk({ client, repo, owner: job.owner, base, paths, team, cfg, author });
        gate.record({ ...entry, action: 'would_route', reasons: d.reasons, reviewers: outcome.reviewers, detail: outcome.via });
      }
      return { line: gateLine(cfg, d, outcome), check: null, decision: d };
    }
    // auto-approve
    if (d.risk !== 'low') {
      const dismissed = await dismissOld(client, repo, job.number, job.headSha);
      if (dismissed) gate.record({ ...entry, action: 'dismissed', reasons: d.reasons, detail: `${dismissed} earlier approval${dismissed === 1 ? '' : 's'}` });
    }
    if (d.risk === 'low') {
      if (gate.done(team.id, job.owner, job.name, job.number, job.headSha, 'approved')) return { line: gateLine(cfg, d, { ok: true }), check: null, decision: d };
      const r = await client.request('POST', `/repos/${repo}/pulls/${job.number}/reviews`, { commit_id: job.headSha, event: 'APPROVE', body: `Grapim merge gate: low risk (${d.reasons[0]}). An owner can turn this off in Settings, Review.` });
      outcome = r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
      gate.record({ ...entry, action: r.ok ? 'approved' : 'approve_failed', reasons: d.reasons, detail: r.ok ? null : outcome.error });
      return { line: gateLine(cfg, d, outcome), check: null, decision: d };
    }
    if (d.risk === 'high') {
      const who = await whoToAsk({ client, repo, owner: job.owner, base, paths, team, cfg, author });
      outcome = { ...who };
      if (who.reviewers.length && !gate.done(team.id, job.owner, job.name, job.number, job.headSha, 'routed')) {
        const r = await requestReviews(client, repo, job.number, who.reviewers);
        outcome = r.ok ? { reviewers: r.reviewers, via: who.via } : { reviewers: [], error: r.error };
        gate.record({ ...entry, action: r.ok ? 'routed' : 'route_failed', reasons: d.reasons, reviewers: r.ok ? r.reviewers : who.reviewers, detail: r.ok ? who.via : r.error });
      } else if (!who.reviewers.length) gate.record({ ...entry, action: 'route_failed', reasons: d.reasons, detail: 'nobody to ask' });
      return { line: gateLine(cfg, d, outcome), check: { conclusion: 'failure', title: checkTitle(d) }, decision: d };
    }
    return { line: '', check: null, decision: d };
  }

  // After the review's findings are posted. findings: the review's current
  // findings (inline, repeated from an earlier commit, or moved to the
  // summary); posted: post()'s result; result: the worker's result (stats,
  // facts, gate from the repository file); request: statedRequest(); hubRuns:
  // the runs the hub's synced notes name (cloud_provenance).
  // -> { markdown, check, save(checkId, baseCheck) }
  async function prepare({ client, job, team = null, pr, findings, posted = {}, result = {}, request = null, hubRuns = [] }) {
    const repo = `${job.owner}/${job.name}`;
    const facts = result.facts ?? null;
    const stats = { reviewedHunks: result.stats?.reviewedHunks ?? 0, hunks: result.stats?.hunks ?? 0 };
    const moved = (posted.moved ?? []).map(compact);
    const links = findingLinks(findings, await reviewComments(client, repo, job.number), (c) => c.user?.type === 'Bot' && (!bot || c.user.login === bot));
    // The links the summary's findings list uses (cloud-review.js, from the
    // review's own comments) fill any the listing above did not match, so the
    // card and the list link the same comments.
    for (const { finding, url } of Array.isArray(posted.links) ? posted.links : []) {
      if (finding && isHttpsUrl(url) && !links.has(findingKey(finding))) links.set(findingKey(finding), url);
    }
    // The findings the summary's own list shows (cloud-review.js): the card
    // counts them on one line instead of listing them again.
    const listed = (Array.isArray(posted.links) ? posted.links : []).filter((r) => r?.finding).map((r) => findingKey(r.finding));
    const ci = await readCi(client, repo, job.headSha);
    ci.live = true;
    const card = decideCard({ facts, runs: hubRuns, pr: request ?? { title: pr?.title, body: pr?.body }, findings, stats, ci, links, moved, prUrl: pr?.html_url ?? null, listed });
    const cfg = team && gate ? gate.forRepo(team, job.owner, job.name, result.gate ?? null) : null;
    const paths = (facts?.files ?? []).map((f) => f.path).slice(0, MAX_PATHS);
    const sensitive = cfg ? sensitivePaths(facts, gate.teamRules(team.id)) : [];
    const author = typeof pr?.user?.login === 'string' && LOGIN.test(pr.user.login.replace(/\[bot\]$/, '')) ? pr.user.login : '';
    const trusted = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(pr?.author_association);
    const base = SHA.test(String(pr?.base?.sha ?? '')) ? pr.base.sha : String(pr?.base?.ref ?? 'HEAD');
    let g = { line: '', check: null };
    try {
      g = await runGate({ client, job, team, cfg, card, facts, sensitive, paths, author, trusted, base });
    } catch (err) {
      log(`merge gate failed: ${String(err?.message ?? err).slice(0, 200)}`);
    }
    const markdown = renderCard({ ...card, gate: g.line });
    const state = { card, findings: findings.map(compact), links: [...links], listed, moved, stats, facts: facts ? { size: facts.size, truncated: !!facts.truncated } : null, sensitive, paths, author, trusted, base, gateFile: result.gate ?? null };
    const save = (checkId, baseCheck, marker) => {
      if (!Number.isSafeInteger(Number(job.repoId)) || !Number.isSafeInteger(job.number)) return;
      db.prepare(
        `INSERT INTO gh_merge_cards (installation_id, repo_gh_id, number, team_id, owner, name, head_sha, marker, state, check_id, ci, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, repo_gh_id, number) DO UPDATE SET team_id = excluded.team_id, owner = excluded.owner, name = excluded.name, head_sha = excluded.head_sha, marker = excluded.marker, state = excluded.state, check_id = excluded.check_id, ci = excluded.ci, updated_at = excluded.updated_at`,
      ).run(job.installationId, Number(job.repoId), job.number, team?.id ?? null, job.owner, job.name, job.headSha, marker, JSON.stringify({ ...state, baseCheck }), Number.isSafeInteger(checkId) ? checkId : null, ciKey(ci), now());
    };
    return { markdown, check: g.check, card, ci, save };
  }

  // The newest card of a head, if Grapim has one (a CI event's commit).
  const cardsFor = (installationId, headSha) => (SHA.test(String(headSha)) ? db.prepare('SELECT * FROM gh_merge_cards WHERE installation_id = ? AND head_sha = ?').all(installationId, headSha) : []);

  // CI changed on a head Grapim reviewed: read it again, redo the card and
  // the gate, update the summary comment and the check. Nothing else is read
  // from the repository. -> { updated } | { skipped }
  async function refresh({ client, row }) {
    if (!NAME.test(row.owner) || !NAME.test(row.name)) return { skipped: 'bad_row' };
    const repo = `${row.owner}/${row.name}`;
    let state;
    try {
      state = JSON.parse(row.state);
    } catch {
      return { skipped: 'bad_row' };
    }
    const pr = await client.request('GET', `/repos/${repo}/pulls/${row.number}`);
    if (!pr.ok || pr.json?.state !== 'open' || pr.json?.head?.sha !== row.head_sha) return { skipped: 'stale' };
    const ci = await readCi(client, repo, row.head_sha);
    ci.live = true;
    if (ciKey(ci) === row.ci) return { skipped: 'unchanged' };
    const links = new Map(Array.isArray(state.links) ? state.links : []);
    const card = withCi(state.card, ci, { findings: state.findings ?? [], stats: state.stats ?? {}, links, moved: state.moved ?? [], listed: Array.isArray(state.listed) ? state.listed : [] });
    const team = row.team_id && teams ? teams.get(row.team_id) : null;
    const job = { installationId: row.installation_id, repoId: row.repo_gh_id, owner: row.owner, name: row.name, number: row.number, headSha: row.head_sha };
    const cfg = team && gate ? gate.forRepo(team, row.owner, row.name, state.gateFile ?? null) : null;
    let g = { line: '', check: null };
    try {
      g = await runGate({ client, job, team, cfg, card, facts: state.facts, sensitive: state.sensitive ?? [], paths: state.paths ?? [], author: state.author ?? '', trusted: state.trusted === true, base: state.base ?? 'HEAD' });
    } catch (err) {
      log(`merge gate failed: ${String(err?.message ?? err).slice(0, 200)}`);
    }
    const markdown = renderCard({ ...card, gate: g.line });
    // The summary comment: Grapim's own, found by its marker.
    let body = null;
    for (let page = 1; page <= 10 && body === null; page++) {
      const r = await client.request('GET', `/repos/${repo}/issues/${row.number}/comments?per_page=100&page=${page}`);
      if (!r.ok || !Array.isArray(r.json)) break;
      const hit = r.json.find((c) => typeof c?.body === 'string' && c.body.startsWith(row.marker) && c.user?.type === 'Bot' && (!bot || c.user.login === bot));
      if (hit) {
        body = spliceCard(hit.body, markdown);
        if (body !== hit.body) await client.request('PATCH', `/repos/${repo}/issues/comments/${hit.id}`, { body });
      }
      if (r.json.length < 100) break;
    }
    const base = state.baseCheck ?? null;
    if (row.check_id && base) {
      // As at review time: the card's verdict as the title, the short summary.
      const check = cardCheck({ base, verdict: card.verdict, gate: g.check });
      await client.request('PATCH', `/repos/${repo}/check-runs/${row.check_id}`, { conclusion: check.conclusion, output: { title: check.title, summary: base.summary ?? (body ?? markdown).replace(row.marker, '').trim().slice(0, 64_000) } });
    }
    db.prepare('UPDATE gh_merge_cards SET state = ?, ci = ?, updated_at = ? WHERE installation_id = ? AND repo_gh_id = ? AND number = ?').run(JSON.stringify({ ...state, card }), ciKey(ci), now(), row.installation_id, row.repo_gh_id, row.number);
    return { updated: true, ci: ci.state, gate: g.decision?.risk ?? null };
  }

  const sweep = (days = 30) => db.prepare('DELETE FROM gh_merge_cards WHERE updated_at < ?').run(now() - days * 86_400_000);
  return { prepare, refresh, cardsFor, readCi, sweep, marker: CARD_MARKER };
}
