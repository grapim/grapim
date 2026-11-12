// The left sidebar: drag its edge to resize, or collapse it to an icon rail.
// Shared by the review desk (ui/) and the hub (/hub/static/sidebar.js).
// Loaded in <head> without defer so a saved width or a collapsed sidebar is
// applied before first paint. CSP-safe: no inline script, styles set through
// CSSOM only. Saved per browser in localStorage "grapim.sidebar".
//
//   drag the edge          resize, 200 to 400 px; drag past the left to collapse
//   double-click the edge  back to the default width
//   [  or  Ctrl/⌘ \        collapse to the rail or expand (not while typing)
//   hover a rail icon      a tooltip names it
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

  let hideTip = () => {};
  function setCollapsed(c) {
    state = { ...state, collapsed: !!c };
    save(state);
    apply();
    hideTip();
    for (const b of document.querySelectorAll('[data-sidebar-toggle]')) {
      b.setAttribute('aria-expanded', String(!c));
      b.setAttribute('aria-label', c ? 'Expand sidebar' : 'Collapse sidebar');
      b.dataset.tip = c ? 'Expand sidebar' : '';
      b.title = c ? '' : 'Collapse sidebar  [';
    }
    const handle = document.querySelector('.side-resize');
    if (handle) handle.setAttribute('aria-valuenow', String(c ? 0 : width()));
  }
  const toggle = () => setCollapsed(!state.collapsed);

  const ICON = '<svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><rect x="2" y="2.5" width="12" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 2.5v11" stroke="currentColor" stroke-width="1.5"/></svg>';
  function toggleButton() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'side-toggle';
    b.dataset.sidebarToggle = '';
    b.innerHTML = ICON;
    b.addEventListener('click', toggle);
    return b;
  }

  // The rail's tooltip: the item's own words (its label or aria-label).
  function tooltips(side) {
    const tip = document.createElement('div');
    tip.className = 'rail-tip';
    tip.setAttribute('aria-hidden', 'true');
    document.body.append(tip);
    let timer = 0;
    hideTip = () => { clearTimeout(timer); tip.classList.remove('is-on'); };
    const labelOf = (n) => n.dataset.tip
      || n.querySelector('.nav-label, .label, .search-btn > span, .ask-btn > span, .login, .brand > span, .brand-name')?.textContent.trim()
      || n.getAttribute('aria-label') || '';
    const show = (n) => {
      if (!state.collapsed) return;
      const text = labelOf(n);
      if (!text) return;
      tip.textContent = text;
      const r = n.getBoundingClientRect();
      tip.style.left = `${Math.round(r.right + 10)}px`;
      tip.style.top = `${Math.round(r.top + r.height / 2)}px`;
      clearTimeout(timer);
      // Instant once one tooltip is showing, a short wait for the first.
      timer = setTimeout(() => tip.classList.add('is-on'), tip.classList.contains('is-on') ? 0 : 280);
    };
    const target = (e) => e.target.closest?.('a, button, summary');
    side.addEventListener('pointerover', (e) => { const n = target(e); if (n && side.contains(n)) show(n); });
    side.addEventListener('pointerleave', hideTip);
    side.addEventListener('focusin', (e) => { const n = target(e); if (n) show(n); });
    side.addEventListener('focusout', hideTip);
    side.addEventListener('click', hideTip);
    window.addEventListener('scroll', hideTip, { passive: true });
  }

  function wire() {
    const side = document.querySelector('.side, .sidebar');
    const app = side?.closest('.app');
    if (!side || !app || root.classList.contains('embed')) return;

    // The collapse button, in the sidebar next to the brand (under it on the rail).
    const brand = side.querySelector('.brand');
    if (brand) {
      const row = document.createElement('div');
      row.className = 'side-head';
      brand.replaceWith(row);
      row.append(brand, toggleButton());
    }

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
      dragging = true; startX = e.clientX; startW = state.collapsed ? 56 : width();
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

    tooltips(side);

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

    setCollapsed(state.collapsed); // labels and aria on the new button
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
