// Engineering-manager reports (docs/provenance.md section 7): the AI share of
// added lines, agents, unreviewed AI lines and activity, as JSON, CSV and
// team pages. Gated on the plan's `reports` feature (governance).
//
// Work per report is capped (compute.js) and results are cached per team for
// at most an hour. The cache key includes the team's newest sync and newest
// provenance note, so a sync shows on the next request.

import { HttpError, sendHtml } from '../http.js';
import { reportsPage } from '../pages/reports.js';
import { activity, agents, aiShare, dayStart, DAY, isoDay, unreviewed, WEEK, weekStart } from './compute.js';
import { toCsv } from './csv.js';

export const REPORTS = Object.freeze(['ai-share', 'agents', 'unreviewed', 'activity']);
const COMPUTE = { 'ai-share': aiShare, agents, unreviewed, activity };
export const DEFAULT_WEEKS = 12;
export const MAX_DAYS = 366;
export const CACHE_MS = 60 * 60 * 1000;
export const CACHE_MAX = 256;
// Computing a report reads up to CAPS.noteBytes of synced notes in the one hub
// process. Each team may spend at most this much compute time per minute;
// past it, the newest cached answer for the same query is served (stale), or
// 429. The teaser (every plan) ignores syncs for TEASER_MS, so a free team
// cannot force a recompute with each sync.
export const COMPUTE_BUDGET_MS = 5000;
const BUDGET_WINDOW_MS = 60_000;
export const TEASER_MS = 10 * 60 * 1000;
const NO_FEATURES = Object.freeze({ reports: false, requireReview: false });

// h_provenance is docs/provenance.md section 3, created here too (same schema)
// so it does not matter which module opens the database first.
export function ensureReportSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS h_provenance (
  team_id     TEXT NOT NULL,
  repo_id     TEXT NOT NULL,
  commit_sha  TEXT NOT NULL,
  note_json   TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, repo_id, commit_sha)
);
CREATE INDEX IF NOT EXISTS h_provenance_received ON h_provenance(team_id, received_at);
CREATE INDEX IF NOT EXISTS h_changes_team_ts ON h_changes(team_id, ts);
CREATE INDEX IF NOT EXISTS h_events_team_kind ON h_events(team_id, kind, ts);
`);
}

function parseDay(v, name) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, 'bad_request', `${name} must be a date like 2026-11-02.`);
  const ms = Date.parse(`${v}T00:00:00Z`);
  if (!Number.isFinite(ms) || isoDay(ms) !== v) throw new HttpError(400, 'bad_request', `${name} is not a real date.`);
  return ms;
}

export class Reports {
  constructor({ db, now, limits }) {
    this.db = db;
    this.now = now;
    this.limits = limits;
    this.cache = new Map();
    this.computed = 0; // reports computed (not served from the cache), for tests
    this.versions = new Map(); // team id -> syncs seen by this process
    this.spent = new Map(); // team id -> [[performance.now(), ms], ...] in the last minute
    ensureReportSchema(db);
  }

  // Compute time this team used in the last minute (wall clock, not the hub's clock).
  #used(teamId) {
    const t = performance.now();
    const list = (this.spent.get(teamId) ?? []).filter(([at]) => t - at < BUDGET_WINDOW_MS);
    if (list.length) this.spent.set(teamId, list);
    else this.spent.delete(teamId);
    return list.reduce((n, [, ms]) => n + ms, 0);
  }

  features(team) {
    return this.limits(team)?.features ?? NO_FEATURES;
  }

  repos(team) {
    return this.db.prepare('SELECT id, name FROM repos WHERE team_id = ? ORDER BY name COLLATE NOCASE LIMIT 1000').all(team.id);
  }

  historyFrom(team) {
    const days = this.limits(team).historyDays;
    return Number.isFinite(days) ? dayStart(this.now() - days * DAY) : null;
  }

  // Query parameters -> { from, to (exclusive), repo, fromDay, toDay, clamped, historyFrom }.
  params(team, q = new URLSearchParams(), repos = this.repos(team)) {
    const get = (k) => {
      const v = typeof q.get === 'function' ? q.get(k) : q[k];
      return v === null || v === undefined || v === '' ? null : String(v);
    };
    const today = dayStart(this.now());
    const toDay = get('to') ? parseDay(get('to'), 'to') : today;
    let from = get('from') ? parseDay(get('from'), 'from') : weekStart(today) - (DEFAULT_WEEKS - 1) * WEEK;
    if (from > toDay) throw new HttpError(400, 'bad_request', 'from must be on or before to.');
    const to = toDay + DAY;
    if ((to - from) / DAY > MAX_DAYS) throw new HttpError(400, 'bad_request', `A report covers at most ${MAX_DAYS} days.`);
    const historyFrom = this.historyFrom(team);
    let clamped = false;
    if (historyFrom !== null && from < historyFrom) {
      from = Math.min(historyFrom, to - DAY);
      clamped = true;
    }
    let repo = get('repo');
    if (repo !== null && !repos.some((r) => r.id === repo)) throw new HttpError(404, 'not_found', 'No such repo in this team.');
    return { from, to, repo, fromDay: isoDay(from), toDay: isoDay(to - DAY), clamped, historyFrom };
  }

  // A sync stored new rows for the team: its cached reports are stale.
  bump(teamId) {
    this.versions.set(teamId, (this.versions.get(teamId) ?? 0) + 1);
  }

  // Changes whenever the team syncs or uploads a note (also across processes
  // sharing the database, where bump() is not called).
  stamp(team) {
    const s = this.db.prepare('SELECT MAX(last_sync_at) AS t, COUNT(*) AS n FROM machines WHERE team_id = ?').get(team.id);
    const p = this.db.prepare('SELECT MAX(received_at) AS t FROM h_provenance WHERE team_id = ?').get(team.id);
    return `${s.t ?? 0}.${s.n}.${p.t ?? 0}.${this.versions.get(team.id) ?? 0}`;
  }

  // key = `${base}|${hour}|${stamp}`; base names the team and the query.
  #cached(teamId, base, key, fn) {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_MS) {
      this.cache.delete(key); // move to the newest end (LRU)
      this.cache.set(key, hit);
      return hit.value;
    }
    if (this.#used(teamId) >= COMPUTE_BUDGET_MS) {
      let stale = null;
      for (const [k, v] of this.cache) if (k.startsWith(`${base}|`)) stale = v.value;
      if (stale) return stale;
      throw new HttpError(429, 'rate_limited', 'Reports for this team are busy. Try again in a minute.', { retryAfter: 60 });
    }
    const started = performance.now();
    const value = fn();
    const ms = performance.now() - started;
    this.spent.set(teamId, [...(this.spent.get(teamId) ?? []), [started, ms]]);
    this.computed++;
    this.cache.set(key, { at: this.now(), value });
    while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  // The report, or 402 when the plan does not include reports.
  get(team, name, p) {
    if (!COMPUTE[name]) throw new HttpError(404, 'not_found', 'No such report.');
    if (!this.features(team).reports) {
      throw new HttpError(402, 'plan_required', 'Reports are on the Governance plan. Free and Team plans see last week\'s AI share only.', { body: { teaser: this.teaser(team) } });
    }
    return this.compute(team, name, p);
  }

  // No gating: callers check features first (get() does).
  compute(team, name, p, { stamp = null } = {}) {
    const hour = Math.floor(this.now() / CACHE_MS);
    const base = [team.id, name, p.from, p.to, p.repo ?? ''].join('|');
    const key = [base, hour, stamp ?? this.stamp(team)].join('|');
    return this.#cached(team.id, base, key, () => {
      const repos = this.repos(team);
      const body = COMPUTE[name]({ db: this.db, team, from: p.from, to: p.to, repo: p.repo, repos });
      return {
        report: name,
        range: { from: p.fromDay, to: p.toDay, history_from: p.historyFrom === null ? null : isoDay(p.historyFrom), clamped: p.clamped },
        repo: p.repo,
        generated_at: this.now(),
        ...body,
      };
    });
  }

  // Last full week (Monday to Sunday, UTC): the AI share only. Every plan sees it.
  teaser(team) {
    const end = weekStart(dayStart(this.now()));
    const p = { from: end - WEEK, to: end, repo: null, fromDay: isoDay(end - WEEK), toDay: isoDay(end - DAY), clamped: false, historyFrom: null };
    const r = this.compute(team, 'ai-share', p, { stamp: `teaser.${Math.floor(this.now() / TEASER_MS)}` });
    return {
      week: p.fromDay,
      week_end: p.toDay,
      share: r.totals.share,
      ai: r.totals.ai,
      ai_in_share: r.totals.ai_in_share,
      added: r.totals.added,
      human: r.totals.human,
      repos_not_recorded: r.coverage.repos_without_provenance.length,
      commits: r.totals.commits,
      commits_with_totals: r.totals.commits_with_totals,
      repos_with_provenance: r.coverage.repos_with_provenance,
      repos_total: r.coverage.repos_total,
      caveats: r.caveats,
    };
  }
}

// GET /hub/api/teams/:team/reports/<name>[.csv] and the Reports tab.
export function reportRoutes(router, hub) {
  const { reports, config } = hub;
  // Every sync that stores rows invalidates that team's cached reports.
  if (hub.ingest && typeof hub.ingest.onSync === 'function') {
    const onSync = hub.ingest.onSync;
    hub.ingest.onSync = (teamId, repoId) => {
      reports.bump(teamId);
      return onSync(teamId, repoId);
    };
  }
  const TEAM = { auth: 'session', team: true };
  const json = (ctx, body) => {
    const data = JSON.stringify(body, (k, v) => (v === Infinity ? null : v));
    ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
    ctx.res.end(data);
  };
  const run = (ctx, name) => {
    hub.limit(ctx, 'read', ctx.member.userId);
    const team = hub.teams.get(ctx.member.team.id) ?? ctx.member.team;
    return reports.get(team, name, reports.params(team, ctx.url.searchParams));
  };

  for (const name of REPORTS) {
    router.get(`/hub/api/teams/:team/reports/${name}`, (ctx) => json(ctx, run(ctx, name)), TEAM);
    router.get(
      `/hub/api/teams/:team/reports/${name}.csv`,
      (ctx) => {
        const r = run(ctx, name);
        const body = toCsv(name, r);
        ctx.res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Content-Disposition': `attachment; filename="grapim-${name}-${r.range.from}-to-${r.range.to}.csv"`,
          'Cache-Control': 'no-store',
        });
        ctx.res.end(body);
      },
      TEAM,
    );
  }

  const page = (ctx, name) => {
    hub.limit(ctx, 'read', ctx.member.userId);
    const team = hub.teams.get(ctx.member.team.id) ?? ctx.member.team;
    const repos = reports.repos(team);
    const features = reports.features(team);
    const q = ctx.url.searchParams;
    let p = null;
    let error = null;
    try {
      p = reports.params(team, q, repos);
    } catch (err) {
      if (!(err instanceof HttpError) || err.status >= 500) throw err;
      error = err.message;
      p = reports.params(team, new URLSearchParams(), repos);
    }
    const body = reportsPage({
      user: ctx.session.user,
      csrf: ctx.session.csrf,
      team,
      role: ctx.member.role,
      name,
      params: p,
      query: { from: q.get('from') ?? '', to: q.get('to') ?? '', repo: q.get('repo') ?? '' },
      repos,
      features,
      report: features.reports ? reports.compute(team, name, p) : null,
      teaser: features.reports ? null : reports.teaser(team),
      billing: { enabled: !!hub.billing, intervals: config.governanceIntervals ?? [] },
      seatsUsed: hub.teams.seatsUsed(team.id),
      now: hub.now(),
      error,
    });
    sendHtml(ctx.res, error ? 400 : 200, body);
  };
  router.get('/hub/teams/:team/reports', (ctx) => page(ctx, 'ai-share'), TEAM);
  for (const name of REPORTS) router.get(`/hub/teams/:team/reports/${name}`, (ctx) => page(ctx, name), TEAM);
}
