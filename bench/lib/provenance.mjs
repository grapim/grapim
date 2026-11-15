// Synthetic Grapim provenance for a benchmark PR. A real team running Grapim
// has a refs/notes/grapim note per commit, written at commit time, naming the
// agent run that wrote each line and the prompt it was given. Public PRs have
// none, so the harness writes the note Grapim would have written: every line a
// PR commit added belongs to the one agent run of the PR, whose prompt is the
// request (the linked issue, else the PR title and description).
//
// This is what the `grapim` adapter reviews with; `grapim-noprov` reviews the
// same PR with no notes (everything "human or unknown", review mode "all").

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, prCommits, addedRanges } from './git.mjs';

export const INTENT_CHARS = 1000; // parseNote keeps at most 1000 characters

const KIND = { 'claude-code': 'claude-code', codex: 'codex', cursor: 'cursor' };
const LABEL = { copilot: 'GitHub Copilot coding agent', devin: 'Devin', jules: 'Jules', codex: 'Codex', 'claude-code': 'Claude Code', cursor: 'Cursor background agent' };

// The request the agent was given, as one prompt text.
export function requestText(pr, { maxChars = INTENT_CHARS } = {}) {
  const parts = pr.linked_issues?.length
    ? pr.linked_issues.map((i) => `${i.title}\n${i.body ?? ''}`)
    : [`${pr.title}\n${pr.body ?? ''}`];
  const t = parts.join('\n\n').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
  return t.length > maxChars ? `${t.slice(0, maxChars - 1)}…` : t;
}

export function runOf(pr) {
  const kind = KIND[pr.agent] ?? 'mcp';
  const id = kind === 'claude-code' ? `claude-code:bench-${pr.number}` : `${pr.agent}-agent:pr-${pr.number}`;
  return { id, label: `${LABEL[pr.agent] ?? pr.agent} (PR #${pr.number})`, kind };
}

// Writes one note per non-merge commit of the PR into gitDir. Returns the count.
export function writeNotes(gitDir, pr, { intentChars = INTENT_CHARS } = {}) {
  const run = runOf(pr);
  const intent = requestText(pr, { maxChars: intentChars });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-bench-note-'));
  let n = 0;
  try {
    for (const sha of prCommits(gitDir, pr)) {
      // A commit at the shallow boundary has no parent here: its diff would be the
      // whole tree (and would download every file). Skip it.
      const parent = (git(gitDir, ['rev-parse', '--verify', '--quiet', `${sha}^`], { allowFail: true, noLazy: true }) ?? '').trim();
      if (!parent || git(gitDir, ['cat-file', '-e', `${parent}^{commit}`], { allowFail: true, noLazy: true }) === null) continue;
      const diff = git(gitDir, ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', parent, sha]);
      const ranges = addedRanges(diff);
      const files = {};
      for (const [p, list] of Object.entries(ranges)) files[p] = list.map(([s, e]) => [s, e, 0, 1]);
      const note = { v: 1, tool: 'grapim-bench', runs: [{ ...run, turns: [{ turn: 1, intent }] }], files };
      const f = path.join(tmp, `${sha}.json`);
      fs.writeFileSync(f, JSON.stringify(note));
      git(gitDir, ['notes', '--ref=grapim', 'add', '-f', '-F', f, sha]);
      n++;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return n;
}
