"""verify_webhook against signatures computed here, independently, from the
contract's wording (docs/platform.md "Webhooks"):
    Grapim-Signature: t=<unix>,v1=<hex hmac-sha256 of "t.body" with the endpoint secret>
"""

import hashlib
import hmac
import json
import os
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

import grapim  # noqa: E402
from grapim import GrapimError, WebhookSignatureError, verify_webhook  # noqa: E402

SECRET = "whsec_0123456789abcdef0123456789abcdef"
EVENT = {
    "id": "evt_123", "type": "run.started", "created": 1762850000,
    "workspace": {"id": "ws_1", "external_id": "cust_9"},
    "data": {"run": "http:tok/fixer", "note": "naïve ünïcode ✓"},
}
BODY = json.dumps(EVENT, ensure_ascii=False).encode("utf-8")


def sign(t, body=BODY, secret=SECRET):
    return hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()


def header(t, sig=None):
    return f"t={t},v1={sig or sign(t)}"


def now():
    return int(time.time())


class VerifyWebhookTest(unittest.TestCase):
    def refused(self, code, *args, **kw):
        with self.assertRaises(WebhookSignatureError) as cm:
            verify_webhook(*args, **kw)
        self.assertIsInstance(cm.exception, GrapimError)
        self.assertEqual(cm.exception.code, code)

    def test_contract_format(self):
        t = now()
        self.assertEqual(verify_webhook(BODY, header(t), SECRET), EVENT)
        self.assertEqual(grapim.verify_webhook(BODY.decode("utf-8"), header(t), SECRET), EVENT)
        self.assertEqual(verify_webhook(bytearray(BODY), header(t), SECRET), EVENT)

    def test_several_v1(self):
        t = now()
        h = f"t={t}, v1={sign(t, secret='whsec_old')}, v0=abc, v1={sign(t)}"
        self.assertEqual(verify_webhook(BODY, h, SECRET), EVENT)
        self.assertEqual(verify_webhook(BODY, [f"t={t}", f"v1={sign(t).upper()}"], SECRET), EVENT)
        self.assertEqual(verify_webhook(BODY, f"t={t},v1=ünï,v1={sign(t)}", SECRET), EVENT)

    def test_refuses_tampering(self):
        t = now()
        self.refused("invalid_signature", BODY, header(t), "whsec_wrong")
        self.refused("invalid_signature", BODY.replace(b"cust_9", b"cust_8"), header(t), SECRET)
        self.refused("invalid_signature", BODY, f"t={t - 1},v1={sign(t)}", SECRET)
        self.refused("invalid_signature", BODY, f"t={t},v1={sign(t)[:63]}", SECRET)

    def test_tolerance(self):
        old = now() - 301
        self.refused("timestamp_out_of_tolerance", BODY, header(old), SECRET)
        self.refused("timestamp_out_of_tolerance", BODY, header(now() + 400), SECRET)
        self.assertEqual(verify_webhook(BODY, header(old), SECRET, tolerance=600), EVENT)
        self.assertEqual(verify_webhook(BODY, header(1), SECRET, tolerance=0), EVENT)
        self.assertEqual(verify_webhook(BODY, header(1000), SECRET, now=1100), EVENT)

    def test_malformed(self):
        self.refused("invalid_header", BODY, None, SECRET)
        self.refused("invalid_header", BODY, "v1=abc", SECRET)
        self.refused("invalid_header", BODY, f"t={now()}", SECRET)
        self.refused("invalid_header", BODY, f"t=abc,v1={sign(now())}", SECRET)
        self.refused("invalid_secret", BODY, header(now()), "")
        self.refused("invalid_body", EVENT, header(now()), SECRET)


if __name__ == "__main__":
    unittest.main()
