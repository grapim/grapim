// JSON routes: who am I, teams and their settings, the team read API in the
// docs/api.md shapes, the SSE stream, sync ingest and the Stripe webhook.
//
// The hub is read-only for code in v0: undo, branch and review answer 405
// with a pointer to `grapim serve` on the machine.

import { HttpError, readBody, readJson, sendJson } from './http.js';
import { MAX_BATCH, parseBatch } from './ingest.js';

const TEAM_API = { auth: 'session', team: true };
const REPO_API = { auth: 'session', team: true, repo: true, token: true };
export const MAX_STREAMS_PER_USER = 20; // a person's sessions and machine tokens together
export const MAX_STREAMS = 1000; // the whole hub
export const MAX_SYNCS = 8; // sync batches being parsed and written at once, hub wide
export const MAX_SYNCS_PER_TEAM = 2;

const fin = (n) => (Number.isFinite(n) ? n : null); // JSON has no Infinity: unlimited is null

export function apiRoutes(router, hub) {
  const { teams, read, limits } = hub;
  const syncing = new Map(); // '*' and 'team:<id>' -> batches in flight
  const json = (ctx, body, status = 200) => sendJson(ctx.res, status, body);
  const actor = (ctx) => ({ role: ctx.member.role, userId: ctx.member.userId });
  const teamJson = (t, role) => {
    const l = limits(t);
    return {
      id: t.id,
      name: t.name,
      role,
      plan: t.plan,
      limits: { seats: fin(l.seats), historyDays: l.historyDays, repos: fin(l.repos) },
    };
  };

  router.get(
    '/hub/api/me',
    (ctx) => json(ctx, { user: ctx.session.user, csrf: ctx.session.csrf, teams: teams.forUser(ctx.session.user.id) }),
    { auth: 'session' },
  );
  router.get('/hub/api/teams', (ctx) => json(ctx, teams.forUser(ctx.session.user.id)), { auth: 'session' });
  router.get('/hub/api/teams/:team', (ctx) => json(ctx, teamJson(ctx.member.team, ctx.member.role)), TEAM_API);
  router.get('/hub/api/teams/:team/repos', (ctx) => json(ctx, read.repos(ctx.member.team)), { ...TEAM_API, token: true });
  router.get('/hub/api/teams/:team/members', (ctx) => json(ctx, teams.members(ctx.member.team.id)), TEAM_API);
  router.get('/hub/api/teams/:team/invites', (ctx) => json(ctx, teams.invites(ctx.member.team.id)), { ...TEAM_API, owner: true });
  router.get(
    '/hub/api/teams/:team/tokens',
    (ctx) => json(ctx, teams.tokens(ctx.member.team.id, actor(ctx)).map(({ user_id, ...t }) => t)),
    TEAM_API,
  );
  router.get(
    '/hub/api/teams/:team/billing',
    (ctx) => {
      const t = teams.get(ctx.member.team.id);
      const l = limits(t);
      json(ctx, {
        enabled: !!hub.billing,
        plan: t.plan,
        status: t.plan_status ?? null,
        seats: t.seats ?? null,
        seats_used: teams.seatsUsed(t.id),
        period_end: t.period_end ?? null,
        limits: { seats: fin(l.seats), historyDays: l.historyDays, repos: fin(l.repos) },
        has_customer: !!t.customer_id,
      });
    },
    TEAM_API,
  );

  // ---- The team read API (docs/api.md shapes) ----

  const base = '/hub/api/teams/:team/repos/:repo';
  router.get(`${base}/overview`, (ctx) => json(ctx, read.overview(ctx.member.team, ctx.repo)), REPO_API);
  router.get(`${base}/runs`, (ctx) => json(ctx, read.runs(ctx.member.team, ctx.repo)), REPO_API);
  router.get(
    `${base}/runs/:run`,
    (ctx) => json(ctx, read.run(ctx.member.team, ctx.repo, ctx.params.run, ctx.url.searchParams.get('machine'))),
    REPO_API,
  );
  router.get(
    `${base}/events`,
    (ctx) => json(ctx, read.events(ctx.member.team, ctx.repo, { after: ctx.url.searchParams.get('after'), limit: ctx.url.searchParams.get('limit') })),
    REPO_API,
  );
  for (const act of ['undo', 'branch', 'review']) {
    router.post(
      `${base}/runs/:run/${act}`,
      () => {
        throw new HttpError(405, 'read_only', `The hub is read-only for code in v0. Run ${act} on the machine that made the run, with grapim ${act === 'undo' ? 'undo' : 'serve'}.`, { allow: 'GET' });
      },
      REPO_API,
    );
  }

  // Server-sent events: a tick whenever a sync adds rows to this repo, a
  // ping every 15 s. Membership is re-checked on every ping.
  router.get(
    `${base}/stream`,
    (ctx) => {
      const { team } = ctx.member;
      const repo = ctx.repo;
      // Counted per person (a member's machine tokens share their cap) and hub wide.
      const who = `u${ctx.member.userId}`;
      const open = hub.streams.get(who) ?? 0;
      const total = hub.streams.get('*') ?? 0;
      if (open >= MAX_STREAMS_PER_USER || total >= MAX_STREAMS) throw new HttpError(429, 'rate_limited', 'Too many open streams.', { retryAfter: 15 });
      hub.streams.set(who, open + 1);
      hub.streams.set('*', total + 1);
      const { res, req } = ctx;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const tick = () => res.write(`event: tick\ndata: ${JSON.stringify({ last_event_id: read.lastEventId(team, repo) })}\n\n`);
      tick();
      const topic = `sync:${team.id}:${repo.id}`;
      const still = () =>
        ctx.session ? !!teams.membership(team.id, ctx.session.user.id) && !!hub.auth.load(ctx.cookies) : !!teams.authenticate(String(req.headers.authorization).split(/\s+/)[1]);
      const ping = setInterval(() => {
        if (!still()) return done();
        res.write(': ping\n\n');
      }, 15_000);
      ping.unref();
      let closed = false;
      const done = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        hub.bus.off(topic, tick);
        hub.bus.off('close', done);
        hub.streams.set(who, Math.max(0, (hub.streams.get(who) ?? 1) - 1));
        hub.streams.set('*', Math.max(0, (hub.streams.get('*') ?? 1) - 1));
        res.end();
      };
      hub.bus.on(topic, tick);
      hub.bus.on('close', done);
      req.on('close', done);
    },
    REPO_API,
  );

  // ---- Sync ingest ----

  router.post(
    '/hub/api/sync',
    async (ctx) => {
      hub.limit(ctx, 'sync', ctx.machine.token.id);
      // A batch costs up to ~10x its 8 MB body in memory while it is parsed:
      // cap how many are in flight, so a burst cannot exhaust the process.
      const teamKey = `team:${ctx.machine.team.id}`;
      const all = syncing.get('*') ?? 0;
      const mine = syncing.get(teamKey) ?? 0;
      if (all >= MAX_SYNCS || mine >= MAX_SYNCS_PER_TEAM) {
        ctx.req.resume();
        throw new HttpError(429, 'busy', 'The hub is busy with other syncs. Retry in a few seconds.', { retryAfter: 2 });
      }
      syncing.set('*', all + 1);
      syncing.set(teamKey, mine + 1);
      try {
        const batch = parseBatch(await readJson(ctx.req, MAX_BATCH));
        const out = hub.ingest.apply(ctx.machine, batch);
        json(ctx, out.body, out.status);
      } finally {
        syncing.set('*', syncing.get('*') - 1);
        if (syncing.get(teamKey) <= 1) syncing.delete(teamKey);
        else syncing.set(teamKey, syncing.get(teamKey) - 1);
      }
    },
    { auth: 'token', token: true },
  );

  // ---- Stripe webhook (raw body, verified by the billing module) ----

  router.post(
    '/hub/stripe/webhook',
    async (ctx) => {
      if (!hub.billing) throw new HttpError(503, 'billing_unavailable', 'Billing is not set up on this hub.');
      const raw = await readBody(ctx.req, 1024 * 1024);
      let r;
      try {
        r = await hub.billing.handleWebhook(raw, ctx.req.headers['stripe-signature'], {
          setPlan: (teamId, fields, meta) => teams.setPlan(teamId, fields, meta),
          teamIdFor: (q) => teams.teamIdForBilling(q),
          now: hub.now(),
        });
      } catch (err) {
        const code = err?.code;
        if (code === 'bad_signature' || code === 'bad_payload' || code === 'bad_request') throw new HttpError(400, code, 'Webhook rejected.');
        if (code === 'not_configured') throw new HttpError(503, code, 'Billing is not set up on this hub.');
        throw err;
      }
      hub.log(`stripe webhook ${r?.type ?? '?'} handled=${!!r?.handled}`);
      json(ctx, { received: true, handled: !!r?.handled });
    },
    { rate: 'webhook' },
  );

}
