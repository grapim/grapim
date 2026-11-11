import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { inspect } from 'node:util';

import { Grapim, NotFoundError, PermissionDeniedError, PreconditionFailedError, AuthenticationError, GrapimError } from '../src/index.js';
import { startFakeServer } from './fake-server.js';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

let fake;
let grapim;
let ws;
let write; // { token }
let files; // a WorkspaceClient with a write token

before(async () => {
  fake = await startFakeServer();
  grapim = new Grapim({ apiKey: fake.apiKey, baseUrl: fake.url, baseDelayMs: 5 });
  ws = await grapim.workspaces.create({ external_id: 'cust_files', name: 'files' });
  write = await grapim.tokens.create(ws.id, { scope: 'write' });
  files = Grapim.workspace({ url: ws.url, token: write.token, agent: 'fixer', intent: 'Fix the README', baseDelayMs: 5 });
});
after(() => fake.close());
beforeEach(() => fake.reset());

const wsPath = (p) => new URL(ws.url).pathname + p;

describe('workspace file client', () => {
  test('write then read round-trips bytes and sha; headers carry the token and agent', async () => {
    const w = await files.write('README.md', '# Hello\n', { ifMatch: 'absent' });
    assert.equal(w.sha, sha1('# Hello\n'));
    const put = fake.requests.at(-1);
    assert.equal(put.method, 'PUT');
    assert.equal(put.path, wsPath('fs/README.md'));
    assert.equal(put.headers.authorization, `Bearer ${write.token}`);
    assert.equal(put.headers['x-grapim-agent'], 'fixer');
    assert.equal(put.headers['x-grapim-intent'], 'Fix the README');
    assert.equal(put.headers['if-match'], '"absent"');
    assert.equal(put.headers['content-type'], 'application/octet-stream');
    assert.equal(put.headers['idempotency-key'], undefined);

    const r = await files.read('README.md');
    assert.ok(r.content instanceof Uint8Array);
    assert.equal(new TextDecoder().decode(r.content), '# Hello\n');
    assert.equal(r.sha, w.sha);
    assert.equal((await files.readText('README.md')).text, '# Hello\n');
  });

  test('a stale ifMatch is a PreconditionFailedError with currentSha, and nothing is written', async () => {
    const { sha } = await files.read('README.md');
    await files.write('README.md', '# Hello again\n', { ifMatch: sha });
    const e = await files.write('README.md', '# Lost update\n', { ifMatch: sha }).catch((x) => x);
    assert.ok(e instanceof PreconditionFailedError);
    assert.equal(e.code, 'precondition_failed');
    assert.equal(e.status, 412);
    assert.equal(e.currentSha, sha1('# Hello again\n'));
    assert.equal((await files.readText('README.md')).text, '# Hello again\n');
    // "absent" on an existing file fails too, with the file's sha.
    const e2 = await files.write('README.md', 'x', { ifMatch: null }).catch((x) => x);
    assert.equal(e2.currentSha, sha1('# Hello again\n'));
  });

  test('ifMatch accepts an ETag with quotes and refuses junk before sending', async () => {
    const { sha } = await files.read('README.md');
    await files.write('README.md', '# Quoted\n', { ifMatch: `"${sha}"` });
    assert.equal(fake.requests.at(-1).headers['if-match'], `"${sha}"`);
    const n = fake.requests.length;
    await assert.rejects(files.write('README.md', 'x', { ifMatch: 'nope' }), GrapimError);
    assert.equal(fake.requests.length, n);
  });

  test('paths are encoded segment by segment', async () => {
    await files.write('docs/a b/naïve #1.txt', new Uint8Array([1, 2, 3]));
    assert.equal(fake.requests.at(-1).path, wsPath('fs/docs/a%20b/na%C3%AFve%20%231.txt'));
    const r = await files.read('docs/a b/naïve #1.txt');
    assert.deepEqual([...r.content], [1, 2, 3]);
  });

  test('list: a folder, and recursive', async () => {
    const root = await files.list();
    assert.equal(fake.requests.at(-1).path, wsPath('fs/'));
    assert.deepEqual(root.map((e) => [e.name, e.type]), [['docs', 'dir'], ['README.md', 'file']]);
    const docs = await files.list('docs');
    assert.equal(fake.requests.at(-1).path, wsPath('fs/docs/'));
    assert.equal(docs[0].type, 'dir');
    const all = await files.list('', { recursive: true });
    assert.equal(fake.requests.at(-1).path, wsPath('api/files'));
    assert.equal(new URLSearchParams(fake.requests.at(-1).query).get('recursive'), '1');
    assert.equal(all.truncated, false);
    assert.deepEqual(all.files.map((f) => f.path), ['README.md', 'docs/a b/naïve #1.txt']);
  });

  test('delete with ifMatch, then the file is gone', async () => {
    await files.write('tmp.txt', 'bye');
    await files.delete('tmp.txt', { ifMatch: sha1('bye') });
    assert.equal(fake.requests.at(-1).headers['if-match'], `"${sha1('bye')}"`);
    await assert.rejects(files.read('tmp.txt'), NotFoundError);
  });

  test('blame, runs, run, undo plan and apply, release', async () => {
    const b = await files.blame('README.md', { full: true });
    assert.equal(b.path, 'README.md');
    assert.equal(b.content, '# Quoted\n');
    assert.equal(new URLSearchParams(fake.requests.at(-1).query).get('full'), '1');

    const runs = await files.runs();
    const mine = runs.find((r) => r.label === 'fixer');
    assert.ok(mine, 'the agent run is listed');
    assert.match(mine.run, /^http:tok-\d+\/fixer$/);
    const detail = await files.run(mine.run);
    assert.equal(detail.run.run, mine.run);
    assert.equal(fake.requests.at(-1).path, wsPath('api/runs/' + encodeURIComponent(mine.run)));

    const plan = await files.undo(mine.run);
    assert.equal(plan.applied, false);
    assert.deepEqual(JSON.parse(fake.requests.at(-1).body), { turn: null, apply: false });
    const done = await files.undo(mine.run, { apply: true });
    assert.equal(done.applied, true);
    await assert.rejects(files.read('README.md'), NotFoundError);

    const rel = await files.release();
    assert.deepEqual(rel.released, []);
    assert.equal(fake.requests.at(-1).path, wsPath('fs/_release'));
  });

  test('busy (503) on a write is retried; 500 on undo (a POST) is not', async () => {
    fake.script((req, url) => req.method === 'PUT', [{ status: 503, headers: { 'Retry-After': '0' }, code: 'busy' }]);
    await files.write('retry.txt', 'ok');
    assert.equal(fake.requests.filter((r) => r.method === 'PUT').length, 2);
    fake.reset();
    fake.script((req, url) => url.pathname.endsWith('/undo'), [{ status: 500 }]);
    const e = await files.undo('http:whatever', { apply: true }).catch((x) => x);
    assert.equal(e.status, 500);
    assert.equal(fake.requests.length, 1);
  });

  test('a read token cannot write; a revoked token is 401', async () => {
    const ro = await grapim.tokens.create(ws.id, { scope: 'read' });
    const reader = Grapim.workspace({ url: ws.fs_url, token: ro.token });
    assert.equal(reader.url, ws.url);
    await reader.list();
    await assert.rejects(reader.write('x.txt', 'x'), PermissionDeniedError);
    await grapim.tokens.revoke(ws.id, ro.id);
    await assert.rejects(reader.list(), AuthenticationError);
  });

  test('the token stays out of inspect output', () => {
    assert.ok(!inspect(files, { depth: 10, showHidden: true }).includes(write.token));
    assert.ok(!JSON.stringify(files).includes(write.token));
  });

  test('url normalisation: url, fs_url and mcp_url all give the workspace root', () => {
    for (const u of [ws.url, ws.fs_url, ws.mcp_url, ws.url.slice(0, -1), ws.url + '?x=1']) {
      assert.equal(Grapim.workspace({ url: u, token: 'gws_x' }).url, ws.url);
    }
    assert.throws(() => Grapim.workspace({ url: ws.url }), GrapimError);
    assert.throws(() => Grapim.workspace({ url: ws.url, token: 'gws_x', agent: 'bad\nname' }), GrapimError);
  });
});
