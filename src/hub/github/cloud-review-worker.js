// Grapim Review in the cloud, one pull request: run by cloud-review.js as a
// child process, so the engine's git calls (synchronous) and its memory never
// block or bloat the hub. Reads one JSON job on stdin:
//   { dir, base, head, model, request, limits }
// takes the model key from ANTHROPIC_API_KEY in its own environment, and
// writes one JSON line on stdout: { ok: true, result } or { ok: false, error, config }.
// Progress goes to stderr. It never runs code from the repository.

import { anthropicProvider, ConfigError, loadConfig, reviewChanges, validateConfig } from '../../airev/index.js';

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main() {
  const job = await readStdin();
  let config;
  try {
    // The base commit's .grapim/review.json (a pull request cannot loosen its
    // own review), with the model the cloud review pays for.
    // A repository without Grapim notes gets every change reviewed: the
    // engine's planReview does that itself.
    config = validateConfig({ ...loadConfig(job.dir, { rev: job.base }), model: job.model });
  } catch (err) {
    if (err instanceof ConfigError) return { ok: false, config: true, error: err.message };
    throw err;
  }
  const provider = anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: job.model, ...(process.env.ANTHROPIC_BASE_URL ? { baseUrl: process.env.ANTHROPIC_BASE_URL } : {}) });
  const result = await reviewChanges({
    cwd: job.dir,
    base: job.base,
    head: job.head,
    config,
    provider,
    ...(job.request ? { request: job.request } : {}),
    ...(job.limits ? { limits: job.limits } : {}),
    env: {},
    log: (line) => process.stderr.write(`${line}\n`),
  });
  return { ok: true, result: { ...result, failOn: config.failOn } };
}

main()
  .then((out) => process.stdout.write(`${JSON.stringify(out)}\n`))
  .catch((err) => {
    process.stdout.write(`${JSON.stringify({ ok: false, config: err instanceof ConfigError, error: String(err?.message ?? err).slice(0, 500) })}\n`);
    process.exitCode = 1;
  });
