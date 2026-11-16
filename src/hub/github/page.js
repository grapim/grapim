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
    <p>Only this App check waits for approvals in the hub. The provenance Action (<code>grapim/grapim/action</code>) only comments and never fails. <a class="link" href="/docs/review#block-merging-on-a-blocker">Grapim Review</a>, the AI review job, fails when it finds a blocker (the default <code>fail-on</code>), and you can require it as a separate check.</p>
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
      : 'Requiring approval is on the Governance plan. The check stays neutral until then.'}</p>
  ${on
    ? html`<h3 class="card-title small policy-sub">Require provenance</h3>
  ${toggle({ team, csrf, field: 'require_provenance', on: prov, allowed, from })}
  <p class="fine">${prov
    ? 'The check also fails while a commit that adds lines has no Grapim note (not recorded). Human-only commits made with Grapim get an empty note and pass. Turn this off if some people commit from machines without Grapim.'
    : 'Commits without a Grapim note are accepted as human. Anyone who commits from a machine without Grapim passes the policy.'}</p>`
    : ''}
  ${branchRule({ slug, checkName })}`;
}

// Settings, GitHub (owners only): the App's installations and the history scan.
export function githubSection({ team, configured, installations, checkName, history = '' }) {
  return html`<section class="card" id="github" aria-labelledby="github-title">
  <div class="card-head">
    <h2 id="github-title" class="card-title">GitHub App</h2>
    <a class="btn btn-sm" href="/hub/teams/${team.id}/github">${installations.length ? 'Manage' : 'Connect'}</a>
  </div>
  <p class="card-sub">${!configured
    ? 'The GitHub App is not configured on this hub.'
    : installations.length
      ? html`Pull requests in ${installations.map((i, n) => html`${n ? ', ' : ''}<span class="strong">${i.account_login || `installation ${i.id}`}</span>`)} get a provenance comment and a "${checkName}" check.`
      : 'Install the App so each pull request lists its agent runs and who approved them, with a check that can block merging.'}</p>
  ${history}
</section>`;
}

// Settings, Review rules (owners only): require review before merge, and
// require provenance once that is on. How to make GitHub enforce the check
// folds away under the card.
export function policyCard({ team, csrf, policy, allowed, slug = null, checkName = 'Grapim provenance (app)' }) {
  const on = !!policy.require_review;
  const prov = policy.require_provenance === undefined ? true : !!policy.require_provenance;
  return html`<section class="card" id="require-review" aria-labelledby="require-review-title">
  <div class="card-head">
    <h2 id="require-review-title" class="card-title">Require approval before merge</h2>
    ${toggle({ team, csrf, field: 'require_review', on, allowed, from: 'settings' })}
  </div>
  <p class="card-sub">${allowed || on
    ? html`The <code>${checkName}</code> check fails while a pull request has lines from an agent run no other member approved in this hub.`
    : 'On the Governance plan. Until then the check stays neutral.'}</p>
  ${on
    ? html`<div class="policy-row">
    <div><p class="strong">Require provenance</p><p class="fine">${prov ? 'Commits that add lines without a Grapim note fail the check too.' : 'Commits without a Grapim note pass as human.'}</p></div>
    ${toggle({ team, csrf, field: 'require_provenance', on: prov, allowed, from: 'settings' })}
  </div>`
    : ''}
  <details class="howto"><summary>Make GitHub block the merge</summary>${branchRule({ slug, checkName })}</details>
</section>`;
}

export function githubPage({ user, csrf, team, configured, problems = [], installations, linkable, pending, policy, allowed, slug = null, checkName, history = '', notice = null, error = null }) {
  return layout({
    title: `${team.name} GitHub`,
    user,
    csrf,
    team,
    crumbs: [{ label: 'Settings', href: `/hub/teams/${team.id}/settings` }, { label: 'GitHub' }],
    body: html`${head(team, 'settings', { title: 'GitHub', sub: html`Pull request comments and the Grapim check. <a href="/hub/teams/${team.id}/settings/github">Back to settings</a>` })}
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
  <p class="card-sub">Each pull request in a linked account gets one comment, updated on every push, listing each agent run (what it was asked, its lines, who approved it) and the share of added lines from agents, and a "${checkName}" check. It reads the provenance this team synced; a repo maps to its GitHub name through its <code>origin</code> remote.</p>
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
  ${history}
</section>`}

<section class="card" id="policy" aria-labelledby="policy-title">
  <div class="card-head"><h2 id="policy-title" class="card-title">Require approval before merge</h2></div>
  ${policyForm({ team, csrf, policy, allowed, slug, checkName })}
</section>`,
  });
}

// Settings, Review: cloud review on or off, then how it reviews (a few of the
// engine's options, review-config.js). Owners change them; members read them.
// values: the form's fields (teamFormValues, or what was typed after an error).
export function reviewSettingsCard({ team, csrf, owner, cloud, values, checkName }) {
  const on = !!cloud.enabled;
  const allowed = cloud.available && cloud.linked;
  const lock = owner ? '' : html`disabled`;
  return html`<section class="card" id="cloud-review" aria-labelledby="cloud-review-title">
  <div class="card-head">
    <h2 id="cloud-review-title" class="card-title">Cloud review</h2>
    ${owner
      ? html`<form method="post" action="/hub/teams/${team.id}/github/cloud-review" class="inline-form">
      ${csrfField(csrf)}
      <input type="hidden" name="enabled" value="${on ? '0' : '1'}">
      <input type="hidden" name="from" value="review">
      <span class="badge ${on ? 'badge-ok' : ''}">${on ? 'On' : 'Off'}</span>
      <button class="btn btn-sm" type="submit" ${!on && !allowed ? html`disabled aria-disabled="true"` : ''}>${on ? 'Turn off' : 'Turn on'}</button>
    </form>`
      : html`<span class="badge ${on ? 'badge-ok' : ''}">${on ? 'On' : 'Off'}</span>`}
  </div>
  <p class="card-sub">${!cloud.available
    ? 'Cloud review is not set up on this hub. These settings apply once it is.'
    : !cloud.linked
      ? html`Connect the GitHub App first, in <a class="link" href="/hub/teams/${team.id}/settings/github">Settings, GitHub</a>.`
      : on
        ? html`Grapim reviews every pull request in the connected repositories and posts a <code>${checkName}</code> check.`
        : 'Pull requests are not reviewed in the cloud until an owner turns this on.'}</p>
</section>

<section class="card review-settings" id="review-settings" aria-labelledby="review-settings-title">
  <div class="card-head"><h2 id="review-settings-title" class="card-title">How Grapim reviews</h2></div>
  <form method="post" action="/hub/teams/${team.id}/settings/review">
    ${csrfField(csrf)}
    <fieldset class="setting-rows" ${lock}>
      <legend class="sr-only">Review settings</legend>
      <div class="policy-row">
        <div class="setting-text"><label class="strong" for="rs-fail">Block merging on blockers</label><p class="fine">On: a blocker fails the <code>${checkName}</code> check, so a branch rule that requires it stops the merge. Off: the check passes and the findings stay as comments.</p></div>
        <label class="toggle"><input id="rs-fail" type="checkbox" name="failOn" value="blocker" ${values.failOn === 'blocker' ? html`checked` : ''}> Fail the check</label>
      </div>
      <div class="policy-row">
        <div class="setting-text"><label class="strong" for="rs-max">Comments per pull request</label><p class="fine">The most serious findings are posted, up to this many. From 1 to 50.</p></div>
        <input id="rs-max" class="input-narrow" type="number" name="maxComments" min="1" max="50" step="1" inputmode="numeric" value="${values.maxComments}" required>
      </div>
      <div class="policy-row setting-row-wide">
        <div class="setting-text"><label class="strong" for="rs-ignore">Paths to skip</label><p class="fine">One pattern per line, like <code>docs/**</code> or <code>*.min.js</code>. These files are never sent to the model. Up to 50 lines.</p></div>
        <textarea id="rs-ignore" name="ignore" rows="4" spellcheck="false" autocapitalize="off">${values.ignore.join('\n')}</textarea>
      </div>
      <div class="policy-row setting-row-wide">
        <div class="setting-text"><label class="strong" for="rs-notes">Review notes for Grapim</label><p class="fine">What the reviewer should know about your code, added to every review. Up to 2,000 characters.</p></div>
        <textarea id="rs-notes" name="instructions" rows="4" maxlength="2000" placeholder="We use Postgres; flag missing indexes on new queries.">${values.instructions}</textarea>
      </div>
    </fieldset>
    ${owner ? html`<div class="setting-foot"><button class="btn btn-primary" type="submit">Save</button></div>` : ''}
  </form>
  <p class="fine">A repository's <code>.grapim/review.json</code> overrides these. <a class="link" href="/docs/review#the-config-file">The config file</a>${owner ? '' : html`<br>Only an owner can change these.`}</p>
</section>`;
}
