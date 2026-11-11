# Grapim for platforms: contract v0

This is for companies that run AI agents for their own customers: background coding agent products, sandbox providers (E2B- or Modal-style), and enterprise agent platforms. They embed Grapim so that every one of their end customers gets a recorded, reviewable, undoable workspace without building it themselves. The model is the one Neon and Supabase follow with agent platforms.

This file is shared by three builders: the platform API (hub), the SDKs, and the embedded review desk. Change it only by editing this file and saying so.

## Concepts

- **Platform**: a hub team with `kind = 'platform'`. Its owner creates platform API keys in the hub UI.
- **Workspace**: the same cloud workspace as in docs/workspaces.md. For platforms, a workspace carries an `external_id` (the platform's own id for its end customer or session, unique per platform) and free-form `metadata` (JSON, up to 4 KB).
- **Platform API key** `gpk_live_…` (or `gpk_test_…` for test mode, which never bills): stored as sha256, shown once, revocable, with last used at. A key acts for the whole platform, so treat it like a database password.
- **Scoped workspace token** `gws_…`: minted through the API for one workspace, with scope `read|write` and a TTL (default 1 h, maximum 30 days). It's what the platform hands to an agent running in a sandbox. These are the same tokens as docs/workspaces.md, plus `expires_at`.

## REST API, base `https://<hub>/v1`, header `Authorization: Bearer gpk_…`

JSON in and out. Errors use `{ "error": { "code", "message", "request_id" } }`. Every response has a `Request-Id` header. POSTs accept an `Idempotency-Key` header: the same key with the same body within 24 h returns the stored response, and the same key with a different body gets 409 `idempotency_mismatch`. Lists use cursor pagination: `?limit=50&starting_after=<id>` returns `{ "data": [...], "has_more" }`.

| Method and path | What it does |
|---|---|
| `POST /v1/workspaces` | `{ external_id?, name?, metadata?, template? }` creates a workspace. `template` is `blank` (default), `agent-team`, `research` or `data` (docs/workspaces.md 1b). Returns the workspace object |
| `GET /v1/workspaces` | List, filter `?external_id=` |
| `GET /v1/workspaces/:id` | One workspace: `{ id, object: "workspace", external_id, name, metadata, created_at, expires_at, url, mcp_url, fs_url, usage: { bytes, writes_30d } }` |
| `PATCH /v1/workspaces/:id` | Update `name` and `metadata` |
| `DELETE /v1/workspaces/:id` | Soft delete |
| `POST /v1/workspaces/:id/tokens` | `{ scope: "read"|"write", ttl_seconds?, agent_name?, scopes? }` returns `{ token, expires_at, scope, scopes }`, shown once. `agent_name` pins the run identity (`http:<token-name>/<agent_name>`); `scopes` limits the token to some folders (docs/workspaces.md 1a) |
| `DELETE /v1/workspaces/:id/tokens/:token_id` | Revoke a token |
| `POST /v1/workspaces/:id/embed_sessions` | `{ ttl_seconds? (default 600, max 3600), mode: "review"|"readonly", theme?: "light"|"dark"|"system" }` returns `{ url, expires_at }`. `url` opens the review desk for that workspace with no Grapim login. It is single-use to establish an embed cookie scoped to that workspace path, and can be framed only by the platform's allowed origins |
| `GET /v1/workspaces/:id/runs` | The same run objects as docs/api.md `/api/runs` (convenience proxy) |
| `POST /v1/workspaces/:id/runs/:run/undo` | `{ turn?, apply }`, as docs/api.md |
| `GET /v1/usage?from=&to=&group_by=workspace|day` | `{ data: [{ workspace_id, external_id, day, writes, api_calls, storage_byte_days, active }] }` |
| `POST /v1/webhook_endpoints` | `{ url (https only), events: [...] }` returns `{ id, secret }` (`whsec_`-style, shown once) |
| `GET/DELETE /v1/webhook_endpoints[/:id]` | List or delete |
| `GET/PUT /v1/settings` | The settings of the key's own mode: `{ embed_allowed_origins: ["https://app.example.com"], workspace_storage_mb: 512 }`. The origins are used for `frame-ancestors` |

## Webhooks

- **Events**: `workspace.created`, `workspace.deleted`, `run.started` (the first change of a run), `run.updated` (debounced: at most once per run per 30 s), `run.reviewed`, `run.undone`, `edit.blocked` (a claim conflict), `file.restored`.
- **Payload**: `{ id: "evt_…", type, created, workspace: { id, external_id }, data: {...} }`.
- **Signature**: header `Grapim-Signature: t=<unix>,v1=<hex hmac-sha256 of "t.body" with the endpoint secret>`. The SDKs ship a `verifyWebhook(body, header, secret, tolerance=300)`.
- **Delivery**: a durable outbox table, retried with exponential backoff for up to 24 h (about 8 attempts). An endpoint that fails for 3 days in a row is disabled, and the platform is told on its settings page. Delivery uses a 10 s timeout, follows no redirects, and refuses private and loopback addresses (SSRF), including after DNS resolution. Delivery is fair between platforms: one platform's slow endpoints never hold up another's webhooks (see "As built").

## Metering and pricing (usage-based)

- **What is metered per workspace per day**: `writes` (recorded changes), `api_calls`, `storage_byte_days` (sampled daily) and `active` (a workspace with at least one write that day).
- **Prices** live in one table in billing.js, so they're easy to change:
  - $0.50 per active workspace-month (a workspace with writes in the month);
  - $0.10 per 1,000 writes;
  - $0.10 per GB-month of storage;
  - a $500 monthly platform minimum on live keys.
  - Test keys are free, small and short-lived: per platform 25 workspaces, 2,000 writes a day and 100 MB, and each test workspace is deleted 7 days after it was created. Test mode is for building and CI, not for serving customers.
- **Stripe**: report usage through Stripe Billing Meters (`POST /v1/billing/meter_events`) from a daily job, idempotent per (platform, day, meter). It only runs when `STRIPE_SECRET_KEY` and the meter ids are configured; otherwise usage is just recorded and visible.

## Embedding the review desk

- An embed session URL sets a cookie scoped to `/w/<team>/<ws>/`, with `SameSite=None; Secure; Partitioned`, so it works in third-party iframes.
- `frame-ancestors` is the platform's allowed origins.
- `?embed=1` mode in the UI:
  - no sidebar or workspace switcher;
  - the theme follows `theme`;
  - it sends `postMessage` events to the parent: `grapim:ready`, `grapim:run-opened {run}`, `grapim:run-reviewed {run,status}`, `grapim:undone {run,files}` (the target origin is the embedding origin passed in the session, never `*`).
- `mode=readonly` hides undo, restore, review and branch, and the server enforces that too.

**As built (ui/embed.js)**:
- **Meta tags.** The hub injects `<meta name="grapim-embed-origin" content="https://app.example.com">` and `<meta name="grapim-embed-mode" content="review|readonly">`. The origin must be a bare origin. If it's missing or malformed, the desk sends nothing and ignores navigate messages.
- **Mode strictness.** Any mode other than `review` is treated as readonly. `/api/overview` may also return `embed: { mode, origin }`, and it can only make the desk stricter; if its origin differs from the meta, messaging turns off.
- **Messages.** Each one is a flat `{ type, ...fields }` object.
  - The desk sends `grapim:ready {view, mode}`, `grapim:run-opened {run, label}`, `grapim:run-reviewed {run, status}`, `grapim:undone {run, turn, files}` and `grapim:height {px}`.
  - `ready` always comes first. `run-reviewed` and `undone` are sent only after the server confirms.
  - The desk accepts `grapim:navigate {view, run?, path?, filter?}` only from the embedding origin and `window.parent`.
- **Auto-height.** Hosts that size the iframe from `grapim:height` must add the iframe's own border to `px`.
- **Branding.** A "Powered by Grapim" link sits in the footer, and `&brand=0` removes it, in live mode only.
- **Test mode.** A desk opened from a test key's session carries a "TEST MODE" banner drawn by the page the hub serves (with `<meta name="grapim-embed-test" content="1">`), and always shows the branding, whatever the URL says.
- **Demo page.** `ui/embed-demo.html` is for local testing (`node ui/dev-server.mjs`) and must not be served by the hub.

## SDKs

- **TypeScript** `@grapim/sdk` in `sdk/js/`: ESM, zero dependencies, fetch-based, typed with JSDoc and `.d.ts`.
- **Python** `grapim` in `sdk/python/`: standard library only (`urllib`), Python 3.9+.
- **Both cover**:
  - `workspaces.create/list/get/update/delete`;
  - `tokens.create/revoke`;
  - `embedSessions.create`;
  - `runs.list/undo`;
  - `usage.get`;
  - `webhooks.create/list/delete`;
  - `verifyWebhook`;
  - a workspace file client for agents holding a `gws_` token: `read`, `write` (with If-Match), `delete`, `list`, `blame`;
  - automatic `Idempotency-Key` on creates;
  - retries on 429 and 5xx with backoff;
  - typed errors.

## As built (platform API, hub, 2026-11-11)

Code: `src/hub/platform/` (`api.js` routes and pipeline, `openapi.js`, `keys.js`, `embeds.js`, `webhooks.js`, `ssrf.js`, `metering.js`, `events.js`, `pages.js`, `schema.js`). Tests: `test/platform.test.js`. Quickstart: `docs/platform-quickstart.md`.

- **Turning a team into a platform**: an owner does it on `/hub/teams/<team>/platform`. While `HUB_TEAM_CREATORS` is set, only those accounts can (closed beta). It cannot be turned back in the beta. Keys, embedding origins, the webhook deliveries log and the usage page are owner only.
- **Keys**: `gpk_live_<43>` and `gpk_test_<43>`, at most 20 live per platform. A key acts as the owner who created it, and stops working if that person leaves the team or stops being an owner.
- **Modes**:
  - A test key sees only test workspaces, test webhook endpoints and test usage; a live key sees only live ones. Workspaces made in the hub UI are live.
  - Settings belong to a mode too (changed 2026-11-11, security review M6): `GET` and `PUT /v1/settings` read and change only the calling key's mode, so a test key handed to CI cannot change what frames the live desk. The reply is `{ object: "platform_settings", livemode, embed_allowed_origins, workspace_storage_mb }`. `PUT` takes either field or both. An embed session uses the origins of the mode of the key that created it. The hub page edits each mode's origins separately. Platforms from before the split start with their shared origins in both modes.
  - `external_id` is unique per platform **and mode** among non-deleted workspaces (409 `external_id_taken`). It is free again once its workspace is deleted.
- **Objects and times**:
  - Every timestamp (`created_at`, `expires_at`, the webhook `created`) is in Unix seconds.
  - `PATCH` replaces `metadata` whole (no merge). It is at most 4 KB as JSON.
  - `name` is optional on create; `ws-<10 characters>` is generated.
  - The workspace object also has `livemode`, and `expires_at`: when a test workspace is deleted (7 days after `created_at`), null for live ones.
  - Deletes return `{ id, object, deleted: true }`.
- **Lists**:
  - The shape is `{ object: "list", data, has_more }`. `limit` is 1 to 100, default 50 (usage: up to 1,000, default 100).
  - `starting_after` is the last item's `id`: `run` for runs, `<day>|<workspace_id>` for usage rows. An unknown cursor is a 400, never a silent restart.
  - Workspaces are listed newest first.
- **Errors**: `{ error: { code, message, request_id } }`, where `request_id` equals the `Request-Id` header. The codes:
  - 401 `unauthorized`;
  - 404 `not_found`, also for every object of another platform or mode;
  - 400 `invalid_request`, and `url_not_allowed`, `url_invalid`, `url_unresolvable` for webhook URLs;
  - 409 `idempotency_mismatch`, `idempotency_in_progress`, `external_id_taken`, `conflict`;
  - 429 `rate_limited` (with `Retry-After`) and `test_mode_limit`;
  - 413 `storage_limit`, and `too_large` when comparing a run's or an undo's contents line by line takes over 2 s (the hub's compute budget per request, docs/security.md);
  - 503 `busy` (with `Retry-After`).
- **Rate limits**: each key has a token bucket of 50 that refills at 20 a second, in memory (per process). Per client address, /v1 allows 6,000 requests a minute instead of the hub's 600, and so do `/w/` requests with a `gws_` token (sandboxes share egress addresses); there, only unknown, revoked or expired tokens count toward the 240 a minute per address, and each valid token has its own 600 a minute.
- **Idempotency**:
  - `Idempotency-Key` on POSTs, 1 to 255 printable ASCII characters, keyed per platform and mode (test and live keys never share one). The stored request hash covers the mode, method, path and body.
  - Replies, 4xx refusals included, are kept 24 h, sealed with AES-256-GCM under a key derived from `HUB_SECRET` and bound to the platform and key, so a replayed token creation returns the same token. A replay carries `Idempotent-Replayed: true`.
  - At most 36,000 new keys an hour per platform; past that, 429 `rate_limited` (stored keys still replay).
  - 5xx and 429 replies are not kept.
- **Tokens**:
  - Body `{ scope, ttl_seconds? (60 to 2,592,000, default 3,600), agent_name? ([A-Za-z0-9._-]{1,60}), name?, scopes? }`. Reply `{ id, object: "workspace_token", token, scope, scopes, name, agent_name, expires_at }`.
  - `scopes`: at most 32 `{ path, access }` rules, e.g. `[{ "path": "docs/**", "access": "read" }, { "path": "docs/drafts/**", "access": "write" }]`. Outside them the token gets 404 on reads and 403 on writes; the most specific rule wins. A read token cannot have write rules. Bad rules are 400 `invalid_request`. Absent or `[]`: the whole workspace (`scopes: null` in the reply). Rules are in docs/workspaces.md 1a.
  - With `agent_name`, every run of the token is `http:<name>/<agent_name>`, over `/fs` and MCP, and `X-Grapim-Agent` is ignored.
  - An expired token gets 401, like a revoked one. Tokens made in the hub UI have no `expires_at` and never expire.
  - Expired tokens do not count toward the 50 live tokens per workspace.
- **Undo through /v1** acts as `api:<key name>`.
- **Embed sessions**:
  - The body adds:
    - `parent_origin?`: one of `embed_allowed_origins`, required when there are several;
    - `user?`: names the reviewer as `human:embed:<user>` (else `human:embed:<session id>`);
    - `branding?`: false adds `&brand=0`. In test mode it is refused (400): a test desk always says Grapim.
  - The reply is `{ id, object: "embed_session", url, expires_at, mode, theme, parent_origin, branding }`.
  - The link is `<hub>/hub/embed/<id>.<secret>.<hmac>`: HMAC-signed with `HUB_SECRET`, with the secret stored as sha256. It works once, until `expires_at`, and answers 410 after that.
  - Opening the link answers 303 to `/w/<team>/<name>/?embed=1&theme=<theme>&mode=<mode>[&brand=0]` and sets the cookie:
    - named `__Secure-grapim_embed` (`grapim_embed` on plain-http localhost);
    - with `Path=/w/<team>/<name>/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=<ttl_seconds>`;
    - lasting `ttl_seconds` from the moment the link is opened.
  - The cookie works for that workspace only: on another path, workspace or platform it counts as absent (401). It stops when the workspace is deleted, the team stops being a platform, or its `parent_origin` is taken off `embed_allowed_origins` (which also voids its unused links: the way to end sessions early).
  - `embed_allowed_origins` are plain origins: a DNS name, IPv4 or [IPv6] host, no wildcards.
  - At most 36,000 embed sessions an hour per platform (429 `rate_limited`).
  - The desk's HTML for an embed session gets `frame-ancestors <parent_origin>` and no `X-Frame-Options`, plus the meta tags `grapim-embed-origin`, `grapim-embed-mode` and `grapim-embed-theme`.
  - Every other response keeps `frame-ancestors 'none'`: the same desk for a hub session, and all API, file and MCP responses. `/api/overview` does not carry `embed` yet.
  - The desk's writes need `X-Grapim-Csrf` (sent back on every workspace response) and the hub's own origin, as for a hub session.
  - `readonly` refuses every act route (undo, restore, review, branch) with 403.
  - No embed session can write files over `/fs` or call MCP write tools, in either mode: it is a person reviewing, not an agent.
  - `ui/embed-demo.html` is never served under `/w/` (404).
- **Webhooks**:
  - The reply to `POST /v1/webhook_endpoints` adds `secret`, once. `GET /v1/webhook_endpoints/:id` exists too. A platform can have at most 16 endpoints per mode. `events` may be `["*"]`.
  - The HMAC key is the whole `whsec_...` string as UTF-8. The hub sends one `v1=` (no rotation yet), plus the headers `Grapim-Event-Id` and `Grapim-Delivery-Id`. Delivery is at least once: deduplicate on the event `id`.
  - The payload adds `object: "event"` and `livemode`. Each event's `data`:
    - `workspace.created`: `{ workspace }`;
    - `workspace.deleted`: `{ workspace, reason }`, where `reason` is `"deleted"` (by the API or the hub UI) or `"test_expired"` (a test workspace at 7 days);
    - `run.started`: `{ run, label, path, started_at }`;
    - `run.updated`: `{ run, label, files, edits, added, removed, last_change_at }`;
    - `run.reviewed`: `{ run, status, note, by }`;
    - `run.undone`: `{ run, files, by }`;
    - `edit.blocked`: `{ agent, path, reason }`;
    - `file.restored`: `{ path, sha, run, by }`.
  - A run's first change sends `run.started`. Later changes within 30 s fold into one trailing `run.updated` with the latest totals.
  - In `run.undone`, `run` is null when the hub cannot tell which run was undone (for example, an undo outside an HTTP request).
  - Undo and restore changes do not start runs of their own in webhooks.
  - Failed deliveries are retried after 1 min, 5 min, 30 min, 1 h, 3 h, 6 h and 13 h: 8 attempts over about 24 h.
  - Fair delivery (security review M9): at most 2 deliveries of one platform are in flight at once, and 16 in all. Each free slot goes to the next platform in turn (round robin), and every delivery that ends starts the next one, so nothing waits for a batch.
  - Each attempt has 10 s in all (DNS included). An endpoint whose delivery times out is paused for 1 min, then 2, 4, and so on up to 1 h while it keeps timing out; its other deliveries wait meanwhile (they are not failed), and any answer ends the pause. A hanging endpoint therefore holds at most its own platform's 2 slots, for one delivery each.
  - An endpoint whose deliveries keep failing, with no success for 3 days, is disabled, and the platform page says so. To start over, delete it and create it again.
  - SSRF protection:
    - https only, with no user name or password;
    - no `localhost`, `*.localhost`, `*.local` or `*.internal` host (a trailing dot is ignored), and no name without a dot;
    - every address the name resolves to must be public, checked at creation and again at every attempt;
    - refused addresses: loopback, RFC 1918, CGNAT, link-local (169.254.169.254 included), ULA (fd00:ec2::254 included), documentation and multicast ranges, the IPv4-mapped, NAT64 and 6to4 forms of those, and all of `::/96` (IPv4-compatible), `::ffff:0:0:0/96` (SIIT) and `64:ff9b:1::/48` (local-use NAT64);
    - names are resolved with c-ares (A and AAAA, not getaddrinfo, so a slow zone cannot hold the hub's threadpool), within 5 s;
    - the connection goes to the checked address, with TLS for the host name;
    - no redirects, a 10 s limit, and replies read up to 64 KB.
  - Signing secrets are stored sealed (AES-256-GCM, key derived from `HUB_SECRET`, bound to the endpoint and platform). Only events some endpoint wants are kept in the outbox. Rotating `HUB_SECRET` makes existing endpoints undeliverable: their deliveries fail with "cannot sign".
- **Metering**:
  - `writes` are the workspace ledger's recorded changes, undo and restore changes included.
  - `api_calls` are every `/w/` request to the workspace plus every `/v1` call about it.
  - Storage is sampled once a UTC day from the measured folder size.
  - Only platform teams are metered. A workspace's history from before its team became a platform is not counted.
- **`GET /v1/usage`**:
  - `from` and `to` are `YYYY-MM-DD` (UTC). The default is this month up to today; the range is at most 93 days, and at most 100,000 rows (one per workspace per day): past that, 400, ask for fewer days.
  - Without `group_by`, rows are per workspace per day, and `active` is a boolean.
  - `group_by=workspace` sums per workspace: `day` is null, and `active` is true if any day had a write.
  - `group_by=day` sums per day: `workspace_id` is null, and `active` is the number of active workspaces.
- **Test mode** (security review M10). Test keys never bill, so test mode is kept small and short-lived:
  - 25 non-deleted test workspaces per platform, and 2,000 test writes per platform per UTC day. Past either, 429 `test_mode_limit`; reads keep working. Every write counts: each write tool of an MCP batch on its own (a batch that would pass the cap is refused whole), and an applied undo through `/v1` (refused at the cap, like the storage limits below).
  - 100 MB of storage for all of the platform's test workspaces together; past it, 413 `storage_limit`.
  - Each test workspace is deleted (softly, as `DELETE` does) 7 days after it was created, within the hour, with a `workspace.deleted` webhook whose `reason` is `"test_expired"`. The workspace object's `expires_at` says when.
  - An embedded test desk shows a "TEST MODE" banner and cannot hide the branding.
- **Storage** (security review M11):
  - A platform team has its own quota, `PLATFORM_STORAGE_MB` (default 20480), instead of the per-team `HUB_TEAM_STORAGE_MB`. It counts the same bytes: every workspace's files, `.git` and ledger, and every version uploaded to storage.
  - Each workspace also has its own limit, `workspace_storage_mb` in the settings of its mode (default 512, at most the platform's quota), set with `PUT /v1/settings`. It does not depend on anything in the workspace, `metadata` included, so an end customer cannot raise it. It counts the workspace's folder and the versions uploaded to storage for it.
  - A write past either answers 413 `storage_limit` and writes nothing; the workspace limit's message names the workspace (`<name> (<id>)`). Writes are admitted before their body is read, as for every workspace.
  - The hub page `/hub/teams/<team>/platform/usage` shows the quota used and the 100 largest workspaces against their limit.
- **Prices** are `PLATFORM_PRICES` in `src/hub/billing.js`. The hub page `/hub/teams/<team>/platform/usage` shows the month to date and the estimate: live only, with the $500 minimum included.
- **Stripe Billing Meters**:
  - A daily job sends `POST /v1/billing/meter_events` for every platform team with a Stripe customer, for each of the last 3 finished UTC days, to three meters:
    - `STRIPE_METER_WRITES`: the writes that day;
    - `STRIPE_METER_ACTIVE_WORKSPACES`: the workspaces whose first write of the month was that day, so the monthly sum is active workspace-months;
    - `STRIPE_METER_STORAGE`: MiB-days, as a whole number.
  - The identifier and the Idempotency-Key are both `grapim-<team>-<day>-<meter>`. Sent reports are recorded, so each is sent once.
  - It runs only when `STRIPE_SECRET_KEY` and all three meter variables are set.
  - The $500 minimum is not a meter: set it up in Stripe's price.
- **OpenAPI**: `GET /v1/openapi.json` is public, and is built from the same table that registers the routes.
