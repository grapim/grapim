"""The workspace file client, for an agent holding a ``gws_`` token.

It needs no platform key, so it is safe to hand to code running in a sandbox::

    ws = Grapim.workspace(url=workspace["url"], token=token, agent="fixer")
    content, sha = ws.read("src/app.py")
    ws.write("src/app.py", new_content, if_match=sha)
"""

from __future__ import annotations

import re
import urllib.parse
from typing import Any, Dict, List, NamedTuple, Optional, Union

from ._http import Http
from .errors import GrapimError

_SHA = re.compile(r"^[0-9a-fA-F]{40}$")
_PRINTABLE = re.compile(r"^[\x20-\x7e]{1,500}$")


class FileContent(NamedTuple):
    """What ``read`` returns; unpacks as ``content, sha = ws.read(path)``."""

    content: bytes
    sha: Optional[str]


def _unquote(etag: Optional[str]) -> Optional[str]:
    if not etag:
        return None
    e = etag[2:] if etag.startswith("W/") else etag
    return e[1:-1] if len(e) >= 2 and e[0] == '"' and e[-1] == '"' else e


def encode_path(p: str) -> str:
    if not isinstance(p, str):
        raise GrapimError("A path must be a string.", code="bad_request")
    return "/".join(urllib.parse.quote(seg, safe="") for seg in p.lstrip("/").split("/"))


def _if_match(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    if v in ("absent", '"absent"'):
        return '"absent"'
    s = _unquote(str(v)) or ""
    if not _SHA.match(s):
        raise GrapimError('if_match must be a sha1 (from read or write) or "absent".', code="bad_request")
    return f'"{s.lower()}"'


def _header(name: str, v: Optional[str]) -> Optional[str]:
    if v is None or v == "":
        return None
    if not _PRINTABLE.match(str(v)):
        raise GrapimError(f"{name} must be 1 to 500 printable ASCII characters.", code="bad_request")
    return str(v)


def workspace_base(url: str) -> str:
    """The workspace root URL with one trailing slash; accepts ``url``, ``fs_url`` or ``mcp_url``."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise GrapimError(f"Not a workspace URL: {url}", code="bad_request")
    path = re.sub(r"/+$", "", parts.path)
    path = re.sub(r"/(fs|mcp)$", "", path)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, path + "/", "", ""))


class WorkspaceClient:
    def __init__(
        self,
        url: str,
        token: str,
        *,
        agent: Optional[str] = None,
        intent: Optional[str] = None,
        max_attempts: int = 3,
        base_delay: float = 0.5,
        max_delay: float = 8.0,
        timeout: float = 60.0,
    ) -> None:
        if not url:
            raise GrapimError("Grapim.workspace needs url.", code="bad_request")
        if not isinstance(token, str) or not token:
            raise GrapimError("Grapim.workspace needs token (a gws_ workspace token).", code="bad_request")
        self.url = workspace_base(url)
        self._agent = _header("agent", agent)
        self._intent = _header("intent", intent)
        self._http = Http(f"Bearer {token}", self.url, max_attempts=max_attempts, base_delay=base_delay, max_delay=max_delay, timeout=timeout)

    def __repr__(self) -> str:
        return f"WorkspaceClient(url={self.url!r}, agent={self._agent!r})"

    def _headers(self, intent: Optional[str] = None) -> Dict[str, str]:
        h: Dict[str, str] = {}
        if self._agent:
            h["X-Grapim-Agent"] = self._agent
        i = _header("intent", intent) if intent is not None else self._intent
        if i:
            h["X-Grapim-Intent"] = i
        return h

    def read(self, path: str) -> FileContent:
        """The file's bytes and sha (its ETag). Raises NotFoundError when there is no such file."""
        r = self._http.request("GET", "fs/" + encode_path(path), as_bytes=True, headers={"Accept": "application/octet-stream"})
        return FileContent(r.data, _unquote(r.headers.get("ETag")))

    def read_text(self, path: str, encoding: str = "utf-8") -> "tuple[str, Optional[str]]":
        content, sha = self.read(path)
        return content.decode(encoding), sha

    def write(self, path: str, content: Union[bytes, bytearray, str], *, if_match: Optional[str] = None, intent: Optional[str] = None) -> Dict[str, Any]:
        """Writes the file. ``if_match`` is a sha (the file must still be that version)
        or ``"absent"`` (it must not exist); a mismatch raises PreconditionFailedError
        with ``current_sha``, and nothing is written."""
        if isinstance(content, str):
            data = content.encode("utf-8")
        elif isinstance(content, (bytes, bytearray, memoryview)):
            data = bytes(content)
        else:
            raise GrapimError("content must be bytes or str.", code="bad_request")
        h = self._headers(intent)
        im = _if_match(if_match)
        if im:
            h["If-Match"] = im
        return self._http.request("PUT", "fs/" + encode_path(path), raw=data, headers=h).data

    def delete(self, path: str, *, if_match: Optional[str] = None, intent: Optional[str] = None) -> Dict[str, Any]:
        """Deletes the file, with the same ``if_match`` rule as write."""
        h = self._headers(intent)
        im = _if_match(if_match)
        if im:
            h["If-Match"] = im
        return self._http.request("DELETE", "fs/" + encode_path(path), headers=h).data

    def list(self, dir: str = "", *, recursive: bool = False) -> Any:  # noqa: A002
        """A folder's entries ('' is the root); with ``recursive=True``,
        ``{"files": [...], "truncated": bool}``: every file below it."""
        d = (dir or "").lstrip("/")
        if recursive:
            return self._http.request("GET", "api/files", query={"path": d or None, "recursive": 1}).data
        folder = "" if d == "" else encode_path(d[:-1] if d.endswith("/") else d) + "/"
        return self._http.request("GET", "fs/" + folder).data

    def blame(self, path: str, *, full: bool = False) -> Dict[str, Any]:
        return self._http.request("GET", "api/blame", query={"path": path, "full": 1 if full else None}).data

    def runs(self) -> List[Dict[str, Any]]:
        return self._http.request("GET", "api/runs").data

    def run(self, run: str) -> Dict[str, Any]:
        return self._http.request("GET", "api/runs/" + urllib.parse.quote(run, safe="")).data

    def undo(self, run: str, *, turn: Optional[int] = None, apply: bool = False) -> Dict[str, Any]:
        """``apply=False`` (default) returns the plan; ``apply=True`` applies it. Needs a write token."""
        return self._http.request(
            "POST", "api/runs/" + urllib.parse.quote(run, safe="") + "/undo",
            json_body={"turn": turn, "apply": bool(apply)}, headers=self._headers(),
        ).data

    def release(self) -> Dict[str, Any]:
        """Releases every file this agent holds (writes keep their claim until then)."""
        return self._http.request("POST", "fs/_release", headers=self._headers(), retry_unsafe=True).data
