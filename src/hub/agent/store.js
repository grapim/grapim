// Ask Grapim's tables: one open conversation per person and team, its
// messages exactly as they were sent to the model (so the next request can
// replay them unchanged), the actions the model proposed with what the person
// decided, and the tokens used per team, person and day.

import { tx } from '../db.js';
import { randomId } from '../secure.js';

export function ensureAgentSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS agent_conversations (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS agent_conversations_owner ON agent_conversations (team_id, user_id, closed_at);
CREATE TABLE IF NOT EXISTS agent_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  meta            TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_messages_conv ON agent_messages (conversation_id, id);
CREATE TABLE IF NOT EXISTS agent_actions (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  team_id         TEXT NOT NULL,
  user_id         INTEGER NOT NULL,
  tool_use_id     TEXT NOT NULL,
  kind            TEXT NOT NULL,
  card            TEXT NOT NULL,
  status          TEXT NOT NULL,
  note            TEXT,
  reported        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER
);
CREATE INDEX IF NOT EXISTS agent_actions_conv ON agent_actions (conversation_id, created_at);
CREATE TABLE IF NOT EXISTS agent_usage (
  team_id            TEXT NOT NULL,
  user_id            INTEGER NOT NULL,
  day                TEXT NOT NULL,
  messages           INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  tool_calls         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, user_id, day)
);
`);
}

export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const parse = (s, fallback = null) => {
  try {
    return s === null || s === undefined ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
};

export class AgentStore {
  constructor({ db, now }) {
    this.db = db;
    this.now = now;
    ensureAgentSchema(db);
  }

  // The open conversation, or null.
  current(teamId, userId) {
    return this.db.prepare('SELECT * FROM agent_conversations WHERE team_id = ? AND user_id = ? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1').get(teamId, userId) ?? null;
  }

  open(teamId, userId) {
    const have = this.current(teamId, userId);
    if (have) return have;
    const t = this.now();
    const id = `c_${randomId(12)}`;
    this.db.prepare('INSERT INTO agent_conversations (id, team_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, teamId, userId, t, t);
    return this.current(teamId, userId);
  }

  close(teamId, userId) {
    this.db.prepare('UPDATE agent_conversations SET closed_at = ? WHERE team_id = ? AND user_id = ? AND closed_at IS NULL').run(this.now(), teamId, userId);
  }

  // role: user | assistant (sent to the model) or notice (shown only).
  add(conversationId, role, content, meta = null) {
    const t = this.now();
    this.db.prepare('INSERT INTO agent_messages (conversation_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)').run(conversationId, role, JSON.stringify(content), meta ? JSON.stringify(meta) : null, t);
    this.db.prepare('UPDATE agent_conversations SET updated_at = ? WHERE id = ?').run(t, conversationId);
  }

  // Several rows at once (an assistant turn and its tool results): both or neither.
  addAll(conversationId, rows) {
    tx(this.db, () => {
      for (const r of rows) this.add(conversationId, r.role, r.content, r.meta ?? null);
    });
  }

  messages(conversationId) {
    return this.db
      .prepare('SELECT id, role, content, meta, created_at FROM agent_messages WHERE conversation_id = ? ORDER BY id')
      .all(conversationId)
      .map((m) => ({ id: m.id, role: m.role, content: parse(m.content, []), meta: parse(m.meta), created_at: m.created_at }));
  }

  // What the conversation weighs: messages and stored characters.
  size(conversationId) {
    return this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS chars FROM agent_messages WHERE conversation_id = ?').get(conversationId);
  }

  // ---- proposed actions ----

  propose({ conversationId, teamId, userId, toolUseId, kind, card }) {
    const id = `act_${randomId(12)}`;
    this.db
      .prepare("INSERT INTO agent_actions (id, conversation_id, team_id, user_id, tool_use_id, kind, card, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?)")
      .run(id, conversationId, teamId, userId, toolUseId, kind, JSON.stringify(card), this.now());
    return this.action(id);
  }

  #row(r) {
    return r ? { id: r.id, conversation_id: r.conversation_id, team_id: r.team_id, user_id: r.user_id, tool_use_id: r.tool_use_id, kind: r.kind, card: parse(r.card, {}), status: r.status, note: r.note, reported: !!r.reported, created_at: r.created_at, decided_at: r.decided_at } : null;
  }

  action(id) {
    return this.#row(this.db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(String(id)));
  }

  actions(conversationId) {
    return this.db.prepare('SELECT * FROM agent_actions WHERE conversation_id = ? ORDER BY created_at').all(conversationId).map((r) => this.#row(r));
  }

  // proposed -> done | failed | cancelled, once. Only the person it was proposed to.
  decide(id, teamId, userId, status, note) {
    const r = this.db
      .prepare("UPDATE agent_actions SET status = ?, note = ?, decided_at = ? WHERE id = ? AND team_id = ? AND user_id = ? AND status = 'proposed'")
      .run(status, note, this.now(), String(id), teamId, userId);
    return r.changes > 0;
  }

  // Decisions the model has not been told about yet; marks them told.
  unreported(conversationId) {
    const rows = this.db.prepare("SELECT * FROM agent_actions WHERE conversation_id = ? AND status != 'proposed' AND reported = 0 ORDER BY decided_at").all(conversationId);
    if (rows.length) this.db.prepare(`UPDATE agent_actions SET reported = 1 WHERE id IN (${rows.map(() => '?').join(',')})`).run(...rows.map((r) => r.id));
    return rows.map((r) => this.#row(r));
  }

  // ---- usage ----

  usage(teamId, userId, day = dayOf(this.now())) {
    const mine = this.db.prepare('SELECT messages FROM agent_usage WHERE team_id = ? AND user_id = ? AND day = ?').get(teamId, userId, day)?.messages ?? 0;
    const team = this.db.prepare('SELECT COALESCE(SUM(messages), 0) AS n FROM agent_usage WHERE team_id = ? AND day = ?').get(teamId, day).n;
    return { mine, team };
  }

  count(teamId, userId, delta) {
    const day = dayOf(this.now());
    this.db
      .prepare(
        `INSERT INTO agent_usage (team_id, user_id, day, messages, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, tool_calls)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id, user_id, day) DO UPDATE SET
           messages = messages + excluded.messages, input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens, cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
           cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens, tool_calls = tool_calls + excluded.tool_calls`,
      )
      .run(teamId, userId, day, delta.messages ?? 0, delta.input_tokens ?? 0, delta.output_tokens ?? 0, delta.cache_read_tokens ?? 0, delta.cache_write_tokens ?? 0, delta.tool_calls ?? 0);
  }

  // A team's token use per day, for billing or a usage page later.
  teamUsage(teamId, fromDay = '0000-00-00') {
    return this.db
      .prepare(
        `SELECT day, SUM(messages) AS messages, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens, SUM(tool_calls) AS tool_calls
         FROM agent_usage WHERE team_id = ? AND day >= ? GROUP BY day ORDER BY day`,
      )
      .all(teamId, fromDay);
  }
}
