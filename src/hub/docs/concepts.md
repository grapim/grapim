---
title: How Grapim works
nav: How Grapim works
description: Runs, turns and intents, how each agent is recorded, provenance notes, and what the hub does with them.
---
## Runs, turns and intents

A **run** is one agent session: one Claude Code conversation, one Codex session, one Cursor chat. It has a label such as `claude 7f3e21aa` or `codex 11349`.

A **turn** is one prompt inside a run. Grapim keeps the first line of each prompt as the turn's **intent**, so a reviewer sees what the agent was asked next to what it did.

For every edit, Grapim records the run and turn, the file, and its content before and after. That record is the **ledger**. It lives in the repo's git folder, is shared by every worktree of the repo, and leaves the machine only through `grapim sync`.

## Agents

`grapim init` sets up each agent it finds. What gets recorded depends on what the agent lets Grapim see:

| Agent | Set up in | What is recorded |
|---|---|---|
| Claude Code | `.claude/settings.local.json`, or the Claude Code plugin | Every Edit, Write, MultiEdit and NotebookEdit, by prompt. Two agents are stopped from editing the same file at once. |
| Codex CLI | `.codex/hooks.json` | Every `apply_patch` edit, by prompt. Codex runs project hooks only after you trust them once (`/hooks` in Codex). |
| Cursor | `.cursor/hooks.json` | Every file edit the agent makes, by prompt. |
| Gemini CLI | `.gemini/settings.json` | Every `write_file` and `replace`, by prompt. |
| Any MCP client | `grapim mcp` as an MCP server | The files the agent claims with `claim_files`, from claim to release. |

Choose the agents yourself with `grapim init --agents claude,codex` (or `all`). Config files that Grapim creates in a git repo are added to `.git/info/exclude`, because they hold a path on your machine.

Changes no recorded agent made, such as a person's edit or a shell command like `sed -i`, are **outside agents**: counted, never credited to a run.

## Provenance notes

After `grapim init`, every commit gets a note in `refs/notes/grapim`. For the lines the commit added, it lists which run and turn wrote them, with the prompt. A commit with no agent lines gets an empty note, so it is recorded as human rather than unknown.

The notes travel with your branch (`pre-push` pushes them) and survive `--amend` and rebase. Commits without a note, made before `grapim init` or on machines without it, are **not recorded**: reports and the pull request check treat them as unknown, never as human.

`grapim blame <file> --history` reads the notes: every line of a file, with the run, turn and prompt that wrote it, or human.

## The hub

`grapim sync` sends a repo's ledger and notes to your team's hub at app.grapim.com. The hub:

- lists runs to review, with their prompts and diffs ([Reviewing runs](/docs/reviews));
- comments on pull requests and runs the merge check, through the GitHub App ([GitHub App and PR check](/docs/github));
- builds [reports](/docs/reports) from the notes and the review decisions.

The hub never writes to your repositories. Undo, restore and branch run on your machine.
