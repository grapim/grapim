// Small git helpers for provenance. Every call is execFileSync with an
// argument list (no shell), and returns null instead of throwing where
// "not there" is a normal answer.

import { execFileSync } from 'node:child_process';
import { NOTES_REF_NAME, NOTE_REF } from './note.js';

const MAX_BUFFER = 256 * 1024 * 1024;

export class GitError extends Error {}

export function git(root, args, { input, buffer = false, env, timeout } = {}) {
  try {
    const out = execFileSync('git', args, {
      cwd: root,
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      env: env ? { ...process.env, ...env } : process.env,
      ...(timeout ? { timeout, killSignal: 'SIGKILL' } : {}),
    });
    return buffer ? out : out.toString('utf8');
  } catch (err) {
    const msg = String(err.stderr || err.message).trim().split('\n')[0];
    throw new GitError(`git ${args[0]} failed: ${msg}`);
  }
}

export function tryGit(root, args, opts) {
  try {
    return git(root, args, opts);
  } catch {
    return null;
  }
}

export function resolveCommit(root, rev) {
  const out = tryGit(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  const sha = out?.trim();
  if (!sha) throw new GitError(`${rev} is not a commit in this repo.`);
  return sha;
}

// [sha, ...parents], and the committer time in ms.
export function commitInfo(root, sha) {
  const [line, time] = git(root, ['show', '-s', '--format=%H %P%n%ct', sha]).trim().split('\n');
  const [, ...parents] = line.trim().split(/\s+/);
  return { sha, parents, time: Number(time) * 1000 };
}

// The files a commit changed against `parent` (null: the root commit), with
// renames and copies detected. [{ status: 'A'|'M'|'D'|'R'|'C'|'T', path, from }]
export function changedFiles(root, parent, sha) {
  const args = ['diff-tree', '-r', '-z', '-M', '--name-status', '--no-commit-id', '--no-ext-diff', '--no-textconv'];
  const out = git(root, parent ? [...args, parent, sha] : [...args, '--root', sha]);
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; ) {
    const st = parts[i++];
    if (!st) continue;
    const s = st[0];
    if (s === 'R' || s === 'C') {
      const from = parts[i++];
      const p = parts[i++];
      files.push({ status: s, path: p, from });
    } else {
      files.push({ status: s, path: parts[i++], from: s === 'A' ? null : undefined });
    }
  }
  return files.map((f) => ({ ...f, from: f.from === undefined ? f.path : f.from }));
}

// A file's content at a commit, as stored in git (no eol conversion), or null.
export function blobAt(root, rev, file) {
  return tryGit(root, ['cat-file', 'blob', `${rev}:${file}`], { buffer: true });
}

export function configGet(root, key, { all = false, bool = false } = {}) {
  const args = ['config', ...(bool ? ['--bool'] : []), all ? '--get-all' : '--get', key];
  const out = tryGit(root, args);
  if (out === null) return all ? [] : null;
  return all ? out.split('\n').filter(Boolean) : out.trim();
}

export function readNote(root, sha) {
  return tryGit(root, ['notes', `--ref=${NOTES_REF_NAME}`, 'show', sha]);
}

// Writes (replaces) the note through stdin. Retries with a fallback identity
// when the repo has none configured: a notes commit needs a committer.
export function writeNote(root, sha, json) {
  const args = ['notes', `--ref=${NOTES_REF_NAME}`, 'add', '-f', '-F', '-', sha];
  try {
    git(root, args, { input: json + '\n' });
  } catch (err) {
    if (!/identity|user\.email|user\.name|tell me who you are/i.test(err.message)) throw err;
    const id = { name: 'Grapim', email: 'grapim@localhost' };
    git(root, args, { input: json + '\n', env: { GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email } });
  }
}

// commit sha -> note blob sha, for every note in the ref.
export function listNotes(root) {
  const out = tryGit(root, ['notes', `--ref=${NOTES_REF_NAME}`, 'list']);
  const map = new Map();
  for (const line of (out ?? '').split('\n')) {
    const [blob, commit] = line.trim().split(/\s+/);
    if (blob && commit) map.set(commit, blob);
  }
  return map;
}

// Reads many objects in one `git cat-file --batch`: name (a sha, or
// "<rev>:<path>") -> Buffer. Missing objects are left out; names with a
// newline cannot go through --batch and are left out too.
export function readObjects(root, names) {
  const out = new Map();
  const list = [...new Set(names)].filter((n) => !/[\r\n]/.test(n));
  if (!list.length) return out;
  const buf = git(root, ['cat-file', '--batch'], { input: list.join('\n') + '\n', buffer: true });
  let pos = 0;
  for (const name of list) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString('utf8').split(' ');
    pos = nl + 1;
    if (header.at(-1) === 'missing' || header.at(-1) === 'ambiguous' || header.length < 3) continue;
    const size = Number(header[2]);
    if (header[1] === 'blob') out.set(name, buf.subarray(pos, pos + size));
    pos += size + 1;
  }
  return out;
}

// sha -> utf8 text.
export function readBlobs(root, shas) {
  const out = new Map();
  for (const [k, v] of readObjects(root, shas)) out.set(k, v.toString('utf8'));
  return out;
}

export const notesRefSha = (root) => tryGit(root, ['rev-parse', '--verify', '--quiet', NOTE_REF])?.trim() || null;

// The hooks directory git uses (core.hooksPath respected), absolute.
export function hooksDir(root) {
  const out = tryGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  return out ? out.trim() : null;
}
