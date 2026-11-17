// The inputs of renderSummary (render.js) for a range of commits, from a
// local git repo: the lines a PR adds (its final diff from the merge base),
// `git blame --porcelain` at the head for those lines, and the notes of the
// commits that introduced them. Used by `grapim provenance pr <base>..<head>`
// and by the GitHub Action (bundled into action/dist/ by action/bundle.mjs),
// so it imports only node: builtins and runs on Node 20.
//
// git never runs a program from the repo here: diffs and blame are called
// with --no-ext-diff and --no-textconv, and nothing reads the working tree.

import { spawnSync } from 'node:child_process';

export const NOTES_REF = 'refs/notes/grapim';
export const MAX_NOTE_BYTES = 512 * 1024; // the contract caps notes at 256 KB; past twice that, ignore it
const MAX_BUFFER = 256 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export class GitError extends Error {}

// timeout (ms): kill git after that long; it then throws a GitError.
export function git(cwd, args, { input, allowFail = false, encoding = 'utf8', timeout } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, input, encoding: encoding === 'buffer' ? undefined : encoding, maxBuffer: MAX_BUFFER, windowsHide: true, ...(timeout ? { timeout, killSignal: 'SIGKILL' } : {}) });
  if (r.error) throw new GitError(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) {
    if (allowFail) return null;
    throw new GitError(`git ${args[0]} failed: ${String(r.stderr ?? '').trim().split('\n')[0]}`);
  }
  return r.stdout;
}

export const resolveCommit = (cwd, rev) => {
  const out = git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { allowFail: true });
  return out ? out.trim() : null;
};

// What a CI checkout lacks for base..head: refs/notes/grapim (actions/checkout
// never fetches it), the full history if the clone is shallow, and the base
// and head commits (head from refs/pull/<n>/head when it is not on a branch).
// Shared by the provenance and review Actions. Never fails: whatever is still
// missing shows up as an unknown commit later.
export function prepareHistory(cwd, { base, head, number }, log = () => {}) {
  if (git(cwd, ['fetch', '--no-tags', '--quiet', 'origin', `+${NOTES_REF}:${NOTES_REF}`], { allowFail: true }) === null) log(`No ${NOTES_REF} on the remote yet.`);
  if ((git(cwd, ['rev-parse', '--is-shallow-repository'], { allowFail: true }) ?? '').trim() === 'true') {
    log('The checkout is shallow: fetching the full history (set fetch-depth: 0 on actions/checkout to skip this).');
    git(cwd, ['fetch', '--no-tags', '--quiet', '--unshallow', 'origin'], { allowFail: true });
  }
  for (const [sha, extra] of [
    [base, null],
    [head, Number.isSafeInteger(number) ? `+refs/pull/${number}/head` : null],
  ]) {
    if (resolveCommit(cwd, sha)) continue;
    git(cwd, ['fetch', '--no-tags', '--quiet', 'origin', sha], { allowFail: true });
    if (!resolveCommit(cwd, sha) && extra) git(cwd, ['fetch', '--no-tags', '--quiet', 'origin', extra], { allowFail: true });
  }
}

// `git diff --numstat -z` entries: { path, oldPath, added, binary }.
function numstat(cwd, from, to) {
  const out = git(cwd, ['diff', '--numstat', '-z', '-M', '--no-ext-diff', '--no-textconv', from, to]);
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i];
    if (!head) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) continue;
    let p = m[3];
    let oldPath = null;
    if (p === '') {
      oldPath = parts[++i];
      p = parts[++i];
    }
    files.push({ path: p, oldPath, added: m[1] === '-' ? 0 : Number(m[1]), binary: m[1] === '-' });
  }
  return files;
}

// Added line ranges per file, in numstat order: git prints both in the same
// order with the same options, so section n of the diff is entry n.
function addedRanges(cwd, from, to) {
  const out = git(cwd, ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', from, to]);
  const sections = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = [];
      sections.push(cur);
    } else if (cur && line.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0) cur.push([start, start + count - 1]);
    }
  }
  return sections;
}

// git blame --porcelain for the given head line ranges of one file:
// [{ start, end, commit, orig, path }], one entry per line group.
export function blameRanges(cwd, head, file, ranges) {
  const args = ['blame', '--porcelain', '--no-textconv'];
  if (ranges.length <= 200) for (const [s, e] of ranges) args.push('-L', `${s},${e}`);
  args.push(head, '--', file);
  const out = git(cwd, args, { allowFail: true });
  if (out === null) return [];
  const names = new Map(); // commit -> its file name there
  const groups = [];
  let last = null;
  for (const line of out.split('\n')) {
    const h = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\d+) (\d+)(?: (\d+))?$/.exec(line);
    if (h) {
      const commit = h[1];
      const orig = Number(h[2]);
      const final = Number(h[3]);
      // Consecutive lines of one group extend it; a new group starts otherwise.
      if (last && last.commit === commit && last.end + 1 === final && last.orig + (final - last.start) === orig) last.end = final;
      else {
        last = { start: final, end: final, commit, orig };
        groups.push(last);
      }
      continue;
    }
    if (line.startsWith('filename ') && last) names.set(last.commit, line.slice(9));
  }
  return groups
    .filter((g) => !/^0+$/.test(g.commit))
    .map((g) => ({ ...g, path: names.get(g.commit) ?? file }));
}

export function hasNotesRef(cwd, ref = NOTES_REF) {
  return git(cwd, ['rev-parse', '--verify', '--quiet', ref], { allowFail: true }) !== null;
}

// { [commit]: note JSON text } for the commits that have a note.
export function readNotes(cwd, commits, ref = NOTES_REF) {
  const want = new Set(commits);
  const out = git(cwd, ['notes', `--ref=${ref}`, 'list'], { allowFail: true });
  if (!out) return {};
  const blobs = new Map();
  for (const line of out.split('\n')) {
    const [blob, commit] = line.trim().split(/\s+/);
    if (blob && want.has(commit) && SHA.test(blob)) blobs.set(blob, commit);
  }
  if (!blobs.size) return {};
  // Sizes first: anyone who can push refs/notes/grapim can push a huge note,
  // and reading it whole would only make the job fail.
  const check = git(cwd, ['cat-file', '--batch-check'], { input: [...blobs.keys()].join('\n') + '\n' });
  for (const line of check.split('\n')) {
    const [sha, type, size] = line.split(' ');
    if (blobs.has(sha) && (type !== 'blob' || !(Number(size) <= MAX_NOTE_BYTES))) blobs.delete(sha);
  }
  if (!blobs.size) return {};
  const raw = git(cwd, ['cat-file', '--batch'], { input: [...blobs.keys()].join('\n') + '\n', encoding: 'buffer' });
  const notes = {};
  let at = 0;
  while (at < raw.length) {
    const nl = raw.indexOf(0x0a, at);
    if (nl < 0) break;
    const [sha, type, size] = raw.subarray(at, nl).toString('latin1').split(' ');
    if (type === 'missing' || size === undefined) {
      at = nl + 1;
      continue;
    }
    const n = Number(size);
    const body = raw.subarray(nl + 1, nl + 1 + n);
    at = nl + 1 + n + 1;
    if (type === 'blob' && n <= MAX_NOTE_BYTES && blobs.has(sha)) notes[blobs.get(sha)] = body.toString('utf8');
  }
  return notes;
}

// Everything renderSummary needs for base..head. maxFiles: files attributed,
// in diff order; the rest are counted as omitted.
export function collectFromGit({ cwd, base, head, maxFiles = 300, ref = NOTES_REF }) {
  const headSha = resolveCommit(cwd, head);
  const baseSha = resolveCommit(cwd, base);
  if (!headSha) throw new GitError(`Unknown commit: ${head}`);
  if (!baseSha) throw new GitError(`Unknown commit: ${base}`);
  const mergeBase = (git(cwd, ['merge-base', baseSha, headSha], { allowFail: true }) ?? '').trim() || baseSha;
  const stat = numstat(cwd, mergeBase, headSha);
  const sections = addedRanges(cwd, mergeBase, headSha);
  const changed = stat.map((f, i) => ({ ...f, ranges: sections[i] ?? [] }));
  const candidates = changed.filter((f) => !f.binary && f.ranges.length);
  const chosen = candidates.slice(0, maxFiles);
  const files = [];
  const blameByFile = {};
  const commits = new Set();
  for (const f of chosen) {
    files.push({ path: f.path, added: f.ranges });
    const b = blameRanges(cwd, headSha, f.path, f.ranges);
    blameByFile[f.path] = b;
    for (const g of b) commits.add(g.commit);
  }
  const notesRef = hasNotesRef(cwd, ref);
  const notesByCommit = notesRef ? readNotes(cwd, [...commits], ref) : {};
  return { base: baseSha, head: headSha, mergeBase, files, blameByFile, notesByCommit, omittedFiles: candidates.length - chosen.length, hasNotes: notesRef };
}
