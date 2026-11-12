// Browser routes: sign in, teams, settings, invites, tokens, billing, and the
// read-only repo and run views. Every POST here is CSRF checked (opts.csrf).

import { safeNext } from './auth.js';
import { HttpError, redirect, sendHtml } from './http.js';
import { invitePage, pickerPage, signInPage } from './pages/account.js';
import { repoPage, runPage } from './pages/repo.js';
import { overviewPage, reposPage, reviewsPage, settingsPage } from './pages/team.js';
import { SCOPE_ROWS, WORKSPACE_TABS, workspacePage, workspacesPage } from './pages/workspaces.js';
import { getReview } from '../review.js';
import { cleanTemplate } from './templates.js';

// The "Limit to folders" rows of the token form (scope_path_<i>,
// scope_access_<i>) as rules; rows without a path are left out. None: null.
function scopeRows(form) {
  const rules = [];
  for (let i = 0; i < SCOPE_ROWS; i++) {
    const p = String(form[`scope_path_${i}`] ?? '').trim();
    if (p) rules.push({ path: p, access: form[`scope_access_${i}`] === 'write' ? 'write' : 'read' });
  }
  return rules.length ? rules : null;
}

const SESSION = { auth: 'session' };
const FORM = { auth: 'session', csrf: true };
const TEAM = { auth: 'session', team: true };
const TEAM_FORM = { auth: 'session', csrf: true, team: true };
const WS = { ...TEAM, workspace: true };
const WS_FORM = { ...TEAM_FORM, workspace: true };

// Stripe URLs only: the billing module's answer is never an open redirect.
function stripeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && (url.hostname === 'stripe.com' || url.hostname.endsWith('.stripe.com')) ? url.toString() : null;
  } catch {
    return null;
  }
}

const BILLING_STATUS = {
  bad_request: 400,
  not_configured: 503,
  live_key_refused: 503,
  no_customer: 409,
  stripe_unreachable: 502,
  stripe_error: 502,
};

// What a form did, said after its redirect as a toast (?done=<code>): a fixed
// list, so the address can never put words on the page.
const DONE = {
  team_created: 'Team created. Connect a repo below to start seeing what your agents change.',
  left: 'You left the team. Your machine tokens for it no longer work.',
  token_revoked: 'Token revoked. That machine can no longer sync.',
  invite_revoked: 'Invite link revoked.',
  member_removed: 'Member removed. Their machine tokens no longer work.',
  cap_saved: 'Monthly limit saved.',
  renamed: 'Workspace renamed. Agents and synced folders need the new address.',
  wstoken_revoked: 'Token revoked. Agents using it stop working at once.',
  synced: 'Synced.',
};
export const doneText = (ctx) => DONE[ctx.url?.searchParams.get('done')] ?? null;

export function pageRoutes(router, hub) {
  const { config, teams, read, auth, limits } = hub;
  const html = (ctx, body, status = 200, headers = {}) => sendHtml(ctx.res, status, body, headers);

  function renderSettings(ctx, extra = {}, status = 200) {
    const { team, role, userId } = ctx.member;
    const fresh = teams.get(team.id);
    const actor = { role, userId };
    html(
      ctx,
      settingsPage({
        user: ctx.session.user,
        csrf: ctx.session.csrf,
        team: fresh,
        role,
        members: teams.members(team.id),
        invites: role === 'owner' ? teams.invites(team.id) : [],
        tokens: teams.tokens(team.id, actor),
        limits: limits(fresh),
        seatsUsed: teams.seatsUsed(team.id),
        billing: { enabled: !!hub.billing, intervals: config.billingIntervals, governanceIntervals: config.governanceIntervals ?? [] },
        origin: config.origin,
        agent: hub.agent?.config.configured ? hub.agent.usageInfo(fresh, { people: role === 'owner' }) : null,
        github: role === 'owner' ? hub.github?.settingsSection(fresh, ctx.session.csrf) : null,
        // A team's own bucket (src/hub/team-storage.js): owners only.
        storage: role === 'owner' ? (hub.teamStorage?.settingsSection(fresh, ctx.session.csrf) ?? null) : null,
        ...extra,
      }),
      status,
    );
  }
  // The storage card's routes render the page with their own error (team-storage.js).
  hub.renderSettings = renderSettings;

  // Errors a person can fix on the settings page are shown there, not on a bare error page.
  async function onSettings(ctx, fn) {
    try {
      await fn();
    } catch (err) {
      if (err instanceof HttpError && err.status < 500 && err.status !== 404 && err.status !== 403) {
        renderSettings(ctx, { error: err.message }, err.status);
        return;
      }
      throw err;
    }
  }

  router.get('/', (ctx) => redirect(ctx.res, '/hub'));
  router.get('/hub/health', (ctx) => {
    ctx.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    ctx.res.end('ok');
  });

  router.get('/hub', (ctx) => {
    if (!ctx.session) return html(ctx, signInPage({}));
    html(ctx, pickerPage({ user: ctx.session.user, csrf: ctx.session.csrf, teams: hub.overview.teamsOf(ctx.session.user.id), toast: doneText(ctx) }));
  });

  router.get('/hub/login', (ctx) => {
    const next = safeNext(ctx.url.searchParams.get('next'));
    if (ctx.session) return redirect(ctx.res, next);
    html(ctx, signInPage({ next }));
  });

  router.get('/hub/auth/github', (ctx) => auth.start(ctx.res, ctx.url.searchParams.get('next')), { rate: 'auth' });

  router.get(
    '/hub/auth/callback',
    async (ctx) => {
      let result;
      try {
        result = await auth.callback(ctx.url.searchParams, ctx.cookies);
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        return html(ctx, signInPage({ error: err.message }), err.status, { 'Set-Cookie': auth.clearOauthCookie() });
      }
      // A fresh session id on every sign in (no session fixation).
      if (ctx.session) auth.destroy(ctx.session);
      const s = auth.createSession(result.userId);
      redirect(ctx.res, safeNext(result.next), { 'Set-Cookie': [s.cookie, auth.clearOauthCookie()] });
    },
    { rate: 'auth' },
  );

  router.post('/hub/logout', (ctx) => redirect(ctx.res, '/hub', { 'Set-Cookie': auth.destroy(ctx.session) }), FORM);

  router.post(
    '/hub/teams',
    (ctx) => {
      try {
        const u = ctx.session.user;
        if (config.teamCreators && !config.teamCreators.includes(String(u.id)) && !config.teamCreators.includes(u.login.toLowerCase())) {
          throw new HttpError(403, 'forbidden', 'This hub is in a private beta: creating teams is limited to invited accounts. Ask a team owner for an invite link.');
        }
        const team = teams.create(u, ctx.form.name);
        redirect(ctx.res, `/hub/teams/${team.id}?done=team_created`);
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        html(ctx, pickerPage({ user: ctx.session.user, csrf: ctx.session.csrf, teams: hub.overview.teamsOf(ctx.session.user.id), error: err.message }), err.status);
      }
    },
    FORM,
  );

  // ---- Invites ----

  router.get(
    '/hub/invite/:token',
    (ctx) => {
      const token = ctx.params.token;
      html(ctx, invitePage({ user: ctx.session.user, csrf: ctx.session.csrf, token, invite: teams.peekInvite(token) }), 200);
    },
    { ...SESSION, rate: 'auth' },
  );

  router.post(
    '/hub/invite/accept',
    (ctx) => {
      const { team } = teams.acceptInvite(ctx.form.token, ctx.session.user.id);
      redirect(ctx.res, `/hub/teams/${team.id}`);
    },
    { ...FORM, rate: 'auth' },
  );

  // ---- Team ----

  // The team home: what needs me now, or the setup checklist for a new team.
  router.get(
    '/hub/teams/:team',
    (ctx) => {
      const team = teams.get(ctx.member.team.id);
      const ov = hub.overview;
      const userId = ctx.session.user.id;
      const setup = ov.setup(team);
      const runs = setup.empty ? [] : ov.runs(team, userId);
      let teaser = null;
      try {
        teaser = setup.empty ? null : hub.reports.teaser(team);
      } catch (err) {
        if (!(err instanceof HttpError)) throw err; // over the compute budget: the page shows the rest
      }
      html(
        ctx,
        overviewPage({
          toast: doneText(ctx),
          user: ctx.session.user,
          csrf: ctx.session.csrf,
          team,
          role: ctx.member.role,
          origin: config.origin,
          setup,
          waiting: runs.filter((r) => r.waiting && !r.mine),
          mine: runs.filter((r) => r.waiting && r.mine),
          pulls: setup.empty ? { enforced: false, list: [] } : ov.pulls(team),
          teaser,
          active: setup.empty ? [] : ov.activeAgents(team),
          activity: setup.empty ? [] : ov.activity(team),
          repos: read.repos(team),
          workspaces: ov.workspaces(team).sort((a, b) => b.last_activity - a.last_activity),
        }),
      );
    },
    TEAM,
  );

  router.get(
    '/hub/teams/:team/repos',
    (ctx) => {
      const team = teams.get(ctx.member.team.id);
      const waiting = new Map();
      for (const r of hub.overview.runs(team, ctx.session.user.id)) if (r.waiting) waiting.set(r.repo_id, (waiting.get(r.repo_id) ?? 0) + 1);
      html(ctx, reposPage({ user: ctx.session.user, csrf: ctx.session.csrf, team, repos: read.repos(team), origin: config.origin, limits: limits(team), waiting }));
    },
    TEAM,
  );

  // The review inbox: synced runs that need a hub review.
  router.get(
    '/hub/teams/:team/reviews',
    (ctx) => {
      const team = teams.get(ctx.member.team.id);
      const all = hub.overview.runs(team, ctx.session.user.id);
      const groups = {
        yours: all.filter((r) => r.waiting && !r.mine),
        mine: all.filter((r) => r.waiting && r.mine),
        done: all.filter((r) => !r.waiting),
      };
      const f = ctx.url.searchParams.get('f');
      const filter = Object.hasOwn(groups, f) ? f : 'yours';
      const counts = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length]));
      html(ctx, reviewsPage({ user: ctx.session.user, csrf: ctx.session.csrf, team, filter, runs: groups[filter].slice(0, 200), counts }));
    },
    TEAM,
  );

  router.get(
    '/hub/teams/:team/settings',
    (ctx) => {
      const b = ctx.url.searchParams.get('billing');
      const notice = b === 'success' ? 'Thanks. The plan updates here as soon as Stripe confirms the payment.' : b === 'cancel' ? 'Checkout was cancelled. Nothing was charged.' : null;
      // The Ask Grapim limit form comes back here with ?error=cap (src/hub/agent/index.js).
      const capError = ctx.url.searchParams.get('error') === 'cap' ? { message: 'Enter an amount in dollars, like 5 or 12.50.' } : null;
      renderSettings(ctx, { notice, toast: doneText(ctx), capError });
    },
    TEAM,
  );

  router.post(
    '/hub/teams/:team/invites',
    (ctx) =>
      onSettings(ctx, () => {
        const inv = teams.createInvite(ctx.member.team.id, ctx.member);
        renderSettings(ctx, { revealed: { kind: 'invite', value: `${config.origin}/hub/invite/${inv.token}` } });
      }),
    TEAM_FORM,
  );

  router.post(
    '/hub/teams/:team/invites/:invite/revoke',
    (ctx) =>
      onSettings(ctx, () => {
        teams.revokeInvite(ctx.member.team.id, ctx.member, ctx.params.invite);
        redirect(ctx.res, `/hub/teams/${ctx.member.team.id}/settings?done=invite_revoked#invites`);
      }),
    TEAM_FORM,
  );

  router.post(
    '/hub/teams/:team/members/:user/remove',
    (ctx) =>
      onSettings(ctx, () => {
        const userId = Number(ctx.params.user);
        if (!Number.isSafeInteger(userId)) throw new HttpError(400, 'bad_request', 'Unknown member.');
        teams.removeMember(ctx.member.team.id, ctx.member, userId);
        redirect(ctx.res, `/hub/teams/${ctx.member.team.id}/settings?done=member_removed#members`);
      }),
    TEAM_FORM,
  );

  router.post(
    '/hub/teams/:team/leave',
    (ctx) =>
      onSettings(ctx, () => {
        teams.leave(ctx.member.team.id, ctx.session.user.id);
        redirect(ctx.res, '/hub?done=left');
      }),
    TEAM_FORM,
  );

  router.post(
    '/hub/teams/:team/tokens',
    (ctx) =>
      onSettings(ctx, () => {
        const t = teams.createToken(ctx.member.team.id, ctx.member, ctx.form.name);
        renderSettings(ctx, { revealed: { kind: 'token', value: t.token, name: t.name } });
      }),
    TEAM_FORM,
  );

  router.post(
    '/hub/teams/:team/tokens/:token/revoke',
    (ctx) =>
      onSettings(ctx, () => {
        teams.revokeToken(ctx.member.team.id, ctx.member, ctx.params.token);
        redirect(ctx.res, `/hub/teams/${ctx.member.team.id}/settings?done=token_revoked#tokens`);
      }),
    TEAM_FORM,
  );

  // ---- Cloud workspaces (docs/workspaces.md section 1) ----

  const { workspaces } = hub;
  const wsActor = (ctx) => ({ role: ctx.member.role, userId: ctx.member.userId });

  function renderWorkspaces(ctx, extra = {}, status = 200) {
    const team = teams.get(ctx.member.team.id);
    html(ctx, workspacesPage({ user: ctx.session.user, csrf: ctx.session.csrf, team, workspaces: hub.overview.workspaces(team), limit: workspaces.limitOf(team), ...extra }), status);
  }

  // The Activity tab: the workspace's newest runs and changes, read from its
  // ledger (the same engine the desk uses). A workspace being restored says so.
  function workspaceActivity(ws) {
    try {
      const store = hub.mount.engineFor(ws).store;
      const runs = store.runs().slice(0, 20).map((r) => ({ ...r, review: getReview(store, r.run)?.status ?? 'pending' }));
      const changes = store.db.prepare('SELECT c.run, COALESCE(a.label, c.label) AS label, c.path, c.added, c.removed, c.ts FROM changes c LEFT JOIN agents a ON a.agent = c.run ORDER BY c.id DESC LIMIT 12').all();
      return { runs, changes };
    } catch (err) {
      if (err instanceof HttpError || typeof err?.status === 'number') return { error: err.message };
      throw err;
    }
  }

  function renderWorkspace(ctx, extra = {}, status = 200) {
    const ws = workspaces.byId(ctx.member.team.id, ctx.workspace.id) ?? ctx.workspace;
    const tab = extra.tab ?? 'activity';
    html(
      ctx,
      workspacePage({
        user: ctx.session.user,
        csrf: ctx.session.csrf,
        team: ctx.member.team,
        role: ctx.member.role,
        ws,
        tokens: workspaces.tokens(ws, wsActor(ctx)),
        origin: config.origin,
        connectors: hub.connectors?.status(ws) ?? [], // SaaS connectors (src/hub/connectors.js)
        lastActivity: hub.overview.workspaceActivity(ws),
        activity: tab === 'activity' ? workspaceActivity(ws) : null,
        ...extra,
        tab,
      }),
      status,
    );
  }
  // A form's way back to the tab it was posted from.
  const tabFrom = (ctx, fallback) => (WORKSPACE_TABS.includes(ctx.form?.from) ? ctx.form.from : fallback);
  const onTab = (tab) => (ctx, extra = {}, status) => renderWorkspace(ctx, { tab, ...extra }, status);

  // Errors a person can fix are shown on the page they came from.
  async function onPage(ctx, render, fn) {
    try {
      await fn();
    } catch (err) {
      if (err instanceof HttpError && err.status < 500 && err.status !== 404 && err.status !== 403) {
        render(ctx, { error: err.message }, err.status);
        return;
      }
      throw err;
    }
  }

  router.get('/hub/teams/:team/workspaces', (ctx) => renderWorkspaces(ctx), TEAM);

  router.post(
    '/hub/teams/:team/workspaces',
    (ctx) =>
      onPage(ctx, renderWorkspaces, async () => {
        const team = teams.get(ctx.member.team.id);
        const template = cleanTemplate(ctx.form.template);
        const ws = workspaces.create(team, wsActor(ctx), ctx.form.name);
        // Its folders, as the approved run template:<name> (src/hub/templates.js).
        hub.mount.applyTemplate(ws, template, `human:${ctx.session.user.login}`);
        await hub.mount.measure(ws).catch(() => {});
        hub.platform?.workspaceCreated(ws); // a platform's webhooks (docs/platform.md)
        redirect(ctx.res, `/hub/teams/${team.id}/workspaces/${ws.id}`);
      }),
    TEAM_FORM,
  );

  router.get('/hub/teams/:team/workspaces/:ws', (ctx) => renderWorkspace(ctx, { toast: doneText(ctx) }), WS);
  for (const tab of WORKSPACE_TABS.filter((t) => t !== 'activity')) {
    router.get(`/hub/teams/:team/workspaces/:ws/${tab}`, (ctx) => renderWorkspace(ctx, { tab, toast: doneText(ctx) }), WS);
  }

  router.post(
    '/hub/teams/:team/workspaces/:ws/rename',
    (ctx) =>
      onPage(ctx, onTab('settings'), async () => {
        const ws = workspaces.rename(ctx.member.team.id, ctx.workspace.id, ctx.form.name);
        // The open engine serves the old address: close it, the next request opens the new one.
        await hub.mount.close(ws.id);
        redirect(ctx.res, `/hub/teams/${ctx.member.team.id}/workspaces/${ws.id}/settings?done=renamed`);
      }),
    WS_FORM,
  );

  router.post(
    '/hub/teams/:team/workspaces/:ws/delete',
    (ctx) =>
      onPage(ctx, onTab('settings'), async () => {
        const ws = ctx.workspace;
        if (String(ctx.form.confirm ?? '').trim() !== ws.name) throw new HttpError(400, 'bad_request', `Type ${ws.name} exactly to delete this workspace.`);
        // Its engine holds the folder's files open: close it before the move,
        // with no await in between, so no request can reopen it meanwhile.
        const closed = hub.mount.close(ws.id);
        workspaces.remove(ctx.member.team.id, ws.id);
        await closed;
        hub.platform?.workspaceDeleted(ws);
        renderWorkspaces(ctx, { notice: `Deleted ${ws.name}. Its address and tokens no longer work.` });
      }),
    { ...WS_FORM, owner: true },
  );

  router.post(
    '/hub/teams/:team/workspaces/:ws/tokens',
    (ctx) =>
      onPage(ctx, onTab(tabFrom(ctx, 'tokens')), () => {
        const t = workspaces.createToken(ctx.workspace, wsActor(ctx), ctx.form.name, ctx.form.scope, { scopes: scopeRows(ctx.form) });
        renderWorkspace(ctx, { tab: tabFrom(ctx, 'tokens'), revealed: { value: t.token, name: t.name, scope: t.scope, scopes: t.scopes } });
      }),
    WS_FORM,
  );

  router.post(
    '/hub/teams/:team/workspaces/:ws/tokens/:wstoken/revoke',
    (ctx) =>
      onPage(ctx, onTab('tokens'), () => {
        workspaces.revokeToken(ctx.workspace, wsActor(ctx), ctx.params.wstoken);
        redirect(ctx.res, `/hub/teams/${ctx.member.team.id}/workspaces/${ctx.workspace.id}/tokens?done=wstoken_revoked`);
      }),
    WS_FORM,
  );

  // ---- SaaS connectors (docs/connectors.md): owners connect, test, sync and disconnect ----

  const connectorName = (form) => String(form.connector ?? '');
  const backTo = (ctx) => `/hub/teams/${ctx.member.team.id}/workspaces/${ctx.workspace.id}/integrations`;

  router.post(
    '/hub/teams/:team/workspaces/:ws/connectors/connect',
    (ctx) =>
      onPage(ctx, onTab('integrations'), async () => {
        const info = await hub.connectors.connect(ctx.workspace, wsActor(ctx), connectorName(ctx.form), ctx.form.token);
        renderWorkspace(ctx, { tab: 'integrations', notice: `Connected to ${info.name}${info.workspace ? ` in ${info.workspace}` : ''}. The first sync is running; reload in a minute to see the pages.` });
      }),
    { ...WS_FORM, owner: true },
  );

  router.post(
    '/hub/teams/:team/workspaces/:ws/connectors/test',
    (ctx) =>
      onPage(ctx, onTab('integrations'), async () => {
        const info = await hub.connectors.test(ctx.workspace, connectorName(ctx.form));
        renderWorkspace(ctx, { tab: 'integrations', notice: `The connection works: ${info.name}${info.workspace ? ` in ${info.workspace}` : ''}.` });
      }),
    { ...WS_FORM, owner: true },
  );

  router.post(
    '/hub/teams/:team/workspaces/:ws/connectors/sync',
    (ctx) =>
      onPage(ctx, onTab('integrations'), async () => {
        await hub.connectors.syncNow(ctx.workspace, connectorName(ctx.form)).catch((err) => {
          throw new HttpError(400, 'bad_request', err.message);
        });
        redirect(ctx.res, `${backTo(ctx)}?done=synced`);
      }),
    { ...WS_FORM, owner: true },
  );

  router.post(
    '/hub/teams/:team/workspaces/:ws/connectors/disconnect',
    (ctx) =>
      onPage(ctx, onTab('integrations'), () => {
        hub.connectors.disconnect(ctx.workspace, connectorName(ctx.form));
        renderWorkspace(ctx, { tab: 'integrations', notice: 'Disconnected. Syncing stopped; the files and their history stay in the workspace.' });
      }),
    { ...WS_FORM, owner: true },
  );

  // ---- Repo and run views (read-only) ----

  router.get(
    '/hub/teams/:team/repos/:repo',
    (ctx) => {
      const { team } = ctx.member;
      const all = read.runs(team, ctx.repo);
      // 50 runs a page, newest first (?page=2 …); a page past the end shows the last.
      const size = 50;
      const pages = Math.max(1, Math.ceil(all.length / size));
      const n = Math.min(pages, Math.max(1, Number.parseInt(ctx.url.searchParams.get('page'), 10) || 1));
      const runs = all.slice((n - 1) * size, n * size);
      // Hub review state per run (src/hub/reviews.js), for the Review column.
      const reviews = hub.github?.reviews && runs.length ? hub.github.reviews.latest(team, [ctx.repo.id], runs.map((r) => r.run)) : new Map();
      html(ctx, repoPage({ user: ctx.session.user, csrf: ctx.session.csrf, team, repo: ctx.repo, overview: read.overview(team, ctx.repo), runs, reviews, page: { n, pages, size, total: all.length } }));
    },
    { ...TEAM, repo: true },
  );

  router.get(
    '/hub/teams/:team/repos/:repo/runs/:run',
    (ctx) => {
      const { team } = ctx.member;
      const detail = read.run(team, ctx.repo, ctx.params.run, ctx.url.searchParams.get('machine'));
      // Approve or reject in the hub: the review require_review counts (src/hub/github/index.js).
      const review = hub.github?.reviewPanel?.({ team, repo: ctx.repo, run: detail.run.run, userId: ctx.session.user.id, done: ctx.url.searchParams.get('done') }) ?? null;
      html(ctx, runPage({ user: ctx.session.user, csrf: ctx.session.csrf, team, repo: ctx.repo, detail, review }));
    },
    { ...TEAM, repo: true },
  );

  // ---- Billing ----

  const billingCall = async (ctx, fn) => {
    if (!hub.billing) throw new HttpError(503, 'billing_unavailable', 'Billing is not set up on this hub.');
    let out;
    try {
      out = await fn(hub.billing);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const status = BILLING_STATUS[err?.code];
      if (!status) throw err;
      hub.log(`billing ${err.code}`);
      const msg = status === 409 ? 'This team has no billing account yet. Upgrade first.' : status === 400 ? 'Check the seats and billing period.' : 'Billing is unavailable right now. Try again shortly.';
      throw new HttpError(status, err.code, msg);
    }
    const url = stripeUrl(out?.url);
    if (!url) throw new HttpError(502, 'billing_error', 'Billing returned an unexpected address.');
    redirect(ctx.res, url);
  };

  const billingTeam = (t) => ({ id: t.id, name: t.name, plan: t.plan, seats: t.seats, stripe_customer_id: t.customer_id || null });

  // A plan or seats mistake is shown on the settings page, next to the form.
  router.post(
    '/hub/billing/checkout',
    (ctx) => onSettings(ctx, () => {
      const { team } = ctx.member;
      const seats = Number(ctx.form.seats);
      if (!Number.isInteger(seats) || seats < 1 || seats > 1000) throw new HttpError(400, 'bad_request', 'Seats must be a whole number from 1 to 1000.');
      if (seats < teams.seatsUsed(team.id)) throw new HttpError(400, 'bad_request', `The team already has ${teams.seatsUsed(team.id)} members. Buy at least that many seats.`);
      const interval = ctx.form.interval === 'year' ? 'year' : 'month';
      // Team unless the form asks for Governance (the reports plan, docs/provenance.md section 7).
      const plan = ctx.form.plan === 'governance' ? 'governance' : 'team';
      const back = `${config.origin}/hub/teams/${team.id}/settings`;
      return billingCall(ctx, (b) =>
        b.createCheckout({
          team: billingTeam(team),
          user: { id: ctx.session.user.id, login: ctx.session.user.login },
          seats,
          interval,
          plan,
          successUrl: `${back}?billing=success#billing`,
          cancelUrl: `${back}?billing=cancel#billing`,
        }),
      );
    }),
    { ...FORM, team: 'form', owner: true },
  );

  router.post(
    '/hub/billing/portal',
    (ctx) => onSettings(ctx, () => {
      const { team } = ctx.member;
      return billingCall(ctx, (b) => b.createPortal({ team: billingTeam(team), returnUrl: `${config.origin}/hub/teams/${team.id}/settings#billing` }));
    }),
    { ...FORM, team: 'form', owner: true },
  );
}
