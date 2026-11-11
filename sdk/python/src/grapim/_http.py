"""The one place that talks HTTP: auth, JSON, Idempotency-Key, retries with
jittered backoff that honours Retry-After, timeouts and typed errors.

Nothing here logs. Redirects are not followed, so a credential is never
re-sent to another host."""

from __future__ import annotations

import email.utils
import json
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Dict, Mapping, Optional

from .errors import APIConnectionError, GrapimError, error_from_response

VERSION = "0.1.0"

_IDEMPOTENT = {"GET", "HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


def retry_after_seconds(value: Optional[str], now: Optional[float] = None) -> Optional[float]:
    """Seconds a Retry-After header asks for (seconds or an HTTP date), or None."""
    if value is None or value.strip() == "":
        return None
    s = value.strip()
    try:
        return max(0.0, float(s))
    except ValueError:
        pass
    try:
        t = email.utils.parsedate_to_datetime(s)
    except (TypeError, ValueError):
        return None
    if t is None:
        return None
    return max(0.0, t.timestamp() - (time.time() if now is None else now))


class Response:
    __slots__ = ("status", "headers", "data", "request_id")

    def __init__(self, status: int, headers: Mapping[str, str], data: Any, request_id: Optional[str]) -> None:
        self.status = status
        self.headers = headers
        self.data = data
        self.request_id = request_id


class Http:
    def __init__(
        self,
        authorization: str,
        base_url: str,
        *,
        max_attempts: int = 3,
        base_delay: float = 0.5,
        max_delay: float = 8.0,
        max_retry_after: float = 60.0,
        timeout: float = 60.0,
        headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        self.__authorization = authorization
        self.base_url = base_url
        self.max_attempts = max(1, int(max_attempts))
        self.base_delay = base_delay
        self.max_delay = max_delay
        self.max_retry_after = max_retry_after
        self.timeout = timeout
        self.headers = dict(headers or {})
        self._opener = urllib.request.build_opener(_NoRedirect)
        self._sleep = time.sleep

    def __repr__(self) -> str:
        return f"Http(base_url={self.base_url!r})"

    def backoff(self, attempt: int) -> float:
        """Full jitter in [half, whole] of min(max_delay, base_delay * 2**(attempt-1))."""
        cap = min(self.max_delay, self.base_delay * (2 ** (attempt - 1)))
        return cap / 2 + random.random() * (cap / 2)

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
        json_body: Any = None,
        raw: Optional[bytes] = None,
        headers: Optional[Mapping[str, str]] = None,
        idempotency_key: Any = None,
        as_bytes: bool = False,
        retry_unsafe: bool = False,
    ) -> Response:
        url = self.base_url + path
        if query:
            q = [(k, _qv(v)) for k, v in query.items() if v is not None]
            if q:
                url += ("&" if "?" in url else "?") + urllib.parse.urlencode(q)
        h: Dict[str, str] = {"Accept": "application/json", "User-Agent": f"grapim-python/{VERSION}"}
        h.update(self.headers)
        h.update(headers or {})
        h["Authorization"] = self.__authorization
        data: Optional[bytes] = None
        if json_body is not None:
            h["Content-Type"] = "application/json"
            data = json.dumps(json_body, separators=(",", ":")).encode("utf-8")
        elif raw is not None:
            h["Content-Type"] = "application/octet-stream"
            data = raw
        key: Optional[str] = None
        if idempotency_key:
            key = idempotency_key if isinstance(idempotency_key, str) else str(uuid.uuid4())
            h["Idempotency-Key"] = key
        safe = method in _IDEMPOTENT or key is not None or retry_unsafe

        attempt = 0
        while True:
            attempt += 1
            last = attempt >= self.max_attempts
            req = urllib.request.Request(url, data=data, headers=h, method=method)
            try:
                with self._opener.open(req, timeout=self.timeout) as res:
                    body = res.read()
                    rid = res.headers.get("Request-Id")
                    out = body if as_bytes else _parse_json(body, res.status, rid)
                    return Response(res.status, res.headers, out, rid)
            except urllib.error.HTTPError as e:
                status = e.code
                rid = e.headers.get("Request-Id") if e.headers else None
                try:
                    body = e.read()
                except Exception:  # noqa: BLE001
                    body = b""
                finally:
                    e.close()
                retryable = status in (429, 503) or (status >= 500 and safe)
                if not last and retryable:
                    wait = retry_after_seconds(e.headers.get("Retry-After") if e.headers else None)
                    self._sleep(self.backoff(attempt) if wait is None else min(wait, self.max_retry_after))
                    continue
                try:
                    parsed = json.loads(body.decode("utf-8")) if body else None
                except ValueError:
                    parsed = None
                raise error_from_response(status, parsed, rid) from None
            except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as e:
                if not last and safe:
                    self._sleep(self.backoff(attempt))
                    continue
                origin = urllib.parse.urlsplit(url)
                reason = getattr(e, "reason", e)
                raise APIConnectionError(f"Could not reach {origin.scheme}://{origin.netloc}: {reason}") from None


def _qv(v: Any) -> str:
    if v is True:
        return "1"
    if v is False:
        return "0"
    return str(v)


def _parse_json(body: bytes, status: int, rid: Optional[str]) -> Any:
    if not body:
        return None
    try:
        return json.loads(body.decode("utf-8"))
    except ValueError:
        raise GrapimError("Expected JSON from the server.", code="invalid_response", status=status, request_id=rid) from None
