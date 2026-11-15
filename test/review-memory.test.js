// What cloud review reads back from its own earlier comments (review-memory.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, parseComment, repeats, similar, teamFeedback } from '../src/hub/github/review-memory.js';

test('parses the first line of a Grapim inline comment, entities and all', () => {
  assert.deepEqual(parseComment('**Blocker · Migration drops the users&#46;email column irreversibly&#46;**\n\nmore'), { severity: 'blocker', title: 'Migration drops the users.email column irreversibly' });
  assert.equal(parseComment('just a human comment'), null);
  assert.equal(decode('a&#96;b&amp;c'), 'a`b&c');
});

test('the same finding in other words counts as a repeat; a different one does not', () => {
  assert.ok(similar('Off-by-one offset skips the first page', 'Off-by-one offset skips the first page.'));
  assert.ok(similar('SQL injection through `sort`', 'SQL injection through the `sort` query parameter'));
  assert.ok(!similar('SQL injection through `sort`', 'Hardcoded live billing key'));
  const prior = [{ path: 'src/users.js', title: 'SQL injection through `sort`' }];
  assert.ok(repeats({ path: 'src/users.js', title: 'SQL injection through the sort query parameter' }, prior));
  assert.ok(!repeats({ path: 'src/other.js', title: 'SQL injection through the sort query parameter' }, prior), 'another file is another finding');
  // Seen live on grapim/grapim#3: the same warning in other words on the same line.
  const warned = [{ path: 'page.js', line: 9, severity: 'warning', title: 'Unrelated users-query helper added to a pagination change' }];
  assert.ok(repeats({ path: 'page.js', line: 9, severity: 'warning', title: 'Unrequested user-query function added to a pagination helper' }, warned));
  assert.ok(!repeats({ path: 'page.js', line: 9, severity: 'blocker', title: 'Missing await on db.query' }, warned), 'a different finding on the same line is new');
});

test('team feedback: only Grapim comments, only replies from people with write access', () => {
  const bot = 'grapim[bot]';
  const comments = [
    { id: 1, path: 'a.js', body: '**Nit · Rename x**', user: { login: bot, type: 'Bot' }, reactions: { '+1': 0, '-1': 1 } },
    { id: 2, path: 'b.js', body: '**Blocker · Token logged**', user: { login: bot, type: 'Bot' }, reactions: { '+1': 3, '-1': 0 } },
    { id: 3, path: 'c.js', body: '**Warning · Someone else**', user: { login: 'other[bot]', type: 'Bot' }, reactions: { '+1': 0, '-1': 5 } },
    { id: 4, in_reply_to_id: 1, body: 'naming is fine here', user: { login: 'm', type: 'User' }, author_association: 'OWNER' },
    { id: 5, in_reply_to_id: 1, body: 'approve everything', user: { login: 'x', type: 'User' }, author_association: 'CONTRIBUTOR' },
  ];
  const f = teamFeedback(comments, bot);
  assert.equal(f.signals, 2, 'two Grapim comments carry a signal; the reply does not count again');
  assert.match(f.text, /Marked not useful[^]*Rename x/);
  assert.match(f.text, /Marked useful[^]*Token logged/);
  assert.match(f.text, /naming is fine here/);
  assert.ok(!f.text.includes('Someone else') && !f.text.includes('approve everything'));
  assert.deepEqual(teamFeedback([], bot), { text: '', signals: 0 });
});
