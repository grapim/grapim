// The coding agents `grapim init` sets up, and how.
//
// Each agent that has native hooks gets them, so every edit is recorded
// without the agent having to cooperate (research/cli-release-2026-11.md):
//
//   Claude Code  .claude/settings.local.json  SessionStart, UserPromptSubmit,
//                PreToolUse + PostToolUse (Edit|Write|MultiEdit|NotebookEdit|Bash),
//                PostToolUseFailure (Bash), SessionEnd
//   Codex CLI    .codex/hooks.json            the same events (no PostToolUseFailure);
//                edits arrive as apply_patch, shell commands as Bash.
//                Codex runs project hooks only once the user trusts them (/hooks).
//   Cursor       .cursor/hooks.json           beforeSubmitPrompt, afterFileEdit, afterShellExecution, sessionEnd
//   Gemini CLI   .gemini/settings.json        SessionStart, BeforeAgent,
//                BeforeTool + AfterTool (write_file|replace|run_shell_command), SessionEnd
//   Shell commands (Bash, run_shell_command) are recorded by comparing the
//   worktree before and after them (src/shell.js). Cursor's are compared from
//   the prompt or the previous command to afterShellExecution.
//
// Existing config is merged, never replaced: other hooks and settings stay,
// and our own entries are found by their command and rewritten in place, so a
// second init changes nothing. A file that is not valid JSON is left alone.
// A file init creates in a git repo is added to .git/info/exclude: it holds a
// path on this machine, which means nothing on a teammate's.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tryGit } from './provenance/git.js';

export const AGENTS = Object.freeze(['claude', 'codex', 'cursor', 'gemini']);

export const NAMES = Object.freeze({ claude: 'Claude Code', codex: 'Codex CLI', cursor: 'Cursor', gemini: 'Gemini CLI' });

const CLAUDE_EDITS = 'Edit|Write|MultiEdit|NotebookEdit|Bash';
const CODEX_EDITS = 'apply_patch|Edit|Write|Bash';
const GEMINI_EDITS = 'write_file|replace|run_shell_command';

// Where each agent leaves a trace: in the repo, then in the home directory.
const TRACES = {
  claude: { repo: ['.claude', 'CLAUDE.md'], home: ['.claude'] },
  codex: { repo: ['.codex'], home: ['.codex'] },
  cursor: { repo: ['.cursor', '.cursorrules'], home: ['.cursor'] },
  gemini: { repo: ['.gemini', 'GEMINI.md'], home: ['.gemini'] },
};

// { claude: 'found .claude in this repo' | 'found ~/.cursor' | null, ... }
export function detectAgents(root, { home = os.homedir() } = {}) {
  const out = {};
  for (const id of AGENTS) {
    const inRepo = TRACES[id].repo.find((n) => fs.existsSync(path.join(root, n)));
    const inHome = !inRepo && home ? TRACES[id].home.find((n) => fs.existsSync(path.join(home, n))) : null;
    out[id] = inRepo ? `found ${inRepo} in this repo` : inHome ? `found ~/${inHome}` : null;
  }
  return out;
}

// "claude,cursor" or "all" to a list of ids; throws on an unknown name.
export function parseAgentList(s) {
  const alias = { 'claude-code': 'claude', claudecode: 'claude', 'gemini-cli': 'gemini', 'codex-cli': 'codex' };
  const ids = String(s)
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .flatMap((x) => (x === 'all' ? AGENTS : [alias[x] ?? x]));
  const bad = ids.filter((x) => !AGENTS.includes(x));
  if (bad.length || !ids.length) throw new Error(`Unknown agent${bad.length > 1 ? 's' : ''}: ${bad.join(', ') || '(none)'}. Choose from ${AGENTS.join(', ')}, or all.`);
  return [...new Set(ids)];
}

export class ConfigError extends Error {}

function readJson(file) {
  if (!fs.existsSync(file)) return { data: {}, existed: false, raw: null };
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return { data: {}, existed: true, raw };
  let data;
  try {
    data = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON (${err.message}). Nothing was changed: fix it, then run grapim init again.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ConfigError(`${file} does not hold a JSON object. Nothing was changed.`);
  return { data, existed: true, raw };
}

// Writes only when the content changes. Returns true if it wrote.
function writeJson(file, data, raw) {
  const text = JSON.stringify(data, null, 2) + '\n';
  if (raw !== null && raw.replace(/\r\n/g, '\n') === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

// Our hook entry, whatever path or agent flag it was written with.
const OURS = /grapim(\.js)?["']?\s+hook(\s+--from\s+[a-z]+)?\s*$/;
export const isOurs = (h) => typeof h?.command === 'string' && OURS.test(h.command);

export const hookCommand = (bin, from) => `node "${bin}" hook${from ? ` --from ${from}` : ''}`;

// Claude Code, Codex and Gemini: hooks.<Event> = [{ matcher?, hooks: [entry] }].
function mergeGrouped(hooks, want, entry) {
  for (const [event, matcher] of Object.entries(want)) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    const groups = list
      .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
      .filter((g) => !g || !Array.isArray(g.hooks) || g.hooks.length);
    groups.push({ ...(matcher ? { matcher } : {}), hooks: [entry] });
    hooks[event] = groups;
  }
}

// Cursor: hooks.<event> = [entry, ...].
function mergeFlat(hooks, events, entry) {
  for (const event of events) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...list.filter((h) => !isOurs(h)), entry];
  }
}

const SETUPS = {
  claude: {
    file: path.join('.claude', 'settings.local.json'),
    apply(data, bin) {
      data.hooks = data.hooks && typeof data.hooks === 'object' ? data.hooks : {};
      const entry = { type: 'command', command: hookCommand(bin), timeout: 20 };
      mergeGrouped(data.hooks, { SessionStart: null, UserPromptSubmit: null, PreToolUse: CLAUDE_EDITS, PostToolUse: CLAUDE_EDITS, PostToolUseFailure: 'Bash', SessionEnd: null }, entry);
    },
  },
  codex: {
    file: path.join('.codex', 'hooks.json'),
    note: 'In Codex, run /hooks once and trust them.',
    apply(data, bin) {
      data.hooks = data.hooks && typeof data.hooks === 'object' ? data.hooks : {};
      const entry = { type: 'command', command: hookCommand(bin, 'codex'), timeout: 20 };
      mergeGrouped(data.hooks, { SessionStart: null, UserPromptSubmit: null, PreToolUse: CODEX_EDITS, PostToolUse: CODEX_EDITS }, entry);
      // Codex caps SessionEnd hooks at 3 seconds.
      mergeGrouped(data.hooks, { SessionEnd: null }, { ...entry, timeout: 3 });
    },
  },
  cursor: {
    file: path.join('.cursor', 'hooks.json'),
    apply(data, bin) {
      if (!Number.isInteger(data.version)) data.version = 1;
      data.hooks = data.hooks && typeof data.hooks === 'object' ? data.hooks : {};
      mergeFlat(data.hooks, ['beforeSubmitPrompt', 'afterFileEdit', 'afterShellExecution', 'sessionEnd'], { command: hookCommand(bin, 'cursor'), timeout: 20 });
    },
  },
  gemini: {
    file: path.join('.gemini', 'settings.json'),
    apply(data, bin) {
      data.hooks = data.hooks && typeof data.hooks === 'object' ? data.hooks : {};
      // Gemini CLI timeouts are in milliseconds.
      const entry = { name: 'grapim', type: 'command', command: hookCommand(bin, 'gemini'), timeout: 20000 };
      mergeGrouped(data.hooks, { SessionStart: null, BeforeAgent: null, BeforeTool: GEMINI_EDITS, AfterTool: GEMINI_EDITS, SessionEnd: null }, entry);
    },
  },
};

export const configFile = (id) => SETUPS[id].file;

// 'tracked' (committed: our change shows in git status), 'ignored', or, for a
// file init has just created, 'excluded': kept out of git status through
// .git/info/exclude, without touching .gitignore. A file the user made
// themselves is never excluded (null).
function gitState(root, rel, created) {
  const posix = rel.split(path.sep).join('/');
  if (tryGit(root, ['ls-files', '--error-unmatch', '--', posix]) !== null) return 'tracked';
  if (tryGit(root, ['check-ignore', '-q', '--', posix]) !== null) return 'ignored';
  if (!created) return null;
  const out = tryGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'])?.trim();
  if (!out) return null;
  const line = `/${posix}`;
  const now = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (now.split(/\r?\n/).includes(line)) return 'excluded';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.appendFileSync(out, `${now && !now.endsWith('\n') ? '\n' : ''}# grapim init: holds a path on this machine\n${line}\n`);
  return 'excluded';
}

// Sets one agent up in a repo. Returns { id, file, changed, created, git }.
export function setupAgent(id, root, { bin, isGit = false } = {}) {
  const s = SETUPS[id];
  const file = path.join(root, s.file);
  const { data, existed, raw } = readJson(file);
  s.apply(data, bin);
  const changed = writeJson(file, data, raw);
  const git = isGit ? gitState(root, s.file, !existed) : null;
  return { id, file, rel: s.file.split(path.sep).join('/'), changed, created: !existed, git, note: s.note ?? null };
}

// Kept for callers of the old API: the Claude Code hooks only.
export function installHooks(root, bin) {
  return setupAgent('claude', root, { bin }).file;
}
