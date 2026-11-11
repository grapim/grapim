// Sign in with GitHub (OAuth web flow) and the browser session.
//
// - The OAuth `state` is random, stored server side (hashed, 10 minutes,
//   single use) and also bound to the browser by a signed cookie, so a login
//   started in one browser cannot be completed in another (login CSRF).
// - The code is exchanged server side; the GitHub access token is used once to
//   read the profile and then dropped. It is never stored or logged.
// - The session cookie holds a random id and its HMAC. The server keeps only
//   sha256(id), with the user, the CSRF token and a 30-day expiry. Logout
//   deletes the row, so a copied cookie stops working.

import { tx } from './db.js';
import { cookie, HttpError, redirect } from './http.js';
import { randomToken, same, sha256, sign, unsign } from './secure.js';

export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const STATE_MS = 10 * 60 * 1000;

export const sessionCookieName = (config) => (config.secure ? '__Host-grapim_session' : 'grapim_session');
export const oauthCookieName = (config) => (config.secure ? '__Host-grapim_oauth' : 'grapim_oauth');

// Where to go after signing in: only hub paths and cloud workspaces
// (/w/<team>/<name>), never another host.
export function safeNext(next) {
  return typeof next === 'string' && /^\/(hub|w)(\/[A-Za-z0-9_\-/]*)?$/.test(next) && !next.includes('//') ? next : '/hub';
}

export class Auth {
  constructor({ db, config, fetch, now }) {
    this.db = db;
    this.config = config;
    this.fetch = fetch;
    this.now = now;
  }

  get callbackUrl() {
    return `${this.config.origin}/hub/auth/callback`;
  }

  // ---- Sessions ----

  createSession(userId) {
    const id = randomToken(32);
    const csrf = randomToken(32);
    const t = this.now();
    this.db
      .prepare('INSERT INTO sessions (id_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(id), userId, csrf, t, t + SESSION_MS);
    return { cookie: this.sessionCookie(sign(this.config.secret, 'session', id)), csrf };
  }

  sessionCookie(value, maxAge = Math.floor(SESSION_MS / 1000)) {
    return cookie(sessionCookieName(this.config), value, { maxAge, secure: this.config.secure });
  }

  // { user, csrf, idHash } for a valid, unexpired session cookie, else null.
  load(cookies) {
    const raw = cookies[sessionCookieName(this.config)];
    if (!raw) return null;
    const id = unsign(this.config.secret, 'session', raw);
    if (!id) return null;
    const row = this.db
      .prepare(
        `SELECT s.id_hash, s.csrf, s.expires_at, u.id, u.login, u.name, u.avatar_url
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
      )
      .get(sha256(id));
    if (!row || row.expires_at <= this.now()) return null;
    return {
      idHash: row.id_hash,
      csrf: row.csrf,
      user: { id: row.id, login: row.login, name: row.name, avatar_url: row.avatar_url },
    };
  }

  destroy(session) {
    if (session) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(session.idHash);
    return this.sessionCookie('', 0);
  }

  sweep() {
    const t = this.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(t);
    this.db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(t);
  }

  // ---- OAuth ----

  start(res, next) {
    const state = randomToken(32);
    const t = this.now();
    this.db
      .prepare('INSERT INTO oauth_states (state_hash, next, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(state), safeNext(next), t, t + STATE_MS);
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.config.github.clientId);
    url.searchParams.set('redirect_uri', this.callbackUrl);
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'true');
    const bind = cookie(oauthCookieName(this.config), sign(this.config.secret, 'oauth', state), {
      maxAge: STATE_MS / 1000,
      secure: this.config.secure,
    });
    redirect(res, url.toString(), { 'Set-Cookie': bind });
  }

  // Checks the state, exchanges the code, upserts the user. Returns { userId, next }.
  async callback(query, cookies) {
    const state = query.get('state');
    const code = query.get('code');
    if (query.get('error')) throw new HttpError(400, 'oauth_denied', 'GitHub sign in was cancelled.');
    if (!state || !code || state.length > 200 || code.length > 200) throw new HttpError(400, 'bad_request', 'The sign in link is incomplete. Start again.');
    const bound = unsign(this.config.secret, 'oauth', cookies[oauthCookieName(this.config)]);
    // Consume the stored state whatever happens next: it is single use.
    const row = tx(this.db, () => {
      const r = this.db.prepare('SELECT * FROM oauth_states WHERE state_hash = ?').get(sha256(state));
      if (r) this.db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(r.state_hash);
      return r;
    });
    if (!bound || !same(bound, state) || !row || row.expires_at <= this.now()) {
      throw new HttpError(400, 'bad_state', 'This sign in attempt expired or did not start in this browser. Start again.');
    }

    const token = await this.exchange(code);
    const profile = await this.profile(token);
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO users (id, login, name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET login = excluded.login, name = excluded.name,
           avatar_url = excluded.avatar_url, updated_at = excluded.updated_at`,
      )
      .run(profile.id, profile.login, profile.name, profile.avatar_url, t, t);
    return { userId: profile.id, next: row.next || '/hub' };
  }

  async exchange(code) {
    let res;
    try {
      res = await this.fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'grapim-hub' },
        body: JSON.stringify({
          client_id: this.config.github.clientId,
          client_secret: this.config.github.clientSecret,
          code,
          redirect_uri: this.callbackUrl,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new HttpError(502, 'github_unreachable', 'Could not reach GitHub. Try again.');
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || typeof body.access_token !== 'string' || !body.access_token) {
      throw new HttpError(400, 'oauth_failed', 'GitHub did not accept this sign in. Start again.');
    }
    return body.access_token;
  }

  async profile(token) {
    let res;
    try {
      res = await this.fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'grapim-hub' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new HttpError(502, 'github_unreachable', 'Could not reach GitHub. Try again.');
    }
    const u = await res.json().catch(() => null);
    if (!res.ok || !u || !Number.isSafeInteger(u.id) || u.id <= 0 || typeof u.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(u.login)) {
      throw new HttpError(502, 'oauth_failed', 'GitHub returned an unexpected profile.');
    }
    const avatar = typeof u.avatar_url === 'string' && u.avatar_url.startsWith('https://avatars.githubusercontent.com/') ? u.avatar_url : null;
    return { id: u.id, login: u.login, name: typeof u.name === 'string' ? u.name.slice(0, 200) : null, avatar_url: avatar };
  }

  clearOauthCookie() {
    return cookie(oauthCookieName(this.config), '', { maxAge: 0, secure: this.config.secure });
  }
}
