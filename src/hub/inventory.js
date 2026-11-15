// The agent inventory (docs: src/hub/docs/inventory.md): which coding agents,
// versions, models and MCP servers each machine reports with `grapim sync`.
//
// A batch may carry `inventory` (src/inventory.js builds it). It is checked
// strictly here, then stored per (team, repo, machine) as a snapshot that
// replaces the previous one: items still there keep their first_seen, items
// gone are deleted. Older CLIs send no inventory, and nothing changes.
//
// Every query is scoped by team id. The page aggregates across repos: one
// machine is one (user, machine name) pair.

import { badRequest, HttpError, sendHtml } from './http.js';
import { inventoryPage } from './pages/inventory.js';
import { COMMAND_RE, HOST_RE, MODEL_RE, NAME_RE, PACKAGE_RE, VERSION_RE } from '../inventory.js';

const AGENTS = ['claude', 'codex', 'cursor', 'gemini'];
const TRANSPORTS = ['stdio', 'http', 'sse'];
const SCOPES = ['user', 'project'];
const MAX_AGENTS = AGENTS.length;
const MAX_MODELS = 20;
const MAX_SERVERS = 200;
const WEEK = 7 * 24 * 3600 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS h_inventory (
  team_id    TEXT NOT NULL,
  repo_id    TEXT NOT NULL,
  machine    TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('agent', 'model', 'mcp')),
  item       TEXT NOT NULL,              -- the item's identity within its kind
  agent      TEXT NOT NULL,
  name       TEXT,                       -- model or MCP server name
  version    TEXT,                       -- agent rows
  transport  TEXT,                       -- mcp rows: stdio | http | sse
  command    TEXT,                       -- stdio: the command's basename
  package    TEXT,                       -- stdio via npx/uvx/bunx: the package name
  host       TEXT,                       -- http/sse: the URL's host
  scope      TEXT,                       -- user | project
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (team_id, repo_id, machine, kind, item)
);
CREATE INDEX IF NOT EXISTS h_inventory_team ON h_inventory(team_id, kind);
`;

// An item's identity: the agent name for agent rows, a JSON array for the
// rest. Never join with "\u0000": node:sqlite on Node 22 (the hub's Docker
// image) stores such text whole but reads it back cut at the NUL, so the
// snapshot could not find, and so never deleted, the rows it replaced.
const modelItem = (agent, name) => JSON.stringify([agent, name]);
const mcpItem = (s) => JSON.stringify([s.agent, s.scope, s.name, s.transport, s.command ?? '', s.package ?? '', s.host ?? '']);

// The table is made on first use, so the hub's schema file stays untouched.
const ready = new WeakSet();
function ensure(db) {
  if (ready.has(db)) return;
  db.exec(SCHEMA);
  // Rows from before the JSON keys were joined with NUL. Re-key them from
  // their columns in place, so they keep their first_seen. The blob cast is
  // needed because SQLite's text functions also stop at a NUL.
  const legacy = db.prepare("SELECT rowid AS id, kind, agent, name, scope, transport, command, package, host FROM h_inventory WHERE kind <> 'agent' AND instr(CAST(item AS BLOB), x'00') > 0").all();
  if (legacy.length) {
    const rekey = db.prepare('UPDATE OR IGNORE h_inventory SET item = ? WHERE rowid = ?');
    for (const r of legacy) rekey.run(r.kind === 'model' ? modelItem(r.agent, r.name) : mcpItem(r), r.id);
  }
  ready.add(db);
}

// ---- Validation ----

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function field(v, name, re, { optional = true } = {}) {
  if (v === null || v === undefined) {
    if (optional) return null;
    throw badRequest(`${name} is required.`);
  }
  if (typeof v !== 'string' || !re.test(v)) throw badRequest(`${name} has characters or a length the hub does not accept.`);
  return v;
}

function oneOf(v, name, allowed) {
  if (!allowed.includes(v)) throw badRequest(`${name} must be one of ${allowed.join(', ')}.`);
  return v;
}

function arr(v, name, max) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw badRequest(`${name} must be an array.`);
  if (v.length > max) throw new HttpError(413, 'too_large', `At most ${max} ${name} per inventory.`);
  return v;
}

// body.inventory -> { agents, mcp } or null (absent). Throws HttpError.
export function parseInventory(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isObj(raw)) throw badRequest('inventory must be an object.');
  const seenAgents = new Set();
  const agents = arr(raw.agents, 'inventory.agents', MAX_AGENTS).map((a, i) => {
    const at = `inventory.agents[${i}]`;
    if (!isObj(a)) throw badRequest(`${at} must be an object.`);
    const agent = oneOf(a.agent, `${at}.agent`, AGENTS);
    if (seenAgents.has(agent)) throw badRequest(`${at}.agent is listed twice.`);
    seenAgents.add(agent);
    const models = [...new Set(arr(a.models, `${at}.models`, MAX_MODELS).map((m, j) => field(m, `${at}.models[${j}]`, MODEL_RE, { optional: false })))];
    return { agent, version: field(a.version, `${at}.version`, VERSION_RE), models };
  });
  const mcp = arr(raw.mcp, 'inventory.mcp', MAX_SERVERS).map((s, i) => {
    const at = `inventory.mcp[${i}]`;
    if (!isObj(s)) throw badRequest(`${at} must be an object.`);
    const transport = oneOf(s.transport, `${at}.transport`, TRANSPORTS);
    const stdio = transport === 'stdio';
    const out = {
      agent: oneOf(s.agent, `${at}.agent`, AGENTS),
      scope: oneOf(s.scope ?? 'user', `${at}.scope`, SCOPES),
      name: field(s.name, `${at}.name`, NAME_RE, { optional: false }),
      transport,
      command: field(s.command, `${at}.command`, COMMAND_RE),
      package: field(s.package, `${at}.package`, PACKAGE_RE),
      host: field(s.host, `${at}.host`, HOST_RE),
    };
    if (stdio && out.host) throw badRequest(`${at}: a stdio server has no host.`);
    if (!stdio && (out.command || out.package)) throw badRequest(`${at}: an ${transport} server has no command.`);
    return out;
  });
  return { agents, mcp };
}

// ---- Storage ----

// Replaces the snapshot of (team, repo, machine). Runs inside the ingest
// transaction. Returns the number of items stored.
export function storeInventory(db, teamId, repoId, machine, userId, inv, now) {
  ensure(db);
  const rows = [];
  for (const a of inv.agents) {
    rows.push({ kind: 'agent', item: a.agent, agent: a.agent, version: a.version });
    for (const m of a.models) rows.push({ kind: 'model', item: modelItem(a.agent, m), agent: a.agent, name: m });
  }
  for (const s of inv.mcp) rows.push({ kind: 'mcp', item: mcpItem(s), ...s });
  const keep = new Set(rows.map((r) => JSON.stringify([r.kind, r.item])));
  // By rowid, so a row goes even if its item would not read back exactly.
  const del = db.prepare('DELETE FROM h_inventory WHERE rowid = ?');
  for (const old of db.prepare('SELECT rowid AS id, kind, item FROM h_inventory WHERE team_id = ? AND repo_id = ? AND machine = ?').all(teamId, repoId, machine)) {
    if (!keep.has(JSON.stringify([old.kind, old.item]))) del.run(old.id);
  }
  const put = db.prepare(
    `INSERT INTO h_inventory (team_id, repo_id, machine, user_id, kind, item, agent, name, version, transport, command, package, host, scope, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(team_id, repo_id, machine, kind, item) DO UPDATE SET
       user_id = excluded.user_id, version = excluded.version, last_seen = excluded.last_seen`,
  );
  for (const r of rows) {
    put.run(teamId, repoId, machine, userId, r.kind, r.item, r.agent, r.name ?? null, r.version ?? null, r.transport ?? null, r.command ?? null, r.package ?? null, r.host ?? null, r.scope ?? null, now, now);
  }
  return rows.length;
}

// ---- Reading ----

const MACHINE = "i.user_id || ':' || i.machine";

// What the Agents page shows, for one team only.
export function inventoryView(db, teamId, now = Date.now()) {
  ensure(db);
  const totals = db
    .prepare(
      `SELECT COUNT(DISTINCT ${MACHINE}) AS machines, MIN(first_seen) AS since, COUNT(DISTINCT i.user_id) AS people
       FROM h_inventory i WHERE i.team_id = ?`,
    )
    .get(teamId);
  const loginsOf = (ids) => {
    const get = db.prepare('SELECT login FROM users WHERE id = ?');
    return [...new Set(String(ids ?? '').split(',').filter(Boolean))].map((id) => get.get(Number(id))?.login).filter(Boolean).sort();
  };
  const agents = db
    .prepare(
      `SELECT i.agent, COUNT(DISTINCT ${MACHINE}) AS machines, GROUP_CONCAT(DISTINCT i.user_id) AS users,
              GROUP_CONCAT(DISTINCT i.version) AS versions, MIN(i.first_seen) AS first_seen, MAX(i.last_seen) AS last_seen
       FROM h_inventory i WHERE i.team_id = ? AND i.kind = 'agent' GROUP BY i.agent ORDER BY machines DESC, i.agent`,
    )
    .all(teamId);
  const models = db
    .prepare(
      `SELECT i.agent, i.name, COUNT(DISTINCT ${MACHINE}) AS machines FROM h_inventory i
       WHERE i.team_id = ? AND i.kind = 'model' GROUP BY i.agent, i.name ORDER BY machines DESC, i.name`,
    )
    .all(teamId);
  const servers = db
    .prepare(
      `SELECT i.name, i.transport, i.command, i.package, i.host, GROUP_CONCAT(DISTINCT i.agent) AS agents, GROUP_CONCAT(DISTINCT i.scope) AS scopes,
              COUNT(DISTINCT ${MACHINE}) AS machines, GROUP_CONCAT(DISTINCT i.user_id) AS users,
              MIN(i.first_seen) AS first_seen, MAX(i.last_seen) AS last_seen
       FROM h_inventory i WHERE i.team_id = ? AND i.kind = 'mcp'
       GROUP BY i.name, i.transport, COALESCE(i.command, ''), COALESCE(i.package, ''), COALESCE(i.host, '')
       ORDER BY first_seen DESC, i.name`,
    )
    .all(teamId);
  // "New" means new to this team: not the items of its first inventory, which are all new.
  const since = totals.since;
  const isNew = (first) => !!since && first >= now - WEEK && first > since + 24 * 3600 * 1000;
  const semver = (v) => v.split(/[.+-]/).map((p) => (/^\d+$/.test(p) ? p.padStart(8, '0') : p)).join('.');
  return {
    machines: totals.machines,
    people: totals.people,
    since,
    agents: agents.map((a) => ({
      agent: a.agent,
      versions: String(a.versions ?? '').split(',').filter(Boolean).sort((x, y) => (semver(x) < semver(y) ? 1 : -1)),
      models: models.filter((m) => m.agent === a.agent).map((m) => ({ name: m.name, machines: m.machines })),
      machines: a.machines,
      people: loginsOf(a.users),
      last_seen: a.last_seen,
    })),
    servers: servers.map((s) => ({
      name: s.name,
      transport: s.transport,
      command: s.command,
      package: s.package,
      host: s.host,
      agents: String(s.agents ?? '').split(',').filter(Boolean).sort(),
      scopes: String(s.scopes ?? '').split(',').filter(Boolean).sort(),
      machines: s.machines,
      people: loginsOf(s.users),
      first_seen: s.first_seen,
      last_seen: s.last_seen,
      isNew: isNew(s.first_seen),
    })),
  };
}

// GET /hub/teams/:team/agents: every member can see it.
export function inventoryRoutes(router, hub) {
  router.get(
    '/hub/teams/:team/agents',
    (ctx) => {
      hub.limit?.(ctx, 'read', ctx.member.userId);
      const team = hub.teams.get(ctx.member.team.id) ?? ctx.member.team;
      const view = inventoryView(hub.db, team.id, hub.now());
      sendHtml(ctx.res, 200, inventoryPage({ user: ctx.session.user, csrf: ctx.session.csrf, team, view, origin: hub.config.origin, now: hub.now() }));
    },
    { auth: 'session', team: true },
  );
}
