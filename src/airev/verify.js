// A second look before posting: every finding of a review goes back to the
// model with the code around it, where the names it mentions are used in the
// repository, the pull request's commit messages and its discussion. The model
// keeps a finding the code supports and drops one the code or the discussion
// contradicts (the author already explained it, the condition it needs cannot
// happen here, the number it calls wrong is right).
//
// Measured on 27 findings from 17 public pull requests that people checked
// by hand (17 real, 9 false, 1 unsure): see bench/verify-eval.mjs.
//
// One request per review, for all its findings together. The context is
// gathered here with read-only git commands. With `tools: true` the model can
// also search and read the whole repository at the head (repo-tools.js) for up
// to MAX_TOOL_TURNS rounds: on 16 pull requests from repos it had never seen,
// every false finding the fixed context let through needed code outside the
// diff to rule out. A failed request keeps every finding (the check only ever
// removes).

import { parseFindingsText } from './findings.js';
import { REPO_TOOLS, runRepoTool } from './repo-tools.js';

const MAX_FINDINGS = 15;
const FILE_LINES = 70; // lines of the file on each side of the finding
const GREP_HITS = 12; // per name the finding mentions
const GREP_NAMES = 4;
const MAX_CONTEXT_CHARS = 120_000;
const MAX_DISCUSSION_CHARS = 12_000;
const MAX_TOOL_TURNS = 24;

export const VERIFY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'verdict', 'reason'],
        properties: {
          id: { type: 'integer' },
          verdict: { type: 'string', enum: ['keep', 'drop'] },
          reason: { type: 'string' },
        },
      },
    },
  },
});

export const VERIFY_PROMPT = `You check another reviewer's findings on a pull request before they are posted. A wrong comment costs the author's time and trust, so you are skeptical; a missed real bug costs more, so you do not drop a finding on a hunch.

For each finding, read the code and context given and decide:
- keep: the code shown supports the claim, or nothing shown contradicts it and the failure it describes can happen.
- drop: something shown contradicts it. For example the author already explained or justified this exact point in the commit messages or the discussion; the condition it needs cannot happen in this code (the API it relies on is not exposed, every caller already sets the value, the input is validated earlier); the value or count it calls wrong is right; it describes code the pull request did not change and the change does not make worse; or it restates a style preference as a bug.

Rules: judge only from what is shown. Do not drop a blocker unless the context clearly shows it is wrong. A "this change is outside the task" finding is a drop when the commit messages or discussion explain why the change is there. Give a one-sentence reason naming the line or text that decided it. Answer in JSON with one verdict per finding id.`;

export const VERIFY_TOOLS_PROMPT = `You can search and read the whole repository at the pull request head with the tools (search, read_file, list_files, history). Most wrong findings are wrong because of code outside the diff, so before you keep a finding, look for what would make it wrong:
- the callers, and every other place that sets, checks or handles the same value, state or case (a guard, a conversion, a retry, a second code path that adds the missing item back);
- the definition of each function, type or hook it relies on (does it really compare by identity, really throw, really return null);
- the project's convention: docs, comments and other modules doing the same thing on purpose;
- whether the thing it calls unrequested or wrong also changed elsewhere (history).
Judge from what is shown and what you find with the tools. Drop a finding when the repository shows the failure cannot happen or the behaviour is intended. Keep it when you looked and found nothing that contradicts it. Search in a few targeted steps per finding and stop as soon as you can decide; you have a limited number of tool rounds.`;

const NAME_IN_TICKS = /`([A-Za-z_$][\w$.:]{2,60})`/g;
const IDENT = /^[A-Za-z_$][\w$]*$/;

// Names worth looking up: identifiers in backticks in the title and body,
// last segment of dotted names, not too common.
export function namesIn(f) {
  const out = [];
  const text = `${f.title ?? ''} ${f.body ?? ''}`;
  for (const m of text.matchAll(NAME_IN_TICKS)) {
    const name = m[1].split(/[.:]+/).filter(Boolean).pop();
    if (name && IDENT.test(name) && name.length >= 4 && !out.includes(name)) out.push(name);
    if (out.length >= GREP_NAMES) break;
  }
  return out;
}

function around(text, line, span) {
  const lines = String(text).split('\n');
  const from = Math.max(1, line - span);
  const to = Math.min(lines.length, line + span);
  const out = [];
  for (let i = from; i <= to; i++) out.push(`${String(i).padStart(5)}  ${lines[i - 1]}`);
  return out.join('\n');
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…` : s);

// git(args) -> stdout string, or null when the command fails.
export function gatherContext({ findings, git, base, head, discussion = '' }) {
  const files = new Map();
  const fileAt = (p) => {
    if (!files.has(p)) files.set(p, git(['show', `${head}:${p}`]));
    return files.get(p);
  };
  const parts = [];
  const log = git(['log', '--format=--- %h %s%n%b', `${base}..${head}`]);
  if (log) parts.push(`<commits>\n${clip(log.trim(), 6000)}\n</commits>`);
  if (discussion.trim()) parts.push(`<discussion>\n${clip(discussion.trim(), MAX_DISCUSSION_CHARS)}\n</discussion>`);
  findings.forEach((f, id) => {
    const block = [`<finding id="${id}">`, `${f.severity} (${f.confidence ?? 'high'}) ${f.path}:${f.line}${(f.endLine ?? f.end_line) && (f.endLine ?? f.end_line) !== f.line ? `-${f.endLine ?? f.end_line}` : ''}`, `Title: ${f.title}`, `Body: ${f.body}`];
    const diff = git(['diff', '--unified=3', base, head, '--', f.path]);
    if (diff) block.push(`<diff file="${f.path}">\n${clip(diff, 8000)}\n</diff>`);
    const text = fileAt(f.path);
    if (text != null) block.push(`<file path="${f.path}" at="head">\n${around(text, f.line, FILE_LINES)}\n</file>`);
    for (const name of namesIn(f)) {
      const hits = git(['grep', '-n', '-w', '-I', '--max-count=3', name, head]);
      if (!hits) continue;
      const lines = hits.split('\n').filter(Boolean).slice(0, GREP_HITS).map((l) => l.replace(`${head}:`, ''));
      block.push(`<uses name="${name}">\n${lines.join('\n')}\n</uses>`);
    }
    block.push('</finding>');
    parts.push(block.join('\n'));
  });
  return clip(parts.join('\n\n'), MAX_CONTEXT_CHARS);
}

export function buildVerifyRequest({ findings, context, model, request, tools = false }) {
  // The engine's request ({ title, body, issues }) or plain { text }.
  const said = request?.text ?? [request?.title, request?.body, ...(request?.issues ?? []).map((i) => `${i.number ? `#${i.number} ` : ''}${i.title ?? ''}\n${i.body ?? ''}`)].filter(Boolean).join('\n\n');
  const ask = said ? `The pull request says it does this:\n${clip(String(said), 4000)}\n\n` : '';
  return {
    model,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: tools ? `${VERIFY_PROMPT}\n\n${VERIFY_TOOLS_PROMPT}` : VERIFY_PROMPT }],
    messages: [{ role: 'user', content: [{ type: 'text', text: `${ask}${context}\n\nReturn a verdict for each of the ${findings.length} findings (ids 0 to ${findings.length - 1}).` }] }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: VERIFY_SCHEMA } },
    ...(tools ? { tools: REPO_TOOLS } : {}),
  };
}

// Each tool round resends everything before it. Cache breakpoints on the
// system prompt, the gathered context and the newest tool results (three of
// the four allowed) let every round read the earlier ones from the cache.
const EPHEMERAL = Object.freeze({ type: 'ephemeral' });
function cached(body, messages) {
  const mark = (blocks) => blocks.map((b, i) => (i === blocks.length - 1 ? { ...b, cache_control: EPHEMERAL } : b));
  const last = messages.length - 1;
  return {
    ...body,
    system: mark(body.system),
    messages: messages.map((m, i) => (i === 0 || (i === last && i > 0) ? { ...m, content: mark(m.content) } : m)),
  };
}

// -> { kept, dropped: [{ finding, reason }], usage: { input, output }, checked }
// tools: let the model search the repository (see VERIFY_TOOLS_PROMPT). A
// provider that runs the tool loop itself (the bench's CLI stand-in) gets
// { repo: { base, head, dir } } as the second argument of send().
export async function verifyFindings({ findings, git, base, head, provider, model, request = null, discussion = '', tools = false, repoDir = null, log = () => {} }) {
  const usage = { input: 0, output: 0 };
  if (!findings?.length || !provider) return { kept: findings ?? [], dropped: [], usage, checked: 0 };
  const checkNow = findings.slice(0, MAX_FINDINGS);
  const rest = findings.slice(MAX_FINDINGS);
  const context = gatherContext({ findings: checkNow, git, base, head, discussion });
  const body = buildVerifyRequest({ findings: checkNow, context, model, request, tools });
  const count = (m) => {
    const u = m?.usage ?? {};
    usage.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    usage.output += u.output_tokens ?? 0;
  };
  let msg;
  let searches = 0;
  try {
    const messages = [...body.messages];
    for (let turn = 0; ; turn++) {
      // The last round may not call a tool, so it has to give its verdicts.
      const final = tools && turn >= MAX_TOOL_TURNS;
      msg = await provider.send({ ...(tools ? cached(body, messages) : { ...body, messages }), ...(final ? { tool_choice: { type: 'none' } } : {}) }, { repo: { base, head, dir: repoDir } });
      count(msg);
      searches += Number(msg?.tool_rounds) || 0; // a provider that ran the tools itself
      const uses = (msg?.content ?? []).filter((b) => b?.type === 'tool_use');
      if (!tools || !uses.length || msg.stop_reason !== 'tool_use' || final) break;
      searches += uses.length;
      messages.push({ role: 'assistant', content: msg.content });
      messages.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: runRepoTool(git, head, u.name, u.input) })) });
    }
  } catch (err) {
    log(`Second look failed (${err?.message ?? err}); posting every finding.`);
    return { kept: findings, dropped: [], usage, checked: 0 };
  }
  const parsed = parseFindingsText(msg);
  const verdicts = new Map();
  for (const v of parsed?.verdicts ?? []) if (Number.isInteger(v?.id) && (v.verdict === 'keep' || v.verdict === 'drop')) verdicts.set(v.id, v);
  const kept = [];
  const dropped = [];
  checkNow.forEach((f, id) => {
    const v = verdicts.get(id);
    // A blocker is dropped only with a stated reason; no verdict keeps it.
    if (v?.verdict === 'drop' && String(v.reason ?? '').trim()) dropped.push({ finding: f, reason: String(v.reason).trim().slice(0, 400) });
    else kept.push(f);
  });
  log(`Second look: ${checkNow.length} checked, ${dropped.length} dropped${tools ? `, ${searches} tool calls` : ''}.`);
  return { kept: [...kept, ...rest], dropped, usage, checked: checkNow.length, searches };
}
