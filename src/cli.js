import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { fileKey, resolveWorkspace } from './workspace.js';
import { ago, blameText, logText, restoreText, runsText, statusText, undoText, who } from './format.js';
import { runHook, SOURCES } from './hook.js';
import { AGENTS, ConfigError, NAMES, detectAgents, parseAgentList, setupAgent } from './agents.js';

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

export const HUB = 'https://app.grapim.com';
export const DOCS = 'https://app.grapim.com/docs';

const HELP = `grapim: every AI change to your code has someone accountable for it.

Usage: grapim <command> [options]

Get started
  grapim init [--agents <list>] [--no-intents]
                               record every edit your coding agents make in this repo: sets up
                               the agents found here (Claude Code, Codex, Cursor, Gemini CLI;
                               --agents claude,codex,cursor,gemini or all to choose) and, in a
                               git repo, the git hooks that keep AI provenance as git notes
                               (--no-intents: notes without prompts)
  grapim sync [--watch] [--hub <url>]
                               send this repo's runs to your team's hub for review (default
                               ${HUB}; machine token from $GRAPIM_HUB_TOKEN)

Review and undo agent runs
  grapim runs                  every agent run: intent, turns, files, +/- lines, still in the tree?
  grapim review <run> --approve|--reject|--pending [--note "..."]
                               mark a run reviewed on this machine (without a flag, show its
                               review). The pull request check counts approvals in the hub only
  grapim undo <run> [--turn N] [--yes]
                               remove one run's (or one turn's) changes, keep everyone else's.
                               <run> is a run id, label or session id prefix. Without --yes it
                               only prints the plan. Needs git (for git merge-file).
  grapim branch <run>          put one run's changes on a new git branch (grapim/<label>) from
                               HEAD, without touching your working tree, index or HEAD
  grapim restore <file> <sha> [--yes]
                               put a file back to a version from its history (a sha prefix
                               from /api/files/history or the desk). Without --yes it only
                               prints the plan. Recorded as its own run, so it can be undone
  grapim blame <file>          which run and turn wrote each line that differs from HEAD
  grapim blame <file> --history
                               every line, committed or not: agent run, turn and prompt, or human
  grapim provenance record [<commit>] | show [<commit>] | stats [<rev-range>] | push [<remote>]
                               AI provenance notes (refs/notes/grapim): write one for a commit,
                               print one, AI share per agent and file, push the notes
  grapim provenance pr <base>..<head> [--json]
                               the summary a pull request gets: its agent runs, their review
                               and lines (git blame + notes)
  (runs, review, undo, branch, restore, blame, provenance and status take --json)

Coordinate agents
  grapim status [--watch]      who is active, what they are doing, which files they hold
  grapim log [-n 30]           recent claims, edits (+/- lines), blocks and undos
  grapim claim <files..> [--intent "..."] [--ttl 30]
  grapim release [files..]     release files (all of yours if none given)
  grapim intent "<text>"       say what you are working on

Servers and integrations
  grapim mcp                   run the MCP server (for agents without hooks: they call
                               claim_files and release_files themselves)
  grapim serve [--port 7420] [--host 127.0.0.1] [--open]
                               the review desk, JSON API, agent workspace (/fs) and MCP over
                               HTTP (/mcp). A --host other than loopback needs $GRAPIM_TOKEN
  grapim hub                   run the team hub server (from a source checkout only; configured
                               from env, see .env.example)
  grapim folder <workspace-url> <dir> [--watch] [--once] [--force] [--token-env NAME]
                               keep a local folder and a workspace in sync both ways (token from
                               $GRAPIM_WORKSPACE_TOKEN; edits on both sides merge or keep both)
  grapim mount <workspace-url> [drive-letter | mount-point]
                               the workspace as a network drive (WebDAV): on Windows with a
                               letter it runs net use, elsewhere it prints the steps (token
                               from $GRAPIM_WORKSPACE_TOKEN, never the command line)
  grapim hook [--from codex|cursor|gemini]
                               the agent hook entry point (reads JSON on stdin; grapim init
                               sets it up)

Options
  --agent <name>  act as this agent (default: $GRAPIM_AGENT, or human:<your user name>)
  --version       print the version
  Env: GRAPIM_MODE=warn  warn after the edit instead of blocking it
       GRAPIM_TTL_MINUTES  how long a claim lasts without edits (default 30)

No telemetry: grapim connects to a server only when you run sync, folder or mount.
Docs: ${DOCS}   Help: https://app.grapim.com/support`;

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

// The Claude Code hooks alone (the API before `grapim init` set up other agents).
export function installHooks(root, bin = BIN) {
  return setupAgent('claude', root, { bin }).file;
}

export function version() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

// npx, pnpm dlx and bunx run a package from a cache folder they may clear:
// hooks pointing there would stop recording without a word.
export const isTemporaryInstall = (bin) => /\/_npx\/|\/dlx[-/]|\/bunx-/.test(String(bin).replace(/\\/g, '/'));

// bin/grapim.js of a global npm install, or null.
function globalBin() {
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32', timeout: 15000, windowsHide: true }).trim();
    const bin = path.join(root, 'grapim', 'bin', 'grapim.js');
    return root && fs.existsSync(bin) ? bin.split(path.sep).join('/') : null;
  } catch {
    return null;
  }
}

const pad = (s, n) => s + ' '.repeat(Math.max(1, n - s.length));

// `grapim init`. Options are for tests: home (where agents keep their config),
// bin (the grapim.js hooks run), findGlobal, out and err.
export async function initCmd(ws, flags, { home = os.homedir(), bin = BIN, findGlobal = globalBin, out = console.log, err = console.error } = {}) {
  if (isTemporaryInstall(bin)) {
    const lasting = findGlobal();
    if (!lasting) {
      err(
        [
          'grapim init needs grapim installed: npx runs it from a temporary folder that npm clears,',
          'and hooks pointing there would stop recording without telling you. Install it, then init:',
          '',
          '  npm install -g grapim',
          '  grapim init',
        ].join('\n'),
      );
      return 1;
    }
    bin = lasting;
  }
  let chosen;
  const found = detectAgents(ws.root, { home });
  if (flags.agents !== undefined) {
    try {
      chosen = parseAgentList(flags.agents);
    } catch (e) {
      err(e.message);
      return 1;
    }
  } else chosen = AGENTS.filter((id) => found[id]);
  const fallback = !chosen.length;
  if (fallback) chosen = ['claude'];

  const rows = [];
  const problems = [];
  let tracked = [];
  for (const id of chosen) {
    try {
      const r = setupAgent(id, ws.root, { bin, isGit: ws.isGit });
      rows.push([NAMES[id], `${r.rel}${r.changed ? '' : ' (already set up)'}${r.note ? `. ${r.note}` : ''}`]);
      if (r.git === 'tracked' && r.changed) tracked.push(r.rel);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      problems.push(`${NAMES[id]}: ${e.message}`);
    }
  }
  let intents = null;
  if (ws.isGit) {
    // Commit provenance: post-commit records a note, pre-push pushes the notes.
    const { installGitHooks } = await import('./provenance/hooks.js');
    try {
      const g = installGitHooks(ws.root, { bin, intents: flags['no-intents'] ? false : null });
      rows.push(['Git', `post-commit and pre-push hooks keep AI provenance as git notes${g.chained.length ? ` (chained to your existing ${g.chained.join(', ')})` : ''}`]);
      intents = g.intents;
    } catch (e) {
      problems.push(`Git: could not install the hooks for commit provenance: ${e.message}`);
    }
  }

  const lines = [];
  if (rows.length) {
    lines.push(`Grapim is set up in ${ws.repo}. Every change these agents make is recorded as a run:`, '');
    for (const [name, what] of rows) lines.push(`  ${pad(name, 13)}${what}`);
  }
  const missing = AGENTS.filter((id) => !chosen.includes(id));
  if (fallback) lines.push('', `No coding agent found in this repo or your home folder, so Claude Code was set up. To choose: grapim init --agents ${AGENTS.join(',')}`);
  else if (missing.length && flags.agents === undefined) lines.push('', `Not found: ${missing.map((id) => NAMES[id]).join(', ')}. To add one anyway: grapim init --agents ${missing[0]}`);
  if (tracked.length) lines.push('', `${tracked.join(', ')} ${tracked.length > 1 ? 'are' : 'is'} committed in this repo and now holds a path on this machine: keep that change out of your commits.`);
  if (intents !== null) lines.push('', intents ? 'Notes include the first line of each prompt. To leave prompts out: grapim init --no-intents' : 'Notes leave prompts out (grapim.notes.intents=false).');
  const agentsSet = rows.some(([n]) => n !== 'Git');
  if (agentsSet) {
    const setToken = process.platform === 'win32' ? '$env:GRAPIM_HUB_TOKEN = "cmh_..."' : 'export GRAPIM_HUB_TOKEN=cmh_...';
    lines.push(
      '',
      'Restart any agent that is already running so it loads the hooks.',
      '',
      'Next',
      '  See the runs on this machine:  grapim runs',
      '  Review them with your team:',
      `    1. Sign in at ${HUB} and create a machine token (Settings, Machine tokens; create a team first if you have none)`,
      `    2. ${setToken}`,
      '    3. grapim sync --watch',
      '',
      `Docs: ${DOCS}`,
    );
    out(lines.join('\n'));
  }
  for (const p of problems) err(p);
  return problems.length && !rows.some(([n]) => n !== 'Git') ? 1 : 0;
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

// The options each command reads (beyond --agent and --help). serve, folder,
// mount and provenance pr parse their own.
const OPTIONS = {
  init: ['agents', 'no-intents'],
  sync: ['watch', 'hub', 'token'],
  status: ['watch', 'json'],
  log: ['n'],
  claim: ['intent', 'ttl'],
  release: [],
  intent: [],
  runs: ['json'],
  blame: ['json', 'history'],
  undo: ['turn', 'yes', 'json'],
  restore: ['yes', 'json'],
  branch: ['json'],
  review: ['approve', 'reject', 'pending', 'note', 'json'],
  provenance: ['json', 'hook'],
  hook: ['from'],
  mcp: [],
  hub: [],
};
const OWN_PARSER = ['serve', 'folder', 'mount'];
const COMMANDS = [...Object.keys(OPTIONS), ...OWN_PARSER];

// The closest known command to a typo, or null (edit distance 2 at most).
function closest(word) {
  const d = (a, b) => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
  };
  const best = COMMANDS.map((c) => [c, d(String(word).toLowerCase(), c)]).sort((x, y) => x[1] - y[1])[0];
  return best && best[1] <= 2 ? best[0] : null;
}

// One command's lines from HELP, for `grapim <command> --help`.
export function commandHelp(cmd) {
  const lines = HELP.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(`  grapim ${cmd} `) && lines[i] !== `  grapim ${cmd}`) continue;
    out.push(lines[i]);
    while (i + 1 < lines.length && /^ {31}\S/.test(lines[i + 1])) out.push(lines[++i]);
  }
  if (!out.length) return null;
  return [
    'Usage:',
    ...out,
    ...(['claim', 'release', 'intent', 'undo', 'restore', 'branch', 'review'].includes(cmd) ? ['', '  --agent <name>  act as this agent (default: $GRAPIM_AGENT, or human:<your user name>)'] : []),
    '',
    `All commands: grapim --help   Docs: ${DOCS}/cli`,
  ].join('\n');
}

export async function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(version());
    return 0;
  }
  if (cmd && cmd !== 'help' && cmd.startsWith('-') && cmd !== '--help' && cmd !== '-h') {
    console.error(`Unknown option ${cmd}. Options go after the command, like grapim runs --json. See grapim --help.`);
    return 1;
  }
  if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h' && !COMMANDS.includes(cmd)) {
    const near = closest(cmd);
    console.error(`Unknown command: ${term(cmd)}.${near ? ` Did you mean grapim ${near}?` : ''} See grapim --help for the list.`);
    return 1;
  }
  if (cmd === 'help' && args[0]) {
    const one = commandHelp(args[0]);
    console.log(one ?? HELP);
    return 0;
  }
  if (OWN_PARSER.includes(cmd)) {
    // Parsed by the command itself below.
  } else {
    const { flags: given } = parse(args);
    if ((given.help || given.h) && cmd) {
      console.log(commandHelp(cmd) ?? HELP);
      return 0;
    }
    const known = new Set([...(OPTIONS[cmd] ?? []), 'agent', 'help', 'h']);
    const bad = Object.keys(given).filter((k) => !known.has(k));
    if (cmd && bad.length) {
      const opts = OPTIONS[cmd]?.map((o) => (o === 'n' ? '-n' : `--${o}`)) ?? [];
      console.error(`grapim ${cmd} has no option ${bad.map((k) => (k === 'n' ? '-n' : `--${term(k)}`)).join(', ')}.${opts.length ? ` It takes ${opts.join(', ')}.` : ''} See grapim ${cmd} --help.`);
      return 1;
    }
  }
  const { flags, rest } = parse(args);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || flags.help || flags.h) {
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
    const from = SOURCES.includes(flags.from) ? flags.from : 'claude';
    try {
      const r = runHook(input, process.env, () => Date.now(), from);
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
    // Not in the npm package: the hub runs at app.grapim.com.
    if (!fs.existsSync(new URL('./hub/index.js', import.meta.url))) {
      console.error(`The team hub server is not part of the grapim package. Your team's hub is ${HUB}: send runs to it with grapim sync.`);
      return 1;
    }
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

  if (cmd === 'init') return initCmd(ws, flags);

  if (cmd === 'sync') {
    const { SyncError, syncOnce, syncWatch } = await import('./sync.js');
    const hubUrl = flags.hub || process.env.GRAPIM_HUB_URL || HUB;
    const token = flags.token || process.env.GRAPIM_HUB_TOKEN;
    if (!token) {
      const set = process.platform === 'win32' ? '$env:GRAPIM_HUB_TOKEN = "cmh_..."' : 'export GRAPIM_HUB_TOKEN=cmh_...';
      console.error(
        [
          `grapim sync needs a machine token. Create one at ${hubUrl} (Settings, Machine tokens), then:`,
          '',
          `  ${set}`,
          '  grapim sync --watch',
          '',
          'The variable keeps the token out of your shell history; --token <t> works too.',
        ].join('\n'),
      );
      return 1;
    }
    try {
      new URL(hubUrl);
    } catch {
      console.error(`${hubUrl} is not a URL. Give the hub's address, like ${HUB}.`);
      return 1;
    }
    const syncStore = new Store(ws.stateDir);
    const say = (r) => {
      const n = r.changes + r.events + (r.notes ?? 0);
      if (!n && flags.watch) return;
      const what = r.code_storage === 'metadata' ? `${r.changes} change${r.changes === 1 ? '' : 's'} (no file contents: the team has No code storage on)` : `${r.changes} change${r.changes === 1 ? '' : 's'}`;
      console.log(`Synced ${what}, ${r.events} event${r.events === 1 ? '' : 's'}, ${r.code_storage === 'metadata' ? '' : `${r.blobs} file version${r.blobs === 1 ? '' : 's'} `}and ${r.notes ?? 0} provenance note${r.notes === 1 ? '' : 's'} to ${new URL(hubUrl).host}.`);
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
