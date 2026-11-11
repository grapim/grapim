"""Webhook signatures, as docs/platform.md specifies::

    Grapim-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<raw body>" with the endpoint secret>

The HMAC key is the endpoint secret exactly as shown at creation (the whole
``whsec_...`` string, UTF-8). Several ``v1=`` entries may appear (while a secret
rotates); any one matching is enough. The comparison is constant time."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

from .errors import WebhookSignatureError

_T = re.compile(r"^\d{1,12}$")


def parse_signature_header(header: Union[str, Sequence[str], None]) -> Optional[Tuple[str, List[str]]]:
    if header is None:
        return None
    h = header if isinstance(header, str) else ",".join(header)
    if not h.strip():
        return None
    t: Optional[str] = None
    v1: List[str] = []
    for part in h.split(","):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k, v = k.strip(), v.strip()
        if k == "t":
            t = v
        elif k == "v1":
            v1.append(v.lower())
    if t is None or not _T.match(t):
        return None
    return t, v1


def verify_webhook(
    raw_body: Union[bytes, bytearray, memoryview, str],
    header: Union[str, Sequence[str], None],
    secret: str,
    tolerance: int = 300,
    *,
    now: Optional[int] = None,
) -> Dict[str, Any]:
    """Verifies a webhook delivery and returns the parsed event.

    Pass the body exactly as received (bytes). Raises WebhookSignatureError when
    the header is missing or malformed, no signature matches, or the timestamp
    is more than ``tolerance`` seconds from now in either direction (0 turns
    the age check off).
    """
    if not isinstance(secret, str) or not secret:
        raise WebhookSignatureError("No webhook secret given.", code="invalid_secret")
    if isinstance(raw_body, str):
        body = raw_body.encode("utf-8")
    elif isinstance(raw_body, (bytes, bytearray, memoryview)):
        body = bytes(raw_body)
    else:
        raise WebhookSignatureError(
            "verify_webhook needs the raw request body (bytes or str), not parsed JSON: "
            "re-serialising changes the bytes and the signature will not match.",
            code="invalid_body",
        )
    parsed = parse_signature_header(header)
    if parsed is None:
        raise WebhookSignatureError("Missing or malformed Grapim-Signature header (expected t=<unix>,v1=<hex>).", code="invalid_header")
    t, candidates = parsed
    if not candidates:
        raise WebhookSignatureError("The Grapim-Signature header has no v1 signature.", code="invalid_header")
    current = int(time.time()) if now is None else int(now)
    if tolerance > 0 and abs(current - int(t)) > tolerance:
        raise WebhookSignatureError(
            f"The webhook timestamp is {abs(current - int(t))} s away from now, over the {tolerance} s tolerance.",
            code="timestamp_out_of_tolerance",
        )
    expected = hmac.new(secret.encode("utf-8"), t.encode("ascii") + b"." + body, hashlib.sha256).hexdigest()
    ok = False
    for c in candidates:
        # compare_digest is constant time for equal lengths; check every candidate.
        if c.isascii():
            ok = hmac.compare_digest(expected, c) or ok
    if not ok:
        raise WebhookSignatureError("No signature in the Grapim-Signature header matches this body and secret.")
    try:
        return json.loads(body.decode("utf-8"))
    except ValueError:
        raise WebhookSignatureError("The signature is valid but the body is not JSON.", code="invalid_body") from None
