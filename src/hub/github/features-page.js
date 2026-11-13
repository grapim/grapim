// Pages and settings cards for the GitHub features built on the App:
// the 90-day AI history scan, path rules and Slack notifications.
// No inline script or style (the CSP forbids both): the history page
// refreshes itself through hub.js reading data-refresh.

import { csrfField, layout } from '../pages/layout.js';
import { date, html, time } from '../pages/html.js';
import { head } from '../pages/team.js';
import { icon } from '../pages/icons.js';
import { AGENTS } from './agents.js';
import { MAX_APPROVALS } from '../rules.js';

const n = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–');
const plural = (k, one, many = `${one}s`) => `${n(k)} ${k === 1 ? one : many}`;
const agentName = (k) => AGENTS[k] ?? k;
const short = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const OPEN = new Set(['queued', 'running', 'waiting']);

// ---------------------------------------------------------------- history

function progress(s) {
  const pct = s.repos_total ? Math.round((s.repos_done / s.repos_total) * 100) : 0;
  const what =
    s.status === 'queued'
      ? 'Waiting for another scan to finish.'
      : s.status === 'waiting'
        ? `Paused to leave GitHub API points for your pull request checks. Resumes ${s.resume_at ? `around ${new Date(s.resume_at).toISOString().slice(11, 16)} UTC` : 'shortly'}.`
        : s.repos_total
          ? `Reading repo ${n(Math.min(s.repos_done + 1, s.repos_total))} of ${n(s.repos_total)}.`
          : 'Listing the repositories the App can see.';
  return html`<section class="card scan-progress" aria-labelledby="scan-title" data-refresh="5">
  <div class="card-head"><h2 id="scan-title" class="card-title">Scanning the last 90 days</h2><span class="badge badge-pending">${s.status === 'waiting' ? 'paused' : s.status}</span></div>
  <progress class="ask-meter-bar" max="100" value="${pct}" aria-label="Repos read">${pct}%</progress>
  <p class="muted small" role="status">${what} ${plural(s.prs_scanned, 'merged pull request')} read so far. This page updates by itself; you can leave and come back.</p>
</section>`;
}

function verdict(r) {
  const t = r.totals;
  if (!t.merged) {
    return html`<section class="card verdict" aria-labelledby="v-title"><h2 id="v-title" class="verdict-line">No merged pull requests in the last 90 days</h2>
    <p class="muted">The App read ${plural(r.scan.repos_total, 'repo')} and found nothing merged since ${short(r.scan.since)}. Add repos to the installation on GitHub, then scan again.</p></section>`;
  }
  return html`<section class="card verdict" aria-labelledby="v-title">
  <h2 id="v-title" class="verdict-line">In the last 90 days, <strong>at least ${n(t.ai)}</strong> of ${n(t.merged)} merged pull request${t.merged === 1 ? '' : 's'} had commits from AI agents. <strong class="${t.unapproved ? 'warn-text' : ''}">${n(t.unapproved)}</strong> of them ${t.unapproved === 1 ? 'was' : 'were'} merged without an approving review by someone other than the author.</h2>
  <p class="muted small">Read from commit authors and <code>Co-authored-by</code> trailers that agents add, and from GitHub's own review records. Trailers can be turned off, so the real number is likely higher.</p>
</section>
<dl class="kpis">
  <div class="kpi"><dt>Merged pull requests read</dt><dd><span class="kpi-v">${n(t.merged)}</span><span class="kpi-s">${plural(r.scan.repos_total, 'repo')} · since ${short(r.scan.since)}</span></dd></div>
  <div class="kpi"><dt>With AI agent commits</dt><dd><span class="kpi-v">≥ ${n(t.ai)}</span><span class="kpi-s">${t.merged ? `${Math.round((t.ai / t.merged) * 100)}% of merged` : ''}</span></dd></div>
  <div class="kpi"><dt>No approval by another person</dt><dd><span class="kpi-v ${t.unapproved ? 'warn-text' : ''}">${n(t.unapproved)}</span><span class="kpi-s">of the AI pull requests</span></dd></div>
  <div class="kpi"><dt>Agents seen</dt><dd><span class="kpi-v">${n(r.agents.length)}</span><span class="kpi-s">${r.agents.slice(0, 3).map((a) => agentName(a.agent)).join(', ') || 'none'}</span></dd></div>
</dl>`;
}

const bar = (v, max, cls) =>
  html`<svg class="hbar" width="100%" height="8" aria-hidden="true"><rect class="track" width="100%" height="8" rx="2"/>${v > 0 ? html`<rect class="${cls}" width="${Math.max(1, (v / Math.max(1, max)) * 100)}%" height="8" rx="2"/>` : ''}</svg>`;

function tables(r) {
  const maxAgent = Math.max(1, ...r.agents.map((a) => a.prs));
  return html`<div class="split-2">
<section class="card chart-card flush" aria-labelledby="by-agent">
  <div class="card-head pad"><h2 id="by-agent" class="card-title">By agent</h2></div>
  ${r.agents.length
    ? html`<div class="table-scroll"><table class="table table-dense bar-table">
    <caption class="sr-only">Merged pull requests with commits from each agent</caption>
    <thead><tr><th scope="col">Agent</th><th scope="col" class="bar-col hide-sm"><span class="sr-only">Share</span></th><th scope="col" class="num">PRs</th><th scope="col" class="num">No other approval</th></tr></thead>
    <tbody>${r.agents.map(
      (a) => html`<tr><th scope="row"><span class="strong">${agentName(a.agent)}</span><span class="muted small block">${a.how.join(', ')}</span></th>
      <td class="bar-col hide-sm">${bar(a.prs, maxAgent, 'k-ai')}</td><td class="num">${n(a.prs)}</td><td class="num ${a.unapproved ? 'warn-text' : ''}">${n(a.unapproved)}</td></tr>`,
    )}</tbody></table></div>`
    : html`<p class="pad muted small">No agent signals found.</p>`}
</section>
<section class="card chart-card flush" aria-labelledby="by-repo">
  <div class="card-head pad"><h2 id="by-repo" class="card-title">By repo</h2></div>
  <div class="table-scroll"><table class="table table-dense">
    <caption class="sr-only">Merged pull requests per repo</caption>
    <thead><tr><th scope="col">Repo</th><th scope="col" class="num hide-sm">Merged</th><th scope="col" class="num">With AI</th><th scope="col" class="num">No other approval</th></tr></thead>
    <tbody>${r.repos.slice(0, 50).map(
      (x) => html`<tr><th scope="row" class="truncate"><a class="strong" href="${`https://github.com/${x.repo}`}" rel="noreferrer">${x.repo}</a></th><td class="num hide-sm">${n(x.merged)}</td><td class="num">${n(x.ai)}</td><td class="num ${x.unapproved ? 'warn-text' : ''}">${n(x.unapproved)}</td></tr>`,
    )}</tbody></table></div>
</section>
</div>`;
}

function prList(r) {
  if (!r.prs.length) return '';
  const shown = r.prs.slice(0, 200);
  return html`<h2 class="section-title">Pull requests with AI agent commits</h2>
<div class="table-wrap"><table class="table table-dense">
  <caption class="sr-only">Merged pull requests with AI agent commits, unapproved first</caption>
  <thead><tr><th scope="col">Pull request</th><th scope="col" class="hide-sm">Agents</th><th scope="col">Approval</th><th scope="col" class="hide-sm">Merged</th></tr></thead>
  <tbody>${shown.map(
    (p) => html`<tr>
    <th scope="row" class="cell-run"><a class="run-link" href="${p.url}" rel="noreferrer"><span class="run-intent">${p.title || `#${p.number}`}</span></a><span class="run-sub"><span class="mono">${p.repo}#${p.number}</span>${p.author ? html` · ${p.author}` : ''}</span></th>
    <td class="hide-sm">${p.agents.map((a) => agentName(a.agent)).join(', ')}</td>
    <td>${p.approved_other ? html`<span class="badge badge-ok">${icon('check')}${p.approvers.slice(0, 2).join(', ')}</span>` : html`<span class="badge badge-warn">No other approval</span>`}</td>
    <td class="hide-sm">${date(p.merged_at)}</td>
  </tr>`,
  )}</tbody>
</table></div>
${r.prs.length > shown.length ? html`<p class="fine">Showing ${n(shown.length)} of ${n(r.prs.length)}. Export CSV for all of them.</p>` : ''}`;
}

function caveats(r) {
  return html`<details class="caveats" open>
  <summary>How to read this</summary>
  <ul>
    <li>An agent is counted when a commit's author is its bot account (for example <code>copilot-swe-agent[bot]</code>, <code>devin-ai-integration[bot]</code>), or a commit carries its <code>Co-authored-by</code> trailer (for example Claude Code's <code>noreply@anthropic.com</code>, Cursor's <code>cursoragent@cursor.com</code>). These are opt-in: people can turn them off, and agents that leave no mark are not seen. So these are lower bounds.</li>
    <li>"Approved by someone other than the author" means GitHub recorded an Approve review from a person whose login is not the pull request author's. Bot approvals do not count.</li>
    <li>An approval on GitHub shows that an account clicked Approve. It does not show which agent run wrote which lines, or that a person read them. That is what Grapim records from here on.</li>
    <li>Read with the App's installation token: at most 50 repos (most recently pushed), 400 pull requests per repo, 2,000 in all and 100 commits per pull request.${r?.scan.capped.length ? html` This scan hit: ${r.scan.capped.join('; ')}.` : ''}</li>
  </ul>
</details>`;
}

function nextSteps(team) {
  return html`<section class="card next" aria-labelledby="next-title">
  <div class="card-head"><h2 id="next-title" class="card-title">Make the next 90 days answerable</h2></div>
  <ol class="steps-list compact">
    <li class="step"><span class="step-mark" aria-hidden="true">1</span><span class="step-body"><span class="step-title">Record every agent run</span><span class="step-text"><code>npm install -g grapim</code> then <code>grapim init</code> in each repo: each commit gets a note naming the run and prompt behind each line.</span></span></li>
    <li class="step"><span class="step-mark" aria-hidden="true">2</span><span class="step-body"><span class="step-title">Review runs, not just pull requests</span><span class="step-text">A teammate other than the run's author approves it in Grapim, or from the button on the GitHub check.</span></span></li>
    <li class="step"><span class="step-mark" aria-hidden="true">3</span><span class="step-body"><span class="step-title">Block unreviewed merges</span><span class="step-text"><a class="link" href="/hub/teams/${team.id}/github#policy">Require review</a> makes the Grapim check fail until every run is approved.</span></span></li>
  </ol>
</section>`;
}

export function historyPage({ user, csrf, team, role, report, configured, linked, canScan, notice = null, error = null }) {
  const owner = role === 'owner';
  const s = report?.scan ?? null;
  const running = s && OPEN.has(s.status);
  const scanForm = owner && configured && linked
    ? html`<form method="post" action="/hub/teams/${team.id}/github/history/scan" class="inline-form">${csrfField(csrf)}<button class="btn btn-sm ${s ? '' : 'btn-primary'}" type="submit" ${running || !canScan ? html`disabled aria-disabled="true"` : ''}>${s ? 'Scan again' : 'Scan history'}</button></form>`
    : '';
  const actions = html`${s && report.totals.merged ? html`<a class="btn btn-sm" href="/hub/api/teams/${team.id}/github/history.csv" download>Export CSV</a>` : ''}${scanForm}`;
  let body;
  if (!configured) body = html`<div class="empty"><p class="empty-title">The GitHub App is not configured on this hub</p><p class="muted">The scan reads pull requests through the Grapim GitHub App.</p></div>`;
  else if (!linked) {
    body = html`<div class="empty"><p class="empty-title">Link GitHub to see your last 90 days</p><p class="muted">Install the Grapim GitHub App on your organization. Grapim then reads the pull requests merged in the last 90 days and shows how many had commits from AI agents, and how many of those merged without another person's approval. Nothing is installed in your repos.</p>${owner ? html`<p class="empty-actions"><a class="btn btn-primary" href="/hub/teams/${team.id}/github">Connect GitHub</a></p>` : html`<p class="fine">Ask a team owner to connect GitHub.</p>`}</div>`;
  } else if (!s) {
    body = html`<div class="empty"><p class="empty-title">No scan yet</p><p class="muted">Reads the pull requests merged in the last 90 days in the repos the App can see. It takes a few minutes and runs in the background.</p>${owner ? '' : html`<p class="fine">Ask a team owner to start one.</p>`}</div>`;
  } else {
    body = html`${running ? progress(s) : ''}
${s.status === 'failed' ? html`<p class="notice notice-error" role="alert">The scan stopped: ${s.error || 'GitHub answered with an error'}. Scan again to retry.</p>` : ''}
${report.totals.merged || !running ? verdict(report) : ''}
${report.totals.merged ? html`${tables(report)}${prList(report)}` : ''}
${caveats(report)}
${nextSteps(team)}
${s.finished_at ? html`<p class="fine">Scan ${s.reason === 'install' ? 'started when GitHub was linked' : 'started by an owner'}, finished ${time(s.finished_at)}. Only merged pull requests in repos the installation can see are read.</p>` : ''}`;
  }
  return layout({
    title: `AI history · ${team.name}`,
    user,
    csrf,
    team,
    wide: true,
    crumbs: [{ label: 'Settings', href: `/hub/teams/${team.id}/settings` }, { label: 'GitHub', href: owner ? `/hub/teams/${team.id}/github` : null }, { label: 'AI history' }],
    body: html`${head(team, 'settings', { title: 'AI history, last 90 days', sub: 'What GitHub already knows about AI-written code in your merged pull requests.', actions })}
${notice ? html`<p class="notice" role="status">${notice}</p>` : ''}
${error ? html`<p class="notice notice-error" role="alert">${error}</p>` : ''}
${body}`,
  });
}

// The scan's line on the GitHub card (settings and the GitHub page).
export function historyCard({ team, csrf, owner, report, configured, linked }) {
  const s = report?.scan;
  const t = report?.totals;
  return html`<h3 class="card-title small policy-sub">AI history, last 90 days</h3>
  <p class="fine">${!configured || !linked
    ? 'Once GitHub is linked, Grapim reads the last 90 days of merged pull requests and shows how many had AI agent commits, and how many merged without another person\'s approval.'
    : !s
      ? 'Not scanned yet.'
      : OPEN.has(s.status)
        ? `Scanning: ${plural(s.prs_scanned, 'pull request')} read so far.`
        : s.status === 'failed'
          ? 'The last scan stopped with an error.'
          : html`At least <b>${n(t.ai)}</b> of ${n(t.merged)} merged pull requests had AI agent commits; <b>${n(t.unapproved)}</b> merged without another person's approval.`}
  ${configured && linked ? html` <a class="link" href="/hub/teams/${team.id}/github/history">Open the report</a>` : ''}</p>
  ${owner && configured && linked && !s ? html`<form method="post" action="/hub/teams/${team.id}/github/history/scan" class="inline-form">${csrfField(csrf)}<button class="btn btn-sm" type="submit">Scan history</button></form>` : ''}`;
}

// ---------------------------------------------------------------- path rules

function ruleRow({ team, csrf, rule, owner, members }) {
  const names = rule.approvers.map((id) => members.find((m) => m.id === id)?.login ?? `user ${id}`);
  return html`<li class="row">
  <span class="row-main"><code class="rule-pattern">${rule.pattern}</code></span>
  <span class="row-meta">${rule.action === 'auto'
    ? html`<span class="badge badge-ok">Approved automatically</span>`
    : html`${plural(rule.approvals, 'approval')}${names.length ? html` from <span class="strong">${names.join(', ')}</span>` : ' from any member'}`}</span>
  ${owner
    ? html`<form method="post" action="/hub/teams/${team.id}/rules/${rule.id}/delete" data-confirm="${`Remove the rule ${rule.pattern}?`}">${csrfField(csrf)}<button class="btn btn-ghost btn-sm btn-danger" type="submit" aria-label="${`Remove the rule ${rule.pattern}`}">Remove</button></form>`
    : ''}
</li>`;
}

// On Settings, Review rules. The form is one row (pattern, what a run that
// changes it gets, how many approvals) and the approvers under it. Approvals
// and approvers only mean something for a review rule: hub.css hides them
// while "Passes automatically" is picked (:has, no script), and says so.
export function rulesCard({ team, csrf, role, rules, members, allowed }) {
  const owner = role === 'owner';
  return html`<section class="card" id="rules" aria-labelledby="rules-title">
  <div class="card-head"><h2 id="rules-title" class="card-title">Path rules</h2>${allowed ? '' : html`<span class="badge">Governance</span>`}</div>
  <p class="card-sub">A run whose every file matches an automatic rule passes on its own; one that touches a review path needs that rule's approvals; any other run needs one approval from another member.</p>
  ${rules.length ? html`<ul class="list list-flush">${rules.map((rule) => ruleRow({ team, csrf, rule, owner, members }))}</ul>` : html`<p class="muted small">No rules yet.</p>`}
  ${allowed && owner && !rules.length
    ? html`<form method="post" action="/hub/teams/${team.id}/rules/starter" class="rule-starter">
    ${csrfField(csrf)}
    <p class="fine">Start from a common set: tests and docs pass automatically; auth, payments, migrations, infrastructure and CI need a person. You can remove any of them after.</p>
    <button class="btn btn-sm" type="submit">Add the starter rules</button>
  </form>`
    : ''}
  ${!allowed
    ? html`<p class="fine">Path rules are on the Governance plan.${rules.length ? ' These rules are kept but do not apply until then.' : ''}</p>`
    : owner
      ? html`<form method="post" action="/hub/teams/${team.id}/rules" class="rule-form">
    ${csrfField(csrf)}
    <h3 class="sub-title">Add a rule</h3>
    <div class="rule-fields">
      <label class="field rule-pattern-field"><span class="label">Path pattern</span><input name="pattern" type="text" required maxlength="200" placeholder="payments/**" spellcheck="false" autocomplete="off" class="mono"></label>
      <label class="field"><span class="label">A run that changes it</span><select name="action"><option value="review">Needs approval</option><option value="auto">Passes automatically</option></select></label>
      <label class="field rule-review-only"><span class="label">Approvals</span><select name="approvals">${Array.from({ length: MAX_APPROVALS }, (_, i) => html`<option value="${i + 1}">${i + 1}</option>`)}</select></label>
    </div>
    <fieldset class="rule-who rule-review-only"><legend class="label">Who may approve <span class="muted">(none ticked: any member)</span></legend>
      ${members.map((m) => html`<label class="toggle"><input type="checkbox" name="${`approver_${m.id}`}" value="1"> ${m.login}</label>`)}
    </fieldset>
    <p class="fine rule-auto-note">Runs that only change matching files pass without a person; the rule and its author are on record.</p>
    <p class="fine">Review rules win over automatic ones. <code>**</code> matches any folders, <code>*</code> any characters in a name, from the repo root.</p>
    <button class="btn btn-sm btn-primary" type="submit">Add rule</button>
  </form>`
      : html`<p class="fine">Team owners add and remove rules.</p>`}
</section>`;
}

// ---------------------------------------------------------------- notifications

export function notifyCard({ team, csrf, info }) {
  return html`<section class="card" id="notifications" aria-labelledby="notify-title">
  <div class="card-head"><h2 id="notify-title" class="card-title">Slack</h2>${info ? html`<span class="badge ${info.disabled ? 'badge-warn' : 'badge-ok'}">${info.disabled ? 'Off' : 'On'}</span>` : ''}</div>
  <p class="card-sub">A digest when runs wait for review (at most every 15 minutes), and a message when the Grapim check fails on a pull request.</p>
  ${info
    ? html`<p class="fine">Webhook ending in <code>…${info.hint}</code>, saved ${time(info.set_at)}.${info.last_ok_at ? html` Last delivered ${time(info.last_ok_at)}.` : ''}</p>
  ${info.last_error ? html`<p class="notice notice-error" role="alert">${info.last_error}</p>` : ''}
  <div class="billing-actions">
    <form method="post" action="/hub/teams/${team.id}/notifications/slack/test" class="inline-form">${csrfField(csrf)}<button class="btn btn-sm" type="submit">Send a test message</button></form>
    <form method="post" action="/hub/teams/${team.id}/notifications/slack/remove" class="inline-form" data-confirm="Stop posting to this Slack channel?">${csrfField(csrf)}<button class="btn btn-sm btn-ghost btn-danger" type="submit">Remove</button></form>
  </div>`
    : ''}
  <form method="post" action="/hub/teams/${team.id}/notifications/slack" class="rule-form">
    ${csrfField(csrf)}
    <label class="storage-field"><span>${info ? 'Replace the Slack incoming webhook URL' : 'Slack incoming webhook URL'}</span><input name="url" type="url" required maxlength="300" placeholder="https://hooks.slack.com/services/T…/B…/…" spellcheck="false" autocomplete="off" class="mono"></label>
    <p class="fine">In Slack: create an app, turn on <b>Incoming Webhooks</b>, add one to a channel and copy its URL. Only <code>hooks.slack.com</code> addresses are accepted. The URL is stored encrypted and never shown again.</p>
    <button class="btn btn-sm btn-primary" type="submit">Save webhook</button>
  </form>
</section>`;
}

// ---------------------------------------------------------------- the run page's rules

export function rulesPanel(evaluation) {
  if (!evaluation?.rules?.length) return '';
  return html`<div class="rules-applied">
  <p class="fine strong">Path rules for this run</p>
  <ul class="rule-checks">${evaluation.rules.map(
    (r) => html`<li class="${r.ok ? 'ok' : 'todo'}">${r.ok ? icon('check') : icon('x')}<span><code>${r.pattern}</code> (changed <code>${r.path}</code>) needs ${plural(r.approvals, 'approval')}${r.approvers.length ? ` from ${r.approvers.map((a) => a.login).join(', ')}` : ''}. ${r.ok ? html`Met by ${r.have.join(', ')}.` : html`${r.have.length ? `Has ${r.have.join(', ')}; ` : ''}<b>${plural(r.need, 'more approval')} needed</b>${r.approvers.length ? `, from ${r.approvers.filter((a) => !r.have.includes(a.login)).map((a) => a.login).join(' or ')}` : ''}.`}</span></li>`,
  )}</ul>
</div>`;
}
