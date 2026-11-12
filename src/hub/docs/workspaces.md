---
title: Workspaces
nav: Workspaces
description: A shared folder on the hub for agents that write docs or data, with every write recorded, reviewable and undoable.
---
Not every agent writes code in a repo. Research notes, specs, generated data and reports often end up in a folder nobody tracks. A workspace is that folder on the hub, with the same record as a repo: who wrote what, from which prompt, and a way to take one run back.

## Create one

In your team, open **Workspaces** and create one with a short name, such as `research-notes`. Its address is:

```text
https://app.grapim.com/w/<team-id>/<name>/
```

Open it in the browser for the review desk: live agents, runs, diffs, blame, file versions, undo and restore. Team members sign in as usual. The Free plan has one workspace; paid plans have as many as you need.

## Connect an agent

Agents use a **workspace token**, created on the workspace's page. A token is shown once and can be:

- **read** or **write**;
- limited to some folders, for example read `docs/**` and write only `docs/drafts/**`. Outside its folders, a path does not exist for that token.

An agent reaches the workspace in one of three ways, all with `Authorization: Bearer <token>`:

- **MCP**: point the agent's MCP client at `https://app.grapim.com/w/<team-id>/<name>/mcp`. It gets tools to read, write and list files, and to claim them.
- **HTTPS**: `GET`, `PUT` and `DELETE` on `/w/<team-id>/<name>/fs/<path>`.
- **A network drive** (WebDAV), for tools that only know files: `grapim mount <workspace-url>`.

Each token's writes are recorded as its own agent, so one token cannot write as another's.

## Sync a local folder

People can keep a folder on their own machine in sync with a workspace, both ways:

```sh
export GRAPIM_WORKSPACE_TOKEN=gws_your_token
grapim folder https://app.grapim.com/w/<team-id>/<name>/ ./notes --watch
```

When both sides change the same file, it merges the changes if it can and keeps both copies if it cannot.

## Notion

An owner can connect a Notion integration to a workspace. Pages shared with the integration appear as Markdown files under `saas/notion/`; an agent's edit to one is recorded like any other write and pushed back to Notion, and undoing the run puts the previous content back in Notion too.

## Limits

Workspace files count toward your team's storage. Files that would run code on a laptop after syncing (such as `.claude/settings.json`, `.vscode/tasks.json`, `.envrc` or anything in `.git`) cannot be written by agents.
