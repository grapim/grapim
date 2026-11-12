// Reviews made in the hub (docs/provenance.md section 6, "Reviews"): the only
// approvals the `require_review` policy counts.
//
// A signed-in member approves or rejects a synced run on its hub run page,
// after reading its diff from the synced blobs. The run's owners (every hub
// user whose machine synced rows of that run: machines.user_id, fixed by the
// first sync of a machine name and enforced by ingest's machine_taken check)
// may not review it, so nobody approves their own work. Approvals synced from a
// machine (`grapim review`, h_events kind 'review') stay informational.
//
// An approval covers what the reviewer saw: it records the run's newest synced
// change (h_changes.id). When more changes of the run are synced later, the
// approval is stale and the run needs a new one.
//
// Every row is keyed by team; every query filters on team_id.

export const HUB_REVIEWS_SCHEMA = `
CREATE TABLE IF NOT EXISTS hub_reviews (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id          TEXT NOT NULL,
  repo_id          TEXT NOT NULL,
  run              TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('approved', 'rejected')),
  reviewer_user_id INTEGER NOT NULL,
  reviewed_at      INTEGER NOT NULL,
  note             TEXT,
  seen_change      INTEGER NOT NULL DEFAULT 0,  -- the run's newest h_changes.id the reviewer saw
  via              TEXT,                        -- 'hub' (the run page) or 'github' (the check's button); NULL before
  rules            TEXT                         -- JSON: the path rules that applied when it was made
);
CREATE INDEX IF NOT EXISTS hub_reviews_run ON hub_reviews(team_id, run, id);
`;

// Columns added after the first release.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(hub_reviews)').all().map((c) => c.name);
  if (!cols.includes('via')) db.exec('ALTER TABLE hub_reviews ADD COLUMN via TEXT');
  if (!cols.includes('rules')) db.exec('ALTER TABLE hub_reviews ADD COLUMN rules TEXT');
}

export const STATUSES = Object.freeze(['approved', 'rejected']);
export const MAX_NOTE = 1000;
const MAX_RUNS = 5000;
const SHA = /^[0-9a-f]{40}$/;

const chunks = (list, n = 400) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};
const marks = (list) => list.map(() => '?').join(',');
const teamIdOf = (team) => (typeof team === 'string' ? team : team?.id);

export class HubReviews {
  constructor({ db, now }) {
    this.db = db;
    this.now = now;
    db.exec(HUB_REVIEWS_SCHEMA);
    migrate(db);
  }

  #repoIds(teamId) {
    return this.db.prepare('SELECT id FROM repos WHERE team_id = ?').all(teamId).map((r) => r.id);
  }

  // The hub users whose machines synced rows of this run, in any of the team's repos.
  owners(team, run) {
    const teamId = teamIdOf(team);
    const out = new Set();
    if (!teamId || typeof run !== 'string' || !run) return out;
    const q = this.db.prepare(
      `SELECT DISTINCT m.user_id FROM machines m
       WHERE m.team_id = ? AND m.repo_id = ? AND m.machine IN (
         SELECT machine FROM h_changes WHERE team_id = ? AND repo_id = ? AND run = ?
         UNION SELECT machine FROM h_runs WHERE team_id = ? AND repo_id = ? AND run = ?)`,
    );
    for (const repoId of this.#repoIds(teamId)) {
      for (const r of q.all(teamId, repoId, teamId, repoId, run, teamId, repoId, run)) out.add(r.user_id);
    }
    return out;
  }

  // The run's newest synced change in one repo (0: none).
  headChange(team, repoId, run) {
    return this.db.prepare('SELECT MAX(id) AS id FROM h_changes WHERE team_id = ? AND repo_id = ? AND run = ?').get(teamIdOf(team), repoId, run)?.id ?? 0;
  }

  // Records a decision. Throws { code } errors the route maps to HTTP:
  // bad_request, not_found (nothing of this run synced), own_run.
  // opts: { via: 'hub' | 'github', rules: [the path rules that applied] }.
  record(team, repoId, run, status, userId, note = null, { via = 'hub', rules = null } = {}) {
    const teamId = teamIdOf(team);
    const fail = (code, message) => Object.assign(new Error(message), { code });
    if (typeof repoId !== 'string' || !SHA.test(repoId) || typeof run !== 'string' || !run || run.length > 200) throw fail('not_found', 'No such run.');
    const head = this.headChange(teamId, repoId, run);
    if (!head) throw fail('not_found', 'Nothing of this run was synced to the hub, so there is nothing to review.');
    if (!STATUSES.includes(status)) throw fail('bad_request', 'Choose approve or reject.');
    const text = typeof note === 'string' ? note.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE) : '';
    const owners = this.owners(teamId, run);
    if (!Number.isSafeInteger(userId) || owners.has(userId)) throw fail('own_run', 'You synced this run, so another member has to review it.');
    const reviewed_at = this.now();
    this.db
      .prepare('INSERT INTO hub_reviews (team_id, repo_id, run, status, reviewer_user_id, reviewed_at, note, seen_change, via, rules) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(teamId, repoId, run, status, userId, reviewed_at, text || null, head, via === 'github' ? 'github' : 'hub', Array.isArray(rules) && rules.length ? JSON.stringify(rules.slice(0, 50).map((r) => ({ id: r.id, pattern: r.pattern, approvals: r.approvals, approvers: r.approvers }))) : null);
    return { status, reviewer_user_id: userId, reviewed_at, note: text || null, seen_change: head, via: via === 'github' ? 'github' : 'hub' };
  }

  // The members whose own newest decision on the run is a current approval
  // (it saw the run's newest change in that repo): [{ user_id, login, reviewed_at, via }].
  approvals(team, repoIds, run) {
    const teamId = teamIdOf(team);
    const repos = [...new Set(repoIds)].filter((r) => typeof r === 'string' && SHA.test(r));
    if (!teamId || !repos.length || typeof run !== 'string' || !run) return [];
    const rows = this.db
      .prepare(
        `SELECT r.*, u.login FROM hub_reviews r LEFT JOIN users u ON u.id = r.reviewer_user_id
         WHERE r.team_id = ? AND r.repo_id IN (${marks(repos)}) AND r.run = ? ORDER BY r.id`,
      )
      .all(teamId, ...repos, run);
    const newest = new Map();
    for (const r of rows) newest.set(r.reviewer_user_id, r);
    const head = new Map(repos.map((id) => [id, this.headChange(teamId, id, run)]));
    return [...newest.values()]
      .filter((r) => r.status === 'approved' && r.seen_change >= (head.get(r.repo_id) ?? 0))
      .map((r) => ({ user_id: r.reviewer_user_id, login: r.login ?? null, reviewed_at: r.reviewed_at, via: r.via ?? 'hub' }));
  }

  // Every decision on the run, oldest first (the audit evidence).
  history(team, repoIds, run) {
    const teamId = teamIdOf(team);
    const repos = [...new Set(repoIds)].filter((r) => typeof r === 'string' && SHA.test(r));
    if (!teamId || !repos.length) return [];
    return this.db
      .prepare(
        `SELECT r.status, r.reviewed_at, r.note, r.via, r.rules, r.seen_change, r.repo_id, r.reviewer_user_id, u.login FROM hub_reviews r LEFT JOIN users u ON u.id = r.reviewer_user_id
         WHERE r.team_id = ? AND r.repo_id IN (${marks(repos)}) AND r.run = ? ORDER BY r.id LIMIT 200`,
      )
      .all(teamId, ...repos, run);
  }

  // Map run -> the newest hub decision for it in any of `repoIds`:
  // { status, repo_id, reviewer_user_id, reviewer_login, reviewed_at, note, stale }.
  // stale: the run has synced changes the reviewer did not see.
  latest(team, repoIds, runIds) {
    const teamId = teamIdOf(team);
    const out = new Map();
    const ids = [...new Set(runIds)].filter((r) => typeof r === 'string' && r).slice(0, MAX_RUNS);
    const repos = [...new Set(repoIds)].filter((r) => typeof r === 'string' && SHA.test(r));
    if (!teamId || !ids.length || !repos.length) return out;
    const head = this.db.prepare('SELECT MAX(id) AS id FROM h_changes WHERE team_id = ? AND repo_id = ? AND run = ?');
    for (const part of chunks(ids)) {
      const rows = this.db
        .prepare(
          `SELECT r.*, u.login AS reviewer_login FROM hub_reviews r LEFT JOIN users u ON u.id = r.reviewer_user_id
           WHERE r.team_id = ? AND r.repo_id IN (${marks(repos)}) AND r.run IN (${marks(part)}) ORDER BY r.id`,
        )
        .all(teamId, ...repos, ...part);
      for (const r of rows) {
        const now = head.get(teamId, r.repo_id, r.run)?.id ?? 0;
        out.set(r.run, {
          status: r.status,
          repo_id: r.repo_id,
          reviewer_user_id: r.reviewer_user_id,
          reviewer_login: r.reviewer_login ?? null,
          reviewed_at: r.reviewed_at,
          note: r.note,
          via: r.via ?? 'hub',
          stale: now > r.seen_change,
        });
      }
    }
    return out;
  }

  // Approvals synced from machines (`grapim review`): informational only.
  // Map run -> { status, login, machine, ts } (newest event).
  local(team, repoIds, runIds) {
    const teamId = teamIdOf(team);
    const out = new Map();
    const ids = [...new Set(runIds)].filter((r) => typeof r === 'string' && r).slice(0, MAX_RUNS);
    const repos = [...new Set(repoIds)].filter((r) => typeof r === 'string');
    if (!teamId || !ids.length || !repos.length) return out;
    for (const part of chunks(ids)) {
      const rows = this.db
        .prepare(
          `SELECT e.agent, e.detail, e.ts, e.id, e.machine, u.login FROM h_events e
           LEFT JOIN machines m ON m.team_id = e.team_id AND m.repo_id = e.repo_id AND m.machine = e.machine
           LEFT JOIN users u ON u.id = m.user_id
           WHERE e.team_id = ? AND e.repo_id IN (${marks(repos)}) AND e.kind = 'review' AND e.agent IN (${marks(part)})
           ORDER BY e.ts, e.id`,
        )
        .all(teamId, ...repos, ...part);
      for (const r of rows) {
        const status = /^(pending|approved|rejected)\b/.exec(String(r.detail ?? ''))?.[1];
        if (status) out.set(r.agent, { status, login: r.login ?? null, machine: r.machine, ts: r.ts });
      }
    }
    return out;
  }

  // Where to review a run: Map run -> { repo_id, machine } of its newest synced change.
  places(team, repoIds, runIds) {
    const teamId = teamIdOf(team);
    const out = new Map();
    const ids = [...new Set(runIds)].filter((r) => typeof r === 'string' && r).slice(0, MAX_RUNS);
    const repos = [...new Set(repoIds)].filter((r) => typeof r === 'string');
    if (!teamId || !ids.length || !repos.length) return out;
    for (const part of chunks(ids)) {
      const rows = this.db
        .prepare(
          `SELECT repo_id, machine, run, MAX(id) AS id FROM h_changes
           WHERE team_id = ? AND repo_id IN (${marks(repos)}) AND run IN (${marks(part)}) GROUP BY repo_id, machine, run ORDER BY id`,
        )
        .all(teamId, ...repos, ...part);
      for (const r of rows) out.set(r.run, { repo_id: r.repo_id, machine: r.machine });
    }
    return out;
  }
}
