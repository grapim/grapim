// One compute worker of the hub's pool (compute-pool.js). It runs one task at
// a time on the inputs of that one call and keeps no state between calls, so
// a worker that served one team holds nothing of it when it serves the next.

import { parentPort } from 'node:worker_threads';
import { runTask } from '../server/compute.js';

parentPort.on('message', ({ id, task, input }) => {
  let reply;
  try {
    reply = { id, ok: true, value: runTask(task, input) };
  } catch (err) {
    reply = { id, ok: false, message: String(err?.message ?? err).slice(0, 500) };
  }
  parentPort.postMessage(reply);
});
parentPort.postMessage({ ready: true });
