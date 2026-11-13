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
  return html`${current === 'home' ? html`<p class="announce"><a href="/changelog"><b>13 Nov</b><span>Cursor support<span class="announce-long">: undo now covers changes from commands it runs.</span></span><span class="announce-go">Changelog ${ICON.arrow}</span></a></p>` : ''}<header class="bar">
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
      <p>See what your AI agents changed, and undo their mistakes.</p>
      <p class="foot-social"><a href="https://www.linkedin.com/company/grapim" rel="noopener">LinkedIn</a><a href="https://github.com/grapim" rel="noopener">GitHub</a></p>
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

// Brand marks from Simple Icons 16.0.0 (CC0 1.0; each mark stays its owner's trademark, used here only to name a tool Grapim works with).
const BRAND_PATHS = {
  "github": "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  "claude": "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  "cursor": "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
  "googlegemini": "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
  "stripe": "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z",
  "postgresql": "M23.5594 14.7228a.5269.5269 0 0 0-.0563-.1191c-.139-.2632-.4768-.3418-1.0074-.2321-1.6533.3411-2.2935.1312-2.5256-.0191 1.342-2.0482 2.445-4.522 3.0411-6.8297.2714-1.0507.7982-3.5237.1222-4.7316a1.5641 1.5641 0 0 0-.1509-.235C21.6931.9086 19.8007.0248 17.5099.0005c-1.4947-.0158-2.7705.3461-3.1161.4794a9.449 9.449 0 0 0-.5159-.0816 8.044 8.044 0 0 0-1.3114-.1278c-1.1822-.0184-2.2038.2642-3.0498.8406-.8573-.3211-4.7888-1.645-7.2219.0788C.9359 2.1526.3086 3.8733.4302 6.3043c.0409.818.5069 3.334 1.2423 5.7436.4598 1.5065.9387 2.7019 1.4334 3.582.553.9942 1.1259 1.5933 1.7143 1.7895.4474.1491 1.1327.1441 1.8581-.7279.8012-.9635 1.5903-1.8258 1.9446-2.2069.4351.2355.9064.3625 1.39.3772a.0569.0569 0 0 0 .0004.0041 11.0312 11.0312 0 0 0-.2472.3054c-.3389.4302-.4094.5197-1.5002.7443-.3102.064-1.1344.2339-1.1464.8115-.0025.1224.0329.2309.0919.3268.2269.4231.9216.6097 1.015.6331 1.3345.3335 2.5044.092 3.3714-.6787-.017 2.231.0775 4.4174.3454 5.0874.2212.5529.7618 1.9045 2.4692 1.9043.2505 0 .5263-.0291.8296-.0941 1.7819-.3821 2.5557-1.1696 2.855-2.9059.1503-.8707.4016-2.8753.5388-4.1012.0169-.0703.0357-.1207.057-.1362.0007-.0005.0697-.0471.4272.0307a.3673.3673 0 0 0 .0443.0068l.2539.0223.0149.001c.8468.0384 1.9114-.1426 2.5312-.4308.6438-.2988 1.8057-1.0323 1.5951-1.6698zM2.371 11.8765c-.7435-2.4358-1.1779-4.8851-1.2123-5.5719-.1086-2.1714.4171-3.6829 1.5623-4.4927 1.8367-1.2986 4.8398-.5408 6.108-.13-.0032.0032-.0066.0061-.0098.0094-2.0238 2.044-1.9758 5.536-1.9708 5.7495-.0002.0823.0066.1989.0162.3593.0348.5873.0996 1.6804-.0735 2.9184-.1609 1.1504.1937 2.2764.9728 3.0892.0806.0841.1648.1631.2518.2374-.3468.3714-1.1004 1.1926-1.9025 2.1576-.5677.6825-.9597.5517-1.0886.5087-.3919-.1307-.813-.5871-1.2381-1.3223-.4796-.839-.9635-2.0317-1.4155-3.5126zm6.0072 5.0871c-.1711-.0428-.3271-.1132-.4322-.1772.0889-.0394.2374-.0902.4833-.1409 1.2833-.2641 1.4815-.4506 1.9143-1.0002.0992-.126.2116-.2687.3673-.4426a.3549.3549 0 0 0 .0737-.1298c.1708-.1513.2724-.1099.4369-.0417.156.0646.3078.26.3695.4752.0291.1016.0619.2945-.0452.4444-.9043 1.2658-2.2216 1.2494-3.1676 1.0128zm2.094-3.988-.0525.141c-.133.3566-.2567.6881-.3334 1.003-.6674-.0021-1.3168-.2872-1.8105-.8024-.6279-.6551-.9131-1.5664-.7825-2.5004.1828-1.3079.1153-2.4468.079-3.0586-.005-.0857-.0095-.1607-.0122-.2199.2957-.2621 1.6659-.9962 2.6429-.7724.4459.1022.7176.4057.8305.928.5846 2.7038.0774 3.8307-.3302 4.7363-.084.1866-.1633.3629-.2311.5454zm7.3637 4.5725c-.0169.1768-.0358.376-.0618.5959l-.146.4383a.3547.3547 0 0 0-.0182.1077c-.0059.4747-.054.6489-.115.8693-.0634.2292-.1353.4891-.1794 1.0575-.11 1.4143-.8782 2.2267-2.4172 2.5565-1.5155.3251-1.7843-.4968-2.0212-1.2217a6.5824 6.5824 0 0 0-.0769-.2266c-.2154-.5858-.1911-1.4119-.1574-2.5551.0165-.5612-.0249-1.9013-.3302-2.6462.0044-.2932.0106-.5909.019-.8918a.3529.3529 0 0 0-.0153-.1126 1.4927 1.4927 0 0 0-.0439-.208c-.1226-.4283-.4213-.7866-.7797-.9351-.1424-.059-.4038-.1672-.7178-.0869.067-.276.1831-.5875.309-.9249l.0529-.142c.0595-.16.134-.3257.213-.5012.4265-.9476 1.0106-2.2453.3766-5.1772-.2374-1.0981-1.0304-1.6343-2.2324-1.5098-.7207.0746-1.3799.3654-1.7088.5321a5.6716 5.6716 0 0 0-.1958.1041c.0918-1.1064.4386-3.1741 1.7357-4.4823a4.0306 4.0306 0 0 1 .3033-.276.3532.3532 0 0 0 .1447-.0644c.7524-.5706 1.6945-.8506 2.802-.8325.4091.0067.8017.0339 1.1742.081 1.939.3544 3.2439 1.4468 4.0359 2.3827.8143.9623 1.2552 1.9315 1.4312 2.4543-1.3232-.1346-2.2234.1268-2.6797.779-.9926 1.4189.543 4.1729 1.2811 5.4964.1353.2426.2522.4522.2889.5413.2403.5825.5515.9713.7787 1.2552.0696.087.1372.1714.1885.245-.4008.1155-1.1208.3825-1.0552 1.717-.0123.1563-.0423.4469-.0834.8148-.0461.2077-.0702.4603-.0994.7662zm.8905-1.6211c-.0405-.8316.2691-.9185.5967-1.0105a2.8566 2.8566 0 0 0 .135-.0406 1.202 1.202 0 0 0 .1342.103c.5703.3765 1.5823.4213 3.0068.1344-.2016.1769-.5189.3994-.9533.6011-.4098.1903-1.0957.333-1.7473.3636-.7197.0336-1.0859-.0807-1.1721-.151zm.5695-9.2712c-.0059.3508-.0542.6692-.1054 1.0017-.055.3576-.112.7274-.1264 1.1762-.0142.4368.0404.8909.0932 1.3301.1066.887.216 1.8003-.2075 2.7014a3.5272 3.5272 0 0 1-.1876-.3856c-.0527-.1276-.1669-.3326-.3251-.6162-.6156-1.1041-2.0574-3.6896-1.3193-4.7446.3795-.5427 1.3408-.5661 2.1781-.463zm.2284 7.0137a12.3762 12.3762 0 0 0-.0853-.1074l-.0355-.0444c.7262-1.1995.5842-2.3862.4578-3.4385-.0519-.4318-.1009-.8396-.0885-1.2226.0129-.4061.0666-.7543.1185-1.0911.0639-.415.1288-.8443.1109-1.3505.0134-.0531.0188-.1158.0118-.1902-.0457-.4855-.5999-1.938-1.7294-3.253-.6076-.7073-1.4896-1.4972-2.6889-2.0395.5251-.1066 1.2328-.2035 2.0244-.1859 2.0515.0456 3.6746.8135 4.8242 2.2824a.908.908 0 0 1 .0667.1002c.7231 1.3556-.2762 6.2751-2.9867 10.5405zm-8.8166-6.1162c-.025.1794-.3089.4225-.6211.4225a.5821.5821 0 0 1-.0809-.0056c-.1873-.026-.3765-.144-.5059-.3156-.0458-.0605-.1203-.178-.1055-.2844.0055-.0401.0261-.0985.0925-.1488.1182-.0894.3518-.1226.6096-.0867.3163.0441.6426.1938.6113.4186zm7.9305-.4114c.0111.0792-.049.201-.1531.3102-.0683.0717-.212.1961-.4079.2232a.5456.5456 0 0 1-.075.0052c-.2935 0-.5414-.2344-.5607-.3717-.024-.1765.2641-.3106.5611-.352.297-.0414.6111.0088.6356.1851z",
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
  <figcaption class="iso-cap">The bad change comes out. Everything else stays.</figcaption>
</figure>`;
}

// Real product fragments (design/illustration.md, B): pieces of the hub and
// of GitHub, rebuilt in HTML with the product's own words and the page's
// one demo repo. Decorative copies of real screens: the text beside each
// says the same thing.
function frag(caption, body) {
  return html`<figure class="frag" aria-hidden="true"><div class="frag-stage"><div class="frag-card">${body}</div></div><figcaption class="frag-cap">${caption}</figcaption></figure>`;
}

// Each fragment keeps one meaning a visitor gets at a glance (design/illustration.md, B).
// Settings, Code storage (src/hub/pages/team.js codeStorageSection).
const FIG_HOME = () => frag('One setting in Grapim.', html`
  <div class="fc-head"><b>No code storage</b><span class="fc-switch fc-on" aria-hidden="true"><i></i></span></div>
  <p class="fc-big">Your code stays on your machines.</p>
  <p class="fc-sub">Grapim keeps a record of what changed and who approved it. Never the code itself.</p>`);

// Agents page (src/hub/pages/inventory.js), in plain names.
const FIG_REACH = () => frag('The Agents page, for the whole team.', html`
  <div class="fc-head"><b>What your agents can reach</b><span class="fc-muted">Claude Code \u00b7 Codex \u00b7 Cursor</span></div>
  <ul class="fc-list">
    <li>${brand('github', '')}GitHub<span class="fc-muted">6 machines</span></li>
    <li>${brand('postgresql', '')}Database<span class="fc-muted">3 machines</span></li>
    <li>${brand('stripe', '')}Stripe <span class="fc-badge fc-new">New this week</span><span class="fc-muted">1 machine</span></li>
  </ul>`);

// The pull request on GitHub (src/hub/github/pull.js), reduced to its outcome.
const FIG_GITHUB = () => frag('On GitHub, Grapim only adds a check.', html`
  <div class="fc-gh-big"><span class="fc-gh-ok">${ICON.check}</span><div><b>Ready to merge</b><span class="fc-muted">Approved by priya in Grapim</span></div></div>
  <div class="fc-gh-merge">Grapim never changes your code.</div>`);

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
  <figcaption class="iso-cap">The bad change comes out. Everything else stays.</figcaption>
</figure>`;
}

const description = 'When an AI coding agent breaks something, Grapim shows exactly what it changed and puts it back in one step, without losing anyone else\u2019s work. For Claude Code, Codex, Cursor and Gemini CLI.';

// demo: the public read-only demo at /demo is on (GRAPIM_DEMO=1).
export function landingPage({ origin, demo = false }) {
  return html`${siteHead({ title: 'Grapim: see and undo what your coding agents change', description, path: '/', origin })}
<body class="site">
<a class="skip" href="#main">Skip to content</a>
${siteBar({ current: 'home' })}
<main id="main">

<section class="hero" aria-labelledby="hero-title">
  <div class="hero-text">
    <h1 id="hero-title">See what your AI agents changed.<br> Undo the mistakes.</h1>
    <p class="hero-sub">When an AI coding agent breaks something, see exactly what it did and put it back in one step, without losing anyone else’s work.</p>
    <div class="cta">
      ${demo
        ? html`<a class="btn btn-primary btn-lg" href="/demo" rel="nofollow">Open the live demo</a>
      <a class="btn btn-lg" href="${SIGN_IN}" rel="nofollow">${GH}<span>Start with GitHub</span></a>`
        : html`<a class="btn btn-primary btn-lg" href="${SIGN_IN}" rel="nofollow">${GH}<span>Start with GitHub</span></a>
      <a class="btn btn-lg" href="/docs/support">Talk to us</a>`}
    </div>
    <p class="works" aria-label="Works with"><span class="works-label">Works with</span><span>${brand('claude', '')}Claude Code</span><span>${brand('openai', '')}Codex</span><span>${brand('cursor', '')}Cursor</span><span>${brand('googlegemini', '')}Gemini CLI</span><span>${brand('github', '')}GitHub</span></p>
    ${isoFigure()}
    ${stackFigure()}
  </div>
  <figure class="frame frame-hero">
    ${shot('run', 'A run page in the Grapim hub: the run "Add idempotency keys to POST /orders" by claude 7f3e21aa, 2 turns, 3 files, +32 −4, marked Needs review, with Approve and Reject buttons, its prompts and its diff.', { eager: true })}
    <figcaption>What a reviewer sees in Grapim. Every screen on this page uses a demo project.</figcaption>
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
          <h3>Know which agent changed what</h3>
          <p>Every change Claude Code, Codex, Cursor or Gemini CLI makes is recorded with the request that caused it, including files changed by commands the agent ran.</p>
          <p><a class="link" href="/docs">Set up in five minutes ${ICON.arrow}</a></p>
        </div>
        <div class="step-vis">${term('Terminal', RUNS)}</div>
      </li>
      <li class="step">
        <div class="step-text">
          <h3>Undo one agent’s mistake. Keep everyone else’s work.</h3>
          <p>One command takes back everything a single agent did, and shows you what it will change before it does. Work by other agents and people stays as it is.</p>
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
      <h2 id="gate-title">Important code waits for a person.</h2>
      <p>Pick the parts of your code that need a human, like payments or sign-in. Changes there cannot be merged until the person you chose approves them. Low-risk changes, like tests and docs, go through on their own.</p>
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
        <h3>Your code can stay on your machines</h3>
        <p>Turn on one setting and Grapim keeps only a record of what changed, never the code itself.</p>
        <p><a class="link" href="/docs/data-handling">What Grapim stores ${ICON.arrow}</a></p>
      </div>
      <div>
        ${FIG_REACH()}
        <h3>See what your agents can reach</h3>
        <p>Which AI agents your team uses and which tools and services they can reach, with anything new flagged.</p>
        <p><a class="link" href="/docs/inventory">The agent inventory ${ICON.arrow}</a></p>
      </div>
      <div>
        ${FIG_GITHUB()}
        <h3>Nothing leaves GitHub</h3>
        <p>Your code stays where it is. Grapim never changes it, and undo runs on your own computer.</p>
        <p><a class="link" href="/docs/security">Security model ${ICON.arrow}</a></p>
      </div>
    </div>
  </div>
</section>

<section class="close" aria-labelledby="close-title">
  <div class="wrap close-in">
    <h2 id="close-title">Try it on your busiest project.</h2>
    <p>Sign in with GitHub and follow the five-minute setup. Free during early access.</p>
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
