// SaaS connectors (docs/connectors.md), Notion first: Markdown <-> blocks,
// pulls as an approved saas:notion run, agent edits pushed as the smallest
// block changes, three-way merges and conflict copies, undo pushed back,
// 429 backoff, the sealed token, path confinement and disconnecting.
// Against a fake Notion API on a local port (test/fake-notion.js): no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { checkPath, connectorPath, createQueue, createSync } from '../src/connectors/index.js';
import { RetryableError } from '../src/connectors/queue.js';
import { createNotionConnector, propsOf, slugOf } from '../src/connectors/notion/index.js';
import { blocksToMd, frontMatter, mdToBlocks, parseInline, segmentsOf, splitFrontMatter } from '../src/connectors/notion/markdown.js';
import { getReview } from '../src/review.js';
import { createEngine } from '../src/server/engine.js';
import { createHub } from '../src/hub/server.js';
import { sealer } from '../src/hub/platform/util.js';
import { fakeNotion, rt } from './fake-notion.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const fast = () => createQueue({ perSecond: 1000 });

function repo() {
  const dir = tmp('grapim-saas-');
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '--quiet', '--template=']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  return dir;
}

// ---------------------------------------------------------------- blocks <-> Markdown

const p = (text, extra = {}) => ({ type: 'paragraph', paragraph: { rich_text: typeof text === 'string' ? rt(text) : text, color: 'default' }, ...extra });
const block = (type, payload, extra = {}) => ({ object: 'block', id: crypto.randomUUID(), type, has_children: false, archived: false, created_time: '2026-11-01T00:00:00.000Z', last_edited_time: '2026-11-02T00:00:00.000Z', [type]: payload, ...extra });

// Every supported block type as Notion returns it.
function everyType() {
  return [
    block('heading_1', { rich_text: rt([['Plan ', {}], ['2026', { bold: true }]]), color: 'default', is_toggleable: false }),
    block('heading_2', { rich_text: rt('Goals'), color: 'default', is_toggleable: false }),
    block('heading_3', { rich_text: rt('Small'), color: 'default', is_toggleable: false }),
    block('paragraph', {
      rich_text: rt([
        ['Plain, ', {}],
        ['bold', { bold: true }],
        [', ', {}],
        ['italic', { italic: true }],
        [', ', {}],
        ['both', { bold: true, italic: true }],
        [', ', {}],
        ['code', { code: true }],
        [', ', {}],
        ['gone', { strikethrough: true }],
        [' and ', {}],
        ['a link', {}, 'https://example.com/a?b=1'],
        [' with *stars*, [brackets], snake_case, _under_ and a \\ backslash.', {}],
      ]),
      color: 'default',
    }),
    block('paragraph', { rich_text: rt('Two lines\nin one paragraph'), color: 'default' }),
    block('paragraph', { rich_text: [], color: 'default' }),
    block('paragraph', { rich_text: rt('# not a heading'), color: 'default' }),
    block('paragraph', { rich_text: rt('1. not a list'), color: 'default' }),
    block('bulleted_list_item', { rich_text: rt('one'), color: 'default' }),
    block('bulleted_list_item', { rich_text: rt('two'), color: 'default' }, { has_children: true, children: [block('bulleted_list_item', { rich_text: rt('nested'), color: 'default' }), block('to_do', { rich_text: rt('nested todo'), checked: true, color: 'default' })] }),
    block('to_do', { rich_text: rt('open task'), checked: false, color: 'default' }),
    block('to_do', { rich_text: rt('done task'), checked: true, color: 'default' }),
    block('numbered_list_item', { rich_text: rt('first'), color: 'default' }),
    block('numbered_list_item', { rich_text: rt('second'), color: 'default' }, { has_children: true, children: [block('paragraph', { rich_text: rt('a paragraph under it'), color: 'default' })] }),
    block('code', { rich_text: rt('const a = `x`;\n```\nstill code'), language: 'javascript', caption: [] }),
    block('code', { rich_text: rt('plain'), language: 'plain text', caption: [] }),
    block('quote', { rich_text: rt('A quote\nover two lines'), color: 'default' }),
    block('callout', { rich_text: rt([['Heads up:', { bold: true }], [' read this', {}]]), icon: { type: 'emoji', emoji: '💡' }, color: 'gray_background' }),
    block('divider', {}),
  ];
}

// The content Markdown can carry, to compare blocks across a round trip.
function canon(blocks) {
  return blocks.map((b) => {
    const x = b[b.type] ?? {};
    const c = { type: b.type };
    if (x.rich_text) c.text = segmentsOf(x.rich_text);
    if (b.type === 'to_do') c.checked = !!x.checked;
    if (b.type === 'code') c.language = x.language;
    if (b.type === 'callout') c.icon = x.icon?.emoji ?? null;
    if (b.opaque || !['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'code', 'quote', 'callout', 'divider'].includes(b.type)) c.json = { id: b.id, payload: b[b.type] };
    if (b.children?.length) c.children = canon(b.children);
    return c;
  });
}

test('every supported block type round-trips: blocks -> Markdown -> blocks, and the Markdown is a fixed point', () => {
  const blocks = everyType();
  const md = blocksToMd(blocks);
  const back = mdToBlocks(md);
  assert.deepEqual(canon(back), canon(blocks));
  assert.equal(blocksToMd(back), md, 'Markdown -> blocks -> Markdown gives the same text');
  // Approximation: spaces at the edge of bold text move outside it (Markdown has no ** x **).
  assert.equal(blocksToMd([p(rt([['Note: ', { bold: true }], ['x', {}]]))]), '**Note:** x');
  // What it looks like: the dialect agents read and write.
  for (const line of [
    '# Plan **2026**',
    '## Goals',
    '### Small',
    'Plain, **bold**, *italic*, ***both***, `code`, ~~gone~~ and [a link](https://example.com/a?b=1) with \\*stars\\*, \\[brackets\\], snake_case, \\_under\\_ and a \\\\ backslash.',
    'Two lines\nin one paragraph',
    '<br>',
    '\\# not a heading',
    '1\\. not a list',
    '- one\n- two\n  - nested\n  - [x] nested todo\n- [ ] open task\n- [x] done task',
    '1. first\n2. second\n\n   a paragraph under it',
    '````javascript\nconst a = `x`;\n```\nstill code\n````',
    '```\nplain\n```',
    '> A quote\n> over two lines',
    '> [!callout] 💡\n> **Heads up:** read this',
    '---',
  ]) {
    assert.ok(md.includes(line), `missing:\n${line}\nin:\n${md}`);
  }
});

test('Markdown written by hand parses to blocks and renders back the same', () => {
  const md = [
    '# Title',
    '',
    'Text with **bold** and [link](<https://example.com/a b>) and `a ``tick`` here` and `` a `tick` ``.',
    '',
    '- a',
    '  continued',
    '- b',
    '  1. inner',
    '',
    '1. x',
    '2. y',
    '',
    '- [ ] todo',
    '',
    '> [!callout]',
    '> no icon',
    '',
    '```python',
    'print(1)',
    '```',
  ].join('\n');
  const blocks = mdToBlocks(md);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['heading_1', 'paragraph', 'bulleted_list_item', 'bulleted_list_item', 'numbered_list_item', 'numbered_list_item', 'to_do', 'callout', 'code'],
  );
  assert.equal(segmentsOf(blocks[2].bulleted_list_item.rich_text)[0].text, 'a\ncontinued', 'an indented line right below an item continues it');
  assert.equal(blocks[3].children[0].type, 'numbered_list_item');
  assert.equal(blocks[8].code.language, 'python');
  assert.equal(blocksToMd(blocks), md);
  // Aliases and unknown languages for code: Notion only takes its own list.
  assert.equal(mdToBlocks('```js\nx\n```')[0].code.language, 'javascript');
  assert.equal(mdToBlocks('```brainfuck\nx\n```')[0].code.language, 'plain text');
  // Inline edge cases.
  assert.deepEqual(parseInline('2 * 3 * 4').map((s) => s.text), ['2 * 3 * 4'], 'a lone star with spaces is not emphasis');
  assert.deepEqual(parseInline('a **b** c'), [
    { text: 'a ', bold: false, italic: false, strike: false, code: false, link: null },
    { text: 'b', bold: true, italic: false, strike: false, code: false, link: null },
    { text: ' c', bold: false, italic: false, strike: false, code: false, link: null },
  ]);
  assert.equal(parseInline('*'.repeat(5000)).map((s) => s.text).join(''), '*'.repeat(5000), 'hostile input stays literal and fast');
});

test('unsupported blocks are kept as notion-block JSON, so a round trip never loses them', () => {
  const image = block('image', { type: 'file', file: { url: 'https://s3.example/signed?X-Amz-Expires=3600', expiry_time: '2026-11-11T10:00:00.000Z' }, caption: rt('A chart') });
  const table = block('table', { table_width: 2, has_column_header: true, has_row_header: false }, { has_children: true });
  const toggle = block('toggle', { rich_text: rt('Details'), color: 'default' }, { has_children: true });
  const childPage = block('child_page', { title: 'Sub page' });
  const toggleHeading = block('heading_2', { rich_text: rt('Folded'), color: 'default', is_toggleable: true }, { has_children: true });
  const blocks = [p('before'), image, table, toggle, childPage, toggleHeading, p('after')];
  const md = blocksToMd(blocks);
  assert.match(md, /```notion-block\n\{"id":"[0-9a-f-]{36}","type":"image"/);
  assert.ok(!md.includes('X-Amz-Expires') && !md.includes('expiry_time'), 'signed file URLs change on every read: left out, so the version is stable');
  assert.ok(!md.includes('last_edited_time') && !md.includes('created_time'));
  const back = mdToBlocks(md);
  assert.deepEqual(
    back.map((b) => [b.type, b.id ?? null, !!b.opaque]),
    [['paragraph', null, false], ['image', image.id, true], ['table', table.id, true], ['toggle', toggle.id, true], ['child_page', childPage.id, true], ['heading_2', toggleHeading.id, true], ['paragraph', null, false]],
  );
  assert.equal(blocksToMd(back), md);
  // A notion-block whose JSON was broken stays visible as code, never dropped.
  const broken = mdToBlocks('```notion-block\n{oops\n```');
  assert.equal(broken[0].type, 'code');
});

test('front matter: every property type in, the same values out', () => {
  const page = {
    properties: {
      Name: { type: 'title', title: rt('Ship it') },
      Status: { type: 'status', status: { name: 'In progress' } },
      Tags: { type: 'multi_select', multi_select: [{ name: 'a' }, { name: 'b: c' }] },
      Due: { type: 'date', date: { start: '2026-11-11', end: '2026-11-12' } },
      Done: { type: 'checkbox', checkbox: false },
      Points: { type: 'number', number: 3.5 },
      Notes: { type: 'rich_text', rich_text: rt('Line: with colon') },
      Link: { type: 'url', url: null },
      '狀態 (zh)': { type: 'select', select: { name: '進行中' } },
      Edited: { type: 'last_edited_time', last_edited_time: '2026-11-11T00:00:00.000Z' },
      Score: { type: 'formula', formula: { type: 'number', number: 7 } },
    },
  };
  const props = propsOf(page);
  assert.equal(props[0][0], 'Name', 'the title comes first');
  assert.ok(!props.some(([k]) => k === 'Edited'), 'timestamps that change on every edit are left out');
  const fm = frontMatter(props, 'Notion page');
  const back = splitFrontMatter(`${fm}\n\nbody\n`);
  assert.deepEqual([...back.props], props);
  assert.equal(back.body, 'body\n');
});

// ---------------------------------------------------------------- a workspace and a fake Notion

// An engine on a temp repo, the Notion connector on a fake server, and the
// post-write callback wired the way the hub wires it.
async function setup(t, { queue = fast(), pages = 'plan' } = {}) {
  const fake = await fakeNotion().start();
  t.after(() => fake.close());
  const connector = createNotionConnector({ token: fake.token, baseUrl: fake.url, queue });
  const sync = createSync({ connector });
  const dir = repo();
  let engine = null;
  const h = () => ({ store: engine.store, ws: engine.ws, offload: null });
  engine = createEngine({ cwd: dir, env: {}, afterWrite: (e) => sync.afterWrite(h(), e) });
  t.after(() => engine.close());
  const server = http.createServer((req, res) => engine.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ids = {};
  if (pages === 'plan') {
    const body = ['P1', 'P2', 'P3', 'P4', 'P5'].map((x) => p(x));
    ids.page = fake.addPage({ title: 'Launch plan', blocks: [{ type: 'heading_1', heading_1: { rich_text: rt('Goals') } }, ...body] });
    ids.blocks = [...fake.kids.get(ids.page)];
  }
  const req = async (method, p2, { body, agent = null, json = false } = {}) => {
    const headers = {};
    if (agent) headers['X-Grapim-Agent'] = agent;
    if (json) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + p2, { method, headers, body: json ? JSON.stringify(body) : body });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
  };
  const file = (rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
  const files = () => (fs.existsSync(path.join(dir, 'saas', 'notion')) ? fs.readdirSync(path.join(dir, 'saas', 'notion')).sort() : []);
  return { fake, connector, sync, dir, engine: () => engine, h, base, req, file, files, ids, pull: () => sync.pull(h()) };
}

const texts = (fake, page) => fake.tree(page).map((b) => b.text ?? `[${b.type}]`);

test('pull: each shared page and database row becomes a Markdown file, written as the approved run saas:notion', async (t) => {
  const s = await setup(t);
  const db = s.fake.addDatabase('Tasks');
  const row = s.fake.addPage({
    title: 'Write docs',
    database: db,
    properties: { Name: { id: 'title', type: 'title', title: rt('Write docs') }, Status: { id: 's', type: 'status', status: { name: 'Todo' } } },
    blocks: [p('Row body')],
  });
  const sum = await s.pull();
  assert.equal(sum.created, 2);
  assert.deepEqual(sum.errors, []);
  const hex = (id) => id.replace(/-/g, '').slice(0, 8);
  assert.deepEqual(s.files(), [`launch-plan--${hex(s.ids.page)}.md`, `write-docs--${hex(row)}.md`].sort());
  const plan = s.file(`saas/notion/launch-plan--${hex(s.ids.page)}.md`);
  assert.equal(plan, `---\n# Notion page https://www.notion.so/${s.ids.page.replace(/-/g, '')}\ntitle: Launch plan\n---\n\n# Goals\n\nP1\n\nP2\n\nP3\n\nP4\n\nP5\n`);
  assert.match(s.file(`saas/notion/write-docs--${hex(row)}.md`), /^---\n# Notion page .*\nName: Write docs\nStatus: Todo\n---\n\nRow body\n$/);

  // In the ledger: one run, labelled Notion, approved without anyone doing it.
  const store = s.engine().store;
  const changes = store.changesOfRun('saas:notion');
  assert.equal(changes.length, 2);
  assert.equal(store.runs().find((r) => r.run === 'saas:notion').label, 'Notion');
  assert.equal(getReview(store, 'saas:notion').status, 'approved');
  assert.equal(s.fake.mutations().length, 0, 'a pull never writes to Notion');

  // Nothing changed: nothing recorded. A person edits in Notion: one new change, a new turn.
  assert.equal((await s.pull()).updated, 0);
  assert.equal(store.changesOfRun('saas:notion').length, 2);
  s.fake.edit(s.ids.blocks[2], 'P2 edited in Notion');
  const again = await s.pull();
  assert.equal(again.updated, 1);
  assert.match(s.file(`saas/notion/launch-plan--${hex(s.ids.page)}.md`), /\n\nP2 edited in Notion\n\n/);
  const all = store.changesOfRun('saas:notion');
  assert.equal(all.length, 3);
  assert.ok(all[2].turn > all[0].turn, 'each pull is its own turn of the run');

  // A page that cannot be read is an error of this pull; the others still sync.
  const third = s.fake.addPage({ title: 'Locked', blocks: [p('secret')] });
  s.fake.broken.add(third);
  s.fake.edit(s.ids.blocks[3], 'P3 edited in Notion');
  const partial = await s.pull();
  assert.equal(partial.updated, 1);
  assert.equal(partial.errors.length, 1);
  assert.match(partial.errors[0], /^Locked: Could not find block\./);
  s.fake.broken.delete(third);
  assert.equal((await s.pull()).created, 1, 'tried again at the next pull');

  // A database that cannot be read: nothing is removed for being absent.
  s.fake.broken.add(db);
  const blind = await s.pull();
  assert.equal(blind.deleted, 0);
  assert.match(blind.errors[0], /^database Tasks: /);
  s.fake.broken.delete(db);

  // A page that leaves the integration's scope is removed here too (recorded, undoable).
  s.fake.pages.get(row).archived = true;
  assert.equal((await s.pull()).deleted, 1);
  assert.equal(s.files().length, 2);
});

test('push: an agent edit through /fs becomes the smallest block changes in Notion', async (t) => {
  const s = await setup(t);
  await s.pull();
  const [rel] = s.files().map((f) => `saas/notion/${f}`);
  const before = s.file(rel);
  const edited = before.replace('\n\nP3\n', '\n\nP3, edited by the agent\n').replace('\n\nP5\n', '\n\n- a new item\n');
  const r = await s.req('PUT', `/fs/${rel}`, { body: edited, agent: 'editor' });
  assert.equal(r.status, 200, r.text);
  const out = r.json();
  assert.equal(out.saas.status, 'pushed', r.text);
  assert.deepEqual({ updated: out.saas.ops.updated, added: out.saas.ops.added, archived: out.saas.ops.archived }, { updated: 1, added: 1, archived: 1 });
  assert.match(out.saas.message, /1 block updated, 1 block added, 1 block archived/);

  // Exactly three writes: update P3, insert after P4, archive P5. Never the whole page.
  const [, , , p3, p4, p5] = s.ids.blocks; // as pulled, before the push
  assert.deepEqual(
    s.fake.mutations().map((m) => `${m.method} ${m.path}${m.body?.after ? ` after ${m.body.after === p4 ? 'P4' : m.body.after}` : ''}`),
    [`PATCH /v1/blocks/${p3}`, `PATCH /v1/blocks/${s.ids.page}/children after P4`, `DELETE /v1/blocks/${p5}`],
  );
  assert.deepEqual(texts(s.fake, s.ids.page), ['Goals', 'P1', 'P2', 'P3, edited by the agent', 'P4', 'a new item']);
  assert.equal(s.fake.blocks.get(p3).id, p3, 'the edited block kept its id (comments and links on it survive)');

  // The file as the agent wrote it is what Notion now renders: the next pull changes nothing.
  assert.equal((await s.pull()).updated, 0);
  assert.equal(s.file(rel), edited);
  assert.equal(s.engine().store.changesOfRun('http:editor').length, 1);

  // A block added above the first one: Notion cannot insert there, so the
  // first block is re-created below the new one.
  const top = s.file(rel).replace('\n\n# Goals\n', '\n\n> New intro\n\n# Goals\n');
  const r2 = (await s.req('PUT', `/fs/${rel}`, { body: top, agent: 'editor' })).json();
  assert.equal(r2.saas.status, 'pushed');
  assert.deepEqual(texts(s.fake, s.ids.page).slice(0, 2), ['New intro', 'Goals']);

  // Database properties: front matter edits change the property, nothing else.
  const db = s.fake.addDatabase('Tasks');
  const row = s.fake.addPage({ database: db, properties: { Name: { id: 'title', type: 'title', title: rt('Task') }, Status: { id: 's', type: 'status', status: { name: 'Todo' } }, Score: { id: 'f', type: 'formula', formula: { type: 'number', number: 1 } } }, blocks: [p('x')] });
  await s.pull();
  const rowRel = `saas/notion/task--${row.replace(/-/g, '').slice(0, 8)}.md`;
  const n = s.fake.mutations().length;
  const r3 = (await s.req('PUT', `/fs/${rowRel}`, { body: s.file(rowRel).replace('Status: Todo', 'Status: Done').replace('Score: 1', 'Score: 9'), agent: 'editor' })).json();
  assert.equal(r3.saas.status, 'pushed');
  assert.deepEqual(r3.saas.ops.properties, ['Status']);
  assert.match(r3.saas.message, /Not written: Score \(formula cannot be written\)/);
  assert.deepEqual(s.fake.mutations().slice(n).map((m) => `${m.method} ${m.path}`), [`PATCH /v1/pages/${row}`]);
  assert.equal(s.fake.pages.get(row).properties.Status.status.name, 'Done');

  // A file under saas/notion that no page backs is written but not sent.
  const lone = (await s.req('PUT', '/fs/saas/notion/new-idea.md', { body: '# Idea\n', agent: 'editor' })).json();
  assert.equal(lone.saas.status, 'not_linked');
});

test('conflicts: a clean three-way merge is applied; an overlapping edit leaves a conflict copy and pushes nothing', async (t) => {
  const s = await setup(t);
  await s.pull();
  const [rel] = s.files().map((f) => `saas/notion/${f}`);
  const pulled = s.file(rel);
  const [, p1, p2, , p4] = s.ids.blocks;

  // Someone edits P1 in Notion; the agent, from the pulled file, edits P4.
  s.fake.edit(p1, 'P1 changed in Notion');
  const r = await s.req('PUT', `/fs/${rel}`, { body: pulled.replace('\n\nP4\n', '\n\nP4 changed by the agent\n'), agent: 'merger' });
  const out = r.json();
  assert.equal(out.saas.status, 'merged', r.text);
  assert.deepEqual(texts(s.fake, s.ids.page), ['Goals', 'P1 changed in Notion', 'P2', 'P3', 'P4 changed by the agent', 'P5']);
  const merged = s.file(rel);
  assert.ok(merged.includes('P1 changed in Notion') && merged.includes('P4 changed by the agent'));
  assert.equal(r.headers.get('etag'), `"${sha1(merged)}"`, 'the ETag is the merged file, so the agent re-reads it');
  assert.equal(s.fake.mutations().filter((m) => m.method !== 'GET').length, 1, 'only P4 was written');

  // Both change P2. Through MCP this time, as another agent: the agent is told, as an error.
  await s.req('POST', '/fs/_release', { agent: 'merger' });
  s.fake.edit(p2, 'P2 by a person');
  const now = s.file(rel);
  const before = s.fake.mutations().length;
  const mcp = async (body, session) => {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Grapim-Agent': 'claude' };
    if (session) headers['Mcp-Session-Id'] = session;
    const res = await fetch(`${s.base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { session: res.headers.get('mcp-session-id'), json: await res.json() };
  };
  const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 't' }, capabilities: {} } });
  const call = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_file', arguments: { path: rel, content: now.replace('\n\nP2\n', '\n\nP2 by the agent\n') } } }, init.session);
  const result = call.json.result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Notion changed this page since it was last synced, and your edit overlaps those changes\. Nothing was sent to Notion\./);
  assert.equal(s.fake.mutations().length, before, 'nothing was pushed');
  assert.deepEqual(texts(s.fake, s.ids.page)[2], 'P2 by a person');
  // The path has Notion's version; the agent's is in a copy beside it.
  assert.ok(s.file(rel).includes('P2 by a person'));
  const copy = s.files().find((f) => f.includes('(conflict from claude '));
  assert.ok(copy, s.files().join(', '));
  assert.ok(s.file(`saas/notion/${copy}`).includes('P2 by the agent'));
  assert.match(result.content[0].text, new RegExp(`yours is in saas/notion/${copy.replace(/[()]/g, '\\$&')}`));
  // Settled: the next pull has nothing to do, and the copy is never pushed.
  const sum = await s.pull();
  assert.equal(sum.updated + sum.created + sum.conflicts.length, 0);

  // A push that fails keeps the file as written and is retried at the next
  // pull, merged with what changed in Notion meanwhile.
  await s.req('POST', '/fs/_release', { agent: 'claude' });
  const [, , , , , p5] = s.ids.blocks;
  s.fake.failNext(1, { status: 500 });
  const down = (await s.req('PUT', `/fs/${rel}`, { body: s.file(rel).replace('\n\nP3\n', '\n\nP3 while Notion was down\n'), agent: 'retry' })).json();
  assert.equal(down.saas.status, 'error');
  assert.match(down.saas.message, /tries again at the next sync/);
  s.fake.edit(p5, 'P5 changed in Notion');
  await s.req('POST', '/fs/_release', { agent: 'retry' });
  const later = await s.pull();
  assert.equal(later.merged, 1, JSON.stringify(later));
  assert.deepEqual(texts(s.fake, s.ids.page).slice(3), ['P3 while Notion was down', 'P4 changed by the agent', 'P5 changed in Notion']);
  assert.ok(s.file(rel).includes('P3 while Notion was down') && s.file(rel).includes('P5 changed in Notion'));
  assert.equal((await s.pull()).updated, 0);
});

test('undo of an agent run that touched Notion pushes the previous content back, and the undo is recorded', async (t) => {
  const s = await setup(t);
  await s.pull();
  const [rel] = s.files().map((f) => `saas/notion/${f}`);
  const original = texts(s.fake, s.ids.page);
  const edited = s.file(rel).replace('\n\nP2\n', '\n\nP2 rewritten\n').replace('\n\nP5\n', '\n\n- [ ] follow up\n');
  assert.equal((await s.req('PUT', `/fs/${rel}`, { body: edited, agent: 'rogue' })).json().saas.status, 'pushed');
  assert.notDeepEqual(texts(s.fake, s.ids.page), original);

  const u = await s.req('POST', `/api/runs/${encodeURIComponent('http:rogue')}/undo`, { body: { apply: true }, json: true });
  assert.equal(u.status, 200, u.text);
  const out = u.json();
  assert.equal(out.files[0].action, 'revert');
  assert.equal(out.saas[0].status, 'pushed', u.text);
  assert.deepEqual(texts(s.fake, s.ids.page), original, 'Notion has the content from before the run');
  const store = s.engine().store;
  assert.ok(store.runs().some((r) => r.run.startsWith('undo:')), 'the undo is a recorded run');
  assert.equal((await s.pull()).updated, 0);

  // Deleting the file moves the page to Notion's trash; undoing the delete brings it back.
  await s.req('POST', '/fs/_release', { agent: 'rogue' });
  const d = (await s.req('DELETE', `/fs/${rel}`, { agent: 'cleaner' })).json();
  assert.equal(d.saas.status, 'archived');
  assert.equal(s.fake.pages.get(s.ids.page).archived, true);
  const writes = s.fake.mutations().length;
  const u2 = (await s.req('POST', `/api/runs/${encodeURIComponent('http:cleaner')}/undo`, { body: { apply: true }, json: true })).json();
  assert.equal(u2.saas[0].status, 'pushed');
  assert.match(u2.saas[0].message, /Notion already had this content/);
  assert.equal(s.fake.pages.get(s.ids.page).archived, false);
  assert.deepEqual(s.fake.mutations().slice(writes).map((m) => `${m.method} ${m.path} ${JSON.stringify(m.body)}`), [`PATCH /v1/pages/${s.ids.page} {"archived":false}`], 'only taken out of the trash');
  assert.deepEqual(texts(s.fake, s.ids.page), original);
});

test('rate limits: 429 is retried after Retry-After, and the whole queue waits', async (t) => {
  // The queue on a fake clock.
  let now = 0;
  const slept = [];
  const q = createQueue({ perSecond: 3, now: () => now, sleep: async (ms) => slept.push(ms) && (now += ms), random: () => 0.5 });
  let calls = 0;
  const started = [];
  const first = q.run(async () => {
    calls++;
    if (calls <= 2) throw new RetryableError('429', { status: 429, retryAfterMs: 2000 });
    return 'ok';
  });
  const second = q.run(async () => {
    started.push(now);
    return 'second';
  });
  assert.equal(await first, 'ok');
  assert.equal(await second, 'second');
  assert.equal(q.stats.retries, 2);
  assert.ok(slept.filter((ms) => ms >= 2000).length >= 1, `waited out Retry-After: ${slept}`);
  assert.ok(started[0] >= 333, 'requests start at most 3 per second');

  // No Retry-After: exponential backoff.
  let n = 0;
  const q2 = createQueue({ perSecond: 1000, now: () => now, sleep: async (ms) => void (now += ms), random: () => 1, baseDelayMs: 100 });
  const t0 = now;
  await q2.run(async () => {
    if (n++ < 3) throw new RetryableError('busy', { status: 503 });
  });
  assert.ok(now - t0 >= 100 + 200 + 400, `backed off ${now - t0} ms`);
  await assert.rejects(
    createQueue({ maxRetries: 1, now: () => now, sleep: async (ms) => void (now += ms) }).run(async () => {
      throw new RetryableError('always 429', { retryAfterMs: 0 });
    }),
    /always 429/,
  );

  // Against the fake Notion: two 429s, then the pull goes through.
  const s = await setup(t, { queue: createQueue({ perSecond: 1000 }) });
  s.fake.failNext(2, { retryAfter: '0' });
  const sum = await s.pull();
  assert.equal(sum.created, 1);
  assert.equal(s.connector.client.queue.stats.retries, 2);
});

test('a connector never writes outside saas/<name>/, whatever paths it names', async (t) => {
  for (const bad of ['../evil.md', 'docs/x.md', 'saas/notion/../../x.md', 'saas/other/x.md', 'saas/notion/sub/x.md', 'saas/notion/.envrc', 'saas/notion/x.txt', '/etc/x.md', 'saas/notion\\..\\x.md', 'saas/notion/']) {
    assert.equal(connectorPath('notion', bad), false, bad);
    assert.throws(() => checkPath('notion', bad), /may only write files directly in saas\/notion\//);
  }
  assert.equal(connectorPath('notion', 'saas/notion/ok--12345678.md'), true);
  assert.equal(slugOf('../../etc/passwd'), 'etc-passwd');
  assert.equal(slugOf('週報 Weekly: 11/11'), '週報-weekly-11-11');
  assert.equal(slugOf(''), 'untitled');

  const dir = repo();
  const engine = createEngine({ cwd: dir, env: {} });
  t.after(() => engine.close());
  const item = (id, p2) => ({ id, path: p2, title: id, content: `# ${id}\n`, version: id });
  const stub = {
    describe: () => ({ name: 'notion', title: 'Notion', root: 'saas/notion/' }),
    pull: async () => ({
      items: [item('a', '../evil.md'), item('b', 'docs/x.md'), item('c', 'saas/notion/../../x.md'), item('d', 'saas/other/x.md'), item('e', 'saas/notion/sub/x.md'), item('f', '.claude/settings.json'), item('g', 'saas/notion/fine.md')],
      present: null,
      cursor: null,
    }),
  };
  const sum = await createSync({ connector: stub }).pull({ store: engine.store, ws: engine.ws });
  assert.equal(sum.errors.length, 6, sum.errors.join('\n'));
  assert.equal(sum.created, 1);
  const all = execFileSync('git', ['ls-files', '-o', '--exclude-standard'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(all, ['saas/notion/fine.md']);
  assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'evil.md')));
});

// ---------------------------------------------------------------- in the hub

const ORIGIN = 'http://localhost:7999';

function fakeGitHub() {
  const codes = new Map();
  const fetch = async (url, init = {}) => {
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://github.com/login/oauth/access_token') return codes.has(JSON.parse(init.body).code) ? reply(200, { access_token: `gho_${JSON.parse(init.body).code}` }) : reply(200, { error: 'bad' });
    if (url === 'https://api.github.com/user') {
      const u = codes.get(String(init.headers?.Authorization || '').replace('Bearer gho_', ''));
      return u ? reply(200, u) : reply(401, {});
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, user: (code, profile) => codes.set(code, profile) };
}

class Browser {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }
  async req(p2, { method = 'GET', form = null, headers = {} } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (method !== 'GET') h.Origin = ORIGIN;
    if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(this.base + p2, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (/Max-Age=0/i.test(c)) this.jar.delete(pair.slice(0, i));
      else this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  }
  async post(p2, form = {}) {
    const csrf = JSON.parse((await this.req('/hub/api/me')).text).csrf;
    return this.req(p2, { method: 'POST', form: { _csrf: csrf, ...form } });
  }
}

test('in the hub: connect with a sealed token bound to its workspace, sync, push, then disconnect stops it all', async (t) => {
  const fake = await fakeNotion().start();
  t.after(() => fake.close());
  const page = fake.addPage({ title: 'Roadmap', blocks: [p('Q1'), p('Q2')] });
  const gh = fakeGitHub();
  const dir = tmp('grapim-saas-hub-');
  const logs = [];
  const hub = await createHub({
    env: { HUB_URL: ORIGIN, HUB_SECRET: 'test-secret-that-is-long-enough-0123456789', HUB_DATA: dir, GITHUB_CLIENT_ID: 'gh', GITHUB_CLIENT_SECRET: 'gh-secret' },
    fetch: gh.fetch,
    billing: null,
    storage: null,
    log: (l) => logs.push(l),
    connectors: { notion: { baseUrl: fake.url, queue: fast() } },
  });
  const addr = await hub.listen(0, '127.0.0.1');
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${addr.port}`;
  gh.user('c1', { id: 9101, login: 'saas-owner', name: 'Owner', avatar_url: null });
  const b = new Browser(base);
  const start = await b.req('/hub/auth/github');
  await b.req(`/hub/auth/callback?code=c1&state=${new URL(start.headers.get('location')).searchParams.get('state')}`);
  const team = (await b.post('/hub/teams', { name: 'Saas team' })).headers.get('location').match(/\/hub\/teams\/([^/]+)\//)[1];
  hub.db.prepare("UPDATE teams SET plan = 'team' WHERE id = ?").run(team);
  const mk = async (name) => (await b.post(`/hub/teams/${team}/workspaces`, { name })).headers.get('location').match(/\/workspaces\/([^/]+)$/)[1];
  const wsA = await mk('notes');
  const wsB = await mk('other');
  const pagePath = `/hub/teams/${team}/workspaces/${wsA}`;

  // Not connected: the steps and the form.
  // The Integrations tab of the workspace page.
  const empty = await b.req(`${pagePath}/integrations`);
  assert.match(empty.text, /Connect Notion/);
  assert.match(empty.text, /notion\.so\/profile\/integrations/);
  assert.match(empty.text, /name="token" type="password"/);

  // A bad token: refused with a message, nothing stored.
  const bad = await b.post(`${pagePath}/connectors/connect`, { connector: 'notion', token: `secret_${'b'.repeat(43)}` });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Notion did not accept this token/);
  assert.equal(hub.db.prepare('SELECT COUNT(*) AS n FROM workspace_connectors').get().n, 0);

  const ok = await b.post(`${pagePath}/connectors/connect`, { connector: 'notion', token: fake.token });
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.text, /Connected to Grapim test in Acme/);
  assert.ok(!ok.text.includes(fake.token), 'the token is never sent back');

  // Sealed, and bound to this workspace.
  const row = hub.db.prepare('SELECT * FROM workspace_connectors WHERE workspace_id = ?').get(wsA);
  assert.match(row.secret, /^v2\./);
  assert.ok(!JSON.stringify(hub.db.prepare('SELECT * FROM workspace_connectors').all()).includes(fake.token));
  const seal = sealer('test-secret-that-is-long-enough-0123456789', 'grapim connector seal v1');
  assert.equal(seal.open(row.secret, `workspace_connectors\n${team}\n${wsA}\nnotion`), fake.token);
  assert.equal(seal.open(row.secret, `workspace_connectors\n${team}\n${wsB}\nnotion`), null, 'it does not open for another workspace');
  assert.equal(sealer('test-secret-that-is-long-enough-0123456789').open(row.secret, `workspace_connectors\n${team}\n${wsA}\nnotion`), null, 'nor with the platform key');
  // Copied into another workspace's row, it cannot be used there.
  hub.db.prepare('INSERT INTO workspace_connectors (workspace_id, team_id, connector, secret, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(wsB, team, 'notion', row.secret, 1, Date.now());
  await assert.rejects(hub.connectors.pull(wsB, 'notion'), /cannot be read/);
  hub.db.prepare('DELETE FROM workspace_connectors WHERE workspace_id = ?').run(wsB);

  // The first sync: the page as a file in the workspace, as saas:notion.
  await hub.connectors.pull(wsA, 'notion');
  const tok = (await b.post(`${pagePath}/tokens`, { name: 'agent', scope: 'write' })).text.match(/value="(gws_[A-Za-z0-9_-]+)"/)[1];
  const agent = async (method, p2, body) => {
    const res = await fetch(`${base}/w/${team}/notes${p2}`, { method, headers: { Authorization: `Bearer ${tok}`, 'X-Grapim-Agent': 'writer' }, body });
    return { status: res.status, text: await res.text() };
  };
  const rel = `saas/notion/roadmap--${page.replace(/-/g, '').slice(0, 8)}.md`;
  const got = await agent('GET', `/fs/${rel}`);
  assert.equal(got.status, 200, got.text);
  assert.match(got.text, /\nQ1\n\nQ2\n$/);
  const shown = await b.req(`${pagePath}/integrations`);
  assert.match(shown.text, /badge-ok">Connected/);
  assert.match(shown.text, /Grapim test/);
  assert.ok(!shown.text.includes(fake.token));
  assert.ok(hub.connectors.scheduled(wsA, 'notion'), 'pulled every 2 minutes from now on');

  // An agent's write is pushed.
  const put = await agent('PUT', `/fs/${rel}`, got.text.replace('Q2', 'Q2 (moved to Q3)'));
  assert.equal(JSON.parse(put.text).saas.status, 'pushed', put.text);
  assert.deepEqual(texts(fake, page), ['Q1', 'Q2 (moved to Q3)']);

  // Disconnect: no row, no timer, no pull, and writes stay local.
  const off = await b.post(`${pagePath}/connectors/disconnect`, { connector: 'notion' });
  assert.equal(off.status, 200, off.text);
  assert.match(off.text, /Disconnected/);
  assert.equal(hub.db.prepare('SELECT COUNT(*) AS n FROM workspace_connectors').get().n, 0);
  assert.equal(hub.connectors.scheduled(wsA, 'notion'), false);
  assert.equal(await hub.connectors.pull(wsA, 'notion'), null);
  const writes = fake.mutations().length;
  const put2 = await agent('PUT', `/fs/${rel}`, got.text.replace('Q1', 'Q1 offline'));
  assert.equal(put2.status, 200);
  assert.equal(JSON.parse(put2.text).saas, undefined, 'nothing is sent once disconnected');
  assert.equal(fake.mutations().length, writes);
  assert.match((await agent('GET', `/fs/${rel}`)).text, /Q1 offline/, 'the files stay');

  // The token never reached a log line.
  assert.ok(!logs.join('\n').includes(fake.token));
});
