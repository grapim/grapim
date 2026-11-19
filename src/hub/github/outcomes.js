// What happened to each inline comment cloud review posted: the comment
// outcome log. One row per inline finding Grapim posts (cloud-review.js
// calls record() right after the review is on GitHub), and the signals that
// arrive later, so acceptance can be measured per repository, severity and
// category, and later learned from.
//
// Signals and when each one is read:
//   - reactions (👍 / 👎 / others): GitHub sends no webhook for reactions, so
//     they are read from the pull request's review comments whenever the pull
//     request is touched (a push, a reply, a thread resolved) and when it closes;
//   - replies under the comment: the same listing; count, the raw text
//     (truncated) and a verdict from simple keyword rules ("not an issue" vs
//     "thanks, fixed"), the verdict only from people with write access or the
//     pull request's author;
//   - thread resolved: the pull_request_review_thread webhook, and GraphQL's
//     reviewThreads on each read (in case the App is not subscribed);
//   - fixed: on a push (pull_request synchronize), the commented lines with two
//     lines of context around them, at the reviewed commit, are looked for in
//     the file at the new head. Gone: a later commit changed them. Only the
//     two versions of that file are read, in memory, and nothing of them is kept;
//   - suggestion applied: the committable suggestion's lines appear in the new
//     file and did not in the reviewed one. Only a hash of the suggestion is kept;
//   - merged or closed, and whether the finding was still unaddressed at merge.
//
// One outcome per finding, derived again after every signal (deriveOutcome):
// accepted, rejected, ignored (merged without any signal), closed (the pull
// request closed unmerged without any signal; left out of the rates) or pending.
//
// What is stored: the finding's place (path and lines), severity, confidence,
// category, title, the agent kind that wrote the lines (never its prompt), the
// model, and the signals above. No code. Reply text at most REPLY_CHARS a
// reply, at most MAX_REPLIES replies. Rows go after RETAIN_DAYS.

import crypto from 'node:crypto';
import { GitHubClient } from './client.js';
import { JobQueue } from './queue.js';
import { decode, parseComment } from './review-memory.js';

export const OUTCOMES_SCHEMA = `
-- One row per inline comment cloud review posted, with what happened to it
-- (outcomes.js). team_id is NULL for a public repository of an installation
-- no team linked. comment_id is GitHub's review comment id (NULL until known).
CREATE TABLE IF NOT EXISTS review_findings (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id            TEXT,
  installation_id    INTEGER NOT NULL,
  repo_gh_id         INTEGER NOT NULL,
  owner              TEXT NOT NULL,
  name               TEXT NOT NULL,
  number             INTEGER NOT NULL,
  head_sha           TEXT NOT NULL,            -- the commit the comment was posted on
  review_row         INTEGER,                  -- cloud_reviews.id
  gh_review_id       INTEGER,                  -- the GitHub review holding the comment
  comment_id         INTEGER,
  path               TEXT NOT NULL,
  line               INTEGER NOT NULL,
  end_line           INTEGER,
  severity           TEXT,                     -- blocker | warning | nit
  confidence         TEXT,                     -- high | medium | low
  category           TEXT,
  title              TEXT,
  agent_kind         TEXT,                     -- the agent whose run wrote the lines, if known
  model              TEXT,
  oss                INTEGER NOT NULL DEFAULT 0,
  suggestion_hash    TEXT,                     -- sha256 of the suggestion's lines, trimmed; never the text
  suggestion_lines   INTEGER,
  created_at         INTEGER NOT NULL,
  up                 INTEGER NOT NULL DEFAULT 0,
  down               INTEGER NOT NULL DEFAULT 0,
  other_reactions    INTEGER NOT NULL DEFAULT 0,
  replies            INTEGER NOT NULL DEFAULT 0,
  reply_verdict      TEXT,                     -- disagree | agree | NULL
  reply_text         TEXT,                     -- JSON [{ who, text }], truncated
  resolved           INTEGER NOT NULL DEFAULT 0,
  resolved_at        INTEGER,
  fixed_sha          TEXT,                     -- the head where the commented lines had changed
  fixed_at           INTEGER,
  suggestion_applied INTEGER NOT NULL DEFAULT 0,
  checked_sha        TEXT,                     -- the newest head compared for "fixed"
  pr_state           TEXT NOT NULL DEFAULT 'open',  -- open | merged | closed
  closed_at          INTEGER,
  unaddressed_at_merge INTEGER,
  outcome            TEXT NOT NULL DEFAULT 'pending', -- accepted | rejected | ignored | closed | pending
  outcome_reason     TEXT,
  outcome_at         INTEGER,
  polled_at          INTEGER,
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS review_findings_comment ON review_findings (installation_id, comment_id) WHERE comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS review_findings_pr ON review_findings (installation_id, repo_gh_id, number);
CREATE INDEX IF NOT EXISTS review_findings_team ON review_findings (team_id, created_at);
`;

export const REPLY_CHARS = 280;
export const MAX_REPLIES = 3;
export const RETAIN_DAYS = 365;
const AROUND = 2;
const MAX_FILE_BYTES = 1_000_000;
const MAX_ROWS = 100;
const MAX_FILES = 40;
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const SEVERITIES = ['blocker', 'warning', 'nit'];
const int = (v) => (Number.isSafeInteger(v) ? v : null);
const clip = (s, n) => {
  const t = decode(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ---- Replies: simple keyword rules ----
//
// "not an issue", "intended", "false positive" -> disagree; "thanks",
// "good catch", "fixed" -> agree. A reply with both reads as disagree
// ("thanks, but this is intended"). Anything else: no verdict.
const DISAGREE = /\b(not (?:an? |really an? )?(?:issue|bug|problem|concern|relevant|applicable|valid|needed|necessary|true|the case)|false (?:positive|alarm)|won'?t fix|wontfix|(?:this|that|it) is fine|(?:this|that|it)'?s fine|works as (?:intended|expected)|expected behaviou?r|doesn'?t apply|does not apply|irrelevant|you'?re wrong|this is wrong|incorrect finding|disagree|nope|ignore (?:this|it)|no need|not needed|unnecessary|can'?t happen|cannot happen|never happens)\b/i;
const AGREE = /\b(thanks|thank you|thx|ty|good catch|nice catch|great catch|good find|nice find|good point|fixed|done|addressed|resolved|updated|changed it|will fix|fixing|agreed|you'?re right|valid point|makes sense|good call|applied)\b/i;
// "intended" says no, but "this was not intended" says the finding is right.
const INTENDED = /(?<!\b(?:not|never) )(?<!n't )\b(?:intended|intentional|deliberate|on purpose|by design)\b/i;
export function replyVerdict(text) {
  const t = decode(text).replace(/`[^`]*`/g, ' ').replace(/[’‘]/g, "'");
  if (DISAGREE.test(t) || INTENDED.test(t)) return 'disagree';
  if (AGREE.test(t)) return 'agree';
  return null;
}

// ---- One outcome per finding ----
//
// An applied suggestion is the strongest signal; an explicit "no" (a reply
// saying it is not an issue, or more 👎 than 👍) comes next, then any sign of
// use (the lines changed, more 👍, a thanks reply). A thread resolved with no
// change to the lines is a rejection. Merged with none of these: ignored.
export function deriveOutcome(r) {
  if (r.suggestion_applied) return { outcome: 'accepted', reason: 'suggestion_applied' };
  if (r.reply_verdict === 'disagree') return { outcome: 'rejected', reason: 'reply_not_an_issue' };
  if (r.down > r.up) return { outcome: 'rejected', reason: 'thumbs_down' };
  if (r.fixed_at) return { outcome: 'accepted', reason: r.resolved ? 'resolved_after_change' : 'fixed' };
  if (r.up > r.down) return { outcome: 'accepted', reason: 'thumbs_up' };
  if (r.reply_verdict === 'agree') return { outcome: 'accepted', reason: 'reply_thanks' };
  if (r.resolved) return { outcome: 'rejected', reason: 'resolved_no_change' };
  if (r.pr_state === 'merged') return { outcome: 'ignored', reason: 'merged_unaddressed' };
  if (r.pr_state === 'closed') return { outcome: 'closed', reason: 'closed_unmerged' };
  return { outcome: 'pending', reason: null };
}

// ---- "Fixed": did the commented lines survive? ----

const norm = (l) => l.trim().replace(/\s+/g, ' ');
const splitLines = (text) => String(text).replace(/\r\n?/g, '\n').split('\n');

function findSeq(hay, needle, from = 0, to = hay.length) {
  if (!needle.length) return 0;
  const last = Math.min(to, hay.length - needle.length);
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// True when the lines [line, end] (1-based, at the reviewed commit) with
// `around` lines of context are no longer found together in the new text,
// near where they were (insertions above can move them). Whitespace and
// indentation changes do not count. null when the range is not in the old text.
export function rangeChanged(oldText, newText, line, end = line, around = AROUND) {
  const a = splitLines(oldText);
  const last = Math.max(line, Number.isSafeInteger(end) ? end : line);
  if (!Number.isSafeInteger(line) || line < 1 || last > a.length) return null;
  const from = Math.max(0, line - 1 - around);
  const to = Math.min(a.length, last + around);
  // Blank edge lines carry nothing; a block of only blank lines cannot be traced.
  const block = a.slice(from, to).map(norm);
  while (block.length && !block[0]) block.shift();
  while (block.length && !block[block.length - 1]) block.pop();
  if (!block.length) return null;
  const b = splitLines(newText).map(norm);
  const slack = Math.abs(b.length - a.length) + 50;
  return findSeq(b, block, from - slack, from + slack) === -1;
}

// The suggestion as stored: its trimmed lines' hash and count (no text).
export function suggestionKey(suggestion) {
  if (typeof suggestion !== 'string') return null;
  const lines = splitLines(suggestion.replace(/\n+$/, '')).map(norm);
  if (!lines.some(Boolean)) return null;
  return { hash: crypto.createHash('sha256').update(lines.join('\n')).digest('hex'), lines: lines.length };
}
function hasSuggestion(text, key) {
  const b = splitLines(text).map(norm);
  for (let i = 0; i + key.lines <= b.length; i++) {
    if (crypto.createHash('sha256').update(b.slice(i, i + key.lines).join('\n')).digest('hex') === key.hash) return true;
  }
  return false;
}
export function suggestionApplied(oldText, newText, key) {
  if (!key?.hash || !(key.lines > 0)) return false;
  return hasSuggestion(newText, key) && !hasSuggestion(oldText, key);
}

// ---- The store ----

export function createOutcomes({ db, now = () => Date.now(), log = () => {}, auth = null, apiBase = 'https://api.github.com', fetch = globalThis.fetch, slug = null, signal = null, concurrency = 1 } = {}) {
  db.exec(OUTCOMES_SCHEMA);
  const bot = slug ? `${slug}[bot]` : null;
  const isBot = (c) => c?.user?.type === 'Bot' && (!bot || c.user.login === bot);

  // Right after a review is posted. rows: [{ finding, commentId, url }] for
  // each inline comment (commentId null when GitHub did not list it).
  function record({ teamId = null, job, reviewRow = null, ghReviewId = null, model = null, oss = false, rows = [] }) {
    const repoGhId = Number(job?.repoId);
    if (!Number.isSafeInteger(repoGhId) || !Number.isSafeInteger(job?.installationId) || !Number.isSafeInteger(job?.number) || !SHA.test(String(job?.headSha))) return 0;
    const t = now();
    const put = db.prepare(
      `INSERT OR IGNORE INTO review_findings (team_id, installation_id, repo_gh_id, owner, name, number, head_sha, review_row, gh_review_id, comment_id, path, line, end_line,
         severity, confidence, category, title, agent_kind, model, oss, suggestion_hash, suggestion_lines, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let n = 0;
    for (const { finding: f, commentId = null } of rows.slice(0, MAX_ROWS)) {
      if (!f || typeof f.path !== 'string' || !Number.isSafeInteger(f.line)) continue;
      const end = Number.isSafeInteger(f.endLine) && f.endLine > f.line ? f.endLine : null;
      const s = suggestionKey(f.suggestion);
      const kind = f.run && (f.run.kind || f.run.id) ? String(f.run.kind || 'agent').slice(0, 40) : null;
      n += put.run(
        teamId || null, job.installationId, repoGhId, job.owner, job.name, job.number, job.headSha, int(reviewRow), int(ghReviewId), int(commentId),
        f.path.slice(0, 500), f.line, end, SEVERITIES.includes(f.severity) ? f.severity : null, typeof f.confidence === 'string' ? f.confidence.slice(0, 20) : null,
        typeof f.category === 'string' ? f.category.slice(0, 40) : null, clip(f.title ?? '', 300), kind, model ? String(model).slice(0, 100) : null, oss ? 1 : 0,
        s?.hash ?? null, s?.lines ?? null, t, t,
      ).changes;
    }
    return n;
  }

  const prRows = (k) => db.prepare('SELECT * FROM review_findings WHERE installation_id = ? AND repo_gh_id = ? AND number = ? ORDER BY id LIMIT ?').all(k.installationId, k.repoGhId, k.number, MAX_ROWS * 5);
  const tracked = (k) => !!db.prepare('SELECT 1 FROM review_findings WHERE installation_id = ? AND repo_gh_id = ? AND number = ? LIMIT 1').get(k.installationId, k.repoGhId, k.number);
  const okKey = (k) => Number.isSafeInteger(k?.installationId) && Number.isSafeInteger(k?.repoGhId) && Number.isSafeInteger(k?.number) && NAME.test(String(k?.owner ?? '')) && NAME.test(String(k?.name ?? ''));

  // Outcome again for every row of a pull request (or the given rows).
  function derive(k) {
    const t = now();
    const set = db.prepare('UPDATE review_findings SET outcome = ?, outcome_reason = ?, outcome_at = ?, updated_at = ? WHERE id = ?');
    for (const r of prRows(k)) {
      const d = deriveOutcome(r);
      if (d.outcome !== r.outcome || d.reason !== r.outcome_reason) set.run(d.outcome, d.reason, t, t, r.id);
    }
  }

  // ---- Jobs: one per pull request at a time; flags of waiting jobs merge ----
  const waiting = new Map();
  const keyOf = (k) => `${k.installationId}:${k.repoGhId}:${k.number}`;
  function enqueue(job) {
    if (!auth || !okKey(job)) return false;
    const key = keyOf(job);
    const prev = waiting.get(key) ?? {};
    const merged = { ...prev, ...job, fix: !!(prev.fix || job.fix), final: !!(prev.final || job.final), headSha: job.headSha ?? prev.headSha, author: job.author ?? prev.author };
    waiting.set(key, merged);
    return queue.push(key, merged, String(job.installationId));
  }

  // pull_request synchronize: compare the commented lines with the new head.
  function onPush(k) {
    if (!okKey(k) || !SHA.test(String(k.headSha)) || !tracked(k)) return false;
    return enqueue({ ...k, fix: true });
  }
  // A reply under (or an edit of) a comment, or anything else on the pull
  // request's review comments: read reactions and replies again.
  function onActivity(k) {
    if (!okKey(k)) return false;
    if (Number.isSafeInteger(k.commentId) && !db.prepare('SELECT 1 FROM review_findings WHERE installation_id = ? AND comment_id = ?').get(k.installationId, k.commentId)) return false;
    if (!tracked(k)) return false;
    return enqueue(k);
  }
  // pull_request closed: the state now; reactions, replies, threads and a last
  // fix check against the final head in a job.
  function onClosed(k) {
    if (!okKey(k) || !tracked(k)) return false;
    const t = now();
    const at = Number.isSafeInteger(k.at) ? k.at : t;
    db.prepare('UPDATE review_findings SET pr_state = ?, closed_at = ?, updated_at = ? WHERE installation_id = ? AND repo_gh_id = ? AND number = ?').run(k.merged ? 'merged' : 'closed', at, t, k.installationId, k.repoGhId, k.number);
    derive(k);
    return enqueue({ ...k, fix: SHA.test(String(k.headSha)), final: true });
  }
  function onReopened(k) {
    if (!okKey(k) || !tracked(k)) return false;
    db.prepare("UPDATE review_findings SET pr_state = 'open', closed_at = NULL, unaddressed_at_merge = NULL, updated_at = ? WHERE installation_id = ? AND repo_gh_id = ? AND number = ?").run(now(), k.installationId, k.repoGhId, k.number);
    derive(k);
    return true;
  }
  // pull_request_review_thread resolved / unresolved: the thread's comments
  // carry Grapim's comment id. Returns how many findings changed.
  function onThread({ installationId, commentIds = [], resolved }) {
    if (!Number.isSafeInteger(installationId)) return 0;
    const t = now();
    let n = 0;
    const touched = new Map();
    for (const id of commentIds.filter(Number.isSafeInteger).slice(0, 100)) {
      const r = db.prepare('SELECT * FROM review_findings WHERE installation_id = ? AND comment_id = ?').get(installationId, id);
      if (!r) continue;
      if (!!r.resolved !== !!resolved) n += db.prepare('UPDATE review_findings SET resolved = ?, resolved_at = ?, updated_at = ? WHERE id = ?').run(resolved ? 1 : 0, resolved ? t : null, t, r.id).changes;
      touched.set(keyOf({ installationId, repoGhId: r.repo_gh_id, number: r.number }), { installationId, repoGhId: r.repo_gh_id, number: r.number });
    }
    for (const k of touched.values()) derive(k);
    return n;
  }

  // ---- Reading GitHub ----

  async function listComments(client, repo, number) {
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const r = await client.request('GET', `/repos/${repo}/pulls/${number}/comments?per_page=100&page=${page}`);
      if (!r.ok || !Array.isArray(r.json)) return page === 1 ? null : all;
      all.push(...r.json);
      if (r.json.length < 100) break;
    }
    return all;
  }

  // Thread state by the id of its first comment; null when GraphQL is not available.
  async function threads(client, owner, name, number) {
    const out = new Map();
    let after = null;
    for (let page = 0; page < 5; page++) {
      let r;
      try {
        r = await client.graphql(
          'query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { isResolved comments(first: 1) { nodes { databaseId } } } } } } }',
          { owner, name, number, after },
        );
      } catch {
        return page ? out : null;
      }
      const t = r?.data?.repository?.pullRequest?.reviewThreads;
      if (!t || !Array.isArray(t.nodes)) return page ? out : null;
      for (const n of t.nodes) {
        const id = n?.comments?.nodes?.[0]?.databaseId;
        if (Number.isSafeInteger(id)) out.set(id, n.isResolved === true);
      }
      if (!t.pageInfo?.hasNextPage) break;
      after = t.pageInfo.endCursor;
    }
    return out;
  }

  // A file at a commit: { text } | { missing: true } (404: deleted or renamed)
  // | null (too large, binary or unreadable). Kept in memory for this job only.
  async function fileAt(client, repo, path, sha) {
    const enc = path.split('/').map(encodeURIComponent).join('/');
    const r = await client.request('GET', `/repos/${repo}/contents/${enc}?ref=${sha}`);
    if (r.status === 404) return { missing: true };
    if (!r.ok || r.json?.type !== 'file' || r.json.encoding !== 'base64' || typeof r.json.content !== 'string' || Number(r.json.size) > MAX_FILE_BYTES) return null;
    const buf = Buffer.from(r.json.content, 'base64');
    if (buf.includes(0)) return null;
    return { text: buf.toString('utf8') };
  }

  // Each finding not yet fixed, posted on an older commit: the commented
  // lines at that commit against the file at `head`.
  async function checkFixes(client, k, head) {
    const repo = `${k.owner}/${k.name}`;
    const rows = prRows(k).filter((r) => !r.fixed_at && r.head_sha !== head && r.checked_sha !== head);
    const cache = new Map();
    let fetched = 0;
    const get = async (path, sha) => {
      const key = `${sha}:${path}`;
      if (!cache.has(key)) {
        if (fetched >= MAX_FILES) return null;
        fetched++;
        cache.set(key, await fileAt(client, repo, path, sha).catch(() => null));
      }
      return cache.get(key);
    };
    const t = now();
    let fixed = 0;
    for (const r of rows) {
      const before = await get(r.path, r.head_sha);
      if (!before?.text) continue;
      const after = await get(r.path, head);
      if (after === null) continue;
      const changed = after.missing ? true : rangeChanged(before.text, after.text, r.line, r.end_line ?? r.line);
      const applied = !after.missing && changed && r.suggestion_hash ? suggestionApplied(before.text, after.text, { hash: r.suggestion_hash, lines: r.suggestion_lines }) : false;
      if (changed) fixed++;
      db.prepare('UPDATE review_findings SET checked_sha = ?, fixed_sha = ?, fixed_at = ?, suggestion_applied = ?, updated_at = ? WHERE id = ?').run(
        head, changed ? head : null, changed ? t : null, applied ? 1 : r.suggestion_applied, t, r.id,
      );
    }
    return fixed;
  }

  // Reactions, replies and thread state of every tracked comment of the pull request.
  async function poll(client, k) {
    const repo = `${k.owner}/${k.name}`;
    const comments = await listComments(client, repo, k.number);
    if (!comments) return false;
    const rows = prRows(k);
    const byId = new Map(comments.map((c) => [c?.id, c]));
    const t = now();
    // Rows whose comment id was not known at posting: Grapim's own comment in
    // the same review, on the same file, with the same title.
    const known = new Set(rows.map((r) => r.comment_id).filter(Boolean));
    for (const r of rows.filter((x) => !x.comment_id)) {
      const hit = comments.find((c) => isBot(c) && !c.in_reply_to_id && !known.has(c.id) && c.path === r.path && (!r.gh_review_id || c.pull_request_review_id === r.gh_review_id) && clip(parseComment(c.body)?.title ?? '', 300) === clip(String(r.title ?? '').replace(/[.\s]+$/, ''), 300));
      if (hit) {
        known.add(hit.id);
        r.comment_id = hit.id;
        db.prepare('UPDATE OR IGNORE review_findings SET comment_id = ? WHERE id = ?').run(hit.id, r.id);
      }
    }
    const state = await threads(client, k.owner, k.name, k.number);
    for (const r of rows) {
      const c = byId.get(r.comment_id);
      if (!c) continue;
      const rx = c.reactions ?? {};
      const up = Number(rx['+1']) || 0;
      const down = Number(rx['-1']) || 0;
      const other = Math.max(0, (Number(rx.total_count) || 0) - up - down);
      const replies = comments.filter((x) => x?.in_reply_to_id === r.comment_id && x.user?.type !== 'Bot' && typeof x.body === 'string').sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || a.id - b.id);
      const trusted = (x) => TRUSTED.has(x.author_association) || (k.author && x.user?.login === k.author);
      let verdict = null;
      for (const x of replies) if (trusted(x)) verdict = replyVerdict(x.body) ?? verdict;
      const text = replies.length ? JSON.stringify(replies.slice(0, MAX_REPLIES).map((x) => ({ who: k.author && x.user?.login === k.author ? 'author' : TRUSTED.has(x.author_association) ? 'member' : 'other', text: clip(x.body, REPLY_CHARS) }))) : null;
      const resolved = state?.has(r.comment_id) ? (state.get(r.comment_id) ? 1 : 0) : r.resolved;
      db.prepare('UPDATE review_findings SET up = ?, down = ?, other_reactions = ?, replies = ?, reply_verdict = ?, reply_text = ?, resolved = ?, resolved_at = ?, polled_at = ?, updated_at = ? WHERE id = ?').run(
        up, down, other, replies.length, verdict, text, resolved, resolved ? r.resolved_at ?? t : null, t, t, r.id,
      );
    }
    return true;
  }

  async function run(job) {
    waiting.delete(keyOf(job));
    const token = await auth.installationToken(job.installationId);
    const client = new GitHubClient({ apiBase, token, fetch, now, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]) : AbortSignal.timeout(5 * 60_000), maxWaitMs: 60_000 });
    let fixed = 0;
    if (job.fix && SHA.test(String(job.headSha))) fixed = await checkFixes(client, job, job.headSha);
    const polled = await poll(client, job);
    if (job.final) {
      // Still unaddressed at merge: not changed, no suggestion taken, not resolved.
      db.prepare(
        `UPDATE review_findings SET unaddressed_at_merge = CASE WHEN fixed_at IS NULL AND suggestion_applied = 0 AND resolved = 0 THEN 1 ELSE 0 END
         WHERE installation_id = ? AND repo_gh_id = ? AND number = ? AND pr_state = 'merged'`,
      ).run(job.installationId, job.repoGhId, job.number);
    }
    derive(job);
    return { fixed, polled };
  }

  const queue = new JobQueue({
    concurrency,
    log,
    run: async (job) => {
      const r = await run(job).catch((err) => ({ failed: String(err?.message ?? err).slice(0, 200) }));
      // No repo or pull request in the log line.
      log(r.failed ? `comment outcomes: read failed: ${r.failed}` : `comment outcomes: read${r.fixed ? `, ${r.fixed} changed` : ''}`);
      return r;
    },
  });

  // ---- The hub: rates and the export, one team at a time ----

  // The last `days` days by when the comment was posted. rate: accepted of
  // the decided ones (accepted, rejected, ignored); pending and closed are
  // counted but not in the rate.
  function stats(teamId, { days = 30 } = {}) {
    const from = now() - days * 86_400_000;
    const rows = db.prepare('SELECT severity, outcome, COUNT(*) AS n FROM review_findings WHERE team_id = ? AND created_at >= ? GROUP BY severity, outcome').all(teamId, from);
    const empty = () => ({ total: 0, accepted: 0, rejected: 0, ignored: 0, pending: 0, closed: 0, decided: 0, rate: null });
    const out = { days, all: empty(), severity: Object.fromEntries(SEVERITIES.map((s) => [s, empty()])) };
    for (const r of rows) {
      for (const b of [out.all, out.severity[r.severity]].filter(Boolean)) {
        b.total += r.n;
        if (r.outcome in b) b[r.outcome] += r.n;
      }
    }
    for (const b of [out.all, ...Object.values(out.severity)]) {
      b.decided = b.accepted + b.rejected + b.ignored;
      b.rate = b.decided ? b.accepted / b.decided : null;
    }
    return out;
  }

  const COLUMNS = ['id', 'repo', 'number', 'head_sha', 'review_id', 'comment_id', 'comment_url', 'path', 'line', 'end_line', 'severity', 'confidence', 'category', 'title', 'agent_written', 'agent', 'model', 'oss', 'created_at', 'thumbs_up', 'thumbs_down', 'other_reactions', 'replies', 'reply_verdict', 'reply_text', 'resolved', 'fixed', 'fixed_sha', 'has_suggestion', 'suggestion_applied', 'pr_state', 'closed_at', 'unaddressed_at_merge', 'outcome', 'outcome_reason'];
  const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);
  // The team's rows, newest first, as plain objects (COLUMNS order).
  function exportRows(teamId, { days = RETAIN_DAYS, limit = 50_000, web = 'https://github.com' } = {}) {
    const from = now() - days * 86_400_000;
    return db.prepare('SELECT * FROM review_findings WHERE team_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?').all(teamId, from, limit).map((r) => {
      let replies = [];
      try {
        replies = r.reply_text ? JSON.parse(r.reply_text) : [];
      } catch {}
      return {
        id: r.id,
        repo: `${r.owner}/${r.name}`,
        number: r.number,
        head_sha: r.head_sha,
        review_id: r.gh_review_id,
        comment_id: r.comment_id,
        comment_url: r.comment_id ? `${web}/${r.owner}/${r.name}/pull/${r.number}#discussion_r${r.comment_id}` : null,
        path: r.path,
        line: r.line,
        end_line: r.end_line,
        severity: r.severity,
        confidence: r.confidence,
        category: r.category,
        title: r.title,
        agent_written: !!r.agent_kind,
        agent: r.agent_kind,
        model: r.model,
        oss: !!r.oss,
        created_at: iso(r.created_at),
        thumbs_up: r.up,
        thumbs_down: r.down,
        other_reactions: r.other_reactions,
        replies: r.replies,
        reply_verdict: r.reply_verdict,
        reply_text: Array.isArray(replies) ? replies : [],
        resolved: !!r.resolved,
        fixed: !!r.fixed_at,
        fixed_sha: r.fixed_sha,
        has_suggestion: !!r.suggestion_hash,
        suggestion_applied: !!r.suggestion_applied,
        pr_state: r.pr_state,
        closed_at: iso(r.closed_at),
        unaddressed_at_merge: r.unaddressed_at_merge === null ? null : !!r.unaddressed_at_merge,
        outcome: r.outcome,
        outcome_reason: r.outcome_reason,
      };
    });
  }

  // Everything of one team (a team deleted, or asked to be forgotten).
  const forgetTeam = (teamId) => db.prepare('DELETE FROM review_findings WHERE team_id = ?').run(teamId).changes;
  const sweep = (days = RETAIN_DAYS) => db.prepare('DELETE FROM review_findings WHERE created_at < ?').run(now() - days * 86_400_000).changes;

  return { record, onPush, onActivity, onClosed, onReopened, onThread, derive, stats, exportRows, columns: COLUMNS, forgetTeam, sweep, queue, close: () => queue.close() };
}
