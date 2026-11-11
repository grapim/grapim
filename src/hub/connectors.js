// SaaS connectors in cloud workspaces (docs/connectors.md): a workspace owner
// connects a service (Notion first) with a token; its data appears under
// saas/<name>/ in the workspace, pulled every 2 minutes and on demand, and
// agents' writes there are pushed back through the workspace engine's
// post-write callback (src/server/after-write.js).
//
// - The token is sealed with AES-256-GCM under a key of its own derived from
//   HUB_SECRET, bound to (team, workspace, connector): copied into another
//   row it does not open. It is never logged, never sent to a page, and only
//   ever sent to the service's fixed API host.
// - One connection per workspace and connector. Disconnecting deletes the
//   row and stops its timer; the files and their history stay.

import { CONNECTORS, createQueue, createSync } from '../connectors/index.js';
import { TOKEN_RE } from '../connectors/notion/client.js';
import { HttpError } from './http.js';
import { sealer } from './platform/util.js';

export const PULL_MS = 2 * 60 * 1000;
export const JITTER_MS = 20 * 1000;
// Pulls running at once, hub wide. A pull keeps its workspace engine open
// (engine.use) for as long as the service takes, minutes for a big Notion:
// without a cap, enough connected workspaces would hold every engine slot and
// the hub would answer 503 to every other workspace (security review batch 5, M4).
export const MAX_PULLS = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace_connectors (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id      TEXT NOT NULL,
  connector    TEXT NOT NULL,
  secret       TEXT NOT NULL,   -- the token, sealed (AES-256-GCM, bound to team, workspace and connector)
  account      TEXT,            -- the integration's name as the service reports it (untrusted text)
  created_by   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  last_sync_at INTEGER,
  last_ok_at   INTEGER,
  last_error   TEXT,
  last_summary TEXT,            -- JSON: what the last pull did
  PRIMARY KEY (workspace_id, connector)
);
`;

const TOKEN_CHECKS = { notion: TOKEN_RE };

// Error text for a page or a log line: the service's own words are
// untrusted, so one line and short; never the token.
const say = (err) => String(err?.message ?? err ?? 'unknown error').replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 400);

// options: { <name>: options for that connector's create() (tests: baseUrl,
// fetch, queue) }, pullMs, jitterMs, random, schedule (false: no timers).
export function createConnectors(hub, options = {}) {
  const { db, log, now } = hub;
  db.exec(SCHEMA);
  const seal = sealer(hub.config.secret, 'grapim connector seal v1');
  const aad = (teamId, wsId, name) => `workspace_connectors\n${teamId}\n${wsId}\n${name}`;
  const pullMs = options.pullMs ?? PULL_MS;
  const jitterMs = options.jitterMs ?? JITTER_MS;
  const random = options.random ?? Math.random;
  const schedule = options.schedule !== false;
  const live = new Map(); // `${workspace id}:${name}` -> { sync, timer, running }
  let closed = false;
  const maxPulls = options.maxPulls ?? MAX_PULLS;
  let pulling = 0;
  const waiting = []; // resolvers of pulls waiting for a slot, first come first served
  const acquire = () => {
    if (pulling < maxPulls) {
      pulling++;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else pulling = Math.max(0, pulling - 1);
  };

  const keyOf = (wsId, name) => `${wsId}:${name}`;
  const rowOf = (wsId, name) => db.prepare('SELECT * FROM workspace_connectors WHERE workspace_id = ? AND connector = ?').get(wsId, name) ?? null;
  const rowsOf = (wsId) => db.prepare('SELECT * FROM workspace_connectors WHERE workspace_id = ?').all(wsId);

  function definition(name) {
    const def = Object.hasOwn(CONNECTORS, name) ? CONNECTORS[name] : null;
    if (!def) throw new HttpError(404, 'not_found', 'No such connector.');
    return def;
  }

  // A connector object for a token. The rate-limit queue is per connection.
  const make = (name, token) => definition(name).create({ token, queue: createQueue({ perSecond: 3 }), ...(options[name] ?? {}) });

  function connection(row) {
    const k = keyOf(row.workspace_id, row.connector);
    let c = live.get(k);
    if (c) return c;
    const token = seal.open(row.secret, aad(row.team_id, row.workspace_id, row.connector));
    if (!token) throw new Error('The stored token cannot be read (was HUB_SECRET changed?). Disconnect and connect again.');
    c = { sync: createSync({ connector: make(row.connector, token), log: (l) => log(`connector ${row.connector} ${row.workspace_id}: ${l}`), now }), timer: null, running: null };
    live.set(k, c);
    return c;
  }

  function stop(wsId, name) {
    const k = keyOf(wsId, name);
    const c = live.get(k);
    if (c?.timer) clearTimeout(c.timer);
    live.delete(k);
  }

  // The workspace handle the sync works on (src/connectors/sync.js).
  const handleFor = (ws, engine) => ({
    store: engine.store,
    ws: engine.ws,
    offload: engine.ctx?.offload ?? null,
    admit: (bytes) => hub.mount.admit(ws, bytes),
    wrote: () => {
      hub.mount.measureSoon(ws);
      hub.mount.storage?.touch(hub.workspaces.storageKey(ws));
    },
  });

  function record(row, { ok, error = null, summary = null }) {
    const t = now();
    db.prepare('UPDATE workspace_connectors SET last_sync_at = ?, last_ok_at = COALESCE(?, last_ok_at), last_error = ?, last_summary = COALESCE(?, last_summary) WHERE workspace_id = ? AND connector = ?').run(
      t,
      ok ? t : null,
      error,
      summary ? JSON.stringify(summary) : null,
      row.workspace_id,
      row.connector,
    );
  }

  // One pull now. Answers the summary; a failure is recorded on the row.
  async function pull(row) {
    if (closed) return null;
    const c = connection(row);
    if (c.running) return c.running;
    c.running = (async () => {
      // A slot first; the engine is opened only once the pull may run.
      await acquire();
      try {
        if (closed) return null;
        return await pullNow(row, c);
      } finally {
        release();
      }
    })().finally(() => {
      c.running = null;
    });
    return c.running;
  }

  async function pullNow(row, c) {
    const ws = hub.workspaces.byId(row.team_id, row.workspace_id);
    if (!ws) {
      // The workspace was deleted: its connection goes with it.
      db.prepare('DELETE FROM workspace_connectors WHERE workspace_id = ?').run(row.workspace_id);
      stop(row.workspace_id, row.connector);
      return null;
    }
    // Disconnected while waiting for a slot: nothing to pull.
    if (!rowOf(row.workspace_id, row.connector)) return null;
    try {
      const engine = hub.mount.engineFor(ws);
      const summary = await engine.use(() => c.sync.pull(handleFor(ws, engine)));
      const error = summary.errors.length ? summary.errors.slice(0, 3).map(say).join(' ') : null;
      // Still connected? A disconnect while pulling leaves no row to update.
      const kept = { pages: summary.pages, created: summary.created, updated: summary.updated, deleted: summary.deleted, merged: summary.merged, conflicts: summary.conflicts.slice(0, 20), skipped: summary.skipped.length, at: now() };
      if (rowOf(row.workspace_id, row.connector)) record(row, { ok: !error, error, summary: kept });
      return summary;
    } catch (err) {
      if (rowOf(row.workspace_id, row.connector)) record(row, { ok: false, error: say(err) });
      log(`connector ${row.connector} ${row.workspace_id}: pull failed: ${say(err)}`);
      throw err;
    }
  }

  // Every 2 minutes per connection, with jitter, so workspaces do not pull in step.
  function plan(row, first = false) {
    if (!schedule || closed || !rowOf(row.workspace_id, row.connector)) return; // disconnected meanwhile
    let c;
    try {
      c = connection(row);
    } catch (err) {
      record(row, { ok: false, error: say(err) });
      return;
    }
    if (c.timer) clearTimeout(c.timer);
    const delay = first ? random() * pullMs : pullMs + (random() * 2 - 1) * jitterMs;
    c.timer = setTimeout(async () => {
      c.timer = null;
      const fresh = rowOf(row.workspace_id, row.connector);
      if (!fresh || closed || live.get(keyOf(row.workspace_id, row.connector)) !== c) return; // disconnected
      await pull(fresh).catch(() => {});
      if (rowOf(row.workspace_id, row.connector) && live.get(keyOf(row.workspace_id, row.connector)) === c) plan(fresh);
    }, Math.max(1000, delay));
    c.timer.unref?.();
  }

  function cleanToken(name, raw) {
    const token = String(raw ?? '').trim();
    const re = TOKEN_CHECKS[name];
    if (!token || (re && !re.test(token))) {
      throw new HttpError(400, 'bad_request', `Paste the integration's secret: it starts with ntn_ (or secret_ for older integrations).`);
    }
    return token;
  }

  // Checks a token with the service: { name, workspace } or an HttpError
  // whose message is safe to show (never the token).
  async function test(name, token) {
    try {
      return await make(name, token).test();
    } catch (err) {
      if (err?.status === 401) throw new HttpError(400, 'bad_request', `${definition(name).title} did not accept this token. Copy the integration's secret again.`);
      throw new HttpError(400, 'bad_request', `${definition(name).title} could not be reached with this token: ${say(err)}`);
    }
  }

  return {
    names: () => Object.keys(CONNECTORS),

    // ws: a live workspace row; actor: { userId }. Tests the token first.
    async connect(ws, actor, name, raw) {
      definition(name);
      const token = cleanToken(name, raw);
      const info = await test(name, token);
      const sealed = seal.seal(token, aad(ws.team_id, ws.id, name));
      stop(ws.id, name);
      db.prepare(
        `INSERT INTO workspace_connectors (workspace_id, team_id, connector, secret, account, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, connector) DO UPDATE SET secret = excluded.secret, account = excluded.account, created_by = excluded.created_by, created_at = excluded.created_at, last_error = NULL`,
      ).run(ws.id, ws.team_id, name, sealed, info.name, actor.userId, now());
      const row = rowOf(ws.id, name);
      // The first pull starts now, in the background; the page shows its result on reload.
      pull(row)
        .catch(() => {})
        .finally(() => plan(rowOf(ws.id, name) ?? row));
      return info;
    },

    // The stored token, checked again with the service.
    async test(ws, name) {
      const row = rowOf(ws.id, name);
      if (!row) throw new HttpError(404, 'not_found', 'Not connected.');
      const token = seal.open(row.secret, aad(row.team_id, row.workspace_id, row.connector));
      if (!token) throw new HttpError(400, 'bad_request', 'The stored token cannot be read (was HUB_SECRET changed?). Disconnect and connect again.');
      return test(name, token);
    },

    async syncNow(ws, name) {
      const row = rowOf(ws.id, name);
      if (!row) throw new HttpError(404, 'not_found', 'Not connected.');
      try {
        return await pull(row);
      } catch (err) {
        throw new HttpError(502, 'bad_gateway', `The sync failed: ${say(err)}`);
      }
    },

    disconnect(ws, name) {
      definition(name);
      db.prepare('DELETE FROM workspace_connectors WHERE workspace_id = ? AND connector = ?').run(ws.id, name);
      stop(ws.id, name);
    },

    // For the workspace page: one entry per connector, connected or not.
    status(ws) {
      const rows = new Map(rowsOf(ws.id).map((r) => [r.connector, r]));
      return Object.entries(CONNECTORS).map(([name, def]) => {
        const r = rows.get(name);
        let summary = null;
        try {
          summary = r?.last_summary ? JSON.parse(r.last_summary) : null;
        } catch {}
        return {
          name,
          title: def.title,
          connected: !!r,
          account: r?.account ?? null,
          connected_at: r?.created_at ?? null,
          last_sync_at: r?.last_sync_at ?? null,
          last_ok_at: r?.last_ok_at ?? null,
          last_error: r?.last_error ?? null,
          summary,
          syncing: !!live.get(keyOf(ws.id, name))?.running,
        };
      });
    },

    // The engine's post-write callback for workspace ws (workspace-mount.js).
    async afterWrite(ws, engine, event) {
      const p = String(event?.path ?? '');
      if (!p.startsWith('saas/')) return null;
      const name = p.split('/')[1];
      const row = Object.hasOwn(CONNECTORS, name) ? rowOf(ws.id, name) : null;
      if (!row) return null;
      let c;
      try {
        c = connection(row);
      } catch (err) {
        return { connector: name, status: 'error', message: say(err) };
      }
      return c.sync.afterWrite(handleFor(ws, engine), event);
    },

    // Schedules every connection (hub start).
    boot() {
      for (const row of db.prepare('SELECT * FROM workspace_connectors').all()) plan(row, true);
    },

    pull: (wsId, name) => {
      const row = rowOf(wsId, name);
      return row ? pull(row) : Promise.resolve(null);
    },
    // Whether a connection has a timer (tests).
    scheduled: (wsId, name) => !!live.get(keyOf(wsId, name))?.timer,

    // Stops every timer; resolves once the pulls in flight have finished.
    close() {
      closed = true;
      // Pulls waiting for a slot give up at once (they see `closed`).
      for (const resolve of waiting.splice(0)) resolve();
      const running = [];
      for (const c of live.values()) {
        if (c.timer) clearTimeout(c.timer);
        if (c.running) running.push(c.running.catch(() => {}));
      }
      live.clear();
      return Promise.all(running);
    },
  };
}
