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

  // Product scenes on the landing page (data-play) play once when they
  // scroll into view. Without IntersectionObserver, or with reduced motion,
  // nothing is hidden: html.motion is never set.
  const scenes = document.querySelectorAll('[data-play]');
  if (scenes.length && 'IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    root.classList.add('motion');
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add('in');
          if (e.target.classList.contains('ledger')) setTimeout(() => e.target.classList.add('done'), 3700);
          io.unobserve(e.target);
        }
      },
      { threshold: 0.3 },
    );
    for (const s of scenes) io.observe(s);
  } else {
    for (const l of document.querySelectorAll('.ledger')) l.classList.add('done');
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
