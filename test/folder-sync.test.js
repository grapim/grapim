// `grapim folder`: two-way folder sync against a real `grapim serve` started
// in-process on port 0 over a temp git repo (docs/workspaces.md §3). The
// "agent" writes the workspace over /fs, as a sandboxed agent would.
//
// The property every test checks in the end: both sides hold the same files,
// and no bytes written on either side are lost (they are at their path or in
// a conflict copy).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFolderSync, conflictName, folderMain, ignoreMatcher, safeRel } from '../src/folder-sync.js';
import { startServer } from '../src/server/index.js';

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const lines = (n, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}\n`).join('');
const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

function repo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-ws-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']);
  for (const [name, content] of Object.entries({ '.keep': '', ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  git(['add', '.']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return dir;
}

const tmp = (name = 'folder') => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-local-')), name);
const serve = (dir, opts = {}) => startServer({ cwd: dir, port: 0, env: {}, uiDir: path.join(dir, 'no-ui-here'), ...opts });

// A sync client for a folder; its output lines are kept in .out.
function client(s, dir, machine = 'laptop', opts = {}) {
  const out = [];
  const c = createFolderSync({ url: s.url, dir, machine, say: (l) => out.push(l), ...opts });
  c.out = out;
  return c;
}

// The agent: writes over /fs and releases its claim, as a well-behaved agent
// does. With safe, it uses If-Match and retries a stale or held write.
async function agentReq(s, method, rel, { body, ifMatch, name = 'agent' } = {}) {
  const headers = { 'X-Grapim-Agent': name };
  if (ifMatch !== undefined) headers['If-Match'] = `"${ifMatch ?? 'absent'}"`;
  const res = await fetch(`${s.url}/fs/${rel.split('/').map(encodeURIComponent).join('/')}`, { method, headers, body });
  const text = await res.text();
  await fetch(`${s.url}/fs/_release`, { method: 'POST', headers: { 'X-Grapim-Agent': name } });
  return { status: res.status, text };
}
const agentPut = async (s, rel, body, name) => {
  const r = await agentReq(s, 'PUT', rel, { body, name });
  assert.equal(r.status, 200, r.text);
};
const agentDel = async (s, rel) => {
  const r = await agentReq(s, 'DELETE', rel);
  assert.equal(r.status, 200, r.text);
};
async function agentGet(s, rel) {
  const res = await fetch(`${s.url}/fs/${rel.split('/').map(encodeURIComponent).join('/')}`);
  if (res.status === 404) return null;
  return { buf: Buffer.from(await res.arrayBuffer()), etag: res.headers.get('etag')?.slice(1, -1) };
}
// Read, change, write with If-Match; retried on 412 and 409. Never blind.
async function agentEdit(s, rel, change, name = 'agent') {
  for (let i = 0; i < 50; i++) {
    const cur = await agentGet(s, rel);
    const next = change(cur ? cur.buf.toString('utf8') : null);
    const r = await agentReq(s, 'PUT', rel, { body: next, ifMatch: cur ? cur.etag : null, name });
    if (r.status === 200) return;
    assert.ok([409, 412, 503].includes(r.status), r.text);
    await new Promise((res) => setTimeout(res, 20 + Math.random() * 40));
  }
  assert.fail(`agent could not write ${rel}`);
}

// Every file under dir as rel -> latin1 string, without .git and the sync state.
function tree(dir) {
  const out = {};
  const walk = (abs, rel) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (d.name === '.git' || d.name === '.grapim-sync') continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(path.join(abs, d.name), r);
      else if (d.isFile()) out[r] = fs.readFileSync(path.join(abs, d.name), 'latin1');
    }
  };
  walk(dir, '');
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
const write = (dir, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(dir, ...rel.split('/'))), { recursive: true });
  fs.writeFileSync(path.join(dir, ...rel.split('/')), content);
};
const exists = (dir, rel) => fs.existsSync(path.join(dir, ...rel.split('/')));
const conflicts = (t) => Object.keys(t).filter((p) => p.includes('(conflict from'));
// Every token appears somewhere in the tree.
function assertTokens(t, tokens, where) {
  const all = Object.values(t).join('\n');
  for (const tok of tokens) assert.ok(all.includes(tok), `${where}: lost ${tok}`);
}
const without = (t, ...names) => Object.fromEntries(Object.entries(t).filter(([k]) => !names.includes(k)));

test('helpers: safe names, ignore rules, conflict names', () => {
  assert.equal(safeRel('src/a.js'), true);
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a\\b', 'C:/x', 'a/./b', 'x\x00y']) assert.equal(safeRel(bad), false, bad);
  if (process.platform === 'win32') for (const bad of ['a:b', 'nul.txt', 'x.', 'aux']) assert.equal(safeRel(bad), false, bad);

  const ig = ignoreMatcher('# comment\n*.log\n!keep.log\nbuild/\n/top.txt\ndocs/*.tmp\n**/cache/**\n');
  const yes = ['.git/config', '.git', 'sub/.git/HEAD', '.grapim-sync/state.json', 'node_modules/x/y.js', 'a/node_modules/z', '.DS_Store', 'd/Thumbs.db', 'x.log', 'a/b/x.log', 'build/out.js', 'a/build/out.js', 'top.txt', 'docs/a.tmp', 'a/cache/b/c', '.x.txt.grapim-sync-0a1b2c3d.tmp', '.y.grapim-123-ab12.tmp'];
  const no = ['keep.log', 'src/a.js', 'a/top.txt', 'docs/sub/a.tmp', 'building.txt', 'build.txt'];
  for (const p of yes) assert.equal(ig(p), true, `${p} should be ignored`);
  for (const p of no) assert.equal(ig(p), false, `${p} should not be ignored`);
  assert.equal(ig('build', true), true);
  assert.equal(ig('build', false), false, 'build/ matches folders only');

  assert.equal(conflictName('notes.md', 'laptop', '2026-11-11'), 'notes (conflict from laptop 2026-11-11).md');
  assert.equal(conflictName('a/b/notes.md', 'laptop', '2026-11-11', 2), 'a/b/notes (conflict from laptop 2026-11-11 2).md');
  assert.equal(conflictName('.env', 'pc', '2026-11-11'), '.env (conflict from pc 2026-11-11)');
  assert.equal(conflictName('Makefile', 'pc', '2026-11-11'), 'Makefile (conflict from pc 2026-11-11)');
});

test('an initial clone of a populated workspace, then local files go up, with state on disk', async () => {
  const bin = Buffer.from([0, 1, 2, 255, 0, 10, 13, 10]);
  const srv = repo({ 'README.md': '# hi\n', 'src/app.js': lines(5), 'assets/logo.bin': bin, 'crlf.txt': 'a\r\nb\r\n' });
  const s = await serve(srv);
  const dir = tmp();
  try {
    await agentPut(s, 'agent-made/notes.txt', 'from the agent\n');
    const c = client(s, dir);
    const st = await c.syncOnce();
    assert.deepEqual(tree(dir), tree(srv));
    assert.deepEqual(fs.readFileSync(path.join(dir, 'assets', 'logo.bin')), bin, 'bytes exactly');
    assert.equal(fs.readFileSync(path.join(dir, 'crlf.txt'), 'latin1'), 'a\r\nb\r\n', 'CRLF kept');
    assert.equal(st.down, 6);
    assert.ok(c.out.includes('↓ src/app.js'), c.out.join('\n'));

    const state = JSON.parse(fs.readFileSync(path.join(dir, '.grapim-sync', 'state.json'), 'utf8'));
    assert.deepEqual(Object.keys(state).sort(), ['cursor', 'machine', 'manifest', 'url']);
    assert.equal(state.url, `${s.url}/`);
    assert.equal(state.machine, 'laptop');
    assert.equal(state.manifest['README.md'], sha1('# hi\n'));
    assert.ok(state.cursor > 0);
    for (const sha of Object.values(state.manifest)) assert.ok(fs.existsSync(path.join(dir, '.grapim-sync', 'base', sha)), `base/${sha}`);

    // Run again: nothing to do.
    const again = await c.syncOnce();
    assert.deepEqual(again, { up: 0, down: 0, merged: 0, conflicts: 0, skipped: 0, waiting: 0 });

    // A second folder that already has some of the files: same ones adopted, its own pushed.
    const dir2 = tmp();
    write(dir2, 'README.md', '# hi\n');
    write(dir2, 'mine.txt', 'only here\n');
    const c2 = client(s, dir2, 'desktop');
    await c2.syncOnce();
    assert.deepEqual(tree(dir2), tree(srv));
    assert.equal(read(srv, 'mine.txt'), 'only here\n');
    assert.deepEqual(conflicts(tree(dir2)), []);
  } finally {
    await s.close();
  }
});

test('a local edit goes up as sync-<machine>, and an agent edit comes down', async () => {
  const srv = repo({ 'README.md': '# hi\n', 'src/app.js': lines(5) });
  const s = await serve(srv);
  const dir = tmp();
  try {
    const c = client(s, dir);
    await c.syncOnce();
    write(dir, 'README.md', '# hello\n');
    write(dir, 'src/new.ts', 'export {};\n');
    await agentPut(s, 'src/app.js', lines(6));
    const st = await c.syncOnce();
    assert.equal(read(srv, 'README.md'), '# hello\n');
    assert.equal(read(srv, 'src/new.ts'), 'export {};\n');
    assert.equal(read(dir, 'src/app.js'), lines(6));
    assert.deepEqual(tree(dir), tree(srv));
    assert.deepEqual([st.up, st.down], [2, 1]);
    assert.ok(c.out.includes('↑ README.md') && c.out.includes('↓ src/app.js'), c.out.join('\n'));

    // The ledger names the sync agent, and it holds no claims afterwards.
    const runs = await (await fetch(`${s.url}/api/runs`)).json();
    assert.ok(runs.some((r) => r.run === 'http:sync-laptop' && r.label === 'sync-laptop'));
    const o = await (await fetch(`${s.url}/api/overview`)).json();
    assert.deepEqual(o.leases, []);
  } finally {
    await s.close();
  }
});

test('a local delete and a remote delete', async () => {
  const srv = repo({ 'a.txt': 'A\n', 'gone/b.txt': 'B\n', 'c.txt': 'C\n' });
  const s = await serve(srv);
  const dir = tmp();
  try {
    const c = client(s, dir);
    await c.syncOnce();
    fs.rmSync(path.join(dir, 'a.txt'));
    await agentDel(s, 'gone/b.txt');
    await c.syncOnce();
    assert.equal(exists(srv, 'a.txt'), false);
    assert.equal(exists(dir, 'gone/b.txt'), false);
    assert.equal(exists(dir, 'gone'), false, 'the emptied folder goes too');
    assert.deepEqual(tree(dir), tree(srv));
    assert.ok(c.out.includes('↑ deleted a.txt') && c.out.includes('↓ deleted gone/b.txt'), c.out.join('\n'));
    // The deleted bytes stay recoverable in base/.
    assert.ok(fs.existsSync(path.join(dir, '.grapim-sync', 'base', sha1('B\n'))));

    // Deleted here, changed there: the change wins, the file comes back.
    fs.rmSync(path.join(dir, 'c.txt'));
    await agentPut(s, 'c.txt', 'C changed\n');
    await c.syncOnce();
    assert.equal(read(dir, 'c.txt'), 'C changed\n');
    assert.equal(read(srv, 'c.txt'), 'C changed\n');
  } finally {
    await s.close();
  }
});

test('the same file edited on both sides, non-overlapping, merges cleanly', async () => {
  const srv = repo({ 'notes.md': lines(10) });
  const s = await serve(srv);
  const dir = tmp();
  try {
    const c = client(s, dir);
    await c.syncOnce();
    write(dir, 'notes.md', lines(10).replace('line 1\n', 'line 1 LOCAL\n'));
    await agentPut(s, 'notes.md', lines(10).replace('line 10\n', 'line 10 AGENT\n'));
    const st = await c.syncOnce();
    const want = lines(10).replace('line 1\n', 'line 1 LOCAL\n').replace('line 10\n', 'line 10 AGENT\n');
    assert.equal(read(dir, 'notes.md'), want);
    assert.equal(read(srv, 'notes.md'), want);
    assert.equal(st.merged, 1);
    assert.deepEqual(conflicts(tree(dir)), []);
    assert.ok(c.out.includes('⇅ merged notes.md'), c.out.join('\n'));
    // Nothing more to do; the merge is the new base.
    assert.deepEqual(await c.syncOnce(), { up: 0, down: 0, merged: 0, conflicts: 0, skipped: 0, waiting: 0 });
  } finally {
    await s.close();
  }
});

test('overlapping edits keep both: the workspace version at the path, ours as a pushed conflict copy', async () => {
  const srv = repo({ 'notes.md': lines(10) });
  const s = await serve(srv);
  const dir = tmp();
  try {
    const c = client(s, dir);
    await c.syncOnce();
    const mine = lines(10).replace('line 5\n', 'line 5 MINE\n');
    const theirs = lines(10).replace('line 5\n', 'line 5 THEIRS\n');
    write(dir, 'notes.md', mine);
    await agentPut(s, 'notes.md', theirs);
    const st = await c.syncOnce();
    const copy = `notes (conflict from laptop ${TODAY}).md`;
    assert.equal(read(dir, 'notes.md'), theirs);
    assert.equal(read(dir, copy), mine);
    assert.equal(read(srv, copy), mine, 'the conflict copy is pushed');
    assert.equal(read(srv, 'notes.md'), theirs);
    assert.deepEqual(tree(dir), tree(srv));
    assert.equal(st.conflicts, 1);
    assert.ok(c.out.includes(`⚠ conflict: notes.md, kept both: ${copy}`), c.out.join('\n'));
    assert.ok(!Object.values(tree(dir)).some((t) => t.includes('<<<<<<<')), 'no conflict markers anywhere');
    assert.deepEqual(await c.syncOnce(), { up: 0, down: 0, merged: 0, conflicts: 0, skipped: 0, waiting: 0 });
  } finally {
    await s.close();
  }
});

test('binary on both sides, and a new file on both sides, give a conflict copy; the same new file does not', async () => {
  const b0 = Buffer.from([0, 1, 2, 3]);
  const srv = repo({ 'img.png': b0 });
  const s = await serve(srv);
  const dir = tmp();
  try {
    const c = client(s, dir);
    await c.syncOnce();
    const bMine = Buffer.from([0, 1, 2, 3, 4]);
    const bTheirs = Buffer.from([0, 9, 9]);
    fs.writeFileSync(path.join(dir, 'img.png'), bMine);
    await agentPut(s, 'img.png', bTheirs);
    write(dir, 'plan.txt', 'my plan\n');
    await agentPut(s, 'plan.txt', 'their plan\n');
    write(dir, 'same.txt', 'identical\n');
    await agentPut(s, 'same.txt', 'identical\n');
    const st = await c.syncOnce();
    assert.equal(st.conflicts, 2);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'img.png')), bTheirs);
    assert.deepEqual(fs.readFileSync(path.join(dir, `img (conflict from laptop ${TODAY}).png`)), bMine);
    assert.deepEqual(fs.readFileSync(path.join(srv, `img (conflict from laptop ${TODAY}).png`)), bMine);
    assert.equal(read(dir, 'plan.txt'), 'their plan\n');
    assert.equal(read(dir, `plan (conflict from laptop ${TODAY}).txt`), 'my plan\n');
    assert.equal(read(dir, 'same.txt'), 'identical\n');
    assert.deepEqual(conflicts(tree(dir)).sort(), [`img (conflict from laptop ${TODAY}).png`, `plan (conflict from laptop ${TODAY}).txt`]);
    assert.deepEqual(tree(dir), tree(srv));

    // A second conflict on the same day gets " 2".
    write(dir, 'plan.txt', 'my plan v2\n');
    await agentPut(s, 'plan.txt', 'their plan v2\n');
    await c.syncOnce();
    assert.equal(read(dir, `plan (conflict from laptop ${TODAY} 2).txt`), 'my plan v2\n');
    assert.equal(read(dir, `plan (conflict from laptop ${TODAY}).txt`), 'my plan\n');
    assert.deepEqual(tree(dir), tree(srv));
  } finally {
    await s.close();
  }
});

test('ignore rules: built-in names and .grapimignore, in both directions', async () => {
  const srv = repo({ 'keep.md': 'k\n' });
  const s = await serve(srv);
  const dir = tmp();
  try {
    write(dir, '.grapimignore', '*.log\n!important.log\nbuild/\n');
    write(dir, 'node_modules/pkg/index.js', 'x');
    write(dir, '.DS_Store', 'x');
    write(dir, 'sub/Thumbs.db', 'x');
    write(dir, 'debug.log', 'x');
    write(dir, 'important.log', 'keep me\n');
    write(dir, 'build/out.js', 'x');
    write(dir, 'src/build.js', 'real code\n');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'config'), 'x');
    const c = client(s, dir, 'laptop', { force: true });
    await c.syncOnce();
    for (const p of ['node_modules/pkg/index.js', '.DS_Store', 'sub/Thumbs.db', 'debug.log', 'build/out.js']) assert.equal(exists(srv, p), false, `${p} must not go up`);
    for (const p of ['.grapimignore', 'important.log', 'src/build.js', 'keep.md']) assert.equal(exists(srv, p), true, `${p} must go up`);
    // The workspace's ignored files do not come down either.
    await agentPut(s, 'server.log', 'agent log\n');
    await agentPut(s, 'build/agent.js', 'x');
    await agentPut(s, 'src/ok.js', 'ok\n');
    await c.syncOnce();
    assert.equal(exists(dir, 'server.log'), false);
    assert.equal(exists(dir, 'build/agent.js'), false);
    assert.equal(read(dir, 'src/ok.js'), 'ok\n');
    assert.equal(fs.readdirSync(path.join(dir, '.grapim-sync')).includes('state.json'), true);
    assert.equal(exists(srv, '.grapim-sync/state.json'), false);
  } finally {
    await s.close();
  }
});

test('a link pointing outside the folder is not followed, either way', async () => {
  const srv = repo({ 'a.txt': 'A\n' });
  const s = await serve(srv);
  const dir = tmp();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'do not upload\n');
  try {
    fs.mkdirSync(dir, { recursive: true });
    // A junction needs no admin rights on Windows; elsewhere it is a symlink.
    fs.symlinkSync(outside, path.join(dir, 'link'), 'junction');
    const c = client(s, dir);
    await c.syncOnce();
    assert.equal(exists(srv, 'link/secret.txt'), false, 'nothing behind the link goes up');
    assert.equal(exists(srv, 'link'), false);
    assert.ok(c.out.some((l) => /skipped link: .*link/.test(l)), c.out.join('\n'));
    // The workspace has link/evil.txt: it must not land in the outside folder.
    await agentPut(s, 'link/evil.txt', 'pwned\n');
    await c.syncOnce();
    assert.deepEqual(fs.readdirSync(outside), ['secret.txt']);
    assert.ok(c.out.some((l) => /skipped link\/evil\.txt: link is a link/.test(l)), c.out.join('\n'));
    assert.equal(read(dir, 'a.txt'), 'A\n');
  } finally {
    await s.close();
  }
});

test('a git repo with uncommitted changes is refused without --force', async () => {
  const srv = repo({ 'a.txt': 'A\n' });
  const s = await serve(srv);
  try {
    const dir = repo({ 'x.txt': 'x\n' });
    fs.writeFileSync(path.join(dir, 'x.txt'), 'dirty\n');
    await assert.rejects(client(s, dir).syncOnce(), (e) => e.fatal && /uncommitted changes/.test(e.message));
    assert.equal(fs.existsSync(path.join(dir, 'a.txt')), false, 'nothing written');
    await client(s, dir, 'laptop', { force: true }).syncOnce();
    assert.equal(read(dir, 'a.txt'), 'A\n');
    assert.equal(read(srv, 'x.txt'), 'dirty\n');
  } finally {
    await s.close();
  }
});

test('401 and 403 stop with a clear message; a token is never sent over plain http to another host', async () => {
  const srv = repo({ 'a.txt': 'A\n' });
  const s = await serve(srv, { token: 'right-token-0123456789' });
  try {
    await assert.rejects(client(s, tmp()).syncOnce(), (e) => e.fatal && /needs a token \(401\).*GRAPIM_WORKSPACE_TOKEN/.test(e.message));
    await assert.rejects(client(s, tmp(), 'laptop', { token: 'wrong-token-0123456789' }).syncOnce(), (e) => e.fatal && /refused the token in \$GRAPIM_WORKSPACE_TOKEN \(401\)/.test(e.message));
    const dir = tmp();
    await client(s, dir, 'laptop', { token: 'right-token-0123456789' }).syncOnce();
    assert.equal(read(dir, 'a.txt'), 'A\n');
    assert.throws(() => createFolderSync({ url: 'http://example.com/w/t/ws/', dir: tmp(), token: 'x'.repeat(20) }), /plain http/);

    // Through the CLI: exit 1 and one clear line; --token is refused outright.
    const errs = [];
    const code = await folderMain([s.url, tmp(), '--once'], { env: {}, log: () => {}, error: (l) => errs.push(l) });
    assert.equal(code, 1);
    assert.match(errs.join('\n'), /needs a token \(401\)/);
    const errs2 = [];
    assert.equal(await folderMain([s.url, tmp(), '--token', 'abc'], { env: {}, log: () => {}, error: (l) => errs2.push(l) }), 1);
    assert.match(errs2[0], /does not take a token on the command line/);
    const logs = [];
    assert.equal(await folderMain([s.url, tmp(), '--once', '--token-env', 'MY_TOKEN'], { env: { MY_TOKEN: 'right-token-0123456789' }, log: (l) => logs.push(l), error: (l) => logs.push(l) }), 0);
    assert.match(logs.at(-1), /^Synced: 2 down\.$/);
  } finally {
    await s.close();
  }
});

// Each crash point, in each kind of action: crash there (a throw from the
// hook), restart a fresh client on the same folder, and it must converge with
// every byte from both sides kept and no extra conflict copies.
test('an interrupted sync, at every step, converges without loss after a restart', async () => {
  const scenarios = {
    push: { steps: ['push', 'pushed'], local: (t) => t.replace('line 3\n', 'line 3 LOCAL-EDIT\n'), remote: null, copies: 0 },
    pull: { steps: ['pull', 'pulled', 'page'], local: null, remote: (t) => t.replace('line 7\n', 'line 7 REMOTE-EDIT\n'), copies: 0 },
    merge: { steps: ['merge-push', 'merge-pushed', 'merged'], local: (t) => t.replace('line 1\n', 'line 1 LOCAL-EDIT\n'), remote: (t) => t.replace('line 9\n', 'line 9 REMOTE-EDIT\n'), copies: 0 },
    conflict: {
      steps: ['conflict-copy', 'conflict-copied', 'conflict-copy-pushed', 'conflict-resolved'],
      local: (t) => t.replace('line 5\n', 'line 5 LOCAL-EDIT\n'),
      remote: (t) => t.replace('line 5\n', 'line 5 REMOTE-EDIT\n'),
      copies: 1,
    },
    delete: { steps: ['push', 'pushed'], local: () => null, remote: null, copies: 0 },
  };
  for (const [name, sc] of Object.entries(scenarios)) {
    for (const crashAt of sc.steps) {
      const srv = repo({ 'f.txt': lines(10), 'other.txt': 'other\n' });
      const s = await serve(srv);
      const dir = tmp();
      try {
        await client(s, dir).syncOnce();
        if (sc.local) {
          const next = sc.local(lines(10));
          if (next === null) fs.rmSync(path.join(dir, 'f.txt'));
          else write(dir, 'f.txt', next);
        }
        if (sc.remote) await agentPut(s, 'f.txt', sc.remote(lines(10)));
        let hit = 0;
        const crashing = client(s, dir, 'laptop', {
          hooks: {
            step: (n) => {
              if (n === crashAt && hit++ === 0) throw new Error(`crash at ${n}`);
            },
          },
        });
        await assert.rejects(crashing.syncOnce(), new RegExp(`crash at ${crashAt}`), `${name}/${crashAt} must reach its step`);
        // Restart: a fresh process on the same folder.
        for (let i = 0; i < 3; i++) await client(s, dir).syncOnce();
        const here = tree(dir);
        assert.deepEqual(here, tree(srv), `${name}/${crashAt}: both sides equal`);
        const tokens = [sc.local && 'LOCAL-EDIT', sc.remote && 'REMOTE-EDIT'].filter((t) => t && !(name === 'delete'));
        assertTokens(here, tokens, `${name}/${crashAt}`);
        assert.equal(conflicts(here).length, sc.copies, `${name}/${crashAt}: ${conflicts(here)}`);
        assert.equal(here['other.txt'], 'other\n');
        if (name === 'delete') assert.equal(here['f.txt'], undefined);
      } finally {
        await s.close();
      }
    }
  }
});

// A seeded random walk: two folders and an agent edit the same files at the
// same time, while both clients sync. Edits only insert unique lines, so
// "nothing lost" is checkable: every line ever written must survive somewhere.
test('two folders and an agent writing at once converge to the same content, losing nothing', async () => {
  let seed = 20261111;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const srv = repo({ 'a.md': lines(6, 'a'), 'b.md': lines(6, 'b'), 'docs/c.md': lines(6, 'c') });
  const s = await serve(srv);
  const dirA = tmp('A');
  const dirB = tmp('B');
  const tokens = [];
  let n = 0;
  const insert = (text, tok) => {
    const ls = (text ?? '').split('\n').slice(0, -1);
    ls.splice(Math.floor(rand() * (ls.length + 1)), 0, tok);
    return ls.map((l) => l + '\n').join('');
  };
  // An edit in a folder, the way an editor saves: in place.
  const localEdit = (dir, who) => {
    const files = Object.keys(tree(dir)).filter((p) => p.endsWith('.md') && !p.includes('(conflict'));
    const tok = `${who}-${++n}`;
    tokens.push(tok);
    if (!files.length || rand() < 0.15) write(dir, `${who}-new-${n}.md`, `${tok}\n`);
    else {
      const f = pick(files);
      write(dir, f, insert(fs.readFileSync(path.join(dir, ...f.split('/')), 'utf8'), tok));
    }
  };
  const agentStep = async () => {
    const tok = `agent-${++n}`;
    tokens.push(tok);
    const f = rand() < 0.15 ? `agent-new-${n}.md` : pick(['a.md', 'b.md', 'docs/c.md']);
    await agentEdit(s, f, (cur) => insert(cur, tok));
  };
  const later = (ms, fn) => new Promise((r) => setTimeout(() => r(fn()), ms));
  try {
    const A = client(s, dirA, 'laptop');
    const B = client(s, dirB, 'desktop');
    await A.syncOnce();
    await B.syncOnce();
    for (let round = 0; round < 8; round++) {
      const work = [A.syncOnce(), B.syncOnce()];
      for (let i = 0; i < 3; i++) {
        work.push(later(Math.floor(rand() * 60), () => localEdit(dirA, 'A')));
        work.push(later(Math.floor(rand() * 60), () => localEdit(dirB, 'B')));
        work.push(later(Math.floor(rand() * 60), agentStep));
      }
      await Promise.all(work);
    }
    // Quiet now: sync until nothing moves.
    for (let i = 0; i < 10; i++) {
      const a = await A.syncOnce();
      const b = await B.syncOnce();
      const moved = (x) => x.up + x.down + x.merged + x.conflicts + x.waiting;
      if (!moved(a) && !moved(b) && JSON.stringify(tree(dirA)) === JSON.stringify(tree(dirB))) break;
    }
    const tA = tree(dirA);
    assert.deepEqual(tA, tree(dirB), 'the two folders agree');
    assert.deepEqual(without(tA), without(tree(srv)), 'and agree with the workspace');
    assert.ok(tokens.length >= 60);
    assertTokens(tA, tokens, 'converged tree');
    assert.ok(!Object.values(tA).some((t) => t.includes('<<<<<<<')), 'no conflict markers');
  } finally {
    await s.close();
  }
});

test('--watch: an agent edit arrives within seconds, a local edit goes up, stop() ends it', async () => {
  const srv = repo({ 'a.txt': 'A\n' });
  const s = await serve(srv);
  const dir = tmp();
  try {
    const c = client(s, dir);
    const errors = [];
    const running = c.watch({ onError: (e) => errors.push(e.message) });
    const until = async (fn, what) => {
      for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(fn(), `${what}; output: ${c.out.join(' | ')}; errors: ${errors.join(' | ')}`);
    };
    await until(() => exists(dir, 'a.txt'), 'the first sync');
    await agentPut(s, 'from-agent.txt', 'hello\n');
    await until(() => exists(dir, 'from-agent.txt'), 'the agent file arrives');
    write(dir, 'from-me.txt', 'hi\n');
    await until(() => exists(srv, 'from-me.txt'), 'the local file goes up');
    await c.stop();
    await running;
    assert.deepEqual(tree(dir), tree(srv));
    // The lock is released, so a one-off sync can run now.
    await c.syncOnce();
  } finally {
    await s.close();
  }
});

test('names that differ only in letter case are not mixed up on a case-insensitive folder', { skip: !['win32', 'darwin'].includes(process.platform) }, async () => {
  const srv = repo({});
  const s = await serve(srv);
  const dir = tmp();
  try {
    const c = client(s, dir);
    await c.syncOnce();
    write(dir, 'Notes.txt', 'mine\n');
    await agentPut(s, 'notes.txt', 'theirs\n');
    await c.syncOnce();
    await c.syncOnce();
    assert.ok(c.out.some((l) => /skipped notes\.txt: notes\.txt is Notes\.txt in this folder/.test(l)), c.out.join('\n'));
    // Both texts are kept, here and there.
    assertTokens(tree(dir), ['mine', 'theirs'], 'folder');
    assertTokens(tree(srv), ['mine', 'theirs'], 'workspace');
  } finally {
    await s.close();
  }
});

test('403 stops; 429 and 503 back off, honouring Retry-After', async () => {
  const http = await import('node:http');
  let answer = { status: 403, headers: {}, body: { error: { code: 'forbidden', message: 'This token is read-only.' } } };
  let hits = 0;
  const stub = http.createServer((req, res) => {
    hits++;
    res.writeHead(answer.status, { 'Content-Type': 'application/json', ...answer.headers });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${stub.address().port}/w/team/ws/`;
  try {
    await assert.rejects(createFolderSync({ url, dir: tmp(), machine: 'm' }).syncOnce(), (e) => e.fatal && /refused access \(403\): This token is read-only/.test(e.message));

    answer = { status: 429, headers: { 'Retry-After': '3' }, body: { error: { code: 'too_many', message: 'slow down' } } };
    await assert.rejects(createFolderSync({ url, dir: tmp(), machine: 'm' }).syncOnce(), (e) => e.transient && !e.fatal && e.retryAfter === 3000);

    answer = { status: 503, headers: {}, body: { error: { code: 'busy', message: 'busy' } } };
    const c = createFolderSync({ url, dir: tmp(), machine: 'm' });
    const delays = [];
    const running = c.watch({ onError: (e, n, delay) => delays.push(delay) });
    for (let i = 0; i < 100 && delays.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    await c.stop();
    await running;
    assert.deepEqual(delays.slice(0, 2), [2000, 4000], 'exponential without Retry-After');
    assert.ok(hits >= 4);
  } finally {
    stub.close();
  }
});
