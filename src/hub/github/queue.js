// A small in-process job queue, so webhooks answer at once and the work runs
// off the request path. Jobs with the same key coalesce: a second push for a
// pull request that is still waiting replaces the waiting job (only the
// newest head matters). Bounded: past `max` waiting jobs, new ones are dropped
// and logged; GitHub sends another event on the next push.
//
// Fair across installations: jobs carry a group (the installation id). At
// most one job per group runs at a time and at most `maxPerGroup` wait, so
// one account's burst of large pull requests (or its exhausted rate limit)
// cannot hold every worker or fill the queue for everyone else.

export class JobQueue {
  constructor({ run, concurrency = 2, max = 200, maxPerGroup = 20, log = () => {} }) {
    this.run = run;
    this.concurrency = concurrency;
    this.max = max;
    this.maxPerGroup = maxPerGroup;
    this.log = log;
    this.waiting = new Map(); // key -> { job, group }, in arrival order
    this.running = new Set(); // keys
    this.busyGroups = new Map(); // group -> running jobs
    this.active = 0;
    this.closed = false;
    this.idlers = [];
  }

  push(key, job, group = key) {
    if (this.closed) return false;
    if (this.waiting.has(key)) {
      this.waiting.set(key, { job, group });
      return true;
    }
    if (this.waiting.size >= this.max) {
      this.log('github queue full: event dropped');
      return false;
    }
    let inGroup = 0;
    for (const w of this.waiting.values()) if (w.group === group) inGroup++;
    if (inGroup >= this.maxPerGroup) {
      this.log('github queue: too many waiting jobs for one installation, event dropped');
      return false;
    }
    this.waiting.set(key, { job, group });
    this.#pump();
    return true;
  }

  #pump() {
    while (!this.closed && this.active < this.concurrency) {
      // The first waiting job whose key is not already running (one job per
      // pull request at a time, so two cannot race on its comment) and whose
      // installation has no job running.
      let next;
      for (const [k, w] of this.waiting) {
        if (!this.running.has(k) && !this.busyGroups.get(w.group)) {
          next = k;
          break;
        }
      }
      if (next === undefined) break;
      const { job, group } = this.waiting.get(next);
      this.waiting.delete(next);
      this.running.add(next);
      this.busyGroups.set(group, (this.busyGroups.get(group) ?? 0) + 1);
      this.active++;
      Promise.resolve()
        .then(() => this.run(job))
        .catch((err) => this.log(`github job failed: ${err?.name ?? 'Error'}: ${err?.message ?? err}`))
        .finally(() => {
          this.active--;
          this.running.delete(next);
          const n = (this.busyGroups.get(group) ?? 1) - 1;
          if (n > 0) this.busyGroups.set(group, n);
          else this.busyGroups.delete(group);
          this.#pump();
          if (!this.active && !this.waiting.size) for (const r of this.idlers.splice(0)) r();
        });
    }
  }

  get size() {
    return this.waiting.size + this.active;
  }

  // Resolves when nothing is waiting or running (tests, shutdown).
  idle() {
    if (!this.active && !this.waiting.size) return Promise.resolve();
    return new Promise((r) => this.idlers.push(r));
  }

  close() {
    this.closed = true;
    this.waiting.clear();
    if (!this.active) for (const r of this.idlers.splice(0)) r();
  }
}
