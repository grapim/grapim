// Browser routes: sign in, teams, settings, invites, tokens, billing, and the
// read-only repo and run views. Every POST here is CSRF checked (opts.csrf).

import { safeNext } from './auth.js';
import { HttpError, redirect, sendHtml } from './http.js';
import { invitePage, pickerPage, signInPage } from './pages/account.js';
import { repoPage, runPage } from './pages/repo.js';
import { reposPage, settingsPage } from './pages/team.js';
import { workspacePage, workspacesPage } from './pages/workspaces.js';

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
        github: role === 'owner' ? hub.github?.settingsSection(fresh, ctx.session.csrf) : null,
        ...extra,
      }),
      status,
    );
  }

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
    html(ctx, pickerPage({ user: ctx.session.user, csrf: ctx.session.csrf, teams: teams.forUser(ctx.session.user.id) }));
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
        redirect(ctx.res, `/hub/teams/${team.id}/settings`);
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        html(ctx, pickerPage({ user: ctx.session.user, csrf: ctx.session.csrf, teams: teams.forUser(ctx.session.user.id), error: err.message }), err.status);
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

  router.get(
    '/hub/teams/:team',
    (ctx) => {
      const { team } = ctx.member;
      html(ctx, reposPage({ user: ctx.session.user, csrf: ctx.session.csrf, team, repos: read.repos(team), origin: config.origin, limits: limits(team) }));
    },
    TEAM,
  );

  router.get(
    '/hub/teams/:team/settings',
    (ctx) => {
      const b = ctx.url.searchParams.get('billing');
      const notice = b === 'success' ? 'Thanks. The plan updates here as soon as Stripe confirms the payment.' : b === 'cancel' ? 'Checkout was cancelled. Nothing was charged.' : null;
      renderSettings(ctx, { notice });
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
        redirect(ctx.res, `/hub/teams/${ctx.member.team.id}/settings#invites`);
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
        redirect(ctx.res, `/hub/teams/${ctx.member.team.id}/settings#members`);
      }),
    TEAM_FORM,
  );

  router.post(
    '/hub/teams/:team/leave',
    (ctx) =>
      onSettings(ctx, () => {
        teams.leave(ctx.member.team.id, ctx.session.user.id);
        redirect(ctx.res, '/hub');
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
        redirect(ctx.res, `/hub/teams/${ctx.member.team.id}/settings#tokens`);
      }),
    TEAM_FORM,
  );

  // ---- Cloud workspaces (docs/workspaces.md section 1) ----

  const { workspaces } = hub;
  const wsActor = (ctx) => ({ role: ctx.member.role, userId: ctx.member.userId });

  function renderWorkspaces(ctx, extra = {}, status = 200) {
    const team = teams.get(ctx.member.team.id);
    html(ctx, workspacesPage({ user: ctx.session.user, csrf: ctx.session.csrf, team, workspaces: workspaces.live(team.id), limit: workspaces.limitOf(team), ...extra }), status);
  }

  function renderWorkspace(ctx, extra = {}, status = 200) {
    const ws = workspaces.byId(ctx.member.team.id, ctx.workspace.id) ?? ctx.workspace;
    html(
      ctx,
      workspacePage({ user: ctx.session.user, csrf: ctx.session.csrf, team: ctx.member.team, role: ctx.member.role, ws, tokens: workspaces.tokens(ws, wsActor(ctx)), origin: config.origin, ...extra }),
      status,
    );
  }

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
        const ws = workspaces.create(team, wsActor(ctx), ctx.form.name);
        await hub.mount.measure(ws).catch(() => {});
        hub.platform?.workspaceCreated(ws); // a platform's webhooks (docs/platform.md)
        redirect(ctx.res, `/hub/teams/${team.id}/workspaces/${ws.id}`);
      }),
    TEAM_FORM,
  );

  router.get('/hub/teams/:team/workspaces/:ws', (ctx) => renderWorkspace(ctx), WS);

  router.post(
    '/hub/teams/:team/workspaces/:ws/rename',
    (ctx) =>
      onPage(ctx, renderWorkspace, async () => {
        const ws = workspaces.rename(ctx.member.team.id, ctx.workspace.id, ctx.form.name);
        // The open engine serves the old address: close it, the next request opens the new one.
        await hub.mount.close(ws.id);
        redirect(ctx.res, `/hub/teams/${ctx.member.team.id}/workspaces/${ws.id}`);
      }),
    WS_FORM,
  );

  router.post(
    '/hub/teams/:team/workspaces/:ws/delete',
    (ctx) =>
      onPage(ctx, renderWorkspace, async () => {
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
      onPage(ctx, renderWorkspace, () => {
        const t = workspaces.createToken(ctx.workspace, wsActor(ctx), ctx.form.name, ctx.form.scope);
        renderWorkspace(ctx, { revealed: { value: t.token, name: t.name, scope: t.scope } });
      }),
    WS_FORM,
  );

  router.post(
    '/hub/teams/:team/workspaces/:ws/tokens/:wstoken/revoke',
    (ctx) =>
      onPage(ctx, renderWorkspace, () => {
        workspaces.revokeToken(ctx.workspace, wsActor(ctx), ctx.params.wstoken);
        redirect(ctx.res, `/hub/teams/${ctx.member.team.id}/workspaces/${ctx.workspace.id}#tokens`);
      }),
    WS_FORM,
  );

  // ---- Repo and run views (read-only) ----

  router.get(
    '/hub/teams/:team/repos/:repo',
    (ctx) => {
      const { team } = ctx.member;
      html(ctx, repoPage({ user: ctx.session.user, csrf: ctx.session.csrf, team, repo: ctx.repo, overview: read.overview(team, ctx.repo), runs: read.runs(team, ctx.repo) }));
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

  router.post(
    '/hub/billing/checkout',
    (ctx) => {
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
    },
    { ...FORM, team: 'form', owner: true },
  );

  router.post(
    '/hub/billing/portal',
    (ctx) => {
      const { team } = ctx.member;
      return billingCall(ctx, (b) => b.createPortal({ team: billingTeam(team), returnUrl: `${config.origin}/hub/teams/${team.id}/settings#billing` }));
    },
    { ...FORM, team: 'form', owner: true },
  );
}
