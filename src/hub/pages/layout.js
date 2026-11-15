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

// Team settings: one short page per topic, at /hub/teams/:team/settings/<id>,
// with a sub-nav (a column on the left, a scrolling row on phones).
// owner: shown to owners only. A page the hub has nothing for (no GitHub App,
// not a platform team) is left out: see settingsPage in team.js.
export const SETTINGS_PAGES = [
  { id: 'general', label: 'General' },
  { id: 'members', label: 'Members' },
  { id: 'rules', label: 'Approval rules' },
  { id: 'github', label: 'GitHub', owner: true },
  { id: 'notifications', label: 'Notifications', owner: true },
  { id: 'machines', label: 'Machines' },
  { id: 'data', label: 'Data' },
  { id: 'plan', label: 'Plan and usage' },
  { id: 'platform', label: 'Platform', owner: true },
];

// The team's sections, in sidebar order. g: the second key of its "g" shortcut.
// The review loop comes first. Workspaces and the platform API are secondary:
// they sit below a divider, and Workspaces shows only once the team has one
// (navLinks). secondary: below the divider.
function sections(team, kind = team.kind) {
  const base = `/hub/teams/${team.id}`;
  const list = [
    { id: 'overview', label: 'Overview', href: base, icon: 'home', g: 'o' },
    { id: 'reviews', label: 'Approvals', href: `${base}/reviews`, icon: 'review', g: 'r' },
    { id: 'repos', label: 'Repos', href: `${base}/repos`, icon: 'repo', g: 'p' },
    { id: 'agents', label: 'Agents', href: `${base}/agents`, icon: 'agents', g: 'i' },
    { id: 'reports', label: 'Reports', href: `${base}/reports`, icon: 'reports', g: 'a' },
    { id: 'settings', label: 'Settings', href: `${base}/settings`, icon: 'settings', g: 's' },
    { id: 'workspaces', label: 'Workspaces', href: `${base}/workspaces`, icon: 'workspace', g: 'w', secondary: true },
  ];
  // A platform team (docs/platform.md) gets its API keys, webhooks and usage as a section.
  if (kind === 'platform') list.push({ id: 'platform', label: 'Platform', href: `${base}/platform`, icon: 'external', g: 'f', secondary: true });
  return list;
}

function currentSection(team, pathname = '') {
  const base = `/hub/teams/${team.id}`;
  const rest = pathname.startsWith(base) ? pathname.slice(base.length).replace(/\/+$/, '') : null;
  if (rest === null) return null;
  if (rest === '') return 'overview';
  const first = rest.split('/')[1];
  if (['settings', 'github', 'storage', 'rules'].includes(first)) return 'settings';
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
  // Workspaces is drawn once the team has one, or while you are on its pages.
  // Before that its link stays hidden, so "g w" and the palette still reach it.
  const shown = (s) => s.id !== 'workspaces' || shell.palette.workspaces.length > 0 || current === 'workspaces';
  const link = (s) => html`<a class="nav-item" href="${s.href}" data-g="${s.g}" ${current === s.id ? html`aria-current="page"` : ''} ${shown(s) ? '' : html`hidden`}>${icon(s.icon)}<span class="nav-label">${s.label}</span>${
    s.id === 'reviews' && shell.reviews ? html`<span class="count num" title="${`${shell.reviews} run${shell.reviews === 1 ? '' : 's'} waiting for your approval`}">${shell.reviews}</span>` : ''
  }</a>`;
  const more = list.filter((s) => s.secondary);
  return html`${list.filter((s) => !s.secondary).map(link)}${more.some(shown) ? html`<div class="nav-sep" role="separator"></div>` : ''}${more.map(link)}`;
}

// What Ctrl/Cmd K can jump to, as plain links hub.js reads (no inline data).
function paletteSource(team, shell) {
  const base = `/hub/teams/${team.id}`;
  const item = (group, href, label, sub = '', hint = '') => html`<a href="${href}" data-group="${group}" data-sub="${sub}" data-hint="${hint}">${label}</a>`;
  const owner = shell.role === 'owner';
  return html`<template id="palette-src">
  ${sections(team, shell.teams.find((t) => t.id === team.id)?.kind).map((s) => item('Go to', s.href, s.label, '', `g ${s.g}`))}
  ${shell.palette.runs.map((r) => item('Runs to approve', `${base}/repos/${r.repo_id}/runs/${encodeURIComponent(r.run)}?machine=${encodeURIComponent(r.machine)}`, r.intent || r.label, `${r.label} · ${r.repo}`))}
  ${shell.palette.repos.map((r) => item('Repos', `${base}/repos/${r.id}`, r.name))}
  ${shell.palette.workspaces.map((w) => item('Workspaces', `${base}/workspaces/${w.id}`, w.name, 'workspace'))}
  ${shell.palette.workspaces.map((w) => item('Workspaces', `/w/${team.id}/${w.name}/`, `Open ${w.name} in the review desk`, 'review desk'))}
  ${SETTINGS_PAGES.filter((s) => (shell.settings ? shell.settings.includes(s.id) : owner || !s.owner)).map((s) => item('Settings', `${base}/settings/${s.id}`, s.label, 'settings'))}
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
<link rel="preload" href="/hub/static/fonts/public-sans-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/hub/static/fonts/ibm-plex-mono-400-latin.woff2" as="font" type="font/woff2" crossorigin>
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
      <a class="menu-item" href="${base}/settings/plan">${icon('usage')}<span class="menu-title">Plan and usage</span></a>
      <a class="menu-item" href="${base}/settings/machines">${icon('key')}<span class="menu-title">Machine tokens</span></a>
      <a class="menu-item" href="/docs">${icon('repo')}<span class="menu-title">Docs</span></a>
      <a class="menu-item" href="/hub/support">${icon('help')}<span class="menu-title">Help and feedback</span></a>
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
  return html`<button class="ask-btn" type="button" data-action="agent" aria-controls="agent" aria-expanded="false">${icon('mark')}<span>Ask Grapim</span><kbd class="mod">Ctrl</kbd><kbd>J</kbd></button>`;
}

function agentRoot(team, csrf, shell) {
  if (!shell.agent) return '';
  return html`<aside class="agent-panel" id="agent" aria-label="Ask Grapim" tabindex="-1" hidden data-team="${team.id}" data-csrf="${csrf}" data-configured="${shell.agent.configured ? '1' : '0'}" data-role="${shell.role}"${shell.agent.demo ? html` data-demo="1"` : ''}></aside>`;
}

// The public demo (src/hub/demo.js): on every page of a demo session.
function demoBanner(user) {
  if (!user?.demo) return '';
  return html`<div class="demo-banner" role="note"><span class="demo-banner-tag">Demo</span><span>You're viewing a demo team with sample data. <a href="/hub/login">Sign in with GitHub</a> to try Grapim on your repos.</span></div>`;
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
    <div class="brand-row">
      <a class="brand brand-mark-only" href="/hub" aria-label="Grapim, all teams" title="All teams">${LOGO}</a>
      <details class="team-switch" data-menu>
        <summary class="team-switch-btn" aria-label="${`Team: ${team.name}. Switch team`}"><span class="team-switch-name">${team.name}</span>${icon('updown', 'switch-chev')}</summary>
        <div class="menu team-menu">${teamMenu(shell, team)}</div>
      </details>
    </div>
    <button class="search-btn" type="button" data-action="palette">${icon('search')}<span>Jump to…</span>${MOD}</button>
    <nav class="nav" aria-label="Team sections">${navLinks(team, shell, current)}</nav>
    <div class="side-foot">
      ${profileMenu({ user, team, me, csrf, shell })}
    </div>
  </aside>
  <div class="main">
    ${demoBanner(user)}
    <header class="topbar">
      <a class="brand" href="/hub" aria-label="Grapim, all teams">${LOGO}</a>
      <span class="topbar-team">${team.name}</span>
      <button class="icon-btn" type="button" data-action="palette" aria-label="Search or jump to">${icon('search')}</button>
      ${shell.agent ? html`<button class="icon-btn" type="button" data-action="agent" aria-controls="agent" aria-expanded="false" aria-label="Ask Grapim">${icon('mark')}</button>` : ''}
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

export function layout({ title, user = null, team = null, csrf = null, crumbs = [], body, wide = false, toast = null, bodyClass = '' }) {
  const shell = user && team && typeof user.shell === 'function' ? user.shell(team) : null;
  if (shell) return shellPage({ title, user, team, csrf, crumbs, body, wide, shell, toast });
  return html`${head(title)}
<body${bodyClass ? html` class="${bodyClass}"` : ''}>
<a class="skip" href="#main">Skip to content</a>
${demoBanner(user)}
<header class="top">
  <nav class="crumbs" aria-label="Breadcrumb">
    <a class="brand" href="${user ? '/hub' : '/'}">${LOGO}<span>Grapim</span></a>
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
  const fallback = { 404: 'This page does not exist, or it belongs to a team you are not in.', 403: 'Your account cannot open this page.', 429: 'Too many requests in a short time. Wait a minute and try again.' }[status] ?? 'Grapim couldn’t finish that. Try again in a moment.';
  return layout({
    title: heading,
    user,
    csrf,
    body: html`<section class="empty-page">
  <p class="muted num">Error ${status}</p>
  <h1>${heading}</h1>
  <p class="lede">${bare ? fallback : message}</p>
  <p>${user ? html`<a class="btn" href="/hub">Back to your teams</a>` : html`<a class="btn" href="/">Go to the home page</a> <a class="btn btn-ghost" href="/docs">Read the docs</a>`}</p>
</section>`,
  });
}

// After installing the GitHub App straight from GitHub, with no team behind it:
// public repositories are reviewed free from now on (cloud-review.js).
export function appInstalledPage({ user = null, csrf = null }) {
  return layout({
    title: 'Grapim is installed',
    user,
    csrf,
    body: html`<section class="empty-page">
  <p class="muted num">GitHub App</p>
  <h1>Grapim is installed</h1>
  <p class="lede">Pull requests on your public repositories are now reviewed free. Open one, or push to one, and a Grapim Review check appears within a minute or two. Pull requests opened by bots are skipped.</p>
  <p class="lede">Private repositories need a team with cloud review on.</p>
  <p>${user ? html`<a class="btn btn-primary" href="/hub">Connect it to a team</a>` : html`<a class="btn btn-primary" href="/hub/login">Sign in for private repositories</a>`} <a class="btn btn-ghost" href="/docs/review#free-for-open-source">How free reviews work</a></p>
</section>`,
  });
}

// A write refused in a demo session (src/hub/demo.js): what to do instead.
export function demoReadOnlyPage({ user = null, csrf = null, teamId }) {
  return layout({
    title: 'Read-only demo',
    user,
    csrf,
    body: html`<section class="empty-page">
  <p class="muted num">Demo</p>
  <h1>This is a read-only demo</h1>
  <p class="lede">Nothing here can be changed: the team, its runs and its people are sample data. Sign in with GitHub to use Grapim on your own repos.</p>
  <p><a class="btn btn-primary" href="/hub/login">Sign in with GitHub</a> <a class="btn btn-ghost" href="/hub/teams/${teamId}">Back to the demo</a></p>
</section>`,
  });
}
