// A team's pages: the home (what needs me now, or the setup checklist for a
// new team), the review inbox, the repos, and the settings pages (general,
// members, review rules, GitHub, notifications, machines, data, plan and
// usage, platform).

import { avatar, csrfField, layout, SETTINGS_PAGES } from './layout.js';
import { date, html, time } from './html.js';
import { icon } from './icons.js';
import { agent, code, delta, emptyState, phoneMeta, plural, reviewBadge, runHref } from './parts.js';
import { REVIEW_PROVIDERS, WORKFLOW_PATH } from './review-setup.js';

const TITLES = { overview: 'Overview', 'pull-requests': 'Reviews', reviews: 'Approvals', repos: 'Repos', workspaces: 'Workspaces', reports: 'Reports', settings: 'Settings', platform: 'Platform' };

// The page heading. The sidebar says which section this is; the heading names it.
export function head(team, current, { sub = null, actions = null, title = null } = {}) {
  return html`<header class="page-head">
  <div class="page-head-main">
    <h1>${title ?? TITLES[current] ?? team.name}</h1>
    ${sub ? html`<p class="page-sub">${sub}</p>` : ''}
  </div>
  ${actions ? html`<div class="page-actions">${actions}</div>` : ''}
</header>`;
}

const syncSnippet = (origin, name = null) =>
  code(`export GRAPIM_HUB_TOKEN=cmh_…   # ${name ? `the token "${name}"` : 'from Settings → Machine tokens'}
grapim sync --hub ${origin} --watch`);

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

// ---------------------------------------------------------------- overview

// The first-run steps. s: from overview.setup(); every step says done or not from real data.
function checklist({ team, csrf, role, origin, setup, compact = false }) {
  const owner = role === 'owner';
  const done = new Map(setup.steps.map((s) => [s.key, s.done]));
  const base = `/hub/teams/${team.id}`;
  const STEPS = {
    cli: {
      title: 'Install Grapim in a repo',
      body: html`Run it in each repo your agents work in. It works with Claude Code, Codex, Cursor and Gemini CLI. From then on, each agent session is saved as a <strong>run</strong>: which agent, what it was asked, and the lines it changed.`,
      action: code('npm install -g grapim\ngrapim init'),
      link: null,
    },
    token: {
      title: 'Create a token for your computer',
      body: html`Each computer that sends its agents' work to Grapim needs its own token. You see it once.`,
      action: html`<form method="post" action="${base}/tokens" class="inline-form">
        ${csrfField(csrf)}
        <label class="sr-only" for="setup-token">Machine name</label>
        <input id="setup-token" name="name" type="text" maxlength="60" placeholder="Computer name, e.g. alex-macbook" required autocomplete="off" spellcheck="false">
        <button class="btn btn-primary" type="submit">Create token</button>
      </form>`,
      link: `${base}/settings/machines`,
    },
    sync: {
      title: 'Send your agents’ work to Grapim',
      body: html`Run this in the repo with the token set. Each new run then shows up here for a teammate to approve.`,
      action: syncSnippet(origin),
      link: null,
    },
    github: {
      title: 'Hold pull requests until agent work is approved',
      body: owner
        ? html`Install the GitHub App. Each pull request gets a comment listing its agent runs and which are approved, and a check that can block the merge until all of them are.`
        : html`An owner of ${team.name} installs the GitHub App. Pull requests then list their agent runs and get a check.`,
      action: owner ? html`<a class="btn" href="${base}/github">Connect GitHub</a>` : '',
      link: owner ? `${base}/github` : null,
    },
    workspace: {
      title: 'Create a workspace',
      body: html`A shared folder your agents can read and write from anywhere. Every change is recorded and can be undone.`,
      action: html`<form method="post" action="${base}/workspaces" class="inline-form">
        ${csrfField(csrf)}
        <label class="sr-only" for="setup-ws">Workspace name</label>
        <input id="setup-ws" name="name" type="text" maxlength="40" placeholder="Name, e.g. research-notes" required autocomplete="off" spellcheck="false">
        <button class="btn" type="submit">Create workspace</button>
      </form>`,
      link: `${base}/workspaces`,
    },
  };
  const steps = setup.steps.map((s) => ({ ...s, ...STEPS[s.key] }));
  if (compact) {
    const left = steps.filter((s) => !s.done);
    return html`<section class="panel" aria-labelledby="setup-title">
  <div class="panel-head"><h2 id="setup-title" class="panel-title">Finish setting up</h2><span class="muted small num">${setup.done} of ${steps.length} done</span></div>
  <ul class="plain-list">
    ${left.map((s) => html`<li class="plain-row"><span class="step-dot" aria-hidden="true"></span>${s.link ? html`<a class="link" href="${s.link}">${s.title}</a>` : html`<span>${s.title}</span>`}</li>`)}
  </ul>
</section>`;
  }
  return html`<ol class="steps-list" aria-label="Steps to record agent runs">
  ${steps.map(
    (s, i) => html`<li class="step ${s.done ? 'is-done' : ''}">
    <span class="step-mark" aria-hidden="true">${s.done ? icon('check') : i + 1}</span>
    <div class="step-body">
      <h2 class="step-title">${s.title} ${s.done ? html`<span class="badge badge-ok">Done</span>` : html`<span class="sr-only">(not done)</span>`}</h2>
      <p class="step-text">${s.body}</p>
      ${s.done ? '' : html`<div class="step-action">${s.action}</div>`}
    </div>
  </li>`,
  )}
</ol>`;
}

// Grapim Review, the first path for a new team: pick the model account, copy
// the workflow file for it, open a pull request. The hub never receives the
// Action's results, so step 3 says where the review shows up instead of
// pretending to wait for it. The pick is radio buttons and CSS, no script.
const CREDENTIALS = {
  anthropic: html`Add your Anthropic API key as the repository secret <code>ANTHROPIC_API_KEY</code>: on GitHub, <strong>Settings</strong>, <strong>Secrets and variables</strong>, <strong>Actions</strong>.`,
  bedrock: html`No keys to store: the job signs in with GitHub's OIDC token. Create an IAM role that GitHub can assume for this repository and that may invoke Claude on Amazon Bedrock, then put its ARN and your region in the file.`,
  vertex: html`No keys to store: the job signs in with Workload Identity Federation. Give it a service account that can call Claude on Vertex AI, then put the provider, the service account and your project in the file.`,
  foundry: html`Add your Foundry API key as the repository secret <code>ANTHROPIC_FOUNDRY_API_KEY</code>, and put your Foundry resource name in the file.`,
};
const HOW = { anthropic: 'API key', bedrock: 'AWS IAM role', vertex: 'Google Cloud project', foundry: 'API key' };
const docsId = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function reviewSetup() {
  return html`<ol class="steps-list review-setup" aria-label="Set up Grapim Review">
  <li class="step">
    <span class="step-mark" aria-hidden="true">1</span>
    <div class="step-body">
      <h2 class="step-title" id="pick-title">Choose the model account that reviews your code</h2>
      <p class="step-text">Grapim Review calls Claude with your own credentials. Your code goes only there, and the provider bills you directly.</p>
      <div class="step-action pick" role="radiogroup" aria-labelledby="pick-title">
        ${REVIEW_PROVIDERS.map(
          (p, i) => html`<label class="pick-item"><input type="radio" name="review-provider" value="${p.key}" ${i === 0 ? html`checked` : ''}><span class="pick-name">${p.label}</span><span class="pick-sub">${HOW[p.key]}</span></label>`,
        )}
      </div>
    </div>
  </li>
  <li class="step">
    <span class="step-mark" aria-hidden="true">2</span>
    <div class="step-body">
      <h2 class="step-title">Add the workflow file</h2>
      <p class="step-text">Commit it to your default branch as <code>${WORKFLOW_PATH}</code>.</p>
      <div class="step-action">
        ${REVIEW_PROVIDERS.map(
          (p) => html`<div class="wf" data-provider="${p.key}">
          <p class="step-text wf-note">${CREDENTIALS[p.key]} <a class="link" href="/docs/review#${docsId(p.label)}">Details</a></p>
          ${code(p.yaml, `Workflow file for ${p.label}`)}
        </div>`,
        )}
      </div>
    </div>
  </li>
  <li class="step">
    <span class="step-mark" aria-hidden="true">3</span>
    <div class="step-body">
      <h2 class="step-title">Waiting for the first pull request review</h2>
      <p class="step-text">Open a pull request in that repository, or push to an open one. The job <strong>Grapim Review / review</strong> posts its review on the pull request, usually within a few minutes.</p>
      <p class="step-text">The review stays on GitHub and Grapim never receives it, so this page will not change.</p>
      <p class="step-action step-links"><a class="link" href="/docs/review#what-the-comments-look-like">What the review looks like</a><a class="link" href="/docs/review#open-a-pull-request">If no review appears</a></p>
    </div>
  </li>
</ol>`;
}

// Cloud review, the first path for a new team when the hub offers it, the way
// GitHub review apps onboard (install the App, turn it on, open a pull
// request): three steps, each one done in place, with the reviews that ran
// listed under the last one. Owners act; members see who has to.
function cloudSetup({ team, csrf, role, cloud }) {
  const owner = role === 'owner';
  const linked = cloud.linked.length > 0;
  const on = cloud.enabled;
  const u = cloud.usage;
  const step = (n, done, title, body, action) => html`<li class="step ${done ? 'is-done' : ''}">
    <span class="step-mark" aria-hidden="true">${done ? icon('check') : n}</span>
    <div class="step-body">
      <h2 class="step-title">${title} ${done ? html`<span class="badge badge-ok">Done</span>` : html`<span class="sr-only">(not done)</span>`}</h2>
      <p class="step-text">${body}</p>
      ${action ? html`<div class="step-action">${action}</div>` : ''}
    </div>
  </li>`;
  const reviews = cloud.recent.length
    ? html`<ul class="plain-list">${cloud.recent.map(
        (r) => html`<li class="plain-row"><a class="plain-main link" href="https://github.com/${r.owner}/${r.name}/pull/${r.number}" rel="noopener noreferrer">${r.owner}/${r.name}#${r.number}</a><span class="muted small">${r.status === 'running' ? 'reviewing' : r.status === 'failed' ? 'could not finish' : r.blockers ? plural(r.blockers, 'blocker') : r.findings ? plural(r.findings, 'finding') : 'no findings'}</span>${time(r.finished_at ?? r.started_at)}</li>`,
      )}</ul>`
    : '';
  return html`<ol class="steps-list" id="setup" aria-label="Set up cloud review">
  ${step(
    1,
    linked,
    'Connect GitHub',
    linked ? html`Connected to <span class="strong">${cloud.linked.join(', ')}</span>.` : 'Install the Grapim GitHub App on the repositories you want reviewed. You choose which ones on GitHub.',
    linked ? null : owner ? html`<form method="post" action="/hub/teams/${team.id}/github/install">${csrfField(csrf)}<button class="btn btn-primary" type="submit">Install on GitHub</button></form>` : html`<p class="muted small">An owner of ${team.name} installs it.</p>`,
  )}
  ${step(
    2,
    on,
    'Turn on cloud review',
    on
      ? html`On. This month: ${plural(u.reviews, 'review')}, $${u.spent.toFixed(2)} of $${u.budget.toFixed(2)} credit.`
      : html`Grapim reviews each pull request with ${cloud.modelName} on its own model account. Your ${team.plan} plan includes $${u.budget.toFixed(2)} of review a month, about ${Math.max(10, Math.floor(u.budget / 0.18 / 10) * 10).toLocaleString('en-US')} pull requests.`,
    on ? null : owner ? html`<form method="post" action="/hub/teams/${team.id}/github/cloud-review">${csrfField(csrf)}<input type="hidden" name="enabled" value="1"><input type="hidden" name="from" value="overview"><button class="btn ${linked ? 'btn-primary' : ''}" type="submit" ${linked ? '' : html`disabled aria-disabled="true"`}>Turn on</button></form>` : html`<p class="muted small">An owner of ${team.name} turns it on.</p>`,
  )}
  ${step(
    3,
    cloud.recent.length > 0,
    cloud.recent.length ? 'Reviews' : 'Open a pull request',
    cloud.recent.length ? 'The newest reviews. Each one is on its pull request as comments and a Grapim Review (cloud) check.' : 'Open one in a connected repository, or push to an open one. A Grapim Review (cloud) check appears at once, and the comments follow, usually within a minute or two.',
    reviews || null,
  )}
</ol>`;
}

function runRow(team, r) {
  return html`<li class="item">
  <a class="item-link" href="${runHref(team.id, r)}">
    <span class="item-main">
      <span class="item-title" title="${r.intent || r.label}">${r.intent || r.label}</span>
      <span class="item-meta">${agent(r.label, r.kind)}<span class="sep" aria-hidden="true">·</span><span>${r.repo}</span><span class="sep hide-sm" aria-hidden="true">·</span><span class="hide-sm">${plural(r.files, 'file')}</span> ${delta(r.added, r.removed)}</span>
    </span>
    <span class="item-side">${r.status === 'stale' ? reviewBadge('stale') : ''}${time(r.last_ts)}</span>
  </a>
</li>`;
}

function activityRow(team, e) {
  if (e.type === 'review') {
    return html`<li class="feed-row"><span class="feed-what"><span class="strong">${e.login || 'A member'}</span> <span class="muted">${e.status}</span> <a class="link" href="/hub/teams/${team.id}/repos/${e.repo_id}/runs/${encodeURIComponent(e.run)}">${e.label || 'a run'}</a> <span class="muted">in ${e.repo}</span></span>${time(e.ts)}</li>`;
  }
  return html`<li class="feed-row"><span class="feed-what">${agent(e.label, e.kind)} <span class="muted">changed</span> <a class="mono link" href="${runHref(team.id, e)}">${e.path}</a>${e.files > 1 ? html` <span class="muted">and ${plural(e.files - 1, 'other file')}</span>` : ''} <span class="muted">in ${e.repo}</span></span>${time(e.ts)}</li>`;
}

function shareBlock(team, teaser) {
  if (!teaser) return '';
  const pct = (r) => (r === null || r === undefined || !Number.isFinite(r) ? null : `${(r * 100).toFixed(r > 0 && r < 0.1 ? 1 : 0)}%`);
  const share = teaser.commits ? pct(teaser.share) : null;
  return html`<section class="panel" aria-labelledby="share-title">
  <div class="panel-head"><h2 id="share-title" class="panel-title">Written by agents last week</h2><a class="link small" href="/hub/teams/${team.id}/reports">Reports</a></div>
  <div class="panel-body">
    ${share
      ? html`<p class="share"><span class="share-num num">${share}</span> of new lines of code</p>
    <p class="muted small">${teaser.ai_in_share.toLocaleString('en-US')} of ${teaser.added.toLocaleString('en-US')} lines, in ${plural(teaser.commits, 'commit')} Grapim recorded across ${teaser.repos_with_provenance} of ${plural(teaser.repos_total, 'repo')}.</p>`
      : html`<p class="muted small">No recorded commits last week. Repos where Grapim is installed count here from the following week.</p>`}
  </div>
</section>`;
}

// ---------------------------------------------------------------- cloud reviews
//
// What Grapim's cloud review did for the team, the way review bots lay out
// their dashboards: four numbers for the last 30 days, then the reviewed pull
// requests, one row each (its newest review). Rows come from
// overview.reviewedPulls; the Overview shows the newest five.

// status: running | done | failed | no_credit (cloud_reviews.status).
const REVIEW_STATUS = { done: ['Done', 'badge-ok'], running: ['Reviewing', 'badge-pending'], failed: ['Failed', 'badge-warn'], no_credit: ['No credit', 'badge-outline'] };
const reviewStatus = (s, error = null) => {
  const [label, cls] = REVIEW_STATUS[s] ?? [s, ''];
  return html`<span class="badge ${cls}" title="${s === 'failed' && error ? String(error).slice(0, 200) : null}">${label}</span>`;
};
const blockerCount = (n) => (n > 0 ? html`<span class="badge badge-danger num" title="${plural(n, 'blocker')}">${n}</span>` : html`<span class="muted">0</span>`);
const usd = (n) => `$${n.toFixed(2)}`;

function pullsTable(rows, caption) {
  return html`<div class="table-wrap">
<table class="table pulls-table">
  <caption class="sr-only">${caption}</caption>
  <thead><tr><th scope="col">Pull request</th><th scope="col" class="num hide-sm">Comments</th><th scope="col" class="num">Blockers</th><th scope="col" class="hide-sm">Status</th><th scope="col">When</th><th scope="col" class="num hide-sm">Reviews</th></tr></thead>
  <tbody>
  ${rows.map(
    (r) => html`<tr>
    <th scope="row" class="cell-run">${r.url ? html`<a class="run-link" href="${r.url}" rel="noopener noreferrer" title="${r.owner}/${r.name}#${r.number}"><span class="run-intent">${r.name} #${r.number}</span></a>` : html`<span class="run-link" title="${r.owner}/${r.name}#${r.number}"><span class="run-intent">${r.name} #${r.number}</span></span>`}<span class="run-sub hide-sm"><span class="muted">${r.owner}</span>${r.agent ? html`<span class="muted">Agent-written</span>` : ''}</span>${phoneMeta(reviewStatus(r.status, r.error), r.status === 'done' ? html`<span class="muted">${plural(r.findings, 'comment')}</span>` : '', r.agent ? html`<span class="muted">Agent-written</span>` : '')}</th>
    <td class="num hide-sm">${r.status === 'done' ? r.findings : html`<span class="muted">—</span>`}</td>
    <td class="num">${r.status === 'done' ? blockerCount(r.blockers) : html`<span class="muted">—</span>`}</td>
    <td class="hide-sm">${reviewStatus(r.status, r.error)}</td>
    <td>${time(r.ts)}</td>
    <td class="num hide-sm">${r.reviews}</td>
  </tr>`,
  )}
  </tbody>
</table>
</div>`;
}

const NO_REVIEWS = 'Open a pull request in a connected repository and the first review appears here in a minute or two.';
const noReviews = (team) => emptyState('No reviews yet', NO_REVIEWS, html`<p class="empty-actions"><a class="link" href="/hub/teams/${team.id}#setup">See the setup steps</a></p>`);

// The four tiles. s: overview.reviewStats(team).
function reviewTiles(s) {
  const tile = (label, value, sub, extra = '') => html`<div class="kpi"><dt>${label}</dt><dd><span class="kpi-v${extra}">${value}</span><span class="kpi-s kpi-note">${sub}</span></dd></div>`;
  const u = s.usage;
  return html`<dl class="kpis review-kpis">
  ${tile('Pull requests reviewed', s.pulls.toLocaleString('en-US'), 'Pull requests with a finished review.')}
  ${tile('Comments posted', s.comments.toLocaleString('en-US'), 'Findings Grapim left on those pull requests.')}
  ${tile('Blockers', s.blockers.toLocaleString('en-US'), 'Findings that fail the check until fixed.', s.blockers > 0 ? ' kpi-blocker' : '')}
  ${tile('Review spend', u ? html`${usd(u.spent)}<span class="kpi-of"> of ${usd(u.budget)}</span>` : html`<span class="muted">—</span>`, u ? 'Credit used this calendar month. Public repositories are free.' : 'Cloud review is not set up on this hub.')}
</dl>`;
}

// When every cloud setup step is done: one line instead of the checklist.
function setupDoneLine(team, cloud, role) {
  return html`<p class="setup-done" role="status">${icon('check')}<span>Setup done: GitHub connected to <span class="strong">${cloud.linked.join(', ')}</span>, cloud review on.${role === 'owner' ? html` <a class="link" href="/hub/teams/${team.id}/settings/github">Settings</a>` : ''}</span></p>`;
}

// The approvals widgets (agent runs synced by the CLI): what needs me now,
// pull requests with unapproved agent work, activity, and the side column.
function approvalsBody({ team, csrf, role, origin, setup, waiting, mine, pulls, teaser, active, activity, repos, workspaces }) {
  const base = `/hub/teams/${team.id}`;
  const left = setup.steps.some((s) => !s.done);
  return html`<div class="overview">
  <div class="ov-main">
    <section class="panel" aria-labelledby="needs-title">
      <div class="panel-head"><h2 id="needs-title" class="panel-title">Needs your approval <span class="num muted">${waiting.length}</span></h2><a class="link small" href="${base}/reviews">All approvals</a></div>
      ${waiting.length
        ? html`<ul class="items">${waiting.slice(0, 6).map((r) => runRow(team, r))}</ul>`
        : html`<p class="panel-empty">Nothing waits for you. ${mine.length ? html`${plural(mine.length, 'run')} of yours ${mine.length === 1 ? 'waits' : 'wait'} for a teammate.${setup.members < 2 ? html` <a class="link" href="${base}/settings/members">Invite a teammate</a> to approve ${mine.length === 1 ? 'it' : 'them'}.` : ''}` : 'New agent work shows up here as soon as a teammate’s computer sends it.'}</p>`}
    </section>
    ${pulls.list.length
      ? html`<section class="panel" aria-labelledby="prs-title">
      <div class="panel-head"><h2 id="prs-title" class="panel-title">${pulls.enforced ? 'Pull requests waiting on approval' : 'Pull requests with unapproved agent work'} <span class="num muted">${pulls.list.length}</span></h2></div>
      <ul class="items">${pulls.list.slice(0, 6).map(
        (p) => html`<li class="item"><div class="item-link">
          <span class="item-main"><span class="item-title">${p.url ? html`<a class="link" href="${p.url}" rel="noopener noreferrer">${p.owner}/${p.name}#${p.number}</a>` : html`${p.owner}/${p.name}#${p.number}`}</span>
          <span class="item-meta">${p.unapproved} of ${plural(p.runs, 'agent run')} not approved yet</span></span>
          <span class="item-side">${p.failing ? html`<span class="badge badge-danger">Check failing</span>` : ''}${time(p.updated_at)}</span>
        </div></li>`,
      )}</ul>
    </section>`
      : ''}
    <section class="panel" aria-labelledby="act-title">
      <div class="panel-head"><h2 id="act-title" class="panel-title">Recent activity</h2></div>
      ${activity.length ? html`<ul class="feed">${activity.map((e) => activityRow(team, e))}</ul>` : html`<p class="panel-empty">No agent work yet.</p>`}
    </section>
  </div>
  <div class="ov-side">
    ${shareBlock(team, teaser)}
    <section class="panel" aria-labelledby="active-title">
      <div class="panel-head"><h2 id="active-title" class="panel-title">Working now <span class="num muted">${active.length}</span></h2></div>
      ${active.length
        ? html`<ul class="plain-list">${active.map((a) => html`<li class="plain-row"><span class="live" aria-hidden="true"></span><span class="plain-main">${agent(a.label, a.kind)}<span class="muted small truncate" title="${a.intent || a.repo}">${a.intent || a.repo}</span></span>${time(a.last_seen)}</li>`)}</ul>`
        : html`<p class="panel-empty">No agent has changed code in the last hour.</p>`}
    </section>
    <section class="panel" aria-labelledby="where-title">
      <div class="panel-head"><h2 id="where-title" class="panel-title">Where agents work</h2></div>
      <ul class="plain-list">
        ${repos.slice(0, 6).map((r) => html`<li class="plain-row">${icon('repo')}<a class="plain-main link-quiet" href="${base}/repos/${r.id}">${r.name}</a>${time(r.last_change_ts ?? r.last_sync_at)}</li>`)}
        ${workspaces.slice(0, 6).map((w) => html`<li class="plain-row">${icon('workspace')}<a class="plain-main link-quiet" href="${base}/workspaces/${w.id}">${w.name}</a>${time(w.last_activity)}</li>`)}
      </ul>
      ${repos.length > 6 || workspaces.length > 6 ? html`<p class="panel-foot"><a class="link small" href="${base}/repos">All repos</a> · <a class="link small" href="${base}/workspaces">All workspaces</a></p>` : ''}
    </section>
    ${left ? checklist({ team, csrf, role, origin, setup, compact: true }) : ''}
  </div>
</div>`;
}

// The Overview once the hub offers cloud review (or the team has reviews):
// setup while it is not done, the 30-day tiles, the newest reviews, then the
// approvals widgets when the team syncs agent runs.
function reviewOverview(p) {
  const { toast, user, csrf, team, role, origin, setup, cloud, reviews, recent, waiting } = p;
  const base = `/hub/teams/${team.id}`;
  const offered = !!cloud?.available;
  const stepsDone = offered && cloud.linked.length > 0 && cloud.enabled && reviews.any;
  const showSteps = offered && !stepsDone;
  const sub = showSteps
    ? 'Install the GitHub App and Grapim reviews every pull request in about a minute. It knows what each agent was asked and flags what nobody asked for.'
    : html`<span class="plan">${team.plan}</span> plan${waiting.length ? html` · <a class="link" href="${base}/reviews">${plural(waiting.length, 'run')} waiting for your approval</a>` : ''}`;
  return layout({
    title: team.name,
    user,
    csrf,
    team,
    toast,
    wide: true,
    crumbs: [{ label: 'Overview' }],
    body: html`${head(team, 'overview', { title: showSteps && !reviews.any ? `Set up ${team.name}` : team.name, sub })}
${showSteps ? cloudSetup({ team, csrf, role, cloud }) : stepsDone ? setupDoneLine(team, cloud, role) : ''}
${showSteps && setup.empty
  ? html`<details class="setup-more">
  <summary><span class="setup-more-title">Or run it in your own CI</span><span class="muted small">Your model account, nothing reaches Grapim</span></summary>
  <p class="setup-more-text">The same review as a GitHub Action on your runner. Your code goes only to the model account you choose.</p>
  ${reviewSetup()}
</details>
<details class="setup-more">
  <summary><span class="setup-more-title">Also record every agent run (CLI)</span><span class="muted small">Optional</span></summary>
  <p class="setup-more-text"><code>grapim init</code> records each coding agent session as a run: the agent, what it was asked and the lines it changed. Grapim Review then knows which agent wrote each line. Sync the runs here so a teammate can approve them, and undo one run without touching the rest.</p>
  ${checklist({ team, csrf, role, origin, setup })}
</details>`
  : ''}
<section class="review-home" aria-labelledby="reviews-title">
  <h2 id="reviews-title" class="sub-title">Cloud review, last ${reviews.days} days</h2>
  ${reviews.any
    ? html`${reviewTiles(reviews)}
  <div class="panel-head panel-head-bare"><h2 class="panel-title">Recent reviews</h2><a class="link small" href="${base}/pull-requests">All reviews</a></div>
  ${pullsTable(recent, 'The newest reviewed pull requests')}`
    : noReviews(team)}
</section>
${setup.empty
  ? ''
  : html`<h2 class="sub-title ov-approvals-title">Agent runs and approvals</h2>
${approvalsBody(p)}`}`,
  });
}

export function overviewPage({ toast = null, user, csrf, team, role, origin, setup, cloud = null, reviews = null, recent = [], waiting, mine, pulls, teaser, active, activity, repos, workspaces }) {
  const base = `/hub/teams/${team.id}`;
  if (reviews && (cloud?.available || reviews.any)) {
    return reviewOverview({ toast, user, csrf, team, role, origin, setup, cloud, reviews, recent, waiting, mine, pulls, teaser, active, activity, repos, workspaces });
  }
  if (setup.empty && cloud?.available) {
    return layout({
      title: team.name,
      user,
      csrf,
      team,
      toast,
      crumbs: [{ label: 'Overview' }],
      body: html`${head(team, 'overview', { title: cloud.enabled && cloud.recent.length ? team.name : `Set up ${team.name}`, sub: 'Install the GitHub App and Grapim reviews every pull request in about a minute. It knows what each agent was asked and flags what nobody asked for.' })}
${cloudSetup({ team, csrf, role, cloud })}
<details class="setup-more">
  <summary><span class="setup-more-title">Or run it in your own CI</span><span class="muted small">Your model account, nothing reaches Grapim</span></summary>
  <p class="setup-more-text">The same review as a GitHub Action on your runner. Your code goes only to the model account you choose.</p>
  ${reviewSetup()}
</details>
<details class="setup-more">
  <summary><span class="setup-more-title">Also record every agent run (CLI)</span><span class="muted small">Optional</span></summary>
  <p class="setup-more-text"><code>grapim init</code> records each coding agent session as a run: the agent, what it was asked and the lines it changed. Grapim Review then knows which agent wrote each line. Sync the runs here so a teammate can approve them, and undo one run without touching the rest.</p>
  ${checklist({ team, csrf, role, origin, setup })}
</details>`,
    });
  }
  if (setup.empty) {
    return layout({
      title: team.name,
      user,
      csrf,
      team,
      toast,
      crumbs: [{ label: 'Overview' }],
      body: html`${head(team, 'overview', { title: `Set up ${team.name}`, sub: 'Grapim Review comments on every pull request from your own GitHub Actions. Your code goes only to the model account you choose.' })}
${reviewSetup()}
<details class="setup-more" ${setup.done ? html`open` : ''}>
  <summary><span class="setup-more-title">Also record every agent run (CLI)</span><span class="muted small">Optional</span></summary>
  <p class="setup-more-text"><code>grapim init</code> records each coding agent session as a run: the agent, what it was asked and the lines it changed. Grapim Review then knows which agent wrote each line. Sync the runs here so a teammate can approve them, and undo one run without touching the rest.</p>
  ${checklist({ team, csrf, role, origin, setup })}
</details>`,
    });
  }
  return layout({
    title: team.name,
    user,
    csrf,
    team,
    wide: true,
    crumbs: [{ label: 'Overview' }],
    body: html`${head(team, 'overview', { sub: html`<span class="plan">${team.plan}</span> plan${waiting.length ? html` · <a class="link" href="${base}/reviews">${plural(waiting.length, 'run')} waiting for your approval</a>` : ' · nothing waiting for you'}` })}
${approvalsBody({ team, csrf, role, origin, setup, waiting, mine, pulls, teaser, active, activity, repos, workspaces })}`,
  });
}

// ---------------------------------------------------------------- reviews

// [key, label, the label on a phone (the three must fit 343 px)].
const FILTERS = [
  ['yours', 'Needs your approval', 'To approve'],
  ['mine', 'Your runs', 'Your runs'],
  ['done', 'Decided', 'Decided'],
];

export function reviewsPage({ user, csrf, team, filter, runs, counts }) {
  const base = `/hub/teams/${team.id}/reviews`;
  return layout({
    title: `Approvals · ${team.name}`,
    user,
    csrf,
    team,
    wide: true,
    crumbs: [{ label: 'Approvals' }],
    body: html`${head(team, 'reviews', { sub: 'Approve or reject what your team’s agents changed. The Grapim check on pull requests counts these approvals. Nobody approves their own runs.' })}
<nav class="seg" aria-label="Filter">
  ${FILTERS.map(([k, label, short]) => html`<a class="seg-item" href="${`${base}?f=${k}`}" ${k === filter ? html`aria-current="page"` : ''}>${short === label ? label : html`<span class="hide-sm">${label}</span><span class="show-sm">${short}</span>`} <span class="num muted">${counts[k]}</span></a>`)}
</nav>
${runs.length
  ? html`<div class="table-wrap">
<table class="table">
  <caption class="sr-only">${FILTERS.find(([k]) => k === filter)[1]}, newest first</caption>
  <thead><tr><th scope="col">Run</th><th scope="col" class="hide-sm">Repo</th><th scope="col" class="num hide-sm">Files</th><th scope="col" class="num hide-sm">Lines</th><th scope="col" class="hide-sm">Approval</th><th scope="col">Last change</th></tr></thead>
  <tbody>
  ${runs.map(
    (r) => html`<tr>
    <th scope="row" class="cell-run"><a class="run-link" href="${runHref(team.id, r)}" title="${r.intent || r.label}"><span class="run-intent">${r.intent || r.label}</span></a><span class="run-sub">${agent(r.label, r.kind)}<span class="muted hide-sm">${r.machine}</span>${phoneMeta(delta(r.added, r.removed), filter === 'yours' ? '' : reviewBadge(r.status))}</span></th>
    <td class="hide-sm">${r.repo}</td>
    <td class="num hide-sm">${r.files}</td>
    <td class="num hide-sm">${delta(r.added, r.removed)}</td>
    <td class="hide-sm">${reviewBadge(r.status)}${r.review && !r.waiting ? html`<span class="muted small hide-sm"> by ${r.review.reviewer_login || 'a member'}</span>` : ''}</td>
    <td>${time(r.last_ts)}</td>
  </tr>`,
  )}
  </tbody>
</table>
</div>`
  : emptyState(
      filter === 'yours' ? 'You’re all caught up' : filter === 'mine' ? 'None of your runs is waiting' : 'Nothing decided yet',
      filter === 'yours' ? 'Your teammates’ agent runs show up here until someone approves or rejects them.' : filter === 'mine' ? 'Runs from your computer wait here until a teammate approves them.' : 'Approved and rejected runs show up here.',
    )}
<p class="fine">Agent work in a <a href="/hub/teams/${team.id}/workspaces">workspace</a> is approved inside that workspace.</p>`,
  });
}

// ---------------------------------------------------------------- reviewed pull requests

// [key, label, empty title, empty text].
const PULL_FILTERS = [
  ['all', 'All', 'No reviews yet', NO_REVIEWS],
  ['blockers', 'With blockers', 'No pull requests with blockers', 'When the newest review of a pull request finds a Blocker, the pull request shows up here.'],
  ['failed', 'Failed', 'No failed reviews', 'A pull request whose newest review could not finish shows up here.'],
];

// rows: overview.reviewedPulls(team, { filter }).list; counts: its counts; limit: the cap.
export function pullRequestsPage({ user, csrf, team, filter, rows, counts }) {
  const base = `/hub/teams/${team.id}/pull-requests`;
  const [, label, emptyTitle, emptyText] = PULL_FILTERS.find(([k]) => k === filter);
  return layout({
    title: `Reviews · ${team.name}`,
    user,
    csrf,
    team,
    wide: true,
    crumbs: [{ label: 'Reviews' }],
    body: html`${head(team, 'pull-requests', { sub: 'Every pull request Grapim reviewed, with its newest review. The comments themselves are on GitHub.' })}
<nav class="seg" aria-label="Filter">
  ${PULL_FILTERS.map(([k, l]) => html`<a class="seg-item" href="${k === 'all' ? base : `${base}?f=${k}`}" ${k === filter ? html`aria-current="page"` : ''}>${l} <span class="num muted">${counts[k]}</span></a>`)}
</nav>
${rows.length
  ? html`${pullsTable(rows, `${label} reviewed pull requests, newest first`)}
${counts[filter] > rows.length ? html`<p class="fine">Showing the newest ${rows.length} of ${counts[filter].toLocaleString('en-US')}.</p>` : ''}`
  : filter === 'all'
    ? noReviews(team)
    : emptyState(emptyTitle, emptyText)}`,
  });
}

// ---------------------------------------------------------------- repos

export function reposPage({ user, csrf, team, repos, origin, limits, waiting = new Map() }) {
  return layout({
    title: `Repos · ${team.name}`,
    user,
    csrf,
    team,
    wide: true,
    crumbs: [{ label: 'Repos' }],
    body: html`${head(team, 'repos', { sub: `Repos where your team’s agents work, with the last ${limits.historyDays} days of history.` })}
${repos.length
  ? html`<div class="table-wrap">
<table class="table">
  <caption class="sr-only">Repos synced to ${team.name}</caption>
  <thead><tr><th scope="col">Repo</th><th scope="col" class="num">Runs</th><th scope="col" class="num">To approve</th><th scope="col" class="num hide-sm">Computers</th><th scope="col">Last change</th><th scope="col" class="hide-sm">Last update</th></tr></thead>
  <tbody>
  ${repos.map(
    (r) => html`<tr>
    <th scope="row"><a class="strong" href="/hub/teams/${team.id}/repos/${r.id}">${r.name}</a></th>
    <td class="num">${r.runs}</td>
    <td class="num">${waiting.get(r.id) ? html`<span class="count-pill">${waiting.get(r.id)}</span>` : html`<span class="muted">0</span>`}</td>
    <td class="num hide-sm">${r.machines}</td>
    <td>${time(r.last_change_ts)}</td>
    <td class="hide-sm">${time(r.last_sync_at)}</td>
  </tr>`,
  )}
  </tbody>
</table>
</div>
<p class="fine">Open a run to approve or reject it. Grapim never changes your code: to undo a run, use <code>grapim undo</code> on the computer that made it.</p>`
  : html`<div class="empty">
  <p class="empty-title">No repos yet</p>
  <p class="muted">Create a token for your computer in <a href="/hub/teams/${team.id}/settings/machines">Settings</a>, then run this in a repo where Grapim is installed:</p>
  ${syncSnippet(origin)}
</div>`}`,
  });
}

// ---------------------------------------------------------------- settings
//
// One short page per topic (SETTINGS_PAGES in layout.js), as Linear, Vercel
// and GitHub lay out theirs: a sub-nav on the left, the page title is the
// section's name, one to three cards under it.

function billingSection({ team, role, csrf, limits, seatsUsed, billing }) {
  const owner = role === 'owner';
  const fmt = (n) => (Number.isFinite(n) ? n : 'Unlimited');
  const paid = team.plan !== 'free';
  return html`<section class="card" id="billing" aria-labelledby="billing-title">
  <div class="card-head">
    <h2 id="billing-title" class="card-title">Plan</h2>
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
    ? html`<p class="fine">Grapim is in early access: nothing is charged. For a Team or Governance pilot, <a class="link" href="/hub/support?topic=pilot&amp;from=${encodeURIComponent(`/hub/teams/${team.id}/settings/plan`)}">talk to us</a>.</p>`
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
        <option value="governance" ${team.plan === 'governance' || !billing.intervals.length ? 'selected' : ''}>Governance · $40 per seat, reports and required approval</option>
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

// Ask Grapim's monthly credit: what the team used, by whom (owners only), and
// the owner's hard limit. Only drawn when Ask Grapim is set up on the hub.
function askSection({ team, role, csrf, agent: a, members, capError = null }) {
  if (!a) return '';
  const owner = role === 'owner';
  const usd = (n) => '$' + n.toFixed(2);
  const renews = new Date(a.resets_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  const pct = a.budget > 0 ? Math.min(1, a.spent / a.budget) : 1;
  const names = new Map((members ?? []).map((m) => [m.id, m.login]));
  return html`<section class="card" id="ask-grapim" aria-labelledby="ask-title">
  <div class="card-head">
    <h2 id="ask-title" class="card-title">Ask Grapim</h2>
    <span class="muted small">Renews ${renews}</span>
  </div>
  <div class="ask-meter">
    <p class="ask-meter-num"><strong>${usd(a.spent)}</strong> <span class="muted">of ${usd(a.budget)} used this month</span></p>
    <progress class="ask-meter-bar${pct >= 0.9 ? ' is-high' : ''}" max="1" value="${pct.toFixed(3)}" aria-label="Ask Grapim credit used this month">${Math.round(pct * 100)}%</progress>
    <p class="muted small">The ${team.plan} plan includes ${usd(a.credit)} a month, at the model's price per token. ${a.messages} ${a.messages === 1 ? 'message' : 'messages'} so far.</p>
  </div>
  ${owner && a.people?.length
    ? html`<table class="ask-people">
    <thead><tr><th scope="col">Member</th><th scope="col" class="num">Messages</th><th scope="col" class="num">Used</th></tr></thead>
    <tbody>${a.people.map((p) => html`<tr><td>@${names.get(p.user_id) ?? 'former member'}</td><td class="num">${p.messages}</td><td class="num">${usd(p.spent)}</td></tr>`)}</tbody>
  </table>`
    : ''}
  ${owner
    ? html`<form method="post" action="/hub/api/teams/${team.id}/agent/cap" class="ask-cap">
    ${csrfField(csrf)}
    <input type="hidden" name="back" value="1">
    <label class="label" for="ask-cap">Monthly limit</label>
    <div class="ask-cap-row">
      <span class="ask-cap-input"><span aria-hidden="true">$</span><input id="ask-cap" class="input" name="cap" inputmode="decimal" autocomplete="off" placeholder="${a.credit.toFixed(2)}" value="${a.cap === null ? '' : a.cap.toFixed(2)}" pattern="\\$?\\s*([0-9]+(\\.[0-9]*)?|\\.[0-9]+)" title="An amount in dollars, like 5 or 12.50" aria-describedby="${capError ? 'ask-cap-error ask-cap-hint' : 'ask-cap-hint'}" ${capError ? html`aria-invalid="true" autofocus` : ''}></span>
      <button class="btn" type="submit">Save</button>
    </div>
    ${capError ? html`<p id="ask-cap-error" class="field-error">${icon('x')}<span>${capError.message}</span></p>` : ''}
    <p id="ask-cap-hint" class="muted small">Ask Grapim stops for the team at this amount. Empty: the plan's ${usd(a.credit)}; 0 turns it off.</p>
  </form>`
    : ''}
</section>`;
}

// "No code storage" (src/hub/code-storage.js). info: { mode, stored: { files, bytes } }.
function codeStorageSection({ team, csrf, role, info }) {
  if (!info) return '';
  const owner = role === 'owner';
  const on = info.mode === 'metadata';
  const { files, bytes } = info.stored;
  const size = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const versions = plural(files, 'file version');
  return html`<section class="card" id="code-storage" aria-labelledby="code-storage-title">
  <div class="card-head">
    <h2 id="code-storage-title" class="card-title">No code storage</h2>
    ${owner
      ? html`<form method="post" action="/hub/teams/${team.id}/code-storage" class="inline-form">
      ${csrfField(csrf)}
      <input type="hidden" name="mode" value="${on ? 'full' : 'metadata'}">
      <span class="badge ${on ? 'badge-ok' : ''}">${on ? 'On' : 'Off'}</span>
      <button class="btn btn-sm" type="submit">${on ? 'Turn off' : 'Turn on'}</button>
    </form>`
      : html`<span class="badge ${on ? 'badge-ok' : ''}">${on ? 'On' : 'Off'}</span>`}
  </div>
  <p class="card-sub">When on, Grapim keeps what each run did (agent, prompt, file names, line counts, reviews) but never the code itself. Diffs load from GitHub when someone opens a run.</p>
  <p class="fine">${on
    ? html`Diffs need the repo connected to the <a class="link" href="/hub/teams/${team.id}/settings/github">GitHub App</a> and its commits pushed with Grapim’s notes. Prompts are still kept, so a prompt that quotes code keeps that quote. <a class="link" href="/docs/data-handling">What Grapim stores</a>`
    : html`Off: Grapim keeps the files agents changed, so every run shows its diff. <a class="link" href="/docs/data-handling">What Grapim stores</a>`}${owner ? '' : ' Only an owner can change this.'}</p>
  ${owner && on && files
    ? html`<h3 class="card-title small policy-sub">Delete stored file contents</h3>
  <p class="fine">Grapim still holds ${versions} (${size}) from before this was on. Deleting them cannot be undone: those runs then show their diff from GitHub, or not at all.</p>
  <form method="post" action="/hub/teams/${team.id}/code-storage/delete" class="inline-form">
    ${csrfField(csrf)}
    <label class="toggle"><input type="checkbox" name="confirm" value="delete" required> Delete ${versions} for good</label>
    <button class="btn btn-sm btn-danger" type="submit">Delete stored contents</button>
  </form>`
    : owner && !on && files
      ? html`<p class="fine">Turning it on does not delete the ${versions} already stored. You can delete them once it is on.</p>`
      : on && !files
        ? html`<p class="fine">Grapim holds no code for this team.</p>`
        : ''}
</section>`;
}

function generalCards({ team, role, csrf }) {
  const owner = role === 'owner';
  return html`<section class="card" id="general" aria-labelledby="general-title">
  <div class="card-head"><h2 id="general-title" class="card-title">Team</h2></div>
  <dl class="facts">
    <div><dt>Name</dt><dd>${team.name}</dd></div>
    <div><dt>Team ID</dt><dd class="mono">${team.id}</dd></div>
    <div><dt>Created</dt><dd>${date(team.created_at)}</dd></div>
    <div><dt>Your role</dt><dd>${owner ? 'Owner' : 'Member'}</dd></div>
    <div><dt>Plan</dt><dd><span class="badge badge-plan">${team.plan}</span> <a class="link small" href="/hub/teams/${team.id}/settings/plan">Plan and usage</a></dd></div>
  </dl>
  ${owner && team.kind !== 'platform'
    ? html`<p class="fine">Run agents for your own customers? A platform (beta) gives each one a workspace. <a class="link" href="/hub/teams/${team.id}/platform">Set it up</a></p>`
    : ''}
</section>

<section class="card card-danger" id="danger" aria-labelledby="leave-title">
  <div class="card-head">
    <h2 id="leave-title" class="card-title">Leave team</h2>
    <form method="post" action="/hub/teams/${team.id}/leave" data-confirm="${`Leave ${team.name}? Your machine tokens for it stop working.`}">${csrfField(csrf)}<button class="btn btn-sm btn-danger" type="submit">Leave</button></form>
  </div>
  <p class="card-sub">Your machine tokens for this team stop working.${owner ? ' The last owner cannot leave.' : ''}</p>
</section>`;
}

function memberCards({ user, team, role, csrf, members, invites, limits, seatsUsed, revealed }) {
  const owner = role === 'owner';
  return html`<section class="card" id="members" aria-labelledby="members-title">
  <div class="card-head">
    <h2 id="members-title" class="card-title">Members</h2>
    <span class="muted">${seatsUsed} of ${Number.isFinite(limits.seats) ? limits.seats : 'unlimited'} seats</span>
  </div>
  <ul class="list list-flush">
  ${members.map(
    (m) => html`<li class="row">
    <span class="row-main">${avatar(m, 24)}<span class="row-title">${m.name || m.login}</span><span class="muted mono hide-sm">@${m.login}</span></span>
    <span class="row-meta hide-sm">joined ${date(m.joined_at)}</span>
    <span class="badge ${m.role === 'owner' ? 'badge-role' : ''}">${m.role === 'owner' ? 'Owner' : 'Member'}</span>
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
  <p class="card-sub">Each link adds one person, works once and expires after 7 days.</p>
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
  : ''}`;
}

function machineCards({ team, role, csrf, tokens, origin, revealed }) {
  const owner = role === 'owner';
  const newestToken = revealed?.kind === 'token' ? revealed.name : null;
  return html`<section class="card" id="tokens" aria-labelledby="tokens-title">
  <div class="card-head">
    <h2 id="tokens-title" class="card-title">Machine tokens</h2>
  </div>
  <p class="card-sub">Each computer that sends agent work to this team uses its own token.${owner ? '' : ' You see your own tokens.'}</p>
  ${revealed?.kind === 'token'
    ? reveal({ id: 'reveal-token', title: `Token for ${revealed.name}`, value: revealed.value, hint: 'Copy it now: Grapim can’t show it again. Set it as GRAPIM_HUB_TOKEN on that computer.' })
    : ''}
  <form method="post" action="/hub/teams/${team.id}/tokens" class="inline-form">
    ${csrfField(csrf)}
    <label class="sr-only" for="token-name">Machine name</label>
    <input id="token-name" name="name" type="text" maxlength="60" placeholder="Computer name, e.g. alex-macbook" required>
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
  <h3 class="sub-title">Connect a computer</h3>
  ${syncSnippet(origin, newestToken)}
</section>`;
}

function platformCard({ team }) {
  return html`<section class="card" id="platform" aria-labelledby="platform-title">
  <div class="card-head"><h2 id="platform-title" class="card-title">Platform</h2><a class="btn btn-sm" href="/hub/teams/${team.id}/platform">Manage</a></div>
  <p class="card-sub">API keys, the sites that may embed the review desk, webhooks and usage.</p>
</section>`;
}

// Under each page's title: what the page is for, in one line.
const SETTINGS_SUBS = {
  members: 'Who can see this team and approve its agent runs.',
  rules: (team) => html`Decide which agent runs pass on their own and which need a person. <a class="link" href="/docs/rules">How rules work</a>`,
  github: 'Pull request comments and the Grapim check.',
  notifications: 'Slack messages about agent runs and failed checks.',
  machines: 'Connect the computers your agents run on.',
  data: 'What Grapim keeps, and where.',
  plan: 'Your plan, its limits and Ask Grapim credit.',
  platform: 'Workspaces for your own customers, through an API.',
};

// section: one of SETTINGS_PAGES; pages: the ids this person can open here.
export function settingsPage({ section = 'general', pages = ['general'], user, csrf, team, role, members, invites, tokens, limits, seatsUsed, billing, origin, agent = null, github = null, policy = null, notifications = null, rules = null, storage = null, codeStorage = null, revealed = null, notice = null, error = null, toast = null, capError = null }) {
  const base = `/hub/teams/${team.id}/settings`;
  const page = SETTINGS_PAGES.find((p) => p.id === section) ?? SETTINGS_PAGES[0];
  const shown = SETTINGS_PAGES.filter((p) => pages.includes(p.id));
  const sub = typeof SETTINGS_SUBS[page.id] === 'function' ? SETTINGS_SUBS[page.id](team) : SETTINGS_SUBS[page.id] ?? null;
  const cards = {
    general: () => generalCards({ team, role, csrf }),
    members: () => memberCards({ user, team, role, csrf, members, invites, limits, seatsUsed, revealed }),
    rules: () => html`${policy ?? ''}${rules ?? ''}`,
    github: () => github ?? '',
    notifications: () => notifications ?? '',
    machines: () => machineCards({ team, role, csrf, tokens, origin, revealed }),
    data: () => html`${codeStorageSection({ team, csrf, role, info: codeStorage })}${storage ?? ''}`,
    plan: () => html`${billingSection({ team, role, csrf, limits, seatsUsed, billing })}${askSection({ team, role, csrf, agent, members, capError })}`,
    platform: () => platformCard({ team }),
  };
  return layout({
    title: `${page.label} · ${team.name} settings`,
    user,
    csrf,
    team,
    wide: 'mid',
    toast,
    crumbs: [{ label: 'Settings', href: base }, { label: page.label }],
    body: html`<div class="settings">
<nav class="subnav" aria-label="Settings">
  <p class="subnav-title">Settings</p>
  ${shown.map((p) => html`<a class="subnav-item" href="${base}/${p.id}" ${p.id === page.id ? html`aria-current="page"` : ''}>${p.label}</a>`)}
</nav>
<div class="settings-body">
${head(team, 'settings', { title: page.label, sub })}
${notice ? html`<p class="notice" role="status">${notice}</p>` : ''}
${error ? html`<p class="notice notice-error" role="alert">${error}</p>` : ''}
${cards[page.id]()}
</div>
</div>`,
  });
}
