// `grapim serve`: one process that serves the review desk (ui/), the JSON
// API (/api), the agent workspace (/fs) and MCP over HTTP (/mcp), on the repo
// containing the current directory and the same state file the hooks use.
// node:http only, no dependencies. See docs/api.md.

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { createEngine, UI_DIR } from './engine.js';
import { createGuard, tokenFor } from './security.js';

export const DEFAULT_PORT = 7420;
export { UI_DIR };

const urlHost = (host) => (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host);

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
  const guard = createGuard({ host, env, token: required });
  // The engine at the root, behind the local guard (Host, token, Origin),
  // checked once per request: locally every MCP tool is allowed.
  const engine = createEngine({ cwd, env, uiDir, authorize: (req, { kind, asset }) => (kind === 'mcp-tool' ? undefined : guard(req, { asset, dav: kind === 'dav' })) });
  const server = http.createServer(engine.handle);
  server.keepAliveTimeout = 5000;
  try {
    await listen(server, port, host);
  } catch (err) {
    engine.close();
    throw err;
  }
  const actual = server.address().port;
  let closing = null;
  const close = () =>
    (closing ??= new Promise((resolve) => {
      engine.ctx.stream.close();
      engine.ctx.mcp.closeAll();
      server.close(() => {
        engine.close();
        resolve();
      });
      server.closeAllConnections();
    }));
  return { url: `http://${urlHost(host)}:${actual}`, port: actual, host, ws: engine.ws, token: required, close };
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
  console.log(`  Drive        ${s.url}/dav/  (WebDAV, this machine only)`);
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
