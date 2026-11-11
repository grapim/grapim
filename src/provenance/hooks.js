// The git hooks `grapim init` installs for commit provenance
// (docs/provenance.md section 2):
//
//   post-commit: grapim provenance record HEAD --hook
//   pre-push:    grapim provenance push <remote>
//
// POSIX sh, so they run the same under Git for Windows. They chain to the
// hook that was there before (kept as <name>.grapim-prev and run first), are
// rewritten in place on a second init, and never fail the commit or push:
// only the previous hook's exit status is passed on.

import fs from 'node:fs';
import path from 'node:path';
import { NOTE_REF } from './note.js';
import { configGet, tryGit } from './git.js';

export const MARKER = '# grapim-hook v1';
export const HOOKS = Object.freeze(['post-commit', 'pre-push']);

// Single-quoted for sh.
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function hookScript(name, bin) {
  const node = `node ${sq(bin)}`;
  const lines = ['#!/bin/sh', MARKER];
  if (name === 'post-commit') {
    lines.push(
      '# Installed by `grapim init`: records which lines of the commit AI agents',
      '# wrote, as a git note in refs/notes/grapim. It never fails the commit.',
      'status=0',
      'prev="$(dirname "$0")/post-commit.grapim-prev"',
      'if [ -f "$prev" ] && [ -x "$prev" ]; then',
      '  "$prev" "$@" || status=$?',
      'fi',
      'if command -v node >/dev/null 2>&1; then',
      `  ${node} provenance record HEAD --hook </dev/null >/dev/null 2>&1 ||`,
      '    echo "grapim: could not record AI provenance for this commit (the commit is fine). Try: grapim provenance record HEAD" >&2',
      'fi',
      'exit $status',
    );
  } else {
    lines.push(
      '# Installed by `grapim init`: pushes refs/notes/grapim (AI provenance) with',
      '# your push. It never blocks the push; only the previous hook can.',
      'prev="$(dirname "$0")/pre-push.grapim-prev"',
      'if [ -f "$prev" ] && [ -x "$prev" ]; then',
      '  "$prev" "$@" || exit $?',
      'fi',
      'if command -v node >/dev/null 2>&1; then',
      `  ${node} provenance push "$1" </dev/null >/dev/null 2>&1 ||`,
      '    echo "grapim: could not push AI provenance notes (your push goes on). Try: grapim provenance push" >&2',
      'fi',
      'exit 0',
    );
  }
  return lines.join('\n') + '\n';
}

// The hooks directory git runs hooks from (core.hooksPath respected).
export function gitHooksDir(root) {
  const abs = tryGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'])?.trim();
  if (abs) return abs;
  const rel = tryGit(root, ['rev-parse', '--git-path', 'hooks'])?.trim();
  return rel ? path.resolve(root, rel) : null;
}

const isOurs = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').includes(MARKER);
  } catch {
    return false;
  }
};

export function hasGitHooks(root) {
  const dir = gitHooksDir(root);
  return !!dir && isOurs(path.join(dir, 'post-commit'));
}

function setConfig(root, args) {
  if (tryGit(root, ['config', '--local', ...args]) === null) throw new Error(`could not set git config ${args.at(-2)}`);
}

// Installs both hooks and the notes config. Returns what it did.
export function installGitHooks(root, { bin, intents = null } = {}) {
  const dir = gitHooksDir(root);
  if (!dir) throw new Error('not a git repo');
  fs.mkdirSync(dir, { recursive: true });
  const out = { dir, hooks: [], chained: [] };
  for (const name of HOOKS) {
    const file = path.join(dir, name);
    const prev = `${file}.grapim-prev`;
    if (fs.existsSync(file) && !isOurs(file)) {
      // A hook that is not ours: keep it and call it first. A .grapim-prev
      // left from an earlier install is kept under a dated name, never lost.
      if (fs.existsSync(prev)) fs.renameSync(prev, `${prev}.${Date.now()}`);
      fs.renameSync(file, prev);
    }
    if (fs.existsSync(prev)) out.chained.push(name);
    const tmp = `${file}.grapim-tmp`;
    // A file or link already at the temp name (a hooks dir inside a cloned
    // repo can hold one) is removed, never written through: 'wx' fails rather
    // than follow a link to somewhere else.
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, hookScript(name, bin), { mode: 0o755, flag: 'wx' });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o755);
    } catch {}
    out.hooks.push(file);
  }
  // Notes follow their commits through --amend and rebase.
  const refs = process.env.GIT_NOTES_REWRITE_REF ? [] : configGet(root, 'notes.rewriteRef', { all: true });
  if (!refs.includes(NOTE_REF)) setConfig(root, ['--add', 'notes.rewriteRef', NOTE_REF]);
  setConfig(root, ['notes.rewrite.amend', 'true']);
  setConfig(root, ['notes.rewrite.rebase', 'true']);
  if (intents === false) setConfig(root, ['grapim.notes.intents', 'false']);
  out.intents = configGet(root, 'grapim.notes.intents', { bool: true }) !== 'false';
  return out;
}
