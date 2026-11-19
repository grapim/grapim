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
import { COUNTS_RE, VERDICT_RE, WORTH_RE, countsBold, verdictLine, rankFindings } from '../../airev/findings.js';
import { factsFromGit } from '../../airev/decision.js';
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
  // pull request's discussion, and it may search the repository. The low-
  // confidence points the engine held for the summary ("Worth a look") are
  // checked too: the ones the second look confirms are posted, the rest are
  // not shown at all, so a guess the reviewer could not check never reaches
  // the pull request. Findings it contradicts, or that are remarks rather than
  // defects, are dropped.
  const held = Array.isArray(result.held) ? result.held : [];
  if (job.verify !== false && (result.findings?.length || held.length)) {
    const v = await verifyFindings({
      findings: [...(result.findings ?? []), ...held],
      // A model-chosen search must not hang the job: 15 s per git call.
      git: (args) => git(job.dir, args, { allowFail: true, timeout: 15_000 }),
      base: job.base,
      head: job.head,
      provider,
      model: job.model,
      request: job.request ?? null,
      discussion: typeof job.discussion === 'string' ? job.discussion : '',
      // Search the repository at the head before keeping a finding (repo-tools.js).
      tools: job.verifyTools !== false,
      log: (line) => process.stderr.write(`${line}\n`),
    });
    result.stats = { ...result.stats, inputTokens: (result.stats?.inputTokens ?? 0) + v.usage.input, outputTokens: (result.stats?.outputTokens ?? 0) + v.usage.output, secondLook: { checked: v.checked, dropped: v.dropped.length, searches: v.searches ?? 0 } };
    if (v.checked) {
      const { posted, removed } = afterCheck(result.findings ?? [], held, v);
      result.findings = posted;
      result.held = [];
      result.summary = withCounts(String(result.summary ?? '').replace(WORTH_RE, ''), posted, removed);
    }
  }
  // What the merge decision card needs (airev/decision.js): paths, counts, test
  // skips, the runs and their prompts. Never fails the review.
  const facts = factsFromGit({ cwd: job.dir, base: job.base, head: job.head, config, log: (line) => process.stderr.write(`${line}\n`) });
  return { ok: true, result: { ...result, failOn: config.failOn, ...(facts ? { facts } : {}), gate: config.gate ?? null } };
}

// After the second look: the posted findings it kept, plus the held ones it
// confirmed (verdict keep); a held finding it did not check stays out, as
// before. -> { posted, removed: how many of the posted ones were dropped }
export function afterCheck(findings, held, v) {
  const verdictOf = new Map((v.verdicts ?? []).map((x) => [x.finding, x.verdict]));
  const kept = new Set(v.kept);
  const posted = findings.filter((f) => kept.has(f));
  const confirmed = held.filter((f) => kept.has(f) && verdictOf.get(f) === 'keep');
  return { posted: confirmed.length ? rankFindings([...posted, ...confirmed]) : posted, removed: findings.length - posted.length };
}

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
// The engine's summary opens with the counts (**1 blocker, 0 warnings, 0 nits**);
// after the second look they are recounted and the drop is said once.
export function withCounts(summary, kept, droppedCount) {
  const n = { blocker: 0, warning: 0, nit: 0 };
  for (const f of kept) if (f.severity in n) n[f.severity]++;
  const note = droppedCount ? `_A second look at the code and the discussion dropped ${plural(droppedCount, 'finding')} before posting._` : '';
  let text = String(summary ?? '').replace(VERDICT_RE, '');
  // The counts line, then the verdict from the blockers that are left.
  const m = text.match(COUNTS_RE);
  if (m) {
    const end = text.indexOf('\n', m.index);
    const line = text.slice(m.index, end === -1 ? undefined : end).replace(COUNTS_RE, countsBold(n));
    text = `${text.slice(0, m.index)}${line}${verdictLine(kept)}${end === -1 ? '' : text.slice(end)}`;
  }
  return note ? `${text}\n\n${note}` : text;
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
