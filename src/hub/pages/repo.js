// One synced repo: who is active, and every run with its hub review state;
// and one run, reviewed like a pull request: a sticky header with its review
// state and Approve / Reject, its turns, and its net diff per file. The same
// data as the JSON API, server rendered, styled like the review desk's run view.

import { pullUrl } from '../overview.js';
import { csrfField, layout } from './layout.js';
import { html, time } from './html.js';
import { icon } from './icons.js';
import { agent, delta, plural, reviewBadge } from './parts.js';
import { kindOf } from '../reports/notes.js';

const IN_TREE = { all: ['In tree', 'ok'], some: ['Partly in tree', 'warn'], none: ['Not in tree', 'muted'] };

function treeBadge(v) {
  const [label, tone] = IN_TREE[v] ?? ['Tree state unknown', 'muted'];
  return html`<span class="badge badge-outline badge-${tone}">${label}</span>`;
}

// review: Map(run -> { status, stale, ... }) from the hub's reviews, or empty.
const statusOf = (h) => (!h ? 'pending' : h.stale ? 'stale' : h.status);

export function repoPage({ user, csrf, team, repo, overview, runs, reviews = new Map() }) {
  const base = `/hub/teams/${team.id}/repos/${repo.id}`;
  return layout({
    title: repo.name,
    user,
    csrf,
    team,
    wide: true,
    crumbs: [{ label: 'Repos', href: `/hub/teams/${team.id}/repos` }, { label: repo.name }],
    body: html`<header class="page-head">
  <div class="page-head-main">
    <h1>${repo.name} <span class="sha mono">${repo.id.slice(0, 7)}</span></h1>
    <p class="page-sub">${plural(overview.counts.runs, 'run')} in the history window · ${plural(overview.counts.agents, 'agent')} active in the last hour</p>
  </div>
</header>
${overview.agents.length
  ? html`<section class="panel" aria-labelledby="active-title">
  <div class="panel-head"><h2 id="active-title" class="panel-title">Active now <span class="num muted">${overview.agents.length}</span></h2></div>
  <ul class="plain-list">
  ${overview.agents.map(
    (a) => html`<li class="plain-row"><span class="live" aria-hidden="true"></span><span class="plain-main">${agent(a.label, kindOf(a.agent))}<span class="muted small truncate">${a.intent || ''}</span></span><span class="muted small hide-sm">${a.machine}${a.worktree ? ` · ${a.worktree}` : ''}</span>${time(a.last_seen)}</li>`,
  )}
  </ul>
</section>`
  : ''}
${runs.length
  ? html`<div class="table-wrap">
<table class="table">
  <caption class="sr-only">Agent runs in ${repo.name}, newest first</caption>
  <thead><tr><th scope="col">Run</th><th scope="col" class="hide-sm">Machine</th><th scope="col" class="num hide-sm">Files</th><th scope="col" class="num">Lines</th><th scope="col" class="hide-sm">In tree</th><th scope="col">Review</th><th scope="col">Last</th></tr></thead>
  <tbody>
  ${runs.map(
    (r) => html`<tr>
    <th scope="row" class="cell-run"><a class="run-link" href="${`${base}/runs/${encodeURIComponent(r.run)}?machine=${encodeURIComponent(r.machine)}`}"><span class="run-intent">${r.intent || r.label}</span></a><span class="run-sub">${agent(r.label, kindOf(r.run))}${r.active ? html`<span class="live" title="Active" aria-label="active"></span>` : ''}</span></th>
    <td class="hide-sm">${r.machine}${r.worktree ? html`<span class="muted"> · ${r.worktree}</span>` : ''}</td>
    <td class="num hide-sm">${r.files}</td>
    <td class="num">${delta(r.added, r.removed)}</td>
    <td class="hide-sm">${treeBadge(r.in_tree)}</td>
    <td>${reviewBadge(statusOf(reviews.get(r.run)))}</td>
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
  return html`<div class="diff"><table>
  ${d.hunks.map(
    (h) => html`<tbody>
    <tr class="hunk"><td class="ln" aria-hidden="true"></td><td class="ln" aria-hidden="true"></td><td class="src">@@ −${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</td></tr>
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
</table></div>`;
}

const STATE = { in_tree: ['In tree', 'ok'], partial: ['Partly in tree', 'warn'], gone: ['Not in tree', 'muted'] };
const fileId = (p) => `file-${p.replace(/[^a-zA-Z0-9]+/g, '-')}`;

// The hub review of a run (docs/provenance.md section 6): the only approval
// the require_review policy counts. review: from hub.github.reviewPanel.
function reviewState(review) {
  const h = review.hub;
  return !h ? 'pending' : h.stale ? 'stale' : h.status;
}

function reviewActions({ review, state }) {
  if (review.mine) return html`<span class="muted small">You synced this run</span>`;
  return html`<button class="btn ${state === 'approved' ? '' : 'btn-primary'}" type="submit" form="review-form" name="status" value="approved">${icon('check')}Approve</button>
    <button class="btn btn-danger" type="submit" form="review-form" name="status" value="rejected">${icon('x')}Reject</button>`;
}

function reviewPanel({ csrf, team, repo, run, review }) {
  const h = review.hub;
  const action = `/hub/teams/${team.id}/repos/${repo.id}/runs/${encodeURIComponent(run.run)}/decision`;
  return html`<section class="panel review-panel" id="review" aria-labelledby="review-title">
  <div class="panel-head"><h2 id="review-title" class="panel-title">Review</h2>${reviewBadge(reviewState(review))}</div>
  <div class="panel-body">
  ${review.done ? html`<p class="notice" role="status">${review.done === 'approved' ? 'Approved.' : 'Rejected.'} Open pull requests with this run are checked again.</p>` : ''}
  <p>${h
    ? html`${h.status === 'approved' ? 'Approved' : 'Rejected'} by <span class="strong">${h.reviewer_login || 'a member'}</span> ${time(h.reviewed_at)}${h.note ? html`: ${h.note}` : ''}.${h.stale ? ' The run changed after that, so it needs a new review.' : ''}`
    : 'Nobody has reviewed this run in the hub yet.'}
  ${review.enforced && !(h && h.status === 'approved' && !h.stale) ? ' Pull requests with its lines fail the Grapim check until it is approved here.' : ''}</p>
  ${review.pulls.length
    ? html`<p class="pulls">${icon('pr')}<span>In pull requests: ${review.pulls.map((p, i) => {
        const url = pullUrl(p);
        return html`${i ? ', ' : ''}${url ? html`<a class="link mono" href="${url}" rel="noopener noreferrer">${p.owner}/${p.name}#${p.number}</a>` : html`<code>${p.owner}/${p.name}#${p.number}</code>`}`;
      })}</span></p>`
    : ''}
  ${review.local && review.local.status !== 'pending' ? html`<p class="fine">${review.local.status === 'approved' ? 'Approved' : 'Rejected'} locally by ${review.local.login || review.local.machine} with <code>grapim review</code>. Shown for information: it does not count for the policy.</p>` : ''}
  <p class="fine">Synced by ${review.owners.length ? review.owners.join(', ') : 'nobody'}. The person who synced a run cannot review it.</p>
  ${review.mine
    ? html`<p class="muted small">You synced this run, so another member has to review it.</p>`
    : html`<form method="post" action="${action}" class="review-form" id="review-form">
    ${csrfField(csrf)}
    <input type="hidden" name="machine" value="${run.machine}">
    <label for="review-note">Note (optional), sent with Approve or Reject</label>
    <textarea id="review-note" name="note" maxlength="1000" rows="2"></textarea>
  </form>`}
  </div>
</section>`;
}

export function runPage({ user, csrf, team, repo, detail, review = null }) {
  const r = detail.run;
  const state = review ? reviewState(review) : null;
  const add = detail.files.reduce((n, f) => n + (f.added ?? 0), 0);
  const del = detail.files.reduce((n, f) => n + (f.removed ?? 0), 0);
  const many = detail.files.length > 1;
  return layout({
    title: r.label,
    user,
    csrf,
    team,
    wide: true,
    crumbs: [{ label: 'Repos', href: `/hub/teams/${team.id}/repos` }, { label: repo.name, href: `/hub/teams/${team.id}/repos/${repo.id}` }, { label: r.label }],
    body: html`<header class="run-bar">
  <div class="run-bar-main">
    <h1 class="run-title">${r.intent || r.label}</h1>
    ${state ? reviewBadge(state) : ''}
  </div>
  ${review ? html`<div class="run-bar-actions" role="group" aria-label="Review">${reviewActions({ review, state })}</div>` : ''}
</header>
<div class="run-meta">
  ${agent(r.label, kindOf(r.run))}
  <span>${r.machine}${r.worktree ? ` · ${r.worktree}` : ''}</span>
  <span>${plural(r.turns, 'turn')}</span>
  <span>${plural(r.files, 'file')} ${delta(r.added, r.removed)}</span>
  <span>last edit ${time(r.last_ts)}</span>
  ${treeBadge(r.in_tree)}
  ${r.active ? html`<span class="badge badge-pending"><span class="live" aria-hidden="true"></span>Active</span>` : ''}
</div>
<p class="fine">Undo runs on the machine that made the edits: <code>grapim undo ${r.run.split(':').pop().slice(0, 8)}</code> on ${r.machine}. The hub never changes code.</p>
${review ? reviewPanel({ csrf, team, repo, run: r, review }) : ''}
${detail.turns.length
  ? html`<section aria-labelledby="turns-title">
  <h2 id="turns-title" class="section-title">Turns <span class="num muted">${detail.turns.length}</span></h2>
  <ol class="panel turns" aria-label="Turns">
  ${detail.turns.map(
    (t) => html`<li>
    <span class="turn-n">${t.turn}</span>
    <div class="turn-body">
      ${t.intent ? html`<p class="turn-intent">${t.intent}</p>` : html`<p class="muted">No prompt recorded</p>`}
      <div class="chips">${t.files.map((p) => html`<a class="chip" href="#${fileId(p)}" title="${`Jump to ${p}`}">${p}</a>`)}</div>
    </div>
    <span class="turn-side">${time(t.ts)}</span>
  </li>`,
  )}
  </ol>
</section>`
  : ''}
<section aria-labelledby="files-title">
  <div class="files-head">
    <h2 id="files-title" class="section-title">Files changed <span class="num muted">${detail.files.length}</span> ${delta(add, del)}</h2>
    <label class="toggle"><input type="checkbox" id="wrap-lines" data-pref="wrap"> Wrap long lines</label>
  </div>
  <div class="changes ${many ? '' : 'single'}">
    ${many
      ? html`<nav class="ftree panel" aria-label="Changed files">${detail.files.map(
          (f) => html`<a href="#${fileId(f.path)}" title="${f.path}">${icon('file')}<span class="p"><bdi>${f.path}</bdi></span>${f.diff ? html`<span class="delta"><span class="plus">+${f.added}</span></span>` : ''}</a>`,
        )}</nav>`
      : ''}
    <div class="file-list">
    ${detail.files.map((f) => {
      const [label, tone] = STATE[f.state] ?? ['Tree state unknown', 'muted'];
      return html`<details class="file panel" id="${fileId(f.path)}" open>
  <summary class="file-head">
    ${icon('chev', 'chev')}
    <span class="file-path" title="${f.path}">${f.path}</span>
    <span class="file-meta">${f.diff ? delta(f.added, f.removed) : html`<span class="badge badge-outline">Binary or large</span>`} <span class="badge badge-outline badge-${tone}">${label}</span></span>
  </summary>
  ${f.diff ? (f.diff.hunks.length ? diffTable(f.diff) : html`<p class="file-note">No net change.</p>`) : html`<p class="file-note">Content not kept (binary or over 2 MB).</p>`}
</details>`;
    })}
    </div>
  </div>
</section>`,
  });
}

export { csrfField };
