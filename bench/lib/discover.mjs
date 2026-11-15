// Candidate discovery: searches GitHub for pull requests opened by AI coding
// agents, keeps the ones from reasonably active repositories, and reads their
// review timeline (inline comments, reviews, commits) so a person can decide
// which ones have a usable ground truth. Read-only, cached (lib/gh.mjs).

import { api, searchIssues } from './gh.mjs';

// One query per agent. Each is a GitHub issue-search query string.
export const AGENT_QUERIES = Object.freeze([
  { agent: 'copilot', q: 'is:pr is:merged author:app/copilot-swe-agent review:changes_requested' },
  { agent: 'copilot', q: 'is:pr is:merged author:app/copilot-swe-agent comments:>4' },
  { agent: 'copilot', q: 'is:pr is:merged author:app/copilot-swe-agent review:approved' },
  { agent: 'devin', q: 'is:pr is:merged author:app/devin-ai-integration review:changes_requested' },
  { agent: 'devin', q: 'is:pr is:merged author:app/devin-ai-integration comments:>3' },
  { agent: 'jules', q: 'is:pr is:merged author:app/google-labs-jules' },
  { agent: 'codex', q: 'is:pr is:merged "chatgpt.com/codex/tasks" in:body review:changes_requested' },
  { agent: 'codex', q: 'is:pr is:merged "chatgpt.com/codex/tasks" in:body comments:>3' },
  { agent: 'claude-code', q: 'is:pr is:merged "Generated with Claude Code" in:body review:changes_requested' },
  { agent: 'claude-code', q: 'is:pr is:merged "Generated with Claude Code" in:body comments:>4' },
  { agent: 'cursor', q: 'is:pr is:merged "cursor.com/agents" in:body' },
  { agent: 'cursor', q: 'is:pr is:merged author:app/cursor' },
  { agent: 'cursor', q: 'is:pr is:merged author:app/cursor review:changes_requested' },
  { agent: 'devin', q: 'is:pr author:app/devin-ai-integration review:changes_requested sort:comments-desc' },
  { agent: 'codex', q: 'is:pr "chatgpt.com/codex" in:body review:changes_requested sort:comments-desc' },
  { agent: 'jules', q: 'is:pr author:app/google-labs-jules review:changes_requested' },
]);

// Owners whose repositories are the agent vendors' own (demo) repos.
export const VENDOR_OWNERS = new Set(['anthropics', 'openai', 'google-labs-code', 'cognition-ai', 'cognitionlabs', 'getcursor', 'cursor', 'github', 'copilot']);
export const MIN_STARS = 300;

export const isBot = (u) => !u || u.type === 'Bot' || /\[bot\]$|^Copilot$|^copilot-swe-agent|^devin-ai|^google-labs-jules|^coderabbit|^gemini-code-assist|^cursor/i.test(u.login ?? '');

const repoOf = (url) => /repos\/([^/]+\/[^/]+)$/.exec(url)?.[1] ?? null;

// Per-repository queries: the same agents, inside one active repository.
export const REPO_QUERIES = Object.freeze([
  { agent: 'copilot', q: 'is:pr is:merged author:app/copilot-swe-agent' },
  { agent: 'devin', q: 'is:pr is:merged author:app/devin-ai-integration' },
  { agent: 'claude-code', q: 'is:pr is:merged "Generated with Claude Code" in:body' },
  { agent: 'cursor', q: 'is:pr is:merged author:app/cursor' },
  { agent: 'codex', q: 'is:pr is:merged "chatgpt.com/codex" in:body' },
  { agent: 'jules', q: 'is:pr is:merged author:app/google-labs-jules' },
]);

export function repoQueries(repos) {
  return repos.flatMap((r) => REPO_QUERIES.map(({ agent, q }) => ({ agent, q: `repo:${r} ${q} sort:comments-desc` })));
}

export async function searchCandidates({ pages = 2, log = () => {}, queries = AGENT_QUERIES, perPage = 100 } = {}) {
  const seen = new Map();
  for (const { agent, q } of queries) {
    for (let page = 1; page <= pages; page++) {
      const r = await searchIssues(q, { page, perPage });
      const items = r?.items ?? [];
      log(`${agent}: "${q}" page ${page}: ${items.length}`);
      for (const it of items) {
        const repo = repoOf(it.repository_url);
        if (!repo || VENDOR_OWNERS.has(repo.split('/')[0].toLowerCase())) continue;
        const key = `${repo}#${it.number}`;
        if (!seen.has(key)) seen.set(key, { repo, number: it.number, agent, url: it.html_url, title: it.title, comments: it.comments ?? 0 });
      }
      if (items.length < perPage) break;
    }
  }
  return [...seen.values()];
}

// The review timeline of one pull request, compact.
export async function timeline(c) {
  const [pr, comments, reviews, commits, issueComments] = await Promise.all([
    api(`repos/${c.repo}/pulls/${c.number}`),
    api(`repos/${c.repo}/pulls/${c.number}/comments?per_page=100`, { paginate: true }),
    api(`repos/${c.repo}/pulls/${c.number}/reviews?per_page=100`, { paginate: true }),
    api(`repos/${c.repo}/pulls/${c.number}/commits?per_page=100`, { paginate: true }),
    api(`repos/${c.repo}/issues/${c.number}/comments?per_page=100`, { paginate: true }),
  ]);
  if (!pr) return null;
  const when = (x) => Date.parse(x);
  const cs = (commits ?? []).map((k) => ({ sha: k.sha, date: k.commit?.committer?.date, msg: k.commit?.message?.split('\n')[0] ?? '', parents: k.parents?.length ?? 1 }));
  const human = (comments ?? []).filter((k) => !isBot(k.user)).map((k) => ({ id: k.id, user: k.user.login, path: k.path, line: k.original_line ?? k.line, startLine: k.original_start_line ?? null, side: k.side, subjectType: k.subject_type, commit: k.original_commit_id, date: k.created_at, body: k.body, url: k.html_url, reply: !!k.in_reply_to_id }));
  const fixedAfter = human.filter((h) => !h.reply && cs.some((k) => when(k.date) > when(h.date)));
  const humanReviews = (reviews ?? []).filter((r) => !isBot(r.user) && r.body).map((r) => ({ user: r.user.login, state: r.state, date: r.submitted_at, body: r.body, commit: r.commit_id, url: r.html_url }));
  const humanIssue = (issueComments ?? []).filter((k) => !isBot(k.user)).map((k) => ({ user: k.user.login, date: k.created_at, body: k.body, url: k.html_url }));
  return {
    ...c,
    state: pr.merged_at ? 'merged' : pr.state,
    base: pr.base?.sha,
    head: pr.head?.sha,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    commits: cs,
    human,
    fixedAfter: fixedAfter.length,
    // Any human feedback (inline, review body or conversation) followed by a commit.
    feedbackThenCommit: [...human.filter((h) => !h.reply), ...humanReviews, ...humanIssue].filter((h) => cs.some((k) => when(k.date) > when(h.date))).length,
    humanReviews,
    humanIssue,
    approved: (reviews ?? []).some((r) => r.state === 'APPROVED' && !isBot(r.user)),
  };
}

export async function repoInfo(repo) {
  const r = await api(`repos/${repo}`);
  return r ? { stars: r.stargazers_count, fork: r.fork, archived: r.archived, pushed: r.pushed_at, language: r.language } : null;
}
