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
// and settingsSection(team, csrf) for the settings page, reviewPanel(...) for the run page.
//
// Without GITHUB_APP_* in env every route answers "not configured" and
// nothing else changes. Pull request events are answered 202 at once and
// processed by a small in-process queue.
//
// options (tests): { env, fetch, apiBase, sleep, governance(team) -> bool,
//   repoFor, provenanceFor, hasProvenance, reviewsFor (see source.js), concurrency }

import { tx } from '../db.js';
import { HttpError, readBody, redirect, sendHtml, sendJson } from '../http.js';
import { HubReviews, MAX_NOTE } from '../reviews.js';
import { AppAuth } from './auth.js';
import { githubConfig } from './config.js';
import { Installations } from './link.js';
import { githubPage, githubSection } from './page.js';
import { CHECK_NAME, processPullRequest } from './pull.js';
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
const PULL_DAYS = 90;

// The governance plan, through billing's plan helpers when billing exposes
// one; else off. A team that loses the plan keeps its setting, inert.
function defaultGovernance(hub) {
  return (team) => {
    try {
      const l = hub.limits(team);
      if (l?.governance === true) return true;
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

  const jobCtx = { db, teams, auth, apiBase, fetch: fetchImpl, now, sleep: options.sleep, signal: stop.signal, slug: cfg.slug, source, origin: config.origin, requireReview, requireProvenance, track, maxWaitMs: options.maxWaitMs ?? RATE_WAIT_MS };
  const queue = new JobQueue({
    concurrency: options.concurrency ?? 2,
    log,
    run: async (job) => {
      const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(options.jobMs ?? JOB_MS)]);
      const r = await processPullRequest({ ...jobCtx, signal }, job);
      // No repo, owner or PR in the log line: the outcome only.
      log(r.skipped ? `github pr skipped: ${r.skipped}` : `github pr: comment ${r.comment.action}, check ${r.check.conclusion}${r.empty ? ' (no provenance)' : ''}`);
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
          installs.created(inst, p.sender);
          if (Array.isArray(p.repositories)) installs.repos(inst?.id, p.repositories, []);
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
          // Its runs no longer need re-evaluation after a review.
          const row = installs.get(inst?.id);
          if (row && Number.isSafeInteger(p.repository?.id) && Number.isSafeInteger(p.pull_request?.number)) forgetPull(row.id, p.repository.id, p.pull_request.number);
          return { ignored: 'action' };
        }
        if (!PR_ACTIONS.has(p.action) || p.pull_request?.draft) return { ignored: 'action' };
        const row = installs.get(inst?.id);
        if (!row?.team_id || row.deleted_at || row.suspended_at) return { ignored: 'unlinked' };
        if (!auth || !cfg.slug) return { ignored: 'not_configured' };
        const job = {
          installationId: row.id,
          repoId: Number.isSafeInteger(p.repository?.id) ? p.repository.id : null,
          owner: String(p.repository?.owner?.login ?? ''),
          name: String(p.repository?.name ?? ''),
          number: p.pull_request?.number,
          headSha: String(p.pull_request?.head?.sha ?? ''),
        };
        const queued = queue.push(`${row.id}:${p.repository?.id}:${job.number}`, job, String(row.id));
        return queued ? { queued: true } : { ignored: 'busy' };
      }
      default:
        return { ignored: 'event' };
    }
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
        notice: Object.hasOwn(NOTICES, code) ? NOTICES[code] : null,
        ...extra,
      }).toString(),
    );
  }

  async function onPage(ctx, fn) {
    try {
      await fn();
    } catch (err) {
      if (err instanceof HttpError && err.status < 500 && err.status !== 403) return render(ctx, { error: err.message }, err.status);
      throw err;
    }
  }

  const notConfigured = () => new HttpError(503, 'not_configured', 'The GitHub App is not configured on this hub.');
  const installationId = (v) => {
    if (typeof v !== 'string' || !/^\d{1,12}$/.test(v)) throw new HttpError(400, 'bad_request', 'Unknown installation.');
    return Number(v);
  };
  const back = (ctx, done, form) =>
    redirect(ctx.res, form?.from === 'settings' ? `/hub/teams/${ctx.member.team.id}/settings#github` : `/hub/teams/${ctx.member.team.id}/github?done=${done}`);

  function routes(router) {
    router.post('/hub/github/webhook', webhook, { rate: 'webhook' });

    router.get(
      '/hub/github/setup',
      async (ctx) => {
        if (!cfg.configured) throw notConfigured();
        const q = ctx.url.searchParams;
        const id = installationId(q.get('installation_id') ?? '');
        const user = ctx.session.user;
        const state = q.get('state');
        if (!state) {
          // "Redirect on update" from GitHub's settings carries no state.
          const row = installs.get(id);
          if (row?.team_id && teams.membership(row.team_id, user.id)) return redirect(ctx.res, `/hub/teams/${row.team_id}/github?done=updated`);
          throw new HttpError(400, 'bad_state', 'Start from your team: Settings, GitHub, Install on GitHub.');
        }
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
          installs.link(teamId, id, user.id); // 409 if another team has it
          return redirect(ctx.res, `/hub/teams/${teamId}/github?done=linked`);
        }
        if (!row?.sender_id) {
          installs.pend(teamId, id, user.id);
          return redirect(ctx.res, `/hub/teams/${teamId}/github?done=pending`);
        }
        throw new HttpError(403, 'forbidden', 'Another GitHub account installed this. The person who installed the App has to link it.');
      },
      { auth: 'session', rate: 'auth' },
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
          installs.link(ctx.member.team.id, installationId(ctx.form.installation), ctx.session.user.id);
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

    router.post(
      '/hub/teams/:team/github/policy',
      (ctx) =>
        onPage(ctx, () => {
          const team = teams.get(ctx.member.team.id);
          const change = {};
          for (const k of ['require_review', 'require_provenance']) if (ctx.form[k] === '1' || ctx.form[k] === '0') change[k] = ctx.form[k] === '1';
          if (!Object.keys(change).length) throw new HttpError(400, 'bad_request', 'Nothing to change.');
          if (Object.values(change).some(Boolean) && !governance(team)) throw new HttpError(402, 'plan_required', 'Requiring review is on the Governance plan.');
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
        try {
          reviews.record(team, ctx.repo.id, ctx.params.run, status, ctx.session.user.id, note);
        } catch (err) {
          if (err?.code === 'own_run') throw new HttpError(403, 'own_run', err.message);
          if (err?.code === 'not_found') throw new HttpError(404, 'not_found', err.message);
          if (err?.code === 'bad_request') throw new HttpError(400, 'bad_request', err.message);
          throw err;
        }
        // No run id, repo or user in the log line: the outcome only.
        const queued = reevaluate(team.id, ctx.params.run);
        log(`hub review: ${status}, ${queued} pull request${queued === 1 ? '' : 's'} re-checked`);
        const machine = typeof ctx.form.machine === 'string' && /^[A-Za-z0-9._ -]{1,100}$/.test(ctx.form.machine) ? ctx.form.machine : null;
        redirect(ctx.res, `/hub/teams/${team.id}/repos/${ctx.repo.id}/runs/${encodeURIComponent(ctx.params.run)}?${machine ? `machine=${encodeURIComponent(machine)}&` : ''}done=${status}`);
      },
      REVIEW_FORM,
    );
  }

  function settingsSection(team, csrf) {
    return githubSection({ team, csrf, configured: cfg.configured, installations: installs.forTeam(team.id), policy: policy(team.id), allowed: governance(team), slug: cfg.slug, checkName: CHECK_NAME });
  }

  // What the hub run page shows about reviews (src/hub/pages/repo.js).
  function reviewPanel({ team, repo, run, userId, done = null }) {
    const ids = [repo.id];
    const owners = reviews.owners(team, run);
    const loginOf = db.prepare('SELECT login FROM users WHERE id = ?');
    const pulls = db
      .prepare('SELECT DISTINCT owner, name, number FROM gh_pull_runs WHERE team_id = ? AND run = ? ORDER BY updated_at DESC LIMIT 20')
      .all(team.id, run);
    return {
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
    } catch {}
  }, 60 * 60 * 1000);
  sweep.unref();

  return {
    config: cfg,
    auth,
    installs,
    deliveries,
    queue,
    routes,
    settingsSection,
    reviewPanel,
    reviews,
    reevaluate,
    policy,
    setPolicy,
    requireReview,
    requireProvenance,
    process: (job) => processPullRequest(jobCtx, job),
    close() {
      clearInterval(sweep);
      stop.abort();
      queue.close();
    },
  };
}
