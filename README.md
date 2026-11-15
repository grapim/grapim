# Grapim

<p><a href="https://grapim.com"><img src="https://grapim.com/hub/static/site/og.png" alt="Grapim: code review that knows what your agents were asked. A review comment flags a migration that drops users.email, written by a Claude Code run asked only to add pagination." width="720"></a></p>

<p><a href="https://grapim.com">Website</a> · <a href="https://grapim.com/docs/review">Docs</a> · <a href="https://grapim.com/pricing">Pricing</a> · <a href="https://grapim.com/changelog">Changelog</a> · <a href="https://www.linkedin.com/company/grapim">LinkedIn</a></p>

**Code review that knows what your agents were asked.**

Grapim reviews every pull request and comments on the lines that need attention. When Claude Code, Codex, Cursor or Gemini CLI wrote the change, it knows which run wrote each line and what that run was asked to do, so it also flags work nobody asked for: a dropped column, a deleted test, a weakened check.

It runs two ways:

- **Cloud review.** Install the Grapim GitHub App at [app.grapim.com](https://app.grapim.com) and turn on Cloud review. Each pull request is reviewed in about a minute on Grapim's model account. Every plan includes a monthly review credit.
- **In your own CI.** Add one workflow file ([action/review](action/review/README.md)). The review runs on your GitHub runner with your own Anthropic, Amazon Bedrock, Google Vertex AI or Microsoft Foundry account, and Grapim's servers receive nothing.

Setup for both: [app.grapim.com/docs/review](https://app.grapim.com/docs/review).

## The Grapim CLI: runs, blame and undo

The review knows who wrote each line because the CLI records every change your coding agents make as a *run*: which agent, which prompt, which turn, which lines. Your team approves runs at [app.grapim.com](https://app.grapim.com), and any single run can be undone without touching anyone else's work.

```
$ grapim runs
RUN              WORKTREE  WORKING ON                       TURNS  FILES  +    -   IN TREE  REVIEW    LAST
codex 019a3c3e   main      Rename the logger                1      3      +9   -9  yes      approved  1m ago
claude 1a2b3c4d  billing   Add a /billing route with tests  2      2      +41  -1  yes      pending   3m ago

$ grapim undo 1a2b
Undo claude 1a2b3c4d · 2 files

  revert    src/app.js      its edits removed, later work by others kept
  delete    src/billing.js  created by this run

Nothing was changed. Run again with --yes to apply the 2 clean ones.
```

Node.js 22.13 or newer. No dependencies. No telemetry.

### Quickstart

```bash
npm install -g grapim
cd your-repo
grapim init
```

`grapim init` finds the coding agents you use (Claude Code, Codex CLI, Cursor, Gemini CLI) and hooks each one in, merged into your existing config. From then on, every edit they make in this repo is recorded on your machine. Restart any agent that was already running.

Send the runs to your team for review:

1. Sign in at [app.grapim.com](https://app.grapim.com), then Settings, Machine tokens, and create a token.
2. Give it to grapim and start syncing:

   ```bash
   export GRAPIM_HUB_TOKEN=cmh_...      # PowerShell: $env:GRAPIM_HUB_TOKEN = "cmh_..."
   grapim sync --watch
   ```

Runs appear in the hub's Reviews within seconds. A teammate (not the person who synced the run) approves or rejects each one there; with the GitHub App installed, pull requests holding unapproved runs fail the Grapim check. See the [quickstart](https://app.grapim.com/docs) for the whole path.

> Why not `npx grapim init`? The hooks call grapim on every edit, and npx runs packages from a cache folder npm clears. `grapim init` run through npx points the hooks at your global install, or asks you to make one.

### Supported agents

| Agent | How Grapim sees its edits | What `grapim init` writes | Stops an edit to a file another agent holds | Status |
| --- | --- | --- | --- | --- |
| Claude Code | Native hooks: `PreToolUse` / `PostToolUse` on Edit, Write, MultiEdit, NotebookEdit, and Bash (files a shell command changes, compared with `git status` before and after) | `.claude/settings.local.json` | Yes | Stable |
| Codex CLI | Native hooks: `PreToolUse` / `PostToolUse` on `apply_patch` and `Bash` | `.codex/hooks.json`. Codex runs project hooks only after you trust them: run `/hooks` in Codex once. | Yes | Beta |
| Cursor | Native hooks: `afterFileEdit`, `afterShellExecution`, `beforeSubmitPrompt`, `sessionEnd`. Shell commands are recorded from the prompt or the previous command to the end of each command. | `.cursor/hooks.json` | No: Cursor reports an edit after it happens, so a clash is recorded, not stopped | Beta |
| Gemini CLI | Native hooks: `BeforeTool` / `AfterTool` on `write_file`, `replace`, `run_shell_command` | `.gemini/settings.json` | Yes | Beta |
| Other MCP clients | The `grapim mcp` server: the agent calls `claim_files` before editing and `release_files` after | nothing; add `grapim mcp` as a stdio MCP server | Yes, when the agent calls the tools | Works only if the agent cooperates |
| GitHub Copilot coding agent | Not recorded as runs. Its commits reach your pull requests like any other. | nothing | No | Not supported |

Beta: built from each agent's published hook reference and tested with its documented payloads, not yet across every version of the agent. Tell us when something is missed.

Shell commands an agent runs (`sed -i`, a code generator) are recorded by comparing `git status` before and after each command. Files git ignores (`node_modules` after `npm install`) and files outside the repository are not recorded. Changes no agent made show as `outside agents` in `grapim blame`.

`grapim init --agents claude,codex,cursor,gemini` (or `all`) sets up agents it did not find. A config file `init` creates is added to `.git/info/exclude`, since it holds a path on your machine. A file that is not valid JSON is left alone and reported.

### What you can do with runs

```bash
grapim runs                      # every agent run: intent, turns, files, +/- lines, still in the tree?
grapim blame src/app.js          # which run and turn wrote each line that differs from HEAD
grapim blame src/app.js --history  # every line, committed or not: agent, prompt, or human
grapim undo <run> [--turn N]     # take one run (or one turn) back out; prints the plan, --yes applies it
grapim branch <run>              # put one run's changes on their own git branch
grapim review <run> --approve    # or --reject, --pending, with --note "..."
grapim status --watch            # which agents are active and which files they hold right now
grapim serve --open              # the review desk in your browser, on this machine
```

In a git repo, `grapim init` also installs `post-commit` and `pre-push` hooks that keep AI provenance as git notes (`refs/notes/grapim`), so a commit still says which lines an agent wrote after the uncommitted state is gone. They chain to hooks you already have and never fail a commit or a push. `grapim init --no-intents` leaves prompts out of the notes.

When two agents work in the same repo, or in two worktrees of it, the one that reaches a file second is stopped before it writes and told who holds it and why, so it moves on to other work.

## Privacy

- Runs, file versions and prompts stay in `.git/grapim/` on your machine until you run `grapim sync`.
- `grapim sync` sends them only to the hub you name (default `https://app.grapim.com`), with your machine token.
- No telemetry. grapim connects to a server only when you run `sync`, `folder` or `mount`.
- Grapim Review in your own CI sends changes only to your model account. Cloud review fetches each pull request into a temporary folder on Grapim's server, sends it to Anthropic for the review and deletes it when the review ends.

## Docs and support

- Docs: [app.grapim.com/docs](https://app.grapim.com/docs). Every command: [docs/cli.md](docs/cli.md), or `grapim --help`.
- Questions, bugs and ideas: [app.grapim.com/support](https://app.grapim.com/support).

## License

[Apache-2.0](LICENSE)
