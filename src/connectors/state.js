// A connector's mapping state in one workspace: for every remote item, its
// id, the file it is mapped to, the remote version and the file's sha at the
// last sync, and the content both sides last agreed on (the merge base).
//
// It lives with the workspace's own Grapim state, in
// <state dir>/connectors/<name>/state.json, with the bases beside it in
// base/<sha1>. Every write is a temp file renamed into place.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const keyOf = (p) => (FOLD ? p.toLowerCase() : p);

function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function openState(stateDir, name) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) throw new Error(`bad connector name ${name}`);
  const dir = path.join(stateDir, 'connectors', name);
  const file = path.join(dir, 'state.json');
  let data = { version: 1, cursor: null, items: {} };
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (v && v.version === 1 && v.items && typeof v.items === 'object') data = v;
  } catch {}
  const items = () => Object.values(data.items);
  return {
    get cursor() {
      return data.cursor;
    },
    set cursor(c) {
      data.cursor = c;
    },
    items,
    byId: (id) => data.items[id] ?? null,
    byPath: (p) => items().find((e) => keyOf(e.path) === keyOf(p)) ?? null,
    set(entry) {
      data.items[entry.id] = entry;
      return entry;
    },
    drop(id) {
      delete data.items[id];
    },
    save() {
      atomic(file, JSON.stringify(data));
    },
    // The merge base by its sha (null if not kept), and keeping one.
    base(sha) {
      if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return null;
      try {
        return fs.readFileSync(path.join(dir, 'base', sha), 'utf8');
      } catch {
        return null;
      }
    },
    putBase(text) {
      const sha = sha1(Buffer.from(text, 'utf8'));
      const f = path.join(dir, 'base', sha);
      if (!fs.existsSync(f)) atomic(f, text);
      return sha;
    },
    // Bases no item points at any more.
    prune() {
      const keep = new Set(items().map((e) => e.base));
      let names = [];
      try {
        names = fs.readdirSync(path.join(dir, 'base'));
      } catch {}
      for (const n of names) if (/^[0-9a-f]{40}$/.test(n) && !keep.has(n)) fs.rmSync(path.join(dir, 'base', n), { force: true });
    },
  };
}
