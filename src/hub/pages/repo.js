// The read-only desk for one synced repo: who is active, every run, and a
// run's net diff per file. The same data as the JSON API, server rendered.

import { csrfField, layout } from './layout.js';
import { html, time } from './html.js';

const IN_TREE = { all: ['In tree', 'ok'], some: ['Partly', 'warn'], none: ['Gone', 'muted'] };

function treeBadge(v) {
  const [label, tone] = IN_TREE[v] ?? ['Unknown', 'muted'];
  return html`<span class="badge badge-${tone}">${label}</span>`;
}

const delta = (a, r) => html`<span class="delta"><span class="plus">+${a}</span> <span class="minus">−${r}</span></span>`;

export function repoPage({ user, csrf, team, repo, overview, runs }) {
  const base = `/hub/teams/${team.id}/repos/${repo.id}`;
  return layout({
    title: repo.name,
    user,
    csrf,
    team,
    wide: true,
    crumbs: [{ label: repo.name }],
    body: html`<header class="page-head">
  <h1>${repo.name} <span class="sha mono">${repo.id.slice(0, 7)}</span></h1>
  <p class="muted">${overview.counts.runs} run${overview.counts.runs === 1 ? '' : 's'} · ${overview.counts.agents} agent${overview.counts.agents === 1 ? '' : 's'} active in the last hour · read-only on the hub</p>
</header>
${overview.agents.length
  ? html`<section class="card" aria-labelledby="active-title">
  <h2 id="active-title" class="card-title">Active now</h2>
  <ul class="list list-flush">
  ${overview.agents.map(
    (a) => html`<li class="row">
    <span class="row-main"><span class="dot" aria-hidden="true"></span><span class="row-title">${a.label}</span><span class="muted">${a.machine}${a.worktree ? ` · ${a.worktree}` : ''}</span></span>
    <span class="row-meta truncate">${a.intent || ''}</span>
    <span class="row-meta">${time(a.last_seen)}</span>
  </li>`,
  )}
  </ul>
</section>`
  : ''}
${runs.length
  ? html`<div class="table-wrap">
<table class="table">
  <caption class="sr-only">Agent runs in ${repo.name}, newest first</caption>
  <thead><tr><th scope="col">Run</th><th scope="col" class="hide-sm">Working on</th><th scope="col" class="hide-sm">Machine</th><th scope="col" class="num">Files</th><th scope="col" class="num">Lines</th><th scope="col">In tree</th><th scope="col">Last</th></tr></thead>
  <tbody>
  ${runs.map(
    (r) => html`<tr>
    <th scope="row"><a class="strong" href="${`${base}/runs/${encodeURIComponent(r.run)}?machine=${encodeURIComponent(r.machine)}`}">${r.label}</a>${r.active ? html` <span class="dot" title="active" aria-label="active"></span>` : ''}</th>
    <td class="hide-sm truncate">${r.intent || html`<span class="muted">—</span>`}</td>
    <td class="hide-sm">${r.machine}${r.worktree ? html`<span class="muted"> · ${r.worktree}</span>` : ''}</td>
    <td class="num">${r.files}</td>
    <td class="num">${delta(r.added, r.removed)}</td>
    <td>${treeBadge(r.in_tree)}</td>
    <td>${time(r.last_ts)}</td>
  </tr>`,
  )}
  </tbody>
</table>
</div>`
  : html`<div class="empty"><p class="empty-title">No runs in the history window</p><p class="muted">Runs appear here once a connected machine syncs agent edits.</p></div>`}`,
  });
}

function diffTable(d) {
  return html`<table class="diff">
  ${d.hunks.map(
    (h) => html`<tbody>
    <tr class="hunk"><td colspan="3">@@ −${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</td></tr>
    ${(() => {
      let o = h.oldStart;
      let n = h.newStart;
      return h.lines.map((l) => {
        const left = l.t === '+' ? '' : o++;
        const right = l.t === '-' ? '' : n++;
        const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx';
        return html`<tr class="${cls}"><td class="ln">${left}</td><td class="ln">${right}</td><td class="src"><span class="sign" aria-hidden="true">${l.t === ' ' ? ' ' : l.t === '+' ? '+' : '−'}</span>${l.s}</td></tr>`;
      });
    })()}
  </tbody>`,
  )}
</table>`;
}

const STATE = { in_tree: ['In tree', 'ok'], partial: ['Partly', 'warn'], gone: ['Gone', 'muted'] };

export function runPage({ user, csrf, team, repo, detail }) {
  const r = detail.run;
  return layout({
    title: r.label,
    user,
    csrf,
    team,
    wide: true,
    crumbs: [{ label: repo.name, href: `/hub/teams/${team.id}/repos/${repo.id}` }, { label: r.label }],
    body: html`<header class="page-head">
  <h1>${r.label} ${treeBadge(r.in_tree)}</h1>
  <p class="muted">${r.machine}${r.worktree ? ` · ${r.worktree}` : ''} · ${r.turns} turn${r.turns === 1 ? '' : 's'} · ${r.files} file${r.files === 1 ? '' : 's'} · ${delta(r.added, r.removed)} · last edit ${time(r.last_ts)}</p>
  <p class="fine">To undo this run, run <code>grapim undo ${r.run.split(':').pop().slice(0, 8)}</code> on ${r.machine}. The hub never changes code.</p>
</header>
${detail.turns.length
  ? html`<ol class="turns" aria-label="Turns">
  ${detail.turns.map((t) => html`<li><span class="turn-n">Turn ${t.turn}</span><span class="truncate">${t.intent || html`<span class="muted">no prompt recorded</span>`}</span><span class="muted">${t.files.length} file${t.files.length === 1 ? '' : 's'}</span></li>`)}
</ol>`
  : ''}
${detail.files.map((f) => {
  const [label, tone] = STATE[f.state] ?? ['Unknown', 'muted'];
  return html`<section class="file" aria-label="${f.path}">
  <header class="file-head">
    <span class="mono strong truncate">${f.path}</span>
    <span class="file-meta">${delta(f.added, f.removed)} <span class="badge badge-${tone}">${label}</span></span>
  </header>
  ${f.diff ? (f.diff.hunks.length ? diffTable(f.diff) : html`<p class="muted small pad">No net change.</p>`) : html`<p class="muted small pad">Content not kept (binary or over 2 MB).</p>`}
</section>`;
})}`,
  });
}

export { csrfField };
