// A team's pages: the home (what needs me now, or the setup checklist for a
// new team), the review inbox, the repos, and the settings with their
// sections: general, members and invites, machine tokens, billing, GitHub,
// storage, platform, and the danger zone.

import { avatar, csrfField, layout, SETTINGS_SECTIONS } from './layout.js';
import { date, html, time } from './html.js';
import { icon } from './icons.js';
import { agent, code, delta, emptyState, phoneMeta, plural, reviewBadge, runHref } from './parts.js';

const TITLES = { overview: 'Overview', reviews: 'Reviews', repos: 'Repos', workspaces: 'Workspaces', reports: 'Reports', settings: 'Settings', platform: 'Platform' };

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
      body: html`In each repo your agents work in. It adds the hooks that record every agent edit.`,
      action: code('npx grapim init'),
      link: null,
    },
    token: {
      title: 'Create a machine token',
      body: html`One per machine that syncs. It is shown once; only a hash is kept.`,
      action: html`<form method="post" action="${base}/tokens" class="inline-form">
        ${csrfField(csrf)}
        <label class="sr-only" for="setup-token">Machine name</label>
        <input id="setup-token" name="name" type="text" maxlength="60" placeholder="Machine name, e.g. alex-macbook" required autocomplete="off" spellcheck="false">
        <button class="btn btn-primary" type="submit">Create token</button>
      </form>`,
      link: `${base}/settings#tokens`,
    },
    sync: {
      title: 'Connect the machine',
      body: html`Run this in the repo, with the token in the environment. Runs appear on this page as agents work.`,
      action: syncSnippet(origin),
      link: null,
    },
    github: {
      title: 'Install the GitHub App',
      body: owner
        ? html`Pull requests get a comment with the share of AI-written lines per agent run, and a check that can require review.`
        : html`An owner of ${team.name} installs it. Pull requests then get a provenance comment and check.`,
      action: owner ? html`<a class="btn" href="${base}/github">Connect GitHub</a>` : '',
      link: owner ? `${base}/github` : null,
    },
    workspace: {
      title: 'Create a workspace',
      body: html`A folder on the hub that any agent reads and writes over HTTPS or MCP. Every write is recorded and can be undone.`,
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
  return html`<ol class="steps-list" aria-label="Setup steps">
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
  <div class="panel-head"><h2 id="share-title" class="panel-title">AI share, last week</h2><a class="link small" href="/hub/teams/${team.id}/reports">Reports</a></div>
  <div class="panel-body">
    ${share
      ? html`<p class="share"><span class="share-num num">${share}</span> of added lines were written by AI agents</p>
    <p class="muted small">${teaser.ai_in_share.toLocaleString('en-US')} of ${teaser.added.toLocaleString('en-US')} lines, ${plural(teaser.commits, 'commit')} with provenance from ${teaser.repos_with_provenance} of ${plural(teaser.repos_total, 'repo')}.</p>`
      : html`<p class="muted small">No commit had provenance last week. Run <code>grapim init</code> in each repo and commit as usual; next week this shows the share.</p>`}
  </div>
</section>`;
}

export function overviewPage({ user, csrf, team, role, origin, setup, waiting, mine, pulls, teaser, active, activity, repos, workspaces }) {
  const base = `/hub/teams/${team.id}`;
  if (setup.empty) {
    return layout({
      title: team.name,
      user,
      csrf,
      team,
      crumbs: [{ label: 'Overview' }],
      body: html`${head(team, 'overview', { title: `Set up ${team.name}`, sub: 'Grapim records what each agent was asked, what it changed, and who reviewed it. Connect a machine and its runs appear here.' })}
${checklist({ team, csrf, role, origin, setup })}`,
    });
  }
  const left = setup.steps.some((s) => !s.done);
  return layout({
    title: team.name,
    user,
    csrf,
    team,
    wide: true,
    crumbs: [{ label: 'Overview' }],
    body: html`${head(team, 'overview', { sub: html`<span class="plan">${team.plan}</span> plan${waiting.length ? html` · <a class="link" href="${base}/reviews">${plural(waiting.length, 'run')} to review</a>` : ' · nothing waiting for you'}` })}
<div class="overview">
  <div class="ov-main">
    <section class="panel" aria-labelledby="needs-title">
      <div class="panel-head"><h2 id="needs-title" class="panel-title">Needs your review <span class="num muted">${waiting.length}</span></h2><a class="link small" href="${base}/reviews">All reviews</a></div>
      ${waiting.length
        ? html`<ul class="items">${waiting.slice(0, 6).map((r) => runRow(team, r))}</ul>`
        : html`<p class="panel-empty">Nothing waits for you. ${mine.length ? html`${plural(mine.length, 'run')} you synced ${mine.length === 1 ? 'waits' : 'wait'} for another member.` : 'New agent runs show up here once a machine syncs them.'}</p>`}
    </section>
    ${pulls.list.length
      ? html`<section class="panel" aria-labelledby="prs-title">
      <div class="panel-head"><h2 id="prs-title" class="panel-title">${pulls.enforced ? 'Pull requests with a failing Grapim check' : 'Pull requests with unreviewed runs'} <span class="num muted">${pulls.list.length}</span></h2></div>
      <ul class="items">${pulls.list.slice(0, 6).map(
        (p) => html`<li class="item"><div class="item-link">
          <span class="item-main"><span class="item-title">${p.url ? html`<a class="link" href="${p.url}" rel="noopener noreferrer">${p.owner}/${p.name}#${p.number}</a>` : html`${p.owner}/${p.name}#${p.number}`}</span>
          <span class="item-meta">${plural(p.unapproved, 'agent run')} not approved, of ${p.runs}</span></span>
          <span class="item-side">${p.failing ? html`<span class="badge badge-danger">Check failing</span>` : html`<span class="badge">Review not required</span>`}${time(p.updated_at)}</span>
        </div></li>`,
      )}</ul>
    </section>`
      : ''}
    <section class="panel" aria-labelledby="act-title">
      <div class="panel-head"><h2 id="act-title" class="panel-title">Recent activity</h2></div>
      ${activity.length ? html`<ul class="feed">${activity.map((e) => activityRow(team, e))}</ul>` : html`<p class="panel-empty">No synced edits yet.</p>`}
    </section>
  </div>
  <div class="ov-side">
    ${shareBlock(team, teaser)}
    <section class="panel" aria-labelledby="active-title">
      <div class="panel-head"><h2 id="active-title" class="panel-title">Active now <span class="num muted">${active.length}</span></h2></div>
      ${active.length
        ? html`<ul class="plain-list">${active.map((a) => html`<li class="plain-row"><span class="live" aria-hidden="true"></span><span class="plain-main">${agent(a.label, a.kind)}<span class="muted small truncate" title="${a.intent || a.repo}">${a.intent || a.repo}</span></span>${time(a.last_seen)}</li>`)}</ul>`
        : html`<p class="panel-empty">No agent has synced an edit in the last hour.</p>`}
    </section>
    <section class="panel" aria-labelledby="where-title">
      <div class="panel-head"><h2 id="where-title" class="panel-title">Repos and workspaces</h2></div>
      <ul class="plain-list">
        ${repos.slice(0, 6).map((r) => html`<li class="plain-row">${icon('repo')}<a class="plain-main link-quiet" href="${base}/repos/${r.id}">${r.name}</a>${time(r.last_change_ts ?? r.last_sync_at)}</li>`)}
        ${workspaces.slice(0, 6).map((w) => html`<li class="plain-row">${icon('workspace')}<a class="plain-main link-quiet" href="${base}/workspaces/${w.id}">${w.name}</a>${time(w.last_activity)}</li>`)}
      </ul>
      ${repos.length > 6 || workspaces.length > 6 ? html`<p class="panel-foot"><a class="link small" href="${base}/repos">All repos</a> · <a class="link small" href="${base}/workspaces">All workspaces</a></p>` : ''}
    </section>
    ${left ? checklist({ team, csrf, role, origin, setup, compact: true }) : ''}
  </div>
</div>`,
  });
}

// ---------------------------------------------------------------- reviews

// [key, label, the label on a phone (the three must fit 343 px)].
const FILTERS = [
  ['yours', 'Needs your review', 'To review'],
  ['mine', 'Your runs', 'Your runs'],
  ['done', 'Reviewed', 'Reviewed'],
];

export function reviewsPage({ user, csrf, team, filter, runs, counts }) {
  const base = `/hub/teams/${team.id}/reviews`;
  return layout({
    title: `Reviews · ${team.name}`,
    user,
    csrf,
    team,
    wide: true,
    crumbs: [{ label: 'Reviews' }],
    body: html`${head(team, 'reviews', { sub: 'Agent runs from synced repos. An approval here is the review the Grapim check on pull requests counts; the member who synced a run cannot review it.' })}
<nav class="seg" aria-label="Filter">
  ${FILTERS.map(([k, label, short]) => html`<a class="seg-item" href="${`${base}?f=${k}`}" ${k === filter ? html`aria-current="page"` : ''}>${short === label ? label : html`<span class="hide-sm">${label}</span><span class="show-sm">${short}</span>`} <span class="num muted">${counts[k]}</span></a>`)}
</nav>
${runs.length
  ? html`<div class="table-wrap">
<table class="table">
  <caption class="sr-only">${FILTERS.find(([k]) => k === filter)[1]}, newest first</caption>
  <thead><tr><th scope="col">Run</th><th scope="col" class="hide-sm">Repo</th><th scope="col" class="num hide-sm">Files</th><th scope="col" class="num hide-sm">Lines</th><th scope="col" class="hide-sm">Review</th><th scope="col">Last change</th></tr></thead>
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
      filter === 'yours' ? 'Nothing waits for your review' : filter === 'mine' ? 'None of your runs waits for review' : 'No reviewed runs in the history window',
      filter === 'yours' ? 'Runs other members synced show up here until someone approves or rejects them.' : filter === 'mine' ? 'Runs your machines sync wait here until another member reviews them.' : 'Approved and rejected runs show up here.',
    )}
<p class="fine">Cloud workspace runs are reviewed in each workspace's review desk, from <a href="/hub/teams/${team.id}/workspaces">Workspaces</a>.</p>`,
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
    body: html`${head(team, 'repos', { sub: `Repos your team's machines sync with grapim sync. Showing the last ${limits.historyDays} days of history on the ${team.plan} plan.` })}
${repos.length
  ? html`<div class="table-wrap">
<table class="table">
  <caption class="sr-only">Repos synced to ${team.name}</caption>
  <thead><tr><th scope="col">Repo</th><th scope="col" class="num">Runs</th><th scope="col" class="num">To review</th><th scope="col" class="num hide-sm">Machines</th><th scope="col">Last change</th><th scope="col" class="hide-sm">Last sync</th></tr></thead>
  <tbody>
  ${repos.map(
    (r) => html`<tr>
    <th scope="row"><a class="strong" href="/hub/teams/${team.id}/repos/${r.id}">${r.name}</a><span class="sha mono hide-sm">${r.id.slice(0, 7)}</span></th>
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
<p class="fine">Review synced runs here: open a run to approve or reject it; that is the review the Grapim check on pull requests counts. Undo and branches change files, so for a synced repo they run on the machine, with <code>grapim undo</code> or in <code>grapim serve</code>. Cloud workspaces live on the hub, so their runs are reviewed, undone and branched in their review desk.</p>`
  : html`<div class="empty">
  <p class="empty-title">No repos synced yet</p>
  <p class="muted">Create a machine token in <a href="/hub/teams/${team.id}/settings#tokens">Settings</a>, then run this in a repo where Grapim is set up:</p>
  ${syncSnippet(origin)}
</div>`}`,
  });
}

// ---------------------------------------------------------------- settings

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
    <p class="muted small">The ${team.plan} plan includes ${usd(a.credit)} of Ask Grapim a month, counted at the model's price per token. ${a.messages} ${a.messages === 1 ? 'message' : 'messages'} so far.</p>
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
    <p id="ask-cap-hint" class="muted small">Ask Grapim stops for the team at this amount. Leave it empty to use the plan's ${usd(a.credit)}; 0 turns it off.</p>
  </form>`
    : ''}
</section>`;
}

export function settingsPage({ user, csrf, team, role, members, invites, tokens, limits, seatsUsed, billing, origin, agent = null, github = null, storage = null, revealed = null, notice = null, error = null, toast = null, capError = null }) {
  const owner = role === 'owner';
  const shown = SETTINGS_SECTIONS.filter((s) => owner || !s.owner).filter((s) => (s.id === 'github' ? !!github : s.id === 'storage' ? !!storage : true));
  const newestToken = revealed?.kind === 'token' ? revealed.name : null;
  return layout({
    title: `${team.name} settings`,
    user,
    csrf,
    team,
    wide: 'mid',
    toast,
    crumbs: [{ label: 'Settings' }],
    body: html`${head(team, 'settings')}
${notice ? html`<p class="notice" role="status">${notice}</p>` : ''}
${error ? html`<p class="notice notice-error" role="alert">${error}</p>` : ''}
<div class="settings">
<nav class="subnav" aria-label="Settings sections">
  ${shown.map((s) => html`<a class="subnav-item" href="#${s.id}" data-spy="${s.id}">${s.label}</a>`)}
</nav>
<div class="settings-body">

<section class="card" id="general" aria-labelledby="general-title">
  <div class="card-head"><h2 id="general-title" class="card-title">General</h2></div>
  <dl class="facts">
    <div><dt>Name</dt><dd>${team.name}</dd></div>
    <div><dt>Team ID</dt><dd class="mono">${team.id}</dd></div>
    <div><dt>Created</dt><dd>${date(team.created_at)}</dd></div>
    <div><dt>Your role</dt><dd>${role === 'owner' ? 'Owner' : 'Member'}</dd></div>
    <div><dt>Plan</dt><dd><span class="badge badge-plan">${team.plan}</span> <a class="link small" href="#billing">Billing</a></dd></div>
  </dl>
</section>

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
  <h3 class="sub-title">Connect a machine</h3>
  ${syncSnippet(origin, newestToken)}
</section>

${billingSection({ team, role, csrf, limits, seatsUsed, billing })}

${askSection({ team, role, csrf, agent, members, capError })}

${github ?? ''}

${storage ?? ''}

${owner
  ? team.kind === 'platform'
    ? html`<section class="card" id="platform" aria-labelledby="platform-title">
  <div class="card-head"><h2 id="platform-title" class="card-title">Platform</h2><a class="btn btn-sm" href="/hub/teams/${team.id}/platform">Manage</a></div>
  <p class="card-sub">API keys, the origins that may embed the review desk, webhooks and usage.</p>
</section>`
    : html`<section class="card" id="platform" aria-labelledby="platform-title">
  <div class="card-head"><h2 id="platform-title" class="card-title">Platform</h2><span class="badge">beta</span></div>
  <p class="card-sub">Run agents for your own customers? A platform creates a workspace per end customer through an API, embeds the review desk in its app, and pays by usage. <a href="/hub/teams/${team.id}/platform">Set it up</a>.</p>
</section>`
  : ''}

<section class="card card-danger" id="danger" aria-labelledby="leave-title">
  <div class="card-head">
    <h2 id="leave-title" class="card-title">Leave team</h2>
    <form method="post" action="/hub/teams/${team.id}/leave" data-confirm="${`Leave ${team.name}? Your machine tokens for it stop working.`}">${csrfField(csrf)}<button class="btn btn-sm btn-danger" type="submit">Leave</button></form>
  </div>
  <p class="card-sub">Your machine tokens for this team are revoked. ${owner ? 'The last owner cannot leave.' : ''}</p>
</section>
</div>
</div>`,
  });
}
