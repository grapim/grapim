# Grapim platform SDKs

These are for platforms that run AI agents for their own customers and embed Grapim, so that every end customer gets a recorded, reviewable, undoable workspace. The API contract is [docs/platform.md](../docs/platform.md).

| | Package | Docs |
|---|---|---|
| JavaScript / TypeScript | `@grapim/sdk` | [js/README.md](js/README.md) |
| Python | `grapim` | [python/README.md](python/README.md) |

Both SDKs:

- have the same surface;
- have no dependencies;
- send an automatic `Idempotency-Key` on POSTs;
- retry 429 and 5xx with backoff, at most 3 attempts;
- raise typed errors;
- use cursor-pagination iterators;
- include a workspace file client for agents holding a `gws_` token;
- verify webhooks.

## Examples

| | JavaScript | Python |
|---|---|---|
| A platform mints a write token, an agent in a sandbox process writes files with it, and the platform lists runs and undoes one | [examples/sandbox-agent.mjs](examples/sandbox-agent.mjs) | [examples/sandbox_agent.py](examples/sandbox_agent.py) |
| A webhook receiver that verifies `Grapim-Signature` | [examples/webhook-receiver.mjs](examples/webhook-receiver.mjs) | [examples/webhook_receiver.py](examples/webhook_receiver.py) |

```sh
GRAPIM_API_KEY=gpk_test_... node sdk/examples/sandbox-agent.mjs
GRAPIM_WEBHOOK_SECRET=whsec_... node sdk/examples/webhook-receiver.mjs
```

## Tests

```sh
npm run test:sdk                                                  # JS, also part of npm test
cd sdk/python && python -m unittest discover -s tests -t tests    # Python
```

Both run against in-process fakes of the hub's `/v1` and workspace endpoints, and both run the examples end to end.
