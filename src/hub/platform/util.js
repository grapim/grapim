// Small helpers shared by the platform modules.

import crypto from 'node:crypto';
import { HttpError } from '../http.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

// YYYY-MM-DD in UTC.
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export const unix = (ms) => (ms === null || ms === undefined ? null : Math.floor(ms / 1000));

export const apiError = (status, code, message) => new HttpError(status, code, message);
export const invalid = (message) => apiError(400, 'invalid_request', message);

// AES-256-GCM with a key derived from HUB_SECRET, for the few secrets the hub
// must be able to read back (webhook signing secrets, idempotent replies that
// carry a token). Rotating HUB_SECRET makes them unreadable.
//
// `aad` names the row a value belongs to (its table, platform and id) and is
// authenticated, so a sealed value copied into another row or another
// platform's row does not open (security review 2026-11-11, M1). v1 values
// (no binding) are refused.
//
// `purpose` derives a separate key per use (the SaaS connectors' tokens use
// their own), so a value sealed for one never opens as another's.
export function sealer(secret, purpose = 'grapim platform seal v1') {
  const key = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from(purpose), 32));
  const bind = (aad) => {
    if (typeof aad !== 'string' || !aad) throw new Error('sealer: aad is required');
    return Buffer.from(`grapim seal v2\n${aad}`, 'utf8');
  };
  return {
    seal(text, aad) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(bind(aad));
      const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return `v2.${Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64url')}`;
    },
    open(sealed, aad) {
      if (typeof sealed !== 'string' || !sealed.startsWith('v2.')) return null;
      try {
        const buf = Buffer.from(sealed.slice(3), 'base64url');
        if (buf.length < 28) return null;
        const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
        d.setAAD(bind(aad));
        d.setAuthTag(buf.subarray(buf.length - 16));
        return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
  };
}

// ?limit= (1 to 100, default 50).
export function limitOf(q, { fallback = 50, max = 100 } = {}) {
  const raw = q.get('limit');
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw invalid(`limit must be a whole number from 1 to ${max}.`);
  return n;
}

// Cursor pagination over a list already in order: items after the one whose
// key is `starting_after`. An unknown cursor is a 400, never a silent restart.
export function page(items, q, keyOf, opts) {
  const limit = limitOf(q, opts);
  const after = q.get('starting_after');
  let start = 0;
  if (after !== null && after !== '') {
    const i = items.findIndex((x) => keyOf(x) === after);
    if (i < 0) throw invalid('starting_after is not an item of this list.');
    start = i + 1;
  }
  const data = items.slice(start, start + limit);
  return { object: 'list', data, has_more: start + limit < items.length };
}

// The body fields a request may carry; anything else is a 400, so a typo is
// never silently ignored.
export function onlyFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Send a JSON object.');
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw invalid(`Unknown field ${k}. Allowed: ${allowed.join(', ')}.`);
  return body;
}

// An origin people may embed the desk in: https, or http on localhost for
// development. Returned in its canonical form (scheme://host[:port]).
export function cleanOrigin(raw) {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  // The origin goes into a CSP header (frame-ancestors) as a source
  // expression. WHATWG hosts may hold `*`, `;`, `,` and quotes, which would
  // be a wildcard (`https://*` lets every site frame the desk) or split the
  // header into other directives. Only plain DNS names, IPv4 and [IPv6].
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])$/.test(u.hostname)) return null;
  if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
  if (raw.replace(/\/$/, '') !== u.origin) return null;
  return u.origin;
}
