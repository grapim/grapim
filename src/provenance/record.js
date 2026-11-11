// `grapim provenance record <commit>` (docs/provenance.md section 2): which
// lines a commit added or changed were written by which agent run, saved as a
// git note under refs/notes/grapim.
//
// Per file the commit changed: the base is the parent's version, the final is
// the commit's version. The file's ledger changes are replayed from the base
// (attribution.js replay with a base), then the final content is applied as an
// "outside" step, and every line the commit added (final vs base) keeps the
// author the replay gave it. Lines are compared ignoring line endings, as
// blame does: with core.autocrlf the blob has LF and the ledger CRLF.
//
// - New files: the base is empty.
// - Deleted files: nothing is added, skipped.
// - Renames and copies (diff-tree -M): the base is the old path's version in
//   the parent, and the ledger changes of both paths are replayed in order.
// - Binary files (a NUL byte in the first 8 KB) and files over 2 MB: skipped,
//   the ledger keeps no content for them.
// - Merge commits: skipped, no note. Their lines come from the merged
//   commits, which carry their own notes, and `git blame` (used by blame
//   --history and the PR summary) attributes each line to the commit that
//   introduced it. An agent's edit made while resolving a conflict is not
//   recorded in a note.

import path from 'node:path';
import { history, replay } from '../attribution.js';
import { ignoreEol, matchLines, splitLines } from '../diff.js';
import { MAX_BYTES, sha1 } from '../ledger.js';
import { getReview } from '../review.js';
import { fileKey } from '../workspace.js';
import { NOTE_REF, buildNote, isAgentRun, parseNote, serializeNote } from './note.js';
import { blobAt, changedFiles, commitInfo, configGet, git, readNote, readObjects, resolveCommit, tryGit, writeNote } from './git.js';

export const TOOL = 'grapim/0.1.0';

const isBinary = (buf) => !!buf && buf.subarray(0, 8192).includes(0);
const norm = (buf) => splitLines(buf).map(ignoreEol).join('\n');

// The intent a run had for one turn: the newest intent event at or before the
// turn's first change (the same rule as the review desk).
export function intentOf(store, run, turn) {
  const first = store.db.prepare('SELECT MIN(ts) AS ts FROM changes WHERE run = ? AND turn = ?').get(run, turn)?.ts;
  const rows = store.db.prepare(`SELECT ts, detail FROM events WHERE agent = ? AND kind = 'intent' ORDER BY id`).all(run);
  if (!rows.length) return null;
  if (first === null || first === undefined) return rows.at(-1).detail;
  return rows.filter((r) => r.ts <= first).at(-1)?.detail ?? null;
}

export function runInfo(store, run) {
  const agent = store.db.prepare('SELECT label FROM agents WHERE agent = ?').get(run);
  const change = store.db.prepare('SELECT label FROM changes WHERE run = ? AND label IS NOT NULL ORDER BY id DESC LIMIT 1').get(run);
  let review = 'pending';
  try {
    review = getReview(store, run)?.status ?? 'pending';
  } catch {}
  return { label: agent?.label || change?.label || run, review, intent: (turn) => intentOf(store, run, turn) };
}

export const intentsEnabled = (root) => configGet(root, 'grapim.notes.intents', { bool: true }) !== 'false';

// The ledger changes of these path keys in this worktree, oldest first, with contents.
function ledgerChanges(store, ws, keys) {
  const seen = new Set();
  const all = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    all.push(...history(store, ws.root, k));
  }
  return all.sort((a, b) => a.id - b.id);
}

// Where to start replaying: the latest point at which the ledger's content
// of the file was the base (eol-insensitive). -1 if it never was.
function startIndex(changes, baseNorm) {
  for (let s = changes.length; s >= 0; s--) {
    if (s < changes.length && changes[s].before !== undefined && norm(changes[s].before) === baseNorm) return s;
    if (s > 0 && changes[s - 1].after !== undefined && norm(changes[s - 1].after) === baseNorm) return s;
  }
  return -1;
}

// The agent-written lines of one file in a commit. Returns { lines } or { skip }.
const fileChanges = (store, ws, p, from, until) =>
  ledgerChanges(store, ws, [p, from].filter(Boolean).map((x) => fileKey(ws, path.join(ws.root, x))?.key).filter(Boolean)).filter((c) => c.ts <= until);

export function attributeFile(store, ws, { path: p, from, base, final, until = Infinity, changes = null }) {
  if (final === null) return { skip: 'deleted' };
  if (isBinary(final) || isBinary(base)) return { skip: 'binary' };
  if (final.length > MAX_BYTES) return { skip: 'too large' };
  changes ??= fileChanges(store, ws, p, from, until);
  if (!changes.length) return { lines: [] };
  const baseBuf = base ?? Buffer.alloc(0);
  const s = startIndex(changes, norm(baseBuf));
  const used = changes.slice(Math.max(0, s));
  if (used.some((c) => c.before === undefined || c.after === undefined)) return { skip: 'not recorded (binary or over 2 MB in the ledger)' };
  if (!used.length) return { lines: [] };
  const r = replay(used, { sha: sha1(final), buf: final }, { base: baseBuf, key: ignoreEol });
  const added = matchLines(splitLines(baseBuf), r.lines, ignoreEol);
  const lines = [];
  r.lines.forEach((_, i) => {
    const who = r.who[i];
    if (added[i] < 0 && who?.run && isAgentRun(who.run)) lines.push({ path: p, line: i + 1, run: who.run, turn: who.turn ?? 0 });
  });
  return { lines };
}

// Lines the commit added in text files, as `git diff --numstat` counts them.
function addedLines(root, parent, sha) {
  const args = ['diff-tree', '-r', '-M', '--numstat', '--no-commit-id', '--no-ext-diff', '--no-textconv'];
  // git() throws: every note must carry `added` (the reports' denominator).
  const out = git(root, parent ? [...args, parent, sha] : [...args, '--root', sha]);
  return out.split('\n').reduce((n, l) => n + (/^\d+\t/.test(l) ? Number(l.split('\t')[0]) : 0), 0);
}

// The note a commit should have, without writing it. A commit with no agent
// lines gets an empty note (runs: [], files: {}): "recorded, human", which
// reports tell apart from "not recorded" (no note). null only for merges.
export function attributeCommit(ws, store, commit) {
  const sha = resolveCommit(ws.root, commit);
  const info = commitInfo(ws.root, sha);
  if (info.parents.length > 1) return { commit: sha, merge: true, note: null, files: [], skipped: [] };
  const parent = info.parents[0] ?? null;
  // Changes recorded after the commit was made are not part of it (a later
  // `record` of an old commit). +1 s: the committer time has 1 s resolution.
  const until = info.time + 1000;
  const lines = [];
  const skipped = [];
  const files = [];
  // Only files the ledger has changes for can hold agent lines: their two
  // versions are read in one git process.
  const work = [];
  for (const f of changedFiles(ws.root, parent, sha)) {
    if (f.status === 'D') continue;
    const from = f.status === 'A' ? null : f.from;
    const changes = fileChanges(store, ws, f.path, from, until);
    if (changes.length) work.push({ f, from, changes, baseSpec: from && parent ? `${parent}:${from}` : null, finalSpec: `${sha}:${f.path}` });
    else files.push({ path: f.path, status: f.status, from: f.from, agentLines: 0 });
  }
  const blobs = readObjects(ws.root, work.flatMap((w) => [w.baseSpec, w.finalSpec]).filter(Boolean));
  const get = (spec) => (spec === null ? null : blobs.has(spec) ? blobs.get(spec) : blobAt(ws.root, ...spec.split(/:(.*)/s, 2)));
  for (const { f, from, changes, baseSpec, finalSpec } of work) {
    const r = attributeFile(store, ws, { path: f.path, from, base: get(baseSpec), final: get(finalSpec), until, changes });
    if (r.skip) skipped.push({ path: f.path, reason: r.skip });
    else {
      files.push({ path: f.path, status: f.status, from: f.from, agentLines: r.lines.length });
      lines.push(...r.lines);
    }
  }
  const intents = intentsEnabled(ws.root);
  // The optional commit block (section 1): committer time, and every line the
  // commit added (numstat against the first parent), for the reports' AI share.
  const commitMeta = { ts: info.time, added: addedLines(ws.root, parent, sha) };
  const note = buildNote(lines, (run) => runInfo(store, run), { intents, tool: TOOL, commit: commitMeta });
  return { commit: sha, merge: false, note, files, skipped };
}

function hasAgentRuns(text) {
  if (text === null) return false;
  try {
    return parseNote(text).runs.length > 0;
  } catch {
    return true; // unreadable: not ours to overwrite with an empty note
  }
}

// Is git going to copy notes from the pre-amend commit to the amended one?
function amendCopiesNotes(root) {
  const refs = process.env.GIT_NOTES_REWRITE_REF ? process.env.GIT_NOTES_REWRITE_REF.split(':') : configGet(root, 'notes.rewriteRef', { all: true });
  const ours = refs.some((r) => r === NOTE_REF || (r.endsWith('*') && NOTE_REF.startsWith(r.slice(0, -1))));
  return ours && configGet(root, 'notes.rewrite.amend', { bool: true }) !== 'false';
}

// Records the note for a commit. Idempotent: the note is rewritten. A commit
// with no agent lines gets an empty note, except that an empty note never
// replaces a note that lists agent runs (it may come from a machine whose
// ledger this one does not have). Recording never deletes a note.
//
// hook: true when run from the post-commit hook. Then:
// - during a rebase nothing is recorded: notes.rewriteRef copies each
//   original commit's note to its rewritten commit when the rebase ends;
// - after `commit --amend`, git copies the old commit's note to the new one
//   right after this hook and would concatenate it with ours. So when the old
//   commit has a note, the fresh note is written on the old commit and git's
//   copy carries it over.
export function recordCommit(ws, store, commit = 'HEAD', { hook = false } = {}) {
  let amendOf = null;
  if (hook) {
    const subject = tryGit(ws.root, ['reflog', '-1', '--format=%gs', 'HEAD'])?.trim() ?? '';
    if (/^rebase\b/.test(subject) || /^rebase\b/.test(process.env.GIT_REFLOG_ACTION ?? '')) {
      return { commit: resolveCommit(ws.root, commit), written: false, reason: 'rebase: notes are copied by notes.rewriteRef', note: null, skipped: [] };
    }
    if (/^commit \(amend\)/.test(subject)) amendOf = tryGit(ws.root, ['rev-parse', '--verify', '--quiet', 'HEAD@{1}'])?.trim() || null;
  }
  const r = attributeCommit(ws, store, commit);
  if (r.merge) return { ...r, written: false, reason: 'merge commit: skipped' };
  const json = serializeNote(r.note);
  let target = r.commit;
  if (amendOf && amendOf !== r.commit && readNote(ws.root, amendOf) !== null && amendCopiesNotes(ws.root)) target = amendOf;
  if (!r.note.runs.length && hasAgentRuns(readNote(ws.root, target))) {
    return { ...r, note: showNote(ws, target).note, written: false, target, reason: 'no agent lines found here; the existing note, which lists agent runs, is kept' };
  }
  writeNote(ws.root, target, json);
  return { ...r, note: JSON.parse(json), written: true, target };
}

// The note of a commit, parsed (concatenated notes merged), or null.
export function showNote(ws, commit) {
  const sha = resolveCommit(ws.root, commit);
  const text = readNote(ws.root, sha);
  return { commit: sha, note: text === null ? null : parseNote(text) };
}

// Pushes refs/notes/grapim to a remote. Never throws: returns { ok, message }.
// If the remote's notes moved on (another machine pushed), they are fetched
// and merged (union) first, then pushed again. --no-verify keeps this push
// from running the pre-push hook again.
export function pushNotes(ws, remote = 'origin', { timeoutMs = 30_000 } = {}) {
  const env = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' };
  if (!tryGit(ws.root, ['rev-parse', '--verify', '--quiet', NOTE_REF])) return { ok: true, message: 'No provenance notes to push yet.' };
  const run = (args) => {
    try {
      git(ws.root, args, { env, timeout: timeoutMs });
      return null;
    } catch (err) {
      return err.message;
    }
  };
  let err = run(['push', '--no-verify', '--quiet', remote, `${NOTE_REF}:${NOTE_REF}`]);
  if (err && /rejected|non-fast-forward|fetch first/i.test(err)) {
    const tmp = 'refs/notes/grapim-remote';
    const fetchErr = run(['fetch', '--quiet', remote, `+${NOTE_REF}:${tmp}`]);
    if (!fetchErr) {
      run(['notes', '--ref=grapim', 'merge', '-s', 'cat_sort_uniq', tmp]);
      run(['update-ref', '-d', tmp]);
      err = run(['push', '--no-verify', '--quiet', remote, `${NOTE_REF}:${NOTE_REF}`]);
    } else err = fetchErr;
  }
  return err ? { ok: false, message: `Could not push provenance notes to ${remote}: ${err}` } : { ok: true, message: `Pushed provenance notes to ${remote}.` };
}
