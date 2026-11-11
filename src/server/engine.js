// The engine behind `grapim serve`, mountable anywhere: the review desk
// (ui/), the JSON API (/api), the agent workspace (/fs) and MCP over HTTP
// (/mcp) for one repo, optionally under a base path such as
// /w/<team>/<workspace>. `grapim serve` mounts it at the root with its own
// guard (src/server/index.js); the hub mounts one per cloud workspace with
// its own sign in (src/hub/workspaces.js). Nothing here is forked: the same
// handlers serve both.
//
// Hooks:
// - authorize(req, { kind, write, asset }) runs before anything else and
//   throws an HttpError to refuse. kind is 'asset' | 'api' | 'fs' | 'mcp';
//   write is true for every request that changes something or acts
//   (PUT/DELETE/POST on /fs, POST on /api). MCP tool calls are checked one by
//   one with { kind: 'mcp-tool', tool, write }.
// - identity(req, kind) -> { agent?, human? } | null decides who the caller
//   is. agent (a string) replaces X-Grapim-Agent, so /fs, /mcp and the act
//   routes see that name; agent null removes the header. human names the
//   person for undo, review, branch and restore (`human:<name>`).
// - securityHeaders(res, { asset }) sets the response headers.
// - repoName replaces the repo's folder name in what the desk shows.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../store.js';
import { resolveWorkspace } from '../workspace.js';
import { handleApi } from './api.js';
import { createWorkspace } from './fs.js';
import { handleFs } from './fs-http.js';
import { HttpError, sendError, splitUrl, toHttpError } from './http.js';
import { createMcpHttp } from './mcp-http.js';
import { createOffload } from './offload.js';
import { serveStatic } from './static.js';
import { createStream } from './stream.js';

export const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui');

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// MCP tools that change files, claims or intents. A read-only caller gets
// only the others (who_is_editing, recent_activity, list_runs, who_wrote,
// read_file, list_dir).
export const MCP_WRITE_TOOLS = new Set(['claim_files', 'release_files', 'set_intent', 'write_file', 'delete_file']);

// The parts of the server that hold repo data or act on it. Everything else
// is the review desk's own files (public code, no data), which a browser must
// be able to load before the page can send the token.
export const isAppPath = (target) => /^\/(api|fs|mcp)(\/|$)/.test(target.split('?')[0]);

function kindOf(target) {
  const p = target.split('?')[0];
  if (p === '/mcp') return 'mcp';
  if (p === '/fs' || p.startsWith('/fs/')) return 'fs';
  if (p === '/api' || p.startsWith('/api/')) return 'api';
  return 'asset';
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
const isWrite = (kind, method) => (kind === 'fs' || kind === 'api') && !READS.has(method);

const defaultHeaders = (res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
};

// "/w/a/b/" -> "/w/a/b"; "" and "/" -> "".
function cleanBase(basePath) {
  const b = String(basePath ?? '').replace(/\/+$/, '');
  if (b && (!b.startsWith('/') || /[?#\\]|\/\/|(^|\/)\.\.?(\/|$)/.test(b))) throw new Error(`Bad basePath "${basePath}".`);
  return b;
}

// The request target below the base path, or null when it is not under it.
function below(base, raw) {
  if (!base) return raw;
  if (raw === base) return '/';
  if (raw.startsWith(`${base}/`)) return raw.slice(base.length);
  if (raw.startsWith(`${base}?`)) return `/${raw.slice(base.length)}`;
  return null;
}

// Header values are latin1 in node; agents send UTF-8 (headerText decodes it).
const asHeader = (s) => Buffer.from(s, 'utf8').toString('latin1');

// Opens the repo at `cwd` and returns { ws, store, handle(req, res), idle(), busy(), close() }.
export function createEngine({
  cwd = process.cwd(),
  basePath = '',
  env = process.env,
  uiDir = UI_DIR,
  authorize = () => {},
  identity = null,
  securityHeaders = defaultHeaders,
  repoName = null,
  // The hub: unexpected errors answer a generic message (theirs name hub
  // paths and git output), and the API shows publicRoot instead of the folder.
  hideInternals = false,
  publicRoot = null,
  // The hub: { run(task, input) -> Promise } that runs diffs, line counts,
  // blame and replays in worker threads (src/hub/compute-pool.js, through
  // src/server/offload.js). Without it (grapim serve) they run in place.
  compute = null,
} = {}) {
  const base = cleanBase(basePath);
  const ws = resolveWorkspace(cwd);
  // The name the desk shows (the hub's folders are named by id).
  if (repoName) ws.repo = repoName;
  const store = new Store(ws.stateDir);
  const humans = new WeakMap();
  let inflight = 0;
  let lastUsed = Date.now();
  let closed = false;
  try {
    const offload = compute ? createOffload({ compute, log: (m) => process.stderr.write(`${m}\n`) }) : null;
    if (offload) store.countLines = offload.countLines;
    const workspace = createWorkspace({ store, ws, env, offload });
    const ctx = {
      store,
      ws,
      env,
      workspace,
      uiDir,
      base,
      publicRoot,
      offload,
      // The person behind a request, for `human:<name>` (api.js); null: the local user.
      human: (req) => humans.get(req) ?? null,
      stream: createStream(store),
      mcp: createMcpHttp({ store, ws, workspace, offload, authorizeTool: (req, tool, args) => authorize(req, { kind: 'mcp-tool', tool, write: MCP_WRITE_TOOLS.has(tool), args }) }),
    };

    const applyIdentity = (req, kind) => {
      const id = identity ? identity(req, kind) : null;
      if (!id) return;
      if (id.agent === null) delete req.headers['x-grapim-agent'];
      else if (typeof id.agent === 'string') req.headers['x-grapim-agent'] = asHeader(id.agent);
      if (id.human) humans.set(req, id.human);
    };

    async function handle(req, res) {
      inflight++;
      lastUsed = Date.now();
      res.once('close', () => {
        inflight--;
        lastUsed = Date.now();
      });
      try {
        const target = below(base, req.url);
        const kind = target === null ? 'asset' : kindOf(target);
        const asset = (req.method === 'GET' || req.method === 'HEAD') && target !== null && target.startsWith('/') && !isAppPath(target);
        securityHeaders(res, { asset });
        if (closed) throw new HttpError('busy', 'This workspace is closing. Try again in a moment.', { 'Retry-After': '1' });
        await authorize(req, { kind, write: isWrite(kind, req.method), asset });
        if (target === null) throw new HttpError('not_found', 'Not found.');
        const { path: p, query } = splitUrl(target);
        applyIdentity(req, kind);
        if (p === '/mcp') return await ctx.mcp.handle(req, res);
        if (p === '/fs' || p.startsWith('/fs/')) return await handleFs(ctx, req, res, p);
        if (p === '/api' || p.startsWith('/api/')) return await handleApi(ctx, req, res, p, query);
        return serveStatic(req, res, p, ctx.uiDir, base);
      } catch (err) {
        if (hideInternals && toHttpError(err).code === 'internal') {
          process.stderr.write(`grapim workspace: ${err?.name ?? 'Error'}: ${err?.message ?? err}\n`);
          return sendError(res, new HttpError('internal', 'Something went wrong in this workspace. Try again; if it keeps failing, tell the hub operator.'));
        }
        sendError(res, err);
      }
    }

    function close() {
      if (closed) return;
      closed = true;
      ctx.stream.close();
      ctx.mcp.closeAll();
      store.close();
    }

    return {
      ws,
      store,
      ctx,
      handle,
      close,
      // Requests in flight right now (an open live stream counts until it closes).
      busy: () => inflight > 0,
      inflight: () => inflight,
      idleFor: (now = Date.now()) => (inflight > 0 ? 0 : now - lastUsed),
    };
  } catch (err) {
    store.close();
    throw err;
  }
}
