// Webhook signatures, as docs/platform.md specifies:
//
//   Grapim-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<raw body>" with the endpoint secret>
//
// The HMAC key is the endpoint secret exactly as shown at creation (the whole
// `whsec_…` string, UTF-8). Several v1= entries may appear (for example while
// a secret rotates); any one matching is enough. Uses Web Crypto when the
// runtime has it, node:crypto otherwise. The comparison is constant time.

import { WebhookSignatureError } from './errors.js';

const enc = new TextEncoder();

function bodyBytes(raw) {
  if (typeof raw === 'string') return enc.encode(raw);
  if (raw instanceof Uint8Array) return raw; // Buffer is a Uint8Array
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  throw new WebhookSignatureError(
    'verifyWebhook needs the raw request body (a string, Buffer or Uint8Array), not parsed JSON: re-serialising changes the bytes and the signature will not match.',
    { code: 'invalid_body' },
  );
}

/** Parses `t=…,v1=…[,v1=…]`. Unknown keys are ignored, so later schemes can be added. */
export function parseSignatureHeader(header) {
  const h = Array.isArray(header) ? header.join(',') : header;
  if (typeof h !== 'string' || !h.trim()) return null;
  let t = null;
  const v1 = [];
  for (const part of h.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') v1.push(v.toLowerCase());
  }
  if (t === null || !/^\d{1,12}$/.test(t)) return null;
  return { t: Number(t), signed: t, v1 };
}

async function hmacHex(keyBytes, data) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await subtle.sign('HMAC', key, data));
    let s = '';
    for (const b of sig) s += b.toString(16).padStart(2, '0');
    return s;
  }
  const spec = 'node:crypto';
  const { createHmac } = await import(spec);
  return createHmac('sha256', keyBytes).update(data).digest('hex');
}

/** Constant-time equality of two strings of the same length; a length mismatch is false (lengths are public). */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifies a webhook delivery and returns the parsed event.
 * Throws WebhookSignatureError when the header is missing or malformed, no
 * signature matches, or the timestamp is more than `tolerance` seconds away
 * from now (either direction; 0 turns the age check off).
 *
 * @param {string|Uint8Array|ArrayBuffer} rawBody  the body exactly as received
 * @param {string|string[]|null|undefined} header  the Grapim-Signature header
 * @param {string} secret                          the endpoint secret (whsec_…)
 * @param {{ tolerance?: number, now?: number }} [options]  seconds; `now` is unix seconds, for tests
 */
export async function verifyWebhook(rawBody, header, secret, options = {}) {
  const tolerance = options.tolerance ?? 300;
  if (typeof secret !== 'string' || !secret) throw new WebhookSignatureError('No webhook secret given.', { code: 'invalid_secret' });
  const body = bodyBytes(rawBody);
  const parsed = parseSignatureHeader(header);
  if (!parsed) throw new WebhookSignatureError('Missing or malformed Grapim-Signature header (expected t=<unix>,v1=<hex>).', { code: 'invalid_header' });
  if (parsed.v1.length === 0) throw new WebhookSignatureError('The Grapim-Signature header has no v1 signature.', { code: 'invalid_header' });
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (tolerance > 0 && Math.abs(now - parsed.t) > tolerance) {
    throw new WebhookSignatureError(`The webhook timestamp is ${Math.abs(now - parsed.t)} s away from now, over the ${tolerance} s tolerance.`, { code: 'timestamp_out_of_tolerance' });
  }
  const prefix = enc.encode(parsed.signed + '.');
  const data = new Uint8Array(prefix.length + body.length);
  data.set(prefix, 0);
  data.set(body, prefix.length);
  const expected = await hmacHex(enc.encode(secret), data);
  let ok = false;
  for (const candidate of parsed.v1) ok = timingSafeEqual(expected, candidate) || ok;
  if (!ok) throw new WebhookSignatureError('No signature in the Grapim-Signature header matches this body and secret.', { code: 'invalid_signature' });
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    throw new WebhookSignatureError('The signature is valid but the body is not JSON.', { code: 'invalid_body' });
  }
}
