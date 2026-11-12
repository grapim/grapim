// Audit evidence export (research/core-features-2026-11.md, feature 5): for a
// date range, every agent run the team synced, with what an auditor sampling
// a change asks for: the repo, the agent, what it was asked, how many lines,
// who synced it, who approved or rejected it in the hub and when (and
// whether from the GitHub check), whether it reached a merged pull request,
// and the path rules that applied. CSV, a page, and a print view.
//
// It is labelled for what it is: Grapim's record of runs synced to it and of
// decisions made in it. Evidence for an auditor to evaluate, not a
// certification. Governance plan (the reports feature).
//
//   GET /hub/teams/:team/reports/evidence           the page (members)
//   GET /hub/teams/:team/reports/evidence/print     the print view
//   GET /hub/api/teams/:team/reports/evidence.csv

import { HttpError, sendHtml } from '../http.js';
import { kindOf } from '../../provenance/note.js';
import { layout } from '../pages/layout.js';
import { date, esc, html } from '../pages/html.js';
import { head } from '../pages/team.js';
import { NAMES, teaserBody } from '../pages/reports.js';
import { csvTable } from './csv.js';

export const MAX_RUNS = 5000;
const PEOPLE = new Set(['sync', 'undo', 'restore']);
const KIND = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', mcp: 'MCP agent', http: 'HTTP agent' };
const iso = (ms) => (Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 19)}Z` : '');
const n = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–');
const DISCLAIMER =
  "This is Grapim's record of the AI agent runs your team's machines synced to it and of the review decisions people made in Grapim. It is evidence for your auditor to evaluate, not a certification, an attestation or proof of compliance with any standard. Runs on machines without Grapim are not in it.";

const parse = (s) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

// The rows. p: Reports.params(team, query) -> { from, to (exclusive), repo }.
export function evidence(hub, team, p) {
  const { db } = hub;
  const gh = hub.github;
  const repos = new Map(db.prepare('SELECT id, COALESCE(github, name) AS name FROM repos WHERE team_id = ?').all(team.id).map((r) => [r.id, r.name]));
  const rows = db
    .prepare(
      `SELECT repo_id, run, MIN(ts) AS first_ts, MAX(ts) AS last_ts, SUM(COALESCE(added, 0)) AS added, SUM(COALESCE(removed, 0)) AS removed,
              COUNT(DISTINCT path) AS files, MAX(label) AS label
       FROM h_changes WHERE team_id = ? AND ts >= ? AND ts < ? ${p.repo ? 'AND repo_id = ?' : ''}
       GROUP BY repo_id, run ORDER BY MIN(ts), run LIMIT ?`,
    )
    .all(team.id, p.from, p.to, ...(p.repo ? [p.repo] : []), MAX_RUNS * 2)
    .filter((r) => !PEOPLE.has(kindOf(r.run)) && !String(r.run).startsWith('human:'));
  const truncated = rows.length > MAX_RUNS;
  const intentOf = db.prepare("SELECT detail FROM h_events WHERE team_id = ? AND repo_id = ? AND agent = ? AND kind = 'intent' ORDER BY ts, id LIMIT 1");
  const agentIntent = db.prepare('SELECT intent FROM h_agents WHERE team_id = ? AND repo_id = ? AND agent = ? AND intent IS NOT NULL ORDER BY last_seen LIMIT 1');
  const loginOf = db.prepare('SELECT login FROM users WHERE id = ?');
  const merged = db.prepare('SELECT owner, name, number, merged_at FROM gh_merged_runs WHERE team_id = ? AND run = ? ORDER BY merged_at LIMIT 20');
  const open = db.prepare('SELECT DISTINCT owner, name, number FROM gh_pull_runs WHERE team_id = ? AND run = ? LIMIT 20');
  const list = [];
  for (const r of rows.slice(0, MAX_RUNS)) {
    const decisions = gh ? gh.reviews.history(team, [r.repo_id], r.run) : [];
    const latest = gh ? gh.reviews.latest(team, [r.repo_id], [r.run]).get(r.run) : null;
    const owners = gh ? [...gh.reviews.owners(team, r.run)].map((id) => loginOf.get(id)?.login ?? `user ${id}`) : [];
    const evaluation = gh ? gh.rulesFor(team, [r.repo_id], [r.run]).get(r.run) ?? null : null;
    const atDecision = [...new Set(decisions.flatMap((d) => (parse(d.rules) ?? []).map((x) => x.pattern)))];
    const status = !latest ? 'not reviewed' : latest.stale ? `changed after ${latest.status}` : latest.status === 'approved' && evaluation && !evaluation.ok ? 'approved, rule not met' : latest.status;
    const prs = merged.all(team.id, r.run);
    list.push({
      run: r.run,
      repo_id: r.repo_id,
      repo: repos.get(r.repo_id) ?? r.repo_id.slice(0, 12),
      kind: kindOf(r.run),
      agent: KIND[kindOf(r.run)] ?? kindOf(r.run),
      label: r.label || r.run,
      intent: intentOf.get(team.id, r.repo_id, r.run)?.detail ?? agentIntent.get(team.id, r.repo_id, r.run)?.intent ?? null,
      first_ts: r.first_ts,
      last_ts: r.last_ts,
      added: r.added,
      removed: r.removed,
      files: r.files,
      synced_by: owners,
      status,
      decisions: decisions.map((d) => ({ status: d.status, by: d.login ?? `user ${d.reviewer_user_id}`, at: d.reviewed_at, via: d.via ?? 'hub', note: d.note })),
      merged: prs.map((x) => ({ pr: `${x.owner}/${x.name}#${x.number}`, url: `https://github.com/${x.owner}/${x.name}/pull/${x.number}`, at: x.merged_at })),
      open: open.all(team.id, r.run).map((x) => `${x.owner}/${x.name}#${x.number}`),
      rules: evaluation ? evaluation.rules.map((x) => ({ pattern: x.pattern, ok: x.ok, need: x.need })) : [],
      rules_at_decision: atDecision,
    });
  }
  const t = { runs: list.length, approved: 0, rejected: 0, pending: 0, merged: 0, merged_unapproved: 0, lines: 0 };
  for (const x of list) {
    if (x.status === 'approved') t.approved++;
    else if (x.status === 'rejected') t.rejected++;
    else t.pending++;
    if (x.merged.length) t.merged++;
    if (x.merged.length && x.status !== 'approved') t.merged_unapproved++;
    t.lines += x.added;
  }
  return { range: { from: p.fromDay, to: p.toDay }, repo: p.repo, totals: t, runs: list, truncated, app: !!gh?.config?.configured };
}

const decisionText = (d) => `${iso(d.at)} ${d.status} by ${d.by}${d.via === 'github' ? ' (GitHub check)' : ''}`;
const lastBy = (x, status) => [...x.decisions].reverse().find((d) => d.status === status) ?? null;

export function evidenceCsv(r) {
  return csvTable(
    ['run_id', 'repo', 'agent', 'agent_label', 'intent', 'first_change_utc', 'last_change_utc', 'lines_added', 'lines_removed', 'files', 'synced_by', 'review_status', 'approved_by', 'approved_at_utc', 'rejected_by', 'rejected_at_utc', 'all_decisions', 'merged_pull_requests', 'merged_at_utc', 'open_pull_requests', 'path_rules_now', 'path_rules_at_decision'],
    r.runs.map((x) => {
      const a = lastBy(x, 'approved');
      const j = lastBy(x, 'rejected');
      return [
        x.run, x.repo, x.agent, x.label, x.intent, iso(x.first_ts), iso(x.last_ts), x.added, x.removed, x.files, x.synced_by.join('; '), x.status,
        a?.by ?? '', a ? iso(a.at) : '', j?.by ?? '', j ? iso(j.at) : '',
        x.decisions.map(decisionText).join('; '),
        x.merged.map((m) => m.url).join('; '),
        x.merged.map((m) => iso(m.at)).join('; '),
        x.open.join('; '),
        x.rules.map((rule) => `${rule.pattern} (${rule.ok ? 'met' : `${rule.need} more needed`})`).join('; '),
        x.rules_at_decision.join('; '),
      ];
    }),
  );
}

// ---------------------------------------------------------------- pages

const badge = (s) => html`<span class="badge ${s === 'approved' ? 'badge-ok' : s === 'rejected' ? 'badge-danger' : 'badge-warn'}">${s}</span>`;

function runsTable(r, { print = false } = {}) {
  if (!r.runs.length) return html`<div class="empty"><p class="empty-title">No agent runs in this range</p><p class="muted">Runs reach the hub when a machine runs <code>grapim sync</code>.</p></div>`;
  const sm = print ? '' : 'hide-sm'; // phones: run and review, the rest in the run's line
  return html`<div class="table-wrap"><table class="table table-dense evidence-table">
  <caption class="sr-only">Every agent run synced between ${r.range.from} and ${r.range.to}</caption>
  <thead><tr><th scope="col">Run</th><th scope="col" class="${sm}">Repo</th><th scope="col" class="num ${sm}">Lines</th><th scope="col">Review</th><th scope="col" class="${sm}">Merged pull request</th>${print ? html`<th scope="col">Path rules</th>` : html`<th scope="col" class="hide-sm">Path rules</th>`}</tr></thead>
  <tbody>${r.runs.map((x) => {
    const a = lastBy(x, 'approved');
    const j = lastBy(x, 'rejected');
    return html`<tr>
    <th scope="row" class="cell-run"><span class="run-intent">${x.intent || x.label}</span><span class="run-sub">${x.agent} · <span class="mono">${x.label}</span> · ${date(x.first_ts)}${x.synced_by.length ? ` · synced by ${x.synced_by.join(', ')}` : ''}${print ? '' : html`<span class="show-sm"> · ${x.repo} · +${n(x.added)} −${n(x.removed)}${x.merged.length ? ` · merged in ${x.merged.map((m) => m.pr).join(', ')}` : ''}</span>`}</span></th>
    <td class="truncate ${sm}">${x.repo}</td>
    <td class="num ${sm}"><span class="plus">+${n(x.added)}</span> <span class="minus">−${n(x.removed)}</span></td>
    <td>${badge(x.status)}<span class="run-sub">${a ? html`${a.by}, ${iso(a.at).slice(0, 16).replace('T', ' ')}${a.via === 'github' ? ' (GitHub)' : ''}` : j ? html`${j.by}, ${iso(j.at).slice(0, 16).replace('T', ' ')}` : ''}</span></td>
    <td class="${sm}">${x.merged.length ? x.merged.map((m, i) => html`${i ? ', ' : ''}${print ? html`<span class="mono">${m.pr}</span>` : html`<a class="link mono" href="${m.url}" rel="noreferrer">${m.pr}</a>`}`) : x.open.length ? html`<span class="muted">open: ${x.open.join(', ')}</span>` : html`<span class="muted">${r.app ? 'none seen' : 'unknown'}</span>`}</td>
    <td class="${print ? '' : 'hide-sm'}">${x.rules.length ? x.rules.map((rule, i) => html`${i ? ', ' : ''}<code>${rule.pattern}</code>${rule.ok ? '' : html` <span class="warn-text">(${rule.need} more)</span>`}`) : html`<span class="muted">none</span>`}</td>
  </tr>`;
  })}</tbody></table></div>`;
}

function kpis(r) {
  const t = r.totals;
  const k = (label, v, sub) => html`<div class="kpi"><dt>${label}</dt><dd><span class="kpi-v">${v}</span><span class="kpi-s">${sub}</span></dd></div>`;
  return html`<dl class="kpis">
  ${k('Agent runs', n(t.runs), `${n(t.lines)} lines added`)}
  ${k('Approved in Grapim', n(t.approved), t.runs ? `${Math.round((t.approved / t.runs) * 100)}% of runs` : '')}
  ${k('Rejected or not approved', n(t.rejected + t.pending), `${n(t.rejected)} rejected`)}
  ${k('Reached a merged PR', n(t.merged), t.merged_unapproved ? `${n(t.merged_unapproved)} without approval` : 'all approved')}
</dl>`;
}

const qs = (p) => {
  const q = new URLSearchParams({ from: p.fromDay, to: p.toDay });
  if (p.repo) q.set('repo', p.repo);
  return `?${q}`;
};

export function evidencePage({ user, csrf, team, role, params, repos, report, features, teaser, billing, seatsUsed, error = null }) {
  const base = `/hub/teams/${team.id}/reports`;
  return layout({
    title: `Audit evidence · ${team.name}`,
    user,
    csrf,
    team,
    crumbs: [{ label: 'Reports', href: base }, { label: 'Audit evidence' }],
    wide: true,
    body: html`${head(team, 'reports')}
${error ? html`<p class="notice notice-error" role="alert">${error} Showing the default range.</p>` : ''}
<div class="rbar">
  <nav class="seg" aria-label="Report">${NAMES.map(([k, label]) => html`<a class="seg-item" href="${`${base}/${k}`}" ${k === 'evidence' ? html`aria-current="page"` : ''}>${label}</a>`)}</nav>
  ${features.reports
    ? html`<div class="rbar-right">
    <a class="btn btn-sm" href="${`/hub/api/teams/${team.id}/reports/evidence.csv${qs(params)}`}" download>Download CSV</a>
    <a class="btn btn-sm btn-primary" href="${`${base}/evidence/print${qs(params)}`}">Print view</a>
  </div>`
    : ''}
</div>
${features.reports
  ? html`<form class="filters" method="get" action="${`${base}/evidence`}">
  <label>From <input type="date" name="from" value="${params.fromDay}"></label>
  <label>To <input type="date" name="to" value="${params.toDay}"></label>
  <label>Repo <select name="repo"><option value="">All repos</option>${repos.map((x) => html`<option value="${x.id}" ${params.repo === x.id ? 'selected' : ''}>${x.name}</option>`)}</select></label>
  <button class="btn btn-sm" type="submit">Apply</button>
</form>
<p class="notice evidence-note" role="note">${DISCLAIMER}</p>
${kpis(report)}
${runsTable(report)}
${report.truncated ? html`<p class="fine">The first ${n(MAX_RUNS)} runs are shown. Narrow the dates for the rest.</p>` : ''}`
  : teaserBody({ team, role, csrf, teaser, billing, seatsUsed })}`,
  });
}

// A standalone page for printing or saving as PDF: no app shell.
export function evidencePrint({ team, user, report, origin, now }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent run evidence · ${esc(team.name)} · ${esc(report.range.from)} to ${esc(report.range.to)}</title>
<meta name="color-scheme" content="light dark">
<script src="/hub/static/theme.js"></script>
<link rel="icon" href="/hub/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/hub/static/tokens.css"><link rel="stylesheet" href="/hub/static/hub.css">
<script src="/hub/static/hub.js" defer></script>
</head><body class="print-page">
<main class="print-wrap">
${html`<header class="print-head">
  <p class="print-kicker">Grapim · agent run evidence</p>
  <h1>${team.name}</h1>
  <dl class="print-meta">
    <div><dt>Period (UTC)</dt><dd>${report.range.from} to ${report.range.to}</dd></div>
    <div><dt>Generated</dt><dd>${iso(now)} by ${user.login}</dd></div>
    <div><dt>Source</dt><dd>${origin}</dd></div>
    <div><dt>Runs</dt><dd>${n(report.totals.runs)}${report.truncated ? ' (first 5,000)' : ''}</dd></div>
  </dl>
  <p class="print-note">${DISCLAIMER}</p>
  <p class="print-actions"><button class="btn btn-sm btn-primary" type="button" data-print>Print or save as PDF</button> <a class="btn btn-sm" href="/hub/teams/${team.id}/reports/evidence?from=${report.range.from}&amp;to=${report.range.to}">Back</a></p>
</header>
${kpis(report)}
${runsTable(report, { print: true })}
<footer class="print-foot"><p>Each run is an agent session recorded by the Grapim CLI on a team member's machine and synced to the hub. "Approved" means a team member other than the person who synced the run approved it in Grapim after its last synced change; "GitHub" marks approvals made from the Grapim check's button, recorded as the GitHub user who clicked. Merged pull requests are those the Grapim GitHub App checked and saw merged. Path rules are listed as they apply now and as they applied at each decision (CSV).</p></footer>`}
</main></body></html>`;
}

export function evidenceRoutes(router, hub) {
  const TEAM = { auth: 'session', team: true };
  const setup = (ctx) => {
    hub.limit(ctx, 'read', ctx.member.userId);
    const team = hub.teams.get(ctx.member.team.id) ?? ctx.member.team;
    const features = hub.reports.features(team);
    return { team, features };
  };
  router.get('/hub/teams/:team/reports/evidence', (ctx) => {
    const { team, features } = setup(ctx);
    const repos = hub.reports.repos(team);
    let p;
    let error = null;
    try {
      p = hub.reports.params(team, ctx.url.searchParams, repos);
    } catch (err) {
      if (!(err instanceof HttpError) || err.status >= 500) throw err;
      error = err.message;
      p = hub.reports.params(team, new URLSearchParams(), repos);
    }
    sendHtml(
      ctx.res,
      error ? 400 : 200,
      evidencePage({
        user: ctx.session.user,
        csrf: ctx.session.csrf,
        team,
        role: ctx.member.role,
        params: p,
        repos,
        features,
        report: features.reports ? evidence(hub, team, p) : null,
        teaser: features.reports ? null : hub.reports.teaser(team),
        billing: { enabled: !!hub.billing, intervals: hub.config.governanceIntervals ?? [] },
        seatsUsed: hub.teams.seatsUsed(team.id),
        error,
      }).toString(),
    );
  }, TEAM);
  const gated = (ctx) => {
    const { team, features } = setup(ctx);
    if (!features.reports) throw new HttpError(402, 'plan_required', 'Audit evidence is on the Governance plan.');
    return { team, p: hub.reports.params(team, ctx.url.searchParams) };
  };
  router.get('/hub/teams/:team/reports/evidence/print', (ctx) => {
    const { team, p } = gated(ctx);
    sendHtml(ctx.res, 200, evidencePrint({ team, user: ctx.session.user, report: evidence(hub, team, p), origin: hub.config.origin, now: hub.now() }));
  }, TEAM);
  router.get('/hub/api/teams/:team/reports/evidence.csv', (ctx) => {
    const { team, p } = gated(ctx);
    const r = evidence(hub, team, p);
    const body = evidenceCsv(r);
    ctx.res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Content-Disposition': `attachment; filename="grapim-evidence-${r.range.from}-to-${r.range.to}.csv"`,
      'Cache-Control': 'no-store',
    });
    ctx.res.end(body);
  }, TEAM);
}

