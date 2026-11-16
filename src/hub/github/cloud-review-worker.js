// Grapim Review in the cloud, one pull request: run by cloud-review.js as a
// child process, so the engine's git calls (synchronous) and its memory never
// block or bloat the hub. Reads one JSON job on stdin:
//   { dir, base, head, model, request, limits, feedback, discussion, verify, teamConfig }
// takes the model key from ANTHROPIC_API_KEY in its own environment, and
// writes one JSON line on stdout: { ok: true, result } or { ok: false, error, config }.
// Progress goes to stderr. It never runs code from the repository.

import { anthropicProvider, ConfigError, reviewChanges, validateConfig } from '../../airev/index.js';
import { CONFIG_FILE, parseConfigText } from '../../airev/config.js';
import { pathToFileURL } from 'node:url';
import { verifyFindings } from '../../airev/verify.js';
import { git } from '../../provenance/pr.js';
import { mergeReviewConfig } from './review-config.js';

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
    // own review) over the team's settings from Settings, Review, with the
    // model the cloud review pays for (review-config.js: defaults < team <
    // repository file, per field).
    // A team that turned cloud review on expects every pull request reviewed.
    // The engine's default skips lines it takes for human-written outside
    // sensitive paths, and in a repository that has notes, every commit made
    // without Grapim looks human-written: twfly104/grapim#5 got 0 of 17 hunks
    // reviewed. So the cloud reviews everything unless the repository's own
    // .grapim/review.json picks a mode.
    const raw = git(job.dir, ['cat-file', 'blob', `${job.base}:${CONFIG_FILE}`], { allowFail: true });
    let repo = null;
    if (raw !== null) {
      parseConfigText(String(raw)); // a ConfigError says what to fix in the file
      repo = JSON.parse(String(raw).replace(/^﻿/, ''));
    }
    config = mergeReviewConfig({ team: job.teamConfig ?? null, repo, model: job.model });
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
  // A second look before posting (airev/verify.js): each finding goes back to
  // the model with the code around it, its uses, the commit messages and the
  // pull request's discussion; the ones that context contradicts are dropped.
  if (job.verify !== false && result.findings?.length) {
    const v = await verifyFindings({
      findings: result.findings,
      git: (args) => git(job.dir, args, { allowFail: true }),
      base: job.base,
      head: job.head,
      provider,
      model: job.model,
      request: job.request ?? null,
      discussion: typeof job.discussion === 'string' ? job.discussion : '',
      log: (line) => process.stderr.write(`${line}\n`),
    });
    result.stats = { ...result.stats, inputTokens: (result.stats?.inputTokens ?? 0) + v.usage.input, outputTokens: (result.stats?.outputTokens ?? 0) + v.usage.output, secondLook: { checked: v.checked, dropped: v.dropped.length } };
    if (v.dropped.length) {
      result.findings = v.kept;
      result.summary = withCounts(result.summary, v.kept, v.dropped.length);
    }
  }
  return { ok: true, result: { ...result, failOn: config.failOn } };
}

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
// The engine's summary opens with the counts (**1 blocker, 0 warnings, 0 nits**);
// after the second look they are recounted and the drop is said once.
export function withCounts(summary, kept, droppedCount) {
  const n = { blocker: 0, warning: 0, nit: 0 };
  for (const f of kept) if (f.severity in n) n[f.severity]++;
  const counts = kept.length ? `**${plural(n.blocker, 'blocker')}, ${plural(n.warning, 'warning')}, ${plural(n.nit, 'nit')}**` : '**No problems found**';
  const note = `_A second look at the code and the discussion dropped ${plural(droppedCount, 'finding')} before posting._`;
  const text = String(summary ?? '');
  const re = /\*\*\d+ blockers?, \d+ warnings?, \d+ nits?\*\*/;
  return `${re.test(text) ? text.replace(re, counts) : text}\n\n${note}`;
}

// Only as a program (cloud-review.js spawns it); importing it runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((out) => process.stdout.write(`${JSON.stringify(out)}\n`))
    .catch((err) => {
      process.stdout.write(`${JSON.stringify({ ok: false, config: err instanceof ConfigError, error: String(err?.message ?? err).slice(0, 500) })}\n`);
      process.exitCode = 1;
    });
}
