// Cloud workspace files in the storage backend (docs/workspaces.md section 4,
// "Hub use"). The folder on the volume is the working copy; storage keeps a
// copy that survives losing the volume.
//
// - After each workspace write, the blobs it recorded are queued for upload
//   (write-behind: never awaited by the request, retried by the persister).
// - A manifest ({ path: sha }, head) is written at most every 30 s per
//   workspace, and only after the blobs it names are uploaded.
// - On boot, a live workspace whose folder is missing is rebuilt from its
//   manifest (and made a git repo again: the ledger history is not stored).
//
// src/storage/ is built separately and loaded with a dynamic import: without
// it the hub runs with workspaces on the volume only, and says so in the log.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MANIFEST_MS = 30_000;
const MAX_QUEUED_BYTES = 256 * 1024 * 1024; // file contents waiting for upload, hub wide
const SKIP_ANYWHERE = new Set(['.git']);
const SKIP_AT_ROOT = new Set(['.grapim', '.grapim-sync']);
const TEMP = /\.grapim-\d+-[0-9a-f]+\.tmp$/;
const SHA1_RE = /^[0-9a-f]{40}$/;

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

export const defaultStorageUrl = (dataDir) => pathToFileURL(path.join(dataDir, 'storage')).href;

// Loads src/storage. Returns { storage, mod } or null (logged) when the module
// or the backend is not available. `storage` may be given (tests: a fake).
export async function loadStorage({ url, env, log, storage = undefined, mod = undefined }) {
  if (storage === null) return null;
  let index;
  try {
    mod ??= await import('../storage/workspace.js');
    if (!storage) {
      index = await import('../storage/index.js');
      storage = index.createStorage(url, env);
    }
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') log('workspace storage: src/storage is not installed; workspace files live on the volume only');
    else log(`workspace storage is off: ${err?.message ?? err}`);
    return null;
  }
  for (const fn of ['createPersister', 'writeManifest', 'readManifest', 'restoreWorkspace', 'resolveGitHead']) {
    if (typeof mod[fn] !== 'function') {
      log(`workspace storage is off: src/storage/workspace.js has no ${fn}()`);
      return null;
    }
  }
  return { storage, mod };
}

// Every file of a workspace folder as { path: sha1 }, by the same rules as
// the storage module's snapshot: no .git anywhere, no Grapim state at the
// root, no symlinks, no temp files of an atomic write in progress.
async function scan(root) {
  const files = {};
  async function walk(abs, rel) {
    let entries;
    try {
      entries = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_ANYWHERE.has(e.name) || (!rel && SKIP_AT_ROOT.has(e.name)) || TEMP.test(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(abs, e.name), r);
      else if (e.isFile()) {
        try {
          files[r] = sha1(await fs.promises.readFile(path.join(abs, e.name)));
        } catch {}
      }
    }
  }
  await walk(root, '');
  return files;
}

// The write-behind side. One per hub.
export function createWorkspaceStorage({ storage, mod, log, now = () => Date.now(), manifestMs = MANIFEST_MS, maxQueuedBytes = MAX_QUEUED_BYTES }) {
  // Every blob uploaded is reported (wsKey, bytes), so the team quota counts
  // storage too: each version of a file is kept there, and by default on the
  // same volume as the workspaces.
  let stored = null;
  const counted = {
    get: (key) => storage.get(key),
    has: (key) => storage.has(key),
    delete: (key) => storage.delete(key),
    list: (prefix) => storage.list(prefix),
    async put(key, buf) {
      await storage.put(key, buf);
      const wsKey = /^ws\/(.+)\/blobs\/[0-9a-f]{40}$/.exec(key)?.[1];
      if (wsKey && stored) {
        try {
          stored(wsKey, buf.length);
        } catch (err) {
          log(`workspace storage: could not count ${wsKey}: ${err?.message ?? err}`);
        }
      }
    },
  };
  // The upload queue holds file contents in memory: past this, writes are
  // not queued one by one; the next manifest rescans the folder instead.
  const overQueue = () => persister.stats().queuedBytes > maxQueuedBytes;
  const persister = mod.createPersister(counted, {
    concurrency: 4,
    onError: (err, job) => log(`workspace storage: blob upload failed for ${job.wsKey}: ${err?.message ?? err}`),
  });
  const states = new Map(); // wsKey -> state
  let closed = false;

  // Called when the workspace's engine opens: changes from here on are
  // uploaded as they happen; the first manifest after it is a full scan.
  function open(wsKey, dir, store) {
    const cursor = store.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM changes').get().id;
    const prev = states.get(wsKey);
    if (prev?.timer) clearTimeout(prev.timer);
    // files: { path: sha } once known; early: changes seen while it is not
    // known yet (the first scan is running), applied on top of the scan.
    states.set(wsKey, { wsKey, dir, store, cursor, files: null, early: new Map(), dirty: true, lastManifest: 0, timer: null, writing: null });
  }

  // The engine is closing: write what is pending, then forget its store.
  async function release(wsKey) {
    const s = states.get(wsKey);
    if (!s) return;
    try {
      drain(s);
    } catch {}
    s.store = null;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    // Reopened meanwhile (a rename): the new state carries on.
    if (states.get(wsKey) === s) states.delete(wsKey);
    if (s.dirty) await manifest(s).catch(() => {});
  }

  // Reads the ledger changes recorded since the cursor and queues their blobs.
  function drain(s) {
    if (!s.store) return;
    const rows = s.store.db.prepare('SELECT id, path, after_sha FROM changes WHERE id > ? ORDER BY id').all(s.cursor);
    for (const r of rows) {
      s.cursor = r.id;
      s.dirty = true;
      const into = s.files ?? s.early;
      if (!r.after_sha) {
        if (s.files) s.files.delete(r.path);
        else s.early.set(r.path, null);
        continue;
      }
      // The ledger does not hash files over 2 MB ("untracked"): those are
      // taken as they are on disk now, never written into the manifest as is.
      const known = SHA1_RE.test(r.after_sha);
      if (known) into.set(r.path, r.after_sha);
      if (overQueue()) {
        // Too much waiting for upload: forget the file list, so the next
        // manifest rescans the folder (with backpressure) and uploads what is there.
        s.files = null;
        s.early.clear();
        continue;
      }
      let buf;
      try {
        buf = fs.readFileSync(path.join(s.dir, ...r.path.split('/')));
      } catch {
        continue; // gone again since: a later change says so
      }
      const sha = sha1(buf);
      if (!known) into.set(r.path, sha);
      // Only the bytes the change recorded; a newer version has its own row.
      if (!known || sha === r.after_sha) persister.enqueue(s.wsKey, sha, buf);
    }
  }

  async function manifest(s) {
    if (s.writing) return s.writing;
    s.writing = (async () => {
      s.dirty = false;
      s.lastManifest = now();
      // Moved to the trash: keep the last good manifest rather than an empty one.
      if (!fs.existsSync(path.join(s.dir, '.git'))) return;
      if (!s.files) {
        const files = await scan(s.dir);
        for (const [rel, sha] of Object.entries(files)) {
          // A whole workspace is never held in memory at once.
          if (overQueue()) await persister.flush();
          try {
            persister.enqueue(s.wsKey, sha, fs.readFileSync(path.join(s.dir, ...rel.split('/'))));
          } catch {}
        }
        s.files = new Map(Object.entries(files));
        for (const [rel, sha] of s.early) {
          if (sha) s.files.set(rel, sha);
          else s.files.delete(rel);
        }
        s.early.clear();
      }
      // A manifest never names a blob that is not uploaded yet.
      await persister.flush();
      await mod.writeManifest(storage, s.wsKey, { files: Object.fromEntries([...s.files].sort(([a], [b]) => (a < b ? -1 : 1))), head: mod.resolveGitHead(s.dir) });
    })()
      .catch((err) => {
        s.dirty = true;
        log(`workspace storage: manifest failed for ${s.wsKey}: ${err?.message ?? err}`);
      })
      .finally(() => {
        s.writing = null;
      });
    return s.writing;
  }

  function schedule(s) {
    if (s.timer || closed) return;
    const wait = Math.max(0, s.lastManifest + manifestMs - now());
    s.timer = setTimeout(() => {
      s.timer = null;
      if (s.dirty) manifest(s);
    }, wait);
    s.timer.unref?.();
  }

  return {
    open,
    release,
    // fn(wsKey, bytes) is called after each blob upload (the hub counts it in the team's usage).
    onStored(fn) {
      stored = fn;
    },
    // After a workspace request that may have written: never throws, never waits.
    touch(wsKey) {
      const s = states.get(wsKey);
      if (!s || closed) return;
      try {
        drain(s);
      } catch (err) {
        log(`workspace storage: could not read changes of ${wsKey}: ${err?.message ?? err}`);
        return;
      }
      if (s.dirty) schedule(s);
    },
    // Rebuilds a missing folder from its manifest. Resolves to the restore
    // result, or null when storage has no manifest for it.
    async restore(wsKey, dir) {
      const m = await mod.readManifest(storage, wsKey);
      if (!m) return null;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return mod.restoreWorkspace(storage, wsKey, dir);
    },
    // Waits for queued uploads and due manifests (tests, shutdown).
    async flush() {
      for (const s of states.values()) {
        try {
          drain(s);
        } catch {}
        if (s.timer) {
          clearTimeout(s.timer);
          s.timer = null;
        }
        // A write that landed while a manifest was being written makes it dirty again.
        for (let i = 0; i < 3 && (s.writing || s.dirty); i++) await (s.writing ?? manifest(s));
      }
      await persister.flush();
    },
    async close() {
      await this.flush().catch(() => {});
      closed = true;
      for (const s of states.values()) if (s.timer) clearTimeout(s.timer);
      states.clear();
    },
    stats: () => persister.stats(),
  };
}
