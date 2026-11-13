// The public site: the landing page at / (signed-out visitors; a session
// still goes straight to /hub), the docs at /docs, robots.txt and
// sitemap.xml. No route here reads or changes team data.
//
// Registered before pageRoutes (server.js), so this / wins over its redirect.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { notFound, redirect } from './http.js';
import { docPath, docsPage, loadDocs, ORDER } from './pages/docs.js';
import { changelogPage, landingPage, pricingPage } from './pages/site.js';

const PAGES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pages');
const IMG = path.join(PAGES, 'site-img');
const TYPES = { '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp4': 'video/mp4' };

// The site's static files, for server.js's statics map.
export function siteStatics() {
  const out = {
    '/hub/static/site.css': ['text/css; charset=utf-8', fs.readFileSync(path.join(PAGES, 'site.css'))],
    '/hub/static/site.js': ['text/javascript; charset=utf-8', fs.readFileSync(path.join(PAGES, 'site-client.js'))],
  };
  for (const f of fs.readdirSync(IMG)) {
    const type = TYPES[path.extname(f)];
    if (type) out[`/hub/static/site/${f}`] = [type, fs.readFileSync(path.join(IMG, f))];
  }
  return out;
}

function send(ctx, body, type = 'text/html; charset=utf-8') {
  ctx.res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  ctx.res.end(ctx.req.method === 'HEAD' ? undefined : body);
}

export function siteRoutes(router, hub) {
  const origin = hub.config.origin;
  const pages = loadDocs();
  const landing = landingPage({ origin, demo: !!hub.config.demo });

  router.get('/', (ctx) => {
    if (ctx.session) return redirect(ctx.res, '/hub');
    send(ctx, landing);
  });

  router.get('/pricing', (ctx) => send(ctx, pricingPage({ origin, signedIn: !!ctx.session })));
  router.get('/changelog', (ctx) => send(ctx, changelogPage({ origin, signedIn: !!ctx.session })));

  router.get('/docs', (ctx) => send(ctx, docsPage({ pages, slug: ORDER[0], origin, signedIn: !!ctx.session })));
  router.get('/docs/:page', (ctx) => {
    const slug = ctx.params.page;
    if (slug === ORDER[0]) return redirect(ctx.res, '/docs');
    if (!pages.has(slug)) throw notFound('There is no docs page at this address.');
    send(ctx, docsPage({ pages, slug, origin, signedIn: !!ctx.session }));
  });
  router.get('/support', (ctx) => redirect(ctx.res, '/docs/support'));

  router.get('/robots.txt', (ctx) => {
    const body = ['User-agent: *', 'Allow: /$', 'Allow: /pricing', 'Allow: /changelog', 'Allow: /docs', 'Allow: /hub/static/', 'Disallow: /hub/', 'Disallow: /w/', 'Disallow: /v1/', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n');
    send(ctx, body, 'text/plain; charset=utf-8');
  });

  router.get('/sitemap.xml', (ctx) => {
    const urls = ['/', '/pricing', '/changelog', ...ORDER.map(docPath)];
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${origin}${u}</loc></url>`).join('\n')}\n</urlset>\n`;
    send(ctx, body, 'application/xml; charset=utf-8');
  });
}
