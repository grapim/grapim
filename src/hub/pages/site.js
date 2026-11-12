// The public pages: the landing page at / for signed-out visitors, and the
// shell (head, top bar, footer) the docs share with it. Same rules as the
// hub: escaped templates, no inline script or style (the CSP forbids both),
// behaviour in /hub/static/site.js. Every claim here is something the code
// does today; screenshots are the real hub with the dev hub's demo data.

import { html, raw } from './html.js';
import { LOGO } from './icons.js';

export const SIGN_IN = '/hub/auth/github';

const GH = raw('<svg class="gh" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>');
const S = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
const ICON = {
  arrow: raw(`<svg class="i" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M3 8h10M9 4l4 4-4 4" ${S}/></svg>`),
  check: raw(`<svg class="i" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="m3.5 8.5 3 3 6-7" ${S}/></svg>`),
  x: raw(`<svg class="i" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="m4.5 4.5 7 7m0-7-7 7" ${S}/></svg>`),
  dot: raw(`<svg class="i" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="3.5" fill="currentColor"/></svg>`),
  sun: raw(`<svg class="i" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="2.75" ${S}/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" ${S}/></svg>`),
  moon: raw(`<svg class="i" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M13.2 9.6A5.5 5.5 0 0 1 6.4 2.8a5.5 5.5 0 1 0 6.8 6.8Z" ${S}/></svg>`),
  system: raw(`<svg class="i" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><rect x="2" y="3" width="12" height="8" rx="1" ${S}/><path d="M6 13.5h4M8 11v2.5" ${S}/></svg>`),
  menu: raw(`<svg class="i" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" ${S}/></svg>`),
};
export { ICON };

// <head> for a public page: title, description, canonical and Open Graph.
export function siteHead({ title, description, path, origin, scripts = true }) {
  const url = `${origin}${path}`;
  const full = path === '/' ? title : `${title} · Grapim`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${full}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Grapim">
<meta property="og:title" content="${full}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${origin}/hub/static/site/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<script src="/hub/static/theme.js"></script>
<link rel="icon" href="/hub/static/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/hub/static/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/hub/static/tokens.css">
<link rel="stylesheet" href="/hub/static/site.css">
${scripts ? html`<script src="/hub/static/site.js" defer></script>` : ''}
</head>`;
}

// The top bar. current: 'home' | 'docs'.
export function siteBar({ current = 'home', signedIn = false } = {}) {
  const a = (href, label, id) => html`<a class="bar-link" href="${href}" ${current === id ? html`aria-current="page"` : ''}>${label}</a>`;
  const home = current === 'home' ? '' : '/';
  return html`<header class="bar">
  <div class="bar-in">
    <a class="bar-brand" href="/" aria-label="Grapim home">${LOGO}<span>Grapim</span></a>
    <nav class="bar-nav" aria-label="Site">
      <span class="bar-anchors">${a(`${home}#how`, 'How it works', 'how')}${a(`${home}#security`, 'Security', 'security')}${a(`${home}#pricing`, 'Pricing', 'pricing')}</span>
      ${a('/docs', 'Docs', 'docs')}
    </nav>
    ${signedIn
      ? html`<a class="btn btn-sm" href="/hub">Open the hub</a>`
      : html`<a class="btn btn-sm" href="${SIGN_IN}" rel="nofollow">${GH}<span>Sign in</span></a>`}
  </div>
</header>`;
}

export function siteFooter() {
  const theme = (t, label, ic) => html`<button type="button" data-theme-set="${t}" aria-pressed="false" aria-label="${label} theme" title="${label}">${ICON[ic]}</button>`;
  return html`<footer class="foot">
  <div class="foot-in">
    <div class="foot-brand">
      <a class="bar-brand" href="/" aria-label="Grapim home">${LOGO}<span>Grapim</span></a>
      <p>The accountability layer for AI-written code.</p>
      <div class="theme-seg" role="group" aria-label="Theme">${theme('system', 'System', 'system')}${theme('light', 'Light', 'sun')}${theme('dark', 'Dark', 'moon')}</div>
    </div>
    <nav class="foot-cols" aria-label="Footer">
      <div><h2>Product</h2><a href="/#how">How it works</a><a href="/#agents">Supported agents</a><a href="/#security">Security</a><a href="/#pricing">Pricing</a></div>
      <div><h2>Docs</h2><a href="/docs">Quickstart</a><a href="/docs/github">GitHub App and PR check</a><a href="/docs/cli">CLI reference</a><a href="/docs/security">Security and privacy</a></div>
      <div><h2>Help</h2><a href="/docs/support">Support</a><a href="/docs/faq">FAQ</a><a href="/hub">Sign in</a></div>
    </nav>
  </div>
</footer>`;
}

// A screenshot of the hub in both themes, with a phone crop under 640px.
// Hidden variants are not fetched: display:none plus loading=lazy. The hero
// is lazy too (an eager pair would download the hidden theme as well); it
// sits in the first viewport, so it loads right after layout, at high priority.
function shot(name, alt, { eager = false, w = 2560, h = 1600 } = {}) {
  const pic = (t) => html`<picture class="shot-${t}">
    <source media="(max-width: 640px)" srcset="/hub/static/site/${name}-m-${t}.webp" width="780" height="1120">
    <img src="/hub/static/site/${name}-${t}.webp" width="${w}" height="${h}" alt="${alt}" loading="lazy" ${eager ? html`fetchpriority="high"` : ''} decoding="async">
  </picture>`;
  return html`${pic('light')}${pic('dark')}`;
}

// A terminal block: the real CLI's output format, demo values.
function term(title, lines) {
  return html`<figure class="term">
  <figcaption class="term-head"><span class="term-title">${title}</span><span class="term-note">Example output</span></figcaption>
  <pre class="term-body"><code>${lines.map((l) => (l.startsWith('$ ') ? html`<span class="t-cmd"><span class="t-ps" aria-hidden="true">$ </span>${l.slice(2)}</span>\n` : l.startsWith('# ') ? html`<span class="t-dim">${l}</span>\n` : html`${l}\n`))}</code></pre>
</figure>`;
}

const RUNS = [
  '$ grapim runs',
  "RUN              WORKING ON                            FILES  +     -",
  "claude 7f3e21aa  Add idempotency keys to POST /orders  3      +32   -4",
  "codex 11349      Clean up the feature flag for search  1      +86   -32",
  "claude 2b9c0d14  Return 409 when a key is reused       1      +12   -1",
];

const UNDO = [
  '$ grapim undo 11349',
  'Undo codex 11349 · 1 file',
  '',
  '  revert    src/flags.ts  its edits removed, later work by others kept',
  '',
  'Nothing was changed. Run again with --yes to apply the 1 clean one.',
  '',
  '$ grapim undo 11349 --yes',
];

// The pull request story: the comment and check use the wording the GitHub
// App writes (src/provenance/render.js, src/hub/github/pull.js).
function prThread() {
  return html`<div class="pr" role="img" aria-label="A pull request with the Grapim comment: one of two agent runs is not reviewed, so the Grapim check fails. After a teammate approves the run in the Grapim hub, the check passes.">
  <div class="pr-title"><span class="pr-state">Open</span><span><b>Add idempotency keys to POST /orders</b> <span class="muted">acme-co/shop-api #412</span></span></div>
  <div class="pr-item">
    <div class="pr-who"><span class="pr-av" aria-hidden="true">${LOGO}</span><b>grapim</b><span class="pr-bot">bot</span><span class="muted">commented</span></div>
    <div class="pr-card">
      <p class="pr-h">Grapim provenance</p>
      <p><b>1 agent run of 2 not reviewed yet.</b> 85% of the added lines came from agent runs (44 of 52): claude 7f3e21aa 32, claude 2b9c0d14 12</p>
      <div class="pr-scroll"><table class="pr-table">
        <thead><tr><th>Run</th><th>Agent</th><th class="n">Lines</th><th class="n">Files</th><th>Prompt</th><th>Review</th></tr></thead>
        <tbody>
          <tr><td class="mono">claude 7f3e21aa</td><td>claude-code</td><td class="n">32</td><td class="n">3</td><td>Add idempotency keys to POST /orders</td><td>Not reviewed</td></tr>
          <tr><td class="mono">claude 2b9c0d14</td><td>claude-code</td><td class="n">12</td><td class="n">1</td><td>Return 409 when a key is reused with another body</td><td>Approved</td></tr>
        </tbody>
      </table></div>
      <p class="pr-sub">Not reviewed in Grapim</p>
      <ul><li class="mono">claude 7f3e21aa</li></ul>
    </div>
  </div>
  <div class="pr-check is-fail">${ICON.x}<span><b>Grapim provenance (app)</b> <span class="muted">1 agent run not approved in the Grapim hub</span></span><span class="pr-req">Required</span></div>
  <div class="pr-event">${ICON.check}<span><b>priya</b> approved <span class="mono">claude 7f3e21aa</span> in the Grapim hub. The check runs again; nobody pushes.</span></div>
  <div class="pr-check is-ok">${ICON.check}<span><b>Grapim provenance (app)</b> <span class="muted">Every agent run is approved in the Grapim hub</span></span><span class="pr-req">Required</span></div>
  <div class="pr-merge">${ICON.check}<span>All checks have passed. This branch can be merged.</span></div>
</div>`;
}

const PLANS = [
  {
    name: 'Free',
    price: '$0',
    per: '',
    lede: 'Try it on a side project or one team.',
    items: ['Up to 3 people', '2 repos, 7 days of history', 'Run review, undo, PR comment', '1 workspace', 'Ask Grapim: $1 of use a month'],
  },
  {
    name: 'Team',
    price: '$20',
    per: 'per seat a month',
    lede: 'For a team that reviews agent work every day.',
    items: ['As many seats as you need', 'Unlimited repos, 90 days of history', 'Unlimited workspaces', 'Ask Grapim: $20 of use a month'],
  },
  {
    name: 'Governance',
    price: '$40',
    per: 'per seat a month',
    lede: 'When every AI change needs a named approver.',
    items: ['Everything in Team', 'Require review: the PR check blocks merging', 'Require provenance for every commit', 'Reports and CSV export', '365 days of history', 'Ask Grapim: $50 of use a month'],
    mark: true,
  },
  {
    name: 'Enterprise',
    price: 'Talk to us',
    per: '',
    lede: 'Seats, terms and support for a larger rollout.',
    items: ['Everything in Governance', 'Seats and terms agreed with you', 'Ask Grapim: $100 of use a month'],
  },
];

export function landingPage({ origin }) {
  const description = 'Grapim records every coding-agent run, puts each one in front of a reviewer, blocks the merge until someone approves it, and undoes a single run. For teams using Claude Code, Codex, Cursor and Gemini CLI.';
  return html`${siteHead({ title: 'Grapim: every AI change to your code has someone accountable for it', description, path: '/', origin })}
<body class="site">
<a class="skip" href="#main">Skip to content</a>
${siteBar({ current: 'home' })}
<main id="main">

<section class="hero" aria-labelledby="hero-title">
  <div class="hero-text">
    <h1 id="hero-title">Every AI change to your code has someone accountable for it.</h1>
    <p class="hero-sub">Grapim records which agent run made each change and what it was asked to do, puts every run in front of a reviewer, and holds the pull request until a teammate approves it. If a run was wrong, undo just that run.</p>
    <div class="cta">
      <a class="btn btn-primary btn-lg" href="${SIGN_IN}" rel="nofollow">${GH}<span>Sign in with GitHub</span></a>
      <a class="btn btn-lg" href="/docs">Read the docs</a>
    </div>
    <p class="fine">Free while in early access. Records Claude Code, Codex, Cursor and Gemini CLI.</p>
  </div>
  <figure class="frame frame-hero">
    ${shot('run', 'A run page in the Grapim hub: the run "Add idempotency keys to POST /orders" by claude 7f3e21aa, 2 turns, 3 files, +32 −4, marked Needs review, with Approve and Reject buttons, its prompts and its diff.', { eager: true })}
    <figcaption>A run waiting for review in the Grapim hub. Demo data.</figcaption>
  </figure>
</section>

<section class="band problem" aria-labelledby="problem-title">
  <div class="wrap">
    <h2 id="problem-title">Code review was built for code people wrote.</h2>
    <div class="problem-grid">
      <div><h3>Agents write more of every diff.</h3><p>One pull request now mixes several agent runs and a few human edits. Nothing in it says which lines came from which run, or what the agent was asked to do.</p></div>
      <div><h3>Review cannot keep up.</h3><p>A 600-line agent diff gets a skim and an approve. Afterwards nobody can say which agent work a person actually looked at.</p></div>
      <div><h3>One bad run is hard to take back.</h3><p>Reverting the commit throws away the good work that landed with it, and the agent's edits are spread across files.</p></div>
      <div><h3>Auditors ask who approved it.</h3><p>Change-management controls expect a named reviewer for every change to production code, including the changes an agent wrote.</p></div>
    </div>
  </div>
</section>

<section class="how" id="how" aria-labelledby="how-title">
  <div class="wrap">
    <h2 id="how-title" class="sec-title">How Grapim works</h2>
    <p class="sec-lede">Four steps, on the GitHub you already use. Your repos stay where they are; Grapim adds a record, a review and a check.</p>

    <ol class="steps">
      <li class="step">
        <div class="step-text">
          <span class="step-n" aria-hidden="true">1</span>
          <h3>Record every agent run</h3>
          <p><code>npm install -g grapim</code>, then <code>grapim init</code> in a repo, sets up the hooks of the agents it finds (Claude Code, Codex, Cursor, Gemini CLI) and two git hooks. From then on each agent run is recorded on the machine: the agent, every prompt, the files and lines it changed. Each commit gets a provenance note saying which lines came from which run.</p>
          <p><code>grapim sync</code> sends the runs to your team's hub with a machine token.</p>
        </div>
        <div class="step-vis">${term('Terminal', RUNS)}</div>
      </li>
      <li class="step">
        <div class="step-text">
          <span class="step-n" aria-hidden="true">2</span>
          <h3>Review each run, not a wall of lines</h3>
          <p>The hub lists the runs waiting for you. Open one to see what it was asked, turn by turn, and the diff it produced. Approve or reject it, with a note.</p>
          <p>The person who synced a run cannot approve it, and a run that changes after approval needs approving again.</p>
        </div>
        <figure class="step-vis frame">${shot('reviews', 'The Reviews page in the Grapim hub: a list of agent runs that need review, each with its prompt, agent, machine, repo, files and lines added and removed.')}<figcaption>The review inbox. Demo data.</figcaption></figure>
      </li>
    </ol>
  </div>
</section>

<section class="gate" aria-labelledby="gate-title">
  <div class="wrap gate-in">
    <div class="gate-text">
      <span class="step-n" aria-hidden="true">3</span>
      <h2 id="gate-title">The merge waits for a person.</h2>
      <p>Install the Grapim GitHub App and every pull request gets a comment listing its agent runs: how many lines each wrote, the prompt behind it, and whether it has been reviewed.</p>
      <p>Turn on <b>Require review</b> and the <code>Grapim provenance (app)</code> check fails until every agent run in the pull request is approved in the hub. An approval in the hub re-runs the check; nobody has to push. Make it a required check in your branch rules and unreviewed agent code cannot merge.</p>
      <p><a class="link" href="/docs/github">Set up the GitHub App ${ICON.arrow}</a></p>
    </div>
    <div class="gate-vis">${prThread()}<p class="vis-note">Illustration with demo data. The comment and check use the App's own wording.</p></div>
  </div>
</section>

<section class="how how-2" aria-labelledby="undo-title">
  <div class="wrap">
    <ol class="steps" start="4">
      <li class="step">
        <div class="step-text">
          <span class="step-n" aria-hidden="true">4</span>
          <h3 id="undo-title">Undo one run, keep everything else</h3>
          <p><code>grapim undo &lt;run&gt;</code> takes one run's changes out of every file it touched and keeps the work other agents and people did afterwards. It prints the plan first and changes nothing until you add <code>--yes</code>.</p>
          <p>If someone else has since edited the same lines, that file is left for you and undo says so. Undo runs on the machine that made the edits; the hub never changes your code.</p>
        </div>
        <div class="step-vis">${term('Terminal', UNDO)}</div>
      </li>
    </ol>
  </div>
</section>

<section class="reports" aria-labelledby="reports-title">
  <div class="wrap reports-in">
    <div class="reports-text">
      <h2 id="reports-title" class="sec-title">Evidence for the audit, without a spreadsheet</h2>
      <p class="sec-lede">Every decision in the hub is kept with who made it and when. Reports turn that into answers you can hand over.</p>
      <dl class="facts">
        <div><dt>Merged without review</dt><dd>AI-written lines that reached the default branch from runs nobody approved, by run, repo and agent.</dd></div>
        <div><dt>AI share</dt><dd>How much of the added code agents wrote, week by week, per repo and per agent.</dd></div>
        <div><dt>Agents</dt><dd>Runs, lines, undo rate, reject rate and review time for each agent.</dd></div>
        <div><dt>Export</dt><dd>Every report as CSV, for any date range in your plan's history.</dd></div>
      </dl>
      <p class="fine">Reports are on the Governance plan. Lines from commits Grapim did not record are shown as unknown, never counted as human.</p>
    </div>
    <figure class="frame reports-vis">${shot('reports', 'The Reports page in the Grapim hub: merged without review. Unreviewed AI lines, pending review, rejected lines still in commits, runs not approved, and a table of runs by review state.')}<figcaption>Merged without review, last 12 weeks. Demo data.</figcaption></figure>
  </div>
</section>

<section class="also" aria-labelledby="also-title">
  <div class="wrap">
    <h2 id="also-title" class="sr-only">Also in Grapim</h2>
    <div class="also-grid">
      <div>
        <h3>Ask Grapim</h3>
        <p>An assistant in the hub that answers questions about your team's runs, reviews and reports, and prepares an approval, an invite link or a workspace change for you to confirm. It can read what you can read; it cannot change anything on its own.</p>
        <p><a class="link" href="/docs/ask-grapim">How Ask Grapim works ${ICON.arrow}</a></p>
      </div>
      <div>
        <h3>Workspaces</h3>
        <p>Agents that write docs or data, not code, get a shared folder on the hub. They read and write it over HTTPS or MCP; every write is recorded, reviewable and undoable, and people can sync it to a local folder.</p>
        <p><a class="link" href="/docs/workspaces">How workspaces work ${ICON.arrow}</a></p>
      </div>
    </div>
  </div>
</section>

<section class="agents" id="agents" aria-labelledby="agents-title">
  <div class="wrap">
    <h2 id="agents-title" class="sec-title">Which agents it records</h2>
    <p class="sec-lede">Exactly what is recorded today, per agent.</p>
    <div class="table-scroll"><table class="agents-table">
      <thead><tr><th scope="col">Agent</th><th scope="col">How it connects</th><th scope="col">What is recorded</th></tr></thead>
      <tbody>
        <tr><th scope="row">Claude Code</th><td>Hooks, set up by <code>grapim init</code> or the Claude Code plugin</td><td>Every Edit, Write, MultiEdit and NotebookEdit, by prompt. Two agents are stopped from editing the same file at once.</td></tr>
        <tr><th scope="row">Codex CLI</th><td>Hooks in <code>.codex/hooks.json</code>, set up by <code>grapim init</code></td><td>Every <code>apply_patch</code> edit, by prompt, once you trust the project's hooks in Codex.</td></tr>
        <tr><th scope="row">Cursor</th><td>Hooks in <code>.cursor/hooks.json</code>, set up by <code>grapim init</code></td><td>Every file edit the agent makes, by prompt.</td></tr>
        <tr><th scope="row">Gemini CLI</th><td>Hooks in <code>.gemini/settings.json</code>, set up by <code>grapim init</code></td><td>Every <code>write_file</code> and <code>replace</code>, by prompt.</td></tr>
        <tr><th scope="row">Other MCP clients</th><td>Grapim's MCP server, <code>grapim mcp</code></td><td>The files the agent claims, from claim to release, labelled with the client's name.</td></tr>
      </tbody>
    </table></div>
    <p class="fine">Edits made outside these paths, such as a shell command an agent runs, show up as "outside agents": counted, never credited to a run. Commits made after <code>grapim init</code> carry a note either way, so a human-only commit is recorded as human.</p>
  </div>
</section>

<section class="security" id="security" aria-labelledby="security-title">
  <div class="wrap">
    <h2 id="security-title" class="sec-title">What Grapim can see, and what it cannot</h2>
    <p class="sec-lede">The hub holds your team's agent history, so here is exactly what reaches it.</p>
    <div class="sec-grid">
      <ul class="ticks">
        <li>${ICON.check}<span><b>Code reaches the hub only from machines you connect.</b> A machine runs <code>grapim sync</code> with a token you created; nothing is pulled from your repositories.</span></li>
        <li>${ICON.check}<span><b>Sign-in asks GitHub for nothing but your public profile.</b> No OAuth scopes, no email, no repository access. The GitHub token is used once and dropped.</span></li>
        <li>${ICON.check}<span><b>Tokens are stored as hashes.</b> Machine tokens and invite links are shown once and kept only as SHA-256. A member's machine tokens stop working when they leave the team.</span></li>
        <li>${ICON.check}<span><b>Teams are isolated on every route.</b> Another team's ids answer "not found"; a test calls every route as an outsider to prove it.</span></li>
        <li>${ICON.check}<span><b>The hub never writes to your repositories.</b> Undo runs on your machine. The GitHub App only comments and posts its check.</span></li>
        <li>${ICON.check}<span><b>Prompts can stay out of git.</b> <code>grapim init --no-intents</code> writes provenance notes without the prompt text.</span></li>
      </ul>
      <div class="notyet">
        <h3>Not built yet</h3>
        <p>So you can judge for yourself:</p>
        <ul>
          <li>No SSO or SAML; sign-in is GitHub only.</li>
          <li>No encryption at rest beyond the hosting platform's disk encryption.</li>
          <li>No automatic deletion of synced history yet.</li>
          <li>No audit log of who viewed what in the hub.</li>
          <li>No external penetration test or compliance certification.</li>
        </ul>
        <p><a class="link" href="/docs/security">Read the security model ${ICON.arrow}</a></p>
      </div>
    </div>
  </div>
</section>

<section class="pricing" id="pricing" aria-labelledby="pricing-title">
  <div class="wrap">
    <h2 id="pricing-title" class="sec-title">Pricing</h2>
    <p class="sec-lede">Grapim is in early access, and nothing is charged yet: there is no checkout. These are the plans and prices we intend to charge once billing opens. Want Require review or reports for a pilot now? <a class="link" href="/docs/support">Talk to us</a>.</p>
    <div class="plans">
      ${PLANS.map((p) => html`<section class="plan${p.mark ? ' plan-mark' : ''}" aria-labelledby="plan-${p.name.toLowerCase()}">
        <h3 id="plan-${p.name.toLowerCase()}">${p.name}</h3>
        <p class="plan-price"><span class="num">${p.price}</span>${p.per ? html`<span class="plan-per">${p.per}</span>` : ''}</p>
        <p class="plan-lede">${p.lede}</p>
        <ul>${p.items.map((i) => html`<li>${ICON.check}<span>${i}</span></li>`)}</ul>
      </section>`)}
    </div>
    <p class="fine">Prices in US dollars. Yearly: Team $192 and Governance $384 per seat. Ask Grapim's monthly amount is model use at list price; an owner can set a lower limit.</p>
  </div>
</section>

<section class="close" aria-labelledby="close-title">
  <div class="wrap close-in">
    <h2 id="close-title">Know who approved every line an agent wrote.</h2>
    <p>Sign in, create a team, and run <code>grapim init</code> in one repo. The quickstart takes about five minutes.</p>
    <div class="cta">
      <a class="btn btn-primary btn-lg" href="${SIGN_IN}" rel="nofollow">${GH}<span>Sign in with GitHub</span></a>
      <a class="btn btn-lg" href="/docs">Read the quickstart</a>
    </div>
  </div>
</section>

</main>
${siteFooter()}
</body>
</html>`.toString();
}
