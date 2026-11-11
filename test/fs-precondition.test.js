// Optimistic concurrency on /fs (ETag, If-Match) and the changes feed, over
// real HTTP against `grapim serve` on a temp git repo. docs/workspaces.md §2.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server/index.js';

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function repo(files = { 'app.js': 'one\ntwo\n' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-ifmatch-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  git(['add', '.']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return dir;
}

function request(s, method, rawPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, method, path: rawPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const serve = (dir) => startServer({ cwd: dir, port: 0, env: {}, uiDir: path.join(dir, 'no-ui-here') });
const put = (s, agent, p, body, ifMatch) =>
  request(s, 'PUT', `/fs/${p}`, { headers: { 'X-Grapim-Agent': agent, ...(ifMatch !== undefined ? { 'If-Match': ifMatch } : {}) }, body });
const del = (s, agent, p, ifMatch) => request(s, 'DELETE', `/fs/${p}`, { headers: { 'X-Grapim-Agent': agent, ...(ifMatch !== undefined ? { 'If-Match': ifMatch } : {}) } });
const release = (s, agent) => request(s, 'POST', '/fs/_release', { headers: { 'X-Grapim-Agent': agent } });
const getJson = async (s, p) => {
  const r = await request(s, 'GET', p);
  assert.equal(r.status, 200, `${p}: ${r.text}`);
  return r.json();
};
const q = (sha) => `"${sha}"`;

function assert412(r, current) {
  assert.equal(r.status, 412, r.text);
  const e = r.json().error;
  assert.equal(e.code, 'precondition_failed');
  assert.equal(typeof e.message, 'string');
  assert.equal(e.current_sha, current);
}

// Everything that would show a write happened: the file, change rows, events, leases.
async function trace(s, dir, file) {
  const abs = path.join(dir, file);
  return {
    content: fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null,
    changes: (await getJson(s, '/api/files/changes?after=0')).changes.length,
    events: (await getJson(s, '/api/events?after=0&limit=1000')).length,
    leases: (await getJson(s, '/api/overview')).leases.length,
  };
}

test('GET /fs and PUT answer with an ETag that is the sha1 of the content', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    const g = await request(s, 'GET', '/fs/app.js');
    assert.equal(g.status, 200);
    assert.equal(g.headers.etag, q(sha1('one\ntwo\n')));
    const h = await request(s, 'HEAD', '/fs/app.js');
    assert.equal(h.headers.etag, q(sha1('one\ntwo\n')));
    const w = await put(s, 'a', 'app.js', 'one\n2\n');
    assert.equal(w.status, 200, w.text);
    assert.equal(w.headers.etag, q(sha1('one\n2\n')));
    assert.equal(w.headers.etag, q(w.json().sha));
    // A folder listing is JSON, not a file version: no ETag.
    assert.equal((await request(s, 'GET', '/fs/')).headers.etag, undefined);
  } finally {
    await s.close();
  }
});

test('PUT with If-Match: a match writes, a mismatch is 412 and writes and records nothing', async () => {
  const dir = repo();
  const s = await serve(dir);
  try {
    const v1 = sha1('one\ntwo\n');
    const ok = await put(s, 'a', 'app.js', 'one\nTWO\n', q(v1));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.headers.etag, q(sha1('one\nTWO\n')));
    await release(s, 'a');

    const before = await trace(s, dir, 'app.js');
    // Stale: v1 is no longer the content. Another agent, so a claim would show as a lease.
    assert412(await put(s, 'b', 'app.js', 'lost?\n', q(v1)), sha1('one\nTWO\n'));
    // The same agent that holds nothing, unquoted value works too.
    assert412(await put(s, 'a', 'app.js', 'lost?\n', v1), sha1('one\nTWO\n'));
    assert412(await put(s, 'b', 'app.js', 'lost?\n', '"absent"'), sha1('one\nTWO\n'));
    assert.deepEqual(await trace(s, dir, 'app.js'), before, 'no bytes, no change row, no event, no lease');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file left');

    // absent: creating a file that must not exist yet.
    const created = await put(s, 'b', 'new.txt', 'hello\n', '"absent"');
    assert.equal(created.status, 200, created.text);
    assert412(await put(s, 'b', 'new.txt', 'again\n', '"absent"'), sha1('hello\n'));
    assert412(await put(s, 'c', 'never.txt', 'x', q(sha1('x'))), null);
    assert.equal(fs.existsSync(path.join(dir, 'never.txt')), false);

    // A malformed If-Match is a bad request, not a silent unconditional write.
    const bad = await put(s, 'b', 'new.txt', 'x', '"*"');
    assert.equal(bad.status, 400, bad.text);
    assert.equal(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8'), 'hello\n');
    // Without If-Match, the old behaviour.
    assert.equal((await put(s, 'b', 'new.txt', 'plain\n')).status, 200);
  } finally {
    await s.close();
  }
});

test('DELETE with If-Match: a match deletes, a mismatch or a missing file is 412, absent on no file is 404', async () => {
  const dir = repo({ 'a.txt': 'A\n', 'b.txt': 'B\n' });
  const s = await serve(dir);
  try {
    const before = await trace(s, dir, 'a.txt');
    assert412(await del(s, 'x', 'a.txt', q(sha1('not A\n'))), sha1('A\n'));
    assert412(await del(s, 'x', 'a.txt', '"absent"'), sha1('A\n'));
    assert.deepEqual(await trace(s, dir, 'a.txt'), before);

    const ok = await del(s, 'x', 'a.txt', q(sha1('A\n')));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(fs.existsSync(path.join(dir, 'a.txt')), false);
    // Already gone: the precondition names what is there (nothing).
    assert412(await del(s, 'y', 'a.txt', q(sha1('A\n'))), null);
    assert.equal((await del(s, 'y', 'a.txt', '"absent"')).status, 404);
    assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'B\n');
  } finally {
    await s.close();
  }
});

test('two concurrent PUTs with the same If-Match: exactly one wins, every time', async () => {
  const dir = repo({ 'race.txt': 'v0\n' });
  const s = await serve(dir);
  try {
    let current = sha1('v0\n');
    for (let round = 0; round < 20; round++) {
      // Different agents on even rounds, the same agent on odd rounds.
      const [x, y] = round % 2 ? ['same', 'same'] : [`x${round}`, `y${round}`];
      const bodies = [`x ${round}\n`, `y ${round}\n`];
      const rs = await Promise.all([put(s, x, 'race.txt', bodies[0], q(current)), put(s, y, 'race.txt', bodies[1], q(current))]);
      const won = rs.filter((r) => r.status === 200);
      assert.equal(won.length, 1, `round ${round}: ${rs.map((r) => r.status)}`);
      const lost = rs.find((r) => r.status !== 200);
      const winner = bodies[rs.indexOf(won[0])];
      assert412(lost, sha1(winner));
      assert.equal(fs.readFileSync(path.join(dir, 'race.txt'), 'utf8'), winner);
      current = sha1(winner);
      await release(s, x);
      await release(s, y);
    }
    // One recorded change per round: the losers recorded nothing.
    const feed = await getJson(s, '/api/files/changes?after=0');
    assert.equal(feed.changes.length, 20);
  } finally {
    await s.close();
  }
});

test('the changes feed: this worktree in id order, sha after (null for a delete), paged by cursor', async () => {
  const dir = repo({ 'a.txt': 'A\n' });
  const s = await serve(dir);
  try {
    const empty = await getJson(s, '/api/files/changes?after=0');
    assert.deepEqual(empty, { changes: [], cursor: 0 });

    for (let i = 0; i < 7; i++) assert.equal((await put(s, 'w', `f${i}.txt`, `${i}\n`)).status, 200);
    assert.equal((await del(s, 'w', 'a.txt')).status, 200);
    const all = await getJson(s, '/api/files/changes?after=0&limit=500');
    assert.equal(all.changes.length, 8);
    assert.deepEqual(Object.keys(all.changes[0]).sort(), ['id', 'label', 'path', 'run', 'sha', 'ts']);
    assert.deepEqual(all.changes.map((c) => c.path), ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt', 'f6.txt', 'a.txt']);
    assert.equal(all.changes[0].sha, sha1('0\n'));
    assert.equal(all.changes[0].run, 'http:w');
    assert.equal(all.changes[0].label, 'w');
    assert.equal(all.changes.at(-1).sha, null, 'a delete has sha null');
    assert.equal(all.cursor, all.changes.at(-1).id);
    const ids = all.changes.map((c) => c.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));

    // Paging 3 at a time gives the same list, and the cursor stops at the end.
    const paged = [];
    let cursor = 0;
    for (;;) {
      const page = await getJson(s, `/api/files/changes?after=${cursor}&limit=3`);
      if (!page.changes.length) {
        assert.equal(page.cursor, cursor);
        break;
      }
      assert.ok(page.changes.length <= 3);
      paged.push(...page.changes);
      cursor = page.cursor;
    }
    assert.deepEqual(paged, all.changes);
    assert.equal((await request(s, 'GET', '/api/files/changes?after=-1')).status, 400);
    assert.equal((await request(s, 'GET', '/api/files/changes?limit=0')).status, 400);
  } finally {
    await s.close();
  }
});

test('If-Match is checked again with the claim held: a change that slips in after the first check wins, nothing is recorded', async () => {
  const { Store } = await import('../src/store.js');
  const { resolveWorkspace } = await import('../src/workspace.js');
  const { createWorkspace, httpAgent } = await import('../src/server/fs.js');
  const dir = repo({ 'a.txt': 'base\n' });
  const ws = resolveWorkspace(dir);
  const real = new Store(ws.stateDir);
  // Another process (a hook in warn mode, a person in an editor) writes the
  // file right after the claim, before our rename.
  let sneak = null;
  const store = new Proxy(real, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      if (k !== 'claim' || typeof v !== 'function') return typeof v === 'function' ? v.bind(t) : v;
      return (...args) => {
        const r = v.apply(t, args);
        if (sneak) fs.writeFileSync(path.join(dir, 'a.txt'), sneak);
        return r;
      };
    },
  });
  try {
    const w = createWorkspace({ store, ws });
    sneak = 'theirs\n';
    assert.throws(() => w.write(httpAgent('me'), 'a.txt', Buffer.from('mine\n'), { expect: sha1('base\n') }), (e) => e.status === 412 && e.extra.current_sha === sha1('theirs\n'));
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'theirs\n', 'their bytes survive');
    assert.deepEqual(real.allChanges(), [], 'nothing recorded');
    assert.deepEqual(real.pendingOf('http:me'), [], 'no snapshot left open');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);

    sneak = 'theirs again\n';
    assert.throws(() => w.remove(httpAgent('me'), 'a.txt', { expect: sha1('theirs\n') }), (e) => e.status === 412);
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'theirs again\n');
    assert.deepEqual(real.allChanges(), []);
  } finally {
    real.close();
  }
});
