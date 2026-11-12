---
title: Quickstart
nav: Quickstart
description: From sign-in to your first reviewed agent run in about five minutes.
---
You need Node 22.13 or newer and git on the machine where your agents work, a GitHub account, and a repo with at least one commit.

## 1. Sign in and create a team

Sign in at [app.grapim.com](/hub) with GitHub. Grapim reads your public profile (name and avatar) and asks for no other access.

Create a team on the teams page. A team is the people who review each other's agent work; its owner invites the others later.

> **Early access.** Anyone can sign up and create a team; one account can own up to 5 free teams. To join an existing team instead, open the invite link its owner sends you.

## 2. Install Grapim in a repo

In the repo your agents work in:

```sh
npm install -g grapim
grapim init
```

This sets up recording for the coding agents it finds in the repo or your home folder, and installs two git hooks: `post-commit` writes a provenance note for each commit, and `pre-push` pushes the notes with your branch. Run it once in every repo you want recorded. What it sets up for each agent is listed in [How Grapim works](/docs/concepts#agents).

Each prompt's first line is kept in the notes. To leave prompts out: `grapim init --no-intents`.

## 3. Create a machine token

In the hub, open your team's **Settings**, then **Machine tokens**, give the machine a name (for example `alex-macbook`) and create a token. It starts with `cmh_` and is shown once: copy it now. The hub keeps only a hash.

Use one token per machine. A token can sync to and read this team only, and stops working if you leave the team.

## 4. Sync

Put the token in the environment and start syncing from the repo:

```sh
export GRAPIM_HUB_TOKEN=cmh_your_token
grapim sync --hub https://app.grapim.com --watch
```

On Windows PowerShell, set the token with `$env:GRAPIM_HUB_TOKEN = "cmh_your_token"`. Keeping the token out of the command itself keeps it out of your shell history.

`--watch` syncs every 5 seconds until you stop it. Without it, `grapim sync` sends what is new once and exits. Each sync sends the runs, the changed files' contents and the provenance notes; the repo's GitHub name comes from its `origin` remote.

## 5. Review your first run

Ask your agent for a small change. Within seconds the run appears in your team's **Reviews**: the agent, what it was asked, turn by turn, and the diff.

A run is reviewed by someone other than the person who synced it. Invite a teammate from **Settings**, **Members & invites**; the link works once and expires after 7 days. They open the run and choose **Approve** or **Reject**.

## Next

- [Turn on the pull request check](/docs/github), so unreviewed agent code cannot merge.
- Learn [how a run is recorded](/docs/concepts).
- [Undo a run](/docs/undo) that went wrong.
