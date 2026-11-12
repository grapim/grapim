---
title: Security and privacy
nav: Security and privacy
description: What reaches the hub, how it is protected, and what is not built yet.
---
The hub holds your team's agent history, including the contents of files agents changed. This page says what reaches it, what protects it, and what does not exist yet.

## What reaches the hub

| What | How it gets there |
|---|---|
| Runs, turns, prompts' first lines, changed files' contents | `grapim sync` from machines you connect with a machine token |
| Provenance notes | `grapim sync`, for commits it has not sent before |
| Your GitHub id, login, name and avatar | GitHub sign-in |
| Pull request files and blame | The GitHub App, if an owner installs it, to write its comment and check |
| Workspace files | Agents and people writing to a workspace |

Nothing is pulled from your repositories. Local absolute paths are not sent: only the worktree folder's name and paths inside the repo. Prompts can stay out of provenance notes with `grapim init --no-intents`.

`grapim` itself has no telemetry: it connects to a server only when you run `sync`, `folder` or `mount`.

## Sign-in

- GitHub sign-in asks for no OAuth scopes. The GitHub token is used once to read your public profile and then dropped. Grapim never has access to your repositories through your account.
- Sessions last 30 days, are bound to a random id the server stores only as a hash, and end at sign-out.

## Tokens

- Machine tokens, workspace tokens and invite links are random, shown once, and stored only as SHA-256 hashes.
- A machine token can sync and read one team's repos, nothing else. A member's tokens stop working when they leave or are removed.
- Workspace tokens can be read-only and limited to folders.

## Isolation between teams

Every team page and API checks that you are a member. To anyone else, a team, repo, run or token id answers "not found", exactly like one that does not exist, so ids cannot be probed. An automated test calls every route of the hub as another team's member and token to check this.

## In the browser

- A strict Content Security Policy: no inline scripts, no third-party scripts, no framing.
- Every form checks its origin and a per-session token.
- Everything synced (paths, prompts, file contents) is treated as untrusted and escaped.

## Ask Grapim

The assistant reads with your permissions and only prepares actions; you confirm each one, through the same checks as the page's buttons. Its only outside call is to the Anthropic API. See [Ask Grapim](/docs/ask-grapim).

## Not built yet

So you can decide for yourself:

- **SSO and SAML.** Sign-in is GitHub only; anyone with a GitHub account can sign in, and seeing a team's data needs an invite.
- **Encryption at rest** beyond the hosting platform's disk encryption.
- **Deleting synced history.** Your plan's history window hides older data, but it is not deleted yet, and leaving a team or removing a repo does not purge it.
- **An audit log** of who viewed what in the hub. Review decisions are kept; page views are not.
- **A penetration test or a compliance certification.** None yet.

Found a security problem? Tell us through [Support](/docs/support), choosing "Something is broken", and leave out exploit details until we reply.
