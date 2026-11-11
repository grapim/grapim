// Embed sessions (docs/platform.md, "Embedding the review desk").
//
// 1. POST /v1/workspaces/:id/embed_sessions makes a link:
//    <hub>/hub/embed/<id>.<secret>.<hmac>. The HMAC (HUB_SECRET, purpose
//    "embed") rejects forged links before the database is read; the secret
//    is stored as sha256. The link works once, until expires_at.
// 2. Opening it (normally as an iframe's src) sets a cookie scoped to
//    /w/<team>/<name>/ (HttpOnly; Secure; SameSite=None; Partitioned) and
//    redirects to the desk with ?embed=1&theme=&mode= (and &brand=0 when
//    branding is off). The cookie lasts
//    ttl_seconds from then.
// 3. The mount (workspace-mount.js) accepts that cookie for that workspace
//    only. Writes need the X-Grapim-Csrf the hub returns in a response header
//    (unreadable cross-origin), and must come from the hub's own origin. A
//    `readonly` session cannot call any act or write route; no embed session
//    can write files over /fs or call MCP write tools: it is a person
//    reviewing, not an agent.
// 4. The desk's HTML gets frame-ancestors <parent_origin> (no X-Frame-Options)
//    and <meta name="grapim-embed-origin|grapim-embed-mode|grapim-embed-theme">,
//    so the UI knows where to postMessage. Every other hub response keeps
//    frame-ancestors 'none'.

import fs from 'node:fs';
import path from 'node:path';
import { HttpError as EngineError, headerText } from '../../server/http.js';
import { HttpError } from '../http.js';
import { randomId, randomToken, same, sha256, sign, unsign } from '../secure.js';
import { invalid, onlyFields, unix } from './util.js';

export const EMBED_TTL = { fallback: 600, min: 60, max: 3600 };
export const MAX_EMBEDS_PER_HOUR = 36_000; // per platform: 10 a second
const THEMES = ['light', 'dark', 'system'];
const USER_RE = /^[A-Za-z0-9._@+-]{1,64}$/;
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

const refuse = (message) => {
  const e = new EngineError('forbidden', message);
  e.status = 403;
  return e;
};
// A test-mode desk's banner (review M10). Inline style only: the desk's CSP
// allows style attributes and inline style, never inline script. The style
// keeps "Powered by Grapim" shown even with &brand=0 in the URL.
export const TEST_BANNER =
  '<div class="grapim-test-banner" role="status" style="position:sticky;top:0;z-index:1000;padding:6px 12px;background:#b45309;color:#fff;font:600 12px/1.4 system-ui,sans-serif;text-align:center">TEST MODE: a Grapim test workspace, deleted 7 days after it was created. Not for production use.</div>\n' +
  '<style>html.embed.no-brand .embed-foot{display:flex!important}</style>';
const attr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createEmbeds({ hub, keys }) {
  const { db, now, config, workspaces } = hub;
  const COOKIE = config.secure ? '__Secure-grapim_embed' : 'grapim_embed';

  // POST /v1/workspaces/:id/embed_sessions
  function create(platform, ws, rawBody) {
    const body = onlyFields(rawBody ?? {}, ['mode', 'ttl_seconds', 'theme', 'parent_origin', 'user', 'branding']);
    const mode = body.mode ?? 'review';
    if (mode !== 'review' && mode !== 'readonly') throw invalid('mode is review or readonly.');
    const ttl = body.ttl_seconds ?? EMBED_TTL.fallback;
    if (!Number.isInteger(ttl) || ttl < EMBED_TTL.min || ttl > EMBED_TTL.max) throw invalid(`ttl_seconds is a whole number from ${EMBED_TTL.min} to ${EMBED_TTL.max}.`);
    const theme = body.theme ?? 'system';
    if (!THEMES.includes(theme)) throw invalid('theme is light, dark or system.');
    if (body.user !== undefined && (typeof body.user !== 'string' || !USER_RE.test(body.user))) throw invalid('user is 1 to 64 letters, digits or ._@+- (it names the reviewer in the ledger).');
    if (body.branding !== undefined && typeof body.branding !== 'boolean') throw invalid('branding is true or false.');
    // A test desk always says it is one, and always says it is Grapim (review M10).
    if (platform.mode === 'test' && body.branding === false) throw invalid('branding cannot be turned off in test mode. Use a live key.');
    // The origins of the key's own mode (review M6).
    const allowed = keys.settings(platform.team.id, platform.mode).embed_allowed_origins;
    if (!allowed.length) throw invalid(`Set embed_allowed_origins for ${platform.mode} mode first, with PUT /v1/settings and a ${platform.mode} key.`);
    let parent = body.parent_origin;
    if (parent === undefined) {
      if (allowed.length !== 1) throw invalid('parent_origin is required when embed_allowed_origins has more than one origin.');
      parent = allowed[0];
    }
    if (typeof parent !== 'string' || !allowed.includes(parent.replace(/\/$/, ''))) throw invalid('parent_origin must be one of embed_allowed_origins.');
    parent = parent.replace(/\/$/, '');
    // Each session is a row kept until a day after it ends: bounded per platform (review M7).
    if (!hub.rate.hit(`embeds:${platform.team.id}`, MAX_EMBEDS_PER_HOUR, 60 * 60 * 1000)) {
      throw new HttpError(429, 'rate_limited', `At most ${MAX_EMBEDS_PER_HOUR} embed sessions an hour per platform.`, { retryAfter: hub.rate.retryAfter(`embeds:${platform.team.id}`) });
    }

    const id = `es_${randomId(12)}`;
    const secret = randomToken(32);
    const t = now();
    const expires = t + ttl * 1000;
    db.prepare(
      'INSERT INTO embed_sessions (id, team_id, workspace_id, mode, theme, parent_origin, user_name, brand, key_mode, url_hash, ttl_ms, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, ws.team_id, ws.id, mode, theme, parent, body.user ?? null, body.branding === false ? 0 : 1, platform.mode === 'test' ? 'test' : 'live', sha256(secret), ttl * 1000, t, expires);
    const link = sign(config.secret, 'embed', `${id}.${secret}`);
    return { id, object: 'embed_session', url: `${config.origin}/hub/embed/${link}`, expires_at: unix(expires), mode, theme, parent_origin: parent, branding: body.branding !== false };
  }

  const gone = (message) => new HttpError(410, 'embed_invalid', message);

  // The mode whose settings apply to a session: that of the key that created
  // it (for sessions from before that column, the workspace's: the same).
  const keyMode = (row, ws) => ((row.key_mode ?? ws?.mode) === 'test' ? 'test' : 'live');
  const testDesk = (row, ws) => keyMode(row, ws) === 'test' || ws?.mode === 'test';

  // GET /hub/embed/:token: once, before expires_at.
  function redeem(ctx) {
    const value = unsign(config.secret, 'embed', String(ctx.params.token ?? ''));
    const m = value && /^(es_[A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (!m) throw gone('This embed link is not valid.');
    const row = db.prepare('SELECT * FROM embed_sessions WHERE id = ?').get(m[1]);
    if (!row || !same(row.url_hash, sha256(m[2]))) throw gone('This embed link is not valid.');
    const t = now();
    if (row.used_at || row.expires_at <= t) throw gone('This embed link was already used or has expired. Ask the app for a new one.');
    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ? AND team_id = ? AND deleted_at IS NULL').get(row.workspace_id, row.team_id);
    const team = ws && db.prepare('SELECT kind FROM teams WHERE id = ?').get(ws.team_id);
    if (!ws || team?.kind !== 'platform') throw gone('This workspace no longer exists.');
    if (!keys.settings(row.team_id, keyMode(row, ws)).embed_allowed_origins.includes(row.parent_origin)) throw gone('This embed link is no longer allowed. Ask the app for a new one.');
    const cookieSecret = randomToken(32);
    const csrf = randomToken(24);
    const used = db
      .prepare('UPDATE embed_sessions SET used_at = ?, cookie_hash = ?, csrf = ?, cookie_expires_at = ? WHERE id = ? AND used_at IS NULL')
      .run(t, sha256(cookieSecret), csrf, t + row.ttl_ms, row.id);
    if (!used.changes) throw gone('This embed link was already used.');
    const base = `/w/${ws.team_id}/${ws.name}/`;
    const cookie = [
      `${COOKIE}=${row.id}.${cookieSecret}`,
      `Path=${base}`,
      `Max-Age=${Math.floor(row.ttl_ms / 1000)}`,
      'HttpOnly',
      'Secure',
      'SameSite=None',
      'Partitioned',
    ].join('; ');
    const q = new URLSearchParams({ embed: '1', theme: row.theme, mode: row.mode });
    if (!row.brand && !testDesk(row, ws)) q.set('brand', '0');
    const { res } = ctx;
    res.setHeader('Content-Security-Policy', `default-src 'none'; frame-ancestors ${row.parent_origin}; base-uri 'none'`);
    res.removeHeader('X-Frame-Options');
    res.writeHead(303, { Location: `${base}?${q}`, 'Set-Cookie': cookie, 'Cache-Control': 'no-store' });
    res.end();
  }

  // The principal for a /w/ request carrying a valid embed cookie for this
  // very workspace, else null (the mount then tries the hub session).
  function principal(cookies, where) {
    const raw = cookies?.[COOKIE];
    const m = typeof raw === 'string' && /^(es_[A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/.exec(raw);
    if (!m) return null;
    const row = db.prepare('SELECT * FROM embed_sessions WHERE id = ?').get(m[1]);
    if (!row?.cookie_hash || !same(row.cookie_hash, sha256(m[2])) || !(row.cookie_expires_at > now())) return null;
    const ws = workspaces.byName(where.team, where.name);
    if (!ws || ws.id !== row.workspace_id || ws.team_id !== row.team_id) return null;
    const team = db.prepare('SELECT kind FROM teams WHERE id = ?').get(ws.team_id);
    if (team?.kind !== 'platform') return null;
    // Taking an origin off embed_allowed_origins ends the sessions framed by
    // it at once: the platform's kill switch for a leaked link or a
    // compromised parent page (review L4).
    if (!keys.settings(row.team_id, keyMode(row, ws)).embed_allowed_origins.includes(row.parent_origin)) return null;
    const who = `embed:${row.user_name ?? row.id}`;
    // `session` has the shape the mount's CSRF header and identity code read.
    return { kind: 'embed', embed: row, ws, key: `e:${row.id}`, session: { csrf: row.csrf, user: { login: who } } };
  }

  // The mount's authorize() for an embed principal. sameOrigin is the
  // mount's own Origin/Sec-Fetch check.
  function authorize(req, info, who, sameOrigin) {
    if (info.kind !== 'mcp-tool') {
      const write = !READS.has(req.method);
      const dest = req.headers['sec-fetch-dest'];
      // The desk page itself is loaded by a navigation of the embedder's iframe (cross-site).
      const navigation = req.method === 'GET' && info.kind === 'asset' && req.headers['sec-fetch-mode'] === 'navigate' && (dest === undefined || dest === 'iframe' || dest === 'document');
      if (!navigation) sameOrigin(req, write);
      if (write && !same(headerText(req, 'x-grapim-csrf') ?? '', who.session.csrf)) throw refuse('This page expired. Reload it and try again.');
    }
    // An embedded desk never writes files: not over /fs, WebDAV or MCP. (WebDAV
    // also refuses cookies outright; this keeps the rule true here as well.)
    if (((info.kind === 'fs' || info.kind === 'dav') && info.write) || (info.kind === 'mcp-tool' && info.write)) {
      throw refuse(info.kind === 'mcp-tool' ? `An embedded review desk cannot call ${info.tool}.` : 'An embedded review desk cannot write files.');
    }
    if (who.embed.mode === 'readonly' && info.write) throw refuse('This review desk is read-only: it cannot undo, restore, review or branch.');
  }

  const deskCspFor = (who, csp) => csp.replace("frame-ancestors 'none'", `frame-ancestors ${who.embed.parent_origin}`);

  // The mount's securityHeaders() for an embed principal.
  function headers(res, who, { asset, csp, dataCsp }) {
    if (asset) {
      res.setHeader('Content-Security-Policy', deskCspFor(who, csp));
      res.removeHeader('X-Frame-Options');
    } else {
      res.setHeader('Content-Security-Policy', dataCsp);
    }
  }

  // The desk's index.html, with the embedding origin, mode and theme for the UI.
  function serveIndex(ctx, who, uiDir, csp) {
    const { req, res } = ctx;
    let page;
    try {
      page = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');
    } catch {
      throw new HttpError(404, 'not_found', 'The review desk is not built on this hub.');
    }
    const test = testDesk(who.embed, who.ws);
    const meta =
      `<meta name="grapim-embed-origin" content="${attr(who.embed.parent_origin)}">\n` +
      `<meta name="grapim-embed-mode" content="${attr(who.embed.mode)}">\n` +
      `<meta name="grapim-embed-theme" content="${attr(who.embed.theme)}">\n` +
      (test ? '<meta name="grapim-embed-test" content="1">\n' : '');
    page = /<head[^>]*>/i.test(page) ? page.replace(/<head[^>]*>\r?\n?/i, (h) => `${h.trimEnd()}\n${meta}`) : meta + page;
    // A test-mode desk (review M10) carries a banner the page itself draws,
    // so it shows whatever the desk's script does, and keeps its branding
    // whatever the URL says.
    if (test) page = /<body[^>]*>/i.test(page) ? page.replace(/<body[^>]*>/i, (b) => `${b}\n${TEST_BANNER}`) : TEST_BANNER + page;
    const buf = Buffer.from(page, 'utf8');
    res.setHeader('Content-Security-Policy', deskCspFor(who, csp));
    res.removeHeader('X-Frame-Options');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  }

  return { create, redeem, principal, authorize, headers, serveIndex, COOKIE };
}
