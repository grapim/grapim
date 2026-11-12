// The page shell. A team page gets the app shell, the same as the review
// desk's: a left sidebar (team switcher, search, the team's sections, you and
// Sign out) that collapses to a top bar with a menu on narrow screens, then
// breadcrumbs and the page. Other pages (sign in, the team list, invites,
// errors) get a plain top bar. No inline script or style anywhere (the CSP
// forbids both); behaviour lives in /hub/static/hub.js.

import { date, html } from './html.js';
import { icon, LOGO } from './icons.js';

export function csrfField(csrf) {
  return html`<input type="hidden" name="_csrf" value="${csrf}">`;
}

function avatar(user, size = 20) {
  return user.avatar_url
    ? html`<img class="avatar" src="${`${user.avatar_url}${user.avatar_url.includes('?') ? '&' : '?'}s=${size * 2}`}" width="${size}" height="${size}" alt="">`
    : html`<span class="avatar avatar-blank" aria-hidden="true">${user.login.slice(0, 1).toUpperCase()}</span>`;
}
export { avatar };

// The settings page's sections (anchors on one page, with a scroll-spy).
// owner: shown to owners only.
export const SETTINGS_SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'members', label: 'Members & invites' },
  { id: 'tokens', label: 'Machine tokens' },
  { id: 'billing', label: 'Billing' },
  { id: 'ask-grapim', label: 'Ask Grapim' },
  { id: 'github', label: 'GitHub', owner: true },
  { id: 'storage', label: 'Storage', owner: true },
  { id: 'platform', label: 'Platform', owner: true },
  { id: 'danger', label: 'Danger zone' },
];

// The team's sections, in sidebar order. g: the second key of its "g" shortcut.
function sections(team, kind = team.kind) {
  const base = `/hub/teams/${team.id}`;
  const list = [
    { id: 'overview', label: 'Overview', href: base, icon: 'home', g: 'o' },
    { id: 'reviews', label: 'Reviews', href: `${base}/reviews`, icon: 'review', g: 'r' },
    { id: 'repos', label: 'Repos', href: `${base}/repos`, icon: 'repo', g: 'p' },
    { id: 'workspaces', label: 'Workspaces', href: `${base}/workspaces`, icon: 'workspace', g: 'w' },
    { id: 'reports', label: 'Reports', href: `${base}/reports`, icon: 'reports', g: 'a' },
    { id: 'settings', label: 'Settings', href: `${base}/settings`, icon: 'settings', g: 's' },
  ];
  // A platform team (docs/platform.md) gets its API keys, webhooks and usage as a section.
  if (kind === 'platform') list.push({ id: 'platform', label: 'Platform', href: `${base}/platform`, icon: 'external', g: 'f' });
  return list;
}

function currentSection(team, pathname = '') {
  const base = `/hub/teams/${team.id}`;
  const rest = pathname.startsWith(base) ? pathname.slice(base.length).replace(/\/+$/, '') : null;
  if (rest === null) return null;
  if (rest === '') return 'overview';
  const first = rest.split('/')[1];
  if (['settings', 'github', 'storage'].includes(first)) return 'settings';
  return first;
}

const plan = (t) => html`<span class="plan">${t.plan}</span>`;

function teamMenu(shell, team) {
  return html`<p class="menu-label">Your teams</p>
  ${shell.teams.map(
    (t) => html`<a class="menu-item" href="/hub/teams/${t.id}" ${t.id === team.id ? html`aria-current="true"` : ''}>
      <span class="team-mark" aria-hidden="true">${t.name.slice(0, 1).toUpperCase()}</span>
      <span class="menu-text"><span class="menu-title">${t.name}</span><span class="menu-sub">${t.role} · created ${date(t.created_at)}</span></span>
      ${t.id === team.id ? icon('check', 'menu-check') : ''}
    </a>`,
  )}
  <div class="menu-sep" role="separator"></div>
  <a class="menu-item" href="/hub">${icon('updown')}<span class="menu-text"><span class="menu-title">All teams</span></span></a>
  <a class="menu-item" href="/hub#new-team">${icon('plus')}<span class="menu-text"><span class="menu-title">Create a team</span></span></a>`;
}

function navLinks(team, shell, current) {
  const list = sections(team, shell.teams.find((t) => t.id === team.id)?.kind);
  // A page without its own section (Platform before the team is one) is reached from Settings.
  if (!list.some((s) => s.id === current) && current) current = 'settings';
  return list.map(
    (s) => html`<a class="nav-item" href="${s.href}" data-g="${s.g}" ${current === s.id ? html`aria-current="page"` : ''}>${icon(s.icon)}<span class="nav-label">${s.label}</span>${
      s.id === 'reviews' && shell.reviews ? html`<span class="count num" title="${`${shell.reviews} run${shell.reviews === 1 ? '' : 's'} you can review`}">${shell.reviews}</span>` : ''
    }</a>`,
  );
}

// What Ctrl/Cmd K can jump to, as plain links hub.js reads (no inline data).
function paletteSource(team, shell) {
  const base = `/hub/teams/${team.id}`;
  const item = (group, href, label, sub = '', hint = '') => html`<a href="${href}" data-group="${group}" data-sub="${sub}" data-hint="${hint}">${label}</a>`;
  const owner = shell.role === 'owner';
  return html`<template id="palette-src">
  ${sections(team, shell.teams.find((t) => t.id === team.id)?.kind).map((s) => item('Go to', s.href, s.label, '', `g ${s.g}`))}
  ${shell.palette.runs.map((r) => item('Runs to review', `${base}/repos/${r.repo_id}/runs/${encodeURIComponent(r.run)}?machine=${encodeURIComponent(r.machine)}`, r.intent || r.label, `${r.label} · ${r.repo}`))}
  ${shell.palette.repos.map((r) => item('Repos', `${base}/repos/${r.id}`, r.name))}
  ${shell.palette.workspaces.map((w) => item('Workspaces', `${base}/workspaces/${w.id}`, w.name, 'workspace'))}
  ${shell.palette.workspaces.map((w) => item('Workspaces', `/w/${team.id}/${w.name}/`, `Open ${w.name} in the review desk`, 'review desk'))}
  ${SETTINGS_SECTIONS.filter((s) => owner || !s.owner).map((s) => item('Settings', `${base}/settings#${s.id}`, s.label, 'settings'))}
  ${shell.teams.filter((t) => t.id !== team.id).map((t) => item('Switch team', `/hub/teams/${t.id}`, t.name, `${t.role} · created ${date(t.created_at)}`))}
  ${shell.agent ? html`<a href="#" data-action="agent" data-group="Help" data-hint="Ctrl J">Ask Grapim</a>` : ''}
  <a href="#" data-action="help" data-group="Help" data-hint="?">Show keyboard shortcuts</a>
</template>`;
}

function crumbBar(team, crumbs) {
  return html`<nav class="crumbs" aria-label="Breadcrumb">
    <a class="crumb" href="/hub/teams/${team.id}">${team.name}</a>
    ${crumbs.map((c) => html`<span class="slash" aria-hidden="true">/</span>${c.href ? html`<a class="crumb" href="${c.href}">${c.label}</a>` : html`<span class="crumb current" aria-current="page">${c.label}</span>`}`)}
  </nav>`;
}

function head(title) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title ? `${title} · Grapim` : 'Grapim'}</title>
<script src="/hub/static/theme.js"></script>
<script src="/hub/static/sidebar.js"></script>
<link rel="icon" href="/hub/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/hub/static/tokens.css">
<link rel="stylesheet" href="/hub/static/shell.css">
<link rel="stylesheet" href="/hub/static/hub.css">
<link rel="stylesheet" href="/hub/static/agent.css">
<script src="/hub/static/hub.js" defer></script>
<script src="/hub/static/agent.js"></script>
</head>`;
}

// Content width: data tables and diffs use the wide column (true); settings
// and tabbed pages a middle one ('mid'); forms and prose a readable column.
const wrapClass = (wide) => (wide === true ? 'wrap wrap-wide' : wide === 'mid' ? 'wrap wrap-mid' : 'wrap');

// The profile menu (bottom of the sidebar), as Railway, Linear and Vercel do it:
// who you are in this team, its settings, your teams, the theme, Sign out.
function profileMenu({ user, team, me, csrf, shell }) {
  const base = `/hub/teams/${team.id}`;
  const owner = (me.role ?? shell.role) === 'owner';
  const themeBtn = (t, label, ic) => html`<button type="button" data-theme-set="${t}" aria-pressed="false" aria-label="${label} theme" title="${label}">${icon(ic)}</button>`;
  return html`<details class="profile" data-menu>
    <summary class="profile-btn" aria-label="${`Account: ${user.login}. Open menu`}">${avatar(user)}<span class="login">${user.name || user.login}</span>${icon('updown', 'switch-chev')}</summary>
    <div class="menu menu-up profile-menu">
      <div class="profile-card">
        ${plan(me)}
        ${avatar(user, 48)}
        <p class="profile-name">${user.name || user.login}</p>
        <p class="profile-sub">@${user.login} · ${owner ? 'Owner' : 'Member'} of ${team.name}</p>
      </div>
      <a class="menu-item" href="${base}/settings">${icon('settings')}<span class="menu-title">Team settings</span></a>
      <a class="menu-item" href="${base}/settings#billing">${icon('usage')}<span class="menu-title">Plan and usage</span></a>
      <a class="menu-item" href="${base}/settings#tokens">${icon('key')}<span class="menu-title">Machine tokens</span></a>
      <div class="menu-sep" role="separator"></div>
      ${shell.teams.map((t) => html`<a class="menu-item" href="/hub/teams/${t.id}" title="${`${t.name} · ${t.role} · created ${date(t.created_at)}`}" ${t.id === team.id ? html`aria-current="true"` : ''}>
        <span class="team-mark" aria-hidden="true">${t.name.slice(0, 1).toUpperCase()}</span><span class="menu-title">${t.name}${shell.teams.filter((o) => o.name.toLowerCase() === t.name.toLowerCase()).length > 1 ? html` <span class="sha mono">${t.id.slice(0, 6)}</span>` : ''}</span>${t.id === team.id ? icon('check', 'menu-check') : ''}</a>`)}
      <a class="menu-item" href="/hub">${icon('updown')}<span class="menu-title">All teams</span></a>
      <a class="menu-item" href="/hub#new-team">${icon('plus')}<span class="menu-title">Create a team</span></a>
      <div class="menu-sep" role="separator"></div>
      <div class="profile-foot">
        <div class="seg icons theme-seg" role="group" aria-label="Theme">${themeBtn('system', 'System', 'system')}${themeBtn('light', 'Light', 'sun')}${themeBtn('dark', 'Dark', 'moon')}</div>
        <form method="post" action="/hub/logout">${csrfField(csrf)}<button class="signout" type="submit">Sign out${icon('power')}</button></form>
      </div>
    </div>
  </details>`;
}

const MOD = html`<kbd class="mod">Ctrl</kbd><kbd>K</kbd>`;

// Ask Grapim (src/hub/agent/): the button at the top right of every team
// page (where Railway, Vercel and GitHub keep theirs) and the panel's mount
// point. /hub/static/agent.js builds the panel; shell.agent is null when the
// person should not see it (a member, before the hub has an API key).
function askButton(shell) {
  if (!shell.agent) return '';
  return html`<button class="ask-btn" type="button" data-action="agent" aria-controls="agent" aria-expanded="false">${icon('spark')}<span>Ask Grapim</span><kbd class="mod">Ctrl</kbd><kbd>J</kbd></button>`;
}

function agentRoot(team, csrf, shell) {
  if (!shell.agent) return '';
  return html`<aside class="agent-panel" id="agent" aria-label="Ask Grapim" tabindex="-1" hidden data-team="${team.id}" data-csrf="${csrf}" data-configured="${shell.agent.configured ? '1' : '0'}" data-role="${shell.role}"></aside>`;
}

// What a form just did, after it redirected here (?done=…): a toast that
// hub.js takes away after a few seconds. role=status, so it is announced.
function toastEl(text) {
  if (!text) return '';
  return html`<div class="toast" role="status">${icon('check')}<span class="toast-text">${text}</span><button class="toast-close" type="button" aria-label="Dismiss">${icon('x')}</button></div>`;
}

function shellPage({ title, user, team, csrf, crumbs, body, wide, shell, toast }) {
  const current = currentSection(team, shell.path);
  const me = shell.teams.find((t) => t.id === team.id) ?? { ...team, role: shell.role };
  const signOut = html`<form method="post" action="/hub/logout">${csrfField(csrf)}<button class="btn btn-ghost btn-sm" type="submit">Sign out</button></form>`;
  return html`${head(title)}
<body class="shell">
<a class="skip" href="#main">Skip to content</a>
<div class="app">
  <aside class="side" aria-label="Team">
    <a class="brand" href="/hub">${LOGO}<span>Grapim</span></a>
    <button class="search-btn" type="button" data-action="palette">${icon('search')}<span>Jump to…</span>${MOD}</button>
    <nav class="nav" aria-label="Team sections">${navLinks(team, shell, current)}</nav>
    <div class="side-foot">
      ${profileMenu({ user, team, me, csrf, shell })}
    </div>
  </aside>
  <div class="main">
    <header class="topbar">
      <a class="brand" href="/hub" aria-label="Grapim, all teams">${LOGO}</a>
      <span class="topbar-team">${team.name}</span>
      <button class="icon-btn" type="button" data-action="palette" aria-label="Search or jump to">${icon('search')}</button>
      ${shell.agent ? html`<button class="icon-btn" type="button" data-action="agent" aria-controls="agent" aria-expanded="false" aria-label="Ask Grapim">${icon('spark')}</button>` : ''}
      <details class="mnav" data-menu>
        <summary class="icon-btn" aria-label="Menu">${icon('menu')}</summary>
        <div class="menu menu-sheet">
          <nav class="nav" aria-label="Team sections">${navLinks(team, shell, current)}</nav>
          <div class="menu-sep" role="separator"></div>
          ${teamMenu(shell, team)}
          <div class="menu-sep" role="separator"></div>
          <div class="me">${avatar(user)}<span class="login">${user.login}</span>${signOut}</div>
        </div>
      </details>
    </header>
    <header class="main-bar">
      ${crumbBar(team, crumbs)}
      <div class="main-bar-actions">${askButton(shell)}</div>
    </header>
    <main id="main" class="${wrapClass(wide)}" tabindex="-1">
      ${body}
    </main>
  </div>
  ${agentRoot(team, csrf, shell)}
</div>
${paletteSource(team, shell)}
<dialog id="hub-dialog" aria-label="Dialog"></dialog>
${toastEl(toast)}
</body>
</html>`.toString();
}

export function layout({ title, user = null, team = null, csrf = null, crumbs = [], body, wide = false, toast = null }) {
  const shell = user && team && typeof user.shell === 'function' ? user.shell(team) : null;
  if (shell) return shellPage({ title, user, team, csrf, crumbs, body, wide, shell, toast });
  return html`${head(title)}
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <nav class="crumbs" aria-label="Breadcrumb">
    <a class="brand" href="/hub">${LOGO}<span>Grapim</span></a>
    ${team ? html`<span class="slash" aria-hidden="true">/</span><a class="crumb" href="/hub/teams/${team.id}">${team.name}</a>` : ''}
    ${crumbs.map((c) => html`<span class="slash" aria-hidden="true">/</span>${c.href ? html`<a class="crumb" href="${c.href}">${c.label}</a>` : html`<span class="crumb current" aria-current="page">${c.label}</span>`}`)}
  </nav>
  ${user
    ? html`<div class="me">
    <span class="who">${avatar(user)}<span class="login">${user.login}</span></span>
    <form method="post" action="/hub/logout">${csrfField(csrf)}<button class="btn btn-ghost btn-sm" type="submit">Sign out</button></form>
  </div>`
    : ''}
</header>
<main id="main" class="${wrapClass(wide)}">
${body}
</main>
${toastEl(toast)}
</body>
</html>`.toString();
}

export function errorPage({ status, message, user = null, csrf = null }) {
  const heading = { 400: 'That did not work', 402: 'Plan limit reached', 403: 'Not allowed', 404: 'Not found', 409: 'Cannot do that yet', 410: 'Link no longer valid', 413: 'Too large', 429: 'Slow down' }[status] ?? 'Something went wrong';
  // A bare "Not found." under the heading "Not found" says nothing: say what it means.
  const bare = !message || String(message).replace(/[.\s]+$/, '').toLowerCase() === heading.toLowerCase();
  const fallback = { 404: 'This page does not exist, or it belongs to a team you are not in.', 403: 'Your account cannot open this page.', 429: 'Too many requests in a short time. Wait a minute and try again.' }[status] ?? 'The hub could not finish that. Try again in a moment.';
  return layout({
    title: heading,
    user,
    csrf,
    body: html`<section class="empty-page">
  <p class="muted num">Error ${status}</p>
  <h1>${heading}</h1>
  <p class="lede">${bare ? fallback : message}</p>
  <p><a class="btn" href="/hub">Back to your teams</a></p>
</section>`,
  });
}
