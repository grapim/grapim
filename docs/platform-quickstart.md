# Grapim for platforms: quickstart

In about 10 minutes you will give one of your customers a recorded, reviewable, undoable workspace. You will let an agent in a sandbox write to it, undo what the agent did, show your customer the review desk inside your own app, and receive a signed webhook.

This guide uses `curl`. The TypeScript SDK (`sdk/js`) and the Python SDK (`sdk/python`) wrap the same calls. The full contract is in `docs/platform.md`. The machine-readable API description is at `https://app.grapim.com/v1/openapi.json`.

```sh
export HUB=https://app.grapim.com
```

## 1. Create a key

Platforms are in a closed beta, so first ask us to enable your GitHub account. Then:

1. Sign in at `$HUB/hub` and open your team.
2. In **Settings**, scroll to **Platform** and choose **Turn into a platform**.
3. In the **Platform** tab, under **API keys**, create a **test** key. Copy it now: it is shown once.

```sh
export GRAPIM_KEY=gpk_test_...
```

Test keys are free, and made for building and CI, not for serving customers. A test key sees only test objects and has its own settings. Per platform, test mode allows 25 workspaces, 2,000 writes a day and 100 MB; each test workspace is deleted 7 days after it was created (its `expires_at` says when), and an embedded test desk shows a "TEST MODE" banner. Switch to a `gpk_live_` key when you go to production. Keep keys on your servers only: a key can do anything to every workspace of your platform.

## 2. Create a workspace for an end customer

```sh
curl -s $HUB/v1/workspaces \
  -H "Authorization: Bearer $GRAPIM_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: create-cust_42" \
  -d '{"external_id":"cust_42","metadata":{"plan":"pro"}}'
```

```json
{
  "id": "Xc2f...",
  "object": "workspace",
  "external_id": "cust_42",
  "name": "ws-8k2m1q0z7a",
  "metadata": { "plan": "pro" },
  "livemode": false,
  "created_at": 1794350000,
  "url": "https://app.grapim.com/w/<team>/ws-8k2m1q0z7a/",
  "mcp_url": "https://app.grapim.com/w/<team>/ws-8k2m1q0z7a/mcp",
  "fs_url": "https://app.grapim.com/w/<team>/ws-8k2m1q0z7a/fs/",
  "usage": { "bytes": 4210, "writes_30d": 0 }
}
```

- `external_id` is your own id for the customer or session.
- Sending the same `Idempotency-Key` again within 24 hours returns this same workspace instead of a second one, so a retry is always safe.
- To find the workspace later, use `GET /v1/workspaces?external_id=cust_42`.

```sh
export WS=Xc2f...   # the id
export FS=https://app.grapim.com/w/<team>/ws-8k2m1q0z7a/fs   # fs_url, without the trailing slash
export MCP_URL=https://app.grapim.com/w/<team>/ws-8k2m1q0z7a/mcp
```

## 3. Mint a token for an agent sandbox

```sh
curl -s $HUB/v1/workspaces/$WS/tokens \
  -H "Authorization: Bearer $GRAPIM_KEY" \
  -H "Content-Type: application/json" \
  -d '{"scope":"write","ttl_seconds":3600,"agent_name":"sandbox-1","name":"e2b"}'
```

```json
{ "id": "tK9...", "object": "workspace_token", "token": "gws_...", "scope": "write", "name": "e2b", "agent_name": "sandbox-1", "expires_at": 1794353600 }
```

- Pass `token` into the sandbox, for example as `GRAPIM_WORKSPACE_TOKEN`. It works for this one workspace only, until `expires_at`.
- `agent_name` pins the identity: everything this token writes is recorded as the run `http:e2b/sandbox-1`, whatever the agent claims.
- To cut the agent off early, revoke the token with `DELETE /v1/workspaces/$WS/tokens/tK9...`.

```sh
export GRAPIM_WORKSPACE_TOKEN=gws_...
```

## 4. Write and read files (from the sandbox)

Over HTTPS:

```sh
curl -s -X PUT $FS/src/app.py \
  -H "Authorization: Bearer $GRAPIM_WORKSPACE_TOKEN" \
  --data-binary $'print("hello")\n'

curl -s $FS/src/app.py -H "Authorization: Bearer $GRAPIM_WORKSPACE_TOKEN"
```

- `GET` returns an `ETag`.
- To avoid overwriting someone else's change, send `If-Match: "<etag>"` on the next `PUT`. If the file changed in between, the `PUT` gets a 412 and writes nothing.

Over MCP (Claude Code shown; any MCP client works):

```sh
claude mcp add --transport http workspace $MCP_URL \
  --header "Authorization: Bearer $GRAPIM_WORKSPACE_TOKEN"
```

## 5. List runs

```sh
curl -s "$HUB/v1/workspaces/$WS/runs?limit=20" -H "Authorization: Bearer $GRAPIM_KEY"
```

```json
{ "object": "list", "data": [ { "run": "http:e2b/sandbox-1", "files": 1, "added": 1, "removed": 0, "review": { "status": "pending" } } ], "has_more": false }
```

To get the next page, pass `starting_after=<the last run>`. Every `/v1` list pages the same way.

## 6. Undo a run

Plan first, then apply:

```sh
RUN=$(printf 'http:e2b/sandbox-1' | jq -sRr @uri)
curl -s $HUB/v1/workspaces/$WS/runs/$RUN/undo -H "Authorization: Bearer $GRAPIM_KEY" -H "Content-Type: application/json" -d '{"apply":false}'
curl -s $HUB/v1/workspaces/$WS/runs/$RUN/undo -H "Authorization: Bearer $GRAPIM_KEY" -H "Content-Type: application/json" -d '{"apply":true}'
```

- The undo is recorded as a change of its own, so it can be undone too.
- If a later edit touched the same lines, Grapim merges and keeps that later edit.

## 7. Embed the review desk in your app

Allow your app's origin once. Settings belong to the key's mode: this sets the test origins, and the live key sets the live ones (step 9).

```sh
curl -s -X PUT $HUB/v1/settings \
  -H "Authorization: Bearer $GRAPIM_KEY" -H "Content-Type: application/json" \
  -d '{"embed_allowed_origins":["https://app.example.com"]}'
```

Then, each time a signed-in customer opens the review screen, your server creates a session:

```sh
curl -s $HUB/v1/workspaces/$WS/embed_sessions \
  -H "Authorization: Bearer $GRAPIM_KEY" -H "Content-Type: application/json" \
  -d '{"mode":"review","theme":"system","user":"dana@customer.com","ttl_seconds":600}'
```

```json
{ "id": "es_...", "object": "embed_session", "url": "https://app.grapim.com/hub/embed/es_...", "expires_at": 1794350600, "mode": "review", "theme": "system", "parent_origin": "https://app.example.com", "branding": true }
```

Put `url` straight into an iframe on `https://app.example.com`:

```html
<iframe src="https://app.grapim.com/hub/embed/es_..." style="width:100%;height:720px;border:0"></iframe>
```

- **Single use.** The link works once, before `expires_at`. Opening it sets a cookie for this workspace only, valid for `ttl_seconds`. Create a new session each time the screen opens.
- **Readonly mode.** With `"mode":"readonly"`, the desk hides undo, restore, review and branch, and the server refuses them too.
- **Branding.** `"branding":false` removes the "Powered by Grapim" link, with a live key. In test mode it is refused, and the desk shows a "TEST MODE" banner.
- **Events.** The desk sends `postMessage` events (`grapim:ready`, `grapim:run-opened`, `grapim:run-reviewed`, `grapim:undone`, `grapim:height`) to your origin only. See "Embedding the review desk" in `docs/platform.md`.

## 8. Receive a webhook

```sh
curl -s $HUB/v1/webhook_endpoints \
  -H "Authorization: Bearer $GRAPIM_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://api.example.com/grapim/webhook","events":["run.started","run.updated","run.reviewed","run.undone"]}'
```

The reply has `secret` (`whsec_...`), shown once. Each delivery is a `POST` of JSON like this:

```json
{ "id": "evt_...", "object": "event", "type": "run.started", "created": 1794350100, "livemode": false,
  "workspace": { "id": "Xc2f...", "external_id": "cust_42" },
  "data": { "run": "http:e2b/sandbox-1", "label": "sandbox-1", "path": "src/app.py", "started_at": 1794350100 } }
```

It comes with the header `Grapim-Signature: t=<unix>,v1=<hex>`. Check it before trusting the body. The signature is the HMAC-SHA256 of `<t>.<raw body>`, keyed with the whole `whsec_...` string:

```js
import crypto from 'node:crypto';

function verifyWebhook(rawBody, header, secret, tolerance = 300) {
  const t = /t=(\d+)/.exec(header)?.[1];
  const sigs = [...header.matchAll(/v1=([0-9a-f]{64})/g)].map((m) => m[1]);
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > tolerance) return false;
  const want = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return sigs.some((s) => crypto.timingSafeEqual(Buffer.from(s, 'hex'), want));
}
```

The SDKs ship this as `verifyWebhook`.

- **Answering.** Answer with any 2xx within 10 seconds. Anything else is retried with backoff for about 24 hours.
- **Duplicates.** Delivery is at least once, so deduplicate on `id`.
- **Disabling.** An endpoint that fails for 3 days in a row is disabled. The **Platform → Webhooks** page in the hub shows every recent delivery.
- **Allowed URLs.** Webhook URLs must be https on a public address.

## 9. Usage and going live

```sh
curl -s "$HUB/v1/usage?group_by=workspace" -H "Authorization: Bearer $GRAPIM_KEY"
```

This returns writes, API calls, storage byte-days and whether each workspace was active this month. **Platform → Usage** in the hub shows the month to date and the estimated bill: $0.50 per active workspace-month, $0.10 per 1,000 writes, $0.10 per GB-month, and a $500 monthly minimum on live keys.

To go live:

1. Create a `gpk_live_` key.
2. Point your servers at it.
3. Set your origins again with it (`PUT /v1/settings`, as in step 7): test and live settings are separate, so a test key in CI can never change what frames your live desk.
4. Create the webhook endpoints again in live mode: test and live endpoints are separate.

Each workspace may store 512 MB by default (files, history and stored versions). Change it with `PUT /v1/settings` and `{"workspace_storage_mb": 1024}`. A write past it gets 413 `storage_limit` naming the workspace, so one customer's agent cannot fill your platform for the others.
