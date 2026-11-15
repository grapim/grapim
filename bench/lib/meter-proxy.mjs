// A local HTTP proxy in front of the Anthropic API, so every tool's model calls
// are counted the same way (input, cache and output tokens, from the API's own
// usage fields), whatever client library the tool uses.
//
//   startProxy({ mode: 'forward' })  -> passes requests to https://api.anthropic.com
//   startProxy({ mode: 'fake', reply }) -> answers locally, no network (dry runs)
//
// Point a tool at it with ANTHROPIC_BASE_URL (Claude Code, the Anthropic SDKs)
// or ANTHROPIC_API_BASE (LiteLLM, which PR-Agent uses).

import http from 'node:http';
import { Readable } from 'node:stream';

const UPSTREAM = 'https://api.anthropic.com';

export function emptyUsage() {
  return { requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, models: {} };
}

export function addUsage(total, u, model) {
  if (!u) return total;
  total.input += u.input_tokens ?? 0;
  total.cacheWrite += u.cache_creation_input_tokens ?? 0;
  total.cacheRead += u.cache_read_input_tokens ?? 0;
  total.output += u.output_tokens ?? 0;
  if (model) total.models[model] = (total.models[model] ?? 0) + 1;
  return total;
}

// Usage from a non-streamed body or from an SSE stream's text.
export function usageFromBody(text) {
  const t = String(text ?? '');
  if (t.trimStart().startsWith('{')) {
    try {
      const j = JSON.parse(t);
      return { usage: j.usage ?? null, model: j.model ?? null };
    } catch {
      return { usage: null, model: null };
    }
  }
  const usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  let model = null;
  let seen = false;
  for (const line of t.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let ev;
    try {
      ev = JSON.parse(line.slice(5));
    } catch {
      continue;
    }
    const u = ev.type === 'message_start' ? ev.message?.usage : ev.type === 'message_delta' ? ev.usage : null;
    if (ev.type === 'message_start') model = ev.message?.model ?? model;
    if (!u) continue;
    seen = true;
    // message_delta carries cumulative counts: take the larger value.
    for (const k of Object.keys(usage)) if (typeof u[k] === 'number') usage[k] = Math.max(usage[k], u[k]);
  }
  return { usage: seen ? usage : null, model };
}

function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

// A complete fake message (as JSON or as an SSE stream). answer: the text, or
// { tool: { name, input } } for one tool call (stop_reason "tool_use").
export function fakeMessage(body, answer) {
  const model = body?.model ?? 'claude-opus-5-5';
  const tool = answer && typeof answer === 'object' ? answer.tool : null;
  const text = tool ? '' : String(answer ?? '');
  const inTok = Math.ceil(JSON.stringify(body?.messages ?? []).length / 4) + Math.ceil(JSON.stringify(body?.system ?? '').length / 4) + Math.ceil(JSON.stringify(body?.tools ?? []).length / 4);
  const outTok = Math.max(1, Math.ceil((tool ? JSON.stringify(tool.input).length : text.length) / 4));
  const id = `msg_dry_${Math.random().toString(36).slice(2, 10)}`;
  const toolId = `toolu_dry_${Math.random().toString(36).slice(2, 10)}`;
  const usage = { input_tokens: inTok, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: outTok };
  const stop = tool ? 'tool_use' : 'end_turn';
  const block = tool ? { type: 'tool_use', id: toolId, name: tool.name, input: tool.input } : { type: 'text', text };
  if (!body?.stream) {
    return { contentType: 'application/json', text: JSON.stringify({ id, type: 'message', role: 'assistant', model, content: [block], stop_reason: stop, stop_sequence: null, usage }) };
  }
  const start = tool ? { type: 'tool_use', id: toolId, name: tool.name, input: {} } : { type: 'text', text: '' };
  const delta = tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text };
  return {
    contentType: 'text/event-stream',
    text: sse([
      { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: start },
      { type: 'content_block_delta', index: 0, delta },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outTok } },
      { type: 'message_stop' },
    ]),
  };
}

const readAll = (req) => new Promise((resolve, reject) => {
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => resolve(Buffer.concat(parts)));
  req.on('error', reject);
});

// mode 'fake': reply(body, url) -> the fake answer: text, or { tool: { name, input } }.
export async function startProxy({ mode = 'fake', reply = () => 'No issues found.', upstream = UPSTREAM, fetchImpl = globalThis.fetch } = {}) {
  const usage = emptyUsage();
  const log = [];
  const server = http.createServer(async (req, res) => {
    try {
      const raw = await readAll(req);
      const url = req.url ?? '/';
      let body = null;
      try {
        body = raw.length ? JSON.parse(raw.toString('utf8')) : null;
      } catch {}
      log.push({ method: req.method, url, model: body?.model ?? null, stream: !!body?.stream, at: Date.now() });
      if (mode === 'fake') {
        if (/\/v1\/messages\/count_tokens/.test(url)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ input_tokens: Math.ceil(raw.length / 4) }));
        }
        if (req.method === 'POST' && /\/v1\/messages(?:\?|$)/.test(url)) {
          const a = reply(body, url);
          const m = fakeMessage(body, a && typeof a === 'object' ? a : String(a ?? ''));
          usage.requests++;
          addUsage(usage, usageFromBody(m.text).usage, body?.model);
          res.writeHead(200, { 'content-type': m.contentType });
          return res.end(m.text);
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'dry-run proxy' } }));
      }
      // forward
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!['host', 'connection', 'content-length', 'accept-encoding'].includes(k)) headers[k] = v;
      const up = await fetchImpl(upstream + url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw });
      const outHeaders = {};
      up.headers.forEach((v, k) => {
        if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) outHeaders[k] = v;
      });
      res.writeHead(up.status, outHeaders);
      const chunks = [];
      if (up.body) {
        for await (const c of Readable.fromWeb(up.body)) {
          chunks.push(c);
          res.write(c);
        }
      }
      res.end();
      if (/\/v1\/messages(?:\?|$)/.test(url) && req.method === 'POST') {
        usage.requests++;
        const u = usageFromBody(Buffer.concat(chunks).toString('utf8'));
        addUsage(usage, u.usage, u.model ?? body?.model);
      }
    } catch (err) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `bench proxy: ${err.message}` } }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    usage,
    log,
    reset() {
      Object.assign(usage, emptyUsage());
      log.length = 0;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
