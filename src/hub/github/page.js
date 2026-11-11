// The team's GitHub page (owner only) and the GitHub card on the settings
// page: install and link the App, unlink, and the require-review policy.

import { csrfField, layout } from '../pages/layout.js';
import { date, html } from '../pages/html.js';
import { head } from '../pages/team.js';

const ENV = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_WEBHOOK_SECRET', 'GITHUB_APP_SLUG'];

function toggle({ team, csrf, field, on, allowed, from }) {
  return html`<form method="post" action="/hub/teams/${team.id}/github/policy" class="inline-form">
    ${csrfField(csrf)}
    <input type="hidden" name="${field}" value="${on ? '0' : '1'}">
    ${from ? html`<input type="hidden" name="from" value="${from}">` : ''}
    <span class="badge ${on ? 'badge-ok' : ''}">${on ? 'On' : 'Off'}</span>
    <button class="btn btn-sm" type="submit" ${!on && !allowed ? html`disabled aria-disabled="true"` : ''}>${on ? 'Turn off' : 'Turn on'}</button>
  </form>`;
}

// Exactly what a customer sets in GitHub so the check blocks merging, and
// only the App's own check counts (security review M6).
export function branchRule({ slug, checkName }) {
  return html`<div class="fine">
    <p>To block merging, add a branch rule in GitHub: the repository's <b>Settings</b>, <b>Rules</b>, <b>Rulesets</b> (or <b>Branches</b>, <b>Branch protection rules</b>), for your default branch:</p>
    <ol class="steps">
      <li>Turn on <b>Require status checks to pass</b>.</li>
      <li>Add the check <code>${checkName}</code>.</li>
      <li>Set its source to the GitHub App <b>Grapim</b>${slug ? html` (<code>${slug}</code>)` : ''}, not "any source". Otherwise a workflow or another App could post a passing check with the same name.</li>
    </ol>
    <p>The Grapim GitHub Action only comments. It is never a merge gate.</p>
  </div>`;
}

function policyForm({ team, csrf, policy, allowed, from = null, slug = null, checkName = 'Grapim provenance (app)' }) {
  const on = !!policy.require_review;
  const prov = policy.require_provenance === undefined ? true : !!policy.require_provenance;
  return html`${toggle({ team, csrf, field: 'require_review', on, allowed, from })}
  <p class="fine">${on
    ? html`The <code>${checkName}</code> check fails while a pull request has lines from an agent run that no member approved on its run page in this hub. The run's owner (whoever synced it) cannot approve it, and approvals made with <code>grapim review</code> on a machine do not count.`
    : allowed
      ? html`When on, the <code>${checkName}</code> check fails while a pull request has lines from an agent run that another member has not approved in this hub. When off, it is always neutral.`
      : 'Requiring review is on the Governance plan. The check stays neutral until then.'}</p>
  ${on
    ? html`<h3 class="card-title small policy-sub">Require provenance</h3>
  ${toggle({ team, csrf, field: 'require_provenance', on: prov, allowed, from })}
  <p class="fine">${prov
    ? 'The check also fails while a commit that adds lines has no Grapim note (not recorded). Human-only commits made with Grapim get an empty note and pass. Turn this off if some people commit from machines without Grapim.'
    : 'Commits without a Grapim note are accepted as human. Anyone who commits from a machine without Grapim passes the policy.'}</p>`
    : ''}
  ${branchRule({ slug, checkName })}`;
}

// The card on the settings page (owners only).
export function githubSection({ team, csrf, configured, installations, policy, allowed, slug = null, checkName }) {
  return html`<section class="card" id="github" aria-labelledby="github-title">
  <div class="card-head">
    <h2 id="github-title" class="card-title">GitHub</h2>
    <a class="btn btn-sm" href="/hub/teams/${team.id}/github">${installations.length ? 'Manage' : 'Connect'}</a>
  </div>
  <p class="card-sub">${!configured
    ? 'The GitHub App is not configured on this hub.'
    : installations.length
      ? html`Pull requests in ${installations.map((i, n) => html`${n ? ', ' : ''}<span class="strong">${i.account_login || `installation ${i.id}`}</span>`)} get a provenance comment and a "${checkName}" check.`
      : 'Install the Grapim GitHub App so pull requests get a comment with the share of AI-written lines, per agent run, prompt and review.'}</p>
  <h3 class="card-title small">Require review before merge</h3>
  ${policyForm({ team, csrf, policy, allowed, from: 'settings', slug, checkName })}
</section>`;
}

export function githubPage({ user, csrf, team, configured, problems = [], installations, linkable, pending, policy, allowed, slug = null, checkName, notice = null, error = null }) {
  return layout({
    title: `${team.name} GitHub`,
    user,
    csrf,
    team,
    crumbs: [{ label: 'Settings', href: `/hub/teams/${team.id}/settings` }, { label: 'GitHub' }],
    body: html`${head(team, 'settings', { title: 'GitHub', sub: html`Pull request comments and the Grapim check. <a href="/hub/teams/${team.id}/settings#github">Back to settings</a>` })}
${notice ? html`<p class="notice" role="status">${notice}</p>` : ''}
${error ? html`<p class="notice notice-error" role="alert">${error}</p>` : ''}
${!configured
  ? html`<section class="card" aria-labelledby="gh-off-title">
  <div class="card-head"><h2 id="gh-off-title" class="card-title">The GitHub App is not configured</h2></div>
  <p class="card-sub">The hub operator sets ${ENV.map((k, i) => html`${i ? ', ' : ''}<code>${k}</code>`)} (see docs/deploy.md). Until then, use the GitHub Action in <code>action/</code>: it posts the same comment.</p>
  ${problems.length ? html`<ul class="fine">${problems.map((p) => html`<li>${p}</li>`)}</ul>` : ''}
</section>`
  : html`<section class="card" id="installations" aria-labelledby="gh-title">
  <div class="card-head">
    <h2 id="gh-title" class="card-title">GitHub App</h2>
    <form method="post" action="/hub/teams/${team.id}/github/install">${csrfField(csrf)}<button class="btn btn-sm btn-primary" type="submit">Install on GitHub</button></form>
  </div>
  <p class="card-sub">Each pull request in a linked account gets one comment, updated on every push, with the share of added lines written by AI agents and a row per agent run, and a "${checkName}" check. It reads the provenance this team synced; a repo maps to its GitHub name through its <code>origin</code> remote.</p>
  ${installations.length
    ? html`<ul class="list list-flush">
    ${installations.map(
      (i) => html`<li class="row">
      <span class="row-main"><span class="row-title">${i.account_login || `Installation ${i.id}`}</span><span class="badge">${i.account_type === 'Organization' ? 'organization' : 'user'}</span>${i.suspended_at ? html`<span class="badge badge-warn">suspended</span>` : ''}</span>
      <span class="row-meta">${i.repos ? `${i.repos} repo${i.repos === 1 ? '' : 's'} · ` : ''}linked ${date(i.linked_at)}${i.linked_by_login ? ` by ${i.linked_by_login}` : ''}</span>
      <form method="post" action="/hub/teams/${team.id}/github/unlink" data-confirm="${`Unlink ${i.account_login || 'this installation'}? Its pull requests stop getting provenance comments.`}">
        ${csrfField(csrf)}<input type="hidden" name="installation" value="${i.id}">
        <button class="btn btn-ghost btn-sm btn-danger" type="submit" aria-label="${`Unlink ${i.account_login || i.id}`}">Unlink</button>
      </form>
    </li>`,
    )}
  </ul>`
    : html`<p class="muted small">No GitHub account is linked to this team yet.</p>`}
  ${pending.length ? html`<p class="fine" role="status">Waiting for GitHub to confirm ${pending.length === 1 ? 'an installation' : `${pending.length} installations`}. Reload in a moment.</p>` : ''}
  ${linkable.length
    ? html`<h3 class="card-title small">Installed by you, not linked yet</h3>
  <ul class="list list-flush">
    ${linkable.map(
      (i) => html`<li class="row">
      <span class="row-main"><span class="row-title">${i.account_login || `Installation ${i.id}`}</span></span>
      <form method="post" action="/hub/teams/${team.id}/github/link">${csrfField(csrf)}<input type="hidden" name="installation" value="${i.id}"><button class="btn btn-sm" type="submit">Link to ${team.name}</button></form>
    </li>`,
    )}
  </ul>`
    : ''}
</section>`}

<section class="card" id="policy" aria-labelledby="policy-title">
  <div class="card-head"><h2 id="policy-title" class="card-title">Require review before merge</h2></div>
  ${policyForm({ team, csrf, policy, allowed, slug, checkName })}
</section>`,
  });
}
