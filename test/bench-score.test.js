// The benchmark scorer (bench/lib/score-lib.mjs) and the output parsers of
// the adapters (bench/lib/adapters.mjs). No network, no model calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchFinding, samePath, normPath, inferCategory, categoryOf, lineDistance, scorePr, scoreTool, costUsd, reportMarkdown } from '../bench/lib/score-lib.mjs';
import { parsePrAgentReview, parseClaudeComments, parseClaudeStream, dryReply } from '../bench/lib/parsers.mjs';
import { usageFromBody, fakeMessage } from '../bench/lib/meter-proxy.mjs';
import { addedRanges } from '../bench/lib/git.mjs';
import { linkedIssues } from '../bench/lib/linked.mjs';

const issue = (o = {}) => ({ path: 'src/a.js', line: 40, category: 'correctness', description: 'x', ...o });
const finding = (o = {}) => ({ path: 'src/a.js', line: 40, title: 't', body: 'b', ...o, end_line: o.end_line ?? o.line ?? 40 });

test('paths match exactly, through a/ b/ ./ prefixes, and on a / boundary only', () => {
  assert.equal(normPath('./src/a.js'), 'src/a.js');
  assert.equal(normPath('b/src/a.js'), 'src/a.js');
  assert.equal(normPath('src\\a.js'), 'src/a.js');
  assert.ok(samePath('src/a.js', 'a/src/a.js'));
  assert.ok(samePath('pkg/src/a.js', 'src/a.js'));
  assert.ok(!samePath('src/aa.js', 'src/a.js'));
  assert.ok(!samePath('xsrc/a.js', 'src/a.js'));
  assert.ok(!samePath(null, 'src/a.js'));
});

test('a finding within ±10 lines on the same file matches; 11 away does not', () => {
  assert.equal(matchFinding(finding({ line: 50, end_line: 50, category: 'performance' }), issue()), 'line');
  assert.equal(matchFinding(finding({ line: 30, end_line: 30, category: 'performance' }), issue()), 'line');
  assert.equal(matchFinding(finding({ line: 51, end_line: 51, category: 'performance' }), issue()), null);
  assert.equal(matchFinding(finding({ line: 51, category: 'performance' }), issue(), { window: 11 }), 'line');
});

test('ranges count by their nearest lines', () => {
  assert.equal(lineDistance(10, 20, 25, 30), 5);
  assert.equal(lineDistance(25, 30, 10, 20), 5);
  assert.equal(lineDistance(10, 20, 15, 15), 0);
  assert.equal(matchFinding(finding({ line: 10, end_line: 35, category: 'performance' }), issue({ line: 45 })), 'line');
  assert.equal(matchFinding(finding({ line: 70, category: 'performance' }), issue({ line: 40, end_line: 62 })), 'line');
});

test('same file and same category matches at any line; other file never matches', () => {
  assert.equal(matchFinding(finding({ line: 400, category: 'correctness' }), issue()), 'category');
  assert.equal(matchFinding(finding({ path: 'src/b.js', line: 40, category: 'correctness' }), issue()), null);
  // An issue without a line (a deleted test file) matches by category only.
  assert.equal(matchFinding(finding({ path: 't/a.test.js', line: 3, category: 'weakened_check' }), issue({ path: 't/a.test.js', line: null, category: 'weakened_check' })), 'category');
  assert.equal(matchFinding(finding({ path: 't/a.test.js', line: 3, category: 'scope' }), issue({ path: 't/a.test.js', line: null, category: 'weakened_check' })), null);
});

test('categories are inferred from text for tools that give none', () => {
  assert.equal(inferCategory('Possible SQL injection: the name is concatenated into the query'), 'security');
  assert.equal(inferCategory('The API key is hard-coded in the config'), 'secret');
  assert.equal(inferCategory('This removes the assertions from the test so it always passes'), 'weakened_check');
  assert.equal(inferCategory('This migration drops the column users.email'), 'destructive_migration');
  assert.equal(inferCategory('This change is unrelated to the issue'), 'scope');
  assert.equal(inferCategory('Off-by-one: the loop skips the last element'), 'correctness');
  assert.equal(inferCategory('Consider renaming this variable'), 'other');
  assert.equal(categoryOf({ category: 'security', title: 'off by one' }), 'security');
  assert.equal(categoryOf({ category: 'nonsense', title: 'off-by-one in the loop' }), 'correctness');
});

test('scorePr: recall over issues, precision over findings, one finding can cover two issues', () => {
  const pr = { id: 'p', issues: [issue({ line: 10 }), issue({ line: 18, category: 'security' }), issue({ path: 'src/z.js', line: 5 })] };
  const s = scorePr(pr, [finding({ line: 14, category: 'performance' }), finding({ path: 'src/q.js', line: 1 })]);
  assert.deepEqual(s.found, [true, true, false]);
  assert.deepEqual(s.tp, [true, false]);
  assert.equal(s.foundCount, 2);
  assert.equal(s.tpCount, 1);
});

test('scorePr: judge verdicts add and remove matches', () => {
  const pr = { id: 'p', issues: [issue()] };
  const fs = [finding({ line: 40 }), finding({ line: 300, end_line: 300, category: "performance" })];
  const judged = new Map([['0:0', false], ['1:0', true]]);
  const s = scorePr(pr, fs, { judged });
  assert.deepEqual(s.tp, [false, true]);
  assert.equal(s.pairs[0].how, 'judge');
});

test('scoreTool: clean-PR findings are false positives; failed and missing runs are left out', () => {
  const prs = [
    { id: 'a', issues: [issue()] },
    { id: 'b', issues: [] },
    { id: 'c', issues: [issue()] },
    { id: 'd', issues: [issue()] },
  ];
  const results = new Map([
    ['a', { status: 'ok', findings: [finding()], usage: { input: 1_000_000, output: 0 }, seconds: 10 }],
    ['b', { status: 'ok', findings: [finding(), finding({ line: 99 })], usage: { input: 0, output: 1_000_000 }, seconds: 30 }],
    ['c', { status: 'error', findings: [] }],
    ['d', { status: 'skipped', note: 'not installed' }],
  ]);
  const s = scoreTool(prs, results);
  assert.equal(s.ran, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.missing, 0);
  assert.equal(s.recall, 1);
  assert.equal(s.precision, 1 / 3);
  assert.equal(s.commentsPerPr, 1.5);
  assert.equal(s.cleanFindingsPerPr, 2);
  assert.equal(s.cleanPrsFlagged, 1);
  assert.equal(s.costPerPr, (4 + 20) / 2);
  assert.equal(s.secondsMedian, 20);
  const md = reportMarkdown({ x: s }, { prs });
  assert.ok(md.includes('| x | 2 (+1 failed) (1 skipped) | 100.0% (1/1) | 33.3% (1/3) | 50.0% | 100.0% | 33.3% |'), md);
});

test('lines-only scoring drops the category rule for issues that have a line', () => {
  const pr = { id: 'p', issues: [issue({ line: 40 }), issue({ path: 't/x.test.js', line: null, category: 'weakened_check' })] };
  const fs = [finding({ line: 300, category: 'correctness' }), finding({ path: 't/x.test.js', line: 5, category: 'weakened_check' })];
  assert.deepEqual(scorePr(pr, fs).found, [true, true]);
  assert.deepEqual(scorePr(pr, fs, { lineOnly: true }).found, [false, true]);
  const s = scoreTool([pr], new Map([['p', { status: 'ok', findings: fs }]]));
  assert.equal(s.recall, 1);
  assert.equal(s.recallStrict, 0.5);
  assert.equal(s.precisionStrict, 0.5);
});

test('costUsd uses claude-opus-5-5 list prices', () => {
  assert.equal(costUsd({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }), 4 + 20 + 0.2 + 5);
  assert.equal(costUsd(null), 0);
});

test('PR-Agent structured review -> findings', () => {
  const f = parsePrAgentReview({ review: { key_issues_to_review: [{ relevant_file: 'src/a.py ', issue_header: 'Bug', issue_content: 'None is not handled', start_line: 12, end_line: 15 }, { issue_header: 'no file' }], security_concerns: 'Yes: token is logged' } });
  assert.equal(f.length, 2);
  assert.deepEqual(f[0], { path: 'src/a.py', line: 12, end_line: 15, severity: null, category: null, title: 'Bug', body: 'None is not handled' });
  assert.equal(f[1].category, 'security');
  assert.equal(parsePrAgentReview({ review: { security_concerns: 'No' } }).length, 0);
});

test('Claude action inline comments -> findings; LEFT side, unconfirmed=false and summaries are not findings', () => {
  const lines = [
    JSON.stringify({ path: 'a.js', line: 7, body: '**Bug**: wrong check\nmore' }),
    JSON.stringify({ path: 'a.js', startLine: 3, line: 5, body: 'range' }),
    JSON.stringify({ path: 'a.js', line: 2, side: 'LEFT', body: 'old side' }),
    JSON.stringify({ path: 'a.js', line: 2, confirmed: false, body: 'probe' }),
    JSON.stringify({ kind: 'pr_comment', body: 'Overall looks good' }),
    'not json',
  ].join('\n');
  const { findings, summaries } = parseClaudeComments(lines);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].title, 'Bug**: wrong check');
  assert.equal(findings[1].line, 5);
  assert.deepEqual(summaries, ['Overall looks good']);
});

test('metering: usage from JSON and SSE bodies, fake messages round-trip', () => {
  assert.deepEqual(usageFromBody(JSON.stringify({ usage: { input_tokens: 5, output_tokens: 2 }, model: 'm' })), { usage: { input_tokens: 5, output_tokens: 2 }, model: 'm' });
  const sse = fakeMessage({ model: 'claude-opus-5-5', stream: true, messages: [{ role: 'user', content: 'x'.repeat(400) }] }, 'hello world!');
  const u = usageFromBody(sse.text);
  assert.equal(u.model, 'claude-opus-5-5');
  assert.equal(u.usage.output_tokens, 3);
  assert.ok(u.usage.input_tokens > 100);
  const plain = JSON.parse(fakeMessage({ model: 'm' }, 'hi').text);
  assert.equal(plain.content[0].text, 'hi');
});

test('dry replies are valid for each tool', () => {
  const g = JSON.parse(dryReply({ system: [{ text: 'You are Grapim Review, ...' }], messages: [{ content: [{ type: 'text', text: '<<<GRAPIM-UNTRUSTED kind=DIFF file="1" path="src/x.js" id=abc>>>\n@@ hunk 1\n   OLD  NEW\n   1    1   a\n        2 + b\n<<<END GRAPIM-UNTRUSTED id=abc>>>' }] }] }));
  assert.deepEqual(g.findings.map((f) => [f.path, f.line]), [['src/x.js', 2]]);
  assert.match(dryReply({ messages: [{ content: "key_issues_to_review ## File: 'a.py'" }] }), /relevant_file: \|\n\s+a\.py/);
});

test('added ranges from a -U0 diff', () => {
  const d = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,0 +2,3 @@', '+a', '+b', '+c', '@@ -9 +12 @@', '-q', '+r', '@@ -20,2 +22,0 @@', '-s', '-t', 'diff --git a/y b/y', '--- a/y', '+++ /dev/null', '@@ -1 +0,0 @@', '-z'].join('\n');
  assert.deepEqual(addedRanges(d), { x: [[2, 4], [12, 12]] });
});

test('linked issues from a PR body', () => {
  assert.deepEqual(linkedIssues('Fixes #12 and closes acme/app#3; see also #99. Resolves other/repo#5. https://github.com/acme/app/issues/77', 'acme/app'), [12, 3, 77]);
});

test('Claude Code stream-json: inline comment and gh pr comment tool calls become records', async () => {

  const ev = (content) => JSON.stringify({ type: 'assistant', message: { content } });
  const out = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    ev([{ type: 'tool_use', name: 'Bash', input: { command: 'gh pr diff' } }]),
    ev([{ type: 'text', text: 'Looking' }, { type: 'tool_use', name: 'mcp__github_inline_comment__create_inline_comment', input: { path: 'a.go', line: 9, body: 'nil deref' } }]),
    ev([{ type: 'tool_use', name: 'Bash', input: { command: 'gh pr comment 5 --body "Summary"' } }]),
    JSON.stringify({ type: 'result', num_turns: 4 }),
  ].join('\n');
  const { records, result } = parseClaudeStream(out);
  assert.equal(result.num_turns, 4);
  const { findings, summaries } = parseClaudeComments(records);
  assert.deepEqual(findings.map((f) => [f.path, f.line, f.title]), [['a.go', 9, 'nil deref']]);
  assert.equal(summaries.length, 1);
});
