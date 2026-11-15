// The agent inventory: what `grapim sync` collects from the agents' configs
// (and, above all, what it never collects), how the hub checks and stores it,
// and the Agents page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectInventory, describeServer, parseCodexToml } from '../src/inventory.js';
import { createHub } from '../src/hub/server.js';
import { parseInventory, storeInventory } from '../src/hub/inventory.js';
import { DatabaseSync } from 'node:sqlite';
import { runHook } from '../src/hook.js';
import { Store } from '../src/store.js';
import { resolveWorkspace } from '../src/workspace.js';
import { syncOnce } from '../src/sync.js';

const ORIGIN = 'http://localhost:7999';
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
};

// Strings that must never leave the machine. Each one is planted in a config.
const SECRETS = [
  'sk-ant-SECRET-env-1',
  'ghp_SECRETheader2',
  'Bearer SECRET-bearer-3',
  'SECRET-arg-token-4',
  'postgres://admin:SECRETpw5@db.internal:5432/prod',
  'SECRETpw5',
  'SECRET-query-6',
  'secret-path-7',
  'alexuser',
  'SECRET-codex-env-8',
  'SECRET-gemini-header-9',
  'SECRET-uvx-from-10',
  'SECRET-cursor-env-11',
  'SECRET-project-12',
  '/Users/alexuser/projects/shop',
];

function fakeMachine() {
  const home = tmp('grapim-inv-home-');
  const root = tmp('grapim-inv-repo-');
  write(path.join(home, '.claude.json'), {
    numStartups: 3,
    mcpServers: {
      github: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github@2025.1.0'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_SECRETheader2', ANTHROPIC_API_KEY: 'sk-ant-SECRET-env-1' } },
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp?token=SECRET-query-6', headers: { Authorization: 'Bearer SECRET-bearer-3' } },
      postgres: { command: '/Users/alexuser/.local/bin/uvx', args: ['--from', 'git+https://SECRET-uvx-from-10@github.com/x/y', 'mcp-server-postgres', 'postgres://admin:SECRETpw5@db.internal:5432/prod'] },
      local: { command: '/Users/alexuser/secret-path-7/run-server', args: ['--token', 'SECRET-arg-token-4'] },
      sneaky: { url: 'https://alexuser:SECRETpw5@tools.example.com:8443/secret-path-7/sse', type: 'sse' },
    },
    projects: {
      '/Users/alexuser/projects/shop': { mcpServers: { sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp', headers: { 'X-Key': 'SECRET-project-12' } } }, history: [{ display: 'SECRET-project-12' }] },
    },
  });
  write(path.join(home, '.claude', 'settings.json'), { model: 'claude-opus-4-5', env: { ANTHROPIC_API_KEY: 'sk-ant-SECRET-env-1' } });
  write(path.join(home, '.cursor', 'mcp.json'), {
    mcpServers: { windows: { command: 'cmd', args: ['/c', 'npx', '-y', 'figma-mcp@latest', '--key', 'SECRET-arg-token-4'], env: { FIGMA_KEY: 'SECRET-cursor-env-11' } } },
  });
  write(
    path.join(home, '.codex', 'config.toml'),
    `model = "gpt-5-codex"
approval_policy = "on-request"

[mcp_servers.docs]
command = "npx"
args = [
  "-y", # comment
  "@upstash/context7-mcp",
  "--api-key", "SECRET-arg-token-4",
]
env = { "CONTEXT7_KEY" = "SECRET-codex-env-8" }

[mcp_servers.docs.env]
OTHER = "SECRET-codex-env-8"

[mcp_servers."remote.one"]
url = "https://remote.example.org/mcp/secret-path-7"
bearer_token_env_var = "SECRET-codex-env-8"

[profiles.fast]
model = "not-this-one"
`,
  );
  write(path.join(home, '.gemini', 'settings.json'), {
    model: { name: 'gemini-2.5-pro' },
    mcpServers: {
      search: { url: 'https://search.example.net/sse', headers: { Authorization: 'SECRET-gemini-header-9' } },
      stream: { httpUrl: 'https://stream.example.net/mcp' },
      py: { command: 'uvx', args: ['--python', '3.12', 'mcp-server-time==1.0'] },
    },
  });
  write(path.join(root, '.mcp.json'), { mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest', '--secret', 'SECRET-project-12'] } } });
  return { home, root };
}

test('collection: names, transports, command basenames, packages and hosts only; no secret in env, headers, args, URLs or paths', () => {
  const { home, root } = fakeMachine();
  const inv = collectInventory({ home, root, env: {}, seen: [{ source: 'cursor', kind: 'version', value: '1.7.2' }, { source: 'claude', kind: 'model', value: 'claude-sonnet-4-5[1m]' }] });
  const text = JSON.stringify(inv);
  for (const s of SECRETS) assert.ok(!text.includes(s), `"${s}" leaked into the inventory: ${text}`);
  assert.doesNotMatch(text, /SECRET|alexuser|token|Bearer|postgres:\/\//i);

  const by = (agent, name) => inv.mcp.find((s) => s.agent === agent && s.name === name);
  assert.deepEqual(by('claude', 'github'), { agent: 'claude', scope: 'user', name: 'github', transport: 'stdio', command: 'npx', package: '@modelcontextprotocol/server-github', host: null });
  assert.deepEqual(by('claude', 'linear'), { agent: 'claude', scope: 'user', name: 'linear', transport: 'http', command: null, package: null, host: 'mcp.linear.app' });
  assert.equal(by('claude', 'postgres').command, 'uvx');
  assert.equal(by('claude', 'postgres').package, 'mcp-server-postgres', 'the --from value is skipped, the package kept');
  assert.equal(by('claude', 'local').command, 'run-server');
  assert.equal(by('claude', 'local').package, null);
  assert.deepEqual([by('claude', 'sneaky').transport, by('claude', 'sneaky').host], ['sse', 'tools.example.com']);
  assert.equal(by('claude', 'sentry').scope, 'project', 'per-project entries of ~/.claude.json, without their path');
  assert.deepEqual([by('claude', 'playwright').scope, by('claude', 'playwright').package], ['project', '@playwright/mcp']);
  assert.deepEqual([by('cursor', 'windows').command, by('cursor', 'windows').package], ['npx', 'figma-mcp'], 'cmd /c npx is read as npx');
  assert.deepEqual([by('codex', 'docs').command, by('codex', 'docs').package], ['npx', '@upstash/context7-mcp']);
  assert.deepEqual([by('codex', 'remote.one').transport, by('codex', 'remote.one').host], ['http', 'remote.example.org']);
  assert.deepEqual([by('gemini', 'search').transport, by('gemini', 'stream').transport], ['sse', 'http'], 'Gemini: url is SSE, httpUrl is HTTP');
  assert.deepEqual([by('gemini', 'py').command, by('gemini', 'py').package], ['uvx', 'mcp-server-time'], 'the --python value is skipped');

  const agent = (a) => inv.agents.find((x) => x.agent === a);
  assert.deepEqual(inv.agents.map((a) => a.agent), ['claude', 'codex', 'cursor', 'gemini']);
  assert.deepEqual(agent('claude').models, ['claude-sonnet-4-5[1m]', 'claude-opus-4-5']);
  assert.deepEqual(agent('codex').models, ['gpt-5-codex'], 'the top-level model only, not a profile');
  assert.deepEqual(agent('gemini').models, ['gemini-2.5-pro']);
  assert.equal(agent('cursor').version, '1.7.2');
  // Every value the hub would get passes the hub's own check.
  assert.deepEqual(parseInventory(JSON.parse(text)).mcp.length, inv.mcp.length);
});

test('collection: missing, empty and invalid files are ignored without an error', () => {
  const home = tmp('grapim-inv-bad-');
  write(path.join(home, '.claude.json'), '{ not json');
  write(path.join(home, '.cursor', 'mcp.json'), '[]');
  write(path.join(home, '.codex', 'config.toml'), '[mcp_servers.x\ncommand = = "npx"\nargs = [1, 2]');
  write(path.join(home, '.gemini', 'settings.json'), '');
  const inv = collectInventory({ home, root: path.join(home, 'nope'), env: {} });
  assert.deepEqual(inv.mcp, []);
  assert.deepEqual(collectInventory({ home: path.join(home, 'missing'), root: null, env: {} }), { agents: [], mcp: [] });
  assert.equal(describeServer('bad name!', { command: 'npx' }), null);
  assert.equal(describeServer('x', { command: 'npx', args: ['https://SECRET@evil/pkg'] }).package, null, 'a URL is never taken as a package');
  assert.deepEqual(parseCodexToml('model = "m"\n[mcp_servers.a]\ncommand = \'node\'\nargs = ["s.js"]\n').servers, { a: { command: 'node', args: ['s.js'] } });
});

test('the hooks remember the model and version an agent names, for the inventory', () => {
  const root = tmp('grapim-inv-hook-');
  const env = { ...process.env };
  delete env.GRAPIM_STATE_DIR;
  runHook({ hook_event_name: 'SessionStart', session_id: 'aaaa1111-2222', cwd: root, model: 'claude-opus-4-5' }, env);
  runHook({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'bbbb2222', workspace_roots: [root], prompt: 'hi', model: 'gpt-5', cursor_version: '1.7.2' }, env, undefined, 'cursor');
  runHook({ hook_event_name: 'SessionStart', session_id: 'cccc3333', cwd: root, model: 'bad model; rm -rf /' }, env);
  const store = new Store(resolveWorkspace(root).stateDir);
  try {
    const seen = store.seen(0).map((r) => `${r.source}:${r.kind}:${r.value}`).sort();
    assert.deepEqual(seen, ['claude:model:claude-opus-4-5', 'cursor:model:gpt-5', 'cursor:version:1.7.2']);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------- hub

async function startHub({ clock = null } = {}) {
  const dir = tmp('grapim-inv-hub-');
  const codes = new Map();
  const fetchImpl = async (url, init = {}) => {
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://github.com/login/oauth/access_token') {
      const { code } = JSON.parse(init.body);
      return codes.has(code) ? reply(200, { access_token: `gho_${code}`, token_type: 'bearer' }) : reply(200, { error: 'bad_verification_code' });
    }
    if (url === 'https://api.github.com/user') {
      const u = codes.get(String(init.headers?.Authorization || '').replace('Bearer gho_', ''));
      return u ? reply(200, u) : reply(401, {});
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const hub = await createHub({
    env: { HUB_URL: ORIGIN, HUB_SECRET: 'test-secret-that-is-long-enough-0123456789', HUB_DATA: dir, GITHUB_CLIENT_ID: 'gh-client', GITHUB_CLIENT_SECRET: 'gh-secret' },
    fetch: fetchImpl,
    billing: null,
    now: clock ? () => clock.t : undefined,
    log: () => {},
  });
  const addr = await hub.listen(0, '127.0.0.1');
  return { hub, base: `http://127.0.0.1:${addr.port}`, user: (code, p) => codes.set(code, p), close: () => hub.close() };
}

class Browser {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }
  async req(p, { method = 'GET', form = null } = {}) {
    const h = {};
    if (this.jar.size) h.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (method !== 'GET') h.Origin = ORIGIN;
    if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(this.base + p, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (/Max-Age=0/i.test(c)) this.jar.delete(pair.slice(0, i));
      else this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return { status: res.status, headers: res.headers, text: await res.text() };
  }
  async post(p, form = {}) {
    const csrf = JSON.parse((await this.req('/hub/api/me')).text).csrf;
    return this.req(p, { method: 'POST', form: { _csrf: csrf, ...form } });
  }
}

let nextId = 5000;
async function signIn(h, login) {
  const id = nextId++;
  h.user(`code-${id}`, { id, login, name: login, avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4` });
  const b = new Browser(h.base);
  const state = new URL((await b.req('/hub/auth/github')).headers.get('location')).searchParams.get('state');
  assert.equal((await b.req(`/hub/auth/callback?code=code-${id}&state=${state}`)).status, 303);
  return b;
}
async function createTeam(b, name) {
  const r = await b.post('/hub/teams', { name });
  return r.headers.get('location').match(/\/hub\/teams\/([^/?#]+)/)[1];
}
async function createToken(b, team, name = 'laptop') {
  const r = await b.post(`/hub/teams/${team}/tokens`, { name });
  return r.text.match(/value="(cmh_[A-Za-z0-9_-]+)"/)[1];
}
async function joinTeam(owner, member, team) {
  const r = await owner.post(`/hub/teams/${team}/invites`);
  const token = r.text.match(/\/hub\/invite\/([A-Za-z0-9_-]+)/)[1];
  assert.equal((await member.post('/hub/invite/accept', { token })).status, 303);
}

const REPO = sha1('inventory repo');
const INV = {
  agents: [
    { agent: 'claude', version: '2.0.31', models: ['claude-opus-4-5'] },
    { agent: 'cursor', version: '1.7.2', models: [] },
  ],
  mcp: [
    { agent: 'claude', scope: 'user', name: 'github', transport: 'stdio', command: 'npx', package: '@modelcontextprotocol/server-github', host: null },
    { agent: 'cursor', scope: 'project', name: 'linear', transport: 'http', command: null, package: null, host: 'mcp.linear.app' },
  ],
};
const post = (h, token, body) =>
  fetch(`${h.base}/hub/api/sync`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const batch = (machine, inventory) => ({ repo: { id: REPO, name: 'shop' }, machine, cursor: { changes: 0, events: 0, agents: 0 }, ...(inventory === undefined ? {} : { inventory }) });

test('ingest: the inventory is optional, checked strictly, and a bad one fails the batch before anything is written', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const b = await signIn(h, 'inv-owner');
  const team = await createTeam(b, 'Inv');
  const token = await createToken(b, team);

  // An older CLI: no inventory field at all.
  assert.equal((await post(h, token, batch('old-cli'))).status, 200);
  assert.equal(h.hub.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'h_inventory'").get().n === 0 || h.hub.db.prepare('SELECT COUNT(*) AS n FROM h_inventory').get().n === 0, true);

  const bad = [
    { agents: 'x' },
    { agents: [{ agent: 'copilot' }] },
    { agents: [{ agent: 'claude' }, { agent: 'claude' }] },
    { agents: [{ agent: 'claude', version: '1.0; drop table' }] },
    { agents: [{ agent: 'claude', models: ['m'.repeat(101)] }] },
    { agents: [{ agent: 'claude', models: Array.from({ length: 21 }, (_, i) => `m${i}`) }] },
    { mcp: [{ agent: 'claude', name: 'x', transport: 'websocket' }] },
    { mcp: [{ agent: 'claude', name: '<script>', transport: 'stdio', command: 'npx' }] },
    { mcp: [{ agent: 'claude', name: 'x', transport: 'stdio', command: '/usr/bin/npx' }] },
    { mcp: [{ agent: 'claude', name: 'x', transport: 'stdio', command: 'npx', package: 'https://evil.example/x' }] },
    { mcp: [{ agent: 'claude', name: 'x', transport: 'http', host: 'user:pw@host' }] },
    { mcp: [{ agent: 'claude', name: 'x', transport: 'http', host: 'h.example', command: 'npx' }] },
    { mcp: [{ agent: 'claude', name: 'x', transport: 'stdio', command: 'npx', host: 'h.example' }] },
    { mcp: [{ agent: 'claude', name: 'x', transport: 'stdio', scope: 'global' }] },
    { mcp: [{ agent: 'claude', name: 'x', transport: 'stdio', env: { K: 'v' }, command: 'n'.repeat(61) }] },
    [],
    'inventory',
  ];
  for (const inv of bad) {
    const r = await post(h, token, batch('laptop', inv));
    assert.ok([400, 413].includes(r.status), `accepted ${JSON.stringify(inv)}: ${r.status}`);
  }
  const many = { mcp: Array.from({ length: 201 }, (_, i) => ({ agent: 'claude', name: `s${i}`, transport: 'stdio', command: 'node' })) };
  assert.equal((await post(h, token, batch('laptop', many))).status, 413);
  assert.equal(h.hub.db.prepare("SELECT COUNT(*) AS n FROM machines WHERE machine = 'laptop'").get().n, 0, 'a rejected batch writes nothing');

  // Unknown keys (env, headers, args) are never stored, even if a client sent them.
  const withExtra = { ...INV, mcp: INV.mcp.map((s) => ({ ...s, env: { TOKEN: 'SECRET-x' }, headers: { A: 'SECRET-y' }, args: ['SECRET-z'] })) };
  const ok = await post(h, token, batch('laptop', withExtra));
  assert.equal(ok.status, 200, await ok.text());
  const rows = h.hub.db.prepare('SELECT * FROM h_inventory WHERE team_id = ?').all(team);
  assert.equal(rows.length, 5, '2 agents, 1 model, 2 servers');
  assert.doesNotMatch(JSON.stringify(rows), /SECRET/);
});

test('ingest: each report replaces the machine snapshot; first_seen is kept, removed items go', async (t) => {
  const clock = { t: Date.UTC(2026, 10, 1) };
  const h = await startHub({ clock });
  t.after(h.close);
  const b = await signIn(h, 'snap-owner');
  const team = await createTeam(b, 'Snap');
  const token = await createToken(b, team);
  assert.equal((await post(h, token, batch('mbp', INV))).status, 200);
  const first = clock.t;
  clock.t += 3 * 24 * 3600 * 1000;
  const next = { agents: [{ ...INV.agents[0], version: '2.0.40' }], mcp: [INV.mcp[0], { agent: 'claude', scope: 'user', name: 'sentry', transport: 'sse', command: null, package: null, host: 'mcp.sentry.dev' }] };
  assert.equal((await post(h, token, batch('mbp', next))).status, 200);
  const rows = h.hub.db.prepare("SELECT kind, name, agent, version, first_seen, last_seen FROM h_inventory WHERE team_id = ? AND machine = 'mbp' ORDER BY kind, agent, name").all(team);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.agent, r.name, r.version]),
    [
      ['agent', 'claude', null, '2.0.40'],
      ['mcp', 'claude', 'github', null],
      ['mcp', 'claude', 'sentry', null],
      ['model', 'claude', 'claude-opus-4-5', null],
    ],
    'cursor and its server are gone, sentry is added; the version is updated',
  );
  const github = rows.find((r) => r.name === 'github');
  assert.equal(github.first_seen, first);
  assert.equal(github.last_seen, clock.t);
  // A batch without an inventory leaves the snapshot as it is.
  assert.equal((await post(h, token, batch('mbp'))).status, 200);
  assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM h_inventory WHERE team_id = ?').get(team).n, 4);
});

test('ingest: rows keyed with NUL by older hubs are re-keyed in place; they keep first_seen and can be removed', () => {
  // Node 22's node:sqlite reads text back cut at the first NUL, so a snapshot
  // keyed "agent scope ..." never found its old rows to delete.
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE h_inventory (team_id TEXT NOT NULL, repo_id TEXT NOT NULL, machine TEXT NOT NULL, user_id INTEGER NOT NULL,
    kind TEXT NOT NULL, item TEXT NOT NULL, agent TEXT NOT NULL, name TEXT, version TEXT, transport TEXT, command TEXT, package TEXT,
    host TEXT, scope TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (team_id, repo_id, machine, kind, item))`);
  const put = db.prepare(`INSERT INTO h_inventory (team_id, repo_id, machine, user_id, kind, item, agent, name, version, transport, command, package, host, scope, first_seen, last_seen)
    VALUES ('T', 'R', 'mbp', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 100, 100)`);
  put.run('agent', 'claude', 'claude', null, '2.0.31', null, null, null, null, null);
  put.run('model', 'claude claude-opus-4-5', 'claude', 'claude-opus-4-5', null, null, null, null, null, null);
  put.run('mcp', ['claude', 'user', 'github', 'stdio', 'npx', '@modelcontextprotocol/server-github', ''].join(' '), 'claude', 'github', null, 'stdio', 'npx', '@modelcontextprotocol/server-github', null, 'user');
  put.run('mcp', ['cursor', 'project', 'linear', 'http', '', '', 'mcp.linear.app'].join(' '), 'cursor', 'linear', null, 'http', null, null, 'mcp.linear.app', 'project');
  const inv = parseInventory({ agents: [INV.agents[0]], mcp: [INV.mcp[0]] });
  assert.equal(storeInventory(db, 'T', 'R', 'mbp', 1, inv, 200), 3);
  const rows = db.prepare('SELECT kind, name, item, first_seen, last_seen FROM h_inventory ORDER BY kind, name').all();
  assert.deepEqual(
    rows.map((r) => [r.kind, r.name, r.first_seen, r.last_seen]),
    [
      ['agent', null, 100, 200],
      ['mcp', 'github', 100, 200],
      ['model', 'claude-opus-4-5', 100, 200],
    ],
    'linear is gone; what stayed keeps its first_seen',
  );
  for (const r of rows) assert.ok(!r.item.includes(' '), `no NUL left in ${JSON.stringify(r.item)}`);
});

test('the Agents page: members see their team, another team sees nothing of it, CSP clean, empty state, new this week', async (t) => {
  const clock = { t: Date.UTC(2026, 10, 1) };
  const h = await startHub({ clock });
  t.after(h.close);
  const owner = await signIn(h, 'page-owner');
  const member = await signIn(h, 'page-member');
  const outsider = await signIn(h, 'page-outsider');
  const team = await createTeam(owner, 'Page Team');
  const other = await createTeam(outsider, 'Other Team');
  await joinTeam(owner, member, team);

  // Empty state first.
  const empty = await member.req(`/hub/teams/${team}/agents`);
  assert.equal(empty.status, 200);
  assert.match(empty.text, /No agents reported yet/);
  assert.match(empty.text, /grapim sync/);
  assert.match(empty.text, /href="\/docs\/inventory"/);

  const t1 = await createToken(owner, team, 'owner-mbp');
  const t2 = await createToken(member, team, 'member-xps');
  const tOut = await createToken(outsider, other, 'out');
  assert.equal((await post(h, t1, batch('owner-mbp', INV))).status, 200);
  clock.t += 2 * 24 * 3600 * 1000;
  const fresh = { agents: [{ agent: 'claude', version: '2.0.40', models: ['claude-sonnet-4-5'] }], mcp: [INV.mcp[0], { agent: 'claude', scope: 'user', name: 'brand-new-srv', transport: 'http', command: null, package: null, host: 'new.example.com' }] };
  assert.equal((await post(h, t2, batch('member-xps', fresh))).status, 200);
  assert.equal((await post(h, tOut, batch('out-box', { agents: [{ agent: 'gemini', version: '0.9.0', models: [] }], mcp: [{ agent: 'gemini', scope: 'user', name: 'outsider-only-srv', transport: 'sse', host: 'out.example.com' }] }))).status, 200);

  const page = await member.req(`/hub/teams/${team}/agents`);
  assert.equal(page.status, 200);
  const body = page.text;
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(body), 'no inline script');
  assert.ok(!/\sstyle\s*=/i.test(body), 'no style attribute');
  assert.match(body, /aria-current="page"[^>]*>.*Agents/s);
  assert.match(body, /href="\/hub\/teams\/[^"]+\/agents" data-g="i"/);
  assert.match(body, /Claude Code/);
  assert.match(body, /2\.0\.40/);
  assert.match(body, /2\.0\.31/);
  assert.match(body, /claude-sonnet-4-5/);
  assert.match(body, /@modelcontextprotocol\/server-github/);
  assert.match(body, /mcp\.linear\.app/);
  assert.match(body, /<dt>Computers<\/dt><dd class="num">2<\/dd>/);
  assert.match(body, /<dt>Tools and services<\/dt><dd class="num">3/);
  // Real marks beside the names: Claude Code's, and GitHub's for the github server.
  assert.match(body, /<svg class="brand-mark"[^>]*aria-hidden="true"[^>]*><path fill="currentColor" d="m4\.7144[^"]*"\/><\/svg><span class="agent-name">Claude Code/);
  assert.match(body, /<svg class="brand-mark"[^>]*><path fill="currentColor" d="M12 \.297[^"]*"\/><\/svg><span class="strong">github/);
  assert.match(body, /brand-new-srv<\/span><span class="badge badge-pending">New this week/);
  assert.doesNotMatch(body, /github<\/span><span class="badge badge-pending">/, 'the first report is not "new"');
  assert.match(body, /page-member/);
  // Team scoping: nothing of the other team, and the other team cannot open this page.
  assert.doesNotMatch(body, /outsider-only-srv|out\.example\.com|Gemini CLI/);
  assert.equal((await outsider.req(`/hub/teams/${team}/agents`)).status, 404);
  const theirs = await outsider.req(`/hub/teams/${other}/agents`);
  assert.equal(theirs.status, 200);
  assert.match(theirs.text, /outsider-only-srv/);
  assert.doesNotMatch(theirs.text, /brand-new-srv|mcp\.linear\.app/);
  // Signed out: to sign in, not the page.
  assert.notEqual((await new Browser(h.base).req(`/hub/teams/${team}/agents`)).status, 200);
});

function gitRepo() {
  const root = tmp('grapim-inv-git-');
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return root;
}

test('grapim sync sends the inventory to the hub once, then only when it changes', async (t) => {
  const h = await startHub();
  t.after(h.close);
  const b = await signIn(h, 'sync-owner');
  const team = await createTeam(b, 'Sync');
  const token = await createToken(b, team);
  const { home } = fakeMachine();
  const root = gitRepo();
  const ws = resolveWorkspace(root);
  const store = new Store(ws.stateDir);
  t.after(() => store.close());
  const sent = [];
  const spy = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return fetch(url, init);
  };
  const r1 = await syncOnce({ ws, store, hubUrl: h.base, token, fetch: spy, machine: 'inv-laptop', home });
  assert.ok(r1.inventory && r1.inventory.mcp > 5, JSON.stringify(r1));
  assert.ok(sent[0].inventory);
  for (const s of SECRETS) assert.ok(!JSON.stringify(sent).includes(s), `"${s}" was sent to the hub`);
  const r2 = await syncOnce({ ws, store, hubUrl: h.base, token, fetch: spy, machine: 'inv-laptop', home });
  assert.equal(r2.inventory, undefined, 'unchanged and recent: not sent again');
  assert.equal(sent.at(-1).inventory, undefined);
  const page = await b.req(`/hub/teams/${team}/agents`);
  assert.match(page.text, /figma-mcp/);
  assert.match(page.text, /remote\.example\.org/);
  assert.doesNotMatch(page.text, /SECRET|alexuser/);
  // Off switch.
  const env = process.env.GRAPIM_NO_INVENTORY;
  process.env.GRAPIM_NO_INVENTORY = '1';
  try {
    fs.writeFileSync(path.join(ws.stateDir, 'hub-sync.json'), '{}');
    await syncOnce({ ws, store, hubUrl: h.base, token, fetch: spy, machine: 'inv-laptop', home });
    assert.equal(sent.at(-1).inventory, undefined);
  } finally {
    if (env === undefined) delete process.env.GRAPIM_NO_INVENTORY;
    else process.env.GRAPIM_NO_INVENTORY = env;
  }
});
