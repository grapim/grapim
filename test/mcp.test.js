// The MCP server, spoken to over stdio the way Codex or Cursor would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'grapim.js');

function client(cwd, env = {}) {
  const p = spawn(process.execPath, [BIN, 'mcp'], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  readline.createInterface({ input: p.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  let next = 1;
  const req = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const close = () => new Promise((resolve) => { p.on('close', resolve); p.stdin.end(); });
  return { req, close, notify: (method) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n') };
}

test('two MCP agents: the second is refused, then gets the file after the first disconnects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-mcp-'));
  const a = client(dir, { GRAPIM_AGENT: 'codex-a' });
  const b = client(dir, { GRAPIM_AGENT: 'cursor-b' });

  const init = await a.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'grapim');
  a.notify('notifications/initialized');
  const list = await a.req('tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ['claim_files', 'release_files', 'who_is_editing', 'set_intent', 'recent_activity', 'list_runs', 'who_wrote']);

  const ok = await a.req('tools/call', { name: 'claim_files', arguments: { paths: ['api/routes.ts'], intent: 'add /billing' } });
  assert.equal(ok.result.isError, undefined);

  await b.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cursor', version: '1' } });
  const no = await b.req('tools/call', { name: 'claim_files', arguments: { paths: ['api/routes.ts'] } });
  assert.equal(no.result.isError, true);
  assert.match(no.result.content[0].text, /held by codex-a .*"add \/billing"/);

  const who = await b.req('tools/call', { name: 'who_is_editing', arguments: {} });
  assert.match(who.result.content[0].text, /api\/routes\.ts\s+codex-a/);

  await a.close();
  const yes = await b.req('tools/call', { name: 'claim_files', arguments: { paths: ['api/routes.ts'] } });
  assert.equal(yes.result.isError, undefined);
  await b.close();
});

test('unknown methods get a JSON-RPC error, not a crash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-mcp-'));
  const c = client(dir);
  const r = await c.req('nope/nothing', {});
  assert.equal(r.error.code, -32601);
  const t = await c.req('tools/call', { name: 'nope', arguments: {} });
  assert.equal(t.error.code, -32602);
  await c.close();
});
