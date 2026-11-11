import hashlib
import json
import os
import sys
import unittest
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))
sys.path.insert(0, HERE)

from fake_server import FakeServer  # noqa: E402

from grapim import (  # noqa: E402
    AuthenticationError,
    Grapim,
    GrapimError,
    NotFoundError,
    PermissionDeniedError,
    PreconditionFailedError,
)


def sha1(s):
    return hashlib.sha1(s.encode("utf-8") if isinstance(s, str) else s).hexdigest()


class WorkspaceTest(unittest.TestCase):
    """Ordered steps on one workspace (unittest runs test_* in name order)."""

    @classmethod
    def setUpClass(cls):
        cls.fake = FakeServer()
        cls.g = Grapim(api_key=cls.fake.api_key, base_url=cls.fake.url, base_delay=0.005)
        cls.ws = cls.g.workspaces.create(external_id="cust_files", name="files")
        cls.tok = cls.g.tokens.create(cls.ws["id"], scope="write")
        cls.files = Grapim.workspace(cls.ws["url"], cls.tok["token"], agent="fixer", intent="Fix the README", base_delay=0.005)

    @classmethod
    def tearDownClass(cls):
        cls.fake.close()

    def setUp(self):
        self.fake.reset()

    def path(self, p):
        return urllib.parse.urlsplit(self.ws["url"]).path + p

    def last(self):
        return self.fake.requests[-1]

    def test_01_write_read(self):
        w = self.files.write("README.md", "# Hello\n", if_match="absent")
        self.assertEqual(w["sha"], sha1("# Hello\n"))
        put = self.last()
        self.assertEqual((put["method"], put["path"]), ("PUT", self.path("fs/README.md")))
        h = put["headers"]
        self.assertEqual(h["authorization"], f"Bearer {self.tok['token']}")
        self.assertEqual(h["x-grapim-agent"], "fixer")
        self.assertEqual(h["x-grapim-intent"], "Fix the README")
        self.assertEqual(h["if-match"], '"absent"')
        self.assertEqual(h["content-type"], "application/octet-stream")
        self.assertNotIn("idempotency-key", h)
        content, sha = self.files.read("README.md")
        self.assertEqual((content, sha), (b"# Hello\n", w["sha"]))
        self.assertEqual(self.files.read_text("README.md")[0], "# Hello\n")

    def test_02_stale_if_match(self):
        _, sha = self.files.read("README.md")
        self.files.write("README.md", "# Hello again\n", if_match=sha)
        with self.assertRaises(PreconditionFailedError) as cm:
            self.files.write("README.md", "# Lost update\n", if_match=sha)
        e = cm.exception
        self.assertEqual((e.code, e.status, e.current_sha), ("precondition_failed", 412, sha1("# Hello again\n")))
        self.assertEqual(self.files.read_text("README.md")[0], "# Hello again\n")

    def test_03_if_match_quoted_and_junk(self):
        _, sha = self.files.read("README.md")
        self.files.write("README.md", "# Quoted\n", if_match=f'"{sha}"')
        self.assertEqual(self.last()["headers"]["if-match"], f'"{sha}"')
        n = len(self.fake.requests)
        with self.assertRaises(GrapimError):
            self.files.write("README.md", "x", if_match="nope")
        self.assertEqual(len(self.fake.requests), n)

    def test_04_paths_encoded(self):
        self.files.write("docs/a b/naïve #1.txt", bytes([1, 2, 3]))
        self.assertEqual(self.last()["path"], self.path("fs/docs/a%20b/na%C3%AFve%20%231.txt"))
        self.assertEqual(self.files.read("docs/a b/naïve #1.txt").content, bytes([1, 2, 3]))

    def test_05_list(self):
        root = self.files.list()
        self.assertEqual(self.last()["path"], self.path("fs/"))
        self.assertEqual([(e["name"], e["type"]) for e in root], [("docs", "dir"), ("README.md", "file")])
        self.files.list("docs")
        self.assertEqual(self.last()["path"], self.path("fs/docs/"))
        allf = self.files.list("", recursive=True)
        self.assertEqual(self.last()["path"], self.path("api/files"))
        self.assertEqual(dict(urllib.parse.parse_qsl(self.last()["query"]))["recursive"], "1")
        self.assertEqual([f["path"] for f in allf["files"]], ["README.md", "docs/a b/naïve #1.txt"])

    def test_06_delete(self):
        self.files.write("tmp.txt", "bye")
        self.files.delete("tmp.txt", if_match=sha1("bye"))
        self.assertEqual(self.last()["headers"]["if-match"], f'"{sha1("bye")}"')
        with self.assertRaises(NotFoundError):
            self.files.read("tmp.txt")

    def test_07_blame_runs_undo_release(self):
        b = self.files.blame("README.md", full=True)
        self.assertEqual(b["content"], "# Quoted\n")
        runs = self.files.runs()
        mine = next(r for r in runs if r["label"] == "fixer")
        self.assertRegex(mine["run"], r"^http:tok-\d+/fixer$")
        self.assertEqual(self.files.run(mine["run"])["run"]["run"], mine["run"])
        self.assertEqual(self.last()["path"], self.path("api/runs/" + urllib.parse.quote(mine["run"], safe="")))
        plan = self.files.undo(mine["run"])
        self.assertFalse(plan["applied"])
        self.assertEqual(json.loads(self.last()["body"]), {"turn": None, "apply": False})
        self.assertTrue(self.files.undo(mine["run"], apply=True)["applied"])
        with self.assertRaises(NotFoundError):
            self.files.read("README.md")
        self.assertEqual(self.files.release()["released"], [])
        self.assertEqual(self.last()["path"], self.path("fs/_release"))

    def test_08_retries(self):
        self.fake.script(lambda r: r["method"] == "PUT", [{"status": 503, "headers": {"Retry-After": "0"}, "code": "busy"}])
        self.files.write("retry.txt", "ok")
        self.assertEqual(len([r for r in self.fake.requests if r["method"] == "PUT"]), 2)
        self.fake.reset()
        self.fake.script(lambda r: r["path"].endswith("/undo"), [{"status": 500}])
        with self.assertRaises(GrapimError) as cm:
            self.files.undo("http:whatever", apply=True)
        self.assertEqual(cm.exception.status, 500)
        self.assertEqual(len(self.fake.requests), 1)

    def test_09_read_token_and_revoke(self):
        ro = self.g.tokens.create(self.ws["id"], scope="read")
        reader = Grapim.workspace(self.ws["fs_url"], ro["token"])
        self.assertEqual(reader.url, self.ws["url"])
        reader.list()
        with self.assertRaises(PermissionDeniedError):
            reader.write("x.txt", "x")
        self.g.tokens.revoke(self.ws["id"], ro["id"])
        with self.assertRaises(AuthenticationError):
            reader.list()

    def test_10_token_not_in_repr_and_url_normalised(self):
        self.assertNotIn(self.tok["token"], repr(self.files))
        self.assertNotIn(self.tok["token"], repr(self.files._http))
        for u in (self.ws["url"], self.ws["fs_url"], self.ws["mcp_url"], self.ws["url"][:-1], self.ws["url"] + "?x=1"):
            self.assertEqual(Grapim.workspace(u, "gws_x").url, self.ws["url"])
        with self.assertRaises(GrapimError):
            Grapim.workspace(self.ws["url"], "")
        with self.assertRaises(GrapimError):
            Grapim.workspace(self.ws["url"], "gws_x", agent="bad\nname")


if __name__ == "__main__":
    unittest.main()
