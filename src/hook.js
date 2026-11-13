// The hook handler for every agent with native hooks. The agent pipes one JSON
// object to `grapim hook [--from codex|cursor|gemini]` on stdin; we answer
// with an exit code, plus stderr or stdout. Each agent's payload is first
// read into the Claude Code shape (research/cli-release-2026-11.md has the
// sources for each field):
//
//   SessionStart / UserPromptSubmit: record the agent (and its intent: the
//     latest prompt) and tell it which files other agents hold right now.
//     Each prompt starts a new turn of the run.
//   PreToolUse (a file edit): claim the file. If another agent holds it, exit
//     2 so the agent blocks the edit and is told why. If the edit is allowed,
//     snapshot the file as it is before the edit.
//   PostToolUse: snapshot the file after the edit and record the change in the
//     ledger, then log it. In warn mode, this is where we warn instead.
//   PreToolUse / PostToolUse (PostToolUseFailure too) on the shell tool:
//     snapshot the worktree before the command and record every file it
//     changed after it (src/shell.js). Never blocks the command.
//   SessionEnd: release everything this session held.
//
//   Claude Code  as above; edits are Edit, Write, MultiEdit, NotebookEdit;
//                the shell is Bash.
//   Codex CLI    the same events and fields; edits are apply_patch, whose
//                patch text (tool_input.command) names the files; the shell
//                is Bash.
//   Gemini CLI   BeforeAgent, BeforeTool and AfterTool for the prompt and
//                write_file / replace, and run_shell_command. stdout must be
//                JSON only.
//   Cursor       beforeSubmitPrompt, sessionEnd, and afterFileEdit, which
//                comes after the edit with the edits made: the file as it was
//                before is worked out by undoing them (reverseEdits). Cursor
//                is not blocked from here; a clash is reported, not stopped.
//                Its shell commands are compared from the prompt (or the
//                previous command) to afterShellExecution: see cursorShell.
//
// Ledger failures are written to stderr and never block the edit.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_TTL_MS, Store } from './store.js';
import { fileKey, resolveWorkspace, rootKey } from './workspace.js';
import { ago, othersText, who } from './format.js';
import { beginEdit, beginEditFrom, failOpen, finishEdit } from './ledger.js';
import { hasGitHooks } from './provenance/hooks.js';
import { MODEL_RE, VERSION_RE } from './inventory.js';
import { beginShell, commandText, finishShell } from './shell.js';

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const GEMINI_EDIT_TOOLS = new Set(['write_file', 'replace']);
export const SOURCES = Object.freeze(['claude', 'codex', 'cursor', 'gemini']);
// The shell tool of each agent (Codex documents its shell as Bash; the other
// names are older Codex ones, harmless when they never come).
const SHELL_TOOLS = {
  claude: new Set(['Bash']),
  codex: new Set(['Bash', 'shell', 'local_shell', 'exec_command']),
  gemini: new Set(['run_shell_command']),
};

// \\server\share\…, //server/share/… and \\?\… device paths (Windows only).
const isNetworkPath = (p) => process.platform === 'win32' && /^[\\/]{2}/.test(p);
const rootOf = (p) => path.parse(p).root.toLowerCase();

// Run id prefix and label word per agent. The prefix decides the agent kind
// in provenance notes (kindOf in src/provenance/note.js).
const IDS = {
  claude: ['claude-code', 'claude'],
  codex: ['codex', 'codex'],
  cursor: ['cursor', 'cursor'],
  gemini: ['gemini', 'gemini'],
};

function agentOf(sessionId, from = 'claude') {
  const id = String(sessionId || 'unknown');
  const short = /^[0-9a-f]{8}/i.test(id) ? id.slice(0, 8).toLowerCase() : crypto.createHash('sha1').update(id).digest('hex').slice(0, 8);
  const [prefix, word] = IDS[from] ?? IDS.claude;
  return { agent: `${prefix}:${id}`, label: `${word} ${short}` };
}

function ttlMs(env) {
  const m = Number(env.GRAPIM_TTL_MINUTES);
  return m > 0 ? m * 60 * 1000 : DEFAULT_TTL_MS;
}

function firstLine(s, n = 140) {
  const line = String(s ?? '').trim().split(/\r?\n/).find((l) => l.trim()) ?? '';
  return line.length > n ? line.slice(0, n - 1) + '…' : line;
}

// The files a Codex apply_patch touches: Add, Update, Delete and Move to.
export function patchFiles(patch) {
  const text = Array.isArray(patch) ? patch.filter((x) => typeof x === 'string').join('\n') : typeof patch === 'string' ? patch : '';
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// A Windows path written /c:/Users/...: drop the leading slash.
function osPath(p) {
  const s = String(p);
  return process.platform === 'win32' && /^\/[a-zA-Z]:[\\/]/.test(s) ? s.slice(1) : s;
}

// Each agent's payload in one shape: { ev, cwd, session, prompt, files, id,
// edits }. files: the paths a tool call edits ([] for any other tool).
function normalize(input, from, env) {
  return { ...normalizeEvent(input, from, env), ...modelOf(input, from) };
}

// The model and agent version a payload names, when it does (Cursor sends
// both; Claude Code and Codex send the model on some events). Kept for the
// agent inventory only if they look like a model name or a version.
function modelOf(input, from) {
  const model = typeof input.model === 'string' && MODEL_RE.test(input.model) ? input.model : null;
  const v = from === 'cursor' ? input.cursor_version : null;
  return { model, version: typeof v === 'string' && VERSION_RE.test(v) ? v : null };
}

function normalizeEvent(input, from, env) {
  if (from === 'cursor') {
    const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
    const cwd = input.cwd || (roots[0] ? osPath(roots[0]) : null) || env.CURSOR_PROJECT_DIR || process.cwd();
    const ev = { beforeSubmitPrompt: 'UserPromptSubmit', afterFileEdit: 'FileEdited', afterShellExecution: 'ShellDone', sessionEnd: 'SessionEnd' }[input.hook_event_name] ?? null;
    const files = input.file_path ? [osPath(input.file_path)] : [];
    const shell = ev === 'ShellDone' ? { command: input.command ?? '', dir: cwd } : null;
    return { ev, cwd, session: input.conversation_id || input.session_id, prompt: input.prompt, files, id: null, edits: input.edits, shell };
  }
  const base = { cwd: input.cwd || process.cwd(), session: input.session_id, prompt: input.prompt, id: input.tool_use_id ?? null };
  const filePath = input.tool_input?.file_path || input.tool_input?.notebook_path;
  // A shell command: { command, dir } (Gemini's dir_path is where it runs).
  const shell = SHELL_TOOLS[from]?.has(input.tool_name)
    ? { command: input.tool_input?.command ?? '', dir: typeof input.tool_input?.dir_path === 'string' && input.tool_input.dir_path ? path.resolve(base.cwd, input.tool_input.dir_path) : base.cwd }
    : null;
  if (from === 'gemini') {
    const ev = { BeforeAgent: 'UserPromptSubmit', BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse' }[input.hook_event_name] ?? input.hook_event_name;
    return { ...base, ev, shell, files: GEMINI_EDIT_TOOLS.has(input.tool_name) && filePath ? [filePath] : [] };
  }
  let files = [];
  if (from === 'codex' && input.tool_name === 'apply_patch') files = patchFiles(input.tool_input?.command ?? input.tool_input?.patch ?? input.tool_input?.input);
  else if (EDIT_TOOLS.has(input.tool_name) && filePath) files = [filePath];
  return { ...base, ev: input.hook_event_name, shell, files };
}

// The holder's worktree is named only when it is not the one being edited in.
function blockedMessage(file, c, now, worktree) {
  return [
    `Grapim: ${file} is claimed by another agent, ${who(c)}${c.worktree && c.worktree !== worktree ? ` in worktree ${c.worktree}` : ''}, ${ago(now - c.acquired_at)} ago${c.intent ? `, working on: "${c.intent}"` : ''}.`,
    'Editing it now would collide with their work, so this edit was not applied.',
    'Work on other files first and come back to this one later, or tell the user which file is busy and who has it.',
  ].join('\n');
}

// The Claude Code plugin cannot install git hooks, so a session in a git repo
// without Grapim's post-commit hook gets one line saying how to turn commit
// provenance on. Nothing is installed from here.
function initHint(ws, env) {
  if (!ws.isGit || env.GRAPIM_NO_INIT_HINT === '1') return '';
  try {
    if (hasGitHooks(ws.root)) return '';
  } catch {
    return '';
  }
  return 'Grapim: commits in this repo do not record which lines AI agents wrote yet. If the user wants commit provenance (git notes, shown in pull requests), they can run `grapim init` in the repo.\n';
}

// The file before a Cursor edit, from the file after it and the edits made
// ({ old_string, new_string }, in order). { ok: true, before: Buffer, or null
// when the edit created the file } or { ok: false } when that cannot be told
// for sure: a replacement not found exactly once, or bytes that are not UTF-8.
export function reverseEdits(after, edits) {
  if (!Array.isArray(edits) || !edits.length || !Buffer.isBuffer(after)) return { ok: false };
  let s = after.toString('utf8');
  if (!Buffer.from(s, 'utf8').equals(after)) return { ok: false };
  if (edits.length === 1 && !edits[0]?.old_string && String(edits[0]?.new_string ?? '') === s) return { ok: true, before: null };
  const crlf = s.includes('\r\n');
  for (let i = edits.length - 1; i >= 0; i--) {
    let o = String(edits[i]?.old_string ?? '');
    let n = String(edits[i]?.new_string ?? '');
    if (o === n) continue;
    if (!n) return { ok: false };
    let at = s.indexOf(n);
    if (at < 0 && crlf) {
      n = n.replace(/\r?\n/g, '\r\n');
      o = o.replace(/\r?\n/g, '\r\n');
      at = s.indexOf(n);
    }
    if (at < 0 || s.indexOf(n, at + 1) >= 0) return { ok: false };
    s = s.slice(0, at) + o + s.slice(at + n.length);
  }
  return { ok: true, before: Buffer.from(s, 'utf8') };
}

function readFile(abs) {
  try {
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}

// One file of a tool call: { abs, ws, f }, or null when it is outside any
// repo or on a network share the session is not on.
function target(cwd, p) {
  const abs = path.resolve(cwd, String(p));
  // A network path (\\host\share) on another share than the session's: even
  // looking at it would send this user's Windows credentials to that host.
  if (isNetworkPath(abs) && rootOf(abs) !== rootOf(path.resolve(cwd))) return null;
  const ws = resolveWorkspace(path.dirname(abs));
  const f = fileKey(ws, abs);
  return f ? { abs, ws, f } : null;
}

function withStore(ws, now, fn) {
  const store = new Store(ws.stateDir, { now });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

// What each agent can read back. Gemini CLI parses stdout as JSON and nothing
// else; Cursor's beforeSubmitPrompt answers { continue }.
function shape(r, from, ev) {
  if (from === 'gemini') return r.code === 0 ? { code: 0, stdout: '{}\n', stderr: r.stderr } : { code: r.code, stderr: r.stderr };
  if (from === 'cursor') {
    if (ev === 'UserPromptSubmit') return { code: 0, stdout: '{"continue":true}\n' };
    return { code: 0, stderr: r.stderr };
  }
  return r;
}

export function runHook(input, env = process.env, now = () => Date.now(), from = 'claude') {
  const n = normalize(input, from, env);
  return shape(handle(n, from, env, now), from, n.ev);
}

function handle(n, from, env, now) {
  const { ev, cwd } = n;
  const { agent, label } = agentOf(n.session, from);
  const mode = env.GRAPIM_MODE === 'warn' ? 'warn' : 'block';

  if (ev === 'SessionStart' || ev === 'UserPromptSubmit') {
    const ws = resolveWorkspace(cwd);
    return withStore(ws, now, (store) => {
      // The hooks may be installed twice (the plugin and `grapim init`), so the
      // same prompt can arrive twice in a row: count it as one turn.
      const intent = n.prompt ? firstLine(n.prompt) : null;
      const prev = store.db.prepare('SELECT intent, last_seen FROM agents WHERE agent = ?').get(agent);
      const duplicate = ev === 'UserPromptSubmit' && intent !== null && prev?.intent === intent && now() - prev.last_seen < 5000;
      if (ev === 'UserPromptSubmit' && intent !== null && !duplicate) store.setIntent(agent, intent, { label, worktree: ws.worktree });
      else store.touch(agent, { label, worktree: ws.worktree });
      if (ev === 'UserPromptSubmit' && !duplicate) failOpen('start a new turn', () => store.nextTurn(agent));
      // Cursor: open the shell window its next command closes (cursorShell).
      if (from === 'cursor' && ev === 'UserPromptSubmit' && ws.isGit) failOpen('snapshot the worktree for shell commands', () => openCursorWindow(store, agent, label, ws, now, env));
      try {
        if (n.model) store.noteSeen(from, 'model', n.model);
        if (n.version) store.noteSeen(from, 'version', n.version);
      } catch {} // the inventory is never worth a failed prompt
      const others = othersText(store, agent);
      const hint = ev === 'SessionStart' ? initHint(ws, env) : '';
      if (!others) return hint ? { code: 0, stdout: hint } : { code: 0 };
      return {
        code: 0,
        stdout: `${hint}Grapim: other agents are working in this repo right now. Leave these files alone unless the user says otherwise:\n${others}\n`,
      };
    });
  }

  if (n.shell && (ev === 'PreToolUse' || ev === 'PostToolUse' || ev === 'PostToolUseFailure')) return shellHook(n, ev, agent, label, now, env);
  if (ev === 'ShellDone' && n.shell) return cursorShell(n, agent, label, now, env);

  if (ev === 'PreToolUse' || ev === 'PostToolUse') {
    const targets = n.files.map((p) => target(cwd, p)).filter(Boolean);
    if (!targets.length) return { code: 0 };
    // One pending snapshot per file: a patch over several files needs an id each.
    const idOf = (t) => (n.id && (targets.length > 1 || from === 'codex') ? `${n.id}:${t.f.key}` : n.id);
    const edit = (t) => ({ run: agent, label, ws: t.ws, file: t.f, id: idOf(t) });
    if (ev === 'PreToolUse') {
      if (mode !== 'warn') {
        for (const t of targets) {
          const r = withStore(t.ws, now, (store) => store.claim(agent, [t.f], { ttlMs: ttlMs(env), worktree: t.ws.worktree, label }));
          if (!r.ok) return { code: 2, stderr: blockedMessage(t.f.display, r.conflicts[0], now(), t.ws.worktree) + '\n' };
        }
      }
      // The edit is allowed: keep each file as it is now, to attribute the change.
      for (const t of targets) withStore(t.ws, now, (store) => failOpen('snapshot the file before the edit', () => beginEdit(store, edit(t))));
      return { code: 0 };
    }
    // PostToolUse
    const warnings = [];
    for (const t of targets) {
      withStore(t.ws, now, (store) => {
        const detail = failOpen('record the edit', () => finishEdit(store, edit(t)))?.detail ?? null;
        if (mode !== 'warn') return store.recordEdit(agent, t.f.display, detail);
        const r = store.claim(agent, [t.f], { ttlMs: ttlMs(env), worktree: t.ws.worktree, label });
        store.recordEdit(agent, t.f.display, detail);
        if (!r.ok) {
          const c = r.conflicts[0];
          warnings.push(
            `Grapim warning: you just edited ${t.f.display}, which ${who(c)}${c.worktree ? ` (worktree ${c.worktree})` : ''} has claimed${c.intent ? ` for "${c.intent}"` : ''}. Your change and theirs may conflict. Tell the user.\n`,
          );
        }
      });
    }
    return warnings.length ? { code: 2, stderr: warnings.join('') } : { code: 0 };
  }

  if (ev === 'FileEdited') {
    // Cursor: the edit has happened. Work out the file before it, then record.
    const t = n.files.length ? target(cwd, n.files[0]) : null;
    if (!t) return { code: 0 };
    return withStore(t.ws, now, (store) => {
      const r = store.claim(agent, [t.f], { ttlMs: ttlMs(env), worktree: t.ws.worktree, label });
      const back = reverseEdits(readFile(t.abs), n.edits);
      let detail = null;
      if (back.ok) {
        const edit = { run: agent, label, ws: t.ws, file: t.f, id: null };
        failOpen('snapshot the file before the edit', () => beginEditFrom(store, edit, back.before));
        detail = failOpen('record the edit', () => finishEdit(store, edit))?.detail ?? null;
      }
      store.recordEdit(agent, t.f.display, detail);
      const notes = [];
      if (!back.ok) notes.push(`grapim: could not tell what ${t.f.display} held before this edit, so its lines are not attributed (the edit is logged).\n`);
      if (!r.ok) {
        const c = r.conflicts[0];
        notes.push(`Grapim warning: ${t.f.display} was edited while ${who(c)} has it claimed${c.intent ? ` for "${c.intent}"` : ''}.\n`);
      }
      return notes.length ? { code: 0, stderr: notes.join('') } : { code: 0 };
    });
  }

  if (ev === 'SessionEnd') {
    const ws = resolveWorkspace(cwd);
    withStore(ws, now, (store) => {
      store.endSession(agent);
      // A snapshot still pending here belongs to an edit that failed: drop it.
      failOpen('clear pending snapshots', () => store.dropPending({ run: agent }));
      failOpen('clear shell snapshots', () => store.dropShell(agent));
    });
    return { code: 0 };
  }

  return { code: 0 };
}

// Cursor has no hook before a shell command that can stay silent
// (beforeShellExecution must answer allow, deny or ask, and "allow" would skip
// Cursor's own approval). So the window a command is compared against is
// opened earlier: at the prompt, and again after each command. The command
// itself is told by afterShellExecution, which only reports. Files a person
// changes in that time are credited to the run too; edits Cursor's own edit
// tool made in it are recorded already and not counted again.
function openCursorWindow(store, agent, label, ws, now, env) {
  store.dropShell(agent);
  return beginShell(store, { id: `shell:${agent}:${now()}`, run: agent, label, ws, command: '', env });
}

function cursorShell(n, agent, label, now, env) {
  const ws = resolveWorkspace(n.shell.dir);
  if (!ws.isGit) return { code: 0 };
  return withStore(ws, now, (store) => {
    const notes = [];
    const w = store.shellWindow(null, agent, rootKey(ws.root));
    if (w) {
      failOpen('name the shell command', () => store.db.prepare('UPDATE shell_windows SET command = ? WHERE id = ?').run(commandText(n.shell.command), w.id));
      const r = failOpen('record the shell command', () => finishShell(store, { id: null, run: agent, ws }));
      if (r) {
        for (const c of r.changes) store.recordEdit(agent, c.path, `${c.detail} via shell: ${r.via}`);
        if (r.note) notes.push(r.note);
      }
    }
    const o = failOpen('snapshot the worktree for the next shell command', () => openCursorWindow(store, agent, label, ws, now, env));
    if (o?.note) notes.push(o.note);
    return notes.length ? { code: 0, stderr: notes.join('') } : { code: 0 };
  });
}

// A shell command (src/shell.js). Never blocks: whatever fails, the command
// runs and the reason goes to stderr. Only a git worktree is covered.
function shellHook(n, ev, agent, label, now, env) {
  const ws = resolveWorkspace(n.shell.dir);
  if (!ws.isGit) return { code: 0 };
  const id = n.id ? `shell:${n.id}` : `shell:${agent}:${now()}`;
  return withStore(ws, now, (store) => {
    if (ev === 'PreToolUse') {
      const r = failOpen('snapshot the worktree before the shell command', () => beginShell(store, { id, run: agent, label, ws, command: n.shell.command, env }));
      return r?.note ? { code: 0, stderr: r.note } : { code: 0 };
    }
    const r = failOpen('record the shell command', () => finishShell(store, { id: n.id ? id : null, run: agent, ws }));
    if (!r) return { code: 0 };
    for (const c of r.changes) store.recordEdit(agent, c.path, `${c.detail} via shell: ${r.via}`);
    return r.note ? { code: 0, stderr: r.note } : { code: 0 };
  });
}
