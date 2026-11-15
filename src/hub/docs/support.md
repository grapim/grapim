---
title: Support
nav: Support
description: How to get help, report a problem, or ask for something.
---
Write to the people who build Grapim from **Help and feedback** in the hub, or email [support@grapim.com](mailto:support@grapim.com). We read every message and reply, usually within a day.

{{support-cta}}

## What to include

- What you ran or clicked, and what you expected.
- The exact error message. `grapim sync` and the hub both say what failed.
- Your team's name, and the repo or run if it is about one. Never paste a token.

## Quick fixes

| You see | Try |
|---|---|
| `The hub rejected the token` | The token was revoked, or its owner left the team. Create a new one in Settings, Machine tokens. |
| `This repo has no commits yet` | Commit once, then sync. |
| `grapim sync works in a git repo` | Run it inside the repo, not a parent folder. |
| A Codex run is not recorded | Trust the project hooks once in Codex with `/hooks`, then start a new session. |
| The PR check stays neutral | Require approval is off, or the team is not on Governance. See [the GitHub App and PR check](/docs/github). |
| Lines show as not recorded | The commits were made on a machine without `grapim init`, or before it. |

## Security problems

Use the same form and choose **Something is broken**. Describe the problem without exploit details until we reply.
