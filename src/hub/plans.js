// Plan limits and the billing module, loaded if it is there.
//
// src/hub/billing.js is built separately. The hub imports it dynamically, so a
// missing module (or one that fails to load) leaves billing switched off and
// the defaults below in force, instead of stopping the hub.

export const DEFAULT_LIMITS = {
  free: { seats: 3, historyDays: 7, repos: 2, workspaces: 1 },
  team: { seats: Infinity, historyDays: 90, repos: Infinity, workspaces: Infinity },
  governance: { seats: Infinity, historyDays: 365, repos: Infinity, workspaces: Infinity },
  enterprise: { seats: Infinity, historyDays: 365, repos: Infinity, workspaces: Infinity },
};

// What a plan unlocks (docs/provenance.md section 7), when billing's
// limitsFor does not say: the manager reports and the require_review policy
// are on governance (and enterprise).
export const DEFAULT_FEATURES = Object.freeze({
  free: Object.freeze({ reports: false, requireReview: false }),
  team: Object.freeze({ reports: false, requireReview: false }),
  governance: Object.freeze({ reports: true, requireReview: true }),
  enterprise: Object.freeze({ reports: true, requireReview: true }),
});
const defaultFeatures = (plan) => ({ ...(Object.hasOwn(DEFAULT_FEATURES, plan) ? DEFAULT_FEATURES[plan] : DEFAULT_FEATURES.free) });
const featuresOf = (l, plan) => {
  const f = l?.features;
  return f && typeof f === 'object' ? { reports: f.reports === true, requireReview: f.requireReview === true } : defaultFeatures(plan);
};

// Cloud workspaces a plan may have, when billing's limitsFor does not say.
const defaultWorkspaces = (plan) => (Object.hasOwn(DEFAULT_LIMITS, plan) ? DEFAULT_LIMITS[plan].workspaces : DEFAULT_LIMITS.free.workspaces);

export async function loadBilling({ env = process.env, fetch, log = () => {} } = {}) {
  let mod;
  try {
    mod = await import('./billing.js');
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !String(err.message).includes('billing.js')) {
      log(`billing module failed to load, billing is off: ${err?.message ?? err}`);
    }
    return null;
  }
  // Prefer an instance bound to the hub's env and fetch (tests mock both).
  const api = typeof mod.createBilling === 'function' ? { ...mod, ...mod.createBilling({ env, fetch }) } : mod;
  for (const fn of ['limitsFor', 'createCheckout', 'createPortal', 'handleWebhook']) {
    if (typeof api[fn] !== 'function') {
      log(`billing module has no ${fn}(), billing is off`);
      return null;
    }
  }
  return api;
}

// limits(team) -> { seats, historyDays, repos, workspaces, features } for the
// plan the team has now (features: { reports, requireReview }). workspaces comes from billing's limitsFor when it gives one,
// else free = 1 and every paid plan unlimited.
export function makeLimits(billing, now = () => Date.now()) {
  const forPlan = planLimits(billing, now);
  // A platform (docs/platform.md) pays per active workspace, so its plan does
  // not cap how many it has; the hard cap and the storage quota still do.
  return (team) => {
    const l = forPlan(team);
    return team?.kind === 'platform' ? { ...l, workspaces: Infinity } : l;
  };
}

function planLimits(billing, now) {
  return (team) => {
    const purchased = Number.isInteger(team?.seats) && team.seats > 0 ? team.seats : undefined;
    if (billing) {
      try {
        const plan = typeof billing.effectivePlan === 'function' ? billing.effectivePlan(team, now()) : team.plan;
        const l = billing.limitsFor(plan, { seats: purchased });
        if (l && Number(l.seats) >= 0 && Number(l.historyDays) >= 0 && Number(l.repos) >= 0) {
          return { ...l, workspaces: Number(l.workspaces) >= 0 ? Number(l.workspaces) : defaultWorkspaces(plan), features: featuresOf(l, plan) };
        }
      } catch {}
    }
    const plan = Object.hasOwn(DEFAULT_LIMITS, team?.plan) ? team.plan : 'free';
    const l = DEFAULT_LIMITS[plan];
    return { ...l, seats: plan !== 'free' && purchased ? purchased : l.seats, features: defaultFeatures(plan) };
  };
}
