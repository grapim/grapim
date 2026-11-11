// The engine behind `grapim serve`, mountable anywhere: the review desk
// (ui/), the JSON API (/api), the agent workspace (/fs) and MCP over HTTP
// (/mcp) for one repo, optionally under a base path such as
// /w/<team>/<workspace>. `grapim serve` mounts it at the root with its own
// guard (src/server/index.js); the hub mounts one per cloud workspace with
// its own sign in (src/hub/workspaces.js). Nothing here is forked: the same
// handlers serve both.
//
// Hooks:
// - authorize(req, info) throws an HttpError to refuse. It is path-aware:
//   1. Before anything else, once per request: { kind, write, asset }. kind is
//      'asset' | 'api' | 'fs' | 'mcp' | 'dav'; write is true for every request
//      that changes something or acts (PUT/DELETE/POST on /fs, POST on /api,
//      and on /dav every method but OPTIONS, GET, HEAD and PROPFIND).
//   2. Again, with the same kind and write, as soon as the request names what
//      it touches, adding access ('read' | 'write') and either
//      - path: one workspace-relative path, forward slashes, no leading "/",
//        already checked by resolvePath (no "..", nothing in .git); '' is the
//        root and a trailing "/" marks a folder. Behind a link the real path
//        is checked as well, in a second call; or
//      - paths + recorded: true: the files a run (undo, review, branch) or a
//        stored version touched, from the ledger.
//   3. Each MCP tool call, once: { kind: 'mcp-tool', tool, write, args,
//      access, paths } with the paths the tool names (none for tools that
//      name no file).
//   The hub answers from the token's scope (src/scope.js enforce): a path it
//   may not read is 404, one it may not write 403 forbidden with the path.
//   Other callers of the hook (WebDAV) pass { kind, write, path, access } the
//   same way. Calls 2 and 3 must not have side effects beyond refusing.
// - scope(req) -> scope | null: what the caller may see (src/scope.js). The
//   folder listings, recursive listing, runs, run detail, overview, events,
//   the changes feed and the MCP read tools leave out what it cannot read.
// - identity(req, kind) -> { agent?, human? } | null decides who the caller
//   is. agent (a string) replaces X-Grapim-Agent, so /fs, /mcp and the act
//   routes see that name; agent null removes the header. human names the
//   person for undo, review, branch and restore (`human:<name>`).
// - securityHeaders(res, { asset }) sets the response headers.
// - repoName replaces the repo's folder name in what the desk shows.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reader } from '../scope.js';
import { Store } from '../store.js';
import { fileKey, resolveWorkspace } from '../workspace.js';
import { handleApi } from './api.js';
import { afterWrites, withAfterWrite } from './after-write.js';
import { createWorkspace } from './fs.js';
import { handleFs } from './fs-http.js';
import { HttpError, sendError, splitUrl, toHttpError } from './http.js';
import { createMcpHttp } from './mcp-http.js';
import { createOffload } from './offload.js';
import { realRel, resolvePath } from './paths.js';
import { serveStatic } from './static.js';
import { createStream } from './stream.js';
import { createDav, davClient, DAV_WRITES } from './webdav.js';

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
export const isAppPath = (target) => /^\/(api|fs|mcp|dav)(\/|$)/.test(target.split('?')[0]);

function kindOf(target) {
  const p = target.split('?')[0];
  if (p === '/mcp') return 'mcp';
  if (p === '/fs' || p.startsWith('/fs/')) return 'fs';
  if (p === '/api' || p.startsWith('/api/')) return 'api';
  if (p === '/dav' || p.startsWith('/dav/')) return 'dav';
  return 'asset';
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
// WebDAV (src/server/webdav.js): PROPFIND reads; LOCK and PROPPATCH count as writes.
const isWrite = (kind, method) => (kind === 'dav' ? DAV_WRITES.has(method) : (kind === 'fs' || kind === 'api') && !READS.has(method));

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

// The path a resolved target names for authorize: '' for the root, "dir/" for a folder.
const named = (t) => (t.dir ? (t.rel ? `${t.rel}/` : '') : t.rel);

// The paths an MCP tool call names, for authorize (step 3 above): as given
// (absolute ones made workspace-relative, as claim_files and who_wrote do)
// and, behind a link, as they really are.
const MCP_PATHS = { read_file: 'read', who_wrote: 'read', list_dir: 'read', write_file: 'write', delete_file: 'write', claim_files: 'write', release_files: 'write' };
function toolPaths(ws, tool, args) {
  const access = MCP_PATHS[tool];
  if (!access) return {};
  const many = tool === 'claim_files' || tool === 'release_files';
  const raw = many ? (Array.isArray(args?.paths) ? args.paths : []) : [args?.path ?? ''];
  const paths = [];
  for (const r of raw) {
    let rel = String(r ?? '');
    if (/^([a-zA-Z]:|\/)/.test(rel)) rel = fileKey(ws, rel)?.display ?? rel;
    if (tool === 'list_dir' && rel !== '' && !rel.endsWith('/')) rel += '/';
    paths.push(rel);
    try {
      const t = resolvePath(ws, rel);
      const real = t.dir ? `${realRel(ws, t.abs)}/`.replace(/^\/$/, '') : realRel(ws, t.abs);
      if (real !== named(t)) paths.push(real);
    } catch {} // the tool refuses the path itself
  }
  return { access, paths };
}

// Opens the repo at `cwd` and returns { ws, store, handle(req, res), idle(), busy(), close() }.
export function createEngine({
  cwd = process.cwd(),
  basePath = '',
  env = process.env,
  uiDir = UI_DIR,
  authorize = () => {},
  scope = null,
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
  // The hub: admit(req, { bytes }) counts bytes a request creates without
  // uploading them (a WebDAV COPY) toward the quota; throws to refuse.
  admit = null,
  // The hub: afterWrite(event) runs after every recorded write, delete, undo
  // and restore of a file; its answer joins the response (./after-write.js).
  afterWrite = null,
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
    const workspace = withAfterWrite(createWorkspace({ store, ws, env, offload }), afterWrite);
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
      // The authorize hook, for the handlers' path checks (step 2 above).
      authorize: (req, info) => authorize(req, info),
      // Checks a target from resolvePath: as named, and as it really is behind a link.
      async authorizeTarget(req, info, t, root = ws) {
        await authorize(req, { ...info, path: named(t) });
        const real = realRel(root, t.abs);
        const asNamed = t.dir ? t.rel : named(t);
        if (real !== asNamed) await authorize(req, { ...info, path: t.dir && real ? `${real}/` : real });
      },
      // null when the caller sees everything, else (path, 'file' | 'dir') -> may it see it.
      readable: (req) => reader(scope ? scope(req) : null),
      mcp: createMcpHttp({
        store,
        ws,
        workspace,
        offload,
        authorizeTool: (req, tool, args) => authorize(req, { kind: 'mcp-tool', tool, write: MCP_WRITE_TOOLS.has(tool), args, ...toolPaths(ws, tool, args) }),
        readable: (req) => reader(scope ? scope(req) : null),
      }),
      admit: admit ?? (() => {}),
      // After an undo or restore: the post-write callback for each file it changed.
      afterWrites: (files, info) => afterWrites(afterWrite, files, info),
    };
    // The workspace as a network drive (WebDAV at /dav/).
    ctx.dav = createDav(ctx);

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
        // A drive is one agent per client kind: http:[<token>/]dav-windows.
        if (kind === 'dav') req.headers['x-grapim-agent'] = `dav-${davClient(req.headers['user-agent'])}`;
        applyIdentity(req, kind);
        if (kind === 'dav') return await ctx.dav.handle(req, res, p);
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
      // Runs fn() as if it were a request in flight, so the engine is not
      // closed as idle under it (a SaaS connector's pull).
      async use(fn) {
        if (closed) throw new HttpError('busy', 'This workspace is closing. Try again in a moment.', { 'Retry-After': '1' });
        inflight++;
        lastUsed = Date.now();
        try {
          return await fn();
        } finally {
          inflight--;
          lastUsed = Date.now();
        }
      },
    };
  } catch (err) {
    store.close();
    throw err;
  }
}
