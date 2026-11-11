// The hub's compute pool: diffs, line counts, blame and replays of cloud
// workspaces run here, in a few worker threads, instead of on the one event
// loop that serves every team (security review of workspaces, M7).
//
// - Workers: 2, or availableParallelism() - 1 up to 4. Each runs one job at a
//   time and is started on first use.
// - Budget: a job that runs longer than BUDGET_MS (or needs more than
//   WORKER_HEAP_MB of heap) is stopped by terminating its worker (a fresh one
//   replaces it), and the caller gets too_large (413).
// - Fairness: at most PER_TEAM jobs of one team run at once; the next free
//   worker goes to the next team in turn (round robin), so one team's heavy
//   writer queues behind its own jobs, not in front of everyone's. A team
//   with MAX_QUEUED jobs waiting gets busy (503).
// - Isolation: a job is { task, input } with the inputs of that one call
//   (src/server/compute.js); workers keep nothing between jobs.
//
// grapim serve never uses this: it computes in place (the simple path).

import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { HttpError } from '../server/http.js';

export const BUDGET_MS = 2000;
export const PER_TEAM = 2;
export const MAX_QUEUED = 64;
export const WORKER_HEAP_MB = 512;
export const defaultSize = () => Math.max(2, Math.min(4, (os.availableParallelism?.() ?? os.cpus().length) - 1));

const WORKER_URL = new URL('./compute-worker.js', import.meta.url);

export function tooLarge(budgetMs = BUDGET_MS) {
  return new HttpError('too_large', `Comparing these contents line by line needs more than one request may use (${budgetMs / 1000} s of work). Nothing was changed. Split the file, or use fewer and longer lines.`);
}

export function createComputePool({ size = defaultSize(), budgetMs = BUDGET_MS, perTeam = PER_TEAM, maxQueued = MAX_QUEUED, workerUrl = WORKER_URL, log = () => {} } = {}) {
  const workers = new Set(); // every live worker
  const idle = []; // workers with no job
  const queues = new Map(); // team -> jobs waiting, oldest first
  const running = new Map(); // team -> jobs running
  let lastTeam = null; // the team served last, for the round robin
  let seq = 0;
  let closed = false;
  let terminated = 0; // jobs stopped by the budget, for tests and logs

  function spawn() {
    // A job's heap is bounded too: past it the worker dies, not the hub.
    const w = new Worker(workerUrl, { resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
    w.unref();
    w.job = null;
    // A job's budget starts once its worker has loaded the compute code
    // (it says so with { ready: true }), not while it is still starting.
    w.ready = false;
    w.on('message', (msg) => {
      if (msg?.ready) {
        w.ready = true;
        if (w.job) startBudget(w);
        return;
      }
      finish(w, msg);
    });
    w.on('error', (err) => crash(w, err));
    w.on('exit', () => crash(w, null));
    workers.add(w);
    return w;
  }

  function release(team) {
    const n = (running.get(team) ?? 1) - 1;
    if (n > 0) running.set(team, n);
    else running.delete(team);
  }

  function finish(w, msg) {
    const job = w.job;
    if (!job || msg?.id !== job.id) return;
    clearTimeout(job.timer);
    w.job = null;
    release(job.team);
    idle.push(w);
    if (msg.ok) job.resolve(msg.value);
    else job.reject(new HttpError('internal', `compute ${job.task}: ${msg.message}`));
    pump();
  }

  // A worker that died (or was stopped) is dropped; its job, if any, fails.
  function drop(w) {
    if (!workers.delete(w)) return null;
    const i = idle.indexOf(w);
    if (i >= 0) idle.splice(i, 1);
    const job = w.job;
    w.job = null;
    if (job) {
      clearTimeout(job.timer);
      release(job.team);
    }
    return job;
  }

  function crash(w, err) {
    const job = drop(w);
    if (job && err?.code === 'ERR_WORKER_OUT_OF_MEMORY') job.reject(tooLarge(budgetMs));
    else if (job) job.reject(new HttpError('internal', `compute ${job.task}: the worker stopped${err ? ` (${err.message})` : ''}`));
    if (err && !closed) log(`compute worker: ${err.name ?? 'Error'}: ${err.message}`);
    pump();
  }

  // The job ran out of time: stop its worker. The next job gets a fresh one.
  function overBudget(w) {
    const job = drop(w);
    w.removeAllListeners('exit');
    w.terminate().catch(() => {});
    terminated++;
    if (job) job.reject(tooLarge(budgetMs));
    pump();
  }

  function startBudget(w) {
    const job = w.job;
    if (!job || job.timer) return;
    job.timer = setTimeout(() => overBudget(w), budgetMs);
    job.timer.unref?.();
  }

  // The next team in turn with a job waiting and a free slot of its own.
  function nextTeam() {
    const teams = [...queues.keys()];
    if (!teams.length) return null;
    const from = teams.indexOf(lastTeam) + 1;
    for (let i = 0; i < teams.length; i++) {
      const t = teams[(from + i) % teams.length];
      if ((running.get(t) ?? 0) < perTeam) return t;
    }
    return null;
  }

  function pump() {
    while (!closed) {
      if (!idle.length && workers.size >= size) return;
      const team = nextTeam();
      if (team === null) return;
      const q = queues.get(team);
      const job = q.shift();
      if (!q.length) queues.delete(team);
      lastTeam = team;
      const w = idle.pop() ?? spawn();
      w.job = job;
      running.set(team, (running.get(team) ?? 0) + 1);
      w.postMessage({ id: job.id, task: job.task, input: job.input });
      if (w.ready) startBudget(w);
      job.input = null; // the worker has its own copy
    }
  }

  function run(rawTeam, task, input) {
    const team = String(rawTeam);
    if (closed) return Promise.reject(new HttpError('busy', 'The hub is stopping. Try again in a moment.', { 'Retry-After': '5' }));
    const q = queues.get(team) ?? [];
    if (q.length >= maxQueued) {
      return Promise.reject(new HttpError('busy', 'This team has too many diffs and blames waiting. Try again in a moment.', { 'Retry-After': '2' }));
    }
    return new Promise((resolve, reject) => {
      q.push({ id: ++seq, team, task, input, resolve, reject, timer: null });
      queues.set(team, q);
      pump();
    });
  }

  return {
    run,
    // The compute an engine of this team uses (src/server/offload.js).
    forTeam: (team) => ({ run: (task, input) => run(team, task, input) }),
    stats: () => ({
      workers: workers.size,
      busy: workers.size - idle.length,
      running: Object.fromEntries(running),
      queued: Object.fromEntries([...queues].map(([t, q]) => [t, q.length])),
      terminated,
    }),
    size,
    budgetMs,
    async close() {
      closed = true;
      for (const q of queues.values()) for (const job of q) job.reject(new HttpError('busy', 'The hub is stopping.'));
      queues.clear();
      await Promise.all(
        [...workers].map((w) => {
          const job = drop(w);
          if (job) job.reject(new HttpError('busy', 'The hub is stopping.'));
          w.removeAllListeners('exit');
          return w.terminate().catch(() => {});
        }),
      );
    },
  };
}
