// The JSON API at /api/*, as docs/api.md specifies it.

import os from 'node:os';
import path from 'node:path';
import { blame } from '../attribution.js';
import { snapshot } from '../ledger.js';
import { applyRestore, planRestore, restoreJson } from '../restore.js';
import { autoApprove, createBranch, setReview } from '../review.js';
import { applyUndo, changedAny, planUndo } from '../undo.js';
import { rootKey } from '../workspace.js';
import { createWorkspace, httpAgent } from './fs.js';
import { badRequest, headerText, notAllowed, notFound, readJson, sendBytes, sendJson } from './http.js';
import { diffJson } from './json-diff.js';
import { decodePath, guardSensitiveWrite, resolvePath } from './paths.js';
import { eventsAfter, fileHistory, worktrees } from './queries.js';
import { listRuns, planJson, resolveRun, runDetail } from './runs.js';

const REVIEW = new Set(['pending', 'approved', 'rejected']);
const MAX_NOTE = 4000;

const slash = (p) => p.split(path.sep).join('/');

// Who is acting: the X-Grapim-Agent if given, else the human running the server.
function actor(req) {
  const name = headerText(req, 'x-grapim-agent');
  return name ? httpAgent(name).agent : `human:${os.userInfo().username}`;
}

function int(query, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = query.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw badRequest(`${name} must be a whole number, ${min} or more.`);
  return Math.min(n, max);
}

// ?name=1 (or true, yes) is on; absent, empty or 0 is off.
const flag = (query, name) => ['1', 'true', 'yes'].includes(String(query.get(name) ?? '').toLowerCase());

function filePath(ws, p) {
  if (!p) throw badRequest('Give the file: ?path=src/app.js');
  if (typeof p !== 'string') throw badRequest('path must be a string.');
  const t = resolvePath(ws, p);
  if (!t.file || t.dir) throw badRequest(`"${p}" is a folder path. Give a file.`);
  return t;
}

// The worktree a file request is about: ?worktree=<name> (one of the names
// GET /api/overview lists), or the one the server runs in. Anything else is
// refused, so a request can never name an arbitrary folder.
function worktreeOf(ctx, name) {
  if (name === null || name === undefined || name === '') return { ws: ctx.ws, workspace: ctx.workspace };
  if (typeof name !== 'string') throw badRequest('worktree must be a string.');
  const hits = worktrees(ctx.ws).filter((w) => w.name === name);
  if (!hits.length) throw badRequest(`No worktree named "${name}". GET /api/overview lists them.`);
  if (hits.length > 1) throw badRequest(`${hits.length} worktrees are named "${name}"; the file APIs cannot tell them apart.`);
  const root = path.resolve(hits[0].root);
  const key = rootKey(root);
  if (key === rootKey(ctx.ws.root)) return { ws: ctx.ws, workspace: ctx.workspace };
  ctx.worktreeCache ??= new Map();
  if (!ctx.worktreeCache.has(key)) {
    const ws = { ...ctx.ws, root, worktree: hits[0].name };
    ctx.worktreeCache.set(key, { ws, workspace: createWorkspace({ store: ctx.store, ws, env: ctx.env }) });
  }
  return ctx.worktreeCache.get(key);
}

// GET /api/blame; with full=1 also the working file's text, so the file view needs one request.
function blameOf(ctx, q) {
  const { ws } = worktreeOf(ctx, q.get('worktree'));
  const t = filePath(ws, q.get('path'));
  const b = blame(ctx.store, ws, t.file);
  if (!flag(q, 'full')) return b;
  const now = snapshot(t.abs);
  return { ...b, content: now.buf ? now.buf.toString('utf8') : null };
}

function files(ctx, q) {
  const { workspace } = worktreeOf(ctx, q.get('worktree'));
  const p = q.get('path') ?? '';
  return flag(q, 'recursive') ? workspace.listAll(p) : workspace.list(p);
}

function history(ctx, q) {
  const { ws } = worktreeOf(ctx, q.get('worktree'));
  return fileHistory(ctx.store, ws, filePath(ws, q.get('path')).file.key);
}

function overview({ store, ws }) {
  const leases = store.leases().map((l) => ({
    path: l.path,
    agent: l.agent,
    label: l.label ?? l.agent,
    worktree: l.worktree ?? null,
    intent: l.intent ?? null,
    acquired_at: l.acquired_at,
    expires_at: l.expires_at,
  }));
  const agents = store.activeAgents().map((a) => ({
    agent: a.agent,
    label: a.label ?? a.agent,
    worktree: a.worktree ?? null,
    intent: a.intent ?? null,
    last_seen: a.last_seen,
    files: leases.filter((l) => l.agent === a.agent).map((l) => l.path),
  }));
  const runs = listRuns(store);
  return {
    repo: ws.repo,
    root: slash(ws.root),
    worktrees: worktrees(ws),
    agents,
    leases,
    counts: { agents: agents.length, leases: leases.length, runs: runs.length, unreviewed: runs.filter((r) => r.review.status === 'pending').length },
    worktree: ws.worktree,
  };
}

function undoRun(ctx, req, run, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Send a JSON object: { "turn": null, "apply": false }.');
  const turn = body.turn ?? null;
  if (turn !== null && !(Number.isInteger(turn) && turn >= 0)) throw badRequest('turn must be null or a whole number.');
  if (body.apply !== undefined && typeof body.apply !== 'boolean') throw badRequest('apply must be true or false.');
  const who = actor(req);
  let plan;
  try {
    plan = planUndo(ctx.store, run, { turn, actor: who });
  } catch (err) {
    if (/^No run matches|has no recorded changes/.test(err.message)) throw notFound(err.message);
    if (/matches \d+ runs/.test(err.message)) throw badRequest(err.message);
    throw err;
  }
  if (body.apply) {
    plan = applyUndo(ctx.store, plan, who);
    if (changedAny(plan)) autoApprove(ctx.store, plan.undoRun, who);
  }
  return planJson(plan, !!body.apply);
}

// POST /api/files/restore { path, sha, worktree?, apply = true, expect? }.
// apply: false only plans; both answer with the diff from the current file to the version.
function restore(ctx, req, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Send a JSON object: { "path": "src/app.js", "sha": "…" }.');
  if (typeof body.sha !== 'string') throw badRequest('sha must be a string: a version from GET /api/files/history.');
  if (body.apply !== undefined && typeof body.apply !== 'boolean') throw badRequest('apply must be true or false.');
  if (body.expect !== undefined && body.expect !== null && typeof body.expect !== 'string') throw badRequest('expect must be the current sha, or null for no file.');
  const { ws } = worktreeOf(ctx, body.worktree);
  const t = filePath(ws, body.path);
  // Like /fs: files that run code by themselves are not written over HTTP.
  guardSensitiveWrite(ws, t.rel, ctx.env, t.abs);
  const who = actor(req);
  const apply = body.apply !== false;
  let plan = planRestore(ctx.store, ws, t.file, body.sha, { actor: who });
  if (apply) plan = applyRestore(ctx.store, ws, plan, who, { expect: body.expect });
  const known = plan.now.sha === null || plan.now.buf !== null;
  const diff = known ? diffJson(plan.now.buf, plan.version.buf).diff : null;
  return restoreJson(plan, apply && plan.action !== 'nothing', { worktree: ws.worktree, diff });
}

async function review(ctx, req, run, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Send a JSON object: { "status": "approved" }.');
  if (!REVIEW.has(body.status)) throw badRequest('status must be "pending", "approved" or "rejected".');
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') throw badRequest('note must be a string.');
  if (body.note && body.note.length > MAX_NOTE) throw badRequest(`note is over ${MAX_NOTE} characters.`);
  const r = resolveRun(ctx.store, run);
  return await setReview(ctx.store, r.run, body.status, { note: body.note || null, by: actor(req) });
}

async function branch(ctx, req, run) {
  await readJson(req); // no options yet; a malformed body is still an error
  const r = resolveRun(ctx.store, run);
  return await createBranch(ctx.store, ctx.ws, r.run, { by: actor(req) });
}

// [method, path parts (":run" matches one segment), handler(ctx, req, res, params, query)]
const ROUTES = [
  ['GET', ['overview'], (ctx) => overview(ctx)],
  ['GET', ['runs'], (ctx) => listRuns(ctx.store)],
  ['GET', ['runs', ':run'], (ctx, req, res, p) => runDetail(ctx.store, p.run)],
  ['GET', ['blame'], (ctx, req, res, p, q) => blameOf(ctx, q)],
  ['GET', ['files'], (ctx, req, res, p, q) => files(ctx, q)],
  ['GET', ['files', 'history'], (ctx, req, res, p, q) => history(ctx, q)],
  ['GET', ['files', 'version'], (ctx, req, res, p, q) => version(ctx, res, q)],
  ['GET', ['events'], (ctx, req, res, p, q) => eventsAfter(ctx.store, int(q, 'after', 0), int(q, 'limit', 100, { min: 1, max: 1000 }), { latest: q.get('latest') === '1' })],
  ['GET', ['stream'], (ctx, req, res) => ctx.stream.attach(req, res)],
  ['POST', ['runs', ':run', 'undo'], async (ctx, req, res, p) => undoRun(ctx, req, p.run, await readJson(req))],
  ['POST', ['runs', ':run', 'branch'], async (ctx, req, res, p) => branch(ctx, req, p.run)],
  ['POST', ['runs', ':run', 'review'], async (ctx, req, res, p) => review(ctx, req, p.run, await readJson(req))],
  ['POST', ['files', 'restore'], async (ctx, req) => restore(ctx, req, await readJson(req))],
];

function version(ctx, res, q) {
  const sha = q.get('sha') ?? '';
  if (!/^[0-9a-f]{40}$/.test(sha)) throw badRequest('sha must be 40 lowercase hex characters.');
  const buf = ctx.store.blob(sha);
  if (!buf) throw notFound(`No stored version ${sha}. Binary files and files over 2 MB are not kept.`);
  sendBytes(res, buf, 'text/plain; charset=utf-8');
}

function match(pattern, parts) {
  if (pattern.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    if (pattern[i].startsWith(':')) params[pattern[i].slice(1)] = decodePath(parts[i]);
    else if (pattern[i] !== parts[i]) return null;
  }
  return params;
}

// rawPath starts with /api. Writes the response.
export async function handleApi(ctx, req, res, rawPath, query) {
  const parts = rawPath.split('/').slice(2);
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const allow = [];
  for (const [m, pattern, fn] of ROUTES) {
    const params = match(pattern, parts);
    if (!params) continue;
    if (m !== method) {
      allow.push(m);
      continue;
    }
    const out = await fn(ctx, req, res, params, query);
    if (!res.headersSent) sendJson(res, 200, out);
    return;
  }
  if (allow.length) throw notAllowed(allow);
  throw notFound(`No API at ${rawPath}. See docs/api.md.`);
}
