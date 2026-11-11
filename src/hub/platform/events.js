// What happened in a platform workspace, read from its own ledger after each
// request that could change it: writes are metered and webhook events are
// emitted (run.started, run.updated, run.reviewed, run.undone, edit.blocked,
// file.restored). The workspace engine is not changed: the hub reads the
// changes and events tables past a cursor it keeps per workspace.
//
// run.updated is debounced to at most one per run per 30 s: the first change
// of a run is run.started; later changes inside the window are folded into
// one trailing run.updated with the latest totals.

import { resolveRun } from '../../server/runs.js';

export const DEBOUNCE_MS = 30_000;
export const MAX_TRACKED = 10_000; // runs remembered for the debounce before old ones are dropped
const PAGE = 5000; // ledger rows read per request; the rest on the next one
const SYSTEM_RUN = /^(undo|restore):/; // undo and restore record their changes under these

export function createEvents({ hub, metering, webhooks, log }) {
  const { db, now } = hub;
  const lastUpdate = new Map(); // `${ws}|${run}` -> ms of the last run.started/updated
  const trailing = new Map(); // same key -> { timer, team, mode, ws, data }

  const modeOf = (ws) => (ws.mode === 'test' ? 'test' : 'live');
  // lastUpdate gets one key per run ever seen, and agents choose run names
  // (X-Grapim-Agent): entries older than the debounce window mean nothing
  // any more, so they are dropped once the map is large (review M8).
  const noteUpdate = (key, t) => {
    lastUpdate.set(key, t);
    if (lastUpdate.size > MAX_TRACKED) {
      for (const [k, at] of lastUpdate) if (t - at >= DEBOUNCE_MS && !trailing.has(k)) lastUpdate.delete(k);
    }
  };
  const platformTeam = (teamId) => {
    const t = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
    return t?.kind === 'platform' ? t : null;
  };

  // A workspace the hub has never read starts at the end of its ledger, so
  // history from before the team became a platform is neither billed nor
  // replayed. Workspaces made by the API start at 0 (start()).
  function cursor(ws, store) {
    const c = metering.cursorOf(ws.id);
    if (c) return c;
    const fresh = {
      change_id: store.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM changes').get().id,
      event_id: store.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get().id,
    };
    metering.saveCursor(ws.id, fresh);
    return null;
  }

  const start = (ws) => metering.saveCursor(ws.id, { change_id: 0, event_id: 0 });

  function runTotals(store, run) {
    const r = store.db
      .prepare('SELECT COUNT(*) AS edits, COUNT(DISTINCT path_key) AS files, COALESCE(SUM(added), 0) AS added, COALESCE(SUM(removed), 0) AS removed, MAX(ts) AS last_ts, MAX(label) AS label FROM changes WHERE run = ?')
      .get(run);
    return { run, label: r.label ?? run, files: r.files, edits: r.edits, added: r.added, removed: r.removed, last_change_at: r.last_ts ? Math.floor(r.last_ts / 1000) : null };
  }

  function updated(team, ws, data) {
    const key = `${ws.id}|${data.run}`;
    const t = now();
    const last = lastUpdate.get(key) ?? 0;
    const pend = trailing.get(key);
    if (t - last >= DEBOUNCE_MS) {
      if (pend) {
        clearTimeout(pend.timer);
        trailing.delete(key);
      }
      noteUpdate(key, t);
      webhooks.emit(team, modeOf(ws), 'run.updated', ws, data);
      return;
    }
    if (pend) {
      pend.data = data; // the trailing event carries the newest totals
      return;
    }
    const entry = { team, ws, data, timer: null };
    entry.timer = setTimeout(() => fire(key), Math.max(0, last + DEBOUNCE_MS - t));
    entry.timer.unref?.();
    trailing.set(key, entry);
  }

  function fire(key) {
    const e = trailing.get(key);
    if (!e) return;
    trailing.delete(key);
    noteUpdate(key, now());
    try {
      webhooks.emit(e.team, modeOf(e.ws), 'run.updated', e.ws, e.data);
    } catch (err) {
      log(`run.updated: ${err?.message ?? err}`);
    }
  }

  // Reads the workspace ledger past the cursor. `request` names the act that
  // caused it ({ undoneRun } for an undo), so run.undone can say which run.
  function afterActivity(ws, store, request = {}) {
    const team = platformTeam(ws.team_id);
    if (!team) return;
    const c = cursor(ws, store);
    if (!c) return;
    const changes = store.db.prepare('SELECT id, run, label, path, ts FROM changes WHERE id > ? ORDER BY id LIMIT ?').all(c.change_id, PAGE);
    const events = store.db.prepare('SELECT id, ts, agent, kind, path, detail, actor FROM events WHERE id > ? ORDER BY id LIMIT ?').all(c.event_id, PAGE);
    if (!changes.length && !events.length) return;
    const mode = modeOf(ws);
    const emit = (type, data) => webhooks.emit(team, mode, type, ws, data);

    if (changes.length) metering.bump(ws, { writes: changes.length });
    const runs = new Map();
    for (const ch of changes) if (!SYSTEM_RUN.test(ch.run) && !runs.has(ch.run)) runs.set(ch.run, ch);
    for (const [run, first] of runs) {
      const firstId = store.db.prepare('SELECT MIN(id) AS id FROM changes WHERE run = ?').get(run).id;
      if (firstId > c.change_id) {
        noteUpdate(`${ws.id}|${run}`, now());
        emit('run.started', { run, label: first.label ?? run, path: first.path, started_at: Math.floor(first.ts / 1000) });
      } else {
        updated(team, ws, runTotals(store, run));
      }
    }

    const undone = [];
    for (const e of events) {
      if (e.kind === 'review') {
        const [status, ...note] = String(e.detail ?? '').split(': ');
        emit('run.reviewed', { run: e.agent, status, note: note.join(': ') || null, by: e.actor ?? null });
      } else if (e.kind === 'undo') {
        undone.push(e);
      } else if (e.kind === 'blocked') {
        emit('edit.blocked', { agent: e.agent, path: e.path, reason: e.detail ?? null });
      } else if (e.kind === 'restore') {
        const [sha, run] = String(e.detail ?? '').split(' ');
        emit('file.restored', { path: e.path, sha: sha || null, run: run || null, by: e.actor ?? e.agent });
      }
    }
    if (undone.length) {
      let run = request.undoneRun ?? null;
      if (run) {
        try {
          run = resolveRun(store, run).run;
        } catch {}
      }
      emit('run.undone', { run, files: [...new Set(undone.map((e) => e.path).filter(Boolean))], by: undone[0].actor ?? undone[0].agent });
    }

    metering.saveCursor(ws.id, {
      change_id: changes.length ? changes.at(-1).id : c.change_id,
      event_id: events.length ? events.at(-1).id : c.event_id,
    });
  }

  // After a request to /w/<team>/<name>/...: the run named in an undo URL.
  function afterRequest(ws, engine, { method, rest, status }) {
    try {
      const m = method === 'POST' && status === 200 ? /^\/api\/runs\/([^/?]+)\/undo(?:\?|$)/.exec(rest) : null;
      let undoneRun = null;
      if (m) {
        try {
          undoneRun = decodeURIComponent(m[1]);
        } catch {}
      }
      afterActivity(ws, engine.store, { undoneRun });
    } catch (err) {
      log(`platform events: ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
    }
  }

  return {
    start,
    afterActivity,
    afterRequest,
    close() {
      for (const e of trailing.values()) clearTimeout(e.timer);
      trailing.clear();
    },
    tracked: () => lastUpdate.size,
    // For tests: send every pending trailing run.updated now.
    flushDebounced() {
      for (const k of [...trailing.keys()]) {
        clearTimeout(trailing.get(k).timer);
        fire(k);
      }
    },
  };
}
