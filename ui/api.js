// Talks to `grapim serve` (docs/api.md), or to the fixtures in mock mode.
// Mock mode: `?mock=1`, or the API is not reachable (for example when the UI
// is served by ui/dev-server.mjs). Live updates: SSE `/api/stream` sends a
// tick when the event log grows; whoever is listening refetches.

export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------- token
// When the server has GRAPIM_TOKEN set, the desk is opened once as
// /?token=…. The token moves to sessionStorage (this tab only, gone when it
// closes) and out of the address bar at once, before anything else reads the
// URL; it is never put in localStorage or in a URL again. Every request then
// sends it as Authorization: Bearer.
const TOKEN_KEY = 'grapim.token';
let token = null;
(function takeToken() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl !== null) {
    url.searchParams.delete('token');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
    token = fromUrl || null;
    try { if (token) sessionStorage.setItem(TOKEN_KEY, token); else sessionStorage.removeItem(TOKEN_KEY); } catch {}
    return;
  }
  try { token = sessionStorage.getItem(TOKEN_KEY); } catch {}
})();
const auth = () => (token ? { authorization: `Bearer ${token}` } : {});

// ---------------------------------------------------------------- base path
// `grapim serve` serves the desk at /, the cloud hub at /w/<team>/<workspace>/.
// Every request is relative to the folder the page was loaded from, never a
// fixed path: "/w/acme/docs/" -> "/w/acme/docs/api/overview".
export const BASE = location.pathname.replace(/[^/]*$/, '') || '/';
const at = (p) => `${BASE}${p}`;

// The hub signs in with a cookie, so a write from the desk must also prove it
// comes from the desk: the hub sends a per-session token in X-Grapim-Csrf on
// its responses (other sites cannot read them) and wants it back on every
// write. `grapim serve` sends none and wants none.
let csrf = null;
const keepCsrf = (res) => {
  const c = res.headers.get('x-grapim-csrf');
  if (c) csrf = c;
};
const csrfHeader = (method) => (csrf && method !== 'GET' && method !== 'HEAD' ? { 'x-grapim-csrf': csrf } : {});

const listeners = new Set();
const statusListeners = new Set();
export const conn = { mode: 'live', state: 'connecting', reason: null };

function setState(state) {
  conn.state = state;
  for (const fn of statusListeners) fn(conn);
}
export const onStatus = (fn) => (statusListeners.add(fn), () => statusListeners.delete(fn));
export const onTick = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const tick = (data) => { for (const fn of listeners) fn(data); };

// ---------------------------------------------------------------- live

const enc = encodeURIComponent;

// Plain words for each error code in docs/api.md. The server's own message
// comes first when it has one; this adds what to do about it. A workspace on
// the hub (/w/<team>/<name>/) is not run by `grapim serve`, so it gets its own words.
export const CLOUD = /^\/w\/[^/]+\/[^/]+\//.test(location.pathname);
const ADVICE = CLOUD ? {
  unauthorized: 'Your sign-in to the hub ended. Reload the page to sign in again.',
  forbidden: 'You don’t have access to do this in this workspace. A team admin can change your role.',
  method_not_allowed: 'The hub does not support that action for this workspace.',
  too_large: 'That request was too large for the hub.',
  busy: 'An agent is in the middle of writing. Try again in a moment.',
  internal: 'The hub hit an error. Try again; if it keeps happening, tell your team admin.',
} : {
  unauthorized: 'This server needs its token. Open the desk once as `/?token=<GRAPIM_TOKEN>`; this tab keeps it until you close it.',
  forbidden: 'The server refused this request because of where it came from. Open the desk at the exact address `grapim serve` printed (for example http://127.0.0.1:7420).',
  method_not_allowed: 'This version of the server does not support that action. Update Grapim and restart `grapim serve`.',
  too_large: 'That request was too large for the server.',
  busy: 'An agent is in the middle of writing, or the database was locked. Try again in a moment.',
  internal: 'The server hit an internal error. The terminal running `grapim serve` has the details.',
};

async function request(method, url, body, attempt = 0) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...auth(), ...csrfHeader(method), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('offline', CLOUD
      ? 'Can’t reach Grapim. Check your connection; the desk reconnects by itself.'
      : 'Can’t reach the Grapim server. Check that `grapim serve` is still running in your repo.');
  }
  keepCsrf(res);
  const type = res.headers.get('content-type') || '';
  if (!res.ok) {
    let msg = '';
    let code = { 400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed', 409: 'conflict', 413: 'too_large', 503: 'busy' }[res.status] || 'internal';
    if (type.includes('json')) {
      const j = await res.json().catch(() => null);
      if (j?.error) { msg = j.error.message || ''; code = j.error.code || code; }
    }
    // Busy is temporary: reads wait for Retry-After and try again, twice at most.
    if (code === 'busy' && method === 'GET' && attempt < 2) {
      const wait = Math.min(5, Number(res.headers.get('retry-after')) || 1);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return request(method, url, body, attempt + 1);
    }
    const advice = ADVICE[code];
    const text = [msg && msg.replace(/\s*$/, '').replace(/([^.!?])$/, '$1.'), advice].filter(Boolean).join(' ') || `The server answered ${res.status}.`;
    throw new ApiError(code, text, res.status);
  }
  if (type.includes('json')) return res.json();
  return res.text();
}

// ?worktree=… only when one is picked: the server's own worktree is the default.
const wtq = (worktree) => (worktree ? `&worktree=${enc(worktree)}` : '');

const live = {
  // The first call takes the answer init() already fetched to find the server.
  overview: () => {
    const p = primed;
    primed = null;
    return p && Date.now() - p.at < 5000 ? Promise.resolve(p.body) : request('GET', at('api/overview'));
  },
  runs: () => request('GET', at('api/runs')),
  run: (id) => request('GET', at(`api/runs/${enc(id)}`)),
  // full: also the working file's text as `content`, in the same response.
  blame: (p, { full = false, worktree = null } = {}) => request('GET', at(`api/blame?path=${enc(p)}${full ? '&full=1' : ''}${wtq(worktree)}`)),
  // recursive: { files: [every file below p], truncated } instead of one folder.
  files: (p, { recursive = false, worktree = null } = {}) => request('GET', at(`api/files?path=${enc(p)}${recursive ? '&recursive=1' : ''}${wtq(worktree)}`)),
  history: (p, { worktree = null } = {}) => request('GET', at(`api/files/history?path=${enc(p)}${wtq(worktree)}`)),
  version: (sha) => request('GET', at(`api/files/version?sha=${enc(sha)}`)),
  read: (p) => request('GET', at(`fs/${p.split('/').map(enc).join('/')}`)),
  // The file's bytes, for a download (binary files included).
  raw: async (p) => {
    let res;
    try { res = await fetch(at(`fs/${p.split('/').map(enc).join('/')}`), { headers: auth() }); } catch { throw new ApiError('offline', 'Can’t reach the server to download this file.'); }
    if (!res.ok) throw new ApiError(res.status === 404 ? 'not_found' : 'internal', `The server answered ${res.status} for this file.`, res.status);
    return res.blob();
  },
  // apply: false is the plan (with the diff); expect: the current sha the plan showed.
  restore: (p, sha, { apply = true, expect, worktree = null } = {}) =>
    request('POST', at('api/files/restore'), { path: p, sha, apply, ...(expect !== undefined ? { expect } : {}), ...(worktree ? { worktree } : {}) }),
  // after = 0 means "what just happened": the newest `limit` events.
  events: (after = 0, limit = 100) => request('GET', at(`api/events?after=${after}&limit=${limit}${after ? '' : '&latest=1'}`)),
  undo: (id, { turn = null, apply = false } = {}) => request('POST', at(`api/runs/${enc(id)}/undo`), { turn, apply }),
  branch: (id) => request('POST', at(`api/runs/${enc(id)}/branch`), {}),
  review: (id, status, note) => request('POST', at(`api/runs/${enc(id)}/review`), { status, ...(note ? { note } : {}) }),
};

// EventSource cannot send a header, so with a token the stream is read with
// fetch instead: the same `event: tick` messages, parsed by hand.
function streamWithToken() {
  const open = async () => {
    try {
      const res = await fetch(at('api/stream'), { headers: { ...auth(), accept: 'text/event-stream' } });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      setState('live');
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value.replace(/\r\n?/g, '\n');
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const msg = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const ev = /^event: ?(.*)$/m.exec(msg)?.[1];
          const data = msg.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
          if (ev !== 'tick') continue;
          let d = {};
          try { d = JSON.parse(data); } catch {}
          setState('live');
          tick(d);
        }
      }
    } catch {}
    setState('reconnecting');
    setTimeout(open, 2000);
  };
  open();
}

function stream() {
  if (token) return streamWithToken();
  let es;
  const open = () => {
    es = new EventSource(at('api/stream'));
    es.onopen = () => setState('live');
    es.addEventListener('tick', (e) => {
      setState('live');
      let data = {};
      try { data = JSON.parse(e.data); } catch {}
      tick(data);
    });
    es.onerror = () => {
      setState('reconnecting');
      // EventSource retries by itself while the connection is CONNECTING; if it gave up, start again.
      if (es.readyState === EventSource.CLOSED) setTimeout(open, 3000);
    };
  };
  open();
}

// ---------------------------------------------------------------- mock

const TIME_KEYS = new Set(['ts', 'first_ts', 'last_ts', 'last_seen', 'acquired_at', 'expires_at', 'at']);
function shift(value, delta) {
  if (Array.isArray(value)) return value.map((v) => shift(v, delta));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = TIME_KEYS.has(k) && typeof v === 'number' ? v + delta : shift(v, delta);
    return out;
  }
  return value;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => (v === undefined ? v : structuredClone(v));

function createMock() {
  const base = new URL('./fixtures/', import.meta.url);
  let index;
  let delta = 0;
  const cache = new Map();
  const db = { runs: null, details: new Map(), overview: null, events: null, plans: new Map() };

  async function load(route) {
    index ??= fetch(new URL('index.json', base)).then((r) => r.json()).then((ix) => {
      delta = Date.now() - ix.generated_at;
      return ix;
    });
    index = await index;
    const file = index.routes[route];
    if (!file) throw new ApiError('not_found', `Nothing recorded for ${route.replace(/^\w+ /, '')}.`, 404);
    if (!cache.has(file)) {
      cache.set(file, fetch(new URL(file, base)).then(async (r) => {
        if (!r.ok) throw new ApiError('not_found', `Fixture ${file} is missing.`, 404);
        return file.endsWith('.json') ? shift(await r.json(), delta) : r.text();
      }));
    }
    return cache.get(file);
  }

  let ready = null;
  function ensure() {
    return (ready ??= fill());
  }
  async function fill() {
    [db.runs, db.overview, db.events] = await Promise.all([load('GET /api/runs'), load('GET /api/overview'), load('GET /api/events')]);
  }

  function findRun(q) {
    const s = String(q);
    const hit = db.runs.find((r) => r.run === s || r.label === s) ||
      db.runs.find((r) => r.run.replace(/^[^:]+:/, '').startsWith(s) || r.label.split(' ').at(-1).startsWith(s));
    if (!hit) throw new ApiError('not_found', `No run matches “${s}”. It may have been cleaned up; see the Runs list.`, 404);
    return hit;
  }
  async function detail(q) {
    const row = findRun(q);
    if (!db.details.has(row.run)) db.details.set(row.run, await load(`GET /api/runs/${row.run}`));
    const d = db.details.get(row.run);
    d.run = row; // the list row is the source of truth for review, branch and counts
    return d;
  }
  let nextId = 0;
  function event(e) {
    nextId = Math.max(nextId, ...db.events.map((x) => x.id)) + 1;
    db.events.push({ id: nextId, ts: Date.now(), path: null, detail: null, ...e });
  }

  // Quiet background activity, so Live looks like a real afternoon.
  const SCRIPT = [
    { who: 0, kind: 'edit', path: 'test/billing.test.ts', detail: '+6 -0', add: 6 },
    { who: 3, kind: 'claim', path: 'src/checkout/tax.ts', detail: 'Make the checkout tests pass on Node 22' },
    { who: 1, kind: 'blocked', path: 'src/routes.ts', detail: 'held by claude 1a2b3c4d' },
    { who: 2, kind: 'edit', path: 'web/header.css', detail: '+3 -1', add: 3, del: 1 },
    { who: 0, kind: 'edit', path: 'src/billing/invoice.ts', detail: '+2 -1', add: 2, del: 1 },
    { who: 3, kind: 'edit', path: 'test/cart.test.ts', detail: '+4 -0', add: 4 },
    { who: 1, kind: 'intent', detail: 'Run the type checker and fix what the rename broke' },
    { who: 3, kind: 'release', path: 'src/checkout/tax.ts' },
  ];
  let step = 0;
  let timer = null;
  function simulate() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.visibilityState === 'visible' && db.runs) {
        const s = SCRIPT[step++ % SCRIPT.length];
        const a = db.overview.agents[s.who];
        if (a) {
          a.last_seen = Date.now();
          if (s.kind === 'intent') a.intent = s.detail;
          const row = db.runs.find((r) => r.run === a.agent);
          if (row && s.kind === 'edit') {
            row.last_ts = Date.now();
            row.added += s.add || 0;
            row.removed += s.del || 0;
            db.runs.sort((x, y) => y.last_ts - x.last_ts);
          }
          event({ agent: a.agent, label: a.label, kind: s.kind, path: s.path ?? null, detail: s.detail ?? null });
          tick({ last_event_id: nextId });
        }
      }
      simulate();
    }, 6000 + Math.random() * 5000);
  }

  const CLEAN = new Set(['revert', 'delete', 'restore']);
  const DONE = { revert: 'revert', delete: 'delete', restore: 'restore' };

  const api = {
    async overview() {
      await ensure();
      await wait(60);
      const o = clone(db.overview);
      o.counts = { ...o.counts, runs: db.runs.length, unreviewed: db.runs.filter((r) => r.review.status === 'pending').length };
      return o;
    },
    async runs() { await ensure(); await wait(80); return clone(db.runs); },
    async run(id) { await ensure(); await wait(90); return clone(await detail(id)); },
    async blame(p, { full = false } = {}) {
      await wait(70);
      const b = clone(await load(`GET /api/blame?path=${p}`));
      return full ? { ...b, content: await load(`GET /fs/${p}`).catch(() => null) } : b;
    },
    async files(p, { recursive = false } = {}) {
      await wait(50);
      if (!recursive) return clone(await load(`GET /api/files?path=${p}`));
      // The recorded folders, walked like the server would list them.
      const files = [];
      const queue = [p];
      while (queue.length) {
        const dir = queue.shift();
        const items = await load(`GET /api/files?path=${dir}`).catch(() => []);
        for (const it of items) (it.type === 'dir' ? queue.push(`${it.path}/`) : files.push(clone(it)));
      }
      return { files: files.sort((a, b) => a.path.localeCompare(b.path)), truncated: false };
    },
    async restore(p, sha, { apply = true } = {}) {
      await wait(apply ? 400 : 200);
      const [now, version] = await Promise.all([load(`GET /fs/${p}`).catch(() => null), load(`GET /api/files/version?sha=${sha}`)]);
      const plan = { applied: false, path: p, sha, action: now === null ? 'create' : now === version ? 'nothing' : 'replace', reason: null, current_sha: now === null ? null : 'mock', added: null, removed: null, run: null, diff: null };
      if (!apply || plan.action === 'nothing') return plan;
      throw new ApiError('bad_request', 'Sample data can’t be changed. Run `grapim serve` in your repo to restore real files.', 400);
    },
    async history(p) {
      await wait(50);
      try { return clone(await load(`GET /api/files/history?path=${p}`)); } catch (e) { if (e.code === 'not_found') return []; throw e; }
    },
    async version(sha) { await wait(40); return load(`GET /api/files/version?sha=${sha}`); },
    async read(p) { await wait(40); return load(`GET /fs/${p}`); },
    async raw(p) { await wait(40); return new Blob([await load(`GET /fs/${p}`)], { type: 'text/plain' }); },
    async events(after = 0, limit = 100) {
      await ensure();
      await wait(40);
      return clone(db.events.filter((e) => e.id > after).slice(-limit));
    },
    async review(id, status, note) {
      await ensure();
      await wait(240);
      const row = findRun(id);
      row.review = { status, note: note ?? null, at: status === 'pending' ? null : Date.now(), by: 'human:you' };
      event({ agent: row.run, label: row.label, kind: 'review', detail: status, actor: 'human:you' });
      tick({});
      return clone(row.review);
    },
    async branch(id) {
      await ensure();
      await wait(500);
      const d = await detail(id);
      const name = `grapim/${d.run.label.replace(/\s+/g, '-')}`;
      d.run.branch = name;
      const commit = [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('');
      event({ agent: d.run.run, label: d.run.label, kind: 'branch', detail: `${name} ${commit.slice(0, 12)}`, actor: 'human:you' });
      tick({});
      return { branch: name, commit, files: d.files.map((f) => ({ path: f.path, status: 'applied' })) };
    },
    async undo(id, { turn = null, apply = false } = {}) {
      await ensure();
      await wait(apply ? 700 : 350);
      const d = await detail(id);
      if (!db.plans.has(d.run.run)) db.plans.set(d.run.run, await load(`POST /api/runs/${d.run.run}/undo`));
      const plan = clone(db.plans.get(d.run.run));
      if (turn !== null) {
        const t = d.turns.find((x) => x.turn === turn);
        if (!t) throw new ApiError('bad_request', `${d.run.label} has no turn ${turn}.`, 400);
        plan.files = plan.files.filter((f) => t.files.includes(f.path));
        plan.turn = turn;
      }
      if (!apply) return { ...plan, applied: false };
      const files = plan.files.map((f) => {
        if (!CLEAN.has(f.action)) return f;
        if (f.reason) return { ...f, action: 'skipped', reason: f.reason.replace(/, so --yes will skip it$/, '') };
        return { ...f, action: DONE[f.action], reason: null };
      });
      // Reflect the result: applied files are gone from the tree, the plan now says so.
      const stored = db.plans.get(d.run.run);
      for (const f of files) {
        if (!CLEAN.has(f.action)) continue;
        const df = d.files.find((x) => x.path === f.path);
        if (df) df.state = 'gone';
        const sf = stored.files.find((x) => x.path === f.path);
        if (sf) Object.assign(sf, { action: 'nothing', reason: null });
        event({ agent: 'human:you', label: 'human:you', kind: 'undo', path: f.path, detail: `${f.action}: ${d.run.label}${turn === null ? '' : ` turn ${turn}`}` });
      }
      const states = d.files.map((f) => f.state);
      d.run.in_tree = states.every((s) => s === 'gone') ? 'none' : states.some((s) => s === 'gone' || s === 'partial') ? 'some' : 'all';
      tick({});
      return { ...plan, applied: true, files };
    },
  };
  return { api, simulate };
}

// ---------------------------------------------------------------- pick a mode

export let api = live;
let primed = null; // { at, body }: the overview init() fetched

export async function init() {
  const params = new URLSearchParams(location.search);
  let useMock = params.get('mock') === '1';
  if (!useMock) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2500);
      const res = await fetch(at('api/overview'), { signal: ctl.signal, headers: auth() });
      clearTimeout(t);
      keepCsrf(res);
      // 401 is the real server asking for its token: stay live and say so, not sample data.
      if (res.status !== 401) {
        if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) throw new Error('not the api');
        primed = { at: Date.now(), body: await res.json() };
      }
    } catch {
      // On the hub the workspace is always real: a slow or failed first answer
      // means reconnecting, never sample data in place of the team's files.
      if (!CLOUD) {
        useMock = true;
        conn.reason = 'unreachable';
      }
    }
  } else conn.reason = 'requested';

  if (useMock) {
    const m = createMock();
    api = m.api;
    conn.mode = 'mock';
    setState('mock');
    m.simulate();
  } else {
    conn.mode = 'live';
    stream();
  }
  return conn;
}
