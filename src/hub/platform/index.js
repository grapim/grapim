// Grapim for platforms (docs/platform.md): the /v1 API, platform keys, embed
// sessions, webhooks and metering, wired into the hub.
//
// createPlatform(hub, options) is called by createHub. It adds:
// - hub.platform.router: the /v1 routes (server.js sends /v1 here);
// - hub page routes under /hub/teams/:team/platform and /hub/embed/:token;
// - the hooks the workspace mount calls for platform workspaces
//   (onWorkspaceRequest, embeds.principal/authorize/headers);
// - timers: the webhook worker, the metering flush, the daily storage sample
//   and Stripe meter report. All unref'd and stopped by close().
//
// options (tests): { resolve(host) -> [{ address, family }], transport(target,
// { headers, body }) -> { status }, worker: false (no background delivery),
// webhooks: { timeoutMs, perPlatform, maxInFlight }, env, fetch }.

import { createBilling } from '../billing.js';
import { HttpError as EngineError } from '../../server/http.js';
import { usageOf } from '../ingest.js';
import { HttpError, redirect, sendHtml } from '../http.js';
import { createApi } from './api.js';
import { createEmbeds } from './embeds.js';
import { createEvents } from './events.js';
import { KeyLimiter, PlatformKeys } from './keys.js';
import { createMetering } from './metering.js';
import { platformPage, usagePage, webhooksPage } from './pages.js';
import { migratePlatform, PLATFORM_SCHEMA } from './schema.js';
import { defaultResolve } from './ssrf.js';
import { cleanOrigin, DAY_MS, dayOf, sealer as makeSealer } from './util.js';
import { createWebhooks } from './webhooks.js';

const WORKER_MS = 2000;
const HOURLY = 60 * 60 * 1000;
const MIB = 1024 * 1024;
const EXPIRE_BATCH = 500; // test workspaces deleted per run of the hourly job

export function createPlatform(hub, options = {}) {
  const { db, now, config, log } = hub;
  db.exec(PLATFORM_SCHEMA);
  migratePlatform(db);
  const env = options.env ?? process.env;
  const sealer = makeSealer(config.secret);
  const keys = new PlatformKeys({ db, now, config });
  const limiter = new KeyLimiter({ now });
  const webhooks = createWebhooks({ hub, sealer, resolve: options.resolve ?? defaultResolve, transport: options.transport ?? null, log, ...(options.webhooks ?? {}) });
  const billing = createBilling({ env, fetch: options.fetch });
  const metering = createMetering({ hub, env, log, reportMeterEvent: billing.reportMeterEvent });
  const events = createEvents({ hub, metering, webhooks, log });
  const embeds = createEmbeds({ hub, keys });
  const api = createApi({ hub, keys, limiter, sealer, metering, events, embeds, webhooks });

  const timers = [];
  if (options.worker !== false) {
    timers.push(setInterval(() => webhooks.pump(), WORKER_MS));
    let sampled = null;
    const daily = async () => {
      try {
        const day = dayOf(now());
        if (sampled !== day) {
          metering.sampleStorage(day);
          webhooks.sweep();
          sampled = day;
        }
        await expireTestWorkspaces();
        await metering.reportMeters();
        db.prepare('DELETE FROM platform_idempotency WHERE created_at <= ?').run(now() - 24 * HOURLY);
        db.prepare('DELETE FROM embed_sessions WHERE expires_at < ? AND (cookie_expires_at IS NULL OR cookie_expires_at < ?)').run(now() - 24 * HOURLY, now() - 24 * HOURLY);
      } catch (err) {
        log(`platform daily job: ${err?.message ?? err}`);
      }
    };
    timers.push(setInterval(daily, HOURLY));
    timers.push(setTimeout(daily, 5000));
  }
  for (const t of timers) t.unref();

  const isPlatform = (teamId) => db.prepare('SELECT kind FROM teams WHERE id = ?').get(teamId)?.kind === 'platform';
  const modeOf = (ws) => (ws.mode === 'test' ? 'test' : 'live');
  const caps = metering.prices.testCaps;

  // ---- test mode (review M10) ----

  // Test workspaces are deleted (softly, like DELETE /v1/workspaces/:id)
  // 7 days after they were created, with a workspace.deleted webhook whose
  // reason is "test_expired". Runs with the hourly job.
  async function expireTestWorkspaces() {
    const rows = db
      .prepare(
        `SELECT w.* FROM workspaces w JOIN teams t ON t.id = w.team_id
         WHERE t.kind = 'platform' AND w.mode = 'test' AND w.deleted_at IS NULL AND w.created_at <= ? ORDER BY w.created_at LIMIT ?`,
      )
      .all(now() - caps.workspaceDays * DAY_MS, EXPIRE_BATCH);
    let n = 0;
    for (const ws of rows) {
      try {
        const closed = hub.mount.close(ws.id); // before the move, as deleteWorkspace does
        hub.workspaces.remove(ws.team_id, ws.id);
        await closed;
      } catch (err) {
        log(`test workspace ${ws.id} could not expire: ${err?.message ?? err}`);
        continue;
      }
      n++;
      const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(ws.team_id);
      webhooks.emit(team, 'test', 'workspace.deleted', ws, { workspace: { id: ws.id, external_id: ws.external_id ?? null, name: ws.name }, reason: 'test_expired' });
    }
    return n;
  }

  // The limits the mount's storage admission applies to a platform workspace
  // (review M11), or null for any other team's.
  function storageLimits(ws) {
    if (!isPlatform(ws.team_id)) return null;
    const mode = modeOf(ws);
    return {
      team: config.platformStorageBytes ?? 20480 * MIB,
      workspace: keys.settings(ws.team_id, mode).workspace_storage_mb * MIB,
      test: mode === 'test' ? caps.storageMb * MIB : null,
    };
  }

  // The usage page's storage table (review M11): the platform's quota and
  // what it uses, test mode's share, and the 100 largest live workspaces
  // against their own limit.
  function storageUsage(teamId) {
    const limit = { live: keys.settings(teamId, 'live').workspace_storage_mb * MIB, test: keys.settings(teamId, 'test').workspace_storage_mb * MIB };
    const workspaces = db
      .prepare("SELECT id, name, external_id, COALESCE(mode, 'live') AS mode, bytes, stored_bytes FROM workspaces WHERE team_id = ? AND deleted_at IS NULL ORDER BY bytes + stored_bytes DESC, id LIMIT 100")
      .all(teamId)
      .map((w) => ({ ...w, used: w.bytes + w.stored_bytes, limit: limit[w.mode] }));
    const t = db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN mode = 'test' THEN bytes + stored_bytes ELSE 0 END), 0) AS test FROM workspaces WHERE team_id = ? AND deleted_at IS NULL")
      .get(teamId);
    return { quota: config.platformStorageBytes ?? 20480 * MIB, used: usageOf(db, teamId), count: t.n, testUsed: t.test, testCap: caps.storageMb * MIB, limit, workspaces };
  }

  // Each MCP write tool of a request counts toward test mode's daily write
  // cap, so one batch cannot carry many writes past it (review L2). Called
  // for every write tool before any of the request's tools runs.
  const toolWrites = new WeakMap(); // req -> write tools seen
  function countToolWrite(req, ws) {
    if (ws.mode !== 'test' || !isPlatform(ws.team_id)) return;
    const n = (toolWrites.get(req) ?? 0) + 1;
    toolWrites.set(req, n);
    if (metering.testWritesToday(ws.team_id) + n > caps.writesPerDay) {
      const e = new EngineError('test_mode_limit', `Test mode allows ${caps.writesPerDay} writes a day per platform, and this request would pass it. Use a live key, or wait until 00:00 UTC.`);
      e.status = 429;
      throw e;
    }
  }

  // ---- hooks for the workspace mount ----

  // Called for every /w/ request once the caller is known. Returns true when
  // it answered the request itself (the embedded desk's page).
  function onWorkspaceRequest(ctx, who, where, { write, engine, uiDir, csp }) {
    const ws = who.ws;
    if (!isPlatform(ws.team_id)) return false;
    metering.bump(ws, { apiCalls: 1 });
    if (write) metering.checkTestWrite(ws);
    const { req, res } = ctx;
    if (who.kind === 'embed' && (req.method === 'GET' || req.method === 'HEAD') && (where.rest === '/' || where.rest === '/index.html') && !where.query.includes('token=')) {
      embeds.serveIndex(ctx, who, uiDir, csp);
      return true;
    }
    if (write) res.once('close', () => events.afterRequest(ws, engine, { method: req.method, rest: where.rest, status: res.statusCode }));
    return false;
  }

  // Workspaces created or deleted from the hub pages of a platform team.
  function workspaceCreated(ws) {
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(ws.team_id);
    if (team?.kind !== 'platform') return;
    events.start(ws);
    webhooks.emit(team, ws.mode === 'test' ? 'test' : 'live', 'workspace.created', ws, { workspace: api.wsJson(ws) });
  }
  function workspaceDeleted(ws) {
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(ws.team_id);
    if (team?.kind !== 'platform') return;
    webhooks.emit(team, ws.mode === 'test' ? 'test' : 'live', 'workspace.deleted', ws, { workspace: { id: ws.id, external_id: ws.external_id ?? null, name: ws.name }, reason: 'deleted' });
  }

  // ---- hub pages ----

  function pageRoutes(router) {
    const OWNER = { auth: 'session', team: true, owner: true };
    const OWNER_FORM = { auth: 'session', csrf: true, team: true, owner: true };
    const html = (ctx, body, status = 200) => sendHtml(ctx.res, status, body);

    function renderPlatform(ctx, extra = {}, status = 200) {
      const team = hub.teams.get(ctx.member.team.id);
      const on = team.kind === 'platform';
      html(
        ctx,
        platformPage({
          user: ctx.session.user,
          csrf: ctx.session.csrf,
          team,
          isPlatform: on,
          mayEnable: keys.mayEnable(ctx.session.user),
          keys: on ? keys.list(team.id) : [],
          settings: on ? { live: keys.settings(team.id, 'live'), test: keys.settings(team.id, 'test') } : undefined,
          caps,
          disabled: on ? webhooks.allEndpoints(team.id).filter((e) => !e.enabled) : [],
          origin: config.origin,
          ...extra,
        }),
        status,
      );
    }

    async function onPage(ctx, fn) {
      try {
        await fn();
      } catch (err) {
        if (err instanceof HttpError && err.status < 500 && err.status !== 404) {
          renderPlatform(ctx, { error: err.message }, err.status);
          return;
        }
        throw err;
      }
    }

    const needPlatform = (ctx) => {
      if (!isPlatform(ctx.member.team.id)) throw new HttpError(409, 'conflict', 'This team is not a platform yet.');
    };

    router.get('/hub/teams/:team/platform', (ctx) => renderPlatform(ctx), OWNER);

    router.post(
      '/hub/teams/:team/platform',
      (ctx) =>
        onPage(ctx, () => {
          keys.enable(ctx.member.team, ctx.session.user);
          redirect(ctx.res, `/hub/teams/${ctx.member.team.id}/platform`);
        }),
      OWNER_FORM,
    );

    router.post(
      '/hub/teams/:team/platform/keys',
      (ctx) =>
        onPage(ctx, () => {
          needPlatform(ctx);
          const k = keys.create(ctx.member.team.id, ctx.member, ctx.form.name, ctx.form.mode);
          renderPlatform(ctx, { revealed: { value: k.key, name: k.name, mode: k.mode } });
        }),
      OWNER_FORM,
    );

    router.post(
      '/hub/teams/:team/platform/keys/:key/revoke',
      (ctx) =>
        onPage(ctx, () => {
          needPlatform(ctx);
          keys.revoke(ctx.member.team.id, ctx.params.key);
          redirect(ctx.res, `/hub/teams/${ctx.member.team.id}/platform#keys`);
        }),
      OWNER_FORM,
    );

    router.post(
      '/hub/teams/:team/platform/origins',
      (ctx) =>
        onPage(ctx, () => {
          needPlatform(ctx);
          const mode = ctx.form.mode === 'test' ? 'test' : 'live';
          const lines = String(ctx.form.origins ?? '')
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (lines.length > 20) throw new HttpError(400, 'bad_request', 'At most 20 origins.');
          const clean = [];
          for (const l of lines) {
            const c = cleanOrigin(l);
            if (!c) throw new HttpError(400, 'bad_request', `${l.slice(0, 100)} is not an origin like https://app.example.com (https, no path).`);
            if (!clean.includes(c)) clean.push(c);
          }
          keys.setOrigins(ctx.member.team.id, mode, clean);
          renderPlatform(ctx, { notice: `Saved the ${mode} embedding origins.` });
        }),
      OWNER_FORM,
    );

    router.get(
      '/hub/teams/:team/platform/webhooks',
      (ctx) => {
        const team = hub.teams.get(ctx.member.team.id);
        const on = team.kind === 'platform';
        html(
          ctx,
          webhooksPage({ user: ctx.session.user, csrf: ctx.session.csrf, team, isPlatform: on, endpoints: on ? webhooks.allEndpoints(team.id) : [], deliveries: on ? webhooks.log(team.id) : [], now: now() }),
        );
      },
      OWNER,
    );

    router.get(
      '/hub/teams/:team/platform/usage',
      (ctx) => {
        const team = hub.teams.get(ctx.member.team.id);
        const on = team.kind === 'platform';
        html(
          ctx,
          usagePage({
            user: ctx.session.user,
            csrf: ctx.session.csrf,
            team,
            isPlatform: on,
            live: on ? metering.estimate(team.id, 'live') : null,
            test: on ? metering.estimate(team.id, 'test') : null,
            prices: metering.prices,
            storage: on ? storageUsage(team.id) : null,
          }),
        );
      },
      OWNER,
    );

    // The embed link: no session, single use (embeds.js).
    router.get('/hub/embed/:token', (ctx) => embeds.redeem(ctx), { rate: 'embed' });
  }

  return {
    router: api.router,
    routes: api.routes,
    openapi: api.openapi,
    keys,
    limiter,
    webhooks,
    metering,
    events,
    embeds,
    pageRoutes,
    onWorkspaceRequest,
    workspaceCreated,
    workspaceDeleted,
    storageLimits,
    countToolWrite,
    expireTestWorkspaces,
    storageUsage,
    close() {
      for (const t of timers) clearInterval(t);
      events.close();
      metering.close();
    },
  };
}
