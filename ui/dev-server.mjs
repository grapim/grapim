// Serves ui/ as static files for working on the review desk without
// `grapim serve`. With no /api here, the UI switches to mock mode by itself.
//   node ui/dev-server.mjs [--port 7421]
// Zero dependencies.

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const i = process.argv.indexOf('--port');
const PORT = Number(i > 0 ? process.argv[i + 1] : process.env.PORT || 7421);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end('Bad path'); return; }
  if (rel.startsWith('/api/') || rel.startsWith('/fs/')) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('No API here: the dev server only serves files. The UI uses mock data.');
    return;
  }
  const file = path.join(ROOT, path.normalize(rel === '/' ? '/index.html' : rel));
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(403).end('Forbidden'); return; }
  let st;
  try { st = statSync(file); } catch { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
  if (!st.isFile()) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`Review desk (mock data): http://127.0.0.1:${PORT}/?mock=1`));
