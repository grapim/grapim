// The reviewers under test. Each adapter takes one prepared PR and returns
//   { status: 'ok'|'skipped'|'error', findings: [{ path, line, end_line,
//     severity, category, title, body }], usage, seconds, raw, note }
// All model traffic goes through the metering proxy (meter-proxy.mjs) so
// tokens and cost are counted the same way for every tool; in --dry mode the
// proxy answers locally and nothing leaves the machine.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reviewChanges, anthropicProvider, providerFromEnv, DEFAULT_CONFIG, SYSTEM_PROMPT } from '../../src/airev/index.js';
import { startProxy, emptyUsage, addUsage } from './meter-proxy.mjs';
import { claudeCliProvider } from './cli-provider.mjs';
import { dryReply, parsePrAgentReview, parseClaudeStream, parseClaudeComments } from './parsers.mjs';
import { writeNotes, requestText } from './provenance.mjs';
import { git, prDiff, changedFiles, worktree, addedRanges } from './git.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MODEL = process.env.BENCH_MODEL || 'claude-opus-5-5';

// ---------------------------------------------------------------- dry replies


// ---------------------------------------------------------------- helpers

function runProcess(cmd, args, { cwd, env, input, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(t);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function which(cmd) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

// The parent environment minus any Claude / Anthropic settings (a host session's
// base URL, OAuth or sandbox variables must not leak into the tool under test).
export function cleanEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^(?:CLAUDE|ANTHROPIC|CLAUDECODE)/i.test(k)) out[k] = v;
  return out;
}

const flat = (f) => ({ path: f.path, line: f.line, end_line: f.endLine ?? f.line, severity: f.severity, confidence: f.confidence, category: f.category, title: f.title, body: f.body, ...(f.raised ? { raised: f.raised } : {}) });

const proxyFor = (ctx, hint = null) => startProxy({ mode: ctx.dry ? 'fake' : 'forward', reply: (body) => dryReply(body, hint) });

// ---------------------------------------------------------------- grapim

// What the pull request asked for, as the Action reads it (action/review): its
// title and description and up to three issues it closes. PR-Agent gets the
// same text (prAgentDescription), so no tool reviews blind.
export const requestOf = (pr) => ({
  title: pr.title ?? '',
  body: pr.body ?? '',
  issues: (pr.linked_issues ?? []).slice(0, 3).map((i) => ({ number: i.number, title: i.title ?? '', body: i.body ?? '' })),
});

// limits: reviewChanges limits of a variant (grapim-lean sends no whole files).
// effort: a tuning variant sends every request at this API effort, whatever
// depth the plan gave the batch.
// passes: the engine's "passes" setting (how many times each request is reviewed).
async function grapimReview(pr, ctx, { provenance, limits = {}, effort = null, passes = 1, lowModel = null }) {
  const gitDir = ctx.gitDir(pr);
  let notes = 0;
  if (provenance) notes = writeNotes(gitDir, pr, { intentChars: ctx.intentChars });
  const config = { ...DEFAULT_CONFIG, model: MODEL, review: provenance ? 'ai-and-sensitive' : 'all', passes, lowModel };
  const external = !ctx.dry && process.env.GRAPIM_REVIEW_PROVIDER && process.env.GRAPIM_REVIEW_PROVIDER !== 'anthropic';
  // --via-cli: a tuning run through the logged-in Claude Code CLI (cli-provider.mjs).
  const viaCli = !ctx.dry && ctx.viaCli;
  const cliUsage = emptyUsage();
  // The CLI's environment: none of the calling session's Claude settings, but
  // the sign-in token a terminal provides (the desktop app's does), when set.
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const cliEnv = { ...cleanEnv(), ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}) };
  const cli = viaCli ? claudeCliProvider({ model: MODEL, env: cliEnv, onUsage: (u, m) => { cliUsage.requests++; addUsage(cliUsage, u, m ?? MODEL); } }) : null;
  const proxy = external || viaCli ? null : await proxyFor(ctx);
  try {
    const base = cli
      ?? (external
        ? providerFromEnv(process.env, config)
        : anthropicProvider({ apiKey: ctx.dry ? 'sk-ant-dry-run' : process.env.ANTHROPIC_API_KEY, model: MODEL, baseUrl: proxy.url }));
    const provider = effort ? { ...base, send: (body, o) => base.send({ ...body, output_config: { ...body.output_config, effort } }, o) } : base;
    // The engine finds the repository through cwd. A shell that sets
    // safe.bareRepository=explicit (the Claude desktop app's terminal does)
    // refuses a bare one found that way, so a CLI run names it in GIT_DIR;
    // run.mjs keeps such a run to one review at a time. Set after the CLI
    // provider took its copy of the environment, so the CLI never sees it.
    if (viaCli) process.env.GIT_DIR = gitDir;
    const t0 = Date.now();
    const r = await reviewChanges({ cwd: gitDir, base: pr.base_sha, head: pr.head_sha, config, provider, request: requestOf(pr), limits, log: ctx.verbose ? ctx.log : () => {}, env: {} });
    const seconds = (Date.now() - t0) / 1000;
    const usage = cli ? cliUsage : proxy ? { ...proxy.usage } : addUsage(emptyUsage(), { input_tokens: r.stats.inputTokens, output_tokens: r.stats.outputTokens });
    return {
      status: 'ok',
      ...(cli ? { via: 'claude-cli' } : {}),
      findings: r.findings.map(flat),
      usage,
      seconds,
      // held: low-confidence findings, listed in the summary and not posted inline.
      raw: { stats: r.stats, skipped: r.skipped, deletedTests: r.deletedTests, notesWritten: notes, held: (r.held ?? []).map(flat) },
    };
  } finally {
    if (viaCli) delete process.env.GIT_DIR;
    await proxy?.close();
    cli?.close();
    if (provenance) git(gitDir, ['update-ref', '-d', 'refs/notes/grapim'], { allowFail: true });
  }
}

// ---------------------------------------------------------------- pr-agent

// PR-Agent (github.com/The-PR-Agent/pr-agent) in plain-diff mode: it reviews a
// unified diff file and writes the structured review to --json-output, with
// no GitHub access. Title and description go in as plain_diff.title and
// plain_diff.description (the linked issue appended, standing in for the
// ticket context its GitHub mode reads).
export function prAgentCommand() {
  if (process.env.BENCH_PR_AGENT_CMD) return process.env.BENCH_PR_AGENT_CMD.split(' ');
  if (which('pr-agent')) return ['pr-agent'];
  return null;
}

export function prAgentDescription(pr) {
  const issues = (pr.linked_issues ?? []).map((i) => `\n\nLinked issue #${i.number}: ${i.title}\n${i.body ?? ''}`).join('');
  return `${pr.body ?? ''}${issues}`.slice(0, 30_000);
}


async function prAgent(pr, ctx) {
  const cmd = prAgentCommand();
  if (!cmd) return { status: 'skipped', note: 'pr-agent is not installed (pip install pr-agent, or set BENCH_PR_AGENT_CMD). See bench/README.md.' };
  const dir = ctx.workDir(pr, 'pr-agent');
  const gitDir = ctx.gitDir(pr);
  const diffFile = path.join(dir, 'pr.diff');
  fs.writeFileSync(diffFile, prDiff(gitDir, pr));
  const out = path.join(dir, 'review.json');
  fs.rmSync(out, { force: true });
  const proxy = await proxyFor(ctx);
  const key = ctx.dry ? 'sk-ant-dry-run' : process.env.ANTHROPIC_API_KEY;
  // Dynaconf env overrides (section__key) set the model the same as the others.
  const env = {
    ...cleanEnv(),
    ANTHROPIC_API_KEY: key,
    ANTHROPIC__KEY: key,
    ANTHROPIC_API_BASE: proxy.url,
    ANTHROPIC_BASE_URL: proxy.url,
    CONFIG__MODEL: `anthropic/${MODEL}`,
    CONFIG__FALLBACK_MODELS: `["anthropic/${MODEL}"]`,
    CONFIG__CUSTOM_MODEL_MAX_TOKENS: '200000',
    // Opus 5.5 rejects temperature (400) and always thinks (adaptive).
    CONFIG__NO_TEMPERATURE_MODELS: `["anthropic/${MODEL}", "${MODEL}"]`,
    CONFIG__ENABLE_CLAUDE_ADAPTIVE_THINKING: 'true',
    CONFIG__CLAUDE_ADAPTIVE_THINKING_MODELS_OVERRIDE: `["anthropic/${MODEL}", "${MODEL}"]`,
    CONFIG__PUBLISH_OUTPUT: 'true',
    GITHUB__USER_TOKEN: '',
    LOG_LEVEL: ctx.verbose ? 'INFO' : 'WARNING',
  };
  try {
    const t0 = Date.now();
    const r = await runProcess(cmd[0], [...cmd.slice(1), `--diff-file=${diffFile}`, `--json-output=${out}`, 'review', `--plain_diff.title=${pr.title}`, `--plain_diff.description=${prAgentDescription(pr)}`], { cwd: dir, env });
    const seconds = (Date.now() - t0) / 1000;
    let json = null;
    try {
      json = JSON.parse(fs.readFileSync(out, 'utf8'));
    } catch {}
    if (!json) return { status: 'error', note: `pr-agent exited ${r.code} without a JSON review: ${r.stderr.slice(-800)}`, usage: { ...proxy.usage }, seconds };
    return { status: 'ok', findings: parsePrAgentReview(json), usage: { ...proxy.usage }, seconds, raw: { review: json, stdout: r.stdout.slice(-4000) } };
  } finally {
    await proxy.close();
  }
}

// ---------------------------------------------------------------- claude-action

// The review prompt of anthropics/claude-code-action's comprehensive PR
// review example (examples/pr-review-comprehensive.yml), verbatim but for the
// REPO and PR NUMBER values, run with the Claude Code CLI headless and the
// same allowed tools. `gh` is a local shim answering from the snapshot of the
// PR at the reviewed head, and the inline-comment MCP server records comments
// instead of posting them.
export function claudeActionPrompt(pr) {
  return `REPO: ${pr.repo}
PR NUMBER: ${pr.number}

Perform a comprehensive code review with the following focus areas:

1. **Code Quality**
   - Clean code principles and best practices
   - Proper error handling and edge cases
   - Code readability and maintainability

2. **Security**
   - Check for potential security vulnerabilities
   - Validate input sanitization
   - Review authentication/authorization logic

3. **Performance**
   - Identify potential performance bottlenecks
   - Review database queries for efficiency
   - Check for memory leaks or resource issues

4. **Testing**
   - Verify adequate test coverage
   - Review test quality and edge cases
   - Check for missing test scenarios

5. **Documentation**
   - Ensure code is properly documented
   - Verify README updates for new features
   - Check API documentation accuracy

Provide detailed feedback using inline comments for specific issues.
Use top-level comments for general observations or praise.
`;
}

export const CLAUDE_ALLOWED_TOOLS = 'mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*),Read,Glob,Grep,LS';



function shimBin(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(HERE, 'gh-shim.mjs').replace(/\\/g, '/');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec node "${shim}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gh.cmd'), `@echo off\r\nnode "${shim}" %*\r\n`);
  return bin;
}

// Usage of a --via-cli agent run, from the result event of its stream
// (modelUsage adds up every turn and every model).
function cliStreamUsage(stdout) {
  const u = emptyUsage();
  for (const line of String(stdout).split('\n')) {
    if (!line.includes('"type":"result"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type !== 'result') continue;
      for (const [model, m] of Object.entries(e.modelUsage ?? {})) addUsage(u, { input_tokens: m.inputTokens, output_tokens: m.outputTokens, cache_read_input_tokens: m.cacheReadInputTokens, cache_creation_input_tokens: m.cacheCreationInputTokens }, model);
      u.requests = e.num_turns ?? 0;
    } catch {
      // not the result line
    }
  }
  return u;
}

async function claudeAction(pr, ctx) {
  const claude = process.env.BENCH_CLAUDE_CMD || which('claude');
  if (!claude) return { status: 'skipped', note: 'The claude CLI is not installed (npm i -g @anthropic-ai/claude-code).' };
  const dir = ctx.workDir(pr, 'claude-action');
  const gitDir = ctx.gitDir(pr);
  const tree = worktree(pr, gitDir);
  // The PR snapshot the gh shim serves.
  const snap = path.join(dir, 'pr');
  fs.mkdirSync(snap, { recursive: true });
  fs.writeFileSync(path.join(snap, 'pr.diff'), prDiff(gitDir, pr));
  fs.writeFileSync(path.join(snap, 'pr.json'), JSON.stringify({ number: pr.number, title: pr.title, body: pr.body, author: pr.author ?? pr.agent, url: pr.url, files: changedFiles(gitDir, pr), linked_issues: pr.linked_issues ?? [] }));
  const comments = path.join(dir, 'comments.jsonl');
  fs.rmSync(comments, { force: true });
  const mcpConfig = path.join(dir, 'mcp.json');
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { github_inline_comment: { command: 'node', args: [path.join(HERE, 'inline-comment-mcp.mjs')], env: { BENCH_COMMENTS_FILE: comments } } } }));
  // For --dry: a changed line, so the scripted fake agent can comment on it.
  const firstAdded = Object.entries(addedRanges(prDiff(gitDir, pr)))[0];
  // --via-cli: the agent runs on the Claude plan the shell is signed in to (no
  // API key, no metering proxy; usage is read from the agent's own result).
  const viaCli = !ctx.dry && ctx.viaCli;
  const proxy = viaCli ? null : await proxyFor(ctx, firstAdded ? { path: firstAdded[0], line: firstAdded[1][0][0] } : null);
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  // Its own empty settings folder: none of this machine's Claude settings,
  // memory, hooks or plugins reach the tool under test.
  const configDir = path.join(dir, 'claude-config');
  if (viaCli) fs.mkdirSync(configDir, { recursive: true });
  // BENCH_CLAUDE_TMP: a scratch folder for the agent's shell, when the default temp folder is not writable.
  const tmpDir = process.env.BENCH_CLAUDE_TMP || null;
  if (tmpDir) fs.mkdirSync(tmpDir, { recursive: true });
  const env = {
    ...cleanEnv(),
    PATH:`${shimBin(dir)}${path.delimiter}${process.env.PATH}`,
    BENCH_PR_DIR: snap,
    BENCH_COMMENTS_FILE: comments,
    ...(viaCli
      ? { CLAUDE_CONFIG_DIR: configDir, ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}) }
      : { ANTHROPIC_API_KEY: ctx.dry ? 'sk-ant-dry-run' : process.env.ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL: proxy.url }),
    ANTHROPIC_MODEL: MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_USE_BEDROCK: '',
    CLAUDE_CODE_USE_VERTEX: '',
    ...(tmpDir ? { TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir, CLAUDE_CODE_TMPDIR: tmpDir } : {}),
  };
  delete env.ANTHROPIC_AUTH_TOKEN;
  try {
    const t0 = Date.now();
    const r = await runProcess(claude, ['-p', claudeActionPrompt(pr), '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--mcp-config', mcpConfig, '--strict-mcp-config', '--setting-sources', 'user', '--allowedTools', CLAUDE_ALLOWED_TOOLS, '--max-turns', String(ctx.claudeMaxTurns ?? 60)], { cwd: tree, env });
    const seconds = (Date.now() - t0) / 1000;
    // The comment tool calls, from the event stream (the MCP stand-in's file is
    // the fallback); they are what the action would post.
    const { records, result } = parseClaudeStream(r.stdout);
    const fromFile = fs.existsSync(comments) ? fs.readFileSync(comments, 'utf8') : '';
    const { findings, summaries } = parseClaudeComments(records.trim() ? records : fromFile);
    fs.writeFileSync(path.join(dir, 'stream.jsonl'), r.stdout);
    const status = r.code === 0 || findings.length ? 'ok' : 'error';
    return { status, ...(viaCli ? { via: 'claude-cli' } : {}), note: status === 'error' ? `claude exited ${r.code}: ${(r.stderr || r.stdout).slice(-800)}` : undefined, findings, usage: viaCli ? cliStreamUsage(r.stdout) : { ...proxy.usage }, seconds, raw: { result, summaries, proxyRequests: proxy?.log.length ?? null } };
  } finally {
    await proxy?.close();
  }
}

export const ADAPTERS = Object.freeze({
  grapim: (pr, ctx) => grapimReview(pr, ctx, { provenance: true }),
  'grapim-noprov': (pr, ctx) => grapimReview(pr, ctx, { provenance: false }),
  // The same review on the diff alone: no whole files, 10 context lines a side.
  'grapim-lean': (pr, ctx) => grapimReview(pr, ctx, { provenance: false, limits: { fileContextChars: 0, contextLines: 10 } }),
  // grapim-lean with depth-"low" batches (human-written, off the sensitive paths) on Sonnet 5.5.
  'grapim-lean-sonnet-low': (pr, ctx) => grapimReview(pr, ctx, { provenance: false, limits: { fileContextChars: 0, contextLines: 10 }, lowModel: 'claude-sonnet-5-5' }),
  // grapim-lean with every request reviewed twice and the findings merged.
  'grapim-lean-x2': (pr, ctx) => grapimReview(pr, ctx, { provenance: false, limits: { fileContextChars: 0, contextLines: 10 }, passes: 2 }),
  // Tuning variants (dev half): grapim-lean with one thing changed.
  'grapim-lean-high': (pr, ctx) => grapimReview(pr, ctx, { provenance: false, limits: { fileContextChars: 0, contextLines: 10 }, effort: 'high' }),
  'grapim-lean-focus': (pr, ctx) => grapimReview(pr, ctx, { provenance: false, limits: { fileContextChars: 0, contextLines: 10, batchTokens: 12000 } }),
  'pr-agent': prAgent,
  'claude-action': claudeAction,
});
export const DEFAULT_TOOLS = ['grapim', 'pr-agent', 'claude-action'];
export { SYSTEM_PROMPT, requestText, dryReply, parsePrAgentReview, parseClaudeStream, parseClaudeComments };
