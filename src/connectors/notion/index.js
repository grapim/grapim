// The Notion connector: the pages and databases an internal integration was
// shared with, as Markdown files under saas/notion/ (docs/connectors.md).
//
// - A page is saas/notion/<title-slug>--<first 8 hex of its id>.md: its
//   properties as front matter (a database row's columns; a page's title),
//   then its blocks as Markdown (markdown.js).
// - Its version is the sha1 of that file as rendered from Notion. Notion's
//   last_edited_time is only precise to the minute, so it only says which
//   pages to look at again; the content decides whether one changed.
// - push writes a file back: properties that changed, then the smallest
//   block changes (diff.js). If the page changed in Notion since the base
//   version, nothing is written and the caller gets Notion's version to merge.

import crypto from 'node:crypto';
import { createNotionClient, notionId, NotionError } from './client.js';
import { syncChildren } from './diff.js';
import { CHILD_TYPES, mdToBlocks, pageFile, plainOf, splitFrontMatter } from './markdown.js';

export const NAME = 'notion';
const ROOT = 'saas/notion/';
const MAX_DEPTH = 6; // nested block levels fetched; deeper blocks are kept whole
const MAX_BLOCKS = 10_000; // per page
const MARGIN_MS = 3 * 60 * 1000; // last_edited_time is truncated to the minute; clocks differ

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// ---- properties ----

const SKIP = new Set(['created_time', 'last_edited_time', 'created_by', 'last_edited_by', 'button', 'verification']);
const EDITABLE = new Set(['title', 'rich_text', 'number', 'select', 'status', 'multi_select', 'date', 'checkbox', 'url', 'email', 'phone_number', 'relation']);

const dateText = (d) => (d ? (d.end ? `${d.start}/${d.end}` : d.start ?? null) : null);

// One property's value as front matter shows it, or undefined to leave it out.
export function valueOf(p) {
  if (!p || typeof p !== 'object' || SKIP.has(p.type)) return undefined;
  const v = p[p.type];
  switch (p.type) {
    case 'title':
    case 'rich_text':
      return plainOf(v);
    case 'number':
      return typeof v === 'number' ? v : null;
    case 'select':
    case 'status':
      return v?.name ?? null;
    case 'multi_select':
      return (v ?? []).map((o) => String(o?.name ?? ''));
    case 'date':
      return dateText(v);
    case 'checkbox':
      return !!v;
    case 'url':
    case 'email':
    case 'phone_number':
      return v ?? null;
    case 'people':
      return (v ?? []).map((u) => String(u?.name ?? u?.id ?? ''));
    case 'relation':
      return (v ?? []).map((r) => String(r?.id ?? ''));
    case 'files':
      return (v ?? []).map((f) => String(f?.name ?? ''));
    case 'formula':
      if (!v) return null;
      return v.type === 'date' ? dateText(v.date) : v[v.type] ?? null;
    case 'rollup':
      if (!v) return null;
      if (v.type === 'array') return (v.array ?? []).map((x) => valueOf(x) ?? null);
      return v.type === 'date' ? dateText(v.date) : v[v.type] ?? null;
    case 'unique_id':
      return v ? (v.prefix ? `${v.prefix}-${v.number}` : v.number) : null;
    default:
      return undefined;
  }
}

// [name, value] in file order: the title first, then the others by name.
export function propsOf(page) {
  const all = Object.entries(page?.properties ?? {});
  const title = all.filter(([, p]) => p?.type === 'title');
  const rest = all.filter(([, p]) => p?.type !== 'title').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out = [];
  for (const [name, p] of [...title, ...rest]) {
    const v = valueOf(p);
    if (v !== undefined) out.push([name, v]);
  }
  return out;
}

export const titleOf = (page) => plainOf(Object.values(page?.properties ?? {}).find((p) => p?.type === 'title')?.title ?? []);

const plainRich = (s) => (s ? [{ type: 'text', text: { content: String(s).slice(0, 2000) } }] : []);

// The PATCH /pages/{id} value for a changed property, or a reason it cannot be written.
function propertyValue(p, v) {
  const bad = (why) => ({ error: why });
  switch (p.type) {
    case 'title':
    case 'rich_text':
      return { value: { [p.type]: plainRich(v === null ? '' : String(v)) } };
    case 'number': {
      if (v === null || v === '') return { value: { number: null } };
      const n = Number(v);
      return Number.isFinite(n) ? { value: { number: n } } : bad('not a number');
    }
    case 'select':
      return { value: { select: v === null || v === '' ? null : { name: String(v) } } };
    case 'status':
      return v === null || v === '' ? bad('a status cannot be empty') : { value: { status: { name: String(v) } } };
    case 'multi_select':
      return Array.isArray(v) ? { value: { multi_select: v.map((x) => ({ name: String(x) })) } } : bad('give a list, like [a, b]');
    case 'date': {
      if (v === null || v === '') return { value: { date: null } };
      const [start, end] = String(v).split('/');
      return { value: { date: { start, end: end || null } } };
    }
    case 'checkbox':
      return typeof v === 'boolean' ? { value: { checkbox: v } } : bad('true or false');
    case 'url':
    case 'email':
    case 'phone_number':
      return { value: { [p.type]: v === null || v === '' ? null : String(v) } };
    case 'relation': {
      if (!Array.isArray(v)) return bad('give a list of page ids');
      const ids = v.map(notionId);
      return ids.every(Boolean) ? { value: { relation: ids.map((id) => ({ id })) } } : bad('give a list of page ids');
    }
    default:
      return bad('Notion computes it');
  }
}

// ---- paths ----

export function slugOf(title) {
  const s = Array.from(
    String(title ?? '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, ''),
  )
    .slice(0, 60)
    .join('')
    .replace(/-+$/g, '');
  return s || 'untitled';
}

export const pathOf = (page, idChars = 8) => `${ROOT}${slugOf(titleOf(page))}--${notionId(page.id).replace(/-/g, '').slice(0, idChars)}.md`;

// ---- the connector ----

// options: { token, baseUrl, fetch, queue } (baseUrl only from code: tests).
export function createNotionConnector(options) {
  const client = createNotionClient(options);

  // A page's blocks, children included where the Markdown shows them.
  async function tree(id) {
    let count = 0;
    async function walk(parent, depth) {
      const blocks = await client.children(parent);
      count += blocks.length;
      if (count > MAX_BLOCKS) throw new NotionError(413, 'too_large', `This page has more than ${MAX_BLOCKS} blocks; Grapim does not sync pages that large yet.`);
      for (const b of blocks) {
        if (!b.has_children || !CHILD_TYPES.has(b.type)) continue;
        if (depth >= MAX_DEPTH) b.opaque = true; // kept whole, never rewritten
        else b.children = await walk(b.id, depth + 1);
      }
      return blocks;
    }
    return walk(id, 0);
  }

  const comment = (page) => (typeof page.url === 'string' && /^https:\/\/(www\.)?notion\.so\/[\w-]+$/.test(page.url) ? `Notion page ${page.url}` : 'Notion page');
  const render = (page, blocks) => pageFile(propsOf(page), blocks, comment(page));

  const live = (p) => p && p.object === 'page' && !p.archived && !p.in_trash && notionId(p.id);

  // Every page in scope: shared pages and the rows of shared databases.
  // complete is false when a database could not be read (then nothing is
  // removed for being absent).
  async function list() {
    const found = new Map();
    const errors = [];
    let complete = true;
    for (const x of await client.search()) {
      if (live(x)) found.set(notionId(x.id), x);
      else if (x?.object === 'database' && !x.archived && !x.in_trash && notionId(x.id)) {
        try {
          for (const row of await client.queryDatabase(x.id)) if (live(row)) found.set(notionId(row.id), row);
        } catch (err) {
          complete = false;
          errors.push(`database ${plainOf(x.title) || notionId(x.id)}: ${err?.message ?? err}`);
        }
      }
    }
    return { pages: [...found.values()], complete, errors };
  }

  async function item(page) {
    const content = render(page, await tree(page.id));
    return { id: notionId(page.id), path: pathOf(page), longPath: pathOf(page, 32), title: titleOf(page), content, version: sha1(content), edited: page.last_edited_time ?? null };
  }

  return {
    describe: () => ({
      name: NAME,
      title: 'Notion',
      root: ROOT,
      scope: 'The pages and databases the integration was shared with in Notion (each page: ••• > Connections).',
      run: `saas:${NAME}`,
    }),

    // { name, workspace } of the integration, or a NotionError.
    async test() {
      const me = await client.me();
      return { name: String(me?.name ?? me?.bot?.workspace_name ?? 'Notion integration').slice(0, 100), workspace: me?.bot?.workspace_name ? String(me.bot.workspace_name).slice(0, 100) : null };
    },

    list: async () => (await list()).pages.map((p) => ({ id: notionId(p.id), title: titleOf(p), edited: p.last_edited_time ?? null, path: pathOf(p) })),

    // Pages edited since the cursor (all of them without one), with their
    // content; `present` is every page in scope, for removals.
    // A page that cannot be read is an error of this pull, not of the others.
    async pull(since) {
      const { pages, complete, errors } = await list();
      const cut = since ? Date.parse(since) - MARGIN_MS : -Infinity;
      const items = [];
      let cursor = since ?? null;
      for (const p of pages) {
        const t = Date.parse(p.last_edited_time ?? '');
        if (Number.isFinite(t) && t < cut) continue;
        try {
          items.push(await item(p));
        } catch (err) {
          errors.push(`${titleOf(p) || notionId(p.id)}: ${err?.message ?? err}`);
          continue;
        }
        if (p.last_edited_time && (!cursor || Date.parse(p.last_edited_time) > Date.parse(cursor))) cursor = p.last_edited_time;
      }
      // Removals only from a complete listing.
      return { items, present: complete ? new Set(pages.map((p) => notionId(p.id))) : null, cursor, errors };
    },

    // Writes `content` to the page if it is still at baseVersion.
    async push(entry, content, baseVersion) {
      const page = await client.page(entry.id);
      if (page.archived || page.in_trash) throw new NotionError(409, 'archived', 'The page is in Notion\'s trash. Restore it in Notion first.');
      const blocks = await tree(entry.id);
      const remote = render(page, blocks);
      const version = sha1(remote);
      if (version !== baseVersion) return { conflict: true, remote, version };
      const ops = { updated: 0, added: 0, archived: 0, properties: [], ignored: [] };
      if (remote === content.replace(/\r\n?/g, '\n')) return { version, remote, ops };
      const { props, body } = splitFrontMatter(content);
      if (props) {
        const patch = {};
        const shown = new Map(propsOf(page));
        for (const [name, v] of props) {
          const p = page.properties?.[name];
          if (!p) {
            ops.ignored.push(`${name} (no such property)`);
            continue;
          }
          if (JSON.stringify(shown.get(name)) === JSON.stringify(v)) continue;
          if (!EDITABLE.has(p.type)) {
            ops.ignored.push(`${name} (${p.type.replace(/_/g, ' ')} cannot be written)`);
            continue;
          }
          const r = propertyValue(p, v);
          if (r.error) ops.ignored.push(`${name} (${r.error})`);
          else {
            patch[name] = r.value;
            ops.properties.push(name);
          }
        }
        if (Object.keys(patch).length) await client.updatePage(entry.id, { properties: patch });
      }
      await syncChildren(client, entry.id, blocks, mdToBlocks(body), ops);
      const after = render(await client.page(entry.id), await tree(entry.id));
      return { version: sha1(after), remote: after, ops };
    },

    // The file was deleted: the page goes to Notion's trash (restorable).
    remove: (entry) => client.updatePage(entry.id, { archived: true }),
    // The file came back (an undo): the page leaves the trash.
    restore: (entry) => client.updatePage(entry.id, { archived: false }),

    client,
  };
}
