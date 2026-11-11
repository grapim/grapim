# Grapim

See what every AI agent changed. Undo any agent's run in one command.

Run five coding agents in one repo: none of them overwrites another's work, every uncommitted line is traced to the agent run that wrote it, and any run can be undone while everyone else's work stays.

Before an agent edits a file, Grapim claims that file for it. If another agent already holds the file, the edit is stopped and the agent is told who has it and what they are doing, so it moves on to other work. Claims are shared across every git worktree of the repo, so two agents in two worktrees are stopped before they write the same file, not at merge time.

```
$ grapim status
Grapim · shop-api · 3 agents active · 4 files claimed

AGENT            WORKTREE   WORKING ON                         LAST SEEN
claude 1a2b3c4d  billing    Add a /billing route with tests    12s ago
claude 9f8e7d6c  header     Fix the header on mobile           40s ago
codex 4121       main       rename the app logger              2m ago

FILE                HELD BY          WORKTREE  FOR                              SINCE
src/routes.ts       claude 1a2b3c4d  billing   Add a /billing route with tests  6m
src/billing.ts      claude 1a2b3c4d  billing   Add a /billing route with tests  5m
web/Header.tsx      claude 9f8e7d6c  header    Fix the header on mobile         3m
src/log.ts          codex 4121       main      rename the app logger            2m
```

Status: prototype, phase 0. Node 22.13 or newer, no dependencies.

## Install

Pick one. Node 22.13 or newer, no other dependencies.

**Claude Code plugin** (hooks for every repo, plus the MCP tools and a skill):

```
/plugin marketplace add twfly104/grapim
/plugin install grapim@grapim
```

**npm, per repo:**

```bash
cd your-repo
npx grapim init
```

That installs the Claude Code hooks in `.claude/settings.local.json` (run it in each worktree; the file is not committed). Use the plugin or `init`, not both; if both are installed, Grapim still counts each prompt once.

**Codex, Cursor and any MCP client:** add an MCP server that runs `npx grapim mcp` (see below).

## Try it

Every Claude Code session in the repo now:

- records what it is working on (its latest prompt),
- is told at each prompt which files other agents hold,
- claims each file before it edits it, and is stopped if someone else holds it,
- gives its files back when the session ends. Claims also expire after 30 minutes without edits.

Watch it live in a spare terminal: `grapim status --watch`.

### Codex, Cursor and other agents

They use the MCP server instead of hooks. `grapim init` prints the config. The agent gets seven tools: `claim_files`, `release_files`, `who_is_editing`, `set_intent`, `recent_activity`, `list_runs`, `who_wrote`. Their claims and Claude Code's live in the same place, so a Codex agent and a Claude Code agent coordinate with each other.

### By hand

```bash
grapim claim src/routes.ts --intent "add /billing"   # exit code 3 if someone holds it
grapim release                                       # give back everything you hold
grapim log                                           # who claimed, edited (+/- lines), was stopped
```

`GRAPIM_MODE=warn` lets edits through and warns the agent right after instead of blocking.

## Who wrote this, and taking one agent's work back out

Grapim keeps a ledger of every edit an agent makes: which run (one agent session) and which turn (one prompt) changed which file, with the file's content before and after. That answers two questions plain locks cannot:

```
$ grapim runs
RUN              WORKTREE  WORKING ON                       TURNS  FILES  +   -   IN TREE  LAST
claude 9f8e7d6c  main      Fix the header on mobile         1      1      +1  -1  yes      1m ago
claude 1a2b3c4d  main      Add a /billing route with tests  1      2      +5  -1  yes      3m ago

$ grapim blame src/app.js
src/app.js · 4 lines differ from HEAD

 2  claude 1a2b3c4d  turn 1  | const v1 = billing();
 3  claude 1a2b3c4d  turn 1  | const v1b = 2;
12  claude 9f8e7d6c  turn 1  | const v10 = header();
14  outside agents           | // added by sed

2 lines removed (not shown).

$ grapim undo 1a2b
Undo claude 1a2b3c4d · 2 files

  revert    src/app.js      its edits removed, later work by others kept
  delete    src/billing.js  created by this run

Nothing was changed. Run again with --yes to apply the 2 clean ones.
```

- `grapim runs` lists every run that changed something: its intent, how many turns, files touched, lines added and removed, and whether its changes are still in the working tree (`yes`, `partly`, `no`, or `?` when it cannot tell).
- `grapim blame <file>` shows, for each line of the working file that differs from HEAD, the run and turn that wrote it. Lines that changed but match no recorded edit are `outside agents`: a human, or a Bash `sed`.
- `grapim undo <run> [--turn N] [--yes]` removes one run's changes (or one turn's) from every file it touched and keeps everyone else's later work. `<run>` is a run id, a label, or a session id prefix (`1a2b`). Without `--yes` it only prints the plan. Undo needs git on PATH (it uses `git merge-file`).
- `runs`, `blame` and `undo` take `--json`. MCP agents get `list_runs` and `who_wrote`; undo is deliberately CLI only.

### How the ledger records

- Claude Code: PreToolUse, once the edit is allowed, snapshots the file as it is. PostToolUse snapshots it again and writes one change row. The two are paired by `tool_use_id` (falling back to session + file). The pending snapshot lives in SQLite, since each hook call is its own process. Each prompt (UserPromptSubmit) starts a new turn.
- MCP agents: `claim_files` snapshots each file, `release_files` (or disconnecting) records what changed since. A new intent starts a new turn.
- File contents are stored once each, by sha1, in a `blobs` table in the same SQLite file. Files over 2 MB or binary (a NUL byte in the first 8 KB) still get a change row, marked untracked, without content.
- Files are read and written as raw bytes, never through git filters, so CRLF and LF stay exactly as they were.
- A ledger failure never blocks an edit: it is written to stderr and the edit goes through.

### How blame works

Start from the file's first recorded content, replay its recorded changes in order with a line diff (Myers, in `src/diff.js`), and carry each line's author forward. If a change's before-snapshot does not match the replayed state, someone outside the agents changed the file in between, and the new lines get `outside agents`. The same happens for the step from the last recorded change to the working file. Then the lines that differ from HEAD are shown. The comparison with HEAD ignores line endings, because with `core.autocrlf` HEAD has LF and the working file CRLF.

### How undo works

For each file the run touched, its changes are cut into segments: stretches where nobody else changed the file between two of its edits. Newest first, each segment is reverted with `git merge-file -p` (current = the working file, base = the segment's after, other = its before), through temp files in the OS temp folder that are deleted afterwards. A clean merge is the working file with exactly that segment's edits taken out.

- If the file is still exactly what the run left, the before-content is written back directly, without git.
- A file the run created and nobody changed since is deleted. A file the run deleted is restored.
- If someone else later edited the same or adjacent lines, the merge conflicts: that file is not touched, and undo says so. Other files still go ahead.
- A file another agent holds right now is skipped, and so is a file that changed between the plan and the write.
- The undo itself is recorded as a run (`undo claude 1a2b3c4d`) and an `undo` event in `grapim log`, so blame stays right afterwards.

## How it works

- State is one SQLite file in `<git-common-dir>/grapim/state.db`, which every worktree of the repo shares. Outside git it is `.grapim/` in the current folder.
- Each claim runs in a `BEGIN IMMEDIATE` transaction, so when many agents claim the same file at the same moment, exactly one wins. `test/concurrency.test.js` races 30 processes for one file, 5 rounds, and checks this.
- A multi-file claim is all or nothing.
- If Grapim itself fails (a broken database, bad input), the hook lets the edit through. It never stops an agent because of its own bug.

## Known limits of this prototype

- Only edits through Claude Code's Edit, Write, MultiEdit and NotebookEdit tools are caught. A `sed -i` or `echo >` through Bash is not claimed, and in blame it shows as `outside agents`.
- The ledger attributes whatever changed between the before- and after-snapshot. A shell command that changes the same file while an agent's edit is in flight is credited to that agent. For MCP agents the window is from claim to release, and edits made without claiming are `outside agents`.
- Undo reverts a run's edits, not its side effects: files changed through Bash, generated files and installed packages are not in the ledger.
- `git merge-file` treats edits on adjacent lines as a conflict, so undo is conservative: two agents editing neighbouring lines means the file is left for you.
- Undo cannot revert binary files or files over 2 MB (their content is not stored). Blame on them says who changed them, not which lines.
- A line diff guesses when lines repeat (a lone `}`): blame can credit such a line to the wrong run. When a change rewrites more than about 2000 lines at once, its middle is treated as fully replaced.
- Blame compares with HEAD by path; on Windows the path's case must match git's.
- Blobs are never cleaned up. The ledger grows with every edit until you delete `state.db`.
- Claims are per file. Two agents changing different functions in one file are treated as a conflict.
- Subagents inside one Claude Code session share its session id, so they count as one agent.
- One machine only. Cross-machine sync is the paid cloud part, later.
- Each hook call takes about 0.4 s on Windows (Node start plus two git calls). Fine for now; a compiled daemon would bring it near zero.

## Verify it in a real Claude Code session

1. In a test repo, run `grapim init`, then `grapim claim app.js --agent codex-alice --intent "rename the logger"`.
2. Open a new Claude Code session in that repo and ask it to add a comment to the top of `app.js` and of another file.
3. Expected: the other file is edited, `app.js` is not, and Claude says `app.js` is held by codex-alice for "rename the logger". `grapim log` shows the block.

## Tests

```bash
npm test
```
