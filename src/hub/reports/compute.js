// The four reports (docs/provenance.md section 7), computed from one team's
// synced rows. Every query filters on team_id and every scan is capped; when a
// cap is hit the report says so in coverage.truncated instead of guessing.
//
// ctx: { db, team, from, to (exclusive), repo (id or null), repos: [{ id, name }] }

import { isAiKind, kindOf, labelPrefix, parseNote, SYSTEM_KINDS } from './notes.js';

export const DAY = 24 * 60 * 60 * 1000;
export const WEEK = 7 * DAY;
export const CAPS = Object.freeze({
  notes: 20_000, // provenance notes read for one report
  noteBytes: 32 * 1024 * 1024, // of note JSON read for one report (about 2 s of parsing at worst)
  rows: 200_000, // h_changes rows scanned for one report
  events: 200_000, // h_events rows scanned for one report
  list: 500, // rows a report returns in a list (unreviewed runs)
});

// The order kinds are stacked and coloured in. Colour follows the kind, never its rank.
export const KIND_ORDER = ['claude-code', 'codex', 'cursor', 'mcp', 'http', 'other'];
const kindRank = (k) => (KIND_ORDER.includes(k) ? KIND_ORDER.indexOf(k) : KIND_ORDER.length);

// Grapim writes a note for every recorded commit, agent lines or not, with
// commit.added. So within recorded commits: AI = the note's ranges, human =
// added - AI. Commits with no note are not recorded: unknown, never human.
export const HUMAN_NOTE = 'Human lines are lines of recorded commits (commits with a provenance note) that no agent run wrote. Commits without a note (repos without grapim init, commits from before it, or not synced yet) are not counted: their lines are unknown, not human.';

export const dayStart = (ms) => Math.floor(ms / DAY) * DAY;
export const weekStart = (ms) => {
  const d = dayStart(ms);
  return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY; // Monday, UTC
};
export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

const repoClause = (ctx) => (ctx.repo ? ' AND repo_id = ?' : '');
const repoArg = (ctx) => (ctx.repo ? [ctx.repo] : []);
const ratio = (a, b) => (b > 0 ? a / b : null);
const nameOf = (ctx, id) => ctx.repos.find((r) => r.id === id)?.name ?? id.slice(0, 7);

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// Notes for commits dated in [from, to). A commit is dated by its note's
// commit.ts, else by when the hub received the note. A commit is never
// received before it was made, so received_at >= from bounds the scan.
export function loadNotes(ctx) {
  const stmt = ctx.db.prepare(
    `SELECT repo_id, commit_sha, note_json, received_at FROM h_provenance
     WHERE team_id = ? AND received_at >= ?${repoClause(ctx)} ORDER BY received_at DESC LIMIT ?`,
  );
  const out = { notes: [], scanned: 0, invalid: 0, truncated: false, inconsistent: 0, datedByUpload: 0 };
  let bytes = 0;
  for (const row of stmt.iterate(ctx.team.id, ctx.from, ...repoArg(ctx), CAPS.notes + 1)) {
    if (out.scanned >= CAPS.notes) {
      out.truncated = true;
      break;
    }
    const json = String(row.note_json ?? '');
    bytes += json.length;
    if (bytes > CAPS.noteBytes) {
      out.truncated = true;
      break;
    }
    out.scanned++;
    const note = parseNote(json);
    if (!note) {
      out.invalid++;
      continue;
    }
    const ts = note.ts ?? row.received_at;
    if (ts < ctx.from || ts >= ctx.to) continue;
    if (note.ts === null) out.datedByUpload++;
    if (note.inconsistent) out.inconsistent++;
    out.notes.push({ repo: row.repo_id, sha: row.commit_sha, ts, note });
  }
  return out;
}

// Newest review status per run, from synced `review` events.
// Map("repo|machine|run" and "repo|run" -> { status, ts, decidedTs }).
function reviewsFor(ctx, runIds) {
  const out = new Map();
  const ids = [...new Set(runIds)].filter(Boolean);
  let scanned = 0;
  for (let i = 0; i < ids.length && scanned < CAPS.events; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = ctx.db
      .prepare(
        `SELECT repo_id, machine, agent, ts, detail FROM h_events
         WHERE team_id = ? AND kind = 'review'${repoClause(ctx)} AND agent IN (${chunk.map(() => '?').join(',')})
         ORDER BY ts LIMIT ?`,
      )
      .all(ctx.team.id, ...repoArg(ctx), ...chunk, CAPS.events - scanned);
    scanned += rows.length;
    for (const e of rows) {
      const status = String(e.detail ?? '').split(': ')[0];
      if (!['approved', 'rejected', 'pending'].includes(status)) continue;
      for (const k of [`${e.repo_id}|${e.machine}|${e.agent}`, `${e.repo_id}|${e.agent}`]) {
        const r = out.get(k) ?? { status: 'pending', ts: 0, decidedTs: null };
        if (e.ts >= r.ts) {
          r.status = status;
          r.ts = e.ts;
        }
        if (status !== 'pending' && r.decidedTs === null) r.decidedTs = e.ts;
        out.set(k, r);
      }
    }
  }
  // Decisions made in the hub (src/hub/reviews.js) win over what machines
  // synced: Map("repo|run" -> { status, ts, decidedTs }).
  const hub = new Map();
  if (ctx.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hub_reviews'").get()) {
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const rows = ctx.db
        .prepare(`SELECT repo_id, run, status, reviewed_at FROM hub_reviews WHERE team_id = ?${repoClause(ctx)} AND run IN (${chunk.map(() => '?').join(',')}) ORDER BY id LIMIT ?`)
        .all(ctx.team.id, ...repoArg(ctx), ...chunk, CAPS.events);
      for (const r of rows) {
        const k = `${r.repo_id}|${r.run}`;
        const was = hub.get(k);
        hub.set(k, { status: r.status, ts: r.reviewed_at, decidedTs: was?.decidedTs ?? r.reviewed_at });
      }
    }
  }
  return { map: out, hub, truncated: scanned >= CAPS.events };
}

function noteCoverage(ctx, L) {
  const withNotes = new Set(L.notes.map((n) => n.repo));
  const commits = L.notes.length;
  const withTotals = L.notes.filter((n) => n.note.added !== null).length;
  const noAgentLines = L.notes.filter((n) => n.note.recorded === 0).length;
  return {
    repos_total: ctx.repo ? 1 : ctx.repos.length,
    repos_with_provenance: withNotes.size,
    repos_without_provenance: (ctx.repo ? ctx.repos.filter((r) => r.id === ctx.repo) : ctx.repos).filter((r) => !withNotes.has(r.id)).map((r) => r.name),
    commits,
    commits_with_totals: withTotals,
    commits_without_totals: commits - withTotals,
    commits_without_agent_lines: noAgentLines,
    dated_by_upload: L.datedByUpload,
    notes_scanned: L.scanned,
    notes_invalid: L.invalid,
    notes_inconsistent: L.inconsistent,
    truncated: L.truncated,
  };
}

// Plain sentences a manager needs before trusting the numbers. Shared by the
// JSON (caveats) and the pages.
function noteCaveats(c) {
  const out = [HUMAN_NOTE];
  if (c.repos_without_provenance.length) {
    const k = c.repos_without_provenance.length;
    out.push(`Not recorded: ${c.repos_without_provenance.join(', ')} (${k} of ${c.repos_total} repo${c.repos_total === 1 ? '' : 's'}) uploaded no provenance in this range. Their lines are unknown and are not in these numbers. Run grapim init there.`);
  }
  if (!c.commits) return out;
  if (c.commits_without_agent_lines === 0) {
    out.push('No recorded commit here is human-only. Older Grapim versions wrote notes only for commits with agent lines; if these repos run one, human-only commits are missing and the share overstates AI.');
  }
  if (c.commits_with_totals < c.commits) {
    const n = c.commits - c.commits_with_totals;
    out.push(`${n} note${n === 1 ? '' : 's'} (from an older Grapim) do not say how many lines ${n === 1 ? 'its commit' : 'their commits'} added: the AI lines are counted, the rest of ${n === 1 ? 'that commit is' : 'those commits is'} unknown and left out of the share and the human lines.`);
  }
  if (c.dated_by_upload) out.push(`${c.dated_by_upload} commit${c.dated_by_upload === 1 ? ' is' : 's are'} dated by when the note reached the hub, not by the commit time.`);
  if (c.notes_invalid) out.push(`${c.notes_invalid} note${c.notes_invalid === 1 ? '' : 's'} could not be read and ${c.notes_invalid === 1 ? 'was' : 'were'} skipped.`);
  if (c.truncated) out.push(`This range holds more provenance than one report reads (${CAPS.notes.toLocaleString('en-US')} notes): the oldest uploads were left out. Pick a shorter range or one repo.`);
  return out;
}

// ---------------------------------------------------------------- ai-share

function bucket() {
  return { commits: 0, commits_with_totals: 0, ai: 0, ai_in_totals: 0, added: 0, human: 0, by_kind: {} };
}

function addNote(b, note) {
  b.commits++;
  b.ai += note.ai;
  for (const r of note.runs) if (r.lines && isAiKind(r.kind)) b.by_kind[r.kind] = (b.by_kind[r.kind] ?? 0) + r.lines;
  if (note.added !== null) {
    b.commits_with_totals++;
    b.added += note.added;
    b.ai_in_totals += note.ai;
    b.human += note.added - note.ai; // sync, undo and restore lines are people's
  }
}

// ai_in_share: the AI lines of the commits that reported a total (the share's numerator).
const shapeBucket = ({ ai_in_totals, ...b }) => ({ ...b, ai_in_share: ai_in_totals, share: ratio(ai_in_totals, b.added) });

export function aiShare(ctx) {
  const L = loadNotes(ctx);
  const weeks = new Map();
  for (let w = weekStart(ctx.from); w < ctx.to; w += WEEK) weeks.set(w, bucket());
  const repos = new Map();
  const total = bucket();
  for (const x of L.notes) {
    const w = weekStart(x.ts);
    if (!weeks.has(w)) weeks.set(w, bucket());
    addNote(weeks.get(w), x.note);
    if (!repos.has(x.repo)) repos.set(x.repo, bucket());
    addNote(repos.get(x.repo), x.note);
    addNote(total, x.note);
  }
  const kinds = Object.keys(total.by_kind).sort((a, b) => kindRank(a) - kindRank(b) || a.localeCompare(b));
  const coverage = noteCoverage(ctx, L);
  return {
    totals: shapeBucket(total),
    kinds,
    weeks: [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([start, b]) => ({ week: isoDay(start), start, ...shapeBucket(b) })),
    repos: [...repos.entries()].map(([id, b]) => ({ repo: id, name: nameOf(ctx, id), ...shapeBucket(b) })).sort((a, b) => b.ai - a.ai),
    coverage,
    caveats: noteCaveats(coverage),
  };
}

// ---------------------------------------------------------------- agents

// One row per run that changed files in the range (capped).
function runRows(ctx) {
  const rows = ctx.db
    .prepare(
      `SELECT g.repo_id, g.machine, g.run, g.change_label, g.first_ts, g.last_ts, g.added, g.edits, a.label AS agent_label
       FROM (SELECT repo_id, machine, run, MAX(label) AS change_label, MIN(ts) AS first_ts, MAX(ts) AS last_ts,
                    COALESCE(SUM(added), 0) AS added, COUNT(*) AS edits
             FROM (SELECT repo_id, machine, run, label, ts, added FROM h_changes
                   WHERE team_id = ? AND ts >= ? AND ts < ?${repoClause(ctx)} LIMIT ?)
             GROUP BY repo_id, machine, run) g
       LEFT JOIN h_agents a ON a.team_id = ? AND a.repo_id = g.repo_id AND a.machine = g.machine AND a.agent = g.run`,
    )
    .all(ctx.team.id, ctx.from, ctx.to, ...repoArg(ctx), CAPS.rows + 1, ctx.team.id);
  const scanned = rows.reduce((n, r) => n + r.edits, 0);
  return { rows, scanned, truncated: scanned > CAPS.rows };
}

export function agents(ctx) {
  const R = runRows(ctx);
  const L = loadNotes(ctx);
  const reviews = reviewsFor(ctx, R.rows.map((r) => r.run));
  // Undo runs are labelled "undo <label or id of the run they undid>".
  const undone = new Set(
    ctx.db
      .prepare(
        `SELECT DISTINCT repo_id, machine, label FROM (SELECT repo_id, machine, label FROM h_changes
         WHERE team_id = ? AND ts >= ?${repoClause(ctx)} AND run LIKE 'undo:%' LIMIT ?) WHERE label LIKE 'undo %'`,
      )
      .all(ctx.team.id, ctx.from, ...repoArg(ctx), CAPS.rows)
      .map((u) => `${u.repo_id}|${u.machine}|${u.label.slice(5)}`),
  );

  const groups = new Map();
  const group = (kind, prefix) => {
    const k = `${kind}|${prefix}`;
    if (!groups.has(k)) groups.set(k, { kind, prefix, runs: 0, reviewed: 0, approved: 0, rejected: 0, pending: 0, undone: 0, times: [], lines_written: 0, lines_committed: 0 });
    return groups.get(k);
  };
  const excluded = { sync: 0, undo: 0, restore: 0 };
  const noteReview = new Map();
  for (const x of L.notes) for (const r of x.note.runs) if (r.review) noteReview.set(`${x.repo}|${r.id}`, r.review);

  for (const r of R.rows) {
    const label = r.agent_label || r.change_label || r.run;
    const kind = kindOf(r.run, label);
    if (SYSTEM_KINDS.has(kind)) {
      excluded[kind]++;
      continue;
    }
    const g = group(kind, labelPrefix(label, r.run));
    g.runs++;
    g.lines_written += r.added;
    const rev = reviews.hub.get(`${r.repo_id}|${r.run}`) ?? reviews.map.get(`${r.repo_id}|${r.machine}|${r.run}`);
    const status = rev?.status ?? noteReview.get(`${r.repo_id}|${r.run}`) ?? 'pending';
    g[status]++;
    if (rev?.decidedTs) g.times.push(rev.decidedTs - (r.last_ts <= rev.decidedTs ? r.last_ts : Math.min(r.first_ts, rev.decidedTs)));
    if ([r.agent_label, r.change_label, r.run].some((l) => l && undone.has(`${r.repo_id}|${r.machine}|${l}`))) g.undone++;
  }
  for (const x of L.notes) for (const r of x.note.runs) if (r.lines && isAiKind(r.kind)) group(r.kind, r.prefix).lines_committed += r.lines;

  const list = [...groups.values()]
    .map(({ times, ...g }) => ({
      ...g,
      reviewed: g.approved + g.rejected,
      undo_rate: ratio(g.undone, g.runs),
      reject_rate: ratio(g.rejected, g.approved + g.rejected),
      median_review_ms: median(times),
    }))
    .sort((a, b) => b.runs - a.runs || b.lines_committed - a.lines_committed || kindRank(a.kind) - kindRank(b.kind) || a.prefix.localeCompare(b.prefix));
  const sum = (k) => list.reduce((n, g) => n + g[k], 0);
  const reposWithRuns = new Set(R.rows.map((r) => r.repo_id)).size;
  const nc = noteCoverage(ctx, L);
  const coverage = {
    repos_total: nc.repos_total,
    repos_with_runs: reposWithRuns,
    repos_with_provenance: nc.repos_with_provenance,
    commits: nc.commits,
    rows_scanned: R.scanned,
    notes_scanned: L.scanned,
    truncated: R.truncated || L.truncated || reviews.truncated,
  };
  const caveats = [
    'Runs and review state come from grapim sync; committed lines come from provenance notes. A run that was never synced is not counted.',
    'Undo, restore and folder-sync runs are left out: they are people taking work back, not agent work.',
  ];
  if (coverage.truncated) caveats.push('This range holds more rows than one report reads: some runs were left out. Pick a shorter range or one repo.');
  return {
    totals: {
      groups: list.length,
      runs: sum('runs'),
      reviewed: sum('reviewed'),
      rejected: sum('rejected'),
      undone: sum('undone'),
      lines_written: sum('lines_written'),
      lines_committed: sum('lines_committed'),
      undo_rate: ratio(sum('undone'), sum('runs')),
      reject_rate: ratio(sum('rejected'), sum('reviewed')),
    },
    agents: list,
    excluded,
    coverage,
    caveats,
  };
}

// ---------------------------------------------------------------- unreviewed

export function unreviewed(ctx) {
  const L = loadNotes(ctx);
  const ids = [];
  for (const x of L.notes) for (const r of x.note.runs) if (r.lines && isAiKind(r.kind)) ids.push(r.id);
  const reviews = reviewsFor(ctx, ids);
  const runs = new Map();
  let aiLines = 0;
  let notOnDefault = 0;
  let branchUnknown = 0;
  for (const x of L.notes) {
    if (x.note.defaultBranch === false) {
      notOnDefault++;
      continue;
    }
    if (x.note.defaultBranch === null) branchUnknown++;
    for (const r of x.note.runs) {
      if (!r.lines || !isAiKind(r.kind)) continue;
      aiLines += r.lines;
      const status = (reviews.hub.get(`${x.repo}|${r.id}`) ?? reviews.map.get(`${x.repo}|${r.id}`))?.status ?? r.review ?? 'pending';
      if (status === 'approved') continue;
      const k = `${x.repo}|${r.id}`;
      if (!runs.has(k)) {
        runs.set(k, { repo: x.repo, repo_name: nameOf(ctx, x.repo), run: r.id, label: r.label || r.id, kind: r.kind, status, lines: 0, files: 0, commits: 0, first_ts: x.ts, last_ts: x.ts, intent: null, shas: [] });
      }
      const u = runs.get(k);
      u.lines += r.lines;
      u.files += r.files;
      u.commits++;
      u.first_ts = Math.min(u.first_ts, x.ts);
      u.last_ts = Math.max(u.last_ts, x.ts);
      u.intent ??= r.intent;
      if (u.shas.length < 5) u.shas.push(x.sha);
    }
  }
  const all = [...runs.values()].sort((a, b) => b.lines - a.lines || b.last_ts - a.last_ts);
  const sum = (pred) => all.filter(pred).reduce((n, u) => n + u.lines, 0);
  const nc = noteCoverage(ctx, L);
  const coverage = { ...nc, not_on_default_branch: notOnDefault, branch_unknown: branchUnknown, truncated: nc.truncated || reviews.truncated, list_truncated: all.length > CAPS.list };
  const caveats = ['Only recorded commits (with a provenance note) are counted. Lines in commits without a note are unknown.'];
  if (branchUnknown) caveats.push(`${branchUnknown} of ${nc.commits - notOnDefault} commits do not say whether they are on the default branch, so they are counted as merged. Some may still be on a feature branch.`);
  caveats.push('A run counts as approved here once a member approves it on its run page in the hub, or (informational) once someone approves it with grapim serve and the machine syncs; a decision in the hub wins. The require-review check counts hub approvals only. Pending and rejected runs are both listed.');
  if (coverage.truncated) caveats.push('This range holds more provenance than one report reads: the oldest uploads were left out.');
  return {
    totals: {
      lines: sum(() => true),
      pending_lines: sum((u) => u.status === 'pending'),
      rejected_lines: sum((u) => u.status === 'rejected'),
      ai_lines: aiLines,
      share_of_ai: ratio(sum(() => true), aiLines),
      runs: all.length,
      commits: new Set(L.notes.filter((x) => x.note.defaultBranch !== false && x.note.runs.some((r) => r.lines && isAiKind(r.kind) && runs.has(`${x.repo}|${r.id}`))).map((x) => x.sha)).size,
    },
    runs: all.slice(0, CAPS.list),
    coverage,
    caveats,
  };
}

// ---------------------------------------------------------------- activity

export function activity(ctx) {
  const args = [ctx.team.id, ctx.from, ctx.to, ...repoArg(ctx), CAPS.rows + 1];
  const inner = `SELECT repo_id, machine, run, path, ts FROM h_changes
                 WHERE team_id = ? AND ts >= ? AND ts < ?${repoClause(ctx)} AND run NOT LIKE 'undo:%' AND run NOT LIKE 'restore:%' LIMIT ?`;
  const perDay = ctx.db
    .prepare(
      `SELECT CAST(ts / ${DAY} AS INTEGER) AS d, COUNT(DISTINCT repo_id || '|' || machine || '|' || run) AS runs,
              COUNT(DISTINCT repo_id || '|' || path) AS files, COUNT(*) AS edits
       FROM (${inner}) GROUP BY d`,
    )
    .all(...args);
  const conflicts = ctx.db
    .prepare(
      `SELECT d, COUNT(*) AS n FROM (SELECT CAST(ts / ${DAY} AS INTEGER) AS d, repo_id, path FROM (${inner})
       GROUP BY d, repo_id, path HAVING COUNT(DISTINCT machine || '|' || run) > 1) GROUP BY d`,
    )
    .all(...args);
  const blocks = ctx.db
    .prepare(
      `SELECT CAST(ts / ${DAY} AS INTEGER) AS d, COUNT(*) AS n FROM (SELECT ts FROM h_events
       WHERE team_id = ? AND kind = 'blocked' AND ts >= ? AND ts < ?${repoClause(ctx)} LIMIT ?) GROUP BY d`,
    )
    .all(ctx.team.id, ctx.from, ctx.to, ...repoArg(ctx), CAPS.events + 1);
  const totalRuns = ctx.db
    .prepare(`SELECT COUNT(DISTINCT repo_id || '|' || machine || '|' || run) AS runs, COUNT(DISTINCT repo_id || '|' || path) AS files, COUNT(DISTINCT repo_id) AS repos, COUNT(*) AS edits FROM (${inner})`)
    .get(...args);

  const days = new Map();
  for (let d = dayStart(ctx.from); d < ctx.to; d += DAY) days.set(d / DAY, { runs: 0, files: 0, edits: 0, blocks: 0, conflicts: 0 });
  const at = (d) => days.get(d) ?? days.set(d, { runs: 0, files: 0, edits: 0, blocks: 0, conflicts: 0 }).get(d);
  for (const r of perDay) Object.assign(at(r.d), { runs: r.runs, files: r.files, edits: r.edits });
  for (const r of conflicts) at(r.d).conflicts = r.n;
  for (const r of blocks) at(r.d).blocks = r.n;
  const list = [...days.entries()].sort((a, b) => a[0] - b[0]).map(([d, v]) => ({ date: isoDay(d * DAY), start: d * DAY, ...v }));
  const sum = (k) => list.reduce((n, x) => n + x[k], 0);
  const blocksTotal = blocks.reduce((n, r) => n + r.n, 0);
  const coverage = {
    repos_total: ctx.repo ? 1 : ctx.repos.length,
    repos_with_runs: totalRuns.repos,
    rows_scanned: Math.min(totalRuns.edits, CAPS.rows),
    truncated: totalRuns.edits > CAPS.rows || blocksTotal > CAPS.events,
  };
  const caveats = [
    'Runs and edits come from grapim sync. Blocks are edits refused (or warned about) because another agent held the file. Conflicts are files two or more runs changed on the same day.',
  ];
  if (coverage.truncated) caveats.push('This range holds more rows than one report reads: the counts are a lower bound. Pick a shorter range or one repo.');
  return {
    totals: { runs: totalRuns.runs, files: totalRuns.files, edits: sum('edits'), blocks: sum('blocks'), conflicts: sum('conflicts'), active_days: list.filter((x) => x.edits).length, busiest: Math.max(0, ...list.map((x) => x.runs)) },
    days: list,
    coverage,
    caveats,
  };
}
