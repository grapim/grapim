// The workspace file client, for an agent holding a `gws_` token (docs/workspaces.md,
// docs/api.md "Agent workspace"). It needs no platform key, so it is safe to
// hand to code running in a sandbox, and it works in browsers too.
//
//   const ws = Grapim.workspace({ url: workspace.url, token, agent: 'fixer' });
//   const { content, sha } = await ws.read('src/app.js');
//   await ws.write('src/app.js', next, { ifMatch: sha });

import { GrapimError } from './errors.js';
import { Http } from './http.js';

const enc = new TextEncoder();

/** `"abc…"` → `abc…`. */
const unquote = (etag) => (etag ? etag.replace(/^W\//, '').replace(/^"(.*)"$/, '$1') : null);

/** Encodes a repo-relative path segment by segment, keeping the slashes. */
export function encodePath(p) {
  if (typeof p !== 'string') throw new GrapimError('A path must be a string.', { code: 'bad_request' });
  return p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
}

function ifMatchHeader(v) {
  if (v === undefined) return undefined;
  if (v === null || v === 'absent' || v === '"absent"') return '"absent"';
  const s = unquote(String(v));
  if (!/^[0-9a-f]{40}$/i.test(s)) throw new GrapimError('ifMatch must be a sha1 (the sha from read or write), "absent", or null for absent.', { code: 'bad_request' });
  return `"${s.toLowerCase()}"`;
}

function headerValue(name, v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v);
  if (!/^[\x20-\x7e]{1,500}$/.test(s)) throw new GrapimError(`${name} must be 1 to 500 printable ASCII characters.`, { code: 'bad_request' });
  return s;
}

function toBytes(content) {
  if (typeof content === 'string') return enc.encode(content);
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  throw new GrapimError('content must be a string, Uint8Array or ArrayBuffer.', { code: 'bad_request' });
}

/** The workspace root URL with one trailing slash; accepts the workspace's url, fs_url or mcp_url. */
export function workspaceBase(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new GrapimError(`Not a workspace URL: ${url}`, { code: 'bad_request' });
  }
  u.search = '';
  u.hash = '';
  let p = u.pathname.replace(/\/+$/, '');
  p = p.replace(/\/(fs|mcp)$/, '');
  u.pathname = p + '/';
  return u.toString();
}

export class WorkspaceClient {
  #http;
  #agent;
  #intent;

  /**
   * @param {object} o
   * @param {string} o.url     the workspace URL (`url`, `fs_url` or `mcp_url` from the API)
   * @param {string} o.token   a `gws_` workspace token
   * @param {string} [o.agent] sent as X-Grapim-Agent: the run id becomes http:<token-name>/<agent>
   * @param {string} [o.intent] sent as X-Grapim-Intent on writes; a new intent starts a new turn
   */
  constructor(o = {}) {
    if (!o.url) throw new GrapimError('Grapim.workspace needs { url }.', { code: 'bad_request' });
    if (typeof o.token !== 'string' || !o.token) throw new GrapimError('Grapim.workspace needs { token } (a gws_ workspace token).', { code: 'bad_request' });
    this.url = workspaceBase(o.url);
    this.#agent = headerValue('agent', o.agent);
    this.#intent = headerValue('intent', o.intent);
    this.#http = new Http({ ...o, authorization: `Bearer ${o.token}`, baseUrl: this.url });
  }

  #headers(extra = {}, intent) {
    const h = { ...extra };
    if (this.#agent) h['X-Grapim-Agent'] = this.#agent;
    const i = intent === undefined ? this.#intent : headerValue('intent', intent);
    if (i) h['X-Grapim-Intent'] = i;
    return h;
  }

  /** The file's bytes and sha (its ETag). Throws NotFoundError when there is no such file. */
  async read(path, o = {}) {
    const r = await this.#http.request('GET', 'fs/' + encodePath(path), { as: 'bytes', signal: o.signal, headers: { Accept: 'application/octet-stream' } });
    return { content: r.data, sha: unquote(r.headers.get('etag')) };
  }

  /** read(), decoded as UTF-8. */
  async readText(path, o = {}) {
    const { content, sha } = await this.read(path, o);
    return { text: new TextDecoder().decode(content), sha };
  }

  /**
   * Writes the file. With `ifMatch` (a sha, or "absent"/null for "must not exist")
   * the write only happens if the file is still that version; otherwise a
   * PreconditionFailedError with `currentSha`.
   */
  async write(path, content, o = {}) {
    const headers = this.#headers({}, o.intent);
    const im = ifMatchHeader(o.ifMatch);
    if (im) headers['If-Match'] = im;
    const r = await this.#http.request('PUT', 'fs/' + encodePath(path), { raw: toBytes(content), headers, signal: o.signal });
    return r.data;
  }

  /** Deletes the file, with the same `ifMatch` rule as write. */
  async delete(path, o = {}) {
    const headers = this.#headers({}, o.intent);
    const im = ifMatchHeader(o.ifMatch);
    if (im) headers['If-Match'] = im;
    const r = await this.#http.request('DELETE', 'fs/' + encodePath(path), { headers, signal: o.signal });
    return r.data;
  }

  /**
   * Lists a folder ('' is the root). Without `recursive` it returns the folder's
   * entries (files and folders); with it, `{ files, truncated }`: every file below.
   */
  async list(dir = '', o = {}) {
    const d = String(dir ?? '').replace(/^\/+/, '');
    if (o.recursive) {
      const r = await this.#http.request('GET', 'api/files', { query: { path: d || undefined, recursive: 1 }, signal: o.signal });
      return r.data;
    }
    const folder = d === '' ? '' : encodePath(d.endsWith('/') ? d.slice(0, -1) : d) + '/';
    const r = await this.#http.request('GET', 'fs/' + folder, { signal: o.signal });
    return r.data;
  }

  /** Which run and turn wrote each line that differs from the base. `full: true` adds the file's content. */
  async blame(path, o = {}) {
    const r = await this.#http.request('GET', 'api/blame', { query: { path, full: o.full ? 1 : undefined }, signal: o.signal });
    return r.data;
  }

  /** Every run that changed a file, newest activity first. */
  async runs(o = {}) {
    const r = await this.#http.request('GET', 'api/runs', { signal: o.signal });
    return r.data;
  }

  /** One run with its turns and per-file diffs. */
  async run(run, o = {}) {
    const r = await this.#http.request('GET', 'api/runs/' + encodeURIComponent(run), { signal: o.signal });
    return r.data;
  }

  /**
   * Undoes a run (or one `turn` of it). `apply: false` (the default) returns the
   * plan; `apply: true` applies it. Needs a write token.
   */
  async undo(run, o = {}) {
    const body = { turn: o.turn ?? null, apply: o.apply === true };
    const r = await this.#http.request('POST', 'api/runs/' + encodeURIComponent(run) + '/undo', { json: body, headers: this.#headers(), signal: o.signal });
    return r.data;
  }

  /** Releases every file this agent holds (writes keep their claim until then). */
  async release(o = {}) {
    const r = await this.#http.request('POST', 'fs/_release', { headers: this.#headers(), signal: o.signal, retryUnsafe: true });
    return r.data;
  }
}
