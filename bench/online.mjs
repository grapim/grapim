// Martian's online Code Review Bench, measured here: for merged public pull
// requests a bot reviewed, what share of its suggestions the developer then
// fixed (precision) and what share of the fixes it had flagged (recall).
// The method and the three prompts are Martian's (github.com/withmartian/
// code-review-benchmark, online/, MIT licence): the cut is the commit of the
// bot's first review; suggestions come from all its comments (review bodies,
// inline comments that are not replies, issue comments); fixes come from the
// commits after the cut; a judge matches them. Per pull request precision and
// recall; the board averages them over pull requests that have both. Pull
// requests over 50 commits or 2,000 changed lines are skipped, as theirs are.
//
// Ours differs in: the model (claude-opus-5-5 through the Claude Code CLI,
// cli-provider.mjs, theirs is an OpenAI model) and the sampling. So numbers
// are for comparing bots measured here with each other, not with their board.
//
//   node bench/online.mjs score --bot greptile-apps --since 2026-10-15 --limit 20
//   node bench/online.mjs score --bot grapim --prs grapim/grapim#7,owner/repo#12
//   node bench/online.mjs report [--bot a,b]
//
// --bot is the App's slug (its login is <slug>[bot]). Needs `gh` signed in
// (GitHub API reads only) and a shell where `claude auth status` says loggedIn.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeCliProvider } from './lib/cli-provider.mjs';

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(BENCH_DIR, 'results-online');
const MODEL = process.env.BENCH_ONLINE_MODEL || 'claude-opus-5-5';
const MAX_COMMITS = 50;
const MAX_CHANGED_LINES = 2000;
const MAX_SECTION_CHARS = 120_000;
const PER_REPO = 2;

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const log = (s) => process.stderr.write(`${s}\n`);

// ---- GitHub reads (gh api) ----------------------------------------------------

function gh(url, { accept } = {}) {
  const a = ['api', ...(accept ? ['-H', `Accept: ${accept}`] : []), url];
  return execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
const ghJson = (url) => JSON.parse(gh(url));
function ghPages(url) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const r = ghJson(`${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...r);
    if (r.length < 100) break;
  }
  return out;
}

// Merged pull requests the bot reviewed, at most PER_REPO from one repository.
export function discover(bot, { since, limit }) {
  const q = encodeURIComponent(`is:pr is:merged reviewed-by:app/${bot}${since ? ` merged:>=${since}` : ''}`);
  const seen = new Map();
  const out = [];
  for (let page = 1; page <= 10 && out.length < limit; page++) {
    const r = ghJson(`search/issues?q=${q}&sort=updated&order=desc&per_page=100&page=${page}`);
    for (const it of r.items ?? []) {
      const repo = it.repository_url.split('/repos/')[1];
      const n = seen.get(repo) ?? 0;
      if (n >= PER_REPO) continue;
      seen.set(repo, n + 1);
      out.push(`${repo}#${it.number}`);
      if (out.length >= limit) break;
    }
    if ((r.items ?? []).length < 100) break;
  }
  return out;
}

const sameActor = (login, bot) => {
  const a = String(login ?? '').toLowerCase().replace(/\[bot\]$/, '');
  return a === bot.toLowerCase();
};
const clean = (body) => String(body ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
const clip = (s, n = MAX_SECTION_CHARS) => (s.length > n ? `${s.slice(0, n)}\n[... cut at ${n} characters]` : s);

// One pull request -> what the three prompts need, or { skip }.
export function collect(ref, bot) {
  const m = /^([^/]+\/[^#]+)#(\d+)$/.exec(ref);
  if (!m) throw new Error(`not owner/repo#number: ${ref}`);
  const [, repo, number] = m;
  const pr = ghJson(`repos/${repo}/pulls/${number}`);
  if (!pr.merged_at) return { skip: 'not merged' };
  if (pr.commits > MAX_COMMITS) return { skip: `${pr.commits} commits` };
  if (pr.additions + pr.deletions > MAX_CHANGED_LINES) return { skip: `${pr.additions + pr.deletions} changed lines` };
  const commits = ghPages(`repos/${repo}/pulls/${number}/commits`);
  const reviews = ghPages(`repos/${repo}/pulls/${number}/reviews`);
  const inline = ghPages(`repos/${repo}/pulls/${number}/comments`);
  const issue = ghPages(`repos/${repo}/issues/${number}/comments`);

  // The commit the bot first reviewed (hash X).
  const ts = (x) => Date.parse(x ?? '') || 0;
  const botEvents = [
    ...reviews.filter((r) => sameActor(r.user?.login, bot)).map((r) => ({ kind: 'REVIEW_BODY', t: ts(r.submitted_at), r })),
    ...inline.filter((c) => sameActor(c.user?.login, bot) && !c.in_reply_to_id).map((c) => ({ kind: 'INLINE_REVIEW_COMMENT', t: ts(c.created_at), c })),
    ...issue.filter((c) => sameActor(c.user?.login, bot)).map((c) => ({ kind: 'ISSUE_COMMENT', t: ts(c.created_at), c })),
  ].sort((a, b) => a.t - b.t);
  if (!botEvents.length) return { skip: 'no comments by the bot' };
  const firstReview = reviews.filter((r) => sameActor(r.user?.login, bot) && r.commit_id).sort((a, b) => ts(a.submitted_at) - ts(b.submitted_at))[0];
  const firstInline = inline.filter((c) => sameActor(c.user?.login, bot)).sort((a, b) => ts(a.created_at) - ts(b.created_at))[0];
  let x = firstReview?.commit_id ?? firstInline?.original_commit_id ?? firstInline?.commit_id ?? null;
  if (!x) x = commits.filter((c) => ts(c.commit?.committer?.date) <= botEvents[0].t).at(-1)?.sha ?? null;
  const i = commits.findIndex((c) => c.sha === x);
  const pre = i >= 0 ? commits.slice(0, i + 1) : commits;
  const post = i >= 0 ? commits.slice(i + 1) : [];

  const diffOf = (sha) => gh(`repos/${repo}/commits/${sha}`, { accept: 'application/vnd.github.diff' });
  const fmtCommits = (list) => list.map((c) => `--- Commit ${c.sha.slice(0, 12)} (${c.commit?.author?.date ?? ''}): ${String(c.commit?.message ?? '').split('\n')[0]}\n\`\`\`diff\n${diffOf(c.sha)}\n\`\`\``).join('\n\n');

  let n = 0;
  const botComments = botEvents
    .map((e) => {
      n++;
      if (e.kind === 'REVIEW_BODY') return `COMMENT C${n} [REVIEW_BODY state=${e.r.state} timestamp=${e.r.submitted_at}]\n${clean(e.r.body)}`;
      const c = e.c;
      const where = e.kind === 'INLINE_REVIEW_COMMENT' && c.path ? ` path=${c.path}:${c.line ?? c.original_line ?? ''}` : '';
      return `COMMENT C${n} [${e.kind}${where} timestamp=${c.created_at}]\n${e.kind === 'INLINE_REVIEW_COMMENT' && c.diff_hunk ? `Code context:\n\`\`\`diff\n${c.diff_hunk}\n\`\`\`\n` : ''}${clean(c.body)}`;
    })
    .join('\n\n');

  // Human activity after the bot's first comment: their comments and replies.
  const firstT = botEvents[0].t;
  const human = [
    ...inline.filter((c) => !sameActor(c.user?.login, bot) && ts(c.created_at) > firstT).map((c) => `[review comment by ${c.user?.login} on ${c.path}] ${clean(c.body)}`),
    ...issue.filter((c) => !sameActor(c.user?.login, bot) && ts(c.created_at) > firstT).map((c) => `[comment by ${c.user?.login}] ${clean(c.body)}`),
    ...reviews.filter((r) => !sameActor(r.user?.login, bot) && ts(r.submitted_at) > firstT && clean(r.body)).map((r) => `[review by ${r.user?.login}, ${r.state}] ${clean(r.body)}`),
  ].join('\n\n');

  return {
    ref,
    repo,
    number: Number(number),
    title: pr.title,
    author: pr.user?.login ?? '',
    cut: x,
    preCommits: pre.length,
    postCommits: post.length,
    botComments,
    commitsUnderReview: clip(fmtCommits(pre)),
    postReviewCommits: post.length ? clip(fmtCommits(post)) : '',
    postReviewActivity: clip(human || '(no post-review activity)', 30_000),
  };
}

// ---- The three prompts (Martian online/etl/llm/prompts.py, verbatim) ---------

const EXTRACT_BOT_SUGGESTIONS = `You are analyzing a pull request to extract concrete code-review findings flagged by a code review bot.

The bot's username is: {bot_username}

Below you will see:
1. The bot's review comments on the commits
2. The commits that were under review (the code state the bot saw), including full diffs

The Bot Review Comments section is a numbered list. Each entry is labeled as REVIEW_BODY,
INLINE_REVIEW_COMMENT, or ISSUE_COMMENT. Process all numbered comments. Top-level inline
review comments generally contain substantive findings; review bodies and issue comments may
contain findings or summaries.

Your job is to identify every distinct substantive finding the bot flagged. A finding can be a
bug, defect, risk, incorrect behavior, missing validation, security concern, performance concern,
maintainability issue, documentation problem, test gap, or other concrete code-review concern.

Only extract findings grounded in the bot's comments. Do not invent findings solely from the
commit diff. Use the commit diff only to understand code context for a comment.

For each finding, extract:
- A unique ID (S1, S2, ...)
- A concise description of the issue or concern the bot flagged
- The category (bug, style, performance, security, refactor, documentation, other)
- The file path and line number if available
- Severity (low, medium, high, critical)

Skip generic praise, status/progress messages, quota/limit messages, pure summaries without a
concrete finding, and "looks good" / "no issues found" comments. Also skip follow-up comments
that merely confirm a fix, acknowledge a clarification, say a parent comment was wrong, too
broad, pre-existing, already addressed, or out of scope, unless that same comment introduces a
new distinct code issue.

PR Title: {pr_title}
PR Author: {pr_author}
Repository: {repo_name}

=== Bot Review Comments ===
{bot_comments}

=== Commits Under Review (code the bot reviewed) ===
{commits_under_review}
`;

const EXTRACT_HUMAN_ACTIONS = `You are analyzing post-review commit diffs to extract every concrete code issue that was fixed or improved AFTER the bot reviewed the PR.

These extracted issues are ground-truth labels — the actual problems that existed in the code the bot reviewed. Your job is to read the diffs and identify each distinct issue that was addressed.

The bot's username is: {bot_username}

Below you will see:
1. Commits made AFTER the bot's review, including full diffs
2. Post-review comments that may provide context about why changes were made

For each distinct code issue fixed in the post-review commits, extract:
- A unique ID (A1, A2, ...)
- A description of the specific issue that was fixed (what was wrong, not what was done)
- The category of the issue (bug, style, performance, security, refactor, documentation, other)
- The file path where the fix was applied
- The commit SHA that fixed it
- Action type: why was this changed? (fix, improvement, cleanup, new_feature, other)

Guidelines:
- Focus on the DIFFS — each action should correspond to a real code change you can see
- Describe the ISSUE that existed, not the PR activity (not "replied to comment" or "resolved thread")
- One action per distinct issue — if a commit fixes 3 separate things in 3 files, that's 3 actions
- If a comment explains why a change was made, incorporate that context into the description
- Skip trivial formatting-only changes (whitespace, import ordering) unless they fix a real problem
- Skip merge commits or changes that don't address a code issue

PR Title: {pr_title}
PR Author: {pr_author}
Repository: {repo_name}

=== Post-Review Commits (changes after bot review) ===
{post_review_commits}

=== Post-Review Comments (context for why changes were made) ===
{post_review_activity}
`;

const JUDGE_MATCHING = `You are judging whether a bot's code review suggestions correspond to actual code issues that were later fixed.

The bot's username is: {bot_username}

You have two lists:
- Bot Suggestions: issues the bot flagged during review
- Code Fixes: actual issues that were fixed in post-review commits (ground truth)

For EACH bot suggestion, determine:
1. Does it match any code fix? (matched: true/false)
2. Which code fix? (human_action_id)
3. How confident are you? (0.0-1.0)
4. Brief reasoning

A suggestion is "matched" if:
- It identified the same issue (or substantially the same concern) that was later fixed
- The fix is in the same file/area the suggestion pointed to
- Even a partial overlap counts if the bot caught part of the real problem

A suggestion is NOT matched if:
- No corresponding fix exists — the bot flagged something that wasn't actually fixed
- The fix addresses a different concern than what the bot suggested
- The bot's suggestion was about something that wasn't a real problem

=== Bot Suggestions ===
{bot_suggestions}

=== Code Fixes (ground truth) ===
{human_actions}
`;

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all));
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const str = { type: 'string' };
const SUGGESTIONS = obj({ suggestions: { type: 'array', items: obj({ issue_id: str, description: str, category: str, file_path: { type: ['string', 'null'] }, line_number: { type: ['integer', 'null'] }, severity: str }) } });
const ACTIONS = obj({ actions: { type: 'array', items: obj({ action_id: str, description: str, category: str, file_path: { type: ['string', 'null'] }, commit_sha: { type: ['string', 'null'] }, action_type: str }) } });
const MATCHES = obj({ matches: { type: 'array', items: obj({ bot_issue_id: str, human_action_id: { type: ['string', 'null'] }, matched: { type: 'boolean' }, confidence: { type: 'number' }, reasoning: str }) } });

async function ask(provider, prompt, schema) {
  const msg = await provider.send({ model: MODEL, system: [{ text: 'You are a careful analyst of code review activity. Answer with the JSON the schema asks for.' }], messages: [{ content: [{ text: prompt }] }], output_config: { effort: 'medium', format: { schema } } });
  return JSON.parse(msg.content[0].text);
}

// One pull request through the three steps -> { precision, recall, ... }.
export async function analyze(provider, d, bot) {
  const base = { bot_username: `${bot}[bot]`, pr_title: d.title, pr_author: d.author, repo_name: d.repo };
  const { suggestions } = await ask(provider, fill(EXTRACT_BOT_SUGGESTIONS, { ...base, bot_comments: d.botComments, commits_under_review: d.commitsUnderReview }), SUGGESTIONS);
  const actions = d.postReviewCommits ? (await ask(provider, fill(EXTRACT_HUMAN_ACTIONS, { ...base, post_review_commits: d.postReviewCommits, post_review_activity: d.postReviewActivity }), ACTIONS)).actions : [];
  let matches = [];
  if (suggestions.length && actions.length) {
    const fmtS = suggestions.map((s) => `${s.issue_id} [${s.category}/${s.severity}] ${s.file_path ?? ''}${s.line_number ? `:${s.line_number}` : ''} - ${s.description}`).join('\n');
    const fmtA = actions.map((a) => `${a.action_id} [${a.category}/${a.action_type}] ${a.file_path ?? ''} (${a.commit_sha ?? ''}) - ${a.description}`).join('\n');
    ({ matches } = await ask(provider, fill(JUDGE_MATCHING, { bot_username: base.bot_username, bot_suggestions: fmtS, human_actions: fmtA }), MATCHES));
  }
  const sIds = new Set(suggestions.map((s) => s.issue_id));
  const aIds = new Set(actions.map((a) => a.action_id));
  const ms = new Set(matches.filter((m) => m.matched && sIds.has(m.bot_issue_id)).map((m) => m.bot_issue_id));
  const ma = new Set(matches.filter((m) => m.matched && aIds.has(m.human_action_id)).map((m) => m.human_action_id));
  return {
    suggestions,
    actions,
    matches,
    precision: suggestions.length ? ms.size / suggestions.length : null,
    recall: actions.length ? ma.size / actions.length : null,
  };
}

// The board's numbers: mean precision and mean recall over pull requests that have both.
export function board(rows) {
  const scored = rows.filter((r) => r.precision !== null && r.recall !== null);
  if (!scored.length) return { scored: 0, sampled: rows.length };
  const P = scored.reduce((s, r) => s + r.precision, 0) / scored.length;
  const R = scored.reduce((s, r) => s + r.recall, 0) / scored.length;
  return { scored: scored.length, sampled: rows.length, precision: P, recall: R, f1: P + R ? (2 * P * R) / (P + R) : 0, suggestionsPerPr: scored.reduce((s, r) => s + r.suggestions, 0) / scored.length };
}

const fileFor = (bot, ref) => path.join(OUT_DIR, bot, `${ref.replace(/[/#]/g, '__')}.json`);
const pc = (x) => `${(100 * x).toFixed(1)}%`;

function report(bots) {
  const lines = ['| Bot | Scored PRs | Precision | Recall | F1 | Suggestions per PR |', '|---|---|---|---|---|---|'];
  for (const bot of bots) {
    const dir = path.join(OUT_DIR, bot);
    if (!fs.existsSync(dir)) continue;
    const rows = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter((r) => !r.skip);
    const b = board(rows.map((r) => ({ precision: r.precision, recall: r.recall, suggestions: r.suggestions.length })));
    lines.push(b.scored ? `| ${bot} | ${b.scored} of ${b.sampled} | ${pc(b.precision)} | ${pc(b.recall)} | ${pc(b.f1)} | ${b.suggestionsPerPr.toFixed(1)} |` : `| ${bot} | 0 of ${b.sampled} | | | | |`);
  }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (cmd === 'score') {
    const bot = opt('bot');
    if (!bot) throw new Error('--bot <app slug> is needed');
    const refs = opt('prs') ? opt('prs').split(',') : discover(bot, { since: opt('since'), limit: Number(opt('limit', 20)) });
    log(`${bot}: ${refs.length} pull requests`);
    const provider = claudeCliProvider({ model: MODEL });
    try {
      for (const ref of refs) {
        const file = fileFor(bot, ref);
        if (fs.existsSync(file)) continue;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try {
          const d = collect(ref, bot);
          if (d.skip) {
            fs.writeFileSync(file, JSON.stringify({ ref, skip: d.skip }));
            log(`${ref}: skipped (${d.skip})`);
            continue;
          }
          const a = await analyze(provider, d, bot);
          fs.writeFileSync(file, JSON.stringify({ ref, bot, judge: MODEL, cut: d.cut, preCommits: d.preCommits, postCommits: d.postCommits, ...a }, null, 1));
          log(`${ref}: ${a.suggestions.length} suggestions, ${a.actions.length} fixes after review, P=${a.precision === null ? '-' : pc(a.precision)} R=${a.recall === null ? '-' : pc(a.recall)}`);
        } catch (err) {
          log(`${ref}: failed: ${String(err.message).slice(0, 300)}`);
        }
      }
    } finally {
      provider.close();
    }
    console.log(report([bot]));
  } else if (cmd === 'report') {
    const bots = opt('bot') ? opt('bot').split(',') : fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR) : [];
    console.log(report(bots));
  } else {
    log('usage: node bench/online.mjs score --bot <slug> [--prs owner/repo#n,...] [--since YYYY-MM-DD] [--limit N] | report [--bot a,b]');
    process.exitCode = 2;
  }
}
