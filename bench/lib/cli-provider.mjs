// A stand-in provider for tuning runs: sends each review request through the
// Claude Code CLI in print mode (`claude -p`), so it is billed to the Claude
// plan the CLI is logged in to instead of an API key. Same model, the same
// system prompt (it replaces the CLI's own), the same effort and the same JSON
// schema as the API path; no tools.
//
// For tuning on the dev half only. Published numbers come from the API runs,
// which the metering proxy counts the same way for every tool. A result made
// this way is marked `via: 'claude-cli'` and goes to its own results folder.
//
// Needs a shell where `claude auth status` says loggedIn: the Claude desktop
// app's Terminal panel is one (it provides a sign-in token to `claude` run
// there; adapters.mjs lets that one variable through), or any shell after
// `claude auth login`. A tool-run shell of the desktop app is not signed in.
// Extra CLI arguments: BENCH_CLAUDE_CLI_ARGS (space separated).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 15 * 60 * 1000;

function run(cmd, args, { cwd, env, input }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(t);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

// The CLI's result object -> { text, usage }. text is the findings JSON.
export function parseCliResult(stdout) {
  let j;
  try {
    j = JSON.parse(stdout);
  } catch {
    throw new Error(`claude -p did not print JSON: ${String(stdout).slice(0, 300)}`);
  }
  // --output-format json prints one result object (or an array of events ending in it).
  const r = Array.isArray(j) ? j.findLast((e) => e?.type === 'result') : j;
  if (!r) throw new Error('claude -p printed no result');
  if (r.is_error) throw new Error(/not logged in/i.test(String(r.result)) ? 'The Claude CLI is not logged in in this shell. Run from one where `claude auth status` says loggedIn (the desktop app\'s Terminal panel is one), then try again.' : `claude -p failed: ${String(r.result).slice(0, 300)}`);
  const text = r.structured_output !== undefined && r.structured_output !== null ? JSON.stringify(r.structured_output) : String(r.result ?? '');
  const u = r.usage ?? {};
  return { turns: r.num_turns ?? null, text, usage: { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0 } };
}

// A provider for reviewChanges: { name, send(body) }.
export function claudeCliProvider({ model, env = process.env, command = process.env.BENCH_CLAUDE_CLI || 'claude', onUsage = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-bench-cli-'));
  let n = 0;
  return {
    name: 'anthropic',
    dir,
    // With body.tools and opts.repo.dir (the second look's repository tools),
    // the CLI runs the tool loop itself through bench/lib/repo-tools-mcp.mjs.
    async send(body, opts = {}) {
      const sys = path.join(dir, `system-${++n}.txt`);
      fs.writeFileSync(sys, body.system.map((b) => b.text).join('\n\n'));
      const user = body.messages[0].content.map((b) => b.text).join('\n\n');
      const extra = (process.env.BENCH_CLAUDE_CLI_ARGS || '').split(' ').filter(Boolean);
      if (body.tools?.length && opts.repo?.dir) {
        const cfg = path.join(dir, `mcp-${n}.json`);
        const server = fileURLToPath(new URL('./repo-tools-mcp.mjs', import.meta.url));
        fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { repo: { type: 'stdio', command: process.execPath, args: [server], env: { REPO_GIT_DIR: opts.repo.dir, REPO_HEAD: opts.repo.head } } } }));
        extra.push('--mcp-config', cfg, '--allowedTools', body.tools.map((t) => `mcp__repo__${t.name}`).join(','), '--max-turns', '40', '--verbose');
      }
      const args = ['-p', '--model', body.model ?? model, '--effort', body.output_config?.effort ?? 'medium', '--system-prompt-file', sys, '--json-schema', JSON.stringify(body.output_config.format.schema), '--output-format', body.tools?.length && opts.repo?.dir ? 'stream-json' : 'json', '--tools', '', '--no-session-persistence', '--strict-mcp-config', ...extra];
      // An empty folder: no project instructions or memory reach the request.
      const r = await run(command, args, { cwd: dir, env, input: user });
      if (r.code !== 0 && !r.stdout.trim()) throw new Error(`claude -p exited ${r.code}: ${r.stderr.slice(-400)}`);
      if (process.env.BENCH_CLI_DEBUG) fs.writeFileSync(path.join(process.env.BENCH_CLI_DEBUG, `cli-${Date.now()}-${n}.json`), `${JSON.stringify(args)}
${r.stdout}
${r.stderr}`);
      // stream-json (tools): one event per line; count the repository tool calls.
      let stdout = r.stdout;
      let calls = 0;
      if (body.tools?.length && opts.repo?.dir) {
        const events = r.stdout.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        for (const e of events) if (e.type === 'assistant') calls += (e.message?.content ?? []).filter((b) => b?.type === 'tool_use' && String(b.name).startsWith('mcp__repo__')).length;
        stdout = JSON.stringify(events);
      }
      const { text, usage } = parseCliResult(stdout);
      onUsage(usage, body.model ?? model);
      // tool_rounds: repository tool calls the CLI made (the second look counts them).
      return { content: [{ type: 'text', text }], usage, stop_reason: 'end_turn', ...(body.tools?.length ? { tool_rounds: calls } : {}) };
    },
    close() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
