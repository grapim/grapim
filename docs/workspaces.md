# Cloud workspaces, folder sync, and storage (the "Dropbox" half): contract v0

This is shared by three builders: the cloud workspaces in the hub, the folder sync client, and the storage backends. Change it only by editing this file and saying so in your reply.

## What a user gets

1. On app.grapim.com a team creates a **workspace**, a folder that lives in the cloud. It can hold code, docs or data; any file type.
2. Any agent, anywhere (Claude Code on a laptop, Codex, an agent in E2B or Modal, a CI job), reads and writes it over HTTPS or MCP with a workspace token. Every write goes through the same guard, ledger, blame, undo, branch and review as a local repo.
3. People open the workspace in the browser and get the same review desk as `grapim serve`: live agents, runs, diffs, blame, undo, versions and restore.
4. `grapim folder <workspace-url> <dir> --watch` keeps a local folder and the cloud workspace in sync both ways, like Dropbox. When both sides change the same file, it merges if it can; if not, it keeps both copies.
5. File versions are stored in a pluggable store: the hub's volume by default, or S3 or Cloudflare R2, including a bucket the customer owns.

## 1. Cloud workspaces (hub)

- **Storage on the hub**: `${HUB_DATA}/workspaces/<team_id>/<workspace_id>/` is a normal git repo, created with `git init` plus an empty first commit by a fixed identity, `Grapim <workspace@grapim.local>`. Its Grapim state is in `.git/grapim/` as usual. The hub image must have `git` installed.
- **URLs**: `https://<hub>/w/<team-slug>/<workspace-name>/` serves the review desk UI. Below it, `api/*`, `fs/*` and `mcp` behave exactly as in docs/api.md, by mounting the same engine as `grapim serve` (src/server) with a base path. Reuse src/server; don't fork it.
- **Auth**:
  - A browser uses the hub session cookie, and the user must be a team member. CSRF and Origin rules work as on the hub.
  - An agent or the sync client uses `Authorization: Bearer gws_<random>`, a workspace token created by a member in hub settings. It is stored as sha256, shown once and revocable. Its scope is `read` or `write`.
  - A read token can't call any write or act endpoint (PUT/DELETE fs, undo, restore, review, branch, MCP write tools).
- **Agent identity**: the run id is `http:<token-name>/<X-Grapim-Agent>`, so one token can't write as another token's agents. Without the header, it's `http:<token-name>`. Undo, review and restore done by a signed-in person are recorded as `human:<github-login>`.
- **Limits**: the team storage quota (`HUB_TEAM_STORAGE_MB`) counts workspace bytes. The free plan gets 1 workspace; team gets unlimited. Use `limitsFor` with `{ workspaces }`, defaulting to free=1 and team=Infinity if billing doesn't define it.
- **Pages**: a workspace list in the team page (create, rename, delete with a typed confirmation, tokens per workspace) and a link to open each one in the review desk.
- **As built (hub builder, 2026-11-11)**:
  - `<team-slug>` is the team id (teams have no slug). `<workspace-name>` is a lowercase slug (`[a-z0-9-]`, 1 to 40, no leading or trailing dash), unique among the team's live workspaces. Renaming changes the URL, not the folder or the tokens.
  - A browser session's writes need the header `X-Grapim-Csrf: <session csrf>`; the hub sends that value in an `X-Grapim-Csrf` response header on workspace responses, and `ui/api.js` echoes it. `grapim serve` sends none and needs none.
  - A person's own `/fs` and MCP writes are `http:@<github-login>[/<X-Grapim-Agent>]`. Token names are `[A-Za-z0-9._-]`, 1 to 40, unique in their workspace for good (revoked ones included), so they never contain `/` or `@`.
  - A read token calling an MCP write tool gets HTTP 403 with a JSON-RPC error `-32003`; nothing in that request runs. MCP write tools: `write_file`, `delete_file`, `claim_files`, `release_files`, `set_intent`.
  - No credentials: 401 (a navigation goes to sign in). Unknown or revoked `gws_` token: 401. Everything else that is not allowed: 404.
  - Storage key: `wsKey = <team_id>/<workspace_id>`.

## 2. Optimistic concurrency on `/fs` (in src/server, so it applies locally and in the cloud)

- `GET /fs/<path>` returns `ETag: "<sha1 of content>"`.
- `PUT` and `DELETE /fs/<path>` accept `If-Match: "<sha1>"` (the file must currently have that content) or `If-Match: "absent"` (the file must not exist). On a mismatch, the response is `412` with `{ "error": { "code": "precondition_failed", "message", "current_sha": "<sha>|null" } }`, and nothing is written. Without `If-Match`, the old behaviour stays the same. A successful PUT returns the new `ETag`.
- **Changes feed**: `GET /api/files/changes?after=<id>&limit=500` returns `{ "changes": [{ "id", "path", "sha": "<after sha>|null if deleted", "ts", "run", "label" }], "cursor": <last id> }`. These are the ledger changes for this worktree in id order, so a client can catch up from any cursor. Restores and undos appear too, because they are recorded changes.

## 3. Folder sync client: `grapim folder <workspace-url> <dir> [--watch] [--token-env GRAPIM_WORKSPACE_TOKEN]`

- **State** lives in `<dir>/.grapim-sync/`:
  - `state.json`: `{ url, cursor, machine, manifest: { "<path>": "<sha>" } }`;
  - `base/<sha>`: the content each synced file last had on both sides (the merge base).
  - Writes to it are atomic: a temp file, then rename.
- **Ignored paths**: `.git/`, `.grapim-sync/`, `node_modules/`, `.DS_Store`, `Thumbs.db`, plus the patterns in `<dir>/.grapimignore` (gitignore syntax, simple subset).
- **Pull**: read the changes feed from `cursor`. For each path whose remote sha differs from the manifest:
  - if the local file still equals the manifest base, take the remote version (or delete it);
  - if both sides changed, merge (see below).
- **Push**: for each local file whose sha differs from the manifest (found by polling every 2 s with `--watch`, comparing mtime and size first, then the sha), send `PUT` with `If-Match` set to the manifest sha (or `"absent"` for a new file). Local deletions use `DELETE` with `If-Match`. On 412, pull that file and merge.
- **Merge**: three-way, with `git merge-file -p <local> <base> <remote>`.
  - A clean merge is PUT with `If-Match: <remote sha>`.
  - On a conflict, or for binary content, keep both, Dropbox-style: the remote version stays at the path, the local version is written next to it as `name (conflict from <machine> YYYY-MM-DD).ext` and pushed as a new file, and the user is told.
  - Never lose either side's bytes.
- **Identity**: the client sends `X-Grapim-Agent: sync-<machine>`, so the cloud ledger shows "sync-laptop edited README.md". Human edits on that machine are attributed to its sync agent.
- **Safety**:
  - Never follow symlinks out of `<dir>`.
  - Refuse a `<dir>` that is a git repo with uncommitted changes unless `--force`.
  - Cap file size at 32 MB (larger files are skipped with a warning).
  - Back off on 429 and 503.
  - On 401 or 403, stop with a clear message.

## 4. Storage backends: `src/storage/`

- `createStorage(url, env)` returns `{ put(key, buf), get(key) -> Buffer|null, has(key), delete(key), list(prefix) -> string[] }`, all async.
  - `file:///abs/dir` is a local folder, with atomic writes and keys mapped safely (no traversal).
  - `s3://bucket/prefix?endpoint=https://...&region=auto` is S3-compatible (AWS S3, Cloudflare R2, MinIO). Use AWS SigV4 implemented with node:crypto, with no dependencies. Credentials come from env `GRAPIM_S3_ACCESS_KEY_ID` and `GRAPIM_S3_SECRET_ACCESS_KEY`, and are never logged.
- **Workspace persistence** (`src/storage/workspace.js`):
  - `persistBlob(storage, wsKey, sha, buf)` stores the key `ws/<wsKey>/blobs/<sha>` (content-addressed and idempotent).
  - `writeManifest(storage, wsKey, { files: { path: sha }, head })` and `readManifest`.
  - `snapshotWorkspace(dir, storage, wsKey)` uploads every current file plus the manifest; `restoreWorkspace(storage, wsKey, dir)` rebuilds the files from the manifest.
- **Hub use**: env `HUB_STORAGE_URL`, default `file://${HUB_DATA}/storage`.
  - After each workspace write, the blob is persisted write-behind (queued, retried, never blocking the request). A manifest is written at most every 30 s per workspace.
  - On boot, a workspace whose directory is missing but whose manifest exists is restored.
  - Per team, the hub can later be pointed at a customer's own bucket (`teams.storage_url`, owner-only, stored as given). The credentials for that are v1, so just leave the column and a TODO.
