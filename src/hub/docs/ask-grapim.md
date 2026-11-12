---
title: Ask Grapim
nav: Ask Grapim
description: An assistant in the hub that answers questions about your team's agent work and prepares actions you confirm.
---
## What it does

Open it with **Ask Grapim** at the top right of any team page, or **Ctrl J**. Ask in plain words:

- "What did the agents change in billing-svc today?"
- "Which runs in pull request 412 still need review?"
- "Why did codex 11349 touch the search flags?"

It answers from the same data the hub pages show: runs, reviews, repos, pull requests, workspaces and reports.

## It prepares, you confirm

Ask Grapim can read; it cannot change anything by itself. When you ask for an action it prepares a card that says what will happen, to what, and as whom:

- approve or reject a run;
- create an invite link or a workspace token;
- rename a workspace, or undo a workspace run.

Nothing happens until you choose **Confirm**. Confirming sends the same request the page's own button would, with your session, so the same permission checks apply. Deleting things, revoking tokens, removing members, billing and policy changes are not offered at all: those stay on the hub's own pages.

## What it can see

- What you can open in the hub, in the team you are in. Never another team's data.
- Never tokens, invite links, or files that usually hold secrets (`.env`, keys, credentials).
- Text from runs, files and pull requests is treated as data, never as instructions to it.

The only outside service it calls is the Anthropic API, to run the model.

## Monthly credit

Each team gets a monthly amount of model use, counted at list price and reset on the first of each month (UTC):

| Plan | Ask Grapim each month |
|---|---|
| Free | $1 |
| Team | $20 |
| Governance | $50 |
| Enterprise | $100 |

An owner can set a lower limit, or 0 to turn it off, in **Settings**, **Ask Grapim**. Every member sees the team's total for the month; owners also see who used it.
