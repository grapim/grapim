// `grapim folder <workspace-url> <dir>`: keeps a local folder and a Grapim
// workspace in sync both ways, like Dropbox (docs/workspaces.md §3).
//
// The manifest maps each synced path to the sha both sides last agreed on;
// base/<sha> keeps those bytes, so a later edit on both sides can be merged
// three ways. Per path, with L local, R remote and B the manifest sha:
//   L == R            agree: B = L
//   L == B            only the workspace changed: take R
//   R == B            only the folder changed: PUT/DELETE with If-Match: B
//   both changed      merge with git merge-file; if it conflicts, is binary
//                     or has no base, keep both (a conflict copy of L)
// Every write to the workspace is conditional (If-Match), and every write to
// the folder re-reads the file right before the rename, so a change made by
// someone else in between is never overwritten: the step is retried later.
// The invariant: never lose bytes from either side.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sha1 } from './ledger.js';
import { isGitAlias, sensitiveReason } from './server/paths.js';
import { machineName } from './sync.js';
import { mergeFile } from './undo.js';

export const STATE_DIR = '.grapim-sync';
export const MAX_FILE = 32 * 1024 * 1024;
export const POLL_MS = 2000;
const PAGE = 500;
// Base versions no manifest entry needs any more are kept this long (a deleted
// file's last bytes stay recoverable from .grapim-sync/base for a month).
const BASE_KEEP_MS = 30 * 24 * 3600 * 1000;
// A file changed this recently is re-hashed even if its size and mtime match
// the last scan (an edit within the clock's resolution keeps the same mtime).
const RACY_MS = 3000;
// Release our claims after this many writes, so agents are not kept waiting.
const RELEASE_EVERY = 50;
const WIN = process.platform === 'win32';
// Folders where "A.txt" and "a.txt" are one file.
const FOLD = WIN || process.platform === 'darwin';
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$) *(\..*)?$/i;
const OUR_TEMP = /\.grapim-sync-[0-9a-f]+\.tmp$/;
const SERVER_TEMP = /\.grapim-\d+-[0-9a-f]+\.tmp$/;

export class FolderSyncError extends Error {
  // fatal: stop syncing (401/403, a refused folder). transient: back off and retry.
  constructor(message, { fatal = false, transient = false, retryAfter = null } = {}) {
    super(message);
    this.fatal = fatal;
    this.transient = transient;
    this.retryAfter = retryAfter;
  }
}

const fatal = (m) => new FolderSyncError(m, { fatal: true });
const transient = (m, retryAfter = null) => new FolderSyncError(m, { transient: true, retryAfter });

// Text from the workspace (error messages) goes to a terminal: no control characters.
const clean = (s) => String(s).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '�');
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---------------------------------------------------------------------------
// Paths and ignore rules

// A repo-relative path we are willing to create on this machine. Paths come
// from the workspace, so this is what keeps a hostile one inside <dir>.
export function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 4096) return false;
  if (/[\x00-\x1f\x7f\\]/.test(rel) || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return false;
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.' || seg === '..') return false;
    if (WIN && (/[<>:"|?*]/.test(seg) || /[. ]$/.test(seg) || DEVICE.test(seg))) return false;
    // ".git." or "git~1" is .git itself on Windows (and with HFS+ ignorables on macOS).
    if (isGitAlias(seg)) return false;
    // An 8.3 short name ("CLAUDE~1", "GRAPIM~1") is another name for a folder
    // already here on Windows, so it would write into .claude or our state.
    if (SHORT_NAME.test(seg)) return false;
  }
  return true;
}

// Looks like a Windows 8.3 short name: up to 6 characters, ~N, a short extension.
const SHORT_NAME = /^[^.~]{1,6}~\d{1,6}(\.[^.]{1,3})?$/;

function globSource(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}

// gitignore syntax, the simple subset: # comments, ! negation, a trailing /
// for folders only, a / anywhere else anchors to <dir>, *, ? and **.
export function parseIgnore(text, { foldCase = false } = {}) {
  const rules = [];
  for (let line of String(text).split(/\r?\n/)) {
    line = line.replace(/[ \t]+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    }
    if (line.startsWith('\\')) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.replace(/\/+$/, '');
    }
    const anchored = line.includes('/');
    line = line.replace(/^\/+/, '');
    if (!line) continue;
    const body = globSource(line);
    rules.push({ re: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`, foldCase ? 'i' : ''), negate, dirOnly });
  }
  return rules;
}

const BUILTIN = parseIgnore(['.git', `${STATE_DIR}/`, 'node_modules/', '.DS_Store', 'Thumbs.db'].join('\n'), { foldCase: true });

function matches(rules, rel, isDir) {
  let hit = false;
  for (const r of rules) if ((!r.dirOnly || isDir) && r.re.test(rel)) hit = !r.negate;
  return hit;
}

// (rel, isDir) -> ignored? A path inside an ignored folder is ignored.
export function ignoreMatcher(userText = '') {
  const user = parseIgnore(userText);
  const one = (rel, isDir) => matches(BUILTIN, rel, isDir) || matches(user, rel, isDir);
  return (rel, isDir = false) => {
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    if (OUR_TEMP.test(name) || SERVER_TEMP.test(name)) return true;
    const segs = rel.split('/');
    for (let i = 1; i < segs.length; i++) if (one(segs.slice(0, i).join('/'), true)) return true;
    return one(rel, isDir);
  };
}

// "notes.md" -> "notes (conflict from laptop 2026-11-11).md"; n > 1 adds " n".
export function conflictName(rel, machine, date, n = 1) {
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
  const name = rel.slice(dir.length);
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  return `${dir}${stem} (conflict from ${machine} ${date}${n > 1 ? ` ${n}` : ''})${ext}`;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// The local folder. Links are never followed: a path with a link anywhere in
// it is skipped, for reading and for writing.

const lstat = (abs) => {
  try {
    return fs.lstatSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
};

function renameRetrying(from, to) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      if (i >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      sleepSync(25 * (i + 1));
    }
  }
}

function atomicWriteFile(abs, buf) {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.grapim-sync-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, buf, { flag: 'wx' });
    renameRetrying(tmp, abs);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Skip: this path cannot be synced as it is (a link, a bad name): warn, move on.
// Busy: the file is locked right now (an editor on Windows): try again later.
class Skip extends Error {}
class Busy extends Error {}
const BUSY = ['EPERM', 'EACCES', 'EBUSY'];

// The parent folders of rel, checked: none may be a link or a file. With
// create, missing ones are made. Returns false if one is missing (no create).
function parents(root, rel, create) {
  const segs = rel.split('/');
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = path.join(cur, segs[i]);
    const st = lstat(cur);
    if (!st) {
      if (!create) return false;
      try {
        fs.mkdirSync(cur);
      } catch (err) {
        if (err.code !== 'EEXIST') throw new Skip(`cannot create the folder ${segs.slice(0, i + 1).join('/')}: ${err.code}`);
      }
      continue;
    }
    if (st.isSymbolicLink()) throw new Skip(`${segs.slice(0, i + 1).join('/')} is a link, which sync does not follow`);
    if (!st.isDirectory()) throw new Skip(`${segs.slice(0, i + 1).join('/')} is a file, so it cannot hold ${rel}`);
  }
  return true;
}

// The file now: { sha, buf } or { sha: null } if absent. Throws Skip for a
// link, a folder, a device or a file over the size cap.
function readLocal(root, rel) {
  if (!parents(root, rel, false)) return { sha: null, buf: null };
  const abs = path.join(root, ...rel.split('/'));
  const st = lstat(abs);
  if (!st) return { sha: null, buf: null };
  if (st.isSymbolicLink()) throw new Skip(`${rel} is a link, which sync does not follow`);
  if (st.isDirectory()) throw new Skip(`${rel} is a folder here and a file in the workspace`);
  if (!st.isFile()) throw new Skip(`${rel} is not a regular file`);
  if (st.size > MAX_FILE) throw new Skip(`${rel} is over 32 MB`);
  if (FOLD) {
    // The name on disk must be this name, not one that differs only in
    // letter case (or Unicode form): this folder cannot hold both.
    let real;
    try {
      real = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(abs)).split(path.sep).join('/');
    } catch {
      real = rel;
    }
    if (real.normalize('NFC') !== rel.normalize('NFC')) throw new Skip(`${rel} is ${real} in this folder (only the letter case differs), and this folder cannot hold both`);
  }
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT') return { sha: null, buf: null };
    throw new Skip(`cannot read ${rel}: ${err.code ?? err.message}`);
  }
  return { sha: sha1(buf), buf };
}

const localSha = (root, rel) => {
  try {
    return readLocal(root, rel).sha;
  } catch (err) {
    if (err instanceof Skip) return undefined;
    throw err;
  }
};

// Writes buf at rel only if the file is still `expect` (a sha, or null for
// absent) right before the rename. False if it changed: nothing is written.
function writeLocal(root, rel, buf, expect) {
  parents(root, rel, true);
  const abs = path.join(root, ...rel.split('/'));
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.grapim-sync-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, buf, { flag: 'wx' });
    const mode = lstat(abs)?.mode;
    if (mode !== undefined && !WIN) fs.chmodSync(tmp, mode & 0o7777);
    if (localSha(root, rel) !== expect) return false;
    try {
      renameRetrying(tmp, abs);
    } catch (err) {
      if (BUSY.includes(err.code)) throw new Busy(`${rel} is in use (${err.code})`);
      throw err;
    }
    return true;
  } catch (err) {
    if (err instanceof Skip || err instanceof Busy) throw err;
    if (['EACCES', 'EPERM', 'EINVAL', 'ENAMETOOLONG', 'EISDIR', 'ENOTDIR'].includes(err.code)) throw new Skip(`cannot write ${rel}: ${err.code}`);
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Deletes rel only if it is still `expect`, then any folders that became empty.
function removeLocal(root, rel, expect) {
  if (localSha(root, rel) !== expect) return false;
  const abs = path.join(root, ...rel.split('/'));
  try {
    fs.rmSync(abs, { force: true });
  } catch (err) {
    if (BUSY.includes(err.code)) throw new Busy(`${rel} is in use (${err.code})`);
    throw new Skip(`cannot delete ${rel}: ${err.code ?? err.message}`);
  }
  for (let dir = path.dirname(abs); dir !== root && dir.startsWith(root); dir = path.dirname(dir)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      break;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// State in <dir>/.grapim-sync: state.json (url, cursor, machine, manifest),
// base/<sha>, and a journal of manifest updates appended as each one happens
// (state.json is rewritten only at the end of a step, from memory plus journal).

class State {
  constructor(root) {
    this.root = root;
    this.dir = path.join(root, STATE_DIR);
    this.file = path.join(this.dir, 'state.json');
    this.journal = path.join(this.dir, 'journal');
    this.baseDir = path.join(this.dir, 'base');
    this.manifest = new Map();
    this.cursor = 0;
    this.url = null;
    this.machine = null;
    this.dirty = false;
  }

  exists() {
    return fs.existsSync(this.file);
  }

  load() {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      throw fatal(`${this.file} is unreadable (${err.message}). Move ${STATE_DIR} away to start over; your files are not touched.`);
    }
    this.url = s.url;
    this.cursor = Number.isInteger(s.cursor) ? s.cursor : 0;
    this.machine = s.machine;
    this.manifest = new Map(Object.entries(s.manifest ?? {}));
    this.dirty = false;
    let lines = [];
    try {
      lines = fs.readFileSync(this.journal, 'utf8').split('\n');
    } catch {}
    for (const line of lines) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue; // a line cut short by a crash: its step will be redone
      }
      if (typeof e?.p !== 'string') continue;
      if (e.s === null) this.manifest.delete(e.p);
      else this.manifest.set(e.p, e.s);
      this.dirty = true;
    }
  }

  init(url, machine) {
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.rmSync(this.journal, { force: true });
    this.url = url;
    this.machine = machine;
    this.cursor = 0;
    this.manifest = new Map();
    this.dirty = true;
  }

  setCursor(c) {
    if (c !== this.cursor) this.dirty = true;
    this.cursor = c;
  }

  get(rel) {
    return this.manifest.get(rel) ?? null;
  }

  set(rel, sha) {
    if (sha === null) this.manifest.delete(rel);
    else this.manifest.set(rel, sha);
    fs.appendFileSync(this.journal, JSON.stringify({ p: rel, s: sha }) + '\n');
    this.dirty = true;
  }

  // Writes state.json if anything changed, then empties the journal.
  save() {
    if (!this.dirty) return;
    const manifest = Object.fromEntries([...this.manifest].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    fs.mkdirSync(this.dir, { recursive: true });
    atomicWriteFile(this.file, JSON.stringify({ url: this.url, cursor: this.cursor, machine: this.machine, manifest }, null, 1) + '\n');
    fs.rmSync(this.journal, { force: true });
    this.dirty = false;
  }

  putBase(sha, buf) {
    const f = path.join(this.baseDir, sha);
    if (fs.existsSync(f)) {
      try {
        fs.utimesSync(f, new Date(), new Date());
      } catch {}
      return;
    }
    fs.mkdirSync(this.baseDir, { recursive: true });
    atomicWriteFile(f, buf);
  }

  // The bytes of a base version, or null if missing or damaged.
  base(sha) {
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return null;
    try {
      const buf = fs.readFileSync(path.join(this.baseDir, sha));
      return sha1(buf) === sha ? buf : null;
    } catch {
      return null;
    }
  }

  gc(now = Date.now()) {
    const keep = new Set(this.manifest.values());
    let names = [];
    try {
      names = fs.readdirSync(this.baseDir);
    } catch {}
    for (const n of names) {
      if (keep.has(n)) continue;
      const f = path.join(this.baseDir, n);
      try {
        if (now - fs.statSync(f).mtimeMs > BASE_KEEP_MS) fs.rmSync(f, { force: true });
      } catch {}
    }
  }
}

// One sync process per folder at a time.
function lock(stateDir) {
  const f = path.join(stateDir, 'lock');
  fs.mkdirSync(stateDir, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(f, String(process.pid), { flag: 'wx' });
      return () => fs.rmSync(f, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const pid = Number(fs.readFileSync(f, 'utf8'));
    let alive = pid === process.pid;
    if (!alive && Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (err) {
        alive = err.code === 'EPERM';
      }
    }
    if (alive) throw fatal(`Another grapim folder (process ${pid}) is already syncing this folder. Stop it first.`);
    fs.rmSync(f, { force: true }); // left by a process that is gone
  }
  throw fatal('Could not take the sync lock in .grapim-sync.');
}

// ---------------------------------------------------------------------------
// The workspace over HTTP.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// The workspace base URL, ending in /. A token never goes over plain http,
// except to this machine.
export function workspaceUrl(raw, { token = null } = {}) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw fatal(`Not a URL: ${raw}. Give the workspace URL, like https://<hub>/w/<team>/<workspace>/ or http://127.0.0.1:7420/.`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw fatal('The workspace URL must start with https:// (or http:// for a grapim serve on this machine).');
  if (u.username || u.password) throw fatal('Do not put credentials in the URL. Set $GRAPIM_WORKSPACE_TOKEN instead.');
  if (token && u.protocol === 'http:' && !LOOPBACK.has(u.hostname)) throw fatal('Refusing to send the token over plain http to another machine. Use https://.');
  u.search = '';
  u.hash = '';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.href;
}

const encodeRel = (rel) => rel.split('/').map(encodeURIComponent).join('/');

function createClient({ base, token, machine, tokenEnv }) {
  const headers = { 'X-Grapim-Agent': `sync-${machine}` };
  if (token) headers.Authorization = `Bearer ${token}`;
  const host = new URL(base).host;

  async function call(method, rel, { body, ifMatch, timeout = 120000 + Math.ceil((body?.length ?? 0) / 50) } = {}) {
    const h = { ...headers };
    if (ifMatch !== undefined) h['If-Match'] = `"${ifMatch ?? 'absent'}"`;
    if (body !== undefined) h['Content-Type'] = 'application/octet-stream';
    let res;
    try {
      res = await fetch(base + rel, { method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      throw transient(`Cannot reach ${host}: ${clean(err.cause?.code ?? err.cause?.message ?? err.message)}.`);
    }
    if (res.status >= 300 && res.status < 400) {
      throw fatal(`${host} answered ${res.status} (a redirect to ${clean(res.headers.get('location') ?? '?')}). Give the workspace URL itself.`);
    }
    return res;
  }

  async function errorOf(res) {
    try {
      const j = await res.json();
      return { code: j?.error?.code ?? null, message: clean(j?.error?.message ?? ''), current: j?.error?.current_sha };
    } catch {
      return { code: null, message: '', current: undefined };
    }
  }

  // Throws for what stops or pauses the whole sync; returns the error otherwise.
  async function failure(res, { write = false } = {}) {
    const e = await errorOf(res);
    if (res.status === 401) {
      throw fatal(
        token
          ? `${host} refused the token in $${tokenEnv} (401). It may be revoked or mistyped: create a new one in the workspace settings.`
          : `${host} needs a token (401). Set $${tokenEnv} to a workspace token (or name another variable with --token-env).`,
      );
    }
    // A refused file (one that runs code by itself) is that file's problem only.
    if (res.status === 403 && !(write && /^Refused to write/.test(e.message))) {
      throw fatal(`${host} refused access (403): ${e.message || 'forbidden'}${write ? ' A read-only token cannot sync local changes.' : ''}`);
    }
    if (res.status === 429 || res.status === 503 || res.status >= 500) {
      const ra = Number(res.headers.get('retry-after'));
      throw transient(`${host} is busy (${res.status})${e.message ? `: ${e.message}` : ''}`, Number.isFinite(ra) && ra > 0 ? ra * 1000 : null);
    }
    return { status: res.status, ...e };
  }

  return {
    // { sha, buf } | { sha: null } | { skip }
    async get(rel) {
      const res = await call('GET', `fs/${encodeRel(rel)}`);
      if (res.status === 404) {
        await res.body?.cancel();
        return { sha: null, buf: null };
      }
      if (res.status !== 200) return { skip: (await failure(res)).message || `GET answered ${res.status}` };
      const len = Number(res.headers.get('content-length'));
      if (len > MAX_FILE) {
        await res.body?.cancel();
        return { skip: `${rel} is over 32 MB` };
      }
      let buf;
      try {
        buf = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        throw transient(`Reading ${rel} from ${host} failed: ${clean(err.message)}`);
      }
      if (buf.length > MAX_FILE) return { skip: `${rel} is over 32 MB` };
      const sha = sha1(buf);
      const tag = /^"([0-9a-f]{40})"$/.exec(res.headers.get('etag') ?? '')?.[1];
      if (tag && tag !== sha) throw transient(`${rel} arrived damaged (its ETag does not match its bytes).`);
      return { sha, buf };
    },
    // The ETag without the body, or undefined if the server does not say.
    async head(rel) {
      const res = await call('HEAD', `fs/${encodeRel(rel)}`);
      if (res.status === 404) return null;
      if (res.status !== 200) return undefined;
      return /^"([0-9a-f]{40})"$/.exec(res.headers.get('etag') ?? '')?.[1];
    },
    // { ok } | { stale: current_sha } | { held: message } | { skip: message }
    async put(rel, buf, ifMatch) {
      return writeResult(await call('PUT', `fs/${encodeRel(rel)}`, { body: buf, ifMatch }), rel);
    },
    async del(rel, ifMatch) {
      return writeResult(await call('DELETE', `fs/${encodeRel(rel)}`, { ifMatch }), rel);
    },
    async release() {
      const res = await call('POST', 'fs/_release');
      if (res.status !== 200) await failure(res);
      else await res.body?.cancel();
    },
    async changes(after, limit = PAGE) {
      const res = await call('GET', `api/files/changes?after=${after}&limit=${limit}`);
      if (res.status === 404) throw fatal(`${host} has no changes feed (GET api/files/changes is 404). Is this a Grapim workspace URL, and is the server up to date?`);
      if (res.status !== 200) {
        const e = await failure(res);
        throw transient(`The changes feed failed (${res.status}): ${e.message}`);
      }
      const j = await res.json();
      if (!Array.isArray(j?.changes) || !Number.isInteger(j.cursor)) throw transient('The changes feed answered something unexpected.');
      return j;
    },
    // Every file in the workspace (paths). Falls back to walking folders when
    // the flat list is cut at its limit.
    async list(ignored) {
      const res = await call('GET', 'api/files?recursive=1');
      if (res.status !== 200) {
        const e = await failure(res);
        throw transient(`Listing the workspace failed (${res.status}): ${e.message}`);
      }
      const j = await res.json();
      if (!j.truncated) return j.files.map((f) => f.path);
      const out = [];
      const queue = [''];
      while (queue.length) {
        const dir = queue.shift();
        const r = await call('GET', `fs/${encodeRel(dir)}${dir ? '/' : ''}`);
        if (r.status !== 200) {
          const e = await failure(r);
          throw transient(`Listing ${dir || '/'} failed (${r.status}): ${e.message}`);
        }
        for (const e of await r.json()) {
          if (ignored(e.path, e.type === 'dir')) continue;
          if (e.type === 'dir') queue.push(e.path);
          else out.push(e.path);
        }
      }
      return out;
    },
    // Calls onTick for every `event: tick` until the signal aborts or the stream ends.
    async stream(onTick, signal) {
      const res = await fetch(base + 'api/stream', { headers, signal, redirect: 'manual' });
      if (res.status !== 200 || !res.body) {
        await res.body?.cancel();
        return res.status;
      }
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          if (/^event: tick$/m.test(buf.slice(0, i))) onTick();
          buf = buf.slice(i + 2);
        }
        // An event is a few bytes; a stream that never ends one is not ours to hold.
        if (buf.length > 64 * 1024) break; // leaving the loop cancels the body
      }
      return 200;
    },
  };

  async function writeResult(res, rel) {
    if (res.status === 200) {
      await res.body?.cancel();
      return { ok: true };
    }
    const e = await failure(res, { write: true });
    if (e.status === 412) return { stale: e.current ?? null };
    if (e.status === 409) return { held: e.message || `${rel} is held by another agent` };
    return { skip: e.message || `the workspace refused ${rel} (${e.status})` };
  }
}

// ---------------------------------------------------------------------------
// The sync engine.

// A git repo with uncommitted changes (other than our own state folder).
// The folder holds files from a workspace: git must not take a bare repo
// planted in it (HEAD, objects/, refs/, config) as the repo and run its
// config. Command-line config outranks the repo's own.
const SAFE_GIT = ['-c', 'safe.bareRepository=explicit', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

function gitDirty(root) {
  try {
    execFileSync('git', [...SAFE_GIT, 'rev-parse', '--show-toplevel'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch {
    return false;
  }
  try {
    const out = execFileSync('git', [...SAFE_GIT, 'status', '--porcelain', '--', '.', `:(exclude)${STATE_DIR}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// opts: { url, dir, token, tokenEnv, machine, force, say(line), hooks: { step(name, rel) } }
// hooks.step is called between the steps of each action; tests throw from it
// to simulate a crash at that point.
export function createFolderSync({ url, dir, token = null, tokenEnv = 'GRAPIM_WORKSPACE_TOKEN', machine = null, force = false, say = () => {}, hooks = {} }) {
  const base = workspaceUrl(url, { token });
  const root = path.resolve(dir);
  // sync-<machine> must fit the server's 100-character agent name.
  const thisMachine = () => String(machine || machineName()).slice(0, 90);
  const state = new State(root);
  const step = (name, rel) => hooks.step?.(name, rel);
  let client = null;
  let ignored = ignoreMatcher();
  let stats;
  let writes = 0;
  const warned = new Map(); // rel -> the reason last printed, so a warning is said once
  const refused = new Map(); // rel -> local sha the workspace refused (do not resend it)
  const statCache = new Map(); // rel -> { size, mtimeMs, ino, sha }

  const resetStats = () => (stats = { up: 0, down: 0, merged: 0, conflicts: 0, skipped: 0, waiting: 0 });
  resetStats();

  function warn(rel, why) {
    if (warned.get(rel) === why) return;
    warned.set(rel, why);
    say(`⚠ skipped ${rel}: ${clean(why)}`);
  }

  // Another agent holds the file: said once, retried every round.
  function held(rel, why) {
    const holder = /held by (.+?) for /.exec(why)?.[1];
    const key = `held:${holder ?? why}`;
    if (warned.get(rel) === key) return;
    warned.set(rel, key);
    say(`… waiting: ${clean(holder ? `${rel} is held by ${holder}.` : why)} Will retry.`);
  }

  function loadIgnore() {
    let text = '';
    try {
      const st = lstat(path.join(root, '.grapimignore'));
      if (st?.isFile()) text = fs.readFileSync(path.join(root, '.grapimignore'), 'utf8');
    } catch {}
    ignored = ignoreMatcher(text);
  }

  async function flushClaims(force = false) {
    if (writes && (force || writes >= RELEASE_EVERY)) {
      writes = 0;
      await client.release();
    }
  }

  // ---- actions on one path. Each returns 'done', 'skip', 'wait' or 'stale'.

  function adopt(rel, local) {
    if (local.sha !== null) state.putBase(local.sha, local.buf);
    if (state.get(rel) !== local.sha) state.set(rel, local.sha);
    return 'done';
  }

  function takeRemote(rel, local, remote, note = '') {
    // The local bytes being replaced equal the base, or are a delete; keep
    // them in base/ so they stay recoverable.
    if (local.sha !== null) state.putBase(local.sha, local.buf);
    if (remote.sha !== null) state.putBase(remote.sha, remote.buf);
    step('pull', rel);
    const ok = remote.sha === null ? removeLocal(root, rel, local.sha) : writeLocal(root, rel, remote.buf, local.sha);
    if (!ok) return 'wait'; // changed here meanwhile: look again next round
    step('pulled', rel);
    state.set(rel, remote.sha);
    stats.down++;
    say(remote.sha === null ? `↓ deleted ${rel}` : `↓ ${rel}${note}`);
    return 'done';
  }

  async function push(rel, local, ifMatch, note = '') {
    if (local.sha !== null && refused.get(rel) === local.sha) return 'skip';
    step('push', rel);
    const r = local.sha === null ? await client.del(rel, ifMatch) : await client.put(rel, local.buf, ifMatch);
    if (r.stale !== undefined) return 'stale';
    if (r.held) {
      held(rel, r.held);
      return 'wait';
    }
    if (r.skip) {
      if (local.sha !== null) refused.set(rel, local.sha);
      warn(rel, r.skip);
      return 'skip';
    }
    writes++;
    step('pushed', rel);
    if (local.sha !== null) state.putBase(local.sha, local.buf);
    state.set(rel, local.sha);
    stats.up++;
    say(local.sha === null ? `↑ deleted ${rel}` : `↑ ${rel}${note}`);
    return 'done';
  }

  async function merge(rel, baseSha, local, remote) {
    const baseBuf = baseSha ? state.base(baseSha) : null;
    if (baseBuf && !isBinary(local.buf) && !isBinary(remote.buf) && !isBinary(baseBuf)) {
      let m;
      try {
        m = mergeFile(local.buf, baseBuf, remote.buf);
      } catch {
        m = { clean: false };
      }
      if (m.clean) {
        const merged = { sha: sha1(m.buf), buf: m.buf };
        if (merged.sha !== remote.sha) {
          step('merge-push', rel);
          const r = await client.put(rel, merged.buf, remote.sha);
          if (r.stale !== undefined) return 'stale';
          if (r.held) {
            held(rel, r.held);
            return 'wait';
          }
          if (r.skip) return conflictCopy(rel, local, remote); // this path refuses our write; the copy's name may not
          writes++;
          step('merge-pushed', rel);
        }
        state.putBase(merged.sha, merged.buf);
        state.putBase(local.sha, local.buf);
        if (merged.sha !== local.sha && !writeLocal(root, rel, merged.buf, local.sha)) {
          // Edited here again meanwhile. The workspace has the merge, which
          // holds all of `local`; so `local` is the common base for next time.
          state.set(rel, local.sha);
          return 'wait';
        }
        step('merged', rel);
        state.set(rel, merged.sha);
        stats.merged++;
        say(`⇅ merged ${rel}`);
        return 'done';
      }
    }
    return conflictCopy(rel, local, remote);
  }

  // Keep both: the workspace's version stays at rel, ours goes next to it.
  async function conflictCopy(rel, local, remote) {
    const date = today();
    let copy = null;
    for (let n = 1; n < 1000 && !copy; n++) {
      const c = conflictName(rel, state.machine, date, n);
      if (!safeRel(c) || ignored(c) || sensitiveReason(c)) continue;
      const there = localSha(root, c);
      if (there === local.sha) copy = c; // made by an earlier, interrupted try
      else if (there === null && !state.manifest.has(c)) copy = c;
    }
    if (!copy) {
      warn(rel, 'changed on both sides and no free name for a conflict copy');
      return 'skip';
    }
    step('conflict-copy', rel);
    if (localSha(root, copy) !== local.sha && !writeLocal(root, copy, local.buf, null)) return 'wait';
    step('conflict-copied', rel);
    const r = await client.put(copy, local.buf, null);
    if (r.ok) {
      writes++;
      state.putBase(local.sha, local.buf);
      state.set(copy, local.sha);
      stats.up++;
    } // otherwise the push phase sends it as a new file later
    step('conflict-copy-pushed', rel);
    state.putBase(remote.sha, remote.buf);
    state.putBase(local.sha, local.buf);
    if (!writeLocal(root, rel, remote.buf, local.sha)) return 'wait'; // edited again: the copy keeps these bytes
    step('conflict-resolved', rel);
    state.set(rel, remote.sha);
    stats.conflicts++;
    say(`⚠ conflict: ${rel}, kept both: ${path.posix.basename(copy)}`);
    return 'done';
  }

  // Brings one path to agreement. remote: a known { sha, buf }, or
  // 'assume-base' (a local change: try the write, learn the truth from a 412).
  async function reconcile(rel, { hint, assumeBase = false } = {}) {
    if (!safeRel(rel)) {
      warn(rel, 'its name cannot be used on this machine');
      return 'skip';
    }
    if (ignored(rel)) return 'skip';
    // Files that run code by themselves (.claude/settings.json, .envrc, a
    // bare repo's HEAD...): the workspace refuses them from agents, and this
    // folder never takes them from a workspace either, whatever it sends.
    const danger = sensitiveReason(rel);
    if (danger) {
      warn(rel, `${danger}, so sync never writes it here or there`);
      return 'skip';
    }
    const baseSha = state.get(rel);
    for (let attempt = 0; attempt < 6; attempt++) {
      let local;
      try {
        local = readLocal(root, rel);
      } catch (err) {
        if (!(err instanceof Skip)) throw err;
        warn(rel, err.message);
        return 'skip';
      }
      let remote;
      if (attempt === 0 && assumeBase) {
        if (local.sha === baseSha) return 'done';
        remote = { sha: baseSha, buf: null };
      } else {
        if (attempt === 0 && hint !== undefined && hint !== 'untracked') {
          if (hint === baseSha) return 'done'; // the workspace is where we left it
          if (hint === local.sha) return adopt(rel, local);
        }
        if (attempt === 0 && (hint === 'untracked' || hint === undefined) && local.sha !== null) {
          const tag = await client.head(rel); // ask before downloading what may already be here
          if (tag === local.sha) return adopt(rel, local);
          if (tag === baseSha && tag) return 'done';
        }
        remote = await client.get(rel);
        if (remote.skip) {
          warn(rel, remote.skip);
          return 'skip';
        }
      }
      let r;
      try {
        if (local.sha === remote.sha) r = adopt(rel, local);
        else if (local.sha === baseSha) r = takeRemote(rel, local, remote);
        else if (remote.sha === baseSha) r = await push(rel, local, baseSha);
        else if (local.sha === null) r = takeRemote(rel, local, remote, ' (changed there, so it is back here)');
        else if (remote.sha === null) r = await push(rel, local, null, ' (deleted there, kept your edit)');
        else r = await merge(rel, baseSha, local, remote);
      } catch (err) {
        if (err instanceof Busy) r = 'wait';
        else if (err instanceof Skip) {
          warn(rel, err.message);
          r = 'skip';
        } else throw err;
      }
      if (r !== 'stale') {
        if (r === 'wait') stats.waiting++;
        if (r === 'skip') stats.skipped++;
        if (r === 'done') warned.delete(rel);
        await flushClaims();
        return r;
      }
    }
    stats.waiting++;
    return 'wait'; // the workspace kept changing under us; next round
  }

  // ---- the local folder, scanned. mtime and size first, then the sha.

  function scan() {
    const files = new Map();
    const now = Date.now();
    const queue = [''];
    while (queue.length) {
      const rel = queue.shift();
      let entries;
      try {
        entries = fs.readdirSync(rel ? path.join(root, ...rel.split('/')) : root, { withFileTypes: true });
      } catch (err) {
        if (!rel) throw fatal(`Cannot read ${root}: ${err.code}. Is the folder still there?`);
        continue;
      }
      for (const d of entries) {
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isSymbolicLink()) {
          if (!ignored(r)) warn(r, 'it is a link, which sync does not follow');
          continue;
        }
        if (d.isDirectory()) {
          if (!ignored(r, true)) queue.push(r);
          continue;
        }
        if (!d.isFile() || ignored(r)) continue;
        if (!safeRel(r)) {
          warn(r, 'its name is not allowed in a workspace');
          continue;
        }
        const st = lstat(path.join(root, ...r.split('/')));
        if (!st?.isFile()) continue;
        if (st.size > MAX_FILE) {
          warn(r, 'it is over 32 MB');
          continue;
        }
        const c = statCache.get(r);
        if (c && c.size === st.size && c.mtimeMs === st.mtimeMs && c.ino === st.ino && now - st.mtimeMs > RACY_MS) {
          files.set(r, c.sha);
          continue;
        }
        let sha;
        try {
          sha = sha1(fs.readFileSync(path.join(root, ...r.split('/'))));
        } catch {
          continue;
        }
        statCache.set(r, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, sha });
        files.set(r, sha);
      }
    }
    return files;
  }

  // ---- the phases

  async function pullPhase() {
    for (;;) {
      const page = await client.changes(state.cursor);
      const latest = new Map();
      const first = new Map();
      for (const c of page.changes) {
        if (typeof c?.path !== 'string' || !Number.isInteger(c.id)) continue;
        if (!first.has(c.path)) first.set(c.path, c.id);
        latest.set(c.path, c.sha);
      }
      let blockedAt = Infinity;
      for (const [rel, sha] of latest) {
        const r = await reconcile(rel, { hint: sha });
        if (r === 'wait') blockedAt = Math.min(blockedAt, first.get(rel));
      }
      step('page', null);
      // A path that has to wait keeps the cursor before its first change, so
      // it is looked at again; the others are idempotent when replayed.
      if (blockedAt !== Infinity) {
        state.setCursor(Math.max(state.cursor, blockedAt - 1));
        state.save();
        return;
      }
      state.setCursor(Math.max(state.cursor, page.cursor));
      state.save();
      if (page.changes.length < PAGE) return;
    }
  }

  async function pushPhase() {
    const files = scan();
    for (const [rel, sha] of files) {
      if (sha !== state.get(rel)) await reconcile(rel, { assumeBase: true });
    }
    const gone = [...state.manifest.keys()].filter((rel) => !files.has(rel));
    if (!force && gone.length >= 10 && gone.length === state.manifest.size) {
      throw fatal(`Every synced file (${gone.length}) is gone from ${root}. Not deleting them in the workspace. If you meant it, run once with --force.`);
    }
    for (const rel of gone) {
      if (ignored(rel)) {
        state.set(rel, null); // now ignored here: stop syncing it, delete nothing
        continue;
      }
      await reconcile(rel, { assumeBase: true });
    }
  }

  // The first sync of this folder: everything in the workspace, then everything here.
  async function link() {
    let st = lstat(root);
    if (st && !st.isDirectory()) throw fatal(`${root} is not a folder.`);
    if (!st) fs.mkdirSync(root, { recursive: true });
    else if (!force && gitDirty(root)) {
      throw fatal(`${root} is a git repo with uncommitted changes. Commit or stash them first, or run with --force to sync it anyway.`);
    }
    state.init(base, thisMachine());
    loadIgnore();
    // Where the feed stands before we look, so nothing that changes during the clone is missed.
    let head = 0;
    for (;;) {
      const page = await client.changes(head, 1000);
      head = Math.max(head, page.cursor);
      if (page.changes.length < 1000) break;
    }
    const remote = await client.list(ignored);
    const seen = new Set();
    for (const rel of remote) {
      if (typeof rel !== 'string' || ignored(rel)) continue;
      seen.add(rel);
      await reconcile(rel);
    }
    for (const rel of scan().keys()) if (!seen.has(rel)) await reconcile(rel, { assumeBase: true });
    state.setCursor(head);
    state.save();
  }

  async function round() {
    try {
      if (!state.exists()) {
        await link();
      } else {
        state.load();
        if (state.url !== base) throw fatal(`${root} is already synced with ${state.url}. Use another folder, or move ${STATE_DIR} away to relink it.`);
      }
      loadIgnore();
      await pullPhase();
      await pushPhase();
      await flushClaims(true);
      state.save();
    } finally {
      // Never leave our claims on the workspace's files, even on an error.
      if (writes) await client.release().catch(() => {});
      writes = 0;
    }
  }

  const machineOf = () => {
    if (state.exists()) {
      try {
        return JSON.parse(fs.readFileSync(state.file, 'utf8')).machine;
      } catch {}
    }
    return thisMachine();
  };

  let stopping = null;
  let wake = null;

  return {
    root,
    url: base,
    get stats() {
      return stats;
    },

    // One full sync: pull, then push. Resolves to the counts.
    async syncOnce() {
      resetStats();
      const unlock = lock(state.dir);
      client = createClient({ base, token, machine: machineOf(), tokenEnv });
      try {
        await round();
        state.gc();
        return { ...stats };
      } finally {
        unlock();
      }
    },

    // Syncs every 2 s (sooner on a live tick) until stop(). Rejects on a fatal error.
    async watch({ onError = () => {} } = {}) {
      const unlock = lock(state.dir);
      client = createClient({ base, token, machine: machineOf(), tokenEnv });
      stopping = null;
      const ctl = new AbortController();
      let tickled = false;
      const nap = (ms) =>
        new Promise((resolve) => {
          if (tickled || stopping) {
            tickled = false;
            return resolve();
          }
          const t = setTimeout(done, ms);
          function done() {
            clearTimeout(t);
            wake = null;
            tickled = false;
            resolve();
          }
          wake = done;
        });
      const tick = () => {
        tickled = true;
        wake?.();
      };
      // The live stream only makes us pull sooner; polling works without it.
      (async () => {
        while (!ctl.signal.aborted) {
          let status = 0;
          try {
            status = await client.stream(tick, ctl.signal);
          } catch {}
          if (ctl.signal.aborted) return;
          await new Promise((r) => setTimeout(r, status === 200 || status === 0 ? 2000 : 30000));
        }
      })();
      let failures = 0;
      try {
        while (!stopping) {
          resetStats();
          let delay = POLL_MS;
          try {
            await round();
            failures = 0;
          } catch (err) {
            if (err instanceof FolderSyncError && err.fatal) throw err;
            failures++;
            delay = err.retryAfter ?? Math.min(60000, 1000 * 2 ** Math.min(failures, 6));
            onError(err, failures, delay);
          }
          if (!stopping) await nap(delay);
        }
      } finally {
        ctl.abort();
        unlock();
        stopping?.resolve();
      }
    },

    stop() {
      if (!stopping) {
        let resolve;
        const p = new Promise((r) => (resolve = r));
        stopping = { resolve, promise: p };
        wake?.();
      }
      return stopping.promise;
    },
  };
}

// ---------------------------------------------------------------------------
// The CLI: grapim folder <workspace-url> <dir> [--watch] [--once] [--force] [--token-env NAME]

const USAGE = 'Usage: grapim folder <workspace-url> <dir> [--watch] [--once] [--force] [--token-env GRAPIM_WORKSPACE_TOKEN]';

export async function folderMain(args, { env = process.env, log = console.log, error = console.error } = {}) {
  const opts = { watch: false, once: false, force: false, tokenEnv: 'GRAPIM_WORKSPACE_TOKEN' };
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--watch') opts.watch = true;
    else if (a === '--once') opts.once = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--token-env') {
      const v = args[++i];
      if (!v || v.startsWith('--')) {
        error(`--token-env needs the name of an environment variable.\n${USAGE}`);
        return 1;
      }
      opts.tokenEnv = v;
    } else if (a === '--token' || a.startsWith('--token=')) {
      error('grapim folder does not take a token on the command line (it would be in your shell history and the process list). Put it in $GRAPIM_WORKSPACE_TOKEN, or name another variable with --token-env NAME.');
      return 1;
    } else if (a === '--help' || a === '-h') {
      log(USAGE);
      return 0;
    } else if (a.startsWith('--')) {
      error(`Unknown option for folder: ${a}\n${USAGE}`);
      return 1;
    } else pos.push(a);
  }
  if (pos.length !== 2) {
    error(USAGE);
    return 1;
  }
  if (opts.watch && opts.once) {
    error('Give --watch or --once, not both.');
    return 1;
  }
  const token = env[opts.tokenEnv] || null;
  if (opts.tokenEnv !== 'GRAPIM_WORKSPACE_TOKEN' && !token) {
    error(`$${opts.tokenEnv} is empty.`);
    return 1;
  }
  let sync;
  try {
    sync = createFolderSync({ url: pos[0], dir: pos[1], token, tokenEnv: opts.tokenEnv, force: opts.force, say: log });
  } catch (err) {
    error(`grapim folder: ${err.message}`);
    return 1;
  }

  if (!opts.watch) {
    try {
      const s = await sync.syncOnce();
      log(summary(s));
      return s.skipped || s.waiting ? 2 : 0;
    } catch (err) {
      error(`grapim folder: ${err.message}`);
      return 1;
    }
  }

  log(`Syncing ${sync.root} with ${sync.url} (every 2 s). Ctrl+C to stop.`);
  const stop = () => sync.stop().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let last = null;
  try {
    await sync.watch({
      onError: (err, n, delay) => {
        if (err.message !== last || n === 1) error(`${err.message} Retrying in ${Math.round(delay / 1000)} s.`);
        last = err.message;
      },
    });
    return 0;
  } catch (err) {
    error(`grapim folder: ${err.message}`);
    return 1;
  }
}

export function summary(s) {
  const parts = [];
  if (s.up) parts.push(`${s.up} up`);
  if (s.down) parts.push(`${s.down} down`);
  if (s.merged) parts.push(`${s.merged} merged`);
  if (s.conflicts) parts.push(`${s.conflicts} conflict${s.conflicts === 1 ? '' : 's'} (both kept)`);
  if (s.skipped) parts.push(`${s.skipped} skipped`);
  if (s.waiting) parts.push(`${s.waiting} waiting (run again)`);
  return parts.length ? `Synced: ${parts.join(', ')}.` : 'Up to date.';
}
