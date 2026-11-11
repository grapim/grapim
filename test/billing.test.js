// Hub billing: plan limits, past-due grace, Stripe Checkout and Portal requests,
// webhook signatures and event mapping. No network: fetch is injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  BillingError, GRACE_MS, PLANS, createBilling, effectivePlan, limitsFor,
} from '../src/hub/billing.js';

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const NOW_S = Math.floor(NOW / 1000);
const DAY = 24 * 60 * 60 * 1000;
const SECRET = 'whsec_test_secret';

const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_51abcdefSECRET',
  STRIPE_PRICE_TEAM_MONTH: 'price_team_month',
  STRIPE_PRICE_TEAM_YEAR: 'price_team_year',
  STRIPE_WEBHOOK_SECRET: SECRET,
};

function fakeStripe(reply = { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }, status = 200) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, form: Object.fromEntries(new URLSearchParams(init.body)) });
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const sign = (body, t = NOW_S, secret = SECRET) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
const header = (body, t = NOW_S, secret = SECRET) => `t=${t},v1=${sign(body, t, secret)}`;

function recorder() {
  const calls = [];
  return { calls, setPlan: async (teamId, update) => { calls.push([teamId, update]); } };
}

// Signs and delivers one event; returns the result and every setPlan call.
async function deliver(event, extra = {}) {
  const body = JSON.stringify({ id: 'evt_1', object: 'event', created: NOW_S - 2, livemode: false, ...event });
  const rec = recorder();
  const billing = createBilling({ env: ENV, fetch: () => assert.fail('webhooks must not call Stripe') });
  const result = await billing.handleWebhook(Buffer.from(body), header(body), { setPlan: rec.setPlan, now: NOW, ...extra });
  return { result, calls: rec.calls };
}

const rejects = (promise, code) => assert.rejects(promise, (err) => {
  assert.ok(err instanceof BillingError, `expected BillingError, got ${err}`);
  assert.equal(err.code, code);
  return true;
});

// ---- limits ----

test('limits per plan, with unknown plans on free', () => {
  assert.deepEqual(limitsFor('free'), { seats: 3, historyDays: 7, repos: 2 });
  assert.deepEqual(limitsFor('team'), { seats: Infinity, historyDays: 90, repos: Infinity });
  assert.deepEqual(limitsFor('team', { seats: 12 }), { seats: 12, historyDays: 90, repos: Infinity });
  assert.deepEqual(limitsFor('enterprise'), { seats: Infinity, historyDays: 365, repos: Infinity });
  for (const unknown of ['gold', '', undefined, null, '__proto__', 'toString']) {
    assert.deepEqual(limitsFor(unknown), limitsFor('free'), String(unknown));
  }
  // purchased seats only apply to team
  assert.equal(limitsFor('free', { seats: 50 }).seats, 3);
  // callers get a copy, not the table
  limitsFor('free').seats = 99;
  assert.equal(PLANS.free.seats, 3);
});

test('the plan table holds the prices and their env vars', () => {
  assert.deepEqual(PLANS.team.price.perSeat, { month: 20, year: 192 });
  assert.deepEqual(PLANS.team.price.env, { month: 'STRIPE_PRICE_TEAM_MONTH', year: 'STRIPE_PRICE_TEAM_YEAR' });
  assert.equal(PLANS.enterprise.price, 'contact sales');
});

// ---- effectivePlan ----

test('effectivePlan keeps a past-due team on its plan for 7 days, then free', () => {
  const pastDue = (since) => ({ plan: 'team', plan_status: 'past_due', past_due_since: since });
  assert.equal(effectivePlan(pastDue(NOW - 1 * DAY), NOW), 'team');
  assert.equal(effectivePlan(pastDue(NOW - 7 * DAY + 1), NOW), 'team');
  assert.equal(effectivePlan(pastDue(NOW - GRACE_MS), NOW), 'free');
  assert.equal(effectivePlan(pastDue(NOW - 30 * DAY), NOW), 'free');
  assert.equal(effectivePlan({ plan: 'team', plan_status: 'unpaid', past_due_since: NOW - 2 * DAY }, NOW), 'team');
  assert.equal(effectivePlan({ plan: 'team', plan_status: 'unpaid', past_due_since: NOW - 8 * DAY }, NOW), 'free');
  // camelCase fields, Date and ISO inputs
  assert.equal(effectivePlan({ plan: 'team', planStatus: 'past_due', pastDueSince: new Date(NOW - DAY) }, new Date(NOW)), 'team');
  assert.equal(effectivePlan(pastDue(new Date(NOW - 8 * DAY).toISOString()), NOW), 'free');
  // past due with no start recorded: no grace
  assert.equal(effectivePlan({ plan: 'team', plan_status: 'past_due' }, NOW), 'free');
});

test('effectivePlan by status and plan', () => {
  assert.equal(effectivePlan({ plan: 'team', plan_status: 'active' }, NOW), 'team');
  assert.equal(effectivePlan({ plan: 'team', plan_status: 'trialing' }, NOW), 'team');
  assert.equal(effectivePlan({ plan: 'enterprise' }, NOW), 'enterprise');
  for (const status of ['canceled', 'incomplete', 'incomplete_expired', 'paused']) {
    assert.equal(effectivePlan({ plan: 'team', plan_status: status, past_due_since: NOW }, NOW), 'free', status);
  }
  assert.equal(effectivePlan({ plan: 'gold', plan_status: 'active' }, NOW), 'free');
  assert.equal(effectivePlan({ plan: 'free', plan_status: 'active' }, NOW), 'free');
  assert.equal(effectivePlan(null, NOW), 'free');
  assert.equal(effectivePlan(undefined, NOW), 'free');
});

// ---- checkout ----

test('checkout for a new customer: subscription mode, seats as quantity, team reference and metadata', async () => {
  const stripe = fakeStripe();
  const billing = createBilling({ env: ENV, fetch: stripe.fetch });
  const out = await billing.createCheckout({
    team: { id: 'team_1' }, user: { id: 'user_9', email: 'ana@example.com' }, seats: 5, interval: 'month',
    successUrl: 'https://hub.example/billing/done?s={CHECKOUT_SESSION_ID}', cancelUrl: 'https://hub.example/billing',
  });
  assert.deepEqual(out, { url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
  assert.equal(stripe.calls.length, 1);
  const [call] = stripe.calls;
  assert.equal(call.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, `Bearer ${ENV.STRIPE_SECRET_KEY}`);
  assert.equal(call.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.match(call.init.headers['Idempotency-Key'], /^grapim-checkout-[0-9a-f-]{36}$/);
  assert.deepEqual(call.form, {
    mode: 'subscription',
    'line_items[0][price]': 'price_team_month',
    'line_items[0][quantity]': '5',
    success_url: 'https://hub.example/billing/done?s={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://hub.example/billing',
    client_reference_id: 'team_1',
    'metadata[team_id]': 'team_1',
    'metadata[seats]': '5',
    'metadata[user_id]': 'user_9',
    'subscription_data[metadata][team_id]': 'team_1',
    customer_email: 'ana@example.com',
  });
});

test('checkout reuses the team\'s Stripe customer and uses the yearly price', async () => {
  const stripe = fakeStripe();
  const billing = createBilling({ env: ENV, fetch: stripe.fetch });
  await billing.createCheckout({
    team: { id: 'team_2', stripe_customer_id: 'cus_123' }, user: { id: 'u', email: 'ana@example.com' }, seats: 12, interval: 'year',
    successUrl: 'https://hub.example/ok', cancelUrl: 'https://hub.example/no', idempotencyKey: 'fixed-key',
  });
  const [call] = stripe.calls;
  assert.equal(call.init.headers['Idempotency-Key'], 'fixed-key');
  assert.deepEqual(call.form, {
    mode: 'subscription',
    'line_items[0][price]': 'price_team_year',
    'line_items[0][quantity]': '12',
    success_url: 'https://hub.example/ok',
    cancel_url: 'https://hub.example/no',
    client_reference_id: 'team_2',
    'metadata[team_id]': 'team_2',
    'metadata[seats]': '12',
    'metadata[user_id]': 'u',
    'subscription_data[metadata][team_id]': 'team_2',
    customer: 'cus_123',
  });
});

test('each checkout gets its own idempotency key', async () => {
  const stripe = fakeStripe();
  const billing = createBilling({ env: ENV, fetch: stripe.fetch });
  const args = { team: { id: 't' }, seats: 1, interval: 'month', successUrl: 'https://a', cancelUrl: 'https://b' };
  await billing.createCheckout(args);
  await billing.createCheckout(args);
  assert.notEqual(stripe.calls[0].init.headers['Idempotency-Key'], stripe.calls[1].init.headers['Idempotency-Key']);
});

test('checkout rejects bad input and missing config before calling Stripe', async () => {
  const stripe = fakeStripe();
  const billing = createBilling({ env: ENV, fetch: stripe.fetch });
  const ok = { team: { id: 't' }, seats: 2, interval: 'month', successUrl: 'https://a', cancelUrl: 'https://b' };
  await rejects(billing.createCheckout({ ...ok, seats: 0 }), 'bad_request');
  await rejects(billing.createCheckout({ ...ok, seats: 2.5 }), 'bad_request');
  await rejects(billing.createCheckout({ ...ok, interval: 'week' }), 'bad_request');
  await rejects(billing.createCheckout({ ...ok, team: {} }), 'bad_request');
  await rejects(billing.createCheckout({ ...ok, cancelUrl: '' }), 'bad_request');
  const noPrice = createBilling({ env: { ...ENV, STRIPE_PRICE_TEAM_YEAR: '' }, fetch: stripe.fetch });
  await rejects(noPrice.createCheckout({ ...ok, interval: 'year' }), 'not_configured');
  const noKey = createBilling({ env: { ...ENV, STRIPE_SECRET_KEY: undefined }, fetch: stripe.fetch });
  await rejects(noKey.createCheckout(ok), 'not_configured');
  const publishable = createBilling({ env: { ...ENV, STRIPE_SECRET_KEY: 'pk_test_abc' }, fetch: stripe.fetch });
  await rejects(publishable.createCheckout(ok), 'not_configured');
  assert.equal(stripe.calls.length, 0);
});

test('a Stripe error becomes a BillingError without the key in it', async () => {
  const stripe = fakeStripe({ error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such price: price_team_month' } }, 400);
  const billing = createBilling({ env: ENV, fetch: stripe.fetch });
  await assert.rejects(
    billing.createCheckout({ team: { id: 't' }, seats: 1, interval: 'month', successUrl: 'https://a', cancelUrl: 'https://b' }),
    (err) => {
      assert.equal(err.code, 'stripe_error');
      assert.equal(err.status, 400);
      assert.equal(err.stripeCode, 'resource_missing');
      assert.match(err.message, /No such price/);
      assert.doesNotMatch(JSON.stringify({ ...err, message: err.message, stack: err.stack }), /sk_test_51abcdefSECRET/);
      return true;
    },
  );
  const down = createBilling({ env: ENV, fetch: async () => { throw new TypeError('fetch failed'); } });
  await rejects(down.createPortal({ team: { stripe_customer_id: 'cus_1' }, returnUrl: 'https://a' }), 'stripe_unreachable');
});

// ---- portal ----

test('portal opens a Billing Portal session for the team\'s customer', async () => {
  const stripe = fakeStripe({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/test_1' });
  const billing = createBilling({ env: ENV, fetch: stripe.fetch });
  const out = await billing.createPortal({ team: { id: 'team_1', stripe_customer_id: 'cus_123' }, returnUrl: 'https://hub.example/settings' });
  assert.deepEqual(out, { url: 'https://billing.stripe.com/p/session/test_1' });
  const [call] = stripe.calls;
  assert.equal(call.url, 'https://api.stripe.com/v1/billing_portal/sessions');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, `Bearer ${ENV.STRIPE_SECRET_KEY}`);
  assert.match(call.init.headers['Idempotency-Key'], /^grapim-portal-/);
  assert.deepEqual(call.form, { customer: 'cus_123', return_url: 'https://hub.example/settings' });
});

test('portal needs a Stripe customer', async () => {
  const stripe = fakeStripe();
  const billing = createBilling({ env: ENV, fetch: stripe.fetch });
  await rejects(billing.createPortal({ team: { id: 'team_1' }, returnUrl: 'https://a' }), 'no_customer');
  assert.equal(stripe.calls.length, 0);
});

// ---- live keys ----

test('a live key is refused unless STRIPE_ALLOW_LIVE=1', async () => {
  const checkout = { team: { id: 't' }, seats: 1, interval: 'month', successUrl: 'https://a', cancelUrl: 'https://b' };
  const portal = { team: { stripe_customer_id: 'cus_1' }, returnUrl: 'https://a' };
  for (const key of ['sk_live_51SECRETVALUE', 'rk_live_51SECRETVALUE']) {
    const stripe = fakeStripe();
    for (const allow of [undefined, '0', 'true', 'yes']) {
      const billing = createBilling({ env: { ...ENV, STRIPE_SECRET_KEY: key, STRIPE_ALLOW_LIVE: allow }, fetch: stripe.fetch });
      await assert.rejects(billing.createCheckout(checkout), (err) => {
        assert.equal(err.code, 'live_key_refused');
        assert.doesNotMatch(err.message, /SECRETVALUE/);
        return true;
      });
      await rejects(billing.createPortal(portal), 'live_key_refused');
    }
    assert.equal(stripe.calls.length, 0, 'no request may leave with a refused live key');

    const allowed = createBilling({ env: { ...ENV, STRIPE_SECRET_KEY: key, STRIPE_ALLOW_LIVE: '1' }, fetch: stripe.fetch });
    await allowed.createCheckout(checkout);
    assert.equal(stripe.calls.length, 1);
  }
});

// ---- webhook signatures ----

const SIGNED = JSON.stringify({ id: 'evt_x', type: 'ping.unhandled', created: NOW_S, data: { object: {} } });

async function verify(body, sigHeader, { env = ENV, now = NOW } = {}) {
  const rec = recorder();
  const billing = createBilling({ env, fetch: () => assert.fail('no network') });
  const result = await billing.handleWebhook(body, sigHeader, { setPlan: rec.setPlan, now });
  return { result, calls: rec.calls };
}

test('webhook: a valid signature is accepted, from a Buffer or a string', async () => {
  const { result } = await verify(Buffer.from(SIGNED), header(SIGNED));
  assert.deepEqual(result, { handled: false, type: 'ping.unhandled' });
  assert.deepEqual((await verify(SIGNED, header(SIGNED))).result, { handled: false, type: 'ping.unhandled' });
  // 4 minutes old is inside the tolerance
  const t = NOW_S - 240;
  assert.equal((await verify(Buffer.from(SIGNED), header(SIGNED, t))).result.handled, false);
});

test('webhook: a signature made with the wrong secret is rejected', async () => {
  await rejects(verify(Buffer.from(SIGNED), header(SIGNED, NOW_S, 'whsec_someone_else')), 'bad_signature');
});

test('webhook: a tampered body is rejected', async () => {
  const sig = header(SIGNED);
  const tampered = SIGNED.replace('ping.unhandled', 'customer.subscription.deleted');
  await rejects(verify(Buffer.from(tampered), sig), 'bad_signature');
  // and a body re-serialised by a JSON parser no longer matches either
  const reserialised = JSON.stringify(JSON.parse(SIGNED), null, 2);
  await rejects(verify(Buffer.from(reserialised), sig), 'bad_signature');
});

test('webhook: an old (replayed) or future timestamp is rejected even with a valid signature', async () => {
  await rejects(verify(Buffer.from(SIGNED), header(SIGNED, NOW_S - 301)), 'bad_signature');
  await rejects(verify(Buffer.from(SIGNED), header(SIGNED, NOW_S - 24 * 3600)), 'bad_signature');
  await rejects(verify(Buffer.from(SIGNED), header(SIGNED, NOW_S + 301)), 'bad_signature');
  // the same delivery replayed later
  const sig = header(SIGNED);
  await verify(Buffer.from(SIGNED), sig);
  await rejects(verify(Buffer.from(SIGNED), sig, { now: NOW + 10 * 60 * 1000 }), 'bad_signature');
});

test('webhook: any one of several v1 signatures may match', async () => {
  const good = sign(SIGNED);
  const old = sign(SIGNED, NOW_S, 'whsec_rotated_out');
  for (const h of [
    `t=${NOW_S},v1=${old},v1=${good}`,
    `t=${NOW_S},v1=${good},v1=${old}`,
    `t=${NOW_S},v0=${'0'.repeat(64)},v1=nothex,v1=${good}`,
    ` t=${NOW_S} , v1=${good} `,
  ]) {
    assert.equal((await verify(Buffer.from(SIGNED), h)).result.type, 'ping.unhandled', h);
  }
  await rejects(verify(Buffer.from(SIGNED), `t=${NOW_S},v1=${old},v1=${'a'.repeat(64)}`), 'bad_signature');
  // v0 (or any other scheme) alone never counts
  await rejects(verify(Buffer.from(SIGNED), `t=${NOW_S},v0=${good}`), 'bad_signature');
});

test('webhook: a missing or malformed header is rejected and setPlan never runs', async () => {
  const body = JSON.stringify({ type: 'customer.subscription.deleted', created: NOW_S, data: { object: { id: 'sub_1', metadata: { team_id: 't' } } } });
  for (const h of [undefined, null, '', 'garbage', `v1=${sign(body)}`, `t=${NOW_S}`, `t=abc,v1=${sign(body)}`, `t=${NOW_S},v1=${sign(body).slice(0, 63)}`]) {
    const rec = recorder();
    const billing = createBilling({ env: ENV });
    await rejects(billing.handleWebhook(Buffer.from(body), h, { setPlan: rec.setPlan, now: NOW }), 'bad_signature');
    assert.equal(rec.calls.length, 0, String(h));
  }
});

test('webhook: missing secret or a parsed body are wiring errors, not bad signatures', async () => {
  const rec = recorder();
  await rejects(createBilling({ env: { ...ENV, STRIPE_WEBHOOK_SECRET: '' } }).handleWebhook(Buffer.from(SIGNED), header(SIGNED), { setPlan: rec.setPlan, now: NOW }), 'not_configured');
  await rejects(createBilling({ env: ENV }).handleWebhook(JSON.parse(SIGNED), header(SIGNED), { setPlan: rec.setPlan, now: NOW }), 'bad_request');
});

// ---- webhook events ----

const subscription = (over = {}) => ({
  id: 'sub_1',
  object: 'subscription',
  customer: 'cus_1',
  status: 'active',
  metadata: { team_id: 'team_1' },
  current_period_start: NOW_S - 86400,
  current_period_end: NOW_S + 29 * 86400,
  items: { data: [{ id: 'si_1', quantity: 5, price: { id: 'price_team_month' } }] },
  ...over,
});

test('checkout.session.completed sets the team plan from the session', async () => {
  const { result, calls } = await deliver({
    type: 'checkout.session.completed',
    data: { object: {
      id: 'cs_1', object: 'checkout.session', mode: 'subscription', payment_status: 'paid',
      client_reference_id: 'team_1', metadata: { team_id: 'team_1', seats: '5', user_id: 'u' },
      customer: 'cus_1', subscription: 'sub_1',
    } },
  });
  assert.deepEqual(result, { handled: true, type: 'checkout.session.completed', teamId: 'team_1' });
  assert.deepEqual(calls, [['team_1', {
    plan: 'team', seats: 5, status: 'active', customerId: 'cus_1', subscriptionId: 'sub_1',
    periodEnd: null, pastDueSince: null, eventAt: (NOW_S - 2) * 1000,
  }]]);
});

test('checkout.session.completed: unpaid is incomplete; payment mode is ignored', async () => {
  const unpaid = await deliver({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', payment_status: 'unpaid', metadata: { team_id: 'team_7' }, customer: { id: 'cus_7' }, subscription: { id: 'sub_7' } } } });
  assert.equal(unpaid.calls[0][0], 'team_7');
  assert.equal(unpaid.calls[0][1].status, 'incomplete');
  assert.equal(unpaid.calls[0][1].customerId, 'cus_7');
  assert.equal(unpaid.calls[0][1].subscriptionId, 'sub_7');
  const payment = await deliver({ type: 'checkout.session.completed', data: { object: { mode: 'payment', client_reference_id: 'team_1' } } });
  assert.deepEqual(payment.result, { handled: false, type: 'checkout.session.completed', reason: 'not_a_subscription' });
  assert.equal(payment.calls.length, 0);
});

test('customer.subscription.created maps quantity, status and period end', async () => {
  const { result, calls } = await deliver({ type: 'customer.subscription.created', data: { object: subscription() } });
  assert.equal(result.handled, true);
  assert.deepEqual(calls, [['team_1', {
    plan: 'team', seats: 5, status: 'active', customerId: 'cus_1', subscriptionId: 'sub_1',
    periodEnd: (NOW_S + 29 * 86400) * 1000, pastDueSince: null, eventAt: (NOW_S - 2) * 1000,
  }]]);
});

test('customer.subscription.updated: seat change, past_due with the newer API shape, enterprise metadata', async () => {
  const seats = await deliver({ type: 'customer.subscription.updated', data: { object: subscription({ items: { data: [{ quantity: 9 }] }, current_period_start: undefined, current_period_end: undefined }) } });
  assert.equal(seats.calls[0][1].seats, 9);
  assert.equal(seats.calls[0][1].periodEnd, null);

  // API 2025-03-31+: the period lives on the subscription item
  const periodStart = NOW_S - 3 * 86400;
  const basil = subscription({
    status: 'past_due', current_period_start: undefined, current_period_end: undefined,
    items: { data: [{ quantity: 5, current_period_start: periodStart, current_period_end: periodStart + 30 * 86400 }] },
  });
  const pastDue = await deliver({ type: 'customer.subscription.updated', data: { object: basil } });
  assert.deepEqual(pastDue.calls, [['team_1', {
    plan: 'team', seats: 5, status: 'past_due', customerId: 'cus_1', subscriptionId: 'sub_1',
    periodEnd: (periodStart + 30 * 86400) * 1000, pastDueSince: periodStart * 1000, eventAt: (NOW_S - 2) * 1000,
  }]]);
  // and the team keeps Team for the rest of its 7 days
  const team = { plan: 'team', plan_status: 'past_due', past_due_since: pastDue.calls[0][1].pastDueSince };
  assert.equal(effectivePlan(team, NOW), 'team');
  assert.equal(effectivePlan(team, NOW + 5 * DAY), 'free');

  const ent = await deliver({ type: 'customer.subscription.updated', data: { object: subscription({ metadata: { team_id: 'team_e', plan: 'enterprise' } }) } });
  assert.equal(ent.calls[0][0], 'team_e');
  assert.equal(ent.calls[0][1].plan, 'enterprise');
});

test('customer.subscription.deleted puts the team on free', async () => {
  const { result, calls } = await deliver({ type: 'customer.subscription.deleted', data: { object: subscription({ status: 'canceled' }) } });
  assert.equal(result.handled, true);
  assert.deepEqual(calls, [['team_1', {
    plan: 'free', seats: 5, status: 'canceled', customerId: 'cus_1', subscriptionId: 'sub_1',
    periodEnd: (NOW_S + 29 * 86400) * 1000, pastDueSince: null, eventAt: (NOW_S - 2) * 1000,
  }]]);
});

test('invoice.payment_failed marks the team past due from the invoice date', async () => {
  const created = NOW_S - 3600;
  // older API shape
  const old = await deliver({ type: 'invoice.payment_failed', data: { object: {
    id: 'in_1', object: 'invoice', created, customer: 'cus_1', subscription: 'sub_1',
    subscription_details: { metadata: { team_id: 'team_1' } },
  } } });
  const expected = ['team_1', {
    plan: null, seats: null, status: 'past_due', customerId: 'cus_1', subscriptionId: 'sub_1',
    periodEnd: null, pastDueSince: created * 1000, eventAt: (NOW_S - 2) * 1000,
  }];
  assert.deepEqual(old.result, { handled: true, type: 'invoice.payment_failed', teamId: 'team_1' });
  assert.deepEqual(old.calls, [expected]);
  // API 2025-03-31+ shape
  const basil = await deliver({ type: 'invoice.payment_failed', data: { object: {
    id: 'in_1', object: 'invoice', created, customer: 'cus_1',
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1', metadata: { team_id: 'team_1' } } },
  } } });
  assert.deepEqual(basil.calls, [expected]);
  // an invoice outside any subscription is not ours to map
  const loose = await deliver({ type: 'invoice.payment_failed', data: { object: { id: 'in_2', customer: 'cus_1' } } });
  assert.deepEqual(loose.result, { handled: false, type: 'invoice.payment_failed', reason: 'not_a_subscription' });
});

test('other event types are ignored with handled=false', async () => {
  for (const type of ['invoice.paid', 'customer.created', 'payment_intent.succeeded', 'charge.refunded']) {
    const { result, calls } = await deliver({ type, data: { object: { metadata: { team_id: 'team_1' } } } });
    assert.deepEqual(result, { handled: false, type });
    assert.equal(calls.length, 0);
  }
});

test('an event with no team_id uses teamIdFor, or is left unhandled', async () => {
  const event = { type: 'customer.subscription.updated', data: { object: subscription({ metadata: {} }) } };
  const none = await deliver(event);
  assert.deepEqual(none.result, { handled: false, type: 'customer.subscription.updated', reason: 'no_team_id' });
  assert.equal(none.calls.length, 0);

  const asked = [];
  const found = await deliver(event, { teamIdFor: async (q) => { asked.push(q); return 'team_by_customer'; } });
  assert.deepEqual(asked, [{ customerId: 'cus_1', subscriptionId: 'sub_1', type: 'customer.subscription.updated' }]);
  assert.equal(found.calls[0][0], 'team_by_customer');
});

test('handleWebhook requires setPlan', async () => {
  await rejects(createBilling({ env: ENV }).handleWebhook(Buffer.from(SIGNED), header(SIGNED), { now: NOW }), 'bad_request');
});
