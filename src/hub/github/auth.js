// GitHub App authentication with node:crypto only.
//
// - appJwt: an RS256 JWT with iat 60 s in the past (clock drift), exp 9
//   minutes ahead (GitHub's maximum is 10) and iss = the App id.
// - AppAuth.installationToken(id): an installation access token, cached until
//   5 minutes before it expires; concurrent callers share one request.

import crypto from 'node:crypto';

export const TOKEN_MARGIN_MS = 5 * 60 * 1000;
const JWT_LIFETIME_S = 9 * 60;

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export function appJwt({ appId, key, now = Date.now() }) {
  const iat = Math.floor(now / 1000) - 60;
  const head = b64url({ alg: 'RS256', typ: 'JWT' });
  const body = b64url({ iat, exp: iat + 60 + JWT_LIFETIME_S, iss: String(appId) });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

export class AuthError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

export class AppAuth {
  constructor({ appId, key, apiBase, fetch, now = () => Date.now() }) {
    this.appId = appId;
    this.key = key;
    this.apiBase = apiBase;
    this.fetch = fetch;
    this.now = now;
    this.cache = new Map(); // installation id -> { token, expiresAt }
    this.inflight = new Map();
  }

  jwt() {
    return appJwt({ appId: this.appId, key: this.key, now: this.now() });
  }

  async #call(method, path) {
    let res;
    try {
      res = await this.fetch(`${this.apiBase}${path}`, {
        method,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.jwt()}`, 'User-Agent': 'grapim-hub', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AuthError('GitHub is unreachable.');
    }
    const body = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, body };
  }

  // GET /app/installations/:id with the App JWT: { id, account: { id, login, type } } or null.
  async installation(id) {
    const r = await this.#call('GET', `/app/installations/${Number(id)}`);
    if (r.status === 404) return null;
    if (!r.ok || !r.body || r.body.id !== Number(id)) throw new AuthError(`GitHub answered ${r.status} for the installation.`, r.status);
    return r.body;
  }

  async installationToken(id) {
    const key = Number(id);
    const hit = this.cache.get(key);
    if (hit && this.now() < hit.expiresAt - TOKEN_MARGIN_MS) return hit.token;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      const r = await this.#call('POST', `/app/installations/${key}/access_tokens`);
      const token = r.body?.token;
      const expiresAt = Date.parse(r.body?.expires_at ?? '');
      if (!r.ok || typeof token !== 'string' || !token || !Number.isFinite(expiresAt)) throw new AuthError(`GitHub refused an installation token (${r.status}).`, r.status);
      this.cache.set(key, { token, expiresAt });
      return token;
    })();
    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(key);
    }
  }

  forget(id) {
    this.cache.delete(Number(id));
  }
}
