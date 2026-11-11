// Who wrote each line. Start from the first recorded content of a file, replay
// its recorded changes in order with a line diff, and carry each line's author
// forward. Lines that appear between recorded changes (a Bash sed, a human)
// are written by "outside agents".

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ignoreEol, matchLines, splitLines } from './diff.js';
import { snapshot } from './ledger.js';
import { rootKey } from './workspace.js';

export const OUTSIDE = Object.freeze({ run: null, label: 'outside agents', turn: null });

// Content for a sha: null if the file did not exist, undefined if it was not kept.
function content(store, sha) {
  if (sha === null) return null;
  return store.blob(sha) ?? undefined;
}

// The file's recorded changes with their contents, oldest first.
export function history(store, root, key) {
  return store.changesOfFile(rootKey(root), key).map((c) => ({
    ...c,
    before: content(store, c.before_sha),
    after: content(store, c.after_sha),
  }));
}

export const isTracked = (changes, now) =>
  changes.every((c) => c.before !== undefined && c.after !== undefined) && (now.sha === null || now.buf !== null);

const authorOf = (c) => ({ run: c.run, label: c.label, turn: c.turn });
const countOf = (who, run) => who.reduce((n, a) => n + (a?.run === run ? 1 : 0), 0);

// Replays the changes and then the current file. who[i] is the author of
// lines[i] (null: already there before the first recorded change). ends maps
// each run to how many lines it owned right after its last change.
export function replay(changes, now) {
  let sha = changes.length ? changes[0].before_sha : now.sha;
  let lines = splitLines(changes.length ? changes[0].before : now.buf);
  let who = lines.map(() => null);
  const ends = new Map();
  const step = (next, author) => {
    const from = matchLines(lines, next);
    who = next.map((_, j) => (from[j] >= 0 ? who[from[j]] : author));
    lines = next;
  };
  for (const c of changes) {
    if (c.before_sha !== sha) step(splitLines(c.before), OUTSIDE);
    step(splitLines(c.after), authorOf(c));
    sha = c.after_sha;
    ends.set(c.run, countOf(who, c.run));
  }
  if (now.sha !== sha) step(splitLines(now.buf), OUTSIDE);
  return { lines, who, ends };
}

// The file at HEAD, as stored (no eol conversion). Empty if it is not in HEAD.
function headContent(root, display) {
  try {
    return execFileSync('git', ['cat-file', 'blob', `HEAD:${display}`], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return Buffer.alloc(0);
  }
}

const text = (line) => Buffer.from(line, 'latin1').toString('utf8').replace(/\r?\n$/, '');

// Each line of the working file that differs from HEAD (or, without git, from
// the first recorded content), with who wrote it.
export function blame(store, ws, file) {
  const changes = history(store, ws.root, file.key);
  const now = snapshot(path.join(ws.root, file.display));
  const base = { path: file.display, base: ws.isGit ? 'HEAD' : 'the first recorded version', changes: changes.length, exists: now.sha !== null };
  if (!isTracked(changes, now)) return { ...base, untracked: true, runs: [...new Set(changes.map((c) => c.label || c.run))] };
  const r = replay(changes, now);
  // Compare to HEAD ignoring line endings: with core.autocrlf the blob has LF
  // and the working file CRLF, and that is not an authored change.
  const head = splitLines(ws.isGit ? headContent(ws.root, file.display) : changes[0]?.before);
  const from = matchLines(head, r.lines, ignoreEol);
  const lines = [];
  r.lines.forEach((line, i) => {
    if (from[i] < 0) lines.push({ line: i + 1, text: text(line), ...(r.who[i] ?? OUTSIDE) });
  });
  const removed = head.length - from.filter((i) => i >= 0).length;
  return { ...base, untracked: false, lines, removed };
}

// Per run and file: are the run's lines still in the working file? yes, partly, no, or ?.
function fileStatus(r, c, now) {
  const end = r.ends.get(c.run);
  const kept = countOf(r.who, c.run);
  if (end > 0) return kept === end ? 'yes' : kept === 0 ? 'no' : 'partly';
  // The run only removed lines: compare whole files.
  if (now.sha === c.lastAfter) return 'yes';
  if (now.sha === c.firstBefore) return 'no';
  return '?';
}

// Every touched file, with each run's first before and last after in it.
function touchedFiles(store) {
  const byFile = new Map();
  for (const c of store.allChanges()) {
    const k = `${c.root_key}|${c.path_key}`;
    if (!byFile.has(k)) byFile.set(k, { root: c.root, path: c.path, key: c.path_key, runs: new Map() });
    const runs = byFile.get(k).runs;
    if (!runs.has(c.run)) runs.set(c.run, { run: c.run, firstBefore: c.before_sha });
    runs.get(c.run).lastAfter = c.after_sha;
  }
  return byFile;
}

// One status for a run from its files' statuses; files we cannot judge (?) do not count.
function summary(all) {
  const known = all.filter((s) => s !== '?');
  if (!known.length) return '?';
  return known.every((s) => s === known[0]) ? known[0] : 'partly';
}

// Which runs' changes are still in the working tree. Returns Map(run -> status).
export function inTree(store) {
  const byFile = touchedFiles(store);
  const out = new Map();
  const add = (run, s) => out.set(run, [...(out.get(run) ?? []), s]);
  for (const f of byFile.values()) {
    const changes = history(store, f.root, f.key);
    const now = snapshot(path.join(f.root, f.path));
    const r = isTracked(changes, now) ? replay(changes, now) : null;
    for (const c of f.runs.values()) add(c.run, r ? fileStatus(r, c, now) : '?');
  }
  return new Map([...out].map(([run, all]) => [run, summary(all)]));
}
