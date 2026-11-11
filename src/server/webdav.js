// <base>/dav/: the workspace as a network drive (WebDAV, RFC 4918 class 1
// and 2), for Windows Explorer (Map network drive), macOS Finder (Connect to
// Server) and Linux (davfs2, GNOME Files), with no driver to install.
//
// Nothing here writes a file itself. Every PUT, DELETE, MOVE and COPY goes
// through the agent workspace in fs.js, exactly like PUT and DELETE on /fs:
// path checks, refused sensitive files, the claim, the ledger before and
// after, the atomic write, and (in the hub) quotas and the compute pool.
// MOVE is a create at the destination plus a delete of the source, by the
// same agent, so one run records both; COPY is a create.
//
// Who writes: the engine sets X-Grapim-Agent to dav-<client> (windows,
// macos, linux or dav, from the User-Agent), so the run is
// http:dav-<client> on grapim serve and http:<token-name>/dav-<client> in
// the hub.
//
// Locks (class 2) are short, exclusive write locks on files, kept in memory
// and mapped onto the Grapim claim: a locked file is claimed in the ledger by
// the locking agent for as long as the lock lasts, so /fs, MCP and hook agents
// see it as held. A write to a locked file needs the lock's token in the If
// header and the same agent; anything else is 423 Locked. Without a lock, a
// DAV write releases its claim when it is done (a drive has no _release).
//
// Explorer and Finder litter every folder with desktop.ini, Thumbs.db,
// .DS_Store and ._* files. Those writes are accepted and kept in memory
// only (small, few, lost when the workspace engine closes): never stored,
// never recorded.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sha1 } from '../ledger.js';
import { httpAgent, MAX_LISTED, TEMP } from './fs.js';
import { HttpError, badRequest, headerText, readBody } from './http.js';
import { decodePath, guardSensitiveWrite, isGitAlias, isHidden, resolvePath } from './paths.js';

export const DAV_METHODS = ['OPTIONS', 'GET', 'HEAD', 'PUT', 'DELETE', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK'];
// Methods that change something (or take a claim). PROPFIND is a read.
export const DAV_WRITES = new Set(['PUT', 'DELETE', 'MKCOL', 'MOVE', 'COPY', 'PROPPATCH', 'LOCK', 'UNLOCK']);

const MAX_XML = 64 * 1024; // PROPFIND, PROPPATCH and LOCK bodies
const MAX_TREE = MAX_LISTED; // files one DELETE, MOVE or COPY of a folder may touch
const LOCK_DEFAULT_S = 600;
const LOCK_MAX_S = 1800; // the claim's own default lifetime
const JUNK_MAX_BYTES = 256 * 1024;
const JUNK_MAX = 500;
// All desktop files of one workspace engine together: 500 x 256 KB would be
// 125 MB of memory per open workspace (security review batch 5, M3).
const JUNK_MAX_TOTAL = 4 * 1024 * 1024;
// Locks live in memory and each holds a claim that blocks every other agent:
// a cap per drive (agent) and per workspace (security review batch 5, M2).
export const MAX_LOCKS_PER_AGENT = 100;
export const MAX_LOCKS = 1000;
const ETAG_CACHE = 20_000;
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const fold = (s) => (FOLD ? s.toLowerCase() : s);

// "windows", "macos", "linux" or "dav", from the User-Agent.
export function davClient(userAgent) {
  const ua = String(userAgent ?? '');
  if (/Microsoft-WebDAV-MiniRedir/i.test(ua)) return 'windows';
  if (/WebDAVFS/i.test(ua)) return 'macos';
  if (/davfs2/i.test(ua)) return 'linux';
  return 'dav';
}

// Files the desktop writes into every folder it opens. Never stored.
export function isJunk(rel) {
  const name = String(rel).split('/').at(-1).toLowerCase();
  return name === 'desktop.ini' || name === 'thumbs.db' || name === '.ds_store' || name.startsWith('._');
}

// The repo-relative path in "/dav/<raw>" (raw as sent, below /dav/), decoded
// one segment at a time: "" for the root, never a trailing slash. An escaped
// slash or backslash (%2F, %5C) is refused, so one segment cannot become two;
// everything else is left to resolvePath (.., ., //, .git, links out).
export function davRel(raw) {
  let s = String(raw ?? '');
  if (s === '' || s === '/') return '';
  if (s.endsWith('/')) s = s.slice(0, -1);
  return s
    .split('/')
    .map((seg) => {
      const d = decodePath(seg);
      if (d.includes('/') || d.includes('\\')) throw badRequest(`Refused path "${raw}": an escaped slash (%2F or %5C) is not allowed.`);
      return d;
    })
    .join('/');
}

// An error with a status the API's table does not have (207 is not an error).
function davError(status, code, message, headers = {}) {
  const e = new HttpError(code, message, headers);
  e.status = status;
  return e;
}
const locked = (message) => davError(423, 'locked', message);
const forbidden = (message) => davError(403, 'forbidden', message);
const conflict409 = (message) => davError(409, 'conflict', message);
const precondition = (message) => davError(412, 'precondition_failed', message);

// ---------------------------------------------------------------- XML

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n';

export const xmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(n);
      } catch {
        throw badRequest('The XML body has a bad character reference.');
      }
    }
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e];
  });
}

// A small XML reader for the bodies DAV clients send: elements, attributes,
// namespaces, text and CDATA. No DOCTYPE and no entities beyond the five
// built in (no XXE, no entity expansion). Returns the root element as
// { ns, name, attrs, children, text }.
export function parseXml(text) {
  const s = String(text).replace(/^﻿/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) throw badRequest('XML with a DOCTYPE or entities is not accepted.');
  const bad = () => badRequest('The XML body is not well formed.');
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const top = { children: [], scope: { xml: 'http://www.w3.org/XML/1998/namespace' } };
  const stack = [top];
  let pos = 0;
  let m;
  const qualify = (qname, scope, attr = false) => {
    const i = qname.indexOf(':');
    const prefix = i < 0 ? '' : qname.slice(0, i);
    const local = i < 0 ? qname : qname.slice(i + 1);
    if (attr && !prefix) return { ns: '', name: local };
    const ns = scope[prefix];
    if (ns === undefined) {
      if (prefix) throw badRequest(`The XML body uses the undeclared prefix "${prefix}".`);
      return { ns: '', name: local };
    }
    return { ns, name: local };
  };
  while ((m = re.exec(s))) {
    if (m.index !== pos) throw bad();
    pos = re.lastIndex;
    const cur = stack.at(-1);
    if (m[0].startsWith('<!--') || m[0].startsWith('<?')) continue;
    if (m[1] !== undefined) {
      if (stack.length === 1) throw bad();
      cur.text += m[1];
    } else if (m[2] !== undefined) {
      if (stack.length === 1 || cur.qname !== m[2]) throw bad();
      stack.pop();
    } else if (m[3] !== undefined) {
      if (stack.length === 1 && top.children.length) throw bad(); // one root
      const raw = [...m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((a) => [a[1], decodeEntities(a[2] ?? a[3] ?? '')]);
      const scope = { ...cur.scope };
      for (const [k, v] of raw) {
        if (k === 'xmlns') scope[''] = v;
        else if (k.startsWith('xmlns:')) scope[k.slice(6)] = v;
      }
      const el = { ...qualify(m[3], scope), qname: m[3], attrs: {}, children: [], text: '', scope };
      for (const [k, v] of raw) if (k !== 'xmlns' && !k.startsWith('xmlns:')) el.attrs[k] = v;
      cur.children.push(el);
      if (!m[5]) stack.push(el);
    } else {
      if (stack.length === 1) {
        if (m[6].trim()) throw bad();
      } else cur.text += decodeEntities(m[6]);
    }
  }
  if (pos !== s.length || stack.length !== 1 || top.children.length !== 1) throw bad();
  return top.children[0];
}

const isDav = (el, name) => el && el.ns === 'DAV:' && el.name === name;
const child = (el, name) => el?.children.find((c) => isDav(c, name)) ?? null;

async function readXml(req) {
  const buf = await readBody(req, MAX_XML);
  const text = buf.toString('utf8');
  return text.trim() ? parseXml(text) : null;
}

// ---------------------------------------------------------------- headers

// Lock tokens submitted in the If header (RFC 4918 10.4), from every list,
// tagged or not. "Not" conditions are ignored; a token alone never grants
// anything (the lock's agent must match too).
function submittedTokens(req) {
  const h = headerText(req, 'if') ?? '';
  const out = new Set();
  for (const list of h.matchAll(/\(([^)]*)\)/g)) for (const t of list[1].matchAll(/<([^>]+)>/g)) out.add(t[1].trim());
  return out;
}

function timeoutOf(req) {
  const h = headerText(req, 'timeout') ?? '';
  for (const part of h.split(',').map((s) => s.trim().toLowerCase())) {
    if (part === 'infinite') return LOCK_MAX_S;
    const m = /^second-(\d{1,10})$/.exec(part);
    if (m) return Math.max(1, Math.min(LOCK_MAX_S, Number(m[1])));
  }
  return LOCK_DEFAULT_S;
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const httpDate = (ms) => new Date(ms).toUTCString();

const TYPES = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html',
  '.css': 'text/css', '.js': 'text/javascript', '.xml': 'application/xml', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
// For PROPFIND only: GET always answers application/octet-stream, so no
// workspace file is ever rendered as a page by a browser.
const typeOf = (name) => TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';

function reply(res, status, headers = {}, body = null) {
  const buf = body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const h = { 'Cache-Control': 'no-store', ...headers };
  if (status !== 204 && status !== 304) h['Content-Length'] = buf ? buf.length : 0;
  res.writeHead(status, h);
  res.end(buf ?? undefined);
}

const XML_TYPE = { 'Content-Type': 'application/xml; charset=utf-8' };

// ---------------------------------------------------------------- the server

// ctx: the engine's context. Uses store, ws, env, workspace and base, and
// for access: authorizeTarget (every path a request reads or writes, the
// destination of a MOVE or COPY and each file inside a folder included, as
// { kind: 'dav', write, access, path }), readable (listings leave out what
// the caller cannot see) and admit (bytes a COPY creates, for the quota).
export function createDav(ctx) {
  const { store, ws, env = {}, workspace, base = '' } = ctx;
  const locks = new Map(); // file key -> { token, key, rel, agent, owner, ownerHref, timeoutS, expiresAt }
  const junk = new Map(); // fold(rel) -> { rel, buf, mtime, created }
  const etags = new Map(); // abs -> { mtimeMs, size, sha }
  const davBase = `${base}/dav`;

  const href = (rel, dir) => `${davBase}/${rel ? rel.split('/').map(encodeURIComponent).join('/') : ''}${dir && rel ? '/' : ''}`;
  const agentOf = (req) => httpAgent(headerText(req, 'x-grapim-agent'));

  // The engine's path check for one path this request reads or writes ("dir/"
  // for a folder). A token scoped to some folders gets 404 or 403 here.
  async function check(req, write, rel, dir = false) {
    const t = resolvePath(ws, dir && rel ? `${rel}/` : rel);
    const info = { kind: 'dav', write, access: write ? 'write' : 'read', method: req.method };
    if (ctx.authorizeTarget) await ctx.authorizeTarget(req, info, t);
    else await ctx.authorize?.(req, { ...info, path: dir && rel ? `${rel}/` : rel });
  }
  const visible = (req) => ctx.readable?.(req) ?? null;

  // A folder a DELETE, MOVE or COPY takes as a whole must hold nothing the
  // caller cannot see: refused without naming it, since the per-file checks
  // below would answer with that file's path (security review batch 5, M1).
  function ownTree(req, dirRel, { files, dirs }) {
    const see = visible(req);
    if (!see) return;
    if (files.some((f) => !see(f, 'file')) || dirs.some((d) => !see(d, 'dir'))) {
      throw forbidden(`${dirRel || '/'} holds files outside what this token can see, so it cannot be ${req.method === 'DELETE' ? 'deleted' : req.method === 'MOVE' ? 'moved' : 'copied'} as a whole. Work on the files inside it one by one.`);
    }
  }

  const statOf = (abs) => {
    try {
      return fs.statSync(abs);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
      throw err;
    }
  };

  // The request path checked by resolvePath: { rel, abs, key, st }.
  function locate(rel) {
    const t = resolvePath(ws, rel);
    const st = statOf(t.abs);
    if (st && !st.isFile() && !st.isDirectory()) throw badRequest(`${rel} is not a regular file or folder.`);
    return { rel, abs: t.abs, key: t.file?.key ?? '', st };
  }

  const parentIsDir = (abs) => !!statOf(path.dirname(abs))?.isDirectory();

  // ---- locks ----

  function liveLocks() {
    const now = Date.now();
    for (const [k, l] of locks) if (l.expiresAt <= now) locks.delete(k);
    return locks;
  }

  // 423 unless every DAV lock on these keys (or under these folder keys) is
  // this agent's and its token was submitted.
  function checkLocks(req, me, keys, folders = []) {
    const sent = submittedTokens(req);
    for (const l of liveLocks().values()) {
      const hit = keys.includes(l.key) || folders.some((f) => f === '' || l.key.startsWith(`${f}/`));
      if (hit && !(sent.has(l.token) && l.agent === me.agent)) {
        throw locked(`${l.rel} is locked${l.agent === me.agent ? '; send its lock token in the If header' : ` by ${l.agent}`}.`);
      }
    }
  }

  // 423 when another agent claims one of these files (an /fs or MCP agent,
  // a hook, another drive), before fs.js would answer 409.
  function checkClaims(me, keys) {
    for (const key of keys) {
      const h = store.holder(key, me.agent);
      if (h) throw locked(`${h.path} is being edited by ${h.label || h.agent}. Try again later.`);
    }
  }

  // After a write: a locked file keeps its claim for the rest of the lock,
  // any other file is released.
  async function settle(me, rels) {
    for (const rel of rels) {
      if (isJunk(rel)) continue;
      let key;
      try {
        key = resolvePath(ws, rel).file?.key;
      } catch {
        continue;
      }
      const l = liveLocks().get(key);
      if (l && l.agent === me.agent) workspace.hold(me, rel, { ttlMs: Math.max(1000, l.expiresAt - Date.now()) });
      else await workspace.letGo(me, rel);
    }
  }

  function activeLock(l) {
    const owner = l.owner ? `<D:owner>${l.ownerHref ? `<D:href>${xmlEscape(l.owner)}</D:href>` : xmlEscape(l.owner)}</D:owner>` : '';
    const left = Math.max(0, Math.round((l.expiresAt - Date.now()) / 1000));
    return `<D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth>${owner}<D:timeout>Second-${left}</D:timeout><D:locktoken><D:href>${xmlEscape(l.token)}</D:href></D:locktoken><D:lockroot><D:href>${xmlEscape(href(l.rel, false))}</D:href></D:lockroot></D:activelock>`;
  }

  // ---- junk ----

  const junkGet = (rel) => junk.get(fold(rel)) ?? null;
  function junkPut(rel, buf) {
    const now = Date.now();
    const had = junkGet(rel);
    junk.delete(fold(rel));
    junk.set(fold(rel), { rel, buf: buf.length <= JUNK_MAX_BYTES ? buf : Buffer.alloc(0), mtime: now, created: had?.created ?? now });
    while (junk.size > JUNK_MAX) junk.delete(junk.keys().next().value);
    // Oldest first, until every kept desktop file fits in JUNK_MAX_TOTAL.
    let total = 0;
    for (const j of junk.values()) total += j.buf.length;
    for (const [k, j] of junk) {
      if (total <= JUNK_MAX_TOTAL) break;
      total -= j.buf.length;
      junk.delete(k);
    }
  }
  const junkUnder = (dirRel) => [...junk.values()].filter((j) => (dirRel ? fold(j.rel).startsWith(`${fold(dirRel)}/`) : true));

  // ---- listing ----

  // A folder's entries as { rel, name, abs, st }: never .git, the state
  // folder, temp files, links out of the repo or names resolvePath refuses.
  function entries(dirAbs, dirRel) {
    const out = [];
    let list;
    try {
      list = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const d of list) {
      if (out.length >= MAX_LISTED) break;
      const abs = path.join(dirAbs, d.name);
      if (isHidden(ws, abs) || TEMP.test(d.name) || isGitAlias(d.name)) continue;
      const rel = dirRel ? `${dirRel}/${d.name}` : d.name;
      if (d.isSymbolicLink()) {
        try {
          resolvePath(ws, rel);
        } catch {
          continue;
        }
      }
      const st = statOf(abs);
      if (!st || !(st.isFile() || st.isDirectory())) continue;
      out.push({ rel, name: d.name, abs, st });
    }
    return out;
  }

  // Every file and folder under a folder, deepest folders last in `dirs`.
  function tree(dirAbs, dirRel) {
    const files = [];
    const dirs = [];
    const walk = (abs, rel) => {
      for (const e of entries(abs, rel)) {
        if (e.st.isDirectory()) {
          dirs.push(e.rel);
          walk(e.abs, e.rel);
        } else {
          files.push(e.rel);
          if (files.length > MAX_TREE) throw davError(413, 'too_large', `The folder ${dirRel || '/'} holds more than ${MAX_TREE} files, too many for one WebDAV request. Use grapim folder, or the API, for it.`);
        }
      }
    };
    walk(dirAbs, dirRel);
    return { files, dirs };
  }

  async function etagOf(abs, st) {
    const hit = etags.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.sha;
    let sha;
    try {
      sha = sha1(await fs.promises.readFile(abs));
    } catch {
      return null;
    }
    etags.delete(abs);
    etags.set(abs, { mtimeMs: st.mtimeMs, size: st.size, sha });
    while (etags.size > ETAG_CACHE) etags.delete(etags.keys().next().value);
    return sha;
  }

  // ---- PROPFIND ----

  const LIVE = ['creationdate', 'displayname', 'getcontentlength', 'getcontenttype', 'getetag', 'getlastmodified', 'lockdiscovery', 'resourcetype', 'supportedlock'];

  // One property's value as XML, or undefined if the resource has none.
  async function propValue(name, e) {
    switch (name) {
      case 'creationdate':
        return iso(e.created);
      case 'displayname':
        return xmlEscape(e.name);
      case 'getcontentlength':
        return e.dir ? undefined : String(e.size);
      case 'getcontenttype':
        return e.dir ? undefined : typeOf(e.name);
      case 'getetag': {
        if (e.dir) return undefined;
        const sha = e.buf ? sha1(e.buf) : await etagOf(e.abs, e.st);
        return sha ? `"${sha}"` : undefined;
      }
      case 'getlastmodified':
        return httpDate(e.mtime);
      case 'lockdiscovery': {
        if (e.dir) return '';
        const l = [...liveLocks().values()].find((x) => fold(x.rel) === fold(e.rel));
        return l ? activeLock(l) : '';
      }
      case 'resourcetype':
        return e.dir ? '<D:collection/>' : '';
      case 'supportedlock':
        return e.dir ? '' : '<D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>';
      default:
        return undefined;
    }
  }

  const tag = (p, i, inner = null) => {
    if (p.ns === 'DAV:') return inner === null || inner === '' ? `<D:${p.name}/>` : `<D:${p.name}>${inner}</D:${p.name}>`;
    const decl = p.ns ? `z${i}:${p.name} xmlns:z${i}="${xmlEscape(p.ns)}"` : `${p.name} xmlns=""`;
    return `<${decl}/>`;
  };

  async function responseOf(e, want) {
    const found = [];
    const missing = [];
    const props = want.mode === 'prop' ? want.props : LIVE.map((name) => ({ ns: 'DAV:', name }));
    for (const [i, p] of props.entries()) {
      if (want.mode === 'propname') {
        found.push(tag(p, i));
        continue;
      }
      const v = p.ns === 'DAV:' ? await propValue(p.name, e) : undefined;
      if (v === undefined) missing.push(tag(p, i));
      else found.push(tag(p, i, v));
    }
    const stat = (list, status) => (list.length ? `<D:propstat><D:prop>${list.join('')}</D:prop><D:status>HTTP/1.1 ${status}</D:status></D:propstat>` : '');
    return `<D:response><D:href>${xmlEscape(href(e.rel, e.dir))}</D:href>${stat(found, '200 OK')}${stat(missing, '404 Not Found')}</D:response>`;
  }

  const entryOf = ({ rel, name, abs, st }) => ({
    rel,
    name,
    abs,
    st,
    dir: st.isDirectory(),
    size: st.size,
    mtime: st.mtimeMs,
    created: st.birthtimeMs || st.ctimeMs || st.mtimeMs,
  });
  const junkEntry = (j) => ({ rel: j.rel, name: j.rel.split('/').at(-1), dir: false, size: j.buf.length, mtime: j.mtime, created: j.created, buf: j.buf });

  function wanted(body) {
    if (!body) return { mode: 'allprop' };
    if (!isDav(body, 'propfind')) throw badRequest('A PROPFIND body must be a DAV: propfind element.');
    if (child(body, 'propname')) return { mode: 'propname' };
    const prop = child(body, 'prop');
    if (prop) return { mode: 'prop', props: prop.children.map((c) => ({ ns: c.ns, name: c.name })) };
    return { mode: 'allprop' };
  }

  async function propfind(req, res, rel) {
    const depth = (headerText(req, 'depth') ?? 'infinity').toLowerCase();
    if (depth !== '0' && depth !== '1') {
      req.resume();
      return reply(res, 403, XML_TYPE, `${XML_HEAD}<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>`);
    }
    const want = wanted(await readXml(req));
    const r = locate(rel);
    await check(req, false, rel, !!r.st?.isDirectory());
    const see = visible(req);
    const out = [];
    if (!r.st) {
      const j = junkGet(rel);
      if (!j) return reply(res, 404);
      out.push(junkEntry(j));
    } else {
      const self = entryOf({ rel, name: rel ? rel.split('/').at(-1) : ws.repo, abs: r.abs, st: r.st });
      out.push(self);
      if (depth === '1' && self.dir) {
        const seen = new Set();
        for (const e of entries(r.abs, rel)) {
          seen.add(fold(e.rel));
          if (!see || see(e.rel, e.st.isDirectory() ? 'dir' : 'file')) out.push(entryOf(e));
        }
        const parent = rel ? fold(`${rel}/`) : '';
        for (const j of junk.values()) {
          const f = fold(j.rel);
          if (f.startsWith(parent) && !f.slice(parent.length).includes('/') && !seen.has(f) && (!see || see(j.rel, 'file'))) out.push(junkEntry(j));
        }
      }
    }
    const parts = [];
    for (const e of out) parts.push(await responseOf(e, want));
    return reply(res, 207, XML_TYPE, `${XML_HEAD}<D:multistatus xmlns:D="DAV:">${parts.join('')}</D:multistatus>`);
  }

  // ---- GET / HEAD ----

  async function get(req, res, rel) {
    const r = locate(rel);
    await check(req, false, rel, !!r.st?.isDirectory());
    if (!r.st) {
      const j = junkGet(rel);
      if (!j) return reply(res, 404);
      return reply(res, 200, { 'Content-Type': 'application/octet-stream', ETag: `"${sha1(j.buf)}"`, 'Last-Modified': httpDate(j.mtime) }, j.buf);
    }
    if (r.st.isDirectory()) {
      // A browser that opens the address: a plain list, never a page.
      const see = visible(req);
      const names = entries(r.abs, rel)
        .filter((e) => !see || see(e.rel, e.st.isDirectory() ? 'dir' : 'file'))
        .map((e) => (e.st.isDirectory() ? `${e.name}/` : e.name));
      return reply(res, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, `This is a WebDAV folder. Mount it as a drive to work with it.\n\n${names.join('\n')}\n`);
    }
    const { buf } = workspace.read(rel);
    return reply(res, 200, { 'Content-Type': 'application/octet-stream', ETag: `"${sha1(buf)}"`, 'Last-Modified': httpDate(r.st.mtimeMs), 'Content-Disposition': 'attachment' }, buf);
  }

  // ---- PUT ----

  // If-Match "<sha>" and If-None-Match: * as an fs.js expectation.
  function expectOf(req) {
    const none = headerText(req, 'if-none-match');
    if (none === '*') return null;
    const raw = headerText(req, 'if-match');
    if (!raw || raw === '*') return undefined;
    const v = /^(?:W\/)?"([^"]*)"$/.exec(raw)?.[1] ?? raw;
    return /^[0-9a-f]{40}$/.test(v) ? v : undefined;
  }

  async function put(req, res, rel) {
    if (!rel) throw davError(405, 'method_not_allowed', 'The workspace root is a folder.', { Allow: 'OPTIONS, GET, HEAD, PROPFIND, MKCOL' });
    const me = agentOf(req);
    const r = locate(rel);
    // The scope first: a folder outside it must not answer differently from a file (batch 5, L1).
    await check(req, true, rel);
    if (r.st?.isDirectory()) throw davError(405, 'method_not_allowed', `${rel} is a folder.`);
    if (!parentIsDir(r.abs)) throw conflict409(`The folder for ${rel} does not exist. Create it first.`);
    if (isJunk(rel)) {
      const body = await readBody(req);
      const had = !!junkGet(rel) || !!r.st;
      junkPut(rel, body);
      return reply(res, had ? 204 : 201, { ETag: `"${sha1(body)}"` });
    }
    // Refused before the body is read: sensitive files, locks, claims.
    guardSensitiveWrite(ws, rel, env, r.abs);
    checkLocks(req, me, [r.key]);
    checkClaims(me, [r.key]);
    const expect = expectOf(req);
    const body = await readBody(req);
    checkLocks(req, me, [r.key]); // a LOCK may have come in while the body arrived
    checkClaims(me, [r.key]);
    const existed = !!statOf(r.abs);
    const w = await workspace.write(me, rel, body, { expect });
    await settle(me, [rel]);
    return reply(res, existed ? 204 : 201, { ETag: `"${w.sha}"` });
  }

  // ---- DELETE ----

  // Removes a folder's files (each one recorded) and then its folders.
  async function removeTree(req, me, r) {
    const { files, dirs } = tree(r.abs, r.rel);
    // Refuse up front, so a refused file leaves the whole folder as it was:
    // a sensitive file, or one the caller may not write.
    await check(req, true, r.rel, true);
    ownTree(req, r.rel, { files, dirs });
    for (const f of files) {
      guardSensitiveWrite(ws, f, env, resolvePath(ws, f).abs);
      await check(req, true, f);
    }
    const keys = files.map((f) => resolvePath(ws, f).file.key);
    checkLocks(req, me, keys, [r.key]);
    checkClaims(me, keys);
    for (const f of files) await workspace.remove(me, f);
    for (const d of [...dirs.reverse(), r.rel]) {
      try {
        fs.rmdirSync(resolvePath(ws, d).abs);
      } catch (err) {
        if (err.code !== 'ENOENT') throw conflict409(`${d} could not be removed: it still holds files Grapim does not serve.`);
      }
    }
    for (const j of junkUnder(r.rel)) junk.delete(fold(j.rel));
    await settle(me, files);
  }

  async function del(req, res, rel) {
    if (!rel) throw forbidden('The workspace root cannot be deleted.');
    const me = agentOf(req);
    const r = locate(rel);
    await check(req, true, rel, !!r.st?.isDirectory());
    if (!r.st) {
      if (junk.delete(fold(rel))) return reply(res, 204);
      return reply(res, 404);
    }
    if (r.st.isDirectory()) {
      await removeTree(req, me, r);
      return reply(res, 204);
    }
    if (isJunk(rel) && junk.delete(fold(rel))) return reply(res, 204); // the in-memory copy shadows a stored one
    guardSensitiveWrite(ws, rel, env, r.abs);
    checkLocks(req, me, [r.key]);
    checkClaims(me, [r.key]);
    await workspace.remove(me, rel, { expect: expectOf(req) });
    const l = liveLocks().get(r.key);
    if (l && l.agent === me.agent) locks.delete(r.key);
    await settle(me, [rel]);
    return reply(res, 204);
  }

  // ---- MKCOL ----

  async function mkcol(req, res, rel) {
    const body = await readBody(req, MAX_XML);
    if (body.length) throw davError(415, 'unsupported_media_type', 'MKCOL takes no body.');
    if (!rel) throw davError(405, 'method_not_allowed', 'The workspace root exists.');
    const r = locate(rel);
    await check(req, true, rel, true);
    if (r.st || junkGet(rel)) throw davError(405, 'method_not_allowed', `${rel} already exists.`, { Allow: 'OPTIONS, GET, HEAD, PROPFIND, PROPPATCH, DELETE, MOVE, COPY' });
    if (!parentIsDir(r.abs)) throw conflict409(`The folder for ${rel} does not exist. Create it first.`);
    await ctx.admit?.(req, { bytes: 0, files: 1 }); // a folder is an inode too
    fs.mkdirSync(r.abs);
    return reply(res, 201);
  }

  // ---- MOVE and COPY ----

  // The Destination header as a repo-relative path. It must name this host
  // and this workspace's /dav/; it is decoded and checked like the request
  // path, never normalised (".." and %2e%2e are refused by resolvePath).
  function destinationOf(req) {
    const raw = headerText(req, 'destination');
    if (!raw) throw badRequest('MOVE and COPY need a Destination header.');
    let target;
    const abs = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(raw);
    if (abs) {
      if (!/^https?$/i.test(abs[1])) throw davError(502, 'bad_gateway', 'The Destination must be on this server.');
      const host = abs[2].toLowerCase();
      const mine = String(req.headers.host ?? '').toLowerCase();
      const bare = (h) => h.replace(/:(80|443)$/, '');
      if (host.includes('@') || !mine || bare(host) !== bare(mine)) throw davError(502, 'bad_gateway', 'The Destination must be on this server.');
      target = abs[3] || '/';
    } else if (raw.startsWith('/')) {
      target = raw.split(/[?#]/)[0];
    } else {
      throw badRequest('The Destination header must be an absolute URL or path.');
    }
    if (target !== davBase && !target.startsWith(`${davBase}/`)) throw davError(502, 'bad_gateway', 'The Destination must be in this workspace\'s /dav/ folder.');
    return davRel(target === davBase ? '' : target.slice(davBase.length + 1));
  }

  async function transfer(req, res, rel, move) {
    const me = agentOf(req);
    const destRel = destinationOf(req);
    const overwrite = (headerText(req, 'overwrite') ?? 'T').toUpperCase() !== 'F';
    if (!rel || !destRel) throw forbidden(`The workspace root cannot be ${move ? 'moved' : 'copied'}, or replaced.`);
    req.resume();
    const src = locate(rel);
    const dst = locate(destRel);
    const dirMove = !!src.st?.isDirectory();
    // The source is read (COPY) or written (MOVE); the destination written.
    await check(req, move, rel, dirMove);
    await check(req, true, destRel, dirMove);
    // On a case-insensitive disk "a.txt" -> "A.txt" is the same file: the
    // create-then-delete of a move would delete it.
    if (fold(rel) === fold(destRel)) throw forbidden(rel === destRel ? 'The source and the destination are the same.' : 'A rename that only changes letter case is not supported on this server.');
    if (fold(destRel).startsWith(`${fold(rel)}/`)) throw forbidden('A folder cannot be moved or copied into itself.');
    if (!parentIsDir(dst.abs)) throw conflict409(`The folder for ${destRel} does not exist. Create it first.`);
    const memo = !src.st ? junkGet(rel) : null;
    if (!src.st && !memo) return reply(res, 404);
    const existed = !!dst.st || !!junkGet(destRel);
    if (existed && !overwrite) throw precondition(`${destRel} exists and Overwrite is F.`);

    // Desktop junk: kept in memory, wherever it goes.
    if (isJunk(destRel)) {
      if (dirMove) throw forbidden(`${destRel} is a name the desktop uses for its own files; a folder cannot take it.`);
      if (src.st && move) throw forbidden(`${destRel} is a name the desktop uses for its own files; Grapim does not store it, so it will not move a file there.`);
      junkPut(destRel, memo ? memo.buf : workspace.read(rel).buf);
      if (move && memo) junk.delete(fold(rel));
      return reply(res, existed ? 204 : 201);
    }

    const depth = (headerText(req, 'depth') ?? 'infinity').toLowerCase();
    if (dirMove && !move && depth !== '0' && depth !== 'infinity') throw badRequest('COPY of a folder takes Depth 0 or infinity.');
    const plan = dirMove ? (move || depth === 'infinity' ? tree(src.abs, rel) : { files: [], dirs: [] }) : { files: memo ? [] : [rel], dirs: [] };
    if (dirMove) ownTree(req, rel, plan);
    const destOf = (f) => (f === rel ? destRel : `${destRel}${f.slice(rel.length)}`);
    // Every file is checked before anything changes: its destination is a
    // valid path the caller may write, neither end is a sensitive file, and
    // no lock or claim stands in the way.
    let bytes = memo ? memo.buf.length : 0;
    for (const f of plan.files) {
      const d = destOf(f);
      guardSensitiveWrite(ws, d, env, resolvePath(ws, d).abs);
      if (move) guardSensitiveWrite(ws, f, env, resolvePath(ws, f).abs);
      if (f !== rel) {
        await check(req, move, f);
        await check(req, true, d);
      }
      bytes += statOf(resolvePath(ws, f).abs)?.size ?? 0;
    }
    const destKeys = plan.files.map((f) => resolvePath(ws, destOf(f)).file.key);
    const srcKeys = move ? plan.files.map((f) => resolvePath(ws, f).file.key) : [];
    checkLocks(req, me, [...destKeys, dst.key, ...srcKeys], [...(dst.st?.isDirectory() ? [dst.key] : []), ...(move && dirMove ? [src.key] : [])]);
    checkClaims(me, [...destKeys, ...srcKeys]);
    // A copy adds bytes and files nobody uploaded: counted toward the quota
    // first. A move adds none.
    if (!move || memo) await ctx.admit?.(req, { bytes, files: Math.max(1, plan.files.length) });

    // Overwrite: a folder at the destination goes first, and a file in the
    // way of a folder (recorded deletes). A file over a file is one write.
    if (dst.st?.isDirectory()) await removeTree(req, me, dst);
    else if (dst.st && dirMove) await workspace.remove(me, destRel);
    if (memo) {
      // A desktop file moved or copied to a real name becomes a real file.
      await workspace.write(me, destRel, memo.buf);
      if (move) junk.delete(fold(rel));
      await settle(me, [destRel]);
      return reply(res, existed ? 204 : 201);
    }
    if (dirMove) {
      fs.mkdirSync(dst.abs, { recursive: true });
      for (const d of plan.dirs) fs.mkdirSync(resolvePath(ws, destOf(d)).abs, { recursive: true });
    }
    const touched = [];
    for (const f of plan.files) {
      const { buf } = workspace.read(f);
      await workspace.write(me, destOf(f), buf);
      touched.push(destOf(f));
      if (move) {
        await workspace.remove(me, f);
        touched.push(f);
        const l = liveLocks().get(resolvePath(ws, f).file.key);
        if (l && l.agent === me.agent) locks.delete(l.key); // a lock never moves with its file
      }
    }
    if (dirMove) {
      for (const j of junkUnder(rel)) {
        junkPut(`${destRel}${j.rel.slice(rel.length)}`, j.buf);
        if (move) junk.delete(fold(j.rel));
      }
    }
    if (move && dirMove) {
      for (const d of [...plan.dirs].reverse().concat(rel)) {
        try {
          fs.rmdirSync(resolvePath(ws, d).abs);
        } catch {}
      }
    }
    await settle(me, touched);
    return reply(res, existed ? 204 : 201);
  }

  // ---- PROPPATCH ----

  // Accepted and ignored (Windows sets its file times and attributes after
  // every upload and gives up on the file without a 207).
  async function proppatch(req, res, rel) {
    const me = agentOf(req);
    const body = await readXml(req);
    if (body && !isDav(body, 'propertyupdate')) throw badRequest('A PROPPATCH body must be a DAV: propertyupdate element.');
    const r = locate(rel);
    await check(req, true, rel, !!r.st?.isDirectory());
    if (!r.st && !junkGet(rel)) return reply(res, 404);
    if (r.st?.isFile()) checkLocks(req, me, [r.key]);
    const props = [];
    for (const op of body?.children ?? []) {
      if (!isDav(op, 'set') && !isDav(op, 'remove')) continue;
      for (const c of child(op, 'prop')?.children ?? []) props.push({ ns: c.ns, name: c.name });
    }
    const list = props.map((p, i) => tag(p, i)).join('');
    const isDir = !!r.st?.isDirectory();
    return reply(res, 207, XML_TYPE, `${XML_HEAD}<D:multistatus xmlns:D="DAV:"><D:response><D:href>${xmlEscape(href(rel, isDir))}</D:href>${list ? `<D:propstat><D:prop>${list}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>` : ''}</D:response></D:multistatus>`);
  }

  // ---- LOCK / UNLOCK ----

  const lockBody = (l) => `${XML_HEAD}<D:prop xmlns:D="DAV:"><D:lockdiscovery>${activeLock(l)}</D:lockdiscovery></D:prop>`;

  async function lock(req, res, rel) {
    const me = agentOf(req);
    const body = await readXml(req);
    if (!rel) throw forbidden('Only files can be locked.');
    const r = locate(rel);
    await check(req, true, rel); // before the folder test, as in put()
    if (r.st?.isDirectory()) throw forbidden('Only files can be locked, not folders.');
    const timeoutS = timeoutOf(req);
    const key = isJunk(rel) ? `junk:${fold(rel)}` : r.key;

    if (!body) {
      // A refresh: the If header names the lock.
      const l = liveLocks().get(key);
      if (!l || !submittedTokens(req).has(l.token)) throw precondition(`There is no lock on ${rel} with the token in the If header.`);
      if (l.agent !== me.agent) throw locked(`${rel} is locked by ${l.agent}.`);
      l.timeoutS = timeoutS;
      l.expiresAt = Date.now() + timeoutS * 1000;
      if (!isJunk(rel)) workspace.hold(me, rel, { ttlMs: timeoutS * 1000 });
      return reply(res, 200, XML_TYPE, lockBody(l));
    }

    if (!isDav(body, 'lockinfo')) throw badRequest('A LOCK body must be a DAV: lockinfo element.');
    if (!child(child(body, 'lockscope'), 'exclusive')) throw precondition('Only exclusive locks are supported.');
    if (child(body, 'locktype') && !child(child(body, 'locktype'), 'write')) throw precondition('Only write locks are supported.');
    const ownerEl = child(body, 'owner');
    const ownerHref = child(ownerEl, 'href');
    const owner = (ownerHref ? ownerHref.text : ownerEl?.text ?? '').trim().slice(0, 200) || null;

    const held = () => {
      const l = liveLocks().get(key);
      if (l) throw locked(`${rel} is already locked${l.agent === me.agent ? '' : ` by ${l.agent}`}.`);
    };
    held();
    // Each lock is memory and a claim held for up to 30 minutes.
    const live = [...liveLocks().values()];
    if (live.filter((x) => x.agent === me.agent).length >= MAX_LOCKS_PER_AGENT) throw locked(`This drive holds ${MAX_LOCKS_PER_AGENT} locks already. Close some files first.`);
    if (live.length >= MAX_LOCKS) throw locked(`This workspace has ${MAX_LOCKS} locked files. Try again when some are closed.`);
    let created = false;
    if (!isJunk(rel)) {
      checkClaims(me, [r.key]);
      if (!parentIsDir(r.abs)) throw conflict409(`The folder for ${rel} does not exist. Create it first.`);
      // Locking a name that does not exist yet creates it empty (RFC 4918
      // 7.3): Windows locks, writes 0 bytes, then the content.
      if (!r.st) {
        // A new file, like a PUT: within the workspace's file cap (batch 5, M2).
        await ctx.admit?.(req, { bytes: 0, files: 1 });
        await workspace.write(me, rel, Buffer.alloc(0), { expect: null });
        created = true;
      }
      held(); // another LOCK may have won while the file was created
      workspace.hold(me, rel, { ttlMs: timeoutS * 1000 });
    } else if (!r.st && !junkGet(rel)) {
      junkPut(rel, Buffer.alloc(0));
      created = true;
    }
    const l = { token: `opaquelocktoken:${crypto.randomUUID()}`, key, rel, agent: me.agent, owner, ownerHref: !!ownerHref, timeoutS, expiresAt: Date.now() + timeoutS * 1000 };
    locks.set(key, l);
    return reply(res, created ? 201 : 200, { ...XML_TYPE, 'Lock-Token': `<${l.token}>` }, lockBody(l));
  }

  async function unlock(req, res, rel) {
    const me = agentOf(req);
    req.resume();
    const token = /^<([^>]+)>$/.exec(headerText(req, 'lock-token') ?? '')?.[1];
    if (!token) throw badRequest('UNLOCK needs a Lock-Token header: <opaquelocktoken:...>.');
    const r = rel ? locate(rel) : null;
    if (rel) await check(req, true, rel);
    const key = isJunk(rel) ? `junk:${fold(rel)}` : r?.key;
    const l = key ? liveLocks().get(key) : null;
    if (!l || l.token !== token) throw conflict409(`${rel || '/'} has no lock with that token.`);
    if (l.agent !== me.agent) throw forbidden(`${rel} is locked by ${l.agent}; only it can unlock it.`);
    locks.delete(key);
    if (!isJunk(rel)) await workspace.letGo(me, rel);
    return reply(res, 204);
  }

  // ---- the request ----

  // rawPath is "/dav" or starts with "/dav/" (below the base, not decoded).
  async function handle(req, res, rawPath) {
    const rel = davRel(rawPath === '/dav' ? '' : rawPath.slice('/dav/'.length));
    switch (req.method) {
      case 'OPTIONS':
        req.resume();
        return reply(res, 200, { DAV: '1, 2', 'MS-Author-Via': 'DAV', Allow: DAV_METHODS.join(', '), 'Accept-Ranges': 'none' });
      case 'PROPFIND':
        return propfind(req, res, rel);
      case 'GET':
      case 'HEAD':
        req.resume();
        return get(req, res, rel);
      case 'PUT':
        return put(req, res, rel);
      case 'DELETE':
        req.resume();
        return del(req, res, rel);
      case 'MKCOL':
        return mkcol(req, res, rel);
      case 'MOVE':
        return transfer(req, res, rel, true);
      case 'COPY':
        return transfer(req, res, rel, false);
      case 'PROPPATCH':
        return proppatch(req, res, rel);
      case 'LOCK':
        return lock(req, res, rel);
      case 'UNLOCK':
        return unlock(req, res, rel);
      default:
        req.resume();
        throw davError(405, 'method_not_allowed', `Use ${DAV_METHODS.join(', ')} here.`, { Allow: DAV_METHODS.join(', ') });
    }
  }

  return { handle, locks, junk };
}
