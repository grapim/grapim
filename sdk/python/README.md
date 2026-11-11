# grapim (Python)

Grapim for platforms, in Python. Give every one of your end customers a recorded, reviewable, undoable workspace that your agents write to.

- Standard library only (`urllib.request`, `hmac`, `hashlib`, `json`).
- Python 3.9+, with type hints (`py.typed`).
- No runtime dependencies.

The contract is [docs/platform.md](../../docs/platform.md). It has the same surface as `@grapim/sdk`, in snake_case.

## Install

```sh
pip install grapim
```

## The platform client (your backend)

```python
from grapim import Grapim

grapim = Grapim()  # api_key from GRAPIM_API_KEY (gpk_live_... or gpk_test_...); base_url="https://app.grapim.com"

ws = grapim.workspaces.create(external_id="cust_42", name="cust-42", metadata={"plan": "pro"})

# A token for one workspace, to hand to the agent's sandbox. Shown once.
tok = grapim.tokens.create(ws["id"], scope="write", ttl_seconds=900, agent_name="fixer")

runs = grapim.runs.list(ws["id"])
plan = grapim.runs.undo(ws["id"], runs[0]["run"])               # the plan
grapim.runs.undo(ws["id"], runs[0]["run"], apply=True)          # apply it

embed = grapim.embed_sessions.create(ws["id"], mode="review")   # embed["url"] for an iframe
```

| Resource | Methods |
|---|---|
| `workspaces` | `create(external_id=, name=, metadata=)`, `list(external_id=, limit=, starting_after=)`, `get(id)`, `update(id, name=, metadata=)`, `delete(id)` |
| `tokens` | `create(workspace_id, scope=, ttl_seconds=, agent_name=)`, `revoke(workspace_id, token_id)` |
| `embed_sessions` | `create(workspace_id, mode=, ttl_seconds=, theme=)` |
| `runs` | `list(workspace_id)`, `undo(workspace_id, run, turn=, apply=)` |
| `usage` | `get(from_=, to=, group_by=)` (a `date` becomes `YYYY-MM-DD`) |
| `webhooks` | `create(url=, events=)`, `list()`, `delete(id)` |
| `settings` | `update(embed_allowed_origins=)` |

POSTs take `idempotency_key=`. Responses are plain dicts with the API's field names.

### Pagination

`list()` returns a `ListResult`. Iterate over it to walk every page, or call `first_page()` or `to_list(max=)`:

```python
for ws in grapim.workspaces.list():
    print(ws["id"])
page = grapim.workspaces.list(limit=20).first_page()   # {"data": [...], "has_more": bool}
```

### Retries, idempotency, errors

These work as in the JS SDK:

- **Idempotency**: an `Idempotency-Key` is sent on every POST and reused across retries.
- **Retries**: 429 and 503 are retried. Other 5xx and connection errors are retried only when the request is safe to repeat. At most 3 attempts.
- **Waits**: `Retry-After` is honoured; without it, the wait is jittered backoff.
- **Errors**: `GrapimError` has `code`, `status` and `request_id`. The subclasses are `AuthenticationError`, `PermissionDeniedError`, `NotFoundError`, `ConflictError`, `PreconditionFailedError` (with `current_sha`), `RateLimitError`, `APIConnectionError` and `WebhookSignatureError`.
- **Redirects**: these aren't followed, so a credential never goes to another host.
- **Secrets**: nothing is logged, and keys and tokens aren't in any `repr`.

## The workspace file client (the agent, in its sandbox)

```python
from grapim import Grapim, PreconditionFailedError

ws = Grapim.workspace(os.environ["GRAPIM_WORKSPACE_URL"], os.environ["GRAPIM_WORKSPACE_TOKEN"], agent="fixer", intent="Fix the login bug")

content, sha = ws.read("src/login.py")            # bytes + sha1 (the ETag)
try:
    ws.write("src/login.py", patched, if_match=sha)
except PreconditionFailedError as e:
    ...                                           # e.current_sha: read again, merge, retry
ws.write("NOTES.md", "new file", if_match="absent")
ws.delete("old.txt", if_match=some_sha)
ws.list("src"); ws.list("", recursive=True)
ws.blame("src/login.py"); ws.runs(); ws.undo(run, turn=2, apply=True); ws.release()
```

`if_match=None` (the default) means an unconditional write; use `"absent"` for "must not exist".

## Webhooks

```python
import grapim

event = grapim.verify_webhook(raw_body_bytes, headers["Grapim-Signature"], secret, tolerance=300)
```

It raises `WebhookSignatureError` when the header is missing or wrong, the signature doesn't match, or the timestamp is out of tolerance. It uses `hmac.compare_digest`.

## Tests

```sh
cd sdk/python && python -m unittest discover -s tests -t tests
```

The tests run against an `http.server` fake of `/v1` and the workspace endpoints (`tests/fake_server.py`). They also run the examples in `sdk/examples/`.
