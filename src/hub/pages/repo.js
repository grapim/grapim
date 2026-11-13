// One synced repo: who is active, and every run with its hub review state;
// and one run, reviewed like a pull request: a sticky header with its review
// state and Approve / Reject, its turns, and its net diff per file. The same
// data as the JSON API, server rendered, styled like the review desk's run view.

import { pullUrl } from '../overview.js';
import { csrfField, layout } from './layout.js';
import { html, time } from './html.js';
import { icon } from './icons.js';
import { agent, delta, phoneMeta, plural, reviewBadge } from './parts.js';
import { kindOf } from '../reports/notes.js';

// Whether a run's lines are still in the code: plain text with a dot, not a
// badge, so the review state stays the one thing that stands out in a row.
const IN_TREE = { all: ['In the code', 'ok'], some: ['Partly in the code', 'warn'], none: ['No longer in the code', 'muted'] };

function treeBadge(v) {
  const [label, tone] = IN_TREE[v] ?? ['Unknown', 'muted'];
  return html`<span class="tree tree-${tone}"><span class="tree-dot" aria-hidden="true"></span>${label}</span>`;
}

// review: Map(run -> { status, stale, ... }) from the hub's reviews, or empty.
const statusOf = (h) => (!h ? 'pending' : h.stale ? 'stale' : h.status);

// Previous / Next under a long table. page: { n, pages, size, total }.
function pager(base, page) {
  if (!page || page.pages <= 1) return '';
  const first = (page.n - 1) * page.size + 1;
  const last = Math.min(page.total, page.n * page.size);
  const link = (n, label) => (n >= 1 && n <= page.pages ? html`<a class="btn btn-sm" href="${`${base}?page=${n}`}" rel="${n < page.n ? 'prev' : 'next'}">${label}</a>` : html`<span class="btn btn-sm" aria-disabled="true">${label}</span>`);
  return html`<nav class="pager" aria-label="Pages">
  <span class="num">${first.toLocaleString('en-US')}–${last.toLocaleString('en-US')} of ${page.total.toLocaleString('en-US')} runs</span>
  <span class="pager-links">${link(page.n - 1, 'Previous')}${link(page.n + 1, 'Next')}</span>
</nav>`;
}

export function repoPage({ user, csrf, team, repo, overview, runs, reviews = new Map(), page = null }) {
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
    <h1>${repo.name}</h1>
    <p class="page-sub">${plural(overview.counts.runs, 'agent run')} · ${overview.counts.agents ? `${plural(overview.counts.agents, 'agent')} working now` : 'no agent working now'}</p>
  </div>
</header>
${overview.agents.length
  ? html`<section class="panel" aria-labelledby="active-title">
  <div class="panel-head"><h2 id="active-title" class="panel-title">Working now <span class="num muted">${overview.agents.length}</span></h2></div>
  <ul class="plain-list">
  ${overview.agents.map(
    (a) => html`<li class="plain-row"><span class="live" aria-hidden="true"></span><span class="plain-main">${agent(a.label, kindOf(a.agent))}<span class="muted small truncate" title="${a.intent || ''}">${a.intent || ''}</span></span><span class="muted small hide-sm">${a.machine}${a.worktree ? ` · ${a.worktree}` : ''}</span>${time(a.last_seen)}</li>`,
  )}
  </ul>
</section>`
  : ''}
${runs.length
  ? html`<div class="table-wrap">
<table class="table">
  <caption class="sr-only">Agent runs in ${repo.name}, newest first</caption>
  <thead><tr><th scope="col">Run</th><th scope="col" class="hide-sm">Computer</th><th scope="col" class="num hide-sm">Files</th><th scope="col" class="num hide-sm">Lines</th><th scope="col" class="hide-sm">Still in code</th><th scope="col" class="hide-sm">Review</th><th scope="col">Last change</th></tr></thead>
  <tbody>
  ${runs.map(
    (r) => html`<tr>
    <th scope="row" class="cell-run"><a class="run-link" href="${`${base}/runs/${encodeURIComponent(r.run)}?machine=${encodeURIComponent(r.machine)}`}" title="${r.intent || r.label}"><span class="run-intent">${r.intent || r.label}</span></a><span class="run-sub">${agent(r.label, kindOf(r.run))}${r.active ? html`<span class="live" title="Active" aria-label="active"></span>` : ''}${phoneMeta(delta(r.added, r.removed), reviewBadge(statusOf(reviews.get(r.run))))}</span></th>
    <td class="hide-sm">${r.machine}${r.worktree ? html`<span class="muted"> · ${r.worktree}</span>` : ''}</td>
    <td class="num hide-sm">${r.files}</td>
    <td class="num hide-sm">${delta(r.added, r.removed)}</td>
    <td class="hide-sm">${treeBadge(r.in_tree)}</td>
    <td class="hide-sm">${reviewBadge(statusOf(reviews.get(r.run)))}</td>
    <td>${time(r.last_ts)}</td>
  </tr>`,
  )}
  </tbody>
</table>
</div>
${pager(base, page)}`
  : html`<div class="empty"><p class="empty-title">No agent runs yet</p><p class="muted">Agent work in this repo shows up here once a teammate’s computer sends it.</p></div>`}`,
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

const STATE = { in_tree: ['In the code', 'ok'], partial: ['Partly in the code', 'warn'], gone: ['No longer in the code', 'muted'] };
const fileId = (p) => `file-${p.replace(/[^a-zA-Z0-9]+/g, '-')}`;

// The hub review of a run (docs/provenance.md section 6): the only approval
// the require_review policy counts. review: from hub.github.reviewPanel.
function reviewState(review) {
  const h = review.hub;
  if (h && h.status === 'approved' && !h.stale && review.rules && !review.rules.ok) return 'pending';
  return !h ? 'pending' : h.stale ? 'stale' : h.status;
}

function reviewActions({ review, state }) {
  if (review.mine) return html`<span class="muted small">Your run: a teammate reviews it</span>`;
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
    ? html`${h.status === 'approved' ? 'Approved' : 'Rejected'} by <span class="strong">${h.reviewer_login || 'a member'}</span>${h.via === 'github' ? ' from the GitHub check' : ''} ${time(h.reviewed_at)}${h.note ? html`: ${h.note}` : ''}.${h.stale ? ' The agent changed more since then, so it needs a new review.' : ''}`
    : 'Not reviewed yet.'}
  ${review.enforced && !(h && h.status === 'approved' && !h.stale && (!review.rules || review.rules.ok)) ? ' Pull requests that include it fail the Grapim check until it is approved here.' : ''}</p>
  ${review.rulesHtml ?? ''}
  ${review.pulls.length
    ? html`<p class="pulls">${icon('pr')}<span>In pull requests: ${review.pulls.map((p, i) => {
        const url = pullUrl(p);
        return html`${i ? ', ' : ''}${url ? html`<a class="link mono" href="${url}" rel="noopener noreferrer">${p.owner}/${p.name}#${p.number}</a>` : html`<code>${p.owner}/${p.name}#${p.number}</code>`}`;
      })}</span></p>`
    : ''}
  ${review.local && review.local.status !== 'pending' ? html`<p class="fine">${review.local.status === 'approved' ? 'Approved' : 'Rejected'} by ${review.local.login || review.local.machine} on their own computer, with <code>grapim review</code>. That does not count; only a review here does.</p>` : ''}
  <p class="fine">From ${review.owners.length ? `${review.owners.join(', ')}’s computer` : 'an unknown computer'}. Nobody can review their own run.</p>
  ${review.mine
    ? html`<p class="muted small">This is your run, so a teammate has to review it. Nobody else on the team yet? <a class="link" href="/hub/teams/${team.id}/settings/members">Invite a teammate</a>.</p>`
    : html`<form method="post" action="${action}" class="review-form" id="review-form">
    ${csrfField(csrf)}
    <input type="hidden" name="machine" value="${run.machine}">
    <label for="review-note">Note for the team (optional)</label>
    <textarea id="review-note" name="note" maxlength="1000" rows="2"></textarea>
  </form>`}
  </div>
</section>`;
}

// A file whose contents the hub does not keep ("No code storage"): its diff
// read live from GitHub for this view, or where to see it instead.
function notStored(f, r, live) {
  const parts = live?.files?.get(f.path);
  if (parts?.length) {
    return parts.map(
      (p) => html`<p class="file-note">From commit <code>${p.sha.slice(0, 7)}</code>, loaded from GitHub just for this page. The commit can include lines this run did not write.</p>
  ${p.hunks.length ? diffTable(p) : html`<p class="file-note">No change to this file in that commit.</p>`}`,
    );
  }
  return html`<p class="file-note">The code stays on the developer’s computer. Run <code>grapim serve</code> on ${r.machine} to see this diff.</p>`;
}

export function runPage({ user, csrf, team, repo, detail, review = null, live = null }) {
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
  <div class="run-bar-actions">
    <button class="btn btn-ghost ask-run" type="button" hidden data-agent-ask="Summarize this run: what it changed and why, whether its lines are still in the tree, and anything a reviewer should check before approving.">${icon('spark')}Ask about this run</button>
    ${review ? html`<span class="run-bar-review" role="group" aria-label="Review">${reviewActions({ review, state })}</span>` : ''}
  </div>
</header>
<div class="run-meta">
  ${agent(r.label, kindOf(r.run))}
  <span>${r.machine}${r.worktree ? ` · ${r.worktree}` : ''}</span>
  <span>${plural(r.turns, 'prompt')}${detail.turns.length && detail.turns.length < r.turns ? `, ${detail.turns.length} with edits` : ''}</span>
  <span>${plural(r.files, 'file')} ${delta(r.added, r.removed)}</span>
  <span>last edit ${time(r.last_ts)}</span>
  ${treeBadge(r.in_tree)}
  ${r.active ? html`<span class="run-live"><span class="live" aria-hidden="true"></span>Working now</span>` : ''}
</div>
<p class="fine run-undo">A run is one agent session. Grapim never changes your code; to undo this run, use <code>grapim undo ${r.run.split(':').pop().slice(0, 8)}</code> on ${r.machine}.</p>
${review ? reviewPanel({ csrf, team, repo, run: r, review }) : ''}
${detail.turns.length
  ? html`<section aria-labelledby="turns-title">
  <h2 id="turns-title" class="section-title">Prompts <span class="num muted">${detail.turns.length}</span></h2>
  <ol class="panel turns" aria-label="Prompts">
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
      const [label, tone] = STATE[f.state] ?? ['Unknown', 'muted'];
      return html`<details class="file panel" id="${fileId(f.path)}" open>
  <summary class="file-head">
    ${icon('chev', 'chev')}
    <span class="file-path" title="${f.path}">${f.path}</span>
    <span class="file-meta">${f.diff || f.content === 'not_stored' ? delta(f.added, f.removed) : html`<span class="muted small">Binary or large</span>`} <span class="tree tree-${tone}"><span class="tree-dot" aria-hidden="true"></span>${label}</span></span>
  </summary>
  ${f.diff ? (f.diff.hunks.length ? diffTable(f.diff) : html`<p class="file-note">No net change.</p>`) : f.content === 'not_stored' ? notStored(f, r, live) : html`<p class="file-note">Not shown: a binary file, or over 2 MB.</p>`}
</details>`;
    })}
    </div>
  </div>
</section>`,
  });
}

export { csrfField };
