// The platform client: `new Grapim({ apiKey })` with a `gpk_` key, for a
// platform's backend. The key acts for the whole platform, so it must stay on
// the server; give agents a scoped `gws_` token (tokens.create) instead.

import { GrapimError } from './errors.js';
import { Http, isBrowser } from './http.js';
import { ListResult } from './pagination.js';
import { WorkspaceClient } from './workspace.js';

const id = (v, what) => {
  if (typeof v !== 'string' || !v) throw new GrapimError(`${what} must be a non-empty string.`, { code: 'bad_request' });
  return encodeURIComponent(v);
};

/** Date → YYYY-MM-DD (UTC); numbers and strings go through unchanged. */
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

/** Per-call options every method takes as its last argument. */
const callOpts = (o = {}) => ({ signal: o.signal, idempotencyKey: o.idempotencyKey });

/** POSTs always carry an Idempotency-Key: the caller's, or a fresh one reused across retries. */
const postOpts = (o = {}) => ({ signal: o.signal, idempotencyKey: o.idempotencyKey || true });

export class Grapim {
  #http;

  /**
   * @param {object} [o]
   * @param {string} [o.apiKey]   a `gpk_live_…` or `gpk_test_…` key; defaults to env GRAPIM_API_KEY
   * @param {string} [o.baseUrl]  default https://app.grapim.com
   * @param {typeof fetch} [o.fetch]
   * @param {number} [o.maxAttempts] default 3 (the first try plus two retries)
   * @param {number} [o.timeoutMs]   per attempt, default 60000
   * @param {boolean} [o.dangerouslyAllowBrowser] allow a platform key in a browser (do not)
   */
  constructor(o = {}) {
    const apiKey = o.apiKey ?? globalThis.process?.env?.GRAPIM_API_KEY;
    if (typeof apiKey !== 'string' || !apiKey) throw new GrapimError('new Grapim needs { apiKey } (a gpk_ platform key) or env GRAPIM_API_KEY.', { code: 'bad_request' });
    if (!apiKey.startsWith('gpk_')) {
      const hint = apiKey.startsWith('gws_') ? ' That is a workspace token: use Grapim.workspace({ url, token }) for it.' : '';
      throw new GrapimError(`apiKey must be a platform key starting with gpk_.${hint}`, { code: 'bad_request' });
    }
    if (isBrowser && !o.dangerouslyAllowBrowser) {
      throw new GrapimError('A platform key acts for the whole platform and must not ship to a browser. Call the API from your backend; in the browser use Grapim.workspace with a scoped token or an embed session URL.', { code: 'browser_refused' });
    }
    const base = String(o.baseUrl ?? 'https://app.grapim.com').replace(/\/+$/, '').replace(/\/v1$/, '');
    this.baseUrl = base;
    this.#http = new Http({ ...o, authorization: `Bearer ${apiKey}`, baseUrl: base + '/v1' });
    /** Whether this client uses a test-mode key (never billed). */
    this.testMode = apiKey.startsWith('gpk_test_');

    const http = this.#http;
    const req = async (method, path, o2) => (await http.request(method, path, o2)).data;
    const list = (path, params = {}, o2 = {}) =>
      new ListResult((p) => req('GET', path, { query: p, signal: o2.signal }), params);

    this.workspaces = {
      create: (params = {}, o2) => req('POST', '/workspaces', { json: params, ...postOpts(o2) }),
      list: (params = {}, o2) => list('/workspaces', params, o2),
      get: (wsId, o2) => req('GET', `/workspaces/${id(wsId, 'workspace id')}`, callOpts(o2)),
      update: (wsId, params = {}, o2) => req('PATCH', `/workspaces/${id(wsId, 'workspace id')}`, { json: params, ...callOpts(o2) }),
      delete: (wsId, o2) => req('DELETE', `/workspaces/${id(wsId, 'workspace id')}`, callOpts(o2)),
    };

    this.tokens = {
      create: (wsId, params = {}, o2) => req('POST', `/workspaces/${id(wsId, 'workspace id')}/tokens`, { json: params, ...postOpts(o2) }),
      revoke: (wsId, tokenId, o2) => req('DELETE', `/workspaces/${id(wsId, 'workspace id')}/tokens/${id(tokenId, 'token id')}`, callOpts(o2)),
    };

    this.embedSessions = {
      create: (wsId, params = {}, o2) => req('POST', `/workspaces/${id(wsId, 'workspace id')}/embed_sessions`, { json: params, ...postOpts(o2) }),
    };

    this.runs = {
      list: async (wsId, o2) => {
        const r = await req('GET', `/workspaces/${id(wsId, 'workspace id')}/runs`, callOpts(o2));
        return Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : [];
      },
      undo: (wsId, run, params = {}, o2) =>
        req('POST', `/workspaces/${id(wsId, 'workspace id')}/runs/${id(run, 'run')}/undo`, {
          json: { turn: params.turn ?? null, apply: params.apply === true },
          ...postOpts(o2),
        }),
    };

    this.usage = {
      get: (params = {}, o2) => req('GET', '/usage', { query: { ...params, from: day(params.from), to: day(params.to) }, ...callOpts(o2) }),
    };

    this.webhooks = {
      create: (params, o2) => req('POST', '/webhook_endpoints', { json: params, ...postOpts(o2) }),
      list: (params = {}, o2) => list('/webhook_endpoints', params, o2),
      delete: (endpointId, o2) => req('DELETE', `/webhook_endpoints/${id(endpointId, 'webhook endpoint id')}`, callOpts(o2)),
    };

    this.settings = {
      update: (params, o2) => req('PUT', '/settings', { json: params, ...callOpts(o2) }),
    };
  }

  /** A file client for an agent holding a `gws_` workspace token. Needs no platform key. */
  static workspace(o) {
    return new WorkspaceClient(o);
  }

  toJSON() {
    return { baseUrl: this.baseUrl, testMode: this.testMode };
  }
}
