// The marketing domain (SITE_URL): it serves the public site, sends the hub
// and its APIs to the hub's origin, folds www. into the bare domain, and
// lands old addresses on the home page. Without SITE_URL nothing changes.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../src/hub/server.js';

const HUB = 'http://localhost:7997';
const SITE = 'https://grapim.example';
let h;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-site-host-'));
  const hub = await createHub({
    env: { HUB_URL: HUB, SITE_URL: SITE, HUB_SECRET: 'test-secret-that-is-long-enough-0123456789', HUB_DATA: dir, GITHUB_CLIENT_ID: 'gh-client', GITHUB_CLIENT_SECRET: 'gh-secret' },
    fetch: async (url) => {
      throw new Error(`no network in tests (${url})`);
    },
    billing: null,
    log: () => {},
  });
  const addr = await hub.listen(0, '127.0.0.1');
  h = { hub, port: addr.port };
});
after(() => h?.hub.close());

// A request with a chosen Host header (fetch will not set one).
function ask(host, p, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.port, path: p, method, headers: { host } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location });
    });
    req.on('error', reject);
    req.end();
  });
}

test('the marketing domain serves the site and sends the hub to its own origin', async () => {
  for (const p of ['/', '/pricing', '/changelog', '/docs', '/docs/undo', '/terms', '/privacy', '/robots.txt', '/hub/static/site.css']) {
    assert.equal((await ask('grapim.example', p)).status, 200, p);
  }
  assert.deepEqual(await ask('grapim.example', '/hub/auth/github?next=%2Fhub'), { status: 301, location: `${HUB}/hub/auth/github?next=%2Fhub` });
  assert.deepEqual(await ask('grapim.example', '/v1/teams', 'POST'), { status: 308, location: `${HUB}/v1/teams` });
  assert.deepEqual(await ask('www.grapim.example', '/pricing'), { status: 301, location: `${SITE}/pricing` });
  assert.deepEqual(await ask('grapim.example', '/old-product-page'), { status: 301, location: `${SITE}/` });
});

test('the hub origin itself is unchanged', async () => {
  assert.equal((await ask('localhost:7997', '/')).status, 200);
  assert.equal((await ask('localhost:7997', '/old-product-page')).status, 404);
});
