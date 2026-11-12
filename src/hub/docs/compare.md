---
title: Grapim and the tools you already have
nav: Grapim vs built-in tools
description: What Claude Code, Cursor, GitHub Copilot and Entire already record about AI-written code, what Grapim adds, and when you do not need Grapim.
---
Agent tools and GitHub already keep some records of AI-written code. This page lists what each one records, from its own documentation, and where Grapim differs. Sources were read on 13 November 2026, and the products change often, so check the linked page before relying on a detail.

## Short answer

- **One person, one agent, no audit coming:** your agent's checkpoints and git are enough. You do not need Grapim.
- **Only GitHub Copilot's cloud agent:** GitHub already stops the person who asked for a pull request from approving it, and logs the agent's sessions. You probably do not need Grapim.
- **A team using several agents on their own machines (Claude Code, Codex, Cursor, Gemini CLI), with an auditor or customer who asks who reviewed AI changes:** this is the gap Grapim fills.

## What each tool records

| | What it records, and where | Review and merge gate | Agents covered |
|---|---|---|---|
| Claude Code checkpoints | File edits through Claude's edit tools, per prompt. On your machine, about 30 days | None | Claude Code |
| Cursor checkpoints | Agent changes per session. On your machine, separate from git | None | Cursor |
| GitHub Copilot cloud agent | Session logs and audit log events. On GitHub | The requester cannot approve; your branch rules gate the merge | Copilot, and Claude or Codex running as agents on GitHub |
| Entire | Sessions, prompts and line attribution linked to commits. In git refs | Gates on Entire Trails, not GitHub branch rules | Claude Code, Codex, Copilot CLI, Cursor and others |
| Grapim | Every edit of each run, its prompt, and the lines it wrote in each commit. In your team hub and a git note per commit | A teammate other than the run's author approves; a GitHub check your branch rule can require | Claude Code, Codex, Cursor, Gemini CLI, MCP agents |

## Claude Code

Claude Code takes a checkpoint before each prompt, and `/rewind` (or Esc twice) restores files to one. Its documentation is direct about the limits: a file changed only by Bash commands is not tracked, edits made outside Claude or by other sessions are not tracked, checkpoints are deleted about 30 days after the session last saved one, and they are "not a replacement for version control" ([Checkpointing](https://code.claude.com/docs/en/checkpointing)).

By default Claude Code adds a `Co-Authored-By: … <noreply@anthropic.com>` line to its commits and a "Generated with Claude Code" line to pull requests. Both can be turned off with the `attribution` setting ([Settings](https://code.claude.com/docs/en/settings-reference.md)).

**What Grapim adds:** a record your whole team shares and keeps after the session ends. Each run is tied to the lines it wrote in each commit, and a teammate approves it before the pull request check passes. Grapim's [undo](/docs/undo) works across sessions and agents. Like checkpoints, Grapim records edits made through the agent's file tools: a file changed only by a shell command is not attributed to the run, and its lines count as unknown or human in the commit.

## Cursor

Cursor's Agent creates checkpoints automatically. They are "stored locally and separate from Git", restoring one "reverts files only", and Cursor says to use them only for undoing Agent changes ([Checkpoints](https://cursor.com/docs/agent/chat/checkpoints)). On the Enterprise plan, **Cursor Blame** labels lines as Tab, Agent or Human, using data from Cursor's servers, for changes Cursor tracked ([Cursor Blame](https://cursor.com/docs/integrations/cursor-blame)). Cursor also proposed Agent Trace, an open format for line attribution ([agent-trace.dev](https://agent-trace.dev/)).

**What Grapim adds:** one record across Cursor and the other agents your team uses, a review by someone other than the run's author, and a check that can block merging.

## GitHub Copilot cloud agent

For its own cloud agent (formerly the coding agent), GitHub prevents the person who asked Copilot to create a pull request from approving it. The agent cannot approve or merge, and pushes only to its own `copilot/` branches ([Risks and mitigations](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations)). Administrators get session logs and audit log events marked `actor_is_agent` ([Agentic audit log events](https://docs.github.com/en/copilot/reference/agentic-audit-log-events)). The audit log "does not include client session data, such as the prompts a user sends to Copilot locally" ([Review audit logs](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/review-audit-logs)). The agent control plane shows enterprise agent sessions for the last 24 hours ([changelog](https://github.blog/changelog/2026-02-26-enterprise-ai-controls-agent-control-plane-now-generally-available/)).

**What Grapim adds:** the same separation of author and reviewer, for agents that run on developers' machines, whose commits GitHub sees under a person's account. If your team only uses Copilot's cloud agent, GitHub's controls may be all you need.

## Entire

Entire's CLI records agent sessions as checkpoints linked to commits: prompts, transcript, tool activity, changed files and line-level attribution, stored in git refs (`refs/entire/checkpoints/…`) and marked by an `Entire-Checkpoint` trailer ([Checkpoints](https://docs.entire.com/guides/checkpoints/overview.md), [storage](https://docs.entire.com/guides/checkpoints/checkpoint-storage.md)). Entire also hosts code, and its **Trails** have gates: a minimum number of human approvals, whether the author's approval counts, findings and CI checks. Entire's documentation says these gates do not use GitHub's branch protection rules ([Gates](https://docs.entire.com/guides/trails/gates.md)). The core is free, with agent usage billed per token ([Pricing](https://entire.com/pricing)).

**How Grapim differs:** Grapim leaves your code and your merge process on GitHub. Reviews happen in the hub or from the button on the pull request check, the gate is a GitHub check your branch rule requires, and the reports and [audit evidence](/docs/reports#audit-evidence) are built for an engineering manager and an auditor. If your team moves its review flow onto Entire, its gates may cover you.

## What no tool proves

Records depend on the machines that write them. A trailer can be removed, a local tool can be turned off, and an approval on GitHub shows that an account clicked Approve, not that a person read the lines. Grapim records which run wrote each line and which teammate approved that run in the hub. It cannot stop someone who changes their own client to write false records ([what the check proves](/docs/github#what-the-check-proves-and-what-it-does-not)). No standard (SOC 2, ISO 27001, PCI DSS) requires a specific AI-code tool. What auditors sample is change management: who approved a change, and when.

## See your own numbers first

[Link the GitHub App](/docs/history) and Grapim reads the last 90 days of your merged pull requests. It counts how many had commits from AI agents, and how many of those were merged without an approval from someone other than the author. It installs nothing in your repos.
