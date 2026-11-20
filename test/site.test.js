// The public site: the landing page at / (signed out; a session goes to
// /hub), the docs, robots.txt and sitemap.xml. Checks that every page is
// served, CSP-clean (no inline script or style), has its SEO tags, that
// every internal link and image on it resolves, and that the docs renderer
// and the CLI reference generator behave.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../src/hub/server.js';
import { cliHelp, docPath, LEGAL, loadDocs, NOTES, ORDER, parseHelp, renderMarkdown } from '../src/hub/pages/docs.js';
import { REVIEW_PROVIDERS } from '../src/hub/pages/review-setup.js';
import { FOOT_COLS, NAV_LINKS, NAV_MENUS, REPO } from '../src/hub/pages/site.js';

const ORIGIN = 'http://localhost:7998';
let h;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-site-'));
  const hub = await createHub({
    env: { HUB_URL: ORIGIN, HUB_SECRET: 'test-secret-that-is-long-enough-0123456789', HUB_DATA: dir, GITHUB_CLIENT_ID: 'gh-client', GITHUB_CLIENT_SECRET: 'gh-secret' },
    fetch: async (url) => {
      throw new Error(`no network in tests (${url})`);
    },
    billing: null,
    log: () => {},
  });
  const addr = await hub.listen(0, '127.0.0.1');
  h = { hub, base: `http://127.0.0.1:${addr.port}` };
});
after(() => h?.hub.close());

const get = (p, headers = {}) => fetch(h.base + p, { redirect: 'manual', headers });

function signedInCookie() {
  const now = Date.now();
  h.hub.db.prepare('INSERT OR IGNORE INTO users (id, login, name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)').run(4242, 'sitetester', 'Site Tester', now, now);
  return h.hub.auth.createSession(4242).cookie.split(';')[0];
}

const PAGES = ['/', '/pricing', '/changelog', ...ORDER.map(docPath), ...LEGAL.map((s) => `/${s}`), ...NOTES.map((s) => `/notes/${s}`)];

function assertCspClean(body, where) {
  // A JSON-LD data block is never run, so CSP does not apply to it.
  assert.ok(!/<script(?![^>]*\ssrc=)(?![^>]*type="application\/ld\+json")[^>]*>/i.test(body), `${where}: an inline <script>`);
  assert.ok(!/\sstyle\s*=/i.test(body), `${where}: a style attribute`);
  assert.ok(!/<style[\s>]/i.test(body), `${where}: a <style> element`);
  assert.ok(!/\son[a-z]+\s*=/i.test(body), `${where}: an inline event handler`);
  for (const m of body.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
    assert.ok(m[1].startsWith('/') || m[1].startsWith(ORIGIN), `${where}: an external resource ${m[1]}`);
  }
}

test('/ is the landing page when signed out, and /hub when signed in', async () => {
  const out = await get('/');
  assert.equal(out.status, 200);
  assert.match(out.headers.get('content-type'), /text\/html/);
  assert.match(out.headers.get('content-security-policy'), /script-src 'self'/);
  const body = await out.text();
  assert.match(body, /Code review that knows what <span class="hl">your agents<\/span> were asked\./);
  assert.match(body, /class="btn btn-primary btn-lg" href="\/hub\/auth\/github">Start free</, 'the primary action starts cloud review');
  assert.match(body, /href="\/docs\/review#run-it-in-your-own-ci">Run it in your own CI</, 'the self-hosted path is one click away');
  assert.match(body, /Your code was sent only to Amazon Bedrock \(us-east-1\)\. Grapim received nothing\./, 'the summary line, as the Action writes it');
  assert.match(body, /href="\/hub\/auth\/github"/, 'sign in stays in the bar');
  assert.match(body, /href="\/docs"/);
  assert.match(body, /href="\/pricing"/);
  for (const id of ['where', 'how']) assert.match(body, new RegExp(`id="${id}"`), `section #${id}`);
  // The hero plays one review, but its markup is the finished state (no JS, print, reduced motion).
  assert.match(body, /<figure class="hero-vis" data-play="review">/);
  assert.match(body, /<span class="ck-run" aria-hidden="true">In progress<\/span><span class="ck-fail">Failing after 52s<\/span>/, 'the check ends failing; its in-progress wording is hidden from screen readers');
  assert.match(body, /<button type="button" class="replay" data-replay hidden>Replay<\/button>/, 'Replay only appears once the review has played');
  // Code lives in the docs: the landing shows only the workflow lines that
  // matter, links to the whole file, and has no config file.
  assert.match(body, /<a class="link" href="\/docs\/review#amazon-bedrock">See the full file/);
  assert.match(body, /<span class="cl cl-gap">…<\/span>/, 'left-out lines are marked');
  assert.equal((body.match(/<span class="cl[ "]/g) ?? []).length, 6, 'six lines of the workflow');
  assert.ok(!/review\.json|actions\/checkout/.test(body), 'no config file and no full workflow on the landing');
  assert.match(body, /<dd class="fd-hi">depth high<\/dd>/, 'the depth fragment uses the summary’s words');
  // The top bar's menus are the same on every page, so they are not counted.
  // The comparison table and the FAQ answers are reference text a visitor
  // opens on purpose; the rest of the page keeps to a short read.
  const count = (b) => b.replace(/<header class="bar">[^]*?<\/header>/, '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  const story = count(body.replace(/<section class="versus"[^]*?<\/section>/, '').replace(/<section class="faq home-faq"[^]*?<\/section>/, ''));
  assert.ok(story < 850, `the landing page stays short (${story} words outside the comparison and the FAQ)`);
  assert.ok(count(body) < 1500, `the whole landing page stays under 1,500 words (${count(body)})`);

  // Pricing has its own page. Honest pricing: no checkout while billing is not live.
  const pricing = await (await get('/pricing')).text();
  assert.match(pricing, /nothing is charged yet/);
  assert.match(pricing, /<details open><summary>Does our code have to leave our machines\?/, 'the data question is answered open');
  assert.match(pricing, /Cloud review is included in each plan’s monthly review credit/);
  // Monthly or yearly: a toggle above the plans, yearly by default, no script; no yearly prices in a footnote.
  assert.match(pricing, /<input type="radio" name="cycle" id="cycle-year" value="year" checked>/);
  assert.match(pricing, /<span class="num by-year">\$16<\/span><span class="num by-month">\$20<\/span>/);
  assert.match(pricing, /<span class="by-year">Billed yearly, \$384 per author<\/span>/);
  // Seats are the people who open pull requests; the counts come from REVIEW_COST_ESTIMATE.
  assert.match(pricing, /About 100 per author/);
  assert.match(pricing, /About 200 per author/);
  assert.match(pricing, /A person who opens pull requests that Grapim reviews in a month\. Agents and bots are not seats/);
  assert.match(pricing, /extra pull requests are \$0\.25 each, up to a monthly limit an owner sets/);
  assert.match(pricing, /Save 20%/);
  assert.ok(!/Yearly: Team/.test(pricing), 'yearly prices are not a footnote');
  for (const p of ['free', 'team', 'governance', 'enterprise']) assert.match(pricing, new RegExp(`<h2 id="plan-${p}">`));
  for (const b of [body, pricing]) assert.ok(!/start (your )?(free )?trial|buy now|checkout\.stripe/i.test(b));

  const signedIn = await get('/', { Cookie: signedInCookie() });
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.get('location'), '/hub');
});

test('the landing page: real findings, proof in numbers, the comparison, questions and the closing band', async () => {
  const body = await (await get('/')).text();
  // In order: how it works, what it found, the numbers, your own CI, the comparison, questions, the closing band.
  const at = ['id="how"', 'id="caught"', 'id="proof"', 'id="where"', 'id="compare"', 'id="faq"', 'id="close-title"'].map((m) => body.indexOf(m));
  assert.ok(at.every((i) => i > 0), 'every section is on the page');
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'the sections come in order');

  // Real findings: only the ones the 69-PR write-up presents, and no project names (the write-up names none).
  const note = fs.readFileSync(new URL('../src/hub/docs/notes/claude-code-prs.md', import.meta.url), 'utf8');
  const caught = body.slice(body.indexOf('id="caught"'), body.indexOf('id="proof"'));
  assert.equal((caught.match(/<li class="bug">/g) ?? []).length, 3, 'three findings');
  for (const fact of ['X-Forwarded-For', 'ABC HOME CARE, LLC', 'first name is LLC', 'restarts while the panel is open']) {
    assert.ok(caught.includes(fact), `the card says: ${fact}`);
    assert.ok(note.includes(fact), `the write-up says it too: ${fact}`);
  }
  assert.ok(!/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|#\d{2,}\b/.test(caught), 'no repository or pull request is named');
  assert.match(caught, /would have commented/, 'nothing was posted, and the cards say so');
  assert.match(caught, /href="\/notes\/claude-code-prs"/);

  // Proof: the hand-checked set, its method, and no rank claim anywhere on the page.
  const proof = body.slice(body.indexOf('id="proof"'), body.indexOf('id="where"'));
  for (const fact of ['83%', '47%', '35 → 2', '20 of 24', '95']) assert.ok(proof.includes(fact), `proof: ${fact}`);
  assert.match(proof, /href="https:\/\/github\.com\/grapim\/grapim\/blob\/main\/bench\/README\.md#precision-work-of-2026-11-19[^"]*"/);
  assert.match(proof, /href="https:\/\/github\.com\/grapim\/grapim\/blob\/main\/bench\/real-score\.mjs"/);
  const readme = fs.readFileSync(new URL('../bench/README.md', import.meta.url), 'utf8');
  assert.match(readme, /## Precision work of 2026-11-19: the hand-checked real-repo set and the second look/, 'the heading the method link points at');
  assert.match(readme, /\*\*V2 second look \(shipped\)\*\* \| \*\*20\*\* \| \*\*2\*\* \| \*\*2\*\* \| \*\*83%\*\*/, 'the numbers are the README’s');
  const text = body.replace(/<[^>]+>/g, ' ');
  assert.ok(!/\b(rank(ed|s)?|#1|number one|first place|leaderboard|top[- ]ranked|best[- ]in[- ]class|Martian)\b/i.test(text), 'no leaderboard or rank claim');
  // No social proof we do not have.
  assert.ok(!/testimonial|trusted by|customers love|SOC ?2 (certified|compliant)|ISO 27001 certified|\d[\d,]* (teams|developers|users) (use|trust)/i.test(text), 'no logos, testimonials, user counts or certifications');

  // The comparison: three products, every row a label and three cells, a blank only where the vendor does not say.
  const versus = body.slice(body.indexOf('id="compare"'), body.indexOf('id="faq"'));
  assert.match(versus, /<th scope="col" class="vs-us">Grapim<\/th><th scope="col">GitHub Copilot code review<\/th><th scope="col">CodeRabbit<\/th>/);
  const rows = [...versus.matchAll(/<tr><th scope="row">[^]*?<\/tr>/g)].map((m) => m[0]);
  assert.ok(rows.length >= 6, 'at least six rows');
  for (const r of rows) assert.equal((r.match(/<td[\s>]/g) ?? []).length, 3, r);
  for (const row of ['Open source', 'Runs in your own CI', 'Your own model account', 'Where your code goes', 'Checks the change against what was asked', 'Free on public repositories', 'Price']) {
    assert.ok(rows.some((r) => r.includes(`<th scope="row">${row}</th>`)), `row: ${row}`);
  }
  assert.match(versus, /<td><span class="sr-only">Not stated on its public pages<\/span><\/td>/, 'a blank cell says why to screen readers');
  for (const src of ['https://docs.github.com/en/copilot/concepts/agents/code-review', 'https://www.coderabbit.ai/pricing', 'https://docs.coderabbit.ai/self-hosted/overview']) assert.ok(versus.includes(`href="${src}"`), `source: ${src}`);
  assert.match(versus, /\$16 per pull request author a month, billed yearly/, 'Grapim’s price is the pricing page’s');

  // Questions: native details and summary, all closed, answers that match the docs.
  const faq = body.slice(body.indexOf('id="faq"'), body.indexOf('id="close-title"'));
  const items = [...faq.matchAll(/<details><summary>([^<]+)<\/summary><p>([^<]+)<\/p><\/details>/g)];
  assert.ok(items.length >= 6 && items.length <= 8, `6 to 8 questions (${items.length})`);
  assert.ok(!/<details open/.test(faq), 'every answer starts closed');
  const answer = (q) => items.find((m) => m[1].includes(q))?.[2] ?? '';
  assert.match(answer('Which model'), /Claude Opus 5\.5/);
  assert.match(answer('stored'), /deletes the folder when the review ends/);
  assert.match(answer('Copilot'), /open source/);
  assert.match(answer('Claude Code, Codex and Cursor'), /Gemini CLI/);
  assert.match(answer('self-host'), /GitHub Action on your runner/);
  assert.match(answer('pricing'), /Team \$16 and Governance \$32 per author a month billed yearly \(\$20 and \$40 monthly\)/);
  assert.match(answer('private'), /about 80 pull requests a month on Free/);

  // The closing band: install the App, or self-host.
  const close = body.slice(body.indexOf('id="close-title"'));
  assert.match(close, /<a class="btn btn-primary btn-lg" href="https:\/\/github\.com\/apps\/grapim">Install the GitHub App<\/a>/);
  assert.match(close, /<a class="btn btn-lg" href="\/docs\/review#run-it-in-your-own-ci">Self-host in your CI<\/a>/);
});

test('#where reads at full contrast before, during and after its motion', async () => {
  const body = await (await get('/')).text();
  const where = body.slice(body.indexOf('id="where"'), body.indexOf('id="compare"'));
  assert.match(where, /<b>Grapim<\/b><span>receives nothing<\/span>/);
  assert.ok(!/data-play/.test(where), 'nothing in the band waits for a scene to play');
  const css = fs.readFileSync(new URL('../src/hub/pages/site.css', import.meta.url), 'utf8');
  const hidden = css.match(/\.motion \[data-reveal\]:not\(\.in\) \{([^}]*)\}/)[1];
  assert.ok(!/opacity/.test(hidden), 'sections rise without fading from transparent');
  assert.ok(!/@keyframes sweep|\.gh-last \{[^}]*background-size/.test(css), 'the stamp is not swept in over unreadable text');
  assert.match(css, /\.path-stop\.path-off span:not\(\.path-dot\) \{ color: var\(--text\);/, '"receives nothing" in the band’s text colour');
  // The motion only starts from html.motion, which site.js sets only without reduced motion.
  const client = fs.readFileSync(new URL('../src/hub/pages/site-client.js', import.meta.url), 'utf8');
  assert.match(client, /!matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches\) \{[^]*root\.classList\.add\('motion'\)/);
});

test('every public page is CSP clean and has its title, description, canonical and Open Graph tags', async () => {
  for (const p of PAGES) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    const body = await res.text();
    assertCspClean(body, p);
    assert.match(body, /<title>[^<]{3,}<\/title>/, `${p}: title`);
    assert.match(body, /<meta name="description" content="[^"]{20,}">/, `${p}: description`);
    assert.ok(body.includes(`<link rel="canonical" href="${ORIGIN}${p === '/' ? '/' : p}">`), `${p}: canonical`);
    for (const tag of ['og:title', 'og:description', 'og:url', 'og:image']) assert.match(body, new RegExp(`property="${tag}" content="[^"]+"`), `${p}: ${tag}`);
    assert.equal((body.match(/<h1[\s>]/g) ?? []).length, 1, `${p}: one h1`);
  }
});

test('the home page names the site and its logo for search results', async () => {
  const body = await (await get('/')).text();
  const data = JSON.parse(body.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
  const byType = Object.fromEntries(data['@graph'].map((n) => [n['@type'], n]));
  assert.equal(byType.WebSite.name, 'Grapim');
  assert.equal(byType.Organization.logo.url, `${ORIGIN}/hub/static/site/logo.png`);
  assert.equal((await get('/hub/static/site/logo.png')).status, 200);
});

test('every internal link and image on the public pages resolves', async () => {
  // One request per address: the footer links every page to the same
  // headings, and the hub rate-limits a client that asks too often.
  const seen = new Map();
  const fetchOnce = async (url) => {
    if (!seen.has(url)) {
      const res = await get(url);
      seen.set(url, { status: res.status, text: await res.text() });
    }
    return seen.get(url);
  };
  const check = async (url) => (await fetchOnce(url)).status;
  for (const p of PAGES) {
    const body = await (await get(p)).text();
    const ids = new Set([...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const m of body.matchAll(/\s(?:href|src|srcset)="([^"]+)"/g)) {
      const href = m[1].replace(/&amp;/g, '&');
      if (!href.startsWith('/') && !href.startsWith('#')) continue;
      if (href.startsWith('#')) {
        assert.ok(ids.has(href.slice(1)), `${p}: anchor ${href} has no target`);
        continue;
      }
      const [pathname, hash] = href.split('#');
      if (pathname.startsWith('/hub/auth/github')) continue; // starts OAuth with GitHub
      const status = await check(pathname);
      assert.ok([200, 303].includes(status), `${p}: ${href} answered ${status}`);
      if (hash && status === 200 && !pathname.startsWith('/hub/')) {
        const target = (await fetchOnce(pathname)).text;
        assert.ok(target.includes(`id="${hash}"`), `${p}: ${href} has no #${hash} there`);
      }
    }
  }
});

test('docs: pages, prev and next, the quickstart redirect, and a 404 for unknown pages', async () => {
  const first = await (await get('/docs')).text();
  assert.match(first, /<h1>Quickstart<\/h1>/);
  assert.match(first, /class="pager-next" href="\/docs\/review"/);
  assert.match(first, /aria-current="page"[^>]*>Quickstart|>Quickstart<\/a>/);
  const quick = await get('/docs/quickstart');
  assert.equal(quick.status, 303);
  assert.equal(quick.headers.get('location'), '/docs');
  // Reference ends the review docs; the agent-run pages follow in their own group.
  const support = await (await get('/docs/support')).text();
  assert.match(support, /class="pager-prev" href="\/docs\/faq"/);
  assert.match(support, /class="pager-next" href="\/docs\/concepts"/);
  const last = await (await get('/docs/compare')).text();
  assert.ok(!last.includes('pager-next'));
  assert.equal((await get('/docs/no-such-page')).status, 404);
  assert.equal((await get('/docs/..%2Fsite')).status, 404);
  assert.equal((await get('/support')).headers.get('location'), '/docs/support');
});

test('docs: code blocks get a copy button, output blocks do not', async () => {
  const body = await (await get('/docs/undo')).text();
  assert.match(body, /<button class="copy" type="button" data-copy hidden>Copy<\/button><\/div><pre><code class="lang-sh">grapim undo 7f3e21aa<\/code>/);
  assert.match(body, /<div class="code code-out"><pre><code class="lang-output">Undo claude 7f3e21aa/);
});

test('support: signed out it leads to sign-in and then the form; signed in straight to the form', async () => {
  const out = await (await get('/docs/support')).text();
  assert.ok(out.includes('href="/hub/auth/github?next=%2Fhub%2Fsupport"'));
  const inn = await (await get('/docs/support', { Cookie: signedInCookie() })).text();
  assert.ok(inn.includes('href="/hub/support"'));
  // support@grapim.com is real (Cloudflare Email Routing to the founders, set up 2026-11-15); no other address may appear.
  assert.ok(out.includes('href="mailto:support@grapim.com"'));
  assert.ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(out.replace(/https?:\/\/\S+/g, '').replaceAll('support@grapim.com', '')), 'no email address is invented');
});

test('docs: the CLI reference is generated from the CLI help text', async () => {
  const help = cliHelp();
  assert.ok(help, 'the HELP text is found in src/cli.js');
  const { sections } = parseHelp(help);
  const usages = sections.flatMap((s) => s.entries.map((e) => e.usage)).filter(Boolean);
  for (const cmd of ['init', 'sync', 'runs', 'undo', 'review', 'mcp']) {
    assert.ok(usages.some((u) => u.startsWith(`grapim ${cmd}`)), `grapim ${cmd} is listed`);
  }
  const body = await (await get('/docs/cli')).text();
  assert.match(body, /<code>grapim undo &lt;run&gt;/);
  for (const s of sections) assert.ok(body.includes(`>${s.title.replace(/&/g, '&amp;')}</h2>`), `section ${s.title}`);
});

test('parseHelp reads commands, continuation lines, notes, options and environment', () => {
  const { sections, notes } = parseHelp(`tool: does things.

Usage: grapim <command>

Basics
  grapim one [--x]            first line
                               and its second line
  grapim two <a>
                               only on the next line
  (one and two take --json)

Options
  --agent <name>  act as this agent
  Env: A_MODE=warn  warn instead
       B_TTL  how long

No telemetry.`);
  assert.deepEqual(sections.map((s) => s.title), ['Basics', 'Options']);
  assert.deepEqual(sections[0].entries.map((e) => [e.usage, e.text]), [
    ['grapim one [--x]', 'first line and its second line'],
    ['grapim two <a>', 'only on the next line'],
    [null, 'one and two take --json'],
  ]);
  assert.deepEqual(sections[1].entries.map((e) => [e.usage, e.text]), [
    ['--agent <name>', 'act as this agent'],
    ['A_MODE=warn', 'warn instead'],
    ['B_TTL', 'how long'],
  ]);
  assert.deepEqual(notes, ['No telemetry.']);
});

test('renderMarkdown escapes HTML and keeps only safe links', () => {
  const { html, toc } = renderMarkdown(
    '## Hello <b>world</b>\n\nA <script>alert(1)</script> and [x](javascript:alert(1)) and [y](https://example.com) and `<i>`.\n\n```sh\necho "<b>"\n```\n\n| a | b |\n|---|---|\n| <img> | **c** |',
  );
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>world'));
  assert.ok(!html.includes('<img>'));
  assert.ok(!html.includes('javascript:'));
  assert.match(html, /<a class="link" href="https:\/\/example\.com" rel="noopener">y<\/a>/);
  assert.match(html, /<code>&lt;i&gt;<\/code>/);
  assert.match(html, /echo &quot;&lt;b&gt;&quot;/);
  assert.equal(toc[0].id, 'hello-world');
  const mail = renderMarkdown('[a](mailto:privacy@grapim.com) and [b](mailto:x@y.co?bcc=z@w.co)').html;
  assert.match(mail, /<a class="link" href="mailto:privacy@grapim\.com">a<\/a>/, 'a plain mailto link is kept');
  assert.ok(!mail.includes('bcc'), 'a mailto with extra fields is not');
});

test('every docs page in the nav has a file with a title and a description', () => {
  const pages = loadDocs();
  for (const slug of ORDER) {
    const p = pages.get(slug);
    assert.ok(p.title && p.title !== slug, `${slug}: title`);
    assert.ok(p.description.length > 20, `${slug}: description`);
  }
});

test('terms and privacy: served on their own, dated, with a Changes section, linked from the footer and sign-in', async () => {
  const text = (body) => body.replace(/<[^>]+>/g, ' ').replace(/&#39;|&quot;|&amp;/g, ' ');
  const legal = loadDocs(undefined, LEGAL);
  for (const slug of LEGAL) {
    const res = await get(`/${slug}`);
    assert.equal(res.status, 200, slug);
    const body = await res.text();
    assert.match(body, new RegExp(`<h1>${legal.get(slug).title}</h1>`), `${slug}: its title`);
    assert.match(body, /<strong>Effective 15 November 2026<\/strong>/, `${slug}: the effective date`);
    assert.match(body, /<h2 id="changes">/, `${slug}: a Changes section`);
    assert.match(body, /href="mailto:privacy@grapim\.com"/, `${slug}: privacy requests go to privacy@`);
    assert.ok(!body.includes('docs-nav'), `${slug}: not part of the docs nav`);
    // The note for the founder at the top of the file never reaches the page.
    const src = fs.readFileSync(new URL(`../src/hub/docs/${slug}.md`, import.meta.url), 'utf8');
    assert.ok(src.startsWith('<!--'), `${slug}.md: starts with the list of legal gaps`);
    assert.ok(!/Legal gaps|&lt;!--|lawyer/.test(body), `${slug}: the legal-gaps note is not rendered`);
    assert.ok(!/—/.test(src), `${slug}.md: no em dashes`);
    // Only addresses that really exist (Cloudflare Email Routing).
    const others = text(body).replace(/https?:\/\/\S+/g, '').replace(/\b(support|privacy|hello)@grapim\.com\b/g, '');
    assert.ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(others), `${slug}: no email address is invented`);
  }
  const privacy = text(await (await get('/privacy')).text());
  for (const fact of ['deleted when the review ends', 'Grapim receives nothing', 'Anthropic', 'Railway', 'Cloudflare', 'Stripe', 'GitHub', 'grapim_session', 'grapim_oauth']) {
    assert.ok(privacy.includes(fact), `privacy names: ${fact}`);
  }
  const terms = text(await (await get('/terms')).text());
  for (const fact of ['free for now', 'stay yours', 'can be wrong', 'as is', 'Limitation of liability']) assert.ok(terms.includes(fact), `terms say: ${fact}`);

  // Every public page's footer, and the sign-in page.
  for (const p of PAGES) {
    const body = await (await get(p)).text();
    const foot = body.match(/<footer class="foot">[^]*?<\/footer>/)?.[0] ?? '';
    assert.match(foot, /<li><a href="\/terms">Terms<\/a><\/li><li><a href="\/privacy">Privacy<\/a><\/li>/, `${p}: footer links`);
  }
  const signIn = await (await get('/hub')).text();
  assert.match(signIn, /<a href="\/terms">Terms<\/a>/);
  assert.match(signIn, /<a href="\/privacy">Privacy<\/a>/);
  assert.equal((await get('/terms', { Cookie: signedInCookie() })).status, 200, 'signed in, the pages still show');
});

test('robots.txt and sitemap.xml list the public pages and keep crawlers out of the app', async () => {
  const robots = await (await get('/robots.txt')).text();
  assert.match(robots, /Disallow: \/hub\//);
  for (const s of LEGAL) assert.match(robots, new RegExp(`^Allow: /${s}$`, 'm'));
  assert.match(robots, /Disallow: \/w\//);
  assert.match(robots, new RegExp(`Sitemap: ${ORIGIN}/sitemap.xml`));
  const res = await get('/sitemap.xml');
  assert.match(res.headers.get('content-type'), /xml/);
  const xml = await res.text();
  for (const p of PAGES) assert.ok(xml.includes(`<loc>${ORIGIN}${p}</loc>`), `sitemap has ${p}`);
});

test('the site statics are served with their types', async () => {
  for (const [p, type] of [
    ['/hub/static/site.css', /text\/css/],
    ['/hub/static/site.js', /javascript/],
    ['/hub/static/site/run-light.webp', /image\/webp/],
    ['/hub/static/site/og.png', /image\/png/],
  ]) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), type, p);
  }
  const css = await (await get('/hub/static/site.css')).text();
  assert.ok(!/@import|url\(\s*["']?https?:/i.test(css), 'no external stylesheet or asset');
});

test('AI review: /docs/review and action/review/README.md show the same workflow files the setup checklist hands over', async () => {
  const page = await get('/docs/review');
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /<h1>AI review<\/h1>/);
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const src = read('../src/hub/docs/review.md');
  const readme = read('../action/review/README.md');
  for (const p of REVIEW_PROVIDERS) {
    assert.ok(src.includes(p.yaml), `docs/review.md has the ${p.key} workflow`);
    assert.ok(readme.includes(p.yaml), `action/review/README.md has the ${p.key} workflow`);
    assert.match(body, new RegExp(`id="${p.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}"`), `a heading for ${p.label}`);
  }
});

test('the top bar: Product and Resources menus, plain Pricing and Contact, and the phone sheet, on every page', async () => {
  const client = fs.readFileSync(new URL('../src/hub/pages/site-client.js', import.meta.url), 'utf8');
  for (const p of PAGES) {
    const body = await (await get(p)).text();
    const bar = body.match(/<header class="bar">[^]*?<\/header>/)?.[0];
    assert.ok(bar, `${p}: the bar`);
    assert.equal((bar.match(/<nav class="bar-nav" aria-label="Main">/g) ?? []).length, 1, `${p}: one main nav`);
    for (const m of NAV_MENUS) {
      // Without script the trigger is a link to a real page, and it names the panel it opens.
      assert.match(bar, new RegExp(`<a class="bar-link nav-trigger[^"]*" href="${reEsc(m.href)}" data-panel="nav-${m.id}">${m.label}<svg`), `${p}: ${m.label} trigger`);
      assert.match(bar, new RegExp(`<div class="nav-panel nav-panel-${m.id}" id="nav-${m.id}">`), `${p}: ${m.label} panel`);
      // Every item, in the menu and in the phone sheet: an icon, a title and a one-line description.
      for (const it of m.items) {
        const row = new RegExp(`<a class="nav-row" href="${reEsc(it.href)}"[^>]*><span class="nav-ico"><svg[^]*?</svg></span><span class="nav-txt"><span class="nav-title">${reEsc(it.title)}(<span class="nav-badge">[^<]+</span>)?</span><span class="nav-desc">[^<]{10,}</span>`, 'g');
        assert.equal((bar.match(row) ?? []).length, 2, `${p}: ${m.label} > ${it.title}`);
      }
    }
    for (const l of NAV_LINKS) assert.ok(bar.includes(`href="${l.href}"`), `${p}: ${l.label}`);
    assert.match(bar, /<a class="bar-signin" href="\/hub\/auth\/github" rel="nofollow">Sign in<\/a><a class="btn btn-primary btn-sm" href="\/hub\/auth\/github" rel="nofollow">Start free<\/a>/, `${p}: Sign in and Start free`);
    assert.match(bar, /<details class="bar-menu" data-sheet>\s*<summary aria-label="Menu">/, `${p}: the phone sheet opens without script`);
    assert.equal((bar.match(/<details class="sheet-group"/g) ?? []).length, NAV_MENUS.length, `${p}: one accordion per menu`);
    // Product's second group, under a mono label, in the menu and in the sheet.
    for (const m of NAV_MENUS.filter((x) => x.group)) {
      assert.equal((bar.match(new RegExp(`<p class="nav-label">${m.group.label}</p>`, 'g')) ?? []).length, 2, `${p}: ${m.group.label} label`);
      for (const it of m.group.items) assert.equal((bar.split(`<a class="nav-chip" href="${it.href}"><span class="nav-ico nav-ico-sm"><svg`).length - 1) >= 2, true, `${p}: ${it.title}`);
    }
  }
  // Two columns of six, as the reference menus lay them out.
  for (const m of NAV_MENUS) assert.equal(m.items.length, 6, `${m.label}: six items`);
  const css = fs.readFileSync(new URL('../src/hub/pages/site.css', import.meta.url), 'utf8');
  assert.match(css, /\.bar-nav \.nav-rows \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  // The script turns each trigger into a button that says what it controls.
  for (const s of ["setAttribute('aria-expanded'", "setAttribute('aria-controls'", "'ArrowDown'", "'Escape'", "'pointerenter'", "'pointerleave'", "'sheet-open'"]) assert.ok(client.includes(s), `site.js handles ${s}`);
  assert.match(client, /const OPEN_DELAY = (\d+);/);
  const delay = Number(client.match(/const OPEN_DELAY = (\d+);/)[1]);
  assert.ok(delay >= 80 && delay <= 200, `hover intent delay ${delay} ms`);
});

function reEsc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('the top bar and the footer: every link is a page or a heading that exists', async () => {
  const links = [
    ...NAV_MENUS.flatMap((m) => [{ href: m.href }, ...m.items, ...(m.group?.items ?? [])]),
    ...NAV_LINKS,
    ...FOOT_COLS.flatMap(([, ls]) => ls.map(([href]) => ({ href }))),
  ];
  for (const it of links) {
    // Off the site, only Grapim's own accounts and address.
    if (!it.href.startsWith('/')) {
      assert.ok([REPO, 'https://www.linkedin.com/company/grapim', 'mailto:support@grapim.com'].includes(it.href), it.href);
      continue;
    }
    const [pathname, hash] = it.href.split('#');
    const res = await get(pathname);
    assert.equal(res.status, 200, it.href);
    if (hash) assert.ok((await res.text()).includes(`id="${hash}"`), `${it.href}: the heading exists`);
  }
});

test('the footer: six columns under mono heads, the social marks we have, the year and the mark', async () => {
  const body = await (await get('/pricing')).text();
  const foot = body.match(/<footer class="foot">[^]*?<\/footer>/)[0];
  assert.deepEqual([...foot.matchAll(/<div class="foot-col"><h2>([^<]+)<\/h2>/g)].map((m) => m[1]), ['Product', 'Resources', 'Open source', 'Works with', 'Company', 'Legal']);
  const social = foot.match(/<div class="foot-social">[^]*?<div class="theme-seg"/)[0];
  assert.deepEqual([...social.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]), [REPO, 'https://www.linkedin.com/company/grapim'], 'only accounts Grapim has');
  assert.ok(!/x\.com|twitter\.com/.test(foot), 'no X account to link');
  assert.match(foot, /<div class="theme-seg" role="group" aria-label="Theme">/, 'the theme switch stays');
  assert.match(foot, /<p class="foot-copy"><a class="foot-mark" href="\/" aria-label="Grapim home"><svg[^]*?<\/svg><\/a><span>© 2026 Grapim<\/span><\/p>/);
  const css = fs.readFileSync(new URL('../src/hub/pages/site.css', import.meta.url), 'utf8');
  assert.match(css, /\.foot-cols \{ display: grid; grid-template-columns: repeat\(6, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.foot-col a \{[^}]*var\(--mono\)[^}]*text-transform: uppercase;/);
});

test('the top bar marks where you are', async () => {
  const pricing = await (await get('/pricing')).text();
  assert.match(pricing, /<a class="bar-link" href="\/pricing" aria-current="page">Pricing<\/a>/);
  const review = await (await get('/docs/review')).text();
  assert.match(review, /<a class="bar-link nav-trigger is-current" href="\/docs" data-panel="nav-resources">/, 'Resources is the section');
  assert.match(review, /<a class="nav-row" href="\/docs" aria-current="true">/, 'Docs is the section, not the page');
  const quick = await (await get('/docs')).text();
  assert.match(quick, /<a class="nav-row" href="\/docs" aria-current="page">/);
  assert.ok(!/<a href="\/docs">Docs<\/a><span aria-hidden="true">\/<\/span>/.test(quick), 'the Docs crumb does not link to the page it is on');
  const log = await (await get('/changelog')).text();
  assert.match(log, /<a class="nav-row" href="\/changelog" aria-current="page">/);
  const security = await (await get('/docs/security')).text();
  assert.match(security, /<a class="bar-link nav-trigger is-current" href="\/#how" data-panel="nav-product">/, 'Security sits under Product');
  const home = await (await get('/')).text();
  assert.ok(!/aria-current/.test(home.match(/<header class="bar">[^]*?<\/header>/)[0]), 'nothing is current on the home page');
  // Signed in, the bar offers the hub instead of Sign in and Start free.
  const signed = await (await get('/pricing', { Cookie: signedInCookie() })).text();
  assert.match(signed, /<div class="bar-end"><a class="btn btn-primary btn-sm" href="\/hub">Open the hub<\/a><\/div>/);
  assert.ok(!signed.includes('class="bar-signin"'));
});

test('a page that does not exist gets the site 404, with the site bar and noindex', async () => {
  for (const p of ['/docs/no-such-page', '/notes/no-such-note', '/no-such-page']) {
    const res = await get(p);
    assert.equal(res.status, 404, p);
    const body = await res.text();
    assertCspClean(body, p);
    assert.match(body, /<meta name="robots" content="noindex">/, `${p}: noindex`);
    assert.ok(!body.includes('rel="canonical"'), `${p}: no canonical`);
    assert.match(body, /<header class="bar">/, `${p}: the site bar`);
    assert.match(body, /<h1 class="sec-title">There is no page at this address\.<\/h1>/, p);
  }
  const hub = await get('/hub/no-such-page');
  assert.equal(hub.status, 404);
  assert.ok(!(await hub.text()).includes('<header class="bar">'), 'the hub keeps its own error page');
});
