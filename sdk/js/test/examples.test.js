// Runs sdk/examples/*.mjs against the fake server, end to end.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { startFakeServer } from './fake-server.js';

const example = (name) => fileURLToPath(new URL(`../../examples/${name}`, import.meta.url));

function run(file, env, { until } = {}) {
  const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve({ code, out, err })));
  const ready = until
    ? new Promise((resolve, reject) => {
        child.stdout.on('data', () => { const m = until.exec(out); if (m) resolve(m); });
        child.on('exit', () => reject(new Error(`exited early: ${out}${err}`)));
      })
    : null;
  return { child, exited, ready };
}

test('sandbox-agent.mjs: mint a token, the agent writes in a child process, the platform undoes its run', async () => {
  const fake = await startFakeServer();
  try {
    const { exited } = run(example('sandbox-agent.mjs'), { GRAPIM_API_KEY: fake.apiKey, GRAPIM_BASE_URL: fake.url });
    const { code, out, err } = await exited;
    assert.equal(code, 0, out + err);
    assert.match(out, /\[agent\] wrote README\.md/);
    assert.match(out, /\[agent\] wrote config\/app\.json/);
    assert.match(out, /undid http:tok-\d+\/fixer: 2 file\(s\), applied=true/);
    assert.match(out, /review desk for the customer: http/);
    // The agent wrote with the workspace token only, and with If-Match.
    const puts = fake.requests.filter((r) => r.method === 'PUT');
    assert.equal(puts.length, 2);
    for (const p of puts) {
      assert.match(p.headers.authorization, /^Bearer gws_/);
      assert.equal(p.headers['if-match'], '"absent"');
    }
    // Undone: the workspace is empty again.
    const ws = [...fake.state.workspaces.values()][0];
    assert.equal(fake.state.files.get(ws.id).size, 0);
  } finally {
    await fake.close();
  }
});

test('webhook-receiver.mjs: 200 for a signed delivery, 400 for a bad one', async () => {
  const secret = 'whsec_example_receiver_secret';
  const { child, ready } = run(example('webhook-receiver.mjs'), { GRAPIM_WEBHOOK_SECRET: secret, PORT: '0' }, { until: /listening on (http:\/\/\S+)/ });
  try {
    const [, url] = await ready;
    const body = JSON.stringify({ id: 'evt_1', type: 'run.started', created: 1, workspace: { id: 'ws_1', external_id: 'c1' }, data: { run: 'http:t/a' } });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    const ok = await fetch(url, { method: 'POST', body, headers: { 'Grapim-Signature': `t=${t},v1=${sig}` } });
    assert.equal(ok.status, 200);
    const bad = await fetch(url, { method: 'POST', body: body.replace('c1', 'c2'), headers: { 'Grapim-Signature': `t=${t},v1=${sig}` } });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'invalid_signature' });
    const none = await fetch(url, { method: 'POST', body });
    assert.equal(none.status, 400);
  } finally {
    child.kill();
  }
});
