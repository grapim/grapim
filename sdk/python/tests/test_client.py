import datetime as dt
import json
import os
import re
import socket
import sys
import threading
import time
import unittest
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))
sys.path.insert(0, HERE)

from fake_server import FakeServer  # noqa: E402

from grapim import (  # noqa: E402
    APIConnectionError,
    AuthenticationError,
    ConflictError,
    Grapim,
    GrapimError,
    NotFoundError,
    RateLimitError,
)

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def q(req):
    return dict(urllib.parse.parse_qsl(req["query"]))


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = FakeServer()
        cls.g = Grapim(api_key=cls.fake.api_key, base_url=cls.fake.url, base_delay=0.005, max_delay=0.02)

    @classmethod
    def tearDownClass(cls):
        cls.fake.close()

    def setUp(self):
        self.fake.reset()

    def v1(self, path):
        return [r for r in self.fake.requests if r["path"] == "/v1" + path]

    # -------------------------------------------------------------- construction

    def test_needs_a_gpk_key_and_never_echoes_it(self):
        with self.assertRaises(GrapimError):
            Grapim(api_key="")
        tok = "gws_" + "x" * 30
        with self.assertRaises(GrapimError) as cm:
            Grapim(api_key=tok)
        self.assertIn("Grapim.workspace", str(cm.exception))
        self.assertNotIn(tok, str(cm.exception))

    def test_key_not_in_repr_or_errors(self):
        key = "gpk_live_" + "k" * 32
        c = Grapim(api_key=key, base_url=self.fake.url, max_attempts=1)
        self.assertNotIn(key, repr(c))
        self.assertNotIn(key, repr(c._http))
        with self.assertRaises(AuthenticationError) as cm:
            c.workspaces.list().first_page()
        self.assertNotIn(key, repr(cm.exception))
        self.assertNotIn(key, str(cm.exception))
        self.assertFalse(c.test_mode)

    def test_base_url_with_v1(self):
        c = Grapim(api_key=self.fake.api_key, base_url=self.fake.url + "/v1/")
        c.workspaces.list().first_page()
        self.assertEqual(self.fake.requests[-1]["path"], "/v1/workspaces")
        self.assertTrue(c.test_mode)

    # -------------------------------------------------------------- headers

    def test_headers(self):
        self.g.workspaces.create(external_id="cust_hdr", name="hdr")
        r = self.v1("/workspaces")[0]
        self.assertEqual(r["method"], "POST")
        self.assertEqual(r["headers"]["authorization"], f"Bearer {self.fake.api_key}")
        self.assertEqual(r["headers"]["accept"], "application/json")
        self.assertTrue(r["headers"]["user-agent"].startswith("grapim-python/"))
        self.assertEqual(r["headers"]["content-type"], "application/json")
        self.assertEqual(json.loads(r["body"]), {"external_id": "cust_hdr", "name": "hdr"})

    # -------------------------------------------------------------- idempotency

    def test_posts_get_a_uuid_key_others_none(self):
        ws = self.g.workspaces.create(name="idem-a")
        self.g.workspaces.get(ws["id"])
        self.g.workspaces.update(ws["id"], metadata={"plan": "pro"})
        self.g.tokens.create(ws["id"], scope="read")
        self.g.workspaces.delete(ws["id"])
        posts = [r for r in self.fake.requests if r["method"] == "POST"]
        self.assertEqual(len(posts), 2)
        for p in posts:
            self.assertRegex(p["headers"]["idempotency-key"], UUID)
        self.assertNotEqual(posts[0]["headers"]["idempotency-key"], posts[1]["headers"]["idempotency-key"])
        for r in self.fake.requests:
            if r["method"] != "POST":
                self.assertNotIn("idempotency-key", r["headers"])

    def test_caller_key(self):
        self.g.workspaces.create(name="idem-b", idempotency_key="order-42")
        self.assertEqual(self.fake.requests[-1]["headers"]["idempotency-key"], "order-42")

    def test_lost_response_retry_reuses_key(self):
        before = len(self.fake.workspaces)
        self.fake.script(lambda r: r["path"] == "/v1/workspaces" and r["method"] == "POST", [{"status": 502, "after": True}])
        ws = self.g.workspaces.create(external_id="cust_lost", name="lost")
        posts = [r for r in self.v1("/workspaces") if r["method"] == "POST"]
        self.assertEqual(len(posts), 2)
        self.assertEqual(posts[0]["headers"]["idempotency-key"], posts[1]["headers"]["idempotency-key"])
        self.assertEqual(len(self.fake.workspaces), before + 1)
        self.assertEqual(ws["external_id"], "cust_lost")

    def test_idempotency_mismatch(self):
        self.g.workspaces.create(name="idem-c", idempotency_key="k-mismatch")
        with self.assertRaises(ConflictError) as cm:
            self.g.workspaces.create(name="idem-d", idempotency_key="k-mismatch")
        e = cm.exception
        self.assertEqual((e.code, e.status), ("idempotency_mismatch", 409))
        self.assertTrue(e.request_id.startswith("req_"))

    # -------------------------------------------------------------- retries

    def test_503_then_ok(self):
        self.fake.script("/v1/usage", [{"status": 503, "headers": {"Retry-After": "0"}, "code": "busy"}])
        r = self.g.usage.get()
        self.assertIsInstance(r["data"], list)
        self.assertEqual(len(self.v1("/usage")), 2)

    def test_retry_after_seconds_is_waited_for(self):
        self.fake.script("/v1/usage", [{"status": 429, "headers": {"Retry-After": "1"}, "code": "rate_limited"}])
        t0 = time.monotonic()
        self.g.usage.get()
        self.assertGreaterEqual(time.monotonic() - t0, 0.95)

    def test_at_most_three_attempts(self):
        self.fake.script("/v1/usage", [{"status": 429, "headers": {"Retry-After": "0"}, "code": "rate_limited"}] * 4)
        with self.assertRaises(RateLimitError) as cm:
            self.g.usage.get()
        self.assertEqual((cm.exception.status, cm.exception.code), (429, "rate_limited"))
        self.assertEqual(len(self.v1("/usage")), 3)

    def test_500_get_retried_400_not(self):
        self.fake.script("/v1/webhook_endpoints", [{"status": 500}])
        self.g.webhooks.list().first_page()
        self.assertEqual(len(self.v1("/webhook_endpoints")), 2)
        self.fake.reset()
        with self.assertRaises(GrapimError) as cm:
            self.g.webhooks.create(url="http://not-https.example", events=[])
        self.assertEqual((cm.exception.status, cm.exception.code), (400, "bad_request"))
        self.assertEqual(len(self.fake.requests), 1)

    def test_connection_error(self):
        # A listener that hangs up on every connection (a refused port takes ~2 s per try on Windows).
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        sock.listen(8)
        hits = []

        def hang_up():
            while True:
                try:
                    c, _ = sock.accept()
                except OSError:
                    return
                hits.append(1)
                c.close()

        threading.Thread(target=hang_up, daemon=True).start()
        try:
            dead = Grapim(api_key=self.fake.api_key, base_url=f"http://127.0.0.1:{sock.getsockname()[1]}", base_delay=0.001, timeout=2)
            with self.assertRaises(APIConnectionError) as cm:
                dead.workspaces.list().first_page()
            self.assertEqual(cm.exception.status, 0)
            self.assertEqual(len(hits), 3)
        finally:
            sock.close()

    # -------------------------------------------------------------- errors

    def test_not_found(self):
        with self.assertRaises(NotFoundError) as cm:
            self.g.workspaces.get("ws_nope")
        e = cm.exception
        self.assertIsInstance(e, GrapimError)
        self.assertEqual((e.code, e.status), ("not_found", 404))
        self.assertRegex(e.request_id, r"^req_\d+$")

    # -------------------------------------------------------------- pagination

    def test_pagination(self):
        made = [self.g.workspaces.create(external_id=f"page_{i}", name=f"page-{i}")["id"] for i in range(7)]
        self.fake.reset()
        seen = [ws["id"] for ws in self.g.workspaces.list(limit=3) if ws["id"] in made]
        self.assertEqual(seen, made)
        pages = self.v1("/workspaces")
        self.assertGreaterEqual(len(pages), 3)
        self.assertNotIn("starting_after", q(pages[0]))
        for p in pages[1:]:
            self.assertTrue(q(p)["starting_after"].startswith("ws_"))
        for p in pages:
            self.assertEqual(q(p)["limit"], "3")
        first = self.g.workspaces.list(limit=2).first_page()
        self.assertEqual(len(first["data"]), 2)
        self.assertTrue(first["has_more"])
        one = self.g.workspaces.list(external_id="page_3").first_page()
        self.assertEqual([w["external_id"] for w in one["data"]], ["page_3"])
        self.assertEqual(len(self.g.workspaces.list(limit=2).to_list(max=5)), 5)

    # -------------------------------------------------------------- resources

    def test_resources(self):
        g = self.g
        ws = g.workspaces.create(external_id="cust_res", name="res", metadata={"tier": "a"})
        self.assertEqual(ws["object"], "workspace")
        self.assertTrue(ws["url"].endswith("/w/team_fake/res/"))
        self.assertEqual(g.workspaces.get(ws["id"])["id"], ws["id"])
        self.assertEqual(g.workspaces.update(ws["id"], name="res2")["name"], "res2")
        self.assertEqual(self.fake.requests[-1]["method"], "PATCH")

        tok = g.tokens.create(ws["id"], scope="write", ttl_seconds=60, agent_name="bot")
        self.assertTrue(tok["token"].startswith("gws_"))
        g.tokens.revoke(ws["id"], tok["id"])
        self.assertEqual(self.fake.requests[-1]["path"], f"/v1/workspaces/{ws['id']}/tokens/{tok['id']}")

        self.assertIn("/embed/", g.embed_sessions.create(ws["id"], mode="readonly", theme="dark")["url"])
        self.assertEqual(g.runs.list(ws["id"]), [])

        g.usage.get(from_=dt.date(2026, 11, 1), to="2026-11-30", group_by="day")
        self.assertEqual(q(self.fake.requests[-1]), {"from": "2026-11-01", "to": "2026-11-30", "group_by": "day"})

        ep = g.webhooks.create(url="https://example.com/hooks", events=["run.started"])
        self.assertTrue(ep["secret"].startswith("whsec_"))
        self.assertIn(ep["id"], [e["id"] for e in g.webhooks.list()])
        g.webhooks.delete(ep["id"])

        s = g.settings.update(embed_allowed_origins=["https://app.example.com"])
        self.assertEqual(s["embed_allowed_origins"], ["https://app.example.com"])
        self.assertEqual(self.fake.requests[-1]["method"], "PUT")

        g.workspaces.delete(ws["id"])
        with self.assertRaises(NotFoundError):
            g.workspaces.get(ws["id"])

    def test_ids_are_encoded(self):
        with self.assertRaises(GrapimError):
            self.g.workspaces.get("a/b?c")
        self.assertEqual(self.fake.requests[-1]["path"], "/v1/workspaces/a%2Fb%3Fc")


if __name__ == "__main__":
    unittest.main()
