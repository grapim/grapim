# Grapim hub: security model (v0)

The hub (`grapim hub`, code in `src/hub/`) is the team service. Each developer's local Grapim pushes its ledger to it with `grapim sync`: runs, changes, events, agent rows, and the before and after contents of files that agents edited. That is source code, so the hub holds a team's most sensitive asset, and this document says what protects it and what does not yet.

## What the hub stores

| Data | Where | Notes |
|---|---|---|
| GitHub user id, login, name, avatar URL | `users` | Public profile only. No email, no GitHub access token. |
| Sessions | `sessions` | sha256 of the session id, the CSRF token, a 30-day expiry. |
| OAuth states | `oauth_states` | sha256 of the state, 10-minute expiry, deleted on first use. |
| Teams, members, roles, plan fields | `teams`, `members` | Stripe customer and subscription ids, never card data. |
| Invite links | `invites` | sha256 of the token only. Single use, 7 days, revocable. |
| Machine tokens | `machine_tokens` | sha256 of the token only, plus the last 4 characters as a hint. |
| Synced ledger | `repos`, `machines`, `h_runs`, `h_agents`, `h_changes`, `h_events` | Every row carries `team_id`. Local absolute paths are not sent: only the worktree folder name and repo-relative paths. |
| File contents | `h_blobs` | Keyed by `(team_id, sha1)`. No deduplication across teams. |

Everything is in one SQLite file in `HUB_DATA` (a Railway volume). It is not encrypted at rest by the hub; it relies on the platform's disk encryption.

## Threat model

Assets: synced source code and agent history; the ability to act as a team member; billing state.

Actors considered:

1. **An anonymous internet user.** Can reach every route.
2. **A signed-in user of another team** (the main multi-tenant risk).
3. **A member of the team** with the `member` role, trying to do owner things or to tamper with other members' data.
4. **A malicious website** visited by a signed-in user (CSRF, clickjacking, login CSRF).
5. **A leaked machine token** (laptop stolen, token pasted in a log).
6. **Someone who can send requests to the Stripe webhook URL.**

Out of scope for v0: a compromised hosting platform, a compromised GitHub account, a malicious hub operator, and a compromised developer machine (it already has the code).

## Controls

### Authentication

- GitHub OAuth web flow. The `state` is 256 bits of randomness, stored server side as sha256 with a 10-minute expiry, deleted on first use, and also bound to the browser by an HMAC-signed, HttpOnly cookie. A callback whose state does not match both is refused before GitHub is called. This blocks login CSRF and state replay.
- The authorization code is exchanged server side with the client secret. The GitHub access token is used once to read `/user` and then dropped. The hub asks for no OAuth scopes.
- Users are keyed by the numeric GitHub id, not the login (logins can be renamed and reused).
- `next` after sign in only accepts `/hub/...` paths (no `//host`, no other origin).

### Sessions

- The cookie holds a random 256-bit id and its HMAC-SHA256 (keyed by `HUB_SECRET`, bound to the purpose `session`). The server stores only sha256(id). A forged or modified cookie fails the HMAC; a stolen database does not yield usable cookies.
- Flags: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` 30 days; `Secure` and the `__Host-` name prefix whenever `HUB_URL` is https. Plain http is only accepted for localhost.
- A new session id at every sign in (no fixation). Logout deletes the server row, so copies of the cookie stop working. Expired rows are swept hourly.

### Authorization and tenant isolation

- Every team route passes through one guard in `src/hub/server.js` before its handler: the membership of the session user (or the machine token's team) is looked up by `(team_id, user_id)`. Not a member, or no such team: the same 404. Ids cannot be probed.
- Every query on synced data filters on `team_id`, and a repo is looked up by `(team_id, repo_id)`. A repo id synced by team A is a 404 under team B even for B's owner. `test/hub-security.test.js` enumerates the router: every route with a `:team` or `:repo` must carry the membership and repo guards, and every team route is called as another team's session, another team's machine token, and with team A's repo, run, invite, token and member ids under the caller's own team. All answer 404 and leak nothing.
- Roles: owners invite, revoke invites, remove members and manage billing. Members create their own machine tokens and read the team's repos. A member who leaves or is removed has their machine tokens for that team revoked in the same transaction.
- A machine token is scoped to one team, can only sync and read that team's repo API, and stops working when its creator leaves the team.
- A machine name inside a repo belongs to the member who first synced it, so one member cannot overwrite another member's machine rows.
- Synced repos are read-only on the hub: their undo, branch and review return 405. Nothing on the hub writes to a synced repository. Cloud workspaces (below) are the hub's own repos, written only through the same engine as `grapim serve`.
- Team creation can be limited with `HUB_TEAM_CREATORS` (comma-separated GitHub logins or numeric ids; ids are safer, since logins can be renamed and reused). Anyone can still sign in and join through an invite. Set it for a private beta.

### Cloud workspaces (`/w/<team_id>/<name>/`)

- The engine of `grapim serve` (`src/server/engine.js`) is mounted per workspace; the hub only authenticates and authorizes (`src/hub/workspace-mount.js`). Each workspace is its own git repo with its own ledger in `.git/grapim/`; the hub refuses to open one whose repo root or state folder is not its own folder (so `GRAPIM_STATE_DIR` must never be set on the hub).
- Who: a session whose user is a member of the team, or `Authorization: Bearer gws_...`, a token of that exact workspace whose creator is still a member. Any other caller, a workspace of another team, a deleted workspace, or a token of another workspace: 404, the same as no such workspace. No credentials at all: 401 (sign-in redirect for a navigation), whatever the URL. An unknown or revoked token: 401. Team and name are matched on the raw request target, never a normalised one.
- Workspace tokens: 256-bit, sha256 stored, shown once, revocable, `last_used_at`, scope `read` or `write`, revoked when the workspace is deleted and when their creator leaves the team. A read token gets 403 on every write and act route (`PUT`/`DELETE`/`POST` on `/fs`, every `POST` on `/api`) and on the MCP tools that change anything (`write_file`, `delete_file`, `claim_files`, `release_files`, `set_intent`); a batch holding one is refused whole.
- Folder scopes (docs/workspaces.md 1a): a token may carry up to 32 `{ path, access }` glob rules. One function (`src/scope.js`) decides every path, from the engine's authorize hook and its list filters: `/fs`, every `/api` read and act, every MCP tool and WebDAV. Outside the read scope a path is 404 whatever exists there; outside the write scope 403. Paths are checked after `resolvePath` (no `..`, nothing in `.git`) and, behind a link, as they really are; a path with `..`, `.`, empty parts or a backslash never matches a rule. A run is refused as a whole when any file it touched is outside the write scope, and invisible when none is readable. Matching ignores case on Windows and macOS hubs. A stored rule list that cannot be read grants nothing. A run id prefix is matched among the runs the token can see only, so an ambiguous prefix never names a run outside its scope.
- Identity: a token's agents are `http:<token-name>/<X-Grapim-Agent>` (or `http:<token-name>`). Token names are unique in their workspace for good and cannot hold `/` or `@`, so one token cannot write as another's agents. A person's undo, review, branch and restore are `human:<github-login>` whatever `X-Grapim-Agent` says; their own `/fs` and MCP writes are `http:@<login>[/<agent>]`.
- Browser writes (and every MCP post) with a session need `Origin` equal to `HUB_URL` (or the `Referer` origin), `Sec-Fetch-Site` absent or `same-origin`, and `X-Grapim-Csrf` equal to the session's CSRF token, which the hub sends only in a response header on workspace responses (no CORS, so other origins cannot read it). Reads from another site are refused except a top-level navigation. `?token=` is stripped from desk URLs by a redirect, so a link cannot sign a tab into someone else's workspace.
- WebDAV (`/w/<team>/<name>/dav/`, docs/workspaces.md 5): a workspace token only, as the Basic password (the native clients speak nothing else) or a Bearer token; session and embed cookies are never read there, so no CSRF surface, and a foreign `Origin` or `Sec-Fetch-Site: cross-site` is refused. Over plain http it is refused (403, no challenge) unless the request comes from the hub's own machine; behind the proxy the last `X-Forwarded-Proto` must be `https`, which relies on the same single-proxy assumption as `TRUST_PROXY` for addresses. A missing, wrong or other workspace's token: 401 with `WWW-Authenticate: Basic realm="Grapim workspace <name>"`, bad tokens counted per address. Every write goes through the `/fs` code (claims, ledger, sensitive files, quota, upload caps, compute pool) and every path, `Destination` included, through the authorize hook and the folder scopes. `Destination` must be this host and this workspace's `/dav/`, decoded segment by segment (`%2F` refused) and never normalised. Locks live in memory and are tied to the agent as well as the token string (lock tokens are visible in PROPFIND). Request XML is capped at 64 KB and refused with a DOCTYPE. `grapim serve` answers `/dav` only to loopback peers.
- The desk's CSP is the hub's plus the hash of its one inline theme script and `style-src 'unsafe-inline'` (style attributes); API, file and MCP responses get `default-src 'none'; sandbox`. Files are served as `application/octet-stream` with `nosniff`, never as a page.
- Agents can never write files that run code by themselves (`.claude/settings*.json`, `.vscode/tasks.json`, `.envrc`, `.git/**`, a `HEAD` that would make a folder a bare repo): `GRAPIM_ALLOW_SENSITIVE_WRITES` is never passed to workspace engines, because synced folders carry those files to laptops. Names that are `.git` on another system (`git~1`, `.git.`, `.git` with HFS+ ignorable characters) are refused on every platform. The sync client refuses all of these, and 8.3 short names, whatever a workspace sends, and runs its own git with `safe.bareRepository=explicit`.
- Limits: plan workspaces (free 1, team unlimited, at most 1,000 per team); folder bytes (files, `.git`, ledger) and every blob uploaded to storage count in `team_usage` with the synced data, uploads are admitted against the quota before their body is read (an unknown length counts as 32 MB), MCP `write_file` by its content; at most 100,000 files per workspace; at most 4 requests with a body in flight per token or person and 24 hub wide; 600 workspace requests/min per token or per person, plus the hub's per-address limits; live streams counted with the hub's (20 per person), each re-checked every 15 s; at most 200 workspace engines open at once, idle ones closed after 10 minutes, and engines held only by streams give way at the cap. Unexpected engine errors answer a generic message, and the API names the mount, not the hub folder. See docs/security-review-workspaces-2026-11-11.md.
- CPU: line counts, diffs, blame and the in-tree replays of workspaces run in a pool of worker threads (`src/hub/compute-pool.js`: 2 workers, or the CPU count minus one up to 4), never on the event loop that serves every team. Each job has 2 s; past that its worker is stopped and replaced, and the request answers 413 `too_large` with nothing written (a runs list answers anyway, with unknown in-tree states). At most 2 jobs of one team run at once, free workers go to the next team in turn, and a team with 64 jobs waiting gets 503 `busy`. A job carries only the contents and change rows of its own call, and workers keep nothing between jobs. A write's line counts are computed before its synchronous claim-to-rename section and remembered by content; a count nobody prepared (a path with no prepare step) is recorded as a whole-file replacement rather than computed on the event loop. `grapim serve` computes in place, as before.
- Platform workspaces (docs/platform.md): the platform's own quota (`PLATFORM_STORAGE_MB`, default 20480) instead of `HUB_TEAM_STORAGE_MB`, a limit per workspace (`workspace_storage_mb` in the settings of its mode, default 512) and test mode's 100 MB, all admitted before the body is read (413 `storage_limit`). See docs/security-review-platform-2026-11-11.md.
- Delete is soft: the folder moves to `HUB_DATA/trash/` and still counts toward the quota until purging exists (v1).
- SaaS connectors (docs/connectors.md): a Notion integration secret is pasted by a team owner, checked with Notion, and stored sealed (AES-256-GCM, a key of its own derived from `HUB_SECRET`, bound to team, workspace and connector), never logged or shown again. The client calls only `https://api.notion.com/v1` with paths built from fixed segments and checked ids (no SSRF), refuses redirects and caps replies. Notion content is untrusted: escaped in pages, and a connector may only write `.md` files directly in `saas/<name>/`, through `resolvePath` and the sensitive-file guard. Agents reach those files through `/fs`, MCP and WebDAV, so token scopes apply to them. Connect, test, sync and disconnect are owner-only.

### CSRF and browser hardening

- Every state-changing browser route is a POST that requires: `Origin` equal to `HUB_URL` (falling back to the `Referer` origin; missing both is refused), `Sec-Fetch-Site` absent or `same-origin`/`none`, and a per-session CSRF token in the form, compared in constant time. Logout is included.
- `SameSite=Lax` cookies add a second layer.
- Headers on every response: a CSP of `default-src 'none'` with `script-src 'self'`, `style-src 'self'`, `form-action` limited to self, GitHub and Stripe, `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'` (no inline script or style anywhere); `X-Content-Type-Options: nosniff`; `X-Frame-Options: DENY`; `Referrer-Policy: same-origin`; `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`; HSTS on https. `Referrer-Policy` is `same-origin` rather than `no-referrer` because with `no-referrer` browsers send `Origin: null` on form posts, which would break the Origin check.
- All HTML is built with an escape-by-default template (`src/hub/pages/html.js`). Synced strings (paths, intents, labels, file contents) are untrusted input from any team member's machine and are always escaped.
- Responses with secrets or private data are `Cache-Control: no-store`. JSON responses carry no CORS headers, so other origins cannot read them.

### Secrets

- Invite tokens and machine tokens: 256-bit random, shown exactly once (copy-once reveal, `no-store`), stored as sha256. Comparisons of tokens, CSRF tokens, OAuth states and HMACs use `crypto.timingSafeEqual` on hashes (`src/hub/secure.js`).
- A team's own storage credentials (S3, R2, GCS HMAC or Azure account key; owner only, docs/storage.md) are the one customer secret the hub must read back. They are sealed with AES-256-GCM under a key derived from `HUB_SECRET`, with the column and team id as authenticated data (a value copied to another team or column does not open), never rendered again (the form's secret fields are always empty), never in a /v1 reply, a log line or an error (errors carry the operation, key, HTTP status and provider error code only, and are scrubbed of the secret values). The endpoint follows the webhook SSRF rules on every connection (https, every resolved address public, the connection pinned to the vetted address, no redirects, replies capped at 256 MB). Only a live platform key can set it through `/v1/settings`; test keys get 403. Rotating `HUB_SECRET` makes them unreadable: that team's writes fail until an owner enters them again, rather than silently falling back to the hub's store.
- `HUB_SECRET` must be at least 32 bytes and look random (an entropy estimate of at least 90 bits, and not a short unit repeated), or the hub refuses to start. `HUB_SECRET` and `GITHUB_CLIENT_SECRET` are non-enumerable on the config object, so serialising the config never prints them. The Stripe keys are never copied into the config at all.
- Logs contain the route pattern, status and duration only. Never a query string, a path parameter (invite tokens live in one), a header, a body or an error from Stripe. Unexpected errors log `name: message` only.

### Input handling

- SQL: prepared statements with bound parameters only.
- Bodies are read with hard limits while streaming: forms 64 KB, sync 8 MB, webhook 1 MB (413 beyond).
- Sync batches are fully validated before a write transaction starts: types, string lengths, id ranges, row counts per batch, sha formats, base64 validity, blob size (2 MB), sha1 of every blob equal to its key, and every blob referenced by a change in the same batch. A bad batch writes nothing.
- Synced timestamps must fit a JavaScript Date (at most 8.64e15 ms), so one row cannot break a page.
- Plan limits (repos, seats, history days) come from the billing module's `limitsFor`, with defaults when it is absent.
- Storage: each team has a quota of stored bytes (blobs plus approximate row sizes), `HUB_TEAM_STORAGE_MB`, default 1024. A batch that would pass it is refused with 413 `storage_limit` before anything is written.
- At most 8 sync batches are parsed at once hub-wide and 2 per team (429 `busy` beyond), so a burst of 8 MB bodies cannot exhaust memory. An upload cut off mid-body releases its slot.
- Reads that replay or diff synced content (repo pages, runs, a run's diff) have a per-request budget of 16 MB of blob input, counting every use. Past it, states read as unknown and diffs are omitted. In-tree states are skipped above 20,000 changes in a repo's history window. One team's content therefore cannot stall the process for the others.
- `grapim sync` refuses redirects, so the token and code are never re-sent elsewhere.

### Rate limits (in memory)

Per client address: 600 requests/min overall, 20/min on sign in and invite routes, 240/min for any bearer-token request (on `/w/`, only unknown, revoked or expired `gws_` tokens count, and requests with a `gws_` token get 6,000/min overall instead of 600, as `/v1` does: sandboxes share egress addresses; each valid token has its own 600/min). Per machine token: 120 syncs/min. Per person: 60 state-changing form posts/min and 120 repo reads/min. Webhook: 300/min. Event streams: 20 open per person (sessions and machine tokens together), 1,000 hub-wide. Behind Railway, the address is the last `X-Forwarded-For` hop (only with `TRUST_PROXY=1`, which the Dockerfile sets). That is correct only behind exactly one proxy that appends or overwrites the header: Railway's edge, with Cloudflare on DNS only. An IPv6 client is keyed by its /64, so rotating addresses inside it does not dodge a limit. The limiter keeps at most 100,000 keys and never sweeps on every hit.

### Billing

- Checkout and the billing portal are owner-only, CSRF-checked POSTs. The URL the billing module returns is followed only if it is https on `stripe.com` or a subdomain (no open redirect).
- The webhook takes the raw body (never parsed before verification) and the `Stripe-Signature` header to `billing.handleWebhook`, which verifies the HMAC and timestamp. A bad signature is a 400 and changes nothing. Plan, seat and status updates only move forward in Stripe event time, so a late, older event cannot undo a newer one. Each Stripe event id is recorded in the same transaction (`billing_events`), so a redelivery or a replay inside the 5-minute signature window is a no-op, and an event with the same timestamp cannot move a canceled subscription off `canceled`.

### Container

- `node:22-slim`, no npm dependencies, the app directory read-only. The entrypoint starts as root only to `chown` the mounted volume (platform volumes are mounted owned by root), then drops to the unprivileged `node` user with `setpriv --no-new-privs` before the server starts. As root it touches only `HUB_DATA`, and refuses a relative path, `..`, `/`, `/app` or a system directory. `chown -R` does not follow symbolic links.

## Not covered in v0 (known gaps)

- **Encryption at rest** of synced code beyond the platform's disk encryption. No per-team keys.
- **Retention.** The plan's history window hides older rows from every read, but they are not deleted yet. Leaving the team, removing a repo or deleting a team does not purge synced data; there is no team or repo deletion at all yet.
- **Audit log** of who viewed or changed what on the hub.
- **SSO/SAML, 2FA enforcement, or GitHub org membership checks.** Anyone with a GitHub account can sign in and create a team; access to a team's data needs an invite.
- **Session management UI.** No "sign out everywhere"; sessions end at logout or after 30 days.
- **Token scopes and expiry.** Machine tokens have no expiry and no read-only scope; revocation is manual. Workspace tokens have a read or write scope but no expiry.
- **Workspace CPU, what is left.** Diffs, line counts, blame and replays run in worker threads (see Cloud workspaces). Still on the event loop: `git merge-file` for undo and branch (a child process run with `execFileSync`, in git's own C code), reading contents from the ledger and the folder, and sha1 of contents up to 32 MB. The engines themselves (SQLite, the ledger) stay in the main process.
- **Workspace storage is never collected.** Every uploaded version stays in storage and counts toward the quota until garbage collection exists (v1).
- **A team's own bucket, what is left.** After a move, the copy in the store the team left is not deleted (the hub's disk, or the customer's bucket after moving back). An Azure account key is the whole storage account (Shared Key cannot be scoped; SAS and Entra ID are not supported), so docs/storage.md asks for a dedicated account. The move's progress, not its data, is in the hub database; a hub that loses `HUB_SECRET` loses the ability to read the bucket, not the bucket.
- **Workspace history is not in storage.** The storage backend keeps file contents and a manifest; the ledger (`.git/grapim/`) lives only on the volume. A workspace restored from storage has its files but starts a new history.
- **Rate limits across replicas.** Limits are per process. Run one replica (railway.json sets `numReplicas: 1`, which SQLite needs anyway).
- **Storage accounting is approximate.** The per-team quota counts blob bytes and the text in rows, not SQLite overhead or indexes, and a team created before the quota starts from its blob bytes only. Watch the volume's disk use.
- **Open sign-up.** Without `HUB_TEAM_CREATORS`, anyone with a GitHub account can create teams (up to 20 each) and use the per-team quota. Set it for a private beta.
- **Proxy assumption.** Client addresses for rate limits assume exactly one proxy hop (see Rate limits). Check this after each change to the hosting setup.
- **SHA-1 for blob keys** (it matches the local ledger). A collision could only replace content inside the attacker's own team, because blobs are team-scoped and only team members can sync.
- **Malicious synced content.** Content is escaped in HTML and served as JSON, never as a page of its own. A future UI that renders synced Markdown or HTML must sanitise it.
- **Invite tokens in URLs.** The token is in the invite link's path. The hub never logs it and sends no Referer off-site, but the hosting platform's edge logs and the browser history may record it. While a signed-out invitee signs in, the invite path is kept as `next` in the server-side OAuth state row for up to 10 minutes.
- **Provenance is self-attested.** Notes, the GitHub mapping and review approvals come from members' machines (and, for the Action, from whoever can push `refs/notes/grapim`). The App's `require_review` check fails only on recorded lines from unapproved runs: commits without a note pass, and a member can approve their own run. Branch rules must name the Grapim App as the check's source. See docs/security-review-github-reports-2026-11-11.md (M5, M6).
- **Hosted dependencies.** GitHub and Stripe availability; a GitHub outage blocks sign in.
- **Penetration test.** None yet. This document, `docs/security-review-hub-2026-11-11.md`, `test/hub.test.js` and `test/hub-security.test.js` are the review surface.
