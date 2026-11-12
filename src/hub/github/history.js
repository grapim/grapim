// The 90-day AI history scan (research/core-features-2026-11.md, feature 1).
//
// When a team links the GitHub App (or an owner asks, from Settings ->
// GitHub), the hub reads the pull requests merged in the last 90 days in the
// repositories the installation can see, with the App's installation token:
// each commit's author and Co-authored-by trailers (src/hub/github/agents.js)
// and each pull request's approving reviews. The result answers: how many
// merged pull requests had commits from AI agents, and how many of those were
// merged without an approval from someone other than the author.
//
// - GraphQL, 20 pull requests a page, newest update first; a repo stops at
//   the first pull request last updated before the window.
// - Capped: MAX_REPOS repos (most recently pushed), MAX_PRS_PER_REPO and
//   MAX_PRS pull requests, 100 commits per pull request. Caps are recorded and
//   shown, so the numbers read "at least".
// - One scan runs at a time, hub wide. Its position is saved after every page
//   (state JSON), so a restart or a rate limit resumes where it stopped.
//   When GitHub's remaining GraphQL points fall under RESERVE, the scan
//   waits for the reset instead of starving the App's pull request checks.
// - Every query is scoped by team id; rows hold only what the report shows
//   (repo, number, title, author login, merge time, agents, approvers).

import { tx } from '../db.js';
import { HttpError } from '../http.js';
import { approvedByOther, detectAgents } from './agents.js';
import { GitHubClient, RateLimitError } from './client.js';

export const WINDOW_DAYS = 90;
export const MAX_REPOS = 50;
export const MAX_PRS_PER_REPO = 400;
export const MAX_PRS = 2000;
export const PAGE = 20;
export const RESERVE = 300; // GraphQL points left for the App's own checks
export const RESCAN_MS = 60 * 60 * 1000; // an owner may start a new scan at most hourly
const DAY = 24 * 60 * 60 * 1000;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export const HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS gh_history_scans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,                 -- queued | running | waiting | done | failed
  reason       TEXT NOT NULL,                 -- install | manual
  requested_by INTEGER,
  since        INTEGER NOT NULL,              -- merged at or after (epoch ms)
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER,
  resume_at    INTEGER,
  state        TEXT,                          -- JSON { repos: [{ inst, id, full_name }], i, cursor, n }
  repos_total  INTEGER NOT NULL DEFAULT 0,
  repos_done   INTEGER NOT NULL DEFAULT 0,
  prs_scanned  INTEGER NOT NULL DEFAULT 0,
  capped       TEXT,                          -- JSON list of caps hit
  error        TEXT
);
CREATE INDEX IF NOT EXISTS gh_history_scans_team ON gh_history_scans(team_id, id);
CREATE TABLE IF NOT EXISTS gh_history_prs (
  scan_id        INTEGER NOT NULL REFERENCES gh_history_scans(id) ON DELETE CASCADE,
  team_id        TEXT NOT NULL,
  repo           TEXT NOT NULL,               -- owner/name
  number         INTEGER NOT NULL,
  title          TEXT,
  author         TEXT,
  merged_at      INTEGER NOT NULL,
  agents         TEXT NOT NULL,               -- JSON [{ agent, how: [...] }], [] when no signal
  ai             INTEGER NOT NULL,
  approved_other INTEGER NOT NULL,
  approvers      TEXT,                        -- JSON [login]
  commits        INTEGER,                     -- total commits
  commits_seen   INTEGER,                     -- commits read (at most 100)
  PRIMARY KEY (scan_id, repo, number)
);
`;

const QUERY = `query($owner:String!,$name:String!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:MERGED,orderBy:{field:UPDATED_AT,direction:DESC},first:${PAGE},after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{
        number title mergedAt updatedAt
        author{login __typename}
        mergeCommit{message}
        commits(first:100){totalCount nodes{commit{message author{name email user{login}}}}}
        reviews(states:APPROVED,first:50){nodes{author{login __typename}}}
      }
    }
  }
  rateLimit{remaining resetAt}
}`;

const say = (err) => String(err?.message ?? err ?? 'error').replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 300);
const json = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

export class HistoryScans {
  // client(installationId, signal) -> GitHubClient (tests can replace it)
  constructor({ db, now, log, auth, apiBase, fetch, sleep, maxWaitMs = 60_000, signal = null, timers = true, rescanMs = RESCAN_MS }) {
    this.db = db;
    this.now = now;
    this.log = log;
    this.auth = auth;
    this.apiBase = apiBase;
    this.fetch = fetch;
    this.sleep = sleep;
    this.maxWaitMs = maxWaitMs;
    this.signal = signal;
    this.timers = timers;
    this.rescanMs = rescanMs;
    this.active = null; // promise of the running scan
    this.timer = null;
    this.idlers = [];
    db.exec(HISTORY_SCHEMA);
  }

  get(teamId, id) {
    return this.db.prepare('SELECT * FROM gh_history_scans WHERE team_id = ? AND id = ?').get(teamId, id) ?? null;
  }

  latest(teamId) {
    return this.db.prepare('SELECT * FROM gh_history_scans WHERE team_id = ? ORDER BY id DESC LIMIT 1').get(teamId) ?? null;
  }

  // Queues a scan of the team's linked installations. reason: 'install' |
  // 'manual'. A manual scan is refused while one is open or within an hour
  // of the last one; an install scan is skipped (null) in those cases.
  start(teamId, userId, reason = 'manual') {
    const last = this.latest(teamId);
    const open = last && ['queued', 'running', 'waiting'].includes(last.status);
    const recent = last && last.status === 'done' && this.now() - (last.finished_at ?? 0) < this.rescanMs;
    if (open || recent) {
      if (reason !== 'manual') return null;
      throw new HttpError(429, 'too_soon', open ? 'A history scan is already running.' : 'The last scan finished less than an hour ago. Try again later.');
    }
    const t = this.now();
    const r = this.db
      .prepare('INSERT INTO gh_history_scans (team_id, status, reason, requested_by, since, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(teamId, 'queued', reason === 'install' ? 'install' : 'manual', Number.isSafeInteger(userId) ? userId : null, t - WINDOW_DAYS * DAY, t);
    this.kick();
    return this.get(teamId, Number(r.lastInsertRowid));
  }

  // Runs queued and due scans, one at a time.
  kick() {
    if (this.active || this.signal?.aborted) return;
    const next = this.db
      .prepare("SELECT * FROM gh_history_scans WHERE status IN ('queued', 'running') OR (status = 'waiting' AND COALESCE(resume_at, 0) <= ?) ORDER BY id LIMIT 1")
      .get(this.now());
    if (!next) {
      this.#wake();
      for (const r of this.idlers.splice(0)) r();
      return;
    }
    this.active = this.#run(next)
      .catch((err) => this.log(`github history scan failed: ${say(err)}`))
      .finally(() => {
        this.active = null;
        setImmediate(() => this.kick());
      });
  }

  // A timer for the earliest waiting scan.
  #wake() {
    if (!this.timers) return;
    clearTimeout(this.timer);
    const w = this.db.prepare("SELECT MIN(resume_at) AS t FROM gh_history_scans WHERE status = 'waiting'").get()?.t;
    if (!w) return;
    this.timer = setTimeout(() => this.kick(), Math.max(1000, Math.min(w - this.now(), 60 * 60 * 1000)));
    this.timer.unref?.();
  }

  // Resolves when no scan is running or due (tests).
  idle() {
    if (!this.active) return Promise.resolve();
    return new Promise((r) => this.idlers.push(r));
  }

  close() {
    clearTimeout(this.timer);
  }

  #save(scan, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE gh_history_scans SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), scan.id);
    Object.assign(scan, fields);
  }

  async #client(installationId) {
    const token = await this.auth.installationToken(installationId);
    return new GitHubClient({ apiBase: this.apiBase, token, fetch: this.fetch, now: this.now, sleep: this.sleep, signal: this.signal, maxWaitMs: this.maxWaitMs });
  }

  // The repos to read: every linked installation's, most recently pushed
  // first, skipping archived ones and those with no push in the window.
  async #repos(scan) {
    const installs = this.db.prepare('SELECT id FROM gh_installations WHERE team_id = ? AND deleted_at IS NULL AND suspended_at IS NULL ORDER BY id').all(scan.team_id);
    const all = [];
    for (const i of installs) {
      const gh = await this.#client(i.id);
      for (let page = 1; page <= 10; page++) {
        const r = await gh.rest('GET', `/installation/repositories?per_page=100&page=${page}`);
        const list = Array.isArray(r?.repositories) ? r.repositories : [];
        for (const x of list) {
          if (typeof x?.full_name !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(x.full_name)) continue;
          const pushed = Date.parse(x.pushed_at ?? '') || 0;
          if (x.archived || pushed < scan.since) continue;
          all.push({ inst: i.id, id: x.id, full_name: x.full_name, pushed });
        }
        if (list.length < 100) break;
      }
    }
    const seen = new Set();
    const unique = all.sort((a, b) => b.pushed - a.pushed).filter((r) => !seen.has(r.full_name.toLowerCase()) && seen.add(r.full_name.toLowerCase()));
    return { repos: unique.slice(0, MAX_REPOS).map(({ inst, id, full_name }) => ({ inst, id, full_name })), capped: unique.length > MAX_REPOS };
  }

  async #run(scan) {
    const caps = new Set(json(scan.capped, []));
    let state = json(scan.state, null);
    this.#save(scan, { status: 'running', started_at: scan.started_at ?? this.now(), resume_at: null });
    try {
      if (!state) {
        const { repos, capped } = await this.#repos(scan);
        if (capped) caps.add(`repos: the ${MAX_REPOS} most recently pushed`);
        state = { repos, i: 0, cursor: null, n: 0 };
        this.#save(scan, { state: JSON.stringify(state), repos_total: repos.length, capped: JSON.stringify([...caps]) });
      }
      const put = this.db.prepare(
        `INSERT OR REPLACE INTO gh_history_prs (scan_id, team_id, repo, number, title, author, merged_at, agents, ai, approved_other, approvers, commits, commits_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let clients = new Map();
      while (state.i < state.repos.length) {
        if (this.signal?.aborted) return;
        const repo = state.repos[state.i];
        const [owner, name] = repo.full_name.split('/');
        let done = !NAME.test(owner) || !NAME.test(name);
        if (!done) {
          if (!clients.has(repo.inst)) clients.set(repo.inst, await this.#client(repo.inst));
          const gh = clients.get(repo.inst);
          const { data, errors } = await gh.graphql(QUERY, { owner, name, after: state.cursor });
          const conn = data?.repository?.pullRequests;
          if (!conn) {
            // A repo GitHub will not show (removed from the installation, renamed): skip it.
            if (errors.length) caps.add(`${repo.full_name}: not readable`);
            done = true;
          } else {
            const nodes = Array.isArray(conn.nodes) ? conn.nodes : [];
            let older = false;
            tx(this.db, () => {
              for (const pr of nodes) {
                const updated = Date.parse(pr?.updatedAt ?? '') || 0;
                if (updated && updated < scan.since) {
                  older = true;
                  break;
                }
                const merged = Date.parse(pr?.mergedAt ?? '') || 0;
                if (!merged || merged < scan.since || !Number.isSafeInteger(pr?.number)) continue;
                const commits = (pr.commits?.nodes ?? []).map((n) => n?.commit).filter(Boolean);
                const agents = detectAgents({ author: pr.author, commits, mergeCommit: pr.mergeCommit });
                const approvers = approvedByOther({ author: pr.author, reviews: pr.reviews?.nodes ?? [] });
                const total = Number(pr.commits?.totalCount) || commits.length;
                if (total > commits.length) caps.add('pull requests with more than 100 commits: first 100 read');
                put.run(
                  scan.id,
                  scan.team_id,
                  repo.full_name,
                  pr.number,
                  String(pr.title ?? '').slice(0, 300),
                  typeof pr.author?.login === 'string' ? pr.author.login.slice(0, 100) : null,
                  merged,
                  JSON.stringify([...agents].map(([agent, how]) => ({ agent, how: [...how] }))),
                  agents.size ? 1 : 0,
                  approvers.length ? 1 : 0,
                  JSON.stringify(approvers.slice(0, 20)),
                  total,
                  commits.length,
                );
                state.n++;
              }
            });
            const total = this.db.prepare('SELECT COUNT(*) AS n FROM gh_history_prs WHERE scan_id = ? AND repo = ?').get(scan.id, repo.full_name).n;
            if (total >= MAX_PRS_PER_REPO) caps.add(`${repo.full_name}: the ${MAX_PRS_PER_REPO} most recently updated pull requests`);
            if (older || !conn.pageInfo?.hasNextPage || total >= MAX_PRS_PER_REPO) done = true;
            else state.cursor = conn.pageInfo.endCursor;
          }
          const scanned = this.db.prepare('SELECT COUNT(*) AS n FROM gh_history_prs WHERE scan_id = ?').get(scan.id).n;
          if (scanned >= MAX_PRS) {
            caps.add(`${MAX_PRS} pull requests in all`);
            state.i = state.repos.length;
            done = false;
          }
          // Leave GitHub points for the pull request checks: wait for the reset.
          const left = Number(data?.rateLimit?.remaining);
          if (Number.isFinite(left) && left < RESERVE && state.i < state.repos.length) {
            if (done) {
              state.i++;
              state.cursor = null;
            }
            const reset = Date.parse(data.rateLimit.resetAt ?? '') || this.now() + 15 * 60 * 1000;
            this.#save(scan, { status: 'waiting', resume_at: Math.max(this.now() + 1000, reset + 5000), state: JSON.stringify(state), prs_scanned: scanned, repos_done: Math.min(state.i, state.repos.length), capped: JSON.stringify([...caps]) });
            return;
          }
          this.#save(scan, { prs_scanned: scanned });
        }
        if (done) {
          state.i++;
          state.cursor = null;
        }
        this.#save(scan, { state: JSON.stringify(state), repos_done: Math.min(state.i, state.repos.length), capped: JSON.stringify([...caps]) });
      }
      clients = null;
      this.#save(scan, { status: 'done', finished_at: this.now(), state: null, repos_done: state.repos.length });
      this.log(`github history scan done: ${scan.prs_scanned} pull requests`);
    } catch (err) {
      if (err instanceof RateLimitError) {
        this.#save(scan, { status: 'waiting', resume_at: this.now() + 15 * 60 * 1000, state: state ? JSON.stringify(state) : null, capped: JSON.stringify([...caps]) });
        return;
      }
      if (this.signal?.aborted) return; // shutdown: resumes at the next boot
      this.#save(scan, { status: 'failed', finished_at: this.now(), error: say(err), capped: JSON.stringify([...caps]) });
    }
  }

  // ---- The report ----

  // The newest scan with results (running or done), aggregated.
  report(teamId, scanId = null) {
    const scan = scanId ? this.get(teamId, scanId) : this.latest(teamId);
    if (!scan) return null;
    const rows = this.db.prepare('SELECT * FROM gh_history_prs WHERE scan_id = ? AND team_id = ? ORDER BY merged_at DESC').all(scan.id, teamId);
    const prs = rows.map((r) => ({
      repo: r.repo,
      number: r.number,
      title: r.title,
      author: r.author,
      merged_at: r.merged_at,
      url: `https://github.com/${r.repo}/pull/${r.number}`,
      agents: json(r.agents, []),
      ai: !!r.ai,
      approved_other: !!r.approved_other,
      approvers: json(r.approvers, []),
      commits: r.commits,
      commits_seen: r.commits_seen,
    }));
    const ai = prs.filter((p) => p.ai);
    const unapproved = ai.filter((p) => !p.approved_other);
    const byRepo = new Map();
    const byAgent = new Map();
    for (const p of prs) {
      const r = byRepo.get(p.repo) ?? { repo: p.repo, merged: 0, ai: 0, unapproved: 0 };
      r.merged++;
      if (p.ai) r.ai++;
      if (p.ai && !p.approved_other) r.unapproved++;
      byRepo.set(p.repo, r);
      for (const a of p.agents) {
        const g = byAgent.get(a.agent) ?? { agent: a.agent, prs: 0, unapproved: 0, how: new Set() };
        g.prs++;
        if (!p.approved_other) g.unapproved++;
        for (const h of a.how ?? []) g.how.add(h);
        byAgent.set(a.agent, g);
      }
    }
    return {
      scan: {
        id: scan.id,
        status: scan.status,
        reason: scan.reason,
        since: scan.since,
        created_at: scan.created_at,
        finished_at: scan.finished_at,
        resume_at: scan.resume_at,
        repos_total: scan.repos_total,
        repos_done: scan.repos_done,
        prs_scanned: scan.prs_scanned,
        capped: json(scan.capped, []),
        error: scan.error,
      },
      totals: { merged: prs.length, ai: ai.length, unapproved: unapproved.length },
      repos: [...byRepo.values()].sort((a, b) => b.ai - a.ai || b.merged - a.merged || a.repo.localeCompare(b.repo)),
      agents: [...byAgent.values()].map((g) => ({ ...g, how: [...g.how] })).sort((a, b) => b.prs - a.prs || a.agent.localeCompare(b.agent)),
      prs: ai.sort((a, b) => Number(a.approved_other) - Number(b.approved_other) || b.merged_at - a.merged_at),
    };
  }
}
