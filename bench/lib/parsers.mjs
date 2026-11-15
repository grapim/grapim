// Output parsers and the scripted dry-run answers of the adapters. Only node:
// imports, so the scorer's tests load this without the review engine.

import fs from 'node:fs';

// A deterministic fake answer per tool, so --dry exercises every parser.
// hint: { path, line } of a changed line, for when the agent's shell is unavailable.
export function dryReply(body, hint = null) {
  const sys = JSON.stringify(body?.system ?? '');
  const user = JSON.stringify(body?.messages ?? []);
  if (sys.includes('You are Grapim Review')) {
    // First "+" line of the first DIFF block of the batch.
    const text = (body.messages?.[0]?.content ?? []).map((c) => c.text ?? '').join('\n');
    const m = /<<<GRAPIM-UNTRUSTED kind=DIFF file="\d+" path="([^"]+)"[^\n]*>>>\n([\s\S]*?)<<<END/.exec(text);
    const findings = [];
    if (m) {
      const plus = /^\s*\d*\s+(\d+) \+ /m.exec(m[2]);
      if (plus) findings.push({ path: m[1], line: Number(plus[1]), end_line: Number(plus[1]), severity: 'warning', category: 'correctness', title: 'Dry-run finding', body: 'Fake finding from the dry-run provider.' });
    }
    return JSON.stringify({ findings });
  }
  if (/key_issues_to_review|estimated_effort_to_review/.test(sys + user)) {
    const f = /## File: '([^']+)'/.exec(user)?.[1] ?? 'unknown';
    return `\`\`\`yaml\nreview:\n  estimated_effort_to_review_[1-5]: |\n    1\n  relevant_tests: |\n    No\n  key_issues_to_review:\n    - relevant_file: |\n        ${f}\n      issue_header: |\n        Dry run\n      issue_content: |\n        Fake issue from the dry-run proxy.\n      start_line: 1\n      end_line: 1\n  security_concerns: |\n    No\n\`\`\``;
  }
  // The Claude Code agent loop: read the diff with `gh pr diff` (the shim),
  // post one inline comment through the MCP stand-in, then finish.
  const tools = (body?.tools ?? []).map((t) => t.name);
  if (tools.includes('mcp__github_inline_comment__create_inline_comment') && tools.includes('Bash')) {
    const results = (body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'tool_result');
    if (process.env.BENCH_DEBUG) fs.writeFileSync(process.env.BENCH_DEBUG, JSON.stringify(results));
    if (results.length === 0) return { tool: { name: 'Bash', input: { command: 'gh pr diff', description: 'Show the PR diff' } } };
    if (results.length === 1) {
      const out = [].concat(results[0].content ?? []).map((c) => (typeof c === 'string' ? c : c.text ?? '')).join('\n');
      let file = null;
      let line = null;
      let n = 0;
      for (const l of out.split('\n')) {
        const f = /^\+\+\+ b\/(.+)$/.exec(l);
        if (f) file = f[1];
        const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
        if (h) n = Number(h[1]);
        else if (file && n && l.startsWith('+')) {
          line = n;
          break;
        } else if (n && !l.startsWith('-')) n++;
      }
      if (!(file && line) && hint) ({ path: file, line } = hint);
      if (file && line) return { tool: { name: 'mcp__github_inline_comment__create_inline_comment', input: { path: file, line, body: 'Dry run: fake inline comment.', confirmed: true } } };
    }
    return 'Dry run: review done.';
  }
  return 'Dry run: no issues found.';
}

// The structured review -> findings.
export function parsePrAgentReview(json) {
  const review = json?.review ?? json ?? {};
  const list = review.key_issues_to_review ?? review['key_issues_to_review'] ?? [];
  const items = Array.isArray(list) ? list : [];
  const findings = items
    .filter((i) => i && (i.relevant_file || i.file))
    .map((i) => {
      const line = Number(i.start_line ?? i.line ?? 0) || null;
      return {
        path: String(i.relevant_file ?? i.file).trim(),
        line,
        end_line: Number(i.end_line ?? line ?? 0) || line,
        severity: null,
        category: null,
        title: String(i.issue_header ?? '').trim(),
        body: String(i.issue_content ?? '').trim(),
      };
    });
  const sec = String(review.security_concerns ?? '').trim();
  if (sec && !/^no\b/i.test(sec)) findings.push({ path: null, line: null, end_line: null, severity: null, category: 'security', title: 'Security concerns', body: sec });
  return findings;
}

// Claude Code's --output-format stream-json (with --verbose): one JSON event a
// line. -> { records: comment records as JSON lines (parseClaudeComments'
// input), result: the final "result" event }.
export function parseClaudeStream(stdout) {
  const records = [];
  let result = null;
  for (const line of String(stdout ?? '').split('\n')) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev?.type === 'result') result = ev;
    if (ev?.type !== 'assistant') continue;
    for (const b of ev.message?.content ?? []) {
      if (b?.type !== 'tool_use') continue;
      const a = b.input ?? {};
      if (/create_inline_comment$/.test(b.name ?? '')) records.push(JSON.stringify({ path: a.path, line: a.line, startLine: a.startLine, side: a.side ?? 'RIGHT', body: a.body, confirmed: a.confirmed }));
      else if (b.name === 'Bash' && /^\s*gh\s+pr\s+comment\b/.test(a.command ?? '')) records.push(JSON.stringify({ kind: 'pr_comment', body: a.command }));
    }
  }
  return { records: records.join('\n'), result };
}

export function parseClaudeComments(text) {
  const findings = [];
  const summaries = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let c;
    try {
      c = JSON.parse(line);
    } catch {
      continue;
    }
    if (c.kind === 'pr_comment') {
      summaries.push(c.body);
      continue;
    }
    if (c.confirmed === false || c.side === 'LEFT') continue;
    const body = String(c.body ?? '');
    findings.push({ path: c.path, line: c.line ?? c.startLine ?? null, end_line: c.line ?? null, severity: null, category: null, title: body.split('\n').find((l) => l.trim())?.replace(/^[#*\s]+/, '').slice(0, 200) ?? '', body });
  }
  return { findings, summaries };
}
