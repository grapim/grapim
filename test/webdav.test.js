// WebDAV (src/server/webdav.js): a workspace mounted as a network drive.
// Against a local `grapim serve` and an in-process hub workspace (GitHub
// mocked, as in test/workspaces.test.js). No native client runs here: the
// requests are the ones Explorer, Finder and davfs2 send, written by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../src/hub/server.js';
import { startServer } from '../src/server/index.js';
import { createGuard } from '../src/server/security.js';
import { davClient, davRel, isJunk, parseXml } from '../src/server/webdav.js';
import { mountPlan } from '../src/mount.js';

const ORIGIN = 'http://localhost:7999';
const WIN_UA = 'Microsoft-WebDAV-MiniRedir/10.0.26100';
const MAC_UA = 'WebDAVFS/3.0.0 (03008000) Darwin/23.1.0 (arm64)';
const LINUX_UA = 'davfs2/1.7.0 neon/0.32.5';
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---------------------------------------------------------------- a tiny XML check

// Well formed (every tag closed in order), then the multistatus as
// [{ href, props: { name: inner }, missing: [names] }], with whatever prefix
// the server gave DAV:.
function multistatus(xml) {
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>/);
  const stack = [];
  for (const m of xml.replace(/^<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([A-Za-z_][\w.-]*(?::[\w.-]+)?)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2], `unbalanced </${m[2]}> in ${xml}`);
    else stack.push(m[2]);
  }
  assert.equal(stack.length, 0, `unclosed ${stack.join(', ')}`);
  const p = /xmlns:(\w+)="DAV:"/.exec(xml)[1];
  assert.match(xml, new RegExp(`<${p}:multistatus`));
  const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return [...xml.matchAll(new RegExp(`<${p}:response>([\\s\\S]*?)</${p}:response>`, 'g'))].map(([, body]) => {
    const href = decodeURI(unescape(new RegExp(`<${p}:href>([^<]*)</${p}:href>`).exec(body)[1]));
    const props = {};
    const missing = [];
    for (const [, inner, status] of body.matchAll(new RegExp(`<${p}:propstat><${p}:prop>([\\s\\S]*?)</${p}:prop><${p}:status>([^<]*)</${p}:status></${p}:propstat>`, 'g'))) {
      for (const m of inner.matchAll(new RegExp(`<${p}:(\\w+)(?:/>|>([\\s\\S]*?)</${p}:\\1>)`, 'g'))) {
        if (/200/.test(status)) props[m[1]] = unescape(m[2] ?? '');
        else missing.push(m[1]);
      }
    }
    return { href, props, missing };
  });
}

// ---------------------------------------------------------------- requests

// One request with the target sent exactly as written.
function request(port, method, target, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
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

const basic = (token, user = 'grapim') => `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
const PROPFIND_WIN = `<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:creationdate/><D:getcontentlength/><D:getlastmodified/><D:resourcetype/><D:getetag/><D:displayname/><D:isroot/></D:prop></D:propfind>`;
const LOCK_BODY = `<?xml version="1.0" encoding="utf-8" ?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>DESKTOP\\ana</D:href></D:owner></D:lockinfo>`;

// A DAV client: a User-Agent, maybe credentials, under a base ("" or /w/<team>/<ws>).
function client(port, base, { ua = WIN_UA, auth = null } = {}) {
  const send = (method, p, { headers = {}, body } = {}) =>
    request(port, method, `${base}/dav/${p}`, { headers: { 'User-Agent': ua, ...(auth ? { Authorization: auth } : {}), ...headers }, body });
  return {
    send,
    options: (p = '') => send('OPTIONS', p),
    propfind: (p, depth = '1', body = PROPFIND_WIN) => send('PROPFIND', p, { headers: { Depth: depth, 'Content-Type': 'text/xml' }, body }),
    get: (p) => send('GET', p),
    put: (p, body, headers = {}) => send('PUT', p, { body, headers }),
    del: (p, headers = {}) => send('DELETE', p, { headers }),
    mkcol: (p) => send('MKCOL', p),
    move: (p, dest, headers = {}) => send('MOVE', p, { headers: { Destination: dest, ...headers } }),
    copy: (p, dest, headers = {}) => send('COPY', p, { headers: { Destination: dest, ...headers } }),
    lock: (p, headers = {}, body = LOCK_BODY) => send('LOCK', p, { headers: { Timeout: 'Second-3600', Depth: '0', ...headers }, body }),
    unlock: (p, token) => send('UNLOCK', p, { headers: { 'Lock-Token': `<${token}>` } }),
    proppatch: (p, headers = {}) =>
      send('PROPPATCH', p, {
        headers,
        body: `<?xml version="1.0" encoding="utf-8" ?><D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:"><D:set><D:prop><Z:Win32CreationTime>Wed, 11 Nov 2026 10:00:00 GMT</Z:Win32CreationTime><Z:Win32FileAttributes>00000020</Z:Win32FileAttributes></D:prop></D:set></D:propertyupdate>`,
      }),
  };
}

// ---------------------------------------------------------------- local serve

function repo(files = { 'README.md': 'hello\n' }) {
  const dir = tmp('grapim-dav-');
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

async function serve(t, opts = {}) {
  const dir = repo(opts.files);
  const s = await startServer({ cwd: dir, port: 0, env: {}, uiDir: path.join(dir, 'no-ui-here'), ...opts });
  t.after(() => s.close());
  return { s, dir, port: s.port };
}

const runsOf = async (port, headers = {}) => (await request(port, 'GET', '/api/runs', { headers })).json();

test('OPTIONS answers DAV 1, 2, MS-Author-Via and the methods', async (t) => {
  const { port } = await serve(t);
  const r = await client(port, '').options();
  assert.equal(r.status, 200);
  assert.equal(r.headers.dav, '1, 2');
  assert.equal(r.headers['ms-author-via'], 'DAV');
  for (const m of ['PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'PUT', 'DELETE']) assert.match(r.headers.allow, new RegExp(`\\b${m}\\b`));
  // The bare /dav too (Explorer asks for it without the slash).
  assert.equal((await request(port, 'OPTIONS', '/dav', { headers: { 'User-Agent': WIN_UA } })).status, 200);
});

test('PROPFIND: Depth 0 and 1 give well-formed multistatus in formats Explorer accepts; Depth infinity is refused', async (t) => {
  const { port, dir } = await serve(t, { files: { 'README.md': 'hello\n', 'docs/a b.md': 'x', 'docs/ü.txt': 'y' } });
  const c = client(port, '');

  const root = await c.propfind('', '0');
  assert.equal(root.status, 207, root.text);
  assert.match(root.headers['content-type'], /^application\/xml/);
  const [self] = multistatus(root.text);
  assert.equal(self.href, '/dav/');
  assert.equal(self.props.resourcetype, '<D:collection/>'.replace(/D:/, `${/xmlns:(\w+)="DAV:"/.exec(root.text)[1]}:`));
  assert.ok(self.missing.includes('isroot'), 'an unknown property is listed as 404');

  const list = multistatus((await c.propfind('', '1')).text);
  const byHref = Object.fromEntries(list.map((e) => [e.href, e]));
  assert.ok(byHref['/dav/docs/'], 'folders end in /');
  assert.equal(byHref['/dav/.git/'], undefined, '.git is never listed');
  const readme = byHref['/dav/README.md'];
  assert.equal(readme.props.getcontentlength, '6');
  assert.equal(readme.props.getetag, `"${sha1('hello\n')}"`);
  assert.equal(readme.props.displayname, 'README.md');
  // RFC 1123 dates for getlastmodified, ISO 8601 without milliseconds for creationdate.
  assert.match(readme.props.getlastmodified, /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
  assert.equal(new Date(readme.props.getlastmodified).getTime(), Math.floor(fs.statSync(path.join(dir, 'README.md')).mtimeMs / 1000) * 1000);
  assert.match(readme.props.creationdate, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(readme.props.resourcetype, '');

  // Names are percent-encoded in hrefs and come back intact.
  const docs = multistatus((await c.propfind('docs/', '1')).text).map((e) => e.href).sort();
  assert.deepEqual(docs, ['/dav/docs/', '/dav/docs/a b.md', '/dav/docs/ü.txt']);
  assert.match((await c.propfind('docs/', '1')).text, /a%20b\.md/);

  // allprop (no body) and propname.
  const all = multistatus((await c.propfind('README.md', '0', '')).text)[0];
  for (const p of ['getetag', 'getlastmodified', 'creationdate', 'getcontentlength', 'supportedlock', 'lockdiscovery']) assert.ok(p in all.props, p);
  const names = await c.propfind('README.md', '0', '<?xml version="1.0"?><propfind xmlns="DAV:"><propname/></propfind>');
  assert.equal(names.status, 207);
  assert.ok('getetag' in multistatus(names.text)[0].props);

  for (const depth of ['infinity', 'Infinity']) {
    const inf = await c.propfind('', depth);
    assert.equal(inf.status, 403);
    assert.match(inf.text, /propfind-finite-depth/);
  }
  const none = await c.send('PROPFIND', '', { body: PROPFIND_WIN });
  assert.equal(none.status, 403, 'no Depth header means infinity');
  assert.equal((await c.propfind('missing.txt', '0')).status, 404);
  // XML with a DOCTYPE (entity expansion, XXE) is refused.
  const xxe = await c.propfind('', '0', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>');
  assert.equal(xxe.status, 400);
});

test('PUT and GET round trip as http:dav-<client>, recorded, and undone through the API', async (t) => {
  const { port, dir } = await serve(t);
  const c = client(port, '');
  const put = await c.put('notes.md', 'one\ntwo\n');
  assert.equal(put.status, 201, put.text);
  assert.equal(put.headers.etag, `"${sha1('one\ntwo\n')}"`);
  assert.equal(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8'), 'one\ntwo\n');
  const again = await c.put('notes.md', 'one\nTWO\n');
  assert.equal(again.status, 204);
  const got = await c.get('notes.md');
  assert.equal(got.status, 200);
  assert.equal(got.text, 'one\nTWO\n');
  assert.equal(got.headers.etag, `"${sha1('one\nTWO\n')}"`);
  assert.equal(got.headers['content-type'], 'application/octet-stream');

  // A header naming another agent does not change who the drive is.
  await c.put('b.txt', 'b', { 'X-Grapim-Agent': 'someone-else' });
  await client(port, '', { ua: MAC_UA }).put('mac.txt', 'm');
  await client(port, '', { ua: LINUX_UA }).put('linux.txt', 'l');
  await client(port, '', { ua: 'gvfs/1.52.0' }).put('gnome.txt', 'g');
  const runs = (await runsOf(port)).map((r) => r.run).sort();
  assert.deepEqual(runs, ['http:dav-dav', 'http:dav-linux', 'http:dav-macos', 'http:dav-windows']);

  // Without a lock, a drive's write keeps no claim: an /fs agent can edit next.
  const fsPut = await request(port, 'PUT', '/fs/notes.md', { headers: { 'X-Grapim-Agent': 'bot' }, body: 'bot\n' });
  assert.equal(fsPut.status, 200, fsPut.text);

  const undo = await request(port, 'POST', `/api/runs/${encodeURIComponent('http:dav-windows')}/undo`, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apply: true }) });
  assert.equal(undo.status, 200, undo.text);
  assert.equal(fs.existsSync(path.join(dir, 'b.txt')), false);

  // Parent folders must exist (409), and a folder is not a file.
  assert.equal((await c.put('no/such/dir.txt', 'x')).status, 409);
  fs.mkdirSync(path.join(dir, 'folder'));
  assert.equal((await c.put('folder', 'x')).status, 405);
});

test('MKCOL, then MOVE and COPY of files and folders, each recorded in the drive\'s run', async (t) => {
  const { port, dir } = await serve(t);
  const c = client(port, '');
  assert.equal((await c.mkcol('reports')).status, 201);
  assert.ok(fs.statSync(path.join(dir, 'reports')).isDirectory());
  assert.equal((await c.mkcol('reports')).status, 405, 'exists');
  assert.equal((await c.mkcol('a/b')).status, 409, 'parent missing');
  assert.equal((await c.send('MKCOL', 'withbody', { body: '<x/>' })).status, 415);

  assert.equal((await c.put('reports/q1.md', 'q1\n')).status, 201);
  // Explorer's rename: an absolute URL with the same host.
  const mv = await c.move('reports/q1.md', `http://127.0.0.1:${port}/dav/reports/Q1%20final.md`);
  assert.equal(mv.status, 201, mv.text);
  assert.equal(fs.existsSync(path.join(dir, 'reports', 'q1.md')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'reports', 'Q1 final.md'), 'utf8'), 'q1\n');

  const cp = await c.copy('reports/Q1 final.md'.replace(' ', '%20'), '/dav/reports/copy.md');
  assert.equal(cp.status, 201, cp.text);
  assert.equal(fs.readFileSync(path.join(dir, 'reports', 'copy.md'), 'utf8'), 'q1\n');
  // Overwrite: F refuses an existing destination.
  assert.equal((await c.copy('reports/copy.md', '/dav/reports/Q1%20final.md', { Overwrite: 'F' })).status, 412);

  // A folder: renamed with everything in it, then copied.
  await c.put('reports/sub.txt', 's');
  const mvDir = await c.move('reports/', '/dav/archive/');
  assert.equal(mvDir.status, 201, mvDir.text);
  assert.equal(fs.existsSync(path.join(dir, 'reports')), false);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'archive')).sort(), ['Q1 final.md', 'copy.md', 'sub.txt']);
  const cpDir = await c.copy('archive', '/dav/archive2');
  assert.equal(cpDir.status, 201, cpDir.text);
  assert.equal(fs.readFileSync(path.join(dir, 'archive2', 'sub.txt'), 'utf8'), 's');
  assert.equal((await c.move('archive/', '/dav/archive/inside/')).status, 403, 'not into itself');

  const detail = (await request(port, 'GET', `/api/runs/${encodeURIComponent('http:dav-windows')}`)).json();
  const paths = detail.files.map((f) => f.path).sort();
  for (const p of ['reports/q1.md', 'reports/Q1 final.md', 'reports/copy.md', 'archive/sub.txt', 'archive2/sub.txt', 'reports/sub.txt']) assert.ok(paths.includes(p), `${p} in ${paths.join(', ')}`);

  // DELETE of a folder removes its files (recorded) and the folder.
  assert.equal((await c.del('archive2/')).status, 204);
  assert.equal(fs.existsSync(path.join(dir, 'archive2')), false);
  assert.equal((await c.del('')).status, 403, 'never the root');
  assert.equal((await c.del('missing.txt')).status, 404);
  // The whole run undoes: back to the start.
  const undo = await request(port, 'POST', `/api/runs/${encodeURIComponent('http:dav-windows')}/undo`, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apply: true }) });
  assert.equal(undo.status, 200, undo.text);
  for (const p of ['archive/sub.txt', 'archive2/sub.txt', 'reports/copy.md']) assert.equal(fs.existsSync(path.join(dir, p)), false, p);
});

test('LOCK claims the file in the ledger; another client\'s PUT is 423; UNLOCK releases; Windows lock, 0 bytes, content', async (t) => {
  const { port, dir } = await serve(t);
  const win = client(port, '');
  const mac = client(port, '', { ua: MAC_UA });
  await win.put('plan.md', 'v1\n');

  const l = await win.lock('plan.md');
  assert.equal(l.status, 200, l.text);
  const token = /^<(.+)>$/.exec(l.headers['lock-token'])[1];
  assert.match(token, /^opaquelocktoken:/);
  const disc = parseXml(l.text);
  assert.equal(disc.name, 'prop');
  assert.match(l.text, /<D:timeout>Second-1[78]\d\d<\/D:timeout>/, 'capped at 30 minutes');
  assert.match(l.text, /DESKTOP\\ana/);

  // In the ledger: the drive holds the file, so /fs agents get 409.
  const leases = (await request(port, 'GET', '/api/overview')).json();
  assert.ok(JSON.stringify(leases).includes('plan.md'));
  const fsPut = await request(port, 'PUT', '/fs/plan.md', { headers: { 'X-Grapim-Agent': 'bot' }, body: 'bot' });
  assert.equal(fsPut.status, 409, fsPut.text);

  // Another client: 423 for PUT, DELETE, MOVE and a second LOCK.
  assert.equal((await mac.put('plan.md', 'mac')).status, 423);
  assert.equal((await mac.del('plan.md')).status, 423);
  assert.equal((await mac.move('plan.md', '/dav/moved.md')).status, 423);
  assert.equal((await mac.lock('plan.md')).status, 423);
  // The same client without the token in If: 423 too (two PCs on one token).
  assert.equal((await win.put('plan.md', 'no token')).status, 423);
  // A token in the If header does not help another agent.
  assert.equal((await mac.put('plan.md', 'mac', { If: `(<${token}>)` })).status, 423);
  // PROPFIND shows the lock.
  assert.match((await win.propfind('plan.md', '0', '')).text, new RegExp(token));

  // With the token: written, and the claim stays for the rest of the lock.
  const ok = await win.put('plan.md', 'v2\n', { If: `<http://127.0.0.1:${port}/dav/plan.md> (<${token}>)` });
  assert.equal(ok.status, 204, ok.text);
  assert.equal((await request(port, 'PUT', '/fs/plan.md', { headers: { 'X-Grapim-Agent': 'bot' }, body: 'bot' })).status, 409);
  // Refresh: no body, the token in If.
  const refresh = await win.lock('plan.md', { If: `(<${token}>)`, Timeout: 'Second-60' }, '');
  assert.equal(refresh.status, 200, refresh.text);
  assert.match(refresh.text, /Second-(59|60)/);
  assert.equal((await win.lock('plan.md', { If: '(<opaquelocktoken:nope>)' }, '')).status, 412);
  // PROPPATCH (Windows sets file times after a save): 207, accepted and ignored.
  const pp = await win.proppatch('plan.md', { If: `(<${token}>)` });
  assert.equal(pp.status, 207, pp.text);
  assert.match(pp.text, /Win32CreationTime/);
  assert.match(pp.text, /200 OK/);

  // UNLOCK: only with the right token, by the same agent.
  assert.equal((await mac.unlock('plan.md', token)).status, 403);
  assert.equal((await win.unlock('plan.md', 'opaquelocktoken:wrong')).status, 409);
  assert.equal((await win.unlock('plan.md', token)).status, 204);
  assert.equal((await mac.put('plan.md', 'mac\n')).status, 204);
  assert.equal(fs.readFileSync(path.join(dir, 'plan.md'), 'utf8'), 'mac\n');

  // Windows saving a new file: LOCK an unmapped name (created empty), PUT 0
  // bytes, PUT the content, UNLOCK.
  const nl = await win.lock('new.docx');
  assert.equal(nl.status, 201, nl.text);
  const nt = /^<(.+)>$/.exec(nl.headers['lock-token'])[1];
  assert.equal(fs.readFileSync(path.join(dir, 'new.docx')).length, 0);
  assert.equal((await win.put('new.docx', '', { If: `(<${nt}>)` })).status, 204);
  assert.equal((await win.put('new.docx', 'content', { If: `(<${nt}>)` })).status, 204);
  assert.equal((await win.unlock('new.docx', nt)).status, 204);
  assert.equal(fs.readFileSync(path.join(dir, 'new.docx'), 'utf8'), 'content');
  const detail = (await request(port, 'GET', `/api/runs/${encodeURIComponent('http:dav-windows')}`)).json();
  assert.ok(detail.files.some((f) => f.path === 'new.docx'));
  // Folders cannot be locked; shared locks are not offered.
  fs.mkdirSync(path.join(dir, 'f'));
  assert.equal((await win.lock('f/')).status, 403);
  assert.equal((await win.lock('x.txt', {}, LOCK_BODY.replace('<D:exclusive/>', '<D:shared/>'))).status, 412);
});

test('desktop.ini, Thumbs.db, .DS_Store and ._* are accepted in memory, never stored or recorded', async (t) => {
  const { port, dir } = await serve(t);
  const c = client(port, '');
  await c.mkcol('pics');
  for (const name of ['desktop.ini', 'pics/Thumbs.db', '.DS_Store', 'pics/._photo.jpg']) {
    const r = await c.put(name.split('/').map(encodeURIComponent).join('/'), 'junk');
    assert.equal(r.status, 201, `${name}: ${r.text}`);
    assert.equal(fs.existsSync(path.join(dir, ...name.split('/'))), false, `${name} is not on disk`);
  }
  assert.equal((await c.get('desktop.ini')).text, 'junk', 'the client can read back what it wrote');
  const listed = multistatus((await c.propfind('pics/', '1')).text).map((e) => e.href);
  assert.ok(listed.includes('/dav/pics/Thumbs.db'));
  assert.equal((await c.del('desktop.ini')).status, 204);
  assert.equal((await c.get('desktop.ini')).status, 404);
  assert.deepEqual(await runsOf(port), [], 'nothing recorded');
  assert.equal(isJunk('a/._x'), true);
  assert.equal(isJunk('a/notes.ini'), false);
});

test('paths: traversal, escaped slashes, .git, and Destination headers outside the workspace or host are refused', async (t) => {
  const { port, dir } = await serve(t);
  const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside.txt`);
  const c = client(port, '');
  await c.put('in.txt', 'in');
  for (const p of ['../x.txt', '%2e%2e/x.txt', 'a/%2e%2e/%2e%2e/x.txt', '..%2Fx.txt', 'a%2F..%2F..%2Fx.txt', '..%5Cx.txt', '.git/config', '.GIT/config', '.git%2Fconfig', 'git~1/config', 'a//b.txt', '%00.txt']) {
    for (const m of ['PUT', 'GET', 'PROPFIND', 'DELETE', 'MKCOL', 'LOCK']) {
      const r = await c.send(m, p, { headers: { Depth: '0' }, body: m === 'PUT' ? 'x' : undefined });
      assert.ok(r.status >= 400 && r.status < 500 && r.status !== 404, `${m} ${p}: ${r.status} ${r.text}`);
    }
  }
  assert.equal(fs.existsSync(outside), false);
  assert.equal(fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').startsWith('ref:'), true);

  // Destination: another host, another base, traversal, a scheme, userinfo.
  const dests = [
    'http://evil.example/dav/x.txt',
    `http://user@127.0.0.1:${port}/dav/x.txt`,
    'ftp://127.0.0.1/dav/x.txt',
    '/elsewhere/x.txt',
    '/dav/../x.txt',
    '/dav/%2e%2e/x.txt',
    '/dav/a%2F..%2F..%2Fx.txt',
    `http://127.0.0.1:${port}/dav/../../x.txt`,
    '/dav/.git/hooks/pre-commit',
    'x.txt',
  ];
  for (const d of dests) {
    for (const m of ['MOVE', 'COPY']) {
      const r = await c.send(m, 'in.txt', { headers: { Destination: d } });
      assert.ok([400, 403, 502].includes(r.status), `${m} -> ${d}: ${r.status} ${r.text}`);
    }
  }
  assert.equal(fs.readFileSync(path.join(dir, 'in.txt'), 'utf8'), 'in');
  assert.equal(davRel('a%20b/c%C3%BC'), 'a b/cü');
  assert.throws(() => davRel('a%2Fb'), /escaped slash/);
});

test('sensitive files are refused through every DAV write', async (t) => {
  const { port, dir } = await serve(t);
  const c = client(port, '');
  await c.put('ok.txt', 'ok');
  await c.mkcol('.claude');
  await c.mkcol('.vscode');
  for (const p of ['.envrc', '.claude/settings.json', '.claude/settings.local.json', '.vscode/tasks.json', 'HEAD']) {
    assert.equal((await c.put(p, 'x')).status, 403, `PUT ${p}`);
    assert.equal((await c.lock(p)).status, 403, `LOCK ${p}`);
    assert.equal((await c.move('ok.txt', `/dav/${p}`)).status, 403, `MOVE -> ${p}`);
    assert.equal((await c.copy('ok.txt', `/dav/${p}`)).status, 403, `COPY -> ${p}`);
    assert.equal(fs.existsSync(path.join(dir, ...p.split('/'))), false, p);
  }
  // A folder holding one is not deleted or moved, not even in part.
  fs.writeFileSync(path.join(dir, '.envrc'), 'export A=1\n');
  fs.mkdirSync(path.join(dir, 'proj'));
  fs.writeFileSync(path.join(dir, 'proj', 'a.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'proj', '.envrc'), 'x');
  assert.equal((await c.del('proj/')).status, 403);
  assert.equal((await c.move('proj/', '/dav/proj2/')).status, 403);
  assert.equal(fs.readFileSync(path.join(dir, 'proj', 'a.txt'), 'utf8'), 'a');
  assert.equal((await c.del('.envrc')).status, 403);
});

test('grapim serve: with GRAPIM_TOKEN the drive signs in with Basic (token as password); /dav answers this machine only', async (t) => {
  const token = 'local-token-0123456789abcdef';
  const { port } = await serve(t, { token });
  const none = await client(port, '').propfind('', '0');
  assert.equal(none.status, 401);
  assert.equal(none.headers['www-authenticate'], 'Basic realm="Grapim"');
  assert.equal((await client(port, '', { auth: basic('wrong-token-0123456789') }).propfind('', '0')).status, 401);
  assert.equal((await client(port, '', { auth: basic(token, 'anyone') }).propfind('', '0')).status, 207);
  assert.equal((await client(port, '', { auth: `Bearer ${token}` }).put('x.txt', 'x')).status, 201);

  // From another machine: refused before the token is even looked at.
  const guard = createGuard({ host: '0.0.0.0', env: {}, token });
  const fake = (addr) => ({ method: 'PROPFIND', headers: { host: '127.0.0.1:7420', authorization: basic(token) }, socket: { remoteAddress: addr } });
  assert.throws(() => guard(fake('192.168.1.20'), { dav: true }), /only this machine/);
  assert.doesNotThrow(() => guard(fake('::ffff:127.0.0.1'), { dav: true }));
  // A web page cannot drive it (no CORS, Origin refused).
  const site = await client(port, '', { auth: basic(token) }).send('PUT', 'y.txt', { headers: { Origin: 'http://evil.example' }, body: 'y' });
  assert.equal(site.status, 403);
});

test('davClient and the XML reader', () => {
  assert.equal(davClient(WIN_UA), 'windows');
  assert.equal(davClient(MAC_UA), 'macos');
  assert.equal(davClient(LINUX_UA), 'linux');
  assert.equal(davClient('gvfs/1.52'), 'dav');
  assert.equal(davClient(undefined), 'dav');
  const x = parseXml('<?xml version="1.0"?><a:propfind xmlns:a="DAV:" xmlns:b="urn:x"><a:prop><b:thing/><a:getetag/></a:prop></a:propfind>');
  assert.equal(x.ns, 'DAV:');
  assert.deepEqual(x.children[0].children.map((c) => [c.ns, c.name]), [['urn:x', 'thing'], ['DAV:', 'getetag']]);
  assert.throws(() => parseXml('<a><b></a>'), /well formed/);
  assert.throws(() => parseXml('<x:a/>'), /undeclared/);
  assert.throws(() => parseXml('<!DOCTYPE a><a/>'), /DOCTYPE/);
});

// ---------------------------------------------------------------- the hub

function fakeGitHub() {
  const codes = new Map();
  const fetch = async (url, init = {}) => {
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://github.com/login/oauth/access_token') {
      const { code } = JSON.parse(init.body);
      return codes.has(code) ? reply(200, { access_token: `gho_${code}` }) : reply(200, { error: 'bad_verification_code' });
    }
    if (url === 'https://api.github.com/user') {
      const u = codes.get(String(init.headers?.Authorization || '').replace('Bearer gho_', ''));
      return u ? reply(200, u) : reply(401, {});
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, user: (code, profile) => codes.set(code, profile) };
}

async function startHub(t, env = {}) {
  const gh = fakeGitHub();
  const dir = tmp('grapim-dav-hub-');
  const hub = await createHub({
    env: { HUB_URL: ORIGIN, HUB_SECRET: 'test-secret-that-is-long-enough-0123456789', HUB_DATA: dir, GITHUB_CLIENT_ID: 'gh-client', GITHUB_CLIENT_SECRET: 'gh-secret', ...env },
    fetch: gh.fetch,
    billing: null,
    storage: null,
    log: () => {},
  });
  const addr = await hub.listen(0, '127.0.0.1');
  t.after(() => hub.close());
  return { hub, port: addr.port, base: `http://127.0.0.1:${addr.port}`, gh, dir };
}

class Browser {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }
  async req(p, { method = 'GET', form = null } = {}) {
    const h = {};
    if (this.jar.size) h.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (method !== 'GET') h.Origin = ORIGIN;
    if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(this.base + p, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (/Max-Age=0/i.test(c)) this.jar.delete(pair.slice(0, i));
      else this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  }
  async post(p, form = {}) {
    const csrf = JSON.parse((await this.req('/hub/api/me')).text).csrf;
    return this.req(p, { method: 'POST', form: { _csrf: csrf, ...form } });
  }
}

let nextId = 9000;
async function hubWorkspace(h, name = 'drive') {
  const id = nextId++;
  h.gh.user(`code-${id}`, { id, login: `dav${id}`, name: 'x', avatar_url: null });
  const b = new Browser(h.base);
  const start = await b.req('/hub/auth/github');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  assert.equal((await b.req(`/hub/auth/callback?code=code-${id}&state=${state}`)).status, 303);
  const tr = await b.post('/hub/teams', { name: `Team ${id}` });
  const team = tr.headers.get('location').match(/\/hub\/teams\/([^/]+)\/settings/)[1];
  const wr = await b.post(`/hub/teams/${team}/workspaces`, { name });
  assert.equal(wr.status, 303, wr.text);
  const wsId = wr.headers.get('location').match(/\/workspaces\/([^/]+)$/)[1];
  const token = async (tname, scope = 'write') => {
    const r = await b.post(`/hub/teams/${team}/workspaces/${wsId}/tokens`, { name: tname, scope });
    assert.equal(r.status, 200, r.text);
    return r.text.match(/value="(gws_[A-Za-z0-9_-]+)"/)[1];
  };
  return { browser: b, team, id: wsId, name, base: `/w/${team}/${name}`, dir: path.join(h.dir, 'workspaces', team, wsId), token };
}

test('hub: Basic auth with a workspace token; 401 challenge with the realm; read tokens are read-only; cookies are ignored', async (t) => {
  const h = await startHub(t);
  const ws = await hubWorkspace(h, 'drive');
  const writer = await ws.token('laptop');
  const reader = await ws.token('viewer', 'read');

  const anon = await client(h.port, ws.base).propfind('', '0');
  assert.equal(anon.status, 401);
  assert.equal(anon.headers['www-authenticate'], 'Basic realm="Grapim workspace drive"');
  const wrong = await client(h.port, ws.base, { auth: basic('gws_not-a-real-token') }).propfind('', '0');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers['www-authenticate'], 'Basic realm="Grapim workspace drive"');
  // A token of another workspace: 401 too, so the drive asks again.
  const other = await hubWorkspace(h, 'other');
  const otherToken = await other.token('x');
  assert.equal((await client(h.port, ws.base, { auth: basic(otherToken) }).propfind('', '0')).status, 401);
  // The signed-in browser's cookie means nothing on /dav.
  const cookie = [...ws.browser.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const withCookie = await request(h.port, 'PROPFIND', `${ws.base}/dav/`, { headers: { Cookie: cookie, Depth: '0' } });
  assert.equal(withCookie.status, 401);

  // The workspace page shows the address and the steps.
  // The Connect tab, "Mount as drive".
  const page = await ws.browser.req(`/hub/teams/${ws.team}/workspaces/${ws.id}/connect`);
  assert.match(page.text, /Mount as a drive/);
  assert.ok(page.text.includes(`${ORIGIN}${ws.base}/dav/`), 'the drive address');
  assert.match(page.text, /Map network drive/);
  assert.match(page.text, /FileSizeLimitInBytes/);
  assert.match(page.text, /Connect to Server/);
  assert.match(page.text, /davfs/);

  const w = client(h.port, ws.base, { auth: basic(writer) });
  assert.equal((await w.options()).headers.dav, '1, 2');
  const put = await w.put('notes.md', 'hello\n');
  assert.equal(put.status, 201, put.text);
  assert.equal(fs.readFileSync(path.join(ws.dir, 'notes.md'), 'utf8'), 'hello\n');
  const list = multistatus((await w.propfind('', '1')).text).map((e) => e.href);
  assert.ok(list.includes(`${ws.base}/dav/notes.md`), list.join(', '));
  assert.ok(!list.some((x) => x.includes('.git')));

  // The run: http:<token-name>/dav-windows; undo through the workspace API.
  const runs = JSON.parse((await request(h.port, 'GET', `${ws.base}/api/runs`, { headers: { Authorization: `Bearer ${writer}` } })).text);
  assert.deepEqual(runs.map((r) => r.run), ['http:laptop/dav-windows']);
  const undo = await request(h.port, 'POST', `${ws.base}/api/runs/${encodeURIComponent('http:laptop/dav-windows')}/undo`, {
    headers: { Authorization: `Bearer ${writer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ apply: true }),
  });
  assert.equal(undo.status, 200, undo.text);
  assert.equal(fs.existsSync(path.join(ws.dir, 'notes.md')), false);

  // A read token mounts read-only.
  await w.put('shared.txt', 'shared');
  const r = client(h.port, ws.base, { auth: basic(reader) });
  assert.equal((await r.propfind('', '1')).status, 207);
  assert.equal((await r.get('shared.txt')).text, 'shared');
  for (const [m, p, extra] of [['PUT', 'x.txt'], ['DELETE', 'shared.txt'], ['MKCOL', 'dir'], ['LOCK', 'shared.txt'], ['PROPPATCH', 'shared.txt'], ['MOVE', 'shared.txt', { Destination: `${ws.base}/dav/y.txt` }], ['COPY', 'shared.txt', { Destination: `${ws.base}/dav/y.txt` }]]) {
    const res = await r.send(m, p, { headers: extra ?? {}, body: m === 'PUT' ? 'x' : undefined });
    assert.ok(res.status === 403 || res.status === 405, `${m}: ${res.status}`);
  }
  assert.equal(fs.readFileSync(path.join(ws.dir, 'shared.txt'), 'utf8'), 'shared');
  assert.equal(fs.existsSync(path.join(ws.dir, 'x.txt')), false);

  // Destination in another workspace, or a path out of this one: refused.
  for (const d of [`${other.base}/dav/stolen.txt`, `${h.base}${other.base}/dav/stolen.txt`, `${ws.base}/dav/../../${other.name}/dav/stolen.txt`, `${ws.base}/dav/%2e%2e/x.txt`, `/w/${ws.team}/${ws.name}/fs/x.txt`]) {
    const res = await w.copy('shared.txt', d);
    assert.ok([400, 403, 502].includes(res.status), `${d}: ${res.status} ${res.text}`);
  }
  assert.equal(fs.existsSync(path.join(other.dir, 'stolen.txt')), false);
});

test('hub: Basic over plain http is refused unless it comes from this machine (behind the proxy: X-Forwarded-Proto https)', async (t) => {
  const h = await startHub(t, { TRUST_PROXY: '1' });
  const ws = await hubWorkspace(h, 'tls');
  const token = await ws.token('t');
  const send = (headers) => request(h.port, 'PROPFIND', `${ws.base}/dav/`, { headers: { Depth: '0', Authorization: basic(token), ...headers } });
  const plain = await send({ 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'http' });
  assert.equal(plain.status, 403);
  assert.match(plain.text, /https/);
  assert.equal(plain.headers['www-authenticate'], undefined, 'no password prompt over plain http');
  assert.equal((await send({ 'X-Forwarded-For': '203.0.113.7' })).status, 403);
  // A client cannot claim https in a header the proxy appends to.
  assert.equal((await send({ 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'https, http' })).status, 403);
  assert.equal((await send({ 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'https' })).status, 207);
  assert.equal((await send({})).status, 207, 'loopback, no proxy headers');
});

test('hub: LOCK maps to the claim across clients; junk files are not stored; sensitive files refused', async (t) => {
  const h = await startHub(t);
  const ws = await hubWorkspace(h, 'locks');
  const a = await ws.token('ana');
  const b = await ws.token('ben');
  const win = client(h.port, ws.base, { auth: basic(a) });
  const other = client(h.port, ws.base, { auth: basic(b), ua: MAC_UA });
  await win.put('doc.txt', 'v1');
  const l = await win.lock('doc.txt');
  assert.equal(l.status, 200, l.text);
  const token = /^<(.+)>$/.exec(l.headers['lock-token'])[1];
  assert.equal((await other.put('doc.txt', 'ben')).status, 423);
  // An agent on /fs with another token sees the claim (409).
  const fsPut = await request(h.port, 'PUT', `${ws.base}/fs/doc.txt`, { headers: { Authorization: `Bearer ${b}`, 'X-Grapim-Agent': 'bot' }, body: 'x' });
  assert.equal(fsPut.status, 409, fsPut.text);
  assert.equal((await win.put('doc.txt', 'v2', { If: `(<${token}>)` })).status, 204);
  assert.equal((await win.unlock('doc.txt', token)).status, 204);
  assert.equal((await other.put('doc.txt', 'ben')).status, 204);
  // A rename in the hub: a create and a delete, both in ana's drive run.
  const mv = await win.move('doc.txt', `http://127.0.0.1:${h.port}${ws.base}/dav/renamed.txt`);
  assert.equal(mv.status, 201, mv.text);
  assert.equal(fs.readFileSync(path.join(ws.dir, 'renamed.txt'), 'utf8'), 'ben');
  assert.equal(fs.existsSync(path.join(ws.dir, 'doc.txt')), false);

  for (const p of ['desktop.ini', 'Thumbs.db', '.DS_Store', '._doc.txt']) {
    assert.equal((await win.put(p, 'junk')).status, 201, p);
    assert.equal(fs.existsSync(path.join(ws.dir, p)), false, p);
  }
  for (const p of ['.envrc', '.claude/settings.json']) {
    if (p.includes('/')) await win.mkcol('.claude');
    assert.equal((await win.put(p, 'x')).status, 403, p);
  }
  const runs = JSON.parse((await request(h.port, 'GET', `${ws.base}/api/runs`, { headers: { Authorization: `Bearer ${a}` } })).text).map((r) => r.run).sort();
  assert.deepEqual(runs, ['http:ana/dav-windows', 'http:ben/dav-macos']);
});

test('hub: a token limited to some folders (src/scope.js) sees and writes only those through the drive', async (t) => {
  const h = await startHub(t);
  const ws = await hubWorkspace(h, 'scoped');
  const full = client(h.port, ws.base, { auth: basic(await ws.token('admin')) });
  const scopedToken = await ws.token('docs-only');
  h.hub.db.prepare('UPDATE workspace_tokens SET scopes = ? WHERE name = ?').run(JSON.stringify([{ path: 'docs/**', access: 'write' }, { path: 'ref/**', access: 'read' }]), 'docs-only');
  for (const d of ['docs', 'ref', 'secret']) await full.mkcol(d);
  for (const f of ['docs/a.md', 'ref/r.md', 'secret/s.md']) assert.equal((await full.put(f, f)).status, 201);

  const c = client(h.port, ws.base, { auth: basic(scopedToken) });
  const root = multistatus((await c.propfind('', '1')).text).map((e) => e.href);
  assert.ok(root.includes(`${ws.base}/dav/docs/`) && root.includes(`${ws.base}/dav/ref/`), root.join(', '));
  assert.ok(!root.some((x) => x.includes('secret')), 'a folder outside the scope is not listed');
  assert.equal((await c.propfind('secret/', '1')).status, 404);
  assert.equal((await c.get('secret/s.md')).status, 404);
  assert.equal((await c.put('docs/b.md', 'b')).status, 201);
  assert.equal((await c.put('ref/x.md', 'x')).status, 403);
  assert.equal((await c.put('secret/x.md', 'x')).status, 403);
  // Out of the scope through a MOVE or COPY destination, or a folder delete.
  assert.equal((await c.copy('docs/a.md', `${ws.base}/dav/secret/a.md`)).status, 403);
  assert.equal((await c.move('ref/r.md', `${ws.base}/dav/docs/r.md`)).status, 403);
  assert.equal((await c.copy('secret/s.md', `${ws.base}/dav/docs/s.md`)).status, 404);
  assert.equal((await c.del('ref/')).status, 403);
  assert.equal(fs.existsSync(path.join(ws.dir, 'secret', 'a.md')), false);
  assert.equal(fs.existsSync(path.join(ws.dir, 'docs', 's.md')), false);
  assert.equal(fs.readFileSync(path.join(ws.dir, 'ref', 'r.md'), 'utf8'), 'ref/r.md');
});

test('hub: the storage quota applies to DAV PUT and COPY', async (t) => {
  const h = await startHub(t, { HUB_TEAM_STORAGE_MB: '1' });
  const ws = await hubWorkspace(h, 'quota');
  const c = client(h.port, ws.base, { auth: basic(await ws.token('q')) });
  const big = await c.put('big.bin', Buffer.alloc(1024 * 1024 + 1));
  assert.equal(big.status, 413, big.text);
  assert.equal(JSON.parse(big.text).error.code, 'storage_limit');
  assert.equal(fs.existsSync(path.join(ws.dir, 'big.bin')), false);
  assert.equal((await c.put('half.bin', Buffer.alloc(600 * 1024))).status, 201);
  const cp = await c.copy('half.bin', `${ws.base}/dav/half2.bin`);
  assert.equal(cp.status, 413, cp.text);
  assert.equal(fs.existsSync(path.join(ws.dir, 'half2.bin')), false);
});

// ---------------------------------------------------------------- grapim mount

test('grapim mount: the URL, the per-OS plan, and the token only from the environment', () => {
  const env = { GRAPIM_WORKSPACE_TOKEN: 'gws_secret' };
  const win = mountPlan(['https://app.grapim.com/w/team123/notes/', 'Z:'], { env, platform: 'win32' });
  assert.equal(win.url, 'https://app.grapim.com/w/team123/notes/dav/');
  assert.deepEqual(win.run, { cmd: 'net', args: ['use', 'Z:', 'https://app.grapim.com/w/team123/notes/dav/', '/user:grapim', 'gws_secret'] });
  assert.doesNotMatch(win.text, /gws_secret/, 'the token is never printed');
  assert.equal(mountPlan(['https://app.grapim.com/w/team123/notes/dav/'], { env, platform: 'darwin' }).url, 'https://app.grapim.com/w/team123/notes/dav/');
  assert.match(mountPlan(['https://app.grapim.com/w/team123/notes'], { env, platform: 'darwin' }).text, /Connect to Server/);
  assert.match(mountPlan(['https://app.grapim.com/w/team123/notes', '/mnt/notes'], { env, platform: 'linux' }).text, /davfs/);
  assert.throws(() => mountPlan(['https://app.grapim.com/w/team123/notes', 'gws_abc'], { env, platform: 'win32' }), /never on the command line/);
  assert.throws(() => mountPlan(['http://app.grapim.com/w/team123/notes'], { env, platform: 'win32' }), /https/);
  assert.throws(() => mountPlan(['https://app.grapim.com/w/team123/notes', 'Z:'], { env: {}, platform: 'win32' }), /GRAPIM_WORKSPACE_TOKEN/);
  assert.throws(() => mountPlan(['https://app.grapim.com/hub/x'], { env, platform: 'win32' }), /workspace address/);
});
