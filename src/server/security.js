// Who may talk to the server.
//
// - Bound to anything but loopback, GRAPIM_TOKEN is required to start. When a
//   token is set (on loopback too: other users of the machine, review M6),
//   every request must send Authorization: Bearer <token>, compared in
//   constant time. Only the review desk's own static files load without it:
//   they hold no repo data, and the page cannot send a header before it loads.
// - The Host header must name this server (the bound host, localhost, or an
//   allowed name), so a web page cannot reach it through DNS rebinding.
// - A request that changes something (POST, PUT, DELETE) from a browser must
//   come from the page this server served, not from another site. A read
//   from another site is refused too (no SSE floods, no no-cors loads),
//   except a plain link to the review desk.

import crypto from 'node:crypto';
import os from 'node:os';
import { HttpError } from './http.js';

const MIN_TOKEN = 16;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const isLoopback = (host) => LOOPBACK.has(String(host).toLowerCase());
const bracket = (h) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);

// The token to require, or null. Throws if the host needs one and it is missing or short.
export function tokenFor(host, env, explicit) {
  const token = explicit ?? (env.GRAPIM_TOKEN || null);
  if (!token && !isLoopback(host)) {
    throw new Error(
      `Refusing to listen on ${host} without a token: anyone who can reach this machine could rewrite the repo. Set GRAPIM_TOKEN to a long random secret (${MIN_TOKEN}+ characters) and send it as Authorization: Bearer <token>, or leave --host at 127.0.0.1.`,
    );
  }
  if (token && token.length < MIN_TOKEN) throw new Error(`GRAPIM_TOKEN is too short: use at least ${MIN_TOKEN} random characters.`);
  return token;
}

// Host names a request may use to reach this server.
export function allowedHosts(host, env) {
  const set = new Set([...LOOPBACK, bracket(host.toLowerCase())]);
  if (host === '0.0.0.0' || host === '::') {
    set.add(os.hostname().toLowerCase());
    for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) set.add(bracket(a.address.toLowerCase()));
  }
  for (const h of String(env.GRAPIM_ALLOWED_HOSTS ?? '').split(',')) if (h.trim()) set.add(bracket(h.trim().toLowerCase()));
  return set;
}

// "example.com:7420" -> "example.com", "[::1]:7420" -> "[::1]".
function hostName(header) {
  const h = header.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

function checkToken(req, token) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  // Hashing both sides gives equal lengths, so timingSafeEqual never throws.
  if (!m || !crypto.timingSafeEqual(digest(m[1].trim()), digest(token))) {
    throw new HttpError('unauthorized', 'Send Authorization: Bearer <GRAPIM_TOKEN>.', { 'WWW-Authenticate': 'Bearer' });
  }
}

// `read`: a GET, HEAD or OPTIONS. Another site may still link to the review
// desk (a top-level navigation), but not fetch, embed or stream from it.
function checkOrigin(req, read) {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin.toLowerCase() !== `http://${req.headers.host.toLowerCase()}`) throw new HttpError('forbidden', `Cross-origin request from ${origin} refused.`);
    return;
  }
  const site = req.headers['sec-fetch-site'];
  const navigation = read && req.headers['sec-fetch-mode'] === 'navigate' && (req.headers['sec-fetch-dest'] ?? 'document') === 'document';
  if (site && site !== 'same-origin' && site !== 'none' && !navigation) throw new HttpError('forbidden', 'Cross-site request refused.');
}

// The peer is this machine (the socket's address, not a header).
export const isLoopbackAddress = (addr) => /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.test(String(addr ?? ''));

// WebDAV clients (Explorer, Finder, davfs2) only send a user name and a
// password: the token is the password, the name is ignored. Bearer works too.
function checkDavToken(req, token) {
  const auth = String(req.headers.authorization ?? '');
  let given = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? null;
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(auth)?.[1];
  if (basic) {
    const pair = Buffer.from(basic, 'base64').toString('utf8');
    given = pair.includes(':') ? pair.slice(pair.indexOf(':') + 1) : null;
  }
  if (given === null || !crypto.timingSafeEqual(digest(given), digest(token))) {
    throw new HttpError('unauthorized', 'Use any user name and GRAPIM_TOKEN as the password.', { 'WWW-Authenticate': 'Basic realm="Grapim"' });
  }
}

export function createGuard({ host, env, token }) {
  const hosts = allowedHosts(host, env);
  // asset: a GET of the desk's static files (not /api, /fs, /mcp or /dav).
  // dav: a WebDAV request (/dav): this machine only, since it is plain http
  // and the token would travel as a password; Basic auth when a token is set.
  return function guard(req, { asset = false, dav = false } = {}) {
    const h = req.headers.host;
    if (!h || !hosts.has(hostName(h))) throw new HttpError('forbidden', `Host "${h ?? ''}" is not this server. Use http://127.0.0.1 or http://localhost.`);
    if (dav && !isLoopbackAddress(req.socket?.remoteAddress)) {
      throw new HttpError('forbidden', 'WebDAV on grapim serve answers only this machine: mount http://127.0.0.1:<port>/dav/ here, or use a cloud workspace (https) from other machines.');
    }
    if (token && !asset) (dav ? checkDavToken : checkToken)(req, token);
    checkOrigin(req, ['GET', 'HEAD', 'OPTIONS', 'PROPFIND'].includes(req.method));
  };
}
