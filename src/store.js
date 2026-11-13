// The shared state: who holds which file, what each agent is doing, and what happened.
//
// One SQLite file per repo. Every write runs in BEGIN IMMEDIATE, so two agents
// claiming the same file at the same moment are serialised by SQLite's write
// lock: exactly one wins. busy_timeout makes the loser wait instead of failing.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_TTL_MS = 30 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leases (
  path_key    TEXT PRIMARY KEY,
  path        TEXT NOT NULL,
  agent       TEXT NOT NULL,
  intent      TEXT,
  worktree    TEXT,
  acquired_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  agent     TEXT PRIMARY KEY,
  label     TEXT,
  intent    TEXT,
  worktree  TEXT,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  agent  TEXT NOT NULL,
  kind   TEXT NOT NULL,
  path   TEXT,
  detail TEXT,
  actor  TEXT
);
CREATE INDEX IF NOT EXISTS leases_agent ON leases(agent);

-- The attribution ledger. A run is one agent session (its agent id); turn
-- counts its prompts. File contents are stored once, by sha1.
CREATE TABLE IF NOT EXISTS runs (
  run        TEXT PRIMARY KEY,
  turn       INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blobs (
  sha     TEXT PRIMARY KEY,
  content BLOB NOT NULL
);
-- A before-snapshot waiting for its edit to finish (hook Pre to Post, MCP claim to release).
CREATE TABLE IF NOT EXISTS pending (
  id         TEXT PRIMARY KEY,
  run        TEXT NOT NULL,
  label      TEXT,
  turn       INTEGER NOT NULL,
  root       TEXT NOT NULL,
  root_key   TEXT NOT NULL,
  path_key   TEXT NOT NULL,
  path       TEXT NOT NULL,
  before_sha TEXT,
  ts         INTEGER NOT NULL
);
-- before_sha / after_sha: NULL means the file did not exist. A sha with no
-- row in blobs means the content was not kept (binary or over 2 MB).
CREATE TABLE IF NOT EXISTS changes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run        TEXT NOT NULL,
  label      TEXT,
  turn       INTEGER NOT NULL,
  root       TEXT NOT NULL,
  root_key   TEXT NOT NULL,
  path_key   TEXT NOT NULL,
  path       TEXT NOT NULL,
  before_sha TEXT,
  after_sha  TEXT,
  untracked  INTEGER NOT NULL DEFAULT 0,
  added      INTEGER,
  removed    INTEGER,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_file ON changes(root_key, path_key);
CREATE INDEX IF NOT EXISTS changes_run ON changes(run);
CREATE INDEX IF NOT EXISTS pending_run ON pending(run);
-- What the hooks saw of each agent (source: claude, codex, cursor, gemini):
-- kind 'model' or 'version', for the agent inventory (src/inventory.js).
CREATE TABLE IF NOT EXISTS agent_seen (
  source    TEXT NOT NULL,
  kind      TEXT NOT NULL,
  value     TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (source, kind, value)
);
`;

export class Store {
  constructor(stateDir, { now = () => Date.now() } = {}) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.now = now;
    this.db = new DatabaseSync(path.join(stateDir, 'state.db'));
    this.db.exec('PRAGMA busy_timeout = 15000');
    // Switching a new file to WAL does not wait on busy_timeout: two processes
    // creating it at once can get "database is locked". Retry for up to 5 s.
    for (let i = 0; ; i++) {
      try {
        this.db.exec('PRAGMA journal_mode = WAL');
        break;
      } catch (err) {
        if (i >= 100 || !/\b(busy|locked)\b/i.test(err.message)) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.tx(() => {
      this.db.exec(SCHEMA);
      // Files made before events had an actor (who did a review, branch,
      // undo or restore) get the column; older rows keep NULL.
      if (!this.db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'actor')) this.db.exec('ALTER TABLE events ADD COLUMN actor TEXT');
    });
  }

  close() {
    this.db.close();
  }

  // A model or version an agent's hook payload named. Values are checked by
  // the caller; one row per (source, kind, value), so this never grows much.
  noteSeen(source, kind, value) {
    this.db
      .prepare('INSERT INTO agent_seen (source, kind, value, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(source, kind, value) DO UPDATE SET last_seen = excluded.last_seen')
      .run(source, kind, value, this.now());
  }

  // Newest first, since `since` (epoch ms).
  seen(since = 0) {
    return this.db.prepare('SELECT source, kind, value, last_seen FROM agent_seen WHERE last_seen > ? ORDER BY last_seen DESC LIMIT 200').all(since);
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  #event(agent, kind, p = null, detail = null, actor = null) {
    this.db
      .prepare('INSERT INTO events (ts, agent, kind, path, detail, actor) VALUES (?, ?, ?, ?, ?, ?)')
      .run(this.now(), agent, kind, p, detail, actor);
  }

  #touch(agent, meta = {}) {
    this.db
      .prepare(
        `INSERT INTO agents (agent, label, intent, worktree, last_seen) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent) DO UPDATE SET
           label = COALESCE(excluded.label, agents.label),
           intent = COALESCE(excluded.intent, agents.intent),
           worktree = COALESCE(excluded.worktree, agents.worktree),
           last_seen = excluded.last_seen`,
      )
      .run(agent, meta.label ?? null, meta.intent ?? null, meta.worktree ?? null, this.now());
  }

  #expire() {
    this.db.prepare('DELETE FROM leases WHERE expires_at <= ?').run(this.now());
  }

  touch(agent, meta = {}) {
    this.tx(() => this.#touch(agent, meta));
  }

  setIntent(agent, intent, meta = {}) {
    this.tx(() => {
      this.#touch(agent, { ...meta, intent });
      this.db.prepare('UPDATE leases SET intent = ? WHERE agent = ?').run(intent, agent);
      this.#event(agent, 'intent', null, intent);
    });
  }

  // files: [{ key, display }]. All or nothing: if any file is held by someone
  // else, nothing is claimed and the conflicts are returned.
  claim(agent, files, { intent = null, ttlMs = DEFAULT_TTL_MS, worktree = null, label = null } = {}) {
    return this.tx(() => {
      this.#expire();
      const get = this.db.prepare(
        `SELECT l.*, a.label FROM leases l LEFT JOIN agents a ON a.agent = l.agent WHERE l.path_key = ?`,
      );
      const conflicts = [];
      const fresh = [];
      for (const f of files) {
        const row = get.get(f.key);
        if (row && row.agent !== agent) conflicts.push(row);
        else if (!row) fresh.push(f);
      }
      if (conflicts.length) {
        for (const c of conflicts) this.#event(agent, 'blocked', c.path, `held by ${c.label || c.agent}`);
        return { ok: false, conflicts, claimed: [] };
      }
      this.#touch(agent, { worktree, label, intent });
      const agentIntent = this.db.prepare('SELECT intent FROM agents WHERE agent = ?').get(agent)?.intent;
      const now = this.now();
      const upsert = this.db.prepare(
        `INSERT INTO leases (path_key, path, agent, intent, worktree, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path_key) DO UPDATE SET
           expires_at = excluded.expires_at,
           intent = COALESCE(excluded.intent, leases.intent),
           worktree = excluded.worktree`,
      );
      for (const f of files) {
        upsert.run(f.key, f.display, agent, intent ?? agentIntent ?? null, worktree, now, now + ttlMs);
      }
      for (const f of fresh) this.#event(agent, 'claim', f.display, intent ?? agentIntent ?? null);
      return { ok: true, conflicts: [], claimed: files.map((f) => f.display) };
    });
  }

  // keys: array of path keys, or null for everything this agent holds.
  release(agent, keys = null) {
    return this.tx(() => {
      const rows = keys
        ? keys
            .map((k) => this.db.prepare('SELECT path FROM leases WHERE path_key = ? AND agent = ?').get(k, agent))
            .filter(Boolean)
        : this.db.prepare('SELECT path FROM leases WHERE agent = ?').all(agent);
      if (keys) {
        const del = this.db.prepare('DELETE FROM leases WHERE path_key = ? AND agent = ?');
        for (const k of keys) del.run(k, agent);
      } else {
        this.db.prepare('DELETE FROM leases WHERE agent = ?').run(agent);
      }
      for (const r of rows) this.#event(agent, 'release', r.path);
      return rows.map((r) => r.path);
    });
  }

  // Leases held by someone other than `agent` for the given key, or null.
  holder(key, agent) {
    const row = this.db
      .prepare(
        `SELECT l.*, a.label FROM leases l LEFT JOIN agents a ON a.agent = l.agent
         WHERE l.path_key = ? AND l.expires_at > ?`,
      )
      .get(key, this.now());
    return row && row.agent !== agent ? row : null;
  }

  recordEdit(agent, display, detail = null) {
    this.tx(() => {
      this.#touch(agent);
      this.#event(agent, 'edit', display, detail);
    });
  }

  endSession(agent) {
    const released = this.release(agent, null);
    this.tx(() => this.#event(agent, 'end'));
    return released;
  }

  leases() {
    return this.db
      .prepare(
        `SELECT l.*, a.label FROM leases l LEFT JOIN agents a ON a.agent = l.agent
         WHERE l.expires_at > ? ORDER BY l.acquired_at`,
      )
      .all(this.now());
  }

  // Agents seen within `windowMs`, excluding ones whose session ended since.
  activeAgents(windowMs = 60 * 60 * 1000) {
    return this.db
      .prepare(
        `SELECT a.* FROM agents a
         WHERE a.last_seen > ?
           AND NOT EXISTS (SELECT 1 FROM events e WHERE e.agent = a.agent AND e.kind = 'end' AND e.ts >= a.last_seen)
         ORDER BY a.last_seen DESC`,
      )
      .all(this.now() - windowMs);
  }

  // ---- Attribution ledger ----

  #putBlob(snap) {
    if (snap?.buf) this.db.prepare('INSERT OR IGNORE INTO blobs (sha, content) VALUES (?, ?)').run(snap.sha, snap.buf);
  }

  // The stored content for a sha, or null if it was never kept.
  blob(sha) {
    if (!sha) return null;
    const row = this.db.prepare('SELECT content FROM blobs WHERE sha = ?').get(sha);
    return row ? Buffer.from(row.content) : null;
  }

  turn(run) {
    return this.db.prepare('SELECT turn FROM runs WHERE run = ?').get(run)?.turn ?? 0;
  }

  nextTurn(run) {
    return this.tx(() => {
      this.db
        .prepare('INSERT INTO runs (run, turn, started_at) VALUES (?, 1, ?) ON CONFLICT(run) DO UPDATE SET turn = runs.turn + 1')
        .run(run, this.now());
      return this.turn(run);
    });
  }

  // c: { id, run, label, root, root_key, path_key, path, snap }. With keep, an
  // existing snapshot for the same id wins (an MCP agent claiming twice).
  beginChange(c, { keep = false } = {}) {
    this.tx(() => {
      if (keep && this.db.prepare('SELECT 1 FROM pending WHERE id = ?').get(c.id)) return;
      this.#putBlob(c.snap);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO pending (id, run, label, turn, root, root_key, path_key, path, before_sha, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(c.id, c.run, c.label ?? null, this.turn(c.run), c.root, c.root_key, c.path_key, c.path, c.snap.sha, this.now());
    });
  }

  // The pending snapshot for this tool call, else the newest one for run + file.
  pending({ id, run, root_key, path_key }) {
    const byId = id ? this.db.prepare('SELECT * FROM pending WHERE id = ?').get(id) : undefined;
    return (
      byId ??
      this.db
        .prepare('SELECT * FROM pending WHERE run = ? AND root_key = ? AND path_key = ? ORDER BY ts DESC, rowid DESC LIMIT 1')
        .get(run, root_key, path_key) ??
      null
    );
  }

  // An edit to this file that has begun and not finished, by anyone. Rows older
  // than `maxAgeMs` are treated as abandoned (an agent that crashed mid-edit).
  editInProgress(root_key, path_key, maxAgeMs = 30 * 60 * 1000) {
    return (
      this.db
        .prepare('SELECT * FROM pending WHERE root_key = ? AND path_key = ? AND ts > ? ORDER BY ts DESC LIMIT 1')
        .get(root_key, path_key, this.now() - maxAgeMs) ?? null
    );
  }

  pendingOf(run) {
    return this.db.prepare('SELECT * FROM pending WHERE run = ? ORDER BY ts, rowid').all(run);
  }

  dropPending({ id = null, run = null }) {
    if (id) this.tx(() => this.db.prepare('DELETE FROM pending WHERE id = ?').run(id));
    else if (run) this.tx(() => this.db.prepare('DELETE FROM pending WHERE run = ?').run(run));
  }

  #insertChange(c) {
    this.db
      .prepare(
        `INSERT INTO changes (run, label, turn, root, root_key, path_key, path, before_sha, after_sha, untracked, added, removed, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.run, c.label ?? null, c.turn, c.root, c.root_key, c.path_key, c.path, c.before_sha, c.after_sha, c.untracked ? 1 : 0, c.added ?? null, c.removed ?? null, this.now());
  }

  // Turns a pending snapshot into a change row, in one transaction.
  finishChange(p, after, stats) {
    this.tx(() => {
      this.#putBlob(after);
      this.#insertChange({ ...p, ...stats, after_sha: after.sha });
      this.db.prepare('DELETE FROM pending WHERE id = ?').run(p.id);
    });
  }

  // A change written by Grapim itself (an undo), with both snapshots.
  recordChange(c, before, after) {
    this.tx(() => {
      this.#putBlob(before);
      this.#putBlob(after);
      this.#insertChange({ ...c, before_sha: before.sha, after_sha: after.sha });
    });
  }

  changesOfFile(root_key, path_key) {
    return this.db.prepare('SELECT * FROM changes WHERE root_key = ? AND path_key = ? ORDER BY id').all(root_key, path_key);
  }

  changesOfRun(run) {
    return this.db.prepare('SELECT * FROM changes WHERE run = ? ORDER BY id').all(run);
  }

  allChanges() {
    return this.db.prepare('SELECT * FROM changes ORDER BY id').all();
  }

  // One row per run that changed at least one file, newest first.
  runs() {
    return this.db
      .prepare(
        `SELECT c.run, COALESCE(a.label, MAX(c.label)) AS label, a.intent, a.worktree, MAX(c.root) AS root,
                COALESCE(r.turn, 0) AS turns, COUNT(*) AS edits,
                COUNT(DISTINCT c.root_key || '|' || c.path_key) AS files,
                COALESCE(SUM(c.added), 0) AS added, COALESCE(SUM(c.removed), 0) AS removed,
                MAX(c.untracked) AS untracked, MIN(c.ts) AS first_ts, MAX(c.ts) AS last_ts
         FROM changes c LEFT JOIN runs r ON r.run = c.run LEFT JOIN agents a ON a.agent = c.run
         GROUP BY c.run ORDER BY MAX(c.id) DESC`,
      )
      .all();
  }

  // An undo event: the agent is the one who undid, so it is the actor too.
  recordUndo(agent, display, detail) {
    this.tx(() => this.#event(agent, 'undo', display, detail, agent));
  }

  // An event of any kind, for modules that keep their own tables (review,
  // branch, restore). actor: who did it, when that is not the agent.
  recordEvent(agent, kind, p = null, detail = null, actor = null) {
    this.tx(() => this.#event(agent, kind, p, detail, actor));
  }

  events(limit = 30) {
    return this.db
      .prepare(
        `SELECT e.*, a.label FROM events e LEFT JOIN agents a ON a.agent = e.agent
         ORDER BY e.id DESC LIMIT ?`,
      )
      .all(limit)
      .reverse();
  }
}
