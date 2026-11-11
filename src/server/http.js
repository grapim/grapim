// Small HTTP helpers shared by the server modules: the error shape from
// docs/api.md, JSON replies and bounded body reading.

export const MAX_BODY = 32 * 1024 * 1024;

// Each error code and the HTTP status that goes with it.
export const STATUS = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  precondition_failed: 412,
  too_large: 413,
  internal: 500,
  busy: 503,
};

// extra: more fields for the error body (412 adds current_sha).
export class HttpError extends Error {
  constructor(code, message, headers = {}, extra = null) {
    super(message);
    this.code = code;
    this.status = STATUS[code] ?? 500;
    this.headers = headers;
    this.extra = extra;
  }
}

export const badRequest = (message) => new HttpError('bad_request', message);
export const notFound = (message) => new HttpError('not_found', message);
export const conflict = (message) => new HttpError('conflict', message);
export const busy = (message) => new HttpError('busy', message, { 'Retry-After': '1' });
// If-Match did not hold: the file is not the version the client last saw.
export const preconditionFailed = (message, currentSha) => new HttpError('precondition_failed', message, {}, { current_sha: currentSha });
export const notAllowed = (allow) => new HttpError('method_not_allowed', `Use ${allow.join(' or ')} here.`, { Allow: allow.join(', ') });

const isSqliteBusy = (err) => err?.code === 'ERR_SQLITE_ERROR' && /\b(busy|locked)\b/i.test(err.message);

// Any thrown value as an HttpError. Errors that carry one of our codes (the
// review module's stub does) keep it; everything else is internal.
export function toHttpError(err) {
  if (err instanceof HttpError) return err;
  if (isSqliteBusy(err)) return busy('The state database is busy. Try again in a moment.');
  if (typeof err?.code === 'string' && err.code in STATUS) return new HttpError(err.code, err.message);
  return new HttpError('internal', err?.message || String(err));
}

export function sendJson(res, status, body, headers = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...headers });
  res.end(buf);
}

export function sendError(res, err) {
  const e = toHttpError(err);
  if (e.code === 'internal') process.stderr.write(`grapim serve: ${err?.stack || e.message}\n`);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, e.status, { error: { code: e.code, message: e.message, ...e.extra } }, e.headers);
}

export function sendBytes(res, buf, type = 'application/octet-stream', headers = {}) {
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...headers });
  res.end(buf);
}

// The whole request body, refusing more than `limit` bytes.
export function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError('too_large', `The body is over ${Math.round(limit / 1024 / 1024)} MB.`, { Connection: 'close' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => failed || resolve(Buffer.concat(chunks)));
    req.on('error', (err) => failed || reject(err));
  });
}

// The body as JSON; an empty body is {}.
export async function readJson(req, limit = 1024 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw badRequest('The body is not valid JSON.');
  }
}

// Splits req.url without normalising it: "/fs/../x" must reach the path check
// as written, not as "/x".
export function splitUrl(raw) {
  if (!raw.startsWith('/')) throw badRequest('The request target must be a path starting with /.');
  const q = raw.indexOf('?');
  return { path: q < 0 ? raw : raw.slice(0, q), query: new URLSearchParams(q < 0 ? '' : raw.slice(q + 1)) };
}

// A header value as text. Node reads header bytes as latin1; agents send UTF-8.
export function headerText(req, name) {
  const v = req.headers[name];
  if (typeof v !== 'string') return null;
  return Buffer.from(v, 'latin1').toString('utf8').trim();
}
