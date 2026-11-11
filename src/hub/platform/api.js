// The REST API under /v1 (docs/platform.md, "REST API"), with
// Authorization: Bearer gpk_live_... or gpk_test_....
//
// Every route goes through run() below, in this order:
//   key (401) -> per-key token bucket (429) -> body (JSON, 64 KB) ->
//   Idempotency-Key (POST) -> the handler.
// A key sees only its own platform and its own mode: a test key never sees
// a live workspace and the other way round. Anything else is 404, the same
// as for an id that does not exist. Cookies are never read here, so the API
// cannot be driven cross-site from a browser.
//
// The route table is also the OpenAPI document (openapi.js).

import { undoPairs } from '../../server/offload.js';
import { listRuns, planJson } from '../../server/runs.js';
import { autoApprove } from '../../review.js';
import { applyUndo, changedAny, planUndo } from '../../undo.js';
import { HttpError, readBody, sendJson } from '../http.js';
import { cleanTemplate } from '../templates.js';
import { Router } from '../router.js';
import { randomId, same, sha256 } from '../secure.js';
import { buildOpenApi } from './openapi.js';
import { apiError, cleanOrigin, DAY_MS, dayOf, invalid, limitOf, onlyFields, page, unix } from './util.js';

const MAX_BODY = 64 * 1024;
const MAX_METADATA = 4096;
const TOKEN_TTL = { fallback: 3600, min: 60, max: 30 * 24 * 3600 };
const AGENT_NAME_RE = /^[A-Za-z0-9._-]{1,60}$/;
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;
const HOUR_MS = 60 * 60 * 1000;
// New Idempotency-Keys (rows kept 24 h) per platform per hour: 10 a second.
export const MAX_IDEMPOTENCY_PER_HOUR = 36_000;

export function createApi({ hub, keys, limiter, sealer, metering, events, embeds, webhooks }) {
  const { db, now, config, workspaces } = hub;
  const router = new Router();

  const modeOf = (ws) => (ws.mode === 'test' ? 'test' : 'live');
  const notFound = () => apiError(404, 'not_found', 'No such object.');

  // ---- objects ----

  function writes30d(ws) {
    metering.flush();
    return db.prepare('SELECT COALESCE(SUM(writes), 0) AS n FROM usage_daily WHERE workspace_id = ? AND day >= ?').get(ws.id, dayOf(now() - 29 * DAY_MS)).n;
  }

  function wsJson(ws) {
    let metadata = {};
    try {
      metadata = ws.metadata ? JSON.parse(ws.metadata) : {};
    } catch {}
    const url = `${config.origin}/w/${ws.team_id}/${ws.name}/`;
    return {
      id: ws.id,
      object: 'workspace',
      external_id: ws.external_id ?? null,
      name: ws.name,
      metadata,
      livemode: modeOf(ws) === 'live',
      created_at: unix(ws.created_at),
      // Test workspaces are deleted 7 days after creation (review M10).
      expires_at: modeOf(ws) === 'test' ? unix(ws.created_at + metering.prices.testCaps.workspaceDays * DAY_MS) : null,
      url,
      mcp_url: `${url}mcp`,
      fs_url: `${url}fs/`,
      usage: { bytes: ws.bytes ?? 0, writes_30d: writes30d(ws) },
    };
  }

  // A live workspace of this platform and mode, or 404. Counts as an API call to it.
  function workspaceOf(p, id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw notFound();
    const ws = db.prepare("SELECT * FROM workspaces WHERE id = ? AND team_id = ? AND deleted_at IS NULL AND COALESCE(mode, 'live') = ?").get(id, p.team.id, p.mode);
    if (!ws) throw notFound();
    metering.bump(ws, { apiCalls: 1 });
    return ws;
  }

  const actorOf = (p) => ({ role: 'owner', userId: p.key.created_by });

  function cleanMetadata(m) {
    if (m === null) return null;
    if (typeof m !== 'object' || Array.isArray(m)) throw invalid('metadata must be a JSON object.');
    const text = JSON.stringify(m);
    if (Buffer.byteLength(text) > MAX_METADATA) throw invalid(`metadata is over ${MAX_METADATA} bytes.`);
    return text;
  }

  function cleanExternalId(v) {
    if (typeof v !== 'string' || !v.length || v.length > 255 || /[\x00-\x1f\x7f]/.test(v)) throw invalid('external_id must be 1 to 255 printable characters.');
    return v;
  }

  const randomName = () => `ws-${[...randomId(12)].filter((c) => /[a-z0-9]/.test(c)).join('').slice(0, 10).padEnd(10, '0')}`;

  // ---- handlers ----

  async function createWorkspace(p, rawBody) {
    const body = onlyFields(rawBody, ['external_id', 'name', 'metadata', 'template']);
    const externalId = body.external_id === undefined || body.external_id === null ? null : cleanExternalId(body.external_id);
    const metadata = body.metadata === undefined ? null : cleanMetadata(body.metadata);
    let template;
    try {
      template = cleanTemplate(body.template);
    } catch (err) {
      throw invalid(err.message);
    }
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(p.team.id);
    const mode = p.mode === 'test' ? 'test' : null;
    const check = () => {
      if (mode === 'test' && metering.testWorkspacesLeft(team.id) <= 0) {
        throw apiError(429, 'test_mode_limit', `Test mode allows ${metering.prices.testCaps.workspaces} workspaces. Delete some, or use a live key.`);
      }
      if (externalId && db.prepare("SELECT 1 FROM workspaces WHERE team_id = ? AND COALESCE(mode, 'live') = ? AND external_id = ? AND deleted_at IS NULL").get(team.id, p.mode, externalId)) {
        throw apiError(409, 'external_id_taken', 'A live workspace of this platform already has this external_id.');
      }
    };
    let ws;
    try {
      ws = workspaces.create(team, actorOf(p), body.name ?? randomName(), { externalId, metadata, mode, check });
    } catch (err) {
      if (err instanceof HttpError && err.code === 'bad_request') throw invalid(err.message);
      throw err;
    }
    events.start(ws);
    // Its folders, as the approved run template:<name> (src/hub/templates.js).
    hub.mount.applyTemplate(ws, template, `api:${p.key.name}`);
    await hub.mount.measure(ws).catch(() => {});
    ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(ws.id);
    const out = wsJson(ws);
    webhooks.emit(team, modeOf(ws), 'workspace.created', ws, { workspace: out });
    return out;
  }

  function listWorkspaces(p, q) {
    const limit = limitOf(q);
    const args = [p.team.id, p.mode];
    let where = "team_id = ? AND COALESCE(mode, 'live') = ? AND deleted_at IS NULL";
    const ext = q.get('external_id');
    if (ext !== null) {
      where += ' AND external_id = ?';
      args.push(ext);
    }
    const after = q.get('starting_after');
    if (after) {
      const c = ID_RE.test(after) && db.prepare("SELECT created_at, id FROM workspaces WHERE id = ? AND team_id = ? AND COALESCE(mode, 'live') = ?").get(after, p.team.id, p.mode);
      if (!c) throw invalid('starting_after is not a workspace of this list.');
      where += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
      args.push(c.created_at, c.created_at, c.id);
    }
    const rows = db.prepare(`SELECT * FROM workspaces WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, limit + 1);
    return { object: 'list', data: rows.slice(0, limit).map(wsJson), has_more: rows.length > limit };
  }

  async function updateWorkspace(p, ws, rawBody) {
    const body = onlyFields(rawBody, ['name', 'metadata']);
    if (body.metadata !== undefined) {
      db.prepare('UPDATE workspaces SET metadata = ? WHERE id = ? AND team_id = ?').run(cleanMetadata(body.metadata), ws.id, ws.team_id);
    }
    if (body.name !== undefined && body.name !== ws.name) {
      try {
        workspaces.rename(ws.team_id, ws.id, body.name);
      } catch (err) {
        if (err instanceof HttpError && err.code === 'bad_request') throw invalid(err.message);
        throw err;
      }
      await hub.mount.close(ws.id); // the open engine serves the old address
    }
    return wsJson(db.prepare('SELECT * FROM workspaces WHERE id = ?').get(ws.id));
  }

  async function deleteWorkspace(p, ws) {
    const closed = hub.mount.close(ws.id); // before the move, with no await in between
    workspaces.remove(ws.team_id, ws.id);
    await closed;
    webhooks.emit(p.team, modeOf(ws), 'workspace.deleted', ws, { workspace: { id: ws.id, external_id: ws.external_id ?? null, name: ws.name }, reason: 'deleted' });
    return { id: ws.id, object: 'workspace', deleted: true };
  }

  function createToken(p, ws, rawBody) {
    const body = onlyFields(rawBody, ['scope', 'ttl_seconds', 'agent_name', 'name', 'scopes']);
    if (body.scope !== 'read' && body.scope !== 'write') throw invalid('scope is read or write.');
    const ttl = body.ttl_seconds ?? TOKEN_TTL.fallback;
    if (!Number.isInteger(ttl) || ttl < TOKEN_TTL.min || ttl > TOKEN_TTL.max) throw invalid(`ttl_seconds is a whole number from ${TOKEN_TTL.min} to ${TOKEN_TTL.max} (30 days).`);
    if (body.agent_name !== undefined && (typeof body.agent_name !== 'string' || !AGENT_NAME_RE.test(body.agent_name))) {
      throw invalid('agent_name is 1 to 60 letters, digits, dots, dashes or underscores.');
    }
    const name = body.name ?? `api-${randomId(6)}`;
    const expiresAt = now() + ttl * 1000;
    let t;
    try {
      // scopes: the folders the token is limited to (src/scope.js); validated there.
      t = workspaces.createToken(ws, actorOf(p), name, body.scope, { expiresAt, agentName: body.agent_name ?? null, scopes: body.scopes ?? null });
    } catch (err) {
      if (err instanceof HttpError && err.code === 'bad_request') throw invalid(err.message);
      throw err;
    }
    return { id: t.id, object: 'workspace_token', token: t.token, scope: t.scope, scopes: t.scopes, name: t.name, agent_name: t.agent_name, expires_at: unix(expiresAt) };
  }

  function revokeToken(p, ws, tokenId) {
    try {
      workspaces.revokeToken(ws, actorOf(p), tokenId);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) throw notFound();
      throw err;
    }
    return { id: String(tokenId), object: 'workspace_token', deleted: true };
  }

  // An engine refusal (too_large, busy, storage_limit, test_mode_limit) as
  // this API's error; anything else is ours.
  const fromEngine = (err) => (err && typeof err.status === 'number' && typeof err.code === 'string' && !(err instanceof HttpError) && err.code !== 'internal' ? apiError(err.status, err.code, err.message) : err);

  async function runs(p, ws, q) {
    const engine = hub.mount.engineFor(ws);
    // The in-tree replay runs in the hub's compute pool (src/server/offload.js).
    let status;
    try {
      status = engine.ctx.offload ? await engine.ctx.offload.inTree(engine.store) : undefined;
    } catch (err) {
      throw fromEngine(err);
    }
    return page(listRuns(engine.store, status), q, (r) => r.run);
  }

  async function undo(p, ws, run, rawBody) {
    const body = onlyFields(rawBody, ['turn', 'apply']);
    const turn = body.turn ?? null;
    if (turn !== null && !(Number.isInteger(turn) && turn >= 0)) throw invalid('turn must be null or a whole number.');
    if (body.apply !== undefined && typeof body.apply !== 'boolean') throw invalid('apply must be true or false.');
    const engine = hub.mount.engineFor(ws);
    const store = engine.store;
    const who = `api:${p.key.name}`;
    let plan;
    try {
      plan = planUndo(store, run, { turn, actor: who });
    } catch (err) {
      if (/^No run matches|has no recorded changes/.test(err.message)) throw notFound();
      if (/matches \d+ runs/.test(err.message)) throw invalid(err.message);
      throw err;
    }
    if (body.apply) {
      // An undo writes files like an agent does: test mode's daily write cap
      // and the storage limits apply to it too (review L2).
      metering.checkTestWrite(ws);
      const apply = () => {
        const done = applyUndo(store, plan, who);
        if (changedAny(done)) autoApprove(store, done.undoRun, who);
        return done;
      };
      try {
        hub.mount.admit(ws, plan.files.reduce((n, f) => n + (f.end?.buf?.length ?? 0), 0));
        plan = engine.ctx.offload ? await engine.ctx.offload.ensure(() => undoPairs(plan), apply) : apply();
      } catch (err) {
        throw fromEngine(err);
      } finally {
        hub.mount.measureSoon(ws);
      }
      events.afterActivity(ws, store, { undoneRun: run });
      hub.mount.storage?.touch(workspaces.storageKey(ws));
      // Files under saas/ go back to their service too (src/hub/connectors.js).
      const changed = plan.files.filter((f) => ['revert', 'delete', 'restore'].includes(f.action)).map((f) => ({ path: f.path, sha: f.end?.sha ?? null }));
      const saas = changed.length && engine.ctx.afterWrites ? await engine.ctx.afterWrites(changed, { run: plan.undoRun, kind: 'undo' }) : null;
      if (saas) return { ...planJson(plan, true), saas };
    }
    return planJson(plan, !!body.apply);
  }

  function usage(p, q) {
    const u = metering.usage(p.team.id, p.mode, q);
    const out = page(u.rows, q, (r) => `${r.day ?? ''}|${r.workspace_id ?? ''}`, { fallback: 100, max: 1000 });
    return { ...out, from: u.from, to: u.to };
  }

  // Settings are per mode (review M6): a key reads and writes its own mode's.
  // `storage` (the platform's own bucket, src/hub/team-storage.js) is per team,
  // not per mode: only live keys see it, and only when the hub has storage.
  const settingsJson = (p) => ({
    object: 'platform_settings',
    livemode: p.mode === 'live',
    ...keys.settings(p.team.id, p.mode),
    ...(p.mode === 'live' && hub.teamStorage?.available ? { storage: hub.teamStorage.statusJson(p.team.id) } : {}),
  });
  const maxWorkspaceMb = () => Math.floor((config.platformStorageBytes ?? 20480 * 1024 * 1024) / 1024 / 1024);
  const STORAGE_FIELDS = ['provider', 'bucket', 'prefix', 'endpoint', 'region', 'account', 'access_key_id', 'secret_access_key', 'account_key'];

  async function putSettings(p, rawBody) {
    const body = onlyFields(rawBody, ['embed_allowed_origins', 'workspace_storage_mb', 'storage']);
    if (body.embed_allowed_origins === undefined && body.workspace_storage_mb === undefined && body.storage === undefined) throw invalid('Send embed_allowed_origins, workspace_storage_mb, storage, or several.');
    // A test key cannot move a platform's files (they are the live ones too).
    if (body.storage !== undefined && p.mode !== 'live') throw apiError(403, 'livemode_required', 'storage can only be set with a live key: it applies to every workspace of the platform.');
    if (body.storage !== undefined && body.storage !== null) {
      if (typeof body.storage !== 'object' || Array.isArray(body.storage)) throw invalid('storage is an object, or null for the hub\'s own storage.');
      for (const k of Object.keys(body.storage)) if (!STORAGE_FIELDS.includes(k)) throw invalid(`Unknown field storage.${k.slice(0, 60)}. Allowed: ${STORAGE_FIELDS.join(', ')}.`);
    }
    const patch = {};
    if (body.embed_allowed_origins !== undefined) {
      const list = body.embed_allowed_origins;
      if (!Array.isArray(list) || list.length > 20) throw invalid('embed_allowed_origins is an array of at most 20 origins.');
      const clean = [];
      for (const o of list) {
        const c = cleanOrigin(o);
        if (!c) throw invalid(`${String(o).slice(0, 100)} is not an origin like https://app.example.com (https, no path).`);
        if (!clean.includes(c)) clean.push(c);
      }
      patch.embed_allowed_origins = clean;
    }
    if (body.workspace_storage_mb !== undefined) {
      const mb = body.workspace_storage_mb;
      if (!Number.isInteger(mb) || mb < 1 || mb > maxWorkspaceMb()) throw invalid(`workspace_storage_mb is a whole number from 1 to ${maxWorkspaceMb()} (the platform's own quota).`);
      patch.workspace_storage_mb = mb;
    }
    // Everything else is checked first: a refused probe changes nothing.
    if (body.storage !== undefined) {
      if (!hub.teamStorage?.available) throw apiError(409, 'storage_unavailable', 'Workspace storage is off on this hub.');
      await hub.teamStorage.configure(p.team.id, body.storage, `api:${p.key.id}`);
    }
    if (Object.keys(patch).length) keys.setSettings(p.team.id, p.mode, patch);
    return settingsJson(p);
  }

  // ---- the route table (also the OpenAPI document) ----

  const W = '/v1/workspaces/:id';
  const ROUTES = [
    { method: 'POST', path: '/v1/workspaces', op: 'createWorkspace', summary: 'Create a workspace', body: 'WorkspaceCreate', response: 'Workspace', run: (p, c) => createWorkspace(p, c.body) },
    { method: 'GET', path: '/v1/workspaces', op: 'listWorkspaces', summary: 'List workspaces', query: ['limit', 'starting_after', 'external_id'], response: 'WorkspaceList', run: (p, c) => listWorkspaces(p, c.q) },
    { method: 'GET', path: W, op: 'getWorkspace', summary: 'Get a workspace', response: 'Workspace', ws: true, run: (p, c) => wsJson(c.ws) },
    { method: 'PATCH', path: W, op: 'updateWorkspace', summary: 'Update name and metadata', body: 'WorkspaceUpdate', response: 'Workspace', ws: true, run: (p, c) => updateWorkspace(p, c.ws, c.body) },
    { method: 'DELETE', path: W, op: 'deleteWorkspace', summary: 'Delete a workspace (soft)', response: 'Deleted', ws: true, run: (p, c) => deleteWorkspace(p, c.ws) },
    { method: 'POST', path: `${W}/tokens`, op: 'createWorkspaceToken', summary: 'Mint a workspace token for an agent', body: 'WorkspaceTokenCreate', bodyRequired: true, response: 'WorkspaceToken', ws: true, run: (p, c) => createToken(p, c.ws, c.body) },
    { method: 'DELETE', path: `${W}/tokens/:token_id`, op: 'revokeWorkspaceToken', summary: 'Revoke a workspace token', response: 'Deleted', ws: true, run: (p, c) => revokeToken(p, c.ws, c.params.token_id) },
    { method: 'POST', path: `${W}/embed_sessions`, op: 'createEmbedSession', summary: 'Create a single-use link to the embedded review desk', body: 'EmbedSessionCreate', response: 'EmbedSession', ws: true, run: (p, c) => embeds.create(p, c.ws, c.body) },
    { method: 'GET', path: `${W}/runs`, op: 'listRuns', summary: 'List runs (as GET /api/runs)', query: ['limit', 'starting_after'], response: 'RunList', ws: true, run: (p, c) => runs(p, c.ws, c.q) },
    { method: 'POST', path: `${W}/runs/:run/undo`, op: 'undoRun', summary: 'Plan or apply the undo of a run', body: 'UndoRequest', response: 'UndoPlan', ws: true, run: (p, c) => undo(p, c.ws, c.params.run, c.body) },
    { method: 'GET', path: '/v1/usage', op: 'getUsage', summary: 'Metered usage', query: ['from', 'to', 'group_by', 'usage_limit', 'starting_after'], response: 'Usage', run: (p, c) => usage(p, c.q) },
    { method: 'POST', path: '/v1/webhook_endpoints', op: 'createWebhookEndpoint', summary: 'Create a webhook endpoint (the secret is shown once)', body: 'WebhookEndpointCreate', bodyRequired: true, response: 'WebhookEndpoint', run: (p, c) => webhooks.create(p.team.id, p.mode, onlyFields(c.body, ['url', 'events'])) },
    { method: 'GET', path: '/v1/webhook_endpoints', op: 'listWebhookEndpoints', summary: 'List webhook endpoints', query: ['limit', 'starting_after'], response: 'WebhookEndpointList', run: (p, c) => page(webhooks.list(p.team.id, p.mode).map((e) => webhooks.endpointJson(e)), c.q, (e) => e.id) },
    {
      method: 'GET',
      path: '/v1/webhook_endpoints/:endpoint',
      op: 'getWebhookEndpoint',
      summary: 'Get a webhook endpoint',
      response: 'WebhookEndpoint',
      run: (p, c) => {
        const e = webhooks.get(p.team.id, p.mode, c.params.endpoint);
        if (!e) throw notFound();
        return webhooks.endpointJson(e);
      },
    },
    {
      method: 'DELETE',
      path: '/v1/webhook_endpoints/:endpoint',
      op: 'deleteWebhookEndpoint',
      summary: 'Delete a webhook endpoint',
      response: 'Deleted',
      run: (p, c) => {
        if (!webhooks.remove(p.team.id, p.mode, c.params.endpoint)) throw notFound();
        return { id: c.params.endpoint, object: 'webhook_endpoint', deleted: true };
      },
    },
    { method: 'GET', path: '/v1/settings', op: 'getSettings', summary: "The settings of the key's mode", response: 'Settings', run: (p) => settingsJson(p) },
    { method: 'PUT', path: '/v1/settings', op: 'updateSettings', summary: "Set the key's mode's embedding origins and workspace storage limit", body: 'SettingsUpdate', bodyRequired: true, response: 'Settings', run: (p, c) => putSettings(p, c.body) },
    { method: 'GET', path: '/v1/openapi.json', op: 'getOpenApi', summary: 'This document', public: true, run: () => openapi },
  ];
  const openapi = buildOpenApi(ROUTES, config.origin);

  // ---- the pipeline ----

  async function readJsonBody(req) {
    const raw = (await readBody(req, MAX_BODY)).toString('utf8');
    if (!raw.trim()) return { raw: '', body: {} };
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw invalid('Send Content-Type: application/json.');
    try {
      return { raw, body: JSON.parse(raw) };
    } catch {
      throw invalid('The body is not valid JSON.');
    }
  }

  // Runs fn once per (platform, Idempotency-Key) for 24 h: the same body gets
  // the stored reply, a different one 409. Replies are sealed at rest.
  async function idempotent(ctx, p, raw, fn) {
    const header = ctx.req.headers['idempotency-key'];
    if (ctx.req.method !== 'POST' || header === undefined) return fn();
    if (typeof header !== 'string' || !IDEMPOTENCY_KEY_RE.test(header)) throw invalid('Idempotency-Key must be 1 to 255 printable ASCII characters.');
    const team = p.team.id;
    // Test and live keys have separate namespaces, as their objects do: a test
    // key can neither block nor probe a key the live side used (review L1).
    const key = `${p.mode}:${header}`;
    const hash = sha256(`${p.mode}\n${ctx.req.method} ${ctx.url.pathname}\n${raw}`);
    // The sealed reply is bound to this platform and key: copied into
    // another row, it does not open (review M1).
    const aad = `idempotency\n${team}\n${key}`;
    const t = now();
    db.prepare('DELETE FROM platform_idempotency WHERE team_id = ? AND key = ? AND created_at <= ?').run(team, key, t - DAY_MS);
    const existing = db.prepare('SELECT 1 FROM platform_idempotency WHERE team_id = ? AND key = ?').get(team, key);
    // Every new key is a row kept for 24 h: bounded per platform (review M7).
    if (!existing && !hub.rate.hit(`idempotency:${team}`, MAX_IDEMPOTENCY_PER_HOUR, HOUR_MS)) {
      throw new HttpError(429, 'rate_limited', `At most ${MAX_IDEMPOTENCY_PER_HOUR} new Idempotency-Keys an hour per platform. Retry later, or send fewer keys.`, { retryAfter: hub.rate.retryAfter(`idempotency:${team}`) });
    }
    const fresh = !existing && db.prepare('INSERT OR IGNORE INTO platform_idempotency (team_id, key, request_hash, created_at) VALUES (?, ?, ?, ?)').run(team, key, hash, t).changes;
    if (!fresh) {
      const row = db.prepare('SELECT * FROM platform_idempotency WHERE team_id = ? AND key = ?').get(team, key);
      if (!same(row.request_hash, hash)) throw apiError(409, 'idempotency_mismatch', 'This Idempotency-Key was used with a different request in the last 24 hours.');
      if (row.status === null) throw apiError(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still running. Retry in a moment.');
      const body = sealer.open(row.body, aad);
      if (body === null) throw apiError(409, 'idempotency_mismatch', 'The stored reply for this Idempotency-Key cannot be read. Use a new key.');
      return { status: row.status, body: JSON.parse(body), replayed: true };
    }
    const keep = (status, body) => db.prepare('UPDATE platform_idempotency SET status = ?, body = ? WHERE team_id = ? AND key = ?').run(status, sealer.seal(JSON.stringify(body), aad), team, key);
    try {
      const out = await fn();
      keep(out.status, out.body);
      return out;
    } catch (err) {
      // A refusal is the answer for good; a failure on our side may be retried.
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) keep(err.status, { error: { code: err.code, message: err.message, request_id: ctx.requestId } });
      else db.prepare('DELETE FROM platform_idempotency WHERE team_id = ? AND key = ?').run(team, key);
      throw err;
    }
  }

  function authenticate(ctx) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(String(ctx.req.headers.authorization || ''))?.[1];
    if (!bearer) throw apiError(401, 'unauthorized', 'Send Authorization: Bearer gpk_live_... (or gpk_test_...).');
    const p = keys.authenticate(bearer);
    if (!p) throw apiError(401, 'unauthorized', 'Unknown or revoked platform key.');
    return p;
  }

  async function run(ctx, route) {
    if (route.public) return sendJson(ctx.res, 200, route.run(), { 'Cache-Control': 'public, max-age=300' });
    const p = authenticate(ctx);
    ctx.platform = p;
    const wait = limiter.take(p.key.id);
    if (wait !== true) throw new HttpError(429, 'rate_limited', 'Too many requests for this key: 50 at once, 20 a second sustained.', { retryAfter: wait });
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(ctx.req.method);
    const { raw, body } = hasBody ? await readJsonBody(ctx.req) : { raw: '', body: undefined };
    const c = { body, q: ctx.url.searchParams, params: ctx.params, ws: null };
    const out = await idempotent(ctx, p, raw, async () => {
      if (route.ws) c.ws = workspaceOf(p, ctx.params.id);
      return { status: 200, body: await route.run(p, c) };
    });
    sendJson(ctx.res, out.status, out.body, out.replayed ? { 'Idempotent-Replayed': 'true' } : {});
  }

  for (const r of ROUTES) router.add(r.method, r.path, (ctx) => run(ctx, r), { platform: true, public: !!r.public });

  return { router, routes: ROUTES, openapi, wsJson };
}
