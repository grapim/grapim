// Read-only queries for the team shell and the team home (src/hub/pages/team.js):
// what needs me now, the setup checklist, the sidebar's teams and review
// count, and the command palette's targets. Every query filters on team_id
// (or on the signed-in user's own memberships); nothing here writes.

import fs from 'node:fs';
import path from 'node:path';
import { kindOf, SYSTEM_KINDS } from './reports/notes.js';

const ACTIVE_MS = 60 * 60 * 1000;
const MAX_RUNS = 400; // runs scanned for review state on one page
const GH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_REPO = /^[A-Za-z0-9._-]{1,100}$/;

// A GitHub pull request URL from stored owner/name/number, or null if any part looks wrong.
export function pullUrl(p) {
  return GH_OWNER.test(String(p.owner)) && GH_REPO.test(String(p.name)) && Number.isSafeInteger(p.number) && p.number > 0
    ? `https://github.com/${p.owner}/${p.name}/pull/${p.number}`
    : null;
}

export function createOverview(hub) {
  const { db } = hub;
  const q = (sql) => db.prepare(sql);

  const repoNames = (teamId) => new Map(q('SELECT id, COALESCE(github, name) AS name FROM repos WHERE team_id = ?').all(teamId).map((r) => [r.id, r.name]));

  // Agent runs synced in the history window, newest first, with their hub
  // review state and who synced them. System runs (undo, restore, folder sync) are left out.
  function runs(team, userId) {
    const cut = hub.read.cutoff(team);
    const rows = q(
      `SELECT c.repo_id, c.machine, c.run, MAX(c.label) AS change_label, MAX(c.id) AS head,
              COUNT(DISTINCT c.worktree || '|' || c.path) AS files,
              COALESCE(SUM(c.added), 0) AS added, COALESCE(SUM(c.removed), 0) AS removed,
              MIN(c.ts) AS first_ts, MAX(c.ts) AS last_ts,
              a.label AS agent_label, a.intent, m.user_id AS owner_id
       FROM h_changes c
       LEFT JOIN h_agents a ON a.team_id = c.team_id AND a.repo_id = c.repo_id AND a.machine = c.machine AND a.agent = c.run
       LEFT JOIN machines m ON m.team_id = c.team_id AND m.repo_id = c.repo_id AND m.machine = c.machine
       WHERE c.team_id = ? AND c.ts >= ?
       GROUP BY c.repo_id, c.machine, c.run ORDER BY MAX(c.ts) DESC LIMIT ?`,
    ).all(team.id, cut, MAX_RUNS);
    const names = repoNames(team.id);
    const list = [];
    for (const r of rows) {
      const label = r.agent_label || r.change_label || r.run;
      const kind = kindOf(r.run, label);
      if (SYSTEM_KINDS.has(kind)) continue;
      list.push({ ...r, label, kind, repo: names.get(r.repo_id) ?? r.repo_id.slice(0, 7), mine: r.owner_id === userId });
    }
    const reviews = hub.github?.reviews;
    const latest = reviews && list.length ? reviews.latest(team, [...new Set(list.map((r) => r.repo_id))], list.map((r) => r.run)) : new Map();
    for (const r of list) {
      const h = latest.get(r.run);
      const hit = h && h.repo_id === r.repo_id ? h : null;
      r.review = hit;
      r.status = !hit ? 'pending' : hit.stale ? 'stale' : hit.status;
      r.waiting = r.status === 'pending' || r.status === 'stale';
    }
    return list;
  }

  // Open pull requests that contain agent runs without a fresh hub approval.
  function pulls(team) {
    let rows;
    try {
      rows = q('SELECT owner, name, number, run, MAX(updated_at) AS updated_at FROM gh_pull_runs WHERE team_id = ? GROUP BY owner, name, number, run ORDER BY updated_at DESC LIMIT 400').all(team.id);
    } catch {
      return { enforced: false, list: [] }; // no GitHub App tables on this hub
    }
    const reviews = hub.github?.reviews;
    const repoIds = q('SELECT id FROM repos WHERE team_id = ?').all(team.id).map((r) => r.id);
    const latest = reviews && rows.length ? reviews.latest(team, repoIds, rows.map((r) => r.run)) : new Map();
    const byPull = new Map();
    for (const r of rows) {
      const k = `${r.owner}/${r.name}#${r.number}`;
      if (!byPull.has(k)) byPull.set(k, { owner: r.owner, name: r.name, number: r.number, updated_at: r.updated_at, runs: 0, unapproved: 0 });
      const p = byPull.get(k);
      p.runs++;
      p.updated_at = Math.max(p.updated_at, r.updated_at);
      const h = latest.get(r.run);
      if (!(h && h.status === 'approved' && !h.stale)) p.unapproved++;
    }
    const enforced = !!hub.github?.requireReview?.(team);
    const list = [...byPull.values()].filter((p) => p.unapproved > 0).sort((a, b) => b.updated_at - a.updated_at).map((p) => ({ ...p, url: pullUrl(p), failing: enforced }));
    return { enforced, list };
  }

  // Agents seen in the last hour that have not ended, across the team's repos.
  function activeAgents(team) {
    const t = hub.now();
    const rows = q(
      `SELECT a.repo_id, a.machine, a.agent, a.label, a.intent, a.worktree, a.last_seen
       FROM h_agents a WHERE a.team_id = ? AND a.last_seen > ?
         AND NOT EXISTS (SELECT 1 FROM h_events e WHERE e.team_id = a.team_id AND e.repo_id = a.repo_id AND e.machine = a.machine
                         AND e.agent = a.agent AND e.kind = 'end' AND e.ts >= a.last_seen)
       ORDER BY a.last_seen DESC LIMIT 12`,
    ).all(team.id, t - ACTIVE_MS);
    const names = repoNames(team.id);
    return rows.map((a) => ({ ...a, label: a.label || a.agent, kind: kindOf(a.agent, a.label || a.agent), repo: names.get(a.repo_id) ?? a.repo_id.slice(0, 7) }));
  }

  // The newest synced edits, one entry per run (its newest edit), plus hub reviews.
  function activity(team, limit = 8) {
    const rows = q(
      `SELECT c.repo_id, c.machine, c.run, c.label, c.path, c.ts, c.added, c.removed, a.label AS agent_label
       FROM h_changes c LEFT JOIN h_agents a ON a.team_id = c.team_id AND a.repo_id = c.repo_id AND a.machine = c.machine AND a.agent = c.run
       WHERE c.team_id = ? ORDER BY c.id DESC LIMIT 200`,
    ).all(team.id);
    const names = repoNames(team.id);
    const seen = new Map();
    for (const r of rows) {
      const k = `${r.repo_id}|${r.machine}|${r.run}`;
      if (!seen.has(k)) seen.set(k, { type: 'edit', repo_id: r.repo_id, repo: names.get(r.repo_id) ?? '', machine: r.machine, run: r.run, label: r.agent_label || r.label || r.run, kind: kindOf(r.run, r.agent_label || r.label || r.run), path: r.path, ts: r.ts, files: new Set() });
      seen.get(k).files.add(r.path);
    }
    let reviews = [];
    try {
      reviews = q(
        `SELECT r.repo_id, r.run, r.status, r.reviewed_at AS ts, u.login,
                (SELECT COALESCE(a.label, c.label) FROM h_changes c LEFT JOIN h_agents a ON a.team_id = c.team_id AND a.repo_id = c.repo_id AND a.machine = c.machine AND a.agent = c.run
                 WHERE c.team_id = r.team_id AND c.repo_id = r.repo_id AND c.run = r.run LIMIT 1) AS label
         FROM hub_reviews r LEFT JOIN users u ON u.id = r.reviewer_user_id
         WHERE r.team_id = ? ORDER BY r.reviewed_at DESC, r.id DESC LIMIT 10`,
      ).all(team.id).map((r) => ({ type: 'review', ...r, repo: names.get(r.repo_id) ?? '' }));
    } catch {}
    return [...[...seen.values()].map((e) => ({ ...e, files: e.files.size })), ...reviews].sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  // When an agent last wrote to a cloud workspace: its ledger file's mtime
  // (no engine is opened for this); the creation time if it never had a write.
  function workspaceActivity(ws) {
    const dir = path.join(hub.workspaces.dirOf(ws), '.git', 'grapim');
    let t = 0;
    for (const f of ['state.db', 'state.db-wal']) {
      try {
        t = Math.max(t, fs.statSync(path.join(dir, f)).mtimeMs);
      } catch {}
    }
    return t ? Math.round(t) : ws.created_at;
  }

  function workspaces(team) {
    return hub.workspaces.live(team.id).map((w) => ({ ...w, last_activity: workspaceActivity(w) }));
  }

  // The first-run checklist, each step from real data.
  function setup(team) {
    const tokens = q('SELECT COUNT(*) AS n FROM machine_tokens WHERE team_id = ? AND revoked_at IS NULL').get(team.id).n;
    const machines = q('SELECT COUNT(*) AS n FROM machines WHERE team_id = ?').get(team.id).n;
    const repos = q('SELECT COUNT(*) AS n FROM repos WHERE team_id = ?').get(team.id).n;
    const ws = hub.workspaces.count(team.id);
    const gh = hub.github?.config?.configured ? hub.github.installs.forTeam(team.id).length : null;
    const steps = [
      { key: 'cli', done: machines > 0 || repos > 0 },
      { key: 'token', done: tokens > 0 },
      { key: 'sync', done: repos > 0 },
      ...(gh === null ? [] : [{ key: 'github', done: gh > 0 }]),
    ];
    const members = q('SELECT COUNT(*) AS n FROM members WHERE team_id = ?').get(team.id).n;
    return { steps, done: steps.filter((s) => s.done).length, empty: repos === 0 && ws === 0, githubConfigured: gh !== null, members };
  }

  // The teams the user belongs to, for the switcher (with created dates).
  function teamsOf(userId) {
    return q(
      `SELECT t.id, t.name, t.plan, t.created_at, t.kind, m.role,
              (SELECT COUNT(*) FROM members x WHERE x.team_id = t.id) AS members,
              (SELECT COUNT(*) FROM repos r WHERE r.team_id = t.id) AS repos
       FROM members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? ORDER BY t.name COLLATE NOCASE, t.created_at`,
    ).all(userId);
  }

  // Everything the team shell draws around a page: the switcher, the review
  // count, and the palette's jump targets.
  function shell(user, team, pathname, role = 'member') {
    const all = runs(team, user.id);
    const waiting = all.filter((r) => r.waiting && !r.mine);
    return {
      path: pathname,
      role,
      teams: teamsOf(user.id),
      reviews: waiting.length,
      // Ask Grapim's entry points: null hides them (a member, before it is set up).
      // In the public demo it is shown with a note instead (no model calls; src/hub/demo.js).
      agent: user.demo ? { configured: false, demo: true } : (hub.agent?.shellInfo(role) ?? null),
      // The settings pages this person can open (src/hub/routes-pages.js), for the palette.
      settings: hub.settingsPages?.(team, role) ?? null,
      palette: {
        repos: q('SELECT id, COALESCE(github, name) AS name FROM repos WHERE team_id = ? ORDER BY COALESCE(last_sync_at, created_at) DESC LIMIT 50').all(team.id),
        workspaces: hub.workspaces.live(team.id).slice(0, 50).map((w) => ({ id: w.id, name: w.name })),
        runs: all.filter((r) => r.waiting).slice(0, 30),
      },
    };
  }

  return { runs, pulls, activeAgents, activity, workspaces, workspaceActivity, setup, teamsOf, shell };
}
