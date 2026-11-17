// The public pages: the landing page at / for signed-out visitors, and the
// shell (head, top bar, footer) the docs share with it. Same rules as the
// hub: escaped templates, no inline script or style (the CSP forbids both),
// behaviour in /hub/static/site.js. Every claim here is something the code
// does today; screenshots are the real hub with the dev hub's demo data.

import { html, raw } from './html.js';
import { LOGO } from './icons.js';

export const SIGN_IN = '/hub/auth/github';

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

// Structured data for the home page, so search results name the site
// "Grapim" and show its logo.
function siteSchema(origin) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${origin}/#website`, name: 'Grapim', url: `${origin}/`, publisher: { '@id': `${origin}/#org` } },
      {
        '@type': 'Organization', '@id': `${origin}/#org`, name: 'Grapim', url: `${origin}/`,
        logo: { '@type': 'ImageObject', url: `${origin}/hub/static/site/logo.png`, width: 512, height: 512 },
        sameAs: ['https://www.linkedin.com/company/grapim', 'https://github.com/grapim'],
      },
    ],
  };
}

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
${path === '/' ? raw(`<script type="application/ld+json">${JSON.stringify(siteSchema(origin)).replace(/</g, '\\u003c')}</script>`) : ''}
<script src="/hub/static/theme.js"></script>
<link rel="icon" href="/hub/static/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/hub/static/fonts/public-sans-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/hub/static/fonts/ibm-plex-mono-400-latin.woff2" as="font" type="font/woff2" crossorigin>
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
  return html`<header class="bar">
  <div class="bar-in">
    <a class="bar-brand" href="/" aria-label="Grapim home">${LOGO}<span>Grapim</span></a>
    <nav class="bar-nav" aria-label="Site">${links}</nav>
    <details class="bar-menu">
      <summary aria-label="Menu">${ICON.menu}</summary>
      <nav class="bar-menu-list" aria-label="Site, small screens">${links}${signedIn ? '' : html`<a class="bar-link" href="${SIGN_IN}" rel="nofollow">Sign in</a>`}</nav>
    </details>
    ${signedIn
      ? html`<a class="btn btn-primary btn-sm" href="/hub">Open the hub</a>`
      : html`<a class="bar-signin" href="${SIGN_IN}" rel="nofollow">Sign in</a><a class="btn btn-primary btn-sm" href="${SIGN_IN}" rel="nofollow">Start free</a>`}
  </div>
</header>`;
}

export function siteFooter() {
  const theme = (t, label, ic) => html`<button type="button" data-theme-set="${t}" aria-pressed="false" aria-label="${label} theme" title="${label}">${ICON[ic]}</button>`;
  return html`<footer class="foot">
  <div class="foot-in">
    <div class="foot-brand">
      <a class="bar-brand" href="/" aria-label="Grapim home">${LOGO}<span>Grapim</span></a>
      <p>AI code review that runs in your own CI.</p>
      <p class="foot-social"><a href="https://www.linkedin.com/company/grapim" rel="noopener">LinkedIn</a><a href="https://github.com/grapim" rel="noopener">GitHub</a></p>
      <p class="foot-legal">© 2026 Grapim<a href="/terms">Terms</a><a href="/privacy">Privacy</a></p>
      <div class="theme-seg" role="group" aria-label="Theme">${theme('system', 'System', 'system')}${theme('light', 'Light', 'sun')}${theme('dark', 'Dark', 'moon')}</div>
    </div>
    <nav class="foot-cols" aria-label="Footer">
      <div><h2>Product</h2><a href="/#how">How it works</a><a href="/docs/concepts">Supported agents</a><a href="/docs/security">Security</a><a href="/pricing">Pricing</a><a href="/changelog">Changelog</a><a href="/notes/claude-code-prs">69 Claude Code PRs</a></div>
      <div><h2>Docs</h2><a href="/docs/review">Grapim Review</a><a href="/docs">Quickstart</a><a href="/docs/github">GitHub App and PR check</a><a href="/docs/cli">CLI reference</a><a href="/docs/security">Security and privacy</a></div>
      <div><h2>Help</h2><a href="/docs/support">Support</a><a href="/docs/faq">FAQ</a><a href="mailto:support@grapim.com">support@grapim.com</a></div>
    </nav>
  </div>
</footer>`;
}

// Brand marks from Simple Icons 16.0.0 (CC0 1.0; each mark stays its owner's trademark, used here only to name a tool Grapim works with).
const BRAND_PATHS = {
  "github": "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  "claude": "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  "cursor": "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
  "googlegemini": "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
};

// A brand mark in the text colour, sized by CSS (.brand-mark).
// OpenAI's blossom, from OpenAI's own logo download (openai.com/brand,
// OAI_OpenAI-Blossom_Black.svg), used under its Logo Usage Terms only to say
// Grapim works with Codex: black on light, white on dark, never recoloured,
// with the file's own clear space kept (its 716 viewBox).
const OPENAI_BLOSSOM = "M508.749 317.399C516.777 287.314 508.991 253.884 485.389 230.282C461.788 206.681 428.36 198.895 398.273 206.923C376.231 184.928 343.39 174.956 311.148 183.596C278.906 192.234 255.45 217.292 247.36 247.361C217.291 255.451 192.233 278.91 183.595 311.149C174.957 343.391 184.927 376.232 206.924 398.274C198.896 428.359 206.683 461.789 230.284 485.391C253.885 508.992 287.313 516.779 317.401 508.75C339.442 530.745 372.286 540.717 404.525 532.079C436.767 523.441 460.223 498.384 468.313 468.315C498.383 460.224 523.44 436.766 532.078 404.526C540.716 372.285 530.747 339.443 508.749 317.402V317.399ZM470.899 244.776C486.892 260.77 493.488 282.601 490.687 303.412L415.577 260.046C412.411 258.218 408.509 258.218 405.345 260.046L317.401 310.82V277.526C317.401 275.191 318.652 273.005 320.676 271.837L387.644 233.174C414.178 218.353 448.346 222.223 470.901 244.776H470.899ZM357.837 311.144L398.275 334.491V381.185L357.837 404.532L317.398 381.185V334.491L357.837 311.144ZM264.776 269.693C265.207 239.305 285.644 211.649 316.453 203.393C338.3 197.54 360.505 202.744 377.127 215.573L302.014 258.937C298.848 260.764 296.898 264.144 296.898 267.798V369.346L268.065 352.699C266.043 351.531 264.776 349.353 264.776 347.017V269.691V269.693ZM203.391 316.454C209.244 294.608 224.854 277.978 244.276 269.999V356.73C244.276 360.384 246.226 363.763 249.392 365.591L337.337 416.365L308.503 433.013C306.481 434.181 303.961 434.188 301.939 433.02L234.971 394.357C208.868 378.789 195.138 347.261 203.391 316.454ZM244.775 470.9C228.781 454.906 222.186 433.075 224.986 412.264L300.096 455.63C303.263 457.457 307.164 457.457 310.328 455.63L398.273 404.856V438.149C398.273 440.485 397.022 442.671 394.997 443.839L328.029 482.502C301.495 497.322 267.327 493.452 244.772 470.9H244.775ZM450.897 445.982C450.466 476.371 430.029 504.027 399.22 512.283C377.373 518.136 355.168 512.932 338.547 500.102L413.659 456.738C416.826 454.911 418.775 451.532 418.775 447.877V346.329L447.609 362.977C449.631 364.145 450.897 366.323 450.897 368.659V445.985V445.982ZM512.282 399.221C506.429 421.068 490.819 437.697 471.397 445.676V358.946C471.397 355.292 469.448 351.912 466.281 350.085L378.336 299.311L407.17 282.663C409.192 281.495 411.712 281.487 413.734 282.655L480.702 321.318C506.805 336.887 520.536 368.415 512.282 399.221Z";
const brand = (key, label) => key === 'openai'
  ? raw(`<svg class="brand-mark brand-openai" viewBox="0 0 716 716" width="28" height="28" aria-hidden="true" focusable="false"><path d="${OPENAI_BLOSSOM}"/></svg>`)
  : raw(`<svg class="brand-mark" viewBox="0 0 24 24" width="18" height="18" ${label ? `role="img" aria-label="${label}"` : 'aria-hidden="true" focusable="false"'}><path fill="currentColor" d="${BRAND_PATHS[key]}"/></svg>`);

// Real product fragments (design/illustration.md, B), rebuilt in HTML with the
// product's own words: Grapim Review's inline comment (formatFinding in
// action/review/index.mjs), its summary comment (renderReviewSummary in
// src/airev/findings.js), and the workflow and config from
// action/review/README.md. One scenario throughout, the one in
// scripts/review-demo-pr.sh: a Claude Code run asked only to "Add pagination
// to the users list endpoint". The Action posts with the workflow's own token,
// so on GitHub the author is github-actions, not a Grapim account.
const RUN_PROMPT = 'Add pagination to the users list endpoint';

const actionsBot = (verb) => html`<div class="gh-who"><span class="gh-av" aria-hidden="true">${brand('github', '')}</span><b>github-actions</b><span class="gh-bot">bot</span><span class="muted">${verb}</span></div>`;

// The hero: the inline comment on the migration line, in the PR's diff, and
// the PR's check row below it. The markup is the finished state; with motion
// the page plays it as one review (site.css, "The hero performs one review"):
// the diff lines, the check in progress, then the comment lands and the check
// fails. The in-progress wording is decoration, hidden from screen readers.
function reviewComment() {
  const row = (n, code, on = false) => html`<tr class="gh-row r${n}${on ? ' gh-on' : ''}"><td class="gh-ln">${n}</td><td class="gh-code"><span class="gh-sign" aria-hidden="true">+</span>${code}</td></tr>`;
  return html`<figure class="hero-vis" data-play="review">
  <div class="hero-stage"><div class="gh-card">
    <div class="gh-pr"><span class="gh-open">Open</span><b>${RUN_PROMPT}</b><span class="muted">acme-co/shop-api #418</span></div>
    <div class="gh-file">
      <div class="gh-file-head"><span class="mono">migrations/20261114_users_cleanup.sql</span><span class="gh-add">+3</span></div>
      <table class="gh-diff"><tbody>
        ${row(1, '-- Tidy up the users table.')}
        ${row(2, 'ALTER TABLE users DROP COLUMN email;', true)}
      </tbody></table>
      <div class="gh-reveal"><div class="gh-thread">
        <div class="gh-t t1">${actionsBot('commented')}</div>
        <div class="gh-body">
          <p class="gh-t t2"><b>Blocker · Drops users.email, which the request did not ask for</b></p>
          <p class="gh-t t3">The run was asked to add pagination. This line deletes every stored email address, and a rollback will not bring them back.</p>
          <p class="gh-t t4"><i>Written by Claude Code run: “${RUN_PROMPT}”</i></p>
        </div>
      </div></div>
      <table class="gh-diff"><tbody>
        ${row(3, "DELETE FROM users WHERE last_login_at < now() - interval '90 days';")}
      </tbody></table>
    </div>
    <div class="gh-checks">
      <span class="ck-ico"><span class="ck-spin" aria-hidden="true"></span><span class="ck-x">${ICON.x}</span></span>
      <span class="ck-text"><b>Grapim Review / review (pull_request)</b><span class="ck-state"><span class="ck-run" aria-hidden="true">In progress</span><span class="ck-fail">Failing after 52s</span></span></span>
    </div>
  </div></div>
  <figcaption><span>A demo pull request.</span><button type="button" class="replay" data-replay hidden>Replay</button></figcaption>
</figure>`;
}

// A file as the docs show it, cut to the lines that matter: keys tinted, the
// key lines marked, a quiet "…" where lines are left out, and a link to the
// whole file in the docs.
function codePanel(file, text, marked, full) {
  const lines = text.split('\n').map((l) => {
    if (l.trim() === '…') return html`<span class="cl cl-gap">${l}</span>`;
    const m = /^(\s*(?:- )?)("?[\w-]+"?:)(.*)$/.exec(l);
    return html`<span class="cl${marked.some((k) => l.includes(k)) ? ' cl-on' : ''}">${m ? html`${m[1]}<span class="ck">${m[2]}</span>${m[3]}` : l}</span>`;
  });
  return html`<div class="cpanel"><div class="cpanel-head"><span class="mono">${file}</span><a class="link" href="${full}">See the full file ${ICON.arrow}</a></div><pre><code>${lines}</code></pre></div>`;
}

// The lines that matter from the Bedrock workflow in docs/review.md
// (#amazon-bedrock), which has the whole file.
const BEDROCK = `…
    role-to-assume: arn:aws:iam::123456789012:role/grapim-review
    aws-region: us-east-1
- uses: grapim/grapim/action/review@main
  with:
    provider: bedrock`;

// The summary comment's last two lines (renderReviewSummary), cropped from the top.
function summaryEnd() {
  return html`<div class="gh-card gh-crop">
    <div class="gh-body">
      <p>Model: claude-opus-5-5 on Amazon Bedrock (us-east-1). 2 requests, 18,412 input and 2,906 output tokens.</p>
      <p class="gh-last">Your code was sent only to Amazon Bedrock (us-east-1). Grapim received nothing.</p>
    </div>
  </div>`;
}

const PLANS = [
  {
    name: 'Free',
    price: '$0',
    per: '',
    bill: 'Free forever',
    lede: 'For one team trying it on a repo.',
    items: ['Cloud review of about 50 pull requests a month', 'Public repositories reviewed free, no account needed', 'Grapim Review in your own CI, free', 'Up to 3 people', '2 repos, 7 days of history', 'Every run recorded, and undo'],
  },
  {
    name: 'Team',
    price: '$20',
    per: 'per seat a month',
    year: { price: '$16', bill: 'Billed yearly, $192 per seat' },
    lede: 'For a team whose agents ship code every day.',
    items: ['Everything in Free', 'Cloud review of about 55 pull requests a month per seat', 'As many seats as you need', 'Unlimited repos', '90 days of history'],
  },
  {
    name: 'Governance',
    price: '$40',
    per: 'per seat a month',
    year: { price: '$32', bill: 'Billed yearly, $384 per seat' },
    lede: 'When a person must approve what agents change.',
    items: ['Everything in Team', 'Cloud review of about 110 pull requests a month per seat', 'Path rules: auto-approve or named reviewer', 'Required PR check that blocks merging', 'Reports and CSV export'],
    mark: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    per: '',
    bill: 'Billed as agreed',
    lede: 'Seats, terms and support for a larger rollout.',
    items: ['Everything in Governance', 'Review volume, seats and terms agreed with you', 'Help with the rollout'],
  },
];

// The first answer is open: it is the question a security reviewer asks first.
const FAQ = [
  ['Does our code have to leave our machines?', 'Not if you choose so. Run Grapim Review in your own CI and it sends changes only to your Anthropic API key, Amazon Bedrock, Google Vertex AI or Microsoft Foundry, and Grapim’s servers receive nothing. The cloud review on the GitHub App fetches each pull request into a temporary folder on Grapim’s server, sends it to Anthropic for the review, and deletes it when the review ends.'],
  ['What does a cloud review use up?', 'Each plan includes a monthly review credit: $10 on Free, $10 a seat on Team and $20 a seat on Governance. A typical pull request uses about $0.18 of it, so Free covers about 50 a month and each Team seat about 55. When it runs out, the check says so and reviews wait for the next month or a bigger plan.'],
  ['Is it free for open source?', 'Yes. Install the GitHub App on a public repository and every pull request is reviewed free, about 50 a month per repository, with no account to create. Pull requests opened by bots are skipped, and a repository with fewer than 10 stars is reviewed when someone comments @grapim review.'],
  ['Is anything charged today?', 'No. Grapim is in early access and has no checkout. These are the prices we intend to charge once billing opens, and we will tell every team before that happens.'],
  ['Can we try Governance now?', 'Yes. Design partners get Governance as a pilot at no charge, set by us for your team. Talk to us and say which repos you want to start with.'],
  ['What counts as a seat?', 'A member of your team in the Grapim hub. Agents are not seats, and neither are the machines that sync runs.'],
  ['Which agents are covered?', 'Claude Code, Codex CLI, Cursor and Gemini CLI, including files their shell commands change. Any other MCP client can report the files it claims.'],
];

// A small fragment on its stage panel (design/illustration.md, B). The text
// beside each one says the same thing, so screen readers skip the copy.
function frag(body) {
  return html`<figure class="frag" aria-hidden="true"><div class="frag-stage"><div class="frag-card">${body}</div></div></figure>`;
}

// The PR's checks box on GitHub: the review is a job in your own Actions
// (workflow "Grapim Review", job "review"); fail-on: blocker fails it.
const FIG_CHECK = () => frag(html`
  <div class="fc-head"><b>Some checks were not successful</b></div>
  <div class="fc-check"><span class="fc-x">${ICON.x}</span><span><b>Grapim Review / review (pull_request)</b><span class="fc-muted">Failing after 52s</span></span></div>`);

// The summary comment's run list (renderReviewSummary): the run and its prompt.
const FIG_RUNS = () => frag(html`
  <div class="gh-body">
    <p><b>Agent runs reviewed</b></p>
    <ul><li>Claude Code, 2 hunks, depth high: "${RUN_PROMPT}"</li></ul>
  </div>`);

// Where the review spends its effort, in the product's own words: the
// default sensitive paths (docs/review.md, "The config file") and the depth
// each kind of line gets (depthOf in src/airev/diff.js; "depth high" and
// "not reviewed" as the summary comment says them).
const SENSITIVE = ['migrations/', 'auth/', 'infra/', '*.sql', '.github/workflows/'];
const FIG_DEPTH = () => frag(html`
  <div class="fc-head"><b>Sensitive paths</b><span class="fc-muted">Defaults</span></div>
  <p class="fd-paths">${SENSITIVE.map((p) => html`<code>${p}</code>`)}</p>
  <dl class="fd-depth">
    <div><dt>Agent-written, on these paths</dt><dd class="fd-hi">depth high</dd></div>
    <div><dt>Human-written, elsewhere</dt><dd>not reviewed</dd></div>
  </dl>`);

// The one-minute video tells the old record-and-undo story, so it is off
// until there is a Grapim Review cut. Flip this to bring it back.
const SHOW_FILM = false;
function filmSection() {
  return html`<section class="film" aria-labelledby="film-title">
  <div class="wrap film-in">
    <h2 id="film-title" class="film-title">Grapim in a minute</h2>
    <video class="film-video" controls preload="none" playsinline poster="/hub/static/site/demo-poster.webp" width="1280" height="720">
      <source src="/hub/static/site/demo.mp4" type="video/mp4">
      <a href="/hub/static/site/demo.mp4">Watch the one-minute demo</a>
    </video>
  </div>
</section>`;
}

const REVIEW_DOCS = '/docs/review';

// The facts row under the product shot. Each one is checked against the code:
// cloud review on the App (src/hub/github/cloud-review.js: Opus 5.5, about a
// minute and $0.18 a pull request on the bench, a monthly credit per plan),
// the agents in src/hub/github/agents.js, and the Action that calls only
// api.github.com and the provider's endpoint (action/review/index.mjs).
const FACTS = [
  ['About a minute.', 'From push to review.'],
  ['Knows the agent.', 'And what each run was asked.'],
  ['Free each month.', 'Review credit on every plan.'],
  ['Or in your own CI.', 'Nothing reaches Grapim.'],
];

// The path a review takes, drawn as one hairline that stops at your model
// account. Grapim sits past the gap, ghosted: it is not on the path.
function pathLine() {
  const stop = (name, note, cls = '') => html`<li class="path-stop${cls}"><span class="path-dot" aria-hidden="true"></span><b>${name}</b>${note ? html`<span>${note}</span>` : ''}</li>`;
  return html`<ol class="path" aria-label="Where your code goes" data-reveal>
      ${stop('Your GitHub')}
      ${stop('Your CI runner')}
      ${stop('Your model account', '', ' path-end')}
      ${stop('Grapim', 'receives nothing', ' path-off')}
    </ol>`;
}
const description = 'Grapim reviews every pull request in about a minute and comments on the lines that need attention. It knows which agent wrote each line and what it was asked to do, and flags the changes nobody asked for. Install the GitHub App, or run it in your own CI on your own model account.';

export function landingPage({ origin }) {
  return html`${siteHead({ title: 'Grapim: code review that knows what your agents were asked', description, path: '/', origin })}
<body class="site">
<a class="skip" href="#main">Skip to content</a>
${siteBar({ current: 'home' })}
<main id="main">

<section class="hero" aria-labelledby="hero-title">
  <div class="hero-text">
    <a class="eyebrow" href="${REVIEW_DOCS}"><b>Grapim Review</b><span>Early access</span>${ICON.arrow}</a>
    <h1 id="hero-title">Code review that knows what <span class="hl">your agents</span> were asked.</h1>
    <p class="hero-sub">Install the GitHub App and every pull request is reviewed in about a minute. Grapim checks agent code against the request and flags what nobody asked for.</p>
    <div class="cta">
      <a class="btn btn-primary btn-lg" href="${SIGN_IN}">Start free</a>
      <a class="btn btn-lg" href="${REVIEW_DOCS}#run-it-in-your-own-ci">Run it in your own CI</a>
    </div>
    <p class="works" aria-label="Works with"><span class="works-label">Works with</span><span>${brand('claude', '')}Claude Code</span><span>${brand('openai', '')}Codex</span><span>${brand('cursor', '')}Cursor</span><span>${brand('googlegemini', '')}Gemini CLI</span><span>${brand('github', '')}GitHub</span></p>
  </div>
  <div class="wrap">${reviewComment()}</div>
  <div class="wrap"><ul class="facts" data-reveal>${FACTS.map(([lead, rest]) => html`<li><b>${lead}</b> ${rest}</li>`)}</ul></div>
</section>

<section class="where" id="where" aria-labelledby="where-title">
  <div class="wrap">
    <div class="sec-head" data-reveal>
      <h2 id="where-title" class="sec-title">Or keep your code in your own CI.</h2>
      <p class="sec-lede">The same review on your runner and your model account. Grapim receives nothing.</p>
    </div>
    ${pathLine()}
    <div class="where-grid">
      <figure class="where-fig" data-reveal>${codePanel('.github/workflows/grapim-review.yml', BEDROCK, ['role-to-assume', 'aws-region', 'provider:'], `${REVIEW_DOCS}#amazon-bedrock`)}<figcaption>Amazon Bedrock, with no long-lived keys.</figcaption></figure>
      <figure class="where-fig" data-play data-reveal>${summaryEnd()}<figcaption>How every summary comment ends.</figcaption></figure>
    </div>
    <p class="where-links"><a class="link" href="/docs/security">Security and privacy ${ICON.arrow}</a></p>
  </div>
</section>

<section class="how" id="how" aria-labelledby="how-title">
  <div class="wrap">
    <div class="sec-head" data-reveal><h2 id="how-title" class="sec-title">How it works</h2></div>
    <div class="points" data-reveal>
      <div>
        ${FIG_CHECK()}
        <h3>One switch on GitHub</h3>
        <p>Install the App and turn review on. No workflow to write, nothing to host.</p>
      </div>
      <div>
        ${FIG_RUNS()}
        <h3>Reviews agent code against the request</h3>
        <p>Asked to add pagination, Claude Code should not drop a column. Grapim flags work beyond the prompt.</p>
      </div>
      <div>
        ${FIG_DEPTH()}
        <h3>Spends effort where the risk is</h3>
        <p>The deepest review goes where agents touch sensitive code.</p>
      </div>
    </div>
    <p class="also-line"><span class="also-label">Also in Grapim</span><a href="/docs/concepts">Run records</a><a href="/docs/undo">Undo one run</a><a href="/docs/rules">Merge checks</a></p>
  </div>
</section>

${SHOW_FILM ? filmSection() : ''}

<section class="close" aria-labelledby="close-title">
  <div class="wrap close-in" data-reveal>
    <h2 id="close-title">Try it on one repo.</h2>
    <p>Install the App, or add one workflow file. Free in early access.</p>
    <div class="cta">
      <a class="btn btn-primary btn-lg" href="${SIGN_IN}">Start free</a>
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
  return html`${siteHead({ title: 'Pricing', description: 'Grapim plans: Free, Team at $20 and Governance at $40 per seat a month ($16 and $32 billed yearly), and Enterprise. Nothing is charged during early access.', path: '/pricing', origin })}
<body class="site">
<a class="skip" href="#main">Skip to content</a>
${siteBar({ current: 'pricing', signedIn })}
<main id="main">

<section class="pricing pricing-page" id="pricing" aria-labelledby="pricing-title">
  <div class="wrap">
    <h1 id="pricing-title" class="sec-title">Pricing</h1>
    <p class="sec-lede">Free while in early access: nothing is charged yet. These are the prices once billing opens.</p>
    <fieldset class="cycle">
      <legend class="sr-only">Billing</legend>
      <input type="radio" name="cycle" id="cycle-month" value="month"><label for="cycle-month">Monthly</label>
      <input type="radio" name="cycle" id="cycle-year" value="year" checked><label for="cycle-year">Yearly <span class="cycle-save">Save 20%</span></label>
    </fieldset>
    <div class="plans">
      ${PLANS.map((p) => html`<section class="plan${p.mark ? ' plan-mark' : ''}" aria-labelledby="plan-${p.name.toLowerCase()}">
        <h2 id="plan-${p.name.toLowerCase()}">${p.name}</h2>
        ${p.year
          ? html`<p class="plan-price"><span class="num by-year">${p.year.price}</span><span class="num by-month">${p.price}</span><span class="plan-per">${p.per}</span></p>
        <p class="plan-bill"><span class="by-year">${p.year.bill}</span><span class="by-month">Billed monthly</span></p>`
          : html`<p class="plan-price"><span class="num">${p.price}</span>${p.per ? html`<span class="plan-per">${p.per}</span>` : ''}</p>
        <p class="plan-bill">${p.bill}</p>`}
        <p class="plan-lede">${p.lede}</p>
        ${p.name === 'Free' ? html`<a class="btn plan-cta" href="${SIGN_IN}" rel="nofollow">Start with GitHub</a>` : p.name === 'Enterprise' || p.mark ? html`<a class="btn${p.mark ? ' btn-primary' : ''} plan-cta" href="/docs/support">${p.mark ? 'Ask for a pilot' : 'Talk to us'}</a>` : html`<a class="btn plan-cta" href="${SIGN_IN}" rel="nofollow">Start with GitHub</a>`}
        <ul>${p.items.map((i) => html`<li>${ICON.check}<span>${i}</span></li>`)}</ul>
      </section>`)}
    </div>
    <p class="fine">Cloud review is included in each plan’s monthly review credit; the pull request counts assume about $0.18 a review. Grapim Review in your own CI runs on your own model account, billed by your provider.</p>
  </div>
</section>

<section class="faq" aria-labelledby="faq-title">
  <div class="wrap faq-in">
    <h2 id="faq-title" class="sec-title">Questions</h2>
    <div class="faq-list">
      ${FAQ.map(([q, a], i) => html`<details${i === 0 ? html` open` : ''}><summary>${q}</summary><p>${a}</p></details>`)}
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
    date: '2026-11-16',
    items: [
      { title: 'A second look before posting', body: 'Every finding is checked again against the code around it, where it is used, the commit messages and what the author said on the pull request. Findings that context contradicts are dropped instead of posted.', link: ['/docs/review#a-second-look-before-posting', 'How the second look works'] },
      { title: 'No repeated comments on a new push', body: 'Cloud review no longer posts a finding again when it already commented on it earlier in the same pull request. The summary says how many are still there, and a blocker that is still there still fails the check.', link: ['/docs/review#on-every-new-push', 'What happens on a new push'] },
      { title: 'Ask Grapim in the pull request', body: 'Write @grapim in a comment to ask about a finding or the change, and the answer appears in the thread. @grapim review runs a fresh review.', link: ['/docs/review#ask-grapim-in-the-pull-request', 'How to ask'] },
      { title: 'Learns from your team', body: 'Thumbs up and down on Grapim’s comments, and your team’s replies to them, now guide the next reviews in the repository. Nothing extra is stored.', link: ['/docs/review#it-learns-from-your-team', 'How it learns'] },
    ],
    more: [],
  },
  {
    date: '2026-11-15',
    items: [
      { title: 'Free for open source', body: 'Install the GitHub App on a public repository and every pull request gets a cloud review, free, with no account to create. Teams with cloud review on no longer spend credit on their public repositories. Pull requests opened by bots are skipped.', link: ['/docs/review#free-for-open-source', 'How free reviews work'] },
      { title: 'Cloud review on the GitHub App', body: 'Turn on Cloud review in Settings, GitHub and Grapim reviews every pull request on its own model account, with nothing to set up in CI. A review takes about a minute and posts comments and a Grapim Review (cloud) check. Each plan includes a monthly review credit.', link: ['/docs/review#cloud-review', 'How cloud review works'] },
      { title: 'Sharper reviews', body: 'Each finding now carries a confidence. Sure ones are posted on the line, doubtful ones are listed once in the summary under Worth a look. A repository without Grapim notes gets every changed line reviewed.', link: ['/docs/review#limits-and-costs', 'What gets reviewed'] },
       ],
    more: [],
  },
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
