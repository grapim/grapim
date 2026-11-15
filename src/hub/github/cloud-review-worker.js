// Grapim Review in the cloud, one pull request: run by cloud-review.js as a
// child process, so the engine's git calls (synchronous) and its memory never
// block or bloat the hub. Reads one JSON job on stdin:
//   { dir, base, head, model, request, limits, feedback }
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
    // A team that turned cloud review on expects every pull request reviewed.
    // The engine's default skips lines it takes for human-written outside
    // sensitive paths, and in a repository that has notes, every commit made
    // without Grapim looks human-written: twfly104/grapim#5 got 0 of 17 hunks
    // reviewed. So the cloud reviews everything unless the repository's own
    // .grapim/review.json picks a mode.
    const raw = git(job.dir, ['cat-file', 'blob', `${job.base}:.grapim/review.json`], { allowFail: true });
    let picked = false;
    try {
      picked = raw !== null && Object.hasOwn(JSON.parse(String(raw).replace(/^﻿/, '')), 'review');
    } catch {}
    if (!picked) config = validateConfig({ ...config, review: 'all' });
    // The team's reactions and replies on earlier Grapim comments
    // (review-memory.js), after the repository's own instructions.
    if (typeof job.feedback === 'string' && job.feedback.trim()) {
      const joined = [config.instructions, job.feedback.trim()].filter(Boolean).join('\n\n');
      config = validateConfig({ ...config, instructions: joined.length > 4000 ? `${joined.slice(0, 3999)}…` : joined });
    }
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
    // The summary says the code was on Grapim's server (it was, in job.dir).
    hosted: true,
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
