// Workspace persistence on top of a storage backend (docs/workspaces.md section 4).
//
//   ws/<wsKey>/blobs/<sha1>      file content, content-addressed (sha1 of the raw
//                                bytes, the same sha the ledger records)
//   ws/<wsKey>/manifest.json     { version: 1, head, files: { "<posix path>": "<sha1>" }, written_at }
//
// wsKey is chosen by the hub, e.g. "<team_id>/<workspace_id>"; it must be key-safe.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { validateKey } from './keys.js';
import { writeFileAtomic } from './local.js';
import { backoffDelay, isRetryable, sleep } from './retry.js';

// Same convention as src/ledger.js: sha1 of the raw bytes, lowercase hex.
export const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

const SHA1 = /^[0-9a-f]{40}$/;
const MANIFEST_VERSION = 1;
// Never stored or restored: git internals anywhere, Grapim state at the root.
const SKIP_ANYWHERE = new Set(['.git']);
const SKIP_AT_ROOT = new Set(['.grapim', '.grapim-sync']);
// Names Windows can't hold (":" would even open an alternate data stream).
const WIN_BAD = /[<>:"|?*\x00-\x1f]/;

export class WorkspaceStorageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WorkspaceStorageError';
    this.code = code;
    this.retryable = false;
  }
}

function checkWsKey(wsKey) {
  if (typeof wsKey !== 'string' || !wsKey) throw new WorkspaceStorageError('wsKey must be a non-empty string', 'invalid_ws_key');
  validateKey(`ws/${wsKey}/x`);
  return wsKey;
}

function checkSha(sha) {
  if (typeof sha !== 'string' || !SHA1.test(sha)) throw new WorkspaceStorageError('blob sha must be 40 lowercase hex characters', 'invalid_sha');
  return sha;
}

export const blobKey = (wsKey, sha) => `ws/${checkWsKey(wsKey)}/blobs/${checkSha(sha)}`;
export const manifestKey = (wsKey) => `ws/${checkWsKey(wsKey)}/manifest.json`;

// A manifest path must be a plain relative posix path that stays inside the workspace.
export function checkManifestPath(p) {
  const bad = (why) => new WorkspaceStorageError(`manifest path ${JSON.stringify(String(p).slice(0, 200))} refused: ${why}`, 'unsafe_path');
  if (typeof p !== 'string' || !p) throw bad('empty');
  if (p.length > 4096) throw bad('too long');
  if (p.includes('\\')) throw bad('backslash');
  if (p.includes('\0')) throw bad('NUL byte');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw bad('absolute');
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') throw bad('empty, . or .. segment');
    if (SKIP_ANYWHERE.has(s.toLowerCase())) throw bad('inside .git');
    if (process.platform === 'win32' && (WIN_BAD.test(s) || /[. ]$/.test(s))) throw bad('not a valid Windows file name');
  }
  if (SKIP_AT_ROOT.has(segs[0].toLowerCase())) throw bad('inside Grapim state');
  return p;
}

// Inside `root`, after resolving. Both must be absolute.
const inside = (root, abs) => abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

// ------------------------------------------------------------- blobs ----

// Stores the blob unless it is already there. Returns true if it uploaded.
export async function persistBlob(storage, wsKey, sha, buf) {
  const key = blobKey(wsKey, sha);
  const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (sha1(body) !== sha) throw new WorkspaceStorageError(`blob content does not hash to ${sha}`, 'blob_mismatch');
  if (await storage.has(key)) return false;
  await storage.put(key, body);
  return true;
}

// ---------------------------------------------------------- manifest ----

function checkFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new WorkspaceStorageError('manifest files must be an object of { path: sha }', 'bad_manifest');
  const out = {};
  for (const p of Object.keys(files).sort()) {
    checkManifestPath(p);
    out[p] = checkSha(files[p]);
  }
  return out;
}

export async function writeManifest(storage, wsKey, { files, head = null } = {}) {
  const manifest = { version: MANIFEST_VERSION, head: head ?? null, files: checkFiles(files), written_at: new Date().toISOString() };
  await storage.put(manifestKey(wsKey), Buffer.from(`${JSON.stringify(manifest, null, 1)}\n`));
  return manifest;
}

// The manifest, or null when this workspace has none.
export async function readManifest(storage, wsKey) {
  const buf = await storage.get(manifestKey(wsKey));
  if (!buf) return null;
  let m;
  try {
    m = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new WorkspaceStorageError(`manifest for ${wsKey} is not valid JSON`, 'bad_manifest');
  }
  if (!m || m.version !== MANIFEST_VERSION) throw new WorkspaceStorageError(`manifest for ${wsKey} has unknown version`, 'bad_manifest');
  return { version: m.version, head: m.head ?? null, files: checkFiles(m.files), written_at: m.written_at ?? null };
}

// ---------------------------------------------------------- snapshot ----

async function walkFiles(root) {
  const out = [];
  async function walk(abs, rel) {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      if (SKIP_ANYWHERE.has(e.name)) continue;
      if (!rel && SKIP_AT_ROOT.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      // Symlinks are skipped: never followed, never stored.
      if (e.isDirectory()) await walk(path.join(abs, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  }
  await walk(root, '');
  return out.sort();
}

// The commit HEAD points at, read from the files (no git process). null if unknown.
export function resolveGitHead(dir) {
  try {
    let gitDir = path.join(dir, '.git');
    if (fsSync.statSync(gitDir).isFile()) {
      const m = fsSync.readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (!m) return null;
      gitDir = path.resolve(dir, m[1].trim());
    }
    let common = gitDir;
    try {
      common = path.resolve(gitDir, fsSync.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
    } catch {}
    const head = fsSync.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (SHA1.test(head)) return head;
    const ref = head.match(/^ref:\s*(refs\/\S+)$/)?.[1];
    if (!ref || ref.includes('..')) return null;
    for (const base of [gitDir, common]) {
      try {
        const sha = fsSync.readFileSync(path.join(base, ...ref.split('/')), 'utf8').trim();
        if (SHA1.test(sha)) return sha;
      } catch {}
    }
    const packed = fsSync.readFileSync(path.join(common, 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (name === ref && SHA1.test(sha)) return sha;
    }
  } catch {}
  return null;
}

async function pool(items, concurrency, fn) {
  let next = 0;
  let failed = null;
  const worker = async () => {
    while (next < items.length && !failed) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        failed ||= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  if (failed) throw failed;
}

// Uploads every current file (blobs missing from storage only), then the manifest.
export async function snapshotWorkspace(dir, storage, wsKey, { head, concurrency = 8 } = {}) {
  checkWsKey(wsKey);
  const root = path.resolve(dir);
  const paths = await walkFiles(root);
  const files = {};
  const stats = { files: paths.length, uploaded: 0, present: 0, bytes: 0 };
  const inflight = new Map(); // sha -> promise, so two copies of one blob upload once
  await pool(paths, concurrency, async (rel) => {
    const buf = await fs.readFile(path.join(root, ...rel.split('/')));
    const sha = sha1(buf);
    files[rel] = sha;
    stats.bytes += buf.length;
    let p = inflight.get(sha);
    const first = !p;
    if (first) inflight.set(sha, (p = persistBlob(storage, wsKey, sha, buf)));
    if ((await p) && first) stats.uploaded++;
    else stats.present++;
  });
  const manifest = await writeManifest(storage, wsKey, { files, head: head === undefined ? resolveGitHead(root) : head });
  return { ...stats, head: manifest.head };
}

// ----------------------------------------------------------- restore ----

// Rebuilds `dir` from the manifest. Every path is checked before anything is
// fetched, and every blob is fetched and its sha1 verified (into a staging
// folder next to `dir`) before any file is written, so a bad manifest or a
// tampered blob leaves `dir` untouched. Files are written atomically. Files in
// `dir` that the manifest does not list are left alone.
// Returns null when the workspace has no manifest.
export async function restoreWorkspace(storage, wsKey, dir, { concurrency = 4 } = {}) {
  const manifest = await readManifest(storage, wsKey);
  if (!manifest) return null;
  const root = path.resolve(dir);
  const entries = Object.entries(manifest.files);

  const targets = new Map();
  const lower = new Set();
  for (const [rel] of entries) {
    const abs = path.resolve(root, ...rel.split('/'));
    if (!inside(root, abs)) throw new WorkspaceStorageError(`manifest path ${JSON.stringify(rel)} escapes the workspace`, 'unsafe_path');
    targets.set(rel, abs);
    lower.add(rel.toLowerCase());
  }
  // A path can't be both a file and a folder ("a" and "a/b").
  for (const [rel] of entries) {
    const segs = rel.toLowerCase().split('/');
    for (let i = 1; i < segs.length; i++) {
      if (lower.has(segs.slice(0, i).join('/'))) throw new WorkspaceStorageError(`manifest path ${JSON.stringify(rel)} is under another file`, 'unsafe_path');
    }
  }

  await fs.mkdir(root, { recursive: true });
  const realRoot = await fs.realpath(root);
  const staging = await fs.mkdtemp(path.join(path.dirname(root), `.${path.basename(root)}.grapim-restore-`));
  try {
    const shas = [...new Set(entries.map(([, sha]) => sha))];
    await pool(shas, concurrency, async (sha) => {
      const buf = await storage.get(blobKey(wsKey, sha));
      if (!buf) throw new WorkspaceStorageError(`blob ${sha} is missing from storage`, 'blob_missing');
      if (sha1(buf) !== sha) throw new WorkspaceStorageError(`blob ${sha} does not match its sha1 (tampered or corrupt); restore refused`, 'blob_mismatch');
      await fs.writeFile(path.join(staging, sha), buf);
    });
    let bytes = 0;
    for (const [rel, sha] of entries) {
      const abs = targets.get(rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      // A symlinked folder already in `dir` must not carry the write outside it.
      const realParent = await fs.realpath(path.dirname(abs));
      if (realParent !== realRoot && !inside(realRoot, realParent)) {
        throw new WorkspaceStorageError(`manifest path ${JSON.stringify(rel)} resolves outside the workspace`, 'unsafe_path');
      }
      const buf = await fs.readFile(path.join(staging, sha));
      await writeFileAtomic(abs, buf);
      bytes += buf.length;
    }
    return { files: entries.length, bytes, head: manifest.head };
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

// ------------------------------------------------------- write-behind ----

// Queues blob uploads so a workspace write never waits on storage.
//   const p = createPersister(storage, { concurrency: 4, retry: { retries: 5 } });
//   p.enqueue(wsKey, sha, buf);   // returns at once
//   await p.flush();              // resolves when the queue is empty
//   p.stats();                    // { enqueued, deduped, uploaded, present, retried, failed, queued, inflight, queuedBytes }
export function createPersister(storage, { concurrency = 4, retry = {}, onError = null } = {}) {
  const policy = { retries: 5, baseDelayMs: 200, maxDelayMs: 10_000, ...retry };
  const queue = [];
  const queuedKeys = new Set();
  let active = 0;
  let queuedBytes = 0;
  let waiters = [];
  const counts = { enqueued: 0, deduped: 0, uploaded: 0, present: 0, retried: 0, failed: 0 };

  const report = (err, job) => {
    counts.failed++;
    if (onError) {
      try {
        onError(err, { wsKey: job.wsKey, sha: job.sha });
      } catch {}
    } else {
      process.stderr.write(`grapim storage: could not persist blob ${job.sha} of ${job.wsKey}: ${err.message}\n`);
    }
  };

  const settleIfIdle = () => {
    if (active === 0 && queue.length === 0) {
      const w = waiters;
      waiters = [];
      for (const resolve of w) resolve();
    }
  };

  async function run(job) {
    for (let i = 0; ; i++) {
      try {
        const uploaded = await persistBlob(storage, job.wsKey, job.sha, job.buf);
        counts[uploaded ? 'uploaded' : 'present']++;
        return;
      } catch (err) {
        if (!isRetryable(err) || i >= policy.retries) return report(err, job);
        counts.retried++;
        await sleep(backoffDelay(i, policy));
      }
    }
  }

  function pump() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      queuedBytes -= job.buf.length;
      active++;
      run(job).finally(() => {
        active--;
        queuedKeys.delete(job.key);
        pump();
        settleIfIdle();
      });
    }
  }

  return {
    enqueue(wsKey, sha, buf) {
      let key;
      try {
        key = blobKey(wsKey, sha);
      } catch (err) {
        report(err, { wsKey, sha });
        return false;
      }
      if (queuedKeys.has(key)) {
        counts.deduped++;
        return false;
      }
      const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      queuedKeys.add(key);
      queue.push({ key, wsKey, sha, buf: body });
      queuedBytes += body.length;
      counts.enqueued++;
      pump();
      return true;
    },
    flush() {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
    stats: () => ({ ...counts, queued: queue.length, inflight: active, queuedBytes }),
  };
}
