// Cost estimate before any model call: input tokens per PR per tool from the
// real diffs (chars / 4), and output tokens from stated assumptions. The
// numbers are an approval aid, not a measurement; run.mjs measures the real
// usage through the metering proxy.

import { collectChanges, planReview } from '../../src/airev/diff.js';
import { DEFAULT_CONFIG, SYSTEM_PROMPT, FINDINGS_SCHEMA } from '../../src/airev/index.js';
import { git, prDiff } from './git.mjs';
import { requestText } from './provenance.mjs';
import { PRICES } from './score-lib.mjs';

export const tok = (chars) => Math.ceil(chars / 4);

// Assumptions, in one place so the README can quote them.
export const ASSUMPTIONS = Object.freeze({
  grapimOutputPerBatch: 3000, // adaptive thinking at medium/high effort + findings JSON
  prAgentPromptTokens: 3500, // PR-Agent's review system + user template
  prAgentContextFactor: 1.35, // it widens hunks with extra context lines
  prAgentOutput: 4000, // YAML review + adaptive thinking
  claudeBaseContext: 22000, // Claude Code system prompt + tool definitions
  claudeTurnsBase: 8, // read PR, diff, a few searches, comments, wrap-up
  claudeTurnsPerFile: 1.5, // reads / greps per changed file
  claudeReadTokensPerFile: 3500, // file text it reads per changed file, average
  claudeOutputPerTurn: 700, // tool call or comment + thinking per turn
});

function fileReader(gitDir, head) {
  return (p) => {
    const size = Number(git(gitDir, ['cat-file', '-s', `${head}:${p}`], { allowFail: true }));
    if (!Number.isFinite(size) || size > 256 * 1024) return null;
    return git(gitDir, ['cat-file', 'blob', `${head}:${p}`], { allowFail: true });
  };
}

// -> { grapim, 'grapim-noprov', 'pr-agent', 'claude-action' }: { input, cacheRead, cacheWrite, output, usd, requests }
export function estimatePr(pr, gitDir) {
  const A = ASSUMPTIONS;
  const diff = prDiff(gitDir, pr);
  const diffTok = tok(diff.length);
  const descTok = tok(`${pr.title}\n${pr.body ?? ''}`.length + (pr.linked_issues ?? []).reduce((n, i) => n + `${i.title}\n${i.body ?? ''}`.length, 0));
  const files = (diff.match(/^diff --git /gm) ?? []).length;

  // Grapim: the real plan (batches, file context) of src/airev.
  const changes = collectChanges({ cwd: gitDir, base: pr.base_sha, head: pr.head_sha, config: { ...DEFAULT_CONFIG, review: 'all' } });
  const plan = planReview(changes, { ...DEFAULT_CONFIG, review: 'all' }, { fileText: fileReader(gitDir, changes.head) });
  const sysTok = tok(SYSTEM_PROMPT.length + JSON.stringify(FINDINGS_SCHEMA).length);
  const intentTok = tok(requestText(pr).length);
  const batches = plan.batches.length;
  const grapim = {
    requests: batches,
    cacheWrite: batches ? sysTok : 0,
    cacheRead: Math.max(0, batches - 1) * sysTok,
    input: plan.batches.reduce((n, b) => n + b.tokens + intentTok + 200, 0),
    output: batches * A.grapimOutputPerBatch,
  };
  const noprov = { ...grapim, input: grapim.input - batches * intentTok };

  const prAgent = { requests: 1, cacheWrite: 0, cacheRead: 0, input: Math.round(A.prAgentPromptTokens + descTok + diffTok * A.prAgentContextFactor), output: A.prAgentOutput };

  // Claude Code: every turn re-sends the conversation; the prefix is cached,
  // so a turn pays cache reads for the old context and a cache write for the new.
  const turns = Math.round(A.claudeTurnsBase + A.claudeTurnsPerFile * files);
  const grows = diffTok + descTok + files * A.claudeReadTokensPerFile + turns * A.claudeOutputPerTurn;
  const perTurnGrowth = grows / turns;
  let cacheRead = 0;
  for (let t = 0; t < turns; t++) cacheRead += A.claudeBaseContext + perTurnGrowth * t;
  const claude = { requests: turns, cacheWrite: Math.round(A.claudeBaseContext + grows), cacheRead: Math.round(cacheRead), input: turns * 50, output: turns * A.claudeOutputPerTurn };

  const out = { grapim, 'grapim-noprov': noprov, 'pr-agent': prAgent, 'claude-action': claude };
  const p = PRICES['claude-opus-5-5'];
  for (const v of Object.values(out)) v.usd = (v.input * p.input + v.output * p.output + v.cacheRead * p.cacheRead + v.cacheWrite * p.cacheWrite) / 1e6;
  return { diffTokens: diffTok, files, ...out };
}
