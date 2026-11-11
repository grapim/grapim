# Grapim API contract (v0)

This is the contract shared by the server (`src/server/`), the review desk UI (`ui/`) and the review and branch module (`src/review.js`). Change it only by editing this file and telling the other builders.

`grapim serve [--port 7420] [--host 127.0.0.1] [--open]` starts one process. It serves:
- the review desk UI from `ui/` at `/`;
- the JSON API at `/api/*`;
- the agent workspace at `/fs/*` (the "Dropbox" half);
- MCP over HTTP at `/mcp`.

It works on the repo containing the current directory, the same state file the hooks and CLI use.

**Security.** It binds to 127.0.0.1 by default. If `--host` is anything else (anything but `127.0.0.1`, `localhost` or `::1`), the server refuses to start without `GRAPIM_TOKEN` set (16 characters or more). Whenever `GRAPIM_TOKEN` is set, on loopback too (so other users of the same machine are kept out), every request to `/api`, `/fs` and `/mcp` needs `Authorization: Bearer $GRAPIM_TOKEN`, compared in constant time. The review desk's own static files (`/`, `/app.js`, …) load without it: they are the public UI code and hold no repo data. The desk gets the token once from the address: open `http://127.0.0.1:7420/?token=<GRAPIM_TOKEN>`. The page moves it to `sessionStorage` (that tab only, gone when the tab closes), removes it from the address bar at once, and sends it as a Bearer header on every request, the live stream included; it is never written to `localStorage` or into a URL again. The server never takes a token from a query string.
- The `Host` header must be the bound host, `localhost`, `127.0.0.1` or `[::1]` (403 otherwise), against DNS rebinding. Bound to `0.0.0.0` or `::`, the machine's own addresses and host name also count. More names: `GRAPIM_ALLOWED_HOSTS=a.example,b.example`.
- `POST`, `PUT` and `DELETE` from a browser must come from the served origin: an `Origin` that is not `http://<Host>`, or `Sec-Fetch-Site` other than `same-origin`/`none`, gets 403. Agents that send neither are fine.
- Reads from a browser must be same-origin too (no fetches, no-cors loads or event streams from other sites), except a top-level navigation to a page, so a link to the review desk still opens it.
- Every response has `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy: same-origin`.
- `X-Grapim-Agent` is not authentication: on a local server every client is the developer's own user. See docs/security-review-2026-11-11.md.

All times are epoch milliseconds. All paths are repo-relative with forward slashes. Errors are `{ "error": { "code": "...", "message": "..." } }` with a matching HTTP status:

| code | status | when |
|---|---|---|
| `bad_request` | 400 | malformed input, a refused path |
| `unauthorized` | 401 | missing or wrong bearer token |
| `forbidden` | 403 | wrong `Host`, cross-origin write, an agent write to a file that runs code by itself (see the workspace) |
| `not_found` | 404 | no such run, file or version |
| `method_not_allowed` | 405 | the path exists, the method does not (`Allow` lists the right ones) |
| `conflict` | 409 | another agent holds the file; a restore whose file changed since the plan |
| `precondition_failed` | 412 | a `/fs` write whose `If-Match` no longer holds; the error also has `current_sha` |
| `too_large` | 413 | a body over 32 MB (`/fs`) or 1 MB (`/api`); on a hub workspace also a write, blame, run detail, undo or restore whose line comparison takes over 2 s (nothing is written) |
| `internal` | 500 | a bug, or a module that is not implemented yet (the review stub) |
| `busy` | 503 | another agent is mid-edit on the file, or SQLite stayed locked; `Retry-After: 1` |

## Read

### `GET /api/overview`
```json
{
  "repo": "shop-api",
  "root": "C:/…/shop-api",
  "worktrees": [{ "name": "shop-api", "root": "C:/…/shop-api", "branch": "main" }],
  "agents": [{ "agent": "claude-code:1a2b…", "label": "claude 1a2b3c4d", "worktree": "billing", "intent": "Add /billing", "last_seen": 0, "files": ["src/routes.ts"] }],
  "leases": [{ "path": "src/routes.ts", "agent": "…", "label": "…", "worktree": "billing", "intent": "…", "acquired_at": 0, "expires_at": 0 }],
  "counts": { "agents": 3, "leases": 4, "runs": 7, "unreviewed": 5 },
  "worktree": "shop-api"
}
```
`worktree` is the worktree the server runs in: the file APIs read it unless they get `worktree=`. `unreviewed` counts runs whose review is `pending`, so undo and restore runs (approved automatically, see below) are not in it.

**`worktree=<name>`.** `GET /api/files`, `GET /api/blame`, `GET /api/files/history` and `POST /api/files/restore` (in its body) take the name of one of the `worktrees` above and then work on that worktree's files. Any other value is 400 `bad_request`, so a request can never point the server at an arbitrary folder; two worktrees with the same folder name cannot be told apart and are 400 too. Without it, or with the server's own worktree name, they use the server's worktree.

### `GET /api/runs`
A list, newest activity first. Every run that changed at least one file:
```json
[{
  "run": "claude-code:1a2b…", "label": "claude 1a2b3c4d", "worktree": "billing",
  "intent": "Add /billing", "turns": 3, "files": 4, "added": 120, "removed": 8,
  "in_tree": "all" | "some" | "none" | null,
  "first_ts": 0, "last_ts": 0,
  "active": true,
  "review": { "status": "pending" | "approved" | "rejected", "note": null, "at": 0, "by": "human:alex" },
  "branch": "grapim/claude-1a2b3c4d" | null
}]
```
`in_tree` is `null` when it cannot be told (binary or over 2 MB). A run never reviewed has `review: { "status": "pending", "note": null, "at": null, "by": null }`. `active`: the agent was seen in the last hour and has not ended its session, or holds a file. Undo runs (`undo:<ts>`, labelled `undo <run>`) and restore runs (`restore:<ts>`, labelled `restore <path> <first 8 of the sha>`) are runs too. They are a person (or agent) taking work back, not new agent work, so they are created with `review: { "status": "approved", "note": "automatic", "at": …, "by": <the actor> }` and never sit in the "Needs review" inbox. That approval records no `review` event.

### `GET /api/runs/:run`
`:run` is URL-encoded and accepts the same prefixes as `grapim undo`.
```json
{
  "run": { "…same fields as in the list…" },
  "turns": [{ "turn": 1, "intent": "first prompt line", "ts": 0, "files": ["src/a.ts"] }],
  "files": [{
    "path": "src/routes.ts", "added": 12, "removed": 3, "untracked": false,
    "state": "in_tree" | "gone" | "partial" | null,
    "diff": { "hunks": [{ "oldStart": 1, "oldLines": 3, "newStart": 1, "newLines": 4,
      "lines": [{ "t": " " | "+" | "-", "s": "line text without EOL" }] }] }
  }]
}
```
The diff is the run's net effect per file: its first `before` against its last `after`. Use 3 lines of context, like git. A side with no lines starts at the line before (`oldStart: 0` for a new file). For an untracked file (binary or over 2 MB), `added`, `removed` and `diff` are `null`; `state` is `null` when it cannot be told. `turns` lists the turns that changed files, oldest first; `intent` is what the run said it was working on when that turn began (or `null`). Unknown `:run` is 404; a prefix matching several runs is 400.

### `GET /api/blame?path=src/routes.ts[&full=1][&worktree=<name>]`
The same JSON as `grapim blame --json`. With `full=1` it also has `"content"`: the working file's text (UTF-8), so a file view needs one request. `content` is `null` when the file does not exist (`exists: false`), is binary or is over 2 MB. Without `full` the shape is exactly as before (no `content` key).

### `GET /api/files?path=src/[&recursive=1][&worktree=<name>]`
Lists the folder at `path`, for the workspace browser:
```json
[{ "name": "routes.ts", "path": "src/routes.ts", "type": "file" | "dir", "size": 0,
   "last_change": { "ts": 0, "label": "claude 1a2b3c4d", "run": "…" } | null, "held_by": "claude 1a2b3c4d" | null }]
```
With `recursive=1` it is every file below `path` instead, as one flat list (files only, no folders), sorted by path, for search and the command palette:
```json
{ "files": [{ "name": "routes.ts", "path": "src/routes.ts", "type": "file", "size": 0, "last_change": null, "held_by": null }], "truncated": false }
```
In a git repo the list is what `git ls-files -co --exclude-standard` gives (tracked and untracked files, minus anything `.gitignore`d, `.git/info/exclude` or `core.excludesFile`), keeping only files that are on disk; outside git it walks the folder. `.git` and the Grapim state folder are never listed. At most 5000 files are returned; if there are more, `truncated` is `true`.

### `GET /api/files/history?path=src/routes.ts[&worktree=<name>]`
Every recorded change to one file, oldest first, Dropbox-style version history:
```json
[{ "id": 0, "ts": 0, "run": "…", "label": "…", "turn": 1, "added": 2, "removed": 1, "before_sha": "…", "after_sha": "…" }]
```
Any `before_sha` or `after_sha` here that is not `null` can be passed to `POST /api/files/restore`.

### `GET /api/files/version?sha=…`
The raw content of one stored version (`text/plain`), or 404.

### `GET /api/files/changes?after=<id>&limit=500[&worktree=<name>]`
The changes feed, for folder sync: every recorded change to a file in this worktree with an id above `after`, oldest first, at most `limit` (default 500, at most 1000):
```json
{ "changes": [{ "id": 0, "path": "src/app.ts", "sha": "<sha1 after the change>" | null, "ts": 0, "run": "http:sync-laptop", "label": "sync-laptop" }], "cursor": 0 }
```
`sha` is `null` when the change deleted the file, and `"untracked"` when the file is over 2 MB (its content is not hashed by the ledger: GET it for its ETag). `cursor` is the last id in the page, or `after` when the page is empty: pass it as the next `after`. A short page means the client has caught up. Restores and undos are recorded changes, so they appear too. Only changes the ledger records are here: a file edited on the server's disk by hand, outside any agent, shows up in the feed the next time an agent changes it (and a write with `If-Match` sees it at once).

### `GET /api/events?after=<id>&limit=100[&latest=1]`
Events newer than `id`, oldest first. Without `latest`, it gives the `limit` events right after `id` (for paging). With `latest=1`, it gives the newest `limit` of them, still oldest first, which is what a feed wants (the UI sends it when `after` is 0). Each item is `[{ "id", "ts", "agent", "label", "kind", "path", "detail", "actor" }]`. The kinds are `claim`, `release`, `edit`, `blocked`, `intent`, `end`, `undo`, `review`, `branch` and `restore`.

`actor` is who did it, as an agent id (`human:alex`, `http:sandbox-1`, `claude-code:…`; the same rule as for undo below). For `review` and `branch`, `agent` and `label` are the run that was reviewed or branched and `actor` is who reviewed or branched it, so a feed reads "alex approved claude 1a2b…". For `undo` and `restore`, `agent` and `actor` are both the one who undid or restored. For every other kind the agent acted itself, so `actor` equals `agent`. Review and branch events recorded before actors were stored have `actor: null`. (Storage: a nullable `actor` column on the events table, added to existing state files on open; older Grapim versions keep working with it.)

`restore` events have `path` (the file) and `detail` `"<first 12 of the sha> <restore run id>"`.

### `GET /api/stream`
Server-sent events. It sends `event: tick` with `{ "last_event_id": n }` whenever the events table grows (poll SQLite every 500 ms), and a comment ping every 15 s. The UI refetches what it shows on each tick. At most 64 streams are open at once; beyond that it is 503 `busy`.

## Act

### `POST /api/runs/:run/undo`
Body: `{ "turn": null | 2, "apply": false }`. With `apply: false`, the response is the plan; with `apply: true`, it applies. The response matches `grapim undo --json`: `{ "applied", "run", "label", "turn", "files": [{ "path", "root", "action", "reason" }] }`. The actor is `http:<X-Grapim-Agent>` if that header is sent, else `human:<the user running the server>`; the same goes for `by` in a review and for `actor` on review, branch, undo and restore events. When an applied undo changed at least one file, its `undo:<ts>` run is approved automatically (see `GET /api/runs`).

### `POST /api/files/restore`
Puts one file back to a version from its history (Dropbox-style "restore this version"). Body: `{ "path": "src/app.js", "sha": "<a before_sha or after_sha from GET /api/files/history>", "worktree": "<name>" (optional), "apply": true, "expect": "<sha>" | null (optional) }`. `sha` may be a prefix of 4 or more hex characters if it matches one version of this file only.

It goes through the same safety as undo:
- the path is checked like `/fs` (no `..`, no `.git`, no link out of the repo);
- `sha` must be a version this file had, with its content kept (404 otherwise, also for a binary version or one over 2 MB);
- another agent holding the file is 409 `conflict`; an edit to it in progress (a hook between PreToolUse and PostToolUse, an open MCP snapshot) is 503 `busy`; nothing is written;
- the file's folder must still really be inside the worktree (a folder replaced by a link out of it is 409);
- with `expect`, the current file must still have that sha (`null`: still absent), else 409: the UI sends the `current_sha` its confirm step showed;
- the write is atomic, through a temp file with a random name opened exclusively;
- it is recorded as one change under a new run `restore:<ts>`, so history, blame, runs and undo all see it, and `POST /api/runs/restore:<ts>/undo` takes it back; the run is approved automatically; a `restore` event names the actor.

Like `/fs`, files that run code by themselves are refused with 403 `forbidden` unless `GRAPIM_ALLOW_SENSITIVE_WRITES=1` (see the workspace below).

With `"apply": false` nothing is written: the response is the plan, for a confirm step. Either way:
```json
{
  "applied": true, "path": "src/app.js", "sha": "<full sha>", "worktree": "shop-api",
  "action": "replace" | "create" | "nothing", "reason": null | "held by claude 1a2b3c4d right now",
  "current_sha": "<sha of the working file before>" | null,
  "added": 1, "removed": 1,
  "from": { "id": 12, "ts": 0, "run": "claude-code:…", "label": "claude 1a2b3c4d", "turn": 2, "side": "after" | "before" },
  "run": "restore:1762850000000" | null,
  "diff": { "hunks": [ … ] } | null
}
```
`action` is `create` when the file is not on disk, `nothing` when it already has this content (then nothing is written and `applied` is `false`). `diff` is from the working file (before the restore) to the version, in the same hunk format as `GET /api/runs/:run`; `added`, `removed` and `diff` are `null` when the working file is binary or over 2 MB. `reason` in a plan says why applying would be refused right now. `from` is the recorded change the version comes from.

The CLI does the same: `grapim restore <file> <sha-prefix>` prints the plan and the diff, `--yes` applies it, `--json` prints the JSON above (without `worktree`).

### `POST /api/runs/:run/branch`
Puts the run's net changes on a new git branch made from HEAD, without touching any working tree. Response: `{ "branch": "grapim/claude-1a2b3c4d", "commit": "abc123…", "files": [{ "path", "status": "applied" | "conflict" }] }`. The `branch` event records the actor.

### `POST /api/runs/:run/review`
Body: `{ "status": "approved" | "rejected" | "pending", "note": "optional" }`. It returns the run's new `review`. Approving only marks the run as approved; merging is done separately in git by the human. Rejecting also only marks it; the UI offers undo as a separate, explicit step.

## Agent workspace (the "Dropbox" half)

Any agent can work through HTTP instead of a local checkout, for example one in a sandbox (E2B, Modal) or on another machine. Every write goes through the same claim, ledger and undo as local agents.
Identify the agent with the header `X-Grapim-Agent: <name>` (required for writes, 1 to 100 printable characters). Its run id is `http:<name>` and its label `<name>`. `X-Grapim-Intent: <text>` is optional; the first write, and every write with a new intent, starts a new turn.

- `GET /fs/<path>` returns the raw bytes of a file (`application/octet-stream`) with `ETag: "<sha1 of the content>"` (`HEAD` gives the same headers). A path ending in `/` (or `/fs/` for the root) returns the same JSON as `GET /api/files`. A folder without the `/` is 400.
- `PUT /fs/<path>` takes raw bytes (up to 32 MB). It claims the file for the agent, records `before`, writes atomically (temp file plus rename), records `after`, and keeps the claim. The response is `{ "path", "sha", "added", "removed" }` with `ETag: "<sha>"` (`sha` is the sha1 of the bytes written; `added`/`removed` are `null` for binary or over 2 MB). If another agent holds the file, it returns 409 `conflict` with the holder in the message. If another agent is in the middle of an edit to it without a claim (a hook in warn mode), 503 `busy`.
- `DELETE /fs/<path>` works the same way, as a delete. Response `{ "path", "sha": null, "added": 0, "removed": n }`; 404 if there is no such file.
- **`If-Match`** (optional) on `PUT` and `DELETE` makes the write conditional, so a client never overwrites a version it has not seen. `If-Match: "<sha1>"` (an ETag from `GET` or `PUT`): the file must have exactly that content now. `If-Match: "absent"`: there must be no file. If it does not hold, the answer is 412 `precondition_failed` with `"current_sha": "<sha1>" | null` in the error, and nothing is written or recorded. The condition is checked before the claim (so a stale write takes no claim either) and again, with the claim held, right before the rename (or the delete), so a writer that does not claim (a hook in warn mode, a person in an editor) cannot slip in between; if that second check fails, the claim stays until `_release` as after any write. Two requests with the same `If-Match` cannot both win. Any other `If-Match` value is 400. Without `If-Match`, writes are unconditional as before. A `DELETE` with `If-Match: "absent"` on a missing file is 404.
- `POST /fs/_release` releases everything the agent holds and closes its open snapshots. Response `{ "released": ["src/a.ts"], "recorded": [{ "path", "detail": "+2 -1" }] }`.

Paths are refused (400) if they contain `..`, `.`, empty parts, backslashes, control characters, are absolute or a drive path, reach into `.git` or the Grapim state folder, or resolve (through a symlink or junction) outside the repo. On Windows, names that Windows would silently change (a trailing dot or space, `:`, reserved device names like `nul`) are refused too. `.git` is never listed.

**Files that run code by themselves.** `PUT` and `DELETE` (and the MCP `write_file` and `delete_file` tools, and `POST /api/files/restore`) refuse these with 403 `forbidden`, at any depth and in any letter case, also when reached through a link or a Windows 8.3 name:
- `.claude/settings*.json` (including `.claude/settings.local.json`): Claude Code runs the hooks in them;
- `.git/**`: git hooks and config (a write into `.git` is now 403 rather than 400; reads stay 400);
- `.vscode/tasks.json`: VS Code tasks;
- `.envrc`: direnv runs it on entering the folder.

The developer can still edit them by hand. To let agents write them (all but `.git`), start the server with `GRAPIM_ALLOW_SENSITIVE_WRITES=1` in its environment.

## MCP over HTTP: `POST /mcp`

These are the same tools as the stdio server (`claim_files`, `release_files`, `who_is_editing`, `set_intent`, `recent_activity`, `list_runs`, `who_wrote`). It adds `read_file`, `write_file`, `list_dir` and `delete_file`, which act on the workspace like `/fs`. It uses JSON responses in the streamable HTTP style: a POST with a JSON-RPC body gets a JSON-RPC reply. The `Mcp-Session-Id` header is set on initialize; the session id maps to the agent id, unless `X-Grapim-Agent` is given.

- With `X-Grapim-Agent: <name>`, the agent is `http:<name>`, the same run as its `/fs` writes. Without it, the agent is `http:<client>-<first 8 of the session id>`, labelled `<client> <first 8>`, from `clientInfo.name`.
- A batch (a JSON array) gets an array back. Only notifications: 202 with no body.
- A request without `Mcp-Session-Id` (other than initialize) is 400, an unknown or ended session 404, both with a JSON-RPC error (`-32600`, `-32001`).
- `DELETE /mcp` with the session header ends the session: like a stdio client disconnecting, it records the agent's open snapshots and releases its files. `GET /mcp` is 405 (no server-to-client stream). Idle sessions end after 6 hours. At most 1000 sessions are open at once; `initialize` beyond that is 503 `busy`.
- Over HTTP, `claim_files`, `release_files` and `who_wrote` refuse the same paths `/fs` refuses (`.git`, links out of the repo), as a tool result with `isError: true`.
- Workspace tool failures (held by another agent, a refused path, a refused sensitive file, a missing file) come back as tool results with `isError: true`, not as JSON-RPC errors.
