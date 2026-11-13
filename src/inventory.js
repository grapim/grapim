// The agent inventory `grapim sync` sends with a batch: which coding agents
// are on this machine, their versions, the models they ran with, and the MCP
// servers they are configured to start or call (docs: src/hub/docs/inventory.md).
//
// Discovery only, and deliberately thin. For each MCP server it keeps the
// name, the transport, and either the command's basename (plus the package,
// when it is the plain first argument of npx/uvx/bunx) or the URL's host.
// Never env values, headers, other arguments, tokens, or paths: a config file
// holds secrets in all of those, and they never leave this module.
//
// Every read is best effort: a missing, unreadable or invalid file is the
// same as no file. Nothing here spawns a process.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENTS } from './agents.js';

const MAX_FILE = 32 * 1024 * 1024; // ~/.claude.json grows with project history
const MAX_SERVERS = 200;
const MAX_MODELS = 20;
const SEEN_DAYS = 30;

// What the hub accepts (src/hub/inventory.js checks the same).
export const NAME_RE = /^[A-Za-z0-9._@:/ -]{1,100}$/;
export const COMMAND_RE = /^[A-Za-z0-9._+-]{1,60}$/;
export const PACKAGE_RE = /^(@[A-Za-z0-9._-]{1,100}\/)?[A-Za-z0-9._-]{1,100}$/;
export const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
export const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;
export const MODEL_RE = /^[A-Za-z0-9._:/@[\]-]{1,100}$/;

const ok = (re, v) => (typeof v === 'string' && re.test(v) ? v : null);

function readText(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

function readJson(file) {
  const raw = readText(file);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// ---- TOML, only as much as ~/.codex/config.toml needs ----
// Top-level `model`, and per [mcp_servers.<name>] table its `command`, `args`
// and `url`. Sub-tables ([mcp_servers.<name>.env]) and every other key are
// skipped without being parsed. Returns { model, servers: { name: {...} } }.

function tomlString(s, i) {
  const q = s[i];
  let out = '';
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === q) return [out, i + 1];
    if (q === '"' && c === '\\') {
      const n = s[i + 1];
      out += { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }[n] ?? n ?? '';
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return [null, i];
}

// A value at s[i]: a string, or an array of strings. Anything else: undefined.
function tomlValue(s, i) {
  while (s[i] === ' ' || s[i] === '\t') i++;
  if (s[i] === '"' || s[i] === "'") return tomlString(s, i)[0] ?? undefined;
  if (s[i] !== '[') return undefined;
  const out = [];
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === ']') return out;
    if (c === '"' || c === "'") {
      const [v, j] = tomlString(s, i);
      if (v === null) return undefined;
      out.push(v);
      i = j;
      continue;
    }
    if (c === '#') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (/[\s,]/.test(c)) {
      i++;
      continue;
    }
    return undefined; // a non-string element: not ours to read
  }
  return undefined;
}

// [mcp_servers.name], [mcp_servers."a.b"] -> ['mcp_servers', 'name'] ...
function tomlKeyPath(s) {
  const parts = [];
  let i = 0;
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] === '"' || s[i] === "'") {
      const [v, j] = tomlString(s, i);
      if (v === null) return null;
      parts.push(v);
      i = j;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) return null;
      parts.push(m[0]);
      i += m[0].length;
    }
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (i >= s.length) break;
    if (s[i] !== '.') return null;
    i++;
  }
  return parts;
}

export function parseCodexToml(text) {
  const out = { model: null, servers: {} };
  if (typeof text !== 'string') return out;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let table = []; // the current [table] path
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const m = /^\[\[?\s*(.+?)\s*\]\]?\s*(#.*)?$/.exec(line);
      table = (m && tomlKeyPath(m[1])) || ['?'];
      continue;
    }
    const m = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rest] = m;
    const top = table.length === 0;
    const server = table.length === 2 && table[0] === 'mcp_servers' ? table[1] : null;
    if (!(top && key === 'model') && !(server && ['command', 'args', 'url'].includes(key))) continue;
    // An array may run over several lines: take lines until it closes.
    let src = rest;
    if (rest.trimStart().startsWith('[')) {
      let k = n;
      while (tomlValue(src, 0) === undefined && k + 1 < lines.length && k - n < 200) src += '\n' + lines[++k];
      n = k;
    }
    const v = tomlValue(src, 0);
    if (v === undefined) continue;
    if (top) out.model = typeof v === 'string' ? v : null;
    else {
      if (!Object.hasOwn(out.servers, server)) out.servers[server] = {};
      out.servers[server][key] = v;
    }
  }
  return out;
}

// ---- One MCP server entry, reduced to what may leave the machine ----

const RUNNERS = {
  npx: new Set(['-p', '--package', '-c', '--call', '--registry', '--cache', '--userconfig']),
  bunx: new Set(['-p', '--package', '--bun']),
  pnpx: new Set(['-p', '--package']),
  uvx: new Set(['--from', '--with', '--with-editable', '--with-requirements', '-w', '--python', '-p', '--index', '--index-url', '--extra-index-url', '--default-index', '-i', '--find-links', '-f', '--constraints', '-c', '--overrides', '--cache-dir', '--directory', '--project', '--config-file']),
};
const SHELLS = new Set(['cmd', 'cmd.exe']);

// "C:\\Program Files\\nodejs\\npx.cmd" -> "npx"; "/usr/bin/node" -> "node".
function commandBase(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  const first = cmd.trim().split(/\s+/)[0];
  let base = first.split(/[\\/]/).pop();
  base = base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
  return ok(COMMAND_RE, base);
}

// The package an npx/uvx/bunx line runs: the first argument that is not a
// flag (nor a flag's value), without its version. null when that is not a
// plain package name (a path, a URL, a git spec): it is not sent at all.
function runnerPackage(runner, args) {
  const takesValue = RUNNERS[runner];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') return null;
    if (a === '--') continue;
    if (a.startsWith('-')) {
      if (!a.includes('=') && takesValue.has(a)) i++;
      continue;
    }
    // name@1.2.3, @scope/name@latest, name==1.0, name>=1
    const at = a.startsWith('@') ? a.indexOf('@', 1) : a.indexOf('@');
    let name = at > 0 ? a.slice(0, at) : a;
    name = name.split(/[=<>~!\[;]/)[0];
    return ok(PACKAGE_RE, name);
  }
  return null;
}

// The host of a URL, never its path, query, credentials or port.
function urlHost(u) {
  try {
    const url = new URL(String(u));
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return null;
    return ok(HOST_RE, url.hostname.toLowerCase()); // an IPv6 literal does not match: no host is sent
  } catch {
    return null;
  }
}

// One entry of any agent's MCP config -> { name, transport, command, package, host } or null.
// urlKind: what a bare `url` means in this agent's config ('http' or 'sse').
export function describeServer(name, cfg, { urlKind = 'http' } = {}) {
  if (!ok(NAME_RE, name) || !cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  const type = typeof cfg.type === 'string' ? cfg.type.toLowerCase() : typeof cfg.transport === 'string' ? cfg.transport.toLowerCase() : null;
  const url = cfg.httpUrl ?? cfg.serverUrl ?? cfg.url;
  if (typeof cfg.command === 'string' && type !== 'http' && type !== 'sse' && type !== 'streamable-http') {
    let command = commandBase(cfg.command);
    let args = Array.isArray(cfg.args) ? cfg.args : [];
    // Windows: "cmd /c npx -y pkg" runs npx.
    if (command && SHELLS.has(command.toLowerCase()) && /^\/c$/i.test(String(args[0] ?? ''))) {
      command = commandBase(args[1]);
      args = args.slice(2);
    }
    const runner = command?.toLowerCase();
    return { name, transport: 'stdio', command, package: runner && RUNNERS[runner] ? runnerPackage(runner, args) : null, host: null };
  }
  if (typeof url === 'string') {
    let transport = type === 'sse' ? 'sse' : type === 'http' || type === 'streamable-http' || type === 'streamablehttp' ? 'http' : null;
    if (!transport) transport = cfg.httpUrl ? 'http' : urlKind;
    return { name, transport, command: null, package: null, host: urlHost(url) };
  }
  return null;
}

function serversOf(obj, agent, scope, opts) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const out = [];
  for (const [name, cfg] of Object.entries(obj)) {
    const s = describeServer(name, cfg, opts);
    if (s) out.push({ agent, scope, ...s });
  }
  return out;
}

// ---- Versions, from files only ----

const semverKey = (v) => v.split(/[.+-]/).map((p) => (/^\d+$/.test(p) ? p.padStart(8, '0') : p)).join('.');
const newest = (list) => list.filter((v) => VERSION_RE.test(v) && /^\d/.test(v)).sort((a, b) => (semverKey(a) < semverKey(b) ? 1 : -1))[0] ?? null;

function npmVersion(pkg, env) {
  const dirs = [path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules'), path.join(path.dirname(process.execPath), 'node_modules')];
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm', 'node_modules'));
  if (env.npm_config_prefix) dirs.push(path.join(env.npm_config_prefix, 'lib', 'node_modules'), path.join(env.npm_config_prefix, 'node_modules'));
  for (const d of dirs) {
    const v = readJson(path.join(d, ...pkg.split('/'), 'package.json'))?.version;
    if (ok(VERSION_RE, v)) return v;
  }
  return null;
}

// Claude Code's native installer: ~/.local/bin/claude links to
// ~/.local/share/claude/versions/<version>.
function claudeNativeVersion(home) {
  for (const bin of ['claude', 'claude.exe']) {
    try {
      const v = path.basename(fs.readlinkSync(path.join(home, '.local', 'bin', bin))).replace(/\.exe$/i, '');
      if (ok(VERSION_RE, v) && /^\d/.test(v)) return v;
    } catch {}
  }
  try {
    return newest(fs.readdirSync(path.join(home, '.local', 'share', 'claude', 'versions')).map((n) => n.replace(/\.exe$/i, '')));
  } catch {
    return null;
  }
}

const NPM = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex', gemini: '@google/gemini-cli' };

// ---- The whole inventory ----

// { agents: [{ agent, version, models }], mcp: [{ agent, scope, name, transport, command, package, host }] }
// root: the repo being synced (its project-level configs count too).
// seen: [{ source, kind, value }] from the hooks (Store.seen), newest first.
export function collectInventory({ root = null, home = os.homedir(), env = process.env, seen = [] } = {}) {
  const has = (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  };
  const mcp = [];
  const models = Object.fromEntries(AGENTS.map((a) => [a, []]));
  const versions = Object.fromEntries(AGENTS.map((a) => [a, null]));
  const addModel = (a, m) => {
    if (ok(MODEL_RE, m) && !models[a].includes(m) && models[a].length < MAX_MODELS) models[a].push(m);
  };
  for (const s of seen) {
    if (!models[s.source]) continue;
    if (s.kind === 'model') addModel(s.source, s.value);
    if (s.kind === 'version' && !versions[s.source] && ok(VERSION_RE, s.value)) versions[s.source] = s.value;
  }

  // Claude Code: ~/.claude.json (user scope, and per-project entries keyed
  // by a local path we never send), the repo's .mcp.json, ~/.claude/settings.json's model.
  const claudeJson = home ? readJson(path.join(home, '.claude.json')) : null;
  mcp.push(...serversOf(claudeJson?.mcpServers, 'claude', 'user'));
  if (claudeJson?.projects && typeof claudeJson.projects === 'object') {
    for (const p of Object.values(claudeJson.projects)) mcp.push(...serversOf(p?.mcpServers, 'claude', 'project'));
  }
  if (root) mcp.push(...serversOf(readJson(path.join(root, '.mcp.json'))?.mcpServers, 'claude', 'project'));
  if (home) addModel('claude', readJson(path.join(home, '.claude', 'settings.json'))?.model);

  // Cursor: ~/.cursor/mcp.json and the repo's .cursor/mcp.json.
  if (home) mcp.push(...serversOf(readJson(path.join(home, '.cursor', 'mcp.json'))?.mcpServers, 'cursor', 'user'));
  if (root) mcp.push(...serversOf(readJson(path.join(root, '.cursor', 'mcp.json'))?.mcpServers, 'cursor', 'project'));

  // Codex: ~/.codex/config.toml (CODEX_HOME moves it).
  const codexHome = env.CODEX_HOME || (home ? path.join(home, '.codex') : null);
  if (codexHome) {
    const toml = parseCodexToml(readText(path.join(codexHome, 'config.toml')));
    mcp.push(...serversOf(toml.servers, 'codex', 'user'));
    addModel('codex', toml.model);
  }

  // Gemini CLI: ~/.gemini/settings.json and the repo's .gemini/settings.json.
  // A bare `url` there is SSE; `httpUrl` is streamable HTTP.
  for (const [dir, scope] of [[home, 'user'], [root, 'project']]) {
    if (!dir) continue;
    const g = readJson(path.join(dir, '.gemini', 'settings.json'));
    mcp.push(...serversOf(g?.mcpServers, 'gemini', scope, { urlKind: 'sse' }));
    addModel('gemini', typeof g?.model === 'string' ? g.model : g?.model?.name);
  }

  if (home) {
    if (!versions.claude) versions.claude = claudeNativeVersion(home);
  }
  for (const a of ['claude', 'codex', 'gemini']) if (!versions[a]) versions[a] = npmVersion(NPM[a], env);

  // An agent is in the inventory when it leaves a trace on this machine or
  // in this repo, or the hooks saw it.
  const traces = { claude: ['.claude', '.claude.json'], codex: ['.codex'], cursor: ['.cursor'], gemini: ['.gemini'] };
  const repoTraces = { claude: ['.claude', '.mcp.json'], codex: ['.codex'], cursor: ['.cursor'], gemini: ['.gemini'] };
  const agents = AGENTS.filter(
    (a) =>
      (home && traces[a].some((n) => has(path.join(home, n)))) ||
      (root && repoTraces[a].some((n) => has(path.join(root, n)))) ||
      seen.some((s) => s.source === a) ||
      mcp.some((s) => s.agent === a),
  ).map((a) => ({ agent: a, version: versions[a], models: models[a] }));

  // One row per (agent, scope, name, transport, command, package, host).
  const keyOf = (s) => [s.agent, s.scope, s.name, s.transport, s.command, s.package, s.host].join('\u0000');
  const unique = [...new Map(mcp.map((s) => [keyOf(s), s])).values()].slice(0, MAX_SERVERS);
  return { agents, mcp: unique };
}

export const inventoryHash = (inv) => crypto.createHash('sha256').update(JSON.stringify(inv)).digest('hex').slice(0, 32);

export const SEEN_SINCE = () => Date.now() - SEEN_DAYS * 24 * 3600 * 1000;
