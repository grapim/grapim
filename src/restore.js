// Restore one file to a version Grapim recorded (Dropbox-style "restore this
// version"), with the same safety as undo:
//
// - the version must be one this file had: a before or after of one of its
//   recorded changes, with its content kept;
// - another agent holding the file, or anyone in the middle of an edit to it,
//   stops the write (writing under a half-finished edit would credit our bytes
//   to that agent);
// - the file's folder must still really be inside the worktree (no link out);
// - the write is atomic, through a random temp name opened with wx;
// - it is recorded as a change under its own run, restore:<ts>, so blame, runs
//   and undo see it and the restore itself can be undone; plus a `restore` event.
//
// planRestore(store, ws, file, sha, { actor })  -> plan (changes nothing)
// applyRestore(store, ws, plan, actor, { expect }) -> plan + { run }, or throws
//   errors carry code: not_found | bad_request | conflict | busy

import path from 'node:path';
import { history } from './attribution.js';
import { lineCounts } from './diff.js';
import { snapshot } from './ledger.js';
import { autoApprove } from './review.js';
import { leavesRoot, writeFile } from './undo.js';
import { rootKey } from './workspace.js';

const fail = (code, message) => Object.assign(new Error(message), { code });

// The one recorded sha of this file that `sha` names (a full sha or a prefix of
// 4 or more hex characters), with the newest change that produced it.
function findVersion(store, ws, file, sha) {
  const want = String(sha ?? '').toLowerCase();
  if (!/^[0-9a-f]{4,40}$/.test(want)) throw fail('bad_request', 'sha must be 4 to 40 hex characters: a version from the file history.');
  const changes = history(store, ws.root, file.key);
  const found = new Map(); // sha -> the change it came from (after wins over before)
  for (const c of changes) {
    for (const [s, side] of [[c.before_sha, 'before'], [c.after_sha, 'after']]) {
      if (s && s.startsWith(want) && (side === 'after' || !found.has(s))) found.set(s, { change: c, side });
    }
  }
  if (!found.size) throw fail('not_found', `${file.display} has no recorded version ${want}. See its history.`);
  if (found.size > 1) throw fail('bad_request', `"${want}" matches ${found.size} versions of ${file.display}. Give more of the sha.`);
  const [[full, { change, side }]] = found;
  const buf = store.blob(full);
  if (!buf) throw fail('not_found', `Version ${full.slice(0, 8)} of ${file.display} was not kept (binary or over 2 MB), so it cannot be restored.`);
  return { sha: full, buf, change, side };
}

// Why the file must not be written right now, and as which error, or null.
function blocker(store, ws, file, actor) {
  const h = store.holder(file.key, actor);
  if (h) return { code: 'conflict', reason: `held by ${h.label || h.agent} right now` };
  const p = store.editInProgress(rootKey(ws.root), file.key);
  if (p) return { code: 'busy', reason: `${p.label || p.run} is in the middle of editing it` };
  return null;
}

function actionOf(now, sha) {
  if (now.sha === sha) return 'nothing';
  return now.sha === null ? 'create' : 'replace';
}

// What restoring would do. file: { key, display } from fileKey/resolvePath.
export function planRestore(store, ws, file, sha, { actor = null } = {}) {
  const v = findVersion(store, ws, file, sha);
  const abs = path.join(ws.root, file.display);
  const now = snapshot(abs);
  const action = actionOf(now, v.sha);
  // The current file's content is not kept when it is binary or over 2 MB.
  const known = now.sha === null || now.buf !== null;
  const counts = action === 'nothing' ? { added: 0, removed: 0 } : known ? lineCounts(now.buf, v.buf) : { added: null, removed: null };
  const block = action === 'nothing' ? null : blocker(store, ws, file, actor);
  return {
    path: file.display,
    path_key: file.key,
    root: ws.root,
    abs,
    sha: v.sha,
    version: { sha: v.sha, buf: v.buf },
    // Where the version comes from: after (or before) this change.
    from: { id: v.change.id, ts: v.change.ts, run: v.change.run, label: v.change.label || v.change.run, turn: v.change.turn, side: v.side },
    now,
    action,
    added: counts.added,
    removed: counts.removed,
    reason: block?.reason ?? null,
    block,
  };
}

// Restores the file. expect: the sha the caller saw as current (null for no
// file); if the file changed since, nothing is written (409).
export function applyRestore(store, ws, plan, actor, { expect } = {}) {
  if (plan.action === 'nothing') return { ...plan, run: null };
  const file = { key: plan.path_key, display: plan.path };
  const block = blocker(store, ws, file, actor);
  if (block) throw fail(block.code, `${plan.path} is ${block.reason}. Try again once it is free.`);
  if (leavesRoot(ws.root, plan.abs)) throw fail('conflict', `A folder on the path of ${plan.path} is now a link that leads outside the worktree, so it is not written.`);
  const now = snapshot(plan.abs);
  if (now.sha !== plan.now.sha || (expect !== undefined && now.sha !== expect)) {
    throw fail('conflict', `${plan.path} changed since you looked at it. Look at the version again and restore once more.`);
  }
  writeFile(plan.abs, plan.version);
  const run = `restore:${Date.now()}`;
  const label = `restore ${plan.path} ${plan.sha.slice(0, 8)}`;
  const untracked = now.sha !== null && !now.buf;
  const ref = { root: ws.root, root_key: rootKey(ws.root), path_key: plan.path_key, path: plan.path };
  store.recordChange({ ...ref, run, label, turn: 0, untracked, ...(untracked ? {} : lineCounts(now.buf, plan.version.buf)) }, now, plan.version);
  store.recordEvent(actor, 'restore', plan.path, `${plan.sha.slice(0, 12)} ${run}`, actor);
  autoApprove(store, run, actor);
  return { ...plan, run, label };
}

// The JSON the API and `grapim restore --json` print.
export const restoreJson = (plan, applied, extra = {}) => ({
  applied,
  path: plan.path,
  sha: plan.sha,
  action: plan.action,
  reason: plan.reason,
  current_sha: plan.now.sha,
  added: plan.added,
  removed: plan.removed,
  from: plan.from,
  run: plan.run ?? null,
  ...extra,
});
