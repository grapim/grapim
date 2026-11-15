#!/usr/bin/env node
// A stand-in for claude-code-action's "github_inline_comment" MCP server
// (src/mcp/github-inline-comment-server.ts upstream): the same tool name and
// parameters, but each call is appended to $BENCH_COMMENTS_FILE as one JSON
// line instead of being posted to GitHub. Stdio JSON-RPC, no dependencies.

import fs from 'node:fs';
import readline from 'node:readline';

const OUT = process.env.BENCH_COMMENTS_FILE;

const TOOL = {
  name: 'create_inline_comment',
  description: 'Create an inline comment on a specific line or lines in a PR file',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: "The file path to comment on (e.g., 'src/index.js')" },
      body: {
        type: 'string',
        description:
          'The comment text (supports markdown and GitHub code suggestion blocks). For code suggestions, use: ```suggestion\\nreplacement code\\n```. IMPORTANT: The suggestion block will REPLACE the ENTIRE line range (single line or startLine to line). Ensure the replacement is syntactically complete and valid - it must work as a drop-in replacement for the selected lines.',
      },
      line: { type: 'number', minimum: 0, description: 'Line number for single-line comments (required if startLine is not provided)' },
      startLine: { type: 'number', minimum: 0, description: 'Start line for multi-line comments (use with line parameter for the end line)' },
      side: { type: 'string', enum: ['LEFT', 'RIGHT'], default: 'RIGHT', description: 'Side of the diff to comment on: LEFT (old code) or RIGHT (new code)' },
      commit_id: { type: 'string', description: 'Specific commit SHA to comment on (defaults to latest commit)' },
      confirmed: {
        type: 'boolean',
        description:
          'Set true to post immediately. When omitted, the call is buffered and classified after the session completes — real review comments post, test/probe comments are dropped. Set false to buffer and never post. Only set true when posting final review comments.',
      },
    },
    required: ['path', 'body'],
  },
};

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === 'initialize') {
    send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'GitHub Inline Comment Server', version: '0.0.1' } } });
  } else if (m.method === 'tools/list') {
    send({ id: m.id, result: { tools: [TOOL] } });
  } else if (m.method === 'tools/call') {
    const a = m.params?.arguments ?? {};
    if (!a.line && !a.startLine) {
      send({ id: m.id, result: { isError: true, content: [{ type: 'text', text: "Error creating inline comment: Either 'line' for single-line comments or both 'startLine' and 'line' for multi-line comments must be provided" }] } });
      return;
    }
    // The harness also reads the call from Claude Code's stream-json output,
    // so a failed write is reported, never fatal.
    try {
      if (OUT) fs.appendFileSync(OUT, JSON.stringify({ ts: new Date().toISOString(), path: a.path, line: a.line, startLine: a.startLine, side: a.side ?? 'RIGHT', body: a.body, confirmed: a.confirmed }) + '\n');
    } catch (err) {
      process.stderr.write(`inline-comment-mcp: ${err.message}\n`);
    }
    send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ success: true, comment_id: Date.now(), html_url: 'https://github.com/bench/local' }, null, 2) }] } });
  } else if (m.id !== undefined && m.method) {
    if (m.method === 'ping') send({ id: m.id, result: {} });
    else send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
});
