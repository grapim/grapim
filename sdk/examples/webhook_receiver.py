"""A webhook receiver on http.server that verifies Grapim-Signature before
trusting anything in the body.

Run:  GRAPIM_WEBHOOK_SECRET=whsec_... PORT=8787 python sdk/examples/webhook_receiver.py
Then point an endpoint at it (POST /v1/webhook_endpoints wants https, so put a
TLS proxy or tunnel in front for local testing).
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# In your app, after `pip install grapim`, just `import grapim`.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python", "src"))

from grapim import WebhookSignatureError, verify_webhook  # noqa: E402

SECRET = os.environ.get("GRAPIM_WEBHOOK_SECRET")
MAX_BODY = 1024 * 1024
seen = set()  # event ids already handled; use your database in production


def handle(event):
    who = (event.get("workspace") or {}).get("external_id") or (event.get("workspace") or {}).get("id")
    kind = event.get("type")
    if kind == "run.started":
        print(f"{who}: an agent run started ({(event.get('data') or {}).get('run', '?')})", flush=True)
    elif kind == "edit.blocked":
        print(f"{who}: two agents reached for the same file", flush=True)
    elif kind == "run.undone":
        print(f"{who}: a run was undone", flush=True)
    else:
        print(f"{who}: {kind}", flush=True)


class Receiver(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):  # noqa: N802
        if self.path != "/grapim/webhooks":
            return self.reply(404, {"error": "not_found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self.reply(413, {"error": "too_large"})
        # The raw bytes, exactly as sent: the signature covers them, not re-serialised JSON.
        raw = self.rfile.read(length)
        try:
            event = verify_webhook(raw, self.headers.get("Grapim-Signature"), SECRET, tolerance=300)
        except WebhookSignatureError as e:
            print(f"refused a delivery: {e.code}", file=sys.stderr, flush=True)
            return self.reply(400, {"error": e.code})
        # Deliveries are retried, so the same event can arrive twice.
        if event.get("id") not in seen:
            seen.add(event.get("id"))
            handle(event)
        # Answer fast (delivery times out after 10 s); do slow work in a queue.
        return self.reply(200, {"received": True})


if __name__ == "__main__":
    if not SECRET:
        raise SystemExit("Set GRAPIM_WEBHOOK_SECRET to the endpoint secret (whsec_...).")
    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("PORT", "8787"))), Receiver)
    print(f"listening on http://127.0.0.1:{server.server_address[1]}/grapim/webhooks", flush=True)
    server.serve_forever()
