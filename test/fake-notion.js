// A fake of Notion's REST API (version 2022-06-28), in memory, on a local
// port: just enough of /users/me, /search, /pages, /blocks and
// /databases/query for the connector tests, with Notion's shapes, its
// pagination, its minute-precision last_edited_time, archived blocks and
// pages, and injectable failures (429 with Retry-After). No network.

import crypto from 'node:crypto';
import http from 'node:http';

const uuid = () => crypto.randomUUID();
const minute = (ms) => new Date(Math.floor(ms / 60_000) * 60_000).toISOString().replace(/:00\.000Z$/, ':00.000Z');

// Rich text as Notion stores and returns it.
function richOut(items) {
  return (items ?? []).map((r) => {
    const text = r.text?.content ?? r.plain_text ?? '';
    const link = r.text?.link ?? null;
    return {
      type: 'text',
      text: { content: text, link },
      annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default', ...(r.annotations ?? {}) },
      plain_text: text,
      href: link?.url ?? null,
    };
  });
}

// Shorthand for tests: 'text' or [['text', { bold: true }], ...].
export function rt(spec) {
  if (typeof spec === 'string') return richOut([{ text: { content: spec } }]);
  return richOut(spec.map(([t, a = {}, link = null]) => ({ text: { content: t, link: link ? { url: link } : null }, annotations: a })));
}

export function fakeNotion({ token = 'secret_' + 'a'.repeat(43), clock = () => Date.now() } = {}) {
  const pages = new Map(); // id -> page object
  const dbs = new Map(); // id -> database object
  const blocks = new Map(); // id -> block object (with .parent id)
  const kids = new Map(); // parent id -> [child ids]
  const log = []; // { method, path, body }
  const failures = []; // { status, retryAfter }
  const broken = new Set(); // ids whose children or rows answer 404 (no access)
  let lastEditedBy = 'grapim';

  const pageOf = (id) => {
    let x = id;
    for (let i = 0; i < 50 && x; i++) {
      if (pages.has(x)) return x;
      x = blocks.get(x)?.parent;
    }
    return null;
  };
  const touch = (id) => {
    const p = pageOf(id);
    if (p) pages.get(p).last_edited_time = minute(clock());
  };

  function makeBlock(parent, b) {
    const id = b.id ?? uuid();
    const type = b.type;
    const payload = { ...(b[type] ?? {}) };
    const children = payload.children ?? b.children ?? [];
    delete payload.children;
    if ('rich_text' in payload) payload.rich_text = richOut(payload.rich_text);
    if ('caption' in payload) payload.caption = richOut(payload.caption);
    if (type === 'paragraph' || type.startsWith('heading_') || type.endsWith('list_item') || type === 'to_do' || type === 'quote' || type === 'callout' || type === 'toggle') payload.color ??= 'default';
    const block = { object: 'block', id, parent, type, created_time: minute(clock()), last_edited_time: minute(clock()), has_children: false, archived: false, [type]: payload };
    blocks.set(id, block);
    kids.set(id, []);
    for (const c of children) {
      const cid = makeBlock(id, c);
      kids.get(id).push(cid);
    }
    block.has_children = kids.get(id).length > 0;
    return id;
  }

  const out = (b) => {
    const { parent, ...rest } = b;
    return JSON.parse(JSON.stringify({ ...rest, parent: pages.has(parent) ? { type: 'page_id', page_id: parent } : { type: 'block_id', block_id: parent } }));
  };

  function addDatabase(title, schema = {}) {
    const id = uuid();
    dbs.set(id, { object: 'database', id, title: rt(title), archived: false, in_trash: false, properties: schema, last_edited_time: minute(clock()) });
    return id;
  }

  // properties: Notion-shaped property values; blocks: Notion-shaped blocks
  // (children allowed). Returns the page id.
  function addPage({ title = 'Untitled', database = null, properties = null, blocks: body = [] } = {}) {
    const id = uuid();
    const props = properties ?? { title: { id: 'title', type: 'title', title: rt(title) } };
    if (properties && !Object.values(properties).some((p) => p.type === 'title')) props.Name = { id: 'title', type: 'title', title: rt(title) };
    pages.set(id, {
      object: 'page',
      id,
      created_time: minute(clock()),
      last_edited_time: minute(clock()),
      archived: false,
      in_trash: false,
      parent: database ? { type: 'database_id', database_id: database } : { type: 'workspace', workspace: true },
      properties: props,
      url: `https://www.notion.so/${id.replace(/-/g, '')}`,
    });
    kids.set(id, []);
    for (const b of body) kids.get(id).push(makeBlock(id, b));
    return id;
  }

  // The page's live blocks as a plain tree, for assertions.
  function tree(id) {
    return (kids.get(id) ?? [])
      .map((c) => blocks.get(c))
      .filter((b) => !b.archived)
      .map((b) => {
        const p = b[b.type];
        const node = { id: b.id, type: b.type, text: p.rich_text ? p.rich_text.map((r) => r.plain_text).join('') : undefined };
        if (b.type === 'to_do') node.checked = !!p.checked;
        const c = tree(b.id);
        if (c.length) node.children = c;
        return node;
      });
  }

  // A person editing in Notion.
  function edit(blockId, text) {
    const b = blocks.get(blockId);
    b[b.type].rich_text = rt(text);
    touch(blockId);
  }
  function setProperty(pageId, name, value) {
    pages.get(pageId).properties[name] = value;
    touch(pageId);
  }

  const mutations = () => log.filter((l) => l.method !== 'GET' && !(l.method === 'POST' && (l.path === '/v1/search' || /\/query$/.test(l.path))));

  function paginate(items, q) {
    const size = Math.min(100, Number(q.page_size ?? 100) || 100);
    const start = Number(q.start_cursor ?? 0) || 0;
    const page = items.slice(start, start + size);
    const more = start + size < items.length;
    return { object: 'list', results: page, has_more: more, next_cursor: more ? String(start + size) : null };
  }

  function setProps(page, props) {
    for (const [name, v] of Object.entries(props ?? {})) {
      const cur = page.properties[name];
      if (!cur) throw Object.assign(new Error(`${name} is not a property that exists.`), { status: 400, code: 'validation_error' });
      const type = cur.type;
      let value = v[type];
      if (type === 'title' || type === 'rich_text') value = richOut(value);
      if (type === 'select' || type === 'status') value = value ? { id: uuid(), name: value.name, color: 'default' } : null;
      if (type === 'multi_select') value = value.map((o) => ({ id: uuid(), name: o.name, color: 'default' }));
      if (type === 'date' && value) value = { start: value.start, end: value.end ?? null, time_zone: null };
      page.properties[name] = { ...cur, [type]: value };
    }
  }

  async function handle(req, res) {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const fail = (status, code, message) => send(status, { object: 'error', status, code, message });
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url, 'http://x');
    log.push({ method: req.method, path: url.pathname, body });
    if (req.headers.authorization !== `Bearer ${token}`) return fail(401, 'unauthorized', 'API token is invalid.');
    if (req.headers['notion-version'] !== '2022-06-28') return fail(400, 'missing_version', 'Notion-Version header failed validation.');
    if (failures.length) {
      const f = failures.shift();
      return send(f.status, { object: 'error', status: f.status, code: 'rate_limited', message: 'You have been rate limited.' }, f.retryAfter !== undefined ? { 'Retry-After': String(f.retryAfter) } : {});
    }
    const q = Object.fromEntries(url.searchParams);
    const parts = url.pathname.split('/').slice(2); // after /v1
    try {
      if (req.method === 'GET' && parts[0] === 'users' && parts[1] === 'me') return send(200, { object: 'user', id: uuid(), type: 'bot', name: 'Grapim test', bot: { owner: { type: 'workspace', workspace: true }, workspace_name: 'Acme' } });
      if (req.method === 'POST' && parts[0] === 'search') {
        const want = body?.filter?.value;
        const all = [...(want === 'database' ? [] : [...pages.values()].filter((p) => !p.archived)), ...(want === 'page' ? [] : [...dbs.values()].filter((d) => !d.archived))];
        return send(200, paginate(JSON.parse(JSON.stringify(all)), { page_size: body?.page_size, start_cursor: body?.start_cursor }));
      }
      if (req.method === 'POST' && parts[0] === 'databases' && parts[2] === 'query') {
        if (!dbs.has(parts[1]) || broken.has(parts[1])) return fail(404, 'object_not_found', 'Could not find database.');
        const rows = [...pages.values()].filter((p) => !p.archived && p.parent.database_id === parts[1]);
        return send(200, paginate(JSON.parse(JSON.stringify(rows)), { page_size: body?.page_size, start_cursor: body?.start_cursor }));
      }
      if (parts[0] === 'pages' && parts[1]) {
        const p = pages.get(parts[1]);
        if (!p) return fail(404, 'object_not_found', 'Could not find page.');
        if (req.method === 'GET') return send(200, p);
        if (req.method === 'PATCH') {
          if (body.properties) setProps(p, body.properties);
          if (typeof body.archived === 'boolean') {
            p.archived = body.archived;
            p.in_trash = body.archived;
          }
          p.last_edited_time = minute(clock());
          return send(200, p);
        }
      }
      if (parts[0] === 'blocks' && parts[1]) {
        const id = parts[1];
        const isPage = pages.has(id);
        if (!isPage && !blocks.has(id)) return fail(404, 'object_not_found', 'Could not find block.');
        if (parts[2] === 'children') {
          if (req.method === 'GET') {
            if (broken.has(id)) return fail(404, 'object_not_found', 'Could not find block.');
            const list = (kids.get(id) ?? []).map((c) => blocks.get(c)).filter((b) => !b.archived).map(out);
            return send(200, paginate(list, q));
          }
          if (req.method === 'PATCH') {
            if (!Array.isArray(body.children) || body.children.length > 100) return fail(400, 'validation_error', 'children should be an array of at most 100.');
            const list = kids.get(id);
            let at = list.length;
            if (body.after) {
              const i = list.indexOf(body.after);
              if (i < 0) return fail(400, 'validation_error', 'after block not found in children.');
              at = i + 1;
            }
            const made = body.children.map((c) => makeBlock(id, c));
            list.splice(at, 0, ...made);
            if (!isPage) blocks.get(id).has_children = true;
            touch(id);
            return send(200, { object: 'list', results: made.map((m) => out(blocks.get(m))), has_more: false, next_cursor: null });
          }
        }
        if (isPage) return fail(400, 'validation_error', 'a page is not a block here');
        const b = blocks.get(id);
        if (req.method === 'GET') return send(200, out(b));
        if (req.method === 'DELETE') {
          b.archived = true;
          touch(id);
          return send(200, out(b));
        }
        if (req.method === 'PATCH') {
          for (const k of Object.keys(body)) {
            if (k === 'archived') b.archived = !!body.archived;
            else if (k !== b.type) return fail(400, 'validation_error', `body.${k} should be not present, instead was set.`);
          }
          if (body[b.type]) {
            const upd = { ...body[b.type] };
            if (upd.rich_text) upd.rich_text = richOut(upd.rich_text);
            Object.assign(b[b.type], upd);
          }
          touch(id);
          return send(200, out(b));
        }
      }
      return fail(400, 'invalid_request_url', 'Invalid request URL.');
    } catch (err) {
      return fail(err.status ?? 500, err.code ?? 'internal_server_error', err.message);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });

  return {
    token,
    pages,
    blocks,
    kids,
    log,
    failures,
    broken,
    addPage,
    addDatabase,
    tree,
    edit,
    setProperty,
    mutations,
    pageOf,
    get lastEditedBy() {
      return lastEditedBy;
    },
    // The next n requests answer status (429 by default) with Retry-After.
    failNext(n, { status = 429, retryAfter = '0' } = {}) {
      for (let i = 0; i < n; i++) failures.push({ status, retryAfter });
    },
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      this.url = `http://127.0.0.1:${server.address().port}/v1`;
      return this;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
