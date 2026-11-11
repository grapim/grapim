// /w/<team_id>/<workspace>/...: a cloud workspace, served by the same engine
// as `grapim serve` (src/server/engine.js) mounted at that base path. The
// review desk, /api, /fs and /mcp behave exactly as in docs/api.md; the hub
// only decides who the caller is and what they may do.
//
// Who may come in:
// - A browser with a hub session whose user is a member of the team. Its
//   writes must come from the hub's origin (Origin, Sec-Fetch-Site) and carry
//   the session's CSRF token in X-Grapim-Csrf, which the hub sends back on
//   every response here (only same-origin script can read it). Reads from
//   another site are refused, except a top-level navigation.
// - Authorization: Bearer gws_..., a token of this very workspace. A read
//   token gets 403 on every write and act route and on MCP write tools.
// - /dav (WebDAV, a network drive): only a workspace token, sent by the
//   desktop's own client as the Basic password; never a cookie, and never
//   over plain http except from this machine. A missing or wrong token gets
//   401 with a Basic challenge (davCaller below).
// Anyone else gets 404, the same as for a workspace that does not exist, so
// workspaces cannot be enumerated. A request with no credentials at all gets
// 401 (or the sign-in page for a navigation), whatever the URL names.
//
// Identity: a token's agents are http:<token-name>/<X-Grapim-Agent> (or
// http:<token-name> without the header), so one token cannot write as
// another's. A person's undo, review, branch and restore are human:<login>;
// their own /fs or MCP writes are http:@<login>[/<agent>] (token names cannot
// hold "@").

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { enforce, scopeOf } from '../scope.js';
import { createEngine, UI_DIR } from '../server/engine.js';
import { HttpError as EngineError, headerText, MAX_BODY } from '../server/http.js';
import { DAV_WRITES } from '../server/webdav.js';
import { usageOf } from './ingest.js';
import { HttpError, notFound } from './http.js';
import { MAX_STREAMS, MAX_STREAMS_PER_USER } from './routes-api.js';
import { same } from './secure.js';
import { applyTemplate, cleanTemplate } from './templates.js';
import { initRepo, NAME_RE, TEAM_ID_RE, WS_TOKEN_PREFIX } from './workspaces.js';

export const IDLE_MS = 10 * 60 * 1000; // an unused workspace engine is closed after this
export const MAX_ENGINES = 200; // open workspace engines (SQLite handles, pollers) at once
const MEASURE_MS = 1000; // folder sizes are re-measured at most this often per workspace
const MEASURE_MAX_MS = 60_000; // ...and at least this often: a big folder waits 10x its last walk
// Requests with a body (uploads up to 32 MB, MCP posts up to 40 MB) are held
// in memory whole: at most this many at once per caller and hub wide.
export const MAX_BODIES_PER_CALLER = 4;
export const MAX_BODIES = 24;
// Files in one workspace (outside .git). Empty files cost no quota but
// every measure walks them, and each one is an inode on the shared volume.
export const MAX_FILES = 100_000;
const STREAM_CHECK_MS = 15_000; // an open live stream re-checks its caller this often

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

function samePath(a, b) {
  const real = (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const fold = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
  return fold(real(a)) === fold(real(b));
}

// A refusal the engine answers in its own error shape ({ error: { code, message } }).
const refuse = (status, code, message, headers = {}) => {
  const e = new EngineError(code, message, headers);
  e.status = status;
  return e;
};

// The review desk's own CSP: the hub's, plus the inline theme script of
// ui/index.html by hash and inline style attributes (the desk uses them for
// sizes and colours; no script can run from a style attribute).
function deskCsp(uiDir) {
  let hashes = [];
  try {
    const index = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');
    // Browsers hash the script after the HTML parser turned CRLF and CR into LF.
    hashes = [...index.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${crypto.createHash('sha256').update(m[1].replace(/\r\n?/g, '\n')).digest('base64')}'`);
  } catch {}
  return [
    "default-src 'none'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://avatars.githubusercontent.com",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}

// API, file and MCP responses are data, never a page.
const DATA_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

// Splits /w/<team>/<name><rest>?<query> without normalising it.
function parse(raw) {
  const q = raw.indexOf('?');
  const p = q < 0 ? raw : raw.slice(0, q);
  const m = /^\/w\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
  if (!m || !TEAM_ID_RE.test(m[1]) || !NAME_RE.test(m[2])) return null;
  return { team: m[1], name: m[2], rest: m[3] ?? '', query: q < 0 ? '' : raw.slice(q) };
}

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

function kindOf(rest) {
  if (rest === '/mcp') return 'mcp';
  if (rest === '/fs' || rest.startsWith('/fs/')) return 'fs';
  if (rest === '/api' || rest.startsWith('/api/')) return 'api';
  if (rest === '/dav' || rest.startsWith('/dav/')) return 'dav';
  return 'asset';
}

// "Basic base64(user:password)" -> the password (the user name is ignored).
function basicPassword(header) {
  const b64 = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(String(header ?? ''))?.[1];
  if (!b64) return null;
  const pair = Buffer.from(b64, 'base64').toString('utf8');
  const i = pair.indexOf(':');
  return i < 0 ? null : pair.slice(i + 1);
}

const lastOf = (h) => String(h ?? '').split(',').map((s) => s.trim()).filter(Boolean).at(-1) ?? null;
const LOOPBACK_ADDR = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

export function createWorkspaceMount(
  hub,
  { uiDir = UI_DIR, idleMs = IDLE_MS, maxEngines = MAX_ENGINES, maxBodiesPerCaller = MAX_BODIES_PER_CALLER, maxBodies = MAX_BODIES, maxFiles = MAX_FILES, streamCheckMs = STREAM_CHECK_MS } = {},
) {
  const { config, workspaces, teams } = hub;
  const engines = new Map(); // workspace id -> { engine, base, ws, streams }
  const bodies = new Map(); // caller key (and '*') -> requests with a body in flight
  const fileCounts = new Map(); // workspace id -> files at the last measure
  const principals = new WeakMap(); // req -> who is calling
  const restoring = new Set(); // workspace ids being rebuilt from storage
  const pending = new Map(); // team id -> bytes admitted but not measured yet
  const pendingTest = new Map(); // team id -> of those, bytes admitted to its test-mode workspaces
  const measuring = new Map(); // workspace id -> timer
  const csp = deskCsp(uiDir);
  let storage = null;

  // ---- usage and quota ----

  // { bytes } of everything in the folder, { files } outside its .git.
  async function folderBytes(dir) {
    let n = 0;
    let files = 0;
    async function walk(abs, inGit) {
      let entries;
      try {
        entries = await fs.promises.readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const child = path.join(abs, e.name);
        if (e.isDirectory()) await walk(child, inGit || (abs === dir && e.name === '.git'));
        else if (e.isFile()) {
          if (!inGit) files++;
          try {
            n += (await fs.promises.stat(child)).size;
          } catch {}
        }
      }
    }
    await walk(dir, false);
    return { bytes: n, files };
  }

  const walkMs = new Map(); // workspace id -> how long its last measure took

  // Re-measures the workspace folder (files, .git and the ledger) and moves
  // the difference into team_usage.
  async function measure(ws) {
    const started = Date.now();
    const { bytes, files } = await folderBytes(workspaces.dirOf(ws));
    walkMs.set(ws.id, Date.now() - started);
    fileCounts.set(ws.id, files);
    const row = hub.db.prepare('SELECT bytes, team_id, deleted_at FROM workspaces WHERE id = ?').get(ws.id);
    // A deleted workspace's folder is in the trash and still counts until purged (v1).
    if (!row || row.deleted_at) return;
    const delta = bytes - row.bytes;
    usageOf(hub.db, row.team_id); // makes sure the team has a usage row
    hub.db.prepare('UPDATE workspaces SET bytes = ? WHERE id = ?').run(bytes, ws.id);
    if (delta) hub.db.prepare('UPDATE team_usage SET bytes = MAX(0, bytes + ?) WHERE team_id = ?').run(delta, row.team_id);
  }

  // Bytes admitted since the workspace was last measured; the measure that
  // follows a write counts them for real, so they leave `pending` then.
  const admittedByWs = new Map(); // workspace id -> bytes

  function measureSoon(ws) {
    if (measuring.has(ws.id)) return;
    measuring.set(
      ws.id,
      setTimeout(async () => {
        measuring.delete(ws.id);
        const taken = admittedByWs.get(ws.id) ?? 0;
        admittedByWs.delete(ws.id);
        try {
          await measure(ws);
        } catch (err) {
          hub.log(`workspace usage: ${err?.message ?? err}`);
        } finally {
          pending.set(ws.team_id, Math.max(0, (pending.get(ws.team_id) ?? 0) - taken));
          if (ws.mode === 'test') pendingTest.set(ws.team_id, Math.max(0, (pendingTest.get(ws.team_id) ?? 0) - taken));
        }
      }, Math.min(MEASURE_MAX_MS, Math.max(MEASURE_MS, 10 * (walkMs.get(ws.id) ?? 0)))),
    );
  }

  // Refuses a new write when the workspace already holds maxFiles files.
  function admitFile(ws) {
    if ((fileCounts.get(ws.id) ?? 0) >= maxFiles) {
      throw refuse(413, 'too_large', `This workspace holds ${maxFiles} files, the most one workspace can have. Delete some first.`);
    }
  }

  // A request with a body: counted per caller and hub wide while it runs.
  function takeBody(who, res) {
    const mine = bodies.get(who.key) ?? 0;
    const all = bodies.get('*') ?? 0;
    if (mine >= maxBodiesPerCaller) throw new HttpError(429, 'rate_limited', `At most ${maxBodiesPerCaller} uploads or MCP calls at once per token or person. Wait for one to finish.`, { retryAfter: 1 });
    if (all >= maxBodies) throw new HttpError(503, 'busy', 'The hub is receiving too many uploads right now. Try again in a moment.', { retryAfter: 2 });
    bodies.set(who.key, mine + 1);
    bodies.set('*', all + 1);
    res.once('close', () => {
      const m = (bodies.get(who.key) ?? 1) - 1;
      if (m > 0) bodies.set(who.key, m);
      else bodies.delete(who.key);
      bodies.set('*', Math.max(0, (bodies.get('*') ?? 1) - 1));
    });
  }

  // Refuses a write that would take the team past its storage quota. The
  // check counts what was already admitted but not measured yet, so a burst
  // of uploads cannot slip past it.
  //
  // A platform's workspace (docs/platform.md) has three limits instead
  // (platform review M10, M11): the platform's own quota (PLATFORM_STORAGE_MB,
  // not the per-team one), the workspace's own limit (workspace_storage_mb in
  // the platform's settings for its mode: one end customer cannot fill the
  // platform for the others), and in test mode the test cap for all of the
  // platform's test workspaces together.
  function admit(ws, bytes) {
    const mb = (n) => Math.round(n / 1024 / 1024);
    const lim = hub.platform?.storageLimits(ws) ?? null;
    const cap = lim ? lim.team : config.teamStorageBytes;
    const used = usageOf(hub.db, ws.team_id) + (pending.get(ws.team_id) ?? 0);
    if (used + bytes > cap) {
      throw refuse(413, 'storage_limit', lim ? `This platform has used its ${mb(cap)} MB of hub storage. Delete workspaces or files, or ask the hub operator for more.` : `This team has used its ${mb(cap)} MB of hub storage. Delete files, or ask the hub operator for more.`);
    }
    if (lim) {
      const row = hub.db.prepare('SELECT bytes, stored_bytes FROM workspaces WHERE id = ?').get(ws.id);
      const mine = (row?.bytes ?? 0) + (row?.stored_bytes ?? 0) + (admittedByWs.get(ws.id) ?? 0);
      if (mine + bytes > lim.workspace) {
        throw refuse(413, 'storage_limit', `The workspace ${ws.name} (${ws.id}) has used its ${mb(lim.workspace)} MB of storage. Delete files in it, or raise workspace_storage_mb with PUT /v1/settings.`);
      }
      if (lim.test !== null) {
        const test = hub.db.prepare("SELECT COALESCE(SUM(bytes + stored_bytes), 0) AS n FROM workspaces WHERE team_id = ? AND mode = 'test' AND deleted_at IS NULL").get(ws.team_id).n + (pendingTest.get(ws.team_id) ?? 0);
        if (test + bytes > lim.test) {
          throw refuse(413, 'storage_limit', `Test mode allows ${mb(lim.test)} MB of storage per platform, for all its test workspaces. Delete test workspaces, or use a live key.`);
        }
        pendingTest.set(ws.team_id, (pendingTest.get(ws.team_id) ?? 0) + bytes);
      }
    }
    pending.set(ws.team_id, (pending.get(ws.team_id) ?? 0) + bytes);
    admittedByWs.set(ws.id, (admittedByWs.get(ws.id) ?? 0) + bytes);
  }

  // ---- auth hooks the engine calls ----

  function sameOrigin(req, write) {
    const site = req.headers['sec-fetch-site'];
    const origin = req.headers.origin;
    if (write) {
      let o = origin;
      if (!o || o === 'null') {
        try {
          o = req.headers.referer ? new URL(req.headers.referer).origin : null;
        } catch {
          o = null;
        }
      }
      if (o !== config.origin) throw refuse(403, 'forbidden', 'This request did not come from the hub. Reload the page and try again.');
      if (site && site !== 'same-origin') throw refuse(403, 'forbidden', 'Cross-site request refused.');
      return;
    }
    if (origin !== undefined && origin !== config.origin) throw refuse(403, 'forbidden', `Cross-origin request from ${origin} refused.`);
    const navigation = req.headers['sec-fetch-mode'] === 'navigate' && (req.headers['sec-fetch-dest'] ?? 'document') === 'document';
    if (site && site !== 'same-origin' && site !== 'none' && !navigation) throw refuse(403, 'forbidden', 'Cross-site request refused.');
  }

  function authorize(req, info) {
    const who = principals.get(req);
    if (!who) throw refuse(404, 'not_found', 'Not found.');
    // An embedded desk (docs/platform.md): its own rules, in src/hub/platform/embeds.js.
    if (who.kind === 'embed') return hub.platform.embeds.authorize(req, info, who, sameOrigin);
    if (who.kind === 'session') {
      // A person: the hub's CSRF and same-origin rules. MCP posts and /mcp
      // deletes count as writes here too: they arrive with the cookie.
      const write = !READS.has(req.method);
      if (info.kind !== 'mcp-tool') {
        sameOrigin(req, write);
        if (write && !same(headerText(req, 'x-grapim-csrf') ?? '', who.session.csrf)) {
          throw refuse(403, 'forbidden', 'This page expired. Reload it and try again.');
        }
      }
    } else {
      if (info.write && who.token.scope !== 'write') {
        throw refuse(403, 'forbidden', `The token ${who.token.name} is read-only: it cannot ${info.kind === 'mcp-tool' ? `call ${info.tool}` : 'write or act'} in this workspace.`);
      }
      // The token's folders (src/scope.js), for any call that names paths:
      // 404 outside what it may read, 403 outside what it may write.
      enforce(who.scope, info);
    }
    // Test mode's daily write cap counts each write tool of an MCP batch,
    // not the request once (platform review L2).
    if (info.kind === 'mcp-tool' && info.write) hub.platform?.countToolWrite(req, who.ws);
    if (info.kind === 'mcp-tool' && info.tool === 'write_file') {
      admitFile(who.ws);
      admit(who.ws, Buffer.byteLength(String(info.args?.content ?? ''), 'utf8'));
    }
  }

  function identity(req, kind) {
    const who = principals.get(req);
    if (!who) return null;
    const header = headerText(req, 'x-grapim-agent');
    // A token minted with agent_name (platform API) always writes as <name>/<agent_name>.
    if (who.kind === 'token' && who.token.agent_name) return { agent: `${who.token.name}/${who.token.agent_name}` };
    if (who.kind === 'token') return { agent: header ? `${who.token.name}/${header}` : who.token.name };
    if (kind === 'api') return { agent: null, human: who.session.user.login };
    return { agent: header ? `@${who.session.user.login}/${header}` : `@${who.session.user.login}` };
  }

  function securityHeaders(res, { asset }) {
    // The hub already set its headers (Referrer-Policy same-origin, so the
    // desk's writes carry a real Origin). Only the CSP differs, and an
    // embedded desk may be framed by its platform's origin.
    const who = res.req && principals.get(res.req);
    if (who?.kind === 'embed') return hub.platform.embeds.headers(res, who, { asset, csp, dataCsp: DATA_CSP });
    res.setHeader('Content-Security-Policy', asset ? csp : DATA_CSP);
  }

  // ---- engines ----

  function closeEngine(id) {
    const e = engines.get(id);
    if (!e) return;
    engines.delete(id);
    const key = workspaces.storageKey(e.ws);
    const done = storage ? storage.release(key) : Promise.resolve();
    e.engine.close();
    return done;
  }

  function engineFor(ws) {
    const base = `/w/${ws.team_id}/${ws.name}`;
    const have = engines.get(ws.id);
    if (have && have.base === base) {
      engines.delete(ws.id); // re-insert: Map order is least recently used first
      engines.set(ws.id, have);
      return have.engine;
    }
    if (have) closeEngine(ws.id); // renamed: the base path changed
    if (engines.size >= maxEngines) sweep(0);
    if (engines.size >= maxEngines) {
      // Engines kept open only by live streams (a desk tab, or someone
      // holding streams open to pin engines) give way, least recently used
      // first; their clients reconnect and reopen them.
      for (const [id, e] of engines) {
        if (e.engine.inflight() <= e.streams) {
          closeEngine(id);
          break;
        }
      }
    }
    if (engines.size >= maxEngines) throw new HttpError(503, 'busy', 'The hub has too many workspaces open. Try again in a minute.', { retryAfter: 30 });
    const dir = workspaces.dirOf(ws);
    if (!fs.existsSync(path.join(dir, '.git'))) throw new HttpError(503, 'busy', 'This workspace is being restored. Try again in a minute.', { retryAfter: 30 });
    const engine = createEngine({
      cwd: dir,
      basePath: base,
      // Never GRAPIM_ALLOW_SENSITIVE_WRITES: a .claude/settings.json or .envrc
      // written here runs code on every laptop that syncs the folder.
      env: {},
      uiDir,
      authorize,
      // A token's folders (src/scope.js); people and embeds see everything.
      scope: (req) => principals.get(req)?.scope ?? null,
      identity,
      securityHeaders,
      repoName: ws.name,
      // Error texts and /api/overview never name hub paths.
      hideInternals: true,
      publicRoot: base,
      // Diffs, line counts, blame and replays run in the hub's worker pool,
      // within this team's share of it (src/hub/compute-pool.js).
      compute: hub.compute?.forTeam(ws.team_id) ?? null,
      // Bytes and files a WebDAV COPY or MKCOL creates without an upload.
      admit: (req, { bytes = 0 } = {}) => {
        const who = principals.get(req);
        if (!who) throw refuse(404, 'not_found', 'Not found.');
        admitFile(who.ws);
        if (bytes > 0) admit(who.ws, bytes);
      },
      // SaaS connectors (src/hub/connectors.js): a write under saas/<name>/
      // is pushed to that service, and the answer joins the write's response.
      afterWrite: (event) => (hub.connectors ? hub.connectors.afterWrite(ws, engine, event) : null),
    });
    // Each workspace is its own repo, with its own state: never a parent
    // repo's, nor one GRAPIM_STATE_DIR shared by every workspace.
    if (!samePath(engine.ws.root, dir) || !samePath(path.dirname(path.dirname(engine.ws.stateDir)), dir)) {
      engine.close();
      throw new Error('a workspace engine opened the wrong repo or state folder; is GRAPIM_STATE_DIR set on the hub?');
    }
    engines.set(ws.id, { engine, base, ws, streams: 0 });
    storage?.open(workspaces.storageKey(ws), dir, engine.store);
    return engine;
  }

  // Closes engines idle for `ms` (oldest first), and any over the cap.
  function sweep(ms = idleMs) {
    const now = Date.now();
    for (const [id, e] of engines) {
      if (!e.engine.busy() && e.engine.idleFor(now) >= ms) closeEngine(id);
    }
  }
  const timer = setInterval(() => sweep(), 60_000);
  timer.unref();

  // ---- live streams ----

  // Whether the caller of an open stream may still read this workspace: the
  // same live token of this workspace under this name, or the same signed-in
  // member.
  function stillAllowed(ctx, who, bearer) {
    try {
      if (who.kind === 'token') {
        const hit = workspaces.authenticate(bearer);
        return !!hit && hit.token.id === who.token.id && hit.workspace.id === who.ws.id && hit.workspace.name === who.ws.name;
      }
      if (who.kind === 'embed') return hub.platform.embeds.principal(ctx.cookies, { team: who.ws.team_id, name: who.ws.name })?.embed.id === who.embed.id;
      const s = hub.auth.load(ctx.cookies);
      return !!s && s.user.id === who.session.user.id && !!teams.membership(who.ws.team_id, s.user.id) && workspaces.byName(who.ws.team_id, who.ws.name)?.id === who.ws.id;
    } catch {
      return false;
    }
  }

  function watchStream(ctx, who, bearer, key) {
    const { res } = ctx;
    hub.streams.set(key, (hub.streams.get(key) ?? 0) + 1);
    hub.streams.set('*', (hub.streams.get('*') ?? 0) + 1);
    const entry = engines.get(who.ws.id);
    if (entry) entry.streams++;
    const timer = setInterval(() => {
      if (!stillAllowed(ctx, who, bearer)) res.destroy();
    }, streamCheckMs);
    timer.unref?.();
    res.once('close', () => {
      clearInterval(timer);
      if (entry) entry.streams = Math.max(0, entry.streams - 1);
      hub.streams.set(key, Math.max(0, (hub.streams.get(key) ?? 1) - 1));
      hub.streams.set('*', Math.max(0, (hub.streams.get('*') ?? 1) - 1));
    });
  }

  // ---- WebDAV (/dav): a workspace token as a Basic password ----

  // Whether a WebDAV request arrived over https, or from this machine. Behind
  // the proxy (TRUST_PROXY) its X-Forwarded-Proto and X-Forwarded-For say so.
  function davTransportOk(req) {
    if (req.socket?.encrypted) return true;
    if (config.trustProxy && lastOf(req.headers['x-forwarded-proto'])?.toLowerCase() === 'https') return true;
    const from = (config.trustProxy && lastOf(req.headers['x-forwarded-for'])) || req.socket?.remoteAddress || '';
    return LOOPBACK_ADDR.test(from);
  }

  function davChallenge(res, name, message) {
    const body = JSON.stringify({ error: { code: 'unauthorized', message } });
    res.writeHead(401, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'WWW-Authenticate': `Basic realm="Grapim workspace ${name}"`,
    });
    res.end(body);
    return null;
  }

  // The caller of a /dav request, or null once it was answered with 401.
  // Native clients (Explorer, Finder, davfs2, GNOME) only speak Basic: any
  // user name, a gws_ token of this workspace as the password (Bearer works
  // too). Never a session or embed cookie, so a web page cannot use a signed-in
  // browser against /dav (no CSRF surface), and never over plain http except
  // from this machine: a Basic password would cross the network in clear.
  function davCaller(ctx, where) {
    const { req, res } = ctx;
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if ((origin !== undefined && origin !== config.origin) || (site && site !== 'same-origin' && site !== 'none')) {
      req.resume();
      throw new HttpError(403, 'forbidden', 'Cross-site request refused.');
    }
    if (!davTransportOk(req)) {
      req.resume();
      throw new HttpError(403, 'forbidden', 'The drive sends your workspace token as a password, so it only works over https://. Use the https address of the hub.');
    }
    const auth = req.headers.authorization;
    const secret = basicPassword(auth) ?? /^Bearer\s+(\S+)$/i.exec(String(auth ?? ''))?.[1] ?? null;
    if (!secret) {
      req.resume();
      return davChallenge(res, where.name, 'Sign in with any user name and a workspace token (gws_...) as the password.');
    }
    const hit = secret.startsWith(WS_TOKEN_PREFIX) ? workspaces.authenticate(secret) : null;
    if (!hit) {
      req.resume();
      hub.limit(ctx, 'syncIp', ctx.ip);
    }
    // A token of another workspace gets the same answer as a wrong one.
    if (!hit || hit.workspace.team_id !== where.team || hit.workspace.name !== where.name) {
      req.resume();
      return davChallenge(res, where.name, 'Unknown or revoked workspace token, or a token of another workspace. Use a token of this workspace as the password.');
    }
    return { kind: 'token', token: hit.token, ws: hit.workspace, key: `t:${hit.token.id}`, scope: scopeOf(hit.token) };
  }

  // ---- the request ----

  async function handle(ctx, raw) {
    const { req, res } = ctx;
    const where = parse(raw);
    ctx.routeName = 'WS';
    if (!where) throw notFound();
    const kind = kindOf(where.rest);
    ctx.routeName = `WS ${kind}`;
    ctx.json = kind !== 'asset';

    // Who is calling. The token, not the URL, names its workspace.
    let who;
    const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''))?.[1];
    if (kind === 'dav') {
      who = davCaller(ctx, where);
      if (!who) return; // answered with a Basic challenge
    } else if (req.headers.authorization !== undefined) {
      // Per address, only unknown, revoked and expired tokens are counted;
      // valid tokens are limited per token below. Many sandboxes, of several
      // platforms, share one egress address, so one platform's expired tokens
      // must not lock out another's agents (platform review M4). Lookups are
      // bounded per address by server.js (platformIp).
      const hit = bearer?.startsWith(WS_TOKEN_PREFIX) ? workspaces.authenticate(bearer) : null;
      if (!hit) {
        hub.limit(ctx, 'syncIp', ctx.ip);
        throw new HttpError(401, 'unauthorized', 'Unknown or revoked workspace token. Send Authorization: Bearer gws_...');
      }
      if (hit.workspace.team_id !== where.team || hit.workspace.name !== where.name) throw notFound();
      who = { kind: 'token', token: hit.token, ws: hit.workspace, key: `t:${hit.token.id}`, scope: scopeOf(hit.token) };
    } else if ((who = hub.platform?.embeds.principal(ctx.cookies, where) ?? null)) {
      // An embed session's cookie, valid for this very workspace only.
    } else {
      const session = hub.auth.load(ctx.cookies);
      if (!session) {
        if (kind === 'asset' && (req.method === 'GET' || req.method === 'HEAD')) {
          res.writeHead(303, { Location: `/hub/login?next=${encodeURIComponent(`/w/${where.team}/${where.name}`)}`, 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        throw new HttpError(401, 'unauthorized', 'Sign in, or send Authorization: Bearer <workspace token>.');
      }
      ctx.session = session;
      if (!teams.membership(where.team, session.user.id)) throw notFound();
      const ws = workspaces.byName(where.team, where.name);
      if (!ws) throw notFound();
      who = { kind: 'session', session, ws, key: `u:${session.user.id}` };
    }
    hub.limit(ctx, 'workspace', who.key);

    // The desk takes a token from ?token= for `grapim serve`. Here a link
    // carrying someone else's token would sign this tab into their
    // workspace, so the parameter never reaches the page.
    if (kind === 'asset' && /[?&]token=/.test(where.query)) {
      const q = new URLSearchParams(where.query);
      q.delete('token');
      const rest = q.toString();
      res.writeHead(303, { Location: `/w/${where.team}/${where.name}${where.rest || '/'}${rest ? `?${rest}` : ''}`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    // The embed demo page in ui/ is for local development, never served here.
    if (kind === 'asset' && /^\/embed-demo\.html[.\s]*$/i.test(safeDecode(where.rest))) throw notFound();
    if (where.rest === '') {
      res.writeHead(308, { Location: `/w/${where.team}/${where.name}/${where.query}`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (restoring.has(who.ws.id)) throw new HttpError(503, 'busy', 'This workspace is being restored. Try again in a minute.', { retryAfter: 30 });

    // A live stream holds a socket (and its engine) for as long as the
    // client likes: counted per person with the hub's own streams, and its
    // caller re-checked while it is open, so a revoked token, a removed
    // member or a signed-out session stops receiving.
    const stream = kind === 'api' && req.method === 'GET' && /^\/api\/stream\/?$/.test(where.rest);
    const streamKey = who.kind === 'embed' ? who.key : `u${who.kind === 'token' ? who.token.user_id : who.session.user.id}`;
    if (stream) {
      const open = hub.streams.get(streamKey) ?? 0;
      const total = hub.streams.get('*') ?? 0;
      if (open >= MAX_STREAMS_PER_USER || total >= MAX_STREAMS) throw new HttpError(429, 'rate_limited', 'Too many open streams.', { retryAfter: 15 });
    }

    const engine = engineFor(who.ws);
    principals.set(req, who);
    if (who.kind === 'session' || who.kind === 'embed') res.setHeader('X-Grapim-Csrf', who.session.csrf);

    // WebDAV: PROPFIND is a read; LOCK, UNLOCK and PROPPATCH count as writes.
    const write = kind === 'dav' ? DAV_WRITES.has(req.method) : !READS.has(req.method);
    // Platform workspaces: metering, test-mode caps, webhook events, and the
    // embedded desk's page (src/hub/platform/index.js).
    if (hub.platform?.onWorkspaceRequest(ctx, who, where, { write, engine, uiDir, csp })) return;
    if (write) {
      try {
        if (kind !== 'asset') takeBody(who, res);
        // A file upload counts toward the quota before its body is read.
        // Without a Content-Length it counts as the largest body /fs accepts.
        if ((kind === 'fs' || kind === 'dav') && req.method === 'PUT') {
          admitFile(who.ws);
          const len = Number(req.headers['content-length']);
          admit(who.ws, Number.isFinite(len) && len >= 0 ? len : MAX_BODY);
        }
      } catch (err) {
        req.resume();
        throw err instanceof HttpError ? err : new HttpError(err.status, err.code, err.message);
      }
    }
    if (stream) watchStream(ctx, who, bearer, streamKey);
    if (write) {
      res.once('close', () => {
        measureSoon(who.ws);
        storage?.touch(workspaces.storageKey(who.ws));
      });
    }
    await engine.handle(req, res);
  }

  return {
    handle,
    engines,
    // The live write-behind storage, once boot() wired it.
    get storage() {
      return storage;
    },
    // Wires storage in and rebuilds workspace folders that are missing.
    // Restores run in the background; their workspaces answer 503 meanwhile.
    async boot(ws) {
      storage = ws;
      // Every version uploaded to storage counts toward the team's quota
      // (wsKey is <team_id>/<workspace_id>), so writes cannot fill the disk
      // or the bucket while the workspace folder itself stays small.
      storage?.onStored?.((wsKey, bytes) => {
        const [team, wsId] = wsKey.split('/');
        usageOf(hub.db, team);
        hub.db.prepare('UPDATE team_usage SET bytes = bytes + ? WHERE team_id = ?').run(bytes, team);
        // ...and toward the workspace's own limit (a platform's workspaces).
        hub.db.prepare('UPDATE workspaces SET stored_bytes = stored_bytes + ? WHERE id = ? AND team_id = ?').run(bytes, wsId, team);
      });
      const jobs = [];
      for (const w of workspaces.all()) {
        const dir = workspaces.dirOf(w);
        if (fs.existsSync(dir)) continue;
        restoring.add(w.id);
        jobs.push(
          (async () => {
            try {
              const r = storage ? await storage.restore(workspaces.storageKey(w), dir) : null;
              initRepo(dir);
              hub.log(r ? `workspace ${w.id} restored from storage (${r.files} files)` : `workspace ${w.id} had no folder and no stored copy: recreated empty`);
            } catch (err) {
              hub.log(`workspace ${w.id} could not be restored: ${err?.message ?? err}`);
            } finally {
              restoring.delete(w.id);
            }
          })(),
        );
      }
      return Promise.all(jobs);
    },
    measure,
    admit, // the platform API's undo is admitted like an upload...
    measureSoon, // ...and measured like one, which settles what was admitted
    engineFor, // the platform API's runs and undo use the same engine
    // Writes a folder template into a new workspace, as the approved run
    // template:<name> (src/hub/templates.js). by: who created it.
    applyTemplate(ws, name, by) {
      if (cleanTemplate(name) === 'blank') return { run: null, files: [] };
      const r = applyTemplate(engineFor(ws), name, by);
      if (r.run) storage?.touch(workspaces.storageKey(ws));
      return r;
    },
    close: closeEngine,
    // Closes every engine (writing pending manifests) and stops the timers.
    async closeAll() {
      clearInterval(timer);
      for (const t of measuring.values()) clearTimeout(t);
      measuring.clear();
      await Promise.all([...engines.keys()].map((id) => closeEngine(id)));
      if (storage) await storage.close();
    },
  };
}
