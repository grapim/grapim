// grapim review --ai [<base>..<head>] [--json] [--fail-on blocker|never]
//                    [--provider <name>] [--model <id>] [--request-file <path>]
//
// The Grapim Review engine (src/airev/, docs/design-ai-review.md) on a local
// branch, printed to the terminal. The code goes only to the model endpoint
// the environment's credentials point at, like the GitHub Action.
//
// What was asked for: --request-file (JSON { title, body, issues } or
// Markdown), else the open pull request of this branch through `gh`, if `gh`
// is installed and signed in; without either the review just goes without.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './provenance/pr.js';
import { closingIssues, requestFromFile, REQUEST_LIMITS } from './airev/request.js';

export const USAGE = 'Usage: grapim review --ai [<base>..<head>] [--json] [--fail-on blocker|never] [--provider anthropic|bedrock|vertex|foundry] [--model <id>] [--request-file <path>]';
const SEVERITY = { blocker: 'BLOCKER', warning: 'WARNING', nit: 'NIT' };
const ORDER = { blocker: 0, warning: 1, nit: 2 };
const AGENTS = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini CLI', 'gemini-cli': 'Gemini CLI', mcp: 'MCP agent', http: 'API agent' };
const VALUE_FLAGS = ['--fail-on', '--provider', '--model', '--request-file'];
const KEYS = { '--fail-on': 'failOn', '--provider': 'provider', '--model': 'model', '--request-file': 'requestFile' };

// -> { json, failOn, provider, model, requestFile, base, head } | { error }
export function parseReviewAiArgs(args) {
  const o = { json: false, failOn: null, provider: null, model: null, requestFile: null, base: undefined, head: undefined };
  let range = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--ai') continue;
    if (a === '--json') o.json = true;
    else if (VALUE_FLAGS.includes(a)) {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value.` };
      o[KEYS[a]] = v;
    } else if (a.startsWith('-')) return { error: `grapim review --ai has no option ${a}.` };
    else if (range !== null) return { error: 'Give one range, like origin/main..HEAD.' };
    else range = a;
  }
  if (o.failOn !== null && !['blocker', 'never'].includes(o.failOn)) return { error: '--fail-on must be blocker or never.' };
  if (range !== null) {
    const m = /^(.*?)\.\.\.?(.*)$/.exec(range);
    if (m) {
      if (!m[1]) return { error: 'The range needs a base, like origin/main..HEAD.' };
      o.base = m[1];
      o.head = m[2] || 'HEAD';
    } else {
      o.base = range; // <base>: base..HEAD
      o.head = 'HEAD';
    }
    if (o.base.startsWith('-') || o.head.startsWith('-')) return { error: 'A commit cannot start with "-".' };
  }
  return o;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function countsOf(findings) {
  const n = { blocker: 0, warning: 0, nit: 0 };
  for (const f of findings) if (f.severity in n) n[f.severity]++;
  return n;
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Findings grouped by file, most severe first within a file.
export function findingsText({ findings = [], stats = {}, skipped = [] }) {
  const n = countsOf(findings);
  const total = n.blocker + n.warning + n.nit;
  const what = total ? [n.blocker && plural(n.blocker, 'blocker'), n.warning && plural(n.warning, 'warning'), n.nit && plural(n.nit, 'nit')].filter(Boolean).join(', ') : 'No findings';
  const via = [stats.model, stats.provider && `via ${stats.provider}`].filter(Boolean).join(' ');
  const lines = [`Grapim Review: ${what} in ${plural(stats.reviewedHunks ?? 0, 'reviewed hunk')}${via ? ` (${via})` : ''}.`];
  if (stats.comparedWith?.length) lines.push(`Compared with: ${stats.comparedWith.map(oneLine).join(', ')}.`);
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.path)) byFile.set(f.path, []);
    byFile.get(f.path).push(f);
  }
  for (const [file, list] of byFile) {
    lines.push('', file);
    list.sort((a, b) => (ORDER[a.severity] ?? 3) - (ORDER[b.severity] ?? 3) || a.line - b.line);
    for (const f of list) {
      const at = `${f.path}:${f.endLine > f.line ? `${f.line}-${f.endLine}` : f.line}`;
      lines.push(`  ${(SEVERITY[f.severity] ?? 'NOTE').padEnd(8)} ${oneLine(f.title)}  ${at}`);
      for (const b of String(f.body ?? '').replace(/\r\n?/g, '\n').split('\n')) if (b.trim()) lines.push(`           ${b.trimEnd()}`);
      if (f.run && (f.run.kind || f.run.intent)) {
        const intent = oneLine(f.run.intent);
        lines.push(`           Written by ${AGENTS[f.run.kind] ?? (f.run.kind || 'an agent')} run${intent ? `: "${intent}"` : ''}`);
      }
    }
  }
  if (skipped.length) {
    lines.push('', 'Skipped:');
    for (const s of skipped) lines.push(`  ${s.path}: ${oneLine(s.reason)}`);
  }
  return `${lines.join('\n')}\n`;
}

const isConfigError = (e, engine) => (engine.ConfigError && e instanceof engine.ConfigError) || e?.name === 'ConfigError';

// `gh <args>` in dir: its stdout, or null when gh is missing, signed out, finds
// no pull request, or takes too long. Never prompts.
export function runGh(args, dir) {
  try {
    return execFileSync('gh', args, { cwd: dir, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GH_PROMPT_DISABLED: '1' }, windowsHide: true });
  } catch {
    return null;
  }
}

const parseJson = (s) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

// The open pull request of the current branch, through gh: its title and
// description and the issues it closes (same repository, at most 3). null
// when there is none or gh cannot tell.
export function requestFromGh(dir, gh = runGh) {
  const pr = parseJson(gh(['pr', 'view', '--json', 'title,body,url,state'], dir));
  if (!pr || typeof pr !== 'object' || (pr.state && pr.state !== 'OPEN')) return null;
  const repo = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(String(pr.url ?? ''))?.[1] ?? '';
  const issues = [];
  for (const n of repo ? closingIssues(pr.body, repo, { max: REQUEST_LIMITS.maxIssues }) : []) {
    const i = parseJson(gh(['issue', 'view', String(n), '--json', 'number,title,body'], dir));
    if (i && typeof i === 'object') issues.push({ number: n, title: String(i.title ?? ''), body: String(i.body ?? '') });
  }
  return { title: String(pr.title ?? ''), body: String(pr.body ?? ''), issues };
}

// engine: { reviewChanges, loadConfig, providerFromEnv, ConfigError }, loaded
// from ./airev/index.js unless given (tests). gh: runGh unless given (tests).
export async function reviewAiCommand(args, { cwd = process.cwd(), env = process.env, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), engine, fetchImpl = globalThis.fetch, gh = runGh } = {}) {
  const o = parseReviewAiArgs(args);
  if (o.error) {
    err(`${o.error}\n${USAGE}\n`);
    return 1;
  }
  const root = (git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true }) ?? '').trim();
  if (!root) {
    err('grapim review --ai runs in a git repository.\n');
    return 1;
  }
  let request = null;
  if (o.requestFile) {
    const file = path.resolve(cwd, o.requestFile);
    try {
      request = requestFromFile(fs.readFileSync(file, 'utf8'), file);
    } catch (e) {
      err(`--request-file ${o.requestFile}: ${e.code === 'ENOENT' ? 'no such file' : e.message}\n`);
      return 1;
    }
  }
  engine ??= await import('./airev/index.js');
  let base = o.base;
  let head = o.head;
  if (base !== undefined) {
    // Like a pull request: the changes since the branches split.
    const mb = (git(root, ['merge-base', base, head], { allowFail: true }) ?? '').trim();
    if (!mb) {
      err(`Unknown commit or no common history: ${base}..${head}\n`);
      return 1;
    }
    base = mb;
  }
  let result, config;
  try {
    config = engine.loadConfig(root);
    if (o.model) config = engine.validateConfig ? engine.validateConfig({ ...config, model: o.model }) : { ...config, model: o.model };
    const provider = engine.providerFromEnv(o.provider ? { ...env, GRAPIM_REVIEW_PROVIDER: o.provider } : env, config, { fetchImpl });
    // Without a request file: the branch's open pull request, if gh can say.
    request ??= requestFromGh(root, gh);
    result = await engine.reviewChanges({ cwd: root, base, head, config, provider, ...(request ? { request } : {}), fetchImpl, log: (s) => err(`${s}\n`), now: () => Date.now() });
  } catch (e) {
    if (!isConfigError(e, engine)) throw e;
    err(`${e.message}\n`);
    return 1;
  }
  const findings = result.findings ?? [];
  const n = countsOf(findings);
  if (o.json) out(`${JSON.stringify({ counts: n, findings, summary: result.summary, stats: result.stats, skipped: result.skipped ?? [] }, null, 2)}\n`);
  else out(findingsText(result));
  const failOn = o.failOn ?? (config?.failOn === 'never' ? 'never' : 'blocker');
  return failOn === 'blocker' && n.blocker > 0 ? 1 : 0;
}
