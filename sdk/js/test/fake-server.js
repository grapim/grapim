// An in-process fake of the Grapim hub, as docs/platform.md, docs/workspaces.md
// and docs/api.md describe it: the /v1 platform API (gpk_ keys, Request-Id,
// Idempotency-Key, cursor pagination) and the workspace endpoints under
// /w/<team>/<name>/ (gws_ tokens, /fs with ETag and If-Match, /api/runs, undo,
// blame, files). It is small and in memory; it exists so the SDK tests and the
// examples run without the real server.
//
// Test hooks:
//   fake.requests                every request: { method, path, headers, body }
//   fake.script(match, [steps])  the next requests matching `match` get these
//                                responses instead ({ status, headers, body }),
//                                or { status, after: true } to do the work and
//                                then answer with that status (a lost response)

import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');

export async function startFakeServer({ apiKey = 'gpk_test_fake_key_123' } = {}) {
  let n = 0;
  const next = (p) => `${p}_${String(++n).padStart(6, '0')}`;
  const state = {
    workspaces: new Map(), // id -> workspace
    tokens: new Map(), // token -> { id, wsId, scope, name, agent_name, expires_at, revoked }
    files: new Map(), // wsId -> Map(path -> Buffer)
    changes: new Map(), // wsId -> [{ id, run, label, path, before, after, turn, ts, intent }]
    idem: new Map(), // key -> { hash, status, body }
    webhooks: new Map(),
    settings: {},
  };
  const requests = [];
  const scripts = [];
  let base = '';

  const fake = {
    apiKey,
    state,
    requests,
    get url() { return base; },
    script(match, steps) {
      scripts.push({ match, steps: [...steps] });
    },
    reset() {
      requests.length = 0;
      scripts.length = 0;
    },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };

  const send = (res, status, body, headers = {}) => {
    const h = { 'Request-Id': next('req'), ...headers };
    if (body === undefined || body === null) {
      res.writeHead(status, h);
      return res.end();
    }
    if (Buffer.isBuffer(body)) {
      res.writeHead(status, { 'Content-Type': 'application/octet-stream', ...h });
      return res.end(body);
    }
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', ...h });
    res.end(text);
  };
  const err = (res, status, code, message, extra = {}, headers = {}) =>
    send(res, status, { error: { code, message, request_id: null, ...extra } }, headers);

  function wsPublic(ws) {
    const url = `${base}/w/team_fake/${ws.name}/`;
    const files = state.files.get(ws.id);
    let bytes = 0;
    for (const b of files.values()) bytes += b.length;
    return {
      id: ws.id, object: 'workspace', external_id: ws.external_id, name: ws.name, metadata: ws.metadata,
      created_at: ws.created_at, url, mcp_url: url + 'mcp', fs_url: url + 'fs/',
      usage: { bytes, writes_30d: state.changes.get(ws.id).length },
    };
  }

  function paginate(items, query) {
    const limit = Math.min(100, Math.max(1, Number(query.get('limit') ?? 50)));
    const after = query.get('starting_after');
    let start = 0;
    if (after) {
      const i = items.findIndex((x) => x.id === after);
      start = i < 0 ? items.length : i + 1;
    }
    const data = items.slice(start, start + limit);
    return { object: 'list', data, has_more: start + limit < items.length };
  }

  function runsOf(wsId) {
    const byRun = new Map();
    for (const c of state.changes.get(wsId)) {
      if (!byRun.has(c.run)) {
        byRun.set(c.run, {
          run: c.run, label: c.label, worktree: 'workspace', intent: c.intent ?? null, turns: 0, files: 0, added: 0, removed: 0,
          in_tree: 'all', first_ts: c.ts, last_ts: c.ts, active: true, paths: new Set(), turnSet: new Set(),
          review: c.run.startsWith('undo:') ? { status: 'approved', note: 'automatic', at: c.ts, by: c.actor } : { status: 'pending', note: null, at: null, by: null },
          branch: null,
        });
      }
      const r = byRun.get(c.run);
      r.paths.add(c.path);
      r.turnSet.add(c.turn);
      r.last_ts = c.ts;
    }
    return [...byRun.values()]
      .map(({ paths, turnSet, ...r }) => ({ ...r, files: paths.size, turns: turnSet.size }))
      .sort((a, b) => b.last_ts - a.last_ts);
  }

  function record(wsId, run, label, path, before, after, intent, actor) {
    const list = state.changes.get(wsId);
    const prior = list.filter((c) => c.run === run);
    const lastIntent = prior.length ? prior[prior.length - 1].intent : undefined;
    const lastTurn = prior.length ? prior[prior.length - 1].turn : 0;
    const turn = prior.length === 0 || (intent && intent !== lastIntent) ? lastTurn + 1 : lastTurn;
    list.push({ id: list.length + 1, run, label, path, before, after, turn, ts: Date.now() + list.length, intent: intent ?? lastIntent ?? null, actor });
  }

  function undo(wsId, run, turn, apply, actor) {
    const changes = state.changes.get(wsId).filter((c) => c.run === run && (turn == null || c.turn === turn));
    if (changes.length === 0) return null;
    const files = state.files.get(wsId);
    const firstBefore = new Map();
    for (const c of changes) if (!firstBefore.has(c.path)) firstBefore.set(c.path, c.before);
    const plan = [...firstBefore].map(([path, before]) => ({
      path, root: 'workspace', action: before === null ? 'delete' : 'restore', reason: null, before,
    }));
    if (apply) {
      const undoRun = `undo:${Date.now()}`;
      for (const p of plan) {
        const now = files.get(p.path) ?? null;
        if (p.before === null) files.delete(p.path);
        else files.set(p.path, p.before);
        record(wsId, undoRun, `undo ${run}`, p.path, now, p.before, null, actor);
      }
    }
    return { applied: !!apply, run, label: changes[0].label, turn: turn ?? null, files: plan.map(({ before, ...p }) => p) };
  }

  // ------------------------------------------------------------- /v1

  async function v1(req, res, url, body) {
    if (req.headers.authorization !== `Bearer ${apiKey}`) return err(res, 401, 'unauthorized', 'Invalid API key.');
    const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // drop "v1"
    const m = req.method;
    let json = null;
    if (body.length) {
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        return err(res, 400, 'bad_request', 'Body is not JSON.');
      }
    }

    // Idempotency for POSTs.
    const key = req.headers['idempotency-key'];
    const hash = sha1(body);
    if (m === 'POST' && key) {
      const seen = state.idem.get(key);
      if (seen) {
        if (seen.hash !== hash) return err(res, 409, 'idempotency_mismatch', 'This Idempotency-Key was used with a different body.');
        return send(res, seen.status, seen.body, { 'Idempotent-Replayed': 'true' });
      }
    }
    const reply = (status, out) => {
      if (m === 'POST' && key) state.idem.set(key, { hash, status, body: out });
      return { status, out };
    };

    const r = route();
    if (!r) return err(res, 404, 'not_found', 'No such route.');
    if (r.error) return err(res, r.status, r.error, r.message);
    return r;

    function route() {
      const [a, id, b, sub, c] = parts;
      if (a === 'workspaces' && !id) {
        if (m === 'POST') {
          const ws = {
            id: next('ws'), external_id: json?.external_id ?? null,
            name: json?.name ?? `ws-${n}`, metadata: json?.metadata ?? {}, created_at: Date.now(), deleted: false,
          };
          if (ws.external_id && [...state.workspaces.values()].some((w) => !w.deleted && w.external_id === ws.external_id)) {
            return { status: 409, error: 'conflict', message: 'external_id already used.' };
          }
          state.workspaces.set(ws.id, ws);
          state.files.set(ws.id, new Map());
          state.changes.set(ws.id, []);
          return reply(200, wsPublic(ws));
        }
        if (m === 'GET') {
          const ext = url.searchParams.get('external_id');
          const all = [...state.workspaces.values()].filter((w) => !w.deleted && (!ext || w.external_id === ext)).map(wsPublic);
          return { status: 200, out: paginate(all, url.searchParams) };
        }
      }
      if (a === 'workspaces' && id) {
        const ws = state.workspaces.get(id);
        if (!ws || ws.deleted) return { status: 404, error: 'not_found', message: `No workspace ${id}.` };
        if (!b) {
          if (m === 'GET') return { status: 200, out: wsPublic(ws) };
          if (m === 'PATCH') {
            if (json?.name !== undefined) ws.name = json.name;
            if (json?.metadata !== undefined) ws.metadata = json.metadata;
            return { status: 200, out: wsPublic(ws) };
          }
          if (m === 'DELETE') {
            ws.deleted = true;
            return { status: 200, out: { id, object: 'workspace', deleted: true } };
          }
        }
        if (b === 'tokens' && !sub && m === 'POST') {
          const scope = json?.scope;
          if (scope !== 'read' && scope !== 'write') return { status: 400, error: 'bad_request', message: 'scope must be read or write.' };
          const ttl = json?.ttl_seconds ?? 3600;
          const token = 'gws_' + randomBytes(16).toString('hex');
          const t = { id: next('tok'), wsId: id, scope, name: `tok-${n}`, agent_name: json?.agent_name ?? null, expires_at: Date.now() + ttl * 1000, revoked: false };
          state.tokens.set(token, t);
          return reply(200, { id: t.id, token, expires_at: t.expires_at, scope });
        }
        if (b === 'tokens' && sub && m === 'DELETE') {
          const t = [...state.tokens.values()].find((x) => x.id === sub && x.wsId === id);
          if (!t) return { status: 404, error: 'not_found', message: 'No such token.' };
          t.revoked = true;
          return { status: 200, out: { id: sub, object: 'token', deleted: true } };
        }
        if (b === 'embed_sessions' && m === 'POST') {
          const mode = json?.mode;
          if (mode !== 'review' && mode !== 'readonly') return { status: 400, error: 'bad_request', message: 'mode must be review or readonly.' };
          const ttl = Math.min(3600, json?.ttl_seconds ?? 600);
          return reply(200, { url: `${base}/embed/${randomBytes(12).toString('hex')}`, expires_at: Date.now() + ttl * 1000 });
        }
        if (b === 'runs' && !sub && m === 'GET') return { status: 200, out: runsOf(id) };
        if (b === 'runs' && sub && c === 'undo' && m === 'POST') {
          const u = undo(id, sub, json?.turn ?? null, json?.apply === true, 'platform');
          if (!u) return { status: 404, error: 'not_found', message: `No run ${sub}.` };
          return reply(200, u);
        }
      }
      if (a === 'usage' && m === 'GET') {
        const data = [...state.workspaces.values()].map((w) => ({
          workspace_id: w.id, external_id: w.external_id, day: url.searchParams.get('from') ?? '2026-11-11',
          writes: state.changes.get(w.id).length, api_calls: 0, storage_byte_days: 0, active: state.changes.get(w.id).length > 0,
        }));
        return { status: 200, out: { data, query: Object.fromEntries(url.searchParams) } };
      }
      if (a === 'webhook_endpoints') {
        if (!id && m === 'POST') {
          if (!/^https:\/\//.test(json?.url ?? '')) return { status: 400, error: 'bad_request', message: 'url must be https.' };
          const ep = { id: next('we'), object: 'webhook_endpoint', url: json.url, events: json.events ?? [] };
          state.webhooks.set(ep.id, ep);
          return reply(200, { ...ep, secret: 'whsec_' + randomBytes(24).toString('hex') });
        }
        if (!id && m === 'GET') return { status: 200, out: paginate([...state.webhooks.values()], url.searchParams) };
        if (id && m === 'DELETE') {
          if (!state.webhooks.delete(id)) return { status: 404, error: 'not_found', message: 'No such endpoint.' };
          return { status: 200, out: { id, deleted: true } };
        }
      }
      if (a === 'settings' && m === 'PUT') {
        Object.assign(state.settings, json ?? {});
        return { status: 200, out: { ...state.settings } };
      }
      return null;
    }
  }

  // ------------------------------------------------------------- /w/<team>/<name>/

  function wsRoute(req, res, url, body) {
    const m = /^\/w\/team_fake\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const ws = m && [...state.workspaces.values()].find((w) => !w.deleted && w.name === m[1]);
    if (!ws) return err(res, 404, 'not_found', 'No such workspace.');
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!auth) return err(res, 401, 'unauthorized', 'No credentials.');
    const tok = state.tokens.get(auth);
    if (!tok || tok.revoked || tok.wsId !== ws.id || tok.expires_at < Date.now()) return err(res, 401, 'unauthorized', 'Unknown or revoked token.');
    const rest = m[2] ?? '/';
    const files = state.files.get(ws.id);
    const writes = req.method !== 'GET' && req.method !== 'HEAD';
    if (writes && tok.scope !== 'write') return err(res, 403, 'forbidden', 'A read token cannot write.');
    const agentHeader = req.headers['x-grapim-agent'];
    const agent = tok.agent_name ?? agentHeader;
    const run = agent ? `http:${tok.name}/${agent}` : `http:${tok.name}`;
    const label = agent ?? tok.name;
    const intent = req.headers['x-grapim-intent'];

    if (rest.startsWith('/fs/')) {
      const raw = rest.slice(4);
      const p = decodeURIComponent(raw);
      if (p.split('/').some((s) => s === '..' || s === '.')) return err(res, 400, 'bad_request', 'Refused path.');
      if (req.method === 'GET' && (p === '' || p.endsWith('/'))) {
        const prefix = p;
        const seen = new Map();
        for (const [fp, buf] of files) {
          if (!fp.startsWith(prefix)) continue;
          const tail = fp.slice(prefix.length);
          const slash = tail.indexOf('/');
          if (slash < 0) seen.set(tail, { name: tail, path: fp, type: 'file', size: buf.length, last_change: null, held_by: null });
          else seen.set(tail.slice(0, slash), { name: tail.slice(0, slash), path: prefix + tail.slice(0, slash), type: 'dir', size: 0, last_change: null, held_by: null });
        }
        return send(res, 200, [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)));
      }
      if (p === '_release' && req.method === 'POST') return send(res, 200, { released: [], recorded: [] });
      const cur = files.get(p) ?? null;
      if (req.method === 'GET') {
        if (!cur) return err(res, 404, 'not_found', `No file ${p}.`);
        return send(res, 200, cur, { ETag: `"${sha1(cur)}"` });
      }
      const im = req.headers['if-match'];
      if (im !== undefined) {
        const want = /^"([^"]*)"$/.exec(im)?.[1] ?? im;
        if (want !== 'absent' && !/^[0-9a-f]{40}$/.test(want)) return err(res, 400, 'bad_request', 'Bad If-Match.');
        const is = cur ? sha1(cur) : null;
        const ok = want === 'absent' ? is === null : is === want;
        if (!ok) {
          if (req.method === 'DELETE' && want === 'absent' && !cur) return err(res, 404, 'not_found', `No file ${p}.`);
          return err(res, 412, 'precondition_failed', `${p} changed.`, { current_sha: is });
        }
      }
      if (req.method === 'PUT') {
        if (!agentHeader && !tok.agent_name) return err(res, 400, 'bad_request', 'X-Grapim-Agent is required for writes.');
        files.set(p, body);
        record(ws.id, run, label, p, cur, body, intent, run);
        const s = sha1(body);
        return send(res, 200, { path: p, sha: s, added: 1, removed: cur ? 1 : 0 }, { ETag: `"${s}"` });
      }
      if (req.method === 'DELETE') {
        if (!cur) return err(res, 404, 'not_found', `No file ${p}.`);
        files.delete(p);
        record(ws.id, run, label, p, cur, null, intent, run);
        return send(res, 200, { path: p, sha: null, added: 0, removed: 1 });
      }
      return err(res, 405, 'method_not_allowed', 'Method not allowed.');
    }
    if (rest === '/api/files' && req.method === 'GET') {
      const prefix = url.searchParams.get('path') ?? '';
      const list = [...files].filter(([fp]) => fp.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([fp, buf]) => ({ name: fp.split('/').pop(), path: fp, type: 'file', size: buf.length, last_change: null, held_by: null }));
      return send(res, 200, url.searchParams.get('recursive') === '1' ? { files: list, truncated: false } : list);
    }
    if (rest === '/api/blame' && req.method === 'GET') {
      const p = url.searchParams.get('path');
      const cur = files.get(p);
      const last = [...state.changes.get(ws.id)].reverse().find((c) => c.path === p);
      const lines = cur ? cur.toString('utf8').split('\n').filter((l, i, a) => i < a.length - 1 || l !== '').map((text, i) => ({ line: i + 1, text, run: last?.run ?? null, label: last?.label ?? null, turn: last?.turn ?? null, ts: last?.ts ?? null })) : [];
      const out = { path: p, base: 'HEAD', changes: state.changes.get(ws.id).filter((c) => c.path === p).length, exists: !!cur, untracked: false, lines, removed: 0 };
      if (url.searchParams.get('full') === '1') out.content = cur ? cur.toString('utf8') : null;
      return send(res, 200, out);
    }
    if (rest === '/api/runs' && req.method === 'GET') return send(res, 200, runsOf(ws.id));
    const um = /^\/api\/runs\/([^/]+)\/undo$/.exec(rest);
    if (um && req.method === 'POST') {
      const j = body.length ? JSON.parse(body.toString('utf8')) : {};
      const u = undo(ws.id, decodeURIComponent(um[1]), j.turn ?? null, j.apply === true, agentHeader ? `http:${agentHeader}` : run);
      if (!u) return err(res, 404, 'not_found', 'No such run.');
      return send(res, 200, u);
    }
    const rm = /^\/api\/runs\/([^/]+)$/.exec(rest);
    if (rm && req.method === 'GET') {
      const r = runsOf(ws.id).find((x) => x.run === decodeURIComponent(rm[1]));
      if (!r) return err(res, 404, 'not_found', 'No such run.');
      return send(res, 200, { run: r, turns: [], files: [] });
    }
    return err(res, 404, 'not_found', 'No such route.');
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://fake');
    requests.push({ method: req.method, path: url.pathname, query: url.search, headers: { ...req.headers }, body });

    const s = scripts.find((x) => (typeof x.match === 'function' ? x.match(req, url) : url.pathname.startsWith(x.match)) && x.steps.length);
    const step = s?.steps.shift();
    if (step && !step.after) {
      return send(res, step.status, step.body ?? { error: { code: step.code ?? 'internal', message: 'scripted' } }, step.headers ?? {});
    }
    // A scripted "lost response": do the work, then answer with the scripted status.
    const out = step?.after ? { writeHead() {}, end() {} } : res;
    try {
      if (url.pathname.startsWith('/v1/')) {
        const r = await v1(req, out, url, body);
        if (r && !r.error && r.status) send(out, r.status, r.out);
      } else if (url.pathname.startsWith('/w/')) {
        wsRoute(req, out, url, body);
      } else {
        err(out, 404, 'not_found', 'No such route.');
      }
    } catch (e) {
      err(out, 500, 'internal', String(e?.stack ?? e));
    }
    if (step?.after) send(res, step.status, { error: { code: step.code ?? 'internal', message: 'scripted after the work' } }, step.headers ?? {});
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return fake;
}
