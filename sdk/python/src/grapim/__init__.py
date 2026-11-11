"""Grapim for platforms: workspaces, scoped agent tokens, embedded review,
undo, usage and webhook verification. Standard library only."""

from ._http import VERSION as __version__
from .client import Grapim
from .errors import (
    APIConnectionError,
    AuthenticationError,
    ConflictError,
    GrapimError,
    NotFoundError,
    PermissionDeniedError,
    PreconditionFailedError,
    RateLimitError,
    WebhookSignatureError,
)
from .pagination import ListResult
from .webhooks import verify_webhook
from .workspace import FileContent, WorkspaceClient

__all__ = [
    "__version__",
    "Grapim",
    "WorkspaceClient",
    "FileContent",
    "ListResult",
    "verify_webhook",
    "GrapimError",
    "AuthenticationError",
    "PermissionDeniedError",
    "NotFoundError",
    "ConflictError",
    "PreconditionFailedError",
    "RateLimitError",
    "APIConnectionError",
    "WebhookSignatureError",
]
