// MCP over HTTP at /mcp, in the streamable HTTP style with JSON responses: a
// POST with a JSON-RPC body (or a batch) gets the JSON-RPC reply. initialize
// opens a session and returns its id in Mcp-Session-Id; later requests send it
// back. DELETE /mcp ends the session, which records and releases like a
// stdio client disconnecting.
//
// The agent is http:<X-Grapim-Agent> when that header is given, so an agent
// using both /fs and /mcp is one run. Otherwise the session names it.

import crypto from 'node:crypto';
import { createRpc, createTools, INSTRUCTIONS } from '../mcp.js';
import { httpAgent } from './fs.js';
import { HttpError, busy, headerText, readBody, sendJson } from './http.js';
import { pendingPairs } from './offload.js';
import { resolvePath } from './paths.js';

const IDLE_MS = 6 * 60 * 60 * 1000;
// Sessions live until DELETE or 6 idle hours; this bounds what a client
// looping on initialize can pin in memory.
export const MAX_SESSIONS = 1000;
const WORKSPACE_NOTE =
  ' You can also work on files directly with read_file, write_file, list_dir and delete_file: each write claims the file for you and is recorded, so it can be reviewed and undone.';

const rpcError = (res, status, code, message, id = null) => sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } });

// authorizeTool(req, name, args) (optional) throws an HttpError to refuse a tools/call:
// the hub refuses write tools to read-only workspace tokens.
// offload (the hub, src/server/offload.js) runs the heavy tools off the event
// loop; their replies are awaited one message at a time, in order.
// readable(req) (optional): null when the caller sees everything, else
// (path, 'file' | 'dir') -> whether it may see it (src/scope.js reader): the
// tools that list or summarise leave out what it cannot read.
export function createMcpHttp({ store, ws, workspace, authorizeTool = null, offload = null, readable = null }) {
  const sessions = new Map();

  function open(name, clientName) {
    const id = crypto.randomUUID();
    const short = id.slice(0, 8);
    const client = String(clientName || 'mcp').replace(/[^\w.-]+/g, '-').slice(0, 40) || 'mcp';
    const s = { id, header: name, own: { agent: `http:${client}-${short}`, label: `${client} ${short}` }, seen: Date.now(), used: new Set() };
    // The X-Grapim-Agent of the current request wins over the session's own name.
    const who = () => {
      const me = s.header ? httpAgent(s.header) : s.own;
      s.used.add(me.agent);
      return me;
    };
    // claim_files, release_files and who_wrote get the same path check as /fs.
    const guard = (f) => resolvePath(ws, f.display).file;
    s.tools = createTools({ store, ws, who, workspace, guard, offload });
    s.rpc = createRpc({ tools: s.tools, instructions: INSTRUCTIONS + WORKSPACE_NOTE });
    sessions.set(id, s);
    return s;
  }

  function end(s) {
    sessions.delete(s.id);
    for (const agent of s.used) {
      try {
        s.tools.end(agent);
      } catch (err) {
        process.stderr.write(`grapim serve: could not end MCP session ${s.id}: ${err.message}\n`);
      }
    }
  }

  function prune(now) {
    for (const s of sessions.values()) if (now - s.seen > IDLE_MS) end(s);
  }

  function sessionFor(req, res, messages) {
    const name = headerText(req, 'x-grapim-agent') || null;
    if (name) httpAgent(name); // validates the header, 400 if bad
    const init = messages.find((m) => m?.method === 'initialize');
    if (init) {
      prune(Date.now());
      if (sessions.size >= MAX_SESSIONS) throw busy(`${MAX_SESSIONS} MCP sessions are open. End some with DELETE /mcp, or wait for idle ones to expire.`);
      const s = open(name, init.params?.clientInfo?.name);
      res.setHeader('Mcp-Session-Id', s.id);
      return s;
    }
    const sid = headerText(req, 'mcp-session-id');
    if (!sid) {
      rpcError(res, 400, -32600, 'Missing Mcp-Session-Id. Send initialize first and pass back the Mcp-Session-Id it returns.');
      return null;
    }
    const s = sessions.get(sid);
    if (!s) {
      rpcError(res, 404, -32001, 'Unknown or ended MCP session. Send initialize again.');
      return null;
    }
    s.header = name ?? s.header;
    return s;
  }

  async function post(req, res) {
    const buf = await readBody(req, 40 * 1024 * 1024);
    let body;
    try {
      body = JSON.parse(buf.toString('utf8'));
    } catch {
      return rpcError(res, 400, -32700, 'Parse error');
    }
    const batch = Array.isArray(body);
    const messages = batch ? body : [body];
    if (!messages.length) return rpcError(res, 400, -32600, 'Invalid request: empty batch');
    const s = sessionFor(req, res, messages);
    if (!s) return;
    if (authorizeTool) {
      for (const m of messages) {
        if (m?.method !== 'tools/call') continue;
        try {
          await authorizeTool(req, String(m.params?.name ?? ''), m.params?.arguments ?? {});
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          // Nothing in the request runs: refused as a whole, with the HTTP
          // status. A path outside the caller's scope is "not found", but
          // over HTTP 200: a 404 tells an MCP client its session is gone.
          return rpcError(res, err.status === 404 ? 200 : err.status, -32003, err.message, m.id ?? null);
        }
      }
    }
    s.seen = Date.now();
    const view = readable ? readable(req) : null;
    const rpc = view ? createRpc({ tools: { list: s.tools.list, call: (n, a) => s.tools.call(n, a, { view }) }, instructions: INSTRUCTIONS + WORKSPACE_NOTE }) : s.rpc;
    const replies = [];
    for (const m of messages) {
      const reply = rpc(m);
      replies.push(reply?.then ? await reply : reply);
    }
    const sent = replies.filter(Boolean);
    if (!sent.length) {
      res.writeHead(202, { 'Content-Length': 0 });
      return res.end();
    }
    sendJson(res, 200, batch ? sent : sent[0]);
  }

  async function remove(req, res) {
    const sid = headerText(req, 'mcp-session-id') ?? '';
    let s = sessions.get(sid);
    if (!s) return rpcError(res, 404, -32001, 'Unknown or ended MCP session.');
    // Ending records what changed: those counts first, off the event loop.
    if (offload) {
      for (const agent of s.used) await offload.prepare(pendingPairs(store, agent)).catch(() => {});
      s = sessions.get(sid);
      if (!s) return rpcError(res, 404, -32001, 'Unknown or ended MCP session.');
    }
    end(s);
    res.writeHead(204);
    res.end();
  }

  return {
    async handle(req, res) {
      if (req.method === 'POST') return post(req, res);
      if (req.method === 'DELETE') return remove(req, res);
      // No server-to-client stream: GET is not offered, as the MCP spec allows.
      throw new HttpError('method_not_allowed', 'POST JSON-RPC messages to /mcp, or DELETE it to end a session.', { Allow: 'POST, DELETE' });
    },
    // The server is stopping: end every session as a disconnect would.
    closeAll() {
      for (const s of [...sessions.values()]) end(s);
    },
  };
}
