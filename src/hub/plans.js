// Plan limits and the billing module, loaded if it is there.
//
// src/hub/billing.js is built separately. The hub imports it dynamically, so a
// missing module (or one that fails to load) leaves billing switched off and
// the defaults below in force, instead of stopping the hub.

export const DEFAULT_LIMITS = {
  free: { seats: 3, historyDays: 7, repos: 2 },
  team: { seats: Infinity, historyDays: 90, repos: Infinity },
  enterprise: { seats: Infinity, historyDays: 365, repos: Infinity },
};

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

// limits(team) -> { seats, historyDays, repos } for the plan the team has now.
export function makeLimits(billing, now = () => Date.now()) {
  return (team) => {
    const purchased = Number.isInteger(team?.seats) && team.seats > 0 ? team.seats : undefined;
    if (billing) {
      try {
        const plan = typeof billing.effectivePlan === 'function' ? billing.effectivePlan(team, now()) : team.plan;
        const l = billing.limitsFor(plan, { seats: purchased });
        if (l && Number(l.seats) >= 0 && Number(l.historyDays) >= 0 && Number(l.repos) >= 0) return l;
      } catch {}
    }
    const plan = Object.hasOwn(DEFAULT_LIMITS, team?.plan) ? team.plan : 'free';
    const l = DEFAULT_LIMITS[plan];
    return { ...l, seats: plan !== 'free' && purchased ? purchased : l.seats };
  };
}
