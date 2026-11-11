// Claude Code hook handler. Claude Code pipes one JSON object to `grapim hook`
// on stdin; we answer with an exit code, plus stderr or stdout.
//
//   SessionStart / UserPromptSubmit: record the agent (and its intent: the
//     latest prompt) and tell it which files other agents hold right now.
//     Each prompt starts a new turn of the run.
//   PreToolUse (Edit/Write/MultiEdit/NotebookEdit): claim the file. If another
//     agent holds it, exit 2 so Claude Code blocks the edit and shows Claude why.
//     If the edit is allowed, snapshot the file as it is before the edit.
//   PostToolUse: snapshot the file after the edit and record the change in the
//     ledger, then log it. In warn mode, this is where we warn instead.
//   SessionEnd: release everything this session held.
//
// Ledger failures are written to stderr and never block the edit.

import path from 'node:path';
import { DEFAULT_TTL_MS, Store } from './store.js';
import { fileKey, resolveWorkspace } from './workspace.js';
import { ago, othersText, who } from './format.js';
import { beginEdit, failOpen, finishEdit } from './ledger.js';

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// \\server\share\…, //server/share/… and \\?\… device paths (Windows only).
const isNetworkPath = (p) => process.platform === 'win32' && /^[\\/]{2}/.test(p);
const rootOf = (p) => path.parse(p).root.toLowerCase();

function agentOf(input) {
  const id = String(input.session_id || 'unknown');
  return { agent: `claude-code:${id}`, label: `claude ${id.slice(0, 8)}` };
}

function ttlMs(env) {
  const m = Number(env.GRAPIM_TTL_MINUTES);
  return m > 0 ? m * 60 * 1000 : DEFAULT_TTL_MS;
}

function firstLine(s, n = 140) {
  const line = String(s ?? '').trim().split(/\r?\n/).find((l) => l.trim()) ?? '';
  return line.length > n ? line.slice(0, n - 1) + '…' : line;
}

// The holder's worktree is named only when it is not the one being edited in.
function blockedMessage(file, c, now, worktree) {
  return [
    `Grapim: ${file} is claimed by another agent, ${who(c)}${c.worktree && c.worktree !== worktree ? ` in worktree ${c.worktree}` : ''}, ${ago(now - c.acquired_at)} ago${c.intent ? `, working on: "${c.intent}"` : ''}.`,
    'Editing it now would collide with their work, so this edit was not applied.',
    'Work on other files first and come back to this one later, or tell the user which file is busy and who has it.',
  ].join('\n');
}

export function runHook(input, env = process.env, now = () => Date.now()) {
  const ev = input.hook_event_name;
  const cwd = input.cwd || process.cwd();
  const { agent, label } = agentOf(input);
  const mode = env.GRAPIM_MODE === 'warn' ? 'warn' : 'block';

  if (ev === 'SessionStart' || ev === 'UserPromptSubmit') {
    const ws = resolveWorkspace(cwd);
    const store = new Store(ws.stateDir, { now });
    try {
      if (ev === 'UserPromptSubmit' && input.prompt) store.setIntent(agent, firstLine(input.prompt), { label, worktree: ws.worktree });
      else store.touch(agent, { label, worktree: ws.worktree });
      if (ev === 'UserPromptSubmit') failOpen('start a new turn', () => store.nextTurn(agent));
      const others = othersText(store, agent);
      if (!others) return { code: 0 };
      return {
        code: 0,
        stdout: `Grapim: other agents are working in this repo right now. Leave these files alone unless the user says otherwise:\n${others}\n`,
      };
    } finally {
      store.close();
    }
  }

  if (ev === 'PreToolUse' || ev === 'PostToolUse') {
    if (!EDIT_TOOLS.has(input.tool_name)) return { code: 0 };
    const target = input.tool_input?.file_path || input.tool_input?.notebook_path;
    if (!target) return { code: 0 };
    const abs = path.resolve(cwd, String(target));
    // A network path (\\host\share) on another share than the session's: even
    // looking at it would send this user's Windows credentials to that host.
    if (isNetworkPath(abs) && rootOf(abs) !== rootOf(path.resolve(cwd))) return { code: 0 };
    const ws = resolveWorkspace(path.dirname(abs));
    const f = fileKey(ws, abs);
    if (!f) return { code: 0 };
    const store = new Store(ws.stateDir, { now });
    const edit = { run: agent, label, ws, file: f, id: input.tool_use_id };
    try {
      if (ev === 'PreToolUse') {
        if (mode !== 'warn') {
          const r = store.claim(agent, [f], { ttlMs: ttlMs(env), worktree: ws.worktree, label });
          if (!r.ok) return { code: 2, stderr: blockedMessage(f.display, r.conflicts[0], now(), ws.worktree) + '\n' };
        }
        // The edit is allowed: keep the file as it is now, to attribute the change.
        failOpen('snapshot the file before the edit', () => beginEdit(store, edit));
        return { code: 0 };
      }
      // PostToolUse
      const detail = failOpen('record the edit', () => finishEdit(store, edit))?.detail ?? null;
      if (mode === 'warn') {
        const r = store.claim(agent, [f], { ttlMs: ttlMs(env), worktree: ws.worktree, label });
        store.recordEdit(agent, f.display, detail);
        if (!r.ok) {
          const c = r.conflicts[0];
          return {
            code: 2,
            stderr: `Grapim warning: you just edited ${f.display}, which ${who(c)}${c.worktree ? ` (worktree ${c.worktree})` : ''} has claimed${c.intent ? ` for "${c.intent}"` : ''}. Your change and theirs may conflict. Tell the user.\n`,
          };
        }
        return { code: 0 };
      }
      store.recordEdit(agent, f.display, detail);
      return { code: 0 };
    } finally {
      store.close();
    }
  }

  if (ev === 'SessionEnd') {
    const ws = resolveWorkspace(cwd);
    const store = new Store(ws.stateDir, { now });
    try {
      store.endSession(agent);
      // A snapshot still pending here belongs to an edit that failed: drop it.
      failOpen('clear pending snapshots', () => store.dropPending({ run: agent }));
    } finally {
      store.close();
    }
    return { code: 0 };
  }

  return { code: 0 };
}
