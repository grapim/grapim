// `grapim serve`: one process that serves the review desk (ui/), the JSON
// API (/api), the agent workspace (/fs) and MCP over HTTP (/mcp), on the repo
// containing the current directory and the same state file the hooks use.
// node:http only, no dependencies. See docs/api.md.

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../store.js';
import { resolveWorkspace } from '../workspace.js';
import { handleApi } from './api.js';
import { createWorkspace } from './fs.js';
import { handleFs } from './fs-http.js';
import { sendError, splitUrl } from './http.js';
import { createMcpHttp } from './mcp-http.js';
import { createGuard, tokenFor } from './security.js';
import { serveStatic } from './static.js';
import { createStream } from './stream.js';

export const DEFAULT_PORT = 7420;
export const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// The parts of the server that hold repo data or act on it. Everything else
// is the review desk's own files (public code, no data), which a browser must
// be able to load before the page can send the token.
const isAppPath = (target) => /^\/(api|fs|mcp)(\/|$)/.test(target.split('?')[0]);

const urlHost = (host) => (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host);

function route(ctx) {
  return async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      ctx.guard(req, { asset: (req.method === 'GET' || req.method === 'HEAD') && req.url.startsWith('/') && !isAppPath(req.url) });
      const { path: p, query } = splitUrl(req.url);
      if (p === '/mcp') return await ctx.mcp.handle(req, res);
      if (p === '/fs' || p.startsWith('/fs/')) return await handleFs(ctx, req, res, p);
      if (p === '/api' || p.startsWith('/api/')) return await handleApi(ctx, req, res, p, query);
      return serveStatic(req, res, p, ctx.uiDir);
    } catch (err) {
      sendError(res, err);
    }
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const fail = (err) => {
      if (err.code === 'EADDRINUSE') reject(new Error(`Port ${port} on ${host} is already in use. Try --port ${port + 1}, or stop the other server.`));
      else if (err.code === 'EADDRNOTAVAIL') reject(new Error(`${host} is not an address of this machine.`));
      else reject(err);
    };
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      resolve();
    });
  });
}

// Starts the server. Resolves to { url, port, host, ws, close() }.
export async function startServer({ cwd = process.cwd(), host = '127.0.0.1', port = DEFAULT_PORT, env = process.env, uiDir = UI_DIR, token } = {}) {
  const required = tokenFor(host, env, token);
  const ws = resolveWorkspace(cwd);
  const store = new Store(ws.stateDir);
  const workspace = createWorkspace({ store, ws, env });
  const ctx = {
    store,
    ws,
    env,
    workspace,
    uiDir,
    stream: createStream(store),
    mcp: createMcpHttp({ store, ws, workspace }),
    guard: createGuard({ host, env, token: required }),
  };
  const server = http.createServer(route(ctx));
  server.keepAliveTimeout = 5000;
  try {
    await listen(server, port, host);
  } catch (err) {
    store.close();
    throw err;
  }
  const actual = server.address().port;
  let closing = null;
  const close = () =>
    (closing ??= new Promise((resolve) => {
      ctx.stream.close();
      ctx.mcp.closeAll();
      server.close(() => {
        store.close();
        resolve();
      });
      server.closeAllConnections();
    }));
  return { url: `http://${urlHost(host)}:${actual}`, port: actual, host, ws, token: required, close };
}

// url is built here from a host and a port, so it holds no shell characters.
function openBrowser(url) {
  const [cmd, args, verbatim] =
    process.platform === 'win32'
      ? ['cmd', ['/c', `start "" "${url}"`], true]
      : process.platform === 'darwin'
        ? ['open', [url], false]
        : ['xdg-open', [url], false];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: verbatim }).on('error', () => {}).unref();
  } catch {}
}

function parseArgs(args) {
  const opts = { port: DEFAULT_PORT, host: '127.0.0.1', open: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--open') opts.open = true;
    else if (a === '--port' || a === '--host') {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value.`);
      opts[a.slice(2)] = v;
    } else throw new Error(`Unknown option for serve: ${a}. Usage: grapim serve [--port 7420] [--host 127.0.0.1] [--open]`);
  }
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be a number from 0 to 65535, not "${opts.port}".`);
  return { ...opts, port };
}

// The CLI entry point. Returns an exit code on failure, null while serving.
export async function serveMain(args, { cwd = process.cwd(), env = process.env } = {}) {
  let s;
  try {
    const opts = parseArgs(args);
    s = await startServer({ cwd, env, host: opts.host, port: opts.port });
    if (opts.open) openBrowser(`${s.url}/`);
  } catch (err) {
    console.error(`grapim serve: ${err.message}`);
    return 1;
  }
  console.log(`Grapim is serving ${s.ws.repo} (${s.ws.root.split(path.sep).join('/')})`);
  console.log(`  Review desk  ${s.url}/`);
  console.log(`  API          ${s.url}/api/overview`);
  console.log(`  Workspace    ${s.url}/fs/`);
  console.log(`  MCP          ${s.url}/mcp`);
  if (s.token) {
    console.log('  Every request needs Authorization: Bearer $GRAPIM_TOKEN.');
    console.log('  Open the desk once as /?token=<GRAPIM_TOKEN>; it keeps the token for that tab only.');
  }
  console.log('Ctrl+C to stop.');
  const stop = () => s.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return null;
}
