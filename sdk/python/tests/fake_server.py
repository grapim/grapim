"""An in-process fake of the Grapim hub on http.server, as docs/platform.md,
docs/workspaces.md and docs/api.md describe it: the /v1 platform API (gpk_
keys, Request-Id, Idempotency-Key, cursor pagination) and the workspace
endpoints under /w/<team>/<name>/ (gws_ tokens, /fs with ETag and If-Match,
runs, undo, blame, files).

Test hooks:
    fake.requests                 every request: dict(method, path, query, headers, body)
    fake.script(match, steps)     the next requests matching get these responses
                                  instead: dict(status, headers, code), or
                                  dict(status, after=True) to do the work first
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional


def sha1(b: bytes) -> str:
    return hashlib.sha1(b).hexdigest()


class FakeServer:
    def __init__(self, api_key: str = "gpk_test_fake_key_123") -> None:
        self.api_key = api_key
        self.requests: List[Dict[str, Any]] = []
        self._scripts: List[Dict[str, Any]] = []
        self._n = 0
        self._lock = threading.RLock()
        self.workspaces: Dict[str, Dict[str, Any]] = {}
        self.tokens: Dict[str, Dict[str, Any]] = {}
        self.files: Dict[str, Dict[str, bytes]] = {}
        self.changes: Dict[str, List[Dict[str, Any]]] = {}
        self.idem: Dict[str, Dict[str, Any]] = {}
        self.webhooks: Dict[str, Dict[str, Any]] = {}
        self.settings: Dict[str, Any] = {}
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a: Any) -> None:  # quiet
                pass

            def _handle(self) -> None:
                fake._dispatch(self)

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _handle  # noqa: N815

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    # ------------------------------------------------------------------ hooks

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def reset(self) -> None:
        with self._lock:
            self.requests.clear()
            self._scripts.clear()

    def script(self, match: Any, steps: List[Dict[str, Any]]) -> None:
        with self._lock:
            self._scripts.append({"match": match, "steps": list(steps)})

    def _next(self, prefix: str) -> str:
        with self._lock:
            self._n += 1
            return f"{prefix}_{self._n:06d}"

    # ------------------------------------------------------------------ plumbing

    def _dispatch(self, h: BaseHTTPRequestHandler) -> None:
        length = int(h.headers.get("Content-Length") or 0)
        body = h.rfile.read(length) if length else b""
        u = urllib.parse.urlsplit(h.path)
        req = {"method": h.command, "path": u.path, "query": u.query, "headers": {k.lower(): v for k, v in h.headers.items()}, "body": body}
        with self._lock:
            self.requests.append(req)
            step = None
            for s in self._scripts:
                m = s["match"]
                hit = m(req) if callable(m) else u.path.startswith(m)
                if hit and s["steps"]:
                    step = s["steps"].pop(0)
                    break
        if step and not step.get("after"):
            return self._send(h, step["status"], {"error": {"code": step.get("code", "internal"), "message": "scripted"}}, step.get("headers"))
        try:
            with self._lock:
                status, out, headers = self._route(req, u, body)
        except Exception as e:  # noqa: BLE001
            status, out, headers = 500, {"error": {"code": "internal", "message": repr(e)}}, {}
        if step:
            return self._send(h, step["status"], {"error": {"code": step.get("code", "internal"), "message": "scripted after the work"}}, step.get("headers"))
        self._send(h, status, out, headers)

    def _send(self, h: BaseHTTPRequestHandler, status: int, out: Any, headers: Optional[Dict[str, str]] = None) -> None:
        hdrs = {"Request-Id": self._next("req"), **(headers or {})}
        if out is None:
            data, ctype = b"", None
        elif isinstance(out, bytes):
            data, ctype = out, "application/octet-stream"
        else:
            data, ctype = json.dumps(out).encode("utf-8"), "application/json"
        h.send_response(status)
        if ctype:
            h.send_header("Content-Type", ctype)
        h.send_header("Content-Length", str(len(data)))
        for k, v in hdrs.items():
            h.send_header(k, v)
        h.end_headers()
        h.wfile.write(data)

    @staticmethod
    def _err(status: int, code: str, message: str, **extra: Any):
        return status, {"error": {"code": code, "message": message, "request_id": None, **extra}}, {}

    def _route(self, req: Dict[str, Any], u: urllib.parse.SplitResult, body: bytes):
        if u.path.startswith("/v1/"):
            return self._v1(req, u, body)
        if u.path.startswith("/w/"):
            return self._ws(req, u, body)
        return self._err(404, "not_found", "No such route.")

    # ------------------------------------------------------------------ model

    def _public(self, ws: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{self.url}/w/team_fake/{ws['name']}/"
        return {
            "id": ws["id"], "object": "workspace", "external_id": ws["external_id"], "name": ws["name"],
            "metadata": ws["metadata"], "created_at": ws["created_at"], "url": url, "mcp_url": url + "mcp", "fs_url": url + "fs/",
            "usage": {"bytes": sum(len(b) for b in self.files[ws["id"]].values()), "writes_30d": len(self.changes[ws["id"]])},
        }

    @staticmethod
    def _paginate(items: List[Dict[str, Any]], q: Dict[str, str]) -> Dict[str, Any]:
        limit = max(1, min(100, int(q.get("limit", 50))))
        start = 0
        after = q.get("starting_after")
        if after:
            ids = [x["id"] for x in items]
            start = ids.index(after) + 1 if after in ids else len(items)
        return {"object": "list", "data": items[start:start + limit], "has_more": start + limit < len(items)}

    def _runs(self, ws_id: str) -> List[Dict[str, Any]]:
        by: Dict[str, Dict[str, Any]] = {}
        for c in self.changes[ws_id]:
            r = by.setdefault(c["run"], {
                "run": c["run"], "label": c["label"], "worktree": "workspace", "intent": c["intent"], "added": 0, "removed": 0,
                "in_tree": "all", "first_ts": c["ts"], "last_ts": c["ts"], "active": True, "branch": None,
                "review": {"status": "approved", "note": "automatic", "at": c["ts"], "by": c["actor"]} if c["run"].startswith("undo:")
                else {"status": "pending", "note": None, "at": None, "by": None},
                "_paths": set(), "_turns": set(),
            })
            r["_paths"].add(c["path"])
            r["_turns"].add(c["turn"])
            r["last_ts"] = c["ts"]
        out = []
        for r in by.values():
            r["files"], r["turns"] = len(r.pop("_paths")), len(r.pop("_turns"))
            out.append(r)
        return sorted(out, key=lambda r: -r["last_ts"])

    def _record(self, ws_id: str, run: str, label: str, path: str, before: Optional[bytes], after: Optional[bytes], intent: Optional[str], actor: str) -> None:
        lst = self.changes[ws_id]
        prior = [c for c in lst if c["run"] == run]
        last_intent = prior[-1]["intent"] if prior else None
        last_turn = prior[-1]["turn"] if prior else 0
        turn = last_turn + 1 if (not prior or (intent and intent != last_intent)) else last_turn
        lst.append({"run": run, "label": label, "path": path, "before": before, "after": after, "turn": turn,
                    "ts": int(time.time() * 1000) + len(lst), "intent": intent or last_intent, "actor": actor})

    def _undo(self, ws_id: str, run: str, turn: Optional[int], apply: bool, actor: str) -> Optional[Dict[str, Any]]:
        changes = [c for c in self.changes[ws_id] if c["run"] == run and (turn is None or c["turn"] == turn)]
        if not changes:
            return None
        first: Dict[str, Optional[bytes]] = {}
        for c in changes:
            first.setdefault(c["path"], c["before"])
        files = self.files[ws_id]
        if apply:
            undo_run = f"undo:{int(time.time() * 1000)}"
            for p, before in first.items():
                now = files.get(p)
                if before is None:
                    files.pop(p, None)
                else:
                    files[p] = before
                self._record(ws_id, undo_run, f"undo {run}", p, now, before, None, actor)
        return {"applied": bool(apply), "run": run, "label": changes[0]["label"], "turn": turn,
                "files": [{"path": p, "root": "workspace", "action": "delete" if b is None else "restore", "reason": None} for p, b in first.items()]}

    # ------------------------------------------------------------------ /v1

    def _v1(self, req: Dict[str, Any], u: urllib.parse.SplitResult, body: bytes):
        if req["headers"].get("authorization") != f"Bearer {self.api_key}":
            return self._err(401, "unauthorized", "Invalid API key.")
        parts = [urllib.parse.unquote(p) for p in u.path.split("/") if p][1:]
        q = dict(urllib.parse.parse_qsl(u.query))
        m = req["method"]
        try:
            j = json.loads(body.decode("utf-8")) if body else None
        except ValueError:
            return self._err(400, "bad_request", "Body is not JSON.")
        key = req["headers"].get("idempotency-key")
        h = sha1(body)
        if m == "POST" and key and key in self.idem:
            seen = self.idem[key]
            if seen["hash"] != h:
                return self._err(409, "idempotency_mismatch", "This Idempotency-Key was used with a different body.")
            return seen["status"], seen["out"], {"Idempotent-Replayed": "true"}

        def reply(status: int, out: Any):
            if m == "POST" and key:
                self.idem[key] = {"hash": h, "status": status, "out": out}
            return status, out, {}

        a = parts[0] if parts else None
        wid = parts[1] if len(parts) > 1 else None
        b = parts[2] if len(parts) > 2 else None
        sub = parts[3] if len(parts) > 3 else None
        c = parts[4] if len(parts) > 4 else None
        j = j or {}

        if a == "workspaces" and wid is None:
            if m == "POST":
                ws = {"id": self._next("ws"), "external_id": j.get("external_id"), "name": j.get("name") or f"ws-{self._n}",
                      "metadata": j.get("metadata") or {}, "created_at": int(time.time() * 1000), "deleted": False}
                self.workspaces[ws["id"]] = ws
                self.files[ws["id"]] = {}
                self.changes[ws["id"]] = []
                return reply(200, self._public(ws))
            if m == "GET":
                ext = q.get("external_id")
                items = [self._public(w) for w in self.workspaces.values() if not w["deleted"] and (not ext or w["external_id"] == ext)]
                return 200, self._paginate(items, q), {}
        if a == "workspaces" and wid:
            ws = self.workspaces.get(wid)
            if not ws or ws["deleted"]:
                return self._err(404, "not_found", f"No workspace {wid}.")
            if b is None:
                if m == "GET":
                    return 200, self._public(ws), {}
                if m == "PATCH":
                    for k in ("name", "metadata"):
                        if k in j:
                            ws[k] = j[k]
                    return 200, self._public(ws), {}
                if m == "DELETE":
                    ws["deleted"] = True
                    return 200, {"id": wid, "object": "workspace", "deleted": True}, {}
            if b == "tokens" and sub is None and m == "POST":
                if j.get("scope") not in ("read", "write"):
                    return self._err(400, "bad_request", "scope must be read or write.")
                token = "gws_" + secrets.token_hex(16)
                t = {"id": self._next("tok"), "ws": wid, "scope": j["scope"], "name": f"tok-{self._n}", "agent_name": j.get("agent_name"),
                     "expires_at": int(time.time() * 1000) + int(j.get("ttl_seconds") or 3600) * 1000, "revoked": False}
                self.tokens[token] = t
                return reply(200, {"id": t["id"], "token": token, "expires_at": t["expires_at"], "scope": t["scope"]})
            if b == "tokens" and sub and m == "DELETE":
                for t in self.tokens.values():
                    if t["id"] == sub and t["ws"] == wid:
                        t["revoked"] = True
                        return 200, {"id": sub, "object": "token", "deleted": True}, {}
                return self._err(404, "not_found", "No such token.")
            if b == "embed_sessions" and m == "POST":
                if j.get("mode") not in ("review", "readonly"):
                    return self._err(400, "bad_request", "mode must be review or readonly.")
                return reply(200, {"url": f"{self.url}/embed/{secrets.token_hex(12)}", "expires_at": int(time.time() * 1000) + 600_000})
            if b == "runs" and sub is None and m == "GET":
                return 200, self._runs(wid), {}
            if b == "runs" and sub and c == "undo" and m == "POST":
                r = self._undo(wid, sub, j.get("turn"), j.get("apply") is True, "platform")
                return reply(200, r) if r else self._err(404, "not_found", f"No run {sub}.")
        if a == "usage" and m == "GET":
            data = [{"workspace_id": w["id"], "external_id": w["external_id"], "day": q.get("from", "2026-11-11"),
                     "writes": len(self.changes[w["id"]]), "api_calls": 0, "storage_byte_days": 0, "active": bool(self.changes[w["id"]])}
                    for w in self.workspaces.values()]
            return 200, {"data": data, "query": q}, {}
        if a == "webhook_endpoints":
            if wid is None and m == "POST":
                if not str(j.get("url", "")).startswith("https://"):
                    return self._err(400, "bad_request", "url must be https.")
                ep = {"id": self._next("we"), "object": "webhook_endpoint", "url": j["url"], "events": j.get("events", [])}
                self.webhooks[ep["id"]] = ep
                return reply(200, {**ep, "secret": "whsec_" + secrets.token_hex(24)})
            if wid is None and m == "GET":
                return 200, self._paginate(list(self.webhooks.values()), q), {}
            if wid and m == "DELETE":
                if self.webhooks.pop(wid, None) is None:
                    return self._err(404, "not_found", "No such endpoint.")
                return 200, {"id": wid, "deleted": True}, {}
        if a == "settings" and m == "PUT":
            self.settings.update(j)
            return 200, dict(self.settings), {}
        return self._err(404, "not_found", "No such route.")

    # ------------------------------------------------------------------ /w/<team>/<name>/

    def _ws(self, req: Dict[str, Any], u: urllib.parse.SplitResult, body: bytes):
        mm = re.match(r"^/w/team_fake/([^/]+)(/.*)?$", u.path)
        ws = next((w for w in self.workspaces.values() if mm and not w["deleted"] and w["name"] == mm.group(1)), None)
        if not ws:
            return self._err(404, "not_found", "No such workspace.")
        auth = re.match(r"^Bearer (.+)$", req["headers"].get("authorization", ""))
        if not auth:
            return self._err(401, "unauthorized", "No credentials.")
        tok = self.tokens.get(auth.group(1))
        if not tok or tok["revoked"] or tok["ws"] != ws["id"] or tok["expires_at"] < time.time() * 1000:
            return self._err(401, "unauthorized", "Unknown or revoked token.")
        m = req["method"]
        rest = mm.group(2) or "/"
        files = self.files[ws["id"]]
        if m not in ("GET", "HEAD") and tok["scope"] != "write":
            return self._err(403, "forbidden", "A read token cannot write.")
        agent_header = req["headers"].get("x-grapim-agent")
        agent = tok["agent_name"] or agent_header
        run = f"http:{tok['name']}/{agent}" if agent else f"http:{tok['name']}"
        label = agent or tok["name"]
        intent = req["headers"].get("x-grapim-intent")
        q = dict(urllib.parse.parse_qsl(u.query))

        if rest.startswith("/fs/"):
            p = urllib.parse.unquote(rest[4:])
            if any(s in ("..", ".") for s in p.split("/")):
                return self._err(400, "bad_request", "Refused path.")
            if m == "GET" and (p == "" or p.endswith("/")):
                seen: Dict[str, Dict[str, Any]] = {}
                for fp, buf in files.items():
                    if not fp.startswith(p):
                        continue
                    tail = fp[len(p):]
                    if "/" in tail:
                        name = tail.split("/", 1)[0]
                        seen[name] = {"name": name, "path": p + name, "type": "dir", "size": 0, "last_change": None, "held_by": None}
                    else:
                        seen[tail] = {"name": tail, "path": fp, "type": "file", "size": len(buf), "last_change": None, "held_by": None}
                return 200, sorted(seen.values(), key=lambda e: e["name"].lower()), {}
            if p == "_release" and m == "POST":
                return 200, {"released": [], "recorded": []}, {}
            cur = files.get(p)
            if m == "GET":
                if cur is None:
                    return self._err(404, "not_found", f"No file {p}.")
                return 200, cur, {"ETag": f'"{sha1(cur)}"'}
            im = req["headers"].get("if-match")
            if im is not None:
                want = im[1:-1] if len(im) >= 2 and im[0] == im[-1] == '"' else im
                if want != "absent" and not re.match(r"^[0-9a-f]{40}$", want):
                    return self._err(400, "bad_request", "Bad If-Match.")
                is_ = sha1(cur) if cur is not None else None
                ok = is_ is None if want == "absent" else is_ == want
                if not ok:
                    if m == "DELETE" and want == "absent" and cur is None:
                        return self._err(404, "not_found", f"No file {p}.")
                    return self._err(412, "precondition_failed", f"{p} changed.", current_sha=is_)
            if m == "PUT":
                if not agent:
                    return self._err(400, "bad_request", "X-Grapim-Agent is required for writes.")
                files[p] = body
                self._record(ws["id"], run, label, p, cur, body, intent, run)
                s = sha1(body)
                return 200, {"path": p, "sha": s, "added": 1, "removed": 1 if cur else 0}, {"ETag": f'"{s}"'}
            if m == "DELETE":
                if cur is None:
                    return self._err(404, "not_found", f"No file {p}.")
                del files[p]
                self._record(ws["id"], run, label, p, cur, None, intent, run)
                return 200, {"path": p, "sha": None, "added": 0, "removed": 1}, {}
            return self._err(405, "method_not_allowed", "Method not allowed.")
        if rest == "/api/files" and m == "GET":
            prefix = q.get("path", "")
            lst = [{"name": fp.rsplit("/", 1)[-1], "path": fp, "type": "file", "size": len(b), "last_change": None, "held_by": None}
                   for fp, b in sorted(files.items()) if fp.startswith(prefix)]
            return 200, ({"files": lst, "truncated": False} if q.get("recursive") == "1" else lst), {}
        if rest == "/api/blame" and m == "GET":
            p = q.get("path", "")
            cur = files.get(p)
            out: Dict[str, Any] = {"path": p, "base": "HEAD", "changes": len([c for c in self.changes[ws["id"]] if c["path"] == p]),
                                   "exists": cur is not None, "untracked": False, "lines": [], "removed": 0}
            if q.get("full") == "1":
                out["content"] = cur.decode("utf-8") if cur is not None else None
            return 200, out, {}
        if rest == "/api/runs" and m == "GET":
            return 200, self._runs(ws["id"]), {}
        um = re.match(r"^/api/runs/([^/]+)/undo$", rest)
        if um and m == "POST":
            j = json.loads(body.decode("utf-8")) if body else {}
            r = self._undo(ws["id"], urllib.parse.unquote(um.group(1)), j.get("turn"), j.get("apply") is True, run)
            return (200, r, {}) if r else self._err(404, "not_found", "No such run.")
        rm = re.match(r"^/api/runs/([^/]+)$", rest)
        if rm and m == "GET":
            r = next((x for x in self._runs(ws["id"]) if x["run"] == urllib.parse.unquote(rm.group(1))), None)
            return (200, {"run": r, "turns": [], "files": []}, {}) if r else self._err(404, "not_found", "No such run.")
        return self._err(404, "not_found", "No such route.")

