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

// The top bar. current: 'home' | 'docs' | 'pricing' | 'changelog'.
export function siteBar({ current = 'home', signedIn = false } = {}) {
  const a = (href, label, id) => html`<a class="bar-link" href="${href}" ${current === id ? html`aria-current="page"` : ''}>${label}</a>`;
  const home = current === 'home' ? '' : '/';
  const links = html`${a(`${home}#how`, 'How it works', 'how')}${a('/docs/security', 'Security', 'security')}${a('/pricing', 'Pricing', 'pricing')}${a('/changelog', 'Changelog', 'changelog')}${a('/docs', 'Docs', 'docs')}`;
  return html`<header class="bar">
  <div class="bar-in">
    <a class="bar-brand" href="/" aria-label="Grapim home">${LOGO}<span>Grapim</span></a>
    <nav class="bar-nav" aria-label="Site">${links}</nav>
    <details class="bar-menu">
      <summary aria-label="Menu">${ICON.menu}</summary>
      <nav class="bar-menu-list" aria-label="Site, small screens">${links}</nav>
    </details>
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
      <p>A record of what your coding agents change, and a way to take one run back.</p>
      <div class="theme-seg" role="group" aria-label="Theme">${theme('system', 'System', 'system')}${theme('light', 'Light', 'sun')}${theme('dark', 'Dark', 'moon')}</div>
    </div>
    <nav class="foot-cols" aria-label="Footer">
      <div><h2>Product</h2><a href="/#how">How it works</a><a href="/docs/concepts">Supported agents</a><a href="/docs/security">Security</a><a href="/pricing">Pricing</a><a href="/changelog">Changelog</a></div>
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
  <figcaption class="term-head"><span class="term-title">${title}</span></figcaption>
  <pre class="term-body"><code>${lines.map((l) => (l.startsWith('$ ') ? html`<span class="t-line t-cmd"><span class="t-ps" aria-hidden="true">$ </span>${l.slice(2)}</span>\n` : l.startsWith('# ') ? html`<span class="t-line t-dim">${l}</span>\n` : html`<span class="t-line${l.includes('via shell') ? ' t-hl' : ''}">${l}</span>\n`))}</code></pre>
</figure>`;
}

// The pull request story: the comment and check use the wording the GitHub
// App writes (src/provenance/render.js, src/hub/github/pull.js).
function prThread() {
  return html`<div class="pr" data-play role="img" aria-label="Pull request 412 with three agent runs. The Codex run changed only tests and passed by rule, the Claude run was approved by sam, and the Cursor run changed db/, so the Grapim check fails until priya approves it. Alex undoes the Cursor run and pushes; the check runs again and passes.">
  <div class="pr-title"><span class="pr-state">Open</span><span><b>Add idempotency keys to POST /orders</b> <span class="muted">acme-co/shop-api #412</span></span></div>
  <div class="pr-item">
    <div class="pr-who"><span class="pr-av" aria-hidden="true">${LOGO}</span><b>grapim</b><span class="pr-bot">bot</span><span class="muted">commented</span></div>
    <div class="pr-card">
      <p class="pr-h">Grapim provenance</p>
      <p><b>1 agent run of 3 not reviewed yet.</b> 62 of the 74 added lines came from agent runs.</p>
      <div class="pr-scroll"><table class="pr-table">
        <thead><tr><th>Run</th><th class="n">Lines</th><th>Prompt</th><th>Review</th></tr></thead>
        <tbody>
          <tr><td class="mono">claude 7f3e21aa</td><td class="n">32</td><td>Add idempotency keys to POST /orders</td><td>Approved by sam</td></tr>
          <tr><td class="mono">codex 4c8e1b07</td><td class="n">27</td><td>Add tests for duplicate order keys</td><td>Approved by rule</td></tr>
          <tr><td class="mono">cursor 5d81c0e2</td><td class="n">3</td><td>Clean up the old orders schema</td><td>Not reviewed</td></tr>
        </tbody>
      </table></div>
    </div>
  </div>
  <div class="pr-check is-fail">${ICON.x}<span><b>Grapim provenance (app)</b> <span class="muted">cursor 5d81c0e2 changed db/: db/** needs 1 approval from priya</span></span><span class="pr-req">Required</span></div>
  <div class="pr-event">${ICON.check}<span><b>alex</b> ran <span class="mono">grapim undo 5d81c0e2</span> and pushed. The check runs again.</span></div>
  <div class="pr-check is-ok">${ICON.check}<span><b>Grapim provenance (app)</b> <span class="muted">Every agent run is approved in the Grapim hub (1 by rule)</span></span><span class="pr-req">Required</span></div>
  <div class="pr-merge">${ICON.check}<span>All checks have passed. This branch can be merged.</span></div>
</div>`;
}

const PLANS = [
  {
    name: 'Free',
    price: '$0',
    per: '',
    lede: 'For one team trying it on a repo.',
    items: ['Up to 3 people', '2 repos, 7 days of history', 'Every run recorded, shell commands too', 'Undo any run', 'Agent and MCP inventory'],
  },
  {
    name: 'Team',
    price: '$20',
    per: 'per seat a month',
    lede: 'For a team whose agents ship code every day.',
    items: ['Everything in Free', 'As many seats as you need', 'Unlimited repos', '90 days of history', 'Unlimited workspaces'],
  },
  {
    name: 'Governance',
    price: '$40',
    per: 'per seat a month',
    lede: 'When a person must approve what agents change.',
    items: ['Everything in Team', 'Path rules: auto-approve or named reviewer', 'Required PR check that blocks merging', 'Reports and CSV export', '365 days of history'],
    mark: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    per: '',
    lede: 'Seats, terms and support for a larger rollout.',
    items: ['Everything in Governance', 'Seats and terms agreed with you', 'Help with the rollout'],
  },
];

const FAQ = [
  ['Is anything charged today?', 'No. Grapim is in early access and has no checkout. These are the prices we intend to charge once billing opens, and we will tell every team before that happens.'],
  ['Can we try Governance now?', 'Yes. Design partners get Governance as a pilot at no charge, set by us for your team. Talk to us and say which repos you want to start with.'],
  ['What counts as a seat?', 'A member of your team in the Grapim hub. Agents are not seats, and neither are the machines that sync runs.'],
  ['Does our code have to leave our machines?', 'No. Turn on No code storage and the hub keeps run records (agent, prompt, files, line counts, hashes, decisions) without file contents. Diffs are read from GitHub when someone opens a run and are not saved.'],
  ['Which agents are covered?', 'Claude Code, Codex CLI, Cursor and Gemini CLI, including files their shell commands change. Any other MCP client can report the files it claims.'],
];

// One incident, used on the whole page: in acme-co/shop-api, three agents
// work on PR #412. A Cursor run's shell commands add a migration that drops
// the legacy orders table and delete seed.js; the check holds the PR; one
// command takes that run back and keeps the other two. Sample data from the
// demo repo, in the real output formats of the CLI and the GitHub App.
const RUNS = [
  '$ grapim log',
  '14:01:52  claude 7f3e21aa edited src/routes/orders.ts +32 -4',
  '14:01:58  codex 4c8e1b07 edited test/orders.test.ts +27 -0',
  '14:02:07  cursor 5d81c0e2 edited db/014.sql +3 -0 via shell: prisma migrate',
  '14:02:19  cursor 5d81c0e2 edited seed.js +0 -88 via shell: rm seed.js',
];

const UNDO = [
  '$ grapim undo 5d81c0e2 --yes',
  'Undo cursor 5d81c0e2 · 2 files',
  '',
  '  deleted   db/014.sql  created by this run (via shell: prisma migrate)',
  '  restored  seed.js     deleted by this run (via shell: rm seed.js)',
  '',
  'Done: 2 files changed.',
];

// The incident as a printed log: each line is one thing that happened, in
// order. The rows print in turn (site.css .ledger), and once the undo line
// lands the two Cursor rows are struck through.
const LEDGER = [
  { t: '14:01:52', who: 'claude 7f3e21aa', what: html`edited <code>src/routes/orders.ts</code>`, n: '+32 −4' },
  { t: '14:01:58', who: 'codex 4c8e1b07', what: html`edited <code>test/orders.test.ts</code>`, n: '+27' },
  { t: '14:02:07', who: 'cursor 5d81c0e2', what: html`ran <code>prisma migrate</code>, which wrote <code>db/014.sql</code>: drop table legacy_orders`, n: '+3', cls: 'is-bad' },
  { t: '14:02:19', who: 'cursor 5d81c0e2', what: html`ran <code>rm seed.js</code>`, n: '−88', cls: 'is-bad' },
  { t: '14:02:40', who: 'PR #412', what: html`check held: <code>db/</code> changes wait for priya`, cls: 'is-hold' },
  { t: '14:03:05', who: 'alex', what: html`ran <code>grapim undo 5d81c0e2 --yes</code>. Both files back; the Claude and Codex runs stay.`, cls: 'is-undo' },
];

function ledger() {
  return html`<figure class="ledger" data-play aria-label="Log of PR 412 in acme-co/shop-api. At 14:02 a Cursor run ran prisma migrate, writing a migration that drops the legacy orders table, and deleted seed.js. The pull request check held the change for priya. At 14:03 grapim undo took that Cursor run back; the Claude and Codex runs stayed.">
  <figcaption class="ledger-head"><span>acme-co/shop-api · PR #412</span><span>Thu 13 Nov</span></figcaption>
  <ol class="ledger-rows">
    ${LEDGER.map((r) => html`<li class="${r.cls ?? ''}"><time>${r.t}</time><span class="ledger-who">${r.who}</span><span class="ledger-what">${r.what}</span><span class="ledger-n">${r.n ?? ''}</span></li>`)}
  </ol>
</figure>`;
}

// The walkthrough: the same incident, one stage at a time, each with the
// artifact a team would actually see.
const STAGES = [
  {
    id: 'recorded',
    t: '14:02',
    title: 'It was on the record before anyone looked',
    body: 'Grapim hooks into Claude Code, Codex, Cursor and Gemini CLI on the developer’s machine. Each edit, and each file a shell command creates or deletes, is written down under the run that made it, with the prompt that started it.',
    link: ['/docs/cli', 'What the hooks record'],
    vis: () => term('Terminal', RUNS),
  },
  {
    id: 'held',
    t: '14:02:40',
    title: 'The pull request waited for priya',
    body: 'You choose which paths need a person. A run that touches them keeps the Grapim check red until the reviewer you named approves it in the hub. Runs that only change tests or docs can pass on a rule, and the rule’s author is on record.',
    link: ['/docs/rules', 'How review rules work'],
    vis: () => prThread(),
  },
  {
    id: 'undone',
    t: '14:03',
    title: 'One run came back out, and nothing else moved',
    body: html`<code>grapim undo</code> removes a single run from every file it touched, including what its shell commands did. Work that other agents and people did around it stays. It prints a plan first and changes nothing until you add <code>--yes</code>.`,
    link: ['/docs/undo', 'What undo can and cannot take back'],
    vis: () => term('Terminal', UNDO),
  },
];

// What leaves the developer's machine (src/hub/docs/data-handling.md).
const DATA = [
  ['Run id, agent, start time, the first line of each prompt', 'Sent', 'Sent'],
  ['File paths, lines added and removed, a hash of each version', 'Sent', 'Sent'],
  ['Shell command text, with tokens and passwords masked', 'Sent', 'Sent'],
  ['Review decisions: who approved what, and when', 'Kept in the hub', 'Kept in the hub'],
  ['File contents, up to 2 MB a file', 'Sent', 'Never stored'],
  ['Environment values, keys, MCP arguments', 'Never collected', 'Never collected'],
];

const description = 'Grapim records what each coding agent changes, shell commands included, holds sensitive changes for a named reviewer, and takes one bad run back without touching anyone else’s work. For Claude Code, Codex, Cursor and Gemini CLI on GitHub.';

export function landingPage({ origin }) {
  return html`${siteHead({ title: 'Grapim: a record of what your coding agents change', description, path: '/', origin })}
<body class="site site-ledger">
<a class="skip" href="#main">Skip to content</a>
${siteBar({ current: 'home' })}
<main id="main">

<section class="l-hero" aria-labelledby="hero-title">
  <div class="wrap l-hero-in">
    <div class="l-hero-copy">
      <h1 id="hero-title">An agent dropped a table at 14:02.<br> It was back at 14:03.</h1>
      <p class="l-lede">Grapim keeps a record of what each coding agent changes, shell commands included, so one bad run can be taken back without touching anyone else’s work.</p>
      <div class="cta">
        <a class="btn btn-primary btn-lg" href="${SIGN_IN}" rel="nofollow">${GH}<span>Start with GitHub</span></a>
        <a class="btn btn-lg" href="#film">Watch the one-minute demo</a>
      </div>
      <p class="l-note">Free during early access. Works with Claude Code, Codex, Cursor and Gemini CLI, on your existing GitHub.</p>
    </div>
    ${ledger()}
  </div>
  <p class="wrap l-sample">The incident on this page is sample data from our demo repo, shown in the CLI’s and the GitHub App’s real output.</p>
</section>

<section class="l-shot" aria-label="The run page in the Grapim hub">
  <figure class="wrap frame">
    ${shot('run', 'A run page in the Grapim hub: the run "Add idempotency keys to POST /orders" by claude 7f3e21aa, 2 turns, 3 files, +32 −4, marked Needs review, with Approve and Reject buttons, its prompts and its diff.', { eager: true })}
  </figure>
</section>

<section class="l-steps" id="how" aria-labelledby="how-title">
  <div class="wrap">
    <h2 id="how-title" class="l-h2">How the 14:02 incident played out</h2>
    <ol class="l-stage-list">
      ${STAGES.map((s) => html`<li class="l-stage" id="${s.id}">
        <p class="l-stage-time"><time>${s.t}</time></p>
        <div class="l-stage-body">
          <h3>${s.title}</h3>
          <p>${s.body}</p>
          <p><a class="link" href="${s.link[0]}">${s.link[1]}</a></p>
          <div class="l-stage-vis">${s.vis()}</div>
        </div>
      </li>`)}
    </ol>
  </div>
</section>

<section class="l-film" id="film" aria-labelledby="film-title">
  <div class="wrap l-film-in">
    <h2 id="film-title" class="l-h2">The same afternoon, narrated, in one minute</h2>
    <video class="film-video" controls preload="none" playsinline poster="/hub/static/site/demo-poster.webp" width="1280" height="720">
      <source src="/hub/static/site/demo.mp4" type="video/mp4">
      <a href="/hub/static/site/demo.mp4">Watch the one-minute demo</a>
    </video>
  </div>
</section>

<section class="l-data" id="security" aria-labelledby="data-title">
  <div class="wrap l-data-in">
    <div class="l-data-copy">
      <h2 id="data-title" class="l-h2">What leaves the developer’s machine</h2>
      <p>Your repositories stay on GitHub and the hub never writes to them. Undo runs on the machine that made the edits. If you would rather the hub never hold your code, turn on No code storage: diffs are then read from GitHub when someone opens a run, and not kept.</p>
      <p><a class="link" href="/docs/data-handling">The full list, field by field</a></p>
    </div>
    <div class="table-scroll"><table class="l-table">
      <thead><tr><th scope="col">What</th><th scope="col">Default</th><th scope="col">No code storage</th></tr></thead>
      <tbody>${DATA.map(([what, a, b]) => html`<tr><th scope="row">${what}</th><td class="${a.startsWith('Never') ? 'is-never' : ''}">${a}</td><td class="${b.startsWith('Never') ? 'is-never' : ''}">${b}</td></tr>`)}</tbody>
    </table></div>
  </div>
</section>

<section class="l-close" aria-labelledby="close-title">
  <div class="wrap">
    <h2 id="close-title">Put it on the repo your agents touch most.</h2>
    <p>Sign in with GitHub, run <code>grapim init</code> in that repo, and the next agent run is on the record. About five minutes.</p>
    <div class="cta">
      <a class="btn btn-primary btn-lg" href="${SIGN_IN}" rel="nofollow">${GH}<span>Start with GitHub</span></a>
      <a class="btn btn-lg" href="/pricing">Pricing</a>
    </div>
  </div>
</section>

</main>
${siteFooter()}
</body>
</html>`.toString();
}

export function pricingPage({ origin, signedIn = false }) {
  return html`${siteHead({ title: 'Pricing', description: 'Grapim plans: Free, Team at $20 and Governance at $40 per seat a month, and Enterprise. Nothing is charged during early access.', path: '/pricing', origin })}
<body class="site">
<a class="skip" href="#main">Skip to content</a>
${siteBar({ current: 'pricing', signedIn })}
<main id="main">

<section class="pricing pricing-page" id="pricing" aria-labelledby="pricing-title">
  <div class="wrap">
    <h1 id="pricing-title" class="sec-title">Pricing</h1>
    <p class="sec-lede">Free while in early access: nothing is charged yet. These are the prices once billing opens.</p>
    <div class="plans">
      ${PLANS.map((p) => html`<section class="plan${p.mark ? ' plan-mark' : ''}" aria-labelledby="plan-${p.name.toLowerCase()}">
        <h2 id="plan-${p.name.toLowerCase()}">${p.name}</h2>
        <p class="plan-price"><span class="num">${p.price}</span>${p.per ? html`<span class="plan-per">${p.per}</span>` : ''}</p>
        <p class="plan-lede">${p.lede}</p>
        ${p.name === 'Free' ? html`<a class="btn plan-cta" href="${SIGN_IN}" rel="nofollow">Start with GitHub</a>` : p.name === 'Enterprise' || p.mark ? html`<a class="btn${p.mark ? ' btn-primary' : ''} plan-cta" href="/docs/support">${p.mark ? 'Ask for a pilot' : 'Talk to us'}</a>` : html`<a class="btn plan-cta" href="${SIGN_IN}" rel="nofollow">Start with GitHub</a>`}
        <ul>${p.items.map((i) => html`<li>${ICON.check}<span>${i}</span></li>`)}</ul>
      </section>`)}
    </div>
    <p class="fine">Prices in US dollars. Yearly: Team $192 and Governance $384 per seat.</p>
  </div>
</section>

<section class="faq" aria-labelledby="faq-title">
  <div class="wrap faq-in">
    <h2 id="faq-title" class="sec-title">Questions</h2>
    <div class="faq-list">
      ${FAQ.map(([q, a]) => html`<details><summary>${q}</summary><p>${a}</p></details>`)}
    </div>
  </div>
</section>

</main>
${siteFooter()}
</body>
</html>`.toString();
}

// The changelog: what shipped, newest first. Every entry is a change that is
// live on app.grapim.com, written for the people who use it; the links go to
// the docs page that explains it.
const CHANGES = [
  {
    date: '2026-11-13',
    items: [
      { title: 'Cursor shell commands are recorded and undoable', body: 'Files a Cursor agent changes with a shell command (a migration, an rm, a codegen script) now belong to its run, so grapim undo can take them back like any other edit. Run grapim init again to add the hook.', link: ['/docs/undo', 'How undo works'] },
      { title: 'Undo covers shell commands', body: 'For Claude Code, Codex and Gemini CLI, Grapim compares the worktree before and after each shell command, records every file it created, changed or deleted, and names the command in the run.', link: ['/docs/undo', 'What undo can take back'] },
      { title: 'Automatic path rules', body: 'A run that only touches tests or docs can pass on its own, with the rule and the person who set it on record. Runs that touch payments, auth or migrations still wait for the reviewer you named. New teams can start from a starter set.', link: ['/docs/rules', 'Write your first rule'] },
      { title: 'No code storage', body: 'Turn it on and the hub keeps run records, line counts and hashes, never file contents. When someone opens a run, the diff is read from GitHub for that view and not saved.', link: ['/docs/data-handling', 'What Grapim stores'] },
      { title: 'Agents page', body: 'See which coding agents, versions, models and MCP servers your team’s machines run, and which appeared this week. Only names, transports and hosts are collected.', link: ['/docs/inventory', 'What the inventory collects'] },
    ],
    more: ['Settings are split into short pages, one topic each.', 'Approve a run from the pull request check on GitHub.', 'Your last 90 days of AI code: how many merged pull requests had agent commits, and how many merged without a second person.', 'Pilot plans now unlock Governance features.'],
  },
  {
    date: '2026-11-12',
    items: [
      { title: 'Ask Grapim', body: 'An assistant in the hub that answers questions about your team’s runs, reviews and reports, and prepares an approval or an invite for you to confirm. It can read what you can read and changes nothing on its own.', link: ['/docs/ask-grapim', 'How Ask Grapim works'] },
    ],
    more: ['A collapsible, resizable sidebar.', 'Light and dark themes, with Inter and JetBrains Mono served from Grapim itself.'],
  },
  {
    date: '2026-11-11',
    items: [
      { title: 'Grapim, first release', body: 'Every coding-agent run recorded on the machine: the agent, each prompt, the files and lines it changed. grapim undo takes one run back out and keeps everyone else’s work.', link: ['/docs', 'Quickstart'] },
      { title: 'GitHub App and pull request check', body: 'Each pull request gets a comment listing its agent runs, and a check that blocks merging until every run is approved.', link: ['/docs/github', 'Set up the GitHub App'] },
      { title: 'Workspaces', body: 'Agents that write documents or data, not code, get a shared folder on the hub. Every write is recorded, reviewable and undoable.', link: ['/docs/workspaces', 'How workspaces work'] },
    ],
    more: [],
  },
];

const longDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export function changelogPage({ origin, signedIn = false }) {
  return html`${siteHead({ title: 'Changelog', description: 'What shipped in Grapim, newest first: shell-command undo for Cursor, automatic path rules, no code storage, the agents page and more.', path: '/changelog', origin })}
<body class="site">
<a class="skip" href="#main">Skip to content</a>
${siteBar({ current: 'changelog', signedIn })}
<main id="main">
<section class="log" aria-labelledby="log-title">
  <div class="wrap">
    <h1 id="log-title" class="sec-title">Changelog</h1>
    <p class="sec-lede">What shipped in Grapim, newest first.</p>
    ${CHANGES.map((day) => html`<section class="log-day" aria-labelledby="d-${day.date}">
      <h2 class="log-date" id="d-${day.date}"><time datetime="${day.date}">${longDate(day.date)}</time></h2>
      <div class="log-items">
        ${day.items.map((it) => html`<article class="log-item">
          <h3>${it.title}</h3>
          <p>${it.body}</p>
          <p><a class="link" href="${it.link[0]}">${it.link[1]} ${ICON.arrow}</a></p>
        </article>`)}
        ${day.more.length ? html`<div class="log-more"><h3>Also</h3><ul>${day.more.map((m) => html`<li>${m}</li>`)}</ul></div>` : ''}
      </div>
    </section>`)}
  </div>
</section>
</main>
${siteFooter()}
</body>
</html>`.toString();
}
