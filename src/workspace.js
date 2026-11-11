// Finds which repo a path belongs to and where the shared state lives.
//
// In a git repo the state goes in <git-common-dir>/grapim. Every worktree of a
// repo shares the same common dir, so agents in different worktrees see each
// other's claims. File keys are relative to the worktree root, so
// `src/app.ts` in worktree A and `src/app.ts` in worktree B are the same key.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

// Nearest existing directory at or above `p` (a file being created may not exist yet).
function existingDir(p) {
  let dir = path.resolve(p);
  while (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    const up = path.dirname(dir);
    if (up === dir) return dir;
    dir = up;
  }
  return dir;
}

export function resolveWorkspace(startPath) {
  const dir = existingDir(startPath);
  const override = process.env.GRAPIM_STATE_DIR;
  const top = git(['rev-parse', '--show-toplevel'], dir);
  if (top) {
    const common = path.resolve(dir, git(['rev-parse', '--git-common-dir'], dir) || '.git');
    const root = path.resolve(top);
    return {
      root,
      stateDir: override || path.join(common, 'grapim'),
      worktree: path.basename(root),
      repo: path.basename(path.dirname(common)),
      isGit: true,
    };
  }
  return {
    root: dir,
    stateDir: override || path.join(dir, '.grapim'),
    worktree: path.basename(dir),
    repo: path.basename(dir),
    isGit: false,
  };
}

// Returns { key, display } for a file inside the workspace, or null if it is outside.
export function fileKey(ws, filePath) {
  const rel = path.relative(ws.root, path.resolve(ws.root, filePath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const display = rel.split(path.sep).join('/');
  const key = process.platform === 'win32' || process.platform === 'darwin' ? display.toLowerCase() : display;
  return { key, display };
}

// A comparable form of a worktree root, for matching recorded changes to a worktree.
export function rootKey(root) {
  const p = path.resolve(root).split(path.sep).join('/');
  return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
}
