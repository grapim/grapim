// The page shell: head, top bar, main. No inline script or style anywhere
// (the CSP forbids both); behaviour lives in /hub/static/hub.js.

import { html } from './html.js';

const LOGO = html`<svg class="logo" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M10 1.5 18.5 10 10 18.5 1.5 10Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 6 14 10 10 14 6 10Z" fill="currentColor"/></svg>`;

export function csrfField(csrf) {
  return html`<input type="hidden" name="_csrf" value="${csrf}">`;
}

function avatar(user, size = 20) {
  return user.avatar_url
    ? html`<img class="avatar" src="${`${user.avatar_url}${user.avatar_url.includes('?') ? '&' : '?'}s=${size * 2}`}" width="${size}" height="${size}" alt="">`
    : html`<span class="avatar avatar-blank" aria-hidden="true">${user.login.slice(0, 1).toUpperCase()}</span>`;
}
export { avatar };

export function layout({ title, user = null, team = null, csrf = null, crumbs = [], body, wide = false }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title ? `${title} · Grapim` : 'Grapim'}</title>
<link rel="stylesheet" href="/hub/static/hub.css">
<script src="/hub/static/hub.js" defer></script>
</head>
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
<main id="main" class="${wide ? 'wrap wrap-wide' : 'wrap'}">
${body}
</main>
</body>
</html>`.toString();
}

export function errorPage({ status, message, user = null, csrf = null }) {
  const heading = { 400: 'That did not work', 402: 'Plan limit reached', 403: 'Not allowed', 404: 'Not found', 409: 'Cannot do that yet', 410: 'Link no longer valid', 413: 'Too large', 429: 'Slow down' }[status] ?? 'Something went wrong';
  return layout({
    title: heading,
    user,
    csrf,
    body: html`<section class="empty-page">
  <p class="eyebrow">${status}</p>
  <h1>${heading}</h1>
  <p class="lede">${message}</p>
  <p><a class="btn" href="/hub">Back to your teams</a></p>
</section>`,
  });
}
