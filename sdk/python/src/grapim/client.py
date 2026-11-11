"""The platform client: ``Grapim(api_key=...)`` with a ``gpk_`` key, for a
platform's backend. The key acts for the whole platform; give agents a scoped
``gws_`` token (``tokens.create``) instead."""

from __future__ import annotations

import datetime as _dt
import os
import urllib.parse
from typing import Any, Dict, List, Optional, Sequence, Union

from ._http import Http
from .errors import GrapimError
from .pagination import ListResult
from .workspace import WorkspaceClient

DateLike = Union[_dt.date, _dt.datetime, str, int]


def _id(v: str, what: str) -> str:
    if not isinstance(v, str) or not v:
        raise GrapimError(f"{what} must be a non-empty string.", code="bad_request")
    return urllib.parse.quote(v, safe="")


def _day(v: Optional[DateLike]) -> Any:
    if isinstance(v, _dt.datetime):
        return v.astimezone(_dt.timezone.utc).date().isoformat() if v.tzinfo else v.date().isoformat()
    if isinstance(v, _dt.date):
        return v.isoformat()
    return v


def _body(**kw: Any) -> Dict[str, Any]:
    return {k: v for k, v in kw.items() if v is not None}


class _Resource:
    def __init__(self, http: Http) -> None:
        self._http = http

    def _req(self, method: str, path: str, **kw: Any) -> Any:
        return self._http.request(method, path, **kw).data

    def _post(self, path: str, body: Dict[str, Any], idempotency_key: Optional[str]) -> Any:
        # Every POST carries an Idempotency-Key: the caller's, or a fresh one reused across retries.
        return self._req("POST", path, json_body=body, idempotency_key=idempotency_key or True)

    def _list(self, path: str, params: Dict[str, Any]) -> ListResult:
        return ListResult(lambda p: self._req("GET", path, query=p), params)


class Workspaces(_Resource):
    def create(self, *, external_id: Optional[str] = None, name: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None, template: Optional[str] = None, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """``template``: ``"blank"`` (default), ``"agent-team"``, ``"research"`` or ``"data"``: folders with a short README each, written as the approved run ``template:<name>``."""
        return self._post("/workspaces", _body(external_id=external_id, name=name, metadata=metadata, template=template), idempotency_key)

    def list(self, *, external_id: Optional[str] = None, limit: Optional[int] = None, starting_after: Optional[str] = None) -> ListResult:
        return self._list("/workspaces", {"external_id": external_id, "limit": limit, "starting_after": starting_after})

    def get(self, workspace_id: str) -> Dict[str, Any]:
        return self._req("GET", f"/workspaces/{_id(workspace_id, 'workspace_id')}")

    def update(self, workspace_id: str, *, name: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self._req("PATCH", f"/workspaces/{_id(workspace_id, 'workspace_id')}", json_body=_body(name=name, metadata=metadata))

    def delete(self, workspace_id: str) -> Dict[str, Any]:
        return self._req("DELETE", f"/workspaces/{_id(workspace_id, 'workspace_id')}")


class Tokens(_Resource):
    def create(
        self,
        workspace_id: str,
        *,
        scope: str,
        ttl_seconds: Optional[int] = None,
        agent_name: Optional[str] = None,
        name: Optional[str] = None,
        scopes: Optional[List[Dict[str, str]]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Returns ``{"token", "expires_at", "scope", "scopes"}``; the token is shown once.

        ``scopes`` limits the token to some folders: ``[{"path": "docs/**", "access": "read"},
        {"path": "docs/drafts/**", "access": "write"}]`` (at most 32; the most specific rule wins).
        Outside them, reads are 404 and writes 403. Absent: the whole workspace.
        """
        return self._post(
            f"/workspaces/{_id(workspace_id, 'workspace_id')}/tokens",
            _body(scope=scope, ttl_seconds=ttl_seconds, agent_name=agent_name, name=name, scopes=scopes),
            idempotency_key,
        )

    def revoke(self, workspace_id: str, token_id: str) -> Dict[str, Any]:
        return self._req("DELETE", f"/workspaces/{_id(workspace_id, 'workspace_id')}/tokens/{_id(token_id, 'token_id')}")


class EmbedSessions(_Resource):
    def create(self, workspace_id: str, *, mode: str, ttl_seconds: Optional[int] = None, theme: Optional[str] = None, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        return self._post(f"/workspaces/{_id(workspace_id, 'workspace_id')}/embed_sessions", _body(mode=mode, ttl_seconds=ttl_seconds, theme=theme), idempotency_key)


class Runs(_Resource):
    def list(self, workspace_id: str) -> List[Dict[str, Any]]:
        r = self._req("GET", f"/workspaces/{_id(workspace_id, 'workspace_id')}/runs")
        if isinstance(r, list):
            return r
        return r.get("data", []) if isinstance(r, dict) else []

    def undo(self, workspace_id: str, run: str, *, turn: Optional[int] = None, apply: bool = False, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        return self._post(f"/workspaces/{_id(workspace_id, 'workspace_id')}/runs/{_id(run, 'run')}/undo", {"turn": turn, "apply": bool(apply)}, idempotency_key)


class Usage(_Resource):
    def get(self, *, from_: Optional[DateLike] = None, to: Optional[DateLike] = None, group_by: Optional[str] = None) -> Dict[str, Any]:
        """``from_``/``to``: a date or datetime becomes YYYY-MM-DD (UTC); strings and ints go as given."""
        return self._req("GET", "/usage", query={"from": _day(from_), "to": _day(to), "group_by": group_by})


class Webhooks(_Resource):
    def create(self, *, url: str, events: Sequence[str], idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """Returns ``{"id", "secret", ...}``; the secret is shown once."""
        return self._post("/webhook_endpoints", {"url": url, "events": list(events)}, idempotency_key)

    def list(self, *, limit: Optional[int] = None, starting_after: Optional[str] = None) -> ListResult:
        return self._list("/webhook_endpoints", {"limit": limit, "starting_after": starting_after})

    def delete(self, endpoint_id: str) -> Dict[str, Any]:
        return self._req("DELETE", f"/webhook_endpoints/{_id(endpoint_id, 'endpoint_id')}")


class Settings(_Resource):
    def update(self, *, embed_allowed_origins: Optional[Sequence[str]] = None) -> Dict[str, Any]:
        return self._req("PUT", "/settings", json_body=_body(embed_allowed_origins=list(embed_allowed_origins) if embed_allowed_origins is not None else None))


class Grapim:
    """The Grapim platform API.

    Args:
        api_key: a ``gpk_live_...`` or ``gpk_test_...`` key; defaults to env ``GRAPIM_API_KEY``.
        base_url: default ``https://app.grapim.com``.
        max_attempts: total attempts per request (default 3).
        timeout: seconds per attempt (default 60).
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = "https://app.grapim.com",
        *,
        max_attempts: int = 3,
        base_delay: float = 0.5,
        max_delay: float = 8.0,
        max_retry_after: float = 60.0,
        timeout: float = 60.0,
    ) -> None:
        key = api_key if api_key is not None else os.environ.get("GRAPIM_API_KEY")
        if not isinstance(key, str) or not key:
            raise GrapimError("Grapim needs api_key (a gpk_ platform key) or env GRAPIM_API_KEY.", code="bad_request")
        if not key.startswith("gpk_"):
            hint = " That is a workspace token: use Grapim.workspace(url, token) for it." if key.startswith("gws_") else ""
            raise GrapimError(f"api_key must be a platform key starting with gpk_.{hint}", code="bad_request")
        base = base_url.rstrip("/")
        if base.endswith("/v1"):
            base = base[:-3]
        self.base_url = base
        self.test_mode = key.startswith("gpk_test_")
        http = Http(f"Bearer {key}", base + "/v1", max_attempts=max_attempts, base_delay=base_delay, max_delay=max_delay, max_retry_after=max_retry_after, timeout=timeout)
        self._http = http
        self.workspaces = Workspaces(http)
        self.tokens = Tokens(http)
        self.embed_sessions = EmbedSessions(http)
        self.runs = Runs(http)
        self.usage = Usage(http)
        self.webhooks = Webhooks(http)
        self.settings = Settings(http)

    def __repr__(self) -> str:
        return f"Grapim(base_url={self.base_url!r}, test_mode={self.test_mode})"

    @staticmethod
    def workspace(url: str, token: str, *, agent: Optional[str] = None, intent: Optional[str] = None, **kw: Any) -> WorkspaceClient:
        """A file client for an agent holding a ``gws_`` workspace token. Needs no platform key."""
        return WorkspaceClient(url, token, agent=agent, intent=intent, **kw)
