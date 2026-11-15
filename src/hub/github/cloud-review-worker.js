// Grapim Review in the cloud, one pull request: run by cloud-review.js as a
// child process, so the engine's git calls (synchronous) and its memory never
// block or bloat the hub. Reads one JSON job on stdin:
//   { dir, base, head, model, request }
// takes the model key from ANTHROPIC_API_KEY in its own environment, and
// writes one JSON line on stdout: { ok: true, result } or { ok: false, error, config }.
// Progress goes to stderr. It never runs code from the repository.

import { anthropicProvider, ConfigError, loadConfig, reviewChanges, validateConfig } from '../../airev/index.js';
import { git } from '../../provenance/pr.js';

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
    config = validateConfig({ ...loadConfig(job.dir, { rev: job.base }), model: job.model });
    // A repository without Grapim notes says nothing about who wrote which
    // line, and most cloud teams start without them: unless its config picks
    // a mode, review every change instead of only the sensitive paths.
    const raw = git(job.dir, ['cat-file', 'blob', `${job.base}:.grapim/review.json`], { allowFail: true });
    let picked = false;
    try {
      picked = raw !== null && Object.hasOwn(JSON.parse(String(raw).replace(/^﻿/, '')), 'review');
    } catch {}
    const notes = git(job.dir, ['rev-parse', '--verify', '--quiet', 'refs/notes/grapim'], { allowFail: true });
    if (!picked && !notes) config = validateConfig({ ...config, review: 'all' });
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
