// Which AI coding agents a merged pull request's commits name, from the
// signals the agents themselves leave in git and on GitHub (research/core-features-2026-11.md,
// "Agent signatures"). Only conventions we could verify in vendor docs or
// public commits are listed; everything else is "no signal", never "human".
//
// Every signal is a claim the agent (or a person) wrote: trailers are opt-in
// and can be turned off or typed by hand. The scan therefore reports "at
// least" N pull requests, never an exact count.
//
// Strong: the commit's author, or the pull request's author, is the agent's
// own GitHub App bot account (a `[bot]` login tied to an app id). Trailer: a
// `Co-authored-by:` line in a commit message with the agent's address.

// key -> display name
export const AGENTS = Object.freeze({
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  devin: 'Devin',
  aider: 'Aider',
  jules: 'Jules',
  openhands: 'OpenHands',
  'amazon-q': 'Amazon Q Developer',
  amp: 'Amp',
  factory: 'Factory',
});

// Bot logins (lowercase), as GitHub shows them on commits and pull requests.
const BOTS = new Map([
  ['claude[bot]', 'claude-code'],
  ['chatgpt-codex-connector[bot]', 'codex'],
  ['cursor[bot]', 'cursor'],
  ['copilot', 'copilot'], // the PR author login of the Copilot coding agent (a Bot)
  ['copilot-swe-agent[bot]', 'copilot'],
  ['devin-ai-integration[bot]', 'devin'],
  ['google-labs-jules[bot]', 'jules'],
  ['amazon-q-developer[bot]', 'amazon-q'],
  ['factory-droid[bot]', 'factory'],
  ['openhands-agent', 'openhands'],
]);

// Addresses in Co-authored-by trailers or on commit authors (lowercase).
const EMAILS = new Map([
  ['noreply@anthropic.com', 'claude-code'],
  ['noreply@openai.com', 'codex'],
  ['cursoragent@cursor.com', 'cursor'],
  ['noreply@aider.chat', 'aider'],
  ['openhands@all-hands.dev', 'openhands'],
  ['amp@ampcode.com', 'amp'],
]);

// GitHub's noreply address of an account: "<id>+<login>@users.noreply.github.com".
const NOREPLY = /^(?:\d+\+)?([^@\s]+)@users\.noreply\.github\.com$/i;

const lower = (s) => String(s ?? '').trim().toLowerCase();

// The agent an e-mail address belongs to, or null.
export function agentOfEmail(email) {
  const e = lower(email);
  if (!e) return null;
  if (EMAILS.has(e)) return EMAILS.get(e);
  const m = NOREPLY.exec(e);
  return m ? (BOTS.get(m[1]) ?? null) : null;
}

export const agentOfLogin = (login) => BOTS.get(lower(login)) ?? null;

// Co-authored-by trailers of a commit message: [{ name, email }]. Only lines
// in the form git writes (case-insensitive key, "Name <address>").
export function coAuthors(message) {
  const out = [];
  for (const line of String(message ?? '').split(/\r?\n/).slice(-200)) {
    const m = /^\s*co-authored-by:\s*(.{0,200}?)\s*<([^<>\s]{1,200})>\s*$/i.exec(line);
    if (m) out.push({ name: m[1], email: m[2] });
  }
  return out;
}

// pr: { author: { login, __typename }, commits: [{ message, author: { name, email, user: { login } } }],
//       mergeCommit?: { message } }
// -> Map agent key -> Set of evidence strings ('bot author', 'trailer', 'author name').
export function detectAgents(pr) {
  const found = new Map();
  const add = (agent, how) => {
    if (!agent) return;
    if (!found.has(agent)) found.set(agent, new Set());
    found.get(agent).add(how);
  };
  if (pr?.author?.__typename === 'Bot' || /\[bot\]$/i.test(String(pr?.author?.login ?? '')) || agentOfLogin(pr?.author?.login)) {
    add(agentOfLogin(pr?.author?.login), 'opened the pull request');
  }
  const messages = [];
  for (const c of Array.isArray(pr?.commits) ? pr.commits : []) {
    const a = c?.author ?? {};
    add(agentOfLogin(a.user?.login) ?? agentOfEmail(a.email), 'commit author');
    // Aider marks the author and committer name "Name (aider)" by default.
    if (/\(aider\)\s*$/i.test(String(a.name ?? ''))) add('aider', 'commit author');
    messages.push(c?.message);
  }
  // A squash merge collects the trailers of the commits it squashed.
  if (pr?.mergeCommit?.message) messages.push(pr.mergeCommit.message);
  for (const m of messages) for (const t of coAuthors(m)) add(agentOfEmail(t.email), 'Co-authored-by trailer');
  return found;
}

// Whether someone other than the author approved: an APPROVED review by a
// user (not a bot, not a deleted account) whose login differs from the
// pull request author's. reviews: [{ author: { login, __typename } }].
export function approvedByOther(pr) {
  const author = lower(pr?.author?.login);
  const who = new Set();
  for (const r of Array.isArray(pr?.reviews) ? pr.reviews : []) {
    const login = lower(r?.author?.login);
    if (!login || login === 'ghost' || r?.author?.__typename === 'Bot' || login.endsWith('[bot]') || BOTS.has(login)) continue;
    if (login === author) continue;
    who.add(r.author.login);
  }
  return [...who];
}
