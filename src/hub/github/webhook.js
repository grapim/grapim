// Webhook verification and delivery dedupe.
//
// The signature is checked over the raw bytes, before anything parses them:
// X-Hub-Signature-256 = "sha256=" + hex HMAC-SHA256(secret, body), compared in
// constant time. Delivery ids already seen (kept 7 days) are no-ops.

import crypto from 'node:crypto';

export const DELIVERY_DAYS = 7;
const DELIVERY_MS = DELIVERY_DAYS * 24 * 60 * 60 * 1000;

export function signBody(secret, raw) {
  return `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
}

export function verifySignature(secret, raw, header) {
  if (!secret || !Buffer.isBuffer(raw) || typeof header !== 'string' || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest();
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export const validDeliveryId = (id) => typeof id === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(id);

export class Deliveries {
  constructor({ db, now }) {
    this.db = db;
    this.now = now;
    this.lastSweep = 0;
  }

  // True the first time a delivery id is seen, false for a redelivery.
  first(id) {
    const t = this.now();
    if (t - this.lastSweep > 60 * 60 * 1000) {
      this.lastSweep = t;
      this.sweep();
    }
    return this.db.prepare('INSERT OR IGNORE INTO gh_deliveries (id, received_at) VALUES (?, ?)').run(id, t).changes === 1;
  }

  sweep() {
    this.db.prepare('DELETE FROM gh_deliveries WHERE received_at < ?').run(this.now() - DELIVERY_MS);
  }
}
