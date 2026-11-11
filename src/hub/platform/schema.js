// The platform API's own tables (docs/platform.md). Columns it adds to the
// hub's tables (teams.kind, workspaces.external_id/metadata/mode,
// workspace_tokens.expires_at/agent_name) are migrated in src/hub/db.js.
//
// Every row carries team_id (the platform), and every query filters on it.
// Times are epoch milliseconds; the API shows them as Unix seconds.

export const PLATFORM_SCHEMA = `
CREATE TABLE IF NOT EXISTS platforms (
  team_id               TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  embed_allowed_origins TEXT NOT NULL DEFAULT '[]',   -- before 2026-11-11 (review M6); now in platform_settings, read once to migrate
  created_by            INTEGER NOT NULL,
  created_at            INTEGER NOT NULL
);

-- Settings per mode (review M6): a test key reads and changes only the test
-- row, a live key only the live one.
CREATE TABLE IF NOT EXISTS platform_settings (
  team_id               TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  mode                  TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  embed_allowed_origins TEXT NOT NULL DEFAULT '[]',   -- JSON array of origins, for frame-ancestors
  workspace_storage_mb  INTEGER NOT NULL DEFAULT 512, -- each workspace's storage limit (review M11)
  PRIMARY KEY (team_id, mode)
);

-- gpk_live_... / gpk_test_...: only the sha256 is stored.
CREATE TABLE IF NOT EXISTS platform_keys (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  mode         TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  hint         TEXT NOT NULL,
  created_by   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS platform_keys_team ON platform_keys(team_id);

-- Idempotency-Key replays for 24 h. body is sealed (AES-256-GCM, a key
-- derived from HUB_SECRET): a replayed token creation returns the token.
CREATE TABLE IF NOT EXISTS platform_idempotency (
  team_id      TEXT NOT NULL,
  key          TEXT NOT NULL,
  request_hash TEXT NOT NULL,            -- sha256 of mode, method, path and body
  status       INTEGER,                  -- NULL while the first request runs
  body         TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (team_id, key)
);

-- Embed sessions: a single-use link (url_hash) that becomes a cookie
-- (cookie_hash) scoped to one workspace's path.
CREATE TABLE IF NOT EXISTS embed_sessions (
  id                TEXT PRIMARY KEY,
  team_id           TEXT NOT NULL,
  workspace_id      TEXT NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('review', 'readonly')),
  theme             TEXT NOT NULL,
  parent_origin     TEXT NOT NULL,
  user_name         TEXT,
  brand             INTEGER NOT NULL DEFAULT 1, -- 0: the desk hides Grapim branding (?brand=0)
  key_mode          TEXT,                       -- 'live' | 'test': whose settings (origins) apply (migrated column)
  url_hash          TEXT NOT NULL,
  cookie_hash       TEXT,
  csrf              TEXT,
  ttl_ms            INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,    -- the link works until then
  used_at           INTEGER,
  cookie_expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS embed_sessions_ws ON embed_sessions(workspace_id);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id              TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  mode            TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  url             TEXT NOT NULL,
  events          TEXT NOT NULL,         -- JSON array of event types, or ["*"]
  secret_sealed   TEXT NOT NULL,         -- whsec_..., sealed: it is needed to sign
  hint            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  failing_since   INTEGER,               -- first failure since the last success
  last_success_at INTEGER,
  disabled_at     INTEGER,
  disabled_reason TEXT,
  backoff_until   INTEGER,               -- deliveries to it wait until then (it kept timing out or failing; migrated column)
  backoff_ms      INTEGER,               -- the current pause, doubled on each further failure
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_team ON webhook_endpoints(team_id);

-- The durable outbox: one event, one delivery per endpoint that wants it.
CREATE TABLE IF NOT EXISTS webhook_events (
  id           TEXT PRIMARY KEY,         -- evt_...
  team_id      TEXT NOT NULL,
  mode         TEXT NOT NULL,
  type         TEXT NOT NULL,
  workspace_id TEXT,
  payload      TEXT NOT NULL,            -- the exact JSON body that is signed and sent
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_events_team ON webhook_events(team_id, created_at);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL,
  endpoint_id     TEXT NOT NULL,
  team_id         TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_attempt_at INTEGER,
  last_status     INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  delivered_at    INTEGER
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_team ON webhook_deliveries(team_id, id);

-- Metering: per workspace per UTC day. storage_bytes is the daily sample.
CREATE TABLE IF NOT EXISTS usage_daily (
  team_id       TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  day           TEXT NOT NULL,           -- YYYY-MM-DD (UTC)
  mode          TEXT NOT NULL,           -- 'live' | 'test'
  writes        INTEGER NOT NULL DEFAULT 0,
  api_calls     INTEGER NOT NULL DEFAULT 0,
  storage_bytes INTEGER,
  PRIMARY KEY (workspace_id, day)
);
CREATE INDEX IF NOT EXISTS usage_daily_team ON usage_daily(team_id, mode, day);

-- How far the hub has read each platform workspace's own ledger (changes and
-- events ids), to meter writes and emit webhook events exactly once.
CREATE TABLE IF NOT EXISTS platform_cursors (
  workspace_id TEXT PRIMARY KEY,
  change_id    INTEGER NOT NULL,
  event_id     INTEGER NOT NULL
);

-- Stripe Billing Meter reports already sent, per (platform, day, meter).
CREATE TABLE IF NOT EXISTS meter_reports (
  team_id     TEXT NOT NULL,
  day         TEXT NOT NULL,
  meter       TEXT NOT NULL,
  value       INTEGER NOT NULL,
  identifier  TEXT NOT NULL,
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, day, meter)
);
`;

// Columns added after the tables first shipped, and the move of the shared
// embedding origins into one settings row per mode (both modes start with
// the origins the platform had). Safe to run at every start.
export function migratePlatform(db) {
  const addColumn = (table, column, type) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  addColumn('embed_sessions', 'key_mode', 'TEXT');
  addColumn('webhook_endpoints', 'backoff_until', 'INTEGER');
  addColumn('webhook_endpoints', 'backoff_ms', 'INTEGER');
  db.exec(`INSERT OR IGNORE INTO platform_settings (team_id, mode, embed_allowed_origins) SELECT team_id, 'live', embed_allowed_origins FROM platforms;
INSERT OR IGNORE INTO platform_settings (team_id, mode, embed_allowed_origins) SELECT team_id, 'test', embed_allowed_origins FROM platforms;`);
}
