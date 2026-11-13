// The team read API: the docs/api.md shapes, computed from synced rows.
//
// Differences from the local server, by necessity:
// - The hub never sees a working tree. "In the tree" means: still present in
//   the newest synced version of the file on that machine.
// - Leases and review state are not synced in v0 (leases: [], review pending).
// - Every row also says which machine it came from.
// - Rows older than the plan's history window are not returned.

import { isTracked, replay } from '../attribution.js';
import { hunks } from './hunks.js';
import { HttpError } from './http.js';
import { provenanceFor, repoByGitHub } from './provenance.js';
import { codeStorageOf } from './code-storage.js';

export { provenanceFor, repoByGitHub };

const DAY = 24 * 60 * 60 * 1000;
const ACTIVE_MS = 60 * 60 * 1000;
const RECENT_MS = 60 * 60 * 1000;

// Work caps for one read request. The hub is one process for every team, so
// one team's synced content must not be able to stall or exhaust it: every
// blob handed to the diff/replay code counts against DIFF_BUDGET (cache hits
// included, because each use is diffed again), and past it the content is
// treated as "not kept" (state unknown, no diff). In-tree states are skipped
// when a repo has more than MAX_STATE_ROWS changes in the history window.
export const DIFF_BUDGET = 16 * 1024 * 1024;
export const MAX_STATE_ROWS = 20_000;

const RUN_STATE = { yes: 'all', partly: 'some', no: 'none' };
const FILE_STATE = { yes: 'in_tree', partly: 'partial', no: 'gone' };
const countOf = (who, run) => who.reduce((n, a) => n + (a?.run === run ? 1 : 0), 0);

export class TeamRead {
  constructor({ db, now, limits }) {
    this.db = db;
    this.now = now;
    this.limits = limits;
  }

  cutoff(team) {
    const days = this.limits(team).historyDays;
    return Number.isFinite(days) ? this.now() - days * DAY : 0;
  }

  repos(team) {
    const cut = this.cutoff(team);
    return this.db
      .prepare(
        `SELECT r.id, COALESCE(r.github, r.name) AS name, r.name AS folder, r.github, r.created_at, r.last_sync_at,
                (SELECT COUNT(*) FROM machines m WHERE m.team_id = r.team_id AND m.repo_id = r.id) AS machines,
                (SELECT COUNT(DISTINCT c.machine || '|' || c.run) FROM h_changes c WHERE c.team_id = r.team_id AND c.repo_id = r.id AND c.ts >= ?) AS runs,
                (SELECT MAX(c.ts) FROM h_changes c WHERE c.team_id = r.team_id AND c.repo_id = r.id) AS last_change_ts
         FROM repos r WHERE r.team_id = ? ORDER BY COALESCE(r.last_sync_at, r.created_at) DESC`,
      )
      .all(cut, team.id);
  }

  repo(team, repoId) {
    if (typeof repoId !== 'string' || !/^[0-9a-f]{40}$/.test(repoId)) return null;
    const r = this.db.prepare('SELECT * FROM repos WHERE team_id = ? AND id = ?').get(team.id, repoId);
    return r ? { ...r, folder: r.name, name: r.github || r.name } : null;
  }

  #blobs(teamId, budget = DIFF_BUDGET) {
    const cache = new Map();
    const get = this.db.prepare('SELECT content FROM h_blobs WHERE team_id = ? AND sha = ?');
    let left = budget;
    // null: the file did not exist; undefined: content not kept (or over budget).
    return (sha) => {
      if (sha === null) return null;
      if (left <= 0) return undefined;
      if (!cache.has(sha)) {
        const row = sha === 'untracked' ? undefined : get.get(teamId, sha);
        cache.set(sha, row ? Buffer.from(row.content) : undefined);
      }
      const buf = cache.get(sha);
      if (buf === undefined) return undefined;
      if (buf.length > left) {
        left = 0;
        cache.clear();
        return undefined;
      }
      left -= buf.length;
      return buf;
    };
  }

  // Ended sessions: Map("machine|agent" -> ts of their last end event).
  #ended(team, repo) {
    const rows = this.db
      .prepare("SELECT machine, agent, MAX(ts) AS ts FROM h_events WHERE team_id = ? AND repo_id = ? AND kind = 'end' GROUP BY machine, agent")
      .all(team.id, repo.id);
    return new Map(rows.map((r) => [`${r.machine}|${r.agent}`, r.ts]));
  }

  // For every file touched since the cutoff, which runs' lines are still in
  // its newest synced version. Map("machine|worktree|path" -> Map(run -> yes|no|partly|?)).
  #fileStates(team, repo, blob, onlyRuns = null) {
    const rows = this.db
      .prepare(
        `SELECT * FROM h_changes WHERE team_id = ? AND repo_id = ? AND ts >= ?
         ORDER BY machine, worktree, path, local_id LIMIT ?`,
      )
      .all(team.id, repo.id, this.cutoff(team), MAX_STATE_ROWS + 1);
    // Too much history to replay within one request: states stay unknown.
    if (rows.length > MAX_STATE_ROWS) return new Map();
    const byFile = new Map();
    for (const c of rows) {
      const k = `${c.machine}|${c.worktree}|${c.path}`;
      if (!byFile.has(k)) byFile.set(k, []);
      byFile.get(k).push(c);
    }
    const out = new Map();
    for (const [k, list] of byFile) {
      if (onlyRuns && !list.some((c) => onlyRuns.has(`${c.machine}|${c.run}`))) continue;
      const changes = list.map((c) => ({ ...c, before: blob(c.before_sha), after: blob(c.after_sha) }));
      const last = changes[changes.length - 1];
      const now = { sha: last.after_sha, buf: last.after ?? null };
      const states = new Map();
      if (!isTracked(changes, now)) {
        for (const c of changes) states.set(c.run, '?');
      } else {
        const r = replay(changes, now);
        for (const c of changes) {
          if (states.has(c.run)) continue;
          const mine = changes.filter((x) => x.run === c.run);
          const end = r.ends.get(c.run);
          const kept = countOf(r.who, c.run);
          let s;
          if (end > 0) s = kept === end ? 'yes' : kept === 0 ? 'no' : 'partly';
          else if (now.sha === mine[mine.length - 1].after_sha) s = 'yes';
          else if (now.sha === mine[0].before_sha) s = 'no';
          else s = '?';
          states.set(c.run, s);
        }
      }
      out.set(k, states);
    }
    return out;
  }

  #runRows(team, repo) {
    return this.db
      .prepare(
        `SELECT c.machine, c.run, MAX(c.label) AS change_label, MAX(c.worktree) AS change_worktree,
                COUNT(DISTINCT c.worktree || '|' || c.path) AS files,
                COALESCE(SUM(c.added), 0) AS added, COALESCE(SUM(c.removed), 0) AS removed,
                MIN(c.ts) AS first_ts, MAX(c.ts) AS last_ts,
                a.label AS agent_label, a.intent, a.worktree AS agent_worktree, a.last_seen,
                COALESCE(r.turn, MAX(c.turn)) AS turns
         FROM h_changes c
         LEFT JOIN h_agents a ON a.team_id = c.team_id AND a.repo_id = c.repo_id AND a.machine = c.machine AND a.agent = c.run
         LEFT JOIN h_runs r ON r.team_id = c.team_id AND r.repo_id = c.repo_id AND r.machine = c.machine AND r.run = c.run
         WHERE c.team_id = ? AND c.repo_id = ? AND c.ts >= ?
         GROUP BY c.machine, c.run ORDER BY MAX(c.ts) DESC, MAX(c.id) DESC LIMIT 500`,
      )
      .all(team.id, repo.id, this.cutoff(team));
  }

  #shape(row, ended, states) {
    const endTs = ended.get(`${row.machine}|${row.run}`);
    const seen = row.last_seen ?? row.last_ts;
    let in_tree = null;
    if (states) {
      const all = [];
      for (const [k, s] of states) if (k.startsWith(`${row.machine}|`) && s.has(row.run)) all.push(s.get(row.run));
      const known = all.filter((s) => s !== '?');
      const one = !known.length ? '?' : known.every((s) => s === known[0]) ? known[0] : 'partly';
      in_tree = RUN_STATE[one] ?? null;
    }
    return {
      run: row.run,
      label: row.agent_label || row.change_label || row.run,
      worktree: row.agent_worktree || row.change_worktree || null,
      machine: row.machine,
      intent: row.intent ?? null,
      turns: row.turns ?? 0,
      files: row.files,
      added: row.added,
      removed: row.removed,
      in_tree,
      first_ts: row.first_ts,
      last_ts: row.last_ts,
      active: this.now() - seen < ACTIVE_MS && !(endTs >= seen),
      review: { status: 'pending', note: null, at: null, by: null },
      branch: null,
    };
  }

  runs(team, repo) {
    const blob = this.#blobs(team.id);
    const rows = this.#runRows(team, repo);
    const states = this.#fileStates(team, repo, blob);
    const ended = this.#ended(team, repo);
    return rows.map((r) => this.#shape(r, ended, states));
  }

  // Finds a run by id, session prefix or label, like `grapim undo`.
  #findRun(rows, q, machine) {
    const pool = machine ? rows.filter((r) => r.machine === machine) : rows;
    const exact = pool.filter((r) => r.run === q);
    if (exact.length === 1) return exact[0];
    const loose = exact.length
      ? exact
      : pool.filter((r) => r.agent_label === q || r.change_label === q || r.run.startsWith(q) || r.run.split(':').pop().startsWith(q));
    if (loose.length === 1) return loose[0];
    if (!loose.length) throw new HttpError(404, 'not_found', `No run matches "${q}".`);
    throw new HttpError(409, 'conflict', `"${q}" matches ${loose.length} runs. Add ?machine= or use the full run id.`);
  }

  run(team, repo, q, machine = null) {
    if (typeof q !== 'string' || !q || q.length > 200) throw new HttpError(404, 'not_found', 'No such run.');
    const rows = this.#runRows(team, repo);
    const row = this.#findRun(rows, q, machine);
    const blob = this.#blobs(team.id);
    const states = this.#fileStates(team, repo, blob, new Set([`${row.machine}|${row.run}`]));
    const ended = this.#ended(team, repo);
    const summary = this.#shape(row, ended, states);

    const changes = this.db
      .prepare('SELECT * FROM h_changes WHERE team_id = ? AND repo_id = ? AND machine = ? AND run = ? AND ts >= ? ORDER BY local_id LIMIT ?')
      .all(team.id, repo.id, row.machine, row.run, this.cutoff(team), MAX_STATE_ROWS);
    const intents = this.db
      .prepare("SELECT ts, detail FROM h_events WHERE team_id = ? AND repo_id = ? AND machine = ? AND agent = ? AND kind = 'intent' ORDER BY ts, local_id LIMIT ?")
      .all(team.id, repo.id, row.machine, row.run, MAX_STATE_ROWS);

    // Linear in changes and intents (both can be large and are synced input).
    const turns = new Map();
    const seen = new Map();
    for (const c of changes) {
      if (!turns.has(c.turn)) {
        turns.set(c.turn, { turn: c.turn, intent: null, ts: c.ts, files: [] });
        seen.set(c.turn, new Set());
      }
      if (!seen.get(c.turn).has(c.path)) {
        seen.get(c.turn).add(c.path);
        turns.get(c.turn).files.push(c.path);
      }
    }
    const byTs = [...turns.values()].sort((a, b) => a.ts - b.ts);
    let i = 0;
    let said = null;
    for (const t of byTs) {
      while (i < intents.length && intents[i].ts <= t.ts) said = intents[i++].detail;
      t.intent = said;
    }

    const files = new Map();
    for (const c of changes) {
      const k = `${c.worktree}|${c.path}`;
      if (!files.has(k)) files.set(k, { worktree: c.worktree, path: c.path, first: c, last: c, added: 0, removed: 0, untracked: false, via: null });
      const f = files.get(k);
      f.last = c;
      if (c.via) f.via = c.via;
      f.added += c.added ?? 0;
      f.removed += c.removed ?? 0;
      f.untracked ||= !!c.untracked;
    }
    // "No code storage" (src/hub/code-storage.js): contents missing for that
    // reason say so (content: 'not_stored'), so a page can explain it.
    const metadataOnly = codeStorageOf(this.db, team.id) === 'metadata';
    const fileList = [...files.values()].map((f) => {
      const before = blob(f.first.before_sha);
      const after = blob(f.last.after_sha);
      const s = states.get(`${row.machine}|${f.worktree}|${f.path}`)?.get(row.run) ?? '?';
      const untracked = f.untracked || before === undefined || after === undefined;
      return {
        path: f.path,
        worktree: f.worktree,
        added: f.added,
        removed: f.removed,
        untracked,
        state: FILE_STATE[s] ?? null,
        // stored | untracked (binary, over 2 MB, not tracked) | not_stored (No code storage)
        content: !untracked ? 'stored' : f.untracked || !metadataOnly ? 'untracked' : 'not_stored',
        diff: untracked ? null : { hunks: hunks(before, after) },
        via: f.via,
      };
    });
    return { run: summary, turns: [...turns.values()].sort((a, b) => a.turn - b.turn), files: fileList };
  }

  overview(team, repo) {
    const t = this.now();
    const ended = this.#ended(team, repo);
    const agents = this.db
      .prepare('SELECT * FROM h_agents WHERE team_id = ? AND repo_id = ? AND last_seen > ? ORDER BY last_seen DESC LIMIT 200')
      .all(team.id, repo.id, t - RECENT_MS)
      .filter((a) => !(ended.get(`${a.machine}|${a.agent}`) >= a.last_seen))
      .map((a) => ({ agent: a.agent, label: a.label || a.agent, worktree: a.worktree, machine: a.machine, intent: a.intent, last_seen: a.last_seen, files: [] }));
    const worktrees = this.db
      .prepare('SELECT DISTINCT machine, worktree FROM h_changes WHERE team_id = ? AND repo_id = ? ORDER BY machine, worktree LIMIT 200')
      .all(team.id, repo.id)
      .map((w) => ({ name: w.worktree, root: null, branch: null, machine: w.machine }));
    const runs = this.db
      .prepare('SELECT COUNT(DISTINCT machine || \'|\' || run) AS n FROM h_changes WHERE team_id = ? AND repo_id = ? AND ts >= ?')
      .get(team.id, repo.id, this.cutoff(team)).n;
    return {
      repo: repo.name,
      repo_id: repo.id,
      root: null,
      worktrees,
      agents,
      leases: [],
      counts: { agents: agents.length, leases: 0, runs, unreviewed: runs },
      hub: { read_only: true, note: 'The hub is read-only for code in v0. Undo, review and branch run locally with grapim serve.' },
    };
  }

  events(team, repo, { after = null, limit = 100 } = {}) {
    const n = Math.min(Math.max(1, Number(limit) || 100), 500);
    const cut = this.cutoff(team);
    const sql = `SELECT e.id, e.ts, e.agent, a.label, e.kind, e.path, e.detail, e.machine
                 FROM h_events e LEFT JOIN h_agents a ON a.team_id = e.team_id AND a.repo_id = e.repo_id AND a.machine = e.machine AND a.agent = e.agent
                 WHERE e.team_id = ? AND e.repo_id = ? AND e.ts >= ?`;
    if (after !== null && after !== '') {
      const id = Number(after);
      if (!Number.isSafeInteger(id) || id < 0) throw new HttpError(400, 'bad_request', 'after must be an event id.');
      return this.db.prepare(`${sql} AND e.id > ? ORDER BY e.id LIMIT ?`).all(team.id, repo.id, cut, id, n);
    }
    return this.db.prepare(`${sql} ORDER BY e.id DESC LIMIT ?`).all(team.id, repo.id, cut, n).reverse();
  }

  lastEventId(team, repo) {
    return this.db.prepare('SELECT MAX(id) AS id FROM h_events WHERE team_id = ? AND repo_id = ?').get(team.id, repo.id).id ?? 0;
  }

  // { [sha]: note } for commits of one of the team's repos (docs/provenance.md
  // section 3), for the GitHub App and the reports.
  provenanceFor(team, repoId, shas, opts) {
    return provenanceFor(this.db, team, repoId, shas, opts);
  }

  // The team's hub repos synced from a GitHub repo ("owner/name").
  repoByGitHub(team, fullName) {
    return repoByGitHub(this.db, team, fullName);
  }
}
