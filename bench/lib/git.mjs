// Git plumbing for the harness: one shallow bare clone per repository under
// bench/cache/repos/ (only the commits the benchmark needs), and per pull
// request a small bare repo that borrows those objects (alternates) so each PR
// gets its own refs and its own refs/notes/grapim. Reads from GitHub over
// HTTPS; never pushes.

import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from './gh.mjs';

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  GCM_INTERACTIVE: 'never',
  GIT_AUTHOR_NAME: 'grapim-bench',
  GIT_AUTHOR_EMAIL: 'bench@localhost',
  GIT_COMMITTER_NAME: 'grapim-bench',
  GIT_COMMITTER_EMAIL: 'bench@localhost',
};

// noLazy: never fetch missing objects on demand (a missing commit in a partial
// clone would otherwise pull the whole history of the repository).
export function git(gitDir, args, { input, allowFail = false, cwd, noLazy = false } = {}) {
  try {
    return execFileSync('git', ['-c', 'credential.helper=', '-c', 'core.autocrlf=false', ...(gitDir ? [`--git-dir=${gitDir}`] : []), ...args], {
      cwd,
      input,
      env: noLazy ? { ...GIT_ENV, GIT_NO_LAZY_FETCH: '1' } : GIT_ENV,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15 * 60 * 1000,
    });
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`git ${args.slice(0, 3).join(' ')}: ${String(err.stderr ?? err.message).trim().slice(0, 400)}`);
  }
}

const has = (gitDir, sha) => git(gitDir, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true, noLazy: true }) !== null;

export function sharedRepoDir(repo) {
  return path.join(CACHE_DIR, 'repos', `${repo.replace('/', '__')}.git`);
}

// Async git for the slow network fetches, so several repositories fetch at once.
export function gitAsync(gitDir, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'credential.helper=', ...(gitDir ? [`--git-dir=${gitDir}`] : []), ...args], { env: GIT_ENV, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (allowFail) return resolve(null);
      reject(new Error(`git ${args.slice(0, 3).join(' ')}: ${String(stderr || err.message).trim().slice(0, 400)}`));
    });
  });
}

// Makes sure the shared clone has base and head (with the history between).
export async function fetchPr(pr, { log = () => {} } = {}) {
  const dir = sharedRepoDir(pr.repo);
  if (!fs.existsSync(path.join(dir, 'HEAD'))) {
    fs.mkdirSync(dir, { recursive: true });
    git(null, ['init', '--bare', '--quiet', dir]);
    git(dir, ['remote', 'add', 'origin', `https://github.com/${pr.repo}.git`]);
    // Blob-less partial clone: commits and trees now, file contents on demand.
    git(dir, ['config', 'remote.origin.promisor', 'true']);
    git(dir, ['config', 'remote.origin.partialclonefilter', 'blob:none']);
    git(dir, ['config', 'extensions.partialClone', 'origin']);
  }
  const depth = Math.max(2, (pr.commits_ahead ?? 50) + 10);
  if (!has(dir, pr.head_sha)) {
    log(`fetch ${pr.repo} ${pr.head_sha.slice(0, 9)} (depth ${depth})`);
    // The reviewed head may only exist under the PR ref after a force-push.
    if ((await gitAsync(dir, ['fetch', '--no-tags', '--quiet', '--filter=blob:none', `--depth=${depth}`, 'origin', pr.head_sha], { allowFail: true })) === null) {
      await gitAsync(dir, ['fetch', '--no-tags', '--quiet', '--filter=blob:none', `--depth=${depth}`, 'origin', `+refs/pull/${pr.number}/head:refs/bench/pull/${pr.number}`]);
    }
  }
  if (!has(dir, pr.base_sha)) {
    log(`fetch ${pr.repo} base ${pr.base_sha.slice(0, 9)}`);
    await gitAsync(dir, ['fetch', '--no-tags', '--quiet', '--filter=blob:none', '--depth=1', 'origin', pr.base_sha]);
  }
  if (!has(dir, pr.head_sha) || !has(dir, pr.base_sha)) throw new Error(`could not fetch ${pr.repo} ${pr.head_sha} / ${pr.base_sha}`);
  return dir;
}

// A per-PR bare repo borrowing the shared objects: refs/bench/{base,head}.
export function prRepo(pr, { fresh = false } = {}) {
  const shared = sharedRepoDir(pr.repo);
  const dir = path.join(CACHE_DIR, 'work', pr.id, 'repo.git');
  if (fresh) fs.rmSync(dir, { recursive: true, force: true });
  if (!fs.existsSync(path.join(dir, 'HEAD'))) {
    fs.mkdirSync(dir, { recursive: true });
    git(null, ['init', '--bare', '--quiet', dir]);
    fs.mkdirSync(path.join(dir, 'objects', 'info'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'objects', 'info', 'alternates'), path.join(shared, 'objects').replace(/\\/g, '/') + '\n');
    // Missing blobs are fetched from GitHub on demand, into this repo.
    git(dir, ['remote', 'add', 'origin', `https://github.com/${pr.repo}.git`]);
    git(dir, ['config', 'remote.origin.promisor', 'true']);
    git(dir, ['config', 'remote.origin.partialclonefilter', 'blob:none']);
    git(dir, ['config', 'extensions.partialClone', 'origin']);
    const shallow = path.join(shared, 'shallow');
    if (fs.existsSync(shallow)) fs.copyFileSync(shallow, path.join(dir, 'shallow'));
  }
  git(dir, ['update-ref', 'refs/bench/base', pr.base_sha]);
  git(dir, ['update-ref', 'refs/bench/head', pr.head_sha]);
  git(dir, ['symbolic-ref', 'HEAD', 'refs/bench/head']);
  return dir;
}

// A checkout of the reviewed head (for tools that read files).
export function worktree(pr, gitDir) {
  const dir = path.join(CACHE_DIR, 'work', pr.id, 'tree');
  if (fs.existsSync(path.join(dir, '.git'))) {
    git(gitDir, ['worktree', 'remove', '--force', dir], { allowFail: true });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  git(gitDir, ['worktree', 'prune'], { allowFail: true });
  git(gitDir, ['worktree', 'add', '--detach', '--force', dir, pr.head_sha]);
  return dir;
}

export function mergeBase(gitDir, a, b) {
  return (git(gitDir, ['merge-base', a, b], { allowFail: true }) ?? '').trim() || a;
}

// The PR's diff as GitHub shows it: merge base to head, 3 lines of context.
export function prDiff(gitDir, pr) {
  const mb = mergeBase(gitDir, pr.base_sha, pr.head_sha);
  return git(gitDir, ['diff', '-U3', '-M', '--no-color', '--no-ext-diff', '--no-textconv', mb, pr.head_sha]);
}

export function changedFiles(gitDir, pr) {
  const mb = mergeBase(gitDir, pr.base_sha, pr.head_sha);
  return git(gitDir, ['diff', '--name-only', '-M', mb, pr.head_sha]).split('\n').filter(Boolean);
}

// "@@ -a,b +c,d @@" -> added ranges [c, c+d-1] per file, from a -U0 diff.
export function addedRanges(diffText) {
  const files = {};
  let cur = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      cur = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && cur) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0) (files[cur] ??= []).push([start, start + count - 1]);
    }
  }
  return files;
}

// The non-merge commits of base..head, oldest first.
export function prCommits(gitDir, pr) {
  const mb = mergeBase(gitDir, pr.base_sha, pr.head_sha);
  const out = git(gitDir, ['rev-list', '--reverse', '--no-merges', `${mb}..${pr.head_sha}`], { allowFail: true }) ?? '';
  return out.split('\n').filter(Boolean);
}

// Downloads, in a few batched requests, the file versions the reviewers will
// read (the PR's diff and each PR commit's diff, for blame), so the timed
// review does not wait on one-blob-at-a-time lazy fetches.
// commits: also each commit's own diff, which only the provenance notes of the
// `grapim` tool need (on a branch that merged main in, those are large).
export async function warm(gitDir, pr, { commits = true } = {}) {
  const mb = mergeBase(gitDir, pr.base_sha, pr.head_sha);
  await gitAsync(gitDir, ['diff', '--numstat', '-M', mb, pr.head_sha], { allowFail: true });
  if (!commits) return;
  for (const sha of prCommits(gitDir, pr)) {
    const parent = (git(gitDir, ['rev-parse', '--verify', '--quiet', `${sha}^`], { allowFail: true, noLazy: true }) ?? '').trim();
    if (!parent || git(gitDir, ['cat-file', '-e', `${parent}^{commit}`], { allowFail: true, noLazy: true }) === null) continue;
    await gitAsync(gitDir, ['diff', '--numstat', '-M', parent, sha], { allowFail: true });
  }
}
