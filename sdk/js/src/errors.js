// Typed errors. Every error the API returns becomes a GrapimError (or one of
// its subclasses, picked by HTTP status) carrying the API's code, the status
// and the Request-Id, so a support ticket can quote it.

export class GrapimError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, requestId?: string|null, currentSha?: string|null, body?: unknown, cause?: unknown }} [init]
   */
  constructor(message, init = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'GrapimError';
    /** The API's error code, e.g. `not_found`, `idempotency_mismatch`. */
    this.code = init.code ?? 'unknown';
    /** The HTTP status, or 0 when no response arrived. */
    this.status = init.status ?? 0;
    /** The Request-Id header (or `error.request_id`), when the server sent one. */
    this.requestId = init.requestId ?? null;
    if (init.currentSha !== undefined) this.currentSha = init.currentSha;
    if (init.body !== undefined) Object.defineProperty(this, 'body', { value: init.body, enumerable: false });
  }
}

export class AuthenticationError extends GrapimError {
  constructor(m, i) { super(m, i); this.name = 'AuthenticationError'; }
}
export class PermissionDeniedError extends GrapimError {
  constructor(m, i) { super(m, i); this.name = 'PermissionDeniedError'; }
}
export class NotFoundError extends GrapimError {
  constructor(m, i) { super(m, i); this.name = 'NotFoundError'; }
}
export class ConflictError extends GrapimError {
  constructor(m, i) { super(m, i); this.name = 'ConflictError'; }
}
/** A `/fs` write whose If-Match no longer holds. `currentSha` is the file's sha now (null: absent). */
export class PreconditionFailedError extends GrapimError {
  constructor(m, i) { super(m, i); this.name = 'PreconditionFailedError'; }
}
export class RateLimitError extends GrapimError {
  constructor(m, i) { super(m, i); this.name = 'RateLimitError'; }
}
/** No response: DNS, connection refused, reset, or the request timed out. */
export class ConnectionError extends GrapimError {
  constructor(m, i) { super(m, { code: 'connection_error', ...i }); this.name = 'ConnectionError'; }
}
/** verifyWebhook refused the payload: bad header, wrong signature or too old. */
export class WebhookSignatureError extends GrapimError {
  constructor(m, i) { super(m, { code: 'invalid_signature', status: 400, ...i }); this.name = 'WebhookSignatureError'; }
}

const BY_STATUS = {
  401: AuthenticationError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  412: PreconditionFailedError,
  429: RateLimitError,
};

/** Builds the right error from a non-2xx response's status, parsed body and Request-Id. */
export function errorFromResponse(status, body, requestId) {
  const e = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null;
  const code = typeof e?.code === 'string' ? e.code : status >= 500 ? 'internal' : 'http_' + status;
  const message = typeof e?.message === 'string' && e.message ? e.message : `HTTP ${status}`;
  const Cls = BY_STATUS[status] ?? GrapimError;
  const init = { code, status, requestId: requestId || (typeof e?.request_id === 'string' ? e.request_id : null), body };
  if (e && 'current_sha' in e) init.currentSha = e.current_sha ?? null;
  return new Cls(message, init);
}
