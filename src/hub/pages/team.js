// A team's repos, and its settings: members, invite links, machine tokens,
// billing, leaving.

import { avatar, csrfField, layout } from './layout.js';
import { date, html, time } from './html.js';

function tabs(team, current) {
  const tab = (href, label, key) =>
    html`<a class="tab" href="${href}" ${current === key ? html`aria-current="page"` : ''}>${label}</a>`;
  return html`<nav class="tabs" aria-label="Team">
  ${tab(`/hub/teams/${team.id}`, 'Repos', 'repos')}
  ${tab(`/hub/teams/${team.id}/workspaces`, 'Workspaces', 'workspaces')}
  ${tab(`/hub/teams/${team.id}/reports`, 'Reports', 'reports')}
  ${tab(`/hub/teams/${team.id}/settings`, 'Settings', 'settings')}
  ${team.kind === 'platform' ? tab(`/hub/teams/${team.id}/platform`, 'Platform', 'platform') : ''}
</nav>`;
}

export function head(team, current) {
  return html`<header class="page-head">
  <h1>${team.name}</h1>
  ${tabs(team, current)}
</header>`;
}

const connect = (origin) => html`<pre class="code" tabindex="0"><code>export GRAPIM_HUB_TOKEN=cmh_…   # from Settings → Machine tokens
grapim sync --hub ${origin} --watch</code></pre>`;

export function reposPage({ user, csrf, team, repos, origin, limits }) {
  return layout({
    title: team.name,
    user,
    csrf,
    team,
    body: html`${head(team, 'repos')}
${repos.length
  ? html`<div class="table-wrap">
<table class="table">
  <caption class="sr-only">Repos synced to ${team.name}</caption>
  <thead><tr><th scope="col">Repo</th><th scope="col" class="num">Runs</th><th scope="col" class="num hide-sm">Machines</th><th scope="col">Last change</th><th scope="col" class="hide-sm">Last sync</th></tr></thead>
  <tbody>
  ${repos.map(
    (r) => html`<tr>
    <th scope="row"><a class="strong" href="/hub/teams/${team.id}/repos/${r.id}">${r.name}</a><span class="sha mono hide-sm">${r.id.slice(0, 7)}</span></th>
    <td class="num">${r.runs}</td>
    <td class="num hide-sm">${r.machines}</td>
    <td>${time(r.last_change_ts)}</td>
    <td class="hide-sm">${time(r.last_sync_at)}</td>
  </tr>`,
  )}
  </tbody>
</table>
</div>
<p class="fine">Showing the last ${limits.historyDays} days of history on the ${team.plan} plan. The hub is read-only for code: undo, review and branch run on the machine, with <code>grapim serve</code>.</p>`
  : html`<div class="empty">
  <p class="empty-title">No repos synced yet</p>
  <p class="muted">Create a machine token in <a href="/hub/teams/${team.id}/settings#tokens">Settings</a>, then run this in a repo where Grapim is set up:</p>
  ${connect(origin)}
</div>`}`,
  });
}

export function reveal({ title, value, hint, id }) {
  return html`<div class="reveal" role="status" aria-live="polite">
  <p class="reveal-title">${title}</p>
  <div class="reveal-row">
    <input id="${id}" class="mono reveal-value" type="text" readonly value="${value}" aria-label="${title}" spellcheck="false">
    <button class="btn btn-sm" type="button" data-copy="${id}">Copy</button>
  </div>
  <p class="fine">${hint}</p>
</div>`;
}

function billingSection({ team, role, csrf, limits, seatsUsed, billing }) {
  const owner = role === 'owner';
  const fmt = (n) => (Number.isFinite(n) ? n : 'Unlimited');
  const paid = team.plan !== 'free';
  return html`<section class="card" id="billing" aria-labelledby="billing-title">
  <div class="card-head">
    <h2 id="billing-title" class="card-title">Billing</h2>
    <span class="badge badge-plan">${team.plan}${team.plan_status && team.plan_status !== 'active' ? ` · ${team.plan_status}` : ''}</span>
  </div>
  <dl class="stats">
    <div><dt>Seats</dt><dd>${seatsUsed} / ${fmt(limits.seats)}</dd></div>
    <div><dt>History</dt><dd>${limits.historyDays} days</dd></div>
    <div><dt>Repos</dt><dd>${fmt(limits.repos)}</dd></div>
    <div><dt>Workspaces</dt><dd>${fmt(limits.workspaces ?? 1)}</dd></div>
    ${team.period_end ? html`<div><dt>Renews</dt><dd>${date(team.period_end)}</dd></div>` : ''}
  </dl>
  ${!billing.enabled
    ? html`<p class="fine">Billing is not set up on this hub.</p>`
    : !owner
      ? html`<p class="fine">Only an owner can change the plan.</p>`
      : html`<div class="billing-actions">
    ${billing.intervals.length || billing.governanceIntervals?.length
      ? html`<form method="post" action="/hub/billing/checkout" class="inline-form">
      ${csrfField(csrf)}
      <input type="hidden" name="team" value="${team.id}">
      ${billing.governanceIntervals?.length
        ? html`<label class="sr-only" for="plan">Plan</label>
      <select id="plan" name="plan">
        ${billing.intervals.length ? html`<option value="team" ${team.plan === 'governance' ? '' : 'selected'}>Team · $20 per seat</option>` : ''}
        <option value="governance" ${team.plan === 'governance' || !billing.intervals.length ? 'selected' : ''}>Governance · $40 per seat, reports and required review</option>
      </select>`
        : ''}
      <label for="seats">Seats</label>
      <input id="seats" name="seats" type="number" min="1" max="1000" value="${Math.max(seatsUsed, team.seats || 0, 1)}" inputmode="numeric" class="input-narrow">
      <label class="sr-only" for="interval">Billing period</label>
      <select id="interval" name="interval">
        ${[...new Set([...billing.intervals, ...(billing.governanceIntervals ?? [])])].map((i) => html`<option value="${i}">${i === 'month' ? 'Monthly' : 'Yearly'}</option>`)}
      </select>
      <button class="btn btn-primary" type="submit">${paid ? 'Change plan' : billing.governanceIntervals?.length ? 'Upgrade' : 'Upgrade to Team'}</button>
    </form>`
      : ''}
    ${team.customer_id
      ? html`<form method="post" action="/hub/billing/portal">
      ${csrfField(csrf)}
      <input type="hidden" name="team" value="${team.id}">
      <button class="btn" type="submit">Manage billing</button>
    </form>`
      : ''}
  </div>`}
</section>`;
}

export function settingsPage({ user, csrf, team, role, members, invites, tokens, limits, seatsUsed, billing, origin, github = null, revealed = null, notice = null, error = null }) {
  const owner = role === 'owner';
  return layout({
    title: `${team.name} settings`,
    user,
    csrf,
    team,
    crumbs: [{ label: 'Settings' }],
    body: html`${head(team, 'settings')}
${notice ? html`<p class="notice" role="status">${notice}</p>` : ''}
${error ? html`<p class="notice notice-error" role="alert">${error}</p>` : ''}

<section class="card" id="members" aria-labelledby="members-title">
  <div class="card-head">
    <h2 id="members-title" class="card-title">Members</h2>
    <span class="muted">${seatsUsed} of ${Number.isFinite(limits.seats) ? limits.seats : 'unlimited'} seats</span>
  </div>
  <ul class="list list-flush">
  ${members.map(
    (m) => html`<li class="row">
    <span class="row-main">${avatar(m, 24)}<span class="row-title">${m.name || m.login}</span><span class="muted mono hide-sm">@${m.login}</span></span>
    <span class="row-meta hide-sm">joined ${date(m.joined_at)}</span>
    <span class="badge">${m.role}</span>
    ${owner && m.id !== user.id
      ? html`<form method="post" action="/hub/teams/${team.id}/members/${m.id}/remove" data-confirm="${`Remove ${m.login} from ${team.name}? Their machine tokens stop working.`}">
      ${csrfField(csrf)}<button class="btn btn-ghost btn-sm btn-danger" type="submit" aria-label="${`Remove ${m.login}`}">Remove</button>
    </form>`
      : html`<span class="row-action-spacer" aria-hidden="true"></span>`}
  </li>`,
  )}
  </ul>
</section>

${owner
  ? html`<section class="card" id="invites" aria-labelledby="invites-title">
  <div class="card-head">
    <h2 id="invites-title" class="card-title">Invite links</h2>
    <form method="post" action="/hub/teams/${team.id}/invites">${csrfField(csrf)}<button class="btn btn-sm" type="submit">New invite link</button></form>
  </div>
  <p class="card-sub">Each link adds one person, works once, and expires after 7 days.</p>
  ${revealed?.kind === 'invite'
    ? reveal({ id: 'reveal-invite', title: 'Invite link', value: revealed.value, hint: 'Copy it now and send it to one person. It will not be shown again.' })
    : ''}
  ${invites.length
    ? html`<ul class="list list-flush">
    ${invites.map(
      (i) => html`<li class="row">
      <span class="row-main"><span class="row-title">Link created by ${i.created_by || 'an owner'}</span></span>
      <span class="row-meta">${time(i.created_at)} · expires ${date(i.expires_at)}</span>
      <form method="post" action="/hub/teams/${team.id}/invites/${i.id}/revoke">${csrfField(csrf)}<button class="btn btn-ghost btn-sm" type="submit">Revoke</button></form>
    </li>`,
    )}
  </ul>`
    : html`<p class="muted small">No open invite links.</p>`}
</section>`
  : ''}

<section class="card" id="tokens" aria-labelledby="tokens-title">
  <div class="card-head">
    <h2 id="tokens-title" class="card-title">Machine tokens</h2>
  </div>
  <p class="card-sub">A token lets one machine run <code>grapim sync</code> into this team. ${owner ? 'You see every token in the team.' : 'You see your own tokens.'}</p>
  ${revealed?.kind === 'token'
    ? reveal({ id: 'reveal-token', title: `Token for ${revealed.name}`, value: revealed.value, hint: 'Copy it now. Only a hash is stored, so it cannot be shown again. Put it in GRAPIM_HUB_TOKEN on that machine.' })
    : ''}
  <form method="post" action="/hub/teams/${team.id}/tokens" class="inline-form">
    ${csrfField(csrf)}
    <label class="sr-only" for="token-name">Machine name</label>
    <input id="token-name" name="name" type="text" maxlength="60" placeholder="Machine name, e.g. alex-macbook" required>
    <button class="btn" type="submit">Create token</button>
  </form>
  ${tokens.length
    ? html`<ul class="list list-flush">
    ${tokens.map(
      (t) => html`<li class="row">
      <span class="row-main"><span class="row-title">${t.name}</span><span class="muted mono">…${t.hint}</span></span>
      <span class="row-meta">${owner ? html`${t.owner || 'unknown'} · ` : ''}used ${time(t.last_used_at)}</span>
      <form method="post" action="/hub/teams/${team.id}/tokens/${t.id}/revoke" data-confirm="${`Revoke the token for ${t.name}? That machine stops syncing.`}">${csrfField(csrf)}<button class="btn btn-ghost btn-sm btn-danger" type="submit" aria-label="${`Revoke token ${t.name}`}">Revoke</button></form>
    </li>`,
    )}
  </ul>`
    : ''}
  <details class="howto">
    <summary>How to connect a machine</summary>
    ${connect(origin)}
  </details>
</section>

${billingSection({ team, role, csrf, limits, seatsUsed, billing })}

${github ?? ''}

${owner && team.kind !== 'platform'
  ? html`<section class="card" id="platform" aria-labelledby="platform-title">
  <div class="card-head"><h2 id="platform-title" class="card-title">Platform</h2><span class="badge">beta</span></div>
  <p class="card-sub">Run agents for your own customers? A platform creates a workspace per end customer through an API, embeds the review desk in its app, and pays by usage. <a href="/hub/teams/${team.id}/platform">Set it up</a>.</p>
</section>`
  : ''}

<section class="card card-danger" aria-labelledby="leave-title">
  <div class="card-head">
    <h2 id="leave-title" class="card-title">Leave team</h2>
    <form method="post" action="/hub/teams/${team.id}/leave" data-confirm="${`Leave ${team.name}? Your machine tokens for it stop working.`}">${csrfField(csrf)}<button class="btn btn-sm btn-danger" type="submit">Leave</button></form>
  </div>
  <p class="card-sub">Your machine tokens for this team are revoked. ${owner ? 'The last owner cannot leave.' : ''}</p>
</section>`,
  });
}
