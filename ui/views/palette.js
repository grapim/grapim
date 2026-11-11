// Ctrl/Cmd+K: jump to a view, a run or a file, or run an action. Arrow keys
// move, Enter runs, Esc closes. Files come from one recursive listing
// (tracked and untracked files, .gitignore respected, up to 5000).

import { api } from '../api.js';
import { fileHref, html, navigate, openHelp, render, runHref, setTheme } from '../app.js';
import { agentChip, icon, runTitle } from './shared.js';

let fileCache = null;

async function allFiles() {
  if (fileCache) return fileCache;
  try {
    const r = await api.files('', { recursive: true });
    fileCache = { files: r.files, truncated: r.truncated };
  } catch {
    return { files: [], truncated: false }; // the palette still works without files
  }
  setTimeout(() => (fileCache = null), 60_000);
  return fileCache;
}

// Substring beats subsequence; earlier and shorter matches rank higher.
function score(q, text) {
  if (!q) return 1;
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i >= 0) return 1000 - i - t.length / 100;
  let k = 0, last = -1, gaps = 0;
  for (const c of q) {
    const j = t.indexOf(c, last + 1);
    if (j < 0) return 0;
    if (last >= 0) gaps += j - last - 1;
    last = j;
    k++;
  }
  return 500 - gaps - t.length / 100;
}

export function openPalette(ctx) {
  const s = { q: '', items: [], sel: 0, runs: ctx.shell.runs || [], files: fileCache?.files || [], truncated: !!fileCache?.truncated };

  const base = () => {
    const viewCmds = ctx.current()?.commands?.() || [];
    return [
      ...viewCmds.map((c) => ({ group: 'This page', label: c.label, hint: c.hint, icon: 'right', run: c.run })),
      { group: 'Go to', label: 'Live', hint: 'g l', icon: 'live', run: () => navigate('#/live') },
      { group: 'Go to', label: 'Runs that need review', hint: 'g r', icon: 'runs', run: () => navigate('#/runs?f=pending') },
      { group: 'Go to', label: 'All runs', icon: 'runs', run: () => navigate('#/runs?f=all') },
      { group: 'Go to', label: 'Files', hint: 'g f', icon: 'files', run: () => navigate('#/files') },
      ...s.runs.map((r) => ({ group: 'Runs', label: runTitle(r) || r.label, agent: r.label, sub: r.review?.status === 'pending' ? 'needs review' : r.review?.status, keywords: `${r.label} ${r.run} ${r.worktree}`, icon: 'runs', run: () => navigate(runHref(r.run)) })),
      ...s.files.map((f) => ({ group: 'Files', label: f.path, mono: true, sub: f.held_by ? `held by ${f.held_by}` : '', icon: 'file', run: () => navigate(fileHref(f.path)) })),
      // Embedded, the host sets the theme; the palette only moves inside this workspace.
      ...(ctx.embedded ? [] : [
        { group: 'Actions', label: 'Use the light theme', icon: 'sun', run: () => setTheme('light') },
        { group: 'Actions', label: 'Use the dark theme', icon: 'moon', run: () => setTheme('dark') },
        { group: 'Actions', label: 'Follow the system theme', icon: 'system', run: () => setTheme('system') },
      ]),
      { group: 'Actions', label: 'Show keyboard shortcuts', hint: '?', icon: 'info', run: () => setTimeout(openHelp) },
    ];
  };

  function filter() {
    const q = s.q.trim().toLowerCase();
    const all = base();
    let list = all.map((it) => ({ it, sc: Math.max(score(q, it.label), score(q, it.keywords || '') * 0.9, score(q, it.agent || '') * 0.95) })).filter((x) => x.sc > 0);
    if (q) {
      list.sort((a, b) => b.sc - a.sc);
      // When some results contain the text as typed, loose letter-by-letter matches are noise.
      if (list.some((x) => x.sc >= 900)) list = list.filter((x) => x.sc >= 900 * 0.9);
    }
    // Without a query, keep it short: page actions, views, the first runs, actions.
    if (!q) list = list.filter((x) => x.it.group !== 'Files' && !(x.it.group === 'Runs' && all.filter((i) => i.group === 'Runs').indexOf(x.it) > 5));
    s.items = list.slice(0, 50).map((x) => x.it);
    s.sel = Math.min(s.sel, Math.max(0, s.items.length - 1));
  }

  function listHtml() {
    if (!s.items.length) return html`<p class="palette-empty">Nothing matches “${s.q}”.${s.truncated ? ' Only the first 5000 files are searched.' : ''}</p>`;
    const groups = [];
    s.items.forEach((it, i) => {
      if (!groups.length || groups.at(-1).name !== it.group || s.q) {
        if (!s.q || !groups.length) groups.push({ name: s.q ? 'Results' : it.group, items: [] });
      }
      groups.at(-1).items.push([it, i]);
    });
    return html`${groups.map((g) => html`<div role="group" aria-label="${g.name}"><div class="palette-group" aria-hidden="true">${g.name}</div>${g.items.map(([it, i]) => html`
      <div class="palette-item" role="option" id="pi-${i}" data-i="${i}" aria-selected="${i === s.sel}">
        ${icon(it.icon)}
        <span class="main-l ${it.mono ? 'mono' : ''}">${it.label}</span>
        ${it.agent ? agentChip(it.agent) : ''}
        ${it.sub ? html`<span class="sub">${it.sub}</span>` : ''}
        ${it.hint ? html`<span>${it.hint.split(' ').map((k) => html`<kbd>${k}</kbd>`)}</span>` : ''}
      </div>`)}</div>`)}`;
  }

  const d = ctx.openDialog(html`
    <div class="dlg">
      <div class="palette-input">${icon('search')}
        <input id="palette-q" type="text" role="combobox" aria-expanded="true" placeholder="Jump to a run, a file or a page, or run an action…" autocomplete="off" spellcheck="false"
          aria-label="Search" aria-controls="palette-list" aria-autocomplete="list">
        <kbd>Esc</kbd></div>
      <div class="palette-list" id="palette-list" role="listbox" aria-label="Results"></div>
      <div class="palette-foot" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
    </div>`, { className: 'palette', label: 'Command palette' });

  const input = d.querySelector('#palette-q');
  const listEl = d.querySelector('#palette-list');
  function draw() {
    filter();
    listEl.__html = null;
    render(listEl, listHtml());
    input.setAttribute('aria-activedescendant', s.items.length ? `pi-${s.sel}` : '');
    listEl.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }
  function choose(i) {
    const it = s.items[i];
    if (!it) return;
    d.close();
    it.run();
  }
  input.addEventListener('input', () => { s.q = input.value; s.sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); s.sel = (s.sel + 1) % Math.max(1, s.items.length); draw(); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); s.sel = (s.sel - 1 + s.items.length) % Math.max(1, s.items.length); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(s.sel); }
  });
  listEl.addEventListener('click', (e) => { const it = e.target.closest('[data-i]'); if (it) choose(Number(it.dataset.i)); });
  listEl.addEventListener('mousemove', (e) => {
    const it = e.target.closest('[data-i]');
    if (it && Number(it.dataset.i) !== s.sel) { s.sel = Number(it.dataset.i); for (const x of listEl.querySelectorAll('[data-i]')) x.setAttribute('aria-selected', String(Number(x.dataset.i) === s.sel)); input.setAttribute('aria-activedescendant', `pi-${s.sel}`); }
  });
  draw();
  input.focus();
  allFiles().then((r) => { s.files = r.files; s.truncated = r.truncated; if (d.open) draw(); });
  if (!s.runs.length) api.runs().then((r) => { s.runs = r; if (d.open) draw(); }).catch(() => {});
}
