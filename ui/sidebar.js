// The left sidebar: drag its edge to resize, collapse it, peek at it.
// Shared by the review desk (ui/) and the hub (/hub/static/sidebar.js).
// Loaded in <head> without defer so a saved width or a collapsed sidebar is
// applied before first paint. CSP-safe: no inline script, styles set through
// CSSOM only. Saved per browser in localStorage "grapim.sidebar".
//
//   drag the edge          resize, 200 to 400 px; drag past the left to collapse
//   double-click the edge  back to the default width
//   [  or  Ctrl/⌘ \        collapse or expand (not while typing)
//   hover the left edge    peek at a collapsed sidebar
(() => {
  const KEY = 'grapim.sidebar';
  const MIN = 200, MAX = 400, DEFAULT = 232, SNAP = 140;
  const root = document.documentElement;
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };
  const clamp = (w) => Math.min(MAX, Math.max(MIN, Math.round(w)));
  let state = read();
  const width = () => clamp(Number(state.w) || DEFAULT);

  function apply() {
    root.style.setProperty('--sidebar-open', `${width()}px`);
    if (state.collapsed) root.dataset.sidebar = 'collapsed';
    else delete root.dataset.sidebar;
  }
  apply(); // before first paint

  function setCollapsed(c) {
    state = { ...state, collapsed: !!c };
    save(state);
    delete root.dataset.peek;
    apply();
    for (const b of document.querySelectorAll('[data-sidebar-toggle]')) {
      b.setAttribute('aria-expanded', String(!c));
      b.setAttribute('aria-label', c ? 'Show sidebar' : 'Hide sidebar');
      b.title = c ? 'Show sidebar  [' : 'Hide sidebar  [';
    }
    const handle = document.querySelector('.side-resize');
    if (handle) handle.setAttribute('aria-valuenow', String(c ? 0 : width()));
  }
  const toggle = () => setCollapsed(!state.collapsed);

  const ICON = '<svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><rect x="2" y="2.5" width="12" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 2.5v11" stroke="currentColor" stroke-width="1.5"/></svg>';
  function toggleButton(cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `side-toggle ${cls}`;
    b.dataset.sidebarToggle = '';
    b.innerHTML = ICON;
    b.addEventListener('click', toggle);
    return b;
  }

  function wire() {
    const side = document.querySelector('.side, .sidebar');
    const app = side?.closest('.app');
    if (!side || !app || root.classList.contains('embed')) return;

    // Hide button, in the sidebar next to the brand.
    const brand = side.querySelector('.brand');
    if (brand) {
      const row = document.createElement('div');
      row.className = 'side-head';
      brand.replaceWith(row);
      row.append(brand, toggleButton('in-side'));
    }
    // Show button, at the top left of the page while collapsed.
    const main = app.querySelector('.main');
    if (main) main.prepend(toggleButton('in-main'));

    // The drag handle on the sidebar's right edge (keyboard: arrows, Enter).
    const handle = document.createElement('div');
    handle.className = 'side-resize';
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', 'Resize sidebar');
    handle.setAttribute('aria-valuemin', String(MIN));
    handle.setAttribute('aria-valuemax', String(MAX));
    handle.title = 'Drag to resize, double-click to reset';
    app.append(handle);

    let dragging = false, startX = 0, startW = 0;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true; startX = e.clientX; startW = state.collapsed ? 0 : width();
      handle.setPointerCapture(e.pointerId);
      root.dataset.resizing = '';
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const w = startW + (e.clientX - startX);
      if (w < SNAP) { if (!state.collapsed) { state = { ...state, collapsed: true }; apply(); } return; }
      state = { ...state, collapsed: false, w: clamp(w) };
      apply();
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      delete root.dataset.resizing;
      setCollapsed(state.collapsed);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('dblclick', () => { state = { collapsed: false, w: DEFAULT }; setCollapsed(false); });
    handle.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        if (state.collapsed && e.key === 'ArrowRight') return setCollapsed(false);
        state = { ...state, w: clamp(width() + (e.key === 'ArrowRight' ? 16 : -16)) };
        setCollapsed(false);
      } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      else if (e.key === 'Home') { e.preventDefault(); state = { ...state, w: DEFAULT }; setCollapsed(false); }
    });

    // Peek: with the sidebar collapsed, the pointer at the left edge slides it in.
    const zone = document.createElement('div');
    zone.className = 'side-peek-zone';
    zone.setAttribute('aria-hidden', 'true');
    app.append(zone);
    let leaveTimer = 0;
    zone.addEventListener('pointerenter', () => { if (state.collapsed) root.dataset.peek = ''; });
    side.addEventListener('pointerenter', () => clearTimeout(leaveTimer));
    side.addEventListener('pointerleave', () => {
      if (!('peek' in root.dataset)) return;
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => { if (!side.querySelector('details[open]')) delete root.dataset.peek; }, 250);
    });

    // [ and Ctrl/⌘ \ toggle (not while typing or with a dialog open).
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('dialog[open]')) return;
      if ((e.key === '[' && !e.ctrlKey && !e.metaKey && !e.altKey) || (e.key === '\\' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        toggle();
      }
    });

    setCollapsed(state.collapsed); // labels and aria on the new buttons
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
