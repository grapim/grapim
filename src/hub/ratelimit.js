// In-memory fixed-window rate limits. Good enough for one hub process (v0);
// several replicas would each count separately.
//
// Memory is bounded: past MAX_KEYS live buckets, expired ones are swept (at
// most once a second, so a flood of new keys cannot turn every hit into a
// full scan), and if that is not enough the oldest buckets are dropped.

export const MAX_KEYS = 100_000;

export class RateLimiter {
  constructor({ now = () => Date.now(), maxKeys = MAX_KEYS } = {}) {
    this.now = now;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
    this.lastSweep = 0;
  }

  // True if this hit is allowed: at most `limit` hits per `windowMs` per key.
  hit(key, limit, windowMs) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b || t >= b.reset) {
      if (b) this.buckets.delete(key);
      b = { count: 0, reset: t + windowMs };
      this.buckets.set(key, b);
      if (this.buckets.size > this.maxKeys) this.#shrink(t);
    }
    b.count++;
    return b.count <= limit;
  }

  #shrink(t) {
    if (t - this.lastSweep >= 1000) {
      this.lastSweep = t;
      this.sweep();
    }
    // Map order is insertion order: the first keys are the oldest windows.
    for (const k of this.buckets.keys()) {
      if (this.buckets.size <= this.maxKeys) break;
      this.buckets.delete(k);
    }
  }

  retryAfter(key) {
    const b = this.buckets.get(key);
    return b ? Math.max(1, Math.ceil((b.reset - this.now()) / 1000)) : 1;
  }

  sweep() {
    const t = this.now();
    for (const [k, b] of this.buckets) if (t >= b.reset) this.buckets.delete(k);
  }
}

export const LIMITS = {
  global: [600, 60_000], // any route, per address
  auth: [20, 60_000], // sign in, callback, per address
  sync: [120, 60_000], // per machine token
  syncIp: [240, 60_000], // per address, before the token is checked
  form: [60, 60_000], // state-changing browser posts, per user
  read: [120, 60_000], // repo and run reads (they diff synced content), per user
  workspace: [600, 60_000], // cloud workspace requests (desk, /api, /fs, /mcp), per workspace token or per user
  webhook: [300, 60_000],
  platformIp: [6000, 60_000], // /v1 per address, instead of `global`; each platform key has its own token bucket (src/hub/platform/)
  embed: [120, 60_000], // embed session links redeemed, per address
  demo: [10, 60_000], // demo sessions started at /demo, per address (src/hub/demo.js)
};
