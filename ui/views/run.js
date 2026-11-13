// One run, reviewed like a pull request: what it was asked to do, its turns,
// and every file it changed. Approve and reject are one key and instantly
// reversible; undo always goes through the plan dialog.

import { api } from '../api.js';
import { fileHref, html, navigate, render } from '../app.js';
import { renderDiff } from './diff.js';
import { agentChip, empty, errorBlock, icon, isMainWorktree, plusMinus, reviewBadge, runTitle, sk, treeBadge, when } from './shared.js';

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export async function mount(el, params, ctx) {
  const s = {
    id: params.id, data: null, error: null, busy: null,
    mode: store.get('grapim.diffMode', 'unified'),
    collapsed: new Set(), viewed: new Set(store.get(`grapim.viewed.${params.id}`, [])),
  };
  ctx.setTitle('Run');

  // "Viewed" is keyed by the file's diff size, so a file that changes again is unmarked (like GitHub).
  const viewKey = (f) => `${f.path}|${f.added ?? '?'}|${f.removed ?? '?'}`;
  const saveViewed = () => store.set(`grapim.viewed.${s.id}`, [...s.viewed]);
  const fileId = (p) => `file-${p.replace(/[^a-zA-Z0-9]+/g, '-')}`;

  function header(d) {
    const r = d.run;
    const st = r.review?.status || 'pending';
    return html`
      <nav class="crumbs" aria-label="Breadcrumb"><a href="#/runs">Runs</a><span class="sep" aria-hidden="true">/</span><span>${r.label}</span></nav>
      <div class="run-head">
        <div style="min-width:0">
          <h1 class="run-title">${runTitle(r) || html`<span class="muted">No intent recorded</span>`}</h1>
          <div class="run-meta">
            ${agentChip(r.label, { title: r.run })}
            ${ctx.multiWorktree() ? html`<span class="tag" title="Worktree">${icon('worktree', 'sm')}${r.worktree}</span>` : ''}
            <span>Started ${when(r.first_ts)}</span>
            <span>Last change ${when(r.last_ts)}</span>
            ${r.active ? html`<span class="badge pending"><span class="live-dot" aria-hidden="true"></span> Active</span>` : ''}
            ${treeBadge(r.in_tree)}
            ${reviewBadge(r.review)}
            ${r.branch ? html`<button class="badge outline" type="button" data-copy="${r.branch}" title="Copy branch name">${icon('branch')}<span class="mono">${r.branch}</span></button>` : ''}
          </div>
          ${r.review?.note || (st !== 'pending' && r.review?.by) ? html`<p class="note">${(r.review.by || '').replace(/^\w+:/, '') || 'Someone'} ${st} this ${when(r.review.at)}${r.review.note ? html`: “${r.review.note}”` : '.'}</p>` : ''}
        </div>
        ${ctx.readonly() ? '' : html`<div class="actions" role="group" aria-label="Review">
          <button class="btn approve ${st === 'approved' ? '' : 'primary'}" type="button" data-act="approved" aria-pressed="${st === 'approved'}" title="${st === 'approved' ? 'Approved. Click to mark as needing review again.' : 'Mark as approved. Merging stays your call in git.'}">${icon('check')}${st === 'approved' ? 'Approved' : 'Approve'}<kbd>a</kbd></button>
          <button class="btn reject" type="button" data-act="rejected" aria-pressed="${st === 'rejected'}" title="${st === 'rejected' ? 'Rejected. Click to mark as needing review again.' : 'Mark as rejected. Its changes stay until you undo them.'}">${icon('x')}${st === 'rejected' ? 'Rejected' : 'Reject'}<kbd>x</kbd></button>
          <button class="btn" type="button" data-act="branch" ${s.busy === 'branch' ? 'disabled' : ''} title="Put this run's changes on a new branch from HEAD. No working tree changes.">${icon('branch')}${s.busy === 'branch' ? 'Creating…' : r.branch ? 'New branch' : 'Create branch'}<kbd>b</kbd></button>
          <button class="btn danger" type="button" data-act="undo" title="Remove this run's changes from the working tree. Shows the plan first.">${icon('undo')}Undo…<kbd>u</kbd></button>
        </div>`}
      </div>
      ${r.active ? html`<div class="notice">${icon('info')}<span>${r.label} is still working. It may change more files after you review; new changes show up here as they land.</span></div>` : ''}
      ${st === 'rejected' && r.in_tree !== 'none' ? html`<div class="notice warn">${icon('alert')}<span>Rejected, but its changes are still in the working tree. Rejecting only marks the run.${ctx.readonly() ? '' : html` <button class="btn sm" type="button" data-act="undo" style="margin-left:4px">Undo its changes…</button>`}</span></div>` : ''}`;
  }

  function turns(d) {
    if (!d.turns?.length) return '';
    const main = isMainWorktree(ctx.shell.overview, d.run.worktree);
    return html`
      <section aria-labelledby="turns-h" style="margin-top:8px">
        <div class="section-head"><h2 class="section-title" id="turns-h">Turns <span class="num">${d.turns.length}</span></h2>
          <span class="section-note">Each prompt the agent got that changed files.</span></div>
        <ol class="panel turns">${d.turns.map((t) => html`
          <li>
            <span class="turn-n" aria-label="${t.turn ? `Turn ${t.turn}` : 'The undo'}">${t.turn || icon('undo', 'sm')}</span>
            <div class="turn-body">
              ${t.intent ? html`<p class="turn-intent">${t.intent}</p>` : html`<p class="muted">${t.turn === 0 ? 'The undo, recorded as its own run' : 'No prompt recorded'}</p>`}
              <div class="chips">${(t.files || []).map((p) => html`<a class="chip" href="#${fileId(p)}" data-jump="${fileId(p)}" title="Jump to ${p}">${p}</a>`)}</div>
            </div>
            <div class="turn-side">${when(t.ts)}
              ${d.turns.length > 1 && !ctx.readonly() ? html`<button class="btn ghost sm" type="button" data-undo-turn="${t.turn}" title="Undo only what turn ${t.turn} changed">Undo turn…</button>` : ''}
            </div>
          </li>`)}
        </ol>
        ${main ? '' : html`<p class="section-note after-panel">These files are in the worktree ${d.run.worktree}, so they open here as diffs only.</p>`}
      </section>`;
  }

  function fileBlock(d, f) {
    const collapsed = s.collapsed.has(f.path) || s.viewed.has(viewKey(f));
    const viewed = s.viewed.has(viewKey(f));
    const main = isMainWorktree(ctx.shell.overview, d.run.worktree);
    const stateNote = {
      gone: 'None of these lines are in the working tree any more (undone, or overwritten since).',
      partial: 'Partly in the working tree: later edits by others changed some of these lines.',
    }[f.state];
    const untracked = f.untracked || f.diff === null;
    return html`
      <section class="panel file ${collapsed ? 'collapsed' : ''} ${f.state === 'gone' ? 'gone' : ''}" id="${fileId(f.path)}" data-path="${f.path}">
        <div class="file-head">
          <button class="file-toggle" type="button" aria-expanded="${!collapsed}" data-toggle="${f.path}" data-key="toggle:${f.path}">
            ${icon('chev', 'chev')}<span class="file-path" title="${f.path}"><bdi>${f.path}</bdi></span>
          </button>
          <div class="file-side">
            ${f.state === 'gone' ? html`<span class="badge">Not in tree</span>` : f.state === 'partial' ? html`<span class="badge warn">Partly in tree</span>` : f.state === null && !untracked ? html`<span class="badge outline" title="Grapim can't tell whether these lines are still in the tree.">Unknown</span>` : ''}
            ${untracked ? html`<span class="badge outline">Binary or large</span>` : plusMinus(f.added ?? 0, f.removed ?? 0)}
            ${main ? html`<a class="btn ghost sm" href="${fileHref(f.path)}" title="Open ${f.path} with blame and history">${icon('file', 'sm')}<span class="hide-sm">Open</span></a>` : ''}
            <label class="viewed-box"><input type="checkbox" data-viewed="${f.path}" aria-label="Viewed ${f.path}" ${viewed ? 'checked' : ''}> Viewed</label>
          </div>
        </div>
        ${collapsed ? '' : html`
          ${stateNote ? html`<div class="file-note">${stateNote}</div>` : ''}
          ${f.via ? html`<div class="file-note">Changed by a shell command: <code>${f.via}</code></div>` : ''}
          ${untracked ? html`<div class="file-note">This file is binary or over 2 MB, so Grapim recorded that it changed but not its content. There is no line diff, and undo can't revert it.</div>` : renderDiff(f.diff?.hunks, { mode: s.mode, path: f.path })}`}
      </section>`;
  }

  function files(d) {
    if (!d.files?.length) return html`<section class="panel" style="margin-top:32px">${empty('No file changes recorded', 'This run is listed but none of its edits were recorded.')}</section>`;
    const total = d.files.length;
    const done = d.files.filter((f) => s.viewed.has(viewKey(f))).length;
    const add = d.files.reduce((n, f) => n + (f.added ?? 0), 0);
    const del = d.files.reduce((n, f) => n + (f.removed ?? 0), 0);
    return html`
      <div class="section-head" style="margin-top:32px">
        <h2 class="section-title">Files changed <span class="num">${total}</span> ${plusMinus(add, del)}</h2>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <span class="progress" title="${done} of ${total} files marked viewed"><span class="track"><span class="fill" style="width:${Math.round((done / total) * 100)}%"></span></span><span class="num">${done}/${total} viewed</span></span>
          <div class="seg" role="group" aria-label="Diff layout">
            <button type="button" data-mode="unified" aria-pressed="${s.mode === 'unified'}">Unified</button>
            <button type="button" data-mode="split" aria-pressed="${s.mode === 'split'}">Split</button>
          </div>
        </div>
      </div>
      <div class="changes ${total < 2 ? 'single' : ''}">
        ${total < 2 ? '' : html`<nav class="ftree panel" aria-label="Changed files" style="padding:4px">${d.files.map((f) => html`
          <a href="#${fileId(f.path)}" data-jump="${fileId(f.path)}" class="${s.viewed.has(viewKey(f)) ? 'viewed' : ''}" title="${f.path}">
            ${icon(s.viewed.has(viewKey(f)) ? 'check' : 'file')}<span class="p"><bdi>${f.path}</bdi></span>${f.added === null ? '' : html`<span class="plusminus"><span class="add">+${f.added}</span></span>`}</a>`)}</nav>`}
        <div style="min-width:0">${d.files.map((f) => fileBlock(d, f))}</div>
      </div>`;
  }

  function draw() {
    if (s.error && !s.data) {
      return render(el, html`<nav class="crumbs"><a href="#/runs">Runs</a></nav>${errorBlock(s.error, { title: s.error.code === 'not_found' ? 'No such run' : 'This run didn’t load', retry: s.error.code !== 'not_found' })}
        ${s.error.code === 'not_found' ? html`<p style="margin-top:16px"><a class="btn" href="#/runs">${icon('back')}Back to runs</a></p>` : ''}`);
    }
    if (!s.data) {
      return render(el, html`<nav class="crumbs"><a href="#/runs">Runs</a></nav>
        <div class="run-head"><div>${sk('60%', 24)}<div style="margin-top:12px">${sk('380px')}</div></div>${ctx.readonly() ? '' : html`<div class="actions">${sk('96px', 32)}${sk('84px', 32)}${sk('120px', 32)}${sk('80px', 32)}</div>`}</div>
        <div class="panel" style="padding:16px">${sk('50%')}<div style="margin-top:12px">${sk('40%')}</div></div>
        <div class="panel" style="margin-top:32px;height:240px"></div>`);
    }
    ctx.setTitle(s.data.run.label, 'Run');
    render(el, html`${header(s.data)}${s.error ? html`<div class="stack-gap">${errorBlock(s.error, { title: 'Couldn’t refresh this run' })}</div>` : ''}${turns(s.data)}${files(s.data)}`);
  }

  let opened = false;
  async function load() {
    try {
      const d = await api.run(s.id);
      // Keep an optimistic review until the server agrees.
      if (s.pendingReview && d.run.review?.status !== s.pendingReview) d.run.review = { ...d.run.review, status: s.pendingReview };
      s.data = d;
      s.error = null;
      if (!opened) { opened = true; ctx.emit('grapim:run-opened', { run: d.run.run, label: d.run.label }); }
    } catch (e) {
      s.error = e;
    }
    draw();
  }

  async function review(status) {
    const r = s.data?.run;
    if (!r || ctx.readonly()) return;
    const prev = r.review;
    const next = prev?.status === status ? 'pending' : status;
    r.review = { status: next, note: prev?.note ?? null, at: Date.now(), by: prev?.by ?? null };
    s.pendingReview = next;
    draw();
    try {
      r.review = await api.review(r.run, next);
      s.pendingReview = null;
      draw();
      ctx.emit('grapim:run-reviewed', { run: r.run, status: r.review?.status || next });
      ctx.toast(next === 'pending' ? `${r.label} needs review again.` : `${next === 'approved' ? 'Approved' : 'Rejected'} ${r.label}.`, {
        action: { label: 'Undo', fn: () => review(next) },
      });
      ctx.refreshShell();
    } catch (e) {
      s.pendingReview = null;
      r.review = prev;
      draw();
      ctx.toast(`Couldn’t save the review. ${e.message}`, { kind: 'error' });
    }
  }

  async function branch() {
    const r = s.data?.run;
    if (!r || s.busy || ctx.readonly()) return;
    s.busy = 'branch';
    draw();
    try {
      const b = await api.branch(r.run);
      r.branch = b.branch;
      const left = (b.files || []).filter((f) => f.status === 'conflict');
      ctx.toast(left.length
        ? `Created ${b.branch} at ${b.commit.slice(0, 7)}. Left out ${left.length}: ${left.map((f) => `${f.path}${f.reason ? ` (${f.reason})` : ''}`).join('; ')}.`
        : `Created ${b.branch} at ${b.commit.slice(0, 7)} with ${(b.files || []).length} file${(b.files || []).length === 1 ? '' : 's'}.`, {
        timeout: left.length ? 12000 : 6000,
        action: { label: 'Copy name', fn: () => copy(b.branch) },
      });
    } catch (e) {
      ctx.toast(e.code === 'conflict' ? e.message : `Couldn’t create the branch. ${e.message}`, { kind: 'error', timeout: 12000 });
    } finally {
      s.busy = null;
      draw();
      load();
    }
  }

  function copy(text) {
    navigator.clipboard?.writeText(text).then(() => ctx.toast(`Copied ${text}`), () => ctx.toast('Couldn’t copy. Select the text and copy it by hand.', { kind: 'error' }));
  }

  async function undo(turn = null) {
    if (!s.data) return;
    const done = await ctx.openUndo(s.data.run, turn);
    if (done) load();
  }

  function onClick(e) {
    const t = e.target;
    if (t.closest('[data-action="retry"]')) return load();
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'approved' || act === 'rejected') return review(act);
    if (act === 'branch') return branch();
    if (act === 'undo') return undo();
    const ut = t.closest('[data-undo-turn]');
    if (ut) return undo(Number(ut.dataset.undoTurn));
    const c = t.closest('[data-copy]');
    if (c) return copy(c.dataset.copy);
    const m = t.closest('[data-mode]');
    if (m) { s.mode = m.dataset.mode; store.set('grapim.diffMode', s.mode); return draw(); }
    const tg = t.closest('[data-toggle]');
    if (tg) {
      const p = tg.dataset.toggle;
      const f = s.data.files.find((x) => x.path === p);
      const isOpen = !(s.collapsed.has(p) || s.viewed.has(viewKey(f)));
      if (isOpen) s.collapsed.add(p);
      else { s.collapsed.delete(p); s.viewed.delete(viewKey(f)); saveViewed(); }
      return draw();
    }
    const j = t.closest('[data-jump]');
    if (j) {
      e.preventDefault();
      const target = document.getElementById(j.dataset.jump);
      const p = target?.dataset.path;
      if (p && s.collapsed.has(p)) { s.collapsed.delete(p); draw(); }
      document.getElementById(j.dataset.jump)?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      document.getElementById(j.dataset.jump)?.querySelector('.file-toggle')?.focus({ preventScroll: true });
    }
  }
  function onChange(e) {
    const v = e.target.closest('[data-viewed]');
    if (!v) return;
    const f = s.data.files.find((x) => x.path === v.dataset.viewed);
    if (v.checked) { s.viewed.add(viewKey(f)); s.collapsed.delete(f.path); }
    else s.viewed.delete(viewKey(f));
    saveViewed();
    draw();
    if (v.checked) document.getElementById(fileId(f.path))?.scrollIntoView({ block: 'nearest' });
  }
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);

  draw();
  await load();

  return {
    refresh: load,
    update(p) { if (p.id !== s.id) return false; },
    destroy() { el.removeEventListener('click', onClick); el.removeEventListener('change', onChange); },
    onKey(e) {
      if (!s.data) return false;
      if (!ctx.readonly()) {
        if (e.key === 'a') { review('approved'); return true; }
        if (e.key === 'x') { review('rejected'); return true; }
        if (e.key === 'b') { branch(); return true; }
        if (e.key === 'u') { undo(); return true; }
      }
      if (e.key === 's') { s.mode = s.mode === 'split' ? 'unified' : 'split'; store.set('grapim.diffMode', s.mode); draw(); return true; }
      if (e.key === 'v') {
        const f = s.data.files.find((x) => !s.viewed.has(viewKey(x)));
        if (f) { s.viewed.add(viewKey(f)); saveViewed(); draw(); const n = s.data.files.find((x) => !s.viewed.has(viewKey(x))); if (n) document.getElementById(fileId(n.path))?.scrollIntoView({ block: 'start' }); }
        return true;
      }
      if (e.key === 'Escape') { navigate('#/runs'); return true; }
      if (e.key === 'j' || e.key === 'k') {
        const heads = [...el.querySelectorAll('.file-toggle')];
        const i = heads.indexOf(document.activeElement);
        const n = heads[Math.max(0, Math.min(heads.length - 1, i + (e.key === 'j' ? 1 : -1)))];
        n?.focus();
        n?.closest('.file')?.scrollIntoView({ block: 'start' });
        return true;
      }
      return false;
    },
    commands() {
      const r = s.data?.run;
      if (!r) return [];
      return [
        ...(ctx.readonly() ? [] : [
          { label: r.review?.status === 'approved' ? 'Mark as needing review' : 'Approve this run', hint: 'a', run: () => review('approved') },
          { label: r.review?.status === 'rejected' ? 'Mark as needing review' : 'Reject this run', hint: 'x', run: () => review('rejected') },
          { label: 'Create a branch from this run', hint: 'b', run: branch },
          { label: 'Undo this run…', hint: 'u', run: () => undo() },
        ]),
        { label: s.mode === 'split' ? 'Show unified diffs' : 'Show split diffs', hint: 's', run: () => { s.mode = s.mode === 'split' ? 'unified' : 'split'; store.set('grapim.diffMode', s.mode); draw(); } },
      ];
    },
  };
}
