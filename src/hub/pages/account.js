// Sign in, the team picker, and accepting an invite.

import { csrfField, layout } from './layout.js';
import { date, html } from './html.js';

export function signInPage({ next = '/hub', error = null }) {
  const href = next && next !== '/hub' ? `/hub/auth/github?next=${encodeURIComponent(next)}` : '/hub/auth/github';
  return layout({
    title: 'Sign in',
    body: html`<section class="auth">
  <h1>Sign in to Grapim</h1>
  <p class="lede">See every agent's work across your team's machines: which run wrote each line, what it was asked to do, and what it changed.</p>
  ${error ? html`<p class="notice notice-error" role="alert">${error}</p>` : ''}
  <a class="btn btn-primary btn-block" href="${href}">
    <svg class="gh" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
    Continue with GitHub
  </a>
  <p class="fine">Grapim reads your public GitHub profile (name and avatar) and nothing else. It never asks for access to your repositories: code reaches the hub only from machines you connect with a token.</p>
</section>`,
  });
}

export function pickerPage({ user, csrf, teams, error = null, toast = null }) {
  // Two teams can share a name: the created date, role and id tell them apart.
  const names = new Map();
  for (const t of teams) names.set(t.name.toLowerCase(), (names.get(t.name.toLowerCase()) ?? 0) + 1);
  return layout({
    title: 'Teams',
    user,
    csrf,
    toast,
    body: html`<header class="page-head">
  <div class="page-head-main"><h1>Teams</h1><p class="page-sub">Teams you belong to. Open one to see its runs, reviews and workspaces.</p></div>
</header>
${error ? html`<p class="notice notice-error" role="alert">${error}</p>` : ''}
${teams.length
  ? html`<ul class="list team-list" aria-label="Your teams">
  ${teams.map(
    (t) => html`<li class="row row-link" data-team-name="${t.name}">
    <a href="/hub/teams/${t.id}" class="row-main">
      <span class="team-mark" aria-hidden="true">${t.name.slice(0, 1).toUpperCase()}</span>
      <span class="team-text">
        <span class="row-title">${t.name}${names.get(t.name.toLowerCase()) > 1 ? html` <span class="sha mono">${t.id.slice(0, 6)}</span>` : ''}</span>
        <span class="row-sub" title="${`${t.created_at ? `Created ${date(t.created_at)} · ` : ''}${t.repos} repo${t.repos === 1 ? '' : 's'} · ${t.members} member${t.members === 1 ? '' : 's'}`}">${t.created_at ? html`Created ${date(t.created_at)} · ` : ''}${t.repos} repo${t.repos === 1 ? '' : 's'} · ${t.members} member${t.members === 1 ? '' : 's'}</span>
      </span>
    </a>
    <span class="badge ${t.role === 'owner' ? 'badge-role' : ''}">${t.role === 'owner' ? 'Owner' : 'Member'}</span>
    <span class="badge badge-plan">${t.plan}</span>
  </li>`,
  )}
</ul>`
  : html`<div class="empty">
  <p class="empty-title">No teams yet</p>
  <p class="muted">Create one for your team, or open the invite link a teammate sent you.</p>
</div>`}
<section class="card" id="new-team" aria-labelledby="new-team-title">
  <h2 id="new-team-title" class="card-title">Create a team</h2>
  <form method="post" action="/hub/teams" class="inline-form" data-dup-check>
    ${csrfField(csrf)}
    <label class="sr-only" for="team-name">Team name</label>
    <input id="team-name" name="name" type="text" required maxlength="80" placeholder="Team name, e.g. Acme platform" autocomplete="organization" aria-describedby="team-name-dup">
    <button class="btn btn-primary" type="submit">Create team</button>
  </form>
  <p class="fine warn-text" id="team-name-dup" role="status" hidden></p>
</section>`,
  });
}

export function invitePage({ user, csrf, token, invite }) {
  return layout({
    title: 'Join a team',
    user,
    csrf,
    body: html`<section class="auth">
  ${invite
    ? html`<h1>Join ${invite.team.name}</h1>
  <p class="lede">You'll see the agent runs that ${invite.team.name}'s machines sync, and can connect your own. This link works once and expires on ${date(invite.expires_at)}.</p>
  <form method="post" action="/hub/invite/accept">
    ${csrfField(csrf)}
    <input type="hidden" name="token" value="${token}">
    <button class="btn btn-primary btn-block" type="submit">Join as ${user.login}</button>
  </form>
  <p class="fine"><a href="/hub">Not now</a></p>`
    : html`<h1>This invite link is no longer valid</h1>
  <p class="lede">It expired, was already used, or was revoked. Ask a team owner for a new one.</p>
  <p><a class="btn" href="/hub">Back to your teams</a></p>`}
</section>`,
  });
}
