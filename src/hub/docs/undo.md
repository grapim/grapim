---
title: Undo a run
nav: Undo
description: Take one agent run's changes out of every file it touched, and keep everyone else's work.
---
## Undo one run

On the machine that made the edits, in the repo:

```sh
grapim undo 7f3e21aa
```

`<run>` is a run id, its label, or the start of its session id; the run page in the hub shows the exact command. Without `--yes`, undo only prints its plan:

```output
Undo claude 7f3e21aa · 2 files

  revert    src/app.js      its edits removed, later work by others kept
  delete    src/billing.js  created by this run

Nothing was changed. Run again with --yes to apply the 2 clean ones.
```

Check the plan, then apply it:

```sh
grapim undo 7f3e21aa --yes
```

To undo a single prompt of a run, add `--turn 2`.

## What undo does

- For each file the run touched, it removes that run's edits and keeps the edits other agents and people made afterwards (with `git merge-file`, so git must be on your PATH).
- A file the run created, and nobody changed since, is deleted. A file the run deleted is restored.
- This includes files the run's shell commands changed, created, moved or deleted (an `rm`, `mv`, `sed -i`, a formatter or a codegen script), for Claude Code, Codex and Gemini CLI set up with `grapim init`. The plan names the command: `restore  src/old.js  deleted by this run (via shell: rm src/old.js)`.
- If someone else has since edited the same or neighbouring lines, that file is left alone and undo says so. The other files still go ahead.
- A file another agent is editing right now is skipped.
- The undo is recorded as a run of its own, so blame stays right and the undo itself can be undone.

## What it cannot undo

- Shell-command changes Grapim did not record: files outside the repo or ignored by git (build output, `node_modules`, installed packages), a command run while more than 2,000 files (or 50 MB) were uncommitted, changes a background process makes after its command returned, and a file two agents' commands could both have changed at the same time.
- Anything outside the files: databases, network calls, commits, branches, the git index.
- Binary files and files over 2 MB, whose content is not stored.
- Anything already pushed. Undo changes your working tree; commit and push the result like any other change.

## Other ways to take work back

- `grapim branch <run>` puts one run's changes on a new branch from HEAD, without touching your working tree. Useful to keep a run's work out of the current branch but not lose it.
- `grapim restore <file> <sha>` puts one file back to an earlier version from its history.

The hub never changes your code: undo, branch and restore always run on your machine. In a [workspace](/docs/workspaces), people can undo a run from the review desk in the browser, because the workspace lives on the hub.
