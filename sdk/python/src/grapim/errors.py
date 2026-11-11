"""Typed errors. Every API error becomes a GrapimError (or a subclass picked by
HTTP status) with the API's ``code``, the ``status`` and the ``request_id``."""

from __future__ import annotations

from typing import Any, Optional

_UNSET: Any = object()


class GrapimError(Exception):
    """An error from the Grapim API or the SDK.

    Attributes:
        code: the API's error code, e.g. ``not_found``, ``idempotency_mismatch``.
        status: the HTTP status, 0 when no response arrived.
        request_id: the response's Request-Id, when there was one.
        current_sha: on a 412 from a conditional write, the file's sha now (None: absent).
        body: the parsed error body.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str = "unknown",
        status: int = 0,
        request_id: Optional[str] = None,
        current_sha: Any = _UNSET,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.request_id = request_id
        if current_sha is not _UNSET:
            self.current_sha = current_sha
        self.body = body

    def __repr__(self) -> str:
        return f"{type(self).__name__}(code={self.code!r}, status={self.status}, request_id={self.request_id!r}, message={self.message!r})"


class AuthenticationError(GrapimError):
    """401: missing, wrong or revoked key or token."""


class PermissionDeniedError(GrapimError):
    """403: the key or token may not do this (e.g. a read token writing)."""


class NotFoundError(GrapimError):
    """404."""


class ConflictError(GrapimError):
    """409: e.g. ``idempotency_mismatch``, or another agent holds the file."""


class PreconditionFailedError(GrapimError):
    """412: a conditional write whose ``if_match`` no longer holds. See ``current_sha``."""

    current_sha: Optional[str]


class RateLimitError(GrapimError):
    """429."""


class APIConnectionError(GrapimError):
    """No response: DNS, connection refused or reset, or a timeout."""

    def __init__(self, message: str, **kw: Any) -> None:
        kw.setdefault("code", "connection_error")
        super().__init__(message, **kw)


class WebhookSignatureError(GrapimError):
    """verify_webhook refused the payload."""

    def __init__(self, message: str, **kw: Any) -> None:
        kw.setdefault("code", "invalid_signature")
        kw.setdefault("status", 400)
        super().__init__(message, **kw)


_BY_STATUS = {
    401: AuthenticationError,
    403: PermissionDeniedError,
    404: NotFoundError,
    409: ConflictError,
    412: PreconditionFailedError,
    429: RateLimitError,
}


def error_from_response(status: int, body: Any, request_id: Optional[str]) -> GrapimError:
    e = body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), dict) else None
    code = e.get("code") if e and isinstance(e.get("code"), str) else ("internal" if status >= 500 else f"http_{status}")
    message = e.get("message") if e and isinstance(e.get("message"), str) and e.get("message") else f"HTTP {status}"
    rid = request_id or (e.get("request_id") if e and isinstance(e.get("request_id"), str) else None)
    cls = _BY_STATUS.get(status, GrapimError)
    kw: dict = {"code": code, "status": status, "request_id": rid, "body": body}
    if e is not None and "current_sha" in e:
        kw["current_sha"] = e.get("current_sha")
    return cls(message, **kw)
