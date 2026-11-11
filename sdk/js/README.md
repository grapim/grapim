# @grapim/sdk

Grapim for platforms, in JavaScript and TypeScript. Give every one of your end customers a recorded, reviewable, undoable workspace that your agents write to.

- ESM, zero dependencies, global `fetch`: Node 18+, Deno, Bun.
- Full types in `index.d.ts`.
- The workspace file client and `verifyWebhook` also run in browsers and edge runtimes. The platform client refuses to start in a browser, because a `gpk_` key acts for your whole platform.

The contract is [docs/platform.md](../../docs/platform.md).

## Install

```sh
npm install @grapim/sdk
```

## The platform client (your backend)

```js
import { Grapim } from '@grapim/sdk';

const grapim = new Grapim({ apiKey: process.env.GRAPIM_API_KEY }); // gpk_live_… or gpk_test_…

const ws = await grapim.workspaces.create({ external_id: 'cust_42', name: 'cust-42', metadata: { plan: 'pro' } });

// A token for one workspace, to hand to the agent's sandbox. Shown once.
const { token, expires_at } = await grapim.tokens.create(ws.id, { scope: 'write', ttl_seconds: 900, agent_name: 'fixer' });

// Later: what did the agents do, and take one run back.
const runs = await grapim.runs.list(ws.id);
const plan = await grapim.runs.undo(ws.id, runs[0].run);                  // the plan
await grapim.runs.undo(ws.id, runs[0].run, { apply: true });              // apply it

// Let your customer review inside your app (an iframe URL, single use).
const { url } = await grapim.embedSessions.create(ws.id, { mode: 'review', theme: 'system' });
```

| Resource | Methods |
|---|---|
| `workspaces` | `create(params)`, `list({ external_id?, limit?, starting_after? })`, `get(id)`, `update(id, { name?, metadata? })`, `delete(id)` |
| `tokens` | `create(workspaceId, { scope, ttl_seconds?, agent_name? })`, `revoke(workspaceId, tokenId)` |
| `embedSessions` | `create(workspaceId, { mode, ttl_seconds?, theme? })` |
| `runs` | `list(workspaceId)`, `undo(workspaceId, run, { turn?, apply? })` |
| `usage` | `get({ from?, to?, group_by? })` (a `Date` becomes `YYYY-MM-DD`, UTC) |
| `webhooks` | `create({ url, events })`, `list()`, `delete(id)` |
| `settings` | `update({ embed_allowed_origins?, workspace_storage_mb?, storage? })` (`storage`: your own S3, R2, GCS or Azure bucket, live keys only; `null` moves back to the hub's storage) |

Request and response bodies keep the API's own snake_case names. Every method takes a last argument `{ signal?, idempotencyKey? }`.

Options: `new Grapim({ apiKey, baseUrl = 'https://app.grapim.com', fetch, maxAttempts = 3, timeoutMs = 60000, baseDelayMs = 500, maxDelayMs = 8000, maxRetryAfterMs = 60000, headers })`. `apiKey` defaults to `process.env.GRAPIM_API_KEY`.

### Pagination

A list call is awaitable (the first page) and async-iterable (every page):

```js
const page = await grapim.workspaces.list({ limit: 20 });   // { data, has_more }
for await (const ws of grapim.workspaces.list()) console.log(ws.id);
const all = await grapim.webhooks.list().toArray({ max: 500 });
```

### Retries and idempotency

- Every POST sends an `Idempotency-Key` (a UUID, or yours via `{ idempotencyKey }`), and the same key is reused on every retry, so a create whose response got lost is not done twice.
- 429 and 503 are retried; other 5xx and network errors are retried when the request is safe to repeat (GET, PUT, PATCH, DELETE, or a POST with an Idempotency-Key). That is at most 3 attempts.
- `Retry-After` (seconds or a date) is honoured. Without it, the wait is jittered exponential backoff.

### Errors

Everything throws a `GrapimError` with `code` (the API's, e.g. `not_found`, `idempotency_mismatch`), `status` and `requestId`. Subclasses by status: `AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError` (404), `ConflictError` (409), `PreconditionFailedError` (412, with `currentSha`) and `RateLimitError` (429). There is also `ConnectionError` (no response) and `WebhookSignatureError`.

The SDK never logs. Keys and tokens live in private fields, so they don't show up in `console.log`, `util.inspect` or `JSON.stringify` of a client.

## The workspace file client (the agent, in its sandbox)

It only needs the workspace URL and a `gws_` token. Never give the sandbox your `gpk_` key.

```js
import { Grapim, PreconditionFailedError } from '@grapim/sdk';

const ws = Grapim.workspace({ url: process.env.GRAPIM_WORKSPACE_URL, token: process.env.GRAPIM_WORKSPACE_TOKEN, agent: 'fixer', intent: 'Fix the login bug' });

const { content, sha } = await ws.read('src/login.js');     // Uint8Array + sha1 (the ETag)
try {
  await ws.write('src/login.js', patched, { ifMatch: sha });  // only if nobody wrote in between
} catch (e) {
  if (e instanceof PreconditionFailedError) { /* e.currentSha: read again, merge, retry */ }
}
await ws.write('NOTES.md', 'new file', { ifMatch: 'absent' });  // only if it does not exist yet
await ws.delete('old.txt', { ifMatch: someSha });
await ws.list('src');                                       // one folder: [{ name, path, type, size, … }]
await ws.list('', { recursive: true });                     // { files, truncated }
await ws.blame('src/login.js');
await ws.runs();
await ws.undo(run, { turn: 2, apply: true });               // needs a write token
await ws.release();                                         // writes keep their claim until this
```

`url` can be the workspace's `url`, `fs_url` or `mcp_url`. `ifMatch` takes a sha (quoted or not), `'absent'`, or `null` (also meaning absent). It also works against a local `grapim serve` with its `GRAPIM_TOKEN`.

## Webhooks

```js
import { verifyWebhook, WebhookSignatureError } from '@grapim/sdk';

// rawBody: the bytes exactly as received (a Buffer or string), not parsed JSON.
const event = await verifyWebhook(rawBody, req.headers['grapim-signature'], process.env.GRAPIM_WEBHOOK_SECRET, { tolerance: 300 });
```

It checks `Grapim-Signature: t=<unix>,v1=<hex hmac-sha256 of "t.body">` with the endpoint secret, in constant time (Web Crypto, or node:crypto when there's no global crypto). It accepts any one of several `v1=` values (for secret rotation), refuses timestamps more than `tolerance` seconds away in either direction (`0` turns that off), and returns the parsed event. Anything else throws a `WebhookSignatureError` with `code` set to `invalid_header`, `invalid_signature`, `timestamp_out_of_tolerance`, `invalid_body` or `invalid_secret`.

See [../examples](../examples) for a full sandbox flow and a receiver.

## Tests

```sh
node --test "sdk/js/test/*.test.js"     # or, from the repo root: npm run test:sdk
```

The tests run against an in-process fake of `/v1` and the workspace endpoints (`test/fake-server.js`).
