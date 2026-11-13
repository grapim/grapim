// The hub's only script (the CSP allows no inline code). Every page works
// without it; it adds: copy buttons, confirmation for destructive forms,
// chart tooltips, closing menus, the Ctrl/Cmd K palette, "g" shortcuts and
// the shortcuts help, old settings links, the duplicate team name hint,
// and remembering the diff "wrap long lines" choice.

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  n.append(...kids.filter(Boolean));
  return n;
};
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {}
  },
};

for (const k of $$('kbd.mod')) k.textContent = isMac ? '⌘' : 'Ctrl';

// ---------------------------------------------------------------- copy

async function copyText(text, btn) {
  const label = btn.dataset.label || btn.textContent;
  btn.dataset.label = label;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
    btn.classList.add('is-done');
  } catch {
    btn.textContent = isMac ? 'Press ⌘C' : 'Press Ctrl+C';
  }
  setTimeout(() => {
    btn.textContent = label;
    btn.classList.remove('is-done');
  }, 2000);
}

// A Copy button on every code block: the snippet as shown.
for (const pre of $$('pre.code')) {
  const wrap = el('div', { class: 'code-wrap' });
  pre.replaceWith(wrap);
  wrap.append(pre, el('button', { class: 'btn btn-sm code-copy', type: 'button', 'data-copy-code': '', 'aria-label': `Copy ${pre.getAttribute('aria-label') || 'snippet'}`, text: 'Copy' }));
}

document.addEventListener('click', (e) => {
  const code = e.target.closest('[data-copy-code]');
  if (code) {
    const pre = code.parentElement.querySelector('pre');
    if (pre) copyText(pre.textContent.replace(/\n$/, ''), code);
    return;
  }
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const input = document.getElementById(btn.dataset.copy);
  if (!input) return;
  input.select();
  copyText(input.value, btn);
});

// ---------------------------------------------------------------- waiting states

// What a button says while its form is on the way: "Create token" -> "Creating…".
const VERB = {
  create: 'Creating', new: 'Creating', save: 'Saving', approve: 'Approving', reject: 'Rejecting', delete: 'Deleting',
  rename: 'Renaming', revoke: 'Revoking', remove: 'Removing', leave: 'Leaving', test: 'Testing', sync: 'Syncing',
  connect: 'Connecting', disconnect: 'Disconnecting', upgrade: 'Opening checkout', change: 'Opening checkout',
  manage: 'Opening', install: 'Opening GitHub', link: 'Linking', unlink: 'Unlinking', move: 'Moving', retry: 'Retrying',
  cancel: 'Cancelling', apply: 'Applying', join: 'Joining', sign: 'Signing out', turn: 'Saving', invite: 'Creating',
};
const pendingLabel = (text) => {
  const word = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return `${VERB[word] ?? 'Working'}…`;
};

// A thin bar at the top while the next page loads, after 120 ms so a fast
// page never shows it.
const bar = el('div', { class: 'nav-progress', 'aria-hidden': 'true' });
let barTimer = null;
function navStart() {
  clearTimeout(barTimer);
  barTimer = setTimeout(() => {
    if (!bar.isConnected) document.body.append(bar);
    bar.classList.remove('is-done');
    void bar.offsetWidth;
    bar.classList.add('is-on');
  }, 120);
}
function navReset() {
  clearTimeout(barTimer);
  bar.classList.remove('is-on');
  if (bar.isConnected) bar.classList.add('is-done');
  for (const f of $$('form[aria-busy="true"]')) {
    f.removeAttribute('aria-busy');
    delete f.dataset.busy;
  }
  for (const b of $$('.btn[aria-busy="true"]')) {
    b.removeAttribute('aria-busy');
    const t = [...b.childNodes].reverse().find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (t && b.dataset.idle) t.textContent = b.dataset.idleText ?? b.dataset.idle;
  }
}
// Back and forward restore a page from the cache with its old busy state.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) navReset();
});

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || a.closest('template') || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (a.target === '_blank' || a.hasAttribute('download') || a.dataset.action) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
  navStart();
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('form');
  if (!form || e.defaultPrevented) return; // a script handles it (Ask Grapim's composer)
  if (form.dataset.busy) {
    e.preventDefault(); // one submit per form
    return;
  }
  if (form.matches('[data-confirm]') && !window.confirm(form.dataset.confirm)) {
    e.preventDefault();
    return;
  }
  if (form.method.toLowerCase() === 'get') return navStart();
  // The submitter keeps its name and value (approve or reject): it is marked
  // busy, not disabled, and the form refuses a second submit instead.
  const btn = e.submitter ?? form.querySelector('button[type="submit"], button:not([type])');
  form.dataset.busy = '1';
  form.setAttribute('aria-busy', 'true');
  if (btn instanceof HTMLButtonElement) {
    const last = [...btn.childNodes].reverse().find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    btn.dataset.idle = btn.textContent.trim();
    if (last) btn.dataset.idleText = last.textContent;
    btn.setAttribute('aria-busy', 'true');
    if (last) last.textContent = pendingLabel(btn.dataset.idle);
    else btn.append(pendingLabel(btn.dataset.idle));
  }
  navStart();
});

// ---------------------------------------------------------------- menus

// <details data-menu>: one open at a time; a click outside or Esc closes it.
document.addEventListener('click', (e) => {
  for (const d of $$('details[data-menu][open]')) if (!d.contains(e.target)) d.open = false;
});
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.matches('[data-menu]') || !d.open) return;
  for (const o of $$('details[data-menu][open]')) if (o !== d) o.open = false;
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const d = $('details[data-menu][open]');
  if (d) {
    d.open = false;
    d.querySelector('summary')?.focus();
  }
});

// ---------------------------------------------------------------- report charts

// A tooltip for any mark with data-tip (the tables under the charts hold the
// same numbers, so nothing depends on it).
const tip = el('div', { class: 'tip', 'aria-hidden': 'true' });
tip.hidden = true;
document.addEventListener('pointermove', (e) => {
  const mark = e.target instanceof Element ? e.target.closest('.chart [data-tip], .bar-table [data-tip]') : null;
  if (!mark) {
    tip.hidden = true;
    return;
  }
  if (!tip.isConnected) document.body.append(tip);
  tip.textContent = mark.getAttribute('data-tip');
  tip.hidden = false;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  tip.style.left = `${Math.max(8, Math.min(e.clientX + 12, window.innerWidth - w - 8))}px`;
  tip.style.top = `${e.clientY - h - 12 < 8 ? e.clientY + 16 : e.clientY - h - 12}px`;
});

// Select a freshly revealed secret so it can be copied straight away.
$('.reveal-value')?.focus();
$('.reveal-value')?.select();

// ---------------------------------------------------------------- dialogs

const dialog = $('#hub-dialog');
let opener = null;
function openDialog(content, { label, className = '' }) {
  if (!dialog) return null;
  if (dialog.open) dialog.close();
  dialog.replaceChildren(content);
  dialog.className = className;
  dialog.setAttribute('aria-label', label);
  opener = document.activeElement;
  dialog.showModal();
  return dialog;
}
dialog?.addEventListener('close', () => {
  if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  opener = null;
});
dialog?.addEventListener('click', (e) => {
  if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
});

const MOD = isMac ? '⌘' : 'Ctrl';
const keys = (s) => s.split(' ').map((k) => el('kbd', { text: k }));

function openHelp() {
  const groups = [
    ['Go to', $$('.side .nav-item[data-g]').map((a) => [a.firstChild?.nextSibling?.textContent?.trim() || a.textContent.trim(), `g ${a.dataset.g}`]).concat([['Search or jump to…', `${MOD} K`]], $('.ask-btn') ? [['Ask Grapim', `${MOD} J`]] : [])],
    ['Anywhere', [['Show this list', '?'], ['Close a menu or dialog', 'Esc']]],
  ];
  const body = el('div', { class: 'dlg' },
    el('div', { class: 'dlg-head' }, el('h2', { class: 'dlg-title', text: 'Keyboard shortcuts' }), el('p', { class: 'dlg-lead', text: 'Every shortcut also has a link or button. Shortcuts are off while you type in a field.' })),
    el('div', { class: 'dlg-body' }, el('div', { class: 'keys' }, ...groups.map(([g, items]) =>
      el('section', {}, el('h3', { text: g }), el('ul', {}, ...items.map(([what, k]) => el('li', {}, el('span', { text: what }), el('span', { class: 'keys-k' }, ...keys(k))))))))),
    el('div', { class: 'dlg-foot' }, el('button', { class: 'btn', type: 'button', 'data-close': '', text: 'Close' })),
  );
  openDialog(body, { label: 'Keyboard shortcuts', className: 'help' });
}

// ---------------------------------------------------------------- palette

// Substring beats subsequence; earlier and shorter matches rank higher (as the desk's).
function score(q, text) {
  if (!q) return 1;
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i >= 0) return 1000 - i - t.length / 100;
  let last = -1;
  let gaps = 0;
  for (const c of q) {
    const j = t.indexOf(c, last + 1);
    if (j < 0) return 0;
    if (last >= 0) gaps += j - last - 1;
    last = j;
  }
  return 500 - gaps - t.length / 100;
}

function paletteItems() {
  const src = $('#palette-src');
  if (!src) return [];
  return [...src.content.querySelectorAll('a')].map((a) => ({
    href: a.getAttribute('href'),
    action: a.dataset.action || null,
    label: a.textContent.trim(),
    group: a.dataset.group || '',
    sub: a.dataset.sub || '',
    hint: a.dataset.hint || '',
  }));
}

function openPalette() {
  const all = paletteItems();
  if (!all.length) return;
  const s = { q: '', sel: 0, items: [] };
  const input = el('input', { id: 'palette-q', type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list', 'aria-label': 'Search', placeholder: 'Jump to a page, run, repo, workspace or setting…', autocomplete: 'off', spellcheck: 'false' });
  const list = el('div', { class: 'palette-list', id: 'palette-list', role: 'listbox', 'aria-label': 'Results' });
  const body = el('div', { class: 'dlg' },
    el('div', { class: 'palette-input' }, input, el('kbd', { text: 'Esc' })),
    list,
    el('div', { class: 'palette-foot', 'aria-hidden': 'true' }, el('span', {}, ...keys('↑ ↓'), ' move'), el('span', {}, ...keys('Enter'), ' open'), el('span', {}, ...keys('Esc'), ' close')),
  );

  function filter() {
    const q = s.q.trim().toLowerCase();
    let ranked = all.map((it) => ({ it, sc: Math.max(score(q, it.label), score(q, `${it.sub} ${it.group}`) * 0.8) })).filter((x) => x.sc > 0);
    if (q) {
      ranked.sort((a, b) => b.sc - a.sc);
      if (ranked.some((x) => x.sc >= 900)) ranked = ranked.filter((x) => x.sc >= 810);
    } else {
      // Without a query: the pages, the first runs to review, the actions.
      const counts = new Map();
      ranked = ranked.filter((x) => {
        const n = (counts.get(x.it.group) ?? 0) + 1;
        counts.set(x.it.group, n);
        return x.it.group === 'Go to' || x.it.group === 'Help' || n <= 4;
      });
    }
    s.items = ranked.slice(0, 50).map((x) => x.it);
    s.sel = Math.min(s.sel, Math.max(0, s.items.length - 1));
  }

  function draw() {
    filter();
    list.replaceChildren();
    if (!s.items.length) {
      list.append(el('p', { class: 'palette-empty', text: `Nothing matches “${s.q}”.` }));
      input.setAttribute('aria-activedescendant', '');
      return;
    }
    let group = null;
    s.items.forEach((it, i) => {
      const g = s.q ? 'Results' : it.group;
      if (g !== group) {
        group = g;
        list.append(el('div', { class: 'palette-group', 'aria-hidden': 'true', text: g }));
      }
      const row = el('div', { class: 'palette-item', role: 'option', id: `pi-${i}`, 'data-i': String(i), 'aria-selected': String(i === s.sel) },
        el('span', { class: 'main-l', text: it.label }),
        it.sub ? el('span', { class: 'sub', text: it.sub }) : null,
        it.hint ? el('span', { class: 'keys-k' }, ...keys(it.hint)) : null,
      );
      list.append(row);
    });
    input.setAttribute('aria-activedescendant', `pi-${s.sel}`);
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function choose(i) {
    const it = s.items[i];
    if (!it) return;
    dialog.close();
    if (it.action === 'help') return setTimeout(openHelp);
    // Other actions belong to other scripts (agent.js opens Ask Grapim).
    if (it.action) return setTimeout(() => document.dispatchEvent(new CustomEvent('grapim:action', { detail: it.action })));
    if (it.href) {
      navStart();
      location.href = it.href;
    }
  }

  input.addEventListener('input', () => {
    s.q = input.value;
    s.sel = 0;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    const n = Math.max(1, s.items.length);
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      s.sel = (s.sel + 1) % n;
      draw();
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      s.sel = (s.sel - 1 + n) % n;
      draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(s.sel);
    }
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('[data-i]');
    if (row) choose(Number(row.dataset.i));
  });
  list.addEventListener('mousemove', (e) => {
    const row = e.target.closest('[data-i]');
    if (!row || Number(row.dataset.i) === s.sel) return;
    s.sel = Number(row.dataset.i);
    for (const x of list.querySelectorAll('[data-i]')) x.setAttribute('aria-selected', String(Number(x.dataset.i) === s.sel));
    input.setAttribute('aria-activedescendant', `pi-${s.sel}`);
  });

  openDialog(body, { label: 'Jump to', className: 'palette' });
  draw();
  input.focus();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (!a || a.closest('template')) return;
  if (a.dataset.action === 'palette') {
    e.preventDefault();
    for (const d of $$('details[data-menu][open]')) d.open = false;
    openPalette();
  } else if (a.dataset.action === 'help') {
    e.preventDefault();
    openHelp();
  }
});

// ---------------------------------------------------------------- keys

let pendingG = null;
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k' && $('#palette-src')) {
    e.preventDefault();
    if (dialog?.open && dialog.classList.contains('palette')) dialog.close();
    else openPalette();
    return;
  }
  if (e.defaultPrevented || dialog?.open || typing(e.target) || mod || e.altKey) return;
  if (pendingG) {
    clearTimeout(pendingG);
    pendingG = null;
    const a = $(`.side .nav-item[data-g="${CSS.escape(e.key.toLowerCase())}"]`);
    if (a) {
      e.preventDefault();
      navStart();
      location.href = a.href;
    }
    return;
  }
  if (e.key === 'g' && $('.side .nav-item[data-g]')) {
    pendingG = setTimeout(() => (pendingG = null), 1200);
    return;
  }
  if (e.key === '?' && dialog) {
    e.preventDefault();
    openHelp();
  }
});

// ---------------------------------------------------------------- old settings links

// Settings used to be one page of anchors (/settings#tokens). The server sends
// /settings to General with the fragment kept; send an old anchor on to the
// page that holds it now.
const OLD_SETTINGS = { members: 'members', invites: 'members', tokens: 'machines', billing: 'plan', 'ask-grapim': 'plan', github: 'github', rules: 'rules', notifications: 'notifications', storage: 'data', 'code-storage': 'data', platform: 'platform', danger: 'general' };
{
  const m = location.pathname.match(/^(\/hub\/teams\/[^/]+\/settings)\/general\/?$/);
  const to = m && OLD_SETTINGS[location.hash.slice(1)];
  if (to && to !== 'general') location.replace(`${m[1]}/${to}${location.search}`);
}
// On a phone the settings sub-nav is a row that scrolls sideways: show the current page in it.
{
  const nav = $('.subnav');
  const cur = nav && $('.subnav-item[aria-current]', nav);
  if (cur && nav.scrollWidth > nav.clientWidth) nav.scrollLeft += cur.getBoundingClientRect().left - nav.getBoundingClientRect().left - 16;
}

// ---------------------------------------------------------------- run page

// Jumping to a file opens it if it was collapsed.
function openTarget() {
  const id = decodeURIComponent(location.hash.slice(1));
  const t = id && document.getElementById(id);
  if (t instanceof HTMLDetailsElement) t.open = true;
}
window.addEventListener('hashchange', openTarget);
openTarget();

const wrap = $('#wrap-lines');
if (wrap) {
  wrap.checked = store.get('grapim.hub.wrap') === '1';
  wrap.addEventListener('change', () => store.set('grapim.hub.wrap', wrap.checked ? '1' : null));
}

// ---------------------------------------------------------------- teams list

// Creating a team with a name you already belong to: allowed, but said first.
const dupForm = $('form[data-dup-check]');
if (dupForm) {
  const input = dupForm.querySelector('input[name="name"]');
  const out = $('#team-name-dup');
  const names = $$('[data-team-name]').map((r) => r.dataset.teamName);
  const check = () => {
    const v = input.value.trim().toLowerCase();
    const n = v ? names.filter((x) => x.trim().toLowerCase() === v).length : 0;
    out.hidden = !n;
    out.textContent = n ? `You already belong to ${n === 1 ? 'a team' : `${n} teams`} called ${input.value.trim()}. You can still create another; the list tells them apart by created date and role.` : '';
  };
  input.addEventListener('input', check);
  check();
}

// Theme (System, Light, Dark) in the profile menu; the same key as the desk.
function currentTheme() { try { return localStorage.getItem('grapim.theme') || 'system'; } catch { return 'system'; } }
function paintThemeButtons() { for (const b of $$('[data-theme-set]')) b.setAttribute('aria-pressed', String(b.dataset.themeSet === currentTheme())); }
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-theme-set]');
  if (!b) return;
  const t = b.dataset.themeSet;
  try { if (t === 'system') localStorage.removeItem('grapim.theme'); else localStorage.setItem('grapim.theme', t); } catch {}
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  paintThemeButtons();
});
paintThemeButtons();

// ---------------------------------------------------------------- scroll strips

// Tabs and segmented filters scroll sideways when they do not fit: the
// current one is scrolled into view, and an edge with more fades out.
for (const strip of $$('.tabs, .subnav, .seg')) {
  const paint = () => {
    const max = strip.scrollWidth - strip.clientWidth;
    const start = max > 1 && strip.scrollLeft > 1;
    const end = max > 1 && strip.scrollLeft < max - 1;
    if (start && end) strip.dataset.fade = 'both';
    else if (start) strip.dataset.fade = 'start';
    else if (end) strip.dataset.fade = 'end';
    else delete strip.dataset.fade;
  };
  const cur = strip.querySelector('[aria-current], .seg-item:has(input:checked)');
  if (cur && strip.scrollWidth > strip.clientWidth) {
    const a = strip.getBoundingClientRect();
    const b = cur.getBoundingClientRect();
    if (b.right > a.right || b.left < a.left) strip.scrollLeft += b.left - a.left - (a.width - b.width) / 2;
  }
  paint();
  strip.addEventListener('scroll', paint, { passive: true });
  window.addEventListener('resize', paint);
}

// ---------------------------------------------------------------- toast

// A form's error that came back in the address (?error=…) is shown once.
{
  const url = new URL(location.href);
  if (url.searchParams.has('error')) {
    url.searchParams.delete('error');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }
}

// A toast says what a form just did. It leaves after a few seconds (not
// while hovered or focused), and the ?done= that asked for it leaves the
// address, so a reload does not say it again.
const toast = $('.toast');
if (toast) {
  const url = new URL(location.href);
  if (url.searchParams.has('done')) {
    url.searchParams.delete('done');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }
  let timer = null;
  const leave = () => {
    toast.classList.add('is-out');
    setTimeout(() => toast.hidden = true, 320);
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(leave, 5000);
  };
  toast.addEventListener('pointerenter', () => clearTimeout(timer));
  toast.addEventListener('pointerleave', arm);
  toast.addEventListener('focusin', () => clearTimeout(timer));
  toast.querySelector('.toast-close')?.addEventListener('click', leave);
  arm();
}

// ---------------------------------------------------------------- live pages

// A page with work running on the hub (the history scan) reloads itself
// every data-refresh seconds while the tab is visible.
const refresh = $('[data-refresh]');
if (refresh) {
  const s = Math.min(60, Math.max(3, Number(refresh.dataset.refresh) || 5));
  setInterval(() => {
    if (document.visibilityState === 'visible') location.reload();
  }, s * 1000);
}

// The evidence print view's button.
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-print]')) window.print();
});
