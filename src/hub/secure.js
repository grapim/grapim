// Small crypto helpers. Every secret comparison goes through `same`, which is
// constant time for equal-length inputs and hashes first so lengths never leak.

import crypto from 'node:crypto';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export const randomId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

export function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y) && a.length === b.length;
}

export const hmac = (secret, purpose, value) =>
  crypto.createHmac('sha256', secret).update(`${purpose}\n${value}`).digest('base64url');

// "value.signature", bound to a purpose so a signed value for one cookie
// cannot be replayed as another.
export const sign = (secret, purpose, value) => `${value}.${hmac(secret, purpose, value)}`;

export function unsign(secret, purpose, signed) {
  if (typeof signed !== 'string') return null;
  const dot = signed.lastIndexOf('.');
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  return same(signed.slice(dot + 1), hmac(secret, purpose, value)) ? value : null;
}
