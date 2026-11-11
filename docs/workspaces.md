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

### 1a. Access scopes: each agent sees a different part of the workspace

A workspace token can be limited to some folders. Without rules it works as before: its `read` or `write` scope applies to the whole workspace.

- **Rules**: a list of at most 32 `{ "path": "docs/**", "access": "read" | "write" }`, given when the token is made:
  - in the hub, under **Limit to folders** on the workspace page (rows of path and access);
  - on the platform API, as `scopes` in `POST /v1/workspaces/:id/tokens` (docs/platform.md). The reply and the hub's token list show them; `null` means the whole workspace.
- **Paths** are workspace-relative globs. `**` (a whole segment) is any number of folders, `*` any text inside one name, `?` one character; everything else is literal. No `..`, `.`, empty parts, backslashes or leading `/`. A trailing `/` means the folder and everything in it (`docs/` is stored as `docs/**`). A rule covers a path when it matches the path or a folder above it, as in `.gitignore`, so `notes` covers `notes/a.md`. On Windows and macOS hubs, matching ignores case.
- **Which rule wins**: every rule grants read. A write needs the most specific rule covering the path to be a write rule: the longest literal prefix (the text before the first `*` or `?`) wins, then write over read. So `docs/**` read with `docs/drafts/**` write lets an agent read the docs and change only the drafts, and `data/**` write with `data/raw/**` read keeps `raw/` read-only. A path no rule covers does not exist for the token.
- **A rule never exceeds the token**: a read token cannot have write rules (400).
- **Answers**:
  - a path the token may not read: `404 not_found`, the same answer as a file that is not there, whether it exists or not;
  - a path it may not write: `403 forbidden`, with `error.path`;
  - a run (undo, review, branch) touching a file outside its write scope: `403 forbidden`, naming only the files it may read (`error.paths`) and counting the rest (`error.hidden`, "1 file outside your scope"); a run with no file it may read: 404.
- **Where it applies**, all through one check (`src/scope.js`, called by the engine's authorize hook and its list filters):
  - `/fs`: GET, PUT, DELETE; folder listings leave out what the token cannot see, instead of refusing the folder;
  - `/api` reads: `files` (and `recursive=1`), `blame`, `files/history`, `files/version` (only versions of files it may read), `runs` (only runs that changed a file it may read), `runs/:run` (other files' diffs left out, with `hidden_files` and `scope_note`), `overview`, `events` and `files/changes` (left out; the cursor still moves past them);
  - acts: `undo` (plan or apply), `review`, `branch` and `files/restore` are refused when any file they would touch is outside the write scope;
  - MCP: `read_file`, `list_dir`, `who_wrote`, `write_file`, `delete_file`, `claim_files` and `release_files` check the paths they name; `list_dir`, `list_runs`, `who_is_editing` and `recent_activity` leave out what the token cannot see. A refused write is HTTP 403 with JSON-RPC error `-32003`; a refused read is JSON-RPC error `-32003` over HTTP 200 (a 404 would tell an MCP client its session is gone). Nothing in a refused request runs;
  - WebDAV (`/dav/`) through the same authorize hook.
- **Links**: a path is checked as named and, when a link is on its way, as it really is.
- **The authorize hook contract** (src/server/engine.js): `authorize(req, info)` is called once per request with `{ kind, write, asset }`, then again with the same `kind` and `write` plus `access: 'read' | 'write'` and either `path` (one workspace-relative path, `''` for the root, a trailing `/` for a folder) or `paths` with `recorded: true` (the files a run or version touched). MCP tool calls are checked once each with `{ kind: 'mcp-tool', tool, write, args, access, paths }`. People (session) and embedded desks have no scope.

### 1b. Folder templates

A new workspace (hub page or `POST /v1/workspaces` with `template`) can start with folders:

| `template` | Folders, each with a short `README.md` saying what goes there |
|---|---|
| `blank` (default) | none |
| `agent-team` | `code/`, `docs/`, `data/`, `saas/` (content synced from the team's SaaS tools) |
| `research` | `sources/`, `notes/`, `drafts/` |
| `data` | `raw/`, `clean/`, `reports/` |

- The files are written as one recorded run, `template:<name>` (also its label), right after the workspace is created. It shows in the ledger, runs, blame, history and the changes feed, and can be undone like any run.
- It is approved on creation, like undo and restore runs, by the person (`human:<login>`) or platform key (`api:<key name>`) that created the workspace, so it never waits in the review inbox.
- An unknown template is refused (400) before anything is created.
- The templates pair with scopes: for example `agent-team` with a coding agent on `code/**` (write) and `docs/**` (read), and a writing agent on `docs/**` (write).

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
  - `gs://bucket/prefix` is Google Cloud Storage through its S3-compatible XML API (`https://storage.googleapis.com`, path-style, SigV4 with region `auto`, HMAC keys from `GRAPIM_GCS_ACCESS_KEY_ID` and `GRAPIM_GCS_SECRET_ACCESS_KEY`; no session token; ListObjectsV2 with a `marker=` fallback should a V1 page come back).
  - `azure://account/container/prefix` is Azure Blob Storage with Shared Key auth implemented with node:crypto (`GRAPIM_AZURE_ACCOUNT_KEY`): put, get, has, delete, and list with markers.
- **Workspace persistence** (`src/storage/workspace.js`):
  - `persistBlob(storage, wsKey, sha, buf)` stores the key `ws/<wsKey>/blobs/<sha>` (content-addressed and idempotent).
  - `writeManifest(storage, wsKey, { files: { path: sha }, head })` and `readManifest`.
  - `snapshotWorkspace(dir, storage, wsKey)` uploads every current file plus the manifest; `restoreWorkspace(storage, wsKey, dir)` rebuilds the files from the manifest.
- **Hub use**: env `HUB_STORAGE_URL`, default `file://${HUB_DATA}/storage`.
  - After each workspace write, the blob is persisted write-behind (queued, retried, never blocking the request). A manifest is written at most every 30 s per workspace.
  - On boot, a workspace whose directory is missing but whose manifest exists is restored.
  - Per team, an owner can point the team's workspace files at its own bucket (S3, R2, GCS or Azure): the Storage card in team settings, or `PUT /v1/settings { storage }` with a live platform key. `teams.storage_url` mirrors the store in use (no credentials); the config and the sealed credentials are in `team_storage` (src/hub/team-storage.js). Credentials are AES-256-GCM sealed and bound to the column and team id, never shown again. The endpoint follows the webhook SSRF rules; a probe (put, get, list, delete of a random key) runs before saving. A background move copies the team's blobs and manifests (resumable, idempotent, progress on the card), writes go to both stores meanwhile, blob reads fall back to the old store, manifests are read from the old store, and the team switches only once a verification pass copies nothing. Moving back to the hub's store is the same. Policy and the customer-side IAM steps: docs/storage.md.

## 5. Mount as a drive (WebDAV): `<workspace>/dav/`

A workspace opens as a network drive in Windows File Explorer, macOS Finder and Linux (GNOME Files, davfs2), with no driver or app to install. The address is `https://<hub>/w/<team>/<workspace>/dav/` (on `grapim serve`, `http://127.0.0.1:7420/dav/`). The hub's workspace page has a "Mount as a drive" card with the address and these steps. Built in `src/server/webdav.js`, mounted by the engine, so it is the same code locally and in the cloud.

- **Sign in**: any user name, and a workspace token (`gws_...`) as the password (HTTP Basic, the only scheme the native clients speak; `Authorization: Bearer gws_...` works too). A missing or wrong token, or a token of another workspace, gets 401 with `WWW-Authenticate: Basic realm="Grapim workspace <name>"`. A read token mounts read-only: every write method is 403. A token limited to some folders (section 1a) sees and writes only those, through listings, reads, writes and MOVE or COPY destinations alike.
- **Only over https**: the hub refuses `/dav` over plain http (403, no password prompt) unless the request comes from the hub's own machine. Behind the proxy (`TRUST_PROXY=1`), the last `X-Forwarded-Proto` must be `https`. Session and embed cookies are never read on `/dav`, so a web page cannot use a signed-in browser against it, and requests with a foreign `Origin` or `Sec-Fetch-Site: cross-site` are refused.
- **`grapim serve`**: `/dav` answers only connections from this machine (the socket address, not a header). With `GRAPIM_TOKEN` set, the token is the Basic password.
- **Steps**:
  - Windows: in File Explorer, right-click This PC > Map network drive, pick a letter and paste the address as the Folder (or "Connect to a Web site that you can use to store your documents and pictures" for a network location without a letter); any user name, the token as the password. Or `net use Z: https://<hub>/w/<team>/<ws>/dav/ /user:grapim <token>`, or `grapim mount <workspace-url> Z:`. The WebClient service refuses files over 50 MB by default; raise it with `FileSizeLimitInBytes` (DWORD, up to 4294967295) under `HKLM\SYSTEM\CurrentControlSet\Services\WebClient\Parameters` and restart WebClient. Grapim takes files up to 32 MB each, so this matters only for larger files that reached the workspace another way.
  - macOS: Finder > Go > Connect to Server (Cmd K), paste the address, Registered User, any name, the token as the password. Or `mount_webdav -i <address> <dir>`.
  - Linux: GNOME Files > Other Locations > Connect to Server, `davs://<hub>/w/<team>/<ws>/dav/`. Or davfs2: put `<address> grapim <token>` in `/etc/davfs2/secrets` (mode 600) and `sudo mount -t davfs -o uid=$(id -u),gid=$(id -g) <address> <dir>`.
- **`grapim mount <workspace-url> [drive-letter | mount-point]`**: on Windows with a letter it runs `net use` (user `grapim`); otherwise it prints the steps for the OS. The token comes from `$GRAPIM_WORKSPACE_TOKEN` only; a `gws_` argument is refused, and the token is never printed.
- **What it supports**: WebDAV class 1 and 2. `OPTIONS` (`DAV: 1, 2`, `MS-Author-Via: DAV`), `PROPFIND` (Depth 0 and 1; Depth infinity or no Depth is 403 `propfind-finite-depth`), `GET`, `HEAD`, `PUT`, `DELETE`, `MKCOL`, `MOVE`, `COPY`, `PROPPATCH` (accepted and ignored with 207, which Windows needs after every save), `LOCK` and `UNLOCK`. PROPFIND gives `getlastmodified` (RFC 1123), `creationdate` (ISO 8601, no milliseconds), `getcontentlength`, `getetag` (`"<sha1>"`, the same ETag as `/fs`), `resourcetype`, `displayname`, `getcontenttype`, `supportedlock` and `lockdiscovery`; other properties are listed as 404. Request bodies are XML up to 64 KB, without a DOCTYPE.
- **Every write is an agent write**: `PUT` and `DELETE` go through the same code as `/fs` (path checks, refused sensitive files, the claim, the ledger before and after, the atomic write, and in the hub the quota, the file cap, the upload concurrency caps and the compute pool). `MOVE` is a create at the destination plus a delete of the source; `COPY` is a create (its bytes count toward the quota first); a folder is handled file by file, at most 5000 files per request, never one holding a file the token cannot see (403, without naming it), and everything is checked (paths, scope, sensitive files, locks) before anything changes. `MKCOL` makes a folder (git keeps no empty folders, so an empty one is not in the history). `Destination` must name this host and this workspace's `/dav/`; anything else is 502 or 400, and the path is decoded and checked like the request's (`..`, `%2e%2e`, `%2F`, `.git` are refused).
- **Identity**: the run is `http:<token-name>/dav-<client>` in the hub (`http:dav-<client>` on `grapim serve`), where the client is `windows` (User-Agent `Microsoft-WebDAV-MiniRedir`), `macos` (`WebDAVFS`), `linux` (`davfs2`) or `dav` (anything else). `X-Grapim-Agent` is ignored on `/dav`. Undo, blame and review see the drive like any other agent.
- **Locks**: exclusive write locks on files (folders and shared locks are refused), up to 30 minutes (default 10), kept in memory by the workspace's engine and mapped onto the Grapim claim: a locked file is claimed by the locking drive in the ledger, so `/fs`, MCP and hook agents get 409 while it lasts. Writing a locked file needs its token in the `If` header and the same agent; anything else is 423. `LOCK` without a body and with the token in `If` refreshes. Locking a name that does not exist creates it empty (Windows locks, writes 0 bytes, then the content), within the workspace's file cap like a `PUT`. A drive holds at most 100 locks and a workspace 1000; past that `LOCK` is 423. Without a lock, a drive's write releases its claim at once (a drive never calls `_release`). Locks end when the engine closes (10 idle minutes in the hub); the claim then runs out on its own.
- **Desktop files**: writes to `desktop.ini`, `Thumbs.db`, `.DS_Store` and `._*` are accepted and kept in memory only (up to 500, 256 KB each, 4 MB in all per workspace, the oldest dropped first), so Explorer and Finder stay happy: never stored, never recorded, gone when the engine closes.
- **Not supported**: `Range` requests, Depth infinity, folder locks, dead properties (PROPPATCH values are not kept), renames that only change letter case on a case-insensitive disk (403).