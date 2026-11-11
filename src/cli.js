import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { fileKey, resolveWorkspace } from './workspace.js';
import { ago, blameText, logText, restoreText, runsText, statusText, undoText, who } from './format.js';
import { runHook } from './hook.js';

// Loaded on demand, so the hook (run on every edit) starts as fast as it can.
const attribution = () => import('./attribution.js');
const undo = () => import('./undo.js');
const review = () => import('./review.js');
const restore = () => import('./restore.js');

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'grapim.js').split(path.sep).join('/');

// Text from agents (labels, intents, notes, paths, file lines) goes to a
// terminal: control characters are replaced, so an escape sequence in an
// intent cannot repaint the screen, set the clipboard (OSC 52) or hide text.
// Newlines, tabs and CRLF stay.
export const term = (s) => String(s).replace(/\r(?!\n)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '�');

const HELP = `grapim: lets many coding agents work in one repo without overwriting each other.

  grapim init [--no-intents]  install the Claude Code hooks in this repo (.claude/settings.local.json)
                               and, in a git repo, the post-commit and pre-push hooks that keep AI
                               provenance as git notes (--no-intents: notes without prompts)
  grapim status [--watch]     who is active, what they are doing, which files they hold
  grapim log [-n 30]          recent claims, edits (+/- lines), blocks and undos
  grapim claim <files..> [--intent "..."] [--ttl 30]
  grapim release [files..]    release files (all of yours if none given)
  grapim intent "<text>"      say what you are working on

  grapim runs                 every agent run: intent, turns, files, +/- lines, still in the tree?
  grapim blame <file>         which run and turn wrote each line that differs from HEAD
  grapim blame <file> --history
                               every line, committed or not: agent run, turn and prompt, or human
  grapim provenance record [<commit>] | show [<commit>] | stats [<rev-range>] | push [<remote>]
                               AI provenance notes (refs/notes/grapim): write one for a commit,
                               print one, AI share per agent and file, push the notes
  grapim undo <run> [--turn N] [--yes]
                               remove one run's (or one turn's) changes, keep everyone else's.
                               <run> is a run id, label or session id prefix. Without --yes it
                               only prints the plan. Needs git (for git merge-file).
  grapim restore <file> <sha> [--yes]
                               put a file back to a version from its history (a sha prefix
                               from /api/files/history or the desk). Without --yes it only
                               prints the plan. Recorded as its own run, so it can be undone
  grapim branch <run>         put one run's changes on a new git branch (grapim/<label>) from
                               HEAD, without touching your working tree, index or HEAD
  grapim review <run> --approve|--reject|--pending [--note "..."]
                               mark a run reviewed (without a flag, show its review)
  (runs, blame, undo, restore, branch and review take --json)
  grapim mcp                  run the MCP server (for Codex, Cursor and other agents)
  grapim serve [--port 7420] [--host 127.0.0.1] [--open]
                               the review desk, JSON API, agent workspace (/fs) and MCP over
                               HTTP (/mcp). A --host other than loopback needs $GRAPIM_TOKEN
  grapim sync --hub <url> [--token <t>] [--watch]
                               push this repo's runs, changes and events to a team hub
                               (token from --token or $GRAPIM_HUB_TOKEN)
  grapim hub                  run the team hub server (configured from env, see .env.example)
  grapim folder <workspace-url> <dir> [--watch] [--once] [--force] [--token-env NAME]
                               keep a local folder and a workspace in sync both ways (token from
                               $GRAPIM_WORKSPACE_TOKEN; edits on both sides merge or keep both)
  grapim mount <workspace-url> [drive-letter | mount-point]
                               the workspace as a network drive (WebDAV): on Windows with a
                               letter it runs net use, elsewhere it prints the steps (token
                               from $GRAPIM_WORKSPACE_TOKEN, never the command line)
  grapim provenance pr <base>..<head> [--json]
                               the AI provenance summary a pull request gets (git blame + notes)
  grapim hook                 Claude Code hook entry point (reads JSON on stdin)

  --agent <name>  act as this agent (default: $GRAPIM_AGENT, or human:<your user name>)
  Env: GRAPIM_MODE=warn  warn after the edit instead of blocking it
       GRAPIM_TTL_MINUTES  how long a claim lasts without edits (default 30)`;

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--watch', '--all', '--json', '--yes', '--help', '-h', '--approve', '--reject', '--pending', '--history', '--hook', '--no-intents'].includes(a)) flags[a.replace(/^-+/, '')] = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
    else if (a === '-n') flags.n = argv[++i];
    else rest.push(a);
  }
  return { flags, rest };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function hookEntry(command) {
  return { type: 'command', command, timeout: 20 };
}

export function installHooks(root, bin = BIN) {
  const dir = path.join(root, '.claude');
  const file = path.join(dir, 'settings.local.json');
  fs.mkdirSync(dir, { recursive: true });
  let settings = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (raw) settings = JSON.parse(raw);
  }
  const command = `node "${bin}" hook`;
  const isOurs = (h) => typeof h?.command === 'string' && /grapim(\.js)?"? hook$/.test(h.command);
  settings.hooks ??= {};
  const want = {
    SessionStart: undefined,
    UserPromptSubmit: undefined,
    PreToolUse: 'Edit|Write|MultiEdit|NotebookEdit',
    PostToolUse: 'Edit|Write|MultiEdit|NotebookEdit',
    SessionEnd: undefined,
  };
  for (const [event, matcher] of Object.entries(want)) {
    const groups = (settings.hooks[event] ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    groups.push({ ...(matcher ? { matcher } : {}), hooks: [hookEntry(command)] });
    settings.hooks[event] = groups;
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

async function runsCmd(store, flags) {
  const { inTree } = await attribution();
  const { branchOf, getReview } = await review();
  const rows = store.runs().map((r) => ({ ...r, review: getReview(store, r.run) ?? UNREVIEWED, branch: branchOf(store, r.run) }));
  const status = inTree(store);
  if (flags.json) console.log(JSON.stringify(rows.map((r) => ({ ...r, in_tree: status.get(r.run) ?? '?' })), null, 2));
  else console.log(term(runsText(rows, status)));
  return 0;
}

async function blameCmd(store, rest, flags) {
  const { blame } = await attribution();
  if (!rest[0]) {
    console.error('Give a file: grapim blame <file>');
    return 1;
  }
  const abs = path.resolve(rest[0]);
  const ws = resolveWorkspace(path.dirname(abs));
  const file = fileKey(ws, abs);
  if (!file) {
    console.error(`${rest[0]} is not inside a repo or folder Grapim tracks.`);
    return 1;
  }
  if (flags.history) {
    // Every line, committed (git blame + provenance notes) or not (the ledger).
    const { blameHistoryCmd } = await import('./provenance/cli.js');
    return blameHistoryCmd(store, ws, file, flags, { term });
  }
  const b = blame(store, ws, file);
  console.log(flags.json ? JSON.stringify(b, null, 2) : term(blameText(b)));
  return 0;
}

const planJson = (plan) => ({
  run: plan.run.run,
  label: plan.run.label,
  turn: plan.turn,
  files: plan.files.map((f) => ({ path: f.path, root: f.root, action: f.action, reason: f.reason ?? null })),
});

async function undoCmd(store, rest, flags, agent) {
  const { applyUndo, changedAny, planUndo } = await undo();
  const { autoApprove } = await review();
  if (!rest[0]) {
    console.error('Say which run: grapim undo <run> [--turn N] [--yes]. See grapim runs.');
    return 1;
  }
  const turn = flags.turn === undefined ? null : Number(flags.turn);
  let plan;
  try {
    plan = planUndo(store, rest.join(' '), { turn, actor: agent });
    if (flags.yes) {
      plan = applyUndo(store, plan, agent);
      if (changedAny(plan)) autoApprove(store, plan.undoRun, agent);
    }
  } catch (err) {
    console.error(term(err.message));
    return 1;
  }
  console.log(flags.json ? JSON.stringify({ applied: !!flags.yes, ...planJson(plan) }, null, 2) : term(undoText(plan, !!flags.yes)));
  return 0;
}

const UNREVIEWED = Object.freeze({ status: 'pending', note: null, at: null, by: null });

async function restoreCmd(store, rest, flags, agent) {
  const { applyRestore, planRestore, restoreJson } = await restore();
  const { diffJson } = await import('./server/json-diff.js');
  if (rest.length < 2) {
    console.error('Usage: grapim restore <file> <sha> [--yes]. The sha (or its first 8 characters) is a version from the file history.');
    return 1;
  }
  const abs = path.resolve(rest[0]);
  const ws = resolveWorkspace(path.dirname(abs));
  const file = fileKey(ws, abs);
  if (!file) {
    console.error(`${rest[0]} is not inside a repo or folder Grapim tracks.`);
    return 1;
  }
  let plan;
  try {
    plan = planRestore(store, ws, file, rest[1], { actor: agent });
    if (flags.yes) plan = applyRestore(store, ws, plan, agent);
  } catch (err) {
    console.error(term(err.message));
    return 1;
  }
  const applied = !!flags.yes && plan.action !== 'nothing';
  const known = plan.now.sha === null || plan.now.buf !== null;
  const diff = known ? diffJson(plan.now.buf, plan.version.buf).diff : null;
  console.log(flags.json ? JSON.stringify(restoreJson(plan, applied, { diff }), null, 2) : term(restoreText(plan, applied, diff)));
  return 0;
}

async function branchCmd(store, ws, rest, flags, agent) {
  const { findRun } = await undo();
  const { branchSummary, createBranch } = await review();
  if (!rest[0]) {
    console.error('Say which run: grapim branch <run>. See grapim runs.');
    return 1;
  }
  let run, b;
  try {
    run = findRun(store, rest.join(' '));
    b = createBranch(store, ws, run.run, { by: agent });
  } catch (err) {
    console.error(term(err.message));
    return 1;
  }
  if (flags.json) {
    console.log(JSON.stringify({ run: run.run, label: run.label, ...b }, null, 2));
    return 0;
  }
  const left = b.files.filter((f) => f.status === 'conflict');
  console.log(term(`Branch ${b.branch} created from HEAD for ${run.label || run.run}. Your working tree, index and HEAD are untouched.\n`));
  console.log(term(branchSummary(ws, b.commit)));
  if (left.length) console.log(term(`\nLeft out (conflict):\n${left.map((f) => `  ${f.path}: ${f.reason}`).join('\n')}`));
  return 0;
}

async function reviewCmd(store, rest, flags, agent) {
  const { findRun } = await undo();
  const { branchOf, getReview, setReview } = await review();
  const want = [['approve', 'approved'], ['reject', 'rejected'], ['pending', 'pending']].filter(([f]) => flags[f]);
  if (!rest[0] || want.length > 1) {
    console.error('Usage: grapim review <run> --approve|--reject|--pending [--note "..."]');
    return 1;
  }
  let run, r;
  try {
    run = findRun(store, rest.join(' '));
    r = want.length ? setReview(store, run.run, want[0][1], { note: flags.note ?? null, by: agent }) : (getReview(store, run.run) ?? UNREVIEWED);
  } catch (err) {
    console.error(term(err.message));
    return 1;
  }
  const name = run.label || run.run;
  if (flags.json) console.log(JSON.stringify({ run: run.run, label: run.label, review: r, branch: branchOf(store, run.run) }, null, 2));
  else {
    console.log(term(`${name}: ${r.status}${r.by ? ` by ${r.by}` : ''}${r.note ? ` ("${r.note}")` : ''}`));
    if (want.length && r.status === 'rejected') console.log(term(`Its changes are still in the tree. To remove them: grapim undo "${name}" --yes`));
  }
  return 0;
}

export async function main(argv) {
  const [cmd, ...args] = argv;
  const { flags, rest } = parse(args);
  if (!cmd || cmd === 'help' || flags.help || flags.h) {
    console.log(HELP);
    return 0;
  }

  if (cmd === 'hook') {
    let input;
    try {
      input = JSON.parse(await readStdin());
    } catch {
      return 0;
    }
    try {
      const r = runHook(input);
      // Other agents' intents and labels are in here, shown to Claude and the user.
      if (r.stdout) process.stdout.write(term(r.stdout));
      if (r.stderr) process.stderr.write(term(r.stderr));
      return r.code;
    } catch (err) {
      // Never stop an agent because Grapim itself broke.
      process.stderr.write(`grapim hook error (edit allowed): ${err.message}\n`);
      return 0;
    }
  }

  if (cmd === 'mcp') {
    const { startMcp } = await import('./mcp.js');
    startMcp();
    return null; // stdin keeps the process alive
  }

  if (cmd === 'hub') {
    // The team cloud service. Configured only from env (see .env.example).
    const { startHub } = await import('./hub/index.js');
    return startHub(process.env); // null while serving, 1 if the config is incomplete
  }

  if (cmd === 'serve') {
    // Its own flag parsing: --open takes no value, which parse() does not know.
    const { serveMain } = await import('./server/index.js');
    return serveMain(args); // null while serving: the server keeps the process alive
  }

  if (cmd === 'folder') {
    // Its own flag parsing too (--watch, --once and --force take no value).
    const { folderMain } = await import('./folder-sync.js');
    return folderMain(args);
  }

  if (cmd === 'mount') {
    // The workspace as a network drive (WebDAV); token from $GRAPIM_WORKSPACE_TOKEN.
    const { mountMain } = await import('./mount.js');
    return mountMain(args);
  }

  if (cmd === 'provenance' && args[0] === 'pr') {
    // The pull request summary (docs/provenance.md section 4), from git alone.
    const { prCommand } = await import('./provenance/pr-command.js');
    return prCommand(args.slice(1), { out: (s) => process.stdout.write(term(s)) });
  }

  const ws = resolveWorkspace(process.cwd());
  const agent = flags.agent || process.env.GRAPIM_AGENT || `human:${os.userInfo().username}`;
  const label = agent;

  if (cmd === 'init') {
    const file = installHooks(ws.root);
    console.log(`Claude Code hooks installed in ${file}`);
    console.log(`Shared state: ${ws.stateDir}${ws.isGit ? ' (shared by every worktree of this repo)' : ''}`);
    if (ws.isGit) {
      // Commit provenance: post-commit records a note, pre-push pushes the notes.
      const { installGitHooks } = await import('./provenance/hooks.js');
      try {
        const g = installGitHooks(ws.root, { bin: BIN, intents: flags['no-intents'] ? false : null });
        console.log(`Git hooks for commit provenance installed in ${g.dir} (post-commit, pre-push${g.chained.length ? `; chained to your existing ${g.chained.join(', ')}` : ''})`);
        console.log(g.intents ? 'Notes include the first line of each prompt. To leave prompts out: grapim init --no-intents' : 'Notes leave prompts out (grapim.notes.intents=false).');
      } catch (err) {
        console.error(`Could not install the git hooks for commit provenance: ${err.message}`);
      }
    }
    console.log('\nFor Codex, add to ~/.codex/config.toml:');
    console.log(`  [mcp_servers.grapim]\n  command = "node"\n  args = ["${BIN}", "mcp"]`);
    console.log('\nFor Cursor, add to .cursor/mcp.json:');
    console.log(`  { "mcpServers": { "grapim": { "command": "node", "args": ["${BIN}", "mcp"] } } }`);
    console.log('\nWatch it live: grapim status --watch');
    return 0;
  }

  if (cmd === 'sync') {
    const { SyncError, syncOnce, syncWatch } = await import('./sync.js');
    const hubUrl = flags.hub || process.env.GRAPIM_HUB_URL;
    const token = flags.token || process.env.GRAPIM_HUB_TOKEN;
    if (!hubUrl || !token) {
      console.error('Usage: grapim sync --hub <url> [--token <t>] [--watch]. The token can come from $GRAPIM_HUB_TOKEN (better: it stays out of your shell history).');
      return 1;
    }
    const syncStore = new Store(ws.stateDir);
    const say = (r) => {
      const n = r.changes + r.events + (r.notes ?? 0);
      if (n || !flags.watch) console.log(`Synced ${r.changes} change${r.changes === 1 ? '' : 's'}, ${r.events} event${r.events === 1 ? '' : 's'}, ${r.blobs} file version${r.blobs === 1 ? '' : 's'} and ${r.notes ?? 0} provenance note${r.notes === 1 ? '' : 's'} to ${new URL(hubUrl).host}.`);
    };
    if (!flags.watch) {
      try {
        say(await syncOnce({ ws, store: syncStore, hubUrl, token }));
        return 0;
      } catch (err) {
        console.error(err instanceof SyncError ? err.message : `Sync failed: ${err.message}`);
        return 1;
      } finally {
        syncStore.close();
      }
    }
    console.log(`Syncing ${ws.repo} to ${hubUrl} every 5 s. Ctrl+C to stop.`);
    syncWatch({ ws, store: syncStore, hubUrl, token, onResult: say, onError: (err, n) => console.error(`${err.message}${n > 1 ? ` (failed ${n} times in a row, backing off)` : ''}`) });
    return null; // the timer keeps the process alive
  }

  const store = new Store(ws.stateDir);
  try {
    switch (cmd) {
      case 'status': {
        if (flags.json) {
          console.log(JSON.stringify({ agents: store.activeAgents(), leases: store.leases() }, null, 2));
          return 0;
        }
        if (!flags.watch) {
          console.log(term(statusText(ws, store)));
          return 0;
        }
        const draw = () => {
          process.stdout.write('\x1b[2J\x1b[H' + term(statusText(ws, store) + '\n\nRecent:\n' + logText(store, 12)) + '\n');
        };
        draw();
        setInterval(draw, 1000);
        return null;
      }
      case 'log':
        console.log(term(logText(store, Number(flags.n) || 30)));
        return 0;
      case 'intent':
        store.setIntent(agent, rest.join(' '), { label, worktree: ws.worktree });
        console.log(`${agent} is now working on: ${rest.join(' ')}`);
        return 0;
      case 'claim': {
        const files = rest.map((p) => fileKey(ws, path.resolve(p))).filter(Boolean);
        if (!files.length) {
          console.error('Give one or more files inside this repo.');
          return 1;
        }
        const ttl = Number(flags.ttl) > 0 ? Number(flags.ttl) * 60 * 1000 : undefined;
        const r = store.claim(agent, files, { intent: flags.intent ?? null, ttlMs: ttl, worktree: ws.worktree, label });
        if (r.ok) {
          console.log(`${agent} claimed ${r.claimed.join(', ')}`);
          return 0;
        }
        for (const c of r.conflicts) console.error(term(`${c.path} is held by ${who(c)} for ${ago(Date.now() - c.acquired_at)}${c.intent ? ` ("${c.intent}")` : ''}`));
        return 3;
      }
      case 'release': {
        const keys = rest.length ? rest.map((p) => fileKey(ws, path.resolve(p))).filter(Boolean).map((f) => f.key) : null;
        const released = store.release(agent, keys);
        console.log(released.length ? `Released ${released.join(', ')}` : 'Nothing to release.');
        return 0;
      }
      case 'runs':
        return await runsCmd(store, flags);
      case 'blame':
        return await blameCmd(store, rest, flags);
      case 'undo':
        return await undoCmd(store, rest, flags, agent);
      case 'restore':
        return await restoreCmd(store, rest, flags, agent);
      case 'branch':
        return await branchCmd(store, ws, rest, flags, agent);
      case 'review':
        return await reviewCmd(store, rest, flags, agent);
      case 'provenance': {
        const { provenanceMain } = await import('./provenance/cli.js');
        return await provenanceMain(store, ws, rest, flags, { term });
      }
      default:
        console.error(`Unknown command: ${cmd}\n\n${HELP}`);
        return 1;
    }
  } finally {
    if (!(cmd === 'status' && flags.watch)) store.close();
  }
}
