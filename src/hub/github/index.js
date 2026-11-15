// The Grapim GitHub App, inside the hub (docs/provenance.md section 6).
//
// createGitHubApp(hub, options) is called by createHub. It adds:
//   POST /hub/github/webhook               signed webhooks (no session, no CSRF: the HMAC is the auth)
//   GET  /hub/github/setup                 GitHub's setup redirect after an install (session + signed state)
//   GET  /hub/teams/:team/github           the team's GitHub page (owner)
//   POST /hub/teams/:team/github/install   -> github.com/apps/<slug>/installations/new?state=... (owner)
//   POST /hub/teams/:team/github/link      link an installation you made (owner)
//   POST /hub/teams/:team/github/unlink    (owner)
//   POST /hub/teams/:team/github/policy    require_review / require_provenance on or off (owner; on needs the governance plan)
//   POST /hub/teams/:team/repos/:repo/runs/:run/decision
//                                          approve or reject a synced run (any member but the run's owner)
//   GET  /hub/teams/:team/github/history   the 90-day AI history report (members)
//   POST /hub/teams/:team/github/history/scan  start a scan (owner)
//   GET  /hub/api/teams/:team/github/history[.csv]
//   GET  /hub/teams/:team/rules            -> /settings/rules (path rules: members see, owners edit)
//   POST /hub/teams/:team/rules            add a rule (owner, governance)
//   POST /hub/teams/:team/rules/:rule/delete
// and settingsSection, policySection, rulesSection and notifySection for the
// settings pages (src/hub/routes-pages.js), reviewPanel(...) for the run page.
//
// The check run carries "Approve" buttons (check run actions) for the runs
// still to approve; a click arrives as check_run.requested_action and is
// recorded as the clicking GitHub user, a hub member, under the hub's rules.
//
// Without GITHUB_APP_* in env every route answers "not configured" and
// nothing else changes. Pull request events are answered 202 at once and
// processed by a small in-process queue.
//
// options (tests): { env, fetch, apiBase, sleep, governance(team) -> bool,
//   repoFor, provenanceFor, hasProvenance, reviewsFor (see source.js), concurrency }

import { tx } from '../db.js';
import { HttpError, readBody, redirect, sendHtml, sendJson } from '../http.js';
import { html } from '../pages/html.js';
import { appInstalledPage } from '../pages/layout.js';
import { PathRules } from '../rules.js';
import { hmac } from '../secure.js';
import { csvTable } from '../reports/csv.js';
import { AGENTS } from './agents.js';
import { historyCard, historyPage, notifyCard, rulesCard, rulesPanel } from './features-page.js';
import { HistoryScans } from './history.js';
import { HubReviews, MAX_NOTE } from '../reviews.js';
import { AppAuth } from './auth.js';
import { githubConfig } from './config.js';
import { Installations } from './link.js';
import { githubPage, githubSection, policyCard } from './page.js';
import { CHECK_NAME, processPullRequest } from './pull.js';
import { createCloudReview } from './cloud-review.js';
import { JobQueue } from './queue.js';
import { GITHUB_SCHEMA, migrateGitHubSchema } from './schema.js';
import { provenanceSource } from './source.js';
import { Deliveries, validDeliveryId, verifySignature } from './webhook.js';

export const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;
// One pull request job may run this long, and wait at most RATE_WAIT_MS for
// one rate-limited answer, so one account cannot hold a worker for long.
export const JOB_MS = 5 * 60 * 1000;
export const RATE_WAIT_MS = 60 * 1000;
const PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);
const TEAM_PAGE = { auth: 'session', team: true, owner: true };
const TEAM_FORM = { auth: 'session', csrf: true, team: true, owner: true };
const NOTICES = {
  linked: 'Linked. Pull requests in this account now get a provenance comment and check.',
  pending: 'Installed. Waiting for GitHub to confirm the installation; reload in a moment.',
  updated: 'GitHub saved the installation settings.',
  unlinked: 'Unlinked. Its pull requests no longer get provenance comments.',
  policy: 'Saved.',
};
const REVIEW_FORM = { auth: 'session', csrf: true, team: true, repo: true };
const TEAM_VIEW = { auth: 'session', team: true };
// The starter path rules: low-risk files pass on their own, sensitive ones need a person.
export const STARTER_RULES = Object.freeze([
  ['docs/**', 'auto'],
  ['**/*.md', 'auto'],
  ['test/**', 'auto'],
  ['tests/**', 'auto'],
  ['**/__tests__/**', 'auto'],
  ['**/*.test.*', 'auto'],
  ['**/*.spec.*', 'auto'],
  ['**/auth/**', 'review'],
  ['**/payments/**', 'review'],
  ['**/migrations/**', 'review'],
  ['infra/**', 'review'],
  ['.github/workflows/**', 'review'],
]);
const PULL_DAYS = 90;
const NOTICE_MS = 10 * 60 * 1000;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

// The governance plan, through billing's plan helpers when billing exposes
// one; else off. A team that loses the plan keeps its setting, inert.
function defaultGovernance(hub) {
  return (team) => {
    try {
      const l = hub.limits(team);
      if (l?.governance === true) return true;
      if (l?.features && !Array.isArray(l.features) && typeof l.features.requireReview === 'boolean') return l.features.requireReview;
      if (Array.isArray(l?.features) && (l.features.includes('governance') || l.features.includes('require_review'))) return true;
      const b = hub.billing;
      if (typeof b?.hasFeature === 'function') return !!b.hasFeature(team, 'require_review');
      const plan = typeof b?.effectivePlan === 'function' ? b.effectivePlan(team, hub.now()) : null;
      return plan === 'governance';
    } catch {
      return false;
    }
  };
}

export function createGitHubApp(hub, options = {}) {
  const { db, now, log, teams, config } = hub;
  db.exec(GITHUB_SCHEMA);
  migrateGitHubSchema(db);
  const cfg = githubConfig(options.env ?? process.env);
  if (cfg.problems.length) log(`github app: ${cfg.problems.join(' ')}`);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const apiBase = String(options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const auth = cfg.canAct ? new AppAuth({ appId: cfg.appId, key: cfg.key, apiBase, fetch: fetchImpl, now }) : null;
  const installs = new Installations({ db, now, secret: config.secret, teams });
  const deliveries = new Deliveries({ db, now });
  const reviews = new HubReviews({ db, now });
  const source = provenanceSource(hub, options, reviews);
  const governance = typeof options.governance === 'function' ? options.governance : defaultGovernance(hub);
  const stop = new AbortController();
  const rules = new PathRules({ db, now });
  const cloud = createCloudReview(hub, { auth, installs, apiBase, fetch: fetchImpl, slug: cfg.slug, env: options.env ?? process.env, gitUrl: options.gitUrl ?? null, signal: stop.signal, ...(options.provenanceWaitMs !== undefined ? { provenanceWaitMs: options.provenanceWaitMs } : {}) });
  const scans = new HistoryScans({ db, now, log, auth, apiBase, fetch: fetchImpl, sleep: options.sleep, maxWaitMs: options.maxWaitMs ?? RATE_WAIT_MS, signal: stop.signal, timers: options.historyTimers !== false, ...(options.rescanMs !== undefined ? { rescanMs: options.rescanMs } : {}) });
  // Starts the 90-day scan; an install-time scan never fails the link.
  const startScan = (teamId, userId, reason) => {
    if (!auth) {
      if (reason === 'manual') throw new HttpError(503, 'not_configured', 'The GitHub App is not configured on this hub.');
      return null;
    }
    if (reason === 'manual' && !installs.forTeam(teamId).length) throw new HttpError(409, 'not_linked', 'Link a GitHub installation first.');
    try {
      return scans.start(teamId, userId, reason);
    } catch (err) {
      if (reason === 'manual') throw err;
      return null;
    }
  };

  // ---- Path rules (src/hub/rules.js): governance only ----

  // The run's current approvals, without its owners (they cannot approve).
  const currentApprovals = (team, repoIds, run) => {
    const owners = reviews.owners(team, run);
    return reviews.approvals(team, repoIds, run).filter((a) => !owners.has(a.user_id));
  };
  const evaluateRun = (team, repoIds, run, list = rules.list(team.id)) => rules.evaluate(team.id, repoIds, run, currentApprovals(team, repoIds, run), list);
  // Map run -> evaluation, for the runs any rule applies to.
  function rulesFor(team, repoIds, runIds) {
    const out = new Map();
    if (!governance(team)) return out;
    const list = rules.list(team.id);
    if (!list.length) return out;
    for (const run of runIds.slice(0, 500)) {
      const e = evaluateRun(team, repoIds, run, list);
      if (e.rules.length) out.set(run, e);
    }
    return out;
  }
  source.rulesFor = async (team, repo, runIds) => rulesFor(team, [repo.id, ...(Array.isArray(repo.alt) ? repo.alt : [])], runIds);

  // Automatic rules (src/hub/rules.js): approves a run when every file it
  // changed is covered by one and no review rule applies. Writes an approval
  // with via 'rule' in each repo that has the run's changes. Returns whether
  // anything was written. Governance only, like every path rule.
  function autoApprove(team, repoIds, run, list = rules.list(team.id)) {
    if (!governance(team) || !list.some((r) => r.action === 'auto')) return false;
    let wrote = false;
    for (const repoId of repoIds) {
      const a = rules.autoApproval(team.id, [repoId], run, list);
      if (a && reviews.recordRule(team, repoId, run, a.rules)) wrote = true;
    }
    return wrote;
  }
  // Before the check reads reviews, approve what the rules cover.
  const readReviews = source.hubReviewsFor;
  source.hubReviewsFor = async (team, repo, runIds) => {
    try {
      const ids = [repo.id, ...(Array.isArray(repo.alt) ? repo.alt : [])];
      const list = rules.list(team.id);
      if (list.some((r) => r.action === 'auto')) for (const run of runIds.slice(0, 500)) autoApprove(team, ids, run, list);
    } catch (err) {
      log(`github app: automatic rules failed for team ${team.id}: ${err.message}`);
    }
    return readReviews(team, repo, runIds);
  };
  // After a sync, the runs it touched: approve the covered ones and re-run
  // the checks of their open pull requests.
  function onSync(teamId, repoId) {
    try {
      const team = teams.get(teamId);
      if (!team || !governance(team)) return;
      const list = rules.list(team.id);
      if (!list.some((r) => r.action === 'auto')) return;
      const recent = db
        .prepare(
          `SELECT c.run, MAX(c.id) AS head FROM h_changes c WHERE c.team_id = ? AND c.repo_id = ?
           GROUP BY c.run ORDER BY head DESC LIMIT 200`,
        )
        .all(teamId, repoId);
      const lastSeen = db.prepare('SELECT seen_change FROM hub_reviews WHERE team_id = ? AND repo_id = ? AND run = ? ORDER BY id DESC LIMIT 1');
      for (const r of recent) {
        if ((lastSeen.get(teamId, repoId, r.run)?.seen_change ?? 0) >= r.head) continue;
        if (autoApprove(team, [repoId], r.run, list)) reevaluate(teamId, r.run);
      }
    } catch (err) {
      log(`github app: automatic rules failed after a sync of team ${teamId}: ${err.message}`);
    }
  }
  hub.bus?.on?.('sync', onSync);
  // After rules change: the runs of open pull requests the new rules cover.
  function applyToOpenPulls(team) {
    try {
      const list = rules.list(team.id);
      if (!governance(team) || !list.some((r) => r.action === 'auto')) return;
      const repoIds = db.prepare('SELECT id FROM repos WHERE team_id = ?').all(team.id).map((r) => r.id);
      const runs = db.prepare('SELECT DISTINCT run FROM gh_pull_runs WHERE team_id = ? LIMIT 500').all(team.id).map((r) => r.run);
      for (const run of runs) if (autoApprove(team, repoIds, run, list)) reevaluate(team.id, run);
    } catch (err) {
      log(`github app: automatic rules failed for team ${team.id}: ${err.message}`);
    }
  }

  // One decision, from the run page or the check's button: the same rules.
  // Throws { code } errors: own_run, not_found, bad_request, not_approver.
  function decideRun(team, repoId, run, status, userId, note, via = 'hub') {
    let applied = [];
    if (governance(team)) {
      const list = rules.list(team.id);
      if (list.length) {
        const may = rules.mayApprove(team.id, [repoId], run, userId, list);
        applied = may.rules;
        if (status === 'approved' && !may.ok && reviews.headChange(team, repoId, run)) {
          const names = [...new Set(may.rules.flatMap((r) => r.approvers))].map((id) => db.prepare('SELECT login FROM users WHERE id = ?').get(id)?.login ?? `user ${id}`);
          throw Object.assign(new Error(`This run changed ${may.rules.map((r) => r.pattern).join(', ')}: only ${names.join(', ')} can approve it.`), { code: 'not_approver' });
        }
      }
    }
    const out = reviews.record(team, repoId, run, status, userId, note, { via, rules: applied });
    return { ...out, queued: reevaluate(team.id, run) };
  }

  // ---- Check run buttons ----

  // The button's identifier for a run: stable per (team, repo, run), at most
  // 20 characters, stored so a click maps back inside this team only.
  function actionFor({ team, repoGhId, repoId, run, number }) {
    const identifier = `r${hmac(config.secret, 'gh-check-action', `${team.id}\n${repoId}\n${run}`).slice(0, 16)}`;
    db.prepare(
      `INSERT INTO gh_check_actions (team_id, identifier, repo_gh_id, repo_id, run, number, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(team_id, identifier, repo_gh_id) DO UPDATE SET number = excluded.number, created_at = excluded.created_at`,
    ).run(team.id, identifier, repoGhId, repoId, run, number, now());
    return identifier;
  }
  // A line the next check of a pull request shows (a refused click), kept 10 minutes.
  const notices = new Map();
  const noticeKey = (job) => `${job.installationId}:${job.repoId}:${job.number}`;
  // Shown on every check of that pull request for 10 minutes, or until an approval from GitHub lands.
  const noticeFor = (job) => {
    const n = notices.get(noticeKey(job));
    return n && now() - n.at < NOTICE_MS ? n.text : null;
  };

  // require_provenance defaults on, together with require_review.
  const policy = (teamId) => db.prepare('SELECT require_review, require_provenance FROM gh_team_policy WHERE team_id = ?').get(teamId) ?? { require_review: 0, require_provenance: 1 };
  // change: { require_review?: bool, require_provenance?: bool }; a missing key keeps its value.
  const setPolicy = (teamId, change, userId) => {
    const was = policy(teamId);
    const on = typeof change === 'boolean' ? { require_review: change } : change;
    const next = {
      require_review: on.require_review === undefined ? was.require_review : on.require_review ? 1 : 0,
      require_provenance: on.require_provenance === undefined ? was.require_provenance : on.require_provenance ? 1 : 0,
    };
    db.prepare(
      `INSERT INTO gh_team_policy (team_id, require_review, require_provenance, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(team_id) DO UPDATE SET require_review = excluded.require_review, require_provenance = excluded.require_provenance,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(teamId, next.require_review, next.require_provenance, userId, now());
  };
  const requireReview = (team) => !!policy(team.id).require_review && governance(team);
  const requireProvenance = (team) => requireReview(team) && !!policy(team.id).require_provenance;

  // The runs each pull request contains, for re-evaluation after a hub review.
  function track({ team, job, runs }) {
    const repoGh = Number(job.repoId);
    if (!Number.isSafeInteger(repoGh)) return;
    const t = now();
    const key = [job.installationId, repoGh, job.number];
    tx(db, () => {
      db.prepare('DELETE FROM gh_pull_runs WHERE installation_id = ? AND repo_gh_id = ? AND number = ?').run(...key);
      const put = db.prepare('INSERT OR IGNORE INTO gh_pull_runs (team_id, installation_id, repo_gh_id, owner, name, number, head_sha, run, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const run of runs.slice(0, 500)) put.run(team.id, job.installationId, repoGh, job.owner, job.name, job.number, job.headSha, run, t);
    });
  }
  const forgetPull = (installationId, repoGh, number) => db.prepare('DELETE FROM gh_pull_runs WHERE installation_id = ? AND repo_gh_id = ? AND number = ?').run(installationId, repoGh, number).changes;

  // Re-runs the check of every open pull request of the team that contains the
  // run, on the App's queue. Returns how many were queued.
  function reevaluate(teamId, run) {
    if (!auth || !cfg.slug) return 0;
    const rows = db
      .prepare('SELECT DISTINCT installation_id, repo_gh_id, owner, name, number, head_sha FROM gh_pull_runs WHERE team_id = ? AND run = ? LIMIT 200')
      .all(teamId, run);
    let queued = 0;
    for (const r of rows) {
      const inst = installs.get(r.installation_id);
      if (inst?.team_id !== teamId || inst.deleted_at || inst.suspended_at) continue;
      const job = { installationId: r.installation_id, repoId: r.repo_gh_id, owner: r.owner, name: r.name, number: r.number, headSha: r.head_sha };
      if (queue.push(`${r.installation_id}:${r.repo_gh_id}:${r.number}`, job, String(r.installation_id))) queued++;
    }
    return queued;
  }

  const jobCtx = { db, teams, auth, apiBase, fetch: fetchImpl, now, sleep: options.sleep, signal: stop.signal, slug: cfg.slug, source, origin: config.origin, requireReview, requireProvenance, track, actionFor, noticeFor, cloudOn: (team) => cloud.on(team), saveProvenance: (p) => cloud.saveProvenance(p), maxWaitMs: options.maxWaitMs ?? RATE_WAIT_MS };
  const queue = new JobQueue({
    concurrency: options.concurrency ?? 2,
    log,
    run: async (job) => {
      const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(options.jobMs ?? JOB_MS)]);
      const r = await processPullRequest({ ...jobCtx, signal }, job);
      // No repo, owner or PR in the log line: the outcome only.
      log(r.skipped ? `github pr skipped: ${r.skipped}` : `github pr: comment ${r.comment.action}, check ${r.check.conclusion}${r.empty ? ' (no provenance)' : ''}`);
      if (r.check?.conclusion === 'failure' && hub.notify) {
        const teamId = installs.get(job.installationId)?.team_id;
        if (teamId) await hub.notify.checkFailed({ teamId, owner: job.owner, name: job.name, number: job.number, headSha: job.headSha, title: r.title ?? '' }).catch(() => {});
      }
      return r;
    },
  });

  // ---- Webhook ----

  function onEvent(event, p) {
    const inst = p?.installation;
    switch (event) {
      case 'ping':
        return { ok: true };
      case 'installation':
        if (p.action === 'created') {
          const before = installs.get(inst?.id)?.team_id ?? null;
          const row = installs.created(inst, p.sender);
          if (Array.isArray(p.repositories)) installs.repos(inst?.id, p.repositories, []);
          // A pending link completed by this event: read the team's last 90 days.
          if (row?.team_id && !before) startScan(row.team_id, row.linked_by, 'install');
        } else if (p.action === 'deleted') {
          installs.deleted(inst);
          auth?.forget(inst?.id);
        } else if (p.action === 'suspend' || p.action === 'unsuspend') {
          installs.suspended(inst, p.action === 'suspend');
          auth?.forget(inst?.id);
        } else if (installs.get(inst?.id)) installs.upsert(inst);
        return { ok: true };
      case 'installation_repositories':
        if (!installs.get(inst?.id)) installs.upsert(inst);
        installs.repos(inst?.id, Array.isArray(p.repositories_added) ? p.repositories_added : [], Array.isArray(p.repositories_removed) ? p.repositories_removed : []);
        return { ok: true };
      case 'pull_request': {
        if (p.action === 'closed') {
          // Its runs no longer need re-evaluation after a review. Merged: kept
          // as evidence that the runs reached the default branch's history.
          const row = installs.get(inst?.id);
          if (row && Number.isSafeInteger(p.repository?.id) && Number.isSafeInteger(p.pull_request?.number)) {
            if (p.pull_request.merged === true && row.team_id) {
              const at = Date.parse(p.pull_request.merged_at ?? '') || now();
              db.prepare(
                `INSERT OR IGNORE INTO gh_merged_runs (team_id, run, owner, name, number, head_sha, merged_at)
                 SELECT team_id, run, owner, name, number, head_sha, ? FROM gh_pull_runs WHERE installation_id = ? AND repo_gh_id = ? AND number = ? AND team_id = ?`,
              ).run(at, row.id, p.repository.id, p.pull_request.number, row.team_id);
            }
            forgetPull(row.id, p.repository.id, p.pull_request.number);
          }
          return { ignored: 'action' };
        }
        if (!PR_ACTIONS.has(p.action) || p.pull_request?.draft) return { ignored: 'action' };
        const row = installs.get(inst?.id);
        if (!row || row.deleted_at || row.suspended_at) return { ignored: 'unlinked' };
        if (!auth || !cfg.slug) return { ignored: 'not_configured' };
        const job = {
          installationId: row.id,
          repoId: Number.isSafeInteger(p.repository?.id) ? p.repository.id : null,
          owner: String(p.repository?.owner?.login ?? ''),
          name: String(p.repository?.name ?? ''),
          number: p.pull_request?.number,
          headSha: String(p.pull_request?.head?.sha ?? ''),
        };
        // Public repositories are reviewed free, also for an installation no
        // team has linked yet (cloud-review.js checks again with the API).
        const isPublic = p.repository?.private === false;
        if (!row.team_id) {
          const reviewing = isPublic && cloud.onPullRequest({ ...job, teamId: null, public: true });
          return reviewing ? { queued: true, review: true } : { ignored: 'unlinked' };
        }
        const queued = queue.push(`${row.id}:${p.repository?.id}:${job.number}`, job, String(row.id));
        // Cloud review (cloud-review.js), when the team turned it on.
        const reviewing = cloud.onPullRequest({ ...job, teamId: row.team_id, public: isPublic });
        return queued || reviewing ? { queued: true, ...(reviewing ? { review: true } : {}) } : { ignored: 'busy' };
      }
      case 'check_run':
        return p.action === 'requested_action' ? onRequestedAction(p) : { ignored: 'action' };
      default:
        return { ignored: 'event' };
    }
  }

  // A click on an "Approve" button of our check. The webhook signature is
  // verified; of the payload, only GitHub's own ids are trusted: the
  // installation (-> the team), the repository id (must match the button's)
  // and the sender's numeric id (-> the hub user, keyed by GitHub user id).
  // The sender's login is never used to find anyone.
  function onRequestedAction(p) {
    const row = installs.get(p.installation?.id);
    if (!row?.team_id || row.deleted_at || row.suspended_at) return { ignored: 'unlinked' };
    const team = teams.get(row.team_id);
    if (!team) return { ignored: 'unlinked' };
    if (cfg.slug && p.check_run?.app?.slug !== undefined && p.check_run.app.slug !== cfg.slug) return { ignored: 'not_ours' };
    const identifier = p.requested_action?.identifier;
    if (typeof identifier !== 'string' || !/^r[A-Za-z0-9_-]{16}$/.test(identifier)) return { ignored: 'bad_action' };
    const repoGh = p.repository?.id;
    if (!Number.isSafeInteger(repoGh)) return { ignored: 'bad_action' };
    const act = db.prepare('SELECT * FROM gh_check_actions WHERE team_id = ? AND identifier = ? AND repo_gh_id = ?').get(team.id, identifier, repoGh);
    if (!act) return { ignored: 'unknown_action' };
    const owner = String(p.repository?.owner?.login ?? '');
    const name = String(p.repository?.name ?? '');
    const headSha = String(p.check_run?.head_sha ?? '');
    const job = { installationId: row.id, repoId: repoGh, owner, name, number: act.number, headSha };
    const sender = p.sender ?? {};
    const shown = typeof sender.login === 'string' && LOGIN.test(sender.login) ? sender.login : 'This GitHub user';
    const refuse = (text, code) => {
      notices.set(noticeKey(job), { text: `Not approved: ${text}`, at: now() });
      if (auth && cfg.slug && /^[0-9a-f]{40}$/.test(headSha)) queue.push(`${row.id}:${repoGh}:${act.number}`, job, String(row.id));
      log(`github approve button refused: ${code}`);
      return { refused: code };
    };
    if (!Number.isSafeInteger(sender.id) || sender.id <= 0 || sender.type !== 'User') return refuse('only a person can approve a run.', 'not_a_user');
    const member = teams.membership(team.id, sender.id);
    if (!member) return refuse(`${shown} is not a member of this team in Grapim. Sign in to Grapim with GitHub and join the team, then click again.`, 'not_member');
    try {
      decideRun(team, act.repo_id, act.run, 'approved', sender.id, `Approved from the GitHub check on ${owner}/${name}#${act.number}`.slice(0, 200), 'github');
    } catch (err) {
      if (err?.code === 'own_run') return refuse(`${shown} synced this run, so another member has to approve it.`, 'own_run');
      if (err?.code === 'not_approver') return refuse(err.message, 'not_approver');
      if (err?.code === 'not_found' || err?.code === 'bad_request') return refuse('this run is no longer in the hub.', 'not_found');
      throw err;
    }
    notices.delete(noticeKey(job));
    log('github approve button: approved');
    return { ok: true, approved: true };
  }

  async function webhook(ctx) {
    const { req, res } = ctx;
    const reply = (status, body) => sendJson(res, status, body);
    const error = (status, code, message) => reply(status, { error: { code, message } });
    // No secret: refuse everything, never accept unsigned events.
    if (!cfg.canVerify) {
      req.resume();
      return error(503, 'not_configured', 'The GitHub App is not configured on this hub.');
    }
    let raw;
    try {
      raw = await readBody(req, MAX_WEBHOOK_BYTES);
    } catch (err) {
      if (err instanceof HttpError) return error(err.status, err.code, err.message);
      throw err;
    }
    // The signature is checked over the raw bytes before anything reads them.
    if (!verifySignature(cfg.webhookSecret, raw, req.headers['x-hub-signature-256'])) return error(401, 'bad_signature', 'Webhook signature missing or wrong.');
    const delivery = req.headers['x-github-delivery'];
    const event = req.headers['x-github-event'];
    if (!validDeliveryId(delivery) || typeof event !== 'string' || !/^[a-z_]{1,64}$/.test(event)) return error(400, 'bad_request', 'Missing delivery or event header.');
    if (!deliveries.first(delivery)) return reply(200, { ok: true, duplicate: true });
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return error(400, 'bad_payload', 'The body is not JSON.');
    }
    if (!payload || typeof payload !== 'object') return error(400, 'bad_payload', 'The body is not a JSON object.');
    const r = onEvent(event, payload);
    reply(r.queued ? 202 : 200, r);
  }

  // ---- Pages ----

  function render(ctx, extra = {}, status = 200) {
    const team = teams.get(ctx.member.team.id);
    const user = ctx.session.user;
    const code = ctx.url.searchParams.get('done');
    sendHtml(
      ctx.res,
      status,
      githubPage({
        user,
        csrf: ctx.session.csrf,
        team,
        configured: cfg.configured,
        problems: cfg.problems,
        installations: installs.forTeam(team.id),
        linkable: cfg.configured ? installs.linkableBy(user.id) : [],
        pending: installs.pendingFor(team.id),
        policy: policy(team.id),
        allowed: governance(team),
        slug: cfg.slug,
        checkName: CHECK_NAME,
        history: historyInfo(team, ctx.session.csrf),
        notice: Object.hasOwn(NOTICES, code) ? NOTICES[code] : null,
        ...extra,
      }).toString(),
    );
  }

  async function onPage(ctx, fn) {
    try {
      await fn();
    } catch (err) {
      if (err instanceof HttpError && err.status < 500 && err.status !== 403) {
        // The policy form on Settings, Review rules gets its error there.
        if (ctx.form?.from === 'settings' && hub.renderSettings) return hub.renderSettings(ctx, { section: 'rules', error: err.message }, err.status);
        return render(ctx, { error: err.message }, err.status);
      }
      throw err;
    }
  }

  const notConfigured = () => new HttpError(503, 'not_configured', 'The GitHub App is not configured on this hub.');
  const installationId = (v) => {
    if (typeof v !== 'string' || !/^\d{1,12}$/.test(v)) throw new HttpError(400, 'bad_request', 'Unknown installation.');
    return Number(v);
  };
  // The policy form sits on Settings, Review rules (from=settings) and on the GitHub page.
  const back = (ctx, done, form) =>
    redirect(ctx.res, form?.from === 'settings' ? `/hub/teams/${ctx.member.team.id}/settings/rules?done=policy_saved` : `/hub/teams/${ctx.member.team.id}/github?done=${done}`);

  function routes(router) {
    router.post('/hub/github/webhook', webhook, { rate: 'webhook' });

    router.get(
      '/hub/github/setup',
      async (ctx) => {
        if (!cfg.configured) throw notConfigured();
        const q = ctx.url.searchParams;
        const id = installationId(q.get('installation_id') ?? '');
        const state = q.get('state');
        if (!state) {
          // Installed or updated straight from GitHub, no team behind it: public
          // repositories are reviewed free from now on, no account needed.
          const user = ctx.session?.user ?? null;
          const row = installs.get(id);
          if (user && row?.team_id && teams.membership(row.team_id, user.id)) return redirect(ctx.res, `/hub/teams/${row.team_id}/github?done=updated`);
          return sendHtml(ctx.res, 200, appInstalledPage({ user, csrf: ctx.session?.csrf ?? null }));
        }
        if (!ctx.session) return redirect(ctx.res, `/hub/login?next=${encodeURIComponent(`${ctx.url.pathname}${ctx.url.search}`)}`);
        const user = ctx.session.user;
        const { teamId } = installs.consumeState(state, user.id);
        if (teams.membership(teamId, user.id)?.role !== 'owner') throw new HttpError(403, 'forbidden', 'Only a team owner can link GitHub.');
        let row = installs.get(id);
        if (!row) {
          // Not seen yet (the redirect can beat the webhook): ask GitHub with the App JWT.
          const found = await auth.installation(id).catch((err) => {
            log(`github setup: installation lookup failed: ${err?.message ?? err}`);
            return null;
          });
          if (found) row = installs.upsert(found, null);
        }
        if (row && installs.mayLink(row, user.id)) {
          const linked = installs.link(teamId, id, user.id); // 409 if another team has it
          if (linked === 'linked') startScan(teamId, user.id, 'install');
          return redirect(ctx.res, `/hub/teams/${teamId}/github?done=linked`);
        }
        if (!row?.sender_id) {
          installs.pend(teamId, id, user.id);
          return redirect(ctx.res, `/hub/teams/${teamId}/github?done=pending`);
        }
        throw new HttpError(403, 'forbidden', 'Another GitHub account installed this. The person who installed the App has to link it.');
      },
      { rate: 'auth' },
    );

    router.get('/hub/teams/:team/github', (ctx) => render(ctx), TEAM_PAGE);

    router.post(
      '/hub/teams/:team/github/install',
      (ctx) => {
        if (!cfg.configured) throw notConfigured();
        const state = installs.issueState(ctx.member.team.id, ctx.session.user.id);
        redirect(ctx.res, `https://github.com/apps/${cfg.slug}/installations/new?state=${encodeURIComponent(state)}`);
      },
      TEAM_FORM,
    );

    router.post(
      '/hub/teams/:team/github/link',
      (ctx) =>
        onPage(ctx, () => {
          if (!cfg.configured) throw notConfigured();
          const linked = installs.link(ctx.member.team.id, installationId(ctx.form.installation), ctx.session.user.id);
          if (linked === 'linked') startScan(ctx.member.team.id, ctx.session.user.id, 'install');
          back(ctx, 'linked');
        }),
      TEAM_FORM,
    );

    router.post(
      '/hub/teams/:team/github/unlink',
      (ctx) =>
        onPage(ctx, () => {
          const id = installationId(ctx.form.installation);
          installs.unlink(ctx.member.team.id, id);
          back(ctx, 'unlinked');
        }),
      TEAM_FORM,
    );

    // Cloud review on or off (owner).
    router.post(
      '/hub/teams/:team/github/cloud-review',
      (ctx) => {
        const team = teams.get(ctx.member.team.id);
        const on = ctx.form?.enabled === '1';
        if (ctx.form?.enabled !== '1' && ctx.form?.enabled !== '0') throw new HttpError(400, 'bad_request', 'Nothing to change.');
        if (on && !cloud.config.configured) throw new HttpError(503, 'not_configured', 'Cloud review is not set up on this hub.');
        if (on && !installs.forTeam(team.id).length) throw new HttpError(409, 'not_linked', 'Connect the GitHub App first.');
        cloud.setEnabled(team.id, on, ctx.session.user.id);
        // From the setup page on the overview, back to it.
        redirect(ctx.res, ctx.form?.from === 'overview' ? `/hub/teams/${team.id}` : `/hub/teams/${team.id}/settings/github#cloud-review`);
      },
      TEAM_FORM,
    );

    router.post(
      '/hub/teams/:team/github/policy',
      (ctx) =>
        onPage(ctx, () => {
          const team = teams.get(ctx.member.team.id);
          const change = {};
          for (const k of ['require_review', 'require_provenance']) if (ctx.form[k] === '1' || ctx.form[k] === '0') change[k] = ctx.form[k] === '1';
          if (!Object.keys(change).length) throw new HttpError(400, 'bad_request', 'Nothing to change.');
          if (Object.values(change).some(Boolean) && !governance(team)) throw new HttpError(402, 'plan_required', 'Requiring approval is on the Governance plan.');
          setPolicy(team.id, change, ctx.session.user.id);
          back(ctx, 'policy', ctx.form);
        }),
      TEAM_FORM,
    );

    // A review in the hub: the only kind require_review counts. Any signed-in
    // member may review, except the people whose machines synced the run.
    router.post(
      '/hub/teams/:team/repos/:repo/runs/:run/decision',
      (ctx) => {
        const team = ctx.member.team;
        const status = ctx.form.status === 'approved' || ctx.form.status === 'rejected' ? ctx.form.status : null;
        const note = typeof ctx.form.note === 'string' ? ctx.form.note.slice(0, MAX_NOTE * 2) : null;
        let queued;
        try {
          ({ queued } = decideRun(team, ctx.repo.id, ctx.params.run, status, ctx.session.user.id, note, 'hub'));
        } catch (err) {
          if (err?.code === 'own_run') throw new HttpError(403, 'own_run', err.message);
          if (err?.code === 'not_approver') throw new HttpError(403, 'not_approver', err.message);
          if (err?.code === 'not_found') throw new HttpError(404, 'not_found', err.message);
          if (err?.code === 'bad_request') throw new HttpError(400, 'bad_request', err.message);
          throw err;
        }
        // No run id, repo or user in the log line: the outcome only.
        log(`hub review: ${status}, ${queued} pull request${queued === 1 ? '' : 's'} re-checked`);
        const machine = typeof ctx.form.machine === 'string' && /^[A-Za-z0-9._ -]{1,100}$/.test(ctx.form.machine) ? ctx.form.machine : null;
        redirect(ctx.res, `/hub/teams/${team.id}/repos/${ctx.repo.id}/runs/${encodeURIComponent(ctx.params.run)}?${machine ? `machine=${encodeURIComponent(machine)}&` : ''}done=${status}`);
      },
      REVIEW_FORM,
    );

    // ---- The 90-day AI history scan ----

    const linkedTo = (teamId) => installs.forTeam(teamId).length > 0;
    const historyHtml = (ctx, extra = {}, status = 200) => {
      const team = teams.get(ctx.member.team.id);
      const report = scans.report(team.id);
      const last = report?.scan;
      const canScan = !last || last.status === 'failed' || (last.status === 'done' && now() - (last.finished_at ?? 0) >= scans.rescanMs);
      const code = ctx.url.searchParams.get('done');
      sendHtml(
        ctx.res,
        status,
        historyPage({
          user: ctx.session.user,
          csrf: ctx.session.csrf,
          team,
          role: ctx.member.role,
          report,
          configured: cfg.configured,
          linked: linkedTo(team.id),
          canScan,
          notice: code === 'scan' ? 'Scan started. It reads the last 90 days of merged pull requests in the background.' : null,
          ...extra,
        }).toString(),
      );
    };
    router.get('/hub/teams/:team/github/history', (ctx) => {
      hub.limit(ctx, 'read', ctx.member.userId);
      historyHtml(ctx);
    }, TEAM_VIEW);
    router.post(
      '/hub/teams/:team/github/history/scan',
      (ctx) => {
        try {
          startScan(ctx.member.team.id, ctx.session.user.id, 'manual');
        } catch (err) {
          if (err instanceof HttpError && err.status < 500) return historyHtml(ctx, { error: err.message }, err.status);
          throw err;
        }
        redirect(ctx.res, `/hub/teams/${ctx.member.team.id}/github/history?done=scan`);
      },
      TEAM_FORM,
    );
    router.get('/hub/api/teams/:team/github/history', (ctx) => {
      hub.limit(ctx, 'read', ctx.member.userId);
      const report = scans.report(ctx.member.team.id);
      sendJson(ctx.res, 200, report ?? { scan: null });
    }, TEAM_VIEW);
    router.get('/hub/api/teams/:team/github/history.csv', (ctx) => {
      hub.limit(ctx, 'read', ctx.member.userId);
      // No scan yet: the header row alone.
      const report = scans.report(ctx.member.team.id) ?? { prs: [], scan: { since: now() - 90 * 24 * 60 * 60 * 1000 } };
      const body = csvTable(
        ['repo', 'number', 'title', 'url', 'author', 'merged_at', 'agents', 'signals', 'approved_by_other', 'approvers'],
        report.prs.map((p) => [
          p.repo,
          p.number,
          p.title,
          p.url,
          p.author,
          new Date(p.merged_at).toISOString(),
          p.agents.map((a) => AGENTS[a.agent] ?? a.agent).join('; '),
          [...new Set(p.agents.flatMap((a) => a.how))].join('; '),
          p.approved_other ? 'yes' : 'no',
          p.approvers.join('; '),
        ]),
      );
      ctx.res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Content-Disposition': `attachment; filename="grapim-ai-history-${new Date(report.scan.since).toISOString().slice(0, 10)}.csv"`,
        'Cache-Control': 'no-store',
      });
      ctx.res.end(body);
    }, TEAM_VIEW);

    // ---- Path rules ----
    // They live on Settings, Review rules (src/hub/routes-pages.js); the old
    // address goes there. A refusal is shown on that page, above the form.

    const rulesBack = (ctx, done) => redirect(ctx.res, `/hub/teams/${ctx.member.team.id}/settings/rules?done=${done}`);
    async function onRules(ctx, fn) {
      try {
        await fn();
      } catch (err) {
        if (err instanceof HttpError && err.status < 500 && err.status !== 403 && err.status !== 404 && hub.renderSettings) return hub.renderSettings(ctx, { section: 'rules', error: err.message }, err.status);
        throw err;
      }
    }
    router.get('/hub/teams/:team/rules', (ctx) => redirect(ctx.res, `/hub/teams/${ctx.member.team.id}/settings/rules`), TEAM_VIEW);
    router.post(
      '/hub/teams/:team/rules',
      (ctx) =>
        onRules(ctx, () => {
          const team = teams.get(ctx.member.team.id);
          if (!governance(team)) throw new HttpError(402, 'plan_required', 'Path rules are on the Governance plan.');
          const approvers = Object.keys(ctx.form).filter((k) => /^approver_\d{1,12}$/.test(k) && ctx.form[k] === '1').map((k) => Number(k.slice(9)));
          try {
            rules.add(team.id, { pattern: ctx.form.pattern, approvals: ctx.form.approvals, approvers, action: ctx.form.action === 'auto' ? 'auto' : 'review' }, ctx.session.user.id);
          } catch (err) {
            if (err?.code === 'bad_request') throw new HttpError(400, 'bad_request', err.message);
            throw err;
          }
          applyToOpenPulls(team);
          rulesBack(ctx, 'rule_added');
        }),
      TEAM_FORM,
    );
    // A common starting set, added only to a team without rules.
    router.post(
      '/hub/teams/:team/rules/starter',
      (ctx) =>
        onRules(ctx, () => {
          const team = teams.get(ctx.member.team.id);
          if (!governance(team)) throw new HttpError(402, 'plan_required', 'Path rules are on the Governance plan.');
          if (rules.list(team.id).length) throw new HttpError(409, 'conflict', 'The starter rules are for a team without rules. Add rules one by one instead.');
          for (const [pattern, action] of STARTER_RULES) rules.add(team.id, { pattern, action, approvals: 1 }, ctx.session.user.id);
          applyToOpenPulls(team);
          rulesBack(ctx, 'rule_added');
        }),
      TEAM_FORM,
    );
    router.post(
      '/hub/teams/:team/rules/:rule/delete',
      (ctx) => {
        if (!/^\d{1,12}$/.test(ctx.params.rule) || !rules.remove(ctx.member.team.id, ctx.params.rule)) throw new HttpError(404, 'not_found', 'No such rule.');
        rulesBack(ctx, 'rule_removed');
      },
      TEAM_FORM,
    );
  }

  function historyInfo(team, csrf, owner = true) {
    const linked = installs.forTeam(team.id).length > 0;
    return historyCard({ team, csrf, owner, report: scans.report(team.id), configured: cfg.configured, linked });
  }

  function settingsSection(team, csrf) {
    return html`${githubSection({ team, csrf, configured: cfg.configured, installations: installs.forTeam(team.id), policy: policy(team.id), allowed: governance(team), slug: cfg.slug, checkName: CHECK_NAME, history: historyInfo(team, csrf) })}
${cfg.configured ? cloud.card(team, csrf) : ''}`;
  }

  const notifySection = (team, csrf) => (hub.notify ? notifyCard({ team, csrf, info: hub.notify.info(team.id) }) : null);
  const rulesSection = (team, csrf, role) => rulesCard({ team, csrf, role, rules: rules.list(team.id), members: teams.members(team.id), allowed: governance(team) });
  // Require review before merge, on Settings, Review rules (owners).
  const policySection = (team, csrf) => policyCard({ team, csrf, policy: policy(team.id), allowed: governance(team), slug: cfg.slug, checkName: CHECK_NAME });

  // What the hub run page shows about reviews (src/hub/pages/repo.js).
  function reviewPanel({ team, repo, run, userId, done = null }) {
    const ids = [repo.id];
    const owners = reviews.owners(team, run);
    const loginOf = db.prepare('SELECT login FROM users WHERE id = ?');
    const pulls = db
      .prepare('SELECT DISTINCT owner, name, number FROM gh_pull_runs WHERE team_id = ? AND run = ? ORDER BY updated_at DESC LIMIT 20')
      .all(team.id, run);
    const evaluation = governance(team) ? evaluateRun(team, ids, run) : null;
    return {
      rules: evaluation?.rules.length ? evaluation : null,
      rulesHtml: evaluation?.rules.length ? rulesPanel(evaluation) : '',
      hub: reviews.latest(team, ids, [run]).get(run) ?? null,
      local: reviews.local(team, ids, [run]).get(run) ?? null,
      owners: [...owners].map((id) => loginOf.get(id)?.login ?? `user ${id}`),
      mine: owners.has(userId),
      enforced: requireReview(team),
      pulls,
      done: done === 'approved' || done === 'rejected' ? done : null,
    };
  }

  const sweep = setInterval(() => {
    try {
      installs.sweep();
      deliveries.sweep();
      db.prepare('DELETE FROM gh_pull_runs WHERE updated_at < ?').run(now() - PULL_DAYS * 24 * 60 * 60 * 1000);
      db.prepare('DELETE FROM gh_check_actions WHERE created_at < ?').run(now() - PULL_DAYS * 24 * 60 * 60 * 1000);
      for (const [k, v] of notices) if (now() - v.at >= NOTICE_MS) notices.delete(k);
    } catch {}
  }, 60 * 60 * 1000);
  sweep.unref();
  // Scans a restart interrupted carry on from their saved position.
  if (auth && options.historyBoot !== false) setImmediate(() => scans.kick());

  return {
    config: cfg,
    auth,
    installs,
    deliveries,
    queue,
    routes,
    settingsSection,
    policySection,
    reviewPanel,
    notifySection,
    rulesSection,
    reviews,
    rules,
    scans,
    rulesFor,
    autoApprove,
    onSync,
    decideRun,
    startScan,
    reevaluate,
    policy,
    setPolicy,
    requireReview,
    requireProvenance,
    process: (job) => processPullRequest(jobCtx, job),
    cloud,
    // What a new team's setup page needs to offer cloud review first.
    cloudInfo(team) {
      const available = cfg.configured && cloud.config.configured;
      const linked = installs.forTeam(team.id);
      return { available, linked: linked.map((i) => i.account_login || `installation ${i.id}`), enabled: cloud.enabled(team.id), usage: cloud.usage(team), recent: cloud.recent(team.id), modelName: cloud.config.modelName };
    },
    close() {
      clearInterval(sweep);
      scans.close();
      stop.abort();
      queue.close();
      cloud.close();
    },
  };
}
