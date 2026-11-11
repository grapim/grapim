// s3://bucket/prefix?endpoint=https://...&region=... : any S3-compatible store
// (AWS S3, Cloudflare R2, MinIO), spoken to with path-style URLs and AWS
// Signature Version 4 written here with node:crypto. No dependencies.
//
// Credentials come from GRAPIM_S3_ACCESS_KEY_ID / GRAPIM_S3_SECRET_ACCESS_KEY
// (+ optional GRAPIM_S3_SESSION_TOKEN). They live only in this module's closure:
// they are never logged, never put on the returned object, and never placed in
// an error message. Error messages carry the operation, key, HTTP status and the
// S3 <Code> only, never the response body (S3 echoes the string to sign there).

import crypto from 'node:crypto';
import { validateKey, validatePrefix } from './keys.js';
import { DEFAULT_RETRY, backoffDelay, sleep } from './retry.js';

// ---------------------------------------------------------------- SigV4 ----

export const ALGORITHM = 'AWS4-HMAC-SHA256';
export const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
export const EMPTY_SHA256 = sha256hex('');

// kSecret -> kDate -> kRegion -> kService -> kSigning.
export function signingKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

// UriEncode from the SigV4 spec: every byte except A-Z a-z 0-9 - _ . ~ becomes
// %XX (uppercase hex). "/" is kept in object key paths, encoded everywhere else.
export function uriEncode(str, { keepSlash = false } = {}) {
  let out = '';
  for (const byte of Buffer.from(String(str), 'utf8')) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === '/')) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

// [[name, value], ...] (decoded) -> "a=1&b=2", encoded and sorted by key then value.
export function canonicalQueryString(pairs = []) {
  return pairs
    .map(([k, v]) => [uriEncode(k), uriEncode(v ?? '')])
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

// headers: object or [[name, value]] pairs. Names are lowercased, values trimmed
// with inner runs of spaces collapsed, repeated names joined with ",".
export function canonicalHeaders(headers) {
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  const map = new Map();
  for (const [name, value] of entries) {
    const n = String(name).toLowerCase().trim();
    const v = String(value).trim().replace(/\s+/g, ' ');
    map.set(n, map.has(n) ? `${map.get(n)},${v}` : v);
  }
  const names = [...map.keys()].sort();
  return {
    text: names.map((n) => `${n}:${map.get(n)}\n`).join(''),
    signedHeaders: names.join(';'),
  };
}

// path: the canonical URI, already encoded (e.g. "/bucket/a%20b").
export function canonicalRequest({ method, path, query = [], headers, payloadHash }) {
  const { text, signedHeaders } = canonicalHeaders(headers);
  const request = [method.toUpperCase(), path || '/', canonicalQueryString(query), text, signedHeaders, payloadHash].join('\n');
  return { request, signedHeaders };
}

export const credentialScope = (dateStamp, region, service) => `${dateStamp}/${region}/${service}/aws4_request`;

export const stringToSign = (amzDate, scope, canonicalRequestText) =>
  [ALGORITHM, amzDate, scope, sha256hex(canonicalRequestText)].join('\n');

export const toAmzDate = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// Signs one request. `headers` must already hold every header to sign,
// including host and x-amz-date (and x-amz-security-token when used).
export function signV4({ method, path, query = [], headers, payloadHash, accessKeyId, secretAccessKey, region, service = 's3', amzDate, key = null }) {
  const dateStamp = amzDate.slice(0, 8);
  const scope = credentialScope(dateStamp, region, service);
  const { request, signedHeaders } = canonicalRequest({ method, path, query, headers, payloadHash });
  const sts = stringToSign(amzDate, scope, request);
  const signature = crypto
    .createHmac('sha256', key || signingKey(secretAccessKey, dateStamp, region, service))
    .update(sts, 'utf8')
    .digest('hex');
  const authorization = `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, signature, canonicalRequest: request, stringToSign: sts, signedHeaders };
}

// ------------------------------------------------------------ XML (list) ----

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>|&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, cdata, ent) => {
    if (cdata !== undefined) return cdata;
    if (ent[0] === '#') {
      const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) throw new Error(`bad XML character reference ${m}`);
      return String.fromCodePoint(cp);
    }
    if (!(ent in XML_ENTITIES)) throw new Error(`unknown XML entity ${m}`);
    return XML_ENTITIES[ent];
  });
}

const tag = (name) => new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`);

export function parseListObjectsV2(xml) {
  if (!/<ListBucketResult[\s>]/.test(xml)) throw new Error('ListObjectsV2 response is not a ListBucketResult');
  const keys = [];
  for (const m of xml.matchAll(/<Contents(?:\s[^>]*)?>([\s\S]*?)<\/Contents>/g)) {
    const k = m[1].match(tag('Key'));
    if (k) keys.push(decodeXml(k[1]));
  }
  const truncated = xml.match(tag('IsTruncated'));
  const next = xml.match(tag('NextContinuationToken'));
  return {
    keys,
    isTruncated: !!truncated && truncated[1].trim() === 'true',
    nextContinuationToken: next ? decodeXml(next[1]) : null,
  };
}

// -------------------------------------------------------------- client ----

export class S3Error extends Error {
  constructor(message, { status = null, code = null, retryable = false } = {}) {
    super(message);
    this.name = 'S3Error';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export function parseS3Url(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('storage url is not a valid URL');
  }
  if (u.protocol !== 's3:') throw new Error('S3 storage url must start with s3://');
  if (u.username || u.password) throw new Error('put S3 credentials in GRAPIM_S3_* env vars, not in the storage url');
  const bucket = u.hostname;
  if (!BUCKET.test(bucket)) throw new Error('S3 storage url needs a bucket name: s3://<bucket>/<prefix>');
  const rawPrefix = decodeURIComponent(u.pathname).replace(/^\/+|\/+$/g, '');
  const prefix = rawPrefix ? `${validateKey(rawPrefix)}/` : '';

  let endpointParam = u.searchParams.get('endpoint');
  let region = u.searchParams.get('region');
  if (!region) region = endpointParam && /\.r2\.cloudflarestorage\.com/i.test(endpointParam) ? 'auto' : 'us-east-1';
  if (!/^[a-z0-9-]+$/.test(region)) throw new Error('S3 region must look like us-east-1 or auto');
  if (!endpointParam) {
    if (region === 'auto') throw new Error('region=auto needs an explicit endpoint=');
    endpointParam = `https://s3.${region}.amazonaws.com`;
  }
  let endpoint;
  try {
    endpoint = new URL(endpointParam);
  } catch {
    throw new Error('S3 endpoint is not a valid URL');
  }
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') throw new Error('S3 endpoint must be http(s)');
  if (endpoint.username || endpoint.password || endpoint.search) throw new Error('S3 endpoint must not carry credentials or a query');
  return { bucket, prefix, region, endpoint };
}

const shownKey = (k) => JSON.stringify(k);

export function createS3Storage(url, env = process.env, opts = {}) {
  const { bucket, prefix, region, endpoint } = parseS3Url(url);
  const accessKeyId = env.GRAPIM_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.GRAPIM_S3_SECRET_ACCESS_KEY;
  const sessionToken = env.GRAPIM_S3_SESSION_TOKEN || null;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('S3 storage needs GRAPIM_S3_ACCESS_KEY_ID and GRAPIM_S3_SECRET_ACCESS_KEY in the environment');
  }
  const doFetch = opts.fetch || globalThis.fetch;
  const retry = { ...DEFAULT_RETRY, ...(opts.retry || {}) };
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pageSize = opts.pageSize ?? 1000;
  const now = opts.now || (() => new Date());
  const random = opts.random || Math.random;

  const basePath = endpoint.pathname.replace(/\/+$/, '');
  const bucketPath = `${basePath}/${uriEncode(bucket)}`;

  let cachedKey = null; // { dateStamp, key }
  const keyFor = (dateStamp) => {
    if (!cachedKey || cachedKey.dateStamp !== dateStamp) {
      cachedKey = { dateStamp, key: signingKey(secretAccessKey, dateStamp, region, 's3') };
    }
    return cachedKey.key;
  };

  // One signed attempt. Returns { status, headers, body } or throws (network/timeout).
  async function attempt(method, path, query, body, payloadHash, extraHeaders) {
    const amzDate = toAmzDate(now());
    const headers = {
      host: endpoint.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders,
    };
    if (sessionToken) headers['x-amz-security-token'] = sessionToken;
    const { authorization } = signV4({
      method, path, query, headers, payloadHash, accessKeyId, region, service: 's3', amzDate, key: keyFor(amzDate.slice(0, 8)),
    });
    const { host, ...sendHeaders } = headers; // fetch sets Host itself, from the URL
    sendHeaders.authorization = authorization;
    const qs = canonicalQueryString(query);
    const target = `${endpoint.origin}${path}${qs ? `?${qs}` : ''}`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch(target, { method, headers: sendHeaders, body: body ?? undefined, signal: ac.signal, redirect: 'manual' });
      const buf = method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer());
      return { status: res.status, headers: res.headers, body: buf };
    } catch (err) {
      if (ac.signal.aborted) throw new S3Error(`timed out after ${timeoutMs} ms`, { code: 'timeout', retryable: true });
      // Network errors: keep only the message and the low-level code.
      const code = err?.cause?.code || err?.code || null;
      throw new S3Error(`network error${code ? ` (${code})` : ''}`, { code: code || 'network', retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  // Signed request with retries on 5xx, 429, timeouts and network errors.
  // `accept` lists statuses that are answers rather than failures.
  async function request(op, method, { key = null, query = [], body = null, accept = [200] }) {
    const path = key === null ? bucketPath : `${bucketPath}/${uriEncode(prefix + key, { keepSlash: true })}`;
    const payloadHash = body ? sha256hex(body) : EMPTY_SHA256;
    const extra = body ? { 'content-type': 'application/octet-stream' } : {};
    const what = `S3 ${op}${key === null ? '' : ` ${shownKey(key)}`}`;
    let last = null;
    for (let i = 0; i <= retry.retries; i++) {
      if (i > 0) {
        let wait = backoffDelay(i - 1, retry, random);
        const ra = Number(last?.retryAfter);
        if (Number.isFinite(ra) && ra > 0) wait = Math.max(wait, Math.min(ra * 1000, retry.maxDelayMs));
        await sleep(wait);
      }
      let res;
      try {
        res = await attempt(method, path, query, body, payloadHash, extra);
      } catch (err) {
        last = new S3Error(`${what} failed: ${err.message}`, { code: err.code, retryable: true });
        continue;
      }
      if (accept.includes(res.status)) return res;
      const code = (res.body.toString('utf8').match(/<Code>([^<]{1,100})<\/Code>/) || [])[1] || null;
      const retryable = res.status >= 500 || res.status === 429;
      last = new S3Error(`${what} failed: HTTP ${res.status}${code ? ` ${code}` : ''}`, { status: res.status, code, retryable });
      last.retryAfter = res.headers.get('retry-after');
      if (!retryable) throw last;
    }
    last.message += ` (gave up after ${retry.retries + 1} attempts)`;
    throw last;
  }

  return {
    kind: 's3',
    // Safe to log: no credentials.
    describe: () => `s3://${bucket}/${prefix} via ${endpoint.origin} (${region})`,

    async put(key, buf) {
      validateKey(key);
      const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      await request('PutObject', 'PUT', { key, body });
    },

    async get(key) {
      validateKey(key);
      const res = await request('GetObject', 'GET', { key, accept: [200, 404] });
      return res.status === 404 ? null : res.body;
    },

    async has(key) {
      validateKey(key);
      const res = await request('HeadObject', 'HEAD', { key, accept: [200, 404] });
      return res.status === 200;
    },

    async delete(key) {
      validateKey(key);
      await request('DeleteObject', 'DELETE', { key, accept: [200, 204, 404] });
    },

    async list(listPrefix = '') {
      validatePrefix(listPrefix);
      const full = prefix + listPrefix;
      const out = [];
      const seen = new Set();
      let token = null;
      do {
        const query = [['list-type', '2'], ['max-keys', String(pageSize)], ['prefix', full]];
        if (token) query.push(['continuation-token', token]);
        const res = await request('ListObjectsV2', 'GET', { query });
        let page;
        try {
          page = parseListObjectsV2(res.body.toString('utf8'));
        } catch (err) {
          throw new S3Error(`S3 ListObjectsV2 failed: ${err.message}`, { status: res.status, code: 'bad_xml' });
        }
        for (const k of page.keys) if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
        token = page.isTruncated ? page.nextContinuationToken : null;
        if (page.isTruncated && !token) throw new S3Error('S3 ListObjectsV2 failed: truncated page without a continuation token', { code: 'bad_xml' });
        if (token && seen.has(token)) throw new S3Error('S3 ListObjectsV2 failed: continuation token repeated', { code: 'bad_xml' });
        if (token) seen.add(token);
      } while (token);
      return out.sort();
    },
  };
}
