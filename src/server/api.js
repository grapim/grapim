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
import { restorePairs, undoPairs } from './offload.js';
import { decodePath, guardSensitiveWrite, resolvePath } from './paths.js';
import { changesAfter, eventsAfter, fileHistory, pathsByRun, pathsOfVersion, scopedEvents, worktrees } from './queries.js';
import { listRuns, planJson, resolveRun, runDetail } from './runs.js';

// ---- access scopes (src/scope.js) ----
//
// Paths a request names go through the engine's authorize hook
// (ctx.authorizeTarget, ctx.authorize); lists go through ctx.readable(req),
// which is null when the caller sees everything.

const READ = { kind: 'api', write: false, access: 'read' };
const ACT = { kind: 'api', write: true, access: 'write' };
const see = (ctx, req) => ctx.readable?.(req) ?? null;

// The runs the caller can see: those that changed at least one file it may read.
function visibleRuns(ctx, view) {
  const runs = new Set();
  for (const [run, paths] of pathsByRun(ctx.store)) if (paths.some((p) => view(p))) runs.add(run);
  return runs;
}

// The run id a scoped caller means, matched (as findRun does: id, label or a
// prefix) among the runs it can see only, so an ambiguous prefix never names
// a run outside its scope. Unscoped callers: the query as given.
function runFor(ctx, req, query) {
  const view = see(ctx, req);
  if (!view) return query;
  const ok = visibleRuns(ctx, view);
  return resolveRun({ runs: () => ctx.store.runs().filter((r) => ok.has(r.run)) }, query).run;
}

const scopedRuns = (ctx, view, rows) => {
  if (!view) return rows;
  const ok = visibleRuns(ctx, view);
  return rows.filter((r) => ok.has(r.run));
};

// An act on a recorded run (undo, review, branch) touches the files it
// changed (in one turn, for an undo of a turn): the caller must be allowed to
// write every one of them. Returns the run id to act on.
async function authorizeRun(ctx, req, query, turn = null) {
  const r = resolveRun(ctx.store, runFor(ctx, req, query));
  const paths = [...new Set(ctx.store.changesOfRun(r.run).filter((c) => turn === null || c.turn === turn).map((c) => c.path))];
  await ctx.authorize?.(req, { ...ACT, paths, recorded: true });
  return r.run;
}

// A run's detail without the files the caller may not read; the rest is
// counted ("2 files outside your scope").
function scopedDetail(d, view) {
  if (!view) return d;
  const files = d.files.filter((f) => view(f.path));
  const hidden = d.files.length - files.length;
  if (!files.length) throw notFound('Not found.');
  const turns = d.turns.map((t) => ({ ...t, files: t.files.filter((p) => view(p)) })).filter((t) => t.files.length);
  return { ...d, turns, files, hidden_files: hidden, ...(hidden ? { scope_note: `${hidden} file${hidden === 1 ? '' : 's'} outside your scope` } : {}) };
}

const REVIEW = new Set(['pending', 'approved', 'rejected']);
const MAX_NOTE = 4000;

const slash = (p) => p.split(path.sep).join('/');

// Who is acting: the X-Grapim-Agent if given, else the human: the one the
// mount names (ctx.human, the hub's signed-in person) or the user running the server.
function actor(req, ctx) {
  const name = headerText(req, 'x-grapim-agent');
  return name ? httpAgent(name).agent : `human:${ctx?.human?.(req) ?? os.userInfo().username}`;
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
    ctx.worktreeCache.set(key, { ws, workspace: createWorkspace({ store: ctx.store, ws, env: ctx.env, offload: ctx.offload }) });
  }
  return ctx.worktreeCache.get(key);
}

// GET /api/blame; with full=1 also the working file's text, so the file view needs one request.
// ctx.offload (the hub) compares off the event loop.
async function blameOf(ctx, req, q) {
  const { ws } = worktreeOf(ctx, q.get('worktree'));
  const t = filePath(ws, q.get('path'));
  await ctx.authorizeTarget?.(req, READ, t, ws);
  const b = ctx.offload ? await ctx.offload.blame(ctx.store, ws, t.file) : blame(ctx.store, ws, t.file);
  if (!flag(q, 'full')) return b;
  const now = snapshot(t.abs);
  return { ...b, content: now.buf ? now.buf.toString('utf8') : null };
}

async function files(ctx, req, q) {
  const { ws, workspace } = worktreeOf(ctx, q.get('worktree'));
  const p = q.get('path') ?? '';
  const view = see(ctx, req);
  let t = null;
  try {
    t = resolvePath(ws, p === '' || p.endsWith('/') ? p : `${p}/`);
  } catch {} // the listing refuses the path itself
  if (t) await ctx.authorizeTarget?.(req, READ, t, ws);
  if (flag(q, 'recursive')) {
    const all = workspace.listAll(p);
    return view ? { ...all, files: all.files.filter((f) => view(f.path)) } : all;
  }
  const list = workspace.list(p);
  return view ? list.filter((e) => view(e.path, e.type)) : list;
}

async function history(ctx, req, q) {
  const { ws } = worktreeOf(ctx, q.get('worktree'));
  const t = filePath(ws, q.get('path'));
  await ctx.authorizeTarget?.(req, READ, t, ws);
  return fileHistory(ctx.store, ws, t.file.key);
}

function overview({ store, ws, publicRoot = null }, runs = listRuns(store), view = null) {
  const leases = store.leases().filter((l) => !view || view(l.path)).map((l) => ({
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
  return {
    repo: ws.repo,
    // A hosted engine (the hub) names its mount, never its folder.
    root: publicRoot ?? slash(ws.root),
    worktrees: publicRoot ? worktrees(ws).map((w) => ({ ...w, root: publicRoot })) : worktrees(ws),
    agents,
    leases,
    counts: { agents: agents.length, leases: leases.length, runs: runs.length, unreviewed: runs.filter((r) => r.review.status === 'pending').length },
    worktree: ws.worktree,
  };
}

async function undoRun(ctx, req, run, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Send a JSON object: { "turn": null, "apply": false }.');
  const turn = body.turn ?? null;
  if (turn !== null && !(Number.isInteger(turn) && turn >= 0)) throw badRequest('turn must be null or a whole number.');
  if (body.apply !== undefined && typeof body.apply !== 'boolean') throw badRequest('apply must be true or false.');
  run = await authorizeRun(ctx, req, run, turn);
  const who = actor(req, ctx);
  let plan;
  try {
    plan = planUndo(ctx.store, run, { turn, actor: who });
  } catch (err) {
    if (/^No run matches|has no recorded changes/.test(err.message)) throw notFound(err.message);
    if (/matches \d+ runs/.test(err.message)) throw badRequest(err.message);
    throw err;
  }
  if (body.apply) {
    const apply = (p) => {
      const done = applyUndo(ctx.store, p, who);
      if (changedAny(done)) autoApprove(ctx.store, done.undoRun, who);
      return done;
    };
    plan = ctx.offload ? await ctx.offload.ensure(() => undoPairs(plan), () => apply(plan)) : apply(plan);
  }
  const out = planJson(plan, !!body.apply);
  if (ctx.publicRoot) out.files = out.files.map((f) => ({ ...f, root: ctx.publicRoot }));
  // The hub's SaaS connectors push the reverted files on (src/server/after-write.js).
  if (body.apply && ctx.afterWrites) {
    const changed = plan.files.filter((f) => ['revert', 'delete', 'restore'].includes(f.action)).map((f) => ({ path: f.path, sha: f.end?.sha ?? null }));
    const saas = changed.length ? await ctx.afterWrites(changed, { run: plan.undoRun, kind: 'undo' }) : null;
    if (saas) out.saas = saas;
  }
  return out;
}

// POST /api/files/restore { path, sha, worktree?, apply = true, expect? }.
// apply: false only plans; both answer with the diff from the current file to the version.
async function restore(ctx, req, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Send a JSON object: { "path": "src/app.js", "sha": "…" }.');
  if (typeof body.sha !== 'string') throw badRequest('sha must be a string: a version from GET /api/files/history.');
  if (body.apply !== undefined && typeof body.apply !== 'boolean') throw badRequest('apply must be true or false.');
  if (body.expect !== undefined && body.expect !== null && typeof body.expect !== 'string') throw badRequest('expect must be the current sha, or null for no file.');
  const { ws } = worktreeOf(ctx, body.worktree);
  const t = filePath(ws, body.path);
  await ctx.authorizeTarget?.(req, ACT, t, ws);
  // Like /fs: files that run code by themselves are not written over HTTP.
  guardSensitiveWrite(ws, t.rel, ctx.env, t.abs);
  const who = actor(req, ctx);
  const apply = body.apply !== false;
  const act = () => {
    const p = planRestore(ctx.store, ws, t.file, body.sha, { actor: who });
    return apply ? applyRestore(ctx.store, ws, p, who, { expect: body.expect }) : p;
  };
  // The hub counts the lines of the current file against the version first.
  const plan = ctx.offload ? await ctx.offload.ensure(() => restorePairs(ctx.store, t, body.sha), act) : act();
  const known = plan.now.sha === null || plan.now.buf !== null;
  const diff = known ? (ctx.offload ? (await ctx.offload.diff(plan.now.buf, plan.version.buf)).diff : diffJson(plan.now.buf, plan.version.buf).diff) : null;
  const applied = apply && plan.action !== 'nothing';
  const saas = applied && ctx.afterWrites ? await ctx.afterWrites([{ path: plan.path, sha: plan.sha }], { run: plan.run, kind: 'restore' }) : null;
  return restoreJson(plan, applied, { worktree: ws.worktree, diff, ...(saas ? { saas } : {}) });
}

async function review(ctx, req, run, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Send a JSON object: { "status": "approved" }.');
  if (!REVIEW.has(body.status)) throw badRequest('status must be "pending", "approved" or "rejected".');
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') throw badRequest('note must be a string.');
  if (body.note && body.note.length > MAX_NOTE) throw badRequest(`note is over ${MAX_NOTE} characters.`);
  const id = await authorizeRun(ctx, req, run);
  return await setReview(ctx.store, id, body.status, { note: body.note || null, by: actor(req, ctx) });
}

async function branch(ctx, req, run) {
  await readJson(req); // no options yet; a malformed body is still an error
  const id = await authorizeRun(ctx, req, run);
  return await createBranch(ctx.store, ctx.ws, id, { by: actor(req, ctx) });
}

// [method, path parts (":run" matches one segment), handler(ctx, req, res, params, query)]
const ROUTES = [
  ['GET', ['overview'], async (ctx, req) => overview(ctx, scopedRuns(ctx, see(ctx, req), await allRuns(ctx)), see(ctx, req))],
  ['GET', ['runs'], async (ctx, req) => scopedRuns(ctx, see(ctx, req), await allRuns(ctx))],
  ['GET', ['runs', ':run'], async (ctx, req, res, p) => {
    const run = runFor(ctx, req, p.run);
    return scopedDetail(await (ctx.offload ? ctx.offload.runDetail(ctx.store, run) : runDetail(ctx.store, run)), see(ctx, req));
  }],
  ['GET', ['blame'], (ctx, req, res, p, q) => blameOf(ctx, req, q)],
  ['GET', ['files'], (ctx, req, res, p, q) => files(ctx, req, q)],
  ['GET', ['files', 'history'], (ctx, req, res, p, q) => history(ctx, req, q)],
  ['GET', ['files', 'version'], (ctx, req, res, p, q) => version(ctx, req, res, q)],
  ['GET', ['files', 'changes'], (ctx, req, res, p, q) => changesFeed(ctx, req, q)],
  ['GET', ['events'], (ctx, req, res, p, q) => {
    const view = see(ctx, req);
    const events = eventsAfter(ctx.store, int(q, 'after', 0), int(q, 'limit', 100, { min: 1, max: 1000 }), { latest: q.get('latest') === '1' });
    return view ? scopedEvents(() => visibleRuns(ctx, view), view, events) : events;
  }],
  ['GET', ['stream'], (ctx, req, res) => ctx.stream.attach(req, res)],
  ['POST', ['runs', ':run', 'undo'], async (ctx, req, res, p) => undoRun(ctx, req, p.run, await readJson(req))],
  ['POST', ['runs', ':run', 'branch'], async (ctx, req, res, p) => branch(ctx, req, p.run)],
  ['POST', ['runs', ':run', 'review'], async (ctx, req, res, p) => review(ctx, req, p.run, await readJson(req))],
  ['POST', ['files', 'restore'], async (ctx, req) => restore(ctx, req, await readJson(req))],
];

// GET /api/files/changes?after=<id>&limit=500: the changes feed for folder sync.
// The cursor moves past changes the caller cannot see, so a scoped client
// catches up like any other; it just never hears of them.
function changesFeed(ctx, req, q) {
  const { ws } = worktreeOf(ctx, q.get('worktree'));
  const after = int(q, 'after', 0);
  const changes = changesAfter(ctx.store, ws, after, int(q, 'limit', 500, { min: 1, max: 1000 }));
  const view = see(ctx, req);
  return { changes: view ? changes.filter((c) => view(c.path)) : changes, cursor: changes.length ? changes.at(-1).id : after };
}

const allRuns = (ctx) => (ctx.offload ? ctx.offload.runs(ctx.store) : listRuns(ctx.store));

async function version(ctx, req, res, q) {
  const sha = q.get('sha') ?? '';
  if (!/^[0-9a-f]{40}$/.test(sha)) throw badRequest('sha must be 40 lowercase hex characters.');
  // A scoped caller gets only versions of files it may read.
  if (see(ctx, req)) await ctx.authorize(req, { ...READ, paths: pathsOfVersion(ctx.store, sha), recorded: true });
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
