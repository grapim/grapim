// Serves the review desk from ui/: index.html for "/", files by extension,
// nothing outside ui/ and no dotfiles. A plain 404 page if ui/ is missing.

import fs from 'node:fs';
import path from 'node:path';
import { notAllowed } from './http.js';
import { decodePath } from './paths.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function page(res, status, title, body) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222;background:#fff}code{background:#f2f2f2;padding:.1em .3em;border-radius:3px}@media(prefers-color-scheme:dark){body{color:#ddd;background:#111}code{background:#222}}</style>
</head><body><h1>${escape(title)}</h1>${body}</body></html>`;
  const buf = Buffer.from(html);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

// base: the path the engine is mounted at ("" for grapim serve).
const apiHint = (base = '') => {
  const b = escape(base);
  return `<p>The API is running: <a href="${b}/api/overview"><code>${b}/api/overview</code></a>, <a href="${b}/api/runs"><code>${b}/api/runs</code></a>, the agent workspace at <a href="${b}/fs/"><code>${b}/fs/</code></a>, MCP at <code>POST ${b}/mcp</code>.</p>`;
};

const notFound = (res, rawPath, base) => page(res, 404, 'Not found', `<p>Nothing at <code>${escape(base + rawPath)}</code>.</p>${apiHint(base)}`);

// The file under uiDir for a URL path, or null if the path is not acceptable.
function fileFor(uiDir, rawPath) {
  const rel = decodePath(rawPath.slice(1));
  if (/[\x00-\x1f\\:]/.test(rel)) return null;
  const segs = rel.split('/');
  if (rel.endsWith('/') || rel === '') segs[segs.length - 1] = 'index.html';
  if (segs.some((s) => s === '' || s.startsWith('.'))) return null;
  const abs = path.join(uiDir, ...segs);
  let real;
  try {
    real = fs.realpathSync.native(abs);
  } catch {
    return null;
  }
  const root = fs.realpathSync.native(uiDir);
  return real.startsWith(root + path.sep) ? real : null;
}

export function serveStatic(req, res, rawPath, uiDir, base = '') {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw notAllowed(['GET', 'HEAD']);
  if (!fs.existsSync(path.join(uiDir, 'index.html'))) {
    // No absolute path here: this page loads without the token.
    return page(res, 404, 'The review desk is not built yet', `<p>There is no <code>index.html</code> in the server's <code>ui</code> folder.</p>${apiHint(base)}`);
  }
  const abs = fileFor(uiDir, rawPath);
  const st = abs && fs.statSync(abs);
  if (!st?.isFile()) return notFound(res, rawPath, base);
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
}
