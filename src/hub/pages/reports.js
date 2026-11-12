// The Reports tab (docs/provenance.md section 7): a report switcher, filters,
// and per report an inline SVG chart, the same numbers as a table, and what
// the numbers do not cover. No chart library, no inline script or style (the
// CSP forbids both): bars are positioned with SVG attributes in percent, and
// the hover tooltips come from /hub/static/hub.js reading data-tip.

import { csrfField, layout } from './layout.js';
import { html } from './html.js';
import { head } from './team.js';

export const NAMES = [
  ['unreviewed', 'Merged without review'],
  ['ai-share', 'AI share'],
  ['agents', 'Agents'],
  ['activity', 'Activity'],
  ['evidence', 'Audit evidence'],
];
const KIND_LABEL = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', mcp: 'MCP agent', http: 'HTTP agent', other: 'Other agent' };
const kindLabel = (k) => KIND_LABEL[k] ?? k;
const kindClass = (k) => `k-${KIND_LABEL[k] ? k : 'other'}`;

const DAY = 24 * 60 * 60 * 1000;
const PAGE_RUNS = 50; // unreviewed runs listed on the page; the CSV has up to 500
const n = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–');
const pct = (r) => (r === null || r === undefined || !Number.isFinite(r) ? '–' : `${(r * 100).toFixed(r > 0 && r < 0.1 ? 1 : 0)}%`);
const short = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDay = (iso) => short(Date.parse(`${iso}T00:00:00Z`));
function duration(ms) {
  if (ms === null || ms === undefined) return '–';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ''}`;
}

// A round axis maximum and its ticks: 1, 2, 2.5 or 5 times a power of ten.
function niceScale(max, ticks = 4) {
  if (!(max > 0)) return { max: ticks, step: 1 };
  const raw = max / ticks;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
  return { max: step * ticks, step };
}
const compact = (v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : v >= 1000 ? `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(Math.round(v)));

// ---------------------------------------------------------------- charts

const PLOT = 180; // px of plot height
const AXIS = 22; // px under the plot for x labels

// Columns over time. series: [{ key, cls, label }] stacked bottom-up;
// points: [{ label, tip, values: { key: n } }].
function columns({ id, title, summary, series, points, labelEvery }) {
  const total = (p) => series.reduce((s, x) => s + (p.values[x.key] ?? 0), 0);
  const { max, step } = niceScale(Math.max(0, ...points.map(total)));
  const y = (v) => PLOT - (v / max) * PLOT;
  const slot = 100 / Math.max(1, points.length);
  const bw = Math.min(slot * 0.64, 7);
  const every = labelEvery ?? Math.max(1, Math.ceil(points.length / 6));
  const ticks = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
  return html`<figure class="chart" aria-labelledby="${id}-cap">
  <figcaption id="${id}-cap" class="sr-only">${title}. ${summary} The table below has every value.</figcaption>
  <div class="chart-grid" aria-hidden="true">
    <svg class="chart-y" width="40" height="${PLOT + AXIS + 8}">
      ${ticks.map((v) => html`<text x="34" y="${y(v) + 8 + 4}" text-anchor="end">${compact(v)}</text>`)}
    </svg>
    <svg class="chart-plot" width="100%" height="${PLOT + AXIS + 8}">
      <g transform="translate(0 8)">
        ${ticks.map((v) => html`<line class="${v === 0 ? 'base' : 'grid'}" x1="0" x2="100%" y1="${y(v)}" y2="${y(v)}"/>`)}
        ${points.map((p, i) => {
          const x = i * slot + (slot - bw) / 2;
          let acc = 0;
          const segs = series
            .map((s) => ({ ...s, v: p.values[s.key] ?? 0 }))
            .filter((s) => s.v > 0)
            .map((s, j, all) => {
              const top = y(acc + s.v);
              const h = y(acc) - top;
              acc += s.v;
              const last = j === all.length - 1;
              const gap = j > 0 && h > 3 ? 2 : 0; // a 2 px surface gap between stacked segments
              const hh = Math.max(1, h - gap);
              // Rounded data end on the top segment only: a rounded rect, squared at the bottom.
              return last && hh > 4
                ? html`<rect class="${s.cls}" x="${x}%" width="${bw}%" y="${top}" height="${hh}" rx="3"/><rect class="${s.cls}" x="${x}%" width="${bw}%" y="${top + 3}" height="${hh - 3}"/>`
                : html`<rect class="${s.cls}" x="${x}%" width="${bw}%" y="${top}" height="${hh}"/>`;
            });
          return html`<g class="col" data-tip="${p.tip}"><rect class="hit" x="${i * slot}%" width="${slot}%" y="0" height="${PLOT}"/>${segs}</g>`;
        })}
        ${points.map((p, i) => (i % every === 0 ? html`<text class="xl" x="${i * slot + slot / 2}%" y="${PLOT + 16}" text-anchor="middle">${p.label}</text>` : ''))}
      </g>
    </svg>
  </div>
</figure>`;
}

const legend = (items) =>
  html`<ul class="legend" aria-label="Legend">${items.map((s) => html`<li><span class="swatch ${s.cls}" aria-hidden="true"></span>${s.label}</li>`)}</ul>`;

// A horizontal bar for a table cell, as a share of the row maximum.
const hbar = (v, max, cls) =>
  html`<svg class="hbar" width="100%" height="8" aria-hidden="true"><rect class="track" width="100%" height="8" rx="2"/>${v > 0 ? html`<rect class="${cls}" width="${Math.max(1, (v / max) * 100)}%" height="8" rx="2"/>` : ''}</svg>`;

const stat = (label, value, sub = '') => html`<div class="kpi"><dt>${label}</dt><dd><span class="kpi-v">${value}</span>${sub ? html`<span class="kpi-s" title="${typeof sub === 'string' ? sub : null}">${sub}</span>` : ''}</dd></div>`;

// ---------------------------------------------------------------- shared parts

function caveats(list) {
  if (!list?.length) return '';
  return html`<details class="caveats" open>
  <summary>How to read this</summary>
  <ul>${list.map((c) => html`<li>${c}</li>`)}</ul>
</details>`;
}

function coverageLine(name, r) {
  const c = r.coverage;
  const range = html`<span>${shortDay(r.range.from)} – ${shortDay(r.range.to)}</span>`;
  const repos = (have, of, what) => html`<span><b>${what} from ${n(have)} of ${n(of)} repo${of === 1 ? '' : 's'}</b></span>`;
  const parts =
    name === 'agents' || name === 'activity'
      ? [repos(c.repos_with_runs, c.repos_total, 'Runs'), html`<span>${n(c.rows_scanned)} synced edits</span>`]
      : [repos(c.repos_with_provenance, c.repos_total, 'Provenance'), html`<span>${n(c.commits)} commit${c.commits === 1 ? '' : 's'}</span>`];
  if (name === 'agents') parts.push(html`<span>${n(c.commits)} commits with provenance</span>`);
  return html`<p class="coverage" role="note">${parts}${range}${c.repos_without_provenance?.length && name !== 'agents' && name !== 'activity' ? html`<span class="warn-text">${n(c.repos_without_provenance.length)} not recorded: unknown</span>` : ''}${r.range.clamped ? html`<span class="warn-text">history starts ${shortDay(r.range.history_from)} on this plan</span>` : ''}${c.truncated ? html`<span class="warn-text">partial: a scan cap was hit</span>` : ''}</p>`;
}

function emptyProvenance(r, team) {
  return html`<div class="empty">
  <p class="empty-title">No provenance in this range</p>
  <p class="muted">${r.coverage.repos_total ? `None of the ${r.coverage.repos_total} synced repo${r.coverage.repos_total === 1 ? '' : 's'} uploaded a provenance note for a commit between these dates.` : 'No repos are synced to this team yet.'} Reports read the git notes Grapim writes on every commit.</p>
  <pre class="code" tabindex="0"><code># in each repo, once: installs the commit hooks that write the notes
grapim init

# commit as usual, then upload runs and notes to the hub
grapim sync</code></pre>
  ${r.coverage.repos_total ? '' : html`<p class="fine">Create a machine token in <a href="/hub/teams/${team.id}/settings#tokens">Settings</a> first.</p>`}
</div>`;
}

function emptyRuns(team) {
  return html`<div class="empty">
  <p class="empty-title">No synced runs in this range</p>
  <p class="muted">Agent runs reach the hub when a machine syncs. Run this in a repo where Grapim is set up:</p>
  <pre class="code" tabindex="0"><code>grapim sync --watch</code></pre>
  <p class="fine">No machine yet? Create a token in <a href="/hub/teams/${team.id}/settings#tokens">Settings</a>.</p>
</div>`;
}

// ---------------------------------------------------------------- the four reports

function aiShareBody(r, team) {
  if (!r.coverage.commits) return emptyProvenance(r, team);
  const t = r.totals;
  const series = [...r.kinds.map((k) => ({ key: k, cls: kindClass(k), label: kindLabel(k) })), { key: 'human', cls: 'k-human', label: 'Human' }];
  const points = r.weeks.map((w) => ({
    label: shortDay(w.week),
    tip: `Week of ${shortDay(w.week)}: ${n(w.ai)} AI lines${w.share === null ? '' : ` (${pct(w.share)})`}, ${n(w.human)} human, ${n(w.commits)} recorded commit${w.commits === 1 ? '' : 's'}${r.kinds.length > 1 ? `. ${r.kinds.filter((k) => w.by_kind[k]).map((k) => `${kindLabel(k)} ${n(w.by_kind[k])}`).join(', ')}` : ''}`,
    values: { ...w.by_kind, human: w.human },
  }));
  return html`<dl class="kpis">
  ${stat('AI share of added lines', pct(t.share), t.added ? `${n(t.ai_in_share)} of ${n(t.added)} lines` : 'no commit reported its total')}
  ${stat('AI-written lines', n(t.ai), r.kinds.length ? r.kinds.map(kindLabel).join(', ') : '')}
  ${stat('Human lines', n(t.human), 'recorded commits, no agent run')}
  ${stat('Recorded commits', n(t.commits), `${n(r.coverage.repos_with_provenance)} of ${n(r.coverage.repos_total)} repos; the rest unknown`)}
</dl>
<section class="card chart-card" aria-labelledby="c-weeks">
  <div class="card-head"><h2 id="c-weeks" class="card-title">Added lines in recorded commits, by week</h2>${legend(series)}</div>
  ${columns({ id: 'weeks', title: 'Added lines in recorded commits by week, AI-written by agent kind and human', summary: `${pct(t.share)} of ${n(t.added)} added lines were AI-written.`, series, points })}
</section>
<div class="table-wrap">
<table class="table table-dense">
  <caption class="sr-only">Added lines by week</caption>
  <thead><tr><th scope="col">Week of</th><th scope="col" class="num hide-sm">Commits</th>${r.kinds.map((k) => html`<th scope="col" class="num hide-sm">${kindLabel(k)}</th>`)}<th scope="col" class="num">AI lines</th><th scope="col" class="num">Human</th><th scope="col" class="num hide-sm">Added</th><th scope="col" class="num">AI share</th></tr></thead>
  <tbody>
  ${[...r.weeks].reverse().map(
    (w) => html`<tr>
    <th scope="row">${shortDay(w.week)}${w.start + 7 * DAY > Date.parse(`${r.range.to}T00:00:00Z`) + DAY ? html` <span class="muted small">so far</span>` : ''}</th>
    <td class="num hide-sm">${n(w.commits)}</td>
    ${r.kinds.map((k) => html`<td class="num hide-sm">${n(w.by_kind[k] ?? 0)}</td>`)}
    <td class="num">${n(w.ai)}</td>
    <td class="num">${n(w.human)}</td>
    <td class="num hide-sm">${n(w.added)}</td>
    <td class="num strong">${pct(w.share)}</td>
  </tr>`,
  )}
  </tbody>
</table>
</div>
<h2 class="section-title">By repo</h2>
<div class="table-wrap">
<table class="table table-dense">
  <caption class="sr-only">AI share by repo</caption>
  <thead><tr><th scope="col">Repo</th><th scope="col" class="bar-col hide-sm"><span class="sr-only">AI share</span></th><th scope="col" class="num hide-sm">Commits</th><th scope="col" class="num">AI lines</th><th scope="col" class="num">Human</th><th scope="col" class="num">AI share</th></tr></thead>
  <tbody>
  ${r.repos.map(
    (x) => html`<tr>
    <th scope="row"><a class="strong" href="/hub/teams/${team.id}/repos/${x.repo}">${x.name}</a></th>
    <td class="bar-col hide-sm">${x.share === null ? '' : hbar(x.share, 1, 'k-ai')}</td>
    <td class="num hide-sm">${n(x.commits)}</td>
    <td class="num">${n(x.ai)}</td>
    <td class="num">${n(x.human)}</td>
    <td class="num strong">${pct(x.share)}</td>
  </tr>`,
  )}
  ${r.coverage.repos_without_provenance.map(
    (name) => html`<tr class="row-dim">
    <th scope="row">${name}</th><td class="bar-col hide-sm"></td><td class="num wrap" colspan="4"><span class="muted">Not recorded, lines unknown: run <code>grapim init</code> there</span></td>
  </tr>`,
  )}
  </tbody>
</table>
</div>`;
}

function agentsBody(r, team) {
  if (!r.totals.runs && !r.totals.lines_committed) return emptyRuns(team);
  const t = r.totals;
  const max = Math.max(1, ...r.agents.map((g) => g.lines_committed || g.lines_written));
  const useCommitted = r.agents.some((g) => g.lines_committed);
  return html`<dl class="kpis">
  ${stat('Agent runs', n(t.runs), `${n(r.agents.length)} agent${r.agents.length === 1 ? '' : 's'}`)}
  ${stat('Undo rate', pct(t.undo_rate), `${n(t.undone)} undone`)}
  ${stat('Reject rate', pct(t.reject_rate), `${n(t.rejected)} of ${n(t.reviewed)} reviewed`)}
  ${stat('Lines committed', n(t.lines_committed), `${n(t.lines_written)} written`)}
</dl>
<section class="card chart-card flush" aria-labelledby="c-agents">
  <div class="card-head pad"><h2 id="c-agents" class="card-title">Agents</h2><span class="muted small">Bar: ${useCommitted ? 'lines committed' : 'lines written'}</span></div>
  <div class="table-scroll">
  <table class="table table-dense bar-table">
    <caption class="sr-only">Agents by kind and label: runs, lines, undo and reject rates, review time</caption>
    <thead><tr><th scope="col">Agent</th><th scope="col" class="bar-col hide-sm"><span class="sr-only">Bar</span></th><th scope="col" class="num">Runs</th><th scope="col" class="num hide-sm">Written</th><th scope="col" class="num">Committed</th><th scope="col" class="num">Undo</th><th scope="col" class="num">Reject</th><th scope="col" class="num">Review time</th></tr></thead>
    <tbody>
    ${r.agents.map(
      (g) => html`<tr data-tip="${`${g.prefix} (${kindLabel(g.kind)}): ${n(g.runs)} runs, ${n(g.approved)} approved, ${n(g.rejected)} rejected, ${n(g.pending)} pending, ${n(g.undone)} undone`}">
      <th scope="row"><span class="agent"><span class="swatch ${kindClass(g.kind)}" aria-hidden="true"></span><span class="strong">${g.prefix}</span><span class="muted small hide-sm">${kindLabel(g.kind)}</span></span></th>
      <td class="bar-col hide-sm">${hbar(useCommitted ? g.lines_committed : g.lines_written, max, kindClass(g.kind))}</td>
      <td class="num">${n(g.runs)}</td>
      <td class="num hide-sm">${n(g.lines_written)}</td>
      <td class="num">${n(g.lines_committed)}</td>
      <td class="num">${pct(g.undo_rate)}</td>
      <td class="num">${pct(g.reject_rate)}</td>
      <td class="num">${duration(g.median_review_ms)}</td>
    </tr>`,
    )}
    </tbody>
  </table>
  </div>
</section>
${r.excluded.undo || r.excluded.restore || r.excluded.sync ? html`<p class="fine">Not counted as agents: ${[r.excluded.undo && `${n(r.excluded.undo)} undo`, r.excluded.restore && `${n(r.excluded.restore)} restore`, r.excluded.sync && `${n(r.excluded.sync)} folder-sync`].filter(Boolean).join(', ')} run${r.excluded.undo + r.excluded.restore + r.excluded.sync === 1 ? '' : 's'}.</p>` : ''}`;
}

function unreviewedBody(r, team) {
  if (!r.coverage.commits) return emptyProvenance(r, team);
  const t = r.totals;
  const approved = Math.max(0, t.ai_lines - t.lines);
  const parts = [
    { key: 'approved', cls: 'k-approved', label: 'Approved', v: approved },
    { key: 'pending', cls: 'k-pending', label: 'Pending review', v: t.pending_lines },
    { key: 'rejected', cls: 'k-rejected', label: 'Rejected', v: t.rejected_lines },
  ];
  let acc = 0;
  const max = Math.max(1, ...r.runs.map((u) => u.lines));
  return html`<dl class="kpis">
  ${stat('Unreviewed AI lines', n(t.lines), `${pct(t.share_of_ai)} of ${n(t.ai_lines)} AI lines`)}
  ${stat('Pending review', n(t.pending_lines), 'lines')}
  ${stat('Rejected, still in commits', n(t.rejected_lines), 'lines')}
  ${stat('Runs not approved', n(t.runs), `${n(t.commits)} commit${t.commits === 1 ? '' : 's'}`)}
</dl>
<section class="card chart-card" aria-labelledby="c-review">
  <div class="card-head"><h2 id="c-review" class="card-title">AI lines in commits, by review state</h2>${legend(parts)}</div>
  <figure class="chart" aria-labelledby="c-review-cap">
    <figcaption id="c-review-cap" class="sr-only">${n(approved)} approved, ${n(t.pending_lines)} pending and ${n(t.rejected_lines)} rejected AI lines.</figcaption>
    <svg class="segbar" width="100%" height="28" aria-hidden="true">
      ${t.ai_lines
        ? parts.filter((p) => p.v > 0).map((p, i) => {
            const w = (p.v / t.ai_lines) * 100;
            const x = acc;
            acc += w;
            return html`<g data-tip="${`${p.label}: ${n(p.v)} lines (${pct(p.v / t.ai_lines)})`}"><rect class="${p.cls}" x="${x}%" width="${w}%" height="28" rx="3"/>${i > 0 ? html`<rect class="gap" x="${x}%" width="2" height="28"/>` : ''}</g>`;
          })
        : html`<rect class="track" width="100%" height="28" rx="3"/>`}
    </svg>
  </figure>
</section>
${r.runs.length
  ? html`<div class="table-wrap">
<table class="table table-dense">
  <caption class="sr-only">Runs whose AI lines are in commits without an approval</caption>
  <thead><tr><th scope="col">Run</th><th scope="col">State</th><th scope="col" class="bar-col hide-sm"><span class="sr-only">Lines</span></th><th scope="col" class="num">Lines</th><th scope="col" class="num hide-sm">Files</th><th scope="col" class="num hide-sm">Commits</th><th scope="col" class="hide-sm">Repo</th><th scope="col">Last commit</th></tr></thead>
  <tbody>
  ${r.runs.slice(0, PAGE_RUNS).map(
    (u) => html`<tr>
    <th scope="row" class="truncate"><span class="agent"><span class="swatch ${kindClass(u.kind)}" aria-hidden="true"></span><span class="strong">${u.label}</span></span>${u.intent ? html`<span class="intent muted" title="${u.intent}">${u.intent}</span>` : ''}</th>
    <td><span class="badge ${u.status === 'rejected' ? 'badge-danger' : 'badge-warn'}">${u.status}</span></td>
    <td class="bar-col hide-sm">${hbar(u.lines, max, u.status === 'rejected' ? 'k-rejected' : 'k-pending')}</td>
    <td class="num">${n(u.lines)}</td>
    <td class="num hide-sm">${n(u.files)}</td>
    <td class="num hide-sm">${n(u.commits)}</td>
    <td class="hide-sm">${u.repo_name}</td>
    <td>${short(u.last_ts)}</td>
  </tr>`,
  )}
  </tbody>
</table>
</div>
${t.runs > PAGE_RUNS ? html`<p class="fine">Showing the ${PAGE_RUNS} runs with the most unreviewed lines, of ${n(t.runs)}. Export CSV for ${r.coverage.list_truncated ? `the top ${n(r.runs.length)}` : 'all of them'}.</p>` : ''}`
  : html`<div class="empty empty-ok"><p class="empty-title">Every AI line in this range is from an approved run</p><p class="muted">${n(t.ai_lines)} AI lines in ${n(r.coverage.commits)} commits.</p></div>`}`;
}

function activityBody(r, team) {
  const t = r.totals;
  if (!t.edits && !t.blocks) return emptyRuns(team);
  const long = r.days.length > 45;
  const label = (d) => shortDay(d.date);
  const tip = (d) => `${shortDay(d.date)}: ${n(d.runs)} run${d.runs === 1 ? '' : 's'}, ${n(d.files)} files, ${n(d.blocks)} block${d.blocks === 1 ? '' : 's'}, ${n(d.conflicts)} conflict${d.conflicts === 1 ? '' : 's'}`;
  const every = Math.max(1, Math.ceil(r.days.length / (long ? 6 : 7)));
  const friction = [
    { key: 'blocks', cls: 'k-blocks', label: 'Blocks' },
    { key: 'conflicts', cls: 'k-conflicts', label: 'Conflicts' },
  ];
  return html`<dl class="kpis">
  ${stat('Runs', n(t.runs), `${n(t.active_days)} active day${t.active_days === 1 ? '' : 's'}`)}
  ${stat('Files touched', n(t.files), `${n(t.edits)} edits`)}
  ${stat('Blocks', n(t.blocks), 'edits refused: file held')}
  ${stat('Conflicts', n(t.conflicts), 'files 2+ runs changed in a day')}
</dl>
<section class="card chart-card" aria-labelledby="c-runs">
  <div class="card-head"><h2 id="c-runs" class="card-title">Runs per day</h2><span class="muted small">busiest day ${n(t.busiest)}</span></div>
  ${columns({ id: 'runs', title: 'Agent runs per day', summary: `${n(t.runs)} runs on ${n(t.active_days)} days.`, series: [{ key: 'runs', cls: 'k-ai' }], points: r.days.map((d) => ({ label: label(d), tip: tip(d), values: { runs: d.runs } })), labelEvery: every })}
</section>
<section class="card chart-card" aria-labelledby="c-friction">
  <div class="card-head"><h2 id="c-friction" class="card-title">Blocks and conflicts per day</h2>${legend(friction)}</div>
  ${columns({ id: 'friction', title: 'Blocks and conflicts per day', summary: `${n(t.blocks)} blocks and ${n(t.conflicts)} conflicts.`, series: friction, points: r.days.map((d) => ({ label: label(d), tip: tip(d), values: { blocks: d.blocks, conflicts: d.conflicts } })), labelEvery: every })}
</section>
<div class="table-wrap">
<table class="table table-dense">
  <caption class="sr-only">Activity per day (days with any activity)</caption>
  <thead><tr><th scope="col">Day</th><th scope="col" class="num">Runs</th><th scope="col" class="num">Files</th><th scope="col" class="num hide-sm">Edits</th><th scope="col" class="num">Blocks</th><th scope="col" class="num">Conflicts</th></tr></thead>
  <tbody>
  ${[...r.days].reverse().filter((d) => d.edits || d.blocks).map(
    (d) => html`<tr>
    <th scope="row">${new Date(d.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}</th>
    <td class="num">${n(d.runs)}</td>
    <td class="num">${n(d.files)}</td>
    <td class="num hide-sm">${n(d.edits)}</td>
    <td class="num">${d.blocks ? html`<span class="warn-text">${n(d.blocks)}</span>` : '0'}</td>
    <td class="num">${n(d.conflicts)}</td>
  </tr>`,
  )}
  </tbody>
</table>
</div>`;
}

const BODY = { 'ai-share': aiShareBody, agents: agentsBody, unreviewed: unreviewedBody, activity: activityBody };

// ---------------------------------------------------------------- free and team: the teaser

function teaserBody({ team, role, csrf, teaser, billing, seatsUsed }) {
  const t = teaser;
  const owner = role === 'owner';
  const has = t.commits > 0;
  return html`<section class="card teaser" aria-labelledby="teaser-title">
  <h2 class="card-title" id="teaser-title">Last week · ${shortDay(t.week)} – ${shortDay(t.week_end)}</h2>
  ${has
    ? html`<p class="teaser-big"><span class="teaser-num">${pct(t.share)}</span> of added lines were written by AI agents</p>
  <p class="muted">${n(t.ai_in_share)} AI lines of ${n(t.added)} added, in ${n(t.commits)} commit${t.commits === 1 ? '' : 's'} with provenance from ${n(t.repos_with_provenance)} of ${n(t.repos_total)} repo${t.repos_total === 1 ? '' : 's'}. ${n(t.human)} human lines.${t.repos_not_recorded ? ` ${n(t.repos_not_recorded)} repo${t.repos_not_recorded === 1 ? ' has' : 's have'} no notes: unknown, not counted.` : ''}</p>`
    : html`<p class="teaser-big"><span class="teaser-num">–</span> no provenance last week</p>
  <p class="muted">Run <code>grapim init</code> in each repo so every commit gets a provenance note, then <code>grapim sync</code>. Next week this shows the AI share of your added lines.</p>`}
</section>
<section class="card upgrade" aria-labelledby="up-title">
  <div class="card-head"><h2 id="up-title" class="card-title">Governance</h2><span class="price"><b>$40</b> per seat a month, or $384 a year</span></div>
  <p class="card-sub">The record a manager needs before rolling AI agents out wider.</p>
  <ul class="checks">
    <li><b>Require review</b>: the Grapim GitHub check fails a pull request until a teammate, not the run's author, approves each agent run in the hub, and until every commit is recorded</li>
    <li><b>Unreviewed</b>: AI lines in commits from runs nobody approved</li>
    <li><b>Agents</b>: runs, undo rate, reject rate and median review time per agent</li>
    <li><b>AI share</b> of added lines by week, repo and agent, back 365 days</li>
    <li><b>Activity</b>: runs, files, blocks and conflicts per day, and CSV export of every report</li>
  </ul>
  ${billing.enabled && owner && billing.intervals.length
    ? html`<form method="post" action="/hub/billing/checkout" class="inline-form">
    ${csrfField(csrf)}
    <input type="hidden" name="team" value="${team.id}">
    <input type="hidden" name="plan" value="governance">
    <label for="g-seats">Seats</label>
    <input id="g-seats" name="seats" type="number" min="1" max="1000" value="${Math.max(seatsUsed, team.seats || 0, 1)}" inputmode="numeric" class="input-narrow">
    <label class="sr-only" for="g-interval">Billing period</label>
    <select id="g-interval" name="interval">${billing.intervals.map((i) => html`<option value="${i}">${i === 'month' ? 'Monthly' : 'Yearly'}</option>`)}</select>
    <button class="btn btn-primary" type="submit">Upgrade to Governance</button>
  </form>`
    : !billing.enabled
      ? html`<p class="fine">You are on the ${team.plan} plan. During early access there is no checkout: Governance is available as a pilot. <a class="link" href="/hub/support?topic=pilot&amp;from=${encodeURIComponent(`/hub/teams/${team.id}/reports`)}">Talk to us</a>.</p>`
      : html`<p class="fine">${owner ? html`Upgrade from <a href="/hub/teams/${team.id}/settings#billing">Settings → Billing</a>.` : 'Ask a team owner to upgrade.'} You are on the ${team.plan} plan.</p>`}
</section>`;
}

// ---------------------------------------------------------------- the page

export { teaserBody };

export function reportsPage({ user, csrf, team, role, name, params, query, repos, features, report, teaser, billing, seatsUsed, now = Date.now(), error = null }) {
  const qs = (over = {}) => {
    const q = new URLSearchParams();
    const v = { ...query, ...over };
    for (const k of ['from', 'to', 'repo']) if (v[k]) q.set(k, v[k]);
    const s = q.toString();
    return s ? `?${s}` : '';
  };
  const base = `/hub/teams/${team.id}/reports`;
  const today = new Date(Math.floor(now / DAY) * DAY);
  const iso = (d) => d.toISOString().slice(0, 10);
  const preset = (label, days) => {
    const from = iso(new Date(today.getTime() - (days - 1) * DAY));
    // With no dates given the default range (the 12 weeks up to today) is on.
    const on = query.from ? query.from === from && (!query.to || query.to === iso(today)) : !query.to && days === 84;
    return html`<a class="seg-item" href="${`${base}/${name}${qs({ from, to: '' })}`}" ${on ? html`aria-current="true"` : ''}>${label}</a>`;
  };
  const title = NAMES.find(([k]) => k === name)[1];
  return layout({
    title: `${title} · ${team.name}`,
    user,
    csrf,
    team,
    crumbs: [{ label: 'Reports' }],
    wide: true,
    body: html`${head(team, 'reports')}
${error ? html`<p class="notice notice-error" role="alert">${error} Showing the default range.</p>` : ''}
<div class="rbar">
  <nav class="seg" aria-label="Report">
    ${NAMES.map(([k, label]) => html`<a class="seg-item" href="${`${base}/${k}${qs()}`}" ${k === name ? html`aria-current="page"` : ''}>${label}</a>`)}
  </nav>
  ${features.reports
    ? html`<div class="rbar-right">
    <nav class="seg seg-quiet" aria-label="Range">${preset('4w', 28)}${preset('12w', 84)}${preset('6m', 182)}${preset('1y', 365)}</nav>
    <a class="btn btn-sm" href="${`/hub/api/teams/${team.id}/reports/${name}.csv${qs()}`}" download>Export CSV</a>
  </div>`
    : ''}
</div>
${features.reports
  ? html`<form class="filters" method="get" action="${`${base}/${name}`}">
  <label>From <input type="date" name="from" value="${params.fromDay}" min="${params.historyFrom === null ? '' : iso(new Date(params.historyFrom))}" max="${iso(today)}"></label>
  <label>To <input type="date" name="to" value="${params.toDay}" max="${iso(today)}"></label>
  <label>Repo <select name="repo">
    <option value="">All repos</option>
    ${repos.map((r) => html`<option value="${r.id}" ${params.repo === r.id ? 'selected' : ''}>${r.name}</option>`)}
  </select></label>
  <button class="btn btn-sm" type="submit">Apply</button>
</form>
${coverageLine(name, report)}
${BODY[name](report, team)}
${caveats(report.caveats)}`
  : teaserBody({ team, role, csrf, teaser, billing, seatsUsed })}`,
  });
}
