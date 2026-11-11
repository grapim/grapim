// A minimal MCP server, no dependencies. For agents without Claude Code hooks
// (Codex, Cursor, others): they call claim_files before editing and
// release_files when done.
//
// The same calls feed the attribution ledger: claim_files snapshots each file
// as it is, release_files (or disconnecting) records what changed since.
// One session is one run; a new intent starts a new turn.
//
// The tools and the JSON-RPC handling live here once. startMcp speaks them
// over stdio (newline-delimited JSON-RPC 2.0); src/server/mcp-http.js speaks
// them over HTTP and adds the workspace tools (read_file, write_file,
// list_dir, delete_file), which need a workspace from src/server/fs.js.

import path from 'node:path';
import readline from 'node:readline';
import { Store } from './store.js';
import { fileKey, resolveWorkspace } from './workspace.js';
import { ago, blameText, logText, runsText, statusText, who } from './format.js';
import { blame, inTree } from './attribution.js';
import { beginEdit, failOpen, finishRun } from './ledger.js';
import { pendingPairs } from './server/offload.js';
import { pathsByRun, scopedEvents } from './server/queries.js';

export const VERSION = '0.1.0';

export const TOOLS = [
  {
    name: 'claim_files',
    description:
      'Claim files before you edit them, so other agents working in this repo do not edit them at the same time. Call this before editing. If another agent holds a file, nothing is claimed and you get who holds it and why: work on other files instead.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Files you are about to edit, relative to the repo root or absolute.' },
        intent: { type: 'string', description: 'One line on what you are changing and why, e.g. "add /billing route".' },
        ttl_minutes: { type: 'number', description: 'How long to hold the claim. Default 30.' },
      },
      required: ['paths'],
    },
  },
  {
    name: 'release_files',
    description: 'Release files you claimed once you are done with them. With no paths, releases everything you hold.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } } },
  },
  {
    name: 'who_is_editing',
    description: 'Show which agents are active in this repo, what each is working on, and which files each has claimed.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_intent',
    description: 'Tell other agents what you are working on now, in one line.',
    inputSchema: { type: 'object', properties: { intent: { type: 'string' } }, required: ['intent'] },
  },
  {
    name: 'recent_activity',
    description: 'Recent claims, edits, releases and blocks by all agents in this repo.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  {
    name: 'list_runs',
    description:
      'List agent runs (one per session) in this repo: what each worked on, how many turns, files and lines it changed, and whether its changes are still in the working tree.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'who_wrote',
    description:
      'For one file, show which agent run and turn wrote each line that differs from HEAD. Lines no agent recorded (a shell command, a human) show as "outside agents".',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'The file, relative to the repo root or absolute.' } },
      required: ['path'],
    },
  },
];

const repoPath = { type: 'string', description: 'Relative to the repo root, with forward slashes, e.g. src/app.js.' };

export const WORKSPACE_TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file in the repo as UTF-8 text.',
    inputSchema: { type: 'object', properties: { path: repoPath }, required: ['path'] },
  },
  {
    name: 'write_file',
    description:
      'Create or replace a file in the repo with this content. The file is claimed for you first: if another agent holds it, nothing is written and you are told who has it. The write is recorded as yours, so it can be reviewed and undone. You keep the claim until release_files or 30 minutes without writes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: repoPath,
        content: { type: 'string', description: 'The whole new content of the file.' },
        intent: { type: 'string', description: 'One line on what you are changing and why.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_dir',
    description: 'List a folder in the repo: files and folders, sizes, who last changed each file and who holds it now.',
    inputSchema: { type: 'object', properties: { path: { ...repoPath, description: 'The folder, relative to the repo root. Empty for the root.' } } },
  },
  {
    name: 'delete_file',
    description: 'Delete a file in the repo. Claimed and recorded like write_file, so the delete can be undone.',
    inputSchema: { type: 'object', properties: { path: repoPath, intent: { type: 'string' } }, required: ['path'] },
  },
];

export const INSTRUCTIONS =
  'Several agents may be editing this repo at the same time. Call claim_files before editing any file, and release_files when you finish. If a claim fails, leave that file alone.';

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const toolError = (message, code) => Object.assign(new Error(message), { code });

const counted = (r) => (r.added === null ? 'untracked' : `+${r.added} -${r.removed}`);
// A hub workspace's SaaS connector (src/connectors/) answers for files under
// saas/: what happened remotely. A conflict or a failed push is an error the
// agent must act on, although the file itself was written.
const saasText = (r) => (r?.saas?.message ? `\n${r.saas.message}` : '');
const saasFailed = (r) => r?.saas?.status === 'conflict' || r?.saas?.status === 'error';

function listText(entries, folder) {
  if (!entries.length) return `${folder || '/'} is empty.`;
  return entries
    .map((e) => {
      const name = e.type === 'dir' ? `${e.path}/` : e.path;
      const size = e.type === 'file' ? `  ${e.size} B` : '';
      const held = e.held_by ? `  held by ${e.held_by}` : '';
      const last = e.last_change ? `  last changed by ${e.last_change.label}` : '';
      return `${name}${size}${last}${held}`;
    })
    .join('\n');
}

// The tools for one session. who() gives the calling agent as { agent, label };
// workspace (optional) adds the workspace tools. guard (optional) checks each
// file the core tools touch and throws to refuse it: over HTTP it is the /fs
// path check, so claim_files and who_wrote cannot read .git or follow a link
// out of the repo. offload (optional, the hub: src/server/offload.js) runs
// list_runs, who_wrote and the counts of release_files off the event loop;
// those tools (and the workspace's writes) then answer with a promise.
export function createTools({ store, ws, who: whoAmI, cwd = ws.root, workspace = null, guard = null, offload = null }) {
  const keys = (paths) =>
    paths
      .map((p) => fileKey(ws, path.resolve(cwd, String(p))))
      .filter(Boolean)
      .map((f) => (guard ? guard(f) : f));

  // A new turn starts at the first claim and whenever the intent changes.
  let turnIntent;
  const newTurn = (agent, intent) => {
    if (turnIntent !== undefined && (!intent || intent === turnIntent)) return;
    failOpen('start a new turn', () => store.nextTurn(agent));
    turnIntent = intent || turnIntent || null;
  };
  const snapshotAll = (me, files) =>
    files.forEach((file) => failOpen(`snapshot ${file.display}`, () => beginEdit(store, { run: me.agent, label: me.label, ws, file, keep: true })));
  // Records what changed in the files being released (all of them when only is null).
  const record = (agent, only) => {
    const done = failOpen('record changes', () => finishRun(store, agent, only)) ?? [];
    for (const c of done) store.recordEdit(agent, c.path, c.detail);
    return done;
  };

  // view (a scoped caller, src/scope.js reader): the store as that caller may
  // see it, for the tools that summarise the whole repo.
  const seen = (view) => {
    if (!view) return { store, runs: () => store.runs() };
    const runsSeen = () => {
      const byRun = pathsByRun(store);
      return store.runs().filter((r) => (byRun.get(r.run) ?? []).some((p) => view(p)));
    };
    return {
      store: {
        leases: () => store.leases().filter((l) => view(l.path)),
        activeAgents: () => store.activeAgents(),
        events: (n) => scopedEvents(() => new Set(runsSeen().map((r) => r.run)), view, store.events(n)),
      },
      runs: runsSeen,
    };
  };

  function core(name, args, me, view) {
    switch (name) {
      case 'claim_files': {
        const files = keys(args.paths ?? []);
        if (!files.length) return text('None of those paths are inside this repo.', true);
        const ttlMs = args.ttl_minutes > 0 ? args.ttl_minutes * 60 * 1000 : undefined;
        if (args.intent) store.setIntent(me.agent, args.intent, { label: me.label, worktree: ws.worktree });
        const r = store.claim(me.agent, files, { intent: args.intent ?? null, ttlMs, worktree: ws.worktree, label: me.label });
        if (r.ok) {
          newTurn(me.agent, args.intent);
          snapshotAll(me, files);
          return text(`Claimed: ${r.claimed.join(', ')}. Release them with release_files when you are done.`);
        }
        const now = Date.now();
        const lines = r.conflicts.map(
          (c) => `- ${c.path}: held by ${who(c)}${c.worktree ? ` (worktree ${c.worktree})` : ''} for ${ago(now - c.acquired_at)}${c.intent ? `, working on "${c.intent}"` : ''}`,
        );
        return text(`Nothing was claimed. These files are held by other agents:\n${lines.join('\n')}\nDo not edit them now. Work on other files, or tell the user.`, true);
      }
      case 'release_files': {
        const only = args.paths?.length ? keys(args.paths).map((f) => f.key) : null;
        const release = () => {
          const done = record(me.agent, only);
          const released = store.release(me.agent, only);
          const changed = done.length ? `\nRecorded your changes: ${done.map((c) => `${c.path} ${c.detail}`).join(', ')}` : '';
          return text((released.length ? `Released: ${released.join(', ')}` : 'You held none of those files.') + changed);
        };
        return offload ? offload.ensure(() => pendingPairs(store, me.agent, only), release) : release();
      }
      case 'who_is_editing':
        return text(statusText(ws, seen(view).store));
      case 'set_intent':
        store.setIntent(me.agent, String(args.intent ?? ''), { label: me.label, worktree: ws.worktree });
        newTurn(me.agent, String(args.intent ?? ''));
        return text('Intent recorded. Other agents will see it.');
      case 'recent_activity':
        return text(logText(seen(view).store, Math.min(Number(args.limit) || 30, 200)));
      case 'list_runs':
        if (offload) return offload.inTree(store).then((status) => text(runsText(seen(view).runs(), status)));
        return text(runsText(seen(view).runs(), inTree(store)));
      case 'who_wrote': {
        const [file] = keys([String(args.path ?? '')]);
        if (!file) return text('That path is not inside this repo.', true);
        if (offload) return offload.blame(store, ws, file).then((b) => text(blameText(b)));
        return text(blameText(blame(store, ws, file)));
      }
      default:
        return undefined;
    }
  }

  // Workspace errors (held by someone, bad path, missing file) are answers the
  // agent should read, not protocol errors.
  function files(name, args, me, view) {
    const rel = String(args.path ?? '');
    try {
      switch (name) {
        case 'read_file': {
          const { buf } = workspace.read(rel);
          if (buf.subarray(0, 8192).includes(0)) return text(`${rel} is a binary file; read_file returns text only.`, true);
          return text(buf.toString('utf8'));
        }
        case 'write_file': {
          if (typeof args.content !== 'string') return text('write_file needs content: the whole new file as a string.', true);
          const r = workspace.write(me, rel, Buffer.from(args.content, 'utf8'), { intent: args.intent });
          const say = (w) => text(`Wrote ${w.path} (${counted(w)}). You hold it until release_files, or 30 minutes without writes.${saasText(w)}`, saasFailed(w));
          return r?.then ? r.then(say) : say(r);
        }
        case 'list_dir': {
          const entries = workspace.list(rel);
          return text(listText(view ? entries.filter((e) => view(e.path, e.type)) : entries, rel));
        }
        case 'delete_file': {
          const r = workspace.remove(me, rel, { intent: args.intent });
          const say = (d) => text(`Deleted ${d.path} (${counted(d)}). The delete is recorded as yours and can be undone.${saasText(d)}`, saasFailed(d));
          return r?.then ? r.then(say) : say(r);
        }
        default:
          return undefined;
      }
    } catch (err) {
      if (typeof err.status === 'number' && err.code !== 'internal') return text(err.message, true);
      throw err;
    }
  }

  return {
    list: () => (workspace ? [...TOOLS, ...WORKSPACE_TOOLS] : TOOLS),
    // view: (path, 'file' | 'dir') -> whether this caller may see it, or
    // null for everything (src/scope.js reader). Paths a call names were
    // already checked by the server's authorize hook.
    call(name, args = {}, { view = null } = {}) {
      const me = whoAmI();
      let out;
      try {
        out = core(name, args, me, view);
      } catch (err) {
        // A refused path is an answer for the agent, like in files().
        if (typeof err.status === 'number' && err.code !== 'internal') return text(err.message, true);
        throw err;
      }
      out ??= workspace ? files(name, args, me, view) : undefined;
      if (out === undefined) throw toolError(`Unknown tool: ${name}`, -32602);
      // An offloaded tool answers later; its refusals are answers too.
      if (out?.then) {
        return out.catch((err) => {
          if (typeof err.status === 'number' && err.code !== 'internal') return text(err.message, true);
          throw err;
        });
      }
      return out;
    },
    // The client went away: record what changed and give back what it held.
    end(agent) {
      record(agent, null);
      store.endSession(agent);
    },
  };
}

// Answers one JSON-RPC message, or returns null for a notification.
// onInitialize(params) runs before the initialize reply is built.
export function createRpc({ tools, onInitialize = () => {}, instructions = INSTRUCTIONS }) {
  return function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
    const { id: rid, method, params } = msg;
    const isRequest = rid !== undefined && rid !== null;
    const failed = (err) => ({ jsonrpc: '2.0', id: rid, error: { code: typeof err.code === 'number' ? err.code : -32603, message: err.message } });
    try {
      let result;
      if (method === 'initialize') {
        onInitialize(params);
        result = {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'grapim', version: VERSION },
          instructions,
        };
      } else if (method === 'ping') result = {};
      else if (method === 'tools/list') result = { tools: tools.list() };
      else if (method === 'tools/call') result = tools.call(params?.name, params?.arguments ?? {});
      else if (!isRequest) return null; // notifications such as notifications/initialized
      else throw toolError(`Method not found: ${method}`, -32601);
      // A tool that answers later (the hub's offloaded ones): so does the reply.
      if (result?.then) return result.then((r) => (isRequest ? { jsonrpc: '2.0', id: rid, result: r } : null), (err) => (isRequest ? failed(err) : null));
      return isRequest ? { jsonrpc: '2.0', id: rid, result } : null;
    } catch (err) {
      return isRequest ? failed(err) : null;
    }
  };
}

export function startMcp({ cwd = process.cwd(), env = process.env, input = process.stdin, output = process.stdout } = {}) {
  const ws = resolveWorkspace(cwd);
  const store = new Store(ws.stateDir);
  let agent = env.GRAPIM_AGENT || null;
  let label = env.GRAPIM_AGENT || null;
  const me = () => {
    if (!agent) {
      agent = `mcp:${process.pid}`;
      label = `agent ${process.pid}`;
    }
    return { agent, label };
  };

  const tools = createTools({ store, ws, who: me, cwd });
  const handle = createRpc({
    tools,
    onInitialize(params) {
      const client = params?.clientInfo?.name;
      if (!agent && client) {
        agent = `${client}:${process.pid}`;
        label = `${client} ${process.pid}`;
      }
    },
  });
  const send = (msg) => output.write(JSON.stringify(msg) + '\n');

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      const reply = handle(m);
      if (reply) send(reply);
    }
  });
  rl.on('close', () => {
    // The client went away: give back whatever this agent held.
    if (agent) {
      try {
        tools.end(agent);
      } catch {}
    }
    store.close();
  });
}
