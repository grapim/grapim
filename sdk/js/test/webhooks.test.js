// verifyWebhook against signatures computed here, independently, from the
// contract's wording (docs/platform.md "Webhooks"):
//   Grapim-Signature: t=<unix>,v1=<hex hmac-sha256 of "t.body" with the endpoint secret>

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';

import { verifyWebhook, WebhookSignatureError, GrapimError } from '../src/index.js';

const secret = 'whsec_0123456789abcdef0123456789abcdef';
const event = {
  id: 'evt_123', type: 'run.started', created: 1762850000,
  workspace: { id: 'ws_1', external_id: 'cust_9' },
  data: { run: 'http:tok/fixer', note: 'naïve ünïcode ✓' },
};
const body = JSON.stringify(event);
const now = () => Math.floor(Date.now() / 1000);
const sign = (t, b = body, s = secret) => createHmac('sha256', s).update(`${t}.${b}`, 'utf8').digest('hex');
const header = (t, sig = sign(t)) => `t=${t},v1=${sig}`;

async function rejectsWith(p, code) {
  const e = await p.then(() => null, (x) => x);
  assert.ok(e instanceof WebhookSignatureError, `expected WebhookSignatureError, got ${e}`);
  assert.ok(e instanceof GrapimError);
  assert.equal(e.code, code);
}

describe('verifyWebhook', () => {
  test('accepts the contract format and returns the event (string body)', async () => {
    const t = now();
    assert.deepEqual(await verifyWebhook(body, header(t), secret), event);
  });

  test('accepts a Buffer, a Uint8Array and an ArrayBuffer body', async () => {
    const t = now();
    const buf = Buffer.from(body, 'utf8');
    assert.deepEqual(await verifyWebhook(buf, header(t), secret), event);
    assert.deepEqual(await verifyWebhook(new Uint8Array(buf), header(t), secret), event);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    assert.deepEqual(await verifyWebhook(ab, header(t), secret), event);
  });

  test('any matching v1 among several is enough (secret rotation); spaces and unknown keys are fine', async () => {
    const t = now();
    const h = `t=${t}, v1=${sign(t, body, 'whsec_old')}, v0=abc, v1=${sign(t)}`;
    assert.deepEqual(await verifyWebhook(body, h, secret), event);
    assert.deepEqual(await verifyWebhook(body, [`t=${t}`, `v1=${sign(t).toUpperCase()}`], secret), event);
  });

  test('refuses a wrong secret, a changed body or a changed timestamp', async () => {
    const t = now();
    await rejectsWith(verifyWebhook(body, header(t), 'whsec_wrong'), 'invalid_signature');
    await rejectsWith(verifyWebhook(body.replace('cust_9', 'cust_8'), header(t), secret), 'invalid_signature');
    await rejectsWith(verifyWebhook(body, `t=${t - 1},v1=${sign(t)}`, secret), 'invalid_signature');
    await rejectsWith(verifyWebhook(body, `t=${t},v1=${sign(t).slice(0, 63)}`, secret), 'invalid_signature');
  });

  test('refuses a timestamp outside the tolerance, both ways; tolerance 0 turns the check off', async () => {
    const old = now() - 301;
    await rejectsWith(verifyWebhook(body, header(old), secret), 'timestamp_out_of_tolerance');
    await rejectsWith(verifyWebhook(body, header(now() + 400), secret), 'timestamp_out_of_tolerance');
    assert.deepEqual(await verifyWebhook(body, header(old), secret, { tolerance: 600 }), event);
    assert.deepEqual(await verifyWebhook(body, header(1), secret, { tolerance: 0 }), event);
    assert.deepEqual(await verifyWebhook(body, header(1000), secret, { now: 1100 }), event);
  });

  test('refuses a missing or malformed header, a missing secret and a parsed body', async () => {
    await rejectsWith(verifyWebhook(body, undefined, secret), 'invalid_header');
    await rejectsWith(verifyWebhook(body, 'v1=abc', secret), 'invalid_header');
    await rejectsWith(verifyWebhook(body, `t=${now()}`, secret), 'invalid_header');
    await rejectsWith(verifyWebhook(body, `t=abc,v1=${sign(now())}`, secret), 'invalid_header');
    await rejectsWith(verifyWebhook(body, header(now()), ''), 'invalid_secret');
    await rejectsWith(verifyWebhook(event, header(now()), secret), 'invalid_body');
  });

  test('works through node:crypto when there is no Web Crypto', async () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
    try {
      assert.equal(globalThis.crypto, undefined);
      const t = now();
      assert.deepEqual(await verifyWebhook(body, header(t), secret), event);
      await rejectsWith(verifyWebhook(body, header(t), 'whsec_wrong'), 'invalid_signature');
    } finally {
      Object.defineProperty(globalThis, 'crypto', desc);
    }
  });
});
