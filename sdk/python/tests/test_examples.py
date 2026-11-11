"""Runs sdk/examples/*.py against the fake server, end to end."""

import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from fake_server import FakeServer  # noqa: E402

EXAMPLES = os.path.join(HERE, "..", "..", "examples")


class ExamplesTest(unittest.TestCase):
    def test_sandbox_agent(self):
        fake = FakeServer()
        try:
            env = {**os.environ, "GRAPIM_API_KEY": fake.api_key, "GRAPIM_BASE_URL": fake.url}
            p = subprocess.run([sys.executable, os.path.join(EXAMPLES, "sandbox_agent.py")], env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            self.assertIn("[agent] wrote README.md", p.stdout)
            self.assertIn("[agent] wrote config/app.json", p.stdout)
            self.assertRegex(p.stdout, r"undid http:tok-\d+/fixer: 2 file\(s\), applied=true")
            self.assertIn("review desk for the customer: http", p.stdout)
            puts = [r for r in fake.requests if r["method"] == "PUT"]
            self.assertEqual(len(puts), 2)
            for r in puts:
                self.assertTrue(r["headers"]["authorization"].startswith("Bearer gws_"))
                self.assertEqual(r["headers"]["if-match"], '"absent"')
            ws_id = next(iter(fake.workspaces))
            self.assertEqual(fake.files[ws_id], {})
        finally:
            fake.close()

    def test_webhook_receiver(self):
        secret = "whsec_example_receiver_secret"
        env = {**os.environ, "GRAPIM_WEBHOOK_SECRET": secret, "PORT": "0", "PYTHONUNBUFFERED": "1"}
        p = subprocess.Popen([sys.executable, os.path.join(EXAMPLES, "webhook_receiver.py")], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            line = p.stdout.readline()
            m = re.search(r"listening on (http://\S+)", line)
            self.assertTrue(m, line)
            url = m.group(1)
            body = json.dumps({"id": "evt_1", "type": "run.started", "created": 1, "workspace": {"id": "ws_1", "external_id": "c1"}, "data": {"run": "http:t/a"}}).encode()
            t = int(time.time())
            sig = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()

            def post(b, header):
                req = urllib.request.Request(url, data=b, method="POST", headers={"Grapim-Signature": header} if header else {})
                try:
                    with urllib.request.urlopen(req, timeout=10) as r:
                        return r.status, json.loads(r.read())
                except urllib.error.HTTPError as e:
                    return e.code, json.loads(e.read())

            self.assertEqual(post(body, f"t={t},v1={sig}"), (200, {"received": True}))
            self.assertEqual(post(body.replace(b"c1", b"c2"), f"t={t},v1={sig}"), (400, {"error": "invalid_signature"}))
            self.assertEqual(post(body, None)[0], 400)
        finally:
            p.kill()
            p.communicate()


if __name__ == "__main__":
    unittest.main()
