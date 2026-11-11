// azure://account/container/prefix[?endpoint=https://...] : Azure Blob Storage,
// spoken to with the Blob REST API and Shared Key authorization written here
// with node:crypto. No dependencies.
//
// The account key comes from GRAPIM_AZURE_ACCOUNT_KEY (base64, as the portal
// shows it). It lives only in this module's closure: never logged, never put
// on the returned object, never placed in an error message. Errors carry the
// operation, key, HTTP status and the Azure error code only, never a body
// (Azure echoes the string to sign in AuthenticationErrorDetail).
//
// Shared Key, per "Authorize with Shared Key" (x-ms-version 2015-02-21 and
// later): the string to sign is
//   VERB \n Content-Encoding \n Content-Language \n Content-Length (empty when 0)
//   \n Content-MD5 \n Content-Type \n Date \n If-Modified-Since \n If-Match
//   \n If-None-Match \n If-Unmodified-Since \n Range \n
//   CanonicalizedHeaders (x-ms-*, lowercase, sorted, "name:value\n")
//   CanonicalizedResource ("/" account, the encoded URI path, then each query
//   parameter as "\nname:value[,value]" with lowercase names, sorted)
// and Authorization is "SharedKey <account>:<base64 HMAC-SHA256(key, sts)>".

import crypto from 'node:crypto';
import { validateKey, validatePrefix } from './keys.js';
import { DEFAULT_RETRY, backoffDelay, sleep } from './retry.js';
import { decodeXml, uriEncode } from './s3.js';

export const AZURE_VERSION = '2021-08-06';

// --------------------------------------------------------------- signing ----

export function canonicalizedHeaders(headers) {
  const map = new Map();
  for (const [name, value] of Object.entries(headers)) {
    const n = name.toLowerCase().trim();
    if (!n.startsWith('x-ms-')) continue;
    map.set(n, String(value).trim().replace(/\s+/g, ' '));
  }
  return [...map.keys()].sort().map((n) => `${n}:${map.get(n)}\n`).join('');
}

// path: the URI path as sent, already encoded. query: [[name, value], ...] decoded.
export function canonicalizedResource(account, path, query = []) {
  let out = `/${account}${path}`;
  const params = new Map();
  for (const [k, v] of query) {
    const n = String(k).toLowerCase();
    if (!params.has(n)) params.set(n, []);
    params.get(n).push(String(v ?? ''));
  }
  for (const n of [...params.keys()].sort()) out += `\n${n}:${params.get(n).sort().join(',')}`;
  return out;
}

const STANDARD = ['content-encoding', 'content-language', 'content-length', 'content-md5', 'content-type', 'date', 'if-modified-since', 'if-match', 'if-none-match', 'if-unmodified-since', 'range'];

export function stringToSign({ method, headers, account, path, query = [] }) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const std = STANDARD.map((h) => {
    const v = lower[h] ?? '';
    return h === 'content-length' && v === '0' ? '' : v;
  });
  return `${[method.toUpperCase(), ...std].join('\n')}\n${canonicalizedHeaders(headers)}${canonicalizedResource(account, path, query)}`;
}

export function signSharedKey({ method, headers, account, path, query = [], key }) {
  const sts = stringToSign({ method, headers, account, path, query });
  const signature = crypto.createHmac('sha256', key).update(sts, 'utf8').digest('base64');
  return { authorization: `SharedKey ${account}:${signature}`, signature, stringToSign: sts };
}

// ------------------------------------------------------------ XML (list) ----

export function parseListBlobs(xml) {
  if (!/<EnumerationResults[\s>]/.test(xml)) throw new Error('List Blobs response is not an EnumerationResults');
  const names = [];
  for (const m of xml.matchAll(/<Blob(?:\s[^>]*)?>([\s\S]*?)<\/Blob>/g)) {
    const n = m[1].match(/<Name(\s[^>]*)?>([\s\S]*?)<\/Name>/);
    if (!n) continue;
    let name = decodeXml(n[2]);
    if (/Encoded\s*=\s*"true"/i.test(n[1] || '')) name = decodeURIComponent(name);
    names.push(name);
  }
  const next = xml.match(/<NextMarker(?:\s[^>]*)?>([\s\S]*?)<\/NextMarker>/);
  return { names, nextMarker: next && next[1].trim() ? decodeXml(next[1]) : null };
}

// -------------------------------------------------------------- client ----

export class AzureError extends Error {
  constructor(message, { status = null, code = null, retryable = false } = {}) {
    super(message);
    this.name = 'AzureError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const ACCOUNT = /^[a-z0-9]{3,24}$/;
const CONTAINER = /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$/;

export function parseAzureUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('storage url is not a valid URL');
  }
  if (u.protocol !== 'azure:') throw new Error('Azure storage url must start with azure://');
  if (u.username || u.password) throw new Error('put the Azure account key in GRAPIM_AZURE_ACCOUNT_KEY, not in the storage url');
  const account = u.hostname;
  if (!ACCOUNT.test(account)) throw new Error('Azure storage url needs an account name (3 to 24 lowercase letters and digits): azure://<account>/<container>/<prefix>');
  for (const k of u.searchParams.keys()) if (k !== 'endpoint') throw new Error(`Azure storage url takes only endpoint=, not ${JSON.stringify(k.slice(0, 40))}`);
  const parts = decodeURIComponent(u.pathname).replace(/^\/+|\/+$/g, '');
  const cut = parts.indexOf('/');
  const container = cut === -1 ? parts : parts.slice(0, cut);
  if (!CONTAINER.test(container)) throw new Error('Azure storage url needs a container (3 to 63 lowercase letters, digits and single dashes): azure://<account>/<container>/<prefix>');
  const rawPrefix = cut === -1 ? '' : parts.slice(cut + 1);
  const prefix = rawPrefix ? `${validateKey(rawPrefix)}/` : '';
  let endpoint;
  try {
    endpoint = new URL(u.searchParams.get('endpoint') || `https://${account}.blob.core.windows.net`);
  } catch {
    throw new Error('Azure endpoint is not a valid URL');
  }
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') throw new Error('Azure endpoint must be http(s)');
  if (endpoint.username || endpoint.password || endpoint.search) throw new Error('Azure endpoint must not carry credentials or a query');
  return { account, container, prefix, endpoint };
}

const shownKey = (k) => JSON.stringify(k);

export function createAzureStorage(url, env = process.env, opts = {}) {
  const { account, container, prefix, endpoint } = parseAzureUrl(url);
  const raw = String(env.GRAPIM_AZURE_ACCOUNT_KEY || '').trim();
  if (!raw) throw new Error('Azure storage needs GRAPIM_AZURE_ACCOUNT_KEY in the environment');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error('GRAPIM_AZURE_ACCOUNT_KEY must be the base64 account key from the portal');
  const key = Buffer.from(raw, 'base64');
  if (key.length < 16) throw new Error('GRAPIM_AZURE_ACCOUNT_KEY is too short to be an account key');

  const doFetch = opts.fetch || globalThis.fetch;
  const retry = { ...DEFAULT_RETRY, ...(opts.retry || {}) };
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pageSize = opts.pageSize ?? 1000;
  const now = opts.now || (() => new Date());
  const random = opts.random || Math.random;
  const basePath = endpoint.pathname.replace(/\/+$/, '');
  const containerPath = `${basePath}/${container}`;

  async function attempt(method, path, query, body, extraHeaders) {
    const headers = { 'x-ms-date': now().toUTCString(), 'x-ms-version': AZURE_VERSION, ...extraHeaders };
    if (body) headers['content-length'] = String(body.length);
    const { authorization } = signSharedKey({ method, headers, account, path, query, key });
    const send = { ...headers, authorization };
    delete send['content-length']; // fetch sets it from the body
    const qs = query.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v ?? '')}`).join('&');
    const target = `${endpoint.origin}${path}${qs ? `?${qs}` : ''}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch(target, { method, headers: send, body: body ?? undefined, signal: ac.signal, redirect: 'manual' });
      const buf = method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer());
      return { status: res.status, headers: res.headers, body: buf };
    } catch (err) {
      if (ac.signal.aborted) throw new AzureError(`timed out after ${timeoutMs} ms`, { code: 'timeout', retryable: true });
      const code = err?.cause?.code || err?.code || null;
      throw new AzureError(`network error${code ? ` (${code})` : ''}`, { code: code || 'network', retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(op, method, { key: objKey = null, query = [], body = null, accept = [200], headers = {} }) {
    const path = objKey === null ? containerPath : `${containerPath}/${uriEncode(prefix + objKey, { keepSlash: true })}`;
    const what = `Azure ${op}${objKey === null ? '' : ` ${shownKey(objKey)}`}`;
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
        res = await attempt(method, path, query, body, headers);
      } catch (err) {
        last = new AzureError(`${what} failed: ${err.message}`, { code: err.code, retryable: true });
        continue;
      }
      if (accept.includes(res.status)) return res;
      const fromHeader = res.headers.get('x-ms-error-code');
      const fromBody = (res.body.toString('utf8').match(/<Code>([A-Za-z0-9._-]{1,100})<\/Code>/) || [])[1]; // untrusted endpoint (batch 5, L5)
      const code = (fromHeader && /^[A-Za-z0-9]{1,100}$/.test(fromHeader) ? fromHeader : fromBody) || null;
      const retryable = res.status >= 500 || res.status === 429;
      last = new AzureError(`${what} failed: HTTP ${res.status}${code ? ` ${code}` : ''}`, { status: res.status, code, retryable });
      last.retryAfter = res.headers.get('retry-after');
      if (!retryable) throw last;
    }
    last.message += ` (gave up after ${retry.retries + 1} attempts)`;
    throw last;
  }

  return {
    kind: 'azure',
    // Safe to log: no credentials.
    describe: () => `azure://${account}/${container}/${prefix} via ${endpoint.origin}`,

    async put(objKey, buf) {
      validateKey(objKey);
      const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      await request('PutBlob', 'PUT', { key: objKey, body, accept: [201], headers: { 'content-type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' } });
    },

    async get(objKey) {
      validateKey(objKey);
      const res = await request('GetBlob', 'GET', { key: objKey, accept: [200, 404] });
      return res.status === 404 ? null : res.body;
    },

    async has(objKey) {
      validateKey(objKey);
      const res = await request('GetBlobProperties', 'HEAD', { key: objKey, accept: [200, 404] });
      return res.status === 200;
    },

    async delete(objKey) {
      validateKey(objKey);
      await request('DeleteBlob', 'DELETE', { key: objKey, accept: [202, 404] });
    },

    async list(listPrefix = '') {
      validatePrefix(listPrefix);
      const full = prefix + listPrefix;
      const out = [];
      const seen = new Set();
      let marker = null;
      do {
        const query = [['restype', 'container'], ['comp', 'list'], ['maxresults', String(pageSize)]];
        if (full) query.push(['prefix', full]);
        if (marker) query.push(['marker', marker]);
        const res = await request('ListBlobs', 'GET', { query });
        let page;
        try {
          page = parseListBlobs(res.body.toString('utf8'));
        } catch (err) {
          throw new AzureError(`Azure ListBlobs failed: ${err.message}`, { status: res.status, code: 'bad_xml' });
        }
        for (const n of page.names) if (n.startsWith(prefix)) out.push(n.slice(prefix.length));
        marker = page.nextMarker;
        if (marker && seen.has(marker)) throw new AzureError('Azure ListBlobs failed: marker repeated', { code: 'bad_xml' });
        if (marker) seen.add(marker);
      } while (marker);
      return out.sort();
    },
  };
}
