// The public site's behaviour (/hub/static/site.js): the theme switch,
// copy buttons on code blocks, the docs nav filter and the "on this page"
// highlight. Everything works without it; this only adds to the page.
(() => {
  const root = document.documentElement;

  // Theme: the same choice the hub and the review desk read (grapim.theme).
  const themeBtns = [...document.querySelectorAll('[data-theme-set]')];
  const stored = () => {
    try {
      return localStorage.getItem('grapim.theme') || 'system';
    } catch {
      return 'system';
    }
  };
  const showTheme = () => {
    const t = stored();
    for (const b of themeBtns) b.setAttribute('aria-pressed', String(b.dataset.themeSet === t));
  };
  for (const b of themeBtns) {
    b.addEventListener('click', () => {
      const t = b.dataset.themeSet;
      try {
        if (t === 'system') localStorage.removeItem('grapim.theme');
        else localStorage.setItem('grapim.theme', t);
      } catch {}
      if (t === 'system') delete root.dataset.theme;
      else root.dataset.theme = t;
      showTheme();
    });
  }
  showTheme();

  // The top bar's menus (siteBar). Each trigger is a link in the HTML, so the
  // page works without this; here it becomes a button that opens its menu:
  // on hover after a short intent delay (closing after a grace delay, so a
  // diagonal move to the card does not lose it), on click, and from the
  // keyboard (Enter, Space or ArrowDown; Escape closes and returns focus).
  // Moving from one open menu to the next switches at once.
  const OPEN_DELAY = 120;
  const CLOSE_DELAY = 220;
  const menus = [...document.querySelectorAll('.bar-nav .nav-item[data-menu]')].map((item) => {
    const link = item.querySelector('.nav-trigger');
    const panel = item.querySelector('.nav-panel');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = link.className;
    btn.id = `${panel.id}-trigger`;
    btn.innerHTML = link.innerHTML;
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', panel.id);
    link.replaceWith(btn);
    panel.querySelector('.nav-rows')?.setAttribute('aria-labelledby', btn.id);
    panel.querySelector('.nav-rows')?.removeAttribute('aria-label');
    item.classList.add('is-js');
    return { item, btn, panel, timer: 0, by: '' };
  });
  const links = (m) => [...m.panel.querySelectorAll('a')];
  const setOpen = (m, on, by = '') => {
    clearTimeout(m.timer);
    m.item.classList.toggle('open', on);
    m.btn.setAttribute('aria-expanded', String(on));
    m.by = on ? by : '';
  };
  const openMenu = (m, by) => {
    for (const o of menus) if (o !== m) setOpen(o, false);
    setOpen(m, true, by);
  };
  const isOpen = (m) => m.item.classList.contains('open');
  const anyOpen = () => menus.some(isOpen);
  for (const m of menus) {
    m.item.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse') return;
      clearTimeout(m.timer);
      if (isOpen(m)) return;
      // Already in a menu: switch now. Otherwise wait for intent.
      if (anyOpen()) openMenu(m, 'hover');
      else m.timer = setTimeout(() => openMenu(m, 'hover'), OPEN_DELAY);
    });
    m.item.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'mouse') return;
      clearTimeout(m.timer);
      if (isOpen(m) && m.by === 'hover') m.timer = setTimeout(() => setOpen(m, false), CLOSE_DELAY);
    });
    m.btn.addEventListener('click', () => {
      // A click on a menu the pointer just opened keeps it open.
      if (isOpen(m) && m.by === 'hover') m.by = 'click';
      else if (isOpen(m)) setOpen(m, false);
      else openMenu(m, 'click');
    });
    m.btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        openMenu(m, 'key');
        links(m)[0]?.focus();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        // Along the bar, as a menubar would.
        const tops = [...document.querySelectorAll('.bar-nav .nav-list > li > :is(a, button)')];
        const next = tops[(tops.indexOf(m.btn) + (e.key === 'ArrowRight' ? 1 : tops.length - 1)) % tops.length];
        e.preventDefault();
        next?.focus();
      }
    });
    m.panel.addEventListener('keydown', (e) => {
      const all = links(m);
      const at = all.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        all[(at + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        all[e.key === 'Home' ? 0 : all.length - 1]?.focus();
      }
    });
    // A choice closes the menu (it matters for /#how on the home page).
    m.panel.addEventListener('click', (e) => {
      if (e.target.closest('a')) setOpen(m, false);
    });
    // Tabbing out of the trigger and its menu closes it.
    m.item.addEventListener('focusout', (e) => {
      if (isOpen(m) && !m.item.contains(e.relatedTarget)) setOpen(m, false);
    });
  }
  if (menus.length) {
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const m = menus.find(isOpen);
      if (!m) return;
      const inside = m.item.contains(document.activeElement);
      setOpen(m, false);
      if (inside) m.btn.focus();
    });
    document.addEventListener('pointerdown', (e) => {
      for (const m of menus) if (isOpen(m) && !m.item.contains(e.target)) setOpen(m, false);
    });
  }

  // The phone sheet (a <details>, so it opens without script): the page
  // under it stops scrolling, and a choice, Escape or a wider window closes it.
  const sheet = document.querySelector('[data-sheet]');
  if (sheet) {
    const summary = sheet.querySelector('summary');
    const close = () => {
      sheet.open = false;
      root.classList.remove('sheet-open');
    };
    sheet.addEventListener('toggle', () => {
      root.classList.toggle('sheet-open', sheet.open);
      summary.setAttribute('aria-label', sheet.open ? 'Close menu' : 'Menu');
    });
    sheet.addEventListener('click', (e) => {
      if (e.target.closest('.bar-sheet a')) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sheet.open) {
        close();
        summary.focus();
      }
    });
    matchMedia('(min-width: 769px)').addEventListener('change', (e) => {
      if (e.matches) close();
    });
  }

  // The landing page's motion. Product scenes (data-play) play once and
  // sections (data-reveal) fade up once, as they scroll into view. Without
  // IntersectionObserver, or with reduced motion, nothing is hidden:
  // html.motion is never set.
  const scenes = document.querySelectorAll('[data-play], [data-reveal]');
  if (scenes.length && 'IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // The hero performs one review. Its comment opens inside the card, so the
    // stage keeps the finished height (measured before anything is hidden)
    // and nothing below it moves. After the first play, a Replay button.
    const review = document.querySelector('[data-play="review"]');
    const stage = review?.querySelector('.hero-stage');
    const replay = review?.querySelector('[data-replay]');
    const reserve = () => {
      if (stage) stage.style.minHeight = `${stage.offsetHeight}px`;
    };
    reserve();
    root.classList.add('motion');
    review?.classList.add('armed');
    if (review) {
      review.addEventListener('animationend', (e) => {
        if (!e.target.classList.contains('t4')) return;
        stage.style.minHeight = '';
        if (replay) replay.hidden = false;
      });
      replay?.addEventListener('click', () => {
        reserve();
        review.classList.remove('in');
        void review.offsetWidth;
        review.classList.add('in');
      });
      // A new width before it plays: measure the finished state again.
      addEventListener('resize', () => {
        if (review.classList.contains('in')) return;
        stage.style.minHeight = '';
        review.classList.remove('armed');
        reserve();
        review.classList.add('armed');
      });
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
    );
    for (const s of scenes) io.observe(s);
  }

  // Copy buttons: the code block's text, as shown.
  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.hidden = false;
    btn.setAttribute('aria-label', 'Copy code');
    btn.addEventListener('click', async () => {
      const code = btn.closest('.code')?.querySelector('pre code');
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.textContent.replace(/\n$/, ''));
        btn.textContent = 'Copied';
        btn.dataset.done = '';
      } catch {
        btn.textContent = 'Select and copy';
      }
      setTimeout(() => {
        btn.textContent = 'Copy';
        delete btn.dataset.done;
      }, 1600);
    });
  }

  // Docs nav filter: matches page names and descriptions.
  const filterBox = document.querySelector('.docs-filter');
  const input = document.getElementById('docs-filter');
  if (filterBox && input) {
    filterBox.hidden = false;
    const nav = filterBox.closest('.docs-nav');
    const none = nav.querySelector('.docs-none');
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      for (const group of nav.querySelectorAll('.docs-group')) {
        let inGroup = 0;
        for (const a of group.querySelectorAll('a')) {
          const hit = !q || q.split(/\s+/).every((w) => a.dataset.words.includes(w));
          a.parentElement.hidden = !hit;
          if (hit) inGroup++;
        }
        group.hidden = !inGroup;
        shown += inGroup;
      }
      none.hidden = shown > 0;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = [...nav.querySelectorAll('.docs-group li:not([hidden]) a')][0];
        if (first) location.href = first.href;
      }
      if (e.key === 'Escape') {
        input.value = '';
        input.dispatchEvent(new Event('input'));
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) {
        e.preventDefault();
        input.focus();
      }
    });
  }

  // "On this page": mark the section being read.
  const toc = [...document.querySelectorAll('.docs-toc a')];
  if (toc.length && 'IntersectionObserver' in window) {
    const byId = new Map(toc.map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
    const heads = [...byId.keys()].map((id) => document.getElementById(id)).filter(Boolean);
    const mark = (id) => {
      for (const a of toc) a.removeAttribute('aria-current');
      byId.get(id)?.setAttribute('aria-current', 'true');
    };
    const io = new IntersectionObserver(
      () => {
        let current = heads[0];
        for (const h of heads) if (h.getBoundingClientRect().top < 120) current = h;
        if (current) mark(current.id);
      },
      { rootMargin: '0px 0px -60% 0px', threshold: [0, 1] },
    );
    for (const h of heads) io.observe(h);
  }

  // The docs menu on narrow screens closes after a choice.
  const menu = document.querySelector('[data-docs-menu]');
  if (menu) menu.addEventListener('click', (e) => {
    if (e.target.closest('a')) menu.open = false;
  });
})();
