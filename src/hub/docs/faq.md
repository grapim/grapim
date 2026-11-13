---
title: FAQ
nav: FAQ
description: Short answers to the questions engineering managers ask first.
---
## Does Grapim need access to our repositories?

No. Your code reaches the hub only from machines you connect with a machine token, through `grapim sync`. GitHub sign-in reads your public profile and nothing else. The optional GitHub App reads the pull requests of the repositories you pick, to write its comment and check.

## Do we have to move off GitHub?

No. Your repositories, branches and pull requests stay where they are. Grapim adds a record of agent runs, a review step in the hub, and a check on the pull request.

## Which agents are supported?

Claude Code, Codex CLI, Cursor and Gemini CLI through their hooks, set up by `grapim init`, and any MCP client through `grapim mcp`. What each one records is in [How Grapim works](/docs/concepts#agents).

## What if a developer does not run Grapim?

Their commits have no provenance note, so they count as **not recorded**: reports show them as unknown, and with Require provenance on, the pull request check fails until they are recorded or an owner turns Require provenance off.

## Can someone approve their own agent's work?

Not in the hub. The member who synced a run cannot review it, and approvals made on a machine with `grapim review` do not count for the check.

## Does the reviewer have to read every line?

Grapim does not decide how carefully people review. It makes sure each agent run has a named person who approved it, shows them what the run was asked to do next to what it changed, and keeps that decision for later.

## Is the code in our prompts stored?

The first line of each prompt is kept as the turn's intent, in the hub and in the provenance notes. To keep prompts out of the notes, use `grapim init --no-intents`.

## What does it cost?

Nothing during early access: there is no checkout yet. The plans we intend to charge for are on the [pricing page](/pricing).

## Does Grapim help with SOC 2?

Grapim gives you evidence that change-management controls usually ask for: who approved each change an agent made, and when, with an export. It is not a compliance product and Grapim itself holds no certification yet. See [Security and privacy](/docs/security).

## Can we self-host?

Not as a product today. [Talk to us](/docs/support) if it matters for you.
