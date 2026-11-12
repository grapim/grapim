---
title: Your last 90 days of AI code
nav: AI history scan
description: When you link GitHub, Grapim reads the pull requests merged in the last 90 days and shows how many had commits from AI agents, and how many merged without another person's approval.
---
## What it shows

When an owner links the [Grapim GitHub App](/docs/github), Grapim reads the pull requests merged in the last 90 days in the repositories the App can see. It shows:

- how many merged pull requests had commits from AI agents, at least;
- how many of those were merged without an approving review from someone other than the pull request's author;
- the same per agent and per repo, and the list of pull requests, linked to GitHub.

Open it from **Settings**, **GitHub**, **AI history**. Every member of the team can read it and export it as CSV. Owners can scan again once an hour with **Scan again**. It works on every plan, the free plan included.

## How agents are recognised

Grapim reads two signals that the agents leave themselves:

- **Commit and pull request authors** that are an agent's own GitHub bot account, for example `copilot-swe-agent[bot]` (GitHub Copilot), `devin-ai-integration[bot]` (Devin), `google-labs-jules[bot]` (Jules), `cursor[bot]` (Cursor), `claude[bot]` (Claude's GitHub app), `amazon-q-developer[bot]` and `factory-droid[bot]`.
- **`Co-authored-by` trailers** in commit messages, with the agent's address: `noreply@anthropic.com` (Claude Code), `noreply@openai.com` (Codex), `cursoragent@cursor.com` (Cursor), `noreply@aider.chat` (Aider), `openhands@all-hands.dev` (OpenHands) and `amp@ampcode.com` (Amp). Aider's default `(aider)` suffix on the author name counts too.

These signals can be turned off in the agent's settings, removed by hand, or never added, so the counts are a lower bound: "at least". A squash merge keeps the squashed commits' trailers in its message, and Grapim reads that too.

## What counts as an approval

A pull request counts as approved by someone else when GitHub recorded an **Approve** review from a person whose login is not the pull request author's. Reviews by bots do not count, and neither do dismissed reviews.

An approval on GitHub shows that an account clicked Approve. It does not show which agent wrote which lines, or that a person read them. When an agent works under a developer's GitHub account, its approval looks the same as the developer's. Grapim records those things from the day you [install the CLI](/docs/quickstart).

## Limits

- It reads with the App's own installation token. Nothing is installed in your repos, and nothing is written to GitHub.
- At most 50 repos (the most recently pushed), 400 pull requests per repo, 2,000 in all, and the first 100 commits of each pull request. The report says when a limit was reached.
- The scan runs in the background and pauses when GitHub's API allowance for the App runs low, so pull request checks keep working. It continues from where it stopped, also after the hub restarts.
- Grapim keeps the repo, number, title, author, merge time, agents found and approvers of each pull request. It does not keep code or commit messages.
