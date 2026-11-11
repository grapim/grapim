// Fake object stores for the storage tests: an S3 (also in GCS mode) that
// verifies AWS SigV4, and an Azure Blob service that verifies Shared Key.
// Each verifier rebuilds the canonical request from the raw HTTP request as
// received, with its own encoder and parser (not src/storage), so a wrong
// signature from a client fails with 403. Not a test file itself.

import crypto from 'node:crypto';
import http from 'node:http';

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmacOf = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
export const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function listen(server, state) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    state.port = server.address().port;
    state.endpoint = `http://127.0.0.1:${state.port}`;
    state.close = () => new Promise((r) => {
      server.closeAllConnections();
      server.close(r);
    });
    resolve(state);
  }));
}

// ------------------------------------------------------------------- S3 ----

export function verifySigV4(req, body, creds) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/);
  if (!m) return 'malformed authorization';
  const [, akid, day, region, signed, signature] = m;
  if (akid !== creds.accessKeyId) return 'unknown access key';
  if (creds.region && region !== creds.region) return 'wrong region in the credential scope';
  const amzDate = req.headers['x-amz-date'] || '';
  if (amzDate.slice(0, 8) !== day) return 'date mismatch';
  const names = signed.split(';');
  for (const need of ['host', 'x-amz-content-sha256', 'x-amz-date']) if (!names.includes(need)) return `${need} not signed`;
  if (creds.sessionToken && (!names.includes('x-amz-security-token') || req.headers['x-amz-security-token'] !== creds.sessionToken)) return 'session token missing';
  const payload = req.headers['x-amz-content-sha256'];
  if (payload !== 'UNSIGNED-PAYLOAD' && payload !== crypto.createHash('sha256').update(body).digest('hex')) return 'payload hash mismatch';

  const [rawPath, rawQuery = ''] = req.url.split('?');
  const canonPath = rawPath.split('/').map((seg) => enc(decodeURIComponent(seg))).join('/');
  const canonQuery = rawQuery
    ? rawQuery.split('&').map((kv) => {
      const i = kv.indexOf('=');
      const k = decodeURIComponent(i === -1 ? kv : kv.slice(0, i));
      const v = i === -1 ? '' : decodeURIComponent(kv.slice(i + 1));
      return `${enc(k)}=${enc(v)}`;
    }).sort().join('&')
    : '';
  const canonHeaders = names.map((n) => `${n}:${String(req.headers[n] ?? '').trim().replace(/ +/g, ' ')}\n`).join('');
  const creq = `${req.method}\n${canonPath}\n${canonQuery}\n${canonHeaders}\n${signed}\n${payload}`;
  const sts = `AWS4-HMAC-SHA256\n${amzDate}\n${day}/${region}/s3/aws4_request\n${crypto.createHash('sha256').update(creq).digest('hex')}`;
  let k = hmacOf(`AWS4${creds.secretAccessKey}`, day);
  for (const part of [region, 's3', 'aws4_request']) k = hmacOf(k, part);
  const expected = hmacOf(k, sts).toString('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return { sts };
  return null;
}

// options: gcs (GCS's XML API: x-amz-security-token refused, DELETE of a
// missing object is 404), listMode 'v2' | 'v1' (list-type ignored, NextMarker)
// | 'v1-nomarker' (list-type ignored, no NextMarker: the last key is the marker).
// state.failWhen(req) -> status | null fails chosen requests.
export function startFakeS3({ bucket, creds, pageSize = 2, gcs = false, listMode = 'v2' }) {
  const objects = new Map();
  const state = { objects, requests: [], puts: new Map(), failNext: [], failWhen: null, hangNext: 0, signatureFailures: 0, listMode };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      state.requests.push({ method: req.method, url: req.url, headers: { ...req.headers } });
      const xmlErr = (status, code, extra = '') => {
        res.writeHead(status, { 'content-type': 'application/xml' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>fake</Message>${extra}</Error>`);
      };
      if (state.hangNext > 0) {
        state.hangNext--;
        return; // never answer: the client must time out
      }
      if (state.failNext.length) {
        const status = state.failNext.shift();
        return xmlErr(status, status === 503 ? 'SlowDown' : status === 429 ? 'TooManyRequests' : 'AccessDenied');
      }
      const forced = state.failWhen?.(req);
      if (forced) {
        if (forced >= 300 && forced < 400) {
          res.writeHead(forced, { location: 'https://169.254.169.254/latest/meta-data/' });
          return res.end();
        }
        return xmlErr(forced, forced === 403 ? 'AccessDenied' : 'InternalError');
      }
      if (gcs && req.headers['x-amz-security-token']) return xmlErr(400, 'InvalidArgument');
      const bad = verifySigV4(req, body, creds);
      if (bad) {
        state.signatureFailures++;
        // Real S3 echoes the string to sign; the client must not repeat it.
        return xmlErr(403, 'SignatureDoesNotMatch', `<StringToSign>${xmlEsc(bad.sts || String(bad))}</StringToSign><SignatureProvided>${xmlEsc(req.headers.authorization || '')}</SignatureProvided>`);
      }
      const [rawPath, rawQuery = ''] = req.url.split('?');
      const segs = rawPath.split('/').slice(1).map(decodeURIComponent);
      if (segs[0] !== bucket) return xmlErr(404, 'NoSuchBucket');
      const key = segs.slice(1).join('/');
      const q = new URLSearchParams(rawQuery);

      if (!key && req.method === 'GET' && (q.get('list-type') === '2' || state.listMode !== 'v2')) {
        const prefix = q.get('prefix') || '';
        const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const max = Math.min(Number(q.get('max-keys') || 1000), pageSize);
        let start = 0;
        if (state.listMode === 'v2') {
          const token = q.get('continuation-token');
          start = token ? Number(token.match(/^tok&<(\d+)> \+\/=$/)?.[1] ?? NaN) : 0;
          if (!Number.isFinite(start)) return xmlErr(400, 'InvalidArgument');
        } else {
          const marker = q.get('marker');
          if (marker) start = all.findIndex((k) => k > marker);
          if (start < 0) start = all.length;
        }
        const page = all.slice(start, start + max);
        const truncated = start + max < all.length;
        const next = state.listMode === 'v2'
          ? (truncated ? `<NextContinuationToken>${xmlEsc(`tok&<${start + max}> +/=`)}</NextContinuationToken>` : '')
          : (truncated && state.listMode === 'v1' ? `<NextMarker>${xmlEsc(page[page.length - 1])}</NextMarker>` : '');
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${xmlEsc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${
          page.map((k) => `<Contents><Key>${xmlEsc(k)}</Key><Size>${objects.get(k).length}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('')
        }${next}</ListBucketResult>`);
      }
      if (!key) return xmlErr(400, 'InvalidRequest');
      if (req.method === 'PUT') {
        objects.set(key, body);
        state.puts.set(key, (state.puts.get(key) ?? 0) + 1);
        res.writeHead(200, { etag: `"${crypto.createHash('md5').update(body).digest('hex')}"` });
        return res.end();
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!objects.has(key)) return req.method === 'HEAD' ? (res.writeHead(404), res.end()) : xmlErr(404, 'NoSuchKey');
        const buf = objects.get(key);
        res.writeHead(200, { 'content-length': buf.length, 'content-type': 'application/octet-stream' });
        return res.end(req.method === 'HEAD' ? undefined : buf);
      }
      if (req.method === 'DELETE') {
        if (gcs && !objects.has(key)) return xmlErr(404, 'NoSuchKey');
        objects.delete(key);
        res.writeHead(204);
        return res.end();
      }
      return xmlErr(405, 'MethodNotAllowed');
    });
  });
  return listen(server, state);
}

// ---------------------------------------------------------------- Azure ----

const AZ_STANDARD = ['content-encoding', 'content-language', 'content-length', 'content-md5', 'content-type', 'date', 'if-modified-since', 'if-match', 'if-none-match', 'if-unmodified-since', 'range'];

// Shared Key as the Azure docs define it, from the raw request.
export function verifySharedKey(req, account, keyB64, now = Date.now()) {
  const m = /^SharedKey ([a-z0-9]+):([A-Za-z0-9+/=]+)$/.exec(req.headers.authorization || '');
  if (!m) return 'malformed authorization';
  if (m[1] !== account) return 'wrong account';
  if (!req.headers['x-ms-version']) return 'x-ms-version missing';
  const date = Date.parse(req.headers['x-ms-date'] || '');
  if (!Number.isFinite(date) || Math.abs(now - date) > 15 * 60 * 1000) return 'x-ms-date missing or skewed';
  const std = AZ_STANDARD.map((h) => {
    const v = req.headers[h] ?? '';
    return h === 'content-length' && v === '0' ? '' : v;
  });
  const msHeaders = Object.keys(req.headers).filter((h) => h.startsWith('x-ms-')).sort().map((h) => `${h}:${String(req.headers[h]).trim()}\n`).join('');
  const [rawPath, rawQuery = ''] = req.url.split('?');
  let resource = `/${account}${rawPath}`;
  const params = new Map();
  for (const [k, v] of new URLSearchParams(rawQuery)) {
    const n = k.toLowerCase();
    if (!params.has(n)) params.set(n, []);
    params.get(n).push(v);
  }
  for (const n of [...params.keys()].sort()) resource += `\n${n}:${params.get(n).sort().join(',')}`;
  const sts = `${[req.method, ...std].join('\n')}\n${msHeaders}${resource}`;
  const expected = crypto.createHmac('sha256', Buffer.from(keyB64, 'base64')).update(sts, 'utf8').digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(m[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { sts };
  return null;
}

export function startFakeAzure({ account, container, key, pageSize = 2 }) {
  const blobs = new Map();
  const state = { blobs, requests: [], puts: new Map(), signatureFailures: 0, failWhen: null };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      state.requests.push({ method: req.method, url: req.url, headers: { ...req.headers } });
      const err = (status, code, extra = '') => {
        res.writeHead(status, { 'content-type': 'application/xml', 'x-ms-error-code': code });
        res.end(req.method === 'HEAD' ? undefined : `<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>fake</Message>${extra}</Error>`);
      };
      const forced = state.failWhen?.(req);
      if (forced) return err(forced, forced === 403 ? 'AuthorizationPermissionMismatch' : 'InternalError');
      const bad = verifySharedKey(req, account, key);
      if (bad) {
        state.signatureFailures++;
        // Real Azure echoes the string to sign; the client must not repeat it.
        return err(403, 'AuthenticationFailed', `<AuthenticationErrorDetail>${xmlEsc(bad.sts ? `The MAC signature found in the HTTP request is not the same as any computed signature. Server used following string to sign: '${bad.sts}'.` : String(bad))}</AuthenticationErrorDetail>`);
      }
      const [rawPath, rawQuery = ''] = req.url.split('?');
      const segs = rawPath.split('/').slice(1).map(decodeURIComponent);
      if (segs[0] !== container) return err(404, 'ContainerNotFound');
      const name = segs.slice(1).join('/');
      const q = new URLSearchParams(rawQuery);
      if (!name && req.method === 'GET' && q.get('restype') === 'container' && q.get('comp') === 'list') {
        const prefix = q.get('prefix') || '';
        const all = [...blobs.keys()].filter((k) => k.startsWith(prefix)).sort();
        const marker = q.get('marker');
        const start = marker ? Number(/^m!(\d+)!$/.exec(marker)?.[1] ?? NaN) : 0;
        if (!Number.isFinite(start)) return err(400, 'OutOfRangeInput');
        const max = Math.min(Number(q.get('maxresults') || 5000), pageSize);
        const page = all.slice(start, start + max);
        const next = start + max < all.length ? `m!${start + max}!` : '';
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`﻿<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="https://${account}.blob.core.windows.net/" ContainerName="${container}"><Prefix>${xmlEsc(prefix)}</Prefix><MaxResults>${max}</MaxResults><Blobs>${
          page.map((k) => `<Blob><Name>${xmlEsc(k)}</Name><Properties><Content-Length>${blobs.get(k).length}</Content-Length><BlobType>BlockBlob</BlobType></Properties></Blob>`).join('')
        }</Blobs><NextMarker>${next}</NextMarker></EnumerationResults>`);
      }
      if (!name) return err(400, 'InvalidQueryParameterValue');
      if (req.method === 'PUT') {
        if (req.headers['x-ms-blob-type'] !== 'BlockBlob') return err(400, 'MissingRequiredHeader');
        blobs.set(name, body);
        state.puts.set(name, (state.puts.get(name) ?? 0) + 1);
        res.writeHead(201);
        return res.end();
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!blobs.has(name)) return err(404, 'BlobNotFound');
        const buf = blobs.get(name);
        res.writeHead(200, { 'content-length': buf.length, 'x-ms-blob-type': 'BlockBlob' });
        return res.end(req.method === 'HEAD' ? undefined : buf);
      }
      if (req.method === 'DELETE') {
        if (!blobs.has(name)) return err(404, 'BlobNotFound');
        blobs.delete(name);
        res.writeHead(202);
        return res.end();
      }
      return err(405, 'UnsupportedHttpVerb');
    });
  });
  return listen(server, state);
}

// ------------------------------------------------------------ transport ----

// The team-storage transport for tests: the request is sent to the fake
// listening for the URL's host name, with the original Host header (it is
// signed). `hosts`: { 'name.example': fake }.
export function transportTo(hosts, calls = []) {
  return (target, init) => new Promise((resolve, reject) => {
    const u = new URL(target);
    const fake = hosts[u.hostname];
    calls.push({ host: u.hostname, method: init.method });
    if (!fake) return reject(Object.assign(new Error(`no fake for ${u.hostname}`), { code: 'ENOTFOUND' }));
    const headers = { ...init.headers, host: u.host };
    if (init.body) headers['content-length'] = init.body.length;
    const req = http.request({ host: '127.0.0.1', port: fake.port, path: `${u.pathname}${u.search}`, method: init.method, headers, signal: init.signal }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: { get: (n) => res.headers[n.toLowerCase()] ?? null },
        arrayBuffer: async () => Buffer.concat(chunks),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(init.body);
  });
}
