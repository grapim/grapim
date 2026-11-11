// Notion's REST API, for an internal integration token. Only this one host,
// and only paths built here from fixed segments and ids checked to be Notion
// ids: nothing a user types or a page contains becomes part of a URL, so the
// hub cannot be pointed anywhere else (no SSRF). Redirects are refused.
//
// The token goes in the Authorization header and nowhere else: never in an
// error, a log line or a URL.

import { createQueue, RetryableError } from '../queue.js';

export const NOTION_API = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2022-06-28';
const TIMEOUT_MS = 30_000;
const MAX_REPLY = 16 * 1024 * 1024;

// Internal integration secrets: secret_... (before September 2024) or ntn_....
export const TOKEN_RE = /^(secret_|ntn_)[A-Za-z0-9]{20,120}$/;

export class NotionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// A Notion id, with or without dashes, as the canonical dashed form; else null.
export function notionId(raw) {
  const hex = String(raw ?? '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function idOf(raw) {
  const id = notionId(raw);
  if (!id) throw new NotionError(400, 'bad_id', 'Not a Notion id.');
  return id;
}

// Error text from Notion is untrusted: one short line, no control characters.
const clean = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 300);

// baseUrl is set by code (tests point it at a fake server), never by a request.
export function createNotionClient({ token, baseUrl = NOTION_API, fetch = globalThis.fetch, queue = createQueue({ perSecond: 3 }) }) {
  if (!TOKEN_RE.test(String(token ?? ''))) throw new NotionError(400, 'bad_token', 'That is not a Notion internal integration secret (it starts with ntn_ or secret_).');
  const base = String(baseUrl).replace(/\/+$/, '');

  async function once(method, path, body) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new RetryableError(`Notion could not be reached (${err?.name === 'TimeoutError' ? 'timed out' : 'network error'}).`);
    }
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > MAX_REPLY) throw new NotionError(502, 'too_large', 'Notion sent a reply too large to read.');
    const text = await res.text();
    if (text.length > MAX_REPLY) throw new NotionError(502, 'too_large', 'Notion sent a reply too large to read.');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
      const ra = Number(res.headers.get('retry-after'));
      throw new RetryableError(res.status === 429 ? 'Notion rate limit reached.' : `Notion answered ${res.status}.`, { status: res.status, retryAfterMs: Number.isFinite(ra) && ra >= 0 ? ra * 1000 : null });
    }
    if (!res.ok) throw new NotionError(res.status, clean(json?.code) || 'error', clean(json?.message) || `Notion answered ${res.status}.`);
    if (!json || typeof json !== 'object') throw new NotionError(502, 'bad_reply', 'Notion sent a reply that is not JSON.');
    return json;
  }

  const call = (method, path, body) => queue.run(() => once(method, path, body));

  // Every page of a paginated list.
  async function all(fetchPage, max = 100_000) {
    const out = [];
    let cursor;
    for (;;) {
      const r = await fetchPage(cursor);
      for (const x of r.results ?? []) out.push(x);
      if (out.length > max) throw new NotionError(413, 'too_many', `More than ${max} items.`);
      if (!r.has_more || !r.next_cursor) return out;
      cursor = r.next_cursor;
    }
  }

  return {
    queue,
    me: () => call('GET', '/users/me'),
    // Pages and databases shared with the integration.
    search: (filterValue) =>
      all((cursor) => call('POST', '/search', { page_size: 100, ...(filterValue ? { filter: { property: 'object', value: filterValue } } : {}), ...(cursor ? { start_cursor: cursor } : {}) })),
    queryDatabase: (id) => all((cursor) => call('POST', `/databases/${idOf(id)}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) })),
    page: (id) => call('GET', `/pages/${idOf(id)}`),
    updatePage: (id, body) => call('PATCH', `/pages/${idOf(id)}`, body),
    children: (id) => all((cursor) => call('GET', `/blocks/${idOf(id)}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`), 20_000),
    append: (id, children, after = null) => call('PATCH', `/blocks/${idOf(id)}/children`, { children, ...(after ? { after: idOf(after) } : {}) }),
    updateBlock: (id, body) => call('PATCH', `/blocks/${idOf(id)}`, body),
    deleteBlock: (id) => call('DELETE', `/blocks/${idOf(id)}`),
  };
}
