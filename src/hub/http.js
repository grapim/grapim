// Request and response helpers: bounded body reading, JSON and HTML replies,
// cookies, and the security headers every response carries.

export class HttpError extends Error {
  constructor(status, code, message, extra = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (message) => new HttpError(400, 'bad_request', message);
export const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);
export const forbidden = (message = 'Not allowed.') => new HttpError(403, 'forbidden', message);

// Same-origin only. No inline scripts or styles anywhere; the pages load
// /hub/static/hub.css and /hub/static/hub.js. Forms may lead to Stripe,
// because checkout and the billing portal are redirects after a POST.
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https://avatars.githubusercontent.com",
  "connect-src 'self'",
  "font-src 'self'",
  "media-src 'self'",
  "form-action 'self' https://github.com https://checkout.stripe.com https://billing.stripe.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

export function securityHeaders(res, { secure }) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // same-origin, not no-referrer: with no-referrer browsers send "Origin: null" on
  // form posts, which would defeat the Origin check. Referers never leave the hub.
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

export function sendHtml(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

// Reads the whole body, refusing once it passes `limit` bytes (413) instead
// of buffering an unbounded upload.
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, 'too_large', `Body over ${limit} bytes.`));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        reject(new HttpError(413, 'too_large', `Body over ${limit} bytes.`));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
    // A client that disconnects mid-body must not leave this pending forever
    // (the sync route holds an in-flight slot until it settles).
    req.on('close', () => {
      if (!done) {
        done = true;
        reject(new HttpError(400, 'aborted', 'The request body was cut off.'));
      }
    });
  });
}

export async function readForm(req, limit = 64 * 1024) {
  const type = String(req.headers['content-type'] || '');
  if (!type.startsWith('application/x-www-form-urlencoded')) throw badRequest('Expected a form post.');
  const raw = await readBody(req, limit);
  return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
}

export async function readJson(req, limit) {
  const type = String(req.headers['content-type'] || '');
  if (!type.startsWith('application/json')) throw badRequest('Expected Content-Type: application/json.');
  const raw = await readBody(req, limit);
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw badRequest('The body is not valid JSON.');
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {}
  }
  return out;
}

export function cookie(name, value, { maxAge, secure, httpOnly = true, sameSite = 'Lax', path = '/' }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// The address to rate limit by. Behind a proxy that appends to
// X-Forwarded-For, the last entry is the one the proxy saw; earlier entries
// are whatever the client claimed.
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return rateKey(xff[xff.length - 1]);
  }
  return rateKey(req.socket?.remoteAddress || 'unknown');
}

// One rate-limit key per client: an IPv4 address (IPv4-mapped IPv6 included),
// or the /64 of an IPv6 address, since one client usually holds a whole /64
// and could otherwise rotate through it to dodge every per-address limit.
export function rateKey(addr) {
  let a = String(addr).trim().toLowerCase();
  if (a.startsWith('[')) a = a.slice(1, a.indexOf(']') > 0 ? a.indexOf(']') : undefined);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1];
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(a)) return a.replace(/:\d+$/, '');
  if (!a.includes(':')) return a.slice(0, 64) || 'unknown';
  a = a.split('%')[0];
  const [head, tail = ''] = a.split('::');
  const h = head ? head.split(':') : [];
  const tl = a.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = a.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - tl.length)).fill('0'), ...tl] : h;
  if (groups.length < 4 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g) && !g.includes('.'))) return a.slice(0, 64);
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
