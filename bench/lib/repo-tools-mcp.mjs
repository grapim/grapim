#!/usr/bin/env node
// The second look's repository tools (src/airev/repo-tools.js) as a stdio MCP
// server, for the bench's CLI stand-in provider (`claude -p` runs the tool
// loop itself). Reads REPO_GIT_DIR and REPO_HEAD from the environment. Read
// only: every tool is a git command on the head commit.

import { execFileSync } from 'node:child_process';
import readline from 'node:readline';
import { REPO_TOOLS, runRepoTool } from '../../src/airev/repo-tools.js';

const DIR = process.env.REPO_GIT_DIR;
const HEAD = process.env.REPO_HEAD;
const git = (args) => {
  try {
    return execFileSync('git', ['-c', 'credential.helper=', `--git-dir=${DIR}`, ...args], { encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  } catch (err) {
    // git grep exits 1 when nothing matches.
    return typeof err?.stdout === 'string' && err.stdout ? err.stdout : null;
  }
};

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const tools = REPO_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'repo', version: '0.0.1' } } });
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools } });
  else if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: runRepoTool(git, HEAD, m.params?.name, m.params?.arguments ?? {}) }] } });
  else if (m.id !== undefined) send({ id: m.id, result: {} });
});
