// The Grapim Review Action (action/review/index.mjs) and `grapim review --ai`
// (src/review-ai.js) with a fake engine and a fake GitHub REST API. The engine
// itself (src/airev/) has its own tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INLINE_MARKER, MARKER, diffLines, redact, runReview } from '../action/review/index.mjs';
import { bundledReview, checkReview, importsOf } from '../action/bundle.mjs';
import { md } from '../src/provenance/render.js';
import { parseReviewAiArgs, reviewAiCommand } from '../src/review-ai.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

class ConfigError extends Error {
  constructor(m) {
    super(m);
    this.name = 'ConfigError';
  }
}

const FINDINGS = [
  { path: 'src/pay.js', line: 10, endLine: 12, side: 'RIGHT', severity: 'blocker', category: 'scope', title: 'Deletes the refund check', body: 'The run was asked to rename a field.\n\nIt also removed the check. See @octocat [x](https://evil.example)', run: { id: 'claude-code:1a2b', kind: 'claude-code', intent: 'Rename amount to total @team <b>now</b>' } },
  { path: 'src/util.js', line: 3, side: 'RIGHT', severity: 'nit', category: 'style', title: 'Unused import', body: 'Remove it.' },
];

// The engine's interface (docs/design-ai-review.md), recording its calls.
function fakeLib({ findings = FINDINGS, loadConfig, providerFromEnv, config = {} } = {}) {
  const calls = { reviewChanges: [], loadConfig: [], providerFromEnv: [], prepareHistory: 0 };
  return {
    calls,
    ConfigError,
    md,
    loadConfig: loadConfig ?? ((cwd) => (calls.loadConfig.push({ cwd }), { model: 'claude-opus-5-5', ...config })),
    validateConfig: (raw) => {
      if (raw.bogus) throw new ConfigError('unknown setting "bogus"');
      return { model: 'claude-opus-5-5', ...config, ...raw };
    },
    providerFromEnv: providerFromEnv ?? ((env, cfg) => (calls.providerFromEnv.push({ name: env.GRAPIM_REVIEW_PROVIDER ?? null, cfg }), { name: 'anthropic' })),
    prepareHistory: () => calls.prepareHistory++,
    git: (cwd, args) => {
      if (args[0] === 'merge-base') return `${'c'.repeat(40)}\n`;
      // cat-file blob <base>:<path>: the test checkout stands in for the base commit.
      if (args[0] === 'cat-file') {
        const file = path.join(cwd, args[2].slice(args[2].indexOf(':') + 1));
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      }
      return null;
    },
    reviewChanges: async (opts) => {
      calls.reviewChanges.push(opts);
      return { findings, summary: '**Grapim Review**: 1 blocker, 1 nit. Your code was sent only to anthropic; Grapim received nothing.', stats: { files: 2, hunks: 4, reviewedHunks: 3, aiHunks: 2, skippedHunks: 1, model: 'claude-opus-5-5', provider: 'anthropic' }, skipped: [] };
    },
  };
}

// A fake api.github.com as a fetch function.
function fakeGitHub({ reject422 = 0, files = [], comments = [], reviews = [], deny = false } = {}) {
  const s = { requests: [], reviews: [...reviews], comments: [...comments], posts: [] };
  let refusals = reject422;
  const fetch = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    s.requests.push(`${init.method} ${u.pathname}`);
    const send = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (init.headers.Authorization !== 'Bearer test-token') return send(401, {});
    if (u.pathname === '/repos/acme/api/pulls/7/reviews') {
      if (init.method === 'GET') return send(200, s.reviews);
      s.posts.push(body);
      if (deny) return send(403, { message: 'Resource not accessible by integration' });
      if (refusals-- > 0) return send(422, { message: 'Unprocessable Entity', errors: ['Line could not be resolved'] });
      const r = { id: 100 + s.reviews.length, body: body.body, commit_id: body.commit_id, user: { login: 'github-actions[bot]', type: 'Bot' } };
      s.reviews.push(r);
      return send(200, r);
    }
    if (u.pathname === '/repos/acme/api/pulls/7/files') return send(200, files);
    if (u.pathname === '/repos/acme/api/issues/7/comments') {
      if (init.method === 'GET') return send(200, s.comments);
      if (deny) return send(403, {});
      const c = { id: s.comments.length + 1, body: body.body, user: { login: 'github-actions[bot]', type: 'Bot' } };
      s.comments.push(c);
      return send(201, c);
    }
    const m = /^\/repos\/acme\/api\/issues\/comments\/(\d+)$/.exec(u.pathname);
    if (m && init.method === 'PATCH') {
      const c = s.comments.find((x) => x.id === Number(m[1]));
      c.body = body.body;
      return send(200, c);
    }
    return send(404, {});
  };
  return { s, fetch };
}

function envFor({ fork = false, extra = {} } = {}) {
  const dir = tmp('grapim-review-env-');
  const event = path.join(dir, 'event.json');
  fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 7, base: { sha: BASE, repo: { full_name: 'acme/api' } }, head: { sha: HEAD, repo: { full_name: fork ? 'someone/api' : 'acme/api' } } }, repository: { full_name: 'acme/api' } }));
  return {
    GITHUB_EVENT_PATH: event,
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REPOSITORY: 'acme/api',
    GITHUB_API_URL: 'https://api.example',
    GITHUB_WORKSPACE: dir,
    'INPUT_GITHUB-TOKEN': 'test-token',
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
    GITHUB_OUTPUT: path.join(dir, 'output.txt'),
    ...extra,
  };
}

test('review action: one review with inline comments, then one summary comment', async () => {
  const lib = fakeLib();
  const gh = fakeGitHub();
  const env = envFor();
  const logs = [];
  const out = await runReview({ env, fetch: gh.fetch, lib, log: (l) => logs.push(l) });
  assert.equal(out.status, 'posted', logs.join('\n'));
  // The engine got the merge base, the head and the provider.
  const call = lib.calls.reviewChanges[0];
  assert.equal(call.base, 'c'.repeat(40));
  assert.equal(call.head, HEAD);
  assert.deepEqual(call.provider, { name: 'anthropic' });
  assert.equal(lib.calls.prepareHistory, 1);
  assert.equal(lib.calls.loadConfig.length, 1, 'the default config path is read by the engine');

  assert.equal(gh.s.posts.length, 1);
  const review = gh.s.posts[0];
  assert.equal(review.event, 'COMMENT');
  assert.equal(review.commit_id, HEAD);
  assert.ok(review.body.startsWith(INLINE_MARKER));
  const [c1, c2] = review.comments;
  assert.deepEqual({ path: c1.path, start_line: c1.start_line, line: c1.line, side: c1.side, start_side: c1.start_side }, { path: 'src/pay.js', start_line: 10, line: 12, side: 'RIGHT', start_side: 'RIGHT' });
  assert.deepEqual({ path: c2.path, line: c2.line, side: c2.side }, { path: 'src/util.js', line: 3, side: 'RIGHT' });
  assert.equal(c2.start_line, undefined);
  assert.ok(c1.body.startsWith('**Blocker · Deletes the refund check**\n\n'), c1.body);
  assert.match(c1.body, /\n\n_Written by Claude Code run: “Rename amount to total .*”_$/);
  // Untrusted text is inert: no mentions, links or HTML.
  assert.doesNotMatch(c1.body, /@octocat|@team|\]\(|https:\/\/|<b>/);
  assert.match(c1.body, /The run was asked to rename a field&#46;\n\nIt also removed the check/);
  assert.ok(c2.body.startsWith('**Nit · Unused import**'));
  assert.doesNotMatch(c2.body, /Written by/);

  assert.equal(gh.s.comments.length, 1);
  assert.ok(gh.s.comments[0].body.startsWith(`${MARKER}\n**Grapim Review**: 1 blocker`));
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /^blockers=1\nwarnings=0\nnits=1\nreviewed-hunks=3\n$/);
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /Deletes the refund check/);
  // fail-on defaults to blocker: the job fails, after posting.
  assert.equal(out.exitCode, 1);
  assert.ok(logs.some((l) => l.startsWith('::error::Grapim Review found 1 blocker')));
});

test('review action: a 422 retries once without the comments off the diff and moves them to the summary', async () => {
  const lib = fakeLib();
  // pay.js lines 10-12 are in a hunk; util.js line 3 is not (its hunk is 20-21).
  const files = [
    { filename: 'src/pay.js', patch: '@@ -8,4 +8,6 @@ fn\n a\n b\n+c\n+d\n+e\n f\n-g\n h' },
    { filename: 'src/util.js', patch: '@@ -20,1 +20,2 @@\n x\n+y' },
  ];
  const gh = fakeGitHub({ reject422: 1, files });
  const out = await runReview({ env: envFor(), fetch: gh.fetch, lib, log: () => {} });
  assert.equal(out.status, 'posted');
  assert.equal(gh.s.posts.length, 2);
  assert.deepEqual(gh.s.posts[1].comments.map((c) => c.path), ['src/pay.js']);
  assert.match(gh.s.posts[1].body, /1 more finding in the summary comment/);
  assert.equal(out.moved, 1);
  const summary = gh.s.comments[0].body;
  assert.match(summary, /### Not on a changed line/);
  assert.match(summary, /\*\*Nit · Unused import\*\*/);
  assert.match(summary, /src&#47;util&#46;js&#58;​3/);

  // Refused twice: no review at all, everything in the summary.
  const gh2 = fakeGitHub({ reject422: 2, files });
  const out2 = await runReview({ env: envFor(), fetch: gh2.fetch, lib: fakeLib(), log: () => {} });
  assert.equal(gh2.s.posts.length, 2);
  assert.equal(gh2.s.reviews.length, 0);
  assert.equal(out2.moved, 2);
  assert.match(gh2.s.comments[0].body, /Blocker · Deletes the refund check/);
});

test('review action: diffLines counts context and added lines, per hunk', () => {
  const lines = diffLines([{ filename: 'a.js', patch: '@@ -1,2 +1,3 @@\n x\n+y\n-z\n w\n@@ -10 +11,2 @@\n+p\n q\n\\ No newline at end of file' }, { filename: 'bin.png' }]);
  assert.deepEqual(lines['a.js'].map((h) => [...h]), [[1, 2, 3], [11, 12]]);
  assert.equal(lines['bin.png'], undefined);
});

test('review action: the summary comment is found by marker and bot, and updated in place', async () => {
  const human = { id: 1, body: `${MARKER}\nquoted by a person`, user: { login: 'alice', type: 'User' } };
  const ours = { id: 2, body: `${MARKER}\nold summary`, user: { login: 'github-actions[bot]', type: 'Bot' } };
  const gh = fakeGitHub({ comments: [human, ours] });
  const out = await runReview({ env: envFor(), fetch: gh.fetch, lib: fakeLib(), log: () => {} });
  assert.equal(out.status, 'updated');
  assert.ok(gh.s.requests.includes('PATCH /repos/acme/api/issues/comments/2'));
  assert.equal(gh.s.comments.length, 2);
  assert.equal(human.body, `${MARKER}\nquoted by a person`);
  // A re-run on the same commit: no second review, the summary is unchanged.
  const again = await runReview({ env: envFor(), fetch: gh.fetch, lib: fakeLib(), log: () => {} });
  assert.equal(again.status, 'unchanged');
  assert.equal(gh.s.posts.length, 1);
  assert.equal(gh.s.requests.filter((r) => r.startsWith('PATCH')).length, 1);
});

test('review action: a forked PR goes to the job summary; without credentials it is skipped and passes', async () => {
  const gh = fakeGitHub();
  const env = envFor({ fork: true });
  const logs = [];
  const out = await runReview({ env, fetch: gh.fetch, lib: fakeLib(), log: (l) => logs.push(l) });
  assert.equal(out.status, 'log');
  assert.deepEqual(gh.s.requests, [], 'GitHub is not called from a fork');
  assert.match(logs.join('\n'), /::stop-commands::[0-9a-f]{32}/);
  assert.match(logs.join('\n'), /from a fork/);
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /### Findings[\s\S]*Deletes the refund check/);

  const noCreds = fakeLib({ providerFromEnv: () => { throw new ConfigError('No model credentials: set ANTHROPIC_API_KEY.'); } });
  const skipped = await runReview({ env: envFor({ fork: true }), fetch: gh.fetch, lib: noCreds, log: () => {} });
  assert.deepEqual([skipped.status, skipped.exitCode], ['skipped', 0]);
  assert.equal(noCreds.calls.reviewChanges.length, 0);

  // Same repo but the token cannot write: logged, not thrown.
  const denied = await runReview({ env: envFor(), fetch: fakeGitHub({ deny: true }).fetch, lib: fakeLib(), log: () => {} });
  assert.equal(denied.status, 'log');
});

test('review action: fail-on from the input, then the config; blocker by default', async () => {
  const run = async (env, lib = fakeLib()) => (await runReview({ env, fetch: fakeGitHub().fetch, lib, log: () => {} })).exitCode;
  assert.equal(await run(envFor()), 1);
  assert.equal(await run(envFor({ extra: { 'INPUT_FAIL-ON': 'never' } })), 0);
  assert.equal(await run(envFor(), fakeLib({ config: { failOn: 'never' } })), 0);
  assert.equal(await run(envFor({ extra: { 'INPUT_FAIL-ON': 'blocker' } }), fakeLib({ config: { failOn: 'never' } })), 1);
  assert.equal(await run(envFor(), fakeLib({ findings: [FINDINGS[1]] })), 0, 'a nit never fails the job');
  const bad = await runReview({ env: envFor({ extra: { 'INPUT_FAIL-ON': 'warning' } }), fetch: fakeGitHub().fetch, lib: fakeLib(), log: () => {} });
  assert.deepEqual([bad.status, bad.exitCode], ['config-error', 1]);
});

test('review action: inputs reach the engine (provider, model, config-path)', async () => {
  const lib = fakeLib();
  const env = envFor({ extra: { INPUT_PROVIDER: 'bedrock', INPUT_MODEL: 'claude-sonnet-5', 'INPUT_CONFIG-PATH': 'ci/review.json' } });
  fs.mkdirSync(path.join(env.GITHUB_WORKSPACE, 'ci'));
  fs.writeFileSync(path.join(env.GITHUB_WORKSPACE, 'ci', 'review.json'), '{"review": "all", "failOn": "never"}');
  const out = await runReview({ env, fetch: fakeGitHub().fetch, lib, log: () => {} });
  assert.equal(lib.calls.providerFromEnv[0].name, 'bedrock');
  assert.equal(lib.calls.reviewChanges[0].config.model, 'claude-sonnet-5');
  assert.equal(lib.calls.reviewChanges[0].config.review, 'all');
  assert.equal(lib.calls.loadConfig.length, 0);
  assert.equal(out.exitCode, 0, 'failOn from ci/review.json');
  // A named config file must exist and be valid.
  const missing = await runReview({ env: envFor({ extra: { 'INPUT_CONFIG-PATH': 'ci/none.json' } }), fetch: fakeGitHub().fetch, lib: fakeLib(), log: () => {} });
  assert.equal(missing.status, 'config-error');
  fs.writeFileSync(path.join(env.GITHUB_WORKSPACE, 'ci', 'review.json'), '{"bogus": 1}');
  assert.equal((await runReview({ env, fetch: fakeGitHub().fetch, lib: fakeLib(), log: () => {} })).status, 'config-error');
  const escape = await runReview({ env: envFor({ extra: { 'INPUT_CONFIG-PATH': '../../etc/x.json' } }), fetch: fakeGitHub().fetch, lib: fakeLib(), log: () => {} });
  assert.equal(escape.status, 'config-error');
});

test('review action: a ConfigError posts nothing, prints the plain message and exits 1', async () => {
  for (const lib of [
    fakeLib({ loadConfig: () => { throw new ConfigError('.grapim/review.json: unknown key "maxComment" (did you mean maxComments?)'); } }),
    fakeLib({ providerFromEnv: () => { throw new ConfigError('No model credentials: set ANTHROPIC_API_KEY, or configure Bedrock, Vertex or Foundry.'); } }),
  ]) {
    const gh = fakeGitHub();
    const env = envFor({ extra: { ANTHROPIC_API_KEY: 'sk-ant-secret-value' } });
    const logs = [];
    const out = await runReview({ env, fetch: gh.fetch, lib, log: (l) => logs.push(l) });
    assert.deepEqual([out.status, out.exitCode], ['config-error', 1]);
    assert.deepEqual(gh.s.requests, []);
    assert.equal(lib.calls.reviewChanges.length, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^Grapim Review: (\.grapim|No model)/);
    assert.ok(!fs.existsSync(env.GITHUB_OUTPUT));
  }
  // Thrown by the engine mid-run, too.
  const mid = fakeLib();
  mid.reviewChanges = async () => { throw new ConfigError('Model claude-x is not available on bedrock in us-east-1.'); };
  const gh = fakeGitHub();
  const out = await runReview({ env: envFor(), fetch: gh.fetch, lib: mid, log: () => {} });
  assert.deepEqual([out.status, out.exitCode, gh.s.requests], ['config-error', 1, []]);
});

test('review action: secrets never reach the log', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-abcdef123', AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG', 'INPUT_GITHUB-TOKEN': 'ghs_token123' };
  assert.equal(redact('bad key sk-ant-abcdef123 and wJalrXUtnFEMI/K7MDENG via ghs_token123', env), 'bad key *** and *** via ***');
});

test('review action: action.yml, zero dependencies, and the bundle', () => {
  const yml = fs.readFileSync(new URL('../action/review/action.yml', import.meta.url), 'utf8');
  assert.match(yml, /^name: Grapim Review$/m);
  assert.match(yml, /using: node24/);
  assert.match(yml, /main: index\.mjs/);
  for (const k of ['github-token', 'provider', 'model', 'fail-on', 'config-path', 'blockers', 'warnings', 'nits', 'reviewed-hunks']) assert.match(yml, new RegExp(`^  ${k}:$`, 'm'), k);
  assert.doesNotMatch(yml, /api-key|secret-access|access-token:/i, 'credentials are env, never inputs');
  const src = fs.readFileSync(new URL('../action/review/index.mjs', import.meta.url), 'utf8');
  for (const spec of importsOf(src)) assert.ok(spec.startsWith('node:') || spec.startsWith('./dist/'), spec);

  // The closure of a module under src/, at its own path.
  const s3 = bundledReview({ entries: ['storage/s3.js', 'provenance/render.js'] });
  assert.deepEqual([...s3.keys()].sort(), ['package.json', 'provenance/render.js', 'storage/keys.js', 'storage/retry.js', 'storage/s3.js']);
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  assert.equal(s3.get('storage/s3.js'), fs.readFileSync(path.join(root, 'storage', 's3.js'), 'utf8'), 'byte for byte');
  // Anything but node: and relative .js files under src/ is refused.
  const bad = tmp('grapim-bundle-');
  fs.mkdirSync(path.join(bad, 'airev'));
  fs.writeFileSync(path.join(bad, 'airev', 'index.js'), "import x from 'lodash';\n");
  assert.throws(() => bundledReview({ root: bad, entries: ['airev/index.js'] }), /self-contained/);
  fs.writeFileSync(path.join(bad, 'airev', 'index.js'), "export { a } from '../../outside.js';\n");
  assert.throws(() => bundledReview({ root: bad, entries: ['airev/index.js'] }), /outside src/);
  // Once the engine is in src/airev/, action/review/dist/ must match it.
  assert.deepEqual(checkReview(), [], 'run: node action/bundle.mjs');
});

// ---- grapim review --ai ----

test('grapim review --ai: argument parsing', () => {
  assert.deepEqual(parseReviewAiArgs(['--ai']), { json: false, failOn: null, provider: null, model: null, base: undefined, head: undefined });
  assert.deepEqual(parseReviewAiArgs(['--ai', 'origin/main..HEAD', '--json', '--fail-on', 'never']), { json: true, failOn: 'never', provider: null, model: null, base: 'origin/main', head: 'HEAD' });
  assert.deepEqual(parseReviewAiArgs(['main...feature', '--ai', '--provider', 'vertex', '--model', 'claude-opus-5-5']), { json: false, failOn: null, provider: 'vertex', model: 'claude-opus-5-5', base: 'main', head: 'feature' });
  assert.equal(parseReviewAiArgs(['--ai', 'main']).head, 'HEAD');
  assert.equal(parseReviewAiArgs(['--ai', 'main..']).head, 'HEAD');
  assert.match(parseReviewAiArgs(['--ai', '--fail-on', 'warning']).error, /blocker or never/);
  assert.match(parseReviewAiArgs(['--ai', '--fail-on']).error, /needs a value/);
  assert.match(parseReviewAiArgs(['--ai', '--approve']).error, /no option --approve/);
  assert.match(parseReviewAiArgs(['--ai', 'a..b', 'c..d']).error, /one range/);
  assert.match(parseReviewAiArgs(['--ai', '..HEAD']).error, /needs a base/);
  assert.match(parseReviewAiArgs(['--ai', 'main..--output=x']).error, /cannot start/);
});

test('grapim review --ai: findings grouped by file, exit 1 on a blocker, --json, ConfigError', async () => {
  const repo = tmp('grapim-review-cli-');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  const first = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1\n2\n');
  git('commit', '-qam', 'two');

  const lib = fakeLib();
  const engine = { reviewChanges: lib.reviewChanges, loadConfig: (cwd) => lib.loadConfig(cwd), validateConfig: lib.validateConfig, providerFromEnv: lib.providerFromEnv, ConfigError };
  let out = '';
  let err = '';
  const io = { cwd: repo, env: {}, engine, out: (s) => (out += s), err: (s) => (err += s) };
  assert.equal(await reviewAiCommand(['--ai', `${first}..HEAD`], io), 1, err);
  assert.equal(lib.calls.reviewChanges[0].base, first, 'the merge base');
  assert.equal(lib.calls.reviewChanges[0].head, 'HEAD');
  assert.equal(fs.realpathSync(lib.calls.reviewChanges[0].cwd), fs.realpathSync(repo));
  assert.match(out, /^Grapim Review: 1 blocker, 1 nit in 3 reviewed hunks \(claude-opus-5-5 via anthropic\)\.\n/);
  assert.match(out, /\nsrc\/pay\.js\n  BLOCKER  Deletes the refund check  src\/pay\.js:10-12\n           The run was asked to rename a field\.\n           It also removed the check\./);
  assert.match(out, /           Written by Claude Code run: "Rename amount to total @team <b>now<\/b>"\n/);
  assert.match(out, /\nsrc\/util\.js\n  NIT      Unused import  src\/util\.js:3\n/);

  assert.equal(await reviewAiCommand(['--ai', '--fail-on', 'never'], io), 0);
  assert.equal(lib.calls.reviewChanges[1].base, undefined, 'no range: the engine picks the base');
  out = '';
  assert.equal(await reviewAiCommand(['--ai', '--json', '--provider', 'foundry'], io), 1);
  const j = JSON.parse(out);
  assert.deepEqual(j.counts, { blocker: 1, warning: 0, nit: 1 });
  assert.equal(j.findings.length, 2);
  assert.equal(lib.calls.providerFromEnv.at(-1).name, 'foundry');

  err = '';
  const broken = { ...engine, providerFromEnv: () => { throw new ConfigError('No model credentials: set ANTHROPIC_API_KEY.'); } };
  assert.equal(await reviewAiCommand(['--ai'], { ...io, engine: broken }), 1);
  assert.equal(err, 'No model credentials: set ANTHROPIC_API_KEY.\n');
  err = '';
  assert.equal(await reviewAiCommand(['--ai', 'nope..HEAD'], io), 1);
  assert.match(err, /Unknown commit/);
});

// End to end through the bundled engine (action/review/dist): a real git repo,
// a fake model endpoint and the fake GitHub API.
test('review action: the bundled engine reviews a real PR and the review is posted', { skip: !fs.existsSync(new URL('../action/review/dist/airev/index.js', import.meta.url)) && 'engine not bundled yet' }, async () => {
  const { loadLib } = await import('../action/review/index.mjs');
  const repo = tmp('grapim-review-e2e-');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, '.grapim'));
  fs.writeFileSync(path.join(repo, '.grapim', 'review.json'), '{"review": "all"}');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'pay.js'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(repo, 'src', 'pay.js'), 'export const a = 1;\nexport function refund(x) {\n  return x * 2;\n}\n');
  git('commit', '-qam', 'refund');
  const head = git('rev-parse', 'HEAD');

  const dir = tmp('grapim-review-e2e-env-');
  const event = path.join(dir, 'event.json');
  fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 7, base: { sha: base, repo: { full_name: 'acme/api' } }, head: { sha: head, repo: { full_name: 'acme/api' } } } }));
  const env = { GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'acme/api', GITHUB_API_URL: 'https://api.example', 'INPUT_GITHUB-TOKEN': 'test-token', GITHUB_OUTPUT: path.join(dir, 'out.txt'), ANTHROPIC_API_KEY: 'sk-ant-test-key' };

  const gh = fakeGitHub();
  const modelCalls = [];
  const fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.anthropic.com/')) return gh.fetch(url, init);
    modelCalls.push({ url: String(url), body: JSON.parse(init.body) });
    const findings = [{ path: 'src/pay.js', line: 3, end_line: 3, severity: 'blocker', category: 'correctness', title: 'Refund doubles the amount', body: 'A refund of x pays out 2x.' }];
    return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify({ findings }) }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const logs = [];
  const out = await runReview({ env, cwd: repo, fetch, lib: await loadLib(), log: (l) => logs.push(l), wait: async () => {} });
  assert.equal(out.status, 'posted', logs.join('\n'));
  assert.ok(modelCalls.length >= 1, 'the model endpoint was called');
  assert.ok(!logs.join('\n').includes('sk-ant-test-key'), 'the key is never logged');
  assert.equal(gh.s.posts.length, 1);
  assert.deepEqual(gh.s.posts[0].comments.map((c) => [c.path, c.line, c.side]), [['src/pay.js', 3, 'RIGHT']]);
  assert.ok(gh.s.posts[0].comments[0].body.startsWith('**Blocker · Refund doubles the amount**'));
  assert.match(gh.s.comments[0].body, /Grapim received nothing/);
  assert.equal(out.exitCode, 1);
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /blockers=1/);
});
