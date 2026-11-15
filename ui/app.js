// The review desk shell: a hash router, a tiny render helper, the sidebar,
// global shortcuts, toasts and the help overlay. Views live in views/*.js and
// export mount(el, params, ctx) → { refresh?, destroy?, onKey?, commands? }.

import { api, CLOUD, conn, init, onStatus, onTick } from './api.js';
import * as embed from './embed.js';
import { ago, icon, registerAgents } from './views/shared.js';

const EMBED = embed.EMBED;

// ---------------------------------------------------------------- render helper

// html`` escapes every interpolated value unless it is already Html (from html
// or raw). Arrays are joined. null and undefined render nothing; booleans
// render as "true"/"false", so aria-expanded="${open}" always has a value.
class Html { constructor(s) { this.s = s; } toString() { return this.s; } }
export function raw(s) { return new Html(String(s)); }
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function flat(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Html) return v.s;
  if (Array.isArray(v)) return v.map(flat).join('');
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]);
}
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += flat(vals[i]) + strings[i + 1];
  return new Html(out);
}
// Replaces el's content only when it changed, and keeps keyboard focus on the
// element with the same data-key, so live refreshes never steal focus.
export function render(el, view) {
  const next = flat(view);
  if (el.__html === next) return false;
  const key = el.contains(document.activeElement) ? document.activeElement?.dataset?.key : null;
  el.__html = next;
  el.innerHTML = next;
  if (key && embed.mayFocus()) el.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  return true;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// ---------------------------------------------------------------- router

const VIEWS = { live: 'Live', runs: 'Runs', run: 'Run', files: 'Files' };

function parse() {
  const h = location.hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = h.split('?');
  const q = Object.fromEntries(new URLSearchParams(query));
  const seg = pathPart.split('/').filter(Boolean);
  if (seg[0] === 'runs' && seg[1]) return { view: 'run', params: { id: decodeURIComponent(seg.slice(1).join('/')), ...q } };
  if (seg[0] === 'runs') return { view: 'runs', params: q };
  if (seg[0] === 'files') return { view: 'files', params: { path: seg.slice(1).map(decodeURIComponent).join('/'), ...q } };
  return { view: 'live', params: q };
}

export function navigate(to, { replace = false } = {}) {
  const target = to.startsWith('#') ? to : `#${to}`;
  if (location.hash === target) return;
  if (replace) history.replaceState(null, '', target), route();
  else location.hash = target;
}
export const runHref = (id) => `#/runs/${encodeURIComponent(id)}`;
export const fileHref = (p, q = '') => `#/files/${p.split('/').map(encodeURIComponent).join('/')}${q ? `?${q}` : ''}`;

let current = null; // { name, view, key }
let routing = 0;

async function route() {
  const r = parse();
  const n = ++routing;
  const viewEl = $('#view');
  const sameView = current?.name === r.view;
  if (sameView && current.view?.update && current.view.update(r.params) !== false) {
    setNav(r.view);
    return;
  }
  current?.view?.destroy?.();
  current = { name: r.view, view: null };
  viewEl.__html = null;
  setNav(r.view);
  try {
    const mod = await import(`./views/${r.view}.js`);
    if (n !== routing) return;
    current.view = await mod.mount(viewEl, r.params, ctx);
  } catch (err) {
    console.error(err);
    if (n !== routing) return;
    render(viewEl, html`<div class="error" role="alert"><div><h3>This page failed to load</h3>
      <p>${err?.message || String(err)}</p><p>${CLOUD
        ? 'Reload the page. If it keeps happening, Grapim may have just been updated: reload once more in a minute.'
        : html`Reload the page. If it keeps happening, the UI files may be out of date: restart <code>grapim serve</code>.`}</p></div></div>`);
  }
  if (!sameView && document.activeElement === document.body && embed.mayFocus()) viewEl.focus({ preventScroll: true });
  if (!sameView) window.scrollTo(0, 0);
}

export function setTitle(...parts) {
  document.title = [...parts.filter(Boolean), shell.overview?.repo, 'Grapim'].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- shell

const shell = { overview: null, runs: null, error: null };

const NAV = [
  { id: 'live', label: 'Live', href: '#/live', icon: 'live', key: 'l' },
  { id: 'runs', label: 'Runs', href: '#/runs', icon: 'runs', key: 'r' },
  { id: 'files', label: 'Files', href: '#/files', icon: 'files', key: 'f' },
];

function setNav(view) {
  const active = view === 'run' ? 'runs' : view;
  for (const a of document.querySelectorAll('.nav a')) {
    if (a.dataset.nav === active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function renderShell() {
  const o = shell.overview;
  const counts = o?.counts;
  const nav = html`${NAV.map((n) => {
    const count = n.id === 'live' ? counts?.agents : n.id === 'runs' ? counts?.unreviewed : null;
    const title = n.id === 'live' ? 'agents active' : n.id === 'runs' ? 'runs need approval' : '';
    return html`<a href="${n.href}" data-nav="${n.id}">${icon(n.icon)}<span class="label">${n.label}</span>${
      count ? html`<span class="count num ${n.id === 'runs' ? 'attention' : ''}" title="${count} ${title}">${count}</span>` : ''
    }<kbd aria-hidden="true">G</kbd><kbd aria-hidden="true">${n.key.toUpperCase()}</kbd></a>`;
  })}`;
  render($('#nav-side'), nav);
  render($('#nav-top'), nav);
  if (EMBED) {
    render($('#nav-embed'), html`${NAV.map((n) => {
      const count = n.id === 'runs' ? counts?.unreviewed : null;
      return html`<a href="${n.href}" data-nav="${n.id}"><span>${n.label}</span>${
        count ? html`<span class="count num" title="${count} runs need approval">${count}</span>` : ''}</a>`;
    })}`);
  }
  setNav(current?.name);

  if (o) {
    const main = o.worktrees?.[0];
    const n = o.worktrees?.length || 1;
    render($('#repo'), html`
      <div class="repo-name" title="${o.repo}">${o.repo}</div>
      <div class="repo-meta">${icon('branch', 'sm')}<span>${main?.branch || 'no branch'}</span>${n > 1 ? html`<span>· ${n} worktrees</span>` : ''}</div>`);
    $('#repo').title = o.root || '';
    $('#repo-inline').textContent = o.repo;
  } else if (shell.error) {
    // The whole message is on hover; the sidebar only says what state it is in.
    render($('#repo'), html`<div class="repo-name">Not connected</div><div class="repo-meta">Couldn’t load this workspace</div>`);
    $('#repo').title = shell.error.message.replace(/`/g, '');
  }

  const theme = getTheme();
  render($('#theme-side'), html`${['system', 'light', 'dark'].map((t) =>
    html`<button type="button" data-theme-set="${t}" aria-pressed="${t === theme}" aria-label="${t[0].toUpperCase() + t.slice(1)} theme" title="${t[0].toUpperCase() + t.slice(1)} theme">${icon(t === 'system' ? 'system' : t === 'light' ? 'sun' : 'moon')}</button>`)}`);
  render($('#theme-top'), icon(theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'system'));
  $('#theme-top').setAttribute('aria-label', `Theme: ${theme}. Change theme`);

  const c = $('#conn');
  c.dataset.state = conn.state;
  const connText = { live: 'Live · updates as agents work', reconnecting: CLOUD ? 'Reconnecting…' : 'Reconnecting to grapim serve…', mock: 'Sample data', connecting: 'Connecting…' }[conn.state] || conn.state;
  c.querySelector('.txt').textContent = connText;
  // On the collapsed rail only the dot shows; its words are on hover.
  c.title = connText;
  // Phone width: the sidebar is hidden, so the top bar carries the dot.
  const ct = $('#conn-top');
  ct.dataset.state = conn.state;
  ct.title = connText;
  ct.querySelector('.txt').textContent = connText;

  // Embedded, the state is one word in the header, and the "run grapim serve"
  // banner is not shown: the host's customers never run the server.
  if (EMBED) {
    const ce = $('#conn-embed');
    const [word, tip] = {
      live: ['Live', 'Updates as agents work'], reconnecting: ['Reconnecting…', 'Lost the live connection; trying again'],
      mock: ['Sample data', 'Showing sample data, not a real workspace'], connecting: ['Connecting…', ''],
    }[conn.state] || [conn.state, ''];
    ce.dataset.state = conn.state;
    ce.title = tip;
    ce.querySelector('.txt').textContent = word;
    return;
  }

  if (conn.mode === 'mock') {
    render($('#banner'), html`<div class="banner" role="note">${icon('info', 'sm')}<span>${conn.reason === 'requested'
      ? html`Sample data. To see your own repo, run <code>grapim serve</code> in it and open <code>http://127.0.0.1:7420</code>.`
      : html`Sample data: no Grapim server answered at this address. Run <code>grapim serve</code> in your repo, then open <code>http://127.0.0.1:7420</code>.`}</span></div>`);
  }
}

export async function refreshShell() {
  try {
    const [o, runs] = await Promise.all([api.overview(), api.runs()]);
    // A server that says readonly after the first paint: redraw without the buttons.
    if (embed.readOverview(o)) setTimeout(() => current?.view?.refresh?.());
    shell.overview = o;
    shell.runs = runs;
    shell.error = null;
    // Stable colours: agents in the order they first worked.
    registerAgents([...runs].sort((a, b) => a.first_ts - b.first_ts).map((r) => r.label));
    registerAgents(o.agents.map((a) => a.label));
  } catch (e) {
    shell.error = e;
  }
  renderShell();
}

// ---------------------------------------------------------------- theme

function getTheme() {
  if (EMBED) return embed.embedTheme;
  try { return localStorage.getItem('grapim.theme') || 'system'; } catch { return 'system'; }
}
// Embedded, the host owns the theme (?theme=), so there is nothing to change or save.
export function setTheme(t) {
  if (EMBED) return;
  try { if (t === 'system') localStorage.removeItem('grapim.theme'); else localStorage.setItem('grapim.theme', t); } catch {}
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  renderShell();
}

// ---------------------------------------------------------------- toasts

export function toast(message, { kind = 'info', action, timeout = 5000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  // Server messages mark commands with backticks; a toast is plain words.
  el.innerHTML = flat(html`<span>${String(message).replace(/`/g, '')}</span>${action ? html`<button type="button">${action.label}</button>` : ''}`);
  let timer = 0;
  const close = () => { clearTimeout(timer); el.remove(); };
  const arm = () => { clearTimeout(timer); timer = setTimeout(close, timeout); };
  if (action) el.querySelector('button').addEventListener('click', () => { close(); action.fn(); });
  // A toast with an action stays while the pointer or focus is on it.
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', arm);
  el.addEventListener('focusin', () => clearTimeout(timer));
  el.addEventListener('focusout', arm);
  $('#toasts').append(el);
  arm();
  return close;
}

// Any [data-copy-text] button copies its text (data-copy-what names it in the toast).
// Without the async clipboard (plain http, or an iframe that was not allowed
// it), a hidden field and execCommand still copy.
export function copyText(text, what = '') {
  const done = () => toast(what ? `Copied ${what}.` : 'Copied.', { timeout: 2500 });
  const fallback = () => {
    const opener = document.activeElement;
    const t = document.createElement('textarea');
    t.value = text;
    t.setAttribute('readonly', '');
    t.className = 'sr-only';
    document.body.append(t);
    t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    t.remove();
    opener?.focus?.({ preventScroll: true });
    if (ok) done();
    else toast('Couldn’t copy. Select the text and copy it by hand.', { kind: 'error' });
  };
  if (!navigator.clipboard) return fallback();
  navigator.clipboard.writeText(text).then(done, fallback);
}

// ---------------------------------------------------------------- dialogs

// One <dialog> for the palette, help and undo. showModal traps focus and Esc closes it.
export function openDialog(content, { className = '', onClose, label } = {}) {
  const d = $('#dialog');
  if (d.open) d.close();
  // One element serves every dialog: drop the last one's handlers.
  d.onclick = d.oninput = d.onsubmit = null;
  d.className = className;
  d.__html = null;
  render(d, content);
  if (label) d.setAttribute('aria-label', label); else d.removeAttribute('aria-label');
  const opener = document.activeElement;
  d.onclose = () => {
    onClose?.();
    d.onclose = null;
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  };
  d.showModal();
  return d;
}
document.addEventListener('click', (e) => {
  const d = $('#dialog');
  if (e.target === d) d.close(); // a click on the backdrop
});

const MOD = isMac ? '⌘' : 'Ctrl';
const KEYS = [
  ['Go to', [['Live', 'g l'], ['Runs', 'g r'], ['Files', 'g f'], ['Search or jump to…', `${MOD} K`], ['Collapse the sidebar', '[']]],
  ['Lists', [['Next / previous', 'j k'], ['Open', 'Enter'], ['Back to the list', 'Esc']]],
  ['Review a run', [['Approve', 'a'], ['Reject', 'x'], ['Create branch', 'b'], ['Undo… (asks first)', 'u']]],
  ['Diffs and files', [['Unified / split', 's'], ['Mark next file viewed', 'v'], ['Show this list', '?']]],
];
export function openHelp() {
  let keys = embed.readonly() ? KEYS.filter(([g]) => g !== 'Review a run') : KEYS;
  // Embedded there is no sidebar to collapse.
  if (EMBED) keys = keys.map(([g, items]) => [g, items.filter(([w]) => w !== 'Collapse the sidebar')]);
  openDialog(html`
    <div class="dlg">
      <div class="dlg-head"><h2 class="dlg-title" id="dlg-title">Keyboard shortcuts</h2>
        <p class="dlg-lead">Every action also has a button. Shortcuts are off while you type in a field.</p></div>
      <div class="dlg-body"><div class="keys">${keys.map(([group, items]) => html`
        <section><h3>${group}</h3><ul>${items.map(([what, keys]) => html`
          <li><span>${what}</span><span>${keys.split(' ').map((k) => html`<kbd>${k}</kbd>`)}</span></li>`)}</ul></section>`)}
      </div></div>
      <div class="dlg-foot"><button class="btn" type="button" data-close>Close</button></div>
    </div>`, { label: 'Keyboard shortcuts' });
}

// ---------------------------------------------------------------- context for views

export const ctx = {
  api: () => api,
  navigate,
  toast,
  setTitle,
  shell,
  refreshShell,
  openDialog,
  // Readonly (an embed session, or the server said so): no review, undo,
  // restore or branch. The server refuses them too; this keeps them off screen.
  readonly: embed.readonly,
  mayFocus: embed.mayFocus,
  embedded: EMBED,
  emit: embed.emit,
  async openUndo(run, turn = null) {
    if (embed.readonly()) return false;
    const m = await import('./views/undo.js');
    return m.openUndo(run, turn, ctx);
  },
  current: () => current?.view,
  // With one worktree (every cloud workspace), its name is noise: views leave it out.
  multiWorktree: () => (shell.overview?.worktrees?.length || 1) > 1,
};

// ---------------------------------------------------------------- keys

const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
let pendingG = null;

async function openPalette() {
  const m = await import('./views/palette.js');
  m.openPalette(ctx);
}

document.addEventListener('keydown', (e) => {
  // Embedded, keys only count while the desk itself has focus; the host
  // page's keys never reach here, and a stray synthetic one is ignored.
  if (EMBED && !document.hasFocus()) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    const d = $('#dialog');
    if (d.open && d.classList.contains('palette')) d.close();
    else openPalette();
    return;
  }
  if (e.defaultPrevented || $('#dialog').open || typing(e.target) || mod || e.altKey) return;
  if (pendingG) {
    clearTimeout(pendingG);
    pendingG = null;
    const n = NAV.find((x) => x.key === e.key.toLowerCase());
    if (n) { e.preventDefault(); navigate(n.href); }
    return;
  }
  if (e.key === 'g') { pendingG = setTimeout(() => (pendingG = null), 1200); return; }
  if (e.key === '?') { e.preventDefault(); openHelp(); return; }
  if (current?.view?.onKey?.(e)) e.preventDefault();
});

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (a?.dataset.action === 'palette') openPalette();
  else if (a?.dataset.action === 'help') openHelp();
  else if (a?.dataset.action === 'theme-cycle') {
    const order = ['system', 'light', 'dark'];
    setTheme(order[(order.indexOf(getTheme()) + 1) % 3]);
  }
  const t = e.target.closest('[data-theme-set]');
  if (t) setTheme(t.dataset.themeSet);
  const cp = e.target.closest('[data-copy-text]');
  if (cp) copyText(cp.dataset.copyText, cp.dataset.copyWhat);
  if (e.target.closest('[data-close]')) e.target.closest('dialog')?.close();
});

// ---------------------------------------------------------------- start

let tickTimer = null;
function onLiveTick() {
  clearTimeout(tickTimer);
  tickTimer = setTimeout(() => {
    refreshShell();
    current?.view?.refresh?.();
  }, 150);
}

// Relative times move on their own; nothing re-renders for it.
setInterval(() => {
  const now = Date.now();
  for (const t of document.querySelectorAll('[data-ago]')) {
    const s = ago(Number(t.dataset.ago), now);
    if (t.textContent !== s) t.textContent = s;
  }
}, 15000);

for (const el of document.querySelectorAll('kbd[data-mod]')) el.textContent = MOD;

(async function start() {
  // Embedded: the host can move the desk with grapim:navigate (from its origin only).
  embed.start({
    navigate: (r) => navigate(r.view === 'run' ? runHref(r.run)
      : r.view === 'files' ? (r.path ? fileHref(r.path) : '#/files')
      : r.view === 'runs' ? `#/runs${r.filter ? `?f=${r.filter}` : ''}` : '#/live'),
  });
  renderShell();
  // Until the first data arrives: the page's shape, not a blank screen.
  render($('#view'), html`<div class="page-head"><div><span class="sk" style="width:120px;height:24px"></span><span class="sk" style="width:280px;margin-top:12px"></span></div></div>
    <div class="panel" style="padding:16px">${[60, 80, 45, 70, 55].map((w) => html`<span class="sk" style="width:${w}%;margin:12px 0"></span>`)}</div>`);
  await init();
  // On the hub: the team's top bar and Ask Grapim around the desk.
  if (CLOUD && !EMBED) import('./hub-frame.js').then((m) => m.mountHubFrame()).catch(() => {});
  onStatus(renderShell);
  onTick(onLiveTick);
  await refreshShell();
  window.addEventListener('hashchange', route);
  if (!location.hash) history.replaceState(null, '', `${location.pathname}${location.search}#/live`);
  route().then(() => embed.ready({ view: current?.name }));
  // Warm the modules behind shortcuts, so the first Ctrl K or u opens at once.
  setTimeout(() => { import('./views/palette.js'); import('./views/undo.js'); }, 300);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', renderShell);
  // Coming back to the tab: catch up at once instead of waiting for the next tick.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onLiveTick(); });
})();
