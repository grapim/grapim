// Cursor pagination: `?limit=&starting_after=<id>` returns `{ data, has_more }`.
//
// A list call returns a ListResult, which is both
// - awaitable: `await grapim.workspaces.list({ limit: 10 })` is the first page, `{ data, has_more }`;
// - async-iterable: `for await (const ws of grapim.workspaces.list())` walks every page.

export class ListResult {
  #fetchPage;
  #params;

  /**
   * @param {(params: Record<string, unknown>) => Promise<{ data: any[], has_more: boolean }>} fetchPage
   * @param {Record<string, unknown>} params
   */
  constructor(fetchPage, params = {}) {
    this.#fetchPage = fetchPage;
    this.#params = { ...params };
  }

  /** The first page only. */
  firstPage() {
    return this.#fetchPage(this.#params);
  }

  then(onFulfilled, onRejected) {
    return this.firstPage().then(onFulfilled, onRejected);
  }

  catch(onRejected) {
    return this.firstPage().catch(onRejected);
  }

  async *[Symbol.asyncIterator]() {
    let after = this.#params.starting_after;
    for (;;) {
      const page = await this.#fetchPage({ ...this.#params, starting_after: after });
      const data = Array.isArray(page?.data) ? page.data : [];
      for (const item of data) yield item;
      if (!page?.has_more || data.length === 0) return;
      const last = data[data.length - 1];
      if (!last || typeof last.id !== 'string') return;
      after = last.id;
    }
  }

  /** Every item, across pages, up to `max` (default 10,000). */
  async toArray({ max = 10_000 } = {}) {
    const out = [];
    for await (const item of this) {
      out.push(item);
      if (out.length >= max) break;
    }
    return out;
  }
}
