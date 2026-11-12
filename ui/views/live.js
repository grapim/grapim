// Live: who is working right now, what they hold, and what just happened.
// Calm by default: rows only change when the data does, new feed items get
// one soft highlight, times move on their own.

import { api } from '../api.js';
import { fileHref, html, render, runHref } from '../app.js';
import { agentChip, colorOf, empty, errorBlock, exact, icon, IS_CLOUD, isMainWorktree, setupHint, sk, stamp, until, when, worktreeQuery } from './shared.js';

const FRESH_MS = 90_000; // an agent seen in the last 90 s counts as working this moment

export async function mount(el, _params, ctx) {
  const s = { overview: null, events: null, error: null, seenId: null };
  ctx.setTitle('Live');

  const skeleton = () => html`
    <div class="page-head"><div><h1 class="page-title">Live</h1><p class="page-sub">${sk('260px')}</p></div></div>
    <div class="live-grid">
      <div><section class="panel"><ul class="agent-list">${[0, 1, 2, 3].map(() => html`
        <li style="--c:var(--surface-3)"><span class="bar"></span><div>${sk('160px', 14)}<div style="margin-top:8px">${sk('70%')}</div><div style="margin-top:12px">${sk('180px', 20)}</div></div><div>${sk('48px')}</div></li>`)}</ul></section></div>
      <section class="panel feed"><div class="section-head panel-head"><h2 class="section-title">Activity</h2></div>
        <ol class="feed-list">${Array.from({ length: 8 }, () => html`<li class="feed-item"><span>${sk('48px')}</span><span>${sk('90%')}</span></li>`)}</ol></section>
    </div>`;

  const fileLink = (ov, wt, p) => {
    const q = worktreeQuery(ov, wt);
    if (q === null) return html`<span class="chip" title="In worktree ${wt}">${p}</span>`;
    return html`<a class="chip" href="${fileHref(p, q)}" title="Open ${p}${q ? ` in worktree ${wt}` : ''}">${p}</a>`;
  };

  function agents(ov) {
    if (!ov.agents.length) {
      const h = setupHint('Agents show up here the moment they start.');
      return html`<section class="panel">${empty('No agents are working right now', h.body, h.cmd)}</section>`;
    }
    const list = [...ov.agents].sort((a, b) => b.last_seen - a.last_seen);
    return html`
      <section class="panel" aria-labelledby="agents-h">
        <div class="section-head panel-head"><h2 class="section-title" id="agents-h">Agents <span class="num">${list.length}</span></h2></div>
        <ul class="agent-list">${list.map((a) => {
          const fresh = Date.now() - a.last_seen < FRESH_MS;
          return html`
          <li style="--c:${colorOf(a.label)}" data-agent="${a.agent}">
            <span class="bar"></span>
            <div style="min-width:0">
              <div class="who">${agentChip(a.label)}${ctx.multiWorktree() ? html`<span class="tag" title="Worktree">${icon('worktree', 'sm')}${a.worktree}</span>` : ''}</div>
              <p class="doing">${a.intent || html`<span class="muted">No intent recorded yet</span>`}</p>
              ${a.files.length ? html`<div class="chips" aria-label="Files held">${a.files.map((p) => fileLink(ov, a.worktree, p))}</div>` : html`<p class="muted holds-none">Holds no files</p>`}
            </div>
            <div class="seen">
              <span class="with-dot"><span class="live-dot ${fresh ? '' : 'idle'}" aria-hidden="true"></span>${fresh ? 'active' : 'seen'} ${when(a.last_seen)}</span>
              ${ctx.shell.runs?.some((r) => r.run === a.agent) ? html`<a href="${runHref(a.agent)}">View run</a>` : html`<span>No changes yet</span>`}
            </div>
          </li>`;
        })}</ul>
      </section>`;
  }

  function leases(ov) {
    if (!ov.leases.length) return '';
    const rows = [...ov.leases].sort((a, b) => a.acquired_at - b.acquired_at);
    const wt = ctx.multiWorktree();
    return html`
      <section class="panel" aria-labelledby="held-h">
        <div class="section-head panel-head"><h2 class="section-title" id="held-h">Files held <span class="num">${rows.length}</span></h2>
          <span class="section-note">A held file can only be written by its holder.</span></div>
        <div style="overflow-x:auto"><table class="table">
          <thead><tr><th>File</th><th>Held by</th>${wt ? html`<th class="hide-sm">Worktree</th>` : ''}<th class="r hide-sm">Since</th><th class="r hide-sm">Expires</th></tr></thead>
          <tbody>${rows.map((l) => html`<tr>
            <td class="mono">${worktreeQuery(ov, l.worktree) !== null ? html`<a href="${fileHref(l.path, worktreeQuery(ov, l.worktree))}">${l.path}</a>` : l.path}</td>
            <td>${agentChip(l.label)}</td>
            ${wt ? html`<td class="hide-sm dim">${l.worktree}</td>` : ''}
            <td class="r hide-sm muted">${when(l.acquired_at)}</td>
            <td class="r hide-sm muted"><span title="${exact(l.expires_at)}">${until(l.expires_at)}</span></td>
          </tr>`)}</tbody>
        </table></div>
      </section>`;
  }

  function line(e, ov) {
    const p = e.path ? (isMainWorktree(ov, agentWorktree(ov, e.agent)) ? html`<a class="path" href="${fileHref(e.path)}">${e.path}</a>` : html`<span class="path">${e.path}</span>`) : '';
    const pm = /^\+(\d+) -(\d+)$/.exec(e.detail || '');
    switch (e.kind) {
      case 'claim': return html`<span class="verb">claimed</span> ${p}`;
      case 'release': return html`<span class="verb">released</span> ${p}`;
      case 'edit': return html`<span class="verb">edited</span> ${p} ${pm ? html`<span class="plusminus"><span class="add">+${pm[1]}</span><span class="del">−${pm[2]}</span></span>` : html`<span class="muted">${e.detail || ''}</span>`}`;
      case 'blocked': return html`<span class="verb">was stopped from editing</span> ${p} <span class="muted">(${e.detail})</span>`;
      case 'intent': return html`<span class="verb">is now working on</span> “${e.detail}”`;
      case 'end': return html`<span class="verb">ended its session</span>`;
      case 'undo': return html`<span class="verb">undid</span> ${p} <span class="muted">(${e.detail})</span>`;
      case 'restore': return html`<span class="verb">restored</span> ${p} <span class="verb">to version</span> <span class="mono">${(e.detail || '').slice(0, 8)}</span>`;
      case 'review': {
        // "approved" or "approved: the note"
        const [status, ...note] = (e.detail || '').split(': ');
        const n = note.length ? html` <span class="muted">“${note.join(': ')}”</span>` : '';
        if (e.actor) return html`<span class="verb">${{ approved: 'approved', rejected: 'rejected', pending: 'marked as needing review' }[status] || `reviewed (${status})`}</span> ${agentChip(e.label)}${n}`;
        return html`<span class="verb">${{ approved: 'was approved', rejected: 'was rejected', pending: 'was marked as needing review' }[status] || `review: ${e.detail}`}</span>${n}`;
      }
      case 'branch':
        if (e.actor) return html`<span class="verb">put</span> ${agentChip(e.label)} <span class="verb">on branch</span> <span class="path">${(e.detail || '').split(' ')[0]}</span>`;
        return html`<span class="verb">was put on branch</span> <span class="path">${(e.detail || '').split(' ')[0]}</span>`;
      default: return html`<span class="verb">${e.kind}</span> ${p} <span class="muted">${e.detail || ''}</span>`;
    }
  }

  function feed(ov, events) {
    const list = [...events].reverse().slice(0, 60);
    const prev = s.seenId;
    return html`
      <section class="panel feed" aria-labelledby="feed-h">
        <div class="section-head panel-head"><h2 class="section-title" id="feed-h">Activity</h2>
          <span class="section-note with-dot">${s.live ? html`<span class="live-dot" aria-hidden="true"></span>` : ''}newest first</span></div>
        ${list.length ? html`<ol class="feed-list" aria-live="off">${list.map((e) => html`
          <li class="feed-item ${e.kind} ${prev !== null && e.id > prev ? 'new' : ''}">
            <time datetime="${new Date(e.ts).toISOString()}" title="${exact(e.ts)}">${stamp(e.ts)}</time>
            <p class="what">${actor(e)} ${line(e, ov)}</p>
          </li>`)}</ol>` : empty('Nothing has happened yet', 'Claims, edits, blocks and undos appear here as they happen.', IS_CLOUD ? '' : 'grapim status --watch')}
      </section>`;
  }

  function draw() {
    if (s.error && !s.overview) return render(el, html`<div class="page-head"><h1 class="page-title">Live</h1></div>${errorBlock(s.error)}`);
    if (!s.overview) return render(el, skeleton());
    const ov = s.overview;
    render(el, html`
      <div class="page-head">
        <div>
          <h1 class="page-title">Live</h1>
          <p class="page-sub stats">
            <span><b>${ov.counts.agents}</b>${ov.counts.agents === 1 ? 'agent' : 'agents'} working</span>
            <span><b>${ov.counts.leases}</b>${ov.counts.leases === 1 ? 'file' : 'files'} held</span>
            <span><a href="#/runs"><b>${ov.counts.unreviewed}</b>${ov.counts.unreviewed === 1 ? 'run needs' : 'runs need'} review</a></span>
          </p>
        </div>
      </div>
      ${s.error ? html`<div class="stack-gap">${errorBlock(s.error, { title: 'Live updates paused' })}</div>` : ''}
      <div class="live-grid">
        <div>${agents(ov)}${leases(ov)}</div>
        ${feed(ov, s.events || [])}
      </div>`);
    s.seenId = Math.max(s.seenId ?? 0, ...(s.events || []).map((e) => e.id));
  }

  async function load() {
    try {
      const [ov, events] = await Promise.all([api.overview(), api.events(0, 100)]);
      s.overview = ov;
      s.events = events;
      s.error = null;
      s.live = true;
    } catch (e) {
      s.error = e;
    }
    draw();
  }

  el.addEventListener('click', onClick);
  function onClick(e) { if (e.target.closest('[data-action="retry"]')) load(); }

  draw();
  await load();
  return {
    refresh: load,
    destroy() { el.removeEventListener('click', onClick); },
  };
}

// Who the line is about. Reviews and branches with an actor read "alex
// approved claude 1a2b…": the actor first, the run after the verb. A person
// (human:<name>) is shown by name; agents by their coloured label.
function actor(e) {
  const acted = (e.kind === 'review' || e.kind === 'branch') && e.actor;
  const id = String((acted ? e.actor : e.agent) || '');
  if (id.startsWith('human:')) return html`<b>${id.slice(6)}</b>`;
  if (!acted) return agentChip(e.label);
  return agentChip(id.startsWith('http:') ? id.slice(5) : id);
}
const agentWorktree = (ov, agent) => ov.agents.find((a) => a.agent === agent)?.worktree;
