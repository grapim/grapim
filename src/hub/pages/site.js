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
  const links = html`${a(`${home}#how`, 'Product', 'how')}${a('/docs/security', 'Security', 'security')}${a('/pricing', 'Pricing', 'pricing')}${a('/changelog', 'Changelog', 'changelog')}${a('/docs', 'Docs', 'docs')}`;
  return html`${current === 'home' ? html`<p class="announce"><a href="/changelog"><b>13 Nov</b><span>Cursor shell commands<span class="announce-long"> are now recorded and can be undone.</span></span><span class="announce-go">Changelog ${ICON.arrow}</span></a></p>` : ''}<header class="bar">
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
      <p>See and undo what your coding agents change.</p>
      <p class="foot-legal">© 2026 Grapim</p>
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
  return html`<figure class="term" data-play>
  <figcaption class="term-head"><span class="term-title">${title}</span></figcaption>
  <pre class="term-body"><code>${lines.map((l) => (l.startsWith('$ ') ? html`<span class="t-line t-cmd"><span class="t-ps" aria-hidden="true">$ </span>${l.slice(2)}</span>\n` : l.startsWith('# ') ? html`<span class="t-line t-dim">${l}</span>\n` : html`<span class="t-line${l.includes('via shell') ? ' t-hl' : ''}">${l}</span>\n`))}</code></pre>
</figure>`;
}

const RUNS = [
  '$ grapim runs',
  'RUN              WORKING ON                            FILES  +     -',
  'claude 7f3e21aa  Add idempotency keys to POST /orders  3      +32   -4',
  'codex 4c8e1b07   Add tests for duplicate order keys    1      +27   -0',
  'cursor 5d81c0e2  Drop the legacy orders table          2      +3    -88',
  '',
  '$ grapim log',
  '14:02:07  cursor 5d81c0e2 edited db/014.sql +3 -0 via shell: prisma migrate',
  '14:02:19  cursor 5d81c0e2 edited seed.js +0 -88 via shell: rm seed.js',
];

const UNDO = [
  '$ grapim undo 5d81c0e2',
  'Undo cursor 5d81c0e2 · 2 files',
  '',
  '  delete    db/014.sql  created by this run (via shell: prisma migrate)',
  '  restore   seed.js     deleted by this run (via shell: rm seed.js)',
  '',
  'Nothing was changed. Run again with --yes to apply the 2 clean ones.',
  '',
  '$ grapim undo 5d81c0e2 --yes',
  'Undo cursor 5d81c0e2 · 2 files',
  '',
  '  deleted   db/014.sql  created by this run (via shell: prisma migrate)',
  '  restored  seed.js     deleted by this run (via shell: rm seed.js)',
  '',
  'Done: 2 files changed.',
];

// The pull request story: the comment and check use the wording the GitHub
// App writes (src/provenance/render.js, src/hub/github/pull.js).
function prThread() {
  return html`<div class="pr" data-play role="img" aria-label="A pull request with three agent runs. Two changed only tests and docs and were approved by the team's automatic rules. One changed payments code, so the Grapim check fails until the reviewer that rule names approves it; then the check passes.">
  <div class="pr-title"><span class="pr-state">Open</span><span><b>Add idempotency keys to POST /orders</b> <span class="muted">acme-co/shop-api #412</span></span></div>
  <div class="pr-item">
    <div class="pr-who"><span class="pr-av" aria-hidden="true">${LOGO}</span><b>grapim</b><span class="pr-bot">bot</span><span class="muted">commented</span></div>
    <div class="pr-card">
      <p class="pr-h">Grapim provenance</p>
      <p><b>1 agent run of 3 not reviewed yet.</b> 88% of the added lines came from agent runs (71 of 81).</p>
      <div class="pr-scroll"><table class="pr-table">
        <thead><tr><th>Run</th><th class="n">Lines</th><th>Prompt</th><th>Review</th></tr></thead>
        <tbody>
          <tr><td class="mono">claude 7f3e21aa</td><td class="n">32</td><td>Add idempotency keys to POST /orders</td><td>Not reviewed</td></tr>
          <tr><td class="mono">codex 4c8e1b07</td><td class="n">27</td><td>Add tests for duplicate order keys</td><td>Approved by rule</td></tr>
          <tr><td class="mono">claude 2b9c0d14</td><td class="n">12</td><td>Document the Idempotency-Key header</td><td>Approved by rule</td></tr>
        </tbody>
      </table></div>
    </div>
  </div>
  <div class="pr-check is-fail">${ICON.x}<span><b>Grapim provenance (app)</b> <span class="muted">claude 7f3e21aa changed payments/: needs 1 approval from priya</span></span><span class="pr-req">Required</span></div>
  <div class="pr-event">${ICON.check}<span><b>priya</b> approved <span class="mono">claude 7f3e21aa</span> in the Grapim hub.</span></div>
  <div class="pr-check is-ok">${ICON.check}<span><b>Grapim provenance (app)</b> <span class="muted">Every agent run is approved in the Grapim hub (2 by rule)</span></span><span class="pr-req">Required</span></div>
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

// The site's one brand graphic (design/illustration.md, C): five agent runs
// as glass plates, one warm run pulled out. Flat SVG for phones and reduced
// motion; the 3D version (stackFigure) for wide screens. No labels: the
// caption carries the meaning.
function isoFigure() {
  const cx = 170;
  const a = 112;
  const b = 56;
  const t = 10;
  const gap = 32;
  const top = 70;
  const pts = (list) => list.map(([x, y]) => `${x},${y}`).join(' ');
  const plate = (i) => {
    const out = i === 2;
    const y = top + i * gap + (out ? 52 : 0);
    const x = cx + (out ? 104 : 0);
    return html`<g class="iso-run${out ? ' iso-out' : ''}">
      <polygon class="iso-side" points="${pts([[x - a, y], [x, y + b], [x, y + b + t], [x - a, y + t]])}"/>
      <polygon class="iso-side iso-side-r" points="${pts([[x, y + b], [x + a, y], [x + a, y + t], [x, y + b + t]])}"/>
      <polygon class="iso-top" points="${pts([[x, y - b], [x + a, y], [x, y + b], [x - a, y]])}"/>
    </g>`;
  };
  return html`<figure class="iso" aria-hidden="true">
  <svg viewBox="0 0 420 330" width="420" height="330" focusable="false">
    <defs>
      <linearGradient id="iso-glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5b63e6" stop-opacity="0.26"/><stop offset="1" stop-color="#5b63e6" stop-opacity="0.08"/></linearGradient>
      <linearGradient id="iso-warm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff6b4a"/><stop offset="1" stop-color="#ff9a3d"/></linearGradient>
    </defs>
    ${[4, 3, 1, 0].map(plate)}${plate(2)}
  </svg>
  <figcaption class="iso-cap">The Cursor run comes out. The others stay where they were.</figcaption>
</figure>`;
}

// Real product fragments (design/illustration.md, B): pieces of the hub and
// of GitHub, rebuilt in HTML with the product's own words and the page's
// one demo repo. Decorative copies of real screens: the text beside each
// says the same thing.
function frag(caption, body) {
  return html`<figure class="frag" aria-hidden="true"><div class="frag-stage"><div class="frag-card">${body}</div></div><figcaption class="frag-cap">${caption}</figcaption></figure>`;
}

// Settings, Code storage (src/hub/pages/team.js codeStorageSection).
const FIG_HOME = () => frag('Settings in the hub, with No code storage on.', html`
  <div class="fc-head"><b>No code storage</b><span class="fc-badge fc-ok">On</span><span class="fc-btn">Turn off</span></div>
  <p class="fc-sub">When on, the hub keeps run metadata (agent, prompt, files, line counts, reviews), never stores file contents, and reads diffs from GitHub when someone opens a run.</p>
  <p class="fc-fine">The hub holds no file contents for this team.</p>`);

// Agents page, MCP servers (src/hub/pages/inventory.js).
const FIG_REACH = () => frag('The Agents page: every MCP server your team’s agents can call.', html`
  <div class="fc-head"><b>MCP servers</b><span class="fc-muted">3 servers · 1 new this week</span></div>
  <table class="fc-table">
    <thead><tr><th>Server</th><th>Last seen</th></tr></thead>
    <tbody>
      <tr><td><b>github</b><span class="fc-mono">github-mcp-server</span></td><td>2h ago</td></tr>
      <tr><td><b>postgres</b><span class="fc-mono">server-postgres</span></td><td>5h ago</td></tr>
      <tr><td><b>stripe</b> <span class="fc-badge fc-new">New this week</span><span class="fc-mono">mcp.stripe.com</span></td><td>20m ago</td></tr>
    </tbody>
  </table>`);

// The pull request's checks on GitHub (src/hub/github/pull.js wording).
const FIG_GITHUB = () => frag('On GitHub, Grapim only comments and posts its check.', html`
  <div class="fc-gh-head"><span class="fc-gh-ok">${ICON.check}</span><div><b>All checks have passed</b><span class="fc-muted">1 successful check</span></div></div>
  <div class="fc-gh-row"><span class="fc-gh-ok">${ICON.check}</span><span><b>Grapim provenance (app)</b> <span class="fc-muted">Every agent run is approved in the Grapim hub (2 by rule)</span></span><span class="fc-req">Required</span></div>
  <div class="fc-gh-merge">This branch has no conflicts with the base branch</div>`);

// The hero figure in real 3D (CSS transforms, no library): the same five
// runs as solid plates. It turns a little toward the pointer, and the Cursor
// run slides out while the runs above settle. Shown on wide screens when
// motion is allowed; otherwise the flat line figure (isoFigure) stands in.
function stackFigure() {
  const faces = html`<i class="s3-f s3-top"></i><i class="s3-f s3-n"></i><i class="s3-f s3-e"></i><i class="s3-f s3-s"></i><i class="s3-f s3-w"></i>`;
  return html`<figure class="s3" aria-hidden="true">
  <div class="s3-view"><div class="s3-rig">
    ${[0, 1, 2, 3, 4].map((i) => html`<div class="s3-plate s3-p${i}${i === 2 ? ' s3-out' : i < 2 ? ' s3-above' : ''}">${faces}</div>`)}
  </div></div>
  <figcaption class="iso-cap">The Cursor run comes out. The others stay where they were.</figcaption>
</figure>`;
}

const description = 'Grapim records every change your coding agents make, shell commands included. Sensitive changes wait for a named reviewer, and any single run can be undone. For Claude Code, Codex, Cursor and Gemini CLI.';

// demo: the public read-only demo at /demo is on (GRAPIM_DEMO=1).
export function landingPage({ origin, demo = false }) {
  return html`${siteHead({ title: 'Grapim: see and undo what your coding agents change', description, path: '/', origin })}
<body class="site">
<a class="skip" href="#main">Skip to content</a>
${siteBar({ current: 'home' })}
<main id="main">

<section class="hero" aria-labelledby="hero-title">
  <div class="hero-text">
    <h1 id="hero-title">See every agent change.<br> Undo any run.</h1>
    <p class="hero-sub">Grapim records what Claude Code, Codex, Cursor and Gemini CLI change on each developer’s machine, shell commands included, so a bad run can come back out without touching anyone else’s work.</p>
    <div class="cta">
      ${demo
        ? html`<a class="btn btn-primary btn-lg" href="/demo" rel="nofollow">Open the live demo</a>
      <a class="btn btn-lg" href="${SIGN_IN}" rel="nofollow">${GH}<span>Start with GitHub</span></a>`
        : html`<a class="btn btn-primary btn-lg" href="${SIGN_IN}" rel="nofollow">${GH}<span>Start with GitHub</span></a>
      <a class="btn btn-lg" href="/docs/support">Talk to us</a>`}
    </div>
    <p class="works" aria-label="Works with"><span class="works-label">Works with</span><span>Claude Code</span><span>Codex</span><span>Cursor</span><span>Gemini CLI</span><span>GitHub</span></p>
    ${isoFigure()}
    ${stackFigure()}
  </div>
  <figure class="frame frame-hero">
    ${shot('run', 'A run page in the Grapim hub: the run "Add idempotency keys to POST /orders" by claude 7f3e21aa, 2 turns, 3 files, +32 −4, marked Needs review, with Approve and Reject buttons, its prompts and its diff.', { eager: true })}
    <figcaption>A run waiting for review in the hub. Every screen and terminal on this page uses one demo repo, acme-co/shop-api.</figcaption>
  </figure>
</section>

<section class="film" aria-labelledby="film-title">
  <div class="wrap film-in">
    <h2 id="film-title" class="film-title">Grapim in a minute</h2>
    <video class="film-video" controls preload="none" playsinline poster="/hub/static/site/demo-poster.webp" width="1280" height="720">
      <source src="/hub/static/site/demo.mp4" type="video/mp4">
      <a href="/hub/static/site/demo.mp4">Watch the one-minute demo</a>
    </video>
  </div>
</section>

<section class="how" id="how" aria-labelledby="how-title">
  <div class="wrap">
    <h2 id="how-title" class="sr-only">How Grapim works</h2>
    <ol class="steps">
      <li class="step">
        <div class="step-text">
          <h3>Each change is filed under the run that made it</h3>
          <p>The prompt, the files and the lines, for every agent on the team. When Cursor ran <code>prisma migrate</code> and <code>rm seed.js</code>, both files went on its run too.</p>
          <p><a class="link" href="/docs">Set up in five minutes ${ICON.arrow}</a></p>
        </div>
        <div class="step-vis">${term('Terminal', RUNS)}</div>
      </li>
      <li class="step">
        <div class="step-text">
          <h3>Take back the run that deleted seed.js, and only that run</h3>
          <p><code>grapim undo</code> prints its plan first. With <code>--yes</code> it restores seed.js, removes the migration, and leaves the Claude and Codex runs in the same PR alone.</p>
          <p><a class="link" href="/docs/undo">How undo works ${ICON.arrow}</a></p>
        </div>
        <div class="step-vis">${term('Terminal', UNDO)}</div>
      </li>
    </ol>
  </div>
</section>

<section class="gate" id="review" aria-labelledby="gate-title">
  <div class="wrap gate-in">
    <div class="gate-text">
      <h2 id="gate-title">Payment changes wait for priya.</h2>
      <p>You write path rules once. Here the Claude run touched <code>payments/</code>, so the Grapim check stayed red until priya approved it. The Codex and docs runs passed on a rule, and the rule’s author is on record.</p>
      <p><a class="link" href="/docs/rules">Write your first rule ${ICON.arrow}</a></p>
    </div>
    <div class="gate-vis">${prThread()}</div>
  </div>
</section>

<section class="also" id="security" aria-labelledby="also-title">
  <div class="wrap">
    <h2 id="also-title" class="sr-only">Built for a security review</h2>
    <div class="also-grid">
      <div>
        ${FIG_HOME()}
        <h3>The hub can run without your code</h3>
        <p>With No code storage, the hub keeps run records and hashes, never file contents.</p>
        <p><a class="link" href="/docs/data-handling">What Grapim stores ${ICON.arrow}</a></p>
      </div>
      <div>
        ${FIG_REACH()}
        <h3>See which MCP servers your agents can call</h3>
        <p>Which agents, models and MCP servers your team's machines run, and what appeared this week.</p>
        <p><a class="link" href="/docs/inventory">The agent inventory ${ICON.arrow}</a></p>
      </div>
      <div>
        ${FIG_GITHUB()}
        <h3>Your repositories never leave GitHub</h3>
        <p>No repos move. The hub never writes to your code; undo runs on your machine.</p>
        <p><a class="link" href="/docs/security">Security model ${ICON.arrow}</a></p>
      </div>
    </div>
  </div>
</section>

<section class="close" aria-labelledby="close-title">
  <div class="wrap close-in">
    <h2 id="close-title">Try it on the repo your agents touch most.</h2>
    <p>Sign in with GitHub and run <code>grapim init</code> there. The next agent run is on the record. Free during early access.</p>
    <div class="cta">
      <a class="btn btn-primary btn-lg" href="${SIGN_IN}" rel="nofollow">${GH}<span>Start with GitHub</span></a>
      <a class="btn btn-lg" href="/pricing">See pricing</a>
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
