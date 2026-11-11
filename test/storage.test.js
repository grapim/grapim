import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStorage, defaultStorageUrl } from '../src/storage/index.js';
import {
  signingKey, signV4, uriEncode, sha256hex, EMPTY_SHA256, parseListObjectsV2, decodeXml, parseS3Url,
} from '../src/storage/s3.js';
import {
  persistBlob, writeManifest, readManifest, snapshotWorkspace, restoreWorkspace, createPersister,
  blobKey, manifestKey, sha1,
} from '../src/storage/workspace.js';
import { canonicalizedResource, parseAzureUrl, parseListBlobs, signSharedKey, stringToSign as azureStringToSign } from '../src/storage/azure.js';
import { parseGcsUrl } from '../src/storage/s3.js';
import { startFakeAzure, startFakeS3 } from './fake-clouds.js';

const tmp = (tag = 'x') => fs.mkdtempSync(path.join(os.tmpdir(), `grapim-storage-${tag}-`));
const fileUrl = (dir) => pathToFileURL(dir).href;

// ------------------------------------------------------------------ local ---

describe('local storage (file://)', () => {
  test('round trip: put, get, has, overwrite, missing is null', async () => {
    const s = createStorage(fileUrl(tmp('local')));
    const bin = Buffer.from([0, 1, 2, 255, 13, 10, 0]);
    await s.put('ws/t1/blobs/abc', bin);
    assert.deepEqual(await s.get('ws/t1/blobs/abc'), bin);
    assert.equal(await s.has('ws/t1/blobs/abc'), true);
    await s.put('ws/t1/blobs/abc', Buffer.from('second'));
    assert.equal((await s.get('ws/t1/blobs/abc')).toString(), 'second');
    assert.equal(await s.get('ws/t1/blobs/nope'), null);
    assert.equal(await s.has('ws/t1/blobs/nope'), false);
    assert.equal(await s.has('ws/t1'), false, 'a folder is not an object');
  });

  test('writes are atomic: no temp files are left behind', async () => {
    const dir = tmp('atomic');
    const s = createStorage(fileUrl(dir));
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.put('same/key', Buffer.from(`v${i}`))));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'same')), ['key']);
    assert.match((await s.get('same/key')).toString(), /^v\d+$/);
  });

  test('list walks the folder and filters by prefix', async () => {
    const s = createStorage(fileUrl(tmp('list')));
    for (const k of ['ws/a/blobs/1', 'ws/a/blobs/2', 'ws/a/manifest.json', 'ws/b/blobs/1', 'top']) await s.put(k, Buffer.from(k));
    assert.deepEqual(await s.list('ws/a/'), ['ws/a/blobs/1', 'ws/a/blobs/2', 'ws/a/manifest.json']);
    assert.deepEqual(await s.list('ws/a/blobs/'), ['ws/a/blobs/1', 'ws/a/blobs/2']);
    assert.deepEqual(await s.list('ws/a/man'), ['ws/a/manifest.json']);
    assert.deepEqual(await s.list(), ['top', 'ws/a/blobs/1', 'ws/a/blobs/2', 'ws/a/manifest.json', 'ws/b/blobs/1']);
    assert.deepEqual(await s.list('nothing/'), []);
  });

  test('delete is idempotent', async () => {
    const s = createStorage(fileUrl(tmp('del')));
    await s.put('a/b', Buffer.from('x'));
    await s.delete('a/b');
    await s.delete('a/b');
    await s.delete('never/was');
    assert.equal(await s.get('a/b'), null);
    assert.deepEqual(await s.list(), []);
  });

  test('traversal and malformed keys are refused, nothing is written outside', async () => {
    const parent = tmp('trav');
    const dir = path.join(parent, 'store');
    const s = createStorage(fileUrl(dir));
    const bad = ['../x', 'a/../../x', '..', '/etc/passwd', 'a\\..\\x', 'C:/x', 'a//b', '', 'a/', './a', 'a/./b',
      'ws/%2e%2e/x', 'a b', 'a\0b', 'é', 'a..b'];
    for (const k of bad) {
      for (const op of ['put', 'get', 'has', 'delete']) {
        await assert.rejects(() => s[op](k, Buffer.from('evil')), { code: 'invalid_key' }, `${op} ${JSON.stringify(k)}`);
      }
    }
    await assert.rejects(() => s.list('../'), { code: 'invalid_key' });
    await assert.rejects(() => s.list('/'), { code: 'invalid_key' });
    assert.deepEqual(fs.readdirSync(parent).filter((n) => n !== 'store'), []);
  });

  test('createStorage rejects unknown schemes; defaultStorageUrl is a file url', () => {
    assert.throws(() => createStorage('ftp://x/y'), /unsupported storage url scheme/);
    assert.throws(() => createStorage(''), /empty/);
    const u = defaultStorageUrl({ HUB_DATA: path.join(os.tmpdir(), 'hubdata') });
    assert.match(u, /^file:\/\/.*hubdata\/storage$/);
    assert.equal(createStorage(u).kind, 'file');
  });
});

// ------------------------------------------------- SigV4 test vectors ----

describe('SigV4 against AWS published test vectors', () => {
  // Signing-key derivation example from the AWS General Reference page
  // "Examples of how to derive a signing key for Signature Version 4":
  //   https://docs.aws.amazon.com/general/latest/gr/signature-v4-examples.html
  // (secret wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY, 20120215, us-east-1, iam).
  test('signing key: AWS derive-signing-key example', () => {
    const k = signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam');
    assert.equal(k.toString('hex'), 'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
  });

  // AWS Signature Version 4 test suite, as published by AWS Labs in aws-c-auth:
  //   https://github.com/awslabs/aws-c-auth/tree/main/tests/aws-signing-test-suite/v4
  // Each case: <case>/header-canonical-request.txt, header-string-to-sign.txt,
  // header-signature.txt and context.json (AKIDEXAMPLE, region us-east-1,
  // service "service", 2015-08-30T12:36:00Z).
  const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  const AMZ_DATE = '20150830T123600Z';
  const SCOPE = '20150830/us-east-1/service/aws4_request';
  const base = { host: 'example.amazonaws.com', 'x-amz-date': AMZ_DATE };
  const UNRESERVED = '-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const cases = [
    {
      name: 'get-vanilla', method: 'GET', path: '/', headers: base,
      canonical: `GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:${AMZ_DATE}\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
      sts: 'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
      sig: '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    },
    {
      name: 'get-vanilla-query-order-key-case', method: 'GET', path: '/', query: [['Param2', 'value2'], ['Param1', 'value1']], headers: base,
      canonical: `GET\n/\nParam1=value1&Param2=value2\nhost:example.amazonaws.com\nx-amz-date:${AMZ_DATE}\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
      sts: '816cd5b414d056048ba4f7c5386d6e0533120fb1fcfa93762cf0fc39e2cf19e0',
      sig: 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500',
    },
    {
      name: 'get-unreserved', method: 'GET', path: `/${uriEncode(UNRESERVED)}`, headers: base,
      sts: '6a968768eefaa713e2a6b16b589a8ea192661f098f37349f4e2c0082757446f9',
      sig: '07ef7494c76fa4850883e2b006601f940f8a34d404d0cfa977f52a65bbf5f24f',
    },
    {
      name: 'get-vanilla-query-unreserved', method: 'GET', path: '/', query: [[UNRESERVED, UNRESERVED]], headers: base,
      sts: 'c30d4703d9f799439be92736156d47ccfb2d879ddf56f5befa6d1d6aab979177',
      sig: '9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197',
    },
    {
      // normalize: false in context.json, which is how S3 treats paths.
      name: 'get-space-unnormalized', method: 'GET', path: `/${uriEncode('example space')}/`, headers: base,
      canonical: `GET\n/example%20space/\n\nhost:example.amazonaws.com\nx-amz-date:${AMZ_DATE}\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
      sts: '63ee75631ed7234ae61b5f736dfc7754cdccfedbff4b5128a915706ee9390d86',
      sig: '652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741',
    },
    {
      name: 'get-utf8', method: 'GET', path: `/${uriEncode('\u1234')}`, headers: base,
      canonical: `GET\n/%E1%88%B4\n\nhost:example.amazonaws.com\nx-amz-date:${AMZ_DATE}\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
      sts: '2a0a97d02205e45ce2e994789806b19270cfbbb0921b278ccf58f5249ac42102',
      sig: '8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85',
    },
    {
      name: 'get-vanilla-utf8-query', method: 'GET', path: '/', query: [['\u1234', 'bar']], headers: base,
      sts: 'eb30c5bed55734080471a834cc727ae56beb50e5f39d1bff6d0d38cb192a7073',
      sig: '2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04',
    },
    {
      name: 'get-header-value-trim', method: 'GET', path: '/',
      headers: { ...base, 'My-Header1': ' value1', 'My-Header2': ' "a   b   c"' },
      canonical: `GET\n/\n\nhost:example.amazonaws.com\nmy-header1:value1\nmy-header2:"a b c"\nx-amz-date:${AMZ_DATE}\n\nhost;my-header1;my-header2;x-amz-date\n${EMPTY_SHA256}`,
      sts: 'a726db9b0df21c14f559d0a978e563112acb1b9e05476f0a6a1c7d68f28605c7',
      sig: 'acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736',
    },
    {
      name: 'get-vanilla-with-session-token', method: 'GET', path: '/',
      headers: { ...base, 'x-amz-security-token': '6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267' },
      sts: '067b36aa60031588cea4a4cde1f21215227a047690c72247f1d70b32fbbfad2b',
      sig: '07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8',
    },
    {
      name: 'post-x-www-form-urlencoded', method: 'POST', path: '/', body: 'Param1=value1',
      headers: {
        'content-length': '13', 'content-type': 'application/x-www-form-urlencoded', host: 'example.amazonaws.com',
        'x-amz-content-sha256': '9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e', 'x-amz-date': AMZ_DATE,
      },
      sts: 'b1edd1d03544c25390e32085d55b57acc9a3961bb59415ff86c45c3d89d16cfb',
      sig: 'd3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b',
    },
  ];

  for (const c of cases) {
    test(`suite case ${c.name}: canonical request, string to sign, signature`, () => {
      const payloadHash = c.body ? sha256hex(c.body) : EMPTY_SHA256;
      const r = signV4({
        method: c.method, path: c.path, query: c.query || [], headers: c.headers, payloadHash,
        accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET, region: 'us-east-1', service: 'service', amzDate: AMZ_DATE,
      });
      if (c.canonical) assert.equal(r.canonicalRequest, c.canonical);
      assert.equal(r.stringToSign, `AWS4-HMAC-SHA256\n${AMZ_DATE}\n${SCOPE}\n${c.sts}`);
      assert.equal(r.signature, c.sig);
      assert.equal(r.authorization, `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/${SCOPE}, SignedHeaders=${r.signedHeaders}, Signature=${c.sig}`);
    });
  }
});

// ------------------------------------------------------- fake S3 server ----

// The fakes (test/fake-clouds.js) verify signatures independently of src/storage.

describe('S3 storage against a fake S3 that checks SigV4', () => {
  const creds = { accessKeyId: 'AKIDTESTKEY', secretAccessKey: 'test/secret+KEY/do-not-leak-0123456789', sessionToken: null };
  const env = { GRAPIM_S3_ACCESS_KEY_ID: creds.accessKeyId, GRAPIM_S3_SECRET_ACCESS_KEY: creds.secretAccessKey };
  const fast = { retry: { retries: 3, baseDelayMs: 1, maxDelayMs: 5 }, timeoutMs: 2000 };
  let fake;
  let url;
  before(async () => {
    fake = await startFakeS3({ bucket: 'grapim-test', creds });
    url = `s3://grapim-test/grapim?endpoint=${encodeURIComponent(fake.endpoint)}&region=auto`;
  });
  after(() => fake.close());

  test('url parsing: bucket, prefix, endpoint default for AWS, R2 region auto', () => {
    const aws = parseS3Url('s3://my-bucket/team/x?region=eu-west-1');
    assert.equal(aws.endpoint.href, 'https://s3.eu-west-1.amazonaws.com/');
    assert.equal(aws.prefix, 'team/x/');
    const r2 = parseS3Url('s3://b/grapim?endpoint=https://acct.r2.cloudflarestorage.com');
    assert.equal(r2.region, 'auto');
    assert.equal(parseS3Url('s3://b').prefix, '');
    assert.throws(() => parseS3Url('s3://b/a%2F..%2Fx'), { code: 'invalid_key' });
    assert.throws(() => parseS3Url('s3://b/x?region=auto'), /endpoint/);
    assert.throws(() => createStorage('s3://b/x', {}), /GRAPIM_S3_ACCESS_KEY_ID/);
  });

  test('put, get, has, delete round trip with a verified signature', async () => {
    const s = createStorage(url, env, fast);
    const bin = crypto.randomBytes(3000);
    await s.put('ws/t/blobs/one', bin);
    assert.deepEqual(fake.objects.get('grapim/ws/t/blobs/one'), bin, 'stored under the url prefix');
    assert.deepEqual(await s.get('ws/t/blobs/one'), bin);
    assert.equal(await s.has('ws/t/blobs/one'), true);
    assert.equal(await s.has('ws/t/blobs/two'), false);
    assert.equal(await s.get('ws/t/blobs/two'), null, '404 is null');
    await s.delete('ws/t/blobs/one');
    await s.delete('ws/t/blobs/one');
    assert.equal(await s.has('ws/t/blobs/one'), false);
    assert.equal(fake.signatureFailures, 0);
    await assert.rejects(() => s.put('../escape', Buffer.from('x')), { code: 'invalid_key' });
  });

  test('a session token is sent and signed', async () => {
    const withToken = { ...creds, sessionToken: 'FQoGZXIvYXdzE//token+value==' };
    const f2 = await startFakeS3({ bucket: 'b2', creds: withToken });
    try {
      const s = createStorage(`s3://b2?endpoint=${f2.endpoint}`, { ...env, GRAPIM_S3_SESSION_TOKEN: withToken.sessionToken }, fast);
      await s.put('k', Buffer.from('v'));
      assert.equal((await s.get('k')).toString(), 'v');
      assert.equal(f2.signatureFailures, 0);
    } finally {
      await f2.close();
    }
  });

  test('a wrong secret fails the signature check: 403, no retry, no secret in the error', async () => {
    const before = fake.requests.length;
    const s = createStorage(url, { ...env, GRAPIM_S3_SECRET_ACCESS_KEY: 'wrong-secret-value-XYZ' }, fast);
    const err = await s.put('ws/t/blobs/bad', Buffer.from('x')).catch((e) => e);
    assert.equal(err.status, 403);
    assert.equal(err.code, 'SignatureDoesNotMatch');
    assert.equal(fake.requests.length - before, 1, 'no retry on 4xx');
    assert.equal(fake.signatureFailures, 1, 'the fake really rejected the signature');
    fake.signatureFailures = 0;
    const text = `${err.message} ${err.stack} ${JSON.stringify(err)}`;
    for (const leak of ['wrong-secret-value-XYZ', creds.secretAccessKey, 'Signature=', 'StringToSign', 'AWS4-HMAC-SHA256']) {
      assert.ok(!text.includes(leak), `error must not contain ${leak}`);
    }
    assert.ok(!s.describe().includes('secret'));
    assert.ok(!JSON.stringify(Object.keys(s)).includes('secret'));
  });

  test('list pages through continuation tokens and decodes XML entities in keys', async () => {
    const s = createStorage(url, env, fast);
    const keys = ['ws/l/blobs/a', 'ws/l/blobs/b', 'ws/l/blobs/c', 'ws/l/blobs/d', 'ws/l/blobs/e', 'ws/l/manifest.json'];
    for (const k of keys) await s.put(k, Buffer.from(k));
    // An object written by someone else, whose key needs XML escaping.
    fake.objects.set('grapim/ws/l/odd&key<1>"\'.txt', Buffer.from('odd'));
    const before = fake.requests.length;
    const listed = await s.list('ws/l/');
    assert.deepEqual(listed, [...keys, 'ws/l/odd&key<1>"\'.txt'].sort());
    const lists = fake.requests.slice(before).filter((r) => r.url.includes('list-type=2'));
    assert.equal(lists.length, 4, '7 keys at 2 per page');
    assert.ok(lists.slice(1).every((r) => r.url.includes('continuation-token=tok%26%3C')), 'token is sent back encoded');
    assert.deepEqual(await s.list('ws/l/blobs/'), keys.slice(0, 5));
    assert.deepEqual(await s.list('nothing/'), []);
    assert.equal(fake.signatureFailures, 0);
  });

  test('XML parsing handles entities, character references and CDATA', () => {
    assert.equal(decodeXml('a&amp;b&lt;c&gt;d&quot;e&apos;f&#38;g&#x3C;h'), 'a&b<c>d"e\'f&g<h');
    const page = parseListObjectsV2('<?xml version="1.0"?><ListBucketResult xmlns="x"><IsTruncated>true</IsTruncated><Contents><Key>a&amp;b</Key></Contents><Contents><Key><![CDATA[c<d]]></Key></Contents><CommonPrefixes><Prefix>p/</Prefix></CommonPrefixes><NextContinuationToken>t&amp;1</NextContinuationToken></ListBucketResult>');
    assert.deepEqual(page, { keys: ['a&b', 'c<d'], isTruncated: true, nextContinuationToken: 't&1' });
    assert.throws(() => parseListObjectsV2('<Error><Code>x</Code></Error>'), /ListBucketResult/);
  });

  test('retries 503 and 429 with backoff, then succeeds', async () => {
    const s = createStorage(url, env, fast);
    fake.failNext.push(503, 503);
    let before = fake.requests.length;
    await s.put('ws/t/blobs/retry', Buffer.from('ok'));
    assert.equal(fake.requests.length - before, 3);
    fake.failNext.push(429);
    before = fake.requests.length;
    assert.equal((await s.get('ws/t/blobs/retry')).toString(), 'ok');
    assert.equal(fake.requests.length - before, 2);
  });

  test('gives up after the retry budget on persistent 503', async () => {
    const s = createStorage(url, env, { ...fast, retry: { retries: 2, baseDelayMs: 1, maxDelayMs: 2 } });
    fake.failNext.push(503, 503, 503);
    const before = fake.requests.length;
    await assert.rejects(() => s.has('ws/t/x'), (e) => e.status === 503 && /gave up after 3 attempts/.test(e.message));
    assert.equal(fake.requests.length - before, 3);
  });

  test('no retry on 403', async () => {
    const s = createStorage(url, env, fast);
    fake.failNext.push(403);
    const before = fake.requests.length;
    await assert.rejects(() => s.get('ws/t/blobs/retry'), { status: 403, code: 'AccessDenied' });
    assert.equal(fake.requests.length - before, 1);
  });

  test('a hung request times out through AbortController and is retried', async () => {
    const s = createStorage(url, env, { retry: { retries: 1, baseDelayMs: 1, maxDelayMs: 2 }, timeoutMs: 150 });
    fake.hangNext = 1;
    const before = fake.requests.length;
    await s.put('ws/t/blobs/slow', Buffer.from('eventually'));
    assert.equal(fake.requests.length - before, 2);
    fake.hangNext = 5;
    const s0 = createStorage(url, env, { retry: { retries: 0 }, timeoutMs: 100 });
    await assert.rejects(() => s0.has('ws/t/blobs/slow'), { code: 'timeout' });
    fake.hangNext = 0;
  });
});

// ------------------------------------------------- workspace persistence ----

function makeWorkspace() {
  const dir = tmp('ws');
  const w = (rel, data) => {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  };
  w('README.md', 'line one\r\nline two\r\n\r\nno newline at end');
  w('src/app.js', 'export const x = 1;\n');
  w('src/copy-of-app.js', 'export const x = 1;\n'); // same blob twice
  w('assets/logo.bin', crypto.randomBytes(70_000));
  w('assets/zeros.bin', Buffer.alloc(1024));
  w('empty.txt', '');
  w('deep/a/b/c/d.txt', 'mixed\nendings\r\nhere\r');
  w('unicode/café.txt', 'naïve ☕');
  // Git and Grapim state must be skipped.
  w('.git/HEAD', 'ref: refs/heads/main\n');
  w('.git/refs/heads/main', `${'a'.repeat(40)}\n`);
  w('.git/grapim/state.db', 'secret state');
  w('.grapim/state.db', 'more state');
  w('sub/.git/config', 'nested repo');
  return dir;
}

function readTree(root) {
  const out = {};
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else out[r] = fs.readFileSync(path.join(abs, e.name));
    }
  };
  walk(root, '');
  return out;
}

describe('workspace snapshot and restore', () => {
  test('snapshot then restore into an empty dir is byte-identical (local)', async () => {
    const src = makeWorkspace();
    const storage = createStorage(fileUrl(tmp('wsstore')));
    const r1 = await snapshotWorkspace(src, storage, 'team1/ws1');
    assert.equal(r1.files, 8);
    assert.equal(r1.uploaded, 7, 'duplicate content uploads once');
    assert.equal(r1.head, 'a'.repeat(40));
    const m = await readManifest(storage, 'team1/ws1');
    assert.ok(!Object.keys(m.files).some((p) => p.startsWith('.git') || p.startsWith('.grapim') || p.includes('/.git/')));
    assert.equal(m.files['README.md'], sha1(fs.readFileSync(path.join(src, 'README.md'))));

    const r2 = await snapshotWorkspace(src, storage, 'team1/ws1');
    assert.equal(r2.uploaded, 0, 'nothing re-uploaded when blobs are present');

    const dst = path.join(tmp('restore'), 'fresh');
    const res = await restoreWorkspace(storage, 'team1/ws1', dst);
    assert.equal(res.files, 8);
    const expected = readTree(src);
    for (const k of Object.keys(expected)) if (k.startsWith('.git/') || k.startsWith('.grapim/') || k.startsWith('sub/.git/')) delete expected[k];
    const got = readTree(dst);
    assert.deepEqual(Object.keys(got).sort(), Object.keys(expected).sort());
    for (const k of Object.keys(expected)) assert.ok(got[k].equals(expected[k]), `${k} differs`);
    assert.ok(got['README.md'].includes(Buffer.from('\r\n')), 'CRLF kept');
    assert.deepEqual(fs.readdirSync(path.dirname(dst)), ['fresh'], 'staging folder removed');
  });

  test('snapshot then restore through S3 is byte-identical too', async () => {
    const creds = { accessKeyId: 'AKIDWS', secretAccessKey: 'ws-secret' };
    const fake = await startFakeS3({ bucket: 'wsb', creds, pageSize: 3 });
    try {
      const storage = createStorage(`s3://wsb/grapim?endpoint=${fake.endpoint}`, { GRAPIM_S3_ACCESS_KEY_ID: creds.accessKeyId, GRAPIM_S3_SECRET_ACCESS_KEY: creds.secretAccessKey });
      const src = makeWorkspace();
      await snapshotWorkspace(src, storage, 'team/ws');
      assert.equal((await storage.list('ws/team/ws/blobs/')).length, 7);
      const dst = tmp('s3restore');
      await restoreWorkspace(storage, 'team/ws', dst);
      const a = readTree(src);
      const b = readTree(dst);
      for (const k of Object.keys(b)) assert.ok(b[k].equals(a[k]), `${k} differs`);
      assert.equal(Object.keys(b).length, 8);
      assert.equal(fake.signatureFailures, 0);
    } finally {
      await fake.close();
    }
  });

  test('restore returns null when there is no manifest', async () => {
    const storage = createStorage(fileUrl(tmp('nomani')));
    assert.equal(await restoreWorkspace(storage, 'none/here', tmp('nomani-dst')), null);
    assert.equal(await readManifest(storage, 'none/here'), null);
  });

  test('a tampered blob is refused and nothing is written', async () => {
    const src = makeWorkspace();
    const storage = createStorage(fileUrl(tmp('tamper')));
    await snapshotWorkspace(src, storage, 't/w');
    const m = await readManifest(storage, 't/w');
    await storage.put(blobKey('t/w', m.files['src/app.js']), Buffer.from('export const x = 2; // evil\n'));
    const dst = tmp('tamper-dst');
    await assert.rejects(() => restoreWorkspace(storage, 't/w', dst), { code: 'blob_mismatch' });
    assert.deepEqual(fs.readdirSync(dst), [], 'no file written');
  });

  test('a missing blob is refused', async () => {
    const storage = createStorage(fileUrl(tmp('missing')));
    await writeManifest(storage, 't/w', { files: { 'a.txt': 'b'.repeat(40) } });
    await assert.rejects(() => restoreWorkspace(storage, 't/w', tmp('missing-dst')), { code: 'blob_missing' });
  });

  test('manifest paths that escape dir are refused', async () => {
    const parent = tmp('escape');
    const dst = path.join(parent, 'ws');
    const storage = createStorage(fileUrl(path.join(parent, 'store')));
    const buf = Buffer.from('pwned');
    const sha = sha1(buf);
    await persistBlob(storage, 't/w', sha, buf);
    const evil = ['../evil.txt', 'a/../../evil.txt', '/tmp/evil.txt', 'C:/evil.txt', 'a\\..\\..\\evil.txt', '.git/hooks/pre-commit',
      'sub/.git/config', '.grapim/state.db', './x', 'a//b', '..'];
    for (const p of evil) {
      // Written straight to storage, the way an attacker with bucket access would.
      await storage.put(manifestKey('t/w'), Buffer.from(JSON.stringify({ version: 1, head: null, files: { 'ok.txt': sha, [p]: sha } })));
      await assert.rejects(() => restoreWorkspace(storage, 't/w', dst), { code: 'unsafe_path' }, p);
      await assert.rejects(() => writeManifest(storage, 't/w', { files: { [p]: sha } }), { code: 'unsafe_path' }, p);
    }
    assert.ok(!fs.existsSync(path.join(parent, 'evil.txt')));
    assert.ok(!fs.existsSync(path.join(dst, 'ok.txt')), 'refused before anything is written');
  });

  test('persistBlob is content-addressed and checks the sha', async () => {
    const storage = createStorage(fileUrl(tmp('pb')));
    const buf = Buffer.from('hello');
    assert.equal(await persistBlob(storage, 't/w', sha1(buf), buf), true);
    assert.equal(await persistBlob(storage, 't/w', sha1(buf), buf), false);
    await assert.rejects(() => persistBlob(storage, 't/w', sha1(Buffer.from('other')), buf), { code: 'blob_mismatch' });
    await assert.rejects(() => persistBlob(storage, 't/w', 'untracked', buf), { code: 'invalid_sha' });
    await assert.rejects(() => persistBlob(storage, '../w', sha1(buf), buf), { code: 'invalid_key' });
  });
});

describe('write-behind persister', () => {
  test('retries transient failures, dedupes, and flush waits for the queue', async () => {
    const inner = createStorage(fileUrl(tmp('pers')));
    let putFailures = 2;
    let concurrent = 0;
    let maxConcurrent = 0;
    const flaky = {
      ...inner,
      async put(key, buf) {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent--;
        if (putFailures > 0) {
          putFailures--;
          throw Object.assign(new Error('503 SlowDown'), { retryable: true });
        }
        return inner.put(key, buf);
      },
    };
    const p = createPersister(flaky, { concurrency: 2, retry: { retries: 5, baseDelayMs: 1, maxDelayMs: 5 } });
    const blobs = Array.from({ length: 6 }, (_, i) => Buffer.from(`blob ${i}`));
    for (const b of blobs) assert.equal(p.enqueue('t/w', sha1(b), b), true);
    assert.equal(p.enqueue('t/w', sha1(blobs[0]), blobs[0]), false, 'same blob queued once');
    assert.ok(p.stats().queued + p.stats().inflight > 0, 'enqueue returns before the upload');
    await p.flush();
    const st = p.stats();
    assert.equal(st.uploaded, 6);
    assert.equal(st.retried, 2);
    assert.equal(st.failed, 0);
    assert.equal(st.deduped, 1);
    assert.equal(st.queued, 0);
    assert.equal(st.inflight, 0);
    assert.ok(maxConcurrent <= 2);
    for (const b of blobs) assert.ok((await inner.get(blobKey('t/w', sha1(b)))).equals(b));
    await p.flush(); // idle flush resolves at once

    // Already present: counted, not uploaded again.
    p.enqueue('t/w', sha1(blobs[1]), blobs[1]);
    await p.flush();
    assert.equal(p.stats().present, 1);
  });

  test('permanent errors are not retried and are reported', async () => {
    const inner = createStorage(fileUrl(tmp('pers2')));
    let puts = 0;
    const denied = { ...inner, async put() { puts++; throw Object.assign(new Error('S3 PutObject failed: HTTP 403 AccessDenied'), { status: 403, retryable: false }); } };
    const errors = [];
    const p = createPersister(denied, { retry: { retries: 5, baseDelayMs: 1 }, onError: (err, job) => errors.push([err.status, job.sha]) });
    const b = Buffer.from('x');
    p.enqueue('t/w', sha1(b), b);
    p.enqueue('t/w', 'not-a-sha', b);
    await p.flush();
    assert.equal(puts, 1);
    assert.equal(p.stats().failed, 2);
    assert.deepEqual(errors.map((e) => e[0]), [undefined, 403]);
  });
});

// ------------------------------------------------------------------- GCS ----

describe('GCS (gs://) through the XML API, against the fake S3 in GCS mode', () => {
  const creds = { accessKeyId: 'GOOG1EHMACKEYIDEXAMPLE', secretAccessKey: 'gcs/hmac+secret-do-not-leak-42', region: 'auto' };
  const env = { GRAPIM_GCS_ACCESS_KEY_ID: creds.accessKeyId, GRAPIM_GCS_SECRET_ACCESS_KEY: creds.secretAccessKey };
  const fast = { retry: { retries: 2, baseDelayMs: 1, maxDelayMs: 5 }, timeoutMs: 2000 };
  let fake;
  let url;
  before(async () => {
    fake = await startFakeS3({ bucket: 'gcs-bucket', creds, gcs: true });
    url = `gs://gcs-bucket/grapim?endpoint=${encodeURIComponent(fake.endpoint)}`;
  });
  after(() => fake.close());

  test('url parsing: Google endpoint by default, region auto, prefix; credentials only from GRAPIM_GCS_*', () => {
    const g = parseGcsUrl('gs://my-bucket/team/x');
    assert.equal(g.endpoint.href, 'https://storage.googleapis.com/');
    assert.equal(g.region, 'auto');
    assert.equal(g.prefix, 'team/x/');
    assert.equal(parseGcsUrl('gs://b_1.example').prefix, '');
    assert.throws(() => parseGcsUrl('gs://b/x?region=us'), /only endpoint/);
    assert.throws(() => parseGcsUrl('gs://key:secret@b/x'), /not in the storage url/);
    assert.throws(() => parseGcsUrl('gs://b/a%2F..%2Fx'), { code: 'invalid_key' });
    assert.throws(() => createStorage('gs://b/x', {}), /GRAPIM_GCS_ACCESS_KEY_ID/);
    assert.throws(() => createStorage('gs://b/x', { GRAPIM_S3_ACCESS_KEY_ID: 'a', GRAPIM_S3_SECRET_ACCESS_KEY: 'b' }), /GRAPIM_GCS_ACCESS_KEY_ID/, 'S3 keys are not GCS keys');
    assert.equal(createStorage('gs://b/x', env).kind, 'gcs');
  });

  test('round trip with a verified signature: path-style, scope auto/s3/aws4_request, no session token', async () => {
    // A stray S3 session token in the environment must not be sent to GCS.
    const s = createStorage(url, { ...env, GRAPIM_S3_SESSION_TOKEN: 'stray-token' }, fast);
    const bin = crypto.randomBytes(2048);
    const before = fake.requests.length;
    await s.put('ws/t/blobs/one', bin);
    assert.deepEqual(fake.objects.get('grapim/ws/t/blobs/one'), bin, 'stored under the url prefix');
    assert.deepEqual(await s.get('ws/t/blobs/one'), bin);
    assert.equal(await s.has('ws/t/blobs/one'), true);
    assert.equal(await s.get('ws/t/blobs/two'), null);
    await s.delete('ws/t/blobs/one');
    await s.delete('ws/t/blobs/one'); // GCS answers 404 NoSuchKey here: still fine
    assert.equal(await s.has('ws/t/blobs/one'), false);
    const mine = fake.requests.slice(before);
    assert.ok(mine.every((r) => r.url.startsWith('/gcs-bucket/')), 'path-style');
    assert.ok(mine.every((r) => /Credential=GOOG1EHMACKEYIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request/.test(r.headers.authorization)));
    assert.ok(mine.every((r) => !('x-amz-security-token' in r.headers)));
    assert.ok(mine.every((r) => /^[0-9a-f]{64}$/.test(r.headers['x-amz-content-sha256'])));
    assert.equal(fake.signatureFailures, 0);
    assert.match(s.describe(), /^gs:\/\/gcs-bucket\/grapim\/ via http:\/\/127\.0\.0\.1:\d+ \(auto\)$/);
  });

  test('list pages with ListObjectsV2, and falls back to marker= when GCS answers a V1 page', async () => {
    const s = createStorage(url, env, fast);
    const keys = ['ws/l/blobs/a', 'ws/l/blobs/b', 'ws/l/blobs/c', 'ws/l/blobs/d', 'ws/l/manifest.json'];
    for (const k of keys) await s.put(k, Buffer.from(k));
    for (const mode of ['v2', 'v1', 'v1-nomarker']) {
      fake.listMode = mode;
      const before = fake.requests.length;
      assert.deepEqual(await s.list('ws/l/'), keys, mode);
      const lists = fake.requests.slice(before);
      assert.equal(lists.length, 3, `${mode}: 5 keys at 2 per page`);
      if (mode !== 'v2') assert.ok(lists.slice(1).every((r) => /[?&]marker=/.test(r.url)), `${mode}: marker sent`);
      else assert.ok(lists.slice(1).every((r) => /continuation-token=/.test(r.url)));
    }
    fake.listMode = 'v2';
    assert.equal(fake.signatureFailures, 0);
  });

  test('a wrong HMAC secret: 403 SignatureDoesNotMatch, no retry, nothing secret in the error', async () => {
    const s = createStorage(url, { ...env, GRAPIM_GCS_SECRET_ACCESS_KEY: 'wrong-gcs-secret-XYZ' }, fast);
    const before = fake.requests.length;
    const err = await s.put('ws/t/blobs/bad', Buffer.from('x')).catch((e) => e);
    assert.equal(err.status, 403);
    assert.equal(err.code, 'SignatureDoesNotMatch');
    assert.match(err.message, /^GCS PutObject/);
    assert.equal(fake.requests.length - before, 1);
    fake.signatureFailures = 0;
    const text = `${err.message} ${err.stack} ${JSON.stringify(err)}`;
    for (const leak of ['wrong-gcs-secret-XYZ', creds.secretAccessKey, 'Signature=', 'StringToSign', 'AWS4-HMAC-SHA256']) assert.ok(!text.includes(leak), leak);
  });
});

// ----------------------------------------------------------------- Azure ----

describe('Azure Blob Storage (azure://) with Shared Key, against a fake that verifies it', () => {
  const key = crypto.randomBytes(64).toString('base64');
  const env = { GRAPIM_AZURE_ACCOUNT_KEY: key };
  const fast = { retry: { retries: 2, baseDelayMs: 1, maxDelayMs: 5 }, timeoutMs: 2000 };
  let fake;
  let url;
  before(async () => {
    fake = await startFakeAzure({ account: 'grapimtest', container: 'workspaces', key });
    url = `azure://grapimtest/workspaces/grapim?endpoint=${encodeURIComponent(fake.endpoint)}`;
  });
  after(() => fake.close());

  test('url parsing: account, container, prefix, the default endpoint; bad names refused', () => {
    const a = parseAzureUrl('azure://acct123/my-container/team/x');
    assert.equal(a.endpoint.href, 'https://acct123.blob.core.windows.net/');
    assert.equal(a.container, 'my-container');
    assert.equal(a.prefix, 'team/x/');
    assert.equal(parseAzureUrl('azure://acct123/abc').prefix, '');
    for (const bad of ['azure://Acct/abc', 'azure://ab/abc', 'azure://acct123', 'azure://acct123/a--b', 'azure://acct123/-ab', 'azure://acct123/ab', 'azure://acct123/abc?region=x', 'azure://u:p@acct123/abc']) {
      assert.throws(() => parseAzureUrl(bad), Error, bad);
    }
    assert.throws(() => createStorage('azure://acct123/abc', {}), /GRAPIM_AZURE_ACCOUNT_KEY/);
    assert.throws(() => createStorage('azure://acct123/abc', { GRAPIM_AZURE_ACCOUNT_KEY: 'not base64!' }), /base64/);
    assert.equal(createStorage('azure://acct123/abc', env).kind, 'azure');
  });

  test('string to sign and canonicalized resource follow the documented layout', () => {
    assert.equal(
      canonicalizedResource('myaccount', '/mycontainer', [['restype', 'container'], ['comp', 'list'], ['Prefix', 'a b'], ['include', 'snapshots'], ['include', 'metadata']]),
      '/myaccount/mycontainer\ncomp:list\ninclude:metadata,snapshots\nprefix:a b\nrestype:container',
    );
    const headers = { 'x-ms-version': '2021-08-06', 'x-ms-date': 'Fri, 26 Jun 2015 23:39:12 GMT', 'content-type': 'application/octet-stream', 'content-length': '11', 'x-ms-blob-type': 'BlockBlob' };
    assert.equal(
      azureStringToSign({ method: 'PUT', headers, account: 'myaccount', path: '/mycontainer/a/b.txt' }),
      'PUT\n\n\n11\n\napplication/octet-stream\n\n\n\n\n\n\nx-ms-blob-type:BlockBlob\nx-ms-date:Fri, 26 Jun 2015 23:39:12 GMT\nx-ms-version:2021-08-06\n/myaccount/mycontainer/a/b.txt',
    );
    // Content-Length 0 is an empty line (x-ms-version 2015-02-21 and later).
    assert.match(azureStringToSign({ method: 'PUT', headers: { ...headers, 'content-length': '0' }, account: 'a', path: '/c/k' }), /^PUT\n\n\n\n\napplication/);
    const k = Buffer.from('secret-key-material-0123456789ab');
    const { authorization, signature } = signSharedKey({ method: 'GET', headers: { 'x-ms-date': 'x', 'x-ms-version': 'y' }, account: 'myaccount', path: '/c/k', key: k });
    assert.equal(authorization, `SharedKey myaccount:${signature}`);
    assert.equal(signature, crypto.createHmac('sha256', k).update('GET\n\n\n\n\n\n\n\n\n\n\n\nx-ms-date:x\nx-ms-version:y\n/myaccount/c/k').digest('base64'));
  });

  test('put, get, has, delete round trip with a verified Shared Key', async () => {
    const s = createStorage(url, env, fast);
    const bin = crypto.randomBytes(4096);
    await s.put('ws/t/blobs/one', bin);
    assert.deepEqual(fake.blobs.get('grapim/ws/t/blobs/one'), bin, 'stored under the url prefix');
    assert.deepEqual(await s.get('ws/t/blobs/one'), bin);
    assert.equal(await s.has('ws/t/blobs/one'), true);
    assert.equal(await s.has('ws/t/blobs/two'), false);
    assert.equal(await s.get('ws/t/blobs/two'), null);
    await s.put('ws/t/empty', Buffer.alloc(0));
    assert.equal((await s.get('ws/t/empty')).length, 0, 'an empty blob signs Content-Length as empty');
    await s.delete('ws/t/blobs/one');
    await s.delete('ws/t/blobs/one');
    assert.equal(await s.has('ws/t/blobs/one'), false);
    assert.equal(fake.signatureFailures, 0);
    assert.ok(fake.requests.every((r) => r.headers['x-ms-version'] && r.headers['x-ms-date']));
    await assert.rejects(() => s.put('../escape', Buffer.from('x')), { code: 'invalid_key' });
    assert.match(s.describe(), /^azure:\/\/grapimtest\/workspaces\/grapim\/ via /);
    assert.ok(!s.describe().includes(key));
  });

  test('list pages through NextMarker', async () => {
    const s = createStorage(url, env, fast);
    const keys = ['ws/l/blobs/a', 'ws/l/blobs/b', 'ws/l/blobs/c', 'ws/l/blobs/d', 'ws/l/blobs/e', 'ws/l/manifest.json'];
    for (const k of keys) await s.put(k, Buffer.from(k));
    const before = fake.requests.length;
    assert.deepEqual(await s.list('ws/l/'), keys);
    const lists = fake.requests.slice(before);
    assert.equal(lists.length, 3, '6 keys at 2 per page');
    assert.ok(lists.slice(1).every((r) => /marker=m%21\d+%21/.test(r.url)), 'marker sent back encoded');
    assert.deepEqual(await s.list('nothing/'), []);
    assert.equal(fake.signatureFailures, 0);
  });

  test('List Blobs XML: entities and percent-encoded names', () => {
    const page = parseListBlobs('<?xml version="1.0"?><EnumerationResults><Blobs><Blob><Name>a&amp;b</Name></Blob><Blob><Name Encoded="true">c%3Cd</Name></Blob></Blobs><NextMarker>m&amp;1</NextMarker></EnumerationResults>');
    assert.deepEqual(page, { names: ['a&b', 'c<d'], nextMarker: 'm&1' });
    assert.equal(parseListBlobs('<EnumerationResults><Blobs/><NextMarker/></EnumerationResults>').nextMarker, null);
    assert.throws(() => parseListBlobs('<Error><Code>x</Code></Error>'), /EnumerationResults/);
  });

  test('a wrong key fails the Shared Key check: 403, no retry, no key or string to sign in the error', async () => {
    const wrong = crypto.randomBytes(64).toString('base64');
    const s = createStorage(url, { GRAPIM_AZURE_ACCOUNT_KEY: wrong }, fast);
    const before = fake.requests.length;
    const err = await s.put('ws/t/blobs/bad', Buffer.from('x')).catch((e) => e);
    assert.equal(err.status, 403);
    assert.equal(err.code, 'AuthenticationFailed');
    assert.equal(fake.requests.length - before, 1, 'no retry on 4xx');
    assert.equal(fake.signatureFailures, 1);
    fake.signatureFailures = 0;
    const text = `${err.message} ${err.stack} ${JSON.stringify(err)}`;
    for (const leak of [wrong, key, 'SharedKey', 'string to sign', 'x-ms-date:']) assert.ok(!text.includes(leak), leak);
  });

  test('retries 503 then succeeds; gives up after the budget', async () => {
    const s = createStorage(url, env, fast);
    let fails = 2;
    fake.failWhen = () => (fails-- > 0 ? 503 : null);
    const before = fake.requests.length;
    await s.put('ws/t/retry', Buffer.from('ok'));
    assert.equal(fake.requests.length - before, 3);
    fake.failWhen = () => 503;
    await assert.rejects(() => s.has('ws/t/retry'), (e) => e.status === 503 && /gave up after 3 attempts/.test(e.message));
    fake.failWhen = null;
  });
});
