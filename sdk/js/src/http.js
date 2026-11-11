// The one place that talks HTTP: auth header, JSON, Idempotency-Key, retries
// with backoff, timeouts and typed errors. Nothing here logs; the credential
// lives in a private field so it never shows up in console.log, util.inspect
// or JSON.stringify of a client.

import { ConnectionError, errorFromResponse, GrapimError } from './errors.js';

export const VERSION = '0.1.0';

const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

/** A UUID v4 from Web Crypto, or node:crypto on runtimes without a global crypto. */
export async function uuid() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  const spec = 'node:crypto';
  const { randomUUID } = await import(spec);
  return randomUUID();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Milliseconds a Retry-After header asks for, or null. Seconds or an HTTP date. */
export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']);

export class Http {
  #authorization;

  /**
   * @param {object} o
   * @param {string} o.authorization  the full Authorization header value
   * @param {string} o.baseUrl        absolute; request paths are appended to it
   * @param {typeof fetch} [o.fetch]
   * @param {number} [o.maxAttempts]  total attempts, default 3
   * @param {number} [o.baseDelayMs]  first backoff step, default 500
   * @param {number} [o.maxDelayMs]   backoff cap, default 8000
   * @param {number} [o.maxRetryAfterMs] longest Retry-After honoured, default 60000
   * @param {number} [o.timeoutMs]    per attempt, default 60000
   * @param {Record<string,string>} [o.headers] sent on every request
   */
  constructor(o) {
    this.#authorization = o.authorization;
    this.baseUrl = o.baseUrl;
    const f = o.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') throw new GrapimError('No fetch: use Node 18+, Deno, Bun or a browser, or pass { fetch }.', { code: 'no_fetch' });
    this.fetch = f;
    this.maxAttempts = Math.max(1, o.maxAttempts ?? 3);
    this.baseDelayMs = o.baseDelayMs ?? 500;
    this.maxDelayMs = o.maxDelayMs ?? 8000;
    this.maxRetryAfterMs = o.maxRetryAfterMs ?? 60_000;
    this.timeoutMs = o.timeoutMs ?? 60_000;
    this.headers = { ...(o.headers ?? {}) };
  }

  /** Backoff for attempt n (1-based) when the server gave no Retry-After: full jitter in [half, whole]. */
  backoff(n) {
    const cap = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (n - 1));
    return Math.round(cap / 2 + Math.random() * (cap / 2));
  }

  /**
   * @param {string} method
   * @param {string} path  appended to baseUrl as is (callers encode it)
   * @param {object} [o]
   * @param {Record<string, unknown>} [o.query]
   * @param {unknown} [o.json]         a JSON body
   * @param {Uint8Array|string} [o.raw] a raw body (application/octet-stream)
   * @param {Record<string,string>} [o.headers]
   * @param {string|boolean} [o.idempotencyKey] true: generate one; a string: use it
   * @param {'json'|'bytes'} [o.as]    how to read a 2xx body
   * @param {AbortSignal} [o.signal]
   * @param {boolean} [o.retryUnsafe]  retry 5xx/network errors on a POST without an Idempotency-Key (default false)
   * @returns {Promise<{ status: number, headers: Headers, data: any, requestId: string|null }>}
   */
  async request(method, path, o = {}) {
    let url = this.baseUrl + path;
    if (o.query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(o.query)) if (v !== undefined && v !== null) q.append(k, String(v));
      const s = q.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }
    const headers = { Accept: 'application/json', ...this.headers, ...(o.headers ?? {}), Authorization: this.#authorization };
    if (!isBrowser) headers['User-Agent'] = `grapim-js/${VERSION}`;
    let body;
    if (o.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(o.json);
    } else if (o.raw !== undefined) {
      headers['Content-Type'] = 'application/octet-stream';
      body = o.raw;
    }
    let key = null;
    if (o.idempotencyKey) {
      key = typeof o.idempotencyKey === 'string' ? o.idempotencyKey : await uuid();
      headers['Idempotency-Key'] = key;
    }
    // A retry is safe when repeating the request cannot do the work twice.
    const safe = IDEMPOTENT.has(method) || key !== null || o.retryUnsafe === true;

    for (let attempt = 1; ; attempt++) {
      const last = attempt >= this.maxAttempts;
      const ctl = new AbortController();
      const onAbort = () => ctl.abort(o.signal.reason);
      if (o.signal) {
        if (o.signal.aborted) throw o.signal.reason ?? new DOMException('Aborted', 'AbortError');
        o.signal.addEventListener('abort', onAbort, { once: true });
      }
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, this.timeoutMs);
      let res;
      try {
        res = await this.fetch(url, { method, headers, body, signal: ctl.signal });
      } catch (err) {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
        if (o.signal?.aborted) throw err;
        if (!last && safe) {
          await sleep(this.backoff(attempt));
          continue;
        }
        const origin = (() => { try { return new URL(url).origin; } catch { return 'the server'; } })();
        throw new ConnectionError(timedOut ? `Request to ${origin} timed out after ${this.timeoutMs} ms` : `Could not reach ${origin}: ${err?.message ?? err}`, { cause: err });
      }
      try {
        const requestId = res.headers.get('request-id');
        if (res.ok) {
          const data = o.as === 'bytes' ? new Uint8Array(await res.arrayBuffer()) : await readJson(res);
          return { status: res.status, headers: res.headers, data, requestId };
        }
        const retryable = res.status === 429 || res.status === 503 || (res.status >= 500 && safe);
        if (!last && retryable) {
          const wait = retryAfterMs(res.headers.get('retry-after'));
          await res.arrayBuffer().catch(() => {});
          await sleep(wait === null ? this.backoff(attempt) : Math.min(wait, this.maxRetryAfterMs));
          continue;
        }
        throw errorFromResponse(res.status, await readJson(res).catch(() => null), requestId);
      } finally {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
      }
    }
  }
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    if (!res.ok) return null;
    throw new GrapimError(`Expected JSON from the server, got ${res.headers.get('content-type') || 'no content type'}`, {
      code: 'invalid_response', status: res.status, requestId: res.headers.get('request-id'),
    });
  }
}

export { isBrowser };
