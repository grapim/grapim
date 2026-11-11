// A local stand-in for the Anthropic Messages API, for tests and the dev hub
// (scripts/dev-hub.mjs): point ANTHROPIC_BASE_URL at it. It speaks the
// streaming wire format (server-sent events: message_start,
// content_block_start/delta/stop, message_delta, message_stop) and answers
// with whatever the script returns for each request. Nothing leaves the machine.
//
//   const fake = await startFakeAnthropic({ script: (body, n) => reply })
//   reply: { content: [blocks], stop_reason, usage } | { status, error } | a function of (res)
//   fake.url, fake.requests (every body it got), fake.close()
//
// demoBrain() is the dev hub's script: it picks a tool from the question and
// the page, then summarises the tool's answer, so the panel can be shown
// without an API key.

import http from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startFakeAnthropic({ script, chunk = 12, delayMs = 0, firstTokenMs = 0, port = 0 } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/messages') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const c of req) raw += c;
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad json' } }));
      return;
    }
    requests.push({ body, headers: req.headers });
    let reply;
    try {
      reply = await script(body, requests.length - 1, req.headers);
    } catch (err) {
      reply = { status: 500, error: String(err?.message ?? err) };
    }
    if (typeof reply === 'function') return reply(res);
    if (reply.status) {
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: reply.error ?? 'error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    const usage = { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...(reply.usage ?? {}) };
    send('message_start', { message: { id: `msg_fake_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } });
    if (firstTokenMs) await sleep(firstTokenMs);
    let closed = false;
    res.on('close', () => (closed = true));
    for (const [index, block] of (reply.content ?? []).entries()) {
      if (closed) return;
      if (block.type === 'text') {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } });
        for (let i = 0; i < block.text.length; i += chunk) {
          send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text.slice(i, i + chunk) } });
          if (delayMs) await sleep(delayMs);
          if (closed) return;
        }
      } else if (block.type === 'tool_use') {
        send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
        const json = JSON.stringify(block.input ?? {});
        for (let i = 0; i < json.length; i += 20) send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 20) } });
      } else if (block.type === 'thinking') {
        send('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
        send('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature ?? 'sig' } });
      }
      send('content_block_stop', { index });
    }
    send('message_delta', { delta: { stop_reason: reply.stop_reason ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens || 42 } });
    send('message_stop', {});
    res.end();
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const { port: p } = server.address();
  return {
    url: `http://127.0.0.1:${p}`,
    requests,
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

// ---------------------------------------------------------------- the dev hub's demo script

let ids = 0;
const toolUse = (name, input, ...more) => ({ content: [[name, input], ...more].map(([n, i]) => ({ type: 'tool_use', id: `toolu_demo_${++ids}`, name: n, input: i })), stop_reason: 'tool_use' });
const say = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });

function lastUser(body) {
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const m = body.messages[i];
    if (m.role === 'user') return m;
  }
  return null;
}

const parseResult = (s) => {
  try {
    return JSON.parse(String(s).replace(/^Tool result\.[^\n]*\n/, ''));
  } catch {
    return null;
  }
};

// The tool calls the assistant made in its last message, by id.
function lastCalls(body) {
  const a = [...body.messages].reverse().find((m) => m.role === 'assistant');
  return new Map((a?.content ?? []).filter((b) => b.type === 'tool_use').map((b) => [b.id, b]));
}

const ago = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

function summarise(call, data, isError, text) {
  if (isError) return say(`That did not work: ${text}`);
  switch (call.name) {
    case 'list_runs_to_review': {
      const others = data.runs.filter((r) => !r.mine);
      const top = others.slice(0, 4);
      return say(`**${others.length} runs** are waiting for your review${data.count - others.length ? ` (and ${data.count - others.length} of your own, which someone else has to review)` : ''}. The newest:\n\n${top.map((r) => `- [${r.label}](${r.url}) in \`${r.repo}\`: ${r.intent ?? 'no intent recorded'} (+${r.added} -${r.removed}, ${ago(r.last_change)})`).join('\n')}\n\nWant me to summarise one of them before you review it?`);
    }
    case 'get_run': {
      const files = data.files.map((f) => `- \`${f.path}\` +${f.added} -${f.removed}${f.state === 'in_tree' ? '' : f.state ? ` (${f.state.replace('_', ' ')})` : ''}`).join('\n');
      const firstDiff = data.files.find((f) => f.diff)?.diff ?? '';
      return say(`**${data.label}** on ${data.machine} worked in ${data.turns.length} turn${data.turns.length === 1 ? '' : 's'}:\n\n${data.turns.map((t) => `${t.turn}. ${t.intent ?? 'no prompt recorded'}`).join('\n')}\n\nIt changed ${data.files.length} files, all still in the tree:\n\n${files}\n\nThe core of it:\n\n\`\`\`diff\n${firstDiff.split('\n').slice(0, 14).join('\n')}\n\`\`\`\n\n${/idempotency/i.test(firstDiff) ? 'Worth checking before you approve: the idempotency key is kept for 24 hours in Redis, and a retried request returns the first answer without re-running `createOrder`. ' : ''}${data.review?.you_synced_it ? 'You synced this run, so another member has to review it.' : 'Say the word and I will prepare the approval for you to confirm.'}`);
    }
    case 'failing_pull_requests':
      return say(data.pull_requests.length ? `${data.pull_requests.length} open pull requests hold runs without a fresh approval${data.review_required_by_policy ? ', so the Grapim check fails them' : ''}:\n\n| Pull request | Unapproved runs | Updated |\n|---|---|---|\n${data.pull_requests.map((p) => `| [${p.pull}](${p.url}) | ${p.unapproved_runs} of ${p.runs} | ${ago(p.updated)} |`).join('\n')}` : 'No open pull request is waiting on a hub review.');
    case 'active_agents':
      return say(data.length ? `${data.length} agents are working right now:\n\n${data.map((a) => `- **${a.label}** in \`${a.repo}\` on ${a.machine}: ${a.intent ?? 'no intent'}`).join('\n')}` : 'No agent has been active in the last hour.');
    case 'get_report':
      return say(data.plan_required ? `Last week the AI share was **${Math.round((data.teaser.share ?? 0) * 100)}%**. Full reports are on the Governance plan.` : `Over ${data.range.from} to ${data.range.to}, agents wrote **${Math.round((data.totals.share ?? 0) * 100)}%** of the added lines (${data.totals.ai.toLocaleString('en')} of ${data.totals.added.toLocaleString('en')}). [Open the report](${data.url})`);
    case 'list_workspace_files':
      return say(`${data.workspace} has ${data.files.length} files:\n\n${data.files.map((f) => `- \`${f.path}\`${f.last_change ? `, last changed by ${f.last_change.label}` : ''}`).join('\n')}`);
    case 'get_team':
      return say(`${data.team.name} is on the ${data.team.plan} plan with ${data.members.length} members:\n\n${data.members.map((m) => `- @${m.login} (${m.role})`).join('\n')}`);
    default:
      if (call.name.startsWith('propose_')) return say(`The card above is ready: ${(data.what_it_does ?? '').replace(/^./, (c) => c.toLowerCase())} Nothing changes until you confirm it there.`);
      return say(`Here is what I found:\n\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 600)}\n\`\`\``);
  }
}

export function demoBrain() {
  return (body) => {
    const u = lastUser(body);
    const results = Array.isArray(u?.content) ? u.content.filter((b) => b.type === 'tool_result') : [];
    if (results.length) {
      const calls = lastCalls(body);
      return say(results.map((r) => summarise(calls.get(r.tool_use_id), r.is_error ? null : parseResult(r.content), !!r.is_error, r.content).content[0].text).join('\n\n'));
    }
    const blocks = Array.isArray(u?.content) ? u.content : [{ type: 'text', text: String(u?.content ?? '') }];
    const context = blocks[0]?.text ?? '';
    const q = (blocks[blocks.length - 1]?.text ?? '').toLowerCase();
    const run = /run (\S+?)(?: on machine (\S+))? in the repo .*?\(repo_id ([0-9a-f]{40})\)/.exec(context);
    const ws = /cloud workspace (\S+) \(id/.exec(context);
    if (/approve|reject/.test(q) && run) return toolUse('propose_review_decision', { repo_id: run[3], run: run[1], machine: run[2], decision: /reject/.test(q) ? 'rejected' : 'approved' });
    if (/summari|this run|risky|what did/.test(q) && run) return toolUse('get_run', { repo_id: run[3], run: run[1], machine: run[2] });
    if (/token/.test(q)) return toolUse('propose_workspace_token', { workspace: ws?.[1] ?? 'research-notes', name: `reader-${Date.now().toString(36).slice(-4)}`, access: 'read' });
    if (/invite/.test(q)) return toolUse('propose_invite_link', {});
    if (/pull request|check/.test(q)) return toolUse('failing_pull_requests', {});
    if (/active|working/.test(q)) return toolUse('active_agents', {});
    if (/share|report/.test(q)) return toolUse('get_report', { report: 'ai-share' });
    if (/file/.test(q) && ws) return toolUse('list_workspace_files', { workspace: ws[1] });
    if (/team|who is|owner/.test(q)) return toolUse('get_team', {});
    if (/review|need|wait/.test(q)) return toolUse('list_runs_to_review', {}, ['failing_pull_requests', {}]);
    return say('I can look up runs waiting for review, summarise a run, check pull requests and the AI share, list workspace files, and prepare approvals, undos, invite links and tokens for you to confirm. What would you like?');
  };
}
