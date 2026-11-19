// The comment outcome log (src/hub/github/outcomes.js): one row per inline
// comment cloud review posts, and what happened to it, against a fake GitHub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createOutcomes, deriveOutcome, rangeChanged, replyVerdict, suggestionApplied, suggestionKey } from '../src/hub/github/outcomes.js';

const BOT = { login: 'grapim-test[bot]', type: 'Bot' };
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const NEWER = 'c'.repeat(40);

test('reply verdicts: "not an issue" is a no, "thanks, fixed" a yes, the rest nothing', () => {
  for (const t of ['Not an issue, the caller checks it.', 'This is intended.', 'false positive', "That's fine here", 'Works as expected, by design', 'nope', 'Thanks, but this is intentional']) assert.equal(replyVerdict(t), 'disagree', t);
  for (const t of ['Thanks!', 'Good catch, fixed in the next commit', 'done', "You're right", 'Agreed, will fix']) assert.equal(replyVerdict(t), 'agree', t);
  for (const t of ['@grapim why?', 'Can you explain the second case?', '']) assert.equal(replyVerdict(t), null, t);
  assert.equal(replyVerdict('Oh, that was not intended. Fixed.'), 'agree', '"not intended" agrees with the finding');
  assert.equal(replyVerdict('You’re right'), 'agree', 'a curly apostrophe');
});

test('fixed: the commented lines (and two around them) gone from the new file; a shift or reindent is not a fix', () => {
  const before = ['import x from "y";', '', 'export function f(a) {', '  const b = a.c;', '  return b;', '}', ''].join('\n');
  assert.equal(rangeChanged(before, before, 4, 4), false);
  assert.equal(rangeChanged(before, `// header\n// more\n${before}`, 4, 4), false, 'lines inserted above only move it');
  assert.equal(rangeChanged(before, before.replace('  const b', '    const b'), 4, 4), false, 'indentation only');
  assert.equal(rangeChanged(before, before.replace('a.c', 'a?.c'), 4, 4), true, 'the line itself');
  assert.equal(rangeChanged(before, before.replace('  return b;', '  if (!b) throw new Error();\n  return b;'), 4, 4), true, 'a line added right under it');
  assert.equal(rangeChanged(before, before, 40, 40), null, 'not a line of the old file');
  const key = suggestionKey('  const b = a?.c;\n');
  assert.equal(key.lines, 1);
  assert.ok(!JSON.stringify(key).includes('a?.c'), 'only a hash of the suggestion');
  assert.equal(suggestionApplied(before, before.replace('a.c', 'a?.c'), key), true);
  assert.equal(suggestionApplied(before, before.replace('a.c', 'a!.c'), key), false);
  assert.equal(suggestionKey('\n\n'), null);
});

test('one outcome per finding, in order of how strong the signal is', () => {
  const base = { up: 0, down: 0, reply_verdict: null, resolved: 0, fixed_at: null, suggestion_applied: 0, pr_state: 'open' };
  const o = (x) => deriveOutcome({ ...base, ...x });
  assert.deepEqual(o({}), { outcome: 'pending', reason: null });
  assert.equal(o({ fixed_at: 1 }).reason, 'fixed');
  assert.equal(o({ fixed_at: 1, resolved: 1 }).reason, 'resolved_after_change');
  assert.equal(o({ resolved: 1 }).outcome, 'rejected');
  assert.equal(o({ up: 2, down: 1 }).reason, 'thumbs_up');
  assert.equal(o({ up: 1, down: 2, fixed_at: 1 }).reason, 'thumbs_down', 'an explicit no beats a nearby change');
  assert.equal(o({ down: 1, suggestion_applied: 1 }).reason, 'suggestion_applied');
  assert.equal(o({ reply_verdict: 'disagree', up: 3 }).outcome, 'rejected');
  assert.equal(o({ reply_verdict: 'agree' }).reason, 'reply_thanks');
  assert.equal(o({ pr_state: 'merged' }).outcome, 'ignored');
  assert.equal(o({ pr_state: 'closed' }).outcome, 'closed');
});

// A fake GitHub: the pull request's review comments, files by commit, and
// review threads over GraphQL.
function fakeGitHub() {
  const s = { comments: [], files: new Map(), threads: new Map(), graphqlFails: false, requests: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const url = new URL(req.url, 'http://x');
    s.requests.push(`${req.method} ${url.pathname}`);
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== 'Bearer ghs_outcomes') return send(401, { message: 'bad token' });
    if (url.pathname === '/repos/acme/api/pulls/7/comments') return send(200, url.searchParams.get('page') === '1' ? s.comments : []);
    let m;
    if ((m = /^\/repos\/acme\/api\/contents\/(.+)$/.exec(url.pathname))) {
      const text = s.files.get(`${url.searchParams.get('ref')}:${decodeURIComponent(m[1])}`);
      if (text === undefined) return send(404, { message: 'Not Found' });
      return send(200, { type: 'file', encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') });
    }
    if (url.pathname === '/graphql' && req.method === 'POST') {
      if (s.graphqlFails) return send(200, { data: null, errors: [{ type: 'FORBIDDEN', message: 'no' }] });
      assert.deepEqual({ owner: body.variables.owner, name: body.variables.name, number: body.variables.number }, { owner: 'acme', name: 'api', number: 7 });
      const nodes = [...s.threads].map(([id, isResolved]) => ({ isResolved, comments: { nodes: [{ databaseId: id }] } }));
      return send(200, { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } });
    }
    send(404, { message: `fake: no route ${req.method} ${url.pathname}` });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ s, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

const FILE = ['export function total(items) {', '  let sum = 0;', '  for (const i of items) sum += i.price;', '  return sum;', '}', '', 'export function avg(items) {', '  return total(items) / items.length;', '}', ''].join('\n');
const finding = (over) => ({ path: 'src/cart.js', line: 3, severity: 'warning', confidence: 'high', category: 'correctness', title: 'Price can be undefined', body: 'x', ...over });

async function setup(t) {
  const gh = await fakeGitHub();
  const db = new DatabaseSync(':memory:');
  let clock = Date.parse('2026-11-01T00:00:00Z');
  const logs = [];
  const outcomes = createOutcomes({ db, now: () => clock, log: (l) => logs.push(l), auth: { installationToken: async () => 'ghs_outcomes' }, apiBase: gh.base, fetch: globalThis.fetch, slug: 'grapim-test' });
  t.after(async () => {
    outcomes.close();
    await gh.close();
  });
  const pr = { installationId: 1, repoGhId: 99, owner: 'acme', name: 'api', number: 7, author: 'dev' };
  const job = { installationId: 1, repoId: 99, owner: 'acme', name: 'api', number: 7, headSha: OLD };
  const comment = (id, f, extra = {}) => ({ id, pull_request_review_id: 500, path: f.path, line: f.line, body: `**${f.severity[0].toUpperCase()}${f.severity.slice(1)} · ${f.title}.**\n\nbody`, user: BOT, reactions: { '+1': 0, '-1': 0, total_count: 0 }, ...extra });
  const rowOf = (commentId) => db.prepare('SELECT * FROM review_findings WHERE comment_id = ?').get(commentId);
  return { gh, db, outcomes, pr, job, comment, rowOf, logs, tick: (ms) => (clock += ms) };
}

test('a posted review: one row per inline comment, with no code and no prompt', async (t) => {
  const { outcomes, db, job } = await setup(t);
  const n = outcomes.record({
    teamId: 'team1',
    job,
    reviewRow: 3,
    ghReviewId: 500,
    model: 'claude-opus-5-5',
    rows: [
      { finding: finding({ endLine: 4, suggestion: '  for (const i of items) sum += i.price ?? 0;', run: { id: 'r1', kind: 'claude', intent: 'Add the cart total; secret prompt' } }), commentId: 11 },
      { finding: finding({ path: 'src/b.js', line: 1, severity: 'nit', title: 'Name' }), commentId: null },
    ],
  });
  assert.equal(n, 2);
  const r = db.prepare('SELECT * FROM review_findings WHERE comment_id = 11').get();
  assert.equal(r.team_id, 'team1');
  assert.equal(r.repo_gh_id, 99);
  assert.equal(r.head_sha, OLD);
  assert.equal(r.gh_review_id, 500);
  assert.equal(r.review_row, 3);
  assert.deepEqual([r.path, r.line, r.end_line, r.severity, r.confidence, r.category, r.title], ['src/cart.js', 3, 4, 'warning', 'high', 'correctness', 'Price can be undefined']);
  assert.equal(r.agent_kind, 'claude');
  assert.equal(r.model, 'claude-opus-5-5');
  assert.equal(r.outcome, 'pending');
  assert.ok(r.suggestion_hash && r.suggestion_lines === 1);
  const all = JSON.stringify(db.prepare('SELECT * FROM review_findings').all());
  assert.ok(!all.includes('secret prompt') && !all.includes('price ?? 0'), 'neither the prompt nor the suggestion is stored');
  // The same comment again (a retried job): no second row.
  assert.equal(outcomes.record({ teamId: 'team1', job, rows: [{ finding: finding(), commentId: 11 }] }), 0);
});

test('reactions and replies: read when the pull request is touched; a stranger’s "not an issue" counts as a reply, not a verdict', async (t) => {
  const { gh, outcomes, job, pr, comment, rowOf } = await setup(t);
  const a = finding({ title: 'Price can be undefined' });
  const b = finding({ line: 8, title: 'Division by zero on an empty cart' });
  const c = finding({ line: 2, title: 'Use reduce' });
  const d = finding({ line: 1, severity: 'blocker', title: 'Export name collides' });
  outcomes.record({ teamId: 'team1', job, ghReviewId: 500, rows: [{ finding: a, commentId: 11 }, { finding: b, commentId: 12 }, { finding: c, commentId: 13 }, { finding: d, commentId: null }] });
  gh.s.comments = [
    comment(11, a, { reactions: { '+1': 2, '-1': 0, heart: 1, total_count: 3 } }),
    comment(12, b, { reactions: { '+1': 0, '-1': 1, total_count: 1 } }),
    comment(13, c),
    comment(14, d),
    { id: 21, in_reply_to_id: 13, body: 'Not an issue, the list is tiny.', user: { login: 'stranger', type: 'User' }, author_association: 'NONE', created_at: '2026-11-01T01:00:00Z' },
    { id: 22, in_reply_to_id: 14, body: 'Thanks, good catch!', user: { login: 'dev', type: 'User' }, author_association: 'CONTRIBUTOR', created_at: '2026-11-01T01:00:00Z' },
    { id: 23, in_reply_to_id: 11, body: 'x'.repeat(1000), user: { login: 'lead', type: 'User' }, author_association: 'MEMBER', created_at: '2026-11-01T02:00:00Z' },
    { id: 24, in_reply_to_id: 11, body: 'I can explain that.', user: BOT, created_at: '2026-11-01T03:00:00Z' },
  ];
  assert.equal(outcomes.onActivity({ ...pr, commentId: 999 }), false, 'a reply under someone else’s comment reads nothing');
  assert.equal(outcomes.onActivity({ ...pr, commentId: 13 }), true);
  await outcomes.queue.idle();

  const ra = rowOf(11);
  assert.deepEqual([ra.up, ra.down, ra.other_reactions, ra.outcome, ra.outcome_reason], [2, 0, 1, 'accepted', 'thumbs_up']);
  assert.equal(ra.replies, 1, 'Grapim’s own answer is not a reply');
  const [reply] = JSON.parse(ra.reply_text);
  assert.equal(reply.who, 'member');
  assert.ok(reply.text.length <= 280, 'reply text is truncated');
  assert.equal(rowOf(12).outcome, 'rejected');
  assert.equal(rowOf(12).outcome_reason, 'thumbs_down');
  const rc = rowOf(13);
  assert.deepEqual([rc.replies, rc.reply_verdict, rc.outcome], [1, null, 'pending']);
  assert.equal(JSON.parse(rc.reply_text)[0].who, 'other');
  // The row posted without a comment id found its comment (same review, file and title); the author's thanks counts.
  const rd = rowOf(14);
  assert.ok(rd, 'comment id filled in');
  assert.deepEqual([rd.reply_verdict, rd.outcome, rd.outcome_reason], ['agree', 'accepted', 'reply_thanks']);

  // A member says it is not an issue: rejected, whatever the reactions.
  gh.s.comments.push({ id: 25, in_reply_to_id: 11, body: 'This is intended, not an issue.', user: { login: 'lead', type: 'User' }, author_association: 'MEMBER', created_at: '2026-11-01T04:00:00Z' });
  outcomes.onActivity({ ...pr, commentId: 11 });
  await outcomes.queue.idle();
  assert.deepEqual([rowOf(11).replies, rowOf(11).outcome, rowOf(11).outcome_reason], [2, 'rejected', 'reply_not_an_issue']);
});

test('thread resolved: with no change a rejection, after a change an acceptance; GraphQL agrees on the next read', async (t) => {
  const { gh, outcomes, job, pr, comment, rowOf } = await setup(t);
  const a = finding();
  outcomes.record({ teamId: 'team1', job, rows: [{ finding: a, commentId: 11 }] });
  gh.s.comments = [comment(11, a)];
  assert.equal(outcomes.onThread({ installationId: 1, commentIds: [11, 4242], resolved: true }), 1);
  assert.equal(rowOf(11).resolved, 1);
  assert.deepEqual([rowOf(11).outcome, rowOf(11).outcome_reason], ['rejected', 'resolved_no_change']);
  assert.equal(outcomes.onThread({ installationId: 2, commentIds: [11], resolved: true }), 0, 'another installation’s comment 11 is not this one');

  // Then the lines change: resolved after a change.
  gh.s.files.set(`${OLD}:src/cart.js`, FILE);
  gh.s.files.set(`${NEW}:src/cart.js`, FILE.replace('sum += i.price', 'sum += i.price ?? 0'));
  gh.s.threads.set(11, true);
  assert.equal(outcomes.onPush({ ...pr, headSha: NEW }), true);
  await outcomes.queue.idle();
  assert.deepEqual([rowOf(11).resolved, rowOf(11).fixed_sha, rowOf(11).outcome, rowOf(11).outcome_reason], [1, NEW, 'accepted', 'resolved_after_change']);

  // Unresolved on GitHub (no webhook): the next read says so.
  gh.s.threads.set(11, false);
  outcomes.onActivity(pr);
  await outcomes.queue.idle();
  assert.equal(rowOf(11).resolved, 0);
  assert.equal(rowOf(11).outcome_reason, 'fixed');
});

test('fixed by a later commit and suggestion applied: computed on a push; a shift, an untouched line or another file is not a fix', async (t) => {
  const { gh, outcomes, job, pr, comment, rowOf } = await setup(t);
  const a = finding({ line: 3, title: 'Price can be undefined', suggestion: '  for (const i of items) sum += i.price ?? 0;' });
  const b = finding({ line: 8, title: 'Division by zero on an empty cart' });
  const c = finding({ path: 'src/gone.js', line: 1, title: 'Unused file' });
  const d = finding({ path: 'src/other.js', line: 1, title: 'Unrelated' });
  outcomes.record({ teamId: 'team1', job, rows: [{ finding: a, commentId: 11 }, { finding: b, commentId: 12 }, { finding: c, commentId: 13 }, { finding: d, commentId: 14 }] });
  gh.s.comments = [comment(11, a), comment(12, b), comment(13, c), comment(14, d)];
  gh.s.files.set(`${OLD}:src/cart.js`, FILE);
  gh.s.files.set(`${OLD}:src/gone.js`, 'module.exports = 1;\n');
  gh.s.files.set(`${OLD}:src/other.js`, 'const x = 1;\nconst y = 2;\n');
  gh.s.files.set(`${NEW}:src/other.js`, 'const x = 1;\nconst y = 2;\n');
  // The suggestion committed, plus a header comment that moves every line down.
  gh.s.files.set(`${NEW}:src/cart.js`, `// cart\n${FILE.replace('  for (const i of items) sum += i.price;', '  for (const i of items) sum += i.price ?? 0;')}`);

  assert.equal(outcomes.onPush({ ...pr, headSha: 'nope' }), false);
  assert.equal(outcomes.onPush({ ...pr, number: 8, headSha: NEW }), false, 'a pull request with no comments reads nothing');
  assert.equal(outcomes.onPush({ ...pr, headSha: NEW }), true);
  await outcomes.queue.idle();
  assert.deepEqual([rowOf(11).fixed_sha, rowOf(11).suggestion_applied, rowOf(11).outcome, rowOf(11).outcome_reason], [NEW, 1, 'accepted', 'suggestion_applied']);
  assert.deepEqual([rowOf(12).fixed_at, rowOf(12).checked_sha, rowOf(12).outcome], [null, NEW, 'pending'], 'moved down by one line, not changed');
  assert.equal(rowOf(13).outcome_reason, 'fixed', 'the file is gone at the new head');
  assert.equal(rowOf(14).fixed_at, null);

  // A second push changes the division: fixed, without a suggestion.
  gh.s.files.set(`${NEWER}:src/cart.js`, FILE.replace('total(items) / items.length', 'items.length ? total(items) / items.length : 0'));
  gh.s.files.set(`${NEWER}:src/other.js`, 'const x = 1;\nconst y = 2;\n');
  const before = gh.s.requests.length;
  outcomes.onPush({ ...pr, headSha: NEWER });
  await outcomes.queue.idle();
  assert.deepEqual([rowOf(12).fixed_sha, rowOf(12).suggestion_applied, rowOf(12).outcome_reason], [NEWER, 0, 'fixed']);
  assert.ok(!gh.s.requests.slice(before).some((r) => r.includes('gone.js')), 'a fixed finding is not compared again');
});

test('merged: still unaddressed comments are ignored; closed unmerged is left out of the rates; reopened is pending again', async (t) => {
  const { gh, outcomes, db, job, pr, comment, rowOf } = await setup(t);
  const a = finding({ title: 'One' });
  const b = finding({ line: 8, title: 'Two' });
  outcomes.record({ teamId: 'team1', job, rows: [{ finding: a, commentId: 11 }, { finding: b, commentId: 12 }] });
  gh.s.comments = [comment(11, a), comment(12, b, { reactions: { '+1': 1, '-1': 0, total_count: 1 } })];
  gh.s.graphqlFails = true;
  gh.s.files.set(`${OLD}:src/cart.js`, FILE);
  gh.s.files.set(`${NEW}:src/cart.js`, FILE);

  assert.equal(outcomes.onClosed({ ...pr, merged: true, headSha: NEW, at: 123 }), true);
  assert.equal(rowOf(11).outcome, 'ignored', 'settled at once, before GitHub is read');
  await outcomes.queue.idle();
  assert.deepEqual([rowOf(11).pr_state, rowOf(11).closed_at, rowOf(11).unaddressed_at_merge, rowOf(11).outcome, rowOf(11).outcome_reason], ['merged', 123, 1, 'ignored', 'merged_unaddressed']);
  assert.deepEqual([rowOf(12).unaddressed_at_merge, rowOf(12).outcome], [1, 'accepted'], 'a 👍 still accepts it, though nothing changed');

  outcomes.onReopened(pr);
  assert.deepEqual([rowOf(11).pr_state, rowOf(11).unaddressed_at_merge, rowOf(11).outcome], ['open', null, 'pending']);
  outcomes.onClosed({ ...pr, merged: false, headSha: NEW });
  await outcomes.queue.idle();
  assert.equal(rowOf(11).outcome, 'closed');
  assert.equal(rowOf(11).unaddressed_at_merge, null);

  const s = outcomes.stats('team1');
  assert.deepEqual([s.all.total, s.all.accepted, s.all.closed, s.all.decided, s.all.rate], [2, 1, 1, 1, 1]);
  assert.equal(s.severity.warning.total, 2);
  assert.equal(s.severity.blocker.rate, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_findings').get().n, 2);
});

test('stats and export are per team; a team can be forgotten; old rows go', async (t) => {
  const { outcomes, job, tick } = await setup(t);
  outcomes.record({ teamId: 'team1', job, rows: [{ finding: finding({ severity: 'blocker' }), commentId: 11 }] });
  outcomes.record({ teamId: 'team2', job: { ...job, number: 8, owner: 'other', name: 'secret' }, rows: [{ finding: finding({ title: 'Theirs' }), commentId: 12 }] });
  outcomes.record({ teamId: null, job: { ...job, number: 9 }, oss: true, rows: [{ finding: finding({ title: 'Open source' }), commentId: 13 }] });
  const mine = outcomes.exportRows('team1');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].repo, 'acme/api');
  assert.equal(mine[0].comment_url, 'https://github.com/acme/api/pull/7#discussion_r11');
  assert.deepEqual(Object.keys(mine[0]), outcomes.columns);
  assert.equal(outcomes.stats('team1').severity.blocker.total, 1);
  assert.equal(outcomes.stats('team1').all.total, 1);
  assert.equal(outcomes.forgetTeam('team2'), 1);
  assert.equal(outcomes.exportRows('team2').length, 0);
  tick(40 * 86_400_000);
  assert.equal(outcomes.stats('team1').all.total, 0, 'the block counts the last 30 days');
  assert.equal(outcomes.exportRows('team1').length, 1, 'the export keeps a year');
  tick(400 * 86_400_000);
  assert.equal(outcomes.sweep(), 2);
});
