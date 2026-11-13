// Billing for the Grapim team cloud (the hub): plans and their limits,
// Stripe Checkout and Billing Portal sessions, and the Stripe webhook.
//
// Zero dependencies. Stripe is called with fetch and form-encoded bodies; the
// webhook signature is checked here with HMAC-SHA256. Nothing in this file logs,
// and no error message ever contains a key.
//
// The default exports read process.env and globalThis.fetch at call time.
// Tests (or a hub that wants its own config) use createBilling({ fetch, env }).

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const STRIPE_API = 'https://api.stripe.com/v1';
const DAY_MS = 24 * 60 * 60 * 1000;

// How long a team whose payment failed keeps its paid limits.
export const GRACE_MS = 7 * DAY_MS;
// How old (or how far in the future) a signed webhook may be.
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

// Every plan in one place. Unlimited is Infinity (it compares correctly with
// `count < limit`; note JSON.stringify turns it into null).
// Team seats are what the team bought: pass them to limitsFor(plan, { seats }).
export const PLANS = {
  free: {
    seats: 3,
    historyDays: 7,
    repos: 2,
    price: null,
  },
  team: {
    seats: Infinity,
    historyDays: 90,
    repos: Infinity,
    price: {
      currency: 'usd',
      perSeat: { month: 20, year: 192 },
      // The Stripe price ids live in these env vars.
      env: { month: 'STRIPE_PRICE_TEAM_MONTH', year: 'STRIPE_PRICE_TEAM_YEAR' },
    },
  },
  // Team plus the manager reports and the require_review policy
  // (docs/provenance.md section 7).
  governance: {
    seats: Infinity,
    historyDays: 365,
    repos: Infinity,
    price: {
      currency: 'usd',
      perSeat: { month: 40, year: 384 },
      env: { month: 'STRIPE_PRICE_GOVERNANCE_MONTH', year: 'STRIPE_PRICE_GOVERNANCE_YEAR' },
    },
  },
  enterprise: {
    seats: Infinity,
    historyDays: 365,
    repos: Infinity,
    price: 'contact sales',
  },
};

// What each plan unlocks beyond its limits. Unknown plans get none.
export const FEATURES = Object.freeze({
  free: Object.freeze({ reports: false, requireReview: false }),
  team: Object.freeze({ reports: false, requireReview: false }),
  governance: Object.freeze({ reports: true, requireReview: true }),
  enterprise: Object.freeze({ reports: true, requireReview: true }),
});

// The plans a team can buy in self-serve checkout (they have a price table).
export const CHECKOUT_PLANS = Object.freeze(Object.keys(PLANS).filter((p) => typeof PLANS[p].price === 'object' && PLANS[p].price));

export const featuresFor = (plan) => ({ ...(Object.hasOwn(FEATURES, plan) ? FEATURES[plan] : FEATURES.free) });

// Usage-based pricing for platforms (docs/platform.md, "Metering and
// pricing"): the one table to change. Amounts are in `currency` units.
// Test keys never bill and are capped instead. `meters` names the env vars
// holding the Stripe Billing Meter event names the daily reporter sends to
// (src/hub/platform/metering.js); the reporter only runs when all are set.
export const PLATFORM_PRICES = Object.freeze({
  currency: 'usd',
  activeWorkspaceMonth: 0.5, // a workspace with at least one write in the month
  per1000Writes: 0.1,
  perGbMonth: 0.1, // storage, sampled daily: GB-month = byte-days / days in month / 2^30
  monthlyMinimum: 500, // live keys only
  // Test keys never bill, so test mode is kept small and short-lived (platform
  // review M10): per platform, 25 workspaces at once, 2,000 writes a UTC day,
  // 100 MB of storage, and each test workspace is deleted 7 days after it
  // was created.
  testCaps: Object.freeze({ workspaces: 25, writesPerDay: 2_000, storageMb: 100, workspaceDays: 7 }),
  meters: Object.freeze({
    writes: 'STRIPE_METER_WRITES', // value: writes that day
    activeWorkspaces: 'STRIPE_METER_ACTIVE_WORKSPACES', // value: workspaces whose first write of the month was that day
    storage: 'STRIPE_METER_STORAGE', // value: MiB-days stored that day (whole numbers)
  }),
});

// Stripe subscription statuses that keep the paid plan, and those that keep it
// only during the grace period. Anything else (canceled, incomplete,
// incomplete_expired, paused) means free.
const PAID_STATUSES = new Set(['active', 'trialing', 'pilot']); // pilot: set by a hub admin for a design partner, no billing
const GRACE_STATUSES = new Set(['past_due', 'unpaid']);

export class BillingError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const isPlan = (plan) => typeof plan === 'string' && Object.hasOwn(PLANS, plan);

// Limits for a plan name. Unknown names get the free limits.
// For 'team' and 'governance', pass the purchased seat count to get it back as
// the seat limit. `features` ({ reports, requireReview }) is on the result too,
// non-enumerable so the limits compare and serialise as they always have; read
// it as limitsFor(plan).features.
export function limitsFor(plan, { seats } = {}) {
  const p = isPlan(plan) ? PLANS[plan] : PLANS.free;
  const purchased = (plan === 'team' || plan === 'governance') && Number.isInteger(seats) && seats > 0 ? seats : null;
  const out = { seats: purchased ?? p.seats, historyDays: p.historyDays, repos: p.repos };
  return Object.defineProperty(out, 'features', { value: featuresFor(isPlan(plan) ? plan : 'free'), enumerable: false });
}

// The plan a team actually gets right now.
// Reads team.plan, team.plan_status and team.past_due_since (camelCase also
// accepted). A team with no status is treated as active (e.g. enterprise set by
// hand). past_due / unpaid keep the plan for GRACE_MS after past_due_since,
// then fall back to free; a past-due team with no past_due_since is free.
export function effectivePlan(team, now = Date.now()) {
  const plan = team?.plan;
  if (!isPlan(plan) || plan === 'free') return 'free';
  const status = team.plan_status ?? team.planStatus ?? 'active';
  if (PAID_STATUSES.has(status)) return plan;
  if (GRACE_STATUSES.has(status)) {
    const since = toMs(team.past_due_since ?? team.pastDueSince);
    return since !== null && toMs(now) < since + GRACE_MS ? plan : 'free';
  }
  return 'free';
}

// Checks a Stripe-Signature header ("t=...,v1=...,v1=...") against the raw body.
// Returns the signed timestamp in seconds; throws code 'bad_signature' otherwise.
export function verifyStripeSignature(rawBody, header, secret, now = Date.now()) {
  if (typeof header !== 'string' || header.trim() === '') throw badSignature('missing Stripe-Signature header');
  let t = null;
  const v1 = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && t === null) t = value;
    else if (key === 'v1') v1.push(value);
  }
  if (!/^\d+$/.test(t ?? '')) throw badSignature('no timestamp in Stripe-Signature header');
  if (v1.length === 0) throw badSignature('no v1 signature in Stripe-Signature header');

  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  const matches = v1.some((sig) => /^[0-9a-f]{64}$/i.test(sig) && timingSafeEqual(Buffer.from(sig, 'hex'), expected));
  if (!matches) throw badSignature('signature does not match');

  const signedAtMs = Number(t) * 1000;
  if (Math.abs(toMs(now) - signedAtMs) > SIGNATURE_TOLERANCE_MS) throw badSignature('timestamp outside the 5-minute tolerance');
  return Number(t);
}

export function createBilling({ fetch: fetchImpl, env: envSource } = {}) {
  const getEnv = () => envSource ?? process.env;
  const getFetch = () => fetchImpl ?? globalThis.fetch;

  async function stripePost(path, params, idempotencyKey) {
    const key = secretKey(getEnv());
    let res;
    try {
      res = await getFetch()(`${STRIPE_API}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': idempotencyKey,
        },
        body: formEncode(params),
      });
    } catch (err) {
      throw new BillingError('stripe_unreachable', `Could not reach Stripe: ${err?.message ?? err}`);
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
      const e = data?.error;
      throw new BillingError('stripe_error', `Stripe ${res.status}: ${e?.message ?? 'request failed'}`, {
        status: res.status,
        stripeCode: e?.code ?? e?.type ?? null,
      });
    }
    if (!data) throw new BillingError('stripe_error', 'Stripe returned a response that is not JSON', { status: res.status });
    return data;
  }

  // A Stripe Checkout Session (subscription mode) for `seats` seats of a plan
  // (Team unless `plan` says 'governance').
  async function createCheckout({ team, user, seats, interval, plan = 'team', successUrl, cancelUrl, idempotencyKey } = {}) {
    if (team?.id === undefined || team?.id === null || team.id === '') throw badRequest('team.id is required');
    if (!Number.isInteger(seats) || seats < 1) throw badRequest('seats must be a whole number of at least 1');
    if (interval !== 'month' && interval !== 'year') throw badRequest("interval must be 'month' or 'year'");
    if (!CHECKOUT_PLANS.includes(plan)) throw badRequest(`plan must be one of ${CHECKOUT_PLANS.join(', ')}`);
    if (!successUrl || !cancelUrl) throw badRequest('successUrl and cancelUrl are required');

    const env = getEnv();
    secretKey(env); // refuse a live or missing key before anything else
    const priceVar = PLANS[plan].price.env[interval];
    const price = env[priceVar];
    if (!price) throw new BillingError('not_configured', `${priceVar} is not set`);

    const teamId = String(team.id);
    const params = {
      mode: 'subscription',
      line_items: [{ price, quantity: seats }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: teamId,
      metadata: { team_id: teamId, seats, user_id: user?.id },
      // So every customer.subscription.* and invoice.* event names the team too.
      subscription_data: { metadata: { team_id: teamId } },
    };
    // Team checkouts carry no plan (that is the default everywhere); others
    // name it, so the subscription events set the right plan.
    if (plan !== 'team') {
      params.metadata.plan = plan;
      params.subscription_data.metadata.plan = plan;
    }
    if (team.stripe_customer_id) params.customer = team.stripe_customer_id;
    else if (user?.email) params.customer_email = user.email;

    const session = await stripePost('/checkout/sessions', params, idempotencyKey ?? `grapim-checkout-${randomUUID()}`);
    return { url: session.url };
  }

  // A Stripe Billing Portal session, where a team changes seats, card or cancels.
  async function createPortal({ team, returnUrl, idempotencyKey } = {}) {
    if (!team?.stripe_customer_id) throw new BillingError('no_customer', 'This team has no Stripe customer yet; send it to checkout first');
    if (!returnUrl) throw badRequest('returnUrl is required');
    const session = await stripePost(
      '/billing_portal/sessions',
      { customer: team.stripe_customer_id, return_url: returnUrl },
      idempotencyKey ?? `grapim-portal-${randomUUID()}`,
    );
    return { url: session.url };
  }

  // Verifies and applies one Stripe webhook delivery.
  // setPlan(teamId, { plan, seats, status, customerId, subscriptionId, periodEnd, pastDueSince, eventAt }, { eventId, type })
  // A null field means "this event does not say; keep what you have".
  // Times are epoch milliseconds. teamIdFor({ customerId, subscriptionId, type })
  // is an optional lookup for events that carry no team_id metadata.
  async function handleWebhook(rawBody, signatureHeader, { setPlan, now, teamIdFor } = {}) {
    if (typeof setPlan !== 'function') throw badRequest('handleWebhook needs a setPlan function');
    const body = toBuffer(rawBody);
    const secret = getEnv().STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new BillingError('not_configured', 'STRIPE_WEBHOOK_SECRET is not set');
    const nowMs = toMs(now ?? Date.now());

    verifyStripeSignature(body, signatureHeader, secret, nowMs);

    let event;
    try { event = JSON.parse(body.toString('utf8')); } catch {
      throw new BillingError('bad_payload', 'Webhook body is not JSON');
    }
    const type = event?.type ?? null;
    const obj = event?.data?.object ?? {};
    const eventAt = secToMs(event?.created) ?? nowMs;

    const mapped = mapEvent(type, obj, eventAt, planOfPrice(getEnv()));
    if (!mapped) return { handled: false, type };
    if (mapped.skip) return { handled: false, type, reason: mapped.skip };

    let teamId = mapped.teamId;
    if (!teamId && typeof teamIdFor === 'function') {
      teamId = await teamIdFor({ customerId: mapped.update.customerId, subscriptionId: mapped.update.subscriptionId, type });
    }
    if (!teamId) return { handled: false, type, reason: 'no_team_id' };

    // Stripe retries deliveries and does not order them, and a captured delivery
    // verifies again for 5 minutes. The third argument lets setPlan skip an
    // event id it has already applied (and eventAt, one older than its state).
    await setPlan(String(teamId), { ...mapped.update, eventAt }, { eventId: typeof event.id === 'string' ? event.id : null, type });
    return { handled: true, type, teamId: String(teamId) };
  }

  // One Stripe Billing Meter event (POST /v1/billing/meter_events). The
  // identifier doubles as the Idempotency-Key, so a retried report of the
  // same (platform, day, meter) is counted once by Stripe.
  async function reportMeterEvent({ eventName, customerId, value, identifier, timestamp } = {}) {
    if (!eventName || !customerId || !identifier) throw badRequest('eventName, customerId and identifier are required');
    if (!Number.isSafeInteger(value) || value < 0) throw badRequest('value must be a whole number');
    return stripePost(
      '/billing/meter_events',
      { event_name: eventName, identifier, timestamp, payload: { stripe_customer_id: customerId, value: String(value) } },
      identifier,
    );
  }

  return { createCheckout, createPortal, handleWebhook, reportMeterEvent };
}

// Turns a Stripe event into { teamId, update }, { skip: reason }, or null for
// types this module does not handle.
function mapEvent(type, obj, eventAt, priceToPlan = () => null) {
  switch (type) {
    case 'checkout.session.completed': {
      if (obj.mode !== 'subscription') return { skip: 'not_a_subscription' };
      const paid = obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required';
      return {
        teamId: obj.client_reference_id || obj.metadata?.team_id || null,
        update: {
          plan: paidPlan(obj.metadata?.plan) ?? 'team',
          seats: toSeats(obj.metadata?.seats),
          status: paid ? 'active' : 'incomplete',
          customerId: idOf(obj.customer),
          subscriptionId: idOf(obj.subscription),
          periodEnd: null,
          pastDueSince: null,
        },
      };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const update = fromSubscription(obj, eventAt, priceToPlan);
      if (type === 'customer.subscription.deleted') {
        update.plan = 'free';
        update.status = 'canceled';
        update.pastDueSince = null;
      }
      return { teamId: obj.metadata?.team_id || null, update };
    }
    case 'invoice.payment_failed': {
      // Older API versions put the subscription on the invoice; 2025-03-31 and
      // later put it under parent.subscription_details.
      const details = obj.parent?.subscription_details ?? obj.subscription_details ?? null;
      const subscriptionId = idOf(obj.subscription) ?? idOf(obj.parent?.subscription_details?.subscription);
      if (!subscriptionId) return { skip: 'not_a_subscription' };
      return {
        teamId: details?.metadata?.team_id || obj.metadata?.team_id || null,
        update: {
          plan: null,
          seats: null,
          status: 'past_due',
          customerId: idOf(obj.customer),
          subscriptionId,
          periodEnd: null,
          pastDueSince: secToMs(obj.created) ?? eventAt,
        },
      };
    }
    default:
      return null;
  }
}

function fromSubscription(sub, eventAt, priceToPlan = () => null) {
  const item = sub.items?.data?.[0];
  const metaPlan = sub.metadata?.plan;
  // Self-serve subscriptions are Team or Governance: the item's price says
  // which (so a plan switch in the Billing Portal is seen), else the checkout's
  // metadata.plan. Enterprise ones made by hand in Stripe carry
  // metadata.plan = 'enterprise', which always wins.
  const plan = metaPlan === 'enterprise' ? 'enterprise' : priceToPlan(idOf(item?.price)) ?? paidPlan(metaPlan) ?? 'team';
  // Period fields moved from the subscription to its items in API 2025-03-31.
  const periodStart = secToMs(sub.current_period_start ?? item?.current_period_start);
  const periodEnd = secToMs(sub.current_period_end ?? item?.current_period_end);
  return {
    plan,
    seats: toSeats(item?.quantity),
    status: sub.status ?? null,
    customerId: idOf(sub.customer),
    subscriptionId: idOf(sub.id),
    periodEnd,
    // A renewal that failed leaves the subscription past_due from the start of
    // the unpaid period; that moment is stable across retries.
    pastDueSince: GRACE_STATUSES.has(sub.status) ? (periodStart ?? eventAt) : null,
  };
}

function secretKey(env) {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new BillingError('not_configured', 'STRIPE_SECRET_KEY is not set');
  if (!/^(sk|rk)_(test|live)_/.test(key)) {
    throw new BillingError('not_configured', 'STRIPE_SECRET_KEY does not look like a Stripe secret key (sk_test_...)');
  }
  if (/^(sk|rk)_live_/.test(key) && env.STRIPE_ALLOW_LIVE !== '1') {
    throw new BillingError('live_key_refused', 'Refusing a live Stripe key; set STRIPE_ALLOW_LIVE=1 to charge real cards');
  }
  return key;
}

// Stripe's form encoding: nested objects as a[b]=, arrays as a[0][b]=.
function formEncode(params) {
  const out = new URLSearchParams();
  const walk = (prefix, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(prefix ? `${prefix}[${k}]` : k, v);
    else out.append(prefix, String(value));
  };
  walk('', params);
  return out.toString();
}

function toBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody);
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  throw badRequest('handleWebhook needs the raw request body as a Buffer, not parsed JSON');
}

function toMs(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const paidPlan = (p) => (isPlan(p) && p !== 'free' ? p : null);

// priceId -> the self-serve plan whose STRIPE_PRICE_* env var holds it, or null.
function planOfPrice(env) {
  return (priceId) => {
    if (!priceId) return null;
    for (const plan of CHECKOUT_PLANS) {
      for (const v of Object.values(PLANS[plan].price.env)) if (env[v] && env[v] === priceId) return plan;
    }
    return null;
  };
}

const secToMs = (s) => (Number.isFinite(s) ? s * 1000 : null);
const idOf = (x) => (typeof x === 'string' ? x : x?.id ?? null);

function toSeats(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isInteger(n) && n > 0 ? n : null;
}

const badRequest = (message) => new BillingError('bad_request', message);
const badSignature = (message) => new BillingError('bad_signature', `Bad Stripe signature: ${message}`);

const defaults = createBilling();
export const createCheckout = defaults.createCheckout;
export const createPortal = defaults.createPortal;
export const handleWebhook = defaults.handleWebhook;
