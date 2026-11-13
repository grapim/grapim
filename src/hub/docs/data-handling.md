---
title: What Grapim stores
nav: What Grapim stores
description: Exactly what the hub keeps for a synced repo, with and without No code storage.
---
A synced repo reaches the hub through `grapim sync`. This page lists what the hub keeps from it, in the default mode and with **No code storage** on. Cloud workspaces are different: they are folders on the hub, so their files are stored there in both modes.

## The two modes

An owner turns No code storage on or off in **Settings → Code storage**. It is a team setting, available on every plan, and it applies to every repo the team syncs.

| | Default | No code storage |
|---|---|---|
| Runs: run id, agent and its label, turns, start time | Kept | Kept |
| The first line of each prompt (up to 2,000 characters), as the run's intent | Kept | Kept |
| Files touched: path inside the repo, worktree folder name, lines added and removed, time | Kept | Kept |
| A SHA-1 hash of each file version before and after an edit | Kept | Kept |
| Events: edits, claims, releases, session ends, with their path and short detail | Kept | Kept |
| Provenance notes: for each commit, which run wrote which line ranges, and the run's intent (up to 140 characters) | Kept | Kept |
| Repo identity: the root commit hash, the folder name, the GitHub `owner/name` from the `origin` remote | Kept | Kept |
| The machine name that synced, and which member's token it used | Kept | Kept |
| Review decisions in the hub: who approved or rejected a run, when, and the note | Kept | Kept |
| **File contents**: each version of each file an agent changed (up to 2 MB a file) | Kept | **Not stored** |

Prompts are kept in both modes because they are what a reviewer reads. A prompt that pastes code keeps that code with it. To keep prompts out of provenance notes too, run `grapim init --no-intents`.

## How No code storage works

- **The hub drops contents.** With the mode on, the hub accepts a sync but never writes file contents for the team, whatever the client sends. Only the hashes are kept. This also covers older versions of `grapim` that still send contents.
- **`grapim sync` stops sending them.** The hub tells `grapim sync` the team's mode in its answer, and the CLI remembers it. Before its first sync to a hub, the CLI asks with an empty batch, so contents of such a team do not leave the machine. If an owner turns the mode on later, a machine's next batch may still carry contents once; the hub drops them, and the machine stops sending them from then on.
- **Existing contents stay until you delete them.** Turning the mode on does not delete what was synced before. An owner can then delete the team's stored file contents from the same card. That deletes every stored file version of this team for good, and nothing of any other team.
- **Turning it off** keeps contents of new syncs again. Runs synced while it was on stay without contents.

## Diffs with No code storage

When someone opens a run whose contents the hub does not have:

- If the repo is on a GitHub account linked to the team's [GitHub App](/docs/github), and the run's commits were pushed with provenance notes, the hub reads those commits' diffs from GitHub for that page view. They are not saved. A commit's diff can include lines the run did not write.
- Otherwise the run page says so: the diff stays on the developer's machine, where `grapim serve` shows it in the review desk.

What still works without contents: the run list, prompts, files and line counts, reviews and the pull request check. What needs contents and so is unavailable for those runs: the hub's "still in the tree" state, and line-by-line blame in Ask Grapim.

## What else reaches the hub

These do not depend on the mode:

- **The GitHub App**, if an owner installs it, reads pull request files and blame from GitHub to write its comment and check. It keeps the runs it found in each pull request, not the files.
- **The 90-day history scan** keeps each merged pull request's repo, number, title, author, merge time and the AI signals found.
- **Your GitHub profile** (id, login, name, avatar) from sign-in.

See [Security and privacy](/docs/security) for how this data is protected, and what is not built yet.
