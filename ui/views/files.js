// Files: the workspace browser. A tree on the left (who last changed each
// file, who holds it now), and for one file its content with every line that
// differs from HEAD coloured by the agent that wrote it, next to its version
// history. Any version can be opened, alone or as the change it made, and
// restored. With more than one worktree, a switcher picks which one to browse.

import { api } from '../api.js';
import { fileHref, html, navigate, raw, render, runHref } from '../app.js';
import { diffTexts, highlight, langOf, renderDiff } from './diff.js';
import { agentChip, ago, colorOf, empty, errorBlock, exact, icon, pluralize, sk, when } from './shared.js';

// Tree state survives moving between files (and is dropped when the worktree changes).
const tree = { open: new Set(['']), dirs: new Map(), errors: new Map(), worktree: null };
try { for (const p of JSON.parse(sessionStorage.getItem('grapim.tree') || '[]')) tree.open.add(p); } catch {}
const saveOpen = () => { try { sessionStorage.setItem('grapim.tree', JSON.stringify([...tree.open])); } catch {} };

const listPath = (dir) => (dir ? `${dir}/` : '');

export async function mount(el, params, ctx) {
  const s = {
    path: params.path || '', version: params.v || null, show: params.show || 'file', pane: 'code',
    worktree: params.wt || null, // null: the worktree the server runs in
    file: null, // { path, text, exists, blame, history, error, versionText }
    filter: null, recent: null,
  };

  // Links inside this view keep the picked worktree.
  const href = (p, q = '') => fileHref(p, [q, s.worktree ? `wt=${encodeURIComponent(s.worktree)}` : ''].filter(Boolean).join('&'));
  const rootHref = () => (s.worktree ? `#/files?wt=${encodeURIComponent(s.worktree)}` : '#/files');
  const wtOpt = () => ({ worktree: s.worktree });
  const worktrees = () => ctx.shell.overview?.worktrees || [];
  const currentWorktree = () => s.worktree || ctx.shell.overview?.worktree || worktrees()[0]?.name || null;
  function syncTree() {
    if (tree.worktree === s.worktree) return;
    tree.worktree = s.worktree;
    tree.dirs.clear();
    tree.errors.clear();
  }

  async function loadDir(dir) {
    const wt = s.worktree;
    try {
      const items = await api.files(listPath(dir), wtOpt());
      if (wt !== s.worktree) return;
      tree.dirs.set(dir, items);
      tree.errors.delete(dir);
    } catch (e) {
      if (wt === s.worktree) tree.errors.set(dir, e);
    }
  }
  async function loadOpenDirs() {
    await Promise.all([...tree.open].map(loadDir));
  }
  // Open every folder above the current file.
  function revealPath(p) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) tree.open.add(parts.slice(0, i).join('/'));
    saveOpen();
  }

  // ---------------------------------------------------------------- tree

  function treeHtml(dir, depth = 0) {
    const items = tree.dirs.get(dir);
    if (tree.errors.has(dir)) return html`<p class="loading muted" style="font-size:12px">Couldn’t list ${dir || 'the root'}: ${tree.errors.get(dir).message}</p>`;
    if (!items) return html`<div class="loading">${sk('60%')}</div>`;
    if (!items.length && depth === 0) return html`<p class="loading muted">This folder is empty.</p>`;
    return html`<ul role="${depth ? 'group' : 'tree'}" aria-label="${depth ? '' : 'Workspace files'}">${items.map((it) => {
      const holder = it.held_by;
      const side = html`<span class="side">${holder ? html`<span class="held-dot" style="--c:${raw(colorOf(holder))}" title="Held by ${holder}"></span>` : ''}${it.last_change ? html`<span title="Last changed by ${it.last_change.label}, ${exact(it.last_change.ts)}" data-ago="${it.last_change.ts}">${ago(it.last_change.ts)}</span>` : ''}</span>`;
      if (it.type === 'dir') {
        const open = tree.open.has(it.path);
        return html`<li role="none"><button class="tree-row dir" type="button" role="treeitem" aria-expanded="${open}" data-dir="${it.path}" data-key="tree:${it.path}">${icon('chev', 'chev')}<span class="name">${it.name}</span>${side}</button>
          ${open ? treeHtml(it.path, depth + 1) : ''}</li>`;
      }
      return html`<li role="none"><a class="tree-row" role="treeitem" href="${href(it.path)}" data-file="${it.path}" data-key="tree:${it.path}" ${s.path === it.path ? raw('aria-current="page"') : ''}>
        <span></span><span class="name" title="${it.path}">${it.name}</span>${side}</a></li>`;
    })}</ul>`;
  }

  // ---------------------------------------------------------------- one file

  // One request for the text and who wrote it (blame with full=1), one for the history.
  async function loadFile() {
    const p = s.path;
    if (!p) return;
    const f = s.file?.path === p ? s.file : { path: p };
    s.file = f;
    try {
      const [blame, history] = await Promise.all([api.blame(p, { full: true, ...wtOpt() }), api.history(p, wtOpt()).catch(() => [])]);
      if (s.path !== p) return;
      const { content = null, ...rest } = blame;
      Object.assign(f, { text: content, exists: blame.exists !== false, blame: rest, history, error: null });
    } catch (e) {
      f.error = e;
    }
    await loadVersion();
  }

  async function loadVersion() {
    const f = s.file;
    if (!f || !s.version) return;
    const h = f.history?.find((x) => x.after_sha === s.version || `id${x.id}` === s.version);
    f.versionError = null;
    try {
      const [after, before] = await Promise.all([
        h?.after_sha ? api.version(h.after_sha) : Promise.resolve(null),
        h?.before_sha ? api.version(h.before_sha) : Promise.resolve(null),
      ]);
      f.versionText = { key: s.version, after, before, entry: h };
    } catch (e) {
      f.versionError = e;
    }
  }

  function heldInfo(p) {
    const wt = currentWorktree();
    return ctx.shell.overview?.leases?.find((l) => l.path === p && (l.worktree === wt || !l.worktree));
  }

  function blameTable(f) {
    const lines = f.text === null || f.text === undefined ? [] : f.text.replace(/\n$/, '').split('\n');
    const by = new Map((f.blame?.lines || []).map((l) => [l.line, l]));
    const lang = langOf(f.path);
    let prev = null;
    const rows = lines.map((text, i) => {
      const a = by.get(i + 1);
      const key = a ? `${a.run}|${a.turn}` : null;
      const start = a && key !== prev;
      prev = key;
      if (!a) return html`<tr class="${s.filter ? '' : ''}"><td class="bar"></td><td class="who"></td><td class="ln">${i + 1}</td><td class="code">${raw(highlight(text, lang) || ' ')}</td></tr>`;
      const outside = a.label === 'outside agents';
      const match = s.filter && (a.run ?? 'outside') === s.filter;
      return html`<tr class="auth ${outside ? 'outside' : ''} ${start ? 'start' : ''} ${match ? 'match' : ''}" style="--c:${raw(colorOf(a.label))}" title="${a.label}${a.turn ? `, turn ${a.turn}` : ''}">
        <td class="bar"></td>
        <td class="who">${start ? html`<i class="dot"></i>${a.label.replace(/^restore .+ ([0-9a-f]{8})$/, 'restore $1')}${a.turn ? html`<span class="t">t${a.turn}</span>` : ''}` : ''}</td>
        <td class="ln">${i + 1}</td><td class="code">${raw(highlight(text, lang) || ' ')}</td></tr>`;
    });
    return html`<div class="blame ${s.filter ? 'filtering' : ''}" tabindex="0" role="region" aria-label="${f.path} with authors"><table><tbody>${rows}</tbody></table></div>`;
  }

  function legend(f) {
    const b = f.blame;
    if (!b || b.error) return html`<div class="legend"><span class="muted">${b?.error ? `Couldn’t load who wrote what: ${b.error.message}` : ''}</span></div>`;
    if (b.untracked) return html`<div class="legend"><span class="muted">Binary or over 2 MB: Grapim knows who changed it (${(b.runs || []).join(', ') || 'nobody'}), not which lines.</span></div>`;
    const counts = new Map();
    for (const l of b.lines) {
      const k = l.run ?? 'outside';
      if (!counts.has(k)) counts.set(k, { label: l.label, n: 0 });
      counts.get(k).n++;
    }
    if (!counts.size) return html`<div class="legend"><span class="muted">Same as ${b.base || 'HEAD'}: no line differs.${b.removed ? ` ${pluralize(b.removed, 'line')} removed.` : ''}</span></div>`;
    return html`<div class="legend" role="group" aria-label="Who wrote the changed lines. Pick one to highlight its lines.">
      ${[...counts].map(([k, v]) => html`<button type="button" data-filter="${k}" aria-pressed="${s.filter === k}">${agentChip(v.label)}<span class="n num">${pluralize(v.n, 'line')}</span></button>`)}
      <span class="muted">${b.lines.length} of ${(f.text || '').replace(/\n$/, '').split('\n').length} lines differ from ${b.base || 'HEAD'}${b.removed ? `, ${b.removed} removed` : ''}</span>
    </div>`;
  }

  function versions(f) {
    const hist = [...(f.history || [])].reverse();
    const cur = !s.version;
    return html`
      <section class="panel history-pane" aria-labelledby="hist-h">
        <div class="section-head" style="padding:12px 12px 0;margin:0"><h2 class="section-title" id="hist-h">${icon('history')} Versions <span class="num">${hist.length + 1}</span></h2></div>
        <ul class="versions" style="margin-top:8px">
          <li><button class="version" type="button" data-version="" aria-current="${cur}" data-key="ver:current">
            <span><b>Working file</b></span><span class="when">now</span>
            <span class="sub">${f.exists === false ? 'Deleted' : 'What is on disk right now'}</span></button></li>
          ${hist.map((h) => html`<li><button class="version" type="button" data-version="${h.after_sha ?? `id${h.id}`}" aria-current="${s.version === (h.after_sha ?? `id${h.id}`)}" data-key="ver:${h.id}">
            <span>${agentChip(h.label)}</span><span class="when"><span title="${exact(h.ts)}" data-ago="${h.ts}">${ago(h.ts)}</span></span>
            <span class="sub">${h.turn ? `turn ${h.turn}` : h.label.startsWith('undo ') ? 'undo' : h.run?.startsWith('restore:') ? 'restored' : ''}${h.after_sha === null ? html`<span class="badge bad">deleted</span>` : h.before_sha === null ? html`<span class="badge ok">created</span>` : ''}${h.added === null ? html`<span>binary</span>` : html`<span class="plusminus"><span class="add">+${h.added}</span><span class="del">−${h.removed}</span></span>`}</span>
          </button></li>`)}
        </ul>
        ${!hist.length ? html`<p class="muted" style="padding:0 12px 12px;font-size:12px">No agent has changed this file since Grapim started recording.</p>` : ''}
      </section>`;
  }

  function versionView(f) {
    const v = f.versionText;
    if (f.versionError) return errorBlock(f.versionError, { title: 'This version didn’t load' });
    if (!v || v.key !== s.version) return html`<div class="panel" style="padding:16px">${sk('40%')}<div style="margin-top:12px">${sk('70%')}</div></div>`;
    const h = v.entry;
    const bar = html`<div class="version-bar">
      <span>${h ? html`After ${agentChip(h.label)}${h.turn ? ` turn ${h.turn}` : ''}, <span title="${exact(h.ts)}">${ago(h.ts)}</span>` : 'An older version'}</span>
      <span class="spacer"></span>
      <div class="seg" role="group" aria-label="Show">
        <button type="button" data-show="file" aria-pressed="${s.show !== 'changes'}">File</button>
        <button type="button" data-show="changes" aria-pressed="${s.show === 'changes'}">Its changes</button>
      </div>
      ${v.after !== null && h?.after_sha && !ctx.readonly() ? html`<button class="btn sm primary" type="button" data-restore="${h.after_sha}">${icon('history', 'sm')}Restore this version</button>` : ''}
      ${h?.run && !h.run.startsWith('undo:') ? html`<a class="btn sm" href="${runHref(h.run)}">Open run</a>` : ''}
      <button class="btn sm" type="button" data-version="">${icon('back', 'sm')}Back to now</button>
    </div>`;
    if (s.show === 'changes') {
      const hunks = diffTexts(v.before ?? '', v.after ?? '');
      return html`<section class="panel" style="overflow:hidden">${bar}${renderDiff(hunks, { path: f.path })}</section>`;
    }
    if (v.after === null) return html`<section class="panel" style="overflow:hidden">${bar}<div class="file-note">This change deleted the file.</div></section>`;
    const lang = langOf(f.path);
    const lines = v.after.replace(/\n$/, '').split('\n');
    return html`<section class="panel" style="overflow:hidden">${bar}<div class="blame" tabindex="0" role="region" aria-label="Version"><table><tbody>${lines.map((t, i) => html`<tr><td class="ln">${i + 1}</td><td class="code">${raw(highlight(t, lang) || ' ')}</td></tr>`)}</tbody></table></div></section>`;
  }

  function fileView() {
    const f = s.file;
    const parts = s.path.split('/');
    const crumbs = html`<nav class="crumbs" aria-label="Path"><a href="${rootHref()}">Files</a>${parts.map((p, i) => html`<span class="sep" aria-hidden="true">/</span>${i === parts.length - 1 ? html`<span>${p}</span>` : html`<span>${p}</span>`}`)}</nav>`;
    if (!f || (f.text === undefined && !f.error)) {
      return html`${crumbs}<div class="page-head"><h1 class="page-title mono" style="font-size:18px">${parts.at(-1)}</h1></div>
        <div class="panel" style="padding:16px">${Array.from({ length: 10 }, (_, i) => html`<div style="margin:6px 0">${sk(`${30 + ((i * 37) % 60)}%`)}</div>`)}</div>`;
    }
    if (f.error) return html`${crumbs}${errorBlock(f.error)}`;
    const held = heldInfo(s.path);
    const hist = f.history || [];
    const last = hist.at(-1);
    const deleted = f.exists === false;
    // On disk, but binary or over 2 MB: the server does not send its text.
    const opaque = !deleted && f.text === null;
    return html`
      ${crumbs}
      <div class="page-head" style="margin-bottom:16px">
        <div style="min-width:0">
          <h1 class="page-title mono" style="font-size:18px;overflow-wrap:anywhere">${parts.at(-1)}</h1>
          <p class="page-sub">
            ${deleted ? html`<span class="badge bad">Deleted</span>` : opaque ? html`<span class="badge">Binary or over 2 MB</span>` : html`<span class="num">${pluralize((f.text || '').replace(/\n$/, '').split('\n').length, 'line')}</span>`}
            ${last ? html`<span>Last changed by ${agentChip(last.label)} ${when(last.ts)}</span>` : html`<span class="muted">No recorded agent changes</span>`}
          </p>
        </div>
      </div>
      ${held ? html`<div class="notice" style="--c:${raw(colorOf(held.label))}">${icon('lock')}<span>Held by ${agentChip(held.label)} since ${when(held.acquired_at)}${held.intent ? html` for “${held.intent}”` : ''}. Other agents are stopped before they write it.</span></div>` : ''}
      <div class="seg pane-tabs" role="group" aria-label="Show">
        <button type="button" data-pane="code" aria-pressed="${s.pane === 'code'}">${s.version ? 'Version' : 'Code'}</button>
        <button type="button" data-pane="history" aria-pressed="${s.pane === 'history'}">History <span class="num muted">${hist.length + 1}</span></button>
      </div>
      <div class="file-grid" data-pane="${s.pane}">
        <div class="code-pane" style="min-width:0">
          ${s.version ? versionView(f) : deleted
            ? html`<section class="panel">${empty('This file is not on disk', f.history?.length ? 'It was deleted after its last recorded change. Its earlier versions are in the history, and any of them can be restored.' : `There is no such file${s.worktree ? ` in the worktree ${s.worktree}` : ''}.`)}</section>`
            : opaque ? html`<section class="panel" style="overflow:hidden">${legend(f)}<div class="file-note">This file is binary or over 2 MB, so its content is not shown here.</div></section>`
            : html`<section class="panel" style="overflow:hidden">${legend(f)}${blameTable(f)}</section>`}
        </div>
        ${versions(f)}
      </div>`;
  }

  function recentView() {
    const evs = s.recent;
    const seen = new Set();
    const items = (evs || []).filter((e) => e.kind === 'edit' && e.path && !seen.has(e.path) && seen.add(e.path)).slice(0, 12);
    return html`
      <div class="page-head"><div><h1 class="page-title">Files</h1><p class="page-sub">The working tree of ${ctx.shell.overview?.repo || 'this repo'}, with who changed and who holds each file.</p></div></div>
      <section class="panel" aria-labelledby="recent-h">
        <div class="section-head" style="padding:12px 16px 0;margin:0"><h2 class="section-title" id="recent-h">Recently edited</h2></div>
        ${!evs ? html`<div style="padding:16px">${sk('50%')}</div>` : items.length ? html`<table class="table"><tbody>${items.map((e) => html`<tr>
          <td class="mono"><a href="${fileHref(e.path)}">${e.path}</a></td><td>${agentChip(e.label)}</td><td class="r muted">${when(e.ts)}</td></tr>`)}</tbody></table>`
          : empty('No agent has edited a file yet', html`Edits show up here once an agent changes a file. Run <code>grapim init</code> in your repo, then start a Claude Code session.`)}
      </section>`;
  }

  // Only when the repo has more than one worktree.
  function switcher() {
    const list = worktrees();
    if (list.length < 2) return '';
    const cur = currentWorktree();
    return html`<div class="wt-switch">
      <label for="wt-select">${icon('worktree', 'sm')}<span>Worktree</span></label>
      <select id="wt-select" data-wt data-key="wt-select">${list.map((w) => html`<option value="${w.name}" ${w.name === cur ? raw('selected') : ''}>${w.name}${w.branch ? ` · ${w.branch}` : ''}</option>`)}</select>
    </div>`;
  }

  function draw() {
    ctx.setTitle(s.path ? s.path.split('/').at(-1) : 'Files', s.worktree);
    const sw = switcher();
    render(el, html`
      ${sw && s.path ? html`<div class="wt-bar">${sw}</div>` : ''}
      <div class="files-grid ${s.path ? 'has-file' : ''}">
        <nav class="tree panel" aria-label="Workspace">${sw && !s.path ? html`<div class="wt-bar in-tree">${sw}</div>` : ''}${treeHtml('')}</nav>
        <div class="file-view">${s.path ? fileView() : recentView()}</div>
      </div>`);
  }

  // Picking a worktree keeps the file open: the same path, in the other checkout.
  function onChange(e) {
    if (!e.target.matches('[data-wt]')) return;
    const name = e.target.value;
    const wt = name === (ctx.shell.overview?.worktree || worktrees()[0]?.name) ? '' : `wt=${encodeURIComponent(name)}`;
    navigate(s.path ? fileHref(s.path, wt) : `#/files${wt ? `?${wt}` : ''}`);
  }

  // ---------------------------------------------------------------- restore

  // Confirm (the diff from the working file to the version), apply, show the result.
  function openRestore(sha) {
    if (ctx.readonly()) return;
    const p = s.path;
    const wt = s.worktree;
    const entry = s.file?.versionText?.entry;
    const short = sha.slice(0, 8);
    const st = { step: 'loading', plan: null, result: null, error: null };
    const d = ctx.openDialog(html``, { className: 'restore', label: `Restore ${p} to version ${short}` });

    function body() {
      if (st.step === 'loading') return html`<div aria-busy="true" aria-label="Working out what changes">${[60, 80, 40, 70].map((w) => html`<div style="margin:8px 0">${sk(`${w}%`)}</div>`)}</div>`;
      if (st.error) {
        return html`<div class="error" role="alert">${icon('alert')}<div><h3>${st.step === 'plan' ? 'Couldn’t work out the restore' : 'The restore didn’t happen'}</h3><p>${st.error.message}</p>
          ${st.error.code === 'busy' || st.error.code === 'offline' || st.error.code === 'conflict' ? html`<button class="btn sm" type="button" data-again>Look again</button>` : ''}</div></div>`;
      }
      const r = st.result;
      if (r) {
        return html`<p>${p} is now version <span class="mono">${short}</span>. Recorded as its own run, so blame and history stay right, and it can be undone like any run.</p>`;
      }
      const plan = st.plan;
      if (plan.action === 'nothing') return html`<p class="muted">The working file already has this content. Nothing to restore.</p>`;
      const hunks = plan.diff?.hunks ?? (s.file?.text !== undefined && s.file?.versionText?.after != null ? diffTexts(s.file.text ?? '', s.file.versionText.after) : null);
      return html`
        ${plan.reason ? html`<div class="notice warn">${icon('alert')}<span>${p} is ${plan.reason}. Restore once it is free.</span></div>` : ''}
        <p class="restore-sum">
          <span class="act ${plan.action === 'create' ? 'restore' : 'revert'}">${plan.action === 'create' ? 'Create' : 'Replace'}</span>
          <span class="mono p">${p}</span>
          ${plan.added === null ? html`<span class="muted">binary</span>` : html`<span class="plusminus"><span class="add">+${plan.added}</span><span class="del">−${plan.removed}</span></span>`}
        </p>
        <p class="muted restore-what">Lines marked − are in the working file now and go away; lines marked + come back from this version.</p>
        ${hunks ? renderDiff(hunks, { path: p }) : html`<div class="file-note">The working file is binary or over 2 MB, so the change can’t be shown line by line.</div>`}`;
    }

    function foot() {
      if (st.step === 'loading') return html`<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" disabled>Restore</button>`;
      if (st.result) {
        return html`${st.result.run ? html`<a class="btn" href="${runHref(st.result.run)}" data-close-nav>Open the restore run</a>` : ''}<button class="btn primary" type="button" data-close>Done</button>`;
      }
      if (st.error || st.plan.action === 'nothing') return html`<button class="btn" type="button" data-close>Close</button>`;
      const blocked = !!st.plan.reason;
      return html`<button class="btn" type="button" data-close>Cancel</button>
        <button class="btn primary" type="button" data-apply ${blocked || st.step === 'applying' ? 'disabled' : ''}>${st.step === 'applying' ? 'Restoring…' : 'Restore this version'}</button>`;
    }

    function drawDlg() {
      render(d, html`<div class="dlg">
        <div class="dlg-head">
          <h2 class="dlg-title" id="dlg-title">${icon('history')} ${st.result ? 'Restored' : 'Restore this version?'}</h2>
          <p class="dlg-lead">${st.result ? '' : html`Puts <span class="mono">${p}</span> back to <span class="mono">${short}</span>${entry ? html`, as it was after ${agentChip(entry.label)}${entry.turn ? ` turn ${entry.turn}` : ''} ${when(entry.ts)}` : ''}. Nothing changes until you confirm.`}</p>
        </div>
        <div class="dlg-body">${body()}</div>
        <div class="dlg-foot">${foot()}</div>
      </div>`);
    }

    async function plan() {
      st.step = 'loading';
      st.error = null;
      drawDlg();
      try {
        st.plan = await api.restore(p, sha, { apply: false, worktree: wt });
      } catch (e) {
        st.error = e;
      }
      st.step = 'plan';
      drawDlg();
      d.querySelector('[data-apply]')?.focus();
    }

    async function apply() {
      if (st.step !== 'plan' || !st.plan || st.plan.reason) return;
      st.step = 'applying';
      drawDlg();
      try {
        st.result = await api.restore(p, sha, { apply: true, expect: st.plan.current_sha, worktree: wt });
        ctx.toast(`Restored ${p.split('/').at(-1)} to ${short}.`);
        ctx.refreshShell();
      } catch (e) {
        st.error = e;
      }
      st.step = 'done';
      drawDlg();
      d.querySelector('.dlg-foot .primary, [data-close]')?.focus();
    }

    d.onclick = (e) => {
      if (e.target.closest('[data-apply]')) apply();
      if (e.target.closest('[data-again]')) { st.result = null; plan(); }
      if (e.target.closest('[data-close-nav]')) { st.leaving = true; d.close(); }
    };
    // After a restore, show the working file (now this version), unless the
    // dialog was left through the link to the restore run.
    const prevClose = d.onclose;
    d.onclose = () => {
      prevClose?.();
      if (st.result && !st.leaving && s.path === p) { s.file = null; navigate(href(p), { replace: true }); refresh(); }
    };
    plan();
  }

  async function loadRecent() {
    try { s.recent = (await api.events(0, 200)).reverse(); } catch { s.recent = []; }
  }

  async function refresh() {
    await Promise.all([loadOpenDirs(), s.path ? loadFile() : loadRecent()]);
    draw();
  }

  function onClick(e) {
    const t = e.target;
    if (t.closest('[data-action="retry"]')) return refresh();
    const dir = t.closest('[data-dir]');
    if (dir) {
      const p = dir.dataset.dir;
      if (tree.open.has(p)) tree.open.delete(p);
      else { tree.open.add(p); if (!tree.dirs.has(p)) loadDir(p).then(draw); }
      saveOpen();
      return draw();
    }
    const v = t.closest('[data-version]');
    if (v) {
      const q = v.dataset.version ? `v=${v.dataset.version}` : '';
      return navigate(href(s.path, q), { replace: true });
    }
    const rs = t.closest('[data-restore]');
    if (rs) return openRestore(rs.dataset.restore);
    const sh = t.closest('[data-show]');
    if (sh) { s.show = sh.dataset.show; return draw(); }
    const pn = t.closest('[data-pane]');
    if (pn && pn.tagName === 'BUTTON') { s.pane = pn.dataset.pane; return draw(); }
    const fl = t.closest('[data-filter]');
    if (fl) { s.filter = s.filter === fl.dataset.filter ? null : fl.dataset.filter; return draw(); }
  }
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);

  if (s.path) revealPath(s.path);
  syncTree();
  draw();
  await refresh();

  return {
    refresh,
    async update(p) {
      const path = p.path || '';
      const wtChanged = (p.wt || null) !== s.worktree;
      const changed = path !== s.path || wtChanged;
      s.path = path;
      s.version = p.v || null;
      s.worktree = p.wt || null;
      if (wtChanged) syncTree();
      if (changed) { s.file = null; s.filter = null; s.show = 'file'; s.pane = 'code'; revealPath(path); window.scrollTo(0, 0); }
      if (s.version && changed === false) s.pane = 'code';
      draw();
      // revealPath may have opened folders that were never listed.
      const unlisted = [...tree.open].filter((d) => !tree.dirs.has(d) && !tree.errors.has(d));
      if (changed) await Promise.all([path ? loadFile() : loadRecent(), wtChanged ? loadOpenDirs() : Promise.all(unlisted.map(loadDir))]);
      else await loadVersion();
      draw();
    },
    destroy() { el.removeEventListener('click', onClick); el.removeEventListener('change', onChange); },
    onKey(e) {
      if (e.key === 'j' || e.key === 'k' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const rows = [...el.querySelectorAll('.tree-row')].filter((r) => r.offsetParent);
        if (!rows.length) return false;
        const i = rows.indexOf(document.activeElement);
        const n = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + (e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1)))];
        n.focus();
        n.scrollIntoView({ block: 'nearest' });
        return true;
      }
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && document.activeElement?.dataset.dir !== undefined) {
        const p = document.activeElement.dataset.dir;
        const open = tree.open.has(p);
        if (e.key === 'ArrowRight' && !open) document.activeElement.click();
        if (e.key === 'ArrowLeft' && open) document.activeElement.click();
        return true;
      }
      if (e.key === 'Escape' && s.version) { navigate(href(s.path), { replace: true }); return true; }
      if (e.key === 'Escape' && s.path) { navigate(rootHref()); return true; }
      return false;
    },
  };
}
