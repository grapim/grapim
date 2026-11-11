// The hub: one node:http server. createHub() wires the modules together and
// runs every request through the same guards before its route:
//
//   security headers -> global rate limit -> route match -> session ->
//   (bearer token) -> CSRF (Origin + per-session token) -> team membership
//
// A team route answers 404 to anyone who is not a member, exactly as for a
// team that does not exist, so ids cannot be probed.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Auth } from './auth.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { clientIp, HttpError, notFound, parseCookies, readForm, securityHeaders, sendHtml, sendJson } from './http.js';
import { Ingest } from './ingest.js';
import { loadBilling, makeLimits } from './plans.js';
import { LIMITS, RateLimiter } from './ratelimit.js';
import { TeamRead } from './read.js';
import { reportRoutes, Reports } from './reports/index.js';
import { Router } from './router.js';
import { randomId, same } from './secure.js';
import { Teams } from './teams.js';
import { createWorkspaceMount } from './workspace-mount.js';
import { createComputePool } from './compute-pool.js';
import { createPlatform } from './platform/index.js';
import { createGitHubApp } from './github/index.js';
import { createWorkspaceStorage, defaultStorageUrl, loadStorage } from './workspace-storage.js';
import { Workspaces } from './workspaces.js';
import { errorPage } from './pages/layout.js';
import { apiRoutes } from './routes-api.js';
import { pageRoutes } from './routes-pages.js';

const PAGES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pages');

const defaultLog = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

// options: { env | config, fetch, now, billing (object, or null for off; omitted: load billing.js), log,
//   storage (a storage backend for workspace files, or null for none; omitted: HUB_STORAGE_URL), uiDir,
//   compute (options for the workspace compute pool: { size, budgetMs, perTeam }) }
export async function createHub(options = {}) {
  const config = options.config ?? loadConfig(options.env ?? process.env);
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const log = options.log ?? defaultLog;
  const db = openDb(config.dataDir);

  const billingMod = options.billing !== undefined ? options.billing : await loadBilling({ env: options.env ?? process.env, fetch: fetchImpl, log });
  const billing = config.billingEnabled || options.billing ? billingMod : null;
  const limits = makeLimits(billingMod, now);

  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const hub = {
    config,
    db,
    now,
    log,
    billing,
    limits,
    bus,
    auth: new Auth({ db, config, fetch: fetchImpl, now }),
    teams: new Teams({ db, now, limits }),
    read: new TeamRead({ db, now, limits }),
    reports: new Reports({ db, now, limits }), // docs/provenance.md section 7
    rate: new RateLimiter({ now }),
    streams: new Map(), // user id -> open SSE connections
  };
  hub.workspaces = new Workspaces({ db, now, limits, dataDir: config.dataDir });
  hub.ingest = new Ingest({ db, now, limits, storageBytes: config.teamStorageBytes, onSync: (teamId, repoId) => bus.emit(`sync:${teamId}:${repoId}`) });
  // Workspace diffs, blame and replays run in worker threads, a fair share
  // per team, never on this event loop (security review of workspaces, M7).
  hub.compute = createComputePool({ log, ...(options.compute ?? {}) });

  const statics = {
    '/hub/static/hub.css': ['text/css; charset=utf-8', fs.readFileSync(path.join(PAGES, 'hub.css'))],
    '/hub/static/hub.js': ['text/javascript; charset=utf-8', fs.readFileSync(path.join(PAGES, 'hub.js'))],
  };

  // Cloud workspaces at /w/<team>/<name>/, and their files in storage.
  const env = options.env ?? process.env;
  hub.mount = createWorkspaceMount(hub, options.uiDir ? { uiDir: options.uiDir } : {});
  const storageUrl = String(env.HUB_STORAGE_URL ?? '').trim() || defaultStorageUrl(config.dataDir);
  const loaded = await loadStorage({ url: storageUrl, env, log, storage: options.storage });
  if (loaded) log(`workspace storage: ${storageUrl.startsWith('file:') ? 'the local folder' : storageUrl.split('?')[0].replace(/\/\/[^@/]*@/, '//')}${options.storage ? ' (given)' : ''}`);
  hub.restored = hub.mount.boot(loaded ? createWorkspaceStorage({ ...loaded, log, now }) : null);

  const router = new Router();
  pageRoutes(router, hub);
  apiRoutes(router, hub);
  reportRoutes(router, hub);
  // Grapim for platforms (docs/platform.md): /v1 has its own router; its hub pages join this one.
  hub.platform = createPlatform(hub, { env, fetch: fetchImpl, ...(options.platform ?? {}) });
  hub.platform.pageRoutes(router);
  // The GitHub App (docs/provenance.md section 6): webhooks, linking, PR comments and checks.
  hub.github = createGitHubApp(hub, { env, fetch: fetchImpl, ...(options.github ?? {}) });
  hub.github.routes(router);

  const wantsJson = (p) => p.startsWith('/hub/api/') || p.startsWith('/hub/stripe/');

  function fail(ctx, err) {
    const { res } = ctx;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const known = err instanceof HttpError;
    if (!known) log(`error ${ctx.routeName}: ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
    const status = known ? err.status : 500;
    const code = known ? err.code : 'internal';
    const message = known ? err.message : 'Something went wrong on the hub.';
    const headers = status === 429 && err.extra?.retryAfter ? { 'Retry-After': String(err.extra.retryAfter) } : {};
    if (status === 405 && err.extra?.allow) headers.Allow = err.extra.allow;
    if (ctx.json) sendJson(res, status, { error: { code, message, ...(ctx.requestId ? { request_id: ctx.requestId } : {}) }, ...(err.extra?.body ?? {}) }, headers);
    else sendHtml(res, status, errorPage({ status, message, user: ctx.session?.user, csrf: ctx.session?.csrf }), headers);
  }

  function limit(ctx, bucket, key) {
    const [n, windowMs] = LIMITS[bucket];
    const k = `${bucket}:${key}`;
    if (!hub.rate.hit(k, n, windowMs)) {
      throw new HttpError(429, 'rate_limited', 'Too many requests. Wait a minute and try again.', { retryAfter: hub.rate.retryAfter(k) });
    }
  }
  hub.limit = limit;

  // Origin check plus the session's CSRF token, for every state-changing
  // browser route. Returns the parsed form.
  async function csrf(ctx) {
    const { req } = ctx;
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'forbidden', 'Cross-site request refused.');
    let origin = req.headers.origin;
    if (!origin || origin === 'null') {
      try {
        origin = req.headers.referer ? new URL(req.headers.referer).origin : null;
      } catch {
        origin = null;
      }
    }
    if (origin !== config.origin) throw new HttpError(403, 'forbidden', 'This request did not come from the hub. Reload the page and try again.');
    const form = await readForm(req);
    if (!ctx.session || !same(form._csrf, ctx.session.csrf)) {
      throw new HttpError(403, 'forbidden', 'This form expired. Reload the page and try again.');
    }
    return form;
  }

  async function handle(req, res) {
    const started = Date.now();
    securityHeaders(res, config);
    let pathname;
    const ctx = { req, res, json: false, routeName: '-' };
    try {
      const url = new URL(req.url, config.origin);
      pathname = url.pathname;
      ctx.url = url;
      // /v1: the platform API. JSON errors with a request_id, and a Request-Id header on every response.
      const v1 = pathname === '/v1' || pathname.startsWith('/v1/');
      if (v1) {
        ctx.requestId = `req_${randomId(12)}`;
        res.setHeader('Request-Id', ctx.requestId);
      }
      ctx.json = v1 || wantsJson(pathname);
      ctx.ip = clientIp(req, config.trustProxy);
      // Platform keys have their own token buckets; per address, /v1 gets a wider limit.
      // So do agents calling a workspace with a gws_ token: a platform's
      // sandboxes share a few egress addresses (with other platforms' too),
      // and each valid token has its own limit in the mount. Bad tokens are
      // still counted per address there (syncIp).
      const agentCall = req.url.startsWith('/w/') && /^Bearer\s+gws_/i.test(String(req.headers.authorization || ''));
      limit(ctx, v1 || agentCall ? 'platformIp' : 'global', ctx.ip);

      // A cloud workspace: decided on the raw target, never on a normalised
      // one, so "/w/a/b/fs/../x" reaches the engine's path check as written.
      if (req.url.startsWith('/w/')) {
        ctx.cookies = parseCookies(req.headers.cookie);
        await hub.mount.handle(ctx, req.url);
        return;
      }

      if (statics[pathname] && (req.method === 'GET' || req.method === 'HEAD')) {
        const [type, body] = statics[pathname];
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'public, max-age=300' });
        res.end(body);
        ctx.routeName = 'static';
        return;
      }

      const m = (v1 ? hub.platform.router : router).match(req.method, pathname);
      if (!m) throw notFound();
      if (m.allowed) throw new HttpError(405, 'method_not_allowed', 'Method not allowed.', { allow: [...new Set(m.allowed)].join(', ') });
      const { route, params } = m;
      ctx.routeName = `${route.method} ${route.pattern}`;
      for (const k of Object.keys(params)) {
        try {
          params[k] = decodeURIComponent(params[k]);
        } catch {
          throw new HttpError(400, 'bad_request', 'Malformed URL.');
        }
      }
      ctx.params = params;
      const o = route.opts;
      if (o.rate) limit(ctx, o.rate, ctx.ip);

      ctx.cookies = parseCookies(req.headers.cookie);
      ctx.session = hub.auth.load(ctx.cookies);

      // Machine tokens may read a team's repos through the API, nothing else.
      const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''))?.[1];
      if (o.token && bearer) {
        limit(ctx, 'syncIp', ctx.ip);
        ctx.machine = hub.teams.authenticate(bearer);
        if (!ctx.machine) throw new HttpError(401, 'unauthorized', 'Unknown or revoked machine token.');
      }

      if (o.auth === 'session' && !ctx.session && !ctx.machine) {
        if (ctx.json) throw new HttpError(401, 'unauthorized', 'Sign in first.');
        res.writeHead(303, { Location: `/hub/login?next=${encodeURIComponent(pathname)}`, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      if (o.auth === 'token' && !ctx.machine) throw new HttpError(401, 'unauthorized', 'Send Authorization: Bearer <machine token>.');

      if (o.csrf) {
        ctx.form = await csrf(ctx);
        limit(ctx, 'form', ctx.session.user.id);
      }

      if (o.team) {
        const teamId = o.team === 'form' ? ctx.form?.team : params.team;
        if (ctx.session) {
          const mem = hub.teams.membership(teamId, ctx.session.user.id);
          if (!mem) throw notFound();
          ctx.member = { team: mem.team, role: mem.role, userId: ctx.session.user.id };
        } else if (ctx.machine && ctx.machine.team.id === teamId) {
          ctx.member = { team: ctx.machine.team, role: 'member', userId: ctx.machine.token.user_id, via: 'token' };
        } else {
          throw notFound();
        }
        if (o.owner && ctx.member.role !== 'owner') throw new HttpError(403, 'forbidden', 'Only a team owner can do that.');
      }
      if (o.workspace) {
        ctx.workspace = hub.workspaces.byId(ctx.member.team.id, params.ws);
        if (!ctx.workspace) throw notFound();
      }
      if (o.repo) {
        ctx.repo = hub.read.repo(ctx.member.team, params.repo);
        if (!ctx.repo) throw notFound();
        // Repo reads replay and diff synced content: bounded per request
        // (read.js) and per person here, so no one can keep the process busy.
        limit(ctx, 'read', ctx.member.userId);
      }

      await route.handler(ctx);
    } catch (err) {
      fail(ctx, err);
    } finally {
      // Only the route pattern is logged: never a query string, a path
      // parameter (invite tokens live in one), a header or a body.
      if (ctx.routeName !== 'static') log(`${ctx.routeName === '-' ? req.method : ctx.routeName} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 65_000;

  const sweep = setInterval(() => {
    try {
      hub.auth.sweep();
      hub.rate.sweep();
    } catch {}
  }, 60 * 60 * 1000);
  sweep.unref();

  hub.server = server;
  hub.router = router; // read by the route-enumerating isolation tests
  hub.handle = handle;
  hub.listen = (port = config.port, host = config.host) =>
    new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
  let closing = null;
  hub.close = () =>
    (closing ??= new Promise((resolve) => {
      clearInterval(sweep);
      hub.platform.close();
      hub.github.close();
      bus.emit('close');
      server.closeAllConnections?.();
      server.close(async () => {
        try {
          await hub.restored;
          await hub.mount.closeAll();
          await hub.compute.close();
        } catch {}
        try {
          db.close();
        } catch {}
        resolve();
      });
    }));
  return hub;
}
