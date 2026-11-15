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
import { cliHelp, docPath, loadDocs, ORDER, parseHelp, renderMarkdown } from '../src/hub/pages/docs.js';
import { REVIEW_PROVIDERS } from '../src/hub/pages/review-setup.js';

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

const PAGES = ['/', '/pricing', '/changelog', ...ORDER.map(docPath)];

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
  const words = body.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  assert.ok(words < 500, `the landing page stays short (${words} words)`);

  // Pricing has its own page. Honest pricing: no checkout while billing is not live.
  const pricing = await (await get('/pricing')).text();
  assert.match(pricing, /nothing is charged yet/);
  assert.match(pricing, /<details open><summary>Does our code have to leave our machines\?/, 'the data question is answered open');
  assert.match(pricing, /Cloud review is included in each plan’s monthly review credit/);
  for (const p of ['free', 'team', 'governance', 'enterprise']) assert.match(pricing, new RegExp(`<h2 id="plan-${p}">`));
  for (const b of [body, pricing]) assert.ok(!/start (your )?(free )?trial|buy now|checkout\.stripe/i.test(b));

  const signedIn = await get('/', { Cookie: signedInCookie() });
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.get('location'), '/hub');
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
  const seen = new Map();
  const check = async (url) => {
    if (!seen.has(url)) seen.set(url, (await get(url)).status);
    return seen.get(url);
  };
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
        const target = await (await get(pathname)).text();
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
  const last = await (await get('/docs/support')).text();
  assert.match(last, /class="pager-prev" href="\/docs\/faq"/);
  assert.ok(!last.includes('pager-next'));
  assert.equal((await get('/docs/no-such-page')).status, 404);
  assert.equal((await get('/docs/..%2Fsite')).status, 404);
  assert.equal((await get('/support')).headers.get('location'), '/docs/support');
});

test('docs: code blocks get a copy button, output blocks do not', async () => {
  const body = await (await get('/docs/undo')).text();
  assert.match(body, /<button class="copy" type="button" data-copy hidden>Copy<\/button><\/div><pre><code>grapim undo 7f3e21aa<\/code>/);
  assert.match(body, /<div class="code code-out"><pre><code>Undo claude 7f3e21aa/);
});

test('support: signed out it leads to sign-in and then the form; signed in straight to the form', async () => {
  const out = await (await get('/docs/support')).text();
  assert.ok(out.includes('href="/hub/auth/github?next=%2Fhub%2Fsupport"'));
  const inn = await (await get('/docs/support', { Cookie: signedInCookie() })).text();
  assert.ok(inn.includes('href="/hub/support"'));
  assert.ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(out.replace(/https?:\/\/\S+/g, '')), 'no email address is invented');
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
});

test('every docs page in the nav has a file with a title and a description', () => {
  const pages = loadDocs();
  for (const slug of ORDER) {
    const p = pages.get(slug);
    assert.ok(p.title && p.title !== slug, `${slug}: title`);
    assert.ok(p.description.length > 20, `${slug}: description`);
  }
});

test('robots.txt and sitemap.xml list the public pages and keep crawlers out of the app', async () => {
  const robots = await (await get('/robots.txt')).text();
  assert.match(robots, /Disallow: \/hub\//);
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
