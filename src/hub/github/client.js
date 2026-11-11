// A small GitHub REST and GraphQL client for one installation token.
//
// Rate limits: a 403 or 429 that carries Retry-After, or
// X-RateLimit-Remaining: 0 with X-RateLimit-Reset, waits (up to maxWaitMs)
// and retries; GraphQL's RATE_LIMITED error is treated the same. Past
// maxWaitMs it gives up with a RateLimitError rather than hold the queue.
// Other 5xx answers are retried twice with a short backoff.

export class GitHubError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}
export class RateLimitError extends GitHubError {}

const defaultSleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

export class GitHubClient {
  constructor({ apiBase, token, fetch, now = () => Date.now(), sleep = defaultSleep, maxWaitMs = 5 * 60 * 1000, signal = null }) {
    this.apiBase = apiBase;
    this.token = token;
    this.fetch = fetch;
    this.now = now;
    this.sleep = sleep;
    this.maxWaitMs = maxWaitMs;
    this.signal = signal;
    this.calls = 0;
  }

  // How long a rate-limited answer asks us to wait, or -1 if it is not one.
  waitFor(res) {
    const after = Number(res.headers.get('retry-after'));
    if (after > 0) return after * 1000;
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      return Number.isFinite(reset) && reset > 0 ? Math.max(1000, reset * 1000 - this.now() + 1000) : 60_000;
    }
    return -1;
  }

  async #backoff(ms) {
    if (ms > this.maxWaitMs) throw new RateLimitError(`GitHub rate limit: retry in ${Math.ceil(ms / 1000)} s.`, 403);
    await this.sleep(ms, this.signal);
    if (this.signal?.aborted) throw new GitHubError('Stopped.');
  }

  async request(method, path, body = undefined) {
    if (typeof path !== 'string' || !path.startsWith('/')) throw new GitHubError('Bad API path.');
    for (let attempt = 0; ; attempt++) {
      if (this.signal?.aborted) throw new GitHubError('Stopped.');
      this.calls++;
      let res;
      try {
        res = await this.fetch(`${this.apiBase}${path}`, {
          method,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${this.token}`,
            'User-Agent': 'grapim-hub',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        if (attempt < 2) {
          await this.#backoff(1000 * 2 ** attempt);
          continue;
        }
        throw new GitHubError('GitHub is unreachable.');
      }
      if ((res.status === 403 || res.status === 429) && attempt < 3) {
        const ms = this.waitFor(res);
        if (ms >= 0) {
          await res.arrayBuffer().catch(() => {});
          await this.#backoff(ms);
          continue;
        }
      }
      if (res.status >= 500 && attempt < 2) {
        await res.arrayBuffer().catch(() => {});
        await this.#backoff(1000 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      return { status: res.status, ok: res.ok, json, headers: res.headers };
    }
  }

  async rest(method, path, body) {
    const r = await this.request(method, path, body);
    if (!r.ok) throw new GitHubError(`GitHub answered ${r.status} to ${method} ${path.split('?')[0].replace(/^\/repos\/[^/]+\/[^/]+/, '/repos/:repo')}.`, r.status);
    return r.json;
  }

  // Pages of a list endpoint (per_page=100), up to maxItems.
  async paginate(path, maxItems = 1000) {
    const out = [];
    for (let page = 1; out.length < maxItems; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const items = await this.rest('GET', `${path}${sep}per_page=100&page=${page}`);
      if (!Array.isArray(items)) break;
      out.push(...items);
      if (items.length < 100) break;
    }
    return out.slice(0, maxItems);
  }

  async graphql(query, variables) {
    for (let attempt = 0; ; attempt++) {
      const r = await this.request('POST', '/graphql', { query, variables });
      const errors = Array.isArray(r.json?.errors) ? r.json.errors : [];
      if (errors.some((e) => e?.type === 'RATE_LIMITED') && attempt < 3) {
        const ms = this.waitFor(r);
        await this.#backoff(ms >= 0 ? ms : 60_000);
        continue;
      }
      if (!r.ok) throw new GitHubError(`GitHub GraphQL answered ${r.status}.`, r.status);
      return { data: r.json?.data ?? null, errors };
    }
  }
}
