# grapim CLI

`grapim` records every change AI coding agents make in a repo as a run, lets you blame, review and undo runs on your machine, and sends them to your team's hub for review. This page covers every command. Start with the [README](../README.md) for the quickstart.

Requires Node.js 22.13 or newer (the first Node 22 release with the built-in SQLite module unflagged). On an older Node, `grapim` exits with code 1 and says which version it found.

## Install

```bash
npm install -g grapim
grapim --version
```

Install it globally rather than running it through `npx`: the agent hooks call grapim on every edit, and npx keeps packages in a cache folder npm may clear. If you run `npx grapim init`, it points the hooks at your global install when there is one, and otherwise stops and tells you to install it.

`grapim --help` lists every command; `grapim <command> --help` (or `grapim help <command>`) shows one. An unknown command or option is refused with exit code 1 and a pointer to the right usage; nothing runs.

## grapim init

```
grapim init [--agents <list>] [--no-intents]
```

Sets up every coding agent it finds, in the repo you run it in. Run it again any time: it changes nothing that is already right, and rewrites its own entries in place if grapim moved.

An agent counts as found when the repo or your home folder has its trace:

| Agent | Found by | Config written | Events used |
| --- | --- | --- | --- |
| Claude Code | `.claude/` or `CLAUDE.md` in the repo, or `~/.claude/` | `.claude/settings.local.json` | `SessionStart`, `UserPromptSubmit`, `PreToolUse` and `PostToolUse` (matcher `Edit\|Write\|MultiEdit\|NotebookEdit\|Bash`), `PostToolUseFailure` (matcher `Bash`), `SessionEnd` |
| Codex CLI | `.codex/` in the repo, or `~/.codex/` | `.codex/hooks.json` | `SessionStart`, `UserPromptSubmit`, `PreToolUse` and `PostToolUse` (matcher `apply_patch\|Edit\|Write\|Bash`), `SessionEnd` |
| Cursor | `.cursor/` or `.cursorrules` in the repo, or `~/.cursor/` | `.cursor/hooks.json` | `beforeSubmitPrompt`, `afterFileEdit`, `afterShellExecution`, `sessionEnd` |
| Gemini CLI | `.gemini/` or `GEMINI.md` in the repo, or `~/.gemini/` | `.gemini/settings.json` | `SessionStart`, `BeforeAgent`, `BeforeTool` and `AfterTool` (matcher `write_file\|replace\|run_shell_command`), `SessionEnd` |

- `--agents claude,codex,cursor,gemini` (any subset, or `all`) sets up exactly those, found or not. With no agent found and no `--agents`, Claude Code is set up.
- Existing config is merged: your other hooks and settings stay as they were. A file that is not valid JSON (for example one with comments) is not touched; init says so and sets up the other agents.
- A config file init creates is added to `.git/info/exclude`: it holds the path of grapim on your machine. If the file was already committed, init tells you to keep its change out of your commits.
- In a git repo, init also installs `post-commit` and `pre-push` git hooks that record AI provenance as git notes in `refs/notes/grapim` and push them with your branch. They chain to any hook already there (kept as `<name>.grapim-prev`) and respect `core.hooksPath`. `--no-intents` keeps prompts out of the notes.

Hooks written by an older grapim do not cover shell commands: run `grapim init` again to add them. After init, restart any agent that was already running. Codex also asks you to review new hooks: run `/hooks` in Codex and trust the grapim entries; Codex skips project hooks until you do.

### How each agent's edits are recorded

- **Claude Code, Codex CLI, Gemini CLI**: the hook before a file tool claims the file and snapshots it, the hook after snapshots it again and records the change. If another agent holds the file, the hook exits 2 and the agent is told who holds it and why, so the edit does not happen. A Codex `apply_patch` that touches several files claims and records each of them.
- **Cursor**: `afterFileEdit` arrives after the edit, with the replacements made. grapim works out the file as it was before by undoing those replacements, then records the change. If that cannot be done exactly (the replaced text appears more than once, for example), the edit is logged without line attribution and grapim says so on stderr. A clash with another agent's claim is reported, not stopped.
- **Prompts**: each prompt starts a new turn of the run, and its first line becomes the run's intent.
- **Shell commands (Claude Code `Bash`, Codex `Bash`, Gemini CLI `run_shell_command`, Cursor)**: the hook before the command runs `git status` and keeps a copy of every uncommitted or untracked file; files with no uncommitted changes need no copy, since their content is in HEAD. The hook after it runs `git status` again and records every file the command created, changed or deleted as a change of the run and turn, with the command (up to 200 characters, with tokens, passwords and keys masked) as `via`. A move is a delete plus a create. `grapim log` shows these as `+a -r via shell: <command>`. What this does not cover:
  - files outside the git worktree the command started in, files git ignores, and anything outside a git repo;
  - a command whose before-hook finds more than 2,000 uncommitted files, or more than 50 MB of them: nothing is recorded for that command, and grapim says so on stderr (`GRAPIM_SHELL_MAX_FILES`, `GRAPIM_SHELL_MAX_BYTES` change the limits);
  - files over 2 MB or binary: recorded as changed, without content, so undo leaves them to you;
  - changes a command makes after its hook has fired, such as a background process (`run_in_background`) still writing, or a command the agent interrupted without an after-hook;
  - content behind a git filter (Git LFS, `ident`, `working-tree-encoding`) for a file that had no uncommitted changes before the command: recorded as changed, without content;
  - Cursor, which works differently: its `beforeShellExecution` must answer with a permission, and an answer could bypass Cursor's own approval of the command, so grapim does not install it. Instead the snapshot is taken at the prompt and again after each command, and `afterShellExecution` (which only reports) closes it. Edits Cursor's own edit tool makes in between are recorded already and not counted twice, but a file a person changes by hand while Cursor is working is credited to the run too.
- **Shell commands of two agents at once**: the disk cannot say which command changed a file. If another run's command was running in the same worktree at an overlapping time and could have made the same change, the file is credited to neither run, grapim warns on stderr, and blame shows those lines as `outside agents`. A file an edit tool recorded during the command is not counted again.
- **Anything else** (a person, a tool outside the agent): `grapim blame` shows those lines as `outside agents`.

A failure inside grapim never blocks an agent: the hook writes the error to stderr and lets the edit or command through. Undo of a shell command puts files back; it does not touch commits, branches, the git index or anything outside the files.

## grapim sync

```
grapim sync [--watch] [--hub <url>] [--token <token>]
```

Sends this repo's runs, changes, file versions and provenance notes to your team's hub, by default `https://app.grapim.com` (or `$GRAPIM_HUB_URL`). The machine token comes from `$GRAPIM_HUB_TOKEN`; create one in the hub under Settings, Machine tokens. `--token` works too, but leaves the token in your shell history. `--watch` keeps syncing every 5 seconds and backs off when the hub cannot be reached.

## Runs: blame, review, undo

| Command | What it does |
| --- | --- |
| `grapim runs` | Every agent run: intent, turns, files, lines added and removed, and whether its changes are still in the working tree |
| `grapim blame <file>` | For each line that differs from HEAD, the run and turn that wrote it |
| `grapim blame <file> --history` | Every line, committed or not: agent run, turn and prompt, or human |
| `grapim undo <run> [--turn N] [--yes]` | Removes one run's changes (or one turn's) and keeps everyone else's, including files its shell commands changed, created or deleted (as recorded above). Without `--yes` it only prints the plan. Needs git. |
| `grapim restore <file> <sha> [--yes]` | Puts a file back to a recorded version, as its own run that can be undone |
| `grapim branch <run>` | Puts one run's changes on a new branch `grapim/<label>` from HEAD, without touching your working tree |
| `grapim review <run> --approve\|--reject\|--pending [--note "..."]` | Marks a run reviewed; without a flag, shows its review |
| `grapim provenance record\|show\|stats\|push` | Git-note provenance for commits |
| `grapim provenance pr <base>..<head>` | The AI provenance summary a pull request gets |

`<run>` is a run id, its label (`claude 1a2b3c4d`) or a session id prefix (`1a2b`). `runs`, `blame`, `undo`, `restore`, `branch` and `review` take `--json`.

## Coordinating agents

| Command | What it does |
| --- | --- |
| `grapim status [--watch]` | Who is active, what each is working on, which files each holds |
| `grapim log [-n 30]` | Recent claims, edits, blocks and undos |
| `grapim claim <files..> [--intent "..."] [--ttl 30]` | Claims files by hand; exit code 3 if someone else holds one |
| `grapim release [files..]` | Gives back files (all of yours if none given) |
| `grapim intent "<text>"` | Says what you are working on |

Claims are shared by every worktree of a repo and expire after 30 minutes without edits (`GRAPIM_TTL_MINUTES`).

## Servers

| Command | What it does |
| --- | --- |
| `grapim serve [--port 7420] [--host 127.0.0.1] [--open]` | The review desk, JSON API ([api.md](api.md)) and MCP over HTTP, on this machine. A host other than loopback needs `$GRAPIM_TOKEN`. |
| `grapim mcp` | The MCP server over stdio, for agents without hooks. Tools: `claim_files`, `release_files`, `who_is_editing`, `set_intent`, `recent_activity`, `list_runs`, `who_wrote`. |
| `grapim folder <workspace-url> <dir>` | Keeps a local folder and a cloud workspace in sync ([workspaces.md](workspaces.md)) |
| `grapim mount <workspace-url> [drive \| mount-point]` | A cloud workspace as a network drive (WebDAV) |
| `grapim hook [--from codex\|cursor\|gemini]` | The hook entry point the agents call, with the event as JSON on stdin. `grapim init` writes it into each agent's config. |

To use `grapim mcp` with an agent, add a stdio MCP server whose command is `grapim` with the argument `mcp`. For Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.grapim]
command = "grapim"
args = ["mcp"]
```

For Cursor, in `.cursor/mcp.json`:

```json
{ "mcpServers": { "grapim": { "command": "grapim", "args": ["mcp"] } } }
```

## Environment

| Variable | Meaning |
| --- | --- |
| `GRAPIM_HUB_TOKEN` | Machine token for `grapim sync` |
| `GRAPIM_HUB_URL` | Hub address for `grapim sync` (default `https://app.grapim.com`) |
| `GRAPIM_AGENT` | Who CLI commands act as (default `human:<your user name>`) |
| `GRAPIM_MODE=warn` | Let a clashing edit through and warn the agent after it, instead of stopping it |
| `GRAPIM_TTL_MINUTES` | How long a claim lasts without edits (default 30) |
| `GRAPIM_SHELL_MAX_FILES`, `GRAPIM_SHELL_MAX_BYTES` | Above this many uncommitted files (default 2000) or bytes (default 50 MB), a shell command's changes are not recorded |
| `GRAPIM_STATE_DIR` | Where the ledger lives (default `<git-common-dir>/grapim`, or `.grapim/` outside git) |
| `GRAPIM_NO_INIT_HINT=1` | Don't tell a Claude Code session that commit provenance is off |
| `GRAPIM_DEBUG=1` | Print the stack trace when grapim fails |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done |
| 1 | Wrong usage, or the command failed; the message says why |
| 2 | (`grapim hook` only) the edit is stopped: another agent holds the file |
| 3 | (`grapim claim` only) another agent holds one of the files |

## Privacy

Everything stays in the ledger on your machine until you run `grapim sync`, which sends it only to the hub you name, with your token. There is no telemetry: grapim connects to a server only for `sync`, `folder` and `mount`.
