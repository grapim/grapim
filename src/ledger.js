// Records who changed what: a before-snapshot when an agent starts an edit,
// an after-snapshot when it finishes, and one change row joining the two.
//
// Claude Code: PreToolUse begins, PostToolUse finishes, paired by tool_use_id.
// MCP agents: claim_files begins, release_files (or disconnect) finishes.
// Files are read as raw bytes, never through git, so CRLF is kept exactly.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lineCounts } from './diff.js';
import { rootKey } from './workspace.js';

export const MAX_BYTES = 2 * 1024 * 1024;
// The sha recorded for a file too big to hash cheaply.
export const UNTRACKED = 'untracked';

export const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

const isBinary = (buf) => buf.subarray(0, 8192).includes(0);

// The file as it is now. { sha: null } if absent; buf is null when the content
// is not kept (binary, or over 2 MB).
export function snapshot(abs) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { sha: null, buf: null };
    throw err;
  }
  if (!st.isFile() || st.size > MAX_BYTES) return { sha: UNTRACKED, buf: null };
  const buf = fs.readFileSync(abs);
  return { sha: sha1(buf), buf: isBinary(buf) ? null : buf };
}

// Runs a ledger step without ever letting it stop the agent.
export function failOpen(what, fn) {
  try {
    return fn();
  } catch (err) {
    process.stderr.write(`grapim ledger: could not ${what} (edit allowed): ${err.message}\n`);
    return null;
  }
}

const fileRef = (ws, file) => ({ root: ws.root, root_key: rootKey(ws.root), path_key: file.key, path: file.display });

const fallbackId = (run, ref) => `${run}|${ref.root_key}|${ref.path_key}`;

export function beginEdit(store, { run, label, ws, file, id = null, keep = false }) {
  const ref = fileRef(ws, file);
  const snap = snapshot(path.join(ws.root, file.display));
  store.beginChange({ ...ref, id: id || fallbackId(run, ref), run, label, snap }, { keep });
}

function stats(store, p, after) {
  const before = store.blob(p.before_sha);
  const untracked = (p.before_sha !== null && !before) || (after.sha !== null && !after.buf);
  return untracked ? { untracked: true } : { untracked: false, ...lineCounts(before, after.buf) };
}

export const detailOf = (s) => (s.untracked ? 'untracked' : `+${s.added} -${s.removed}`);

// Closes one pending snapshot. Returns the change's +/- detail, or null if the file did not change.
export function finishPending(store, p) {
  const after = snapshot(path.join(p.root, p.path));
  if (after.sha === p.before_sha && after.sha !== UNTRACKED) {
    store.dropPending({ id: p.id });
    return null;
  }
  const s = stats(store, p, after);
  store.finishChange(p, after, s);
  return { path: p.path, detail: detailOf(s) };
}

export function finishEdit(store, { run, ws, file, id = null }) {
  const p = store.pending({ ...fileRef(ws, file), id, run });
  return p ? finishPending(store, p) : null;
}

// MCP release: close the run's pending snapshots, all of them or only these keys.
export function finishRun(store, run, pathKeys = null) {
  const wanted = pathKeys && new Set(pathKeys);
  return store
    .pendingOf(run)
    .filter((p) => !wanted || wanted.has(p.path_key))
    .map((p) => finishPending(store, p))
    .filter(Boolean);
}
