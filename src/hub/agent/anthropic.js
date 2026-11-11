// The one outbound call Ask Grapim makes: POST /v1/messages on the Anthropic
// API, streamed (server-sent events), with plain fetch (the hub has no npm
// dependencies). Returns the finished message, rebuilt from the stream with
// every block kept as the API sent it (thinking blocks and their signatures
// included), because the next request must pass them back unchanged.

export const API_VERSION = '2026-10-21';

export class AnthropicError extends Error {
  constructor(message, { status = null, type = null } = {}) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

// Splits a byte stream into server-sent events: { event, data }.
async function* sse(body, signal) {
  const decoder = new TextDecoder();
  let buf = '';
  const reader = body.getReader();
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = 'message';
        const data = [];
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// body: the Messages API request (stream is forced on). onText(text) gets
// visible text as it arrives; onBlock(block) each finished content block.
// Returns { content, stop_reason, stop_details, usage, model }.
export async function streamMessage({ apiKey, baseUrl, body, betas = [], signal, fetchImpl = globalThis.fetch, onText = () => {}, onBlock = () => {} }) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
  };
  if (betas.length) headers['anthropic-beta'] = betas.join(',');
  let res;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }), signal });
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err;
    throw new AnthropicError('The model could not be reached.', { type: 'network' });
  }
  if (!res.ok) {
    let type = null;
    try {
      type = (await res.json())?.error?.type ?? null;
    } catch {}
    throw new AnthropicError(`The model answered ${res.status}.`, { status: res.status, type });
  }

  const blocks = [];
  const partial = new Map(); // index -> accumulated tool input JSON
  let message = null;
  let usage = {};
  let stop = null;
  let stopDetails = null;
  for await (const { event, data } of sse(res.body, signal)) {
    if (event === 'ping') continue;
    let e;
    try {
      e = JSON.parse(data);
    } catch {
      continue;
    }
    if (e.type === 'error') throw new AnthropicError('The model stopped with an error.', { type: e.error?.type ?? 'error' });
    if (e.type === 'message_start') {
      message = e.message ?? {};
      usage = { ...(message.usage ?? {}) };
    } else if (e.type === 'content_block_start') {
      const b = { ...(e.content_block ?? {}) };
      if (b.type === 'tool_use') {
        partial.set(e.index, '');
        b.input = {};
      }
      if (b.type === 'text' && b.text) onText(b.text);
      blocks[e.index] = b;
    } else if (e.type === 'content_block_delta') {
      const b = blocks[e.index];
      const d = e.delta ?? {};
      if (!b) continue;
      if (d.type === 'text_delta') {
        b.text = (b.text ?? '') + d.text;
        onText(d.text);
      } else if (d.type === 'input_json_delta') partial.set(e.index, (partial.get(e.index) ?? '') + (d.partial_json ?? ''));
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + (d.thinking ?? '');
      else if (d.type === 'signature_delta') b.signature = (b.signature ?? '') + (d.signature ?? '');
      else if (d.type === 'citations_delta') (b.citations ??= []).push(d.citation);
    } else if (e.type === 'content_block_stop') {
      const b = blocks[e.index];
      if (b?.type === 'tool_use') {
        const raw = partial.get(e.index) ?? '';
        try {
          b.input = raw ? JSON.parse(raw) : {};
        } catch {
          b.input = { __invalid_json: true };
        }
      }
      if (b) onBlock(b);
    } else if (e.type === 'message_delta') {
      if (e.delta?.stop_reason) stop = e.delta.stop_reason;
      if (e.delta?.stop_details) stopDetails = e.delta.stop_details;
      if (e.usage) usage = { ...usage, ...e.usage };
    }
  }
  if (!message) throw new AnthropicError('The model sent an empty stream.', { type: 'empty' });
  return { content: blocks.filter(Boolean), stop_reason: stop, stop_details: stopDetails, usage, model: message.model ?? body.model };
}
