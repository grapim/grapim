// The hub's database: one SQLite file in HUB_DATA. Every query below is a
// prepared statement with bound parameters; no SQL is ever built from input.
//
// Tenancy: every synced row carries team_id, and every read filters on it.
// Blobs are stored per team too, so one team can never learn whether another
// team holds some content (no cross-tenant dedupe oracle).

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PROVENANCE_SCHEMA } from './provenance.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,           -- the GitHub user id
  login      TEXT NOT NULL,
  name       TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT PRIMARY KEY,              -- sha256 of the session id in the cookie
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  next       TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  created_by      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  plan            TEXT NOT NULL DEFAULT 'free',
  seats           INTEGER,
  plan_status      TEXT,                     -- Stripe subscription status
  past_due_since   INTEGER,
  customer_id      TEXT,
  subscription_id  TEXT,
  period_end       INTEGER,
  billing_event_at INTEGER                   -- newest Stripe event applied, to ignore stale ones
);
CREATE INDEX IF NOT EXISTS teams_customer ON teams(customer_id);
CREATE INDEX IF NOT EXISTS teams_subscription ON teams(subscription_id);
CREATE TABLE IF NOT EXISTS members (
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
CREATE TABLE IF NOT EXISTS invites (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  used_by    INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS invites_team ON invites(team_id);
CREATE TABLE IF NOT EXISTS machine_tokens (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,         -- sha256 of the token; the token itself is never stored
  hint         TEXT NOT NULL,                -- the last 4 characters, to tell tokens apart
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS tokens_team ON machine_tokens(team_id);

CREATE TABLE IF NOT EXISTS repos (
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  id           TEXT NOT NULL,                -- sha1 of the repo's root commit
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_sync_at INTEGER,
  PRIMARY KEY (team_id, id)
);
-- One row per machine syncing a repo: who owns the name, and how far it got.
CREATE TABLE IF NOT EXISTS machines (
  team_id        TEXT NOT NULL,
  repo_id        TEXT NOT NULL,
  machine        TEXT NOT NULL,
  user_id        INTEGER NOT NULL,
  token_id       TEXT NOT NULL,
  cursor_changes INTEGER NOT NULL DEFAULT 0,
  cursor_events  INTEGER NOT NULL DEFAULT 0,
  cursor_agents  INTEGER NOT NULL DEFAULT 0,
  last_sync_at   INTEGER NOT NULL,
  PRIMARY KEY (team_id, repo_id, machine)
);
CREATE TABLE IF NOT EXISTS h_runs (
  team_id    TEXT NOT NULL,
  repo_id    TEXT NOT NULL,
  machine    TEXT NOT NULL,
  run        TEXT NOT NULL,
  turn       INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, repo_id, machine, run)
);
CREATE TABLE IF NOT EXISTS h_agents (
  team_id   TEXT NOT NULL,
  repo_id   TEXT NOT NULL,
  machine   TEXT NOT NULL,
  agent     TEXT NOT NULL,
  label     TEXT,
  intent    TEXT,
  worktree  TEXT,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (team_id, repo_id, machine, agent)
);
CREATE TABLE IF NOT EXISTS h_changes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    TEXT NOT NULL,
  repo_id    TEXT NOT NULL,
  machine    TEXT NOT NULL,
  local_id   INTEGER NOT NULL,
  run        TEXT NOT NULL,
  label      TEXT,
  turn       INTEGER NOT NULL,
  worktree   TEXT NOT NULL,
  path       TEXT NOT NULL,
  before_sha TEXT,
  after_sha  TEXT,
  untracked  INTEGER NOT NULL DEFAULT 0,
  added      INTEGER,
  removed    INTEGER,
  ts         INTEGER NOT NULL,
  UNIQUE (team_id, repo_id, machine, local_id)
);
CREATE INDEX IF NOT EXISTS h_changes_run ON h_changes(team_id, repo_id, run);
CREATE INDEX IF NOT EXISTS h_changes_file ON h_changes(team_id, repo_id, machine, worktree, path);
CREATE TABLE IF NOT EXISTS h_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id  TEXT NOT NULL,
  repo_id  TEXT NOT NULL,
  machine  TEXT NOT NULL,
  local_id INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  agent    TEXT NOT NULL,
  kind     TEXT NOT NULL,
  path     TEXT,
  detail   TEXT,
  UNIQUE (team_id, repo_id, machine, local_id)
);
CREATE INDEX IF NOT EXISTS h_events_repo ON h_events(team_id, repo_id, id);
CREATE TABLE IF NOT EXISTS h_blobs (
  team_id TEXT NOT NULL,
  sha     TEXT NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY (team_id, sha)
);
-- Stripe event ids already applied, so a redelivered or replayed event is a no-op.
CREATE TABLE IF NOT EXISTS billing_events (
  event_id   TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
-- Approximate bytes each team has synced (blobs plus rows), for the storage
-- quota. Cloud workspaces add the bytes of their folders (src/hub/workspaces.js).
CREATE TABLE IF NOT EXISTS team_usage (
  team_id TEXT PRIMARY KEY,
  bytes   INTEGER NOT NULL
);

-- Cloud workspaces (docs/workspaces.md section 1): a git repo per row at
-- HUB_DATA/workspaces/<team_id>/<id>/. The name is the URL segment
-- (/w/<team_id>/<name>/), unique among a team's live workspaces. Deleting is
-- soft: the folder moves to HUB_DATA/trash/ and deleted_at is set.
CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  bytes      INTEGER NOT NULL DEFAULT 0   -- the folder's size as last measured, counted in team_usage
);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_live_name ON workspaces(team_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS workspaces_team ON workspaces(team_id);
-- Workspace tokens (gws_...): one workspace each, read or write. Only the
-- sha256 is stored. The name is unique in its workspace for good (revoked
-- tokens keep theirs), because it is the agent namespace: http:<name>/<agent>.
CREATE TABLE IF NOT EXISTS workspace_tokens (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id      TEXT NOT NULL,
  user_id      INTEGER NOT NULL,
  name         TEXT NOT NULL,
  scope        TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  token_hash   TEXT NOT NULL UNIQUE,
  hint         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER,
  UNIQUE (workspace_id, name)
);
CREATE INDEX IF NOT EXISTS workspace_tokens_ws ON workspace_tokens(workspace_id);
`;

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, 'hub.db'));
  db.exec('PRAGMA busy_timeout = 15000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  // Columns added after v0 shipped, for hub.db files made before them.
  // teams.storage_url: the url (no credentials) of the team's own bucket for
  // workspace files, NULL for the hub's store. Set by src/hub/team-storage.js
  // when a move completes; the config and sealed credentials are in its
  // team_storage table (owner only).
  if (!db.prepare('PRAGMA table_info(teams)').all().some((c) => c.name === 'storage_url')) db.exec('ALTER TABLE teams ADD COLUMN storage_url TEXT');
  // Platforms (docs/platform.md): a team's kind, and what the platform API
  // adds to workspaces and their tokens. The platform's own tables are in
  // src/hub/platform/schema.js.
  const addColumn = (table, name, type) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  };
  addColumn('teams', 'kind', "TEXT NOT NULL DEFAULT 'team'"); // 'team' | 'platform'
  addColumn('workspaces', 'external_id', 'TEXT'); // the platform's id for its end customer
  addColumn('workspaces', 'metadata', 'TEXT'); // JSON, up to 4 KB
  addColumn('workspaces', 'mode', 'TEXT'); // 'test' for a platform's test-mode workspace, else NULL (live)
  // Bytes of every version uploaded to storage for this workspace (they also
  // count in team_usage): with `bytes`, what its own storage limit sees.
  addColumn('workspaces', 'stored_bytes', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('workspace_tokens', 'expires_at', 'INTEGER'); // NULL: never (tokens made in the hub UI)
  addColumn('workspace_tokens', 'agent_name', 'TEXT'); // pins the run identity to <name>/<agent_name>
  addColumn('workspace_tokens', 'scopes', 'TEXT'); // JSON [{ path, access }] (src/scope.js); NULL: the whole workspace
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS workspaces_external ON workspaces(team_id, COALESCE(mode, 'live'), external_id) WHERE deleted_at IS NULL AND external_id IS NOT NULL");
  // Provenance (docs/provenance.md section 3): the notes, and the GitHub
  // repo ("owner/name") a hub repo is synced from, at most one per repo.
  db.exec(PROVENANCE_SCHEMA);
  addColumn('repos', 'github', 'TEXT');
  // "No code storage" (src/hub/code-storage.js): 'metadata' keeps no file
  // contents (h_blobs) for the team; 'full' is the default.
  addColumn('teams', 'code_storage', "TEXT NOT NULL DEFAULT 'full'");
  db.exec('CREATE INDEX IF NOT EXISTS repos_github ON repos(team_id, github COLLATE NOCASE) WHERE github IS NOT NULL');
  return db;
}

// Runs fn in one write transaction.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  }
}
