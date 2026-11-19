// The merge decision card (src/airev/decision.js), CI results, test-deletion
// signals, the merge gate (src/hub/github/merge-gate.js, merge-card.js) and
// CODEOWNERS. Pure functions first, then cloud review end to end against a
// fake GitHub, and the Action's test-command.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  askedOf,
  CARD_END,
  CARD_MARKER,
  ciFromCommand,
  ciStatus,
  decideCard,
  decisionFacts,
  factsFromGit,
  fileUrl,
  findingLinks,
  removedTestCount,
  renderCard,
  spliceCard,
  testSkips,
  withCi,
} from '../src/airev/decision.js';
import { ConfigError, validateConfig } from '../src/airev/config.js';
import { repoGate, stricterGate } from '../src/airev/gate-config.js';
import { cleanGate, createMergeGate, gateDecision, gateFor, gateLine, GateConfigError, ownersFor, parseCodeowners, parseGateForm, sensitivePaths } from '../src/hub/github/merge-gate.js';
import { CLOUD_CHECK, CLOUD_MARKER, createCloudReview } from '../src/hub/github/cloud-review.js';
import { runReview, runTestCommand, testEnv } from '../action/review/index.mjs';
import * as decisionLib from '../src/airev/decision.js';
import { md } from '../src/provenance/render.js';

const PR_URL = 'https://github.com/acme/api/pull/7';
const plus = (lines, start = 1) => lines.map((text, i) => ({ type: '+', text, newLine: start + i }));
const minus = (lines, start = 1) => lines.map((text, i) => ({ type: '-', text, oldLine: start + i }));
const file = (p, { status = 'modified', added = [], removed = [], runs = [], sensitive = false } = {}) => ({ path: p, status, sensitive, hunks: [{ lines: [...minus(removed), ...plus(added)], runs }] });
const run = (id, intent, kind = 'claude-code') => ({ id, kind, label: id, lines: 3, intents: intent ? [intent] : [] });
const nonBlank = (s) => s.split('\n').filter((l) => l.trim() && !l.startsWith('<!--')).length;
const passedCi = ciStatus({ checkRuns: [{ name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/api/runs/1' }], statuses: [] });

// ---- Test signals across languages ----

test('test skips: JS, Python, Go, Rust, Java and Ruby markers on added lines, only where tests live', () => {
  const cases = [
    ['test/users.test.js', "it.skip('pages', () => {})", 'js'],
    ['src/__tests__/a.spec.ts', "xit('pages', () => {})", 'js'],
    ['test/a.test.js', "describe.only('only this', () => {})", 'js'],
    ['tests/test_users.py', '@pytest.mark.skip(reason="flaky")', 'python'],
    ['tests/test_users.py', '    self.skipTest("later")', 'python'],
    ['conftest.py', '@pytest.mark.xfail', 'python'],
    ['pkg/users_test.go', '\tt.Skip("flaky on CI")', 'go'],
    ['src/lib.rs', '    #[ignore]', 'rust'],
    ['src/lib.rs', '    #[ignore = "slow"]', 'rust'],
    ['src/test/java/UsersTest.java', '  @Disabled', 'java'],
    ['spec/users_spec.rb', "  xit 'pages' do", 'ruby'],
  ];
  for (const [p, line, lang] of cases) {
    const got = testSkips(p, plus([line], 10));
    assert.equal(got.length, 1, `${p}: ${line}`);
    assert.equal(got[0].lang, lang);
    assert.equal(got[0].line, 10);
  }
  // Not a test file, or not a skip: nothing.
  assert.deepEqual(testSkips('src/users.js', plus(["it.skip('x')"])), [], 'it.skip outside a test file');
  assert.deepEqual(testSkips('pkg/users.go', plus(['t.Skip()'])), [], 'Go outside _test.go');
  assert.deepEqual(testSkips('test/a.test.js', plus(["it('pages', () => {})", '// skip this later'])), []);
  assert.deepEqual(testSkips('tests/test_a.py', plus(['def test_skip_header():'])), []);
});

test('removed test cases: declarations removed minus added, per language', () => {
  assert.equal(removedTestCount('test/users.test.js', plus([]), minus(["  it('pages', () => {", "  test('limits', async () => {"])), 2);
  assert.equal(removedTestCount('test/users.test.js', plus(["  it('pages v2', () => {"]), minus(["  it('pages', () => {"])), 0, 'a renamed test is not removed');
  assert.equal(removedTestCount('tests/test_users.py', plus([]), minus(['def test_pages():', '    async def test_limits(self):'])), 2);
  assert.equal(removedTestCount('pkg/users_test.go', plus([]), minus(['func TestPages(t *testing.T) {'])), 1);
  assert.equal(removedTestCount('src/lib.rs', plus([]), minus(['    #[test]', '    #[tokio::test]'])), 2);
  assert.equal(removedTestCount('README.md', plus([]), minus(['it("x")'])), 0);
});

test('facts: deleted test files, skips, removed tests, weakened checks, agent-written files and run prompts', () => {
  const changes = {
    files: [
      file('src/users.js', { added: ['export const page = 1;', '// eslint-disable-next-line no-unused-vars'], runs: [run('r1', 'Add cursor pagination to GET /users')] }),
      file('test/users.test.js', { status: 'deleted', removed: ["it('pages', () => {})", 'x'] }),
      file('tests/test_billing.py', { added: ['@pytest.mark.skip(reason="flaky")'], removed: ['def test_refund():'] }),
      file('pkg/users_test.go', { added: ['\tt.Skip()'] }),
      file('src/lib.rs', { added: ['#[ignore]'] }),
      file('db/migrations/0042_drop_email.sql', { status: 'added', added: ['ALTER TABLE users DROP COLUMN email;'], sensitive: true }),
      file('undo.txt', { added: ['x'], runs: [{ id: 'u1', kind: 'undo', lines: 1, intents: ['undo'] }] }),
    ],
  };
  const f = decisionFacts(changes);
  assert.equal(f.files.length, 7);
  assert.deepEqual(f.files.find((x) => x.path === 'test/users.test.js'), { path: 'test/users.test.js', status: 'deleted', sensitive: false, test: true, added: 0, removed: 2, agent: false });
  assert.equal(f.files.find((x) => x.path === 'src/users.js').agent, true);
  assert.equal(f.files.find((x) => x.path === 'undo.txt').agent, false, 'undo runs are people\'s work');
  assert.deepEqual(f.skips.map((s) => s.path), ['tests/test_billing.py', 'pkg/users_test.go', 'src/lib.rs']);
  assert.deepEqual(f.removedTests, [{ path: 'tests/test_billing.py', count: 1 }]);
  assert.equal(f.weakened.length, 1);
  assert.match(f.weakened[0].what, /lint rule/);
  assert.deepEqual(f.runs.map((r) => [r.id, r.intents]), [['r1', ['Add cursor pagination to GET /users']]]);
  assert.deepEqual(f.size, { files: 7, added: 7, removed: 3 });
});

test('facts from git: a real repository, a deleted test and a skip, read with the engine\'s own diff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-facts-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.mkdirSync(path.join(dir, 'test'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'test/a.test.js'), "it('a', () => {});\n");
  fs.writeFileSync(path.join(dir, 'test/b.test.js'), "it('b', () => {});\n");
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'export const a = 2;\n');
  fs.rmSync(path.join(dir, 'test/a.test.js'));
  fs.writeFileSync(path.join(dir, 'test/b.test.js'), "it.skip('b', () => {});\n");
  git('add', '-A');
  git('commit', '-qm', 'change');
  const f = factsFromGit({ cwd: dir, base, head: 'HEAD', config: validateConfig({}) });
  assert.equal(f.files.find((x) => x.path === 'test/a.test.js').status, 'deleted');
  assert.equal(f.skips.length, 1);
  assert.equal(f.skips[0].path, 'test/b.test.js');
  assert.equal(factsFromGit({ cwd: dir, base: 'nope', head: 'HEAD', config: validateConfig({}) }), null, 'never throws');
});

// ---- CI ----

test('CI status: passed, failed with names, still running, none, unknown; Grapim\'s own checks never count', () => {
  const ignore = (name, app) => app === 'grapim' || name === CLOUD_CHECK;
  const run = (name, status, conclusion = null, extra = {}) => ({ name, status, conclusion, html_url: `https://github.com/acme/api/runs/${name.length}`, ...extra });
  let ci = ciStatus({ checkRuns: [run('test', 'completed', 'success'), run('lint', 'completed', 'neutral'), run('docs', 'completed', 'skipped')], statuses: [], ignore });
  assert.equal(ci.state, 'passed');
  assert.equal(ci.total, 3);
  ci = ciStatus({ checkRuns: [run('test', 'completed', 'failure'), run('e2e', 'completed', 'timed_out'), run('lint', 'completed', 'success')], statuses: [{ context: 'ci/circleci', state: 'error', target_url: 'https://circleci.com/x' }], ignore });
  assert.equal(ci.state, 'failed');
  assert.deepEqual(ci.failed, ['test', 'e2e', 'ci/circleci']);
  assert.equal(ci.urls['ci/circleci'], 'https://circleci.com/x');
  ci = ciStatus({ checkRuns: [run('test', 'in_progress'), run('lint', 'completed', 'success')], statuses: [{ context: 'deploy', state: 'pending' }], ignore });
  assert.equal(ci.state, 'running');
  assert.deepEqual(ci.running, ['test', 'deploy']);
  // Failing beats running.
  assert.equal(ciStatus({ checkRuns: [run('a', 'queued'), run('b', 'completed', 'cancelled')], statuses: [], ignore }).state, 'failed');
  // Only Grapim's checks: none.
  assert.equal(ciStatus({ checkRuns: [run(CLOUD_CHECK, 'in_progress'), run('Grapim provenance (app)', 'completed', 'failure', { app: { slug: 'grapim' } })], statuses: [], ignore }).state, 'none');
  // Statuses not readable (no permission), checks empty: unknown; checks there: their answer, marked partial.
  assert.equal(ciStatus({ checkRuns: [], statuses: null, ignore }).state, 'unknown');
  const partial = ciStatus({ checkRuns: [run('test', 'completed', 'success')], statuses: null, ignore });
  assert.equal(partial.state, 'passed');
  assert.equal(partial.partial, true);
  assert.equal(ciStatus({}).state, 'unknown');
  // The newest run of a name wins; stale ones are left out.
  assert.equal(ciStatus({ checkRuns: [run('test', 'completed', 'failure', { started_at: '2026-11-19T01:00:00Z' }), run('test', 'completed', 'success', { started_at: '2026-11-19T02:00:00Z' })], statuses: [] }).state, 'passed');
  assert.equal(ciStatus({ checkRuns: [run('old', 'completed', 'stale')], statuses: [] }).state, 'none');
  // The Action's test-command.
  assert.equal(ciFromCommand({ command: 'npm test', exitCode: 0 }).state, 'passed');
  const bad = ciFromCommand({ command: 'npm test', exitCode: 1 });
  assert.equal(bad.state, 'failed');
  assert.deepEqual(bad.failed, ['npm test']);
  assert.equal(ciFromCommand({ command: 'npm test', exitCode: 0, timedOut: true }).state, 'failed');
});

// ---- The card ----

const agentFacts = () =>
  decisionFacts({
    files: [
      file('src/users.js', { added: ['export function page(cursor) {', '  return db.users(cursor);', '}'], runs: [run('r1', 'Add cursor pagination to GET /users')] }),
      file('test/users.test.js', { status: 'deleted', removed: ["it('lists users', () => {})"] }),
      file('db/migrations/0042_drop_email.sql', { status: 'added', added: ['ALTER TABLE users DROP COLUMN email;'], runs: [run('r1', 'Add cursor pagination to GET /users')], sensitive: true }),
    ],
  });
const BLOCKER = { path: 'db/migrations/0042_drop_email.sql', line: 1, severity: 'blocker', category: 'destructive_migration', title: 'Drops users.email, which login still reads' };
const WARNING = { path: 'src/users.js', line: 2, severity: 'warning', category: 'correctness', title: 'The cursor is not validated' };
const NIT = { path: 'src/users.js', line: 1, severity: 'nit', category: 'other', title: 'Name the function listUsers' };

test('card, agent PR: asked from the run prompt, deleted test and migration beyond it, blocker -> Do not merge, every claim linked', () => {
  const links = new Map([[`${BLOCKER.path}\u0000${BLOCKER.line}\u0000${BLOCKER.title.toLowerCase()}`, `${PR_URL}#discussion_r1`]]);
  const ci = ciStatus({ checkRuns: [{ name: 'test (22)', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/acme/api/runs/9' }], statuses: [] });
  const card = decideCard({ facts: agentFacts(), pr: { title: 'Pagination', body: 'Adds pagination.' }, findings: [BLOCKER, WARNING, NIT], stats: { reviewedHunks: 3, hunks: 3 }, ci, links, prUrl: PR_URL });
  assert.equal(card.asked.source, 'runs', 'the run prompt wins over the PR text');
  assert.equal(card.verdict.verdict, 'block');
  const out = renderCard(card);
  assert.ok(out.startsWith(`${CARD_MARKER}\n### Do not merge · 1 blocker, 1 failing check\n`), out.slice(0, 120));
  assert.ok(out.endsWith(CARD_END));
  assert.match(out, /\*\*Asked\*\* \(run prompt\) Claude Code: “Add cursor pagination to GET &#47;users”/);
  assert.match(out, new RegExp(`\\[Blocker: Drops users&#46;email&#44; which login still reads\\]\\(${PR_URL}#discussion_r1\\)`), 'the blocker links to its inline comment');
  assert.match(out, /Failing: <a href="https:\/\/github\.com\/acme\/api\/runs\/9"><code>test &#40;22&#41;<\/code><\/a>/, 'the failing check links to its run');
  assert.match(out, /Warning: The cursor is not validated · <a href="https:\/\/github\.com\/acme\/api\/pull\/7\/files#diff-[0-9a-f]{64}R2">/, 'no comment link: the file\'s line instead');
  assert.match(out, /Deletes 1 test file: <a href="https:\/\/github\.com\/acme\/api\/pull\/7\/files#diff-[0-9a-f]{64}"><code>test&#47;users&#46;test&#46;js<\/code><\/a>/);
  assert.match(out, /Changes the database:/);
  assert.match(out, /\*\*Tests\*\* · failed:/);
  assert.doesNotMatch(out, /Name the function listUsers/, 'nits never appear in the card');
  // GitHub's diff anchor: the SHA-256 of the path.
  assert.equal(fileUrl(PR_URL, 'a.js', 3), `${PR_URL}/files#diff-${createHash('sha256').update('a.js').digest('hex')}R3`);
  assert.equal(fileUrl('javascript:alert(1)', 'a'), null, 'only a GitHub pull request URL');
});

test('card, human PR: no runs -> asked from the PR title, says so; clean review with passing CI -> Safe to merge in at most 8 lines', () => {
  const facts = decisionFacts({ files: [file('src/billing.py', { added: ['total = round(total, 2)'] }), file('tests/test_billing.py', { added: ['def test_rounding():'] })] });
  const card = decideCard({ facts, pr: { title: 'Fix rounding in invoice totals', body: 'Totals were off by a cent.' }, findings: [NIT], stats: { reviewedHunks: 2, hunks: 2 }, ci: passedCi, prUrl: PR_URL });
  assert.equal(card.asked.source, 'pr');
  assert.equal(card.verdict.verdict, 'safe');
  const out = renderCard(card);
  assert.match(out.split('\n')[1], /^### Safe to merge$/, 'the verdict is the first line');
  assert.match(out, /\*\*Asked\*\* \(PR title and description, no recorded agent run\) “Fix rounding in invoice totals”/);
  assert.match(out, /\*\*Beyond the request\*\* · nothing Grapim could see\./);
  assert.match(out, /\*\*Tests\*\* · <a href="https:\/\/github\.com\/acme\/api\/pull\/7\/checks">passed, 1 check<\/a>\./);
  assert.ok(nonBlank(out) <= 8, `${nonBlank(out)} lines:\n${out}`);
  assert.doesNotMatch(out, /listUsers/);
  // With a gate line it still fits.
  assert.ok(nonBlank(renderCard({ ...card, gate: '**Merge gate** · Approved by Grapim: low risk.' })) <= 8);
  // Nothing stated at all.
  const none = decideCard({ facts, pr: null, findings: [], stats: { reviewedHunks: 2, hunks: 2 }, ci: passedCi });
  assert.match(renderCard(none), /\*\*Asked\*\* · not stated/);
  // Runs without prompts: the PR text, and the card says the runs recorded none.
  const silent = askedOf({ runs: [{ id: 'r', kind: 'codex', intents: [] }], pr: { title: 'T' } });
  assert.equal(silent.source, 'pr');
  assert.match(renderCard({ ...decideCard({ facts, runs: [{ id: 'r', kind: 'codex' }], pr: { title: 'T' }, stats: { reviewedHunks: 1 }, ci: passedCi }) }), /its agent runs recorded no prompt/);
});

test('card: warnings and unrequested changes -> Check these first, at most 3 items, the rest counted; nothing reviewed is never safe', () => {
  const facts = agentFacts();
  const card = decideCard({ facts, findings: [WARNING, { ...WARNING, line: 3, title: 'Second' }], stats: { reviewedHunks: 3, hunks: 3 }, ci: passedCi, prUrl: PR_URL });
  assert.equal(card.verdict.verdict, 'check');
  assert.equal(card.verdict.items.length, 3);
  assert.ok(card.verdict.more >= 1);
  const out = renderCard(card);
  assert.match(out, /^### Check these first · 2 warnings, 2 changes beyond the request$/m);
  assert.match(out, /^4\. and \d+ more below$/m);
  // Asked for: tests and a migration in the prompt -> not unrequested.
  const asked = decideCard({ facts, runs: [], pr: null, findings: [], stats: { reviewedHunks: 3 }, ci: passedCi });
  assert.ok(asked.beyond.some((b) => b.kind === 'migration'));
  const said = decisionFacts({ files: [file('db/migrations/1.sql', { status: 'added', added: ['ALTER TABLE t ADD c int;'], runs: [run('r', 'Add a column c to table t with a migration')] })] });
  assert.equal(decideCard({ facts: said, stats: { reviewedHunks: 1 }, ci: passedCi }).beyond.length, 0);
  // Nothing reviewed.
  const nothing = decideCard({ facts: said, stats: { reviewedHunks: 0, hunks: 1 }, ci: passedCi });
  assert.equal(nothing.verdict.verdict, 'check');
  assert.match(renderCard(nothing), /could not review these changes/);
  // Tests still running: safe, but the heading says to wait.
  const running = decideCard({ facts: said, stats: { reviewedHunks: 1, hunks: 1 }, ci: { ...ciStatus({ checkRuns: [{ name: 't', status: 'queued' }], statuses: [] }), live: true } });
  assert.match(renderCard(running), /^### Safe to merge · once CI passes$/m);
  assert.match(renderCard(running), /This card updates when they finish\./);
});

test('card: an agent edits tests its prompt did not mention; source changed with no tests; skips', () => {
  const facts = decisionFacts({ files: [file('src/a.js', { added: ['x'], runs: [run('r', 'Speed up the users query')] }), file('test/a.test.js', { added: ["it.skip('slow', () => {})"], runs: [run('r', 'Speed up the users query')] })] });
  const card = decideCard({ facts, stats: { reviewedHunks: 2 }, ci: passedCi, prUrl: PR_URL });
  const kinds = card.beyond.map((b) => b.kind);
  assert.ok(kinds.includes('agent_tests'), kinds.join());
  assert.ok(kinds.includes('skipped_tests'));
  assert.ok(card.beyond.find((b) => b.kind === 'skipped_tests').deletion);
  const lone = decideCard({ facts: decisionFacts({ files: [file('src/a.go', { added: ['x'] })] }), stats: { reviewedHunks: 1 }, ci: passedCi });
  assert.match(renderCard(lone), /No test added or changed for 1 changed source file\./);
  // The same with tests named in the prompt: not unrequested.
  const asked = decisionFacts({ files: [file('test/a.test.js', { added: ['x'], runs: [run('r', 'Fix the flaky tests in users')] })] });
  assert.deepEqual(decideCard({ facts: asked, stats: { reviewedHunks: 1 }, ci: passedCi }).beyond, []);
});

test('card: untrusted text is inert; finding links only from Grapim\'s own comments on that line', () => {
  const facts = decisionFacts({ files: [file('src/a.js', { added: ['x'], runs: [run('r', 'Ping @octocat and close #12, see [x](javascript:alert(1)) <img src=x>')] })] });
  const out = renderCard(decideCard({ facts, findings: [{ ...WARNING, title: '@team <script>alert(1)</script>' }], stats: { reviewedHunks: 1 }, ci: passedCi, prUrl: PR_URL }));
  assert.doesNotMatch(out, /<script>|<img|\]\(javascript:/);
  assert.doesNotMatch(out, /@octocat|@team/, 'no live mentions');
  const f = { path: 'src/a.js', line: 3, endLine: 5, title: 'Bad thing', severity: 'warning' };
  const comments = [
    { path: 'src/a.js', line: 5, body: `**Warning · ${md('Bad thing', 200)}**\n\nbody`, html_url: `${PR_URL}#discussion_r2`, user: { type: 'Bot', login: 'grapim[bot]' } },
    { path: 'src/a.js', line: 5, body: '**Warning · Bad thing**', html_url: `${PR_URL}#discussion_r3`, user: { type: 'User', login: 'mallory' } },
  ];
  const links = findingLinks([f], comments, (c) => c.user.type === 'Bot');
  assert.equal(links.size, 1);
  assert.equal([...links.values()][0], `${PR_URL}#discussion_r2`);
  assert.equal(findingLinks([f], [{ ...comments[0], html_url: 'javascript:alert(1)' }]).size, 0);
});

test('card: spliced into a summary comment and redone when CI finishes', () => {
  const card = decideCard({ facts: decisionFacts({ files: [file('src/a.js', { added: ['x'] })] }), stats: { reviewedHunks: 1, hunks: 1 }, ci: { ...ciStatus({ checkRuns: [{ name: 't', status: 'in_progress' }], statuses: [] }), live: true } });
  const body = `${CLOUD_MARKER}\n${renderCard(card)}\n\n### Grapim Review\n\nrest`;
  assert.equal(spliceCard(body, renderCard(card)), body);
  const after = withCi(JSON.parse(JSON.stringify(card)), passedCi, { stats: { reviewedHunks: 1, hunks: 1 } });
  const next = spliceCard(body, renderCard(after));
  assert.match(next, /^### Safe to merge$/m);
  assert.match(next, /### Grapim Review\n\nrest$/);
  assert.equal(next.split(CARD_MARKER).length, 2, 'one card');
  assert.match(spliceCard(`${CLOUD_MARKER}\nold summary`, 'CARD'), /^<!-- grapim:review:cloud -->\nCARD\n\nold summary$/);
});

// ---- CODEOWNERS ----

test('CODEOWNERS: anchored and anywhere patterns, folders, last match wins, teams kept, emails dropped', () => {
  const rules = parseCodeowners(`# Owners
*                 @acme/everyone
*.sql             @dba alice@example.com
/docs/            @writer
apps/             @apps-team
/src/auth         @sec @acme/security   # the auth team
src/auth/vendor/  # nobody: last match clears it
[Section]
`);
  const own = (p) => [...ownersFor(rules, [p]).keys()].sort();
  assert.deepEqual(own('README.md'), ['acme/everyone']);
  assert.deepEqual(own('db/migrations/1.sql'), ['dba'], 'emails dropped');
  assert.deepEqual(own('docs/a.md'), ['writer']);
  assert.deepEqual(own('sub/docs/a.md'), ['acme/everyone'], '/docs/ is anchored');
  assert.deepEqual(own('apps/web/x.js'), ['apps-team']);
  assert.deepEqual(own('packages/apps/x.js'), ['apps-team'], 'apps/ matches anywhere');
  assert.deepEqual(own('src/auth/login.js'), ['acme/security', 'sec'], 'a folder without a slash covers what is inside');
  assert.deepEqual(own('src/auth/vendor/x.js'), [], 'a later rule with no owners clears them');
  const many = ownersFor(rules, ['docs/a.md', 'docs/b.md', 'x.sql']);
  assert.deepEqual(many.get('writer'), ['docs/a.md', 'docs/b.md']);
  assert.deepEqual(parseCodeowners(''), []);
});

// ---- The gate (pure) ----

const gateCfg = (over = {}) => ({ mode: 'auto-approve', maxLines: 400, excludeAuthors: [], reviewers: [], ...over });
const safeCard = () => decideCard({ facts: decisionFacts({ files: [file('src/a.js', { added: ['x'] })] }), stats: { reviewedHunks: 1, hunks: 1 }, ci: passedCi });

test('gate decisions: low only when every condition holds; each risk signal makes it high', () => {
  const facts = decisionFacts({ files: [file('src/a.js', { added: ['x'] })] });
  const low = gateDecision({ card: safeCard(), facts, gate: gateCfg(), author: 'dev', trusted: true });
  assert.equal(low.risk, 'low', low.reasons.join());
  // Not low: running CI, no CI, too big, excluded author, no write access, points to check.
  const not = (over) => gateDecision({ card: safeCard(), facts, gate: gateCfg(), author: 'dev', trusted: true, ...over });
  assert.equal(not({ card: { ...safeCard(), ci: ciStatus({ checkRuns: [{ name: 't', status: 'queued' }], statuses: [] }) } }).risk, 'normal');
  assert.equal(not({ card: { ...safeCard(), ci: ciStatus({ checkRuns: [], statuses: [] }) } }).risk, 'normal');
  assert.equal(not({ gate: gateCfg({ maxLines: 0 }) }).risk, 'normal');
  assert.equal(not({ gate: gateCfg({ excludeAuthors: ['DEV'] }) }).risk, 'normal');
  assert.equal(not({ trusted: false }).risk, 'normal');
  assert.equal(not({ facts: null }).risk, 'normal');
  // High: do not merge, failing CI, sensitive path, unrequested deletion.
  const blocked = decideCard({ facts, findings: [{ ...BLOCKER, path: 'src/a.js' }], stats: { reviewedHunks: 1 }, ci: passedCi });
  assert.equal(not({ card: blocked }).risk, 'high');
  const failing = decideCard({ facts, stats: { reviewedHunks: 1 }, ci: ciStatus({ checkRuns: [{ name: 't', status: 'completed', conclusion: 'failure' }], statuses: [] }) });
  assert.equal(not({ card: failing }).risk, 'high');
  assert.equal(not({ sensitive: ['db/migrations/1.sql'] }).risk, 'high');
  const deleting = decisionFacts({ files: [file('src/a.js', { added: ['x'] }), file('test/a.test.js', { status: 'deleted', removed: ['x'] })] });
  const del = decideCard({ facts: deleting, stats: { reviewedHunks: 1 }, ci: passedCi });
  assert.equal(not({ card: del, facts: deleting }).risk, 'high');
  // Sensitive paths: the review config's list and the team's approval rules, not automatic ones.
  const sf = decisionFacts({ files: [{ ...file('db/migrations/1.sql', { added: ['x'] }), sensitive: true }, file('payments/charge.js', { added: ['x'] }), file('docs/a.md', { added: ['x'] })] });
  assert.deepEqual(sensitivePaths(sf, [{ pattern: 'payments/**', action: 'review' }, { pattern: 'docs/**', action: 'auto' }]), ['db/migrations/1.sql', 'payments/charge.js']);
});

test('gate config: per repository, the repository file only makes it stricter, the form is checked', () => {
  const team = cleanGate({ mode: 'suggest', maxLines: 300, excludeAuthors: ['dependabot[bot]', 'bad login!'], reviewers: ['alice', 'acme/web'], repos: { 'Acme/API': 'auto-approve', 'bad repo': 'auto-approve', 'acme/x': 'nope' } });
  assert.deepEqual(team.excludeAuthors, ['dependabot[bot]']);
  assert.deepEqual(team.repos, { 'acme/api': 'auto-approve' });
  assert.equal(gateFor(team, 'acme/api').mode, 'auto-approve');
  assert.equal(gateFor(team, 'acme/other').mode, 'suggest');
  // The file can lower, never raise.
  assert.equal(gateFor(team, 'acme/api', { mode: 'suggest' }).mode, 'suggest');
  assert.equal(gateFor(team, 'acme/other', { mode: 'auto-approve' }).mode, 'suggest');
  assert.equal(gateFor(cleanGate({}), 'acme/api', { mode: 'auto-approve' }).mode, 'off', 'off by default, whatever the file says');
  assert.equal(gateFor(team, 'acme/api', { maxLines: 100 }).maxLines, 100);
  assert.equal(gateFor(team, 'acme/api', { maxLines: 9000 }).maxLines, 300);
  assert.deepEqual(stricterGate(gateCfg({ excludeAuthors: ['a'] }), { excludeAuthors: ['A', 'b'] }).excludeAuthors, ['a', 'b']);
  // .grapim/review.json "gate" goes through the engine's config check.
  assert.deepEqual(validateConfig({ gate: { mode: 'suggest', maxLines: 50 } }).gate, { mode: 'suggest', maxLines: 50 });
  assert.equal(validateConfig({}).gate, null);
  assert.throws(() => validateConfig({ gate: { mode: 'yolo' } }), (e) => e instanceof ConfigError && /gate\.mode/.test(e.message));
  assert.throws(() => validateConfig({ gate: { approveEverything: true } }), ConfigError);
  assert.throws(() => validateConfig({ gate: { reviewers: ['not a login!'] } }), ConfigError);
  assert.throws(() => repoGate([]), /must be an object/);
  // The settings form.
  assert.deepEqual(parseGateForm({ gateMode: 'auto-approve', gateMaxLines: '250', gateExclude: '@dependabot[bot]\nrenovate[bot], dependabot[bot]', gateReviewers: 'alice\nacme/web', gateRepos: 'acme/api suggest\n\nacme/web off' }), { mode: 'auto-approve', maxLines: 250, excludeAuthors: ['dependabot[bot]', 'renovate[bot]'], reviewers: ['alice', 'acme/web'], repos: { 'acme/api': 'suggest', 'acme/web': 'off' } });
  for (const bad of [{ gateMode: 'always' }, { gateMode: 'off', gateMaxLines: '0' }, { gateMode: 'off', gateMaxLines: '10', gateExclude: 'no spaces allowed' }, { gateMode: 'off', gateMaxLines: '10', gateRepos: 'acme/api yes' }]) {
    assert.throws(() => parseGateForm(bad), GateConfigError, JSON.stringify(bad));
  }
  // The card line says what the gate would do in suggest mode and never claims an approval.
  const low = { risk: 'low', reasons: ['x'] };
  assert.match(gateLine(gateCfg({ mode: 'suggest' }), low), /qualifies for auto-approval/);
  assert.doesNotMatch(gateLine(gateCfg({ mode: 'suggest' }), low), /Approved by Grapim/);
  assert.equal(gateLine(gateCfg({ mode: 'off' }), low), '');
});

// ---- End to end: cloud review with the gate ----

const TOKEN = 'ghs_gate_test_token';
const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function sourceRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-gate-src-'));
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'config', 'user.email', 't@example.com');
  gitIn(dir, 'config', 'user.name', 'T');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/small.js'), 'export const a = 1;\nexport const b = 2;\n');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-q', '-m', 'base');
  gitIn(dir, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'src/small.js'), 'export const a = 10;\nexport const b = 20;\n');
  gitIn(dir, 'commit', '-qam', 'change');
  const head = gitIn(dir, 'rev-parse', 'HEAD');
  gitIn(dir, 'update-ref', 'refs/pull/7/head', head);
  gitIn(dir, 'checkout', '-q', 'main');
  return { dir, head, base: gitIn(dir, 'rev-parse', 'main') };
}

function listen(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    handler(req, new URL(req.url, 'http://x'), body, send);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

// A fake GitHub with CI results, CODEOWNERS and the reviews and review requests Grapim makes.
function fakeGitHub(src, { ci = 'success', codeowners = '* @alice @dev\n', association = 'MEMBER', statusesAllowed = false } = {}) {
  const s = { checks: [], reviews: [], comments: [], requested: [], dismissed: [], nextId: 1, ci, calls: [] };
  return listen((req, url, body, send) => {
    const p = url.pathname;
    s.calls.push(`${req.method} ${p}`);
    let m;
    if (p === '/repos/acme/api/pulls/7' && req.method === 'GET') return send(200, { number: 7, state: 'open', title: 'Make the constants bigger', body: 'Bump a and b.', html_url: 'https://github.com/acme/api/pull/7', author_association: association, base: { ref: 'main', sha: src.base, repo: { private: true } }, head: { sha: src.head }, user: { login: 'dev', type: 'User' } });
    if (p === `/repos/acme/api/commits/${src.head}/check-runs`) {
      const runs = [{ name: CLOUD_CHECK, status: 'in_progress', app: { slug: 'grapim-test' } }];
      if (s.ci) runs.push({ name: 'test', status: s.ci === 'running' ? 'in_progress' : 'completed', conclusion: s.ci === 'running' ? null : s.ci, html_url: 'https://github.com/acme/api/runs/5', app: { slug: 'github-actions' } });
      return send(200, { total_count: runs.length, check_runs: runs });
    }
    if (p === `/repos/acme/api/commits/${src.head}/status`) return statusesAllowed ? send(200, { state: 'success', statuses: [] }) : send(403, { message: 'Resource not accessible by integration' });
    if (p === '/repos/acme/api/contents/.github/CODEOWNERS') return codeowners ? send(200, { size: codeowners.length, content: Buffer.from(codeowners).toString('base64') }) : send(404, {});
    if (p.startsWith('/repos/acme/api/contents/')) return send(404, {});
    if (p === '/repos/acme/api/pulls/7/comments') return send(200, []);
    if (p === '/repos/acme/api/pulls/comments') return send(200, []);
    if (p === '/repos/acme/api/pulls/7/files') return send(200, [{ filename: 'src/small.js', status: 'modified', patch: '@@ -1,2 +1,2 @@\n-export const a = 1;\n+export const a = 10;' }]);
    if (p === '/repos/acme/api/pulls/7/requested_reviewers' && req.method === 'POST') {
      s.requested.push(body);
      return send(201, {});
    }
    if ((m = /^\/repos\/acme\/api\/pulls\/7\/reviews\/(\d+)\/dismissals$/.exec(p))) {
      s.dismissed.push(Number(m[1]));
      const r = s.reviews.find((x) => x.id === Number(m[1]));
      if (r) r.state = 'DISMISSED';
      return send(200, {});
    }
    if (p === '/repos/acme/api/pulls/7/reviews') {
      if (req.method === 'GET') return send(200, s.reviews);
      const r = { id: s.nextId++, ...body, state: body.event === 'APPROVE' ? 'APPROVED' : 'COMMENTED', user: { login: 'grapim-test[bot]', type: 'Bot' } };
      s.reviews.push(r);
      return send(200, r);
    }
    if (p === '/repos/acme/api/check-runs' && req.method === 'POST') {
      const c = { id: s.nextId++, ...body };
      s.checks.push(c);
      return send(201, c);
    }
    if ((m = /^\/repos\/acme\/api\/check-runs\/(\d+)$/.exec(p))) {
      const c = s.checks.find((x) => x.id === Number(m[1]));
      Object.assign(c, body, body.output ? { output: body.output } : {});
      return send(200, {});
    }
    if (p === '/repos/acme/api/issues/7/comments') {
      if (req.method === 'GET') return send(200, s.comments);
      const c = { id: s.nextId++, body: body.body, user: { login: 'grapim-test[bot]', type: 'Bot' } };
      s.comments.push(c);
      return send(201, c);
    }
    if ((m = /^\/repos\/acme\/api\/issues\/comments\/(\d+)$/.exec(p))) {
      s.comments.find((c) => c.id === Number(m[1])).body = body.body;
      return send(200, {});
    }
    send(404, { message: `fake: no route ${req.method} ${p}` });
  }).then((srv) => ({ ...srv, s }));
}

function fakeAnthropic(findings) {
  return listen((req, url, body, send) => {
    // The second look keeps everything it is shown.
    const verify = JSON.stringify(body).includes('second look') || JSON.stringify(body).includes('"keep"');
    const text = verify ? JSON.stringify({ keep: true, verdicts: [] }) : JSON.stringify({ findings });
    send(200, { id: 'msg', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } });
  });
}

async function setup(t, { gate = { mode: 'auto-approve' }, governance = true, findings = [], gh: ghOpts = {}, rules = [] } = {}) {
  const src = sourceRepo();
  const gh = await fakeGitHub(src, ghOpts);
  const model = await fakeAnthropic(findings);
  t.after(async () => {
    await gh.close();
    await model.close();
  });
  const db = new DatabaseSync(':memory:');
  const logs = [];
  const team = { id: 'team1', plan: 'governance', seats: 5 };
  const hub = { db, now: () => Date.now(), log: (l) => logs.push(l), teams: { get: (id) => ({ ...team, id }), seatsUsed: () => 1 } };
  const mergeGate = createMergeGate({ db, now: hub.now, governance: () => governance, rules: { list: () => rules } });
  if (gate) mergeGate.save('team1', gate, 'owner');
  const cloud = createCloudReview(hub, {
    auth: { installationToken: async () => TOKEN },
    installs: { forTeam: () => [{ id: 1 }] },
    apiBase: gh.base,
    fetch: globalThis.fetch,
    slug: 'grapim-test',
    env: { GRAPIM_REVIEW_ANTHROPIC_KEY: 'sk-test-gate', ANTHROPIC_BASE_URL: model.base },
    gitUrl: () => src.dir,
    provenanceWaitMs: 5,
    gate: mergeGate,
  });
  t.after(() => cloud.close());
  cloud.setEnabled('team1', true, 'u1');
  const job = { installationId: 1, repoId: 99, teamId: 'team1', owner: 'acme', name: 'api', number: 7, headSha: src.head };
  return { cloud, gh, db, job, mergeGate, logs, src };
}

const approvals = (gh) => gh.s.reviews.filter((r) => r.event === 'APPROVE');
const cloudCheck = (gh) => gh.s.checks.find((c) => c.name === CLOUD_CHECK);

test('cloud review: the card tops the summary comment; auto-approve approves a low-risk pull request once, with a reason, and logs it', async (t) => {
  const { cloud, gh, db, job } = await setup(t);
  const r = await cloud.review(job, AbortSignal.timeout(60_000));
  assert.equal(r.done, true, JSON.stringify(r));
  const body = gh.s.comments[0].body;
  assert.ok(body.startsWith(`${CLOUD_MARKER}\n${CARD_MARKER}\n### Safe to merge\n`), body.slice(0, 200));
  assert.match(body, /\*\*Asked\*\* \(PR title and description, no recorded agent run\) “Make the constants bigger”/);
  assert.match(body, /\*\*Tests\*\* · <a href="https:\/\/github\.com\/acme\/api\/pull\/7\/checks">passed, 1 check<\/a>/, 'Grapim\'s own in-progress check does not count');
  assert.match(body, /\*\*Merge gate\*\* · Approved by Grapim: low risk\./);
  assert.ok(body.indexOf(CARD_END) < body.indexOf('Grapim Review</a>'), 'the card comes first');
  // The check stays short (one line); the card is in the comment.
  assert.match(cloudCheck(gh).output.summary, /^Reviewed \d+ files? at [0-9a-f]{7}: no findings\. /);
  assert.equal(approvals(gh).length, 1);
  assert.equal(approvals(gh)[0].commit_id, job.headSha);
  assert.match(approvals(gh)[0].body, /^Grapim merge gate: low risk \(safe to merge, CI passed, no sensitive path, 4 changed lines\)\./);
  assert.equal(cloudCheck(gh).conclusion, 'success');
  const log = db.prepare('SELECT * FROM gh_gate_log').all();
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'approved');
  assert.equal(log[0].risk, 'low');
  // Again on the same head: no second approval.
  await cloud.review(job, AbortSignal.timeout(60_000));
  assert.equal(approvals(gh).length, 1);
  assert.ok(gh.s.calls.includes(`GET /repos/acme/api/commits/${job.headSha}/status`), 'statuses are asked for, and a 403 is not fatal');
});

test('auto-approve never happens when the gate is off, in suggest mode, without Governance, or on any risk signal', async (t) => {
  const cases = [
    ['off', { gate: { mode: 'off' } }, null],
    ['no setting', { gate: null }, null],
    ['suggest', { gate: { mode: 'suggest' } }, 'would_approve'],
    ['no Governance', { governance: false }, null],
    ['CI failing', { gh: { ci: 'failure' } }, 'routed'],
    ['CI running', { gh: { ci: 'running' } }, null],
    ['no CI', { gh: { ci: null } }, null],
    ['a blocker', { findings: [{ path: 'src/small.js', line: 1, severity: 'blocker', confidence: 'high', category: 'correctness', title: 'a is now 10', body: 'Callers expect 1.' }] }, 'routed'],
    ['a warning', { findings: [{ path: 'src/small.js', line: 1, severity: 'warning', confidence: 'high', category: 'correctness', title: 'a is now 10', body: 'Check callers.' }] }, null],
    ['a sensitive path rule', { rules: [{ pattern: 'src/**', action: 'review', approvers: [] }] }, 'routed'],
    ['too big', { gate: { mode: 'auto-approve', maxLines: 2 } }, null],
    ['excluded author', { gate: { mode: 'auto-approve', excludeAuthors: ['dev'] } }, null],
    ['no write access', { gh: { association: 'CONTRIBUTOR' } }, null],
  ];
  for (const [name, opts, logged] of cases) {
    const { cloud, gh, db, job } = await setup(t, opts);
    const r = await cloud.review(job, AbortSignal.timeout(60_000));
    assert.equal(r.done, true, `${name}: ${JSON.stringify(r)}`);
    assert.equal(approvals(gh).length, 0, `${name}: no approval`);
    const actions = db.prepare('SELECT action FROM gh_gate_log').all().map((x) => x.action);
    assert.deepEqual(actions, logged ? [logged] : [], name);
    if (name === 'suggest') assert.match(gh.s.comments[0].body, /\*\*Merge gate\*\* \(suggest only\) · This pull request qualifies for auto-approval/);
    if (name === 'off' || name === 'no Governance') assert.doesNotMatch(gh.s.comments[0].body, /Merge gate/);
  }
});

test('high risk: review requested from CODEOWNERS (never the author), the check fails with the reason, earlier approvals dismissed; suggest only says so', async (t) => {
  const { cloud, gh, db, job } = await setup(t, { gh: { ci: 'failure' } });
  gh.s.reviews.push({ id: 900, event: 'APPROVE', state: 'APPROVED', commit_id: 'e'.repeat(40), user: { login: 'grapim-test[bot]', type: 'Bot' } });
  await cloud.review(job, AbortSignal.timeout(60_000));
  assert.deepEqual(gh.s.requested, [{ reviewers: ['alice'], team_reviewers: [] }], 'the author (dev) is left out');
  assert.equal(cloudCheck(gh).conclusion, 'failure');
  assert.equal(cloudCheck(gh).output.title, 'Needs a person: 1 CI check failed');
  assert.deepEqual(gh.s.dismissed, [900]);
  assert.match(gh.s.comments[0].body, /^### Do not merge · 1 failing check$/m);
  assert.match(gh.s.comments[0].body, /\*\*Merge gate\*\* · Needs a person: 1 CI check failed\. Review requested from <code>alice<\/code> \(CODEOWNERS\)\./);
  const row = db.prepare("SELECT * FROM gh_gate_log WHERE action = 'routed'").get();
  assert.deepEqual(JSON.parse(row.reviewers), ['alice']);
  assert.equal(row.detail, 'CODEOWNERS');

  // No CODEOWNERS: the team's reviewer list (teams of the same org only).
  const two = await setup(t, { gh: { ci: 'failure', codeowners: null }, gate: { mode: 'auto-approve', reviewers: ['carol', 'acme/web', 'other/team'] } });
  await two.cloud.review(two.job, AbortSignal.timeout(60_000));
  assert.deepEqual(two.gh.s.requested, [{ reviewers: ['carol'], team_reviewers: ['web'] }]);

  // Suggest: nothing requested, the check keeps its own conclusion.
  const three = await setup(t, { gh: { ci: 'failure' }, gate: { mode: 'suggest' } });
  await three.cloud.review(three.job, AbortSignal.timeout(60_000));
  assert.deepEqual(three.gh.s.requested, []);
  assert.equal(cloudCheck(three.gh).conclusion, 'success');
  assert.match(three.gh.s.comments[0].body, /\(suggest only\) · High risk: 1 CI check failed\. With auto-approve on, Grapim would ask <code>alice<\/code> to review/);
  assert.equal(three.db.prepare('SELECT action FROM gh_gate_log').get().action, 'would_route');
});

test('CI finishing after the review redoes the card and the gate: running -> passed -> approved', async (t) => {
  const { cloud, gh, db, job } = await setup(t, { gh: { ci: 'running' } });
  await cloud.review(job, AbortSignal.timeout(60_000));
  assert.match(gh.s.comments[0].body, /^### Safe to merge · once CI passes$/m);
  assert.match(gh.s.comments[0].body, /still running: .*This card updates when they finish\./);
  assert.equal(approvals(gh).length, 0);
  // Our own check finishing is not CI.
  assert.equal(cloud.onCiEvent({ installationId: 1, headSha: job.headSha, appSlug: 'grapim-test' }), false);
  assert.equal(cloud.onCiEvent({ installationId: 1, headSha: 'f'.repeat(40) }), false, 'a commit Grapim has no card for');
  gh.s.ci = 'success';
  const r = await cloud.ciRefresh({ installationId: 1, repoGhId: 99, number: 7, headSha: job.headSha }, AbortSignal.timeout(30_000));
  assert.equal(r.updated, true, JSON.stringify(r));
  assert.equal(gh.s.comments.length, 1, 'the same comment, edited');
  assert.match(gh.s.comments[0].body, /^### Safe to merge$/m);
  assert.match(gh.s.comments[0].body, /Approved by Grapim: low risk/);
  assert.ok(gh.s.comments[0].body.includes('Grapim Review</a>'), 'the rest of the summary stays');
  assert.match(gh.s.comments[0].body, /<sub>Reviewed by <a href="https:\/\/github\.com\/grapim\/grapim">Grapim<\/a> at commit/, 'and so does the footer');
  assert.doesNotMatch(cloudCheck(gh).output.summary, /grapim:card|Asked/, 'the check stays short after a refresh');
  assert.equal(approvals(gh).length, 1);
  // Nothing changed: nothing done.
  assert.equal((await cloud.ciRefresh({ installationId: 1, repoGhId: 99, number: 7, headSha: job.headSha }, AbortSignal.timeout(30_000))).skipped, 'unchanged');
  // Then CI fails on a re-run: the card says do not merge and the check fails.
  gh.s.ci = 'failure';
  await cloud.ciRefresh({ installationId: 1, repoGhId: 99, number: 7, headSha: job.headSha }, AbortSignal.timeout(30_000));
  assert.match(gh.s.comments[0].body, /^### Do not merge · 1 failing check$/m);
  assert.equal(cloudCheck(gh).conclusion, 'failure');
  assert.deepEqual(db.prepare('SELECT action FROM gh_gate_log ORDER BY id').all().map((x) => x.action), ['approved', 'routed']);
});

test('the gate settings store: per team, cleaned, and the audit log is per head and action', () => {
  const db = new DatabaseSync(':memory:');
  let gov = false;
  const g = createMergeGate({ db, now: () => 1000, governance: () => gov });
  g.save('t1', { mode: 'auto-approve', repos: { 'acme/api': 'suggest' }, junk: 1 }, 'u');
  assert.equal(g.settings('t1').mode, 'auto-approve');
  assert.equal(g.settings('t2').mode, 'off', 'off by default');
  assert.equal(g.forRepo({ id: 't1' }, 'acme', 'api'), null, 'nothing without Governance');
  gov = true;
  assert.equal(g.forRepo({ id: 't1' }, 'acme', 'api').mode, 'suggest');
  assert.equal(g.forRepo({ id: 't1' }, 'acme', 'web').mode, 'auto-approve');
  assert.equal(g.forRepo({ id: 't2' }, 'acme', 'web'), null);
  const e = { teamId: 't1', owner: 'acme', name: 'api', number: 1, headSha: 'a'.repeat(40), mode: 'auto-approve', risk: 'low', action: 'approved', reasons: ['x'] };
  assert.equal(g.record(e), true);
  assert.equal(g.record(e), false, 'once per head and action');
  assert.equal(g.done('t1', 'acme', 'api', 1, 'a'.repeat(40), 'approved'), true);
  assert.equal(g.recent('t1').length, 1);
  assert.deepEqual(g.recent('t1')[0].reasons, ['x']);
  assert.equal(g.recent('t2').length, 0, 'scoped by team');
});

// ---- The Action ----

test('Action test-command: runs before the review without the model key or GitHub token, and its result is on the card', async (t) => {
  const env = { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-secret-model-key', 'INPUT_GITHUB-TOKEN': 'ghs_tok', GITHUB_TOKEN: 'ghs_tok', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc', MY_SERVICE_API_KEY: 'x', HOME: '/home/runner', CI: 'true' };
  const clean = testEnv(env);
  assert.deepEqual(Object.keys(clean).sort(), ['CI', 'HOME', 'PATH']);
  // A real command: it cannot see the key.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-tc-'));
  const logs = [];
  const r = runTestCommand({ command: `node -e "process.exit(process.env.ANTHROPIC_API_KEY ? 3 : 0)"`, cwd: dir, env, log: (l) => logs.push(l) });
  assert.equal(r.exitCode, 0, logs.join('\n'));
  const failing = runTestCommand({ command: 'node -e "console.log(\'sk-secret-model-key\'); process.exit(2)"', cwd: dir, env: { ...env }, log: (l) => logs.push(l) });
  assert.equal(failing.exitCode, 2);
  assert.ok(!logs.join('\n').includes('sk-secret-model-key'), 'redacted from the log');
});

test('Action: the card tops the summary comment, with the test-command result and links to inline comments', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-action-card-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'src/pay.js'), 'export const refund = () => true;\n');
  fs.writeFileSync(path.join(dir, 'test/pay.test.js'), "it('refunds', () => {});\n");
  g('add', '.');
  g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'src/pay.js'), 'export const refund = () => false;\n');
  fs.rmSync(path.join(dir, 'test/pay.test.js'));
  g('add', '-A');
  g('commit', '-qm', 'head');
  const head = g('rev-parse', 'HEAD');
  const event = path.join(dir, '..', `event-${path.basename(dir)}.json`);
  fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 3, title: 'Rename the refund flag', body: '', html_url: 'https://github.com/acme/pay/pull/3', base: { sha: base, repo: { full_name: 'acme/pay' } }, head: { sha: head, repo: { full_name: 'acme/pay' } } }, repository: { full_name: 'acme/pay' } }));
  const finding = { path: 'src/pay.js', line: 1, side: 'RIGHT', severity: 'blocker', category: 'correctness', title: 'Refunds are now always refused', body: 'b' };
  const posted = { reviews: [], comments: [] };
  const fetch = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/repos/acme/pay/pulls/3/reviews' && method === 'POST') {
      const b = JSON.parse(init.body);
      posted.reviews.push(b);
      return json(200, { id: 77 });
    }
    if (u.pathname === '/repos/acme/pay/pulls/3/reviews') return json(200, []);
    if (u.pathname === '/repos/acme/pay/pulls/3/comments') return json(200, posted.reviews.flatMap((r) => r.comments.map((c, i) => ({ id: i, path: c.path, line: c.line, body: c.body, html_url: `https://github.com/acme/pay/pull/3#discussion_r${i + 50}`, user: { type: 'Bot', login: 'github-actions[bot]' } }))));
    if (u.pathname === '/repos/acme/pay/issues/3/comments' && method === 'GET') return json(200, posted.comments);
    if (u.pathname === '/repos/acme/pay/issues/3/comments') {
      posted.comments.push({ id: 1, body: JSON.parse(init.body).body, user: { type: 'Bot', login: 'github-actions[bot]' } });
      return json(201, { id: 1 });
    }
    return json(404, {});
  };
  const lib = {
    decision: decisionLib,
    md,
    ConfigError,
    closingIssues: () => [],
    loadConfig: () => validateConfig({}),
    validateConfig,
    providerFromEnv: () => ({ name: 'anthropic' }),
    prepareHistory: () => {},
    git: (cwd, args) => {
      try {
        return execFileSync('git', args, { cwd, encoding: 'utf8' });
      } catch {
        return null;
      }
    },
    runTests: ({ command }) => ({ exitCode: command === 'npm test' ? 1 : 0, timedOut: false, ms: 10 }),
    reviewChanges: async () => ({ findings: [finding], summary: '### Grapim Review\n\n**1 blocker** in 1 file.\n\n**Fix before merging:** Refunds are now always refused.', stats: { reviewedHunks: 1, hunks: 1 } }),
  };
  const out = await runReview({ env: { GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'acme/pay', GITHUB_EVENT_NAME: 'pull_request', 'INPUT_GITHUB-TOKEN': 'ghs_x', 'INPUT_TEST-COMMAND': 'npm test', GITHUB_RUN_ID: '42' }, cwd: dir, fetch, lib, log: () => {} });
  assert.equal(out.status, 'posted', JSON.stringify(out));
  const body = posted.comments[0].body;
  assert.ok(body.startsWith('<!-- grapim:review -->\n<!-- grapim:card -->\n### Do not merge · 1 blocker, 1 failing check'), body.slice(0, 160));
  assert.match(body, /\[Blocker: Refunds are now always refused\]\(https:\/\/github\.com\/acme\/pay\/pull\/3#discussion_r50\)/);
  assert.match(body, /\*\*Tests\*\* · <a href="https:\/\/github\.com\/acme\/pay\/actions\/runs\/42">failed<\/a>: <code>npm test<\/code> exited 1 on your runner\./);
  assert.match(body, /Deletes 1 test file/);
  assert.match(body, /\*\*Asked\*\* \(PR title and description, no recorded agent run\) “Rename the refund flag”/);
  // The card's heading is the verdict: the engine's "Fix before merging" line goes, the counts stay.
  assert.doesNotMatch(body, /Fix before merging/);
  assert.match(body, /\n### Grapim Review\n\n\*\*1 blocker\*\* in 1 file\.\n/);
  // Without test-command: the card says how to add it.
  posted.comments.length = 0;
  posted.reviews.length = 0;
  await runReview({ env: { GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'acme/pay', GITHUB_EVENT_NAME: 'pull_request', 'INPUT_GITHUB-TOKEN': 'ghs_x' }, cwd: dir, fetch, lib, log: () => {} });
  assert.match(posted.comments[0].body, /\*\*Tests\*\* · not run\. Set the `test-command` input/);
});
