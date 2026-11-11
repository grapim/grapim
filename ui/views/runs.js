// Runs: one row per agent run, like a pull request inbox. Defaults to the runs
// that need review; approving or rejecting is instant (optimistic) and the row
// stays in place until you leave the filter, so the list never jumps under you.

import { api } from '../api.js';
import { html, navigate, render, runHref } from '../app.js';
import { agentChip, empty, errorBlock, icon, plusMinus, pluralize, reviewBadge, runTitle, sk, treeBadge, treeText, when } from './shared.js';

const FILTERS = [
  { id: 'pending', label: 'Needs review', test: (r) => r.review.status === 'pending' },
  { id: 'active', label: 'Active', test: (r) => r.active },
  { id: 'approved', label: 'Approved', test: (r) => r.review.status === 'approved' },
  { id: 'rejected', label: 'Rejected', test: (r) => r.review.status === 'rejected' },
  { id: 'all', label: 'All', test: () => true },
];

// Survives navigating to a run and back.
const memory = { selected: null };

export async function mount(el, params, ctx) {
  const s = { runs: null, error: null, filter: params.f || 'pending', keep: new Set(), selected: memory.selected };
  ctx.setTitle('Runs');

  const visible = () => {
    const f = FILTERS.find((x) => x.id === s.filter) || FILTERS[0];
    return (s.runs || []).filter((r) => f.test(r) || s.keep.has(r.run));
  };

  const glyph = (r) => {
    if (r.active) return html`<span class="state-glyph" title="Running now"><span class="ring" aria-hidden="true"></span><span class="sr-only">Running</span></span>`;
    const st = r.review.status;
    return html`<span class="state-glyph ${st}" title="${st === 'pending' ? 'Needs review' : st[0].toUpperCase() + st.slice(1)}">${icon(st === 'approved' ? 'check' : st === 'rejected' ? 'x' : 'dotc', 'sm')}</span>`;
  };

  const row = (r) => html`
    <a class="row" href="${runHref(r.run)}" data-key="run:${r.run}" data-run="${r.run}" aria-selected="${s.selected === r.run}">
      <span class="c-glyph">${glyph(r)}</span>
      <span class="c-agent">${agentChip(r.label, { title: r.run })}</span>
      <span class="c-intent intent" title="${runTitle(r) || ''}">${runTitle(r) || html`<span class="muted">No intent recorded</span>`}</span>
      <span class="c-wt wt dim" title="Worktree ${r.worktree}">${r.worktree}</span>
      <span class="c-turns r num dim" title="${r.turns} turns">${r.turns}</span>
      <span class="c-files r num dim" title="${r.files} files">${r.files}</span>
      <span class="c-pm r">${plusMinus(r.added, r.removed)}</span>
      <span class="c-tree">${treeBadge(r.in_tree)}</span>
      <span class="c-review">${reviewBadge(r.review)}</span>
      <span class="c-time r">${when(r.last_ts)}</span>
      <span class="meta-sm">${agentChip(r.label)}<span>${r.worktree}</span><span class="num">${pluralize(r.turns, 'turn')} · ${pluralize(r.files, 'file')}</span>${plusMinus(r.added, r.removed)}<span>${treeText(r.in_tree)}</span>${reviewBadge(r.review)}</span>
    </a>`;

  function draw() {
    const counts = Object.fromEntries(FILTERS.map((f) => [f.id, (s.runs || []).filter(f.test).length]));
    const head = html`
      <div class="page-head">
        <div><h1 class="page-title">Runs</h1>
          <p class="page-sub">Every agent session that changed a file. Review each like a pull request.</p></div>
      </div>
      <div class="toolbar">
        <nav class="tabs" aria-label="Filter runs">${FILTERS.map((f) => html`
          <a href="#/runs?f=${f.id}" aria-current="${s.filter === f.id}" data-filter="${f.id}">${f.label}${s.runs ? html`<span class="n num">${counts[f.id]}</span>` : ''}</a>`)}
        </nav>
        <div class="hint" aria-hidden="true"><span><kbd>j</kbd><kbd>k</kbd> move</span><span><kbd>Enter</kbd> open</span>${ctx.readonly() ? '' : html`<span><kbd>a</kbd> approve</span><span><kbd>x</kbd> reject</span>`}</div>
      </div>`;
    const header = html`<div class="runs-head" aria-hidden="true">
      <span></span><span>Agent</span><span>Intent</span><span class="c-wt">Worktree</span><span class="r">Turns</span><span class="c-files r">Files</span><span class="r">Lines</span><span>In tree</span><span>Review</span><span class="r">Updated</span></div>`;

    if (s.error && !s.runs) return render(el, html`${head}${errorBlock(s.error)}`);
    if (!s.runs) {
      return render(el, html`${head}<section class="panel runs">${header}${Array.from({ length: 6 }, () => html`
        <div class="row" aria-hidden="true"><span>${sk('12px', 12)}</span><span>${sk('110px')}</span><span>${sk('70%')}</span><span class="c-wt">${sk('70px')}</span><span>${sk('16px')}</span><span class="c-files">${sk('16px')}</span><span>${sk('60px')}</span><span>${sk('60px', 20)}</span><span>${sk('80px', 20)}</span><span>${sk('40px')}</span></div>`)}</section>`);
    }
    if (!s.runs.length) {
      return render(el, html`${head}<section class="panel">${empty('No runs yet',
        html`Run <code>grapim init</code> in your repo, then start a Claude Code session. Every session that edits a file shows up here.`,
        'grapim init')}</section>`);
    }
    const list = visible();
    const none = {
      pending: ['Nothing needs review', 'Every run has been approved or rejected. New runs appear here as soon as an agent changes a file.'],
      active: ['No run is active', 'Runs from agents that are working right now show up here.'],
      approved: ['No approved runs', ctx.readonly() ? 'Runs show up here once someone approves them.' : 'Approve a run from its page, or press a on a row.'],
      rejected: ['No rejected runs', ctx.readonly() ? 'Runs show up here once someone rejects them.' : 'Reject a run from its page, or press x on a row.'],
      all: ['No runs', ''],
    }[s.filter];
    render(el, html`${head}
      ${s.error ? html`<div style="margin-bottom:16px">${errorBlock(s.error, { title: 'Couldn’t refresh the list' })}</div>` : ''}
      <section class="panel runs" aria-label="Runs">${list.length ? html`${header}<div role="list">${list.map(row)}</div>` : empty(none[0], none[1])}</section>`);
  }

  async function load() {
    try {
      s.runs = await api.runs();
      s.error = null;
    } catch (e) {
      s.error = e;
    }
    draw();
  }

  function rows() { return [...el.querySelectorAll('.runs .row[data-run]')]; }
  function select(run, focus = true) {
    s.selected = memory.selected = run;
    for (const r of rows()) r.setAttribute('aria-selected', String(r.dataset.run === run));
    el.__html = null; // aria-selected changed outside render
    const target = rows().find((r) => r.dataset.run === run);
    if (focus && target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' }); }
  }
  function move(d) {
    const rs = rows();
    if (!rs.length) return;
    const i = rs.findIndex((r) => r.dataset.run === s.selected);
    const next = rs[Math.max(0, Math.min(rs.length - 1, i < 0 ? 0 : i + d))];
    select(next.dataset.run);
  }

  async function review(run, status) {
    const r = s.runs.find((x) => x.run === run);
    if (!r || ctx.readonly()) return;
    const prev = r.review;
    const nextStatus = prev.status === status ? 'pending' : status;
    r.review = { ...prev, status: nextStatus, at: Date.now() };
    s.keep.add(run);
    draw();
    try {
      r.review = await api.review(run, nextStatus);
      ctx.emit('grapim:run-reviewed', { run, status: r.review?.status || nextStatus });
      ctx.toast(nextStatus === 'pending' ? `${r.label} needs review again.` : `${nextStatus === 'approved' ? 'Approved' : 'Rejected'} ${r.label}.`, {
        action: { label: 'Undo', fn: () => review(run, nextStatus) },
      });
      ctx.refreshShell();
    } catch (e) {
      r.review = prev;
      draw();
      ctx.toast(`Couldn’t save the review: ${e.message}`, { kind: 'error' });
    }
  }

  const onClick = (e) => {
    if (e.target.closest('[data-action="retry"]')) load();
    const row = e.target.closest('.row[data-run]');
    if (row) memory.selected = row.dataset.run;
  };
  const onFocus = (e) => {
    const row = e.target.closest?.('.row[data-run]');
    if (row && row.dataset.run !== s.selected) select(row.dataset.run, false);
  };
  el.addEventListener('click', onClick);
  el.addEventListener('focusin', onFocus);

  draw();
  await load();
  if (s.selected && rows().some((r) => r.dataset.run === s.selected)) select(s.selected, (document.activeElement === el || document.activeElement === document.body) && ctx.mayFocus());

  return {
    refresh: load,
    update(p) {
      const f = p.f || 'pending';
      if (f !== s.filter) { s.filter = f; s.keep.clear(); draw(); }
    },
    destroy() { el.removeEventListener('click', onClick); el.removeEventListener('focusin', onFocus); },
    onKey(e) {
      if (e.key === 'j' || e.key === 'ArrowDown') { move(1); return true; }
      if (e.key === 'k' || e.key === 'ArrowUp') { move(-1); return true; }
      if (e.key === 'Enter' && s.selected && !e.target.closest?.('a,button')) { navigate(runHref(s.selected)); return true; }
      if (!s.selected || !s.runs || ctx.readonly()) return false;
      const r = s.runs.find((x) => x.run === s.selected);
      if (!r) return false;
      if (e.key === 'a') { review(r.run, 'approved'); return true; }
      if (e.key === 'x') { review(r.run, 'rejected'); return true; }
      if (e.key === 'u') { ctx.openUndo(r); return true; }
      if (e.key === 'b') { navigate(runHref(r.run)); return true; }
      return false;
    },
    commands() {
      const r = s.runs?.find((x) => x.run === s.selected);
      if (!r || ctx.readonly()) return [];
      return [
        { label: `Approve ${r.label}`, hint: 'a', run: () => review(r.run, 'approved') },
        { label: `Reject ${r.label}`, hint: 'x', run: () => review(r.run, 'rejected') },
        { label: `Undo ${r.label}…`, hint: 'u', run: () => ctx.openUndo(r) },
      ];
    },
  };
}
