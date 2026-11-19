// Grapim Review engine (docs/design-ai-review.md): plans which hunks of a
// change to review and how deeply (agent-written and sensitive first, from the
// provenance notes), sends them in batches to the model endpoint the customer
// chose, and returns validated findings plus a short summary. No GitHub code,
// no dependencies: node: builtins and plain fetch.
//
//   reviewChanges({ cwd, base, head, config, provider, request, fetchImpl, log, now })
//     -> { findings, summary, stats, skipped }
//   loadConfig(cwd, { rev }?) -> config
//   providerFromEnv(env, config) -> provider (throws ConfigError)

import { git, GitError } from '../provenance/pr.js';
import { ConfigError, DEFAULT_CONFIG, loadConfig, validateConfig } from './config.js';
import { collectChanges, planReview, splitBatch, runAtLine, maxDepth, DEFAULT_LIMITS } from './diff.js';
import { buildRequest } from './prompt.js';
import { normalizeRequest } from './request.js';
import { ProviderError, providerFromEnv, describeProvider } from './providers.js';
import { parseFindingsText, validateFindings, mergePasses, capFindings, rankFindings, splitByConfidence, renderReviewSummary, isTestFile } from './findings.js';

export { ConfigError, DEFAULT_CONFIG, loadConfig, validateConfig } from './config.js';
export { ProviderError, providerFromEnv, anthropicProvider, bedrockProvider, vertexProvider, foundryProvider, describeProvider } from './providers.js';
export { SYSTEM_PROMPT, FINDINGS_SCHEMA, REQUEST_GUIDE, buildRequest } from './prompt.js';
export { normalizeRequest, closingIssues, requestFromFile, REQUEST_LIMITS } from './request.js';
export { GitError };

export const REVIEW_MARKER = '<!-- grapim:review -->';
const RETRY_DELAYS_MS = [2000, 8000];
const DEFAULT_CONCURRENCY = 3;
const MAX_CONTEXT_FILE_BYTES = 256 * 1024;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const category = (c) => (typeof c === 'string' && /^[A-Za-z0-9_\-]{1,40}$/.test(c) ? c : null);

// The file at the head, for context, when it is small text.
function headFileReader(cwd, head) {
  return (p) => {
    const size = Number(git(cwd, ['cat-file', '-s', `${head}:${p}`], { allowFail: true }));
    if (!Number.isFinite(size) || size > MAX_CONTEXT_FILE_BYTES) return null;
    const text = git(cwd, ['cat-file', 'blob', `${head}:${p}`], { allowFail: true });
    return typeof text === 'string' ? text.replace(/\r\n/g, '\n') : null;
  };
}

export async function reviewChanges({
  cwd,
  base,
  head = 'HEAD',
  config,
  provider,
  // The pull request's stated request: { title, body, issues: [{ number, title, body }] }.
  // Context for every batch; it never changes which hunks are reviewed.
  request,
  fetchImpl,
  log = () => {},
  now,
  signal,
  env = process.env,
  limits = {},
  concurrency = DEFAULT_CONCURRENCY,
  sleep = defaultSleep,
  // true when the review runs on Grapim's server (cloud review): the summary
  // then says where the code went instead of "Grapim received nothing".
  hosted = false,
  // Paths to review; the other changed files are left as an earlier review
  // left them (cloud review after new commits: only the files those commits
  // touched). null reviews every changed file.
  only = null,
} = {}) {
  if (!cwd) throw new ConfigError('reviewChanges needs cwd, the path of a git checkout.');
  const cfg = config ? validateConfig(config) : loadConfig(cwd);
  const prov = provider ?? providerFromEnv(env, cfg, { fetchImpl });
  const clock = () => {
    const v = now ? now() : Date.now();
    return v instanceof Date ? v : new Date(v);
  };
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const req = normalizeRequest(request);

  const changes = collectChanges({ cwd, base, head, config: cfg, limits: lim });
  const onlySet = Array.isArray(only) ? new Set(only) : null;
  const unchangedFiles = onlySet ? changes.files.filter((f) => !onlySet.has(f.path)).length : 0;
  const planned = onlySet ? { ...changes, files: changes.files.filter((f) => onlySet.has(f.path)) } : changes;
  const plan = planReview(planned, cfg, { limits: lim, fileText: headFileReader(cwd, changes.head) });
  log(`Grapim Review: ${changes.files.length} files changed, ${plan.stats.hunks} hunks (${plan.stats.aiHunks} by agent runs); ${plan.batches.length} requests to ${describeProvider(prov)}.`);
  if (req && plan.batches.length) log(`Compared with: ${req.sources.join(', ')}.`);

  // Every changed file, for the CHANGES block of a request that holds only some.
  const overview = changes.files.map((f) => ({
    path: f.path,
    status: f.status,
    added: f.hunks.reduce((n, h) => n + h.added.length, 0),
    removed: f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === '-').length, 0),
  }));

  const skipped = [...plan.skipped];
  const skipKeys = new Set(skipped.map((s) => `${s.path}\u0000${s.reason}`));
  const skip = (path, reason) => {
    const k = `${path}\u0000${reason}`;
    if (!skipKeys.has(k)) {
      skipKeys.add(k);
      skipped.push({ path, reason });
    }
  };
  const usage = { input: 0, output: 0, requests: 0, byModel: {} };
  const found = [];
  let dropped = 0;
  let reviewedHunks = 0;
  let reviewedAiHunks = 0;
  const reviewedFiles = new Set();
  const runs = new Map();

  async function send(body) {
    for (let attempt = 0; ; attempt++) {
      try {
        usage.requests++;
        return await prov.send(body, { fetchImpl, signal, now: clock });
      } catch (err) {
        if (!(err instanceof ProviderError) || !err.retryable || attempt >= RETRY_DELAYS_MS.length) throw err;
        const wait = err.retryAfterMs ?? RETRY_DELAYS_MS[attempt];
        log(`${err.message} Retrying in ${Math.round(wait / 1000)} s.`);
        await sleep(wait);
      }
    }
  }

  const skipBatch = (batch, reason) => {
    for (const u of batch.units) skip(u.path, reason);
  };

  // The batch is counted as reviewed once, by the first pass that answers.
  function countReviewed(batch) {
    for (const unit of batch.units) {
      reviewedFiles.add(unit.path);
      for (const h of unit.hunks) {
        reviewedHunks++;
        if (h.ai) reviewedAiHunks++;
        for (const r of h.runs) {
          const agg = runs.get(r.id) ?? { id: r.id, label: r.label || r.id, kind: r.kind, intent: null, hunks: 0, depth: 'low' };
          agg.hunks++;
          agg.depth = maxDepth(agg.depth, h.depth);
          if (!agg.intent && r.intents.length) agg.intent = r.intents[0];
          runs.set(r.id, agg);
        }
      }
    }
  }

  // One batch: the same request sent `passes` times, one after the other (a
  // later pass reads the prompt from the cache the first one wrote). A pass
  // that fails after an earlier one answered ends the batch quietly: it was
  // reviewed once. Only a first pass that fails marks its files as skipped.
  async function runBatch(batch) {
    const model = batch.effort === 'low' && cfg.lowModel ? cfg.lowModel : cfg.model;
    const { body } = buildRequest(batch, { model, instructions: cfg.instructions, request: req, overview, cache: cfg.passes > 1 });
    const files = batch.units.length;
    log(`Request ${batch.id}: ${files} file${files === 1 ? '' : 's'}, effort ${batch.effort}, about ${batch.tokens.toLocaleString('en-US')} tokens${cfg.passes > 1 ? `, ${cfg.passes} passes` : ''}.`);
    const allowed = new Map();
    for (const unit of batch.units) allowed.set(unit.path, unit.hunks.map((h) => ({ added: new Set(h.added) })));
    for (let pass = 0; pass < cfg.passes; pass++) {
      const first = pass === 0;
      let msg;
      try {
        msg = await send(body);
      } catch (err) {
        if (err instanceof ProviderError && !err.fatal) {
          log(`Request ${batch.id} failed: ${err.message}`);
          if (first) skipBatch(batch, `the model request failed (${err.status ? `HTTP ${err.status}` : err.type ?? 'error'})`);
          return;
        }
        throw err;
      }
      const u = msg.usage ?? {};
      usage.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      usage.output += u.output_tokens ?? 0;
      const m = (usage.byModel[model] ??= { input: 0, output: 0 });
      m.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      m.output += u.output_tokens ?? 0;

      if (msg.stop_reason === 'refusal') {
        const c = category(msg.stop_details?.category);
        log(`Request ${batch.id}: the model declined${c ? ` (${c})` : ''}.`);
        if (first) skipBatch(batch, `the model declined to review it${c ? ` (category: ${c})` : ''}`);
        return;
      }
      if (msg.stop_reason === 'max_tokens') {
        if (!first) return;
        const parts = batch.retried ? [] : splitBatch(batch);
        if (!parts.length) return skipBatch(batch, "the review did not fit in the model's output limit");
        log(`Request ${batch.id} ran out of output tokens; retrying in ${parts.length} smaller requests.`);
        for (const p of parts) await runBatch(p);
        return;
      }
      const v = validateFindings(parseFindingsText(msg), allowed);
      if (v.malformed) {
        if (first) skipBatch(batch, "the model's answer was not valid findings JSON");
        return;
      }
      dropped += v.dropped;
      found.push(...v.findings.map((f) => ({ ...f, pass })));
      if (first) countReviewed(batch);
    }
  }

  // A small pool: batches run concurrently, a fatal error stops the review.
  const queue = [...plan.batches];
  let fatal = null;
  const worker = async () => {
    while (queue.length && !fatal) {
      const b = queue.shift();
      try {
        await runBatch(b);
      } catch (err) {
        fatal ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  if (fatal) throw fatal;

  const { sure, held: unsure } = splitByConfidence(mergePasses(found));
  const held = rankFindings(unsure);
  const { kept, omitted } = capFindings(sure, cfg.maxComments);
  const findings = rankFindings(kept).map((f) => {
    const run = runAtLine(changes, f.path, f.line);
    return run ? { ...f, run: { id: run.id, kind: run.kind, intent: run.intent } } : f;
  });

  const stats = {
    files: changes.files.length,
    hunks: plan.stats.hunks,
    reviewedHunks,
    aiHunks: plan.stats.aiHunks,
    skippedHunks: plan.stats.hunks - reviewedHunks,
    inputTokens: usage.input,
    outputTokens: usage.output,
    model: cfg.model,
    // Tokens per model, when "lowModel" sent some batches to a cheaper one.
    byModel: usage.byModel,
    provider: prov.name,
    reviewedFiles: reviewedFiles.size,
    reviewedAiHunks,
    requests: usage.requests,
    droppedFindings: dropped,
    omittedFindings: omitted,
    comparedWith: req && reviewedHunks ? req.sources : [],
    noNotes: plan.stats.noNotes === true,
    heldFindings: held.length,
    passes: cfg.passes,
    // Changed files not looked at again because "only" left them out.
    unchangedFiles,
  };
  const runList = [...runs.values()].sort((a, b) => b.hunks - a.hunks || a.label.localeCompare(b.label));
  const deletedTests = changes.files.filter((f) => f.status === 'deleted' && isTestFile(f.path)).map((f) => f.path);
  const summary = renderReviewSummary({ findings, stats, skipped, runs: runList, providerText: describeProvider(prov), requests: usage.requests, deletedTests, held, hosted });
  return { findings, held, summary, stats, skipped, deletedTests, base: changes.base, head: changes.head };
}
