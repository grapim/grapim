---
title: Agent inventory
nav: Agent inventory
description: Which coding agents, versions, models and MCP servers run on your team's machines, what grapim sync sends to build that list, and what it never sends.
---
## What it shows

The **Agents** page of a team lists, across every machine that syncs:

- each coding agent (Claude Code, Codex CLI, Cursor, Gemini CLI), the versions in use, the models it ran with, and on how many machines and for how many people;
- each MCP server those agents are configured to start or call: its name, transport, command or host, which agents use it, and when it was first and last seen. A server that appeared in the last 7 days is marked **New this week**.

It is discovery only. Nothing on the page blocks an agent or a server.

## How it is collected

`grapim sync` adds a small inventory to what it sends, at most once an hour unless something changed. It reads only these files, and only if they exist:

| Agent | Files read |
| --- | --- |
| Claude Code | `~/.claude.json` (`mcpServers`, and each project's `mcpServers`), the repo's `.mcp.json`, `~/.claude/settings.json` (`model`) |
| Cursor | `~/.cursor/mcp.json`, the repo's `.cursor/mcp.json` |
| Codex CLI | `~/.codex/config.toml` (`model` and the `[mcp_servers.*]` tables) |
| Gemini CLI | `~/.gemini/settings.json`, the repo's `.gemini/settings.json` (`mcpServers`, `model`) |

Versions come from what the agent tells the hooks (Cursor sends its version), Claude Code's installer folder, or the `package.json` of a global npm install. Models come from the agents' settings and from hook payloads that name one. No process is started to find any of this; what cannot be read is left blank.

## What is sent

For each MCP server, only:

- its **name**, as written in the config;
- its **transport**: `stdio`, `http` or `sse`;
- for `stdio`, the **command's file name** (`npx`, `uvx`, `node`), plus the **package name** when the command is `npx`, `uvx` or `bunx` and the package is its plain first argument, without a version;
- for `http` and `sse`, the **host** of the URL (`mcp.example.com`).

For each agent: its name, a version, and model names. Each value is checked against a short list of allowed characters on the machine and again on the hub; anything else is dropped.

## What is never sent

- environment variables or their values (`env`), so no API keys or tokens set there;
- HTTP headers, so no `Authorization` or bearer tokens;
- any argument other than the package name: no flags, file paths, connection strings or keys passed on the command line;
- a URL's path, query, port, user name or password;
- full paths of commands or projects, which would carry your user name;
- prompts, file contents or anything else from the agents' settings.

To turn the inventory off on a machine, set `GRAPIM_NO_INVENTORY=1` before `grapim sync`.

## Who can see it

Every member of the team, and nobody outside it. Each machine's report replaces its previous one, so a server removed from a config disappears on that machine's next report.
