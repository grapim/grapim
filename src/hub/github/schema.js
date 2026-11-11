// The GitHub App's tables (docs/provenance.md section 6). Created by
// createGitHubApp, like the platform's (src/hub/platform/schema.js), so the
// hub's own schema in db.js stays untouched.

export const GITHUB_SCHEMA = `
-- One row per installation of the App the hub has heard of (installation
-- events, or a lookup with the App JWT during linking). team_id is set only
-- by an owner linking it; events of an installation with no team are ignored.
CREATE TABLE IF NOT EXISTS gh_installations (
  id            INTEGER PRIMARY KEY,          -- GitHub installation id
  account_id    INTEGER,
  account_login TEXT,
  account_type  TEXT,                         -- 'User' | 'Organization'
  sender_id     INTEGER,                      -- the GitHub user who installed it (installation.created)
  team_id       TEXT REFERENCES teams(id) ON DELETE SET NULL,
  linked_by     INTEGER,
  linked_at     INTEGER,
  suspended_at  INTEGER,
  deleted_at    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gh_installations_team ON gh_installations(team_id);
CREATE INDEX IF NOT EXISTS gh_installations_sender ON gh_installations(sender_id);
CREATE TABLE IF NOT EXISTS gh_installation_repos (
  installation_id INTEGER NOT NULL,
  repo_id         INTEGER NOT NULL,           -- GitHub repository id
  full_name       TEXT NOT NULL,
  PRIMARY KEY (installation_id, repo_id)
);
-- X-GitHub-Delivery ids already handled, kept 7 days: a redelivery is a no-op.
CREATE TABLE IF NOT EXISTS gh_deliveries (
  id          TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gh_deliveries_at ON gh_deliveries(received_at);
-- Linking states handed to GitHub's install page: sha256 of the nonce only,
-- single use, 30 minutes. The state itself is HMAC-signed with HUB_SECRET.
CREATE TABLE IF NOT EXISTS gh_link_states (
  nonce_hash TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
-- A link waiting for GitHub's installation.created event (the setup redirect
-- can arrive first): completed only if that event's sender is user_id.
CREATE TABLE IF NOT EXISTS gh_pending_links (
  installation_id INTEGER PRIMARY KEY,
  team_id         TEXT NOT NULL,
  user_id         INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gh_team_policy (
  team_id            TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  require_review     INTEGER NOT NULL DEFAULT 0,
  require_provenance INTEGER NOT NULL DEFAULT 1,  -- counts only while require_review is on
  updated_by         INTEGER,
  updated_at         INTEGER
);
-- The agent runs each open pull request contains (as of its last check), so
-- a review in the hub can re-run the check of every pull request it affects.
-- Rows go when the pull request closes, or after 90 days without a push.
CREATE TABLE IF NOT EXISTS gh_pull_runs (
  team_id         TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  repo_gh_id      INTEGER NOT NULL,             -- GitHub repository id (the queue key)
  owner           TEXT NOT NULL,
  name            TEXT NOT NULL,
  number          INTEGER NOT NULL,
  head_sha        TEXT NOT NULL,
  run             TEXT NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (installation_id, repo_gh_id, number, run)
);
CREATE INDEX IF NOT EXISTS gh_pull_runs_run ON gh_pull_runs(team_id, run);
`;

// Columns added after the first release: CREATE TABLE IF NOT EXISTS leaves
// an existing table as it was.
export function migrateGitHubSchema(db) {
  const cols = db.prepare('PRAGMA table_info(gh_team_policy)').all().map((c) => c.name);
  if (!cols.includes('require_provenance')) db.exec('ALTER TABLE gh_team_policy ADD COLUMN require_provenance INTEGER NOT NULL DEFAULT 1');
}
