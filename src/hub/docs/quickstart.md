<!-- The pull request counts below come from src/hub/github/cloud-review.js: the plan credit (DEFAULT_CREDIT.free, DEFAULT_SEAT_CREDIT per author) divided by REVIEW_COST_ESTIMATE, rounded down to ten (aboutReviews): Free 80, Team 100, Governance 200. Extra pull requests: EXTRA_REVIEW_PRICE. Change them together. -->
---
title: Quickstart
nav: Quickstart
description: Get Grapim reviewing your pull requests in about two minutes with the GitHub App, then, if you want it, record every agent run with the CLI.
---
## Review pull requests

1. **Sign in** at [app.grapim.com](/hub) with GitHub and create a team. Signing in reads your public profile (name and avatar) and nothing else.
2. **Connect GitHub.** On the team's overview, choose **Install on GitHub** and pick the repositories to review.
3. **Turn on cloud review** on the same page.
4. **Open a pull request**, or push to an open one. A **Grapim Review (cloud)** check appears at once, and the comments follow, usually within a minute or two.

Each plan includes a monthly review credit (Free: about 80 pull requests; Team: about 100 per person who opens pull requests). To keep your code off Grapim's servers, run the same review [in your own CI](/docs/review#run-it-in-your-own-ci) with your own model account instead.

## Also record every agent run (CLI)

The CLI records each coding agent session as a run: the agent, what it was asked and the lines it changed. Grapim Review then knows which agent wrote each line, and your team can approve runs and undo one without touching the rest.

You need Node 22.13 or newer and git on the machine where your agents work, a GitHub account, and a repo with at least one commit.

### 1. Sign in and create a team

Sign in at [app.grapim.com](/hub) with GitHub. Grapim reads your public profile (name and avatar) and asks for no other access.

Create a team on the teams page. A team is the people who approve each other's agent work; its owner invites the others later.

> **Early access.** Anyone can sign up and create a team; one account can own up to 5 free teams. To join an existing team instead, open the invite link its owner sends you.

### 2. Install Grapim in a repo

In the repo your agents work in:

```sh
npm install -g grapim
grapim init
```

This sets up recording for the coding agents it finds in the repo or your home folder, and installs two git hooks: `post-commit` writes a provenance note for each commit, and `pre-push` pushes the notes with your branch. Run it once in every repo you want recorded. What it sets up for each agent is listed in [How Grapim works](/docs/concepts#agents).

Each prompt's first line is kept in the notes. To leave prompts out: `grapim init --no-intents`.

### 3. Create a machine token

In the hub, open your team's **Settings**, then **Machine tokens**, give the machine a name (for example `alex-macbook`) and create a token. It starts with `cmh_` and is shown once: copy it now. The hub keeps only a hash.

Use one token per machine. A token can sync to and read this team only, and stops working if you leave the team.

### 4. Sync

Put the token in the environment and start syncing from the repo:

```sh
export GRAPIM_HUB_TOKEN=cmh_your_token
grapim sync --hub https://app.grapim.com --watch
```

On Windows PowerShell, set the token with `$env:GRAPIM_HUB_TOKEN = "cmh_your_token"`. Keeping the token out of the command itself keeps it out of your shell history.

`--watch` syncs every 5 seconds until you stop it. Without it, `grapim sync` sends what is new once and exits. Each sync sends the runs, the changed files' contents and the provenance notes; the repo's GitHub name comes from its `origin` remote.

### 5. Approve your first run

Ask your agent for a small change. Within seconds the run appears in your team's **Approvals**: the agent, what it was asked, turn by turn, and the diff.

A run is approved by someone other than the person who synced it. Invite a teammate from **Settings**, **Members**; the link works once and expires after 7 days. They open the run and choose **Approve** or **Reject**.

## Next

- [Turn on the pull request check](/docs/github), so unapproved agent code cannot merge.
- [Add AI review](/docs/review) to every pull request, in your own GitHub Actions.
- Learn [how a run is recorded](/docs/concepts).
- [Undo a run](/docs/undo) that went wrong.
