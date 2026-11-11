#!/usr/bin/env node
// A 60-second terminal demo of Grapim.
//
//   node scripts/demo.mjs           paced for recording (about 60 s)
//   node scripts/demo.mjs --fast    no pauses, no typing, no screen clears (for tests)
//   node scripts/demo.mjs --keep    keep the temp repo and print where it is
//
// The agents are scripted, the tool is not: every Claude Code session talks to
// Grapim by running `grapim hook` with the same JSON Claude Code sends, Codex
// and Cursor each hold a real MCP session over stdio, and every block of output
// on screen is what Grapim (or git, or the repo's tests) printed just now.
// No dependencies. NO_COLOR turns colour off.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'grapim.js');
const args = process.argv.slice(2);
const FAST = args.includes('--fast');
const KEEP = args.includes('--keep');
const TTY = process.stdout.isTTY === true;
const COLOR = TTY && !process.env.NO_COLOR;
// Wrapped text stays under 100 columns, with room for terminals that wrap at the edge.
const WIDTH = 98;

// ---------- screen ----------

const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = sgr('2');
const bold = sgr('1');
const red = sgr('31');
const green = sgr('32');
const say = sgr('1;36');

const out = (s = '') => process.stdout.write(s + '\n');
const sleep = (ms) => (FAST ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

// Wraps prose to the screen width, keeping an indent on every line.
function wrap(text, indent) {
  const width = WIDTH - indent.length;
  const lines = [];
  for (const para of text.replace(/\s+$/, '').split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      if (line && (line + ' ' + word).length > width) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines.map((l) => indent + l).join('\n');
}

// Beats start at fixed times, so the whole run lasts about 60 s on any machine.
let START = null;
async function beat(atSeconds) {
  if (FAST) return out();
  START ??= Date.now();
  const wait = START + atSeconds * 1000 - Date.now();
  // DEMO_TIMING=1 reports how much time each beat left to read its last output.
  if (process.env.DEMO_TIMING) process.stderr.write(`beat ${atSeconds}s: ${(wait / 1000).toFixed(1)}s to spare\n`);
  await sleep(Math.max(wait, 1500));
  if (TTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

async function narrate(text) {
  out(say(`# ${text}`));
  await sleep(700);
}

async function typeCommand(cmd) {
  if (FAST) return out(dim(`$ ${cmd}`));
  process.stdout.write(dim('$ '));
  for (const ch of cmd) {
    process.stdout.write(dim(ch));
    await sleep(28);
  }
  await sleep(250);
  out();
}

// ---------- the repo ----------

const env = { ...process.env };
for (const k of ['GRAPIM_AGENT', 'GRAPIM_MODE', 'GRAPIM_STATE_DIR', 'GRAPIM_TTL_MINUTES']) delete env[k];

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-demo-'));
const REPO = path.join(BASE, 'shop-api');

const FILES = {
  'package.json': `{
  "name": "shop-api",
  "private": true,
  "type": "module",
  "scripts": { "start": "node src/server.js", "test": "node test/api.test.js" }
}
`,
  'src/app.js': `// A tiny Express-style app: register routes and middleware, then handle requests.
export function createApp() {
  const routes = [];
  const middleware = [];
  const route = (method) => (path, fn) => routes.push({ method, path, fn });
  return {
    use: (fn) => middleware.push(fn),
    get: route('GET'),
    post: route('POST'),
    async handle(req) {
      const res = { status: 200, body: null };
      for (const fn of middleware) if (fn(req, res) === false) return res;
      const r = routes.find((r) => r.method === req.method && r.path === req.path);
      if (!r) return { status: 404, body: { error: 'not found' } };
      await r.fn(req, res);
      return res;
    },
  };
}
`,
  'src/routes.js': `import { createApp } from './app.js';
import * as users from './users.js';

export function routes() {
  const app = createApp();

  app.get('/health', (req, res) => {
    res.body = { ok: true };
  });

  app.get('/users', users.list);
  app.post('/users', users.create);

  return app;
}
`,
  'src/users.js': `const users = [{ id: 1, name: 'Ada', email: 'ada@example.com' }];

export function list(req, res) {
  res.body = users;
}

export function create(req, res) {
  const { name, email } = req.body ?? {};
  if (!name) {
    res.status = 400;
    res.body = { error: 'name is required' };
    return;
  }
  const user = { id: users.length + 1, name, email };
  users.push(user);
  res.status = 201;
  res.body = user;
}
`,
  'src/server.js': `import http from 'node:http';
import { routes } from './routes.js';

const app = routes();

http
  .createServer(async (req, res) => {
    const result = await app.handle({ method: req.method, path: req.url, ip: req.socket.remoteAddress });
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.body));
  })
  .listen(process.env.PORT || 3000);
`,
  'test/api.test.js': `import assert from 'node:assert/strict';
import { routes } from '../src/routes.js';

const app = routes();
const call = (method, path, body) => app.handle({ method, path, body, ip: '127.0.0.1' });
const status = async (want, method, path, body) => {
  const res = await call(method, path, body);
  assert.equal(res.status, want, \`got \${res.status}\`);
  return res.body;
};

const tests = {
  'GET /health': () => status(200, 'GET', '/health'),
  'GET /users': () => status(200, 'GET', '/users'),
  'POST /users creates a user': () => status(201, 'POST', '/users', { name: 'Grace', email: 'grace@example.com' }),
  'POST /users needs a name': () => status(400, 'POST', '/users', { email: 'x@example.com' }),
  'GET /users lists the new user': async () => assert.equal((await status(200, 'GET', '/users')).length, 2),
  'GET /nope returns 404': () => status(404, 'GET', '/nope'),
};

const failed = [];
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
  } catch (err) {
    failed.push(\`  FAIL  \${name}: \${err.message.split('\\n')[0]}\`);
  }
}
const n = Object.keys(tests).length;
console.log(failed.length ? \`\${n - failed.length} passed, \${failed.length} failed\\n\${failed.join('\\n')}\` : \`\${n} passed\`);
process.exitCode = failed.length ? 1 : 0;
`,
};

function makeRepo() {
  fs.mkdirSync(REPO);
  const git = (...a) => execFileSync('git', a, { cwd: REPO, stdio: 'ignore' });
  git('init', '-q');
  for (const [name, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(REPO, name)), { recursive: true });
    fs.writeFileSync(path.join(REPO, name), content);
  }
  git('add', '.');
  git('-c', 'user.email=demo@example.com', '-c', 'user.name=demo', 'commit', '-qm', 'shop-api');
}

// ---------- running things ----------

// Runs a command in the repo and shows it: the dimmed command line, then its real output.
async function run(shown, file, argv) {
  await typeCommand(shown);
  const r = spawnSync(file, argv, { cwd: REPO, env, encoding: 'utf8', windowsHide: true });
  const text = (r.stdout + r.stderr).replace(/\s+$/, '');
  if (text) out(text);
  return { code: r.status, text };
}
const grapim = (...a) => run(`grapim ${a.join(' ')}`, process.execPath, [BIN, ...a]);

// A Claude Code session: hook calls with the JSON Claude Code pipes to `grapim hook`.
let toolUse = 0;
function claude(sessionId) {
  const label = `claude ${sessionId.slice(0, 8)}`;
  const hook = (input) => {
    const r = spawnSync(process.execPath, [BIN, 'hook'], {
      input: JSON.stringify({ session_id: sessionId, cwd: REPO, ...input }),
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return {
    label,
    prompt: (prompt) => hook({ hook_event_name: 'UserPromptSubmit', prompt }),
    end: () => hook({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }),
    // One tool call the way Claude Code runs it: PreToolUse, the write (only if
    // the hook allows it), PostToolUse.
    tool(tool, file, toolInput, write) {
      const call = {
        tool_name: tool,
        tool_use_id: `toolu_demo_${++toolUse}`,
        tool_input: { file_path: path.join(REPO, file), ...toolInput },
      };
      const pre = hook({ ...call, hook_event_name: 'PreToolUse' });
      if (pre.code === 2) return { blocked: true, message: pre.stderr };
      write(path.join(REPO, file));
      hook({ ...call, hook_event_name: 'PostToolUse', tool_response: { success: true } });
      return { blocked: false };
    },
  };
}

// Claude Code's Edit/MultiEdit: replace exact strings.
const applyEdits = (edits) => (abs) => {
  let s = fs.readFileSync(abs, 'utf8');
  for (const { old_string, new_string } of edits) {
    if (!s.includes(old_string)) throw new Error(`demo edit does not apply to ${abs}: ${old_string}`);
    s = s.replace(old_string, new_string);
  }
  fs.writeFileSync(abs, s);
};
const editTool = (session, file, edits) =>
  edits.length === 1
    ? session.tool('Edit', file, edits[0], applyEdits(edits))
    : session.tool('MultiEdit', file, { edits }, applyEdits(edits));
const writeTool = (session, file, content) => session.tool('Write', file, { content }, (abs) => fs.writeFileSync(abs, content));

// An MCP client over stdio, as Codex or Cursor runs one: initialize, then tools/call.
async function mcpClient(clientName) {
  const p = spawn(process.execPath, [BIN, 'mcp'], { cwd: REPO, env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const waiting = new Map();
  readline.createInterface({ input: p.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  let next = 1;
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: clientName, version: '1.0.0' } });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return {
    label: `${clientName} ${p.pid}`,
    call: async (name, args) => {
      const msg = await request('tools/call', { name, arguments: args });
      return { text: msg.result.content[0].text, isError: !!msg.result.isError };
    },
    close: () => new Promise((resolve) => (p.on('close', resolve), p.stdin.end())),
  };
}

// ---------- showing agent actions ----------

const NAME_W = 16;
const actor = (label) => bold(label.padEnd(NAME_W));

function showAction(label, what, result = '') {
  out(`${actor(label)} ${what}${result ? `  ${result}` : ''}`);
}

function showReply(text, mark = '') {
  out(wrap(text, '  ' + mark));
}

// ---------- the story ----------

const A_ROUTES = [
  { old_string: "import * as users from './users.js';\n", new_string: "import * as users from './users.js';\nimport * as billing from './billing.js';\n" },
  { old_string: "  app.post('/users', users.create);\n", new_string: "  app.post('/users', users.create);\n  app.post('/billing/invoices', billing.create);\n" },
];
const A_BILLING = `const invoices = [];

export function create(req, res) {
  const { userId, amount } = req.body ?? {};
  if (!userId || !(amount > 0)) {
    res.status = 400;
    res.body = { error: 'userId and a positive amount are required' };
    return;
  }
  const invoice = { id: invoices.length + 1, userId, amount, status: 'open' };
  invoices.push(invoice);
  res.status = 201;
  res.body = invoice;
}
`;
const B_RATELIMIT = `// At most \`perMinute\` requests per client IP in any minute.
export function rateLimit({ perMinute }) {
  const hits = new Map();
  return (req, res) => {
    const now = Date.now();
    const recent = (hits.get(req.ip) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    hits.set(req.ip, recent);
    if (recent.length > perMinute) {
      res.status = 429;
      res.body = { error: 'too many requests' };
      return false;
    }
  };
}
`;
const B_ROUTES = [
  { old_string: "import * as billing from './billing.js';\n", new_string: "import * as billing from './billing.js';\nimport { rateLimit } from './ratelimit.js';\n" },
  { old_string: '  const app = createApp();\n', new_string: '  const app = createApp();\n  app.use(rateLimit({ perMinute: 5 }));\n' },
];
const C_USERS = [
  { old_string: "const users = [{ id: 1, name: 'Ada', email: 'ada@example.com' }];\n", new_string: "const users = [{ id: 1, name: 'Ada', email: 'ada@example.com' }];\nconst isEmail = (s) => /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(s ?? '');\n" },
  { old_string: "    res.body = { error: 'name is required' };\n    return;\n  }\n", new_string: "    res.body = { error: 'name is required' };\n    return;\n  }\n  if (!isEmail(email)) {\n    res.status = 400;\n    res.body = { error: 'email is not valid' };\n    return;\n  }\n" },
  { old_string: '  res.body = user;\n}\n', new_string: '  res.body = user;\n}\n\nexport function verify(req, res) {\n  res.body = { valid: isEmail(req.body?.email) };\n}\n' },
];
const C_ROUTES = [{ old_string: "  app.post('/users', users.create);\n", new_string: "  app.post('/users', users.create);\n  app.post('/users/verify', users.verify);\n" }];
const D_SERVER = [
  {
    old_string: `    const result = await app.handle({ method: req.method, path: req.url, ip: req.socket.remoteAddress });
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.body));
`,
    new_string: `    let result;
    try {
      result = await app.handle({ method: req.method, path: req.url, ip: req.socket.remoteAddress });
    } catch (err) {
      result = { status: 500, body: { error: err.message } };
    }
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.body));
`,
  },
];

async function main() {
  makeRepo();
  const B = claude('7c41e0d2-5b9a-4f1e-9c3d-2a8b6e4f1c07');
  const C = claude('3e8b51a9-0d47-4c2b-8f6e-91a2c5d7e384');
  let codex;
  let cursor;

  try {
    // 0-10 s: the repo, four agents start, grapim status.
    await beat(0);
    out(dim('The agents are scripted. Every hook call, MCP message and output below is real.'));
    out();
    await narrate('shop-api: a small Express-style API.');
    await run('git ls-files', 'git', ['ls-files']);
    out();
    await narrate('Four agents start on it at once: two Claude Code sessions, Codex and Cursor.');
    B.prompt('Add rate limiting to the API');
    showAction(B.label, dim('Claude Code, hooks') + '  "Add rate limiting to the API"');
    C.prompt('Validate emails on signup');
    showAction(C.label, dim('Claude Code, hooks') + '  "Validate emails on signup"');
    codex = await mcpClient('codex');
    const a1 = await codex.call('claim_files', { paths: ['src/routes.js', 'src/billing.js'], intent: 'Add a /billing endpoint' });
    showAction(codex.label, dim('Codex, MCP') + '         "Add a /billing endpoint"');
    cursor = await mcpClient('cursor');
    const d1 = await cursor.call('claim_files', { paths: ['src/server.js'], intent: 'Return JSON errors from the server' });
    showAction(cursor.label, dim('Cursor, MCP') + '        "Return JSON errors from the server"');
    if (a1.isError || d1.isError) throw new Error(`claim failed: ${a1.text} ${d1.text}`);
    await sleep(600);
    out();
    await grapim('status');

    // 10-24 s: Claude C is stopped at src/routes.js and moves on.
    await beat(10);
    await narrate(`${C.label} wants src/routes.js too. Codex is in it.`);
    showAction(C.label, 'Edit src/routes.js');
    const blocked = editTool(C, 'src/routes.js', C_ROUTES);
    if (!blocked.blocked) throw new Error('expected the edit to src/routes.js to be blocked');
    await sleep(500);
    out(red('  ✗ blocked by the PreToolUse hook. What Claude reads:'));
    showReply(blocked.message, '│ ');
    await sleep(3000);
    out();
    await narrate('It moves on to another file. The others keep working.');
    const c1 = editTool(C, 'src/users.js', C_USERS);
    showAction(C.label, 'MultiEdit src/users.js', c1.blocked ? red('✗ blocked') : green('✓'));
    const b1 = writeTool(B, 'src/ratelimit.js', B_RATELIMIT);
    showAction(B.label, 'Write src/ratelimit.js', b1.blocked ? red('✗ blocked') : green('✓'));
    applyEdits(A_ROUTES)(path.join(REPO, 'src/routes.js'));
    fs.writeFileSync(path.join(REPO, 'src/billing.js'), A_BILLING);
    const a2 = await codex.call('release_files', {});
    showAction(codex.label, 'release_files');
    showReply(a2.text);
    await sleep(400);
    applyEdits(D_SERVER)(path.join(REPO, 'src/server.js'));
    const d2 = await cursor.call('release_files', {});
    showAction(cursor.label, 'release_files');
    showReply(d2.text);
    await sleep(400);
    const b2 = editTool(B, 'src/routes.js', B_ROUTES);
    showAction(B.label, 'MultiEdit src/routes.js', b2.blocked ? red('✗ blocked') : green('✓'));
    B.end();
    await sleep(400);
    const c2 = editTool(C, 'src/routes.js', C_ROUTES);
    showAction(C.label, 'Edit src/routes.js', c2.blocked ? red('✗ blocked') : green('✓ free now'));
    C.end();
    // Disconnecting ends both MCP sessions; that finishes while the screen is read.
    const closing = Promise.all([codex.close(), cursor.close()]);
    codex = cursor = null;

    // 24-36 s: what each run changed, and who wrote each line of one file.
    await beat(24);
    await closing;
    await narrate('All four are done. What did each one change?');
    await grapim('runs');
    out();
    await sleep(2500);
    await narrate('Three agents wrote lines in src/routes.js:');
    await grapim('blame', 'src/routes.js');

    // 36-55 s: B broke the tests. Undo its run, keep everyone else's.
    await beat(36);
    await narrate(`The tests fail. ${B.label} added the rate limiter.`);
    await run('node test/api.test.js', process.execPath, ['test/api.test.js']);
    out();
    await sleep(1500);
    await narrate(`Undo that one run:`);
    await grapim('undo', B.label.split(' ')[1].slice(0, 4), '--yes');

    await beat(46);
    await narrate(`Its lines are gone. The lines Codex and ${C.label} wrote in the same file stay:`);
    await grapim('blame', 'src/routes.js');
    out();
    await sleep(1200);
    await run('node test/api.test.js', process.execPath, ['test/api.test.js']);

    // 55-60 s: the line.
    await beat(55);
    if (!FAST && TTY) out('\n'.repeat(Math.max(0, Math.floor((process.stdout.rows || 30) / 2) - 1)));
    out(bold("See what every agent changed. Undo any agent's run in one command."));
    await sleep(4000);
  } finally {
    await codex?.close();
    await cursor?.close();
    if (KEEP) out(dim(`\nrepo kept at ${REPO}`));
    else fs.rmSync(BASE, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`demo failed: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
