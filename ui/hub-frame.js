// The hub's frame around a cloud workspace's desk (/w/<team>/<workspace>/):
// the same top bar as every team page (Team / Workspaces / name on the left,
// Ask Grapim on the right), the brand linking back to the team, and the Ask
// Grapim panel itself (the hub's /hub/static/agent.js and agent.css).
// Only on the hub, never in an embed or under `grapim serve`. DOM only, no
// inline code: the desk's CSP allows scripts and styles from this origin.

const SPARK = '<svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M7 2.5c.35 2.55 1.45 3.65 4 4-2.55.35-3.65 1.45-4 4-.35-2.55-1.45-3.65-4-4 2.55-.35 3.65-1.45 4-4Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M12 10.25c.15 1.05.7 1.6 1.75 1.75-1.05.15-1.6.7-1.75 1.75-.15-1.05-.7-1.6-1.75-1.75 1.05-.15 1.6-.7 1.75-1.75Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.filter(Boolean));
  return n;
};
const fromSvg = (s) => {
  const t = document.createElement('template');
  t.innerHTML = s;
  return t.content.firstChild;
};

export async function mountHubFrame() {
  const m = /^\/w\/([^/]+)\/([^/]+)\//.exec(location.pathname);
  if (!m || document.documentElement.classList.contains('embed')) return;
  const [, teamId, wsRaw] = m;
  let wsName = wsRaw;
  try { wsName = decodeURIComponent(wsRaw); } catch {}
  const teamBase = `/hub/teams/${teamId}`;

  let me = null;
  let agent = null;
  try {
    const [a, b] = await Promise.all([
      fetch('/hub/api/me', { credentials: 'same-origin' }),
      fetch(`/hub/api/teams/${teamId}/agent`, { credentials: 'same-origin' }),
    ]);
    me = a.ok ? await a.json() : null;
    agent = b.ok ? await b.json() : null;
  } catch {}
  const team = me?.teams?.find((t) => t.id === teamId);

  // The brand goes back to the team, like the hub's sidebar.
  const brand = document.querySelector('.sidebar .brand');
  if (brand && brand.tagName !== 'A') {
    const a = el('a', { class: brand.className, href: teamBase, 'aria-label': `Back to ${team?.name ?? 'the team'}` });
    a.append(...brand.childNodes);
    brand.replaceWith(a);
  }

  // The top bar: where you are, and Ask Grapim.
  const main = document.querySelector('.app > .main');
  if (!main) return;
  const crumbs = el('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' },
    el('a', { class: 'crumb', href: teamBase, text: team?.name ?? 'Team' }),
    el('span', { class: 'slash', 'aria-hidden': 'true', text: '/' }),
    el('a', { class: 'crumb', href: `${teamBase}/workspaces`, text: 'Workspaces' }),
    el('span', { class: 'slash', 'aria-hidden': 'true', text: '/' }),
    el('span', { class: 'crumb current', 'aria-current': 'page', text: wsName }));
  const actions = el('div', { class: 'main-bar-actions' });
  const bar = el('header', { class: 'main-bar' }, crumbs, actions);
  const topbar = main.querySelector('.topbar');
  if (topbar) topbar.after(bar);
  else main.prepend(bar);

  const link = el('link', { rel: 'stylesheet', href: '/hub/static/agent.css' });
  document.head.append(link);

  // Ask Grapim: shown when the hub has it for this person (members only once it is set up).
  if (!agent || !(agent.enabled || agent.visible) || !me?.csrf) return;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const ask = el('button', { class: 'ask-btn', type: 'button', 'data-action': 'agent', 'aria-controls': 'agent', 'aria-expanded': 'false' },
    fromSvg(SPARK), el('span', { text: 'Ask Grapim' }), el('kbd', { text: isMac ? '⌘' : 'Ctrl' }), el('kbd', { text: 'J' }));
  actions.append(ask);
  // On phones, next to the desk's own top bar buttons.
  const row = document.querySelector('.topbar .topbar-row');
  if (row) {
    const icon = el('button', { class: 'icon-btn agent-top', type: 'button', 'data-action': 'agent', 'aria-controls': 'agent', 'aria-expanded': 'false', 'aria-label': 'Ask Grapim' }, fromSvg(SPARK));
    const last = row.querySelector('[data-action="palette"]');
    if (last) last.after(icon);
    else row.append(icon);
  }
  const panel = el('aside', {
    class: 'agent-panel', id: 'agent', 'aria-label': 'Ask Grapim', tabindex: '-1', hidden: true,
    'data-team': teamId, 'data-csrf': me.csrf, 'data-configured': agent.configured ? '1' : '0', 'data-role': team?.role ?? 'member',
  });
  document.querySelector('.app').append(panel);
  // Load the panel once its styles are in, so it never flashes unstyled.
  const start = () => document.head.append(el('script', { src: '/hub/static/agent.js' }));
  if (link.sheet) start();
  else { link.addEventListener('load', start, { once: true }); link.addEventListener('error', start, { once: true }); }
}
