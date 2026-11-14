// Full-jitter exponential backoff, shared by the S3 client and the persister.

export const DEFAULT_RETRY = Object.freeze({ retries: 4, baseDelayMs: 100, maxDelayMs: 5000 });

export function backoffDelay(attempt, { baseDelayMs = 100, maxDelayMs = 5000 } = {}, random = Math.random) {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An error is retryable unless it says otherwise (4xx, a bad key, a bad manifest).
export const isRetryable = (err) => err?.retryable !== false;
