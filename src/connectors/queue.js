// A request queue for one SaaS account: requests start one at a time at most
// `perSecond` per second, and a 429 (or a 502/503/504) is retried after the
// server's Retry-After, or with exponential backoff and jitter when it gives
// none. While one request waits out a 429, the whole queue waits: the limit
// is the account's, not the request's.
//
// run(fn): fn() performs one attempt and returns its result, or throws an
// error with { retryable: true, retryAfterMs? } to be tried again.

export class RetryableError extends Error {
  constructor(message, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.retryable = true;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createQueue({ perSecond = 3, maxRetries = 6, baseDelayMs = 1000, maxDelayMs = 60_000, now = () => Date.now(), sleep = realSleep, random = Math.random } = {}) {
  const gap = 1000 / perSecond;
  let nextStart = 0; // when the next request may start
  let tail = Promise.resolve();
  const stats = { requests: 0, retries: 0, waitedMs: 0 };

  async function slot() {
    const wait = nextStart - now();
    if (wait > 0) {
      stats.waitedMs += wait;
      await sleep(wait);
    }
    nextStart = Math.max(now(), nextStart) + gap;
  }

  // Requests start in order; each waits for its slot, not for the one before to finish.
  function turn() {
    const mine = tail.then(slot);
    tail = mine.catch(() => {});
    return mine;
  }

  async function run(fn) {
    for (let attempt = 0; ; attempt++) {
      await turn();
      stats.requests++;
      try {
        return await fn();
      } catch (err) {
        if (!err?.retryable || attempt >= maxRetries) throw err;
        stats.retries++;
        const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.5 + random() / 2);
        const delay = Math.min(maxDelayMs, err.retryAfterMs ?? backoff);
        // Everyone waits: the account is over its limit, not this request.
        nextStart = Math.max(nextStart, now() + delay);
      }
    }
  }

  return { run, stats };
}
