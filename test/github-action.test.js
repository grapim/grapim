// The GitHub Action's core (action/index.mjs) against a temp git repo with
// fixture notes and a fake GitHub REST API; and `grapim provenance pr` on the
// same repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runAction } from '../action/index.mjs';
import { check as bundleCheck } from '../action/bundle.mjs';
import { prCommand } from '../src/provenance/pr-command.js';
import { MARKER } from '../src/provenance/render.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, file, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

// origin (bare) <- dev clone: base on main, then a branch with an AI commit
// (with a note), a human commit, and an AI commit that renames nothing but
// shifts lines. Returns { origin, base, head }.
function fixtureRepo({ notes = true } = {}) {
  const root = tmp('grapim-action-');
  const origin = path.join(root, 'origin.git');
  const dev = path.join(root, 'dev');
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'clone', origin, dev);
  write(dev, 'src/app.js', 'const a = 1;\nconst b = 2;\n');
  write(dev, 'README.md', 'hello\n');
  git(dev, 'add', '.');
  git(dev, 'commit', '-m', 'base');
  git(dev, 'push', 'origin', 'main');
  const base = git(dev, 'rev-parse', 'HEAD');
  git(dev, 'checkout', '-b', 'feature');
  // C1 (claude): adds f at lines 3-5.
  write(dev, 'src/app.js', 'const a = 1;\nconst b = 2;\nfunction f() {\n  return 42;\n}\n');
  git(dev, 'commit', '-am', 'add f');
  const c1 = git(dev, 'rev-parse', 'HEAD');
  // C2 (human): a header line on top, so C1's lines move to 4-6 at the head.
  write(dev, 'src/app.js', '// header\nconst a = 1;\nconst b = 2;\nfunction f() {\n  return 42;\n}\n');
  write(dev, 'README.md', 'hello\nworld\n');
  git(dev, 'commit', '-am', 'header');
  // C3 (codex): exports f, and a second file.
  write(dev, 'src/app.js', '// header\nconst a = 1;\nconst b = 2;\nfunction f() {\n  return 42;\n}\nexport { f };\n');
  write(dev, 'src/new.js', 'export const x = 1;\nexport const y = 2;\n');
  git(dev, 'add', '.');
  git(dev, 'commit', '-m', 'export');
  const c3 = git(dev, 'rev-parse', 'HEAD');
  if (notes) {
    const n1 = { v: 1, tool: 'grapim/0.1.0', runs: [{ id: 'claude-code:1a2b3c4d', label: 'claude 1a2b3c4d', kind: 'claude-code', turns: [{ turn: 1, intent: 'Add f @octocat [x](https://evil.example)' }], review: 'pending' }], files: { 'src/app.js': [[3, 5, 0, 1]] } };
    const n3 = { v: 1, tool: 'grapim/0.1.0', runs: [{ id: 'mcp:codex-4121', label: 'codex 4121', kind: 'codex', turns: [{ turn: 3, intent: 'Export f' }], review: 'approved' }], files: { 'src/app.js': [[7, 7, 0, 3]], 'src/new.js': [[1, 1, 0, 3]] } };
    git(dev, 'notes', '--ref=grapim', 'add', '-m', JSON.stringify(n1), c1);
    git(dev, 'notes', '--ref=grapim', 'add', '-m', JSON.stringify(n3), c3);
    git(dev, 'push', 'origin', 'refs/notes/grapim');
  }
  git(dev, 'push', 'origin', 'feature');
  return { root, origin, dev, base, head: c3 };
}

// A CI checkout: a fresh clone (no notes ref, as actions/checkout leaves it).
function checkout(r) {
  const ci = path.join(r.root, `ci-${Math.random().toString(36).slice(2, 8)}`);
  git(r.root, 'clone', '--no-tags', r.origin, ci);
  git(ci, 'fetch', 'origin', 'feature');
  return ci;
}

// One fixture repo and CI checkout for the tests that only read them (git is slow to spawn on Windows).
let sharedRepo = null;
const shared = () => {
  if (!sharedRepo) {
    const r = fixtureRepo();
    sharedRepo = { r, ci: checkout(r) };
  }
  return sharedRepo;
};

function fakeApi() {
  const s = { comments: [], requests: [], deny: false };
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
    if (req.headers.authorization !== 'Bearer test-token') return send(401, {});
    if (url.pathname === '/repos/acme/api/issues/7/comments') {
      if (req.method === 'GET') return send(200, s.comments);
      if (s.deny) return send(403, { message: 'Resource not accessible by integration' });
      const c = { id: s.comments.length + 1, body: body.body, user: { login: 'github-actions[bot]', type: 'Bot' } };
      s.comments.push(c);
      return send(201, c);
    }
    const m = /^\/repos\/acme\/api\/issues\/comments\/(\d+)$/.exec(url.pathname);
    if (m && req.method === 'PATCH') {
      const c = s.comments.find((x) => x.id === Number(m[1]));
      c.body = body.body;
      return send(200, c);
    }
    send(404, {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

function envFor(r, api, { fork = false, extra = {} } = {}) {
  const dir = tmp('grapim-action-env-');
  const event = path.join(dir, 'event.json');
  fs.writeFileSync(
    event,
    JSON.stringify({
      pull_request: { number: 7, base: { sha: r.base, repo: { full_name: 'acme/api' } }, head: { sha: r.head, repo: { full_name: fork ? 'someone/api' : 'acme/api' } } },
      repository: { full_name: 'acme/api' },
    }),
  );
  return {
    GITHUB_EVENT_PATH: event,
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REPOSITORY: 'acme/api',
    GITHUB_API_URL: api.url,
    'INPUT_GITHUB-TOKEN': 'test-token',
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
    GITHUB_OUTPUT: path.join(dir, 'output.txt'),
    ...extra,
  };
}

test('action/dist is the bundled copy of src/provenance', () => {
  assert.deepEqual(bundleCheck(), [], 'run: node action/bundle.mjs');
  const yml = fs.readFileSync(new URL('../action/action.yml', import.meta.url), 'utf8');
  assert.match(yml, /using: node20/);
  assert.match(yml, /main: index\.mjs/);
  // Zero dependencies: only node: builtins and ./dist.
  const src = fs.readFileSync(new URL('../action/index.mjs', import.meta.url), 'utf8');
  for (const m of src.matchAll(/from '([^']+)'/g)) assert.ok(m[1].startsWith('node:') || m[1].startsWith('./dist/'), m[1]);
});

test('action: fetches the notes, blames the PR, posts one comment and updates it in place', async (t) => {
  const r = fixtureRepo();
  const api = await fakeApi();
  t.after(api.close);
  const ci = checkout(r);
  // (this test pushes to its repo, so it has its own)
  const logs = [];
  const out = await runAction({ env: envFor(r, api), cwd: ci, log: (l) => logs.push(l) });
  assert.equal(out.status, 'posted', logs.join('\n'));
  assert.equal(api.s.comments.length, 1);
  const body = api.s.comments[0].body;
  assert.ok(body.startsWith(MARKER));
  // Added: app.js lines 1, 4-7 (5) + README line 2 + new.js 1-2 = 8. AI: claude 3 (moved to 4-6), codex 2.
  assert.equal(out.stats.added, 8);
  assert.equal(out.stats.ai, 5);
  assert.match(body, /\*\*63% of the added lines were written by AI agents\*\* \(5 of 8\): claude 1a2b3c4d 3, codex 4121 2/);
  assert.doesNotMatch(body, /@octocat|\]\(|https:\/\//);
  assert.match(body, /- claude 1a2b3c4d: 3 lines in 1 file/);
  assert.match(git(ci, 'rev-parse', 'refs/notes/grapim'), /^[0-9a-f]{40}$/, 'the action fetched the notes');

  // Again: same content, nothing written.
  const again = await runAction({ env: envFor(r, api), cwd: ci, log: () => {} });
  assert.equal(again.status, 'unchanged');
  assert.ok(!api.s.requests.some((x) => x.startsWith('PATCH')));
  // A new push changes the summary: updated in place, never a second comment.
  const dev = r.dev;
  write(dev, 'src/new.js', 'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n');
  git(dev, 'commit', '-am', 'z');
  git(dev, 'push', 'origin', 'feature');
  const r2 = { ...r, head: git(dev, 'rev-parse', 'HEAD') };
  git(ci, 'fetch', 'origin', 'feature');
  const upd = await runAction({ env: envFor(r2, api), cwd: ci, log: () => {} });
  assert.equal(upd.status, 'updated');
  assert.equal(api.s.comments.length, 1);
  assert.match(api.s.comments[0].body, /\(5 of 9\)/);

  // Outputs for later steps.
  const env = envFor(r, api);
  await runAction({ env, cwd: ci, log: () => {} });
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /ai-lines=5\nai-share=0\.6250\nunreviewed-runs=1/);
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /Grapim provenance/);
});

test('action: a forked PR (read-only token) logs the summary; a 403 does too; neither fails', async (t) => {
  const { r, ci } = shared();
  const api = await fakeApi();
  t.after(api.close);
  const logs = [];
  const out = await runAction({ env: envFor(r, api, { fork: true }), cwd: ci, log: (l) => logs.push(l) });
  assert.equal(out.status, 'log');
  assert.deepEqual(api.s.requests, [], 'GitHub is not called from a fork');
  const text = logs.join('\n');
  assert.match(text, /from a fork/);
  assert.match(text, /::stop-commands::[0-9a-f]{32}/, 'workflow commands are off while the summary prints');
  // Same repo, but the token cannot write.
  api.s.deny = true;
  const denied = await runAction({ env: envFor(r, api), cwd: ci, log: () => {} });
  assert.equal(denied.status, 'log');
});

test('action: no notes in the repo posts the how-to comment once; big PRs are capped', async (t) => {
  const r = fixtureRepo({ notes: false });
  const api = await fakeApi();
  t.after(api.close);
  const ci = checkout(r);
  assert.equal((await runAction({ env: envFor(r, api), cwd: ci, log: () => {} })).status, 'posted');
  assert.match(api.s.comments[0].body, /No AI provenance was found/);
  assert.equal((await runAction({ env: envFor(r, api), cwd: ci, log: () => {} })).status, 'unchanged');
  assert.equal(api.s.comments.length, 1);

  const { r: big, ci: ci2 } = shared();
  const api2 = await fakeApi();
  t.after(api2.close);
  const out = await runAction({ env: envFor(big, api2, { extra: { 'INPUT_MAX-FILES': '1' } }), cwd: ci2, log: () => {} });
  assert.equal(out.stats.files, 1);
  assert.equal(out.stats.omittedFiles, 2);
  assert.match(api2.s.comments[0].body, /Only the first 1 file of this pull request were attributed; 2 more files were not/);
});

test('grapim provenance pr <base>..<head> renders the same summary locally', async () => {
  const { r } = shared();
  let text = '';
  const code = await prCommand([`${r.base}..${r.head}`], { cwd: r.dev, out: (s) => (text += s), err: (s) => (text += s) });
  assert.equal(code, 0, text);
  assert.match(text, /\(5 of 8\): claude 1a2b3c4d 3, codex 4121 2/);
  let json = '';
  await prCommand(['--json', `${r.base}..${r.head}`], { cwd: r.dev, out: (s) => (json += s) });
  const j = JSON.parse(json);
  assert.equal(j.ai, 5);
  assert.equal(j.has_notes, true);
  let err = '';
  assert.equal(await prCommand(['nonsense'], { cwd: r.dev, out: () => {}, err: (s) => (err += s) }), 1);
  assert.match(err, /Usage/);
});
