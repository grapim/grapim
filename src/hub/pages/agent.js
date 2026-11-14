// Ask Grapim: the hub's assistant panel (src/hub/agent/, docs/security-agent.md).
// A static file, as the CSP wants (no inline code); it talks only to this
// hub's own routes. Loaded in <head> without defer, like sidebar.js, so an
// open panel and its saved width apply before first paint.
//
//   Ctrl/⌘ J, the sidebar button or "Ask about this run"   open or close
//   drag the panel's left edge                              resize, 320 to 640 px
//   Enter sends, Shift+Enter is a new line, Esc closes
//
// Rendering is DOM only (createElement and textContent, never innerHTML for
// text), so nothing the model or an agent wrote can become markup. Links go
// only to this hub's own pages and to github.com.
(() => {
  const KEY = 'grapim.agent';
  const MIN = 320, MAX = 640, DEFAULT = 400;
  const root = document.documentElement;
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };
  const clamp = (w) => Math.min(MAX, Math.max(MIN, Math.round(w)));
  let pref = read();
  const width = () => clamp(Number(pref.w) || DEFAULT);
  root.style.setProperty('--agent-w', `${width()}px`);
  if (pref.open) root.dataset.agent = 'open'; // before first paint; ignored without a panel

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const narrow = () => window.matchMedia('(max-width: 860px)').matches;

  // Fixed icon drawings (constants, never data), the hub's 16 px stroke set.
  const S = 'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';
  const ICONS = {
    spark: `<path d="M7 2.5c.35 2.55 1.45 3.65 4 4-2.55.35-3.65 1.45-4 4-.35-2.55-1.45-3.65-4-4 2.55-.35 3.65-1.45 4-4Z" ${S}/><path d="M12 10.25c.15 1.05.7 1.6 1.75 1.75-1.05.15-1.6.7-1.75 1.75-.15-1.05-.7-1.6-1.75-1.75 1.05-.15 1.6-.7 1.75-1.75Z" ${S}/>`,
    x: `<path d="m4.5 4.5 7 7m0-7-7 7" ${S}/>`,
    plus: `<path d="M8 3.5v9M3.5 8h9" ${S}/>`,
    send: `<path d="M8 13V3.5M4 7.5l4-4 4 4" ${S}/>`,
    stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor"/>',
    check: `<path class="check-path" d="m3.5 8.5 3 3 6-7" ${S}/>`,
    alert: `<circle cx="8" cy="8" r="5.75" ${S}/><path d="M8 5v3.5M8 10.9v.1" ${S}/>`,
    chev: `<path d="m6 4 4 4-4 4" ${S}/>`,
    down: `<path d="M8 3.5V12M4.5 8.5 8 12l3.5-3.5" ${S}/>`,
    external: `<path d="M9.5 2.5h4v4M13.5 2.5 8 8M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" ${S}/>`,
    clock: `<circle cx="8" cy="8" r="5.75" ${S}/><path d="M8 4.75V8l2.25 1.5" ${S}/>`,
    back: `<path d="M12.5 8h-9M7.5 4 3.5 8l4 4" ${S}/>`,
    copy: `<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" ${S}/><path d="M10.5 3.5v-.25A.75.75 0 0 0 9.75 2.5h-6.5a.75.75 0 0 0-.75.75v6.5c0 .41.34.75.75.75h.25" ${S}/>`,
    up: `<path d="M5.5 7v6.5H3.25a.75.75 0 0 1-.75-.75v-5a.75.75 0 0 1 .75-.75H5.5Zm0 0 2.6-4.3a1.1 1.1 0 0 1 2 .75L9.6 6.5h3a1.2 1.2 0 0 1 1.17 1.46l-1.05 4.55a1.2 1.2 0 0 1-1.17.99H5.5" ${S}/>`,
    down2: `<path d="M5.5 9V2.5H3.25a.75.75 0 0 0-.75.75v5c0 .41.34.75.75.75H5.5Zm0 0 2.6 4.3a1.1 1.1 0 0 0 2-.75L9.6 9.5h3a1.2 1.2 0 0 0 1.17-1.46l-1.05-4.55A1.2 1.2 0 0 0 11.55 2.5H5.5" ${S}/>`,
  };
  const svg = (name, cls = '') => {
    const t = document.createElement('template');
    t.innerHTML = `<svg class="icon${cls ? ` ${cls}` : ''}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
    return t.content.firstChild;
  };
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    n.append(...kids.filter((x) => x !== null && x !== undefined && x !== false));
    return n;
  };

  // ---------------------------------------------------------------- markdown

  // Same-origin hub pages and github.com only; anything else stays text.
  function safeHref(u) {
    if (typeof u !== 'string') return null;
    if (/^\/(hub|w)\/[^\s]*$/.test(u) && !u.startsWith('//')) return { href: u, external: false };
    if (/^https:\/\/github\.com\/[^\s]*$/.test(u)) return { href: u, external: true };
    return null;
  }

  function inline(text, into) {
    const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\s][^*\n]*\*)|(_[^_\s][^_\n]*_)/g;
    let at = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index > at) into.append(text.slice(at, m.index));
      const t = m[0];
      if (m[1]) into.append(el('code', { text: t.slice(1, -1) }));
      else if (m[2]) inline(t.slice(2, -2), into.appendChild(el('strong')));
      else if (m[3]) {
        const [, label, url] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t);
        const ok = safeHref(url);
        if (ok) {
          const a = el('a', { href: ok.href, class: 'link', ...(ok.external ? { target: '_blank', rel: 'noopener noreferrer' } : {}) });
          inline(label, a);
          into.append(a);
        } else inline(label, into);
      } else inline(t.slice(1, -1), into.appendChild(el('em')));
      at = m.index + t.length;
    }
    if (at < text.length) into.append(text.slice(at));
    return into;
  }

  function codeBlock(code, lang) {
    const pre = el('pre', { class: 'agent-code', 'aria-label': lang ? `${lang} code` : 'Code' }, el('code', { text: code }));
    const btn = el('button', { class: 'agent-copy', type: 'button', text: 'Copy', 'aria-label': 'Copy code' });
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = isMac ? 'Press ⌘C' : 'Press Ctrl+C';
      }
      btn.classList.add('is-done');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('is-done'); }, 1600);
    });
    return el('div', { class: 'agent-code-wrap' }, pre, btn);
  }

  function markdown(src) {
    const out = document.createDocumentFragment();
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
      if (fence) {
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
        i++;
        out.append(codeBlock(body.join('\n'), fence[1]));
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        out.append(inline(h[2], el(h[1].length <= 2 ? 'h3' : 'h4')));
        i++;
        continue;
      }
      if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const table = el('table');
        const head = el('tr');
        for (const c of cells(line)) head.append(inline(c, el('th')));
        table.append(el('thead', {}, head));
        const body = el('tbody');
        i += 2;
        while (i < lines.length && isTableRow(lines[i])) {
          const tr = el('tr');
          for (const c of cells(lines[i++])) tr.append(inline(c, el('td')));
          body.append(tr);
        }
        table.append(body);
        out.append(el('div', { class: 'agent-table' }, table));
        continue;
      }
      const ul = /^\s*[-*•]\s+/;
      const ol = /^\s*\d+[.)]\s+/;
      if (ul.test(line) || ol.test(line)) {
        const ordered = ol.test(line);
        const list = el(ordered ? 'ol' : 'ul');
        while (i < lines.length && (ordered ? ol : ul).test(lines[i])) {
          list.append(inline(lines[i].replace(ordered ? ol : ul, ''), el('li')));
          i++;
        }
        out.append(list);
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        const q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.append(inline(q.join(' '), el('blockquote')));
        continue;
      }
      const para = [lines[i++]]; // at least one line, so the loop always moves on
      while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !ul.test(lines[i]) && !ol.test(lines[i]) && !(isTableRow(lines[i]) && para.length === 0 && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]))) para.push(lines[i++]);
      const p = el('p');
      para.forEach((l, j) => {
        if (j) p.append(el('br'));
        inline(l, p);
      });
      out.append(p);
    }
    return out;
  }

  // While text streams it is drawn as markdown on every frame, with a link
  // still being written shown as its label only (never a raw URL), and the
  // characters new since the last frame fading in at the end.
  const cleanTail = (t) => t.replace(/\[([^\]\n]*)\]\([^)\s]*$/, '$1').replace(/\[([^\]\n]*)$/, '$1');
  // chunks: [{ n, at }] the recent arrivals, oldest first. Each one's
  // characters at the end of the last text node fade in, continuing from
  // where they were (a negative delay), so redrawing never restarts a fade.
  function fadeTail(root, chunks, now) {
    if (reduced() || !chunks.length) return;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = null;
    while (walk.nextNode()) if (walk.currentNode.nodeValue && !walk.currentNode.parentElement?.closest('.agent-copy')) node = walk.currentNode;
    for (let i = chunks.length - 1; i >= 0 && node && node.nodeValue.length; i--) {
      const keep = Math.max(0, node.nodeValue.length - chunks[i].n);
      const tail = keep ? node.splitText(keep) : node;
      const span = el('span', { class: 'ag-tok' });
      span.style.animationDelay = `${-Math.round(now - chunks[i].at)}ms`;
      tail.replaceWith(span);
      span.append(tail);
      if (!keep) break;
    }
  }

  // ---------------------------------------------------------------- page context

  function pageContext() {
    // The review desk of a cloud workspace: /w/<team>/<workspace>/.
    const w = /^\/w\/[^/]+\/([^/]+)\//.exec(location.pathname);
    if (w) {
      let name = w[1];
      try { name = decodeURIComponent(name); } catch {}
      return { kind: 'workspace', workspace_name: name };
    }
    const m = /^\/hub\/teams\/([^/]+)(?:\/(.*))?$/.exec(location.pathname);
    if (!m) return { kind: 'overview' };
    const parts = (m[2] || '').split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
    if (parts[0] === 'repos' && parts[1] && parts[2] === 'runs' && parts[3]) return { kind: 'run', repo_id: parts[1], run: parts[3], machine: new URLSearchParams(location.search).get('machine') || undefined };
    if (parts[0] === 'repos' && parts[1]) return { kind: 'repo', repo_id: parts[1] };
    if (parts[0] === 'workspaces' && parts[1]) return { kind: 'workspace', workspace_id: parts[1] };
    return { kind: parts[0] || 'overview' };
  }

  const STARTERS = {
    run: ['Summarize this run', 'Which files did it change, and are they still in the tree?', 'Is anything in this run risky to approve?'],
    repo: ['Which runs in this repo need review?', 'Who changed this repo most this week?', 'Which agents are working here right now?'],
    workspace: ['What changed in this workspace today?', 'List the files in this workspace', 'Create a read-only token for an agent'],
    reviews: ['What needs my review first?', 'Which pull requests fail the Grapim check?', 'Summarize the newest run waiting for review'],
    reports: ['What is our AI share over the last 12 weeks?', 'Which agent kind writes the most lines?', 'How many AI lines were merged without review?'],
    settings: ['Who is on the team, and who are the owners?', 'Which machine tokens exist?', 'Create an invite link'],
    workspaces: ['Which workspace was busiest this week?', 'List every workspace token by name', 'Rename a workspace'],
    overview: ['What needs my review?', 'Which pull requests fail the Grapim check?', 'Which agents are active right now?'],
  };

  function contextLabel(ctx) {
    const title = (document.querySelector('.crumbs .crumb.current')?.textContent || document.title.replace(/\s*·\s*Grapim$/, '')).trim();
    const names = { run: 'Run', repo: 'Repo', workspace: 'Workspace', reviews: 'Approvals', reports: 'Reports', settings: 'Settings', workspaces: 'Workspaces', repos: 'Repos', overview: 'Overview' };
    const kind = names[ctx.kind] ?? 'Page';
    return ctx.kind === 'run' || ctx.kind === 'repo' || ctx.kind === 'workspace' ? `${kind} · ${title}` : kind;
  }

  // ---------------------------------------------------------------- the panel

  function wire() {
    const panel = document.getElementById('agent');
    if (!panel) {
      delete root.dataset.agent;
      return;
    }
    const team = panel.dataset.team;
    const csrf = panel.dataset.csrf;
    const configured = panel.dataset.configured === '1';
    const api = `/hub/api/teams/${encodeURIComponent(team)}/agent`;
    const ctx = pageContext();
    const state = { loaded: false, busy: false, items: [], usage: null, enabled: configured, reader: null, conv: null, feedback: {}, history: false };

    // Header.
    const newBtn = el('button', { class: 'agent-icon-btn', type: 'button', 'aria-label': 'New conversation', title: 'New conversation' }, svg('plus'));
    const historyBtn = el('button', { class: 'agent-icon-btn', type: 'button', 'aria-label': 'Past conversations', title: 'Past conversations', 'aria-pressed': 'false' }, svg('clock'));
    const backBtn = el('button', { class: 'agent-icon-btn agent-back', type: 'button', 'aria-label': 'Back to the conversation', title: 'Back', hidden: true }, svg('back'));
    const closeBtn = el('button', { class: 'agent-icon-btn', type: 'button', 'aria-label': 'Close Ask Grapim', title: `Close  ${isMac ? '⌘' : 'Ctrl'} J` }, svg('x'));
    // The title names the conversation once there is one; "Working…" shows while it answers.
    const titleText = el('span', { class: 'agent-title-text', text: 'Ask Grapim' });
    const status = el('span', { class: 'agent-status ag-shimmer', 'aria-hidden': 'true', text: 'Working…' });
    const head = el('header', { class: 'agent-head' },
      el('div', { class: 'agent-head-start' }, backBtn, el('h2', { class: 'agent-title', id: 'agent-title' }, svg('spark', 'agent-mark'), titleText)),
      el('div', { class: 'agent-head-actions' }, status, configured ? historyBtn : null, configured ? newBtn : null, closeBtn));
    function setTitle(text) {
      const t = String(text || '').replace(/\s+/g, ' ').trim();
      titleText.textContent = t ? (t.length > 48 ? `${t.slice(0, 47)}…` : t) : 'Ask Grapim';
      titleText.title = t || '';
      panel.classList.toggle('has-conv', !!t);
      input.placeholder = t ? 'Ask a follow-up…' : 'Ask about runs, reviews, workspaces…';
    }

    // The conversation.
    const log = el('div', { class: 'agent-log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-labelledby': 'agent-title', tabindex: '0' });
    const jump = el('button', { class: 'agent-jump', type: 'button', hidden: true }, svg('down'), 'Jump to latest');
    const body = el('div', { class: 'agent-body' }, log, jump);

    // The composer: the page chip, the field, send that turns into stop.
    const input = el('textarea', { class: 'agent-input', rows: '1', placeholder: 'Ask about runs, reviews, workspaces…', 'aria-label': 'Message Ask Grapim', maxlength: '4000', spellcheck: 'true' });
    const send = el('button', { class: 'agent-send', type: 'submit', 'aria-label': 'Send' }, el('span', { class: 'agent-send-icons', 'aria-hidden': 'true' }, svg('send', 'i-send'), svg('stop', 'i-stop')));
    const chip = el('span', { class: 'agent-chip', title: 'Ask Grapim sees the page you are on' }, el('span', { class: 'agent-chip-dot', 'aria-hidden': 'true' }), contextLabel(ctx));
    const foot = el('p', { class: 'agent-foot' });
    const modelTag = el('span', { class: 'agent-model', title: 'The model answering' });
    const form = el('form', { class: 'agent-compose' }, el('div', { class: 'agent-field' }, el('div', { class: 'agent-field-top' }, chip, modelTag), el('div', { class: 'agent-row' }, input, send)), foot);

    const resize = el('div', { class: 'agent-resize', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize Ask Grapim', 'aria-valuemin': String(MIN), 'aria-valuemax': String(MAX), 'aria-valuenow': String(width()), tabindex: '0', title: 'Drag to resize, double-click to reset' });
    panel.append(resize, el('div', { class: 'agent-card' }, head, body, ...(configured ? [form] : [])));
    panel.setAttribute('aria-labelledby', 'agent-title');
    panel.removeAttribute('aria-label');

    // ------------------------------------------------ open, close, resize

    const toggles = () => document.querySelectorAll('[data-action="agent"]');
    function setOpen(open, { focus = true } = {}) {
      pref = { ...read(), open };
      save(pref);
      for (const b of toggles()) b.setAttribute('aria-expanded', String(open));
      clearTimeout(panel._t);
      if (open) {
        panel.hidden = false;
        panel.classList.remove('is-out');
        void panel.offsetWidth;
        root.dataset.agent = 'open';
        panel.classList.add('is-in');
        if (!state.loaded) load();
        if (focus) setTimeout(() => (configured ? input : closeBtn).focus({ preventScroll: true }), reduced() ? 0 : 60);
      } else {
        panel.classList.remove('is-in');
        panel.classList.add('is-out');
        delete root.dataset.agent;
        const done = () => {
          if (panel.classList.contains('is-out')) panel.hidden = true;
        };
        panel._t = setTimeout(done, reduced() ? 0 : 260);
        const back = document.querySelector('.ask-btn') || document.querySelector('[data-action="agent"]');
        if (focus && panel.contains(document.activeElement)) back?.focus({ preventScroll: true });
      }
    }
    const isOpen = () => !panel.hidden && !panel.classList.contains('is-out');
    const toggle = () => setOpen(!isOpen());

    document.addEventListener('click', (e) => {
      const b = e.target.closest?.('[data-action="agent"]');
      if (!b || b.closest('template')) return;
      e.preventDefault();
      for (const d of document.querySelectorAll('details[data-menu][open]')) d.open = false;
      toggle();
    });
    document.addEventListener('grapim:action', (e) => {
      if (e.detail === 'agent') setOpen(true);
    });
    closeBtn.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        if (document.querySelector('dialog[open]')) return;
        e.preventDefault();
        toggle();
        return;
      }
      if (e.key === 'Escape' && isOpen() && panel.contains(e.target) && !e.defaultPrevented) {
        e.preventDefault();
        setOpen(false);
      }
    });

    let dragging = false, startX = 0, startW = 0;
    resize.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true; startX = e.clientX; startW = width();
      resize.setPointerCapture(e.pointerId);
      root.dataset.resizing = '';
      e.preventDefault();
    });
    resize.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      pref = { ...pref, w: clamp(startW - (e.clientX - startX)) };
      root.style.setProperty('--agent-w', `${width()}px`);
      resize.setAttribute('aria-valuenow', String(width()));
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      delete root.dataset.resizing;
      save({ ...read(), w: width() });
    };
    resize.addEventListener('pointerup', end);
    resize.addEventListener('pointercancel', end);
    const setW = (w) => {
      pref = { ...read(), w: clamp(w) };
      save(pref);
      root.style.setProperty('--agent-w', `${width()}px`);
      resize.setAttribute('aria-valuenow', String(width()));
    };
    resize.addEventListener('dblclick', () => setW(DEFAULT));
    resize.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        setW(width() + (e.key === 'ArrowLeft' ? 16 : -16));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setW(DEFAULT);
      }
    });

    // ------------------------------------------------ scrolling

    let pinned = true;
    const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    log.addEventListener('scroll', () => {
      pinned = nearBottom();
      if (pinned) jump.hidden = true;
    });
    function follow() {
      if (pinned) log.scrollTop = log.scrollHeight;
      else jump.hidden = false;
    }
    jump.addEventListener('click', () => {
      pinned = true;
      log.scrollTo({ top: log.scrollHeight, behavior: reduced() ? 'auto' : 'smooth' });
      jump.hidden = true;
    });

    // ------------------------------------------------ drawing

    function userMsg(text, live) {
      return el('div', { class: `ag-msg msg-user${live ? ' is-live' : ''}` }, el('p', { text }));
    }

    function textMsg(text, live) {
      const n = el('div', { class: `ag-msg msg-text agent-md${live ? ' is-live' : ''}` });
      n._raw = text;
      n.append(markdown(text));
      return n;
    }

    // Under the last text of each answer: Copy, and a thumbs up or down that
    // is kept (per question) to see where answers go wrong.
    function decorateAnswers() {
      for (const r of log.querySelectorAll('.ag-answer-actions')) r.remove();
      if (!state.conv) return;
      let turn = 0;
      let lastText = null;
      const flushTurn = () => {
        if (lastText && turn > 0) lastText.after(answerActions(turn, lastText));
        lastText = null;
      };
      for (const n of [...log.children]) {
        if (n.classList.contains('msg-user')) { flushTurn(); turn++; }
        else if (n.classList.contains('msg-text') && !n.classList.contains('is-streaming')) lastText = n;
      }
      flushTurn();
    }

    function answerActions(turn, textNode) {
      const row = el('div', { class: 'ag-answer-actions' });
      const copy = el('button', { class: 'ag-act-btn', type: 'button', 'aria-label': 'Copy answer', title: 'Copy' }, svg('copy'));
      copy.addEventListener('click', async () => {
        const text = [];
        for (let n = textNode; n && !n.classList.contains('msg-user'); n = n.previousElementSibling) if (n.classList.contains('msg-text')) text.unshift(n._raw ?? n.innerText);
        try { await navigator.clipboard.writeText(text.join('\n\n')); copy.classList.add('is-done'); copy.title = 'Copied'; setTimeout(() => { copy.classList.remove('is-done'); copy.title = 'Copy'; }, 1400); } catch {}
      });
      const rate = (value, icon, label) => {
        const b = el('button', { class: 'ag-act-btn', type: 'button', 'aria-label': label, title: label, 'aria-pressed': String(state.feedback[turn] === value) }, svg(icon));
        b.addEventListener('click', async () => {
          const next = state.feedback[turn] === value ? 0 : value;
          state.feedback[turn] = next;
          for (const x of row.querySelectorAll('[data-rate]')) x.setAttribute('aria-pressed', String(Number(x.dataset.rate) === next));
          row.classList.toggle('is-rated', next !== 0);
          try {
            await fetch(`${api}/feedback`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, conversation: state.conv, turn: String(turn), rating: String(next) }).toString() });
          } catch {}
        });
        b.dataset.rate = String(value);
        return b;
      };
      row.append(copy, rate(1, 'up', 'Good answer'), rate(-1, 'down2', 'Bad answer'));
      if (state.feedback[turn]) row.classList.add('is-rated');
      return row;
    }

    // ------------------------------------------------ past conversations

    function since(ms) {
      const s = Math.max(0, (Date.now() - ms) / 1000);
      if (s < 60) return 'just now';
      if (s < 3600) return `${Math.floor(s / 60)}m ago`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
      return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    function setHistory(on) {
      state.history = on;
      panel.classList.toggle('is-history', on);
      backBtn.hidden = !on;
      historyBtn.setAttribute('aria-pressed', String(on));
      form.hidden = on;
    }

    async function showHistory() {
      if (state.busy) return;
      setHistory(true);
      titleText.textContent = 'Past conversations';
      log.replaceChildren(el('div', { class: 'agent-loading', role: 'status' }, thinkingRow('Loading')));
      let list = [];
      try {
        const res = await fetch(`${api}/conversations`, { credentials: 'same-origin' });
        list = (await res.json()).conversations ?? [];
      } catch {
        log.replaceChildren(noticeMsg('error', 'Could not load past conversations. Try again.'));
        return;
      }
      if (!state.history) return;
      if (!list.length) {
        log.replaceChildren(el('div', { class: 'agent-empty' }, el('h3', { text: 'No conversations yet' }), el('p', { text: 'Questions you ask here are kept, so you can come back to an answer later.' })));
        return;
      }
      const ul = el('ul', { class: 'ag-history', role: 'list' });
      list.forEach((c, i) => {
        const b = el('button', { class: `ag-history-item${c.open ? ' is-current' : ''}`, type: 'button' },
          el('span', { class: 'ag-history-title', text: c.title, title: c.title }),
          el('span', { class: 'ag-history-meta' }, c.open ? el('span', { class: 'ag-history-now', text: 'Current' }) : null, el('span', { text: `${c.questions} ${c.questions === 1 ? 'question' : 'questions'} · ${since(c.updated_at)}` })));
        b.style.setProperty('--i', String(Math.min(i, 12)));
        b.addEventListener('click', () => openConversation(c.id, c.open));
        ul.append(el('li', {}, b));
      });
      log.replaceChildren(ul);
      log.scrollTop = 0;
    }

    async function openConversation(id, isCurrent) {
      if (isCurrent) return closeHistory();
      try {
        const res = await fetch(`${api}/open`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, id }).toString() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'failed');
        setHistory(false);
        state.conv = data.conversation.id;
        state.feedback = data.conversation.feedback ?? {};
        render(data.conversation.items);
        input.focus();
      } catch (e) {
        log.prepend(noticeMsg('error', e.message === 'failed' ? 'Could not open that conversation.' : e.message, true));
      }
    }

    function closeHistory() {
      setHistory(false);
      load();
    }

    function noticeMsg(kind, text, live) {
      return el('div', { class: `ag-msg msg-notice notice-${kind}${live ? ' is-live' : ''}`, role: kind === 'error' ? 'alert' : null }, kind === 'error' || kind === 'refusal' ? svg('alert') : null, el('span', { text }));
    }

    function stepRow(step) {
      const row = el('li', { class: 'ag-step', 'data-status': step.status, 'data-id': step.id || null },
        el('span', { class: 'ag-step-mark', 'aria-hidden': 'true' }, el('span', { class: 'ag-spin' }), svg('check', 'ag-step-check'), svg('x', 'ag-step-x')),
        el('span', { class: 'ag-step-label', text: step.label }));
      return row;
    }

    function stepsGroup(steps, { live = false, open = false } = {}) {
      const list = el('ol', { class: 'ag-steps-list' }, ...steps.map(stepRow));
      const sumText = el('span', { class: 'ag-steps-sum-text' });
      const sum = el('button', { class: 'ag-steps-sum', type: 'button', 'aria-expanded': String(open) }, svg('chev', 'ag-steps-chev'), sumText);
      // A live group starts folded: one shimmering line naming the current step,
      // which opens to the full list (like the finished summary).
      const g = el('div', { class: `ag-steps${live ? ' is-live' : ''}`, 'data-state': live ? 'running' : 'done' }, sum, el('div', { class: 'ag-steps-body' }, el('div', { class: 'ag-steps-inner' }, list)));
      g._list = list;
      g._sum = sumText;
      sum.addEventListener('click', () => {
        const o = sum.getAttribute('aria-expanded') !== 'true';
        sum.setAttribute('aria-expanded', String(o));
        g.classList.toggle('is-open', o);
      });
      if (open) {
        g.classList.add('is-open');
        sum.setAttribute('aria-expanded', 'true');
      }
      summarize(g);
      return g;
    }

    function summarize(g) {
      const rows = [...g._list.children];
      const failed = rows.filter((r) => r.dataset.status === 'error').length;
      // While it runs, the one line says what it is doing now.
      if (g.dataset.state === 'running') {
        const now = rows.filter((r) => r.dataset.status === 'running').pop() ?? rows[rows.length - 1];
        g._sum.textContent = now ? now.querySelector('.ag-step-label').textContent : 'Working…';
        return;
      }
      const label = rows.length === 1 ? rows[0].querySelector('.ag-step-label').textContent : `Looked at ${rows.length} things`;
      g._sum.textContent = failed && rows.length > 1 ? `${label} · ${failed} failed` : label;
    }

    // Collapses a finished group into its one-line summary.
    function settle(g) {
      if (!g || g.dataset.state === 'done') return;
      g.dataset.state = 'done';
      summarize(g);
      g.querySelector('.ag-steps-sum').setAttribute('aria-expanded', 'false');
      g.classList.remove('is-open');
    }

    function actionCard(a, live) {
      const card = el('section', { class: `ag-act${live ? ' is-live' : ''}`, 'data-status': a.status, 'data-kind': a.kind, 'aria-label': a.title });
      draw(card, a);
      return card;
    }

    const DONE = { review: (a) => (a.verb === 'Approve' ? 'Approved' : 'Rejected'), undo: () => 'Undone', invite: () => 'Invite link created', workspace_token: () => 'Token created', rename: () => 'Renamed' };

    function draw(card, a, extra = {}) {
      card.replaceChildren();
      card.dataset.status = a.status;
      if (a.status === 'cancelled') {
        card.append(el('p', { class: 'act-line' }, svg('x'), el('span', { text: `Cancelled: ${a.title}` })));
        return;
      }
      const dl = el('dl', { class: 'act-facts' });
      for (const [k, v] of a.lines || []) dl.append(el('dt', { text: k }), el('dd', { text: v }));
      const head = el('div', { class: 'act-head' },
        el('h3', { class: 'act-title', text: a.title }),
        a.status === 'proposed' ? el('span', { class: 'act-tag', text: 'Needs your OK' }) : null);
      card.append(head, el('p', { class: 'act-effect', text: a.effect }), dl);
      if (a.status === 'proposed') {
        const ok = el('button', { class: `btn btn-sm ${a.danger ? 'btn-danger-solid' : 'btn-primary'} act-ok`, type: 'button' }, el('span', { class: 'ag-spin', 'aria-hidden': 'true' }), el('span', { class: 'act-ok-text', text: a.verb || 'Confirm' }));
        const no = el('button', { class: 'btn btn-sm btn-ghost act-no', type: 'button', text: 'Cancel' });
        ok.addEventListener('click', () => confirmAction(card, a, ok, no));
        no.addEventListener('click', () => decide(card, a, 'cancelled', null));
        card.append(el('div', { class: 'act-buttons' }, ok, no, el('span', { class: 'act-hint', text: 'Nothing changes until you confirm.' })));
      } else if (a.status === 'done') {
        const line = el('p', { class: 'act-result' }, el('span', { class: 'act-done-mark', 'aria-hidden': 'true' }, svg('check')), el('span', { text: `${(DONE[a.kind] ?? (() => 'Done'))(a)}${a.note ? `. ${a.note}` : ''}` }));
        card.append(line);
        if (extra.secret) {
          const id = `agent-secret-${a.id}`;
          const field = el('input', { id, class: 'mono reveal-value', type: 'text', readonly: true, value: extra.secret, 'aria-label': a.kind === 'invite' ? 'Invite link' : 'Token', spellcheck: 'false' });
          const copy = el('button', { class: 'btn btn-sm', type: 'button', text: 'Copy' });
          copy.addEventListener('click', async () => {
            field.select();
            try { await navigator.clipboard.writeText(extra.secret); copy.textContent = 'Copied'; } catch { copy.textContent = isMac ? 'Press ⌘C' : 'Press Ctrl+C'; }
            copy.classList.add('is-done');
            setTimeout(() => { copy.textContent = 'Copy'; copy.classList.remove('is-done'); }, 1600);
          });
          card.append(el('div', { class: 'act-secret' }, field, copy), el('p', { class: 'act-fine', text: `Shown once, here only. Ask Grapim never sees it. Copy it now.` }));
          setTimeout(() => field.select(), 50);
        }
        if (a.link) card.append(linkRow(a.link));
      } else if (a.status === 'failed') {
        card.append(el('p', { class: 'act-result act-failed' }, svg('alert'), el('span', { text: `Not done: ${a.note || 'the hub refused it.'}` })));
      }
    }

    const linkRow = (l) => {
      const ok = safeHref(l.href);
      return ok ? el('p', { class: 'act-link' }, el('a', { class: 'link', href: ok.href, text: l.label })) : null;
    };

    // Sends the confirmed action through the page route that does it.
    async function confirmAction(card, a, ok, no) {
      const r = a.request;
      if (!r || !(r.url.startsWith('/hub/teams/') || r.url.startsWith('/w/')) || r.url.startsWith('//')) return;
      ok.disabled = true;
      no.disabled = true;
      card.classList.add('is-pending');
      ok.setAttribute('aria-busy', 'true');
      let outcome;
      try {
        let res;
        if (r.json) {
          res = await fetch(r.url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Grapim-Csrf': csrf }, body: JSON.stringify(r.json) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.error?.message || `The hub answered ${res.status}.`);
          const n = (data.files || []).filter((f) => f.action && f.action !== 'skip' && f.action !== 'nothing').length;
          outcome = { note: `${n} file${n === 1 ? '' : 's'} put back` };
        } else {
          res = await fetch(r.url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...(r.form || {}), _csrf: csrf }).toString() });
          const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
          const msg = doc.querySelector('.notice-error, .empty-page .lede')?.textContent?.trim();
          if (!res.ok || (msg && !doc.querySelector('.reveal-value') && !r.expect)) throw new Error(msg || `The hub answered ${res.status}.`);
          if (r.expect?.done && new URL(res.url, location.href).searchParams.get('done') !== r.expect.done) throw new Error(msg || 'The hub did not record it.');
          if (r.reveal) {
            const secret = doc.querySelector('.reveal-value')?.value;
            if (!secret) throw new Error(msg || 'The hub did not return it.');
            outcome = { secret };
          } else outcome = {};
        }
      } catch (err) {
        card.classList.remove('is-pending');
        return decide(card, a, 'failed', String(err?.message || 'It did not work.').slice(0, 280));
      }
      card.classList.remove('is-pending');
      card.classList.add('is-confirmed');
      decide(card, a, 'done', outcome.note ?? null, outcome.secret);
    }

    // Records the outcome on the hub (never a secret) and redraws the card.
    async function decide(card, a, status, note, secret = null) {
      const next = { ...a, status, note };
      delete next.request;
      if (status === 'cancelled' && !reduced()) {
        card.classList.add('is-leaving');
        await new Promise((r) => setTimeout(r, 160));
        card.classList.remove('is-leaving');
      }
      draw(card, next, { secret });
      if (status === 'cancelled') card.classList.add('is-cancelled');
      follow();
      try {
        await fetch(`${api}/actions`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, id: a.id, status, ...(note ? { note } : {}) }).toString() });
      } catch {}
    }

    function emptyState() {
      // The public demo: no model behind it, a note on what it does instead.
      if (panel.dataset.demo === '1') {
        return el('div', { class: 'agent-empty agent-off' },
          el('span', { class: 'agent-empty-mark', 'aria-hidden': 'true' }, svg('spark')),
          el('h3', { text: 'Ask Grapim is off in the demo' }),
          el('p', { text: 'In your own team it answers questions about runs, reviews and workspaces, starting from the page you are on, and prepares approvals, undos and tokens for you to confirm.' }),
          el('p', { class: 'agent-fine' }, el('a', { href: '/hub/login', text: 'Sign in with GitHub' }), ' to try it on your repos.'));
      }
      if (!configured) {
        const owner = panel.dataset.role === 'owner';
        return el('div', { class: 'agent-empty agent-off' },
          el('span', { class: 'agent-empty-mark', 'aria-hidden': 'true' }, svg('spark')),
          el('h3', { text: 'Ask Grapim isn’t set up on this hub yet' }),
          el('p', { text: 'Once it is, anyone in the team can ask about runs, reviews and workspaces here, and have it prepare approvals, undos and tokens for them to confirm.' }),
          owner ? el('p', { class: 'agent-fine' }, 'To turn it on, set ', el('code', { text: 'ANTHROPIC_API_KEY' }), ' on the hub’s server and redeploy. Members don’t see Ask Grapim until then.') : null);
      }
      const box = el('div', { class: 'agent-empty' },
        el('span', { class: 'agent-empty-mark', 'aria-hidden': 'true' }, svg('spark')),
        el('h3', { text: 'What do you want to know?' }),
        el('p', { text: 'Ask Grapim sees what you can see in this team, starting with this page. It can prepare approvals, undos, invite links and tokens; nothing happens until you confirm.' }));
      const list = el('div', { class: 'agent-starters', role: 'list' });
      (STARTERS[ctx.kind] ?? STARTERS.overview).forEach((s, i) => {
        const b = el('button', { class: 'agent-starter', type: 'button', role: 'listitem', text: s });
        b.style.setProperty('--i', String(i));
        b.addEventListener('click', () => ask(s));
        list.append(b);
      });
      box.append(list);
      return box;
    }

    function render(items) {
      log.replaceChildren();
      setTitle(items.find((it) => it.type === 'user')?.text);
      if (!items.length) {
        log.append(emptyState());
        return;
      }
      for (const it of items) {
        if (it.type === 'user') log.append(userMsg(it.text));
        else if (it.type === 'text') log.append(textMsg(it.text));
        else if (it.type === 'notice') log.append(noticeMsg(it.kind, it.text));
        else if (it.type === 'steps') log.append(stepsGroup(it.steps));
        else if (it.type === 'action') log.append(actionCard(it.action));
      }
      decorateAnswers();
      pinned = true;
      log.scrollTop = log.scrollHeight;
    }

    // The team's monthly credit: "$0.12 of $1.00 this month" and a hairline bar.
    function setUsage(u) {
      state.usage = u || state.usage;
      foot.replaceChildren();
      const s = state.usage;
      if (s && typeof s.budget === 'number') {
        const pct = s.budget > 0 ? Math.min(1, s.spent / s.budget) : 1;
        const fill = el('span', { class: 'agent-meter-fill' });
        fill.style.transform = `scaleX(${pct})`;
        const meter = el('span', { class: `agent-meter${pct >= 0.9 ? ' is-high' : ''}`, 'aria-hidden': 'true' }, fill);
        const when = new Date(s.resets_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
        foot.append(el('span', { class: 'agent-usage', title: `Team credit for Ask Grapim. Renews ${when}.` }, meter, el('span', { class: 'num', text: `$${s.spent.toFixed(2)} of $${s.budget.toFixed(2)} this month` })), el('span', { class: 'sep', 'aria-hidden': 'true', text: '·' }));
      }
      foot.append(el('span', { text: 'It can be wrong. Actions wait for your OK.' }));
    }

    function setBusy(b) {
      state.busy = b;
      panel.classList.toggle('is-busy', b);
      if (b && titleText.textContent === 'Ask Grapim') setTitle(log.querySelector('.msg-user')?.textContent);
      send.setAttribute('aria-label', b ? 'Stop' : 'Send');
      send.title = b ? 'Stop' : 'Send  Enter';
      newBtn.disabled = b;
    }

    // ------------------------------------------------ loading

    async function load() {
      state.loaded = true;
      if (!configured) {
        log.replaceChildren(emptyState());
        return;
      }
      log.replaceChildren(el('div', { class: 'agent-loading', role: 'status' }, thinkingRow('Loading')));
      try {
        const res = await fetch(api, { credentials: 'same-origin' });
        const data = await res.json();
        if (!data.enabled) {
          log.replaceChildren(emptyState());
          return;
        }
        setUsage(data.usage);
        state.conv = data.conversation?.id ?? null;
        state.feedback = data.conversation?.feedback ?? {};
        if (data.model_label) modelTag.textContent = data.model_label;
        render(data.conversation?.items ?? []);
        if (data.running) waitForRun();
      } catch {
        log.replaceChildren(noticeMsg('error', 'Ask Grapim could not load. Reload the page to try again.'));
        state.loaded = false;
      }
    }

    // An answer still being written (started on another page): wait for it.
    function waitForRun() {
      setBusy(true);
      const t = thinkingRow('Still working on your last message');
      log.append(t);
      follow();
      const poll = async () => {
        try {
          const data = await (await fetch(api, { credentials: 'same-origin' })).json();
          if (data.running) return setTimeout(poll, 1500);
          setBusy(false);
          setUsage(data.usage);
          render(data.conversation?.items ?? []);
        } catch {
          setTimeout(poll, 3000);
        }
      };
      setTimeout(poll, 1200);
    }

    // Before the first token or step: one quiet shimmering line, in the same
    // place the steps line will take over.
    function thinkingRow(label = 'Thinking…') {
      return el('div', { class: 'ag-thinking', role: 'status' }, svg('chev', 'ag-steps-chev'), el('span', { class: 'ag-shimmer', text: label }));
    }

    // ------------------------------------------------ sending

    async function ask(text) {
      text = String(text).trim();
      if (!text || state.busy || !configured) return;
      if (!isOpen()) setOpen(true, { focus: false });
      if (!state.loaded) await load();
      if (state.busy) return;
      log.querySelector('.agent-empty')?.remove();
      log.append(userMsg(text, true));
      input.value = '';
      grow();
      pinned = true;
      const thinking = thinkingRow();
      log.append(thinking);
      follow();
      setBusy(true);

      let res;
      try {
        res = await fetch(`${api}/messages`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ _csrf: csrf, text, context: JSON.stringify(ctx) }).toString(),
        });
      } catch {
        thinking.remove();
        log.append(noticeMsg('error', 'Could not reach the hub. Check your connection and try again.', true));
        retryRow(text);
        setBusy(false);
        return;
      }
      if (!res.ok || !(res.headers.get('content-type') || '').startsWith('text/event-stream')) {
        let msg = `The hub answered ${res.status}.`;
        let code = null;
        try {
          const j = await res.json();
          msg = j.error?.message || msg;
          code = j.error?.code;
        } catch {}
        thinking.remove();
        log.append(noticeMsg(code === 'agent_limit' ? 'limit' : 'error', msg, true));
        if (code === 'conversation_full') log.append(el('p', { class: 'msg-actions' }, newConvButton()));
        else if (code !== 'agent_limit') retryRow(text);
        setBusy(false);
        follow();
        return;
      }

      let current = null; // the text node being streamed into
      let group = null; // the open steps group
      const steps = new Map();
      let raf = 0;
      let failed = false;
      const clearThinking = () => thinking.isConnected && thinking.remove();
      const flush = () => {
        raf = 0;
        if (!current) return;
        const t = performance.now();
        const n = current._text.length - current._len;
        current._len = current._text.length;
        if (n > 0) current._chunks.push({ n, at: t });
        current._chunks = current._chunks.filter((c) => t - c.at < 260);
        current.replaceChildren(markdown(cleanTail(current._text)));
        fadeTail(current, current._chunks, t);
        follow();
        // Keep drawing while the newest characters are still fading.
        if (current._chunks.length && !raf) raf = requestAnimationFrame(flush);
      };
      const finishText = () => {
        if (!current) return;
        cancelAnimationFrame(raf);
        raf = 0;
        const n = textMsg(current._text);
        current.replaceWith(n);
        current = null;
      };

      const on = {
        start(d) {
          if (d.conversation && d.conversation !== state.conv) { state.conv = d.conversation; state.feedback = {}; }
        },
        text(d) {
          clearThinking();
          if (group) {
            settle(group);
            group = null;
          }
          if (!current) {
            current = el('div', { class: 'ag-msg msg-text agent-md is-live is-streaming' });
            current._text = '';
            current._len = 0;
            current._chunks = [];
            log.append(current);
          }
          current._text += d.text;
          if (!raf) raf = requestAnimationFrame(flush);
        },
        step(d) {
          clearThinking();
          if (d.status === 'running') {
            finishText();
            if (!group) {
              group = stepsGroup([], { live: true });
              log.append(group);
            }
            const row = stepRow({ id: d.id, label: d.label, status: 'running' });
            row.classList.add('is-live');
            steps.set(d.id, row);
            group._list.append(row);
            summarize(group);
          } else {
            const row = steps.get(d.id);
            if (row) {
              row.dataset.status = d.status;
              row.querySelector('.ag-step-label').textContent = d.label;
              if (group) summarize(group);
            }
          }
          follow();
        },
        action(d) {
          clearThinking();
          const row = steps.get(d.step);
          if (row) {
            row.remove();
            steps.delete(d.step);
          }
          if (group && !group._list.children.length) {
            group.remove();
            group = null;
          } else if (group) settle(group);
          group = null;
          finishText();
          log.append(actionCard(d.action, true));
          follow();
        },
        notice(d) {
          clearThinking();
          finishText();
          if (group) settle(group);
          group = null;
          if (d.kind === 'error') failed = true;
          log.append(noticeMsg(d.kind, d.text, true));
          follow();
        },
        done(d) {
          setUsage(d.usage);
        },
      };

      const reader = res.body.getReader();
      state.reader = reader;
      const decoder = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event: (\w+)$/m.exec(chunk)?.[1];
            const data = /^data: (.*)$/m.exec(chunk)?.[1];
            if (!ev || !data || !on[ev]) continue;
            try { on[ev](JSON.parse(data)); } catch {}
          }
        }
      } catch {
        // The connection dropped (sleep, network): the answer keeps going on the hub.
        clearThinking();
        finishText();
        state.reader = null;
        waitForRun();
        return;
      }
      state.reader = null;
      clearThinking();
      finishText();
      if (group) settle(group);
      if (failed) retryRow(text);
      setBusy(false);
      decorateAnswers();
      follow();
    }

    function retryRow(text) {
      const b = el('button', { class: 'btn btn-sm', type: 'button', text: 'Retry' });
      b.addEventListener('click', () => {
        row.remove();
        ask(text);
      });
      const row = el('p', { class: 'msg-actions' }, b);
      log.append(row);
    }

    function newConvButton() {
      const b = el('button', { class: 'btn btn-sm', type: 'button' }, svg('plus'), 'New conversation');
      b.addEventListener('click', newConversation);
      return b;
    }

    async function stop() {
      try {
        await fetch(`${api}/stop`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf }).toString() });
      } catch {}
    }

    async function newConversation() {
      if (state.busy) return;
      try {
        await fetch(`${api}/new`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf }).toString() });
      } catch {}
      state.conv = null;
      state.feedback = {};
      setHistory(false);
      render([]);
      input.focus();
    }

    // The field grows with its text, up to a limit.
    function grow() {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    }

    if (configured) {
      setUsage(null);
      input.addEventListener('input', grow);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          form.requestSubmit();
        }
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (state.busy) stop();
        else ask(input.value);
      });
      newBtn.addEventListener('click', newConversation);
      historyBtn.addEventListener('click', () => (state.history ? closeHistory() : showHistory()));
      backBtn.addEventListener('click', closeHistory);
      // "Ask about this run" and other prompts a page offers.
      for (const b of document.querySelectorAll('[data-agent-ask]')) {
        b.hidden = false;
        b.addEventListener('click', () => ask(b.dataset.agentAsk));
      }
    }

    for (const b of toggles()) b.setAttribute('aria-expanded', String(!!pref.open));
    if (pref.open && !narrow()) {
      panel.hidden = false;
      load();
    } else if (pref.open) {
      // A phone keeps the page in front after a navigation.
      delete root.dataset.agent;
      save({ ...read(), open: false });
      for (const b of toggles()) b.setAttribute('aria-expanded', 'false');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
